/**
 * What a saved index has to look like before the engine will believe it.
 *
 * Both index stores handed back whatever JSON they found, and `Engine.start`
 * then spread it into entries and remote states through casts. A file that was
 * valid JSON and nothing else, an index from a future version with a field
 * renamed, or one corrupted in a way that kept the braces balanced, all became
 * engine state: a cursor of `null` read as zero and re-downloaded the vault, a
 * pending list of numbers threw somewhere far from here, and an entry with a
 * hash but no chunks read as a file already synced.
 *
 * So the whole shape is checked, field by field, before anything changes. A
 * refusal names the field, because "the index is corrupt" is not something a
 * person can act on, and says what to do, because the answer is always the
 * same: the index is a cache of what the server and the disk agree on, and
 * both still exist.
 */

import type { StoredState } from "./vault.ts";

/** How to get out of a refused index. Always the same, so said once. */
const RECOVERY =
  "Remove the index and sync again: it is rebuilt from the vault and the server, and nothing is lost.";

/**
 * Returns the state if it is usable, and throws naming the first thing wrong.
 *
 * `undefined` passes through: a device that has never synced has no index and
 * that is a valid state, not a broken one.
 */
export function validateStoredState(raw: unknown, where = "the index"): StoredState | undefined {
  if (raw === undefined) return undefined;
  const refuse = (what: string): Error =>
    new Error(`${where} cannot be trusted: ${what}. ${RECOVERY}`);
  if (!isObject(raw)) throw refuse("it is not an object");

  const cursor = raw["cursor"];
  if (!isCount(cursor)) throw refuse(`cursor is ${describe(cursor)}, not a non-negative integer`);

  const entries = raw["entries"];
  if (!isObject(entries)) throw refuse("entries is not an object");
  for (const [path, entry] of Object.entries(entries)) {
    checkEntry(path, entry, refuse);
  }

  const remote = raw["remote"];
  if (!isObject(remote)) throw refuse("remote is not an object");
  for (const [path, state] of Object.entries(remote)) {
    checkRemote(path, state, refuse);
  }

  const pending = raw["pending"];
  if (!Array.isArray(pending)) throw refuse("pending is not a list");
  pending.forEach((p, i) => {
    if (!isPath(p)) throw refuse(`pending[${i}] is ${describe(p)}, not a path`);
  });

  // Cross-field: the remote index is what pending refers to, and a pending
  // path with no remote state is work that can never be done.
  for (const p of pending as string[]) {
    if (!(p in remote)) {
      throw refuse(`pending names ${JSON.stringify(p)}, which remote does not hold`);
    }
  }

  return { cursor, entries, remote, pending: pending as string[] };
}

function checkEntry(path: string, entry: unknown, refuse: (what: string) => Error): void {
  const at = `entries[${JSON.stringify(path)}]`;
  if (!isPath(path)) throw refuse(`${at} has a key that is not a path`);
  if (!isObject(entry)) throw refuse(`${at} is not an object`);
  if ("path" in entry && entry["path"] !== path) {
    throw refuse(`${at}.path is ${describe(entry["path"])}, which is not its key`);
  }
  for (const field of ["ctime", "mtime", "size", "syncuid", "synctime"]) {
    if (field in entry && !isCount(entry[field])) {
      throw refuse(`${at}.${field} is ${describe(entry[field])}, not a non-negative integer`);
    }
  }
  if ("folder" in entry && typeof entry["folder"] !== "boolean") {
    throw refuse(`${at}.folder is ${describe(entry["folder"])}, not a boolean`);
  }
  for (const field of ["hash", "synchash", "prev"]) {
    if (field in entry && typeof entry[field] !== "string") {
      throw refuse(`${at}.${field} is ${describe(entry[field])}, not a string`);
    }
  }
  if ("chunks" in entry) {
    const chunks = entry["chunks"];
    if (!Array.isArray(chunks) || !chunks.every(isChunkName)) {
      throw refuse(`${at}.chunks is not a list of chunk names`);
    }
  }
  // A synced file names the chunks that make it. An entry claiming a sync
  // with a content hash and no chunk list is one whose content this device
  // cannot produce or compare, and it would read as already synced.
  const synchash = entry["synchash"];
  const chunks = entry["chunks"];
  if (
    typeof synchash === "string" &&
    synchash !== "" &&
    synchash !== "-empty-" &&
    entry["folder"] !== true &&
    Array.isArray(chunks) &&
    chunks.length === 0 &&
    entry["hash"] === synchash
  ) {
    throw refuse(`${at} says it is synced as ${synchash.slice(0, 16)}... but names no chunks`);
  }
}

function checkRemote(path: string, state: unknown, refuse: (what: string) => Error): void {
  const at = `remote[${JSON.stringify(path)}]`;
  if (!isPath(path)) throw refuse(`${at} has a key that is not a path`);
  if (!isObject(state)) throw refuse(`${at} is not an object`);
  if (!isCount(state["uid"]) || state["uid"] === 0) {
    throw refuse(`${at}.uid is ${describe(state["uid"])}, not a positive integer`);
  }
  for (const field of ["folder", "deleted"]) {
    if (typeof state[field] !== "boolean") {
      throw refuse(`${at}.${field} is ${describe(state[field])}, not a boolean`);
    }
  }
  for (const field of ["mtime", "size"]) {
    if (!isCount(state[field])) {
      throw refuse(`${at}.${field} is ${describe(state[field])}, not a non-negative integer`);
    }
  }
  if (typeof state["hash"] !== "string") {
    throw refuse(`${at}.hash is ${describe(state["hash"])}, not a string`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isPath(v: unknown): v is string {
  return typeof v === "string" && v !== "" && !v.includes("\0");
}

/** A chunk name is the hex of a 32-byte digest, and nothing else ever is. */
function isChunkName(v: unknown): boolean {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

function describe(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return Array.isArray(v) ? "a list" : "an object";
}
