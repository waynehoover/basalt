/**
 * review finding I8. The small-file question was measured and decided: keep
 * chunking as it is, no whole-file fast path. docs/compared.md, "A whole-file
 * fast path for small notes", records the numbers. This pins the constants
 * that decision rests on, because changing any of them renames every chunk in
 * every vault and nothing else in the suite would say so.
 */

import { describe, expect, it } from "vitest";

import { TEXT_SIZES, textSizesFor } from "./chunk.ts";

describe("the text chunk sizes compared.md describes", () => {
  it("are 512 B / 1 KiB / 4 KiB", () => {
    expect(TEXT_SIZES).toEqual({ min: 512, avg: 1024, max: 4096 });
  });

  it("give a 4 KiB note the floor sizes, so it is about four chunks", () => {
    // sqrt(64 * 4096) is 512, under the 1 KiB floor on the average, so the
    // floor holds: 512 / 1024 / 4096.
    expect(textSizesFor(4096)).toEqual({ min: 512, avg: 1024, max: 4096 });
  });

  it("scale a 64 KiB note to a 2 KiB average", () => {
    // sqrt(64 * 65536) is 2048: 1024 / 2048 / 8192.
    expect(textSizesFor(65536)).toEqual({ min: 1024, avg: 2048, max: 8192 });
  });

  it("never go below the floor for a tiny note, nor above the ceiling for a huge one", () => {
    expect(textSizesFor(1)).toEqual({ min: 512, avg: 1024, max: 4096 });
    expect(textSizesFor(1 << 30).avg).toBe(64 * 1024);
  });
});
