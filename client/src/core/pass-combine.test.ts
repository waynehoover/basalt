/**
 * review finding C35. A sync asked for while a pass was running runs again when it
 * finishes, and the two reports were added field by field. The work counters
 * add; the state counters do not: one file held back by the write debounce in
 * both passes was reported as two waiting, and a settled vault passed over
 * twice reported every file unchanged twice.
 */

import { describe, expect, it } from "vitest";

import { combinePasses, type SyncReport } from "./engine.ts";
import { didSomething, summarise } from "./client.ts";

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
    skippedPaths: [],
    ignored: 0,
    blocked: 0,
    inTheWay: [],
    needsAttention: [],
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
      ignored: 2,
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
      ignored: 2,
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
    // A state, like the rest of them: the same two ignored paths seen twice
    // are two, not four.
    expect(both.ignored).toBe(2);
    expect(both.blocked).toBe(0);
    expect(both.inTheWay).toEqual([]);
  });
});

/**
 * C-D6 in the 0.3.0 review. `settle` runs another pass while the last one did
 * something, and a file whose write debounce has not run out is not something
 * done: the debounce is tens of seconds and the retry is 60 ms, so eight full
 * scans of the vault happened to find the same file still waiting, and then it
 * returned anyway. Real follow-on work inside a pass is what `again` is for.
 */
describe("what counts as work worth another pass (C-D6)", () => {
  it("does not count a file that is only waiting for its debounce", () => {
    expect(didSomething(report({ waiting: 3, unchanged: 100 }))).toBe(false);
    expect(didSomething(report({}))).toBe(false);
  });

  it("still counts everything a pass actually did", () => {
    for (const key of [
      "uploaded",
      "downloaded",
      "merged",
      "conflicted",
      "deletedLocally",
      "deletedRemotely",
      "restored",
      "foldersCreated",
    ] as const) {
      expect(didSomething(report({ [key]: 1 })), key).toBe(true);
    }
  });
});

/**
 * The one line the plugin has. It is painted straight into the synced state,
 * so a counter missing here is a counter the panel and the status bar cannot
 * show at all.
 */
describe("the one-line summary (N1)", () => {
  it("does not say a vault is up to date while a save is still owed", () => {
    // Tens of seconds of write debounce, during which the pass is honest and
    // the summary was not. Rule 7.
    expect(summarise(report({ waiting: 1 }))).toBe("1 waiting");
    expect(summarise(report({ unchanged: 100, waiting: 2 }))).toBe("2 waiting");
  });

  it("mentions folders it made", () => {
    expect(summarise(report({ foldersCreated: 1 }))).toBe("1 folder");
    expect(summarise(report({ uploaded: 2, foldersCreated: 3 }))).toBe("2 sent, 3 folders");
  });

  it("still says up to date when a pass really had nothing to report", () => {
    expect(summarise(report({ unchanged: 40 }))).toBe("up to date");
  });
});
