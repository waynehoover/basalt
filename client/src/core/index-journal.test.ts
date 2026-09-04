/**
 * The journal's crash semantics.
 *
 * These are the tests index-journal-spec.md says must exist before the journal
 * is finished, and they live at the codec because that is where a crash can be
 * arranged exactly rather than provoked. Every one of them describes something
 * a real filesystem does to a file that was being appended to when the power
 * went: a cut line, a line whose bytes changed under a good newline, NUL
 * padding where the file grew but the write never landed.
 *
 * The property they all serve: an older index is safe, an empty one is not,
 * and an invented one is worst of all.
 */

import { describe, expect, it } from "vitest";
import {
  type JournalDelta,
  type Snapshot,
  applyDelta,
  decodeRecord,
  deltaBetween,
  encodeRecord,
  replay,
} from "./index-journal.ts";
import type { StoredState } from "./vault.ts";

function state(over: Partial<StoredState> = {}): StoredState {
  return {
    cursor: 0,
    entries: {},
    remote: {},
    pending: [],
    ...over,
  } as StoredState;
}

function entry(path: string, size: number): Record<string, unknown> {
  return { path, prev: "", folder: false, ctime: 1, mtime: 2, size, hash: "h", chunks: [] };
}

/** A snapshot at seq 0 holding one note, which is the ordinary starting point. */
function base(): Snapshot {
  return { state: state({ cursor: 5, entries: { "one.md": entry("one.md", 10) } }), seq: 0 };
}

function log(...records: string[]): string {
  return records.join("");
}

describe("a journal record", () => {
  it("round trips", () => {
    const delta: JournalDelta = { cursor: 6, set: { "two.md": entry("two.md", 20) } };
    const read = decodeRecord(encodeRecord(1, delta).slice(0, -1));
    expect("why" in read, JSON.stringify(read)).toBe(false);
    expect(read).toMatchObject({ seq: 1, delta });
  });

  it("refuses a sequence that is not a positive integer", () => {
    expect(() => encodeRecord(0, {})).toThrow(/positive integer/);
    expect(() => encodeRecord(-1, {})).toThrow(/positive integer/);
    expect(() => encodeRecord(1.5, {})).toThrow(/positive integer/);
  });
});

describe("a log a crash damaged", () => {
  it("keeps everything before a record the crash cut in half", () => {
    const good = encodeRecord(1, { cursor: 6 });
    const cut = encodeRecord(2, { cursor: 7 }).slice(0, 12); // no newline
    const out = replay(base(), good + cut);
    expect(out.state.cursor, "the whole record was lost").toBe(6);
    expect(out.applied).toBe(1);
    expect(out.stopped.why).toBe("torn");
  });

  it("refuses a record whose bytes changed under a good newline", () => {
    // A torn write that happens to land on a newline: the line is complete and
    // parses, and only the checksum knows it is not what was written. Without
    // it this record would be applied and the index would hold a value nothing
    // ever wrote.
    const line = encodeRecord(1, { cursor: 6 });
    const damaged = line.replace('"cursor":6', '"cursor":9');
    const out = replay(base(), damaged);
    expect(out.state.cursor, "a damaged record was applied").toBe(5);
    expect(out.applied).toBe(0);
    expect(out.stopped.why).toBe("checksum");
  });

  it("refuses NUL padding, which some filesystems leave where a write never landed", () => {
    const good = encodeRecord(1, { cursor: 6 });
    const padded = good + "\0".repeat(64) + "\n";
    const out = replay(base(), padded);
    expect(out.state.cursor).toBe(6);
    expect(out.applied).toBe(1);
    expect(out.stopped.why).toBe("torn");
  });

  it("stops at damage in the middle rather than skipping past it", () => {
    // Skipping a bad record and applying the ones after it would apply deltas
    // over a base they were not written against, which invents a state that
    // never existed. Older is safe; invented is not.
    const out = replay(
      base(),
      log(
        encodeRecord(1, { cursor: 6 }),
        '1 deadbeef {"cursor":7}\n',
        encodeRecord(3, { cursor: 8 }),
      ),
    );
    expect(out.state.cursor, "replay ran past the damage").toBe(6);
    expect(out.applied).toBe(1);
  });
});

describe("the window between publishing a snapshot and truncating the log", () => {
  it("applies no record twice", () => {
    // The crash this exists for: the snapshot at seq 2 is durable, the log
    // still holds 1 and 2. Replaying them would be harmless today because the
    // values are absolute, and would stop being harmless the first time a
    // record was not.
    const snapshot: Snapshot = { state: state({ cursor: 7, entries: {} }), seq: 2 };
    const out = replay(
      snapshot,
      log(encodeRecord(1, { cursor: 6 }), encodeRecord(2, { cursor: 7 })),
    );
    expect(out.state.cursor).toBe(7);
    expect(out.applied, "a record already in the snapshot was applied again").toBe(0);
    expect(out.seq).toBe(2);
  });

  it("keeps the records the snapshot does not already hold", () => {
    const snapshot: Snapshot = { state: state({ cursor: 7 }), seq: 2 };
    const out = replay(
      snapshot,
      log(encodeRecord(2, { cursor: 7 }), encodeRecord(3, { cursor: 8 })),
    );
    expect(out.state.cursor).toBe(8);
    expect(out.applied).toBe(1);
    expect(out.seq).toBe(3);
  });
});

describe("a log that does not continue its snapshot", () => {
  it("falls back to the snapshot alone when the first record skips ahead", () => {
    // Records between the snapshot and this one are gone. Applying it would
    // put changes on top of a base they were never computed against.
    const out = replay(base(), encodeRecord(4, { cursor: 9 }));
    expect(out.state.cursor, "a delta was applied over the wrong base").toBe(5);
    expect(out.applied).toBe(0);
    expect(out.stopped).toMatchObject({ why: "gap", seq: 4, after: 0 });
  });

  it("stops when sequences go backwards inside the log", () => {
    const out = replay(base(), log(encodeRecord(1, { cursor: 6 }), encodeRecord(1, { cursor: 7 })));
    expect(out.state.cursor).toBe(6);
    expect(out.stopped.why).toBe("out-of-order");
  });
});

describe("a vault that has always used a snapshot and no log", () => {
  it("loads exactly what the snapshot says", () => {
    const out = replay(base(), "");
    expect(out.state).toEqual(base().state);
    expect(out.applied).toBe(0);
    expect(out.stopped.why).toBe("end");
  });
});

describe("what a pass changed", () => {
  it("is nothing at all for a settled vault", () => {
    // A settled vault passes on every watch tick and every keepalive. If this
    // ever answers with a delta, the journal grows for ever while nothing
    // happens, which is the cost LastIndexWrite was added to remove.
    const s = base().state;
    expect(deltaBetween(s, s)).toBeUndefined();
    expect(deltaBetween(s, { ...s, entries: { ...s.entries } })).toBeUndefined();
  });

  it("names an entry that changed, one that arrived, and one that went", () => {
    const before = state({
      entries: { "keep.md": entry("keep.md", 1), "gone.md": entry("gone.md", 2) },
    });
    const after = state({
      cursor: 3,
      entries: { "keep.md": entry("keep.md", 99), "new.md": entry("new.md", 4) },
    });
    const delta = deltaBetween(before, after)!;
    expect(Object.keys(delta.set ?? {}).sort()).toEqual(["keep.md", "new.md"]);
    expect(delta.del).toEqual(["gone.md"]);
    expect(delta.cursor).toBe(3);
  });

  it("survives a round trip through the log", () => {
    const before = base().state;
    const after = state({
      cursor: 9,
      entries: { "two.md": entry("two.md", 7) },
      remote: {
        "two.md": { uid: 9, folder: false, deleted: false, mtime: 1, size: 7, hash: "abc" },
      },
      pending: ["two.md"],
    });
    const out = replay(base(), encodeRecord(1, deltaBetween(before, after)!));
    expect(out.state, "a delta did not carry the whole change").toEqual(after);
  });

  it("leaves both states untouched when it is applied", () => {
    const s = base().state;
    const frozen = JSON.stringify(s);
    applyDelta(s, { cursor: 42, set: { "x.md": entry("x.md", 1) }, del: ["one.md"] });
    expect(JSON.stringify(s), "applyDelta mutated its argument").toBe(frozen);
  });
});
