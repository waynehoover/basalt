/**
 * C23 in TODO.md. Both index stores handed back any valid JSON, and the engine
 * spread it into state through casts. What follows is the corpus of shapes
 * that used to be accepted and are now refused, each with the field named.
 */

import { describe, expect, it } from "vitest";

import { Engine } from "./engine.ts";
import { validateStoredState } from "./stored-state.ts";
import type { Transport } from "./transport.ts";
import { MemoryIndexStore, MemoryVault, type StoredState } from "./vault.ts";
import { deriveKeys } from "./crypto.ts";

const chunk = "ab".repeat(32);
const remoteA = () => good().remote["a.md"] as Record<string, unknown>;

/** A complete, correct index, to break one field at a time. */
function good(): StoredState {
  return {
    cursor: 12,
    entries: {
      "a.md": {
        path: "a.md",
        prev: "",
        folder: false,
        ctime: 1,
        mtime: 2,
        size: 3,
        hash: chunk,
        chunks: [chunk],
        synchash: chunk,
        syncuid: 9,
        synctime: 4,
      },
      dir: { folder: true },
    },
    remote: {
      "a.md": { uid: 9, folder: false, deleted: false, mtime: 2, size: 3, hash: chunk },
      "gone.md": { uid: 11, folder: false, deleted: true, mtime: 5, size: 0, hash: "" },
    },
    pending: ["gone.md"],
  };
}

/** The corpus: a description, a mutation, and the words the refusal must contain. */
export const corpus: [string, (s: Record<string, unknown>) => unknown, RegExp][] = [
  ["a bare list", () => [1, 2, 3], /not an object/],
  ["a null", () => null, /not an object/],
  ["a cursor that is null", (s) => ({ ...s, cursor: null }), /cursor is null/],
  ["a negative cursor", (s) => ({ ...s, cursor: -1 }), /cursor is -1/],
  ["a fractional cursor", (s) => ({ ...s, cursor: 1.5 }), /cursor is 1.5/],
  ["a cursor that is a string", (s) => ({ ...s, cursor: "12" }), /cursor is "12"/],
  ["entries as a list", (s) => ({ ...s, entries: [] }), /entries is not an object/],
  [
    "an entry that is a number",
    (s) => ({ ...s, entries: { "a.md": 7 } }),
    /entries\["a.md"\] is not an object/,
  ],
  [
    "an entry whose path disagrees with its key",
    (s) => ({ ...s, entries: { "a.md": { path: "b.md" } } }),
    /path is "b.md", which is not its key/,
  ],
  [
    "an entry with a negative size",
    (s) => ({ ...s, entries: { "a.md": { size: -4 } } }),
    /size is -4/,
  ],
  [
    "an entry whose folder flag is a string",
    (s) => ({ ...s, entries: { "a.md": { folder: "yes" } } }),
    /folder is "yes"/,
  ],
  [
    "an entry whose chunks are not names",
    (s) => ({ ...s, entries: { "a.md": { chunks: ["short"] } } }),
    /chunks is not a list of chunk names/,
  ],
  [
    "an entry synced with a hash but no chunks",
    (s) => ({ ...s, entries: { "a.md": { hash: chunk, synchash: chunk, chunks: [] } } }),
    /names no chunks/,
  ],
  ["an empty entry key", (s) => ({ ...s, entries: { "": {} } }), /key that is not a path/],
  ["remote as a list", (s) => ({ ...s, remote: [] }), /remote is not an object/],
  [
    "a remote state with uid 0",
    (s) => ({ ...s, remote: { "a.md": { ...remoteA(), uid: 0 } }, pending: [] }),
    /uid is 0/,
  ],
  [
    "a remote state with no deleted flag",
    (s) => ({
      ...s,
      remote: { "a.md": { uid: 1, folder: false, mtime: 1, size: 1, hash: "" } },
      pending: [],
    }),
    /deleted is missing/,
  ],
  [
    "a remote state whose hash is a number",
    (s) => ({ ...s, remote: { "a.md": { ...remoteA(), hash: 5 } }, pending: [] }),
    /hash is 5/,
  ],
  ["pending as an object", (s) => ({ ...s, pending: {} }), /pending is not a list/],
  ["pending holding a number", (s) => ({ ...s, pending: [7] }), /pending\[0\] is 7/],
  [
    "pending naming a path remote does not hold",
    (s) => ({ ...s, pending: ["nowhere.md"] }),
    /which remote does not hold/,
  ],
];

describe("what a saved index must look like (C23)", () => {
  it("accepts a complete, correct index, and nothing at all", () => {
    expect(validateStoredState(good())).toEqual(good());
    expect(validateStoredState(undefined)).toBeUndefined();
  });

  for (const [what, mutate, words] of corpus) {
    it(`refuses ${what}, naming the field`, () => {
      const raw = mutate(good() as unknown as Record<string, unknown>);
      expect(() => validateStoredState(raw)).toThrow(words);
      expect(() => validateStoredState(raw)).toThrow(/Remove the index and sync again/);
    });
  }

  it("stops the engine before it changes any state", async () => {
    const store = new MemoryIndexStore();
    await store.save({ ...good(), cursor: -3 } as StoredState);
    const keys = await deriveKeys(new Uint8Array(20).fill(1));
    let helloed = false;
    const transport = {
      hello: async () => (
        (helloed = true),
        { proto: 2, cursor: 0, perFileMax: 0, chunkMax: 0, maxChunks: 0 }
      ),
    } as unknown as Transport;
    const engine = new Engine({
      vault: new MemoryVault(),
      store,
      keys,
      transport,
      device: "d",
      vaultId: "v",
      token: "t",
    });
    await expect(engine.start()).rejects.toThrow(/cursor is -3/);
    expect(helloed, "talked to the server with a refused index").toBe(false);
    expect(engine.status().files).toBe(0);
  });
});
