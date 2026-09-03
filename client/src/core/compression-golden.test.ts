/**
 * review finding I7: the sealed-chunk format, byte for byte, under Node.
 *
 * The same check runs under Bun in CI through compression-golden.run.ts, and
 * the two together are what say the format is the same on two runtimes. See
 * the header of compression-golden.ts for why one runtime is not enough.
 */

import { describe, expect, it } from "vitest";

import { GOLDEN, PLAINTEXTS, checkGolden, sealAll } from "./compression-golden.ts";

describe("the sealed-chunk format", () => {
  it("seals every fixed plaintext to exactly the bytes in the table", async () => {
    expect(await checkGolden()).toEqual([]);
  });

  it("pins one entry per plaintext, and the marker rule for each", async () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(PLAINTEXTS.map((p) => p.name).sort());
    const results = await sealAll();
    // Stored as-is when deflate would not shrink it: nothing, one byte, a
    // short sequence, and bytes the probe gives up on. Deflated when it does.
    const markers = Object.fromEntries(results.map((r) => [r.name, r.marker]));
    expect(markers["empty"]).toBe(0);
    expect(markers["one byte"]).toBe(0);
    expect(markers["a short growing sequence"]).toBe(0);
    expect(markers["a long growing sequence, which repeats every 256 bytes"]).toBe(1);
    expect(markers["incompressible bytes, probed and left alone"]).toBe(0);
    expect(markers["a long compressible text"]).toBe(1);
  });

  it("never seals to more than the plaintext plus 29 bytes", async () => {
    for (const [i, r] of (await sealAll()).entries()) {
      expect(r.sealed.length, r.name).toBeLessThanOrEqual(PLAINTEXTS[i]!.bytes.length + 29);
    }
  });
});
