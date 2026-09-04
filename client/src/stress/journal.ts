/**
 * What the index journal costs, and what the snapshot policy should be.
 *
 * `index-journal-spec.md` proposed a quarter of the snapshot, 1000 records and
 * a 64 KiB floor and said all three were guesses. A guess in a constant is a
 * decision nobody made, so this measures the four things the policy is a
 * trade between:
 *
 *   - what a pass costs when it appends, against what it costs to rewrite the
 *     whole index. That difference is what the journal buys.
 *   - what a settled pass costs, which is paid on every watch tick for ever
 *     and is the one the whole-file store already had a skip for.
 *   - how fast a log is replayed on load, which is what a larger log costs.
 *   - how big a record really is, which is what turns "1000 records" into
 *     bytes and days.
 *
 * Run: `bun run src/stress/journal.ts`, or `NOTES=50000 bun run ...`.
 * Numbers land in docs/compared.md with the corpus they were taken on.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonIndexStore, writeDurably } from "../cli/vault.ts";
import { deltaFrom, encodeRecord, replay, shapeOf } from "../core/index-journal.ts";
import { indexLogPath } from "../core/index-journal-store.ts";
import type { StoredState } from "../core/vault.ts";

const COUNT = Number(process.env["NOTES"] ?? 10000);

/**
 * An index entry of the shape `Engine.save` writes, with real chunk names.
 *
 * Synthetic rather than a real sync, because a real one at ten thousand notes
 * costs minutes of chunking and sealing to produce a file whose *shape* is all
 * that matters here. The check that the shape is right is the index size:
 * docs/compared.md measured 5.6 MiB at 10,000 notes from a real sync, and this
 * corpus is compared against it below.
 */
function entry(i: number, version = 0): Record<string, unknown> {
  const chunks = 2 + (i % 2); // 2.16 chunks per note was the measured average
  return {
    path: `folder${i % 40}/note-${i}.md`,
    prev: "",
    folder: false,
    ctime: 1700000000000 + i,
    mtime: 1700000000000 + i + version,
    size: 1800 + (i % 900),
    chunks: Array.from({ length: chunks }, (_, c) => hex(i * 31 + c * 7 + version * 1013)),
    syncuid: i + version,
    synctime: 1700000000000 + i,
  };
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

function vault(count: number, edited: ReadonlySet<number> = new Set()): StoredState {
  const entries: Record<string, unknown> = {};
  const remote: Record<string, unknown> = {};
  for (let i = 1; i <= count; i++) {
    const e = entry(i, edited.has(i) ? 1 : 0);
    entries[e["path"] as string] = e;
    remote[e["path"] as string] = {
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

function ms(f: () => void, times = 5): number {
  const runs: number[] = [];
  for (let i = 0; i < times; i++) {
    const t = performance.now();
    f();
    runs.push(performance.now() - t);
  }
  return runs.sort((a, b) => a - b)[Math.floor(times / 2)]!;
}

async function msAsync(f: () => Promise<void>, times = 5): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i < times; i++) {
    const t = performance.now();
    await f();
    runs.push(performance.now() - t);
  }
  return runs.sort((a, b) => a - b)[Math.floor(times / 2)]!;
}

const dir = await mkdtemp(join(tmpdir(), "basalt-journal-"));
const file = join(dir, "index.json");
const log = indexLogPath(file);

for (const count of [1000, COUNT]) {
  const settled = vault(count);
  const text = JSON.stringify(settled);
  console.log(`\n\x1b[1m${count} notes\x1b[0m  index ${(text.length / 1048576).toFixed(2)} MiB`);

  /* What a pass costs, in the two shapes it comes in. */
  const shape = shapeOf(settled);
  const unchanged = ms(() => void deltaFrom(shape, settled));
  const twenty = new Set(Array.from({ length: 20 }, (_, i) => 1 + i * 37));
  const edited = vault(count, twenty);
  const oneNote = vault(count, new Set([7]));
  const compare = ms(() => void deltaFrom(shape, edited));
  const stringify = ms(() => void JSON.stringify(settled));

  console.log(`  settled pass, no write        ${unchanged.toFixed(2)} ms  (comparison only)`);
  console.log(`  the whole-file store's skip   ${stringify.toFixed(2)} ms  (JSON.stringify)`);
  console.log(`  a pass with 20 notes edited   ${compare.toFixed(2)} ms  (comparison)`);

  /* What a record weighs. */
  const one = encodeRecord(1, deltaFrom(shape, oneNote).delta!);
  const twentyRec = encodeRecord(1, deltaFrom(shape, edited).delta!);
  console.log(`  record, 1 note edited         ${one.length} bytes`);
  console.log(`  record, 20 notes edited       ${twentyRec.length} bytes`);

  /*
   * What the two writes cost on a real disk.
   *
   * The state a pass hands down is built once and edited in place between
   * runs, because building a ten thousand entry index is slower than either
   * write and the first version of this had it inside the measurement, which
   * made the journal look three times more expensive than the whole-file write
   * it replaces. Rule 8 cuts both ways.
   */
  const nextPass = (live: StoredState, n: number): StoredState => {
    const i = 1 + (n % count);
    (live.entries as Record<string, unknown>)[`folder${i % 40}/note-${i}.md`] = entry(i, n);
    return { ...live, cursor: count + n };
  };

  await rm(file, { force: true });
  await rm(log, { force: true });
  const folding = new JsonIndexStore(file, {
    log: () => undefined,
    policy: { fractionOfSnapshot: 0, maxRecords: 1, minBytes: 0 },
  });
  await folding.load();
  await folding.save(settled);
  const forSnapshot = vault(count);
  let v = 0;
  const snapshotMs = await msAsync(
    async () => void (await folding.save(nextPass(forSnapshot, ++v))),
    10,
  );

  await rm(file, { force: true });
  await rm(log, { force: true });
  const appending = new JsonIndexStore(file, { log: () => undefined });
  await appending.load();
  await appending.save(settled);
  const forAppend = vault(count);
  let w = 0;
  const appendMs = await msAsync(
    async () => void (await appending.save(nextPass(forAppend, ++w))),
    20,
  );

  const wholeFile = join(dir, "whole.json");
  const oldWay = await msAsync(async () => {
    await writeDurably(wholeFile, new TextEncoder().encode(JSON.stringify(settled)), true, {
      stageIn: join(dir, "tmp"),
    });
  }, 10);

  console.log(
    `  a changed pass, before        ${oldWay.toFixed(2)} ms  (stringify + whole file, durable)`,
  );
  console.log(
    `  a changed pass, now           ${appendMs.toFixed(2)} ms  (compare + one record, durable)`,
  );
  console.log(`  a pass that folds the log in  ${snapshotMs.toFixed(2)} ms  (snapshot + truncate)`);

  /* What a log costs to replay, which is what a bigger one buys and pays. */
  let records = "";
  for (let i = 1; i <= 1000; i++) {
    records += encodeRecord(i, deltaFrom(shape, vault(count, new Set([1 + (i % count)]))).delta!);
  }
  const snapshot = { state: settled, seq: 0 };
  replay(snapshot, records);
  const replayMs = ms(() => void replay(snapshot, records), 5);
  console.log(
    `  1000 records                  ${(records.length / 1024).toFixed(0)} KiB, replayed in ${replayMs.toFixed(0)} ms ` +
      `(${(records.length / 1024 / replayMs).toFixed(0)} KiB/ms)`,
  );

  /* Where the policy actually fires, and how often. */
  for (const floor of [0, 16 * 1024, 64 * 1024, 256 * 1024]) {
    await rm(file, { force: true });
    await rm(log, { force: true });
    const s = new JsonIndexStore(file, {
      log: () => undefined,
      policy: { fractionOfSnapshot: 0.25, maxRecords: 1000, minBytes: floor },
    });
    await s.load();
    await s.save(settled);
    let snapshots = 0;
    let was = (await stat(file)).mtimeMs;
    let maxLog = 0;
    for (let pass = 1; pass <= 200; pass++) {
      await s.save(vault(count, new Set([1 + (pass % count)])));
      maxLog = Math.max(maxLog, (await stat(log)).size);
      const now = (await stat(file)).mtimeMs;
      if (now !== was) snapshots++;
      was = now;
    }
    console.log(
      `  floor ${(floor / 1024).toFixed(0).padStart(4)} KiB   ${String(snapshots).padStart(3)} snapshots in 200 passes, ` +
        `log peaked at ${(maxLog / 1024).toFixed(0)} KiB`,
    );
  }
}

/* A small vault is the case the floor exists for, so it gets its own line. */
console.log("\n\x1b[1m40 notes, a new vault\x1b[0m");
for (const floor of [0, 64 * 1024]) {
  await rm(file, { force: true });
  await rm(log, { force: true });
  const small = new JsonIndexStore(file, {
    log: () => undefined,
    policy: { fractionOfSnapshot: 0.25, maxRecords: 1000, minBytes: floor },
  });
  await small.load();
  await small.save(vault(40));
  let snapshots = 0;
  let was = (await stat(file)).mtimeMs;
  for (let pass = 1; pass <= 200; pass++) {
    await small.save(vault(40, new Set([1 + (pass % 40)])));
    const now = (await stat(file)).mtimeMs;
    if (now !== was) snapshots++;
    was = now;
  }
  const size = (await stat(file)).size;
  console.log(
    `  floor ${(floor / 1024).toFixed(0).padStart(4)} KiB   ${String(snapshots).padStart(3)} snapshots in 200 passes ` +
      `(index ${size} bytes, log ${(await stat(log)).size} bytes)`,
  );
}

console.log(
  `\nwhat a record is worth in days: a settled watch saves on every tick and writes nothing;\n` +
    `only a pass that changed something appends. ` +
    `${(await readFile(log, "utf8")).length} bytes left in the last log.`,
);
await rm(dir, { recursive: true, force: true });
