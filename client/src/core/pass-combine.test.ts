/**
 * C35 in TODO.md. A sync asked for while a pass was running runs again when it
 * finishes, and the two reports were added field by field. The work counters
 * add; the state counters do not: one file held back by the write debounce in
 * both passes was reported as two waiting, and a settled vault passed over
 * twice reported every file unchanged twice.
 */

import { describe, expect, it } from "vitest";

import { combinePasses, type SyncReport } from "./engine.ts";

function report(over: Partial<SyncReport>): SyncReport {
  return {
    uploaded: 0,
    downloaded: 0,
    merged: 0,
    conflicted: 0,
    deletedLocally: 0,
    deletedRemotely: 0,
    restored: 0,
    foldersCreated: 0,
    unchanged: 0,
    waiting: 0,
    retrying: 0,
    skipped: 0,
    blocked: 0,
    inTheWay: [],
    chunksSent: 0,
    bytesSent: 0,
    ...over,
  };
}

describe("two passes of one sync, combined (C35)", () => {
  it("adds what happened and keeps the last word on how the vault looks", () => {
    const first = report({
      uploaded: 2,
      waiting: 3,
      unchanged: 10,
      retrying: 1,
      skipped: 1,
      blocked: 1,
      inTheWay: [{ path: "a", blockedBy: "b" }],
      chunksSent: 4,
      bytesSent: 400,
    });
    const second = report({
      uploaded: 1,
      waiting: 1,
      unchanged: 12,
      retrying: 0,
      skipped: 1,
      blocked: 0,
      chunksSent: 1,
      bytesSent: 50,
    });
    const both = combinePasses(first, second);
    expect(both.uploaded).toBe(3);
    expect(both.chunksSent).toBe(5);
    expect(both.bytesSent).toBe(450);
    // States: the newest pass's answer, not a sum.
    expect(both.waiting).toBe(1);
    expect(both.unchanged).toBe(12);
    expect(both.retrying).toBe(0);
    expect(both.skipped).toBe(1);
    expect(both.blocked).toBe(0);
    expect(both.inTheWay).toEqual([]);
  });
});
