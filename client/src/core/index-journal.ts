/**
 * The index as a snapshot plus a journal of what changed since.
 *
 * This file is the codec and the replay, and nothing else: no files, no
 * adapters, no clock. The crash semantics are the whole point of the design
 * (see index-journal-spec.md), and they are cheapest to pin where there is no
 * I/O to arrange, so they are pinned here.
 *
 * ## The invariant this rests on
 *
 * From plugin/vault.ts, on preferring the live index to a staged copy: "an
 * older index is always safe, because notes are durable before the index that
 * names them". That is what makes a journal viable at all. Losing the tail of
 * the index is not losing data, it is redoing work: the engine rescans and
 * reapplies from an older cursor. So every ambiguous case below falls back to
 * something older. Never to something empty, which is rule 2 and the incident
 * behind it, and never to something guessed.
 *
 * ## Why records carry a sequence
 *
 * A snapshot is made durable before the journal is truncated, in that order,
 * because the other order can lose records. The cost of the safe order is that
 * a crash between the two leaves records already folded into the snapshot. The
 * sequence makes that window exact: on replay, anything at or below the
 * snapshot's sequence is skipped. Without it the design would lean on every
 * record being idempotent, which is true today and would stay true only by
 * everyone remembering.
 *
 * ## Why absolute values, never increments
 *
 * A record says "cursor is 51", never "cursor advanced by one". Replaying a
 * record twice then equals replaying it once, so the sequence check has a
 * correct answer to fall back on rather than a corrupt one.
 */

import { crc32 } from "./crc32.ts";
import type { StoredState } from "./vault.ts";

/** A snapshot and the sequence of the last record folded into it. */
export interface Snapshot {
  readonly state: StoredState;
  readonly seq: number;
}

/**
 * What one pass changed.
 *
 * `entries` and `remote` travel as set-and-delete because they are the large
 * ones and a pass touches few of them. `pending` travels whole because it is
 * small and its order carries meaning.
 */
export interface JournalDelta {
  readonly cursor?: number;
  readonly set?: Record<string, unknown>;
  readonly del?: readonly string[];
  readonly remote?: Record<string, unknown>;
  readonly unremote?: readonly string[];
  readonly pending?: readonly string[];
}

/** Why a single line could not be trusted, with no idea where it sat. */
export type DecodeFailure = { readonly why: "torn" | "checksum" | "unparsable" };

/** Why replay stopped before the end of the log. `at` indexes the record. */
export type ReplayStop =
  | { readonly why: "end"; readonly at?: undefined }
  | { readonly why: "torn"; readonly at: number }
  | { readonly why: "checksum"; readonly at: number }
  | { readonly why: "unparsable"; readonly at: number }
  | { readonly why: "out-of-order"; readonly at: number; readonly seq: number }
  | { readonly why: "gap"; readonly at: number; readonly seq: number; readonly after: number };

export interface Replayed {
  readonly state: StoredState;
  /** The sequence of the last record applied, or the snapshot's if none was. */
  readonly seq: number;
  readonly applied: number;
  readonly stopped: ReplayStop;
}

const encoder = new TextEncoder();

/**
 * One record, as the line that goes on the end of the log.
 *
 * `<seq> <crc32 hex> <json>\n`. The checksum covers the JSON text alone, so a
 * record can be checked without trusting the part of the line that says how
 * long it is.
 */
export function encodeRecord(seq: number, delta: JournalDelta): string {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error(`a journal sequence must be a positive integer, not ${seq}`);
  }
  const json = JSON.stringify(delta);
  const sum = crc32(encoder.encode(json)).toString(16).padStart(8, "0");
  return `${seq} ${sum} ${json}\n`;
}

/**
 * One line back into a record, or undefined if the line cannot be trusted.
 *
 * Undefined covers every way a crash damages a line, and the caller treats
 * them the same way: stop here, keep everything before. They are told apart
 * only so the log can say which happened.
 */
export function decodeRecord(line: string): { seq: number; delta: JournalDelta } | DecodeFailure {
  // A crash can leave NUL padding where the file was extended but not written.
  // It is not whitespace and it does not parse, but it is worth naming,
  // because a reader that trimmed it would turn a torn record into a silent
  // empty one.
  if (line.includes("\0")) return { why: "torn" };
  const firstGap = line.indexOf(" ");
  const secondGap = line.indexOf(" ", firstGap + 1);
  if (firstGap < 1 || secondGap < 0) return { why: "unparsable" };

  const seq = Number(line.slice(0, firstGap));
  if (!Number.isSafeInteger(seq) || seq < 1) return { why: "unparsable" };

  const sum = line.slice(firstGap + 1, secondGap);
  const json = line.slice(secondGap + 1);
  if (!/^[0-9a-f]{8}$/.test(sum)) return { why: "unparsable" };
  if (crc32(encoder.encode(json)).toString(16).padStart(8, "0") !== sum) {
    return { why: "checksum" };
  }

  let delta: unknown;
  try {
    delta = JSON.parse(json);
  } catch {
    // Only reachable if the checksum matched a body that is not JSON, which
    // means the record was written wrong rather than damaged. Same answer.
    return { why: "unparsable" };
  }
  if (delta === null || typeof delta !== "object" || Array.isArray(delta)) {
    return { why: "unparsable" };
  }
  return { seq, delta: delta as JournalDelta };
}

/** Whether decodeRecord answered with a record or with a reason it could not. */
function isFailure(x: { seq: number } | DecodeFailure): x is DecodeFailure {
  return (x as DecodeFailure).why !== undefined;
}

/**
 * The snapshot with the journal folded into it, as far as the journal is good.
 *
 * Stops at the first record it cannot trust and keeps everything before it. A
 * torn tail and damage in the middle cannot be told apart and do not need to
 * be: truncating at the first bad record yields an older index either way, and
 * an older index is safe.
 *
 * A record whose sequence is not greater than the last one applied is skipped
 * when it is at or below the snapshot's (already folded in, the crash window
 * between publishing a snapshot and truncating the log) and stops the replay
 * when it goes backwards inside the log itself, which a correct writer cannot
 * produce.
 */
export function replay(snapshot: Snapshot, log: string): Replayed {
  let state = snapshot.state;
  let seq = snapshot.seq;
  let applied = 0;
  let stopped: ReplayStop = { why: "end" };
  let firstKept = true;

  // Only whole lines. A final fragment with no newline is exactly what a crash
  // mid-append leaves, and it is the case this format exists to make obvious.
  const lines = log.split("\n");
  const complete = lines.slice(0, -1);
  const trailing = lines[lines.length - 1] ?? "";

  for (let i = 0; i < complete.length; i++) {
    const line = complete[i]!;
    if (line === "") {
      stopped = { why: "torn", at: i };
      break;
    }
    const read = decodeRecord(line);
    if (isFailure(read)) {
      stopped = { why: read.why, at: i };
      break;
    }
    if (read.seq <= snapshot.seq) continue; // already in the snapshot
    if (read.seq <= seq) {
      stopped = { why: "out-of-order", at: i, seq: read.seq };
      break;
    }
    // The first record kept must continue the snapshot. A jump means records
    // between the two are gone, and a delta applied over a base it was not
    // written against invents a state that never existed.
    if (firstKept && read.seq !== snapshot.seq + 1) {
      stopped = { why: "gap", at: i, seq: read.seq, after: snapshot.seq };
      break;
    }
    firstKept = false;
    state = applyDelta(state, read.delta);
    seq = read.seq;
    applied++;
  }

  if (stopped.why === "end" && trailing !== "") stopped = { why: "torn", at: complete.length };
  return { state, seq, applied, stopped };
}

/** One delta over one state, giving a new state and touching neither argument. */
export function applyDelta(state: StoredState, delta: JournalDelta): StoredState {
  const entries = { ...state.entries };
  for (const [path, entry] of Object.entries(delta.set ?? {})) entries[path] = entry;
  for (const path of delta.del ?? []) delete entries[path];

  const remote = { ...state.remote };
  for (const [path, value] of Object.entries(delta.remote ?? {})) remote[path] = value;
  for (const path of delta.unremote ?? []) delete remote[path];

  return {
    cursor: delta.cursor ?? state.cursor,
    entries,
    remote,
    pending: delta.pending === undefined ? state.pending : [...delta.pending],
    // A snapshot carries its own sequence; a replayed state does not need one.
  } as StoredState;
}

/**
 * What changed between two states, or undefined when nothing did.
 *
 * Undefined is the common answer and the one that matters: a settled vault
 * passes on every watch tick and must write nothing at all. Today's
 * LastIndexWrite exists for the same reason and found the same thing twice.
 *
 * Compared by serialising each entry rather than by identity, because the
 * engine mutates entries in place (see index-state.ts `observe`), so identity
 * says nothing. A later step can have the engine hand down what it touched and
 * skip this walk; the format does not change if it does.
 */
export function deltaBetween(prev: StoredState, next: StoredState): JournalDelta | undefined {
  const delta: {
    cursor?: number;
    set?: Record<string, unknown>;
    del?: string[];
    remote?: Record<string, unknown>;
    unremote?: string[];
    pending?: string[];
  } = {};

  if (prev.cursor !== next.cursor) delta.cursor = next.cursor;

  const changed = (
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): { set: Record<string, unknown>; del: string[] } => {
    const set: Record<string, unknown> = {};
    const del: string[] = [];
    for (const [path, value] of Object.entries(after)) {
      const was = Object.hasOwn(before, path) ? before[path] : undefined;
      if (was === undefined || JSON.stringify(was) !== JSON.stringify(value)) set[path] = value;
    }
    for (const path of Object.keys(before)) if (!Object.hasOwn(after, path)) del.push(path);
    return { set, del };
  };

  const e = changed(prev.entries, next.entries);
  if (Object.keys(e.set).length > 0) delta.set = e.set;
  if (e.del.length > 0) delta.del = e.del;

  const r = changed(prev.remote, next.remote);
  if (Object.keys(r.set).length > 0) delta.remote = r.set;
  if (r.del.length > 0) delta.unremote = r.del;

  const samePending =
    prev.pending.length === next.pending.length &&
    prev.pending.every((p, i) => p === next.pending[i]);
  if (!samePending) delta.pending = [...next.pending];

  return Object.keys(delta).length === 0 ? undefined : delta;
}
