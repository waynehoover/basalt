import { describe, expect, it } from "vitest";
import { cases, check } from "./merge.fuzz.ts";
import { mergeText } from "./merge.ts";

/**
 * The fuzzer's two properties, run inside the suite against the shipped merge.
 *
 * Everything about how a case is made, and what each property is asking, is in
 * merge.fuzz.ts, including the residue neither property has been able to clear.
 * This file is the part that runs every time and asserts: the properties hold,
 * and enough cases merge for that to mean something.
 *
 * merge.fuzz.run.ts is the same generator at a hundred times the volume, over
 * both merge paths, counting instead of throwing. That is where a number in the
 * comments here came from, and where the next one will.
 */

/**
 * How many cases each mode runs. The default is what fits in the normal suite,
 * about a quarter of a second for both modes; the first case either property
 * still refuses is fifty thousand in, and is described in merge.fuzz.ts.
 */
const CASES = Number(process.env.MERGE_FUZZ_CASES ?? 2000);
const ONLY =
  process.env.MERGE_FUZZ_CASE === undefined ? undefined : Number(process.env.MERGE_FUZZ_CASE);

/** Runs `CASES` cases of one mode and returns the outcome counts. */
function run(collide: boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of cases(collide, CASES, ONLY)) {
    const kind = check(c, mergeText);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  // A long run is asked for by hand, and its numbers are the point of it.
  if (process.env.MERGE_FUZZ_CASES !== undefined) {
    console.log(`${collide ? "tokens" : "placed"}: ${JSON.stringify(Object.fromEntries(counts))}`);
  }
  return counts;
}

describe("fuzzing the merge", () => {
  it("places every disjoint edit where it belongs, or refuses", () => {
    const counts = run(false);
    // Rule 8. If nothing merges, the oracle was never consulted. Measured at
    // 94 per cent merged, and at 70 before the merge worked in line regions;
    // the floor is a fifth, so it is a floor under both.
    if (ONLY === undefined) expect(counts.get("merged") ?? 0).toBeGreaterThan(CASES / 5);
  });

  it("never invents a word, and never loses one nobody removed", () => {
    const counts = run(true);
    // Measured at 85 per cent merged, 57 before regions; the floor is a tenth.
    // Lower than the oracle mode's because in this one the two sides may
    // collide, and a collision is a conflict on purpose.
    if (ONLY === undefined) expect(counts.get("merged") ?? 0).toBeGreaterThan(CASES / 10);
  });
});
