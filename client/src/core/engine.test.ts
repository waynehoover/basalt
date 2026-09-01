/**
 * Two engines, two vaults, one real server.
 *
 * This is the test the whole client exists to pass, and the one the predecessor's
 * notes warn about: rule 10 of docs/philosophy.md records a conflict test that
 * asserted the two devices *agreed*, and passed while one side's edit had
 * silently vanished. Agreement is not the property. Not losing an edit is.
 *
 * So the assertions here are about edits, by name, and where they ended up. The
 * vaults are in memory and everything else is real: real sealing, real chunking,
 * a real WebSocket, a real Go server writing real SQLite.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  Engine,
  OWN_LIMITS,
  SEAL_WINDOW,
  boundedBy,
  contentId,
  refuseIfBehind,
  firstFreeName,
  sealedNames,
  type SyncReport,
} from "./engine.ts";
import { chunkBytes, sizesFor } from "./chunk.ts";
import { macEntry, sealChunks, sealPath } from "./crypto.ts";
import { authToken, deriveKeys, type VaultKeys } from "./crypto.ts";
import { Transport, type WireEntry } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import type { IndexEntry } from "./index-state.ts";
import { TestServer, cleanupBinary, serverBinary, until } from "./test-server.ts";

const SECRET = new Uint8Array(20).fill(33);
let keys: VaultKeys;

beforeAll(async () => {
  await serverBinary();
  keys = await deriveKeys(SECRET);
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

/** One device: an in-memory vault, an index, a transport and an engine. */
class Device {
  readonly vault = new MemoryVault();
  readonly store = new MemoryIndexStore();
  transport!: Transport;
  engine!: Engine;
  /** Every batch this device has been handed, for asserting on the wire. */
  readonly batches: { from: number; to: number; entries: unknown[] }[] = [];
  caughtUp = false;
  clock = 1_000_000;

  constructor(readonly name: string) {}

  async connect(server: TestServer, log?: (message: string) => void): Promise<void> {
    this.caughtUp = false;
    this.transport = new Transport(server.wsUrl, {
      onBatch: async (b) => {
        this.batches.push(b);
        await this.engine.acceptBatch(b);
      },
      onCaughtUp: () => {
        this.caughtUp = true;
      },
      timeoutMs: 20_000,
    });
    this.engine = new Engine({
      vault: this.vault,
      store: this.store,
      keys,
      transport: this.transport,
      device: this.name,
      vaultId: "default",
      ...server.credentials(authToken(keys)),
      // A clock the test advances, so the size-scaled write debounce does
      // not decide when a sync may happen.
      now: () => (this.clock += 60_000),
      ...(log ? { log } : {}),
    });
    await this.transport.connect();
    await this.engine.start();
    await until(`${this.name} to drain the backlog`, () => this.caughtUp);
  }

  /** Syncs until nothing more changes, which is what a settled device looks like. */
  async settle(rounds = 4): Promise<SyncReport> {
    let last = await this.engine.sync();
    for (let i = 1; i < rounds; i++) {
      // Let anything the server relayed arrive before deciding again.
      await new Promise((r) => setTimeout(r, 60));
      last = await this.engine.sync();
    }
    return last;
  }

  close(): void {
    this.transport?.close();
  }
}

let server: TestServer;
const devices: Device[] = [];

async function fresh(): Promise<TestServer> {
  server = new TestServer();
  await server.start();
  return server;
}

async function device(name: string, log?: (message: string) => void): Promise<Device> {
  const d = new Device(name);
  devices.push(d);
  await d.connect(server, log);
  return d;
}

afterEach(async () => {
  while (devices.length) devices.pop()!.close();
  if (server) await server.cleanup();
});

/** Syncs both devices repeatedly until each has seen the other's work. */
async function convergeBoth(a: Device, b: Device, rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await a.engine.sync();
    await new Promise((r) => setTimeout(r, 60));
    await b.engine.sync();
    await new Promise((r) => setTimeout(r, 60));
  }
  await a.engine.sync();
  await new Promise((r) => setTimeout(r, 60));
  await b.engine.sync();
}

describe("one device", () => {
  it("uploads what is in the vault and says what it sent", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("notes/one.md", "# One\n\nSome content.\n");
    await a.vault.edit("notes/two.md", "# Two\n\nOther content.\n");

    const report = await a.engine.sync();
    // Three, not two: the folder the notes live in is an entry of its own,
    // which is how a device that has never seen the vault learns the
    // structure rather than inferring it from paths.
    expect(report.uploaded).toBe(3);
    expect(report.foldersCreated).toBe(0);
    expect(report.chunksSent).toBeGreaterThan(0);
    expect(report.bytesSent).toBeGreaterThan(0);

    // The server agrees that what it stored can be served.
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 120_000);

  it("uploads nothing on a second pass", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("note.md", "content");
    await a.engine.sync();

    const second = await a.engine.sync();
    expect(second.uploaded).toBe(0);
    expect(second.chunksSent).toBe(0);
    expect(second.bytesSent).toBe(0);
  }, 120_000);

  it("sends only the chunks an edit changed", async () => {
    await fresh();
    const a = await device("a");
    let text = "";
    for (let i = 0; i < 2000; i++) text += `Line ${i} of a long note with several words.\n`;
    await a.vault.edit("long.md", text);
    const first = await a.engine.sync();

    const at = text.indexOf("\n", Math.floor(text.length / 3)) + 1;
    await a.vault.edit("long.md", text.slice(0, at) + "An inserted line.\n" + text.slice(at));
    const second = await a.engine.sync();

    expect(second.uploaded).toBe(1);
    expect(second.chunksSent).toBeLessThanOrEqual(3);
    // The ratio rather than two absolute figures. What the design claims is
    // that an edit costs a fraction of the file, and that claim should not
    // have to be restated every time a chunk size changes.
    expect(
      second.bytesSent * 8,
      `the first sync sent ${first.bytesSent} bytes and one edit cost ${second.bytesSent}`,
    ).toBeLessThan(first.bytesSent);
  }, 120_000);

  it("sends nothing for a second file with the same content", async () => {
    await fresh();
    const a = await device("a");
    const content = "# Shared\n\nThe very same words.\n";
    await a.vault.edit("a.md", content);
    await a.engine.sync();

    await a.vault.edit("b.md", content);
    const second = await a.engine.sync();
    expect(second.uploaded).toBe(1);
    expect(second.chunksSent).toBe(0);
  }, 120_000);

  it("keeps its index across a restart and re-uploads nothing", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("note.md", "content");
    await a.engine.sync();
    const cursorBefore = a.engine.status().cursor;
    a.close();

    // Same vault, same index store, new engine and connection.
    const again = new Device("a");
    devices.push(again);
    Object.assign(again, { vault: a.vault, store: a.store });
    await again.connect(server);
    const report = await again.engine.sync();

    expect(report.uploaded).toBe(0);
    expect(report.chunksSent).toBe(0);
    expect(again.engine.status().cursor).toBe(cursorBefore);
  }, 120_000);
});

describe("two devices", () => {
  it("carries a file from one to the other", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("notes/hello.md", "# Hello\n\nFrom device a.\n");
    await convergeBoth(a, b);

    expect(b.vault.text("notes/hello.md")).toBe("# Hello\n\nFrom device a.\n");
    expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
  }, 180_000);

  it("carries a vault of several files both ways", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    for (let i = 0; i < 5; i++) await a.vault.edit(`from-a/${i}.md`, `written on a, number ${i}\n`);
    for (let i = 0; i < 5; i++) await b.vault.edit(`from-b/${i}.md`, `written on b, number ${i}\n`);

    await convergeBoth(a, b, 6);

    // Every edit, by name, on both sides. Not "the two agree".
    for (let i = 0; i < 5; i++) {
      expect(a.vault.text(`from-b/${i}.md`), `a is missing b's file ${i}`).toBe(
        `written on b, number ${i}\n`,
      );
      expect(b.vault.text(`from-a/${i}.md`), `b is missing a's file ${i}`).toBe(
        `written on a, number ${i}\n`,
      );
    }
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
  }, 240_000);

  it("carries an edit to a file both devices already have", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("note.md", "first version\n");
    await convergeBoth(a, b);
    expect(b.vault.text("note.md")).toBe("first version\n");

    await a.vault.edit("note.md", "second version\n");
    await convergeBoth(a, b);
    expect(b.vault.text("note.md")).toBe("second version\n");
  }, 240_000);
});

describe("concurrent edits, which is where notes get lost", () => {
  it("merges edits to different parts of one note, keeping both", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    await a.vault.edit("note.md", base);
    await convergeBoth(a, b);
    expect(b.vault.text("note.md")).toBe(base);

    // Both edit, neither having seen the other.
    await a.vault.edit(
      "note.md",
      base.replace("First paragraph.", "First paragraph, edited on A."),
    );
    await b.vault.edit(
      "note.md",
      base.replace("Third paragraph.", "Third paragraph, edited on B."),
    );

    await convergeBoth(a, b, 6);

    // The property that matters: both edits exist, on both devices.
    for (const d of [a, b]) {
      const text = d.vault.text("note.md") ?? "";
      expect(text, `${d.name} lost A's edit`).toContain("edited on A");
      expect(text, `${d.name} lost B's edit`).toContain("edited on B");
    }
    expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
  }, 240_000);

  it("keeps both versions when the same line was rewritten twice", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("note.md", "# Note\n\nThe original sentence.\n");
    await convergeBoth(a, b);

    await a.vault.edit("note.md", "# Note\n\nA's completely different sentence.\n");
    await b.vault.edit("note.md", "# Note\n\nB's entirely other sentence.\n");

    await convergeBoth(a, b, 6);

    // Neither version is anywhere lost. One of them is under a conflict
    // copy's name, and which does not matter; that both survive does.
    for (const d of [a, b]) {
      const all = Object.values(d.vault.snapshot()).join("\n---\n");
      expect(all, `${d.name} lost A's version`).toContain("A's completely different sentence");
      expect(all, `${d.name} lost B's version`).toContain("B's entirely other sentence");
    }

    // And a conflict copy exists, so somebody can see there was a conflict.
    const copies = a.vault.paths().filter((p) => p.includes("Conflicted copy"));
    expect(copies.length).toBeGreaterThan(0);
  }, 240_000);

  it("keeps both when an attachment changed on both sides", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const bytes = (seed: number) => {
      const out = new Uint8Array(4096);
      for (let i = 0; i < out.length; i++) out[i] = (Math.imul(i + seed, 2654435761) >>> 24) & 0xff;
      return out;
    };
    await a.vault.write("file.bin", bytes(1), { mtime: 1000, ctime: 1000 });
    await convergeBoth(a, b);

    await a.vault.write("file.bin", bytes(2), { mtime: 2000, ctime: 1000 });
    await b.vault.write("file.bin", bytes(3), { mtime: 2001, ctime: 1000 });
    await convergeBoth(a, b, 6);

    // Binary cannot be merged, so both must exist rather than one winning.
    for (const d of [a, b]) {
      const copies = d.vault.paths().filter((p) => p.includes("Conflicted copy"));
      expect(copies.length, `${d.name} has no conflict copy`).toBeGreaterThan(0);
    }
  }, 240_000);
});

/**
 * A conflict copy is the only surviving record of one side of a divergence, so
 * overwriting one is the same failure the copy exists to prevent, one level up.
 *
 * The name carries the time only to the minute, so two conflicts on one path
 * from one device inside the same minute produced the same name and the second
 * write replaced the first. Two passes inside a minute is ordinary: the write
 * debounce is measured in tens of seconds.
 */
describe("naming a copy beside a note", () => {
  const none = async () => false;
  const only =
    (...taken: string[]) =>
    async (p: string) =>
      taken.includes(p);

  it("uses the name it was given when nothing is there", async () => {
    expect(await firstFreeName("note (Conflicted copy a 202608281705).md", none)).toBe(
      "note (Conflicted copy a 202608281705).md",
    );
  });

  it("numbers past a name already in use rather than writing over it", async () => {
    const base = "note (Conflicted copy a 202608281705).md";
    expect(await firstFreeName(base, only(base))).toBe(
      "note (Conflicted copy a 202608281705) 2.md",
    );
  });

  it("keeps numbering while the numbered ones are taken too", async () => {
    const base = "note (Conflicted copy a 202608281705).md";
    const taken = only(
      base,
      "note (Conflicted copy a 202608281705) 2.md",
      "note (Conflicted copy a 202608281705) 3.md",
    );
    expect(await firstFreeName(base, taken)).toBe("note (Conflicted copy a 202608281705) 4.md");
  });

  it("keeps the extension where the name has one, and adds none where it does not", async () => {
    expect(await firstFreeName("a/b/note.md", only("a/b/note.md"))).toBe("a/b/note 2.md");
    // A dot in a folder name is not an extension on the file.
    expect(await firstFreeName("a.b/note", only("a.b/note"))).toBe("a.b/note 2");
  });

  it("refuses rather than inventing a name when a thousand are taken", async () => {
    await expect(firstFreeName("note.md", async () => true)).rejects.toThrow(/unused name/);
  });
});

/**
 * An extension is a claim, not a fact. A `.md` holding bytes that are not UTF-8
 * used to decode with replacement characters, merge cleanly, and get written
 * back with those replacements standing in for bytes neither side had touched:
 * a file altered by a sync that reported success.
 *
 * The edits below are at opposite ends and do not collide, so the merge
 * succeeds. That is the case that mattered: a merge that refuses never writes
 * anything, and it is the clean merge that quietly rewrote the middle.
 */
describe("a text file that is not text", () => {
  it("does not rewrite bytes neither side edited", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    // 0xFF and 0xFE are valid nowhere in UTF-8, and are what a Latin-1 note
    // or a mis-labelled attachment looks like.
    const note = (head: string, tail: string) =>
      new Uint8Array([
        ...new TextEncoder().encode(`${head}\n`),
        0xff,
        0xfe,
        ...new TextEncoder().encode(`\n${tail}\n`),
      ]);

    await a.vault.write("note.md", note("start", "end"), { mtime: 1000, ctime: 1000 });
    await convergeBoth(a, b);

    // Opposite ends, so there is nothing to collide and the merge is clean.
    await a.vault.write("note.md", note("START HERE", "end"), { mtime: 2000, ctime: 1000 });
    await b.vault.write("note.md", note("start", "END HERE"), { mtime: 2000, ctime: 1000 });
    await convergeBoth(a, b);

    for (const d of [a, b]) {
      for (const path of d.vault.paths()) {
        const bytes = await d.vault.read(path);
        // EF BF BD is U+FFFD, the replacement character. Its presence
        // means bytes that were on disk were decoded away and written
        // back as something else.
        const rewritten = [...bytes].some(
          (byte, i) => byte === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd,
        );
        expect(rewritten, `${d.name}:${path} came back with replacement characters`).toBe(false);
      }
    }
  });
});

describe("deletions", () => {
  it("carries a delete from one device to the other", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("doomed.md", "not for long\n");
    await convergeBoth(a, b);
    expect(b.vault.text("doomed.md")).toBe("not for long\n");

    await a.vault.remove("doomed.md");
    await convergeBoth(a, b, 6);

    expect(a.vault.text("doomed.md")).toBeUndefined();
    expect(b.vault.text("doomed.md")).toBeUndefined();
  }, 240_000);

  /**
   * A deletion can be repeated. An edit that is gone from the device that made
   * it and from the server cannot be recovered. So the edit wins.
   */
  it("keeps a file deleted on one device but edited on the other", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("contested.md", "original\n");
    await convergeBoth(a, b);

    await a.vault.remove("contested.md");
    await b.vault.edit("contested.md", "edited, and worth keeping\n");
    await convergeBoth(a, b, 6);

    expect(b.vault.text("contested.md"), "the edit was deleted").toBe(
      "edited, and worth keeping\n",
    );
    expect(a.vault.text("contested.md"), "the edit did not come back").toBe(
      "edited, and worth keeping\n",
    );
  }, 240_000);
});

describe("folders and renames", () => {
  it("creates a folder the other device made", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.mkdir("some/deep/folder");
    await a.vault.edit("some/deep/folder/note.md", "inside\n");
    await convergeBoth(a, b);

    expect(b.vault.text("some/deep/folder/note.md")).toBe("inside\n");
  }, 240_000);

  it("carries a rename as a rename, not a delete and an add", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("before.md", "the same content throughout\n");
    await convergeBoth(a, b);

    // As the vault would report it: the file moved, and the engine is told.
    const bytes = await a.vault.read("before.md");
    await a.vault.remove("before.md");
    await a.vault.write("after.md", bytes, { mtime: 2000, ctime: 1000 });
    a.engine.noteRename("before.md", "after.md");

    const report = await a.engine.sync();
    // Nothing new to send: the content is already there, so the rename costs
    // metadata and no chunks at all.
    expect(report.chunksSent).toBe(0);

    await convergeBoth(a, b, 6);
    expect(b.vault.text("after.md")).toBe("the same content throughout\n");
    expect(b.vault.text("before.md")).toBeUndefined();

    // And the device that did the renaming does not get the old name back.
    //
    // This assertion was the missing half. Telling the engine about a rename
    // removed the old path from the index, and an index with no entry for a
    // path the server still has content at reads as "new on the server", so
    // the very next pass downloaded the file the person had just moved. Every
    // move in Obsidian left a copy behind, and checking only the receiving
    // device could never see it.
    expect(a.vault.text("before.md"), "the moved file came back").toBeUndefined();
    expect(a.vault.text("after.md")).toBe("the same content throughout\n");
  }, 240_000);
});

describe("the content identity", () => {
  it("distinguishes an empty file from one that never synced", () => {
    // The index reads `synchash === ""` as "never synced". Without a marker
    // for it, an empty note that had synced perfectly well would read as one
    // that never had, and every pass would treat it as new.
    expect(contentId([])).not.toBe("");
    expect(contentId([])).toBe("-empty-");
    expect(contentId(["a", "b"])).toBe("a,b");
  });

  it("round trips an empty note between two devices", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("empty.md", "");
    await convergeBoth(a, b);
    expect(b.vault.text("empty.md")).toBe("");

    // And settles: a second pass must not decide it is new again.
    const report = await b.engine.sync();
    expect(report.uploaded).toBe(0);
    expect(report.downloaded).toBe(0);
  }, 240_000);
});

describe("a file that can never sync", () => {
  it("is skipped rather than retried forever", async () => {
    await fresh();
    const a = await device("a");

    // A path the server refuses: over its length bound. Retrying it would
    // fail identically forever and hide everything else in the log.
    const tooLong = "x".repeat(5000) + ".md";
    await a.vault.edit(tooLong, "content");
    await a.vault.edit("fine.md", "content");

    const first = await a.engine.sync();
    expect(first.uploaded).toBeGreaterThanOrEqual(1);
    expect(first.skipped + first.retrying).toBeGreaterThanOrEqual(1);

    // The good file synced regardless: one bad path must not stall the rest.
    expect(a.engine.status().files).toBeGreaterThanOrEqual(1);
    const second = await a.engine.sync();
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe("the guards the happy path hides", () => {
  it("reads no files at all on a pass where nothing changed", async () => {
    // The index's content cache is what keeps a routine scan to one stat per
    // file. Correctness does not depend on it, which is why nothing else
    // here notices when it stops working, and a vault of four thousand notes
    // very much does.
    await fresh();
    const a = await device("a");
    for (let i = 0; i < 5; i++) await a.vault.edit(`note${i}.md`, `content ${i}`);
    await a.engine.sync();

    const before = a.vault.reads;
    await a.engine.sync();
    expect(a.vault.reads - before, "an unchanged pass re-read the vault").toBe(0);
  }, 120_000);

  it("writes its index, so a restart is not a rebuild", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("note.md", "content");
    await a.engine.sync();
    expect(a.store.saves).toBeGreaterThan(0);
  }, 120_000);

  /**
   * A device whose index is gone but whose vault matches the server.
   *
   * Every file decides "nothing", and the ancestor has to move anyway, or the
   * device has no common ancestor for anything and the next concurrent edit
   * conflicts where it should have merged. A lost afternoon rather than a lost
   * note, and still wrong.
   *
   * What this verifies is that the rebuilt device does not re-upload the vault
   * and that the edits both survive. It does *not* isolate the ancestor
   * recovery: with that removed the assertions still hold, because the other
   * device merges and the result comes back. A case that pins the recovery
   * itself would have to make the rebuilt device the one that merges, and
   * ordering two devices that precisely is not something these tests can do
   * yet.
   */
  it("recovers the ancestor for files that already agree", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    await a.vault.edit("note.md", base);
    await convergeBoth(a, b);

    // A restarts having lost its index entirely. The vault is untouched.
    a.close();
    const rebuilt = new Device("a");
    devices.push(rebuilt);
    Object.assign(rebuilt, { vault: a.vault, store: new MemoryIndexStore() });
    await rebuilt.connect(server);
    const recovery = await rebuilt.engine.sync();
    expect(recovery.uploaded, "a rebuilt index re-uploaded the vault").toBe(0);

    // Now both edit different parts. This can only merge if the rebuilt
    // device worked out its ancestor from the agreement.
    await rebuilt.vault.edit(
      "note.md",
      base.replace("First paragraph.", "First paragraph, edited on A."),
    );
    await b.vault.edit(
      "note.md",
      base.replace("Third paragraph.", "Third paragraph, edited on B."),
    );
    await convergeBoth(rebuilt, b, 6);

    for (const d of [rebuilt, b]) {
      const text = d.vault.text("note.md") ?? "";
      expect(text, `${d.name} lost A's edit`).toContain("edited on A");
      expect(text, `${d.name} lost B's edit`).toContain("edited on B");
    }
  }, 240_000);

  /**
   * A device that was not part of the conflict still ends up with both
   * versions.
   *
   * This one passes with the conflict copy's upload removed, and the reason is
   * worth writing down rather than leaving as a puzzle: the copy is a new file
   * in the vault, so the very next scan finds it and uploads it like any other
   * new file. The scan is the backstop. The explicit upload only makes it
   * happen a round earlier, and the test below is the one that shows why a
   * round earlier matters.
   */
  it("carries both versions to a device that was not part of the conflict", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("note.md", "# Note\n\nThe original sentence.\n");
    await convergeBoth(a, b);

    await a.vault.edit("note.md", "# Note\n\nA's completely different sentence.\n");
    await b.vault.edit("note.md", "# Note\n\nB's entirely other sentence.\n");
    await convergeBoth(a, b, 6);

    // C arrives afterwards, having seen none of it.
    const c = await device("c");
    await c.settle(6);

    const all = Object.values(c.vault.snapshot()).join("\n---\n");
    expect(all, "c never received A's version").toContain("A's completely different sentence");
    expect(all, "c never received B's version").toContain("B's entirely other sentence");
  }, 300_000);

  /**
   * The device that detected the conflict sends both versions before it can
   * stop.
   *
   * The scan is the backstop for the conflict copy, and a backstop that needs
   * another pass is not one for the case that matters: B notices the conflict,
   * writes the copy, and then the laptop lid closes. If the copy has not
   * already left, the only place A's own text still exists is A, and A is about
   * to download B's version over it.
   *
   * So B syncs exactly once here and then goes away for good. Everything A
   * recovers, it recovers from what that single pass uploaded.
   */
  it("gets both versions off the device before it stops syncing", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("note.md", "# Note\n\nThe original sentence.\n");
    await convergeBoth(a, b);

    await a.vault.edit("note.md", "# Note\n\nA's completely different sentence.\n");
    await b.vault.edit("note.md", "# Note\n\nB's entirely other sentence.\n");

    // A publishes first, so it is B that finds the conflict.
    await a.engine.sync();
    await new Promise((r) => setTimeout(r, 120));
    const report = await b.engine.sync();
    expect(report.conflicted, "B was meant to be the one that conflicted").toBe(1);

    // And B is gone. One pass, no second chance.
    b.close();
    await new Promise((r) => setTimeout(r, 120));

    await a.settle(6);

    const all = Object.values(a.vault.snapshot()).join("\n---\n");
    expect(all, "A lost its own version").toContain("A's completely different sentence");
    expect(all, "A never received B's version").toContain("B's entirely other sentence");
  }, 300_000);

  /**
   * Two devices that independently arrive at the same content have synced,
   * and the index has to say so.
   *
   * The same note typed twice, or restored from the same backup twice. Nothing
   * is transferred, so it is tempting to call it a no-op. It is not: if the
   * ancestor does not move to the content both sides hold, the next pair of
   * edits merges against a version neither device has ever had, which is a
   * conflict reported for two edits that never overlapped.
   *
   * Nothing else in this file pins that down, because everywhere else the
   * ancestor was already recorded by whichever transfer put the content there.
   * Here there was no transfer.
   */
  it("records the ancestor when both devices already agree", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    // Typed on both, neither having seen the other. Byte for byte the same.
    await a.vault.edit("note.md", base);
    await b.vault.edit("note.md", base);
    await convergeBoth(a, b, 6);

    // Now the edits that must merge rather than collide.
    await a.vault.edit(
      "note.md",
      base.replace("First paragraph.", "First paragraph, edited on A."),
    );
    await b.vault.edit(
      "note.md",
      base.replace("Third paragraph.", "Third paragraph, edited on B."),
    );
    await convergeBoth(a, b, 6);

    for (const d of [a, b]) {
      const text = d.vault.text("note.md") ?? "";
      expect(text, `${d.name} lost A's edit`).toContain("edited on A");
      expect(text, `${d.name} lost B's edit`).toContain("edited on B");
      expect(
        d.vault.paths().filter((x) => x.includes("Conflicted copy")),
        `${d.name} conflicted`,
      ).toEqual([]);
    }
  }, 300_000);

  /**
   * A download records the ancestor itself, rather than leaving it for the
   * next pass to notice.
   *
   * Once a file has been downloaded, local and remote agree, so the pass above
   * would set the ancestor on the following scan anyway. That makes the two
   * mechanisms cover for each other, and cover is not the same as either one
   * being tested. This closes the window between them: B downloads and the
   * user edits straight away, so there is no following scan in which both
   * sides still agree.
   */
  it("records the ancestor on the download itself", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    await a.vault.edit("note.md", base);
    await a.engine.sync();
    await new Promise((r) => setTimeout(r, 150));

    await b.engine.sync();
    expect(b.vault.text("note.md"), "B was meant to have downloaded it by now").toBe(base);

    // Edited before any pass in which local and remote still agree.
    await b.vault.edit(
      "note.md",
      base.replace("Third paragraph.", "Third paragraph, edited on B."),
    );
    await a.vault.edit(
      "note.md",
      base.replace("First paragraph.", "First paragraph, edited on A."),
    );
    await convergeBoth(a, b, 6);

    for (const d of [a, b]) {
      const text = d.vault.text("note.md") ?? "";
      expect(text, `${d.name} lost A's edit`).toContain("edited on A");
      expect(text, `${d.name} lost B's edit`).toContain("edited on B");
      expect(
        d.vault.paths().filter((x) => x.includes("Conflicted copy")),
        `${d.name} conflicted`,
      ).toEqual([]);
    }
  }, 300_000);

  it("runs one pass at a time however often it is asked", async () => {
    // Two passes deciding about the same file from the same index is how a
    // file gets uploaded twice or downloaded over itself.
    await fresh();
    const a = await device("a");
    for (let i = 0; i < 8; i++) await a.vault.edit(`note${i}.md`, `content ${i}`);

    const [first, second, third] = await Promise.all([
      a.engine.sync(),
      a.engine.sync(),
      a.engine.sync(),
    ]);

    // The later calls set a flag and return nothing rather than starting a
    // second pass, so the total is the work done once.
    const uploaded = first.uploaded + second.uploaded + third.uploaded;
    expect(uploaded).toBe(8);
    const settled = await a.engine.sync();
    expect(settled.uploaded).toBe(0);
  }, 120_000);
});

/**
 * A pass that throws on its way out leaves its queues full.
 *
 * Nothing in the loop can do that today: every path is inside a try that records
 * the failure and carries on, and the only throwing steps left (listing, pruning,
 * saving) sit outside the window where anything is queued. The guard is here
 * because the consequence is quiet rather than loud: those writes would commit
 * during the *next* pass and increment a report nobody reads, so the pass that
 * did the work would report none, and `settle` would stop with edits unsent.
 *
 * Discarding is safe. Nothing queued was acknowledged, so no entry is marked
 * synced, and reconciliation queues the same work again.
 */
describe("a pass that ended early", () => {
  it("discards what it queued rather than committing it against the next report", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.write("real.md", new TextEncoder().encode("a real note"), {
      mtime: 1000,
      ctime: 1000,
    });
    await a.settle();

    // What a thrown pass would leave behind. If the guard goes, this commits
    // during the next pass and its uid lands on nothing.
    let committed = false;
    const engine = a.engine as unknown as {
      outbox: unknown[];
      outboxBytes: number;
      inbox: unknown[];
    };
    engine.outbox.push({
      path: "left-over.md",
      size: 0,
      entry: { path: "sealed", meta: { size: 0, ctime: 0, mtime: 0, folder: true }, names: [] },
      bodyOf: async () => new Uint8Array(0),
      commit: () => {
        committed = true;
      },
    });
    engine.outboxBytes = 0;

    const report = await a.engine.sync();

    expect(committed, "a write left by a dead pass was committed by the next one").toBe(false);
    expect(engine.outbox).toHaveLength(0);
    expect(report.uploaded).toBe(0);
  });
});

describe("what the index forgets", () => {
  /**
   * `entries` was pruned and `remote` was not, so a vault kept the server's
   * word about every path it had ever deleted, for ever, in a file rewritten
   * on every sync. Measured before the fix: six hundred deleted notes left a
   * 59 KB index that only ever grew.
   */
  it("does not keep a record of every note ever deleted", async () => {
    await fresh();
    const a = await device("a");

    for (let i = 0; i < 40; i++) await a.vault.edit(`note-${i}.md`, `body ${i}\n`);
    await a.settle();
    expect(await remoteCount(a)).toBe(40);

    for (let i = 0; i < 40; i++) await a.vault.remove(`note-${i}.md`);
    await a.settle();
    expect(await remoteCount(a), "the index kept a tombstone per deleted note").toBe(0);
    expect(await entryCount(a)).toBe(0);
  }, 300_000);

  /**
   * The whole risk of forgetting. A deletion this device has applied must
   * stay applied: if dropping the record let the file come back, the prune
   * would be undoing somebody's deletion on every pass.
   */
  it("does not let a deletion undo itself once forgotten", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("gone.md", "here for now\n");
    await convergeBoth(a, b);
    expect(b.vault.text("gone.md")).toBe("here for now\n");

    await a.vault.remove("gone.md");
    await convergeBoth(a, b, 6);
    expect(await remoteCount(a)).toBe(0);

    // Several more passes, long after the record was dropped.
    await convergeBoth(a, b, 6);
    expect(a.vault.paths()).not.toContain("gone.md");
    expect(b.vault.paths()).not.toContain("gone.md");
  }, 300_000);

  /**
   * A device that was away when the deletion happened still learns about it,
   * because that comes from the server's batches rather than from anybody's
   * local index.
   */
  it("still tells a device that was not there", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("gone.md", "here for now\n");
    await a.settle();
    await a.vault.remove("gone.md");
    await a.settle();
    expect(await remoteCount(a)).toBe(0);

    const late = await device("late");
    await late.settle(6);
    expect(late.vault.paths()).not.toContain("gone.md");
  }, 300_000);

  /**
   * Work still outstanding is not something to forget.
   *
   * Applying an incoming deletion can fail on a real device: a locked file is
   * the ordinary case. The path stays on the inbound work list, and the
   * server's word about it is what the retry will act on. Dropping that
   * record would leave a work item nothing could ever resolve, and a file
   * that stays on this device after being deleted everywhere else.
   */
  it("keeps what it needs while a deletion has not been applied yet", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("locked.md", "cannot be removed just now\n");
    await convergeBoth(a, b);
    expect(b.vault.text("locked.md")).toBeDefined();

    // B is told to delete it and cannot, this once.
    b.vault.failRemoveOnce = "locked.md";
    await a.vault.remove("locked.md");
    await a.settle();
    await new Promise((r) => setTimeout(r, 80));
    // One pass, not a settle: a settle would retry within the same call and
    // the window being tested would close before it could be looked at.
    await b.engine.sync();

    // The file is still there, so the work is not done, and the record of
    // what to do must have survived.
    expect(b.vault.paths(), "the removal was meant to fail").toContain("locked.md");
    expect(await remoteCount(b), "B forgot what it still had to do").toBeGreaterThan(0);

    // And the retry finishes the job.
    await convergeBoth(a, b, 8);
    expect(b.vault.paths()).not.toContain("locked.md");
  }, 300_000);

  /** A path used again after being deleted is a new file, and syncs like one. */
  it("handles a path used again after it was forgotten", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    await a.vault.edit("reused.md", "the first note\n");
    await convergeBoth(a, b);
    await a.vault.remove("reused.md");
    await convergeBoth(a, b, 6);
    expect(await remoteCount(a)).toBe(0);

    await a.vault.edit("reused.md", "a completely different note\n");
    await convergeBoth(a, b, 6);
    expect(b.vault.text("reused.md")).toBe("a completely different note\n");
  }, 300_000);
});

describe("a file that could not sync, and then could", () => {
  /**
   * A permanent refusal stops the retries, which is right: a file the server
   * will reject for the same reason every time is noise that hides everything
   * else. But "permanent" describes the *file*, not the path, and a file can
   * be changed.
   *
   * Somebody whose note is refused for being too large shortens it, and
   * nothing happens, because the path was written off. The only way back was
   * to restart the application, and nothing said so.
   *
   * The refusal used here is an over-long name, which shortening the file does
   * not fix, so it is refused again. That is the correct outcome and not the
   * property being tested: what is tested is that it was tried at all, and the
   * log is where an attempt is observable.
   */
  it("tries again once the file has changed", async () => {
    await fresh();
    const said: string[] = [];
    const a = await device("a", (m) => said.push(m));

    // One filename past the server's limit: the cheapest permanent refusal
    // that lands on exactly one path. A deep path would refuse every folder
    // above it too.
    const tooLong = `${"x".repeat(5000)}.md`;
    await a.vault.edit(tooLong, "refused", 1_000);
    await a.vault.edit("fine.md", "accepted", 1_000);

    const refused = await a.settle();
    expect(refused.skipped, `report was ${JSON.stringify(refused)}`).toBe(1);
    expect(said.filter((m) => m === "skipped for good").length).toBe(1);

    // Unchanged, so it stays written off rather than being asked again.
    await a.settle();
    expect(said.filter((m) => m === "skipped for good").length).toBe(1);
    expect(said.filter((m) => m.startsWith("skipped file changed")).length).toBe(0);

    // Now the file changes.
    await a.vault.edit(tooLong, "different content entirely", 2_000);
    await a.settle();
    expect(
      said.filter((m) => m.startsWith("skipped file changed")).length,
      "a changed file was never tried again",
    ).toBe(1);
    // Tried, and refused again, which is the honest outcome for a name that
    // is still too long.
    expect(said.filter((m) => m === "skipped for good").length).toBe(2);
  }, 300_000);
});

/** How many paths the persisted index still has the server's word about. */
async function remoteCount(d: Device): Promise<number> {
  const state = await d.store.load();
  return state ? Object.keys(state.remote).length : 0;
}

async function entryCount(d: Device): Promise<number> {
  const state = await d.store.load();
  return state ? Object.keys(state.entries).length : 0;
}

describe("what a large attachment costs to send", () => {
  /**
   * A put used to take every sealed chunk of a file at once, so a 256 MiB
   * attachment, which is the size the server advertises it will take, meant
   * 512 MiB live: the file and a sealed copy of it. Measured rather than
   * guessed, and on a phone that is not a spike but the end of the process.
   *
   * The names still have to be known before the put is sent, so the file is
   * chunked and sealed in full either way. Two things changed. The sealed
   * bytes are dropped above a threshold, and a wanted chunk is sealed again
   * from the file, which is deterministic and so gives the same bytes. And
   * the sealing itself now runs a bounded window at a time, so a sealed copy
   * of the whole file is never live even for the moment it takes to learn the
   * names. Measured through a whole sync of one 64 MiB attachment: 816 MB
   * peak resident became 522 MB, and no slower.
   *
   * This counts how many sealed bodies are alive when the server asks for one
   * rather than trying to read the heap, because the heap is the runtime's
   * business and the count is the property.
   */
  /**
   * Windowing must change nothing but the memory. If the names differed from
   * what sealing everything at once produces, a file would go up under names
   * no other device agrees with, and every one of them would download it
   * again for ever.
   */
  it("names a file the same whatever window it is sealed in", async () => {
    // Comfortably more than one window. Content-defined chunking on random
    // bytes gives a count that varies run to run, so a file sized to land
    // near the window boundary makes this test flaky rather than wrong.
    const big = new Uint8Array(24 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 65536) {
      crypto.getRandomValues(big.subarray(at, Math.min(at + 65536, big.length)));
    }
    const pieces = [...chunkBytes(big, sizesFor(big.length, false), false)].map((c) => c.bytes);
    expect(pieces.length, "the test file is too small to have windows at all").toBeGreaterThan(
      SEAL_WINDOW * 2,
    );

    const together = (await sealChunks(keys, pieces)).map((c) => c.name);
    for (const window of [1, 3, SEAL_WINDOW, pieces.length * 2]) {
      expect(await sealedNames(keys, pieces, window), `window ${window}`).toEqual(together);
    }
  });

  /**
   * The server refuses an oversized file at the put, which is correct and far
   * too late: by then the client has read it, chunked it and sealed it, and
   * preparing a file costs several times its own size in memory. A file just
   * over the limit therefore cost the most memory of anything in the vault in
   * order to produce an error its size alone predicted.
   */
  it("refuses a file over the server's limit without reading it", async () => {
    await fresh();
    const a = await device("a");

    const limit = a.engine.limits?.perFileMax ?? 0;
    expect(limit, "the server advertised no file limit").toBeGreaterThan(0);

    // Counted rather than inferred: the property is that the bytes are
    // never fetched, and the vault is the only thing that knows.
    let reads = 0;
    const realRead = a.vault.read.bind(a.vault);
    a.vault.read = async (path: string) => {
      reads++;
      return realRead(path);
    };

    await a.vault.write("huge.bin", new Uint8Array(limit + 1), { mtime: 1000, ctime: 1000 });
    const report = await a.engine.sync();

    expect(reads, "the oversized file was read anyway").toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.uploaded).toBe(0);

    // Written off, not retried: a file does not get smaller by trying again.
    const again = await a.engine.sync();
    expect(again.skipped).toBe(1);
    expect(reads).toBe(0);

    // And undone the moment it changes, so trimming an attachment syncs it.
    await a.vault.write("huge.bin", new Uint8Array(16), { mtime: 2000, ctime: 1000 });
    const third = await a.engine.sync();
    expect(third.uploaded).toBe(1);
    expect(reads).toBeGreaterThan(0);
  });

  /**
   * A streamed file and a held file must produce identical names, or the two
   * adapters would disagree about what a file is called: the headless client
   * streams, the plugin cannot, and a vault synced by both would store every
   * large file twice and never recognise either copy.
   */
  it("names a streamed file exactly as a held one", async () => {
    const { chunkBytes, chunkStream, sizesFor } = await import("./chunk.ts");
    const { sealChunks } = await import("./crypto.ts");

    const bytes = new Uint8Array(9 * 1024 * 1024);
    for (let at = 0; at < bytes.length; at += 65536) {
      crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, bytes.length)));
    }
    const sizes = sizesFor(bytes.length, false);

    const held = (
      await sealChunks(
        keys,
        [...chunkBytes(bytes, sizes, false)].map((c) => c.bytes),
      )
    ).map((c) => c.name);

    async function* blocks(size: number) {
      for (let at = 0; at < bytes.length; at += size) {
        yield bytes.slice(at, Math.min(at + size, bytes.length));
      }
    }

    // Block size must not change the answer either. The chunker cuts on
    // content, so a boundary that moved with the read size would be a
    // rolling hash that was not rolling.
    for (const blockSize of [4096, 64 * 1024, 1024 * 1024, bytes.length]) {
      const streamed: string[] = [];
      const spans: number[] = [];
      for await (const piece of chunkStream(blocks(blockSize), sizes, false)) {
        streamed.push((await sealChunks(keys, [piece.bytes]))[0]!.name);
        spans.push(piece.offset);
      }
      expect(streamed, `block size ${blockSize}`).toEqual(held);
      // And the offsets have to be right, because a wanted chunk is read
      // back by range and would otherwise be different bytes.
      expect(spans[0]).toBe(0);
    }
  });

  it("does not hold a sealed copy of the whole file", async () => {
    await fresh();
    const said: string[] = [];
    const a = await device("a", (m: string, ...r: unknown[]) =>
      said.push(m + " " + r.map(String).join(" ")),
    );

    // Incompressible, so the sealed bytes are the size of the file rather
    // than of a run-length encoding of it.
    const big = new Uint8Array(12 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 65536) {
      crypto.getRandomValues(big.subarray(at, Math.min(at + 65536, big.length)));
    }
    await a.vault.write("attachment.bin", big, { mtime: 1000, ctime: 1000 });

    const report = await a.engine.sync();
    expect(report.uploaded, said.join(" | ")).toBe(1);
    expect(report.chunksSent, "a 12 MiB attachment came out as one chunk").toBeGreaterThan(1);

    // And it arrives intact, which is the thing re-sealing could break: the
    // second seal has to be byte for byte the first, or the server refuses
    // the body against the name it asked for.
    const b = await device("b");
    await b.settle(6);
    const got = await b.vault.read("attachment.bin");
    expect(got.length).toBe(big.length);
    expect(Buffer.from(got).equals(Buffer.from(big)), "the attachment came back different").toBe(
      true,
    );
  }, 300_000);

  /** A note keeps its sealed chunks, because re-sealing one saves nothing. */
  it("still sends a small file without sealing it twice", async () => {
    await fresh();
    const a = await device("a");
    await a.vault.edit("note.md", "a note, which is what almost every file is\n");
    // One pass, because Device.settle returns the last of several and the
    // last one is by construction the one with nothing left to do.
    const report = await a.engine.sync();
    expect(report.uploaded).toBe(1);

    const b = await device("b");
    await b.settle(4);
    expect(b.vault.text("note.md")).toBe("a note, which is what almost every file is\n");
  }, 300_000);
});

/**
 * Large files, of both kinds, through the real server.
 *
 * The chunk-size bug that made a max-size chunk exceed the ceiling only bit on
 * data that does not compress, and every large-file test in this project used
 * data that did. These use both: bytes from the random source, which is what a
 * photo or a video is, and prose, which is what a long note is.
 */
describe("large files", () => {
  /** Incompressible, in pieces because getRandomValues has a cap. */
  const noise = (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes);
    for (let at = 0; at < out.length; at += 65536) {
      crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, out.length)));
    }
    return out;
  };

  /** Prose, which compresses, and is what a long note actually is. */
  const prose = (bytes: number): string => {
    const words = "the quick brown fox jumps over a lazy dog while nobody watches".split(" ");
    let out = "";
    let i = 0;
    while (out.length < bytes) {
      out += words[i++ % words.length] + (i % 12 === 0 ? "\n" : " ");
    }
    return out.slice(0, bytes);
  };

  it("carries an attachment that does not compress", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const bytes = noise(9 * 1024 * 1024);
    await a.vault.write("photo.raw", bytes, { mtime: 1000, ctime: 1000 });

    const sent = await a.engine.sync();
    expect(sent.uploaded, `report was ${JSON.stringify(sent)}`).toBe(1);
    expect(sent.chunksSent, "9 MiB arrived as one chunk").toBeGreaterThan(4);

    await convergeBoth(a, b, 6);
    const got = await b.vault.read("photo.raw");
    expect(got.length).toBe(bytes.length);
    expect(Buffer.from(got).equals(Buffer.from(bytes)), "the attachment came back different").toBe(
      true,
    );
  }, 300_000);

  it("carries a note far larger than a note usually is", async () => {
    await fresh();
    const a = await device("a");
    const b = await device("b");

    const text = prose(6 * 1024 * 1024);
    await a.vault.edit("long.md", text);

    const sent = await a.engine.sync();
    expect(sent.uploaded, `report was ${JSON.stringify(sent)}`).toBe(1);

    await convergeBoth(a, b, 8);
    expect(b.vault.text("long.md")?.length).toBe(text.length);
    expect(b.vault.text("long.md")).toBe(text);
  }, 300_000);

  /**
   * The reason for chunking at all. An edit in the middle of a large file
   * should cost a chunk, not the file.
   */
  it("sends a chunk rather than the file when a large note changes", async () => {
    await fresh();
    const a = await device("a");
    const text = prose(4 * 1024 * 1024);
    await a.vault.edit("long.md", text);
    await a.settle();

    const middle = Math.floor(text.length / 2);
    await a.vault.edit(
      "long.md",
      text.slice(0, middle) + "an inserted sentence. " + text.slice(middle),
      2_000_000,
    );
    const again = await a.engine.sync();

    expect(again.uploaded).toBe(1);
    expect(
      again.bytesSent,
      `an edit to a 4 MiB note cost ${again.bytesSent} bytes across ${again.chunksSent} chunks`,
    ).toBeLessThan(64 * 1024);
  }, 300_000);

  /** An attachment edited in the middle is the same claim, without deflate. */
  it("sends a chunk rather than the file when a large attachment changes", async () => {
    await fresh();
    const a = await device("a");
    const bytes = noise(8 * 1024 * 1024);
    await a.vault.write("clip.raw", bytes, { mtime: 1000, ctime: 1000 });
    await a.settle();

    const edited = bytes.slice();
    edited.set(noise(1024), Math.floor(edited.length / 2));
    await a.vault.write("clip.raw", edited, { mtime: 2000, ctime: 1000 });
    const again = await a.engine.sync();

    expect(again.uploaded).toBe(1);
    expect(
      again.bytesSent,
      `changing 1 KiB of an 8 MiB attachment cost ${again.bytesSent} bytes`,
    ).toBeLessThan(4 * 1024 * 1024);
  }, 300_000);
});

/**
 * What the client refuses to be told by the server it is talking to.
 *
 * Everything the engine acts on beyond the chunk bodies and the sealed path
 * arrives in the clear and unauthenticated: `size`, `deleted`, `folder` and the
 * chunk list. The server holds every sealed path in the vault, so it can name
 * any file. These are the invariants the protocol doc already states and the
 * client was not checking on the way in.
 *
 * `docs/protocol.md`: "a file declaring a size names at least one chunk, since a
 * size with no chunks is byte-identical on the wire to an empty note." That was
 * assigned to the server and never mirrored here, so one frame emptied a note:
 * chunkNamesOf("-empty-") is [], nothing was fetched, and the zero-length
 * assembly was written straight over the file. Through `write`, not `remove`, so
 * there was no trash copy either, and the emptied note then propagated to every
 * peer as an ordinary edit.
 */
/**
 * A forged entry, signed the way a key holder signs.
 *
 * These tests are about the checks *behind* the authenticator: a writer that
 * holds the key and still emits something contradictory, which is a bug rather
 * than an attack, and which a corrupt row reproduces exactly. Without a valid
 * mac they would be refused one step earlier and prove nothing about the checks
 * they are named for.
 */
async function signed(e: Omit<WireEntry, "mac">): Promise<WireEntry> {
  return {
    ...e,
    mac: await macEntry(keys, {
      path: e.path,
      size: e.size,
      ctime: e.ctime,
      mtime: e.mtime,
      folder: e.folder,
      deleted: e.deleted,
      prev: e.prev,
      chunks: e.chunks,
      parent: e.parent,
    }),
  };
}

describe("a batch that contradicts itself", () => {
  let server: TestServer;
  let a: Device;

  afterEach(async () => {
    a?.transport?.close();
    if (server) await server.cleanup();
  });

  /** One device holding one synced note, and that note's sealed path. */
  async function synced(): Promise<{ path: string; sealed: string; before: Uint8Array }> {
    server = new TestServer();
    await server.start();
    a = new Device("a");
    await a.connect(server);

    const path = "Notes/keep.md";
    const before = new TextEncoder().encode("a paragraph worth keeping\n");
    await a.vault.write(path, before, { mtime: a.clock, ctime: a.clock });
    await a.engine.sync();
    expect(await a.vault.read(path)).toEqual(before);
    return { path, sealed: await sealPath(keys, path), before };
  }

  /**
   * The envelope itself. Everything above tests a check behind it; this tests
   * that a server which does not hold the key cannot get past it at all.
   *
   * Before protocol 2 each of these worked: the bytes of a file were sealed
   * and nothing else was, and the server holds every sealed path in the vault,
   * so it could name any file and say anything about it.
   */
  it("refuses an entry carrying no authenticator", async () => {
    const { path, sealed, before } = await synced();
    const uid = 1_000_000;
    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [
          {
            uid,
            path: sealed,
            size: 0,
            ctime: 0,
            mtime: a.clock + 1000,
            folder: false,
            deleted: true,
            chunks: [],
            device: "b",
            parent: "",
            mac: "",
          },
        ],
      }),
    ).rejects.toThrow(/not authenticated by this vault's key/);
    await a.engine.sync();
    expect(await a.vault.read(path)).toEqual(before);
  });

  it("refuses a deletion the server invented for a file it can name", async () => {
    const { path, sealed, before } = await synced();
    const uid = 1_000_000;
    // A well-formed mac, from a key this vault does not use.
    const stranger = await deriveKeys(new Uint8Array(20).fill(3));
    const facts = {
      path: sealed,
      size: 0,
      ctime: 0,
      mtime: a.clock + 1000,
      folder: false,
      deleted: true,
      chunks: [] as string[],
      parent: "",
    };
    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [{ uid, device: "b", ...facts, mac: await macEntry(stranger, facts) }],
      }),
    ).rejects.toThrow(/not authenticated by this vault's key/);
    await a.engine.sync();
    expect(await a.vault.read(path)).toEqual(before);
  });

  it("refuses an entry whose fields were edited after it was signed", async () => {
    const { path, sealed, before } = await synced();
    const uid = 1_000_000;
    // Signed honestly as a small edit, then altered into a deletion.
    const honest = {
      path: sealed,
      size: 0,
      ctime: 0,
      mtime: a.clock + 1000,
      folder: false,
      deleted: false,
      chunks: [] as string[],
      parent: "",
    };
    const mac = await macEntry(keys, honest);
    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [{ uid, device: "b", ...honest, deleted: true, mac }],
      }),
    ).rejects.toThrow(/not authenticated by this vault's key/);
    await a.engine.sync();
    expect(await a.vault.read(path)).toEqual(before);
  });

  it("refuses a size with no chunks, rather than emptying the note", async () => {
    const { path, sealed, before } = await synced();
    const uid = 1_000_000;

    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [
          await signed({
            uid,
            path: sealed,
            size: before.length,
            ctime: 0,
            mtime: a.clock + 1000,
            folder: false,
            deleted: false,
            chunks: [],
            device: "b",
            parent: "",
          }),
        ],
      }),
    ).rejects.toThrow(/size|chunk/i);

    // And the note is still there. A refusal that already wrote is not one.
    expect(await a.vault.read(path)).toEqual(before);
  });

  it("refuses chunks on an entry that says it is a deletion", async () => {
    const { sealed } = await synced();
    const uid = 1_000_000;
    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [
          await signed({
            uid,
            path: sealed,
            size: 0,
            ctime: 0,
            mtime: a.clock,
            folder: false,
            deleted: true,
            chunks: ["deadbeef"],
            device: "b",
            parent: "",
          }),
        ],
      }),
    ).rejects.toThrow(/chunk/i);
  });

  it("refuses chunks on an entry that says it is a folder", async () => {
    const { sealed } = await synced();
    const uid = 1_000_000;
    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [
          await signed({
            uid,
            path: sealed,
            size: 0,
            ctime: 0,
            mtime: a.clock,
            folder: true,
            deleted: false,
            chunks: ["deadbeef"],
            device: "b",
            parent: "",
          }),
        ],
      }),
    ).rejects.toThrow(/chunk/i);
  });

  /**
   * The attack the arrival check cannot see: a chunk list that is internally
   * consistent and belongs to a different file. Every chunk authenticates,
   * because every chunk is authentic; nothing binds one to the file it was cut
   * from. What catches it is that the bytes do not add up to the size the
   * entry declares, and the declared size is a count of the bytes that were
   * chunked rather than a stat, so that comparison is exact.
   */
  it("refuses a chunk list belonging to another file", async () => {
    const { path, sealed, before } = await synced();

    const other = "Notes/other.md";
    await a.vault.write(other, new TextEncoder().encode("a different length entirely, longer\n"), {
      mtime: a.clock,
      ctime: a.clock,
    });
    await a.engine.sync();

    const stored = await a.store.load();
    const otherChunks = (stored?.entries[other] as { chunks?: string[] } | undefined)?.chunks ?? [];
    expect(otherChunks.length, "the other note should have chunks to steal").toBeGreaterThan(0);

    const uid = 1_000_000;
    await a.engine.acceptBatch({
      from: uid,
      to: uid,
      entries: [
        await signed({
          uid,
          path: sealed,
          // The size of the file being overwritten, with the chunks of
          // the one being substituted in.
          size: before.length,
          ctime: 0,
          mtime: a.clock + 5000,
          folder: false,
          deleted: false,
          chunks: [...otherChunks],
          device: "b",
          parent: "",
        }),
      ],
    });

    await a.engine.sync();

    // The note is untouched. A refusal that already wrote is not a refusal.
    expect(await a.vault.read(path)).toEqual(before);
  });

  /**
   * A batch is one unit. Applied entry by entry, everything before a failure
   * stayed, `save()` persisted it, and `deleteLocal` needs no server to act on
   * it later: a forged deletion followed by an entry sealed under another
   * vault's key landed the deletion while the session died looking like a
   * misconfiguration.
   */
  it("applies nothing from a batch whose later entry is not ours", async () => {
    const { path, sealed, before } = await synced();
    const uid = 1_000_000;

    // A second vault's key, so its sealed path cannot be opened by this one.
    const stranger = await deriveKeys(new Uint8Array(20).fill(9));
    const foreign = await sealPath(stranger, "Notes/theirs.md");

    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid + 1,
        entries: [
          await signed({
            uid,
            path: sealed,
            size: 0,
            ctime: 0,
            mtime: a.clock + 1000,
            folder: false,
            deleted: true,
            chunks: [],
            device: "b",
            parent: "",
          }),
          await signed({
            uid: uid + 1,
            path: foreign,
            size: 0,
            ctime: 0,
            mtime: a.clock + 1000,
            folder: false,
            deleted: false,
            chunks: [],
            device: "b",
            parent: "",
          }),
        ],
      }),
    ).rejects.toThrow();

    // The forged deletion in front of it must not survive the refusal.
    await a.engine.sync();
    expect(await a.vault.read(path)).toEqual(before);
  });

  it("still accepts an ordinary empty note, which is a size of zero and no chunks", async () => {
    const { sealed } = await synced();
    const uid = 1_000_000;
    await expect(
      a.engine.acceptBatch({
        from: uid,
        to: uid,
        entries: [
          await signed({
            uid,
            path: sealed,
            size: 0,
            ctime: 0,
            mtime: a.clock + 1000,
            folder: false,
            deleted: false,
            chunks: [],
            device: "b",
            parent: "",
          }),
        ],
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * Missing has to mean this device's own ceiling, never no ceiling.
 *
 * `numberOf()` maps an absent field to 0, and both inbound guards used to read
 * `if (max > 0)`, so a server that simply left `perFileMax` and `maxChunks` out
 * of `ready` turned off the only bounds on inbound work. A corrupt row does the
 * same thing, which is what the guards were written for in the first place.
 */
describe("bounds taken from the party they exist to bound", () => {
  it("falls back to this device's ceiling rather than to none", () => {
    expect(boundedBy(0, 100)).toBe(100);
  });

  it("takes the server's when it is tighter", () => {
    expect(boundedBy(50, 100)).toBe(50);
  });

  it("refuses to be talked upwards", () => {
    expect(boundedBy(1_000_000, 100)).toBe(100);
  });

  it("has ceilings at the protocol's own maxima", () => {
    expect(OWN_LIMITS.perFileMax).toBe(256 * 1024 * 1024);
    expect(OWN_LIMITS.maxChunks).toBe(65536);
  });
});

/**
 * A server behind its own clients is a restored backup or the wrong vault, and
 * the client used to sync against it happily, reporting "up to date" because the
 * status line clamped the gap at zero.
 */
describe("a server that is behind this device", () => {
  it("is refused", () => {
    expect(() => refuseIfBehind(5, 9)).toThrow(/restored backup or the wrong vault/);
  });

  it("is fine when level, which is the ordinary case", () => {
    expect(() => refuseIfBehind(9, 9)).not.toThrow();
  });

  it("is fine when ahead, which is every sync with something to fetch", () => {
    expect(() => refuseIfBehind(90, 9)).not.toThrow();
  });

  it("is fine for a device that has never synced", () => {
    expect(() => refuseIfBehind(0, 0)).not.toThrow();
  });
});

/**
 * Whoever picks the merge base picks what can be thrown away.
 *
 * A three-way merge decides which side's changes are already present. A base
 * equal to the local file plus a few paragraphs makes those paragraphs look
 * deleted by the other side; mergeText drops them, the engine writes the result
 * and uploads it, and the shortened text becomes canonical on every device. No
 * conflict copy, and the pass reports one clean merge.
 *
 * The base is fetched by uid from the server. What the server cannot touch is
 * `entry.synchash`, this device's own record of the ancestor as of the last
 * completed sync, so the fetched chunks are checked against it.
 */
describe("a version that is not the version it is offered as", () => {
  let server: TestServer;
  let a: Device;

  afterEach(async () => {
    a?.transport?.close();
    if (server) await server.cleanup();
  });

  it("is refused when its chunks are not the ones recorded for it", async () => {
    server = new TestServer();
    await server.start();
    a = new Device("a");
    await a.connect(server);

    const path = "Notes/n.md";
    await a.vault.write(path, new TextEncoder().encode("one\ntwo\n"), {
      mtime: a.clock,
      ctime: a.clock,
    });
    await a.engine.sync();

    const stored = await a.store.load();
    const entry = stored?.entries[path] as
      { chunks?: string[]; syncuid?: number; synchash?: string } | undefined;
    const chunks = entry?.chunks ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    // Derived rather than read: the stored form leaves out a hash it can work
    // out from the chunk list, so the field is absent in the ordinary case.
    const synchash = entry?.synchash ?? contentId(chunks);

    // The real chunks under the real uid still open.
    await expect(a.engine.contentOf(entry!.syncuid!, chunks, synchash)).resolves.toBeInstanceOf(
      Uint8Array,
    );

    // A different chunk list for the same uid does not.
    await expect(
      a.engine.contentOf(entry!.syncuid!, [...chunks, chunks[0]!], synchash),
    ).rejects.toThrow(/not the version it is being offered as/);
  });
});

/**
 * A move should not put the file back on the wire.
 *
 * Chunk names are hashes of ciphertext, so moving a file costs the sender
 * nothing: the server already holds every chunk and only metadata travels. The
 * receiver had no such luck and downloaded the whole file back, under a name it
 * was already storing the identical bytes under. Moving one folder of
 * attachments re-pulled all of it, on every other device.
 *
 * Proved the only way that leaves no doubt: every chunk body is deleted from the
 * server before the receiving device syncs, so a single byte off the wire would
 * fail the test rather than merely be slower.
 */
describe("a move is not a download", () => {
  let server: TestServer;
  let a: Device;
  let b: Device;

  afterEach(async () => {
    a?.transport?.close();
    b?.transport?.close();
    if (server) await server.cleanup();
  });

  it("applies from bytes the device already holds, with the server emptied", async () => {
    server = new TestServer();
    await server.start();
    a = new Device("a");
    b = new Device("b");
    await a.connect(server);
    await b.connect(server);

    const body = new TextEncoder().encode("a paragraph worth moving.\n".repeat(400));
    await a.vault.write("Notes/big.md", body, { mtime: a.clock, ctime: a.clock });
    await convergeBoth(a, b);
    expect(await b.vault.read("Notes/big.md")).toEqual(body);

    // The move, as a delete of the old path and a write of the new one,
    // which is what a filesystem scan sees.
    await a.vault.remove("Notes/big.md");
    await a.vault.write("Archive/big.md", body, { mtime: a.clock + 1000, ctime: a.clock + 1000 });
    await a.engine.sync();
    await new Promise((r) => setTimeout(r, 120));

    // Now the server cannot serve a single byte of it.
    const { rm, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const chunks = join(server.dataDir, "chunks");
    for (const vault of await readdir(chunks)) {
      await rm(join(chunks, vault), { recursive: true, force: true });
    }

    await b.engine.sync();

    expect(await b.vault.read("Archive/big.md"), "the move needed the wire after all").toEqual(
      body,
    );
  }, 300_000);
});

/**
 * The index must never be durable ahead of the notes it names.
 *
 * A vault write used to make the file and its directory entry durable before it
 * returned. Flushing the directory once per pass instead of once per file is
 * 10.7 s against 6.1 s for two thousand files, and it moves when the name
 * becomes durable, so the ordering stops being incidental and has to be stated:
 * everything the pass wrote is made durable, and only then is the index written.
 *
 * Get it backwards and a crash leaves an index naming notes that are not there,
 * which the index would then believe on the next pass. That is rule 3 wearing a
 * different hat, and it is the whole reason the deferral is safe.
 */
describe("what is made durable, and in what order", () => {
  let server: TestServer;
  let a: Device;

  afterEach(async () => {
    a?.transport?.close();
    if (server) await server.cleanup();
  });

  it("flushes the vault before it writes the index", async () => {
    server = new TestServer();
    await server.start();
    a = new Device("a");

    const order: string[] = [];
    const vault = a.vault as unknown as { flush?: () => Promise<void> };
    vault.flush = async () => {
      order.push("vault flushed");
    };
    const store = a.store as unknown as { save(s: unknown): Promise<void> };
    const realSave = store.save.bind(store);
    store.save = async (state: unknown) => {
      order.push("index written");
      await realSave(state);
    };

    await a.connect(server);
    await a.vault.write("note.md", new TextEncoder().encode("hello\n"), {
      mtime: a.clock,
      ctime: a.clock,
    });
    await a.engine.sync();

    expect(order.length, "neither happened").toBeGreaterThan(0);
    expect(order[0], `order was ${order.join(", ")}`).toBe("vault flushed");
    expect(order).toContain("index written");
    // And every pass, not just the first: a pass that wrote nothing still
    // has nothing outstanding only because the flush said so.
    expect(order.filter((o) => o === "vault flushed").length).toBe(
      order.filter((o) => o === "index written").length,
    );
  }, 300_000);
});

/**
 * The index round trips through its stored form.
 *
 * A vault's chunk names were written to disk three times: as the list, joined
 * as `hash`, and usually a third time as `synchash`. The stored form leaves out
 * whatever it can derive, and an entry has to come back identical or the index
 * is lying about what is on disk.
 *
 * The case that has to survive is the one where those fields genuinely differ:
 * a file edited since its last sync, where `hash` is the new content and
 * `synchash` is the merge base. Collapsing them would not save space, it would
 * lose the ancestor.
 */
describe("what the index leaves out, and puts back", () => {
  let server: TestServer;
  let a: Device;

  afterEach(async () => {
    a?.transport?.close();
    if (server) await server.cleanup();
  });

  it("comes back the same, for a settled file and an edited one", async () => {
    server = new TestServer();
    await server.start();
    a = new Device("a");
    await a.connect(server);

    const enc = new TextEncoder();
    await a.vault.write("settled.md", enc.encode("one\n"), { mtime: a.clock, ctime: a.clock });
    await a.vault.write("edited.md", enc.encode("one\n"), { mtime: a.clock, ctime: a.clock });
    await a.engine.sync();

    // A completed sync always leaves the two agreeing, so the case where they
    // differ is made directly: an entry scanned since its last sync, whose
    // synchash is still the ancestor. That is the state a merge reads.
    const entries = (a.engine as unknown as { entries: Map<string, IndexEntry> }).entries;
    const edited = entries.get("edited.md")!;
    edited.synchash = "an-older-content-id";
    // And one with no chunk list at all, which is what an unscanned file looks
    // like and the case where `hash` cannot be derived.
    entries.get("settled.md")!.chunks = [];

    const held = (d: Device) =>
      new Map(
        [...(d.engine as unknown as { entries: Map<string, unknown> }).entries].map(([k, v]) => [
          k,
          JSON.stringify(v),
        ]),
      );
    await (a.engine as unknown as { save(): Promise<void> })["save"]();
    const before = held(a);
    const differ = [
      ...(a.engine as unknown as { entries: Map<string, { hash: string; synchash: string }> })
        .entries,
    ].filter(([, e]) => e.hash !== e.synchash);
    expect(
      differ.length,
      "no entry where the two hashes differ, so the hard case is untested",
    ).toBeGreaterThan(0);

    // A second engine over the same index must see exactly what the first held.
    const b = new Device("a");
    (b as unknown as { store: unknown }).store = a.store;
    await b.connect(server);
    const after = held(b);
    b.transport.close();

    expect(after.size, "the reloaded index is empty").toBe(before.size);
    for (const [path, want] of before) {
      expect(after.get(path), `${path} did not survive the round trip`).toBe(want);
    }
  }, 300_000);
});
