/**
 * The journal store's behaviour, against a fake filesystem that can be made to
 * fail exactly where a real one fails by accident.
 *
 * The fake is the point. A short append and a crash between publishing a
 * snapshot and truncating the log are both things a real disk does rarely and
 * a test must do every time.
 */

import { describe, expect, it } from "vitest";
import {
  JournalIndexStore,
  type JournalFiles,
  type JournalStamps,
  wantsSnapshot,
} from "./index-journal-store.ts";
import type { StoredState } from "./vault.ts";

class FakeFiles implements JournalFiles {
  snapshot: string | undefined;
  log: string | undefined;
  /** Cut every append to this many bytes, the way a full disk would. */
  truncateAppendsTo: number | undefined;
  /** Throw after the snapshot is durable and before the log is truncated. */
  crashBeforeTruncate = false;
  /** Throw instead of publishing a snapshot, the way a full disk would. */
  failWriteSnapshot = false;
  appends = 0;
  snapshots = 0;

  /**
   * A clock that ticks on every write, so a stamp can tell one write from the
   * next. A real filesystem's does too, and the one that does not is the
   * residual the store's comment names.
   */
  private clock = 1;
  private snapshotAt = 0;
  private logAt = 0;

  async readSnapshot(): Promise<string | undefined> {
    return this.snapshot;
  }
  async writeSnapshot(text: string): Promise<void> {
    if (this.failWriteSnapshot) throw new Error("no space");
    this.snapshot = text;
    this.snapshotAt = this.clock++;
    this.snapshots++;
  }
  async readLog(): Promise<string | undefined> {
    return this.log;
  }
  async appendLog(line: string): Promise<void> {
    const write =
      this.truncateAppendsTo === undefined ? line : line.slice(0, this.truncateAppendsTo);
    this.log = (this.log ?? "") + write;
    this.logAt = this.clock++;
    this.appends++;
  }
  async truncateLog(): Promise<void> {
    if (this.crashBeforeTruncate) throw new Error("power cut");
    this.log = "";
    this.logAt = this.clock++;
  }
  async stamps(): Promise<JournalStamps> {
    return {
      ...(this.snapshot === undefined
        ? {}
        : { snapshot: { size: bytes(this.snapshot), mtime: this.snapshotAt } }),
      ...(this.log === undefined ? {} : { log: { size: bytes(this.log), mtime: this.logAt } }),
    };
  }

  /** What another writer does: touch a file this store thinks is its own. */
  writeBehindOurBack(what: "snapshot" | "log", text: string): void {
    if (what === "snapshot") {
      this.snapshot = text;
      this.snapshotAt = this.clock++;
    } else {
      this.log = text;
      this.logAt = this.clock++;
    }
  }
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function state(over: Partial<StoredState> = {}): StoredState {
  return { cursor: 0, entries: {}, remote: {}, pending: [], ...over } as StoredState;
}

function entry(path: string, size: number): Record<string, unknown> {
  return { path, prev: "", folder: false, ctime: 1, mtime: 2, size, hash: "h", chunks: [] };
}

describe("a vault with no index at all", () => {
  it("loads as undefined and snapshots on the first save", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    expect(await store.load()).toBeUndefined();
    await store.save(state({ cursor: 1 }));
    expect(files.snapshots).toBe(1);
    expect(files.appends).toBe(0);
  });

  it("refuses a journal with no snapshot rather than inventing a base for it", async () => {
    // Applying deltas to nothing would produce a state that never existed, and
    // silently ignoring them would be rule 2.
    const files = new FakeFiles();
    files.log = '1 00000000 {"cursor":1}\n';
    await expect(new JournalIndexStore(files).load()).rejects.toThrow(/no snapshot/);
  });
});

describe("an ordinary sequence of passes", () => {
  it("appends what changed and does not rewrite the snapshot", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    await store.save(state({ cursor: 1 }));
    const afterFirst = files.snapshots;

    await store.save(state({ cursor: 2, entries: { "a.md": entry("a.md", 1) } }));
    await store.save(state({ cursor: 3, entries: { "a.md": entry("a.md", 1) } }));
    expect(files.appends, "a change did not reach the log").toBe(2);
    expect(files.snapshots, "the snapshot was rewritten for an ordinary pass").toBe(afterFirst);
  });

  it("writes nothing at all when nothing changed", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    const s = state({ cursor: 4, entries: { "a.md": entry("a.md", 1) } });
    await store.save(s);
    const appends = files.appends;
    const snapshots = files.snapshots;

    for (let i = 0; i < 20; i++)
      await store.save(state({ cursor: 4, entries: { "a.md": entry("a.md", 1) } }));
    expect(files.appends, "a settled vault kept writing").toBe(appends);
    expect(files.snapshots).toBe(snapshots);
  });

  it("reads back exactly what was saved, across a reopen", async () => {
    const files = new FakeFiles();
    const first = new JournalIndexStore(files);
    await first.load();
    await first.save(state({ cursor: 1 }));
    const wanted = state({
      cursor: 9,
      entries: { "a.md": entry("a.md", 3) },
      remote: { "a.md": { uid: 9, folder: false, deleted: false, mtime: 1, size: 3, hash: "abc" } },
      pending: ["a.md"],
    });
    await first.save(wanted);

    const reopened = new JournalIndexStore(files);
    expect(await reopened.load()).toEqual(wanted);
  });
});

describe("an append that did not land whole", () => {
  it("raises rather than leaving a record the next load will silently drop", async () => {
    // A short append is the one damage this format cannot see for itself at
    // write time: the next load discards it and nothing ever says why.
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    await store.save(state({ cursor: 1 }));
    files.truncateAppendsTo = 5;
    await expect(store.save(state({ cursor: 2 }))).rejects.toThrow(/did not land whole/);
  });
});

describe("a crash between publishing a snapshot and truncating the log", () => {
  it("loads the snapshot and applies none of the records it already holds", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files, {
      policy: { fractionOfSnapshot: 0, maxRecords: 3, minBytes: 0 },
    });
    await store.load();
    await store.save(state({ cursor: 1 }));
    await store.save(state({ cursor: 2 }));

    files.crashBeforeTruncate = true;
    await expect(store.save(state({ cursor: 3 }))).rejects.toThrow(/power cut/);
    expect(files.snapshot, "the snapshot was not published first").toContain('"cursor":3');
    expect(files.log, "the log was truncated despite the crash").not.toBe("");

    const reopened = new JournalIndexStore(files);
    expect((await reopened.load())!.cursor).toBe(3);
  });
});

describe("a log that cannot be trusted", () => {
  it("keeps the records before the damage and drops the rest", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    await store.save(state({ cursor: 1 }));
    await store.save(state({ cursor: 2 }));
    files.log = (files.log ?? "") + '2 deadbeef {"cursor":99}\n';

    const said: string[] = [];
    const reopened = new JournalIndexStore(files, { log: (m) => said.push(m) });
    expect((await reopened.load())!.cursor).toBe(2);
    expect(said.join(" "), "a discarded record was not reported").toMatch(/journal stops/);
  });

  it("falls back to the snapshot when the whole log is rubbish", async () => {
    const files = new FakeFiles();
    const store = new JournalIndexStore(files);
    await store.load();
    await store.save(state({ cursor: 7 }));
    files.log = "not a journal at all\n";

    const reopened = new JournalIndexStore(files, { log: () => undefined });
    expect((await reopened.load())!.cursor).toBe(7);
  });
});

describe("a snapshot that cannot be read", () => {
  it("refuses, and does not start from empty", async () => {
    const files = new FakeFiles();
    files.snapshot = "{ this is not json";
    await expect(new JournalIndexStore(files).load()).rejects.toThrow(/not valid JSON/);
  });
});

describe("the snapshot policy", () => {
  const tiny = { fractionOfSnapshot: 0.25, maxRecords: 1000, minBytes: 0 };

  it("takes a snapshot once the log has outgrown its fraction", () => {
    expect(wantsSnapshot(10, 1000, 1, tiny)).toBe(false);
    expect(wantsSnapshot(300, 1000, 1, tiny)).toBe(true);
  });

  it("leaves a small log alone however small the snapshot is", () => {
    // The failure this floor exists for: a new vault's snapshot is a few dozen
    // bytes, so a quarter of it is smaller than one record and every pass
    // would rewrite the whole index, which is what the journal replaces.
    expect(wantsSnapshot(300, 60, 1), "a small vault snapshotted on an ordinary pass").toBe(false);
    expect(wantsSnapshot(300, 60, 1, tiny)).toBe(true);
  });

  it("bounds a vault by the record count whatever the sizes say", () => {
    expect(wantsSnapshot(5000, 0, 1)).toBe(false);
    expect(wantsSnapshot(5000, 0, 1000)).toBe(true);
  });
});

describe("something else writing the index", () => {
  /** A policy that never fires, so only a foreign write can force a snapshot. */
  const never = { fractionOfSnapshot: 1e9, maxRecords: 1e9, minBytes: 1e9 };

  it("is answered with a whole snapshot rather than a record", async () => {
    // A record appended beside a snapshot somebody else wrote is this device's
    // delta over their base, which invents a state that never existed. A whole
    // snapshot is complete on its own and cannot.
    const files = new FakeFiles();
    const said: string[] = [];
    const store = new JournalIndexStore(files, { policy: never, log: (m) => said.push(m) });
    await store.load();
    await store.save(state({ cursor: 1 }));
    await store.save(state({ cursor: 2 }));
    expect(files.appends).toBe(1);

    files.writeBehindOurBack("snapshot", JSON.stringify({ ...state({ cursor: 900 }), seq: 77 }));
    await store.save(state({ cursor: 3 }));
    expect(said.join(" ")).toMatch(/something else is writing the index/);
    expect(files.appends, "a record was appended onto somebody else's snapshot").toBe(1);
    expect(files.log).toBe("");
  });

  it("still owes that snapshot after one that failed", async () => {
    // The failure this catches: a foreign write forces a snapshot, the
    // snapshot cannot be written, and the next save finds the files unchanged
    // since the failure and quietly appends a record beside the foreign
    // snapshot after all. One-shot alarms have to survive a failure or they
    // are worse than none.
    const files = new FakeFiles();
    const store = new JournalIndexStore(files, { policy: never, log: () => undefined });
    await store.load();
    await store.save(state({ cursor: 1 }));
    await store.save(state({ cursor: 2 }));

    files.writeBehindOurBack("snapshot", JSON.stringify({ ...state({ cursor: 900 }), seq: 77 }));
    files.failWriteSnapshot = true;
    await expect(store.save(state({ cursor: 3 }))).rejects.toThrow(/no space/);
    files.failWriteSnapshot = false;

    await store.save(state({ cursor: 4 }));
    expect(files.appends, "a failed snapshot was papered over with a record").toBe(1);
    expect(files.snapshot, "the snapshot that was owed was never written").toContain('"cursor":4');
    expect(files.log).toBe("");
  });
});
