/**
 * The fuzzer at a volume the suite cannot afford, over both merges at once.
 *
 * merge.fuzz.test.ts asserts. This counts. The question it exists to answer is
 * the one improvements.md asks about the line-anchored hybrid: does it merge
 * more or less than the merge that ships, and does it produce fewer notes that
 * are wrong. Both merges see the same seeds, so the two columns are comparable
 * case for case rather than only in aggregate.
 *
 * Three numbers per merge per mode, all per 100,000 cases:
 *
 *   - **merged**, which is user-visible quality. A conflict copy is a real cost
 *     to somebody who wanted a note, so a merge that refuses more is worse at
 *     the thing people notice, whatever else it buys.
 *   - **conflicts**, the other side of that.
 *   - **defects**, which is a merge returning text that is not a merge of what
 *     the two devices wrote. This is the number that decides anything.
 *   - **swap-differs**, cases where telling the merge the two devices the other
 *     way round changes the answer. See `asymmetry`: it is the one check here
 *     that has no model of a correct merge behind it, so it is the one the
 *     oracle cannot be accused of agreeing with.
 *
 * Usage, from client/:
 *
 * ```
 * bun run src/core/merge.fuzz.run.ts            # 20,000 cases per mode
 * bun run src/core/merge.fuzz.run.ts 300000     # the real run
 * ```
 *
 * Nothing here is a gate. It prints a table and exits zero; the properties are
 * asserted in the test, and the counts asserted there are floors taken from a
 * run of this.
 */

import { cases, verdict, type Case, type Merge } from "./merge.fuzz.ts";
import { mergeText, mergeTextCharacters } from "./merge.ts";

interface Tally {
  merged: number;
  conflict: number;
  defects: number;
  /** Merges that change when the two devices are swapped; see `asymmetry`. */
  asymmetric: number;
  /** A few seeds per defect shape, because a rate without a case is a rumour. */
  shapes: Map<string, number[]>;
}

const empty = (): Tally => ({
  merged: 0,
  conflict: 0,
  defects: 0,
  asymmetric: 0,
  shapes: new Map(),
});

/**
 * Whether a merge gives a different answer when the two devices change places,
 * which is a defect nothing else here can see.
 *
 * Neither device is privileged: the same three versions reach both, with `mine`
 * and `theirs` the other way round, and both write the result back. So a merge
 * that depends on which side it is told first makes the two devices disagree
 * for ever, and it also means something was placed by a search rather than by
 * the structure of the change. The order of two additions at one point is the
 * exception the whole module allows, so this compares which lines exist rather
 * than the text, exactly as `samePlacement` does and for the same reason.
 *
 * This is the one property here with no model of a correct merge behind it, so
 * it is the one the fuzzer's own oracle cannot be accused of agreeing with.
 */
function asymmetry(c: Case, merge: Merge): boolean {
  const forward = merge(c.base, c.mine, c.theirs);
  const back = merge(c.base, c.theirs, c.mine);
  if (forward.kind === "conflict" || back.kind === "conflict") {
    return forward.kind !== back.kind;
  }
  const lines = (t: string) => (t.match(/[^\n]*\n|[^\n]+$/g) ?? []).sort().join("");
  return lines(forward.text) !== lines(back.text);
}

function record(t: Tally, c: Case, merge: Merge): void {
  const v = verdict(c, merge);
  if (v.kind === "conflict") t.conflict++;
  else t.merged++;
  if (asymmetry(c, merge)) t.asymmetric++;
  if (v.defect === undefined) return;
  t.defects++;
  // The message carries the offending word, which would make every defect its
  // own shape. The shape is what is left when the word is taken out.
  const shape = v.defect.replace(/^"[^"]*": /, "").replace(/\d+/g, "N");
  const seen = t.shapes.get(shape) ?? [];
  if (seen.length < 5) seen.push(c.seed);
  t.shapes.set(shape, seen);
}

const count = Number(process.argv[2] ?? 20000);
const merges: [string, Merge][] = [
  ["classic", (b, m, t) => mergeTextCharacters(b, m, t)],
  ["hybrid", (b, m, t) => mergeText(b, m, t)],
];

const rows: string[] = [];
for (const collide of [false, true]) {
  const mode = collide ? "tokens" : "placed";
  const tallies = merges.map(() => empty());
  let made = 0;
  for (const c of cases(collide, count)) {
    made++;
    merges.forEach(([, merge], i) => record(tallies[i]!, c, merge));
  }
  const per = (n: number) => ((n / made) * 100000).toFixed(1).padStart(8);
  rows.push(`${mode}: ${made} cases`);
  rows.push(
    `  ${"".padEnd(8)}${"merged/100k".padStart(14)}${"conflicts/100k".padStart(16)}` +
      `${"defects/100k".padStart(14)}${"swap-differs/100k".padStart(19)}`,
  );
  merges.forEach(([name], i) => {
    const t = tallies[i]!;
    rows.push(
      `  ${name.padEnd(8)}${per(t.merged).padStart(14)}${per(t.conflict).padStart(16)}` +
        `${per(t.defects).padStart(14)}${per(t.asymmetric).padStart(19)}`,
    );
  });
  merges.forEach(([name], i) => {
    for (const [shape, seeds] of tallies[i]!.shapes) {
      rows.push(`  ${name} defect: ${shape} (cases ${seeds.join(", ")})`);
    }
  });
  rows.push("");
}
console.log(rows.join("\n"));
