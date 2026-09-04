/**
 * The index journal, on the two shells that actually run it.
 *
 * `core/index-journal.test.ts` pins the crash semantics where a crash can be
 * arranged exactly, with no I/O in the way, and `core/index-journal-store.test.ts`
 * pins the policy against a fake filesystem. Neither of them proves that the
 * thing is wired to anything. This does: every test here goes through
 * `JsonIndexStore` on a real directory or `ObsidianIndexStore` on the fake
 * adapter, which is the same code both shells ship.
 *
 * It exists because the journal was written, tested and imported by nothing.
 * A green suite over code the product does not run is the shape rule 9 exists
 * to refuse, and the way to keep it refused is a file that fails the moment
 * either shell stops using it.
 *
 * The crash points are one test each rather than one happy path, because this
 * is the file whose corruption the first rule is about and "it recovers" is
 * not a property: recovering from the four things that can actually happen is.
 */

import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonIndexStore } from "./cli/vault.ts";
import { indexLogPath } from "./core/index-journal-store.ts";
import { encodeRecord } from "./core/index-journal.ts";
import type { StoredState } from "./core/vault.ts";
import { FakeAdapter } from "./plugin/fake.ts";
import { ObsidianIndexStore } from "./plugin/vault.ts";

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

function entry(path: string, size: number): Record<string, unknown> {
  return { path, prev: "", folder: false, ctime: 1, mtime: 2, size, hash: `h${size}`, chunks: [] };
}

function remote(uid: number): Record<string, unknown> {
  return { uid, folder: false, deleted: false, mtime: 1, size: 3, hash: "abc" };
}

/** A state a real vault could hold, and one the engine's own check accepts. */
function state(cursor: number, notes = 1): StoredState {
  const entries: Record<string, unknown> = {};
  for (let i = 1; i <= notes; i++) entries[`note-${i}.md`] = entry(`note-${i}.md`, 100 + i);
  return { cursor, entries, remote: { "note-1.md": remote(cursor || 1) }, pending: [] };
}

/** What today's index looks like: the state, and nothing else. No sequence. */
function legacy(cursor: number, notes = 1): string {
  return JSON.stringify(state(cursor, notes));
}

let root: string;
const dirs: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basalt-journal-"));
  dirs.push(root);
});

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A headless store over a fresh directory, with everything it says captured. */
function cli(said: string[] = [], file = join(root, ".basalt", "index.json")) {
  return {
    store: new JsonIndexStore(file, { log: (m) => said.push(m) }),
    file,
    log: indexLogPath(file),
    said,
  };
}

/** The plugin's store over the fake adapter, likewise. */
function plugin(adapter = new FakeAdapter(), said: string[] = []) {
  const file = ".obsidian/plugins/basalt/index.json";
  return {
    adapter,
    store: new ObsidianIndexStore(adapter, file, { log: (m) => said.push(m) }),
    file,
    log: indexLogPath(file),
    said,
    fresh: (also: string[] = said) =>
      new ObsidianIndexStore(adapter, file, { log: (m) => also.push(m) }),
  };
}

/* ---------------------------------------------------------------- *
 * The engine actually uses it
 * ---------------------------------------------------------------- */

describe("the shells' own index stores are the journal", () => {
  it("puts an ordinary change in the journal rather than rewriting the index", async () => {
    // The property the whole design exists for, asserted on the class the CLI
    // constructs rather than on the one core exports. Without this the journal
    // could go on passing its own tests while nothing shipped it.
    const { store, file, log } = cli();
    await store.save(state(1));
    const snapshot = await stat(file);
    await store.save(state(2));

    expect((await stat(file)).mtimeMs, "an ordinary pass rewrote the index").toBe(snapshot.mtimeMs);
    expect((await readFile(log, "utf8")).trimEnd().split("\n")).toHaveLength(1);
  });

  it("does the same in the plugin", async () => {
    const p = plugin();
    await p.store.save(state(1));
    const snapshot = p.adapter.text(p.file);
    await p.store.save(state(2));

    expect(p.adapter.text(p.file), "an ordinary pass rewrote the index").toBe(snapshot);
    expect(p.adapter.text(p.log)!.trimEnd().split("\n")).toHaveLength(1);
  });

  it("writes byte-identical journals from both shells for one sequence of changes", async () => {
    // One implementation is the whole reason a journal was chosen over a
    // database, and this is what keeps that claim honest: if either shell ever
    // grows its own idea of a record, these stop matching.
    const c = cli();
    const p = plugin();
    const passes = [state(1), state(2, 2), state(3, 3), state(4, 2), state(5, 2)];
    for (const s of passes) {
      await c.store.save(s);
      await p.store.save(s);
    }

    const fromCli = await readFile(c.log, "utf8");
    expect(fromCli, "the two shells wrote different journals").toBe(p.adapter.text(p.log));
    expect(fromCli.trimEnd().split("\n"), "nothing was journalled").toHaveLength(4);
  });

  it("writes nothing at all across many passes over a settled vault", async () => {
    // A settled vault passes on every watch tick and every keepalive. A
    // journal that grows while nothing happens is worse than the whole-file
    // write it replaced, because it grows for ever.
    const { store, file, log } = cli();
    await store.save(state(9, 20));
    const snapshot = await stat(file);
    const logged = await stat(log);

    for (let i = 0; i < 40; i++) await store.save(state(9, 20));
    expect((await stat(log)).size, "a settled vault kept journalling").toBe(logged.size);
    expect((await stat(file)).mtimeMs).toBe(snapshot.mtimeMs);
  });
});

/* ---------------------------------------------------------------- *
 * Migration
 * ---------------------------------------------------------------- */

describe("a vault holding today's index and no journal", () => {
  it("loads it unchanged, and does not lose its cursor", async () => {
    // The migration this design is shaped to avoid needing. A device that
    // re-derived its cursor here would re-scan and re-decide the whole vault
    // against the server on the first run after an upgrade.
    const file = join(root, "index.json");
    await writeFile(file, legacy(51, 3));

    const migrated = new JsonIndexStore(file, { log: () => undefined });
    expect(await migrated.load()).toEqual(state(51, 3));
  });

  it("loads it unchanged in the plugin too", async () => {
    const p = plugin();
    await p.adapter.write(p.file, legacy(51, 3));
    expect(await p.store.load()).toEqual(state(51, 3));
  });

  it("takes one snapshot to give it a sequence, then journals from there", async () => {
    // An index with no sequence cannot say which records it already holds, so
    // the first record beside it would line up with it by coincidence rather
    // than by construction. One whole-file write, once per device, buys the
    // binding; every pass after it is a record.
    const file = join(root, "index.json");
    await writeFile(file, legacy(51));
    const store = new JsonIndexStore(file, { log: () => undefined });
    await store.load();

    await store.save(state(52));
    expect(JSON.parse(await readFile(file, "utf8")).seq, "no sequence was established").toBe(0);
    expect(await readFile(indexLogPath(file), "utf8"), "the migrating save journalled").toBe("");

    await store.save(state(53));
    expect((await readFile(indexLogPath(file), "utf8")).trimEnd().split("\n")).toHaveLength(1);
    expect((await new JsonIndexStore(file, { log: () => undefined }).load())?.cursor).toBe(53);
  });

  it("writes nothing when the migrated index is already what the first pass produces", async () => {
    // The first pass over a settled vault after an upgrade. Rewriting here
    // would be the cost LastIndexWrite was added to remove, paid once by every
    // device that upgrades, for nothing.
    const file = join(root, "index.json");
    await writeFile(file, legacy(51, 5));
    const before = await stat(file);
    const store = new JsonIndexStore(file, { log: () => undefined });
    await store.load();
    await store.save(state(51, 5));
    expect((await stat(file)).mtimeMs, "an unchanged migrated index was rewritten").toBe(
      before.mtimeMs,
    );
  });
});

/* ---------------------------------------------------------------- *
 * The crash points, one at a time
 * ---------------------------------------------------------------- */

describe("a crash while a record was being appended", () => {
  it("raises when the append reported success it had not earned", async () => {
    // Rule 4, and the incident behind it: `adb push` returned 0 after writing
    // one file of four. An append that throws is a failure anybody can see; a
    // short one that returns is the damage this format cannot see for itself
    // later, because the next load discards the torn record and says nothing
    // about the pass that produced it. So the file is checked, not the call.
    const p = plugin();
    await p.store.save(state(1));
    p.adapter.shortAppendsSilently = 6;
    await expect(p.store.save(state(2))).rejects.toThrow(/did not land whole/);
  });

  it("leaves the records before an append that failed outright", async () => {
    const p = plugin();
    await p.store.save(state(1));
    await p.store.save(state(2));
    p.adapter.fault = (op, path) => (op === "append" && path === p.log ? 6 : undefined);
    await expect(p.store.save(state(3))).rejects.toThrow(/ENOSPC/);
    p.adapter.fault = undefined;

    const said: string[] = [];
    expect((await p.fresh(said).load())?.cursor, "a torn record was applied").toBe(2);
    expect(said.join(" ")).toMatch(/journal stops/);
  });

  it("keeps every record before the torn one, on a real file", async () => {
    const { store, file, log } = cli();
    await store.save(state(1));
    await store.save(state(2));
    await store.save(state(3));

    // What a crash mid-append leaves: a line with no newline on the end.
    const whole = await readFile(log, "utf8");
    await writeFile(log, whole + encodeRecord(9, { cursor: 99 }).slice(0, 14));

    const said: string[] = [];
    const after = new JsonIndexStore(file, { log: (m) => said.push(m) });
    expect((await after.load())?.cursor, "a torn record was applied").toBe(3);
    expect(said.join(" ")).toMatch(/journal stops.*torn/);
  });

  it("discards NUL padding, which some filesystems leave where a write never landed", async () => {
    const { store, file, log } = cli();
    await store.save(state(1));
    await store.save(state(7));
    await writeFile(log, (await readFile(log, "utf8")) + "\0".repeat(80) + "\n");

    const said: string[] = [];
    expect((await new JsonIndexStore(file, { log: (m) => said.push(m) }).load())?.cursor).toBe(7);
    expect(said.join(" ")).toMatch(/journal stops/);
  });
});

describe("a crash between publishing a snapshot and truncating the journal", () => {
  it("loads exactly the snapshot, and applies no record twice", async () => {
    // The window the safe ordering buys, and the reason records carry a
    // sequence. Reproduced by hand because the two writes are one method: the
    // snapshot is put back the way it was written and the log is put back the
    // way it was before the truncate.
    const { store, file, log } = cli();
    await store.save(state(1));
    const journalled = [state(2), state(3)];
    for (const s of journalled) await store.save(s);
    const records = await readFile(log, "utf8");

    // The snapshot the next save would publish, made durable, and then the
    // power goes before the truncate.
    await writeFile(file, JSON.stringify({ ...state(3), seq: 2 }));
    await writeFile(log, records);

    const said: string[] = [];
    const after = new JsonIndexStore(file, { log: (m) => said.push(m) });
    expect(await after.load()).toEqual(state(3));
    expect(said, "records already in the snapshot were reported as damage").toEqual([]);
  });

  it("still journals from there rather than starting the sequence again", async () => {
    const { store, file, log } = cli();
    await store.save(state(1));
    await store.save(state(2));
    const records = await readFile(log, "utf8");
    await writeFile(file, JSON.stringify({ ...state(2), seq: 1 }));
    await writeFile(log, records);

    const after = new JsonIndexStore(file, { log: () => undefined });
    await after.load();
    await after.save(state(3));
    // Sequence 2, not 1: reusing a number the log already holds is what
    // "out of order" means, and it would truncate the log at that point.
    expect((await readFile(log, "utf8")).trimEnd().split("\n").pop()).toMatch(/^2 /);
    expect((await new JsonIndexStore(file, { log: () => undefined }).load())?.cursor).toBe(3);
  });
});

describe("a snapshot this session could not finish", () => {
  it("does not then accuse something else of writing the index", async () => {
    // The half of the two-writer alarm that has to be right: an alarm that
    // fires on this session's own interrupted write is a true statement about
    // the wrong thing, and it is the fastest way to teach somebody to ignore
    // the message that matters.
    const p = plugin();
    const said: string[] = [];
    const store = new ObsidianIndexStore(p.adapter, p.file, {
      // A floor, so two ordinary passes journal rather than each outgrowing a
      // snapshot this small, and a cap of three so the next one folds them in.
      policy: { fractionOfSnapshot: 0.25, maxRecords: 3, minBytes: 4096 },
      log: (m) => said.push(m),
    });
    await store.save(state(1));
    await store.save(state(2));
    await store.save(state(3));
    expect(p.adapter.text(p.log)!.trimEnd().split("\n"), "nothing was journalled").toHaveLength(2);

    // The pass that folds the log in: the snapshot lands and the truncate
    // does not, which is the crash the safe ordering leaves behind.
    p.adapter.fault = (op, path) =>
      op === "write" && path === p.log ? new Error("EIO") : undefined;
    await expect(store.save(state(4))).rejects.toThrow(/EIO/);
    p.adapter.fault = undefined;

    said.length = 0;
    await store.save(state(5));
    expect(
      said.join(" "),
      "this session blamed its own interrupted write on somebody else",
    ).not.toMatch(/something else is writing/);
    expect(await p.fresh([]).load()).toEqual(state(5));
  });
});

describe("a crash during the snapshot itself", () => {
  it("leaves the old snapshot and its journal, so nothing is lost", async () => {
    // The snapshot is written by a rename onto the live file, so a crash
    // during it leaves the old bytes. What matters is that the journal is
    // still the one that belongs to those bytes: truncating first would have
    // left an older snapshot with the records that catch it up already gone.
    const { store, file, log } = cli();
    await store.save(state(1));
    await store.save(state(2));
    const before = { snapshot: await readFile(file, "utf8"), records: await readFile(log, "utf8") };

    // A power cut during the rename: neither file moved.
    const after = new JsonIndexStore(file, { log: () => undefined });
    expect((await after.load())?.cursor).toBe(2);
    expect(await readFile(file, "utf8")).toBe(before.snapshot);
    expect(await readFile(log, "utf8")).toBe(before.records);
  });

  it("reads the plugin's staged copy when the live snapshot was cut short", async () => {
    // The plugin cannot rename onto an occupied file, so it writes in place
    // and the staged copy is the only complete one. A journal beside a staged
    // copy is safe for the same reason it is safe beside the live file: the
    // staged copy holds the newer sequence, so its records are skipped rather
    // than applied twice.
    const p = plugin();
    const always = { policy: { fractionOfSnapshot: 0, maxRecords: 1, minBytes: 0 } };
    const forced = new ObsidianIndexStore(p.adapter, p.file, { ...always, log: () => undefined });
    await forced.save(state(1));
    p.adapter.fault = (op, path) => (op === "write" && path === p.file ? 5 : undefined);
    await expect(forced.save(state(2))).rejects.toThrow(/wrote 5 of/);
    p.adapter.fault = undefined;

    expect(await p.fresh().load()).toEqual(state(2));
  });
});

describe("a journal whose snapshot is gone", () => {
  it("refuses rather than inventing the base the records were written against", async () => {
    // Rule 2's shape for this file. Applying deltas to nothing produces a
    // state that never existed; ignoring them silently is the fallback to
    // empty that disabled every plugin on a device.
    const { store, file, log } = cli();
    await store.save(state(1));
    await store.save(state(2));
    await rm(file);

    await expect(new JsonIndexStore(file, { log: () => undefined }).load()).rejects.toThrow(
      /journal but no snapshot/,
    );
    expect((await readFile(log, "utf8")).length, "a refused load wrote something").toBeGreaterThan(
      0,
    );
  });

  it("is what unlink and rebase avoid by removing the journal first", async () => {
    // The order in cli/config.ts. A crash halfway through must leave a
    // snapshot with no journal, which loads without a word, and never a
    // journal with no snapshot, which does not load at all.
    const { store, file, log } = cli();
    await store.save(state(1));
    await store.save(state(2));
    await rm(log);

    expect((await new JsonIndexStore(file, { log: () => undefined }).load())?.cursor).toBe(1);
  });
});

describe("a snapshot that cannot say which records it holds", () => {
  it("is used alone, and the journal beside it is not applied", async () => {
    // A foreign write, an editor's idea of tidy, or a backup from before the
    // journal existed. Its sequence reads as zero, and a log starting at one
    // would line up with it by coincidence: a delta over a base it was never
    // computed from, which is the one outcome worse than an older index.
    const { store, file, log } = cli();
    await store.save(state(1));
    await store.save(state(2));
    await store.save(state(3));
    await writeFile(file, legacy(1)); // no seq, and older than the records

    const records = await readFile(log, "utf8");
    const said: string[] = [];
    const after = new JsonIndexStore(file, { log: (m) => said.push(m) });
    expect((await after.load())?.cursor, "a journal was applied to a foreign snapshot").toBe(1);
    expect(said.join(" ")).toMatch(/does not say which records it holds/);
    // Refusing to apply it is not the same as destroying it. A load that
    // removed the records would take the choice away from whoever comes to
    // look at why the two files disagree.
    expect(await readFile(log, "utf8"), "a load threw the journal away").toBe(records);
  });

  it("replaces the journal on the next save rather than appending to it", async () => {
    const { store, file, log } = cli();
    await store.save(state(1));
    await store.save(state(2));
    await writeFile(file, legacy(1));

    const after = new JsonIndexStore(file, { log: () => undefined });
    await after.load();
    await after.save(state(8));
    expect(await readFile(log, "utf8"), "a record was appended to a foreign journal").toBe("");
    expect((await new JsonIndexStore(file, { log: () => undefined }).load())?.cursor).toBe(8);
  });
});

describe("a journal that replays to something inconsistent", () => {
  it("falls back to the snapshot, which is older and consistent", async () => {
    // Older is safe. Self-inconsistent is not: a pending path with no remote
    // state is work that can never be done, and the engine refuses the whole
    // index over it.
    const { store, file, log } = cli();
    await store.save(state(1));
    const bad = encodeRecord(1, { pending: ["nowhere.md"] });
    await writeFile(log, bad);

    const said: string[] = [];
    const after = new JsonIndexStore(file, { log: (m) => said.push(m) });
    expect(await after.load(), "an inconsistent state was handed to the engine").toEqual(state(1));
    expect(said.join(" ")).toMatch(/cannot be trusted/);
  });
});

/* ---------------------------------------------------------------- *
 * Two writers
 * ---------------------------------------------------------------- */

describe("two writers on one index", () => {
  it("is caught the moment one of them finds the journal is not as it left it", async () => {
    // The CLI's lock governs and the plugin is one instance, so this should
    // not happen. "Should not happen" is how a whole journal of state goes
    // missing without a word, which is what interleaved sequences do: replay
    // stops at the collision and discards everything after it.
    const file = join(root, "index.json");
    const saidA: string[] = [];
    const saidB: string[] = [];
    const a = new JsonIndexStore(file, { log: (m) => saidA.push(m) });
    const b = new JsonIndexStore(file, { log: (m) => saidB.push(m) });

    await a.load();
    await a.save(state(1));
    await b.load(); // b starts from what a wrote, as a second process would
    await a.save(state(2));

    await b.save(state(3));
    expect(saidB.join(" "), "a second writer was not reported").toMatch(
      /something else is writing the index/,
    );
    expect(saidB.join(" "), "the person was not told what to do about it").toMatch(
      /stop one of them/,
    );
    // A whole snapshot, not a record: a snapshot is complete on its own and
    // cannot be a delta over somebody else's base.
    expect(await readFile(indexLogPath(file), "utf8")).toBe("");
    expect((await new JsonIndexStore(file, { log: () => undefined }).load())?.cursor).toBe(3);
  });

  it("catches the other direction too, when the snapshot is what moved", async () => {
    const file = join(root, "index.json");
    const saidA: string[] = [];
    const a = new JsonIndexStore(file, { log: (m) => saidA.push(m) });
    await a.load();
    await a.save(state(1));
    await a.save(state(2));

    // R3, in the shape a journal gives it. The whole-file store learned that
    // an index overwritten in place is still there; here the danger is larger,
    // because a record appended beside it would be this device's delta over
    // somebody else's base.
    await writeFile(file, JSON.stringify({ ...state(1, 4), seq: 400 }));
    await a.save(state(5));
    expect(saidA.join(" ")).toMatch(/index snapshot is not what this session wrote/);
    expect((await new JsonIndexStore(file, { log: () => undefined }).load())?.cursor).toBe(5);
  });

  it("stops at interleaved sequences rather than applying past them", async () => {
    // What a log two writers shared actually looks like: both number their
    // next record the same. Everything after the collision is discarded, which
    // is an older index and safe, and it is said out loud rather than left to
    // be noticed as a device that has forgotten a day.
    const file = join(root, "index.json");
    await writeFile(file, JSON.stringify({ ...state(1), seq: 0 }));
    await writeFile(
      indexLogPath(file),
      encodeRecord(1, { cursor: 2 }) + encodeRecord(1, { cursor: 300 }),
    );

    const said: string[] = [];
    const store = new JsonIndexStore(file, { log: (m) => said.push(m) });
    expect((await store.load())?.cursor, "a colliding record was applied").toBe(2);
    expect(said.join(" ")).toMatch(/journal stops.*out-of-order/);
  });

  it("writes again after an index that has gone from under the session", async () => {
    // R3's original case, which the whole-file store handles by writing rather
    // than skipping. Both files go, so the session cannot append onto a
    // journal whose snapshot is missing and strand the next start.
    const { store, file, log } = cli();
    await store.save(state(1));
    await store.save(state(2));
    await rm(file);
    await rm(log);

    await store.save(state(2));
    expect((await new JsonIndexStore(file, { log: () => undefined }).load())?.cursor).toBe(2);
  });

  it("writes again after a same-size overwrite that only the timestamp can see", async () => {
    const { store, file } = cli();
    await store.save(state(1));
    await store.save(state(2));

    const was = await readFile(file, "utf8");
    await writeFile(file, "!".repeat(was.length));
    const later = new Date(Date.now() + 2_000);
    await utimes(file, later, later);

    await store.save(state(2));
    expect((await new JsonIndexStore(file, { log: () => undefined }).load())?.cursor).toBe(2);
  });
});

/* ---------------------------------------------------------------- *
 * The snapshot policy
 * ---------------------------------------------------------------- */

describe("the snapshot policy, on a real shell", () => {
  it("folds the journal in and empties it, with the state unchanged across the boundary", async () => {
    const file = join(root, "index.json");
    const log = indexLogPath(file);
    // Small enough that the boundary is reached in a handful of passes, and
    // the policy rather than the constants is what is asserted.
    const store = new JsonIndexStore(file, {
      log: () => undefined,
      policy: { fractionOfSnapshot: 0.25, maxRecords: 1000, minBytes: 256 },
    });
    await store.save(state(1, 6));

    let snapshotted = 0;
    for (let cursor = 2; cursor < 30; cursor++) {
      const before = (await stat(file)).mtimeMs;
      await store.save(state(cursor, 6));
      if ((await stat(file)).mtimeMs !== before) {
        snapshotted++;
        expect(await readFile(log, "utf8"), "the journal outlived its snapshot").toBe("");
      }
      expect(
        (await new JsonIndexStore(file, { log: () => undefined }).load())?.cursor,
        "state was lost across the snapshot boundary",
      ).toBe(cursor);
    }
    expect(snapshotted, "the policy never fired").toBeGreaterThan(0);
    expect(snapshotted, "the policy fired on every pass, which is the old behaviour").toBeLessThan(
      10,
    );
  });
});
