/**
 * Runs the compression golden check outside vitest.
 *
 * CI runs this under Bun beside the vitest run under Node, because the
 * property being checked is that two runtimes seal to the same bytes, and one
 * runtime cannot check that on its own. Exits non-zero on the first
 * disagreement, naming it.
 */

import { checkGolden, renderTable } from "./compression-golden.ts";

const problems = await checkGolden();
if (process.argv.includes("--print")) {
  console.log(await renderTable());
} else if (problems.length > 0) {
  console.error("the sealed-chunk format no longer matches the golden table:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
} else {
  console.log(`compression golden: ${problems.length} problems, the format is pinned`);
}
