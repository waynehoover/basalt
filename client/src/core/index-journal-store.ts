/**
 * The `IndexStore` the two shells share, written once over six file
 * primitives so that neither shell holds a copy of the crash semantics.
 *
 * `index-journal.ts` is the codec and this is the policy: when to append, when
 * to snapshot, and what to do with a log that cannot be trusted. Callers see
 * the same `load` and `save` they always did, and `load` hands back what it
 * found rather than a checked version of it, because the engine checks it
 * (`stored-state.ts`) and a store that refused first would replace a message
 * naming the bad field with one naming the file.
 *
 * The order that matters, and the only correct one: the snapshot is made
 * durable BEFORE the log is truncated. The other order can lose records. Its
 * cost is that a crash between the two leaves records already folded into the
 * snapshot, which is what the sequence numbers exist to make harmless.
 *
 * ## What binds a log to its snapshot
 *
 * A delta is only meaningful over the base it was computed against, so
 * applying one over a different base invents a state that never existed, which
 * is worse than any older index. Two things keep that from happening, and both
 * are needed:
 *
 *   - the sequence, which must continue the snapshot's exactly. An older
 *     snapshot restored under a newer log leaves a gap, and a newer one
 *     already holds the records.
 *   - the presence of `seq` at all. A snapshot written by anything other than
 *     this store has no sequence, so its `seq` reads as 0 and a log starting
 *     at 1 would line up with it by coincidence. That is exactly the shape of
 *     a foreign write, an editor's idea of tidy or a restored backup from
 *     before the journal existed, so a log is never applied to a snapshot that
 *     does not say which records it already holds.
 *
 * ## One writer
 *
 * A journal has the same single-writer requirement the whole-file index has,
 * and one failure the whole-file index does not: two writers number their
 * records independently, so their appends interleave into a log whose
 * sequences collide, and replay stops at the collision and silently drops
 * everything after it. The CLI's lock (cli/lock.ts) governs there and Obsidian
 * runs one plugin instance per vault, so this should not happen, and "should
 * not happen" is how a whole journal of state goes missing without a word.
 *
 * So both files are stamped after every write and checked before the next one.
 * A snapshot or a log that is not what this session left is somebody else's
 * write: it is said out loud, and the answer is a fresh snapshot rather than
 * an append, because a full snapshot is complete on its own and cannot be a
 * delta over the wrong base. That is last-writer-wins, which is exactly what
 * the whole-file store already did, and now it is audible.
 */

import {
  type JournalDelta,
  type SavedShape,
  type Snapshot,
  deltaFrom,
  encodeRecord,
  replay,
  shapeOf,
} from "./index-journal.ts";
import { validateStoredState } from "./stored-state.ts";
import type { IndexStamp, IndexStore, StoredState } from "./vault.ts";

/** Both files, as a stat sees them. Undefined where there is no file. */
export interface JournalStamps {
  readonly snapshot?: IndexStamp;
  readonly log?: IndexStamp;
}

/**
 * What a shell must provide. Deliberately small: everything hard is above it.
 *
 * `appendLog` must place bytes at the end of the log and nowhere else, and
 * `stamps` must answer what is really there, because the append is checked
 * against it rather than against the call returning (rule 4), and because it
 * is the only way this store can tell that something else has written.
 */
export interface JournalFiles {
  readSnapshot(): Promise<string | undefined>;
  /** Durably, and atomically as far as the platform allows. */
  writeSnapshot(text: string): Promise<void>;
  readLog(): Promise<string | undefined>;
  appendLog(line: string): Promise<void>;
  /** Leaves an empty log present, not an absent one: the two must stay distinct. */
  truncateLog(): Promise<void>;
  stamps(): Promise<JournalStamps>;
}

/** When a log has earned a fresh snapshot. */
export interface SnapshotPolicy {
  /** Of the snapshot's own size. Measured; see docs/compared.md. */
  readonly fractionOfSnapshot: number;
  readonly maxRecords: number;
  /**
   * Below this the log is left alone whatever the fraction says.
   *
   * Without it a small vault snapshots on every single pass and the journal
   * buys nothing: a new vault's snapshot is a few dozen bytes, a quarter of
   * that is a dozen, and one record is larger than that. Found by the test
   * "appends what changed and does not rewrite the snapshot", which is exactly
   * the property the whole design exists for.
   */
  readonly minBytes: number;
}

/**
 * The policy, measured rather than guessed.
 *
 * The spec proposed a quarter of the snapshot, 1000 records and a 64 KiB floor
 * and said all three were guesses. `bun run src/stress/journal.ts` measures
 * them; the figures are in docs/compared.md with the corpus. All three stay,
 * and the useful thing the measurement produced is knowing which one governs
 * where, because they turned out to bind at three different vault sizes:
 *
 *   - **40 notes, the floor.** A new vault's index is 20 KB, a quarter of that
 *     is 5 KB, and one record is 700 bytes: without a floor it rewrites the
 *     whole index every seventh pass, 22 times in 200 passes. With 64 KiB it
 *     does it twice, and the log it carries instead replays in 2 ms.
 *   - **1,000 notes, the fraction.** A 0.5 MiB index caps the log at 128 KiB,
 *     which is about 200 passes of editing. Load pays for it at 33 KiB/ms of
 *     replay, so 4 ms against the 5 ms it costs to read and parse the snapshot
 *     itself. That is the shape the fraction is for: the log's cost stays
 *     proportional to the snapshot's.
 *   - **10,000 notes, the record count.** A quarter of a 5 MiB index is
 *     1.3 MiB, some 3,200 passes away, so the cap fires first and is the
 *     better bound of the two: it holds the log at 380 KiB and replay at 12 ms
 *     whatever the vault weighs.
 *
 * Moving any of them is flat in this region. Halving the cap halves 12 ms of
 * replay and doubles the number of 13 ms snapshots, which is a wash, and the
 * fraction at 10% or 25% is 16 ms against 39 ms of worst-case replay on a
 * vault that snapshots once every few thousand passes either way. So the
 * numbers are kept, and they are kept because they were measured rather than
 * because they were written down first.
 */
export const DEFAULT_POLICY: SnapshotPolicy = {
  fractionOfSnapshot: 0.25,
  maxRecords: 1000,
  minBytes: 64 * 1024,
};

/** Whether the log has outgrown the snapshot it hangs off. */
export function wantsSnapshot(
  logBytes: number,
  snapshotBytes: number,
  records: number,
  policy: SnapshotPolicy = DEFAULT_POLICY,
): boolean {
  if (records >= policy.maxRecords) return true;
  if (logBytes < policy.minBytes) return false;
  // A snapshot of nothing has no size to be a fraction of, so the record count
  // and the floor are the only bounds on an empty vault.
  if (snapshotBytes <= 0) return false;
  return logBytes > snapshotBytes * policy.fractionOfSnapshot;
}

/** The log that belongs beside an index file. */
export function indexLogPath(indexFile: string): string {
  return indexFile.replace(/\.json$/i, "") + ".log";
}

/** What the snapshot file holds: today's state, plus the sequence it includes. */
interface SnapshotFile {
  readonly seq?: number;
  readonly [key: string]: unknown;
}

export interface JournalStoreOptions {
  readonly policy?: SnapshotPolicy;
  readonly log?: (message: string, ...rest: unknown[]) => void;
}

export class JournalIndexStore implements IndexStore {
  private readonly files: JournalFiles;
  private readonly policy: SnapshotPolicy;
  private readonly say: (message: string, ...rest: unknown[]) => void;

  /** The state as last written, so a pass that changed nothing writes nothing. */
  private saved: SavedShape | undefined;
  private seq = 0;
  private snapshotBytes = 0;
  private records = 0;
  /** How both files looked after this session last wrote them, or on load. */
  private left: JournalStamps = {};
  /**
   * Whether the next save must be a whole snapshot rather than a record.
   *
   * Set when the snapshot on disk carries no sequence, which is every index
   * written before this journal existed. One whole-file write per device, once,
   * establishes the sequence the log hangs off; without it the first records
   * would be appended beside a snapshot that cannot say it does not hold them,
   * and the load after a crash would have to throw them away.
   */
  private mustSnapshot = false;

  constructor(files: JournalFiles, opts: JournalStoreOptions = {}) {
    this.files = files;
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.say = opts.log ?? (() => undefined);
  }

  async load(): Promise<StoredState | undefined> {
    const snapshotText = await this.files.readSnapshot();
    const logText = await this.files.readLog();
    this.left = await this.files.stamps();

    if (snapshotText === undefined) {
      // No snapshot. A log without one is a delta against a base that is not
      // there: applying it would invent a state that never existed, and
      // ignoring it silently would be rule 2. Say so and stop.
      if (logText !== undefined && logText !== "") {
        throw new Error(
          "the index has a journal but no snapshot to apply it to, so it cannot be trusted. " +
            "Remove the journal to start from the server instead.",
        );
      }
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(snapshotText);
    } catch (err) {
      // Rule 2, and the incident behind it: code that read a config file, fell
      // back to an empty result on error and wrote that back disabled every
      // plugin on a device.
      throw new Error(
        `the index snapshot is not valid JSON, so it cannot be trusted: ${(err as Error).message}`,
      );
    }

    const seq = sequenceOf(parsed);
    const snapshotState = withoutSeq(parsed);
    // The text that was read, not the file it came from: the plugin can hand
    // back a staged copy when the live one was cut short, and sizing the
    // policy off the truncated file would fold the log in too eagerly.
    this.snapshotBytes = byteLength(snapshotText);

    if (logText === undefined || logText === "") {
      this.settle(snapshotState, seq ?? 0, 0);
      this.mustSnapshot = seq === undefined;
      return snapshotState;
    }

    if (seq === undefined) {
      // A snapshot with no sequence beside a log with records in it. Either
      // the snapshot predates the journal and the log is somebody else's, or
      // something rewrote the snapshot under a live session. Applying the log
      // would line record 1 up against a base it was never computed from.
      this.say(
        "the index journal sits beside a snapshot that does not say which records it holds, " +
          "so something other than this client wrote one of them. Using the snapshot alone, " +
          "which is older and consistent; the journal will be replaced on the next save.",
      );
      this.settle(snapshotState, 0, 0);
      this.mustSnapshot = true;
      return snapshotState;
    }

    const snapshot: Snapshot = { state: snapshotState, seq };
    let out: ReturnType<typeof replay>;
    try {
      out = replay(snapshot, logText);
    } catch (err) {
      // Replay is total over damaged records and not over a snapshot that is
      // not a state at all. Older is safe; a crash here would leave a device
      // unable to start over an index it could simply have ignored.
      this.say(`the index journal could not be replayed (${err}); using the snapshot alone.`);
      this.settle(snapshotState, seq, 0);
      this.mustSnapshot = true;
      return snapshotState;
    }

    if (out.stopped.why !== "end") {
      this.say(
        `the index journal stops at record ${out.stopped.at ?? 0} (${out.stopped.why}); ` +
          `${out.applied} of its records were applied. An older index is safe: ` +
          "anything past that point is work this device will do again.",
      );
    }

    // A replayed state that does not validate is not older, it is
    // inconsistent. The snapshot alone is older, and older is safe. Only when
    // the snapshot itself is sound, though: when neither is, the replayed one
    // is handed on so the engine's refusal names the field that is wrong.
    if (!checks(out.state) && checks(snapshotState)) {
      this.say(
        "the index journal replayed to a state that cannot be trusted; falling back to the " +
          "snapshot, which is older and consistent.",
      );
      this.settle(snapshotState, seq, 0);
      this.mustSnapshot = true;
      return snapshotState;
    }

    this.settle(out.state, out.seq, out.applied);
    return out.state;
  }

  async save(state: StoredState): Promise<void> {
    const stamps = await this.files.stamps();
    const foreign = this.foreignWrite(stamps);

    // A settled vault passes on every watch tick and every keepalive, and must
    // write nothing at all. Today's whole-file store learned this twice.
    if (this.saved !== undefined && foreign === undefined) {
      const { delta, shape } = deltaFrom(this.saved, state);
      if (delta === undefined) return;
      if (
        !this.mustSnapshot &&
        !wantsSnapshot(stamps.log?.size ?? 0, this.snapshotBytes, this.records + 1, this.policy)
      ) {
        await this.append(delta, shape, stamps.log?.size ?? 0);
        return;
      }
    }

    if (foreign !== undefined) {
      // R3, in the shape a journal gives it. The whole-file store found that
      // an index overwritten in place is still there, and went on skipping it
      // for the rest of the session. Here the danger is larger: appending a
      // record beside a snapshot somebody else wrote would put this device's
      // delta over their base. A whole snapshot cannot do that.
      this.say(
        `${foreign} is not what this session wrote, so something else is writing the index. ` +
          "Replacing both with a fresh snapshot, which is complete on its own. " +
          "If two clients share this vault, stop one of them: their indexes will keep " +
          "overwriting each other.",
      );
    }
    await this.snapshot(state);
  }

  /** Which file moved under this session, or undefined while both are ours. */
  private foreignWrite(now: JournalStamps): string | undefined {
    if (this.saved === undefined) return undefined; // nothing written yet to compare against
    if (!same(this.left.snapshot, now.snapshot)) return "the index snapshot";
    if (!same(this.left.log, now.log)) return "the index journal";
    return undefined;
  }

  private async append(delta: JournalDelta, shape: SavedShape, before: number): Promise<void> {
    const line = encodeRecord(this.seq + 1, delta);
    await this.files.appendLog(line);
    // Rule 4: the call returning is not the outcome. A short append is a
    // record that will be discarded on the next load, silently, which is the
    // one failure this format cannot see for itself.
    const stamps = await this.files.stamps();
    const wrote = (stamps.log?.size ?? 0) - before;
    if (wrote !== byteLength(line)) {
      throw new Error(
        `the index journal grew by ${wrote} bytes for a ${byteLength(line)} byte record, ` +
          "so the append did not land whole",
      );
    }
    this.seq++;
    this.records++;
    this.saved = shape;
    this.left = stamps;
  }

  /**
   * A fresh snapshot, then an empty log, in that order and never the other.
   *
   * Truncating first would leave a window where the records are gone and the
   * snapshot that replaces them is not yet durable.
   */
  private async snapshot(state: StoredState): Promise<void> {
    const text = JSON.stringify({ ...state, seq: this.seq });
    try {
      await this.files.writeSnapshot(text);
      this.snapshotBytes = byteLength(text);
      await this.files.truncateLog();
      this.records = 0;
      this.mustSnapshot = false;
      // Only after both are durable. Recording it first would have the next
      // save skip a write that a failed one still owes.
      this.saved = shapeOf(state);
    } catch (err) {
      // A snapshot that failed still owes a snapshot. Without this the next
      // pass would append a record beside a file that may be half written,
      // which is a delta over a base that is not there.
      this.mustSnapshot = true;
      throw err;
    } finally {
      // Whatever happened, what is on disk now is the baseline the next save
      // compares against. Leaving it stale after a failure would have this
      // session report its own half-finished write as somebody else's, which
      // is a true alarm about the wrong thing and the fastest way to teach
      // somebody to ignore it.
      this.left = await this.files.stamps().catch(() => ({}));
    }
  }

  private settle(state: StoredState, seq: number, records: number): void {
    this.saved = shapeOf(state);
    this.seq = seq;
    this.records = records;
    this.mustSnapshot = false;
  }
}

/** The snapshot's own bookkeeping is not part of the state it holds. */
function withoutSeq(parsed: unknown): StoredState {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // Not a state at all. Handed on as it is, so the engine's refusal names
    // what is actually wrong with it rather than this store guessing.
    return parsed as StoredState;
  }
  const { seq: _seq, ...rest } = parsed as SnapshotFile;
  return rest as unknown as StoredState;
}

/** The sequence the snapshot says it holds, or undefined if it does not say. */
function sequenceOf(parsed: unknown): number | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const seq = (parsed as SnapshotFile).seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;
}

/** Whether a state would survive the check the engine makes of it. */
function checks(state: StoredState): boolean {
  try {
    return validateStoredState(state) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Whether a file is the one that was left there.
 *
 * Size and modification time, the same two `LastIndexWrite` uses and for the
 * same reason: reading the file back on every pass is the cost this design
 * exists to avoid. The residual is the same one too, stated rather than
 * hidden: an overwrite of exactly the same length inside one modification-time
 * tick is invisible here.
 */
function same(a: IndexStamp | undefined, b: IndexStamp | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.size === b.size && a.mtime === b.mtime;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
