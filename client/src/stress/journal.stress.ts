/**
 * The index journal, at a size where its cost is visible.
 *
 * The unit tests pin what the journal does. These pin what it costs, because
 * two of the three things wrong with the first version were only visible in a
 * number: replay was quadratic in the size of the vault, and the snapshot
 * policy's floor was doing nothing on a small vault because nothing had ever
 * run it on one. Rule 8, which is where most of the real bugs here came from.
 *
 * Here rather than in the unit suite because these build indexes of tens of
 * thousands of entries and write to a real disk, and because the stress suite
 * is the gate before a release rather than the thing run on every save.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { JsonIndexStore } from "../cli/vault.ts";
import { deltaFrom, encodeRecord, replay, shapeOf } from "../core/index-journal.ts";
import { indexLogPath } from "../core/index-journal-store.ts";
import type { StoredState } from "../core/vault.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "basalt-journal-stress-"));
  dirs.push(dir);
  return dir;
}

function hex(seed: number): string {
  let s = seed >>> 0;
  let out = "";
  while (out.length < 64) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out += s.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

/** One entry of the shape `Engine.save` writes, with real chunk names in it. */
function entryOf(i: number, version: number): Record<string, unknown> {
  return {
    path: pathOf(i),
    prev: "",
    folder: false,
    ctime: 1700000000000 + i,
    mtime: 1700000000000 + i + version,
    size: 1800 + (i % 900),
    chunks: [hex(i * 31 + version * 1013), hex(i * 31 + 7 + version * 1013)],
    syncuid: i + version,
    synctime: 1700000000000 + i,
  };
}

function pathOf(i: number): string {
  return `folder${i % 40}/note-${i}.md`;
}

function vault(count: number, edited: ReadonlySet<number> = new Set()): StoredState {
  const entries: Record<string, unknown> = {};
  const remote: Record<string, unknown> = {};
  for (let i = 1; i <= count; i++) {
    entries[pathOf(i)] = entryOf(i, edited.has(i) ? 1 : 0);
    remote[pathOf(i)] = {
      uid: i,
      folder: false,
      deleted: false,
      mtime: 1700000000000 + i,
      size: 1800 + (i % 900),
      hash: hex(i),
    };
  }
  return { cursor: count + edited.size, entries, remote, pending: [] };
}

/**
 * A log of `records` passes, each editing one note, over a vault of `count`.
 *
 * The records are built rather than diffed, because diffing whole vaults to
 * build a fixture is quadratic and this file already has one thing in it that
 * was quadratic by accident. `deltaFrom` produces exactly these, and the test
 * below holds it to that so the shortcut cannot drift.
 */
function journal(count: number, records: number): { snapshot: StoredState; log: string } {
  const snapshot = vault(count);
  let log = "";
  for (let i = 1; i <= records; i++) {
    const note = 1 + (i % count);
    log += encodeRecord(i, {
      cursor: snapshot.cursor + i,
      set: { [pathOf(note)]: entryOf(note, 1) },
    });
  }
  return { snapshot, log };
}

function median(runs: number[]): number {
  return [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)]!;
}

function timed(f: () => void, times = 5): number {
  const runs: number[] = [];
  for (let i = 0; i < times; i++) {
    const t = performance.now();
    f();
    runs.push(performance.now() - t);
  }
  return median(runs);
}

describe("replaying a journal on load", () => {
  /**
   * The cost of a load must be the vault's size plus the log's, not their
   * product.
   *
   * The first version copied the whole entries map for every record, so a
   * thousand records over ten thousand notes was ten million entry copies:
   * 454 ms to start, against 10 ms for the whole-file read it replaced. The
   * whole design rests on an older index being safe, which is only true while
   * getting to it is cheap.
   *
   * A ratio rather than a time, because a time is a claim about this machine.
   * The same log over a vault forty times larger did forty times the work
   * before and does one larger copy now.
   */
  it("costs the vault once, not once per record", () => {
    const small = journal(500, 500);
    const large = journal(20000, 500);
    // Warm, so the first run's compilation is not the measurement.
    replay({ state: small.snapshot, seq: 0 }, small.log);
    replay({ state: large.snapshot, seq: 0 }, large.log);

    const cheap = timed(() => void replay({ state: small.snapshot, seq: 0 }, small.log));
    const dear = timed(() => void replay({ state: large.snapshot, seq: 0 }, large.log));

    expect(
      dear / cheap,
      `replay scaled with the vault size per record: ${cheap.toFixed(1)} ms at 500 notes, ` +
        `${dear.toFixed(1)} ms at 20,000, which is the shape of a copy per record`,
    ).toBeLessThan(10);
  });

  it("applies every record of a long journal, however it is folded", () => {
    // The property the speed must not cost. Folding in place is only safe
    // while nothing sees an intermediate state, and the way that goes wrong is
    // silently: a later record's write landing on a copy nothing keeps.
    const { snapshot, log } = journal(2000, 800);
    const out = replay({ state: snapshot, seq: 0 }, log);
    expect(out.applied).toBe(800);
    expect(out.stopped.why).toBe("end");
    expect(out.state.cursor).toBe(2000 + 800);
    expect(Object.keys(out.state.entries)).toHaveLength(2000);
    // Every note the log touched carries the edit, not just the last one.
    for (let i = 1; i <= 800; i++) {
      const note = 1 + (i % 2000);
      expect(
        (out.state.entries[pathOf(note)] as { syncuid: number }).syncuid,
        `record ${i} was folded into a copy nothing kept`,
      ).toBe(note + 1);
    }
    expect(snapshot.cursor, "replay mutated the snapshot it was handed").toBe(2000);
    expect(
      (snapshot.entries[pathOf(1)] as { syncuid: number }).syncuid,
      "replay mutated an entry of the snapshot it was handed",
    ).toBe(1);
  });

  it("builds the same record the engine's own comparison would", () => {
    // The fixture above writes records by hand so that building one is not
    // quadratic. This is what keeps that honest: a shortcut that drifted from
    // the real delta would have every test here measuring something else.
    const snapshot = vault(50);
    const byHand = encodeRecord(1, {
      cursor: snapshot.cursor + 1,
      set: { [pathOf(7)]: entryOf(7, 1) },
    });
    const real = encodeRecord(
      1,
      deltaFrom(shapeOf(snapshot), { ...vault(50, new Set([7])), cursor: snapshot.cursor + 1 })
        .delta!,
    );
    expect(byHand).toBe(real);
  });
});

describe("the snapshot policy at both ends of the range it has to cover", () => {
  /**
   * A small vault is what the floor exists for, and it was found by a test
   * rather than by reasoning.
   *
   * A new vault's index is a few kilobytes, a quarter of that is smaller than
   * one record, and without a floor every single pass rewrites the whole
   * index: the journal buys nothing at all on the vault most likely to be
   * somebody's first. Measured at 40 notes and 200 passes, the floor is the
   * difference between 22 rewrites and 2.
   */
  it("stops a small vault rewriting its index on every pass", async () => {
    const dir = await root();
    const counted = async (minBytes: number): Promise<number> => {
      const file = join(dir, `index-${minBytes}.json`);
      const store = new JsonIndexStore(file, {
        log: () => undefined,
        policy: { fractionOfSnapshot: 0.25, maxRecords: 1000, minBytes },
      });
      await store.load();
      await store.save(vault(40));
      let snapshots = 0;
      let was = (await stat(file)).mtimeMs;
      for (let pass = 1; pass <= 200; pass++) {
        await store.save(vault(40, new Set([1 + (pass % 40)])));
        const now = (await stat(file)).mtimeMs;
        if (now !== was) snapshots++;
        was = now;
      }
      return snapshots;
    };

    const without = await counted(0);
    const withFloor = await counted(64 * 1024);
    expect(without, "a small vault did not need a floor after all").toBeGreaterThan(10);
    expect(withFloor, "the floor did not stop the rewrites").toBeLessThan(5);
  });

  /**
   * A large vault must not journal for ever without folding it in.
   *
   * The record cap is the only bound that fires here in any reasonable time:
   * a quarter of a five megabyte index is three thousand records away. What
   * this pins is that the cap fires at all, and that the state survives the
   * boundary, because a snapshot that dropped what the log held would be the
   * first rule broken quietly.
   */
  it("folds a long journal into the index and loses nothing", async () => {
    const dir = await root();
    const file = join(dir, "index.json");
    const log = indexLogPath(file);
    const store = new JsonIndexStore(file, {
      log: () => undefined,
      policy: { fractionOfSnapshot: 0.25, maxRecords: 60, minBytes: 0 },
    });
    await store.load();
    await store.save(vault(4000));

    for (let pass = 1; pass <= 130; pass++) {
      await store.save(vault(4000, new Set([1 + (pass % 4000)])));
    }
    expect((await readFile(log, "utf8")).length, "the journal grew without bound").toBeLessThan(
      (await stat(file)).size,
    );

    const wanted = vault(4000, new Set([1 + (130 % 4000)]));
    const reopened = new JsonIndexStore(file, { log: () => undefined });
    expect(await reopened.load(), "state was lost when the journal was folded in").toEqual(wanted);
  });
});
