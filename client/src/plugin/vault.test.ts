/**
 * The Obsidian adapter, against a faithful fake of Obsidian's own interface.
 *
 * This file could not exist until `fake.ts` did, and the reason it is worth
 * having is in that file's header: the fake is declared `implements DataAdapter`
 * against the real declarations, and the one behaviour that matters is copied
 * out of the shipped application rather than assumed.
 *
 * What is still not covered: whether Obsidian calls the adapter the way this
 * expects. That needs Obsidian. Everything the plugin's own code does with it is
 * here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeAdapter, FakeVaultIndex, asVault, normalizePath } from "./fake.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";

let adapter: FakeAdapter;
let vault: ObsidianVault;

beforeEach(() => {
  adapter = new FakeAdapter();
  vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
});

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("normalizePath, as Obsidian actually ships it", () => {
  /**
   * These are not tests of this project's code. They are what was read out of
   * `obsidian.asar`, written down so that a future version changing any of it
   * is noticed here rather than in somebody's vault.
   */
  it("collapses slashes and strips the ends", () => {
    expect(normalizePath("/a/b/")).toBe("a/b");
    expect(normalizePath("a//b///c")).toBe("a/b/c");
    expect(normalizePath("a\\b")).toBe("a/b");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/")).toBe("/");
  });

  /**
   * The surprising one, and the reason the adapter below normalizes on the way
   * in as well as on the way out. A non-breaking space in a filename becomes
   * an ordinary space, so the path handed over is not the path written.
   */
  it("rewrites a non-breaking space into an ordinary one", () => {
    expect(normalizePath("a b.md")).toBe("a b.md");
    expect(normalizePath("a b.md")).toBe("a b.md");
    expect(normalizePath("a b.md")).not.toBe("a b.md");
  });

  it("normalizes to NFC, which is what macOS does not hand out", () => {
    const nfd = "café.md";
    const nfc = "café.md";
    expect(nfd).not.toBe(nfc);
    expect(normalizePath(nfd)).toBe(nfc);
  });
});

describe("listing", () => {
  it("reports files and the folders above them", async () => {
    adapter.seed("top.md", "top");
    adapter.seed("notes/one.md", "one");
    adapter.seed("notes/deep/two.md", "two");

    const listed = await vault.list();
    expect(listed.map((f) => f.path).sort()).toEqual([
      "notes",
      "notes/deep",
      "notes/deep/two.md",
      "notes/one.md",
      "top.md",
    ]);
    const byPath = new Map(listed.map((f) => [f.path, f]));
    expect(byPath.get("notes")?.folder).toBe(true);
    expect(byPath.get("top.md")?.folder).toBe(false);
    expect(byPath.get("top.md")?.size).toBe(3);
  });

  it("leaves the directories that must never sync alone", async () => {
    // Obsidian's own index leaves out every dot-prefixed path, so in a real
    // vault these never reach the filter at all. The fake is told to hand
    // them over anyway: the filter is the thing under test, and one that
    // works only because its input was already clean is not tested.
    adapter.indexHidesDotfiles = false;
    // Plugin and settings sync is refused, and one device disabling every
    // plugin on another is the incident that rule came from.
    for (const dir of [".obsidian", ".basalt", ".git", ".trash"]) {
      adapter.seed(`${dir}/inside.md`, "x");
    }
    adapter.seed("real.md", "x");
    expect((await vault.list()).map((f) => f.path)).toEqual(["real.md"]);
  });

  /**
   * The config folder is "typically `.obsidian` but it could be different",
   * says the API, and that folder holds this plugin's `data.json`, and that
   * file holds the root secret. Hardcoding the usual name would mean a vault
   * with a custom one uploaded its own key.
   */
  it("leaves alone whatever Obsidian calls its config folder", async () => {
    adapter.indexHidesDotfiles = false; // As above: the filter is what is under test.
    const odd = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".my-config");
    adapter.seed(".my-config/plugins/basalt/data.json", "the root secret lives here");
    adapter.seed("real.md", "x");
    expect((await odd.list()).map((f) => f.path)).toEqual(["real.md"]);

    // And a stray `.obsidian` in a vault configured elsewhere still does not
    // sync, because nothing dot-prefixed does, whatever it is called.
    adapter.seed(".obsidian/leftover.json", "{}");
    expect((await odd.list()).map((f) => f.path)).not.toContain(".obsidian");
  });

  it("refuses a config folder that is not a plain name", async () => {
    // Anything else means the exclusion would not match what it should, and
    // a silently wrong exclusion is how the secret gets uploaded.
    for (const bad of ["", "/", "a/b"]) {
      expect(
        () => new ObsidianVault(asVault(new FakeVaultIndex(adapter)), bad),
        JSON.stringify(bad),
      ).toThrow(/plain name/);
    }
  });

  it("leaves a never-sync folder alone at any depth", async () => {
    adapter.indexHidesDotfiles = false; // As above: the filter is what is under test.
    adapter.seed("notes/.obsidian/workspace.json", "{}");
    adapter.seed("notes/real.md", "x");
    expect((await vault.list()).map((f) => f.path).sort()).toEqual(["notes", "notes/real.md"]);
  });

  /**
   * The bug this file was written to find.
   *
   * `normalizePath` rewrites a non-breaking space, so a listing that reported
   * the raw name would give the engine a path that `read` and `write` then
   * resolve to a different file. The engine would see the raw path vanish on
   * the next scan and call it a deletion, and see the normalized one appear
   * and call it a new file, forever.
   */
  it("reports paths in the form that reading and writing will use", async () => {
    adapter.seed("a b.md", "nbsp");
    adapter.seed("café.md", "nfd");
    adapter.seed("plain.md", "plain");

    const listed = await vault.list();
    // Nothing was dropped. This is the whole point: the first version of the
    // adapter returned only "plain.md", and the other two notes would never
    // have synced with nothing said about it.
    expect(listed.length).toBe(3);

    for (const file of listed) {
      expect(file.path, `${JSON.stringify(file.path)} is not in normalized form`).toBe(
        normalizePath(file.path),
      );
      // And the path it reported is one it can actually read back.
      expect(dec.decode(await vault.read(file.path)), file.path).toBeTruthy();
    }
  });

  /**
   * A path the engine got from `list` has to survive a round trip through
   * every other method, or the engine and the vault are talking about
   * different files.
   */
  it("round trips a name Obsidian would rewrite", async () => {
    adapter.seed("a b.md", "original");
    const [file] = await vault.list();
    const path = file!.path;
    expect(path).toBe("a b.md");

    expect(await vault.exists(path)).toBe(true);
    await vault.write(path, enc.encode("edited"), { mtime: 5000, ctime: 5000 });
    expect(dec.decode(await vault.read(path))).toBe("edited");

    // Written to the file that was already there, not to a second one
    // beside it under the normalized name.
    expect(adapter.filePaths()).toEqual(["a b.md"]);

    await vault.remove(path);
    expect(await vault.exists(path)).toBe(false);
  });
});

describe("reading and writing", () => {
  it("round trips bytes", async () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 128]);
    await vault.write("bin/file.dat", bytes, { mtime: 1_700_000_000_000, ctime: 0 });
    expect(await vault.read("bin/file.dat")).toEqual(bytes);
  });

  it("creates the folders a path needs", async () => {
    await vault.write("a/b/c/note.md", enc.encode("deep"), { mtime: 1000, ctime: 1000 });
    expect(await vault.exists("a")).toBe(true);
    expect(await vault.exists("a/b")).toBe(true);
    expect(await vault.exists("a/b/c")).toBe(true);
    expect(dec.decode(await vault.read("a/b/c/note.md"))).toBe("deep");
  });

  /**
   * The engine's decision table compares mtimes. A downloaded file stamped
   * with the moment it landed looks locally edited on the next pass, so the
   * device would upload back what it just received, forever.
   */
  it("sets the modification time it was given", async () => {
    const when = 1_600_000_000_000;
    await vault.write("note.md", enc.encode("x"), { mtime: when, ctime: when });
    const listed = await vault.list();
    expect(listed.find((f) => f.path === "note.md")?.mtime).toBe(when);
  });

  it("does not hand over neighbouring bytes when given a view", async () => {
    // Chunk reassembly produces exactly this: a Uint8Array that is a window
    // into a larger buffer. Passing the view where the buffer is read writes
    // the whole thing.
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5);
    await vault.write("note.md", view, { mtime: 1, ctime: 1 });
    expect([...(await vault.read("note.md"))]).toEqual([1, 2, 3]);
  });
});

describe("deleting", () => {
  /**
   * A deletion arriving over the wire was somebody's decision on another
   * device, possibly a mistaken one, and the first rule is not to lose a note.
   */
  it("moves a file to the system trash where there is one", async () => {
    adapter.systemTrashWorks = true;
    adapter.seed("doomed.md", "x");
    await vault.remove("doomed.md");

    expect(adapter.trashedToSystem).toEqual(["doomed.md"]);
    expect(adapter.trashedLocally).toEqual([]);
    expect(await vault.exists("doomed.md")).toBe(false);
  });

  it("falls back to the vault's own trash where there is not", async () => {
    adapter.systemTrashWorks = false;
    adapter.seed("doomed.md", "x");
    await vault.remove("doomed.md");

    expect(adapter.trashedLocally).toEqual(["doomed.md"]);
    expect(adapter.text(".trash/doomed.md")).toBe("x");
  });

  it("falls back when the system trash throws rather than refusing", async () => {
    // A locked file, or a platform whose trash is not there. Failing to
    // reach the recycle bin is not a reason to abandon the deletion.
    adapter.systemTrashThrows = true;
    adapter.seed("doomed.md", "x");
    await vault.remove("doomed.md");
    expect(adapter.trashedLocally).toEqual(["doomed.md"]);
  });

  it("removing something already gone is not an error", async () => {
    // Two devices deleting the same file produces this routinely.
    await expect(vault.remove("never-existed.md")).resolves.toBeUndefined();
    expect(adapter.trashedLocally).toEqual([]);
  });

  it("never syncs what it trashed", async () => {
    // .trash is in the never-sync list. Syncing it back would undo the
    // deletion on every other device in turn.
    adapter.seed("doomed.md", "x");
    await vault.remove("doomed.md");
    expect((await vault.list()).map((f) => f.path)).not.toContain(".trash/doomed.md");
  });
});

describe("paths from elsewhere", () => {
  /**
   * Paths arrive from the server, sealed by another device. The seal proves
   * they came from someone holding the vault key; it does not prove that
   * device is well, and a bug on it is enough.
   */
  it("refuses to write outside the vault", async () => {
    for (const path of [
      "../escaped.md",
      "../../escaped.md",
      "a/../../escaped.md",
      "a/b/../../../out.md",
    ]) {
      await expect(
        vault.write(path, enc.encode("x"), { mtime: 1, ctime: 1 }),
        path,
      ).rejects.toThrow(/outside the vault/);
    }
    expect(adapter.filePaths()).toEqual([]);
  });

  it("refuses to read, remove or make a folder outside the vault", async () => {
    await expect(vault.read("../secret.md")).rejects.toThrow(/outside the vault/);
    await expect(vault.remove("../important")).rejects.toThrow(/outside the vault/);
    await expect(vault.mkdir("../elsewhere")).rejects.toThrow(/outside the vault/);
  });

  it("allows a path that merely looks alarming", async () => {
    // `..` inside a name is a filename, not a traversal, and refusing it
    // would make a legitimate note unsyncable.
    await vault.write("notes/a..b.md", enc.encode("fine"), { mtime: 1, ctime: 1 });
    expect(dec.decode(await vault.read("notes/a..b.md"))).toBe("fine");
  });

  it("refuses a path that normalizes to nothing", async () => {
    // normalizePath("") and normalizePath("/") are both "/", the vault root.
    // Writing a file there is not a thing, and quietly doing something is
    // worse than refusing.
    for (const path of ["", "/", "///"]) {
      await expect(
        vault.write(path, enc.encode("x"), { mtime: 1, ctime: 1 }),
        JSON.stringify(path),
      ).rejects.toThrow();
    }
  });
});

describe("the index", () => {
  const state = (cursor: number) => ({
    cursor,
    entries: { "note.md": { path: "note.md", hash: "h" } },
    remote: { "note.md": { uid: 1 } },
    pending: ["note.md"],
  });

  it("round trips", async () => {
    const store = new ObsidianIndexStore(adapter, ".obsidian/plugins/basalt/index.json");
    await store.save(state(7));
    expect(await store.load()).toEqual(state(7));
  });

  it("reports nothing when there is nothing yet", async () => {
    expect(await new ObsidianIndexStore(adapter, "nowhere/index.json").load()).toBeUndefined();
  });

  /**
   * Rule 2, and the incident behind it: code that read a config file, fell
   * back to an empty result on error, and wrote that back disabled every
   * plugin on a device. An index that cannot be read must stop the run, not be
   * replaced with a blank one that then re-uploads the vault.
   */
  it("refuses to start from an index it cannot parse", async () => {
    await adapter.write("index.json", "{ this is not json");
    await expect(new ObsidianIndexStore(adapter, "index.json").load()).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("creates the folder it needs", async () => {
    const store = new ObsidianIndexStore(adapter, "deep/nested/index.json");
    await store.save(state(1));
    expect(await adapter.exists("deep/nested")).toBe(true);
    expect((await store.load())?.cursor).toBe(1);
  });
});

/**
 * The scan reads Obsidian's own index rather than asking the adapter about
 * every file in turn.
 *
 * On a desktop the difference is wasteful; on a phone it is the difference
 * between a scan you do not notice and one you do, since every adapter call
 * crosses into the platform. The listing happens on every pass, so the cost is
 * per pass, for ever.
 */
describe("what a scan costs", () => {
  it("does not ask the adapter about each file", async () => {
    const a = new FakeAdapter();
    for (let i = 0; i < 200; i++) a.seed(`folder${i % 10}/note-${i}.md`, "x");
    const counting = new CountingAdapter(a);
    const v = new ObsidianVault(
      asVault(new FakeVaultIndex(counting as unknown as FakeAdapter)),
      ".obsidian",
    );

    const listed = await v.list();
    expect(listed.length).toBe(210); // 200 notes and the 10 folders

    // One `exists`, the case-folding probe, and that only on the first
    // listing. Nothing per file.
    expect(
      { stat: counting.stats, list: counting.lists, exists: counting.exists_ },
      `a 200 file vault cost ${counting.stats} stat, ${counting.lists} list and ${counting.exists_} exists calls`,
    ).toEqual({ stat: 0, list: 0, exists: 1 });
    await v.list();
    expect(counting.exists_).toBe(1);
  });

  it("still reports what the walk did", async () => {
    // The same answers as before, from a different source. Folders with no
    // stat, files with theirs.
    const a = new FakeAdapter();
    a.seed("notes/deep/two.md", "two");
    a.seed("top.md", "top");
    const v = new ObsidianVault(asVault(new FakeVaultIndex(a)), ".obsidian");

    const byPath = new Map((await v.list()).map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual([
      "notes",
      "notes/deep",
      "notes/deep/two.md",
      "top.md",
    ]);
    expect(byPath.get("notes")?.folder).toBe(true);
    expect(byPath.get("top.md")?.folder).toBe(false);
    expect(byPath.get("top.md")?.size).toBe(3);
    expect(byPath.get("top.md")?.mtime).toBeGreaterThan(0);
  });
});

/** Counts what the plugin asks of the adapter, which is meant to be nothing. */
class CountingAdapter {
  stats = 0;
  lists = 0;
  exists_ = 0;

  constructor(private readonly inner: FakeAdapter) {}

  index() {
    return this.inner.index();
  }
  async stat(p: string) {
    this.stats++;
    return this.inner.stat(p);
  }
  async list(p: string) {
    this.lists++;
    return this.inner.list(p);
  }
  async exists(p: string) {
    this.exists_++;
    return this.inner.exists(p);
  }
}

/**
 * Streaming through the resource URL, which is how the plugin sends a large
 * attachment without holding it. `DataAdapter` has no ranged or streaming read,
 * but `getResourcePath` returns a URL the webview already fetches for images,
 * and that response carries a body stream and honours a Range header. Verified
 * in a running Obsidian on desktop; unverified on mobile, which is why the
 * engine falls back rather than failing a file.
 */
describe("reading a file through its resource URL", () => {
  /**
   * Test bytes that do not repeat.
   *
   * This was `(i * 37 + (i >> 7)) & 0xff`, whose period is 32768, so every
   * 64 KiB block of it was byte-identical to every other. That made a whole
   * class of bug invisible: yielding a view of the reused block buffer instead
   * of a copy passed, because all the aliased blocks looked the same anyway.
   * Data that repeats at the block size cannot test blocking.
   */
  const body = (n: number) => {
    const out = new Uint8Array(n);
    let x = 0x2545f491;
    for (let i = 0; i < n; i++) {
      x = (Math.imul(x, 1103515245) + 12345) | 0;
      out[i] = (x >>> 16) & 0xff;
    }
    return out;
  };

  /** A vault whose resource URLs are served by a fetch this test controls. */
  function streaming(
    bytes: Uint8Array,
    opts: { honourRange?: boolean; fail?: boolean; pieces?: number } = {},
  ) {
    const adapter = new FakeAdapter();
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    (adapter as unknown as { getResourcePath(p: string): string }).getResourcePath = (p) =>
      `app://test/${p}`;

    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      if (opts.fail) return { ok: false, status: 404, body: null };
      const range = init?.headers?.["Range"];
      let slice = bytes;
      if (range && opts.honourRange !== false) {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
        slice = bytes.subarray(Number(a), Number(b) + 1);
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => slice.slice().buffer,
        body: {
          getReader() {
            // One piece unless the test asks for a shape. What a fetch hands
            // back is the transport's business, and re-blocking exists so the
            // chunker never sees it, so the shapes have to be tested.
            const piece = opts.pieces ?? slice.length;
            let at = 0;
            return {
              async read() {
                if (at >= slice.length) return { done: true, value: undefined };
                const next = slice.slice(at, at + Math.max(1, piece));
                at += next.length;
                return { done: false, value: next };
              },
            };
          },
        },
      };
    }) as never;
    return vault;
  }

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("streams the whole file in blocks of the size asked for", async () => {
    const bytes = body(300_000);
    const vault = streaming(bytes);
    const blocks: Uint8Array[] = [];
    for await (const b of vault.readBlocks("big.bin", 64 * 1024)) blocks.push(b);

    // Re-blocked, so what the chunker sees does not depend on how the
    // transport felt like splitting the response.
    expect(blocks.length).toBe(Math.ceil(300_000 / (64 * 1024)));
    expect(blocks.slice(0, -1).every((b) => b.length === 64 * 1024)).toBe(true);

    const joined = new Uint8Array(300_000);
    let at = 0;
    for (const b of blocks) {
      joined.set(b, at);
      at += b.length;
    }
    expect(joined).toEqual(bytes);
  });

  /**
   * The blocks must not depend on how the response arrived.
   *
   * The re-blocking used to grow a buffer by concatenation, which copied
   * everything held on every arriving piece: 2144 MiB copied and 4160 buffers
   * allocated to move 64 MiB when the pieces came 16 KiB at a time. It fills one
   * buffer now, and that is a different loop, so the shapes that used to take
   * the other branch are the ones worth checking.
   */
  it("blocks the same whatever size the pieces arrive in", async () => {
    // Small blocks, so the byte-at-a-time shapes are a few thousand reads
    // rather than a few hundred thousand.
    const size = 10_000;
    const bytes = body(size);
    const blockSize = 4096;

    for (const pieces of [1, 3, 1000, blockSize - 1, blockSize, blockSize + 1, size, size * 2]) {
      const vault = streaming(bytes, { pieces });
      const blocks: Uint8Array[] = [];
      for await (const b of vault.readBlocks("big.bin", blockSize)) blocks.push(b);

      expect(blocks.length, `pieces=${pieces}`).toBe(Math.ceil(size / blockSize));
      expect(
        blocks.slice(0, -1).every((b) => b.length === blockSize),
        `pieces=${pieces}: a block that is not full`,
      ).toBe(true);
      expect(blocks[blocks.length - 1]!.length, `pieces=${pieces}`).toBe(size % blockSize);

      const joined = new Uint8Array(size);
      let at = 0;
      for (const b of blocks) {
        joined.set(b, at);
        at += b.length;
      }
      expect(joined, `pieces=${pieces}: the bytes came out different`).toEqual(bytes);
    }
  });

  it("reads a range from the middle", async () => {
    const bytes = body(100_000);
    const vault = streaming(bytes);
    expect(await vault.readRange("big.bin", 40_000, 40_200)).toEqual(
      bytes.subarray(40_000, 40_200),
    );
  });

  // The failure that would otherwise be silent: a handler ignoring Range and
  // answering with the whole file. Those bytes would be sealed and refused by
  // the server for not matching their name, which is a fatal protocol error.
  // Caught here, it is a platform that cannot stream.
  it("refuses a vault that ignores the range rather than sending the wrong bytes", async () => {
    const vault = streaming(body(100_000), { honourRange: false });
    await expect(vault.readRange("big.bin", 40_000, 40_200)).rejects.toThrow(/ranged reads/);
  });

  it("says so when the resource cannot be fetched at all", async () => {
    const vault = streaming(body(1000), { fail: true });
    await expect(vault.readRange("big.bin", 0, 10)).rejects.toThrow(/404/);
  });
});

/**
 * A filesystem that folds case, which is what macOS and Windows are.
 *
 * `FakeAdapter` is a `Map` and so is case-sensitive, like Linux. Most of this
 * file is right to use it. This corner is not: the bug it covers only exists
 * where two spellings are one file, and on a case-sensitive fake there is
 * nothing to reproduce.
 *
 * The folding lives in the fake now, under the name and the two rules the
 * shipped adapter uses: a write lands on the spelling already on disk, and a
 * rename onto an occupied name is refused unless the two names differ only by
 * case. This used to be a subclass here that had the first rule and not the
 * second, so a rename onto a name that existed in another case succeeded and
 * left two files a folding disk could not have held.
 */
function foldingAdapter(): FakeAdapter {
  const adapter = new FakeAdapter();
  adapter.insensitive = true;
  return adapter;
}

describe("writing a name that differs only by case", () => {
  it("renames the file rather than leaving the old spelling", async () => {
    const folding = foldingAdapter();
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(folding)), ".obsidian");
    const times = { mtime: 1000, ctime: 1000 };

    await vault.write("Note.md", new TextEncoder().encode("first"), times);
    expect((await folding.list("/")).files).toContain("Note.md");

    // The other device renamed it. Writing the new spelling has to move the
    // directory entry, or the next scan calls NOTE.md missing and reports a
    // deletion that nobody made.
    await vault.write("NOTE.md", new TextEncoder().encode("first"), times);
    const listed = (await folding.list("/")).files;
    expect(listed).toContain("NOTE.md");
    expect(listed).not.toContain("Note.md");
    expect(listed.filter((f) => f.toLowerCase() === "note.md")).toHaveLength(1);
  });

  it("calls two spellings of one file the same file, and two files not", async () => {
    const folding = foldingAdapter();
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(folding)), ".obsidian");
    await vault.write("Note.md", new TextEncoder().encode("first"), { mtime: 1, ctime: 1 });

    expect(await vault.sameFile("Note.md", "NOTE.md")).toBe(true);
    expect(await vault.sameFile("Note.md", "Note.md")).toBe(true);
    // Different names are different files whatever the filesystem does.
    expect(await vault.sameFile("Note.md", "Other.md")).toBe(false);
  });
});

/**
 * review finding P17. The adapter's own write truncates the destination and then
 * fills it, read out of the shipped bundle, so a note used to be able to end up
 * empty with no copy of the old bytes or the new. Every failure below is one a
 * full disk or a killed process produces, and after each the note is either
 * as it was or complete.
 */
/** Whether a path is a staging copy beside `note`, whatever its random part. */
const isStaging = (path: string, note = "note.md") =>
  new RegExp(`^\\.basalt-tmp-[0-9a-f]{8}-${note.replace(".", "\\.")}$`).test(path);
/** The staging copies present, by name. */
const stagingCopies = (a: FakeAdapter) => a.filePaths().filter((p) => p.includes(".basalt-tmp-"));

describe("landing a note without a moment where it is half written (P17)", () => {
  const times = { mtime: 1000, ctime: 1000 };

  it("a new note arrives by rename, never by a write at its own path", async () => {
    await vault.write("note.md", enc.encode("fresh"), times);
    expect(adapter.text("note.md")).toBe("fresh");
    expect(stagingCopies(adapter)).toEqual([]);
    const writes = adapter.calls.filter((c) => c.op === "writeBinary").map((c) => c.path);
    expect(writes.length).toBe(1);
    expect(isStaging(writes[0]!)).toBe(true);
    expect(adapter.calls.some((c) => c.op === "rename" && c.to === "note.md")).toBe(true);
  });

  it("a write refused before anything lands leaves the note as it was", async () => {
    adapter.seed("note.md", "old");
    adapter.fault = (op, path) =>
      op === "writeBinary" && isStaging(path) ? new Error("EACCES: refused") : undefined;
    await expect(vault.write("note.md", enc.encode("new"), times)).rejects.toThrow(/EACCES/);
    expect(adapter.text("note.md")).toBe("old");
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("a staging copy cut short is caught by reading it back, and the note is untouched", async () => {
    adapter.seed("note.md", "old");
    adapter.fault = (op, path) => (op === "writeBinary" && isStaging(path) ? 2 : undefined);
    await expect(vault.write("note.md", enc.encode("new content"), times)).rejects.toThrow(
      /wrote 2 of 11/,
    );
    expect(adapter.text("note.md")).toBe("old");
    // Nothing half written is left lying about under a name that looks like a copy.
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("a short staging copy that the adapter did not report is still caught", async () => {
    // The adapter says the write succeeded and the file is short anyway. The
    // read-back is the only thing that can see it. Rule 4.
    adapter.seed("note.md", "old");
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      if (isStaging(path)) return realWrite(path, data.slice(0, 3), options);
      return realWrite(path, data, options);
    };
    await expect(vault.write("note.md", enc.encode("new content"), times)).rejects.toThrow(
      /3 bytes after writing 11/,
    );
    expect(adapter.text("note.md")).toBe("old");
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("a failure while replacing keeps the complete new copy beside the note and names it", async () => {
    adapter.seed("note.md", "old");
    adapter.fault = (op, path) => (op === "writeBinary" && path === "note.md" ? 1 : undefined);
    await expect(vault.write("note.md", enc.encode("new content"), times)).rejects.toThrow(
      /complete new content is beside it at \.basalt-tmp-[0-9a-f]{8}-note\.md/,
    );
    // The destination is what the adapter left, which is the failure this
    // API cannot prevent; the new version is whole beside it, and the old one
    // is on the server.
    const [copy] = stagingCopies(adapter);
    expect(copy).toBeDefined();
    expect(adapter.text(copy!)).toBe("new content");
  });

  it("a failure removing the staging copy does not fail a verified write", async () => {
    const logs: unknown[][] = [];
    const logging = new ObsidianVault(
      asVault(new FakeVaultIndex(adapter)),
      ".obsidian",
      (...rest) => void logs.push(rest),
    );
    adapter.seed("note.md", "old");
    adapter.fault = (op, path) =>
      op === "remove" && isStaging(path) ? new Error("EBUSY: in use") : undefined;
    await expect(logging.write("note.md", enc.encode("new"), times)).resolves.toBeUndefined();
    expect(adapter.text("note.md")).toBe("new");
    expect(logs.flat().join(" ")).toMatch(/staging copy/);
    // And the leftover is never listed as a note.
    expect((await logging.list()).map((f) => f.path)).toEqual(["note.md"]);
  });

  it("keeps the mtime it was given through the staging copy", async () => {
    await vault.write("note.md", enc.encode("x"), { mtime: 1_600_000_000_000, ctime: 0 });
    expect((await adapter.stat("note.md"))?.mtime).toBe(1_600_000_000_000);
  });
});

/**
 * review finding C17, the adapter half. `exists` and then `write` is a gap, and a
 * conflict copy or a restore landing in it replaced whatever appeared there.
 * The claim has to be exclusive, and `rename` refusing an occupied destination
 * is what makes it so.
 */
describe("creating a file only where nothing is (C17)", () => {
  const times = { mtime: 1000, ctime: 1000 };

  it("writes where nothing is, and refuses where something is", async () => {
    expect(await vault.create("new.md", enc.encode("mine"), times)).toBe(true);
    expect(adapter.text("new.md")).toBe("mine");
    expect(await vault.create("new.md", enc.encode("again"), times)).toBe(false);
    expect(adapter.text("new.md")).toBe("mine");
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("loses to a file that appears between looking and claiming", async () => {
    adapter.fault = (op, _path, to) => {
      // Somebody else writes the very name, in the gap.
      if (op === "rename" && to === "new.md") adapter.seed("new.md", "theirs");
      return undefined;
    };
    expect(await vault.create("new.md", enc.encode("mine"), times)).toBe(false);
    expect(adapter.text("new.md")).toBe("theirs");
    expect(stagingCopies(adapter)).toEqual([]);
  });

  it("does not report a claim it cannot prove", async () => {
    adapter.fault = (op, path) =>
      op === "writeBinary" && isStaging(path, "new.md") ? 1 : undefined;
    await expect(vault.create("new.md", enc.encode("mine"), times)).rejects.toThrow(/wrote 1/);
    expect(await adapter.exists("new.md")).toBe(false);
  });
});

/**
 * P20 and review finding C16. Two raw names in Obsidian's index that normalize to
 * one path used to be one entry in the map, the second winning silently.
 */
describe("two names the plugin cannot hold apart (P20)", () => {
  it("refuses a listing where two raw names normalize to one path, and names both", async () => {
    adapter.seed("a b.md", "nbsp");
    adapter.seed("a b.md", "space");
    adapter.seed("fine.md", "x");
    await expect(vault.list()).rejects.toThrow(/"a b\.md".*"a b\.md"|"a b\.md".*"a b\.md"/);
  });

  it("refuses NFC and NFD spellings of one name", async () => {
    adapter.seed("café.md", "nfc");
    adapter.seed("café.md", "nfd");
    await expect(vault.list()).rejects.toThrow(/only one of them can sync/);
  });

  it("folds normalization always, and case only where the adapter does", async () => {
    // Until asked, the safe answer: two spellings are one file.
    expect(vault.canonical("Note.md")).toBe(vault.canonical("note.md"));
    expect(vault.canonical("café.md")).toBe(vault.canonical("café.md"));
    expect(vault.canonical("a b.md")).toBe(vault.canonical("a b.md"));

    // The fake is a Map, which is case-sensitive like Linux, and the probe
    // finds that out from the first listing.
    adapter.seed("Note.md", "x");
    await vault.list();
    expect(vault.canonical("Note.md")).not.toBe(vault.canonical("note.md"));
    expect(vault.canonical("café.md")).toBe(vault.canonical("café.md"));

    const folding = foldingAdapter();
    const foldingVault = new ObsidianVault(asVault(new FakeVaultIndex(folding)), ".obsidian");
    await foldingVault.write("Note.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    await foldingVault.list();
    expect(foldingVault.canonical("Note.md")).toBe(foldingVault.canonical("note.md"));
  });

  it("two case spellings are two files where the adapter keeps them apart", async () => {
    adapter.seed("Note.md", "one");
    adapter.seed("note.md", "two");
    const listed = (await vault.list()).map((f) => f.path).sort();
    expect(listed).toEqual(["Note.md", "note.md"]);
    expect(vault.canonical("Note.md")).not.toBe(vault.canonical("note.md"));
  });
});

/**
 * review finding P21. `matchCase` used to shrug at a listing that failed and write
 * under a spelling nothing had checked, leaving the old spelling on disk while
 * the engine recorded the new one as synced.
 */
describe("a spelling check that cannot be made (P21)", () => {
  it("fails the write and leaves the note alone, then succeeds once it can", async () => {
    const folding = foldingAdapter();
    const v = new ObsidianVault(asVault(new FakeVaultIndex(folding)), ".obsidian");
    const times = { mtime: 1000, ctime: 1000 };
    await v.write("Note.md", enc.encode("first"), times);

    let failures = 1;
    folding.fault = (op) => (op === "list" && failures-- > 0 ? new Error("EIO") : undefined);
    await expect(v.write("NOTE.md", enc.encode("second"), times)).rejects.toThrow(
      /cannot check how NOTE.md is spelled/,
    );
    expect((await folding.list("/")).files).toEqual(["Note.md"]);
    expect(folding.text("Note.md")).toBe("first");

    await v.write("NOTE.md", enc.encode("second"), times);
    expect((await folding.list("/")).files).toEqual(["NOTE.md"]);
    expect(folding.text("NOTE.md")).toBe("second");
  });
});

/**
 * review finding P18. The index is written with the same truncating write as a
 * note, and an index cut short is not JSON, and an index that is not JSON stops
 * the plugin on every load. A vault whose notes were all fine sat behind it.
 */
describe("the index, interrupted (P18)", () => {
  const INDEX = ".obsidian/plugins/basalt/index.json";
  const TEMP = ".obsidian/plugins/basalt/.basalt-tmp-index-index.json";
  const LOG = ".obsidian/plugins/basalt/index.log";
  const state = (cursor: number) => ({
    cursor,
    entries: { "note.md": { path: "note.md", hash: `h${cursor}` } },
    remote: {},
    pending: [],
  });

  /**
   * Every save writes a whole snapshot, which is what these tests are about.
   *
   * With the ordinary policy the second save of a session appends one record
   * and never touches the snapshot, so a fault injected into the snapshot
   * write would never fire and every one of these would pass without testing
   * anything. Forcing the snapshot keeps them aimed at the path they were
   * written for.
   */
  const always = { policy: { fractionOfSnapshot: 0, maxRecords: 1, minBytes: 0 } };

  it("recovers from a live index cut short by reading the staged copy", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX, always);
    await store.save(state(1));
    adapter.fault = (op, path) => (op === "write" && path === INDEX ? 5 : undefined);
    await expect(store.save(state(2))).rejects.toThrow(/wrote 5 of/);
    expect(() => JSON.parse(adapter.text(INDEX)!)).toThrow();

    // A restart: a fresh store over the same files.
    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(2));
  });

  it("keeps the live index when the staging copy is what was cut short", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX, always);
    await store.save(state(1));
    adapter.fault = (op, path) => (op === "writeBinary" && path === TEMP ? 3 : undefined);
    await expect(store.save(state(2))).rejects.toThrow(/wrote 3/);
    expect(await adapter.exists(TEMP)).toBe(false);
    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(1));
  });

  it("loads the live index and tidies a staged copy left behind after a complete save", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX, always);
    await store.save(state(1));
    adapter.fault = (op, path) =>
      op === "remove" && path === TEMP ? new Error("EBUSY") : undefined;
    await expect(store.save(state(2))).resolves.toBeUndefined();
    expect(await adapter.exists(TEMP)).toBe(true);
    adapter.fault = undefined;

    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(2));
    expect(await adapter.exists(TEMP)).toBe(false);
  });

  it("a first save that fails leaves no index at all, not a short one", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX);
    adapter.fault = (op, path) => (op === "writeBinary" && path === TEMP ? 4 : undefined);
    await expect(store.save(state(1))).rejects.toThrow();
    expect(await adapter.exists(INDEX)).toBe(false);
    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toBeUndefined();
  });

  it("still refuses an unreadable index when there is nothing to recover it from", async () => {
    await adapter.write(INDEX, "{ cut sho");
    await expect(new ObsidianIndexStore(adapter, INDEX).load()).rejects.toThrow(/not valid JSON/);
  });

  it("removes every copy and proves it, for unlink", async () => {
    // Three files, not two. A journal left behind is a delta against a
    // snapshot that no longer exists, and the load after it refuses to start
    // rather than guessing at a base.
    const store = new ObsidianIndexStore(adapter, INDEX);
    await store.save(state(1));
    await store.save(state(2));
    expect(await adapter.exists(LOG), "nothing was journalled to remove").toBe(true);
    await adapter.write(TEMP, JSON.stringify(state(2)));
    await store.remove();
    expect(await adapter.exists(INDEX)).toBe(false);
    expect(await adapter.exists(TEMP)).toBe(false);
    expect(await adapter.exists(LOG), "the journal outlived the index").toBe(false);
    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toBeUndefined();

    await store.save(state(3));
    adapter.fault = (op, path) =>
      op === "remove" && path === INDEX ? new Error("EACCES") : undefined;
    await expect(store.remove()).rejects.toThrow(/EACCES/);
  });
});

/**
 * P28 in TODO-NEW.md. A ranged read that came back short was handed on as if
 * it were the range, sealed as a chunk it was not, and refused much later by
 * name.
 */
describe("a ranged read that comes back short (P28)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("is refused here, where the reason is knowable", async () => {
    const v = new ObsidianVault(asVault(new FakeVaultIndex(new FakeAdapter())), ".obsidian");
    globalThis.fetch = (async () => ({
      ok: true,
      status: 206,
      arrayBuffer: async () => new Uint8Array(100).buffer,
    })) as never;
    await expect(v.readRange("big.bin", 1000, 1200)).rejects.toThrow(
      /answered 100 bytes for a read of 200/,
    );
  });
});

/**
 * P29 in TODO-NEW.md. Above a few megabytes the read-back used to trust the
 * length alone, so a staged copy of the right size and the wrong bytes would
 * have become the note.
 */
describe("a large staged copy with the right length and the wrong bytes (P29)", () => {
  it("is caught by reading every byte back", async () => {
    const big = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      if (isStaging(path, "big.bin")) {
        const flipped = new Uint8Array(data.slice(0));
        flipped[3 * 1024 * 1024] = flipped[3 * 1024 * 1024]! ^ 0xff;
        return realWrite(path, flipped.buffer, options);
      }
      return realWrite(path, data, options);
    };
    await expect(vault.write("big.bin", big, { mtime: 1, ctime: 1 })).rejects.toThrow(
      /reads back differently/,
    );
    expect(await adapter.exists("big.bin")).toBe(false);
  });
});

/**
 * P30 in TODO-NEW.md. A staging copy under a fixed name was a name a person
 * could have given a real dotfile, which no listing shows and a sync of the
 * note beside it would have overwritten.
 */
describe("a dotfile of the user's where a staging copy would go (P30)", () => {
  it("is never written over", async () => {
    // Every name the staging could pick is taken by a file of the user's:
    // pin the random part so the collision is certain rather than lucky.
    const realRandom = crypto.getRandomValues.bind(crypto);
    let calls = 0;
    crypto.getRandomValues = ((arr: Uint8Array) => {
      arr.fill(calls++ < 1 ? 0xab : 0xcd);
      return arr;
    }) as typeof crypto.getRandomValues;
    try {
      adapter.seed(".basalt-tmp-abababab-note.md", "the user's own dotfile");
      await vault.write("note.md", enc.encode("a note"), { mtime: 1, ctime: 1 });
      expect(adapter.text("note.md")).toBe("a note");
      expect(adapter.text(".basalt-tmp-abababab-note.md")).toBe("the user's own dotfile");
      expect(stagingCopies(adapter)).toEqual([".basalt-tmp-abababab-note.md"]);
    } finally {
      crypto.getRandomValues = realRandom;
    }
  });
});

/**
 * review finding P25. The engine saves the index after `flush`, so the index is
 * never durable ahead of the notes it names, and the plugin's vault had no
 * `flush` at all: on desktop the adapter's writes reached the disk when the
 * operating system felt like it, and the index could be durable first. On
 * desktop the adapter is Electron's, the vault is a directory, and Node's fs
 * is reachable, so every written file and every changed directory is fsynced.
 * On a phone there is no fs to reach and the flush is a no-op, which
 * docs/plugin.md calls best effort.
 */
/** Electron's adapter, as far as the vault can tell: it knows the disk path. */
class DesktopAdapter extends FakeAdapter {
  getBasePath(): string {
    return "/home/me/vault";
  }
  getFullPath(normalizedPath: string): string {
    return normalizedPath === "" ? this.getBasePath() : `${this.getBasePath()}/${normalizedPath}`;
  }
}

/** The same, on a filesystem that folds case: macOS and Windows. */
function foldingDesktopAdapter(): DesktopAdapter {
  const adapter = new DesktopAdapter();
  adapter.insensitive = true;
  return adapter;
}

/** A Node fs that records what was opened and synced. */
function recordingFs(failDirs = false) {
  const synced: string[] = [];
  const open: string[] = [];
  const fs = {
    promises: {
      async open(path: string, flags: string) {
        if (flags !== "r") throw new Error(`opened ${path} with ${flags}, and a sync needs only r`);
        if (failDirs && !path.includes(".")) throw new Error("EISDIR");
        open.push(path);
        return {
          async sync() {
            synced.push(path);
          },
          async close() {
            open.splice(open.indexOf(path), 1);
          },
        };
      },
    },
  };
  return { fs, synced, open };
}

describe("making a pass durable on desktop (P25)", () => {
  it("fsyncs every file written this pass and the directories their entries changed in", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced, open } = recordingFs();
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    await v.write("daily/2026-09-02.md", enc.encode("one"), { mtime: 1, ctime: 1 });
    await v.write("top.md", enc.encode("two"), { mtime: 1, ctime: 1 });
    await v.mkdir("attachments");
    expect(synced, "nothing is synced until flush").toEqual([]);

    expect(v.flush).toBeDefined();
    await v.flush!();
    expect(synced).toContain("/home/me/vault/daily/2026-09-02.md");
    expect(synced).toContain("/home/me/vault/top.md");
    // The directories: the one the new note went in, and the root, whose
    // entries gained a note, a folder and another folder.
    expect(synced).toContain("/home/me/vault/daily");
    expect(synced).toContain("/home/me/vault");
    expect(open, "a handle was left open").toEqual([]);

    // Once. A second flush with nothing written syncs nothing.
    synced.length = 0;
    await v.flush!();
    expect(synced).toEqual([]);
  });

  it("syncs a file created beside an occupied name too", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced } = recordingFs();
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    expect(await v.create("note.md", enc.encode("x"), { mtime: 1, ctime: 1 })).toBe(true);
    await v.flush!();
    expect(synced).toContain("/home/me/vault/note.md");
  });

  it("does not fail the pass when a directory cannot be synced, and says so once", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced } = recordingFs(true);
    const said: string[] = [];
    const v = new ObsidianVault(
      asVault(new FakeVaultIndex(desktop)),
      ".obsidian",
      (m) => void said.push(m),
      { fs },
    );
    await v.write("a.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    await v.write("b.md", enc.encode("y"), { mtime: 1, ctime: 1 });
    await v.flush!();
    expect(synced).toEqual(["/home/me/vault/a.md", "/home/me/vault/b.md"]);
    expect(said.filter((m) => m.includes("will not sync a directory"))).toHaveLength(1);
  });

  it("fails the pass when a file cannot be synced, so the index is not saved ahead of it", async () => {
    const desktop = new DesktopAdapter();
    const fs = {
      promises: {
        async open(): Promise<never> {
          throw new Error("EIO");
        },
      },
    };
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    await v.write("a.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    await expect(v.flush!()).rejects.toThrow(/EIO/);
  });

  it("does nothing on an adapter that is not the desktop one, whatever fs is given", async () => {
    // Capacitor's adapter has no getFullPath: there is no path to sync and
    // no fs to sync it with. Best effort, and documented as such.
    const { fs, synced } = recordingFs();
    const v = new ObsidianVault(
      asVault(new FakeVaultIndex(new FakeAdapter())),
      ".obsidian",
      () => {},
      { fs },
    );
    await v.write("a.md", enc.encode("x"), { mtime: 1, ctime: 1 });
    await expect(v.flush!()).resolves.toBeUndefined();
    expect(synced).toEqual([]);
  });

  it("does nothing on desktop when no fs can be reached, rather than failing every pass", async () => {
    // A renderer whose `require` refuses, or has no fs: the flush has
    // nothing to sync with and says nothing, rather than failing every pass.
    const g = globalThis as { require?: unknown };
    const had = g.require;
    g.require = () => {
      throw new Error("no such module");
    };
    try {
      const desktop = new DesktopAdapter();
      const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian");
      await v.write("a.md", enc.encode("x"), { mtime: 1, ctime: 1 });
      await expect(v.flush!()).resolves.toBeUndefined();
    } finally {
      if (had === undefined) delete g.require;
      else g.require = had;
    }
  });
});

/**
 * P-D4 and P-D5 in the 0.3.0 review, both of them rule 3 in the form the header
 * of core/vault.ts gives it: the index must never be durable ahead of the notes
 * it names. `flush` is the whole of how that holds in the plugin, so anything it
 * forgets is a note the index can be saved over.
 */
describe("what flush must not forget (P-D4, P-D5)", () => {
  const times = { mtime: 1, ctime: 1 };

  it("syncs the rest of the pass, and keeps what it could not sync (P-D4)", async () => {
    const desktop = new DesktopAdapter();
    const synced: string[] = [];
    let failing: string | undefined = "/home/me/vault/a.md";
    const fs = {
      promises: {
        async open(path: string) {
          if (path === failing) throw new Error("EMFILE");
          return {
            async sync() {
              synced.push(path);
            },
            async close() {},
          };
        },
      },
    };
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    await v.write("a.md", enc.encode("one"), times);
    await v.write("b.md", enc.encode("two"), times);

    // The pass still fails, which is the point: the index is not saved over
    // a note that is not durable.
    await expect(v.flush!()).rejects.toThrow(/EMFILE/);
    // But one file that would not open is not a reason to leave every later
    // file in the pass unsynced.
    expect(synced, "the files after the failure were skipped").toContain("/home/me/vault/b.md");

    // And the one that failed is still owed. Forgetting it let the next pass
    // flush nothing and save the index over a note never made durable.
    failing = undefined;
    synced.length = 0;
    await expect(v.flush!()).resolves.toBeUndefined();
    expect(synced, "the file that failed was forgotten").toContain("/home/me/vault/a.md");
  });

  it("syncs the directory a deletion changed (P-D5)", async () => {
    for (const systemTrash of [true, false]) {
      const desktop = new DesktopAdapter();
      desktop.systemTrashWorks = systemTrash;
      const { fs, synced } = recordingFs();
      const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
        fs,
      });
      desktop.seed("daily/note.md", "text");

      await v.remove("daily/note.md");
      await v.flush!();
      // A pass that only deleted used to flush nothing at all and then save
      // the index, so the name could come back after a crash while the index
      // said it was gone.
      expect(synced, `system trash ${systemTrash}`).toContain("/home/me/vault/daily");
    }
  });

  it("syncs the directory a case-fixing rename changed even when the write fails (P-D5)", async () => {
    const desktop = foldingDesktopAdapter();
    const { fs, synced } = recordingFs();
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    // Through the vault, because the fake only folds the spellings it has
    // been given: this is the file already on disk, already flushed.
    await v.write("daily/Note.md", enc.encode("old"), times);
    await v.flush!();
    synced.length = 0;

    // The other device renamed it to NOTE.md. The rename lands, the bytes
    // after it do not, and the directory entry that moved is the one thing
    // that changed on disk.
    desktop.fault = (op, path) =>
      op === "writeBinary" && path.includes("basalt-tmp") ? new Error("ENOSPC") : undefined;
    await expect(v.write("daily/NOTE.md", enc.encode("new"), times)).rejects.toThrow(/ENOSPC/);
    desktop.fault = undefined;

    await v.flush!();
    expect(synced).toContain("/home/me/vault/daily");
  });

  /**
   * A Node fs that answers for what the adapter actually holds, which is what
   * a real one does and what `recordingFs` above does not: it opens anything.
   * A path that is not there fails the way the platform fails it.
   */
  function fsOver(adapter: DesktopAdapter) {
    const synced: string[] = [];
    const tried: string[] = [];
    const fs = {
      promises: {
        async open(path: string) {
          tried.push(path);
          const rel = path.slice("/home/me/vault".length).replace(/^\//, "");
          if (rel !== "" && !(await adapter.exists(rel))) {
            const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
            (err as NodeJS.ErrnoException).code = "ENOENT";
            throw err;
          }
          return {
            async sync() {
              synced.push(path);
            },
            async close() {},
          };
        },
      },
    };
    return { fs, synced, tried };
  }

  it("stops owing a file the same pass deleted (R6)", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced, tried } = fsOver(desktop);
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });

    // Arriving and then withdrawn: a note downloaded in a pass that also
    // applies the deletion another device sent for it.
    await v.write("daily/note.md", enc.encode("one"), times);
    await v.remove("daily/note.md");

    await expect(v.flush!()).resolves.toBeUndefined();
    expect(tried, "a name with nothing at it was opened to be synced").not.toContain(
      "/home/me/vault/daily/note.md",
    );
    expect(synced, "the directory the deletion changed").toContain("/home/me/vault/daily");
  });

  it("stops owing a file that had already gone when the deletion arrived (N7)", async () => {
    const desktop = new DesktopAdapter();
    const { fs, synced, tried } = fsOver(desktop);
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });

    // The note arrives, and something outside the app removes it before the
    // deletion another device sent for it is applied. `remove` returns early
    // on a path that is already gone, and used to leave the name on the
    // flush list for the next flush to work out for itself.
    await v.write("daily/note.md", enc.encode("one"), times);
    await desktop.remove("daily/note.md");
    await v.remove("daily/note.md");

    await expect(v.flush!()).resolves.toBeUndefined();
    expect(tried, "a name already known to be gone was opened to be synced").not.toContain(
      "/home/me/vault/daily/note.md",
    );
    expect(synced, "the directory the deletion changed").toContain("/home/me/vault/daily");
  });

  /**
   * N5. The other trigger the flush fix was written for: a write under a
   * spelling that differs only by case renames what is on disk, so a name the
   * flush is still holding from earlier in the same pass no longer names what
   * it named. The pass has to finish, under the surviving spelling.
   */
  it("keeps flushing after a case-only rename moves a file mid-pass (N5)", async () => {
    const folding = foldingDesktopAdapter();
    const { fs, synced } = fsOver(folding);
    const v = new ObsidianVault(asVault(new FakeVaultIndex(folding)), ".obsidian", () => {}, {
      fs,
    });

    await v.write("daily/Note.md", enc.encode("old"), times);
    await v.write("daily/NOTE.md", enc.encode("new"), times);

    await expect(v.flush!()).resolves.toBeUndefined();
    // One file, spelled the way the last writer spelled it, and durable.
    expect((await folding.list("daily")).files).toEqual(["daily/NOTE.md"]);
    expect(synced, "the surviving spelling").toContain("/home/me/vault/daily/NOTE.md");
    expect(synced, "the directory the rename changed").toContain("/home/me/vault/daily");
  });

  it("treats a file that has gone as flushed rather than as a failure, for ever (R6)", async () => {
    const INDEX = ".obsidian/plugins/basalt/index.json";
    const state = { cursor: 1, entries: {}, remote: {}, pending: [] };
    const desktop = new DesktopAdapter();
    const { fs, synced } = fsOver(desktop);
    const v = new ObsidianVault(asVault(new FakeVaultIndex(desktop)), ".obsidian", () => {}, {
      fs,
    });
    const store = new ObsidianIndexStore(desktop, INDEX);

    // Removed from under the vault: another program, or Obsidian's own
    // trash on a device where the person emptied it.
    await v.write("note.md", enc.encode("one"), times);
    await desktop.remove("note.md");

    // The engine's order, twice. A flush that keeps failing over a name
    // nothing can open never lets the save after it run again.
    await expect(v.flush!()).resolves.toBeUndefined();
    await store.save(state);
    await v.write("other.md", enc.encode("two"), times);
    await expect(
      v.flush!(),
      "the second flush still owed the missing file",
    ).resolves.toBeUndefined();
    await store.save({ ...state, cursor: 2 });

    expect(synced).toContain("/home/me/vault/other.md");
    expect(await new ObsidianIndexStore(desktop, INDEX).load()).toEqual({ ...state, cursor: 2 });
  });
});

/**
 * P-D6 in the 0.3.0 review, and the seeding beside it. The skip is what keeps a
 * settled vault from rewriting nine megabytes every thirty seconds, and it is
 * safe only while what it remembers is what is on disk.
 */
describe("the index write that is skipped because nothing changed (P-D6)", () => {
  const INDEX = ".obsidian/plugins/basalt/index.json";
  const state = (cursor: number) => ({
    cursor,
    entries: { "note.md": { path: "note.md", hash: `h${cursor}` } },
    remote: {},
    pending: [],
  });

  it("writes again when the index has gone from under it", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX);
    await store.save(state(1));

    // Removed from outside the session: a tidy-up script, a sync tool, a
    // person in a file manager.
    await adapter.remove(INDEX);
    await store.save(state(1));

    expect(await adapter.exists(INDEX), "the index stayed gone for the session").toBe(true);
    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(1));
  });

  it("does not rewrite an index it has just read", async () => {
    await new ObsidianIndexStore(adapter, INDEX).save(state(1));

    // A restart. The first pass of a settled vault produces the state that
    // is already on disk, and writing it back is two fsyncs to record that
    // nothing happened.
    const store = new ObsidianIndexStore(adapter, INDEX);
    expect(await store.load()).toEqual(state(1));
    let writes = 0;
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      writes++;
      return realWrite(path, data, options);
    };
    await store.save(state(1));
    expect(writes, "an identical index was written again on the first pass").toBe(0);
  });

  it("writes again when the index has been overwritten in place (R3)", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX);
    await store.save(state(1));

    // Still there, and no longer what was written: half an index, a
    // conflicted copy of one, a tidy-up script's idea of tidy. The file
    // exists, so existence alone said nothing was wrong and every later
    // unchanged pass kept it for the rest of the session.
    adapter.now += 1000;
    await adapter.write(INDEX, "{}");
    await store.save(state(1));

    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(1));
  });

  it("writes again when a shorter overwrite lands at the same instant (R3)", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX);
    await store.save(state(1));

    // The clock does not move, so size is the half of the stamp that has to
    // notice this one.
    await adapter.write(INDEX, "!".repeat(JSON.stringify(state(1)).length - 1));
    await store.save(state(1));

    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(1));
  });

  it("writes again when a same-size overwrite lands a tick later (R3)", async () => {
    const store = new ObsidianIndexStore(adapter, INDEX);
    await store.save(state(1));

    // Exactly as long as what was written, so size says nothing and the
    // modification time is the half that has to notice. The named test above
    // only ever moved the size, so this half of the stamp was never exercised.
    //
    // The residual, which is not a bug this can catch: a same-size overwrite
    // inside one modification-time tick still skips. Narrow where the clock
    // is fine grained (APFS, ext4), real where it is not (HFS+ ticks once a
    // second, FAT once every two). Reading the index back on every settled
    // pass is the cost the skip exists to avoid, so the window stays.
    adapter.now += 1000;
    await adapter.write(INDEX, "!".repeat(JSON.stringify(state(1)).length));
    await store.save(state(1));

    expect(await new ObsidianIndexStore(adapter, INDEX).load()).toEqual(state(1));
  });
});
