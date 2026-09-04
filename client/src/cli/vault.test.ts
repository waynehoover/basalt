import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonIndexStore, NodeVault, TEMP_MARK, isTemporary, writeDurably } from "./vault.ts";
import { removeTree } from "../core/test-server.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basalt-vault-"));
});

afterEach(async () => {
  await removeTree(root);
});

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("listing", () => {
  it("reports files and the folders above them", async () => {
    await mkdir(join(root, "notes", "deep"), { recursive: true });
    await writeFile(join(root, "top.md"), "top");
    await writeFile(join(root, "notes", "one.md"), "one");
    await writeFile(join(root, "notes", "deep", "two.md"), "two");

    const listed = await new NodeVault(root).list();
    const byPath = new Map(listed.map((f) => [f.path, f]));

    expect([...byPath.keys()].sort()).toEqual([
      "notes",
      "notes/deep",
      "notes/deep/two.md",
      "notes/one.md",
      "top.md",
    ]);
    expect(byPath.get("notes")?.folder).toBe(true);
    expect(byPath.get("top.md")?.folder).toBe(false);
    expect(byPath.get("top.md")?.size).toBe(3);
    expect(byPath.get("top.md")?.mtime).toBeGreaterThan(0);
  });

  it("uses forward slashes whatever the platform", async () => {
    // Paths are the vault's identity and travel between devices. A backslash
    // from one platform is a filename character on another.
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "c.md"), "x");
    const listed = await new NodeVault(root).list();
    expect(listed.map((f) => f.path)).toContain("a/b/c.md");
    for (const f of listed) expect(f.path).not.toContain("\\");
  });

  it("leaves the directories that must never sync alone", async () => {
    // Plugin and settings sync is refused, and .basalt is this client's own
    // bookkeeping: syncing it would sync the index to itself.
    for (const dir of [".obsidian", ".basalt", ".git", ".trash", "node_modules"]) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, "inside.md"), "x");
    }
    await writeFile(join(root, "real.md"), "x");

    const listed = await new NodeVault(root).list();
    expect(listed.map((f) => f.path)).toEqual(["real.md"]);
  });

  it("takes extra names to leave alone", async () => {
    await mkdir(join(root, "scratch"), { recursive: true });
    await writeFile(join(root, "scratch", "x.md"), "x");
    await writeFile(join(root, "keep.md"), "x");

    const listed = await new NodeVault(root, { alsoIgnore: ["scratch"] }).list();
    expect(listed.map((f) => f.path)).toEqual(["keep.md"]);
  });

  it("does not follow a symlink out of the vault", async () => {
    // Following one would sync a file that is not in the vault, and copying
    // it as a link would sync a path that means nothing anywhere else.
    const outside = await mkdtemp(join(tmpdir(), "basalt-outside-"));
    try {
      await writeFile(join(outside, "secret.md"), "not yours");
      await symlink(outside, join(root, "linked"));
      await writeFile(join(root, "real.md"), "x");

      const listed = await new NodeVault(root).list();
      expect(listed.map((f) => f.path)).toEqual(["real.md"]);
    } finally {
      await removeTree(outside);
    }
  });

  it("refuses to report an empty vault when a directory cannot be read", async () => {
    // Rule 2: absent and unreadable are different states. Reporting the
    // second as the first would tell the engine every file in it was deleted.
    await mkdir(join(root, "locked"), { recursive: true });
    await writeFile(join(root, "locked", "note.md"), "x");
    const { chmod } = await import("node:fs/promises");
    await chmod(join(root, "locked"), 0o000);
    try {
      await expect(new NodeVault(root).list()).rejects.toThrow(/cannot read/);
    } finally {
      await chmod(join(root, "locked"), 0o755);
    }
  });
});

describe("reading and writing", () => {
  it("round trips bytes", async () => {
    const v = new NodeVault(root);
    const bytes = new Uint8Array([0, 1, 250, 255, 128]);
    await v.write("bin/file.dat", bytes, { mtime: 1_700_000_000_000, ctime: 0 });
    expect(await v.read("bin/file.dat")).toEqual(bytes);
  });

  it("creates the folders a path needs", async () => {
    const v = new NodeVault(root);
    await v.write("a/b/c/note.md", enc.encode("deep"), { mtime: 1_700_000_000_000, ctime: 0 });
    expect(dec.decode(await v.read("a/b/c/note.md"))).toBe("deep");
  });

  /**
   * The engine's decision table compares mtimes. A downloaded file stamped
   * with the moment it landed looks locally edited on the next pass, so the
   * device would upload back what it had just received, forever.
   */
  it("sets the modification time it was given", async () => {
    const v = new NodeVault(root);
    const when = 1_600_000_000_000;
    await v.write("note.md", enc.encode("x"), { mtime: when, ctime: when });
    const s = await stat(join(root, "note.md"));
    expect(Math.round(s.mtimeMs)).toBe(when);
    // And the listing agrees, which is what the engine actually reads.
    const listed = await v.list();
    expect(Math.round(listed.find((f) => f.path === "note.md")!.mtime)).toBe(when);
  });

  it("leaves no partial file and no temporary behind", async () => {
    // Written to a temporary name and renamed, so a crash or a concurrent
    // read never sees half a note.
    const v = new NodeVault(root);
    await v.write("note.md", enc.encode("complete"), { mtime: 1, ctime: 1 });
    const listed = await v.list();
    expect(listed.map((f) => f.path)).toEqual(["note.md"]);
    expect(dec.decode(await v.read("note.md"))).toBe("complete");
  });

  it("overwrites cleanly", async () => {
    const v = new NodeVault(root);
    await v.write("note.md", enc.encode("first"), { mtime: 1000, ctime: 1000 });
    await v.write("note.md", enc.encode("second"), { mtime: 2000, ctime: 1000 });
    expect(dec.decode(await v.read("note.md"))).toBe("second");
  });

  it("removes files and folders, and says a path is gone", async () => {
    const v = new NodeVault(root);
    await v.write("dir/note.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    expect(await v.exists("dir/note.md")).toBe(true);

    await v.remove("dir/note.md");
    expect(await v.exists("dir/note.md")).toBe(false);

    await v.mkdir("dir2");
    expect(await v.exists("dir2")).toBe(true);
    await v.remove("dir2");
    expect(await v.exists("dir2")).toBe(false);
  });
});

describe("paths from elsewhere", () => {
  /**
   * Paths arrive from the server, sealed by another device. The seal proves
   * they came from someone holding the vault key; it does not prove that
   * device is well, and a bug on it is enough.
   */
  it("refuses to write outside the vault", async () => {
    const v = new NodeVault(root);
    const escapes = [
      "../escaped.md",
      "../../escaped.md",
      "a/../../escaped.md",
      "/etc/passwd",
      "a/b/../../../escaped.md",
    ];
    for (const path of escapes) {
      await expect(v.write(path, enc.encode("x"), { mtime: 1, ctime: 1 }), path).rejects.toThrow(
        /outside the vault/,
      );
    }
    // And nothing was written above the root.
    await expect(readFile(join(root, "..", "escaped.md"), "utf8")).rejects.toThrow();
  });

  it("refuses to read, remove or make a folder outside the vault", async () => {
    const v = new NodeVault(root);
    await expect(v.read("../secret.md")).rejects.toThrow(/outside the vault/);
    await expect(v.remove("../important")).rejects.toThrow(/outside the vault/);
    await expect(v.mkdir("../elsewhere")).rejects.toThrow(/outside the vault/);
  });

  it("allows a path that merely looks alarming", async () => {
    // `..` inside a name is a filename, not a traversal, and refusing it
    // would make a legitimate note unsyncable.
    const v = new NodeVault(root);
    await v.write("notes/a..b.md", enc.encode("fine"), { mtime: 1, ctime: 1 });
    expect(dec.decode(await v.read("notes/a..b.md"))).toBe("fine");
  });

  /**
   * The ignore set was consulted for the first segment on the way in and for
   * every segment on the way out. A peer's `notes/.git/hooks/post-checkout`
   * was therefore written, never listed, and reported deleted on the next
   * pass; the peer then deleted its own copy on this device's word.
   */
  it("refuses a never-synced name at any depth, exactly where list skips it (C3)", async () => {
    const v = new NodeVault(root);
    const nested = [
      "notes/.git/hooks/post-checkout",
      "notes/node_modules/lib.md",
      "notes/.obsidian/plugins/x/main.js",
      "deep/er/.hidden.md",
    ];
    for (const path of nested) {
      // Refused either way. Which code it carries is R2: a dot-prefixed name
      // cannot work here, and a name on this device's own ignore list is the
      // configuration doing what it was told, which is not a failure.
      const expected = path.includes("node_modules") ? "ignored" : "neversync";
      for (const attempt of [
        () => v.write(path, enc.encode("x"), { mtime: 1, ctime: 1 }),
        () => v.mkdir(path),
      ]) {
        const err = await attempt().then(
          () => undefined,
          (e: Error & { code?: string }) => e,
        );
        expect(err, `${path} was accepted`).toBeDefined();
        expect(err!.code, path).toBe(expected);
      }
      await expect(readFile(join(root, path)), `${path} was written`).rejects.toThrow();
    }
    // Written behind the vault's back, the way a git checkout or an npm
    // install does, none of it is listed either. What is not accepted is not
    // offered, so nothing can be reported deleted that was never here.
    for (const path of nested) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), "x");
    }
    await writeFile(join(root, "notes", "real.md"), "x");
    const listed = (await v.list()).map((f) => f.path);
    expect(listed).toContain("notes/real.md");
    for (const path of nested) expect(listed, path).not.toContain(path);
    expect(listed.some((p) => p.split("/").some((part) => part.startsWith(".")))).toBe(false);
  });
});

/**
 * review finding C17: a create that is exclusive, so the gap between choosing a
 * free name and writing to it cannot swallow a file that appeared in it.
 */
describe("creating a file only if nothing is there", () => {
  it("writes when the name is free, and says so", async () => {
    const v = new NodeVault(root);
    expect(await v.create("new/copy.md", enc.encode("copy"), { mtime: 5000, ctime: 5000 })).toBe(
      true,
    );
    expect(dec.decode(await v.read("new/copy.md"))).toBe("copy");
    expect(Math.round((await stat(join(root, "new", "copy.md"))).mtimeMs)).toBe(5000);
    expect((await readdir(join(root, "new"))).filter((n) => n.includes(TEMP_MARK))).toEqual([]);
  });

  it("leaves what is there alone, and says it did not write", async () => {
    const v = new NodeVault(root);
    await writeFile(join(root, "taken.md"), "somebody else's");
    expect(await v.create("taken.md", enc.encode("mine"), { mtime: 1, ctime: 1 })).toBe(false);
    expect(await readFile(join(root, "taken.md"), "utf8")).toBe("somebody else's");
    expect((await readdir(root)).filter((n) => n.includes(TEMP_MARK))).toEqual([]);
  });

  it("refuses the same paths a write refuses", async () => {
    const v = new NodeVault(root);
    await expect(v.create("../out.md", enc.encode("x"), { mtime: 1, ctime: 1 })).rejects.toThrow(
      /outside the vault/,
    );
    await expect(
      v.create(".obsidian/x.md", enc.encode("x"), { mtime: 1, ctime: 1 }),
    ).rejects.toThrow(/never synced/);
  });
});

/**
 * review finding C16: the identity the disk gives a name, asked of the disk.
 */
describe("what this disk files a name under", () => {
  it("folds Unicode normalisation always, and case as the disk does", async () => {
    const v = new NodeVault(root);
    await v.probeCase();
    expect(v.canonical("caf\u00e9.md")).toBe(v.canonical("cafe\u0301.md"));
    // Asked rather than assumed: the answer differs between a Mac and a
    // Linux box, and the test runs on both.
    await writeFile(join(root, "Probe.md"), "x");
    let folds = true;
    try {
      await stat(join(root, "probe.md"));
    } catch {
      folds = false;
    }
    expect(v.canonical("Note.md") === v.canonical("note.md")).toBe(folds);
  });

  it("assumes folding until it has asked, which refuses rather than overwrites", () => {
    const v = new NodeVault(root);
    expect(v.canonical("Note.md")).toBe(v.canonical("note.md"));
  });

  /**
   * R9. Every command asks this at startup, `basalt status` included, and a
   * command that only reads must leave the vault as it found it: the probe
   * used to make `.basalt/` on its way, which is a write into somebody's
   * vault to print two lines and a failure on a read-only mount.
   */
  it("leaves nothing behind in the vault, not even a folder (R9)", async () => {
    const v = new NodeVault(root);
    await v.probeCase();
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps the safe default when the vault cannot be written to (R9)", async () => {
    const readOnly = await mkdtemp(join(tmpdir(), "basalt-ro-"));
    await chmod(readOnly, 0o555);
    try {
      const v = new NodeVault(readOnly);
      await v.probeCase();
      // Unanswerable, so the answer is the side that refuses two files where
      // one would do rather than overwriting one with the other.
      expect(v.canonical("Note.md")).toBe(v.canonical("note.md"));
      expect(await readdir(readOnly)).toEqual([]);
    } finally {
      await chmod(readOnly, 0o755);
      await rm(readOnly, { recursive: true, force: true });
    }
  });
});

describe("the index on disk", () => {
  const state = (cursor: number) => ({
    cursor,
    entries: { "note.md": { path: "note.md", hash: "h" } },
    remote: { "note.md": { uid: 1 } },
    pending: ["note.md"],
  });

  it("round trips", async () => {
    const store = new JsonIndexStore(join(root, ".basalt", "index.json"));
    await store.save(state(7));
    expect(await store.load()).toEqual(state(7));
  });

  it("reports nothing when there is nothing yet", async () => {
    const store = new JsonIndexStore(join(root, ".basalt", "index.json"));
    expect(await store.load()).toBeUndefined();
  });

  /**
   * The skip that keeps a settled vault from rewriting its whole index on
   * every pass. It is safe because the bytes on disk are already those bytes,
   * so both halves have to be true: the same string, and a file still there.
   */
  it("does not write an index it has just read, and does write one that has gone", async () => {
    const file = join(root, ".basalt", "index.json");
    await new JsonIndexStore(file).save(state(7));

    // A restart over a settled vault: the first pass produces the state that
    // is already on disk, and writing it back is a serialisation and two
    // fsyncs to record that nothing happened.
    const store = new JsonIndexStore(file);
    expect(await store.load()).toEqual(state(7));
    const before = (await stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await store.save(state(7));
    expect((await stat(file)).mtimeMs, "an identical index was written again").toBe(before);

    // And if it goes from under the session, the next save puts it back
    // rather than skipping for ever and starting cold next time.
    await rm(file);
    await store.save(state(7));
    expect(await new JsonIndexStore(file).load()).toEqual(state(7));
  });

  /**
   * Being there was never the question (R3).
   *
   * The plugin's store learned this and this one did not, so the headless
   * client went on preserving an index somebody else had rewritten for the
   * rest of the session. Both stores now share `LastIndexWrite` in core.
   */
  it("writes again when the index has been overwritten in place (R3)", async () => {
    const file = join(root, ".basalt", "index.json");
    const store = new JsonIndexStore(file);
    await store.save(state(7));

    // Still there, and no longer what was written: half an index, a
    // conflicted copy of one, a tidy-up script's idea of tidy.
    await writeFile(file, "{}");
    await store.save(state(7));

    expect(await new JsonIndexStore(file).load()).toEqual(state(7));
  });

  it("writes again when a same-size overwrite lands under it (R3)", async () => {
    const file = join(root, ".basalt", "index.json");
    const store = new JsonIndexStore(file);
    await store.save(state(7));

    // Exactly as long as what was written, so the size half of the stamp
    // cannot see it and the modification time is the half that has to. Set
    // by hand rather than left to the clock, because the residual this does
    // not cover is a filesystem whose clock did not move: a same-size
    // overwrite inside one tick still skips.
    const was = await readFile(file, "utf8");
    await writeFile(file, "!".repeat(was.length));
    const later = new Date(Date.now() + 2_000);
    await utimes(file, later, later);
    await store.save(state(7));

    expect(await new JsonIndexStore(file).load()).toEqual(state(7));
  });

  /**
   * Rule 2, and the incident behind it: code that read a config file, fell
   * back to an empty result on error, and wrote that back disabled every plugin
   * on a device. An index that cannot be read must stop the run, not be
   * silently replaced with a blank one that then re-uploads the vault.
   */
  it("refuses to start from an index it cannot parse", async () => {
    const file = join(root, "index.json");
    await writeFile(file, "{ this is not json");
    await expect(new JsonIndexStore(file).load()).rejects.toThrow(/not valid JSON/);
  });

  it("refuses to start from an index it cannot read", async () => {
    const file = join(root, "index.json");
    await writeFile(file, "{}");
    const { chmod } = await import("node:fs/promises");
    await chmod(file, 0o000);
    try {
      await expect(new JsonIndexStore(file).load()).rejects.toThrow(/cannot read the index/);
    } finally {
      await chmod(file, 0o644);
    }
  });

  it("leaves the previous index intact until the new one is complete", async () => {
    // A half-written index is worse than none: no index re-reads the vault
    // and recovers, while a truncated one is read as fact.
    const file = join(root, "index.json");
    const store = new JsonIndexStore(file);
    await store.save(state(1));
    await store.save(state(2));
    expect((await store.load())?.cursor).toBe(2);
    // No temporary left behind to be mistaken for the real thing.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

/**
 * A deletion arriving over the wire was somebody's decision on another device,
 * possibly a mistaken one, and the first rule is not to lose a note.
 *
 * The Obsidian adapter has always trashed rather than deleted and this one did
 * not, which is the same defect Sync Engine had reported against it as issue
 * 232: files destroyed on one platform and trashed on another, by the same
 * sync. Found by reading their issues rather than by anything failing here.
 */
describe("deleting, which must be recoverable", () => {
  it("moves a file to the vault's trash rather than destroying it", async () => {
    const v = new NodeVault(root);
    await v.write("notes/gone.md", enc.encode("here for now"), { mtime: 1, ctime: 1 });

    await v.remove("notes/gone.md");
    expect(await v.exists("notes/gone.md")).toBe(false);
    expect(dec.decode(await readFile(join(root, ".trash", "notes", "gone.md")))).toBe(
      "here for now",
    );
  });

  it("moves a folder too", async () => {
    const v = new NodeVault(root);
    await v.write("folder/inside.md", enc.encode("in there"), { mtime: 1, ctime: 1 });
    await v.remove("folder");
    expect(await v.exists("folder")).toBe(false);
    expect(dec.decode(await readFile(join(root, ".trash", "folder", "inside.md")))).toBe(
      "in there",
    );
  });

  /**
   * Deleting, restoring and deleting again is ordinary, and the second
   * deletion overwriting the first would quietly discard a version somebody
   * might want.
   */
  it("does not overwrite what is already in the trash", async () => {
    const v = new NodeVault(root);
    await v.write("note.md", enc.encode("the first one"), { mtime: 1, ctime: 1 });
    await v.remove("note.md");
    await v.write("note.md", enc.encode("the second one"), { mtime: 2, ctime: 1 });
    await v.remove("note.md");

    const { readdir } = await import("node:fs/promises");
    const trashed = (await readdir(join(root, ".trash"))).sort();
    expect(trashed.length, `the trash holds ${JSON.stringify(trashed)}`).toBe(2);
    const contents = await Promise.all(
      trashed.map((f) => readFile(join(root, ".trash", f), "utf8")),
    );
    expect(contents.sort()).toEqual(["the first one", "the second one"]);
  });

  it("keeps the trash out of the listing, so it does not sync back", async () => {
    // Otherwise what was deleted travels back out and undoes the deletion
    // on every other device in turn.
    const v = new NodeVault(root);
    await v.write("note.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    await v.remove("note.md");
    await v.write("kept.md", enc.encode("y"), { mtime: 1, ctime: 1 });
    expect((await v.list()).map((f) => f.path)).toEqual(["kept.md"]);
  });

  it("removing something already gone is still not an error", async () => {
    const v = new NodeVault(root);
    await expect(v.remove("never-existed.md")).resolves.toBeUndefined();
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(root, ".trash"))).rejects.toThrow();
  });
});

/**
 * Durability, and the file beside the file.
 *
 * The engine writes a downloaded note and then saves an index saying it is
 * synced. With neither fsynced, a power cut can leave the index on disk and the
 * note not, and the next pass reads a missing file with a matching synchash as
 * "the user deleted this" and propagates the deletion everywhere.
 *
 * What a test can check is every step except the flushes: whether an fsync
 * reached the platter is not observable from a process on any OS. So these
 * cover the outcome, the temp files, and the one hazard the old temp name
 * carried.
 */
describe("writing durably", () => {
  it("leaves the destination correct and no temporary files behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basalt-durable-"));
    try {
      const at = join(dir, "note.md");
      await writeDurably(at, new TextEncoder().encode("the contents"));
      expect(await readFile(at, "utf8")).toBe("the contents");

      const strays = (await readdir(dir)).filter((n) => isTemporary(n));
      expect(strays, `temporary files survived: ${strays.join(", ")}`).toEqual([]);
    } finally {
      await removeTree(dir);
    }
  });

  // A vault is somebody's own directory and they can name a file anything.
  // The temp name used to be exactly `<file>.basalt-tmp`, so a real note at
  // that path was truncated by the next write of `<file>` and then renamed
  // out of existence: two of somebody's files destroyed by a write to a
  // third. The property is broader than that one name, so the test is too.
  it("touches nothing in the directory except the file it was asked to write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basalt-durable-"));
    try {
      const bystanders: Record<string, string> = {
        "note.md.basalt-tmp": "the name this client used to use",
        "note.md.basalt-tmp-0": "and the shape it uses now",
        "note.md.backup": "somebody's own copy",
        "note.md": "the old contents",
        "other.md": "an unrelated note",
      };
      for (const [name, text] of Object.entries(bystanders)) {
        await writeFile(join(dir, name), text);
      }

      await writeDurably(join(dir, "note.md"), new TextEncoder().encode("new contents"));

      expect(await readFile(join(dir, "note.md"), "utf8")).toBe("new contents");
      for (const [name, text] of Object.entries(bystanders)) {
        if (name === "note.md") continue;
        expect(await readFile(join(dir, name), "utf8"), `${name} was modified`).toBe(text);
      }
    } finally {
      await removeTree(dir);
    }
  });

  it("keeps a write in flight out of the listing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basalt-durable-"));
    try {
      await writeFile(join(dir, "real.md"), "a note");
      await writeFile(join(dir, `real.md${TEMP_MARK}7`), "half a note");

      const vault = new NodeVault(dir);
      const paths = (await vault.list()).map((s) => s.path);
      expect(paths).toContain("real.md");
      expect(paths.some((p) => isTemporary(p))).toBe(false);
    } finally {
      await removeTree(dir);
    }
  });
});

/**
 * Streaming a file, which is how a large one is sent without being held.
 *
 * The chunk names go up before any body does, so the file is read once to name
 * it and again for the chunks the server asks for. Both reads have to agree
 * with each other and with reading it whole, or a chunk would go up under a
 * name that is not its own.
 */
describe("reading a file in blocks and in ranges", () => {
  const body = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
    return out;
  };

  it("streams exactly what reading it whole would give", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basalt-stream-"));
    try {
      const bytes = body(700_000);
      await writeFile(join(dir, "big.bin"), bytes);
      const vault = new NodeVault(dir);

      const blocks: Uint8Array[] = [];
      for await (const b of vault.readBlocks("big.bin", 64 * 1024)) blocks.push(b);
      expect(blocks.length).toBeGreaterThan(1);

      const joined = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
      let at = 0;
      for (const b of blocks) {
        joined.set(b, at);
        at += b.length;
      }
      expect(joined).toEqual(await vault.read("big.bin"));
    } finally {
      await removeTree(dir);
    }
  });

  // The block buffer is reused, so a generator yielding views rather than
  // copies would hand out blocks that are rewritten before they are used.
  it("gives blocks that survive the next block being read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basalt-stream-"));
    try {
      await writeFile(join(dir, "big.bin"), body(400_000));
      const vault = new NodeVault(dir);

      const held: Uint8Array[] = [];
      for await (const b of vault.readBlocks("big.bin", 32 * 1024)) held.push(b);

      const whole = await vault.read("big.bin");
      let at = 0;
      for (const b of held) {
        expect(b, `block at ${at} was overwritten`).toEqual(whole.subarray(at, at + b.length));
        at += b.length;
      }
    } finally {
      await removeTree(dir);
    }
  });

  it("reads a range, and reports a short one rather than padding it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basalt-stream-"));
    try {
      const bytes = body(10_000);
      await writeFile(join(dir, "big.bin"), bytes);
      const vault = new NodeVault(dir);

      expect(await vault.readRange("big.bin", 1000, 3000)).toEqual(bytes.subarray(1000, 3000));
      expect(await vault.readRange("big.bin", 0, 1)).toEqual(bytes.subarray(0, 1));

      // Past the end, which is what a file shrinking mid-upload looks
      // like. Short is the honest answer; zeroes would be bytes nobody
      // wrote, sent under a name that is not theirs.
      const past = await vault.readRange("big.bin", 9_000, 12_000);
      expect(past.length).toBe(1_000);
      expect(past).toEqual(bytes.subarray(9_000));
    } finally {
      await removeTree(dir);
    }
  });
});

/**
 * A symlinked folder inside a vault is ordinary practice: a shared attachments
 * directory, a media mount, a notes tree living elsewhere. `absolute` proved
 * containment on the *string* only, and every write followed the link, so a peer
 * naming a path under such a folder wrote outside the vault with the user's
 * privileges. `list` deliberately does not follow or report symlinks, so the
 * folder never syncs out and the vault never learns it exists: the write side
 * was the only side that disagreed.
 */
describe("a symlinked folder is not a way out of the vault", () => {
  it("refuses to write through one, and leaves what is out there alone", async () => {
    const {
      symlink,
      mkdir: mkdirp,
      writeFile: wf,
      readFile: rf,
    } = await import("node:fs/promises");
    const outside = join(root, "..", `outside-${Date.now()}`);
    await mkdirp(outside, { recursive: true });
    const victim = join(outside, "authorized_keys");
    await wf(victim, "the real contents\n");
    await symlink(outside, join(root, "Attachments"));

    const vault = new NodeVault(root);
    await expect(
      vault.write("Attachments/authorized_keys", enc.encode("written by a peer\n"), {
        mtime: 1_700_000_000_000,
        ctime: 1_700_000_000_000,
      }),
    ).rejects.toThrow();

    expect(await rf(victim, "utf8")).toBe("the real contents\n");
    await removeTree(outside);
  });

  it("refuses to make a directory through one", async () => {
    const { symlink, mkdir: mkdirp } = await import("node:fs/promises");
    const outside = join(root, "..", `outside2-${Date.now()}`);
    await mkdirp(outside, { recursive: true });
    await symlink(outside, join(root, "Media"));

    await expect(new NodeVault(root).mkdir("Media/deep")).rejects.toThrow();
    await removeTree(outside);
  });

  it("still writes into an ordinary folder of the same shape", async () => {
    const vault = new NodeVault(root);
    await vault.write("Attachments/real.md", enc.encode("fine\n"), {
      mtime: 1_700_000_000_000,
      ctime: 1_700_000_000_000,
    });
    expect(dec.decode(await vault.read("Attachments/real.md"))).toBe("fine\n");
  });
});

/**
 * A pass that changed nothing should not rewrite the index.
 *
 * Every pass ends with a save, and a settled vault passes on every watch tick
 * and every keepalive, so a 2000 file vault was serialising and flushing
 * megabytes every thirty seconds to record that nothing had happened. Two
 * separate performance audits found it independently.
 */
describe("the index is not rewritten when it has not changed", () => {
  const state = { cursor: 7, entries: {}, remote: {}, pending: [] } as never;

  it("leaves the file alone on an identical save", async () => {
    const file = join(root, ".basalt", "index.json");
    const store = new JsonIndexStore(file);
    await store.save(state);
    const first = await stat(file);

    // Far enough apart that a rewrite would be visible in the timestamps.
    await new Promise((r) => setTimeout(r, 20));
    await store.save(state);
    const second = await stat(file);

    expect(second.mtimeMs, "the index was rewritten with the same bytes").toBe(first.mtimeMs);
  });

  it("writes what changed to the journal, and leaves the snapshot where it is", async () => {
    // The whole point of the journal: an ordinary pass costs one record, not a
    // rewrite of the index. The snapshot not moving is the property; the state
    // coming back is what makes that safe rather than a silent loss.
    const file = join(root, ".basalt", "index2.json");
    const log = join(root, ".basalt", "index2.log");
    const store = new JsonIndexStore(file);
    await store.save(state);
    const first = await stat(file);

    await new Promise((r) => setTimeout(r, 20));
    await store.save({ ...(state as object), cursor: 8 } as never);
    const second = await stat(file);

    expect(second.mtimeMs, "an ordinary pass rewrote the whole index").toBe(first.mtimeMs);
    expect((await stat(log)).size, "the change did not reach the journal").toBeGreaterThan(0);
    expect((await store.load())?.cursor).toBe(8);
    expect((await new JsonIndexStore(file).load())?.cursor, "a restart lost the change").toBe(8);
  });

  /**
   * A skipped write must never be one that failed.
   *
   * The failure has to land in the write itself rather than in the mkdir
   * ahead of it, or this proves nothing about the ordering: an earlier throw
   * happens before the record either way. So the index path is a directory,
   * which lets the mkdir succeed and the write fail.
   */
  it("still owes the write after a failed one", async () => {
    const file = join(root, "blocked", "index.json");
    await mkdir(file, { recursive: true });
    const store = new JsonIndexStore(file);

    await expect(store.save(state), "the write should have failed").rejects.toThrow();
    // The second attempt must try again rather than think it already wrote.
    await expect(store.save(state), "a failed write was recorded as done").rejects.toThrow();
  });
});

/**
 * The scan does not follow symlinks, and cannot be made to loop by one.
 *
 * The write side proves containment against the resolved filesystem, and the
 * question was whether the scan side agreed. `readdir` with file types answers
 * for the entry itself rather than its target, so a link is neither a file nor
 * a directory to the filter and is dropped before anything looks through it.
 * These pin that, including the cyclic case where following would never end.
 */
describe("symlinks in the listing", () => {
  it("does not list a link to a file, as a file or as a link", async () => {
    await writeFile(join(root, "real.md"), "x");
    await symlink(join(root, "real.md"), join(root, "link.md"));
    const listed = await new NodeVault(root).list();
    expect(listed.map((f) => f.path)).toEqual(["real.md"]);
  });

  it("does not follow a link to a folder inside the vault, so nothing is listed twice", async () => {
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "one.md"), "x");
    await symlink(join(root, "notes"), join(root, "alias"));
    const listed = await new NodeVault(root).list();
    expect(listed.map((f) => f.path)).toEqual(["notes", "notes/one.md"]);
  });

  it("terminates on a cyclic link", async () => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "note.md"), "x");
    await symlink("..", join(root, "a", "b", "up"));
    await symlink(root, join(root, "a", "self"));
    const listed = await new NodeVault(root).list();
    expect(listed.map((f) => f.path)).toEqual(["a", "a/b", "a/b/note.md"]);
  });

  it("writing over a link replaces the link and leaves what it pointed at alone", async () => {
    const outside = await mkdtemp(join(tmpdir(), "basalt-target-"));
    try {
      const target = join(outside, "target.md");
      await writeFile(target, "the target's own text\n");
      await symlink(target, join(root, "link.md"));
      const vault = new NodeVault(root);
      await vault.write("link.md", enc.encode("from a peer\n"), {
        mtime: 1_700_000_000_000,
        ctime: 1_700_000_000_000,
      });
      expect(await readFile(target, "utf8")).toBe("the target's own text\n");
      const { lstat } = await import("node:fs/promises");
      expect((await lstat(join(root, "link.md"))).isSymbolicLink()).toBe(false);
      expect(await readFile(join(root, "link.md"), "utf8")).toBe("from a peer\n");
    } finally {
      await removeTree(outside);
    }
  });
});

/**
 * One name, spelled two ways on disk.
 *
 * macOS hands out filenames in NFD and everything else in NFC, and the two are
 * the same name by definition, not two candidates for a person to choose
 * between. The plugin normalises to NFC on the way out and maps back on the way
 * in; this vault listed whatever `readdir` said, so the same note left a Mac
 * under one spelling and every other device under another.
 */
describe("an --ignore spelled the way a Mac shell spells it", () => {
  // The listing folds every name to NFC before asking whether it is ignored,
  // so an ignore list left in the disk's own spelling stopped matching. What
  // that costs is not a warning: it is a folder somebody kept off the server
  // being uploaded on the next pass, silently. Both spellings must work,
  // because a person gets NFD from tab completion and NFC from typing it.
  const nfdName = "Attache\u0301s"; // e + combining acute, what a Mac disk holds
  const nfcName = "Attach\u00e9s"; // precomposed, what typing it gives you

  for (const [how, spelling] of [
    ["the disk's spelling (NFD)", nfdName],
    ["a typed spelling (NFC)", nfcName],
  ] as const) {
    it(`keeps the folder off the server when --ignore uses ${how}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "basalt-ignore-nfc-"));
      await mkdir(join(root, nfdName), { recursive: true });
      await writeFile(join(root, nfdName, "private.md"), "not for the server");
      await writeFile(join(root, "shared.md"), "fine");

      const listed = (await new NodeVault(root, { alsoIgnore: [spelling] }).list()).map(
        (f) => f.path,
      );
      expect(listed, `${spelling} did not match`).not.toContain(
        `${nfcName}/private.md`.normalize("NFC"),
      );
      expect(
        listed.some((p) => p.includes("private.md")),
        "the note leaked",
      ).toBe(false);
      expect(listed).toContain("shared.md");
      await rm(root, { recursive: true, force: true });
    });
  }
});

describe("a name the disk spells in NFD", () => {
  const nfd = "café.md";
  const nfc = "café.md";
  const times = { mtime: 1_700_000_000_000, ctime: 1_700_000_000_000 };

  /** The vault's files as the disk spells them, without the state folder. */
  async function onDisk(): Promise<string[]> {
    return (await readdir(root)).filter((n) => !n.startsWith("."));
  }

  it("is listed in NFC, which is how every other device spells it", async () => {
    await writeFile(join(root, nfd), "x");
    const listed = await new NodeVault(root).list();
    expect(listed.map((f) => f.path)).toEqual([nfc]);
  });

  it("is renamed on disk to the spelling every other device uses (C44)", async () => {
    // The listing said NFC and the disk went on holding NFD, so a Mac was
    // left as the only device with that spelling and every other device had
    // the other one. Invisible here, where the two reach one file, and two
    // filenames in two vaults that are meant to be one on ext4. APFS does
    // perform this rename and keeps the bytes it is given, which is what
    // makes it checkable on this machine at all; the mechanism is pinned on
    // any filesystem in cli/vault-spelling.test.ts.
    await writeFile(join(root, nfd), "on disk");
    await new NodeVault(root).list();
    expect(await onDisk()).toEqual([nfc]);
    expect(await readFile(join(root, nfc), "utf8")).toBe("on disk");
  });

  it("is read and written under the NFC name without making a second file", async () => {
    await writeFile(join(root, nfd), "on disk");
    const vault = new NodeVault(root);
    await vault.list();
    expect(dec.decode(await vault.read(nfc))).toBe("on disk");
    expect(await vault.exists(nfc)).toBe(true);

    await vault.write(nfc, enc.encode("updated"), times);
    expect(await onDisk()).toHaveLength(1);
    expect(dec.decode(await vault.read(nfc))).toBe("updated");
    expect((await vault.list()).map((f) => f.path)).toEqual([nfc]);
  });

  it("names both files when a vault holds both spellings, and syncs the rest", async () => {
    await writeFile(join(root, nfd), "one");
    await writeFile(join(root, nfc), "two");
    await writeFile(join(root, "unrelated.md"), "fine");
    // A disk that files the two as one file has nothing to be ambiguous about.
    if ((await onDisk()).length < 3) return;
    const vault = new NodeVault(root);
    // Not a refusal of the whole vault, which is what this used to be: one
    // pair nobody can name is not a reason to stop every other note.
    expect((await vault.list()).map((f) => f.path)).toEqual(["unrelated.md"]);
    expect(vault.ambiguous().map((a) => a.path)).toEqual([nfc]);
  });
});
