/**
 * The `IndexStore` the two shells share, written once over five file
 * primitives so that neither shell holds a copy of the crash semantics.
 *
 * `index-journal.ts` is the codec and this is the policy: when to append, when
 * to snapshot, and what to do with a log that cannot be trusted. Callers see
 * the same `load` and `save` they always did.
 *
 * The order that matters, and the only correct one: the snapshot is made
 * durable BEFORE the log is truncated. The other order can lose records. Its
 * cost is that a crash between the two leaves records already folded into the
 * snapshot, which is what the sequence numbers exist to make harmless.
 */

import {
  type JournalDelta,
  type Snapshot,
  deltaBetween,
  encodeRecord,
  replay,
} from "./index-journal.ts";
import { validateStoredState } from "./stored-state.ts";
import type { IndexStore, StoredState } from "./vault.ts";

/**
 * What a shell must provide. Deliberately small: everything hard is above it.
 *
 * `appendLog` must place bytes at the end of the log and nowhere else, and
 * `logBytes` must answer what is really there, because the append is checked
 * against it rather than against the call returning (rule 4).
 */
export interface JournalFiles {
  readSnapshot(): Promise<string | undefined>;
  /** Durably, and atomically as far as the platform allows. */
  writeSnapshot(text: string): Promise<void>;
  readLog(): Promise<string | undefined>;
  appendLog(line: string): Promise<void>;
  /** Leaves an empty log present, not an absent one: the two must stay distinct. */
  truncateLog(): Promise<void>;
  logBytes(): Promise<number>;
}

/** When a log has earned a fresh snapshot. */
export interface SnapshotPolicy {
  /** Of the snapshot's own size. A guess until measured; see the spec. */
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
  private saved: StoredState | undefined;
  private seq = 0;
  private snapshotBytes = 0;
  private records = 0;

  constructor(files: JournalFiles, opts: JournalStoreOptions = {}) {
    this.files = files;
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.say = opts.log ?? (() => undefined);
  }

  async load(): Promise<StoredState | undefined> {
    const snapshotText = await this.files.readSnapshot();
    const logText = await this.files.readLog();

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

    let parsed: SnapshotFile;
    try {
      parsed = JSON.parse(snapshotText) as SnapshotFile;
    } catch (err) {
      // Rule 2, and the incident behind it: code that read a config file, fell
      // back to an empty result on error and wrote that back disabled every
      // plugin on a device.
      throw new Error(`the index snapshot is not valid JSON, so it cannot be trusted: ${err}`);
    }
    const snapshotState = validateStoredState(stripSeq(parsed));
    if (snapshotState === undefined) return undefined;

    const seq = typeof parsed.seq === "number" && Number.isSafeInteger(parsed.seq) ? parsed.seq : 0;
    const snapshot: Snapshot = { state: snapshotState, seq };
    this.snapshotBytes = snapshotText.length;

    if (logText === undefined || logText === "") {
      this.settle(snapshotState, seq, 0);
      return snapshotState;
    }

    const out = replay(snapshot, logText);
    if (out.stopped.why !== "end") {
      this.say(
        `the index journal stops at record ${out.stopped.at ?? 0} (${out.stopped.why}); ` +
          `${out.applied} of its records were applied. An older index is safe: ` +
          "anything past that point is work this device will do again.",
      );
    }

    // A replayed state that does not validate is not older, it is
    // inconsistent. The snapshot alone is older, and older is safe.
    let state: StoredState;
    try {
      state = validateStoredState(out.state) ?? snapshotState;
      this.settle(state, out.seq, out.applied);
    } catch (err) {
      this.say(
        `the index journal replayed to a state that cannot be trusted (${err}); ` +
          "falling back to the snapshot, which is older and consistent.",
      );
      state = snapshotState;
      this.settle(state, seq, 0);
    }
    return state;
  }

  async save(state: StoredState): Promise<void> {
    // A settled vault passes on every watch tick and every keepalive, and must
    // write nothing at all. Today's whole-file store learned this twice.
    if (this.saved === undefined) {
      await this.snapshot(state);
      return;
    }
    const delta = deltaBetween(this.saved, state);
    if (delta === undefined) return;

    if (
      wantsSnapshot(await this.files.logBytes(), this.snapshotBytes, this.records + 1, this.policy)
    ) {
      await this.snapshot(state);
      return;
    }
    await this.append(delta, state);
  }

  private async append(delta: JournalDelta, state: StoredState): Promise<void> {
    const line = encodeRecord(this.seq + 1, delta);
    const before = await this.files.logBytes();
    await this.files.appendLog(line);
    // Rule 4: the call returning is not the outcome. A short append is a
    // record that will be discarded on the next load, silently, which is the
    // one failure this format cannot see for itself.
    const after = await this.files.logBytes();
    const wrote = after - before;
    if (wrote !== byteLength(line)) {
      throw new Error(
        `the index journal grew by ${wrote} bytes for a ${byteLength(line)} byte record, ` +
          "so the append did not land whole",
      );
    }
    this.seq++;
    this.records++;
    this.saved = clone(state);
  }

  /**
   * A fresh snapshot, then an empty log, in that order and never the other.
   *
   * Truncating first would leave a window where the records are gone and the
   * snapshot that replaces them is not yet durable.
   */
  private async snapshot(state: StoredState): Promise<void> {
    const seq = this.seq;
    const text = JSON.stringify({ ...state, seq });
    await this.files.writeSnapshot(text);
    await this.files.truncateLog();
    this.snapshotBytes = text.length;
    this.records = 0;
    this.saved = clone(state);
  }

  private settle(state: StoredState, seq: number, records: number): void {
    this.saved = clone(state);
    this.seq = seq;
    this.records = records;
  }
}

/** The snapshot's own bookkeeping is not part of the state it holds. */
function stripSeq(file: SnapshotFile): unknown {
  const { seq: _seq, ...rest } = file;
  return rest;
}

function clone(state: StoredState): StoredState {
  return JSON.parse(JSON.stringify(state)) as StoredState;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
