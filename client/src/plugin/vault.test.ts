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
    const odd = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".my-config");
    adapter.seed(".my-config/plugins/basalt/data.json", "the root secret lives here");
    adapter.seed("real.md", "x");
    expect((await odd.list()).map((f) => f.path)).toEqual(["real.md"]);

    // And the usual name is not special once the vault says otherwise: a
    // stray `.obsidian` in a vault configured elsewhere is just a folder.
    adapter.seed(".obsidian/leftover.json", "{}");
    expect((await odd.list()).map((f) => f.path)).toContain(".obsidian");
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

    expect(
      { stat: counting.stats, list: counting.lists },
      `a 200 file vault cost ${counting.stats} stat and ${counting.lists} list calls`,
    ).toEqual({ stat: 0, list: 0 });
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
  const body = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (i * 37 + (i >> 7)) & 0xff;
    return out;
  };

  /** A vault whose resource URLs are served by a fetch this test controls. */
  function streaming(bytes: Uint8Array, opts: { honourRange?: boolean; fail?: boolean } = {}) {
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
            let sent = false;
            return {
              async read() {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: slice.slice() };
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
