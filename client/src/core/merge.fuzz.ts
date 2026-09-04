import type { MergeOutcome } from "./merge.ts";

/**
 * A fuzzer for the merge, aimed where the merge is known to be weak.
 *
 * `mergeText` is pure: three strings in, an outcome out. That makes it the
 * cheapest thing in the repository to attack by volume, and the thing most
 * worth attacking, because every check in merge.ts exists to catch a defect of
 * diff-match-patch that a hand-built test found only after it had happened once.
 * The hand-built cases are the shapes somebody thought of. This generates the
 * shapes nobody did, biased hard towards the one the fuzzy matcher is known to
 * get wrong: repetitive content, where a hunk's context matches somewhere that
 * looks like the right place and is not.
 *
 * Two properties, two modes.
 *
 * **Placed** (the oracle mode). Both sides make line-level edits that never
 * touch the same line of the ancestor, so the correct merge is known exactly:
 * apply both edit lists to the ancestor. The only latitude is the order of two
 * runs added at the same point by the two sides, which is the daily-note case,
 * so every ordering of those is accepted. A `merged` outcome must be one of the
 * expected texts. This is the property that sees a hunk landing in the wrong
 * place even when the resulting *lines* are all correct, which is the hole the
 * two-directions check was documented to have, and it found that hole (case
 * 1588232709) before a hand-built case did. It also found `splicedAdditions`
 * in merge.ts: two devices rewriting one line, their character spans a single
 * space apart, so nothing overlaps and the two rewrites run together (cases
 * 1588304879 and 1588275183).
 *
 * The oracle needs each side's text to have one reading as edits, or a small
 * enumerable set of them. It does not, when lines repeat: a note of eight
 * identical sections where one device empties section 3 reads equally as a
 * device that moved a section, and the merge of that reading puts the change
 * somewhere else, correctly (case 1588232821). Nor when a line moves past its
 * neighbour, which reads equally as the neighbour moving the other way (case
 * 1588233285), and the two readings interact with every other edit near them.
 * So in this mode every non-blank line is unique, differing from its siblings
 * by a number (which is still what confuses the fuzzy matcher: the observed
 * failure was Item 3 against Item 6), no added line copies an existing one, no
 * blank line is added, and nothing moves; a move is a deletion and an addition
 * elsewhere, and the mode has both of those, with different text. What remains
 * ambiguous is enumerated: a deleted run slides across identical blank lines,
 * an added line sits at either end of a deleted run it touches, two additions
 * at one boundary come in either order, and every candidate reading is kept
 * only if it reproduces the side's text. Two shapes the enumeration cannot
 * reach are excluded where they are generated, each with the case that showed
 * why, and a third is tolerated where the answer is compared.
 *
 * **Tokens** (the adversarial mode). No constraint at all: identical sections,
 * a line repeated thirty times, copied lines, moves, and the two sides may
 * collide, so there is no single right answer. What still has to hold is rule
 * 10's property: no edit is lost, and nothing is invented. See `tokenMismatch`
 * for exactly what is asked and what is deliberately not. This is the mode
 * that found the blank-line splice (case 1588233516), its general form
 * (1588232853), and `inventedWord` in merge.ts, a splice inside a word that no
 * check comparing spans can see (cases 3869907292 and 3869956296).
 *
 * **What is still wrong, at a scale the committed run does not reach.** At a
 * million cases per mode the token property is clean and the placed property
 * still refuses about 1.6 merges in a hundred thousand. The shape changed when
 * the merge did, and the new one is milder than the old one.
 *
 * The old one, which the character merge still has and which is now only
 * reachable through `mergeTextCharacters`, is a line neither device wrote:
 *
 * ```
 * base    # 2026-09-02\n\n- the text\n- here line line\n
 * mine    # 2026-09-02\n\nmine1 the text\n- here line line\n
 * theirs  # 2026-09-02\n\n- theirs sync text 1\n- the text\n
 * merged  # 2026-09-02\n\nmine1 theirs sync text 1\n- the text\n
 * ```
 *
 * One device rewrites the marker of a line, which is a one-character edit with
 * no anchoring context at all, while the other rewrites or displaces that same
 * line. `mine1` lands on the other device's new line and the line it was meant
 * for survives untouched. Cases 16087566 and 15967076, and eighteen more like
 * them in a million. A rule refusing two deletions that share an ancestor line
 * when either crosses a line end was measured against it: it cost three merges
 * in a thousand and still left half the shape, so it was not taken. The line
 * regions took all of it: the two edits are on different ancestor lines, so
 * they are in different regions and neither can reach the other. That merge is
 * now clean and correct.
 *
 * What is left, at 1.6 in a hundred thousand, invents nothing. Every line of it
 * is some device's own line, and what is wrong is which paragraph an added line
 * ends up against, in an ancestor that reads two ways (case 1588715761):
 *
 * ```
 * base    ...\n\nnote sync line here here line text.\n\nthe again ... text.\n\nsame ... same.
 * mine    ...\n\nnote sync line here here mine0 text.\n\nthe again ... text.
 * theirs  ...\n\nnote sync line here here line text.\n\nthe again ... text.\nTHEIRS LINE 0\n\nsame ... same.
 * ```
 *
 * Mine changed a word in one paragraph and deleted the last one. Read the other
 * way, which reproduces mine's text exactly as well, mine replaced three lines
 * with one and rewrote the final paragraph. The line diff picks the second, and
 * under it theirs' added line belongs between mine's two changes rather than at
 * the end, so that is where it goes. Both readings are honest; only the
 * generator knows which one it meant, which is what makes this the oracle's
 * disagreement with a defensible answer rather than a mangled note. Over 300,000
 * cases, the character merge's defects are all a line nobody wrote and the
 * region merge's are all this. Written down rather than fixed, which is the
 * honest state of it.
 *
 * Rule 8: the counts are asserted, not just the property. A fuzzer whose every
 * case ends in `conflict` proves nothing about merges. Measured over a million
 * cases per mode: the placed mode merges 94 per cent of what it generates and
 * refuses 5, the adversarial mode merges 85 and refuses 15, and the placed mode
 * accepts one in ten thousand on blank lines alone. The character merge on its
 * own, which is what those numbers were before the merge worked in regions,
 * managed 70 and 57. The floors asserted in
 * merge.fuzz.test.ts are a third of those, so a merge that grows more cautious
 * does not fail for being cautious, while a merge that refuses everything does.
 *
 * ## Why the generator is a module and not the test
 *
 * The cases are worth more than one run of them. merge.fuzz.test.ts runs two
 * thousand of each mode inside the suite and asserts; merge.fuzz.run.ts runs
 * hundreds of thousands out of band, against two merges at once, and counts
 * instead of throwing. Both have to see the same seeds produce the same cases
 * or a comparison between them means nothing, so the seeds are generated here,
 * once. Same shape as compression-golden.ts, and for the same reason.
 */

// ---------------------------------------------------------------------------
// A small deterministic PRNG. mulberry32, because it is ten lines and good
// enough to pick lines out of a note.

interface Rng {
  next(): number;
  int(n: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

function rng(seed: number): Rng {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
    chance: (p) => next() < p,
  };
}

// ---------------------------------------------------------------------------
// Ancestors. Every shape here is repetitive on purpose.

const WORDS = ["the", "note", "sync", "line", "again", "same", "text", "here"];

function sentence(r: Rng, words: number): string {
  return Array.from({ length: words }, () => r.pick(WORDS)).join(" ");
}

/** N sections sharing boilerplate, told apart only by an item line. */
function sections(r: Rng): string[] {
  const n = 4 + r.int(12);
  const boiler = r.chance(0.5)
    ? ["Some shared boilerplate text here.", ""]
    : ["Some shared boilerplate text here.", "", "And a second boilerplate line.", ""];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) out.push("");
    out.push("## Section", "", ...boiler, `Item ${i}`);
  }
  return out;
}

/** N sections with nothing to tell them apart at all. */
function identicalSections(r: Rng): string[] {
  const n = 3 + r.int(10);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) out.push("");
    out.push("## Section", "", "Some shared boilerplate text here.", "", "- [ ] todo");
  }
  return out;
}

/** A code-like note: the same block repeated, differing by one argument. */
function repeatedBlocks(r: Rng): string[] {
  const n = 3 + r.int(8);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push("// ----------------", "setup();", `step(${i});`, "teardown();", "");
  }
  return out;
}

/** A daily note: heading, then list items drawn from a tiny vocabulary. */
function dailyNote(r: Rng): string[] {
  const n = 2 + r.int(10);
  const out = ["# 2026-09-02", ""];
  for (let i = 0; i < n; i++) out.push(`- ${sentence(r, 1 + r.int(4))}`);
  return out;
}

/** Prose from eight words, so most lines resemble most other lines. */
function prose(r: Rng): string[] {
  const n = 3 + r.int(8);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) out.push("");
    out.push(sentence(r, 4 + r.int(8)) + ".");
  }
  return out;
}

/** One line, over and over. The pathological end of repetition. */
function sameLine(r: Rng): string[] {
  return Array.from({ length: 5 + r.int(30) }, () => r.pick(["p", "- item", "same line"]));
}

/** Shapes for the oracle, before their repeated lines are numbered. */
const DISTINCT = [sections, sections, sections, repeatedBlocks, dailyNote, prose];
/** Every shape, for the property that needs no reading of the edits. */
const ALL = [...DISTINCT, identicalSections, sameLine];

/**
 * Makes every non-blank line unique by numbering repeats, so that a side's
 * text has few readings. The lines stay near-identical, which is what
 * confuses the matcher.
 */
function numbered(lines: string[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    if (line === "") return line;
    const n = seen.get(line) ?? 0;
    seen.set(line, n + 1);
    return n === 0 ? line : `${line} (${n})`;
  });
}

// ---------------------------------------------------------------------------
// Edits, as operations on the ancestor's lines. Line indices are ancestor
// indices, so two edit lists can be applied to the same ancestor together.

type Op =
  | { kind: "insert"; at: number; line: string } // before ancestor line `at`; `at === n` appends
  | { kind: "delete"; at: number; count: number }
  | { kind: "replace"; at: number; line: string }
  | { kind: "move"; from: number; to: number }; // line `from` reinserted before line `to`

/** A line that is brand new, or in the adversarial mode possibly a copy of one already there. */
function newLine(r: Rng, base: string[], tag: string, n: number, collide: boolean): string {
  if (collide && r.chance(0.35)) return r.pick(base);
  // No blank line in the oracle mode. A blank added next to a blank the
  // ancestor already had reads equally as one added on the other side of it,
  // and the two readings put a later addition in different places (case
  // 1588283901). The adversarial mode adds them, and copies of other lines too.
  const forms = [
    `${tag} added ${n}`,
    `- ${tag} ${sentence(r, 2)} ${n}`,
    `${tag.toUpperCase()} LINE ${n}`,
  ];
  return r.pick(forms);
}

/** The ancestor lines an op removes or rewrites. */
function touches(op: Op): number[] {
  if (op.kind === "insert") return [];
  if (op.kind === "move") return [op.from];
  if (op.kind === "replace") return [op.at];
  return Array.from({ length: op.count }, (_, d) => op.at + d);
}

function makeSide(r: Rng, base: string[], tag: string, avoid: Set<number>, collide: boolean): Op[] {
  const n = base.length;
  const ops: Op[] = [];
  const taken = new Set(avoid);
  const free = () => {
    // A line neither side has touched yet, or any line at all in collide mode.
    const candidates: number[] = [];
    for (let i = 0; i < n; i++) if (collide || !taken.has(i)) candidates.push(i);
    return candidates.length === 0 ? undefined : r.pick(candidates);
  };
  const push = (op: Op) => {
    ops.push(op);
    for (const i of touches(op)) taken.add(i);
  };
  const count = 1 + r.int(3);
  for (let k = 0; k < count; k++) {
    const roll = r.next();
    if (roll < 0.3) {
      push({ kind: "insert", at: r.int(n + 1), line: newLine(r, base, tag, k, collide) });
    } else if (roll < 0.45) {
      // A whole run: a section, or several lines. This is what shifts every
      // later offset, which is what sends the fuzzy matcher to the wrong place.
      const at = free();
      if (at === undefined) continue;
      const want = 1 + r.int(6);
      let len = 1;
      while (len < want && at + len < n && (collide || !taken.has(at + len))) len++;
      push({ kind: "delete", at, count: len });
    } else if (roll < 0.6) {
      const at = free();
      if (at === undefined) continue;
      push({ kind: "delete", at, count: 1 });
    } else if (roll < 0.85) {
      const at = free();
      if (at === undefined || base[at] === "") continue;
      const words = base[at]!.split(" ");
      const next = [...words];
      next[r.int(words.length)] = `${tag}${k}`;
      push({ kind: "replace", at, line: next.join(" ") });
    } else if (collide) {
      // Move: the shape the two-directions check was documented not to see.
      // Only where no reading is needed; see the header.
      const from = free();
      if (from === undefined) continue;
      let to = r.int(n + 1);
      if (to === from || to === from + 1) to = (to + 2) % (n + 1);
      push({ kind: "move", from, to });
    } else {
      // The same displacement without the ambiguity: a line goes, and an
      // unrelated one arrives somewhere else.
      const at = free();
      if (at === undefined) continue;
      push({ kind: "delete", at, count: 1 });
      push({ kind: "insert", at: r.int(n + 1), line: newLine(r, base, tag, k, collide) });
    }
  }
  if (ops.length === 0) ops.push({ kind: "insert", at: n, line: `${tag} appended` });
  return ops;
}

// ---------------------------------------------------------------------------
// Readings. One side's text, as edits to the ancestor, in every way that
// reproduces it.

/**
 * A side's edits in the form readings are enumerated in: runs of deleted
 * ancestor lines, and lines added before an ancestor line (`at === n` appends).
 */
interface Script {
  runs: [number, number][];
  /** `group` is the op an addition came from; a moved block stays in order. */
  adds: { at: number; line: string; group: number }[];
}

function toScript(base: string[], ops: Op[]): Script {
  const deleted = new Set<number>();
  const adds: Script["adds"] = [];
  ops.forEach((op, group) => {
    if (op.kind === "insert") adds.push({ at: op.at, line: op.line, group });
    else if (op.kind === "delete") for (let d = 0; d < op.count; d++) deleted.add(op.at + d);
    else if (op.kind === "replace") {
      // A replacement is a deletion and an addition, which is also how a
      // diff sees it, so an addition next to a deleted run has two equally
      // good positions.
      deleted.add(op.at);
      adds.push({ at: op.at + 1, line: op.line, group });
    } else {
      deleted.add(op.from);
      adds.push({ at: op.to, line: base[op.from]!, group });
    }
  });
  const runs: [number, number][] = [];
  for (const i of [...deleted].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[1] === i) last[1] = i + 1;
    else runs.push([i, i + 1]);
  }
  return { runs, adds };
}

function touchedBy(script: Script): Set<number> {
  const out = new Set<number>();
  for (const [s, e] of script.runs) for (let i = s; i < e; i++) out.add(i);
  return out;
}

/**
 * Applies one or both sides' edits to the ancestor.
 *
 * With two sides whose deleted lines are disjoint this is the exact answer, up
 * to the order of lines both sides added at one boundary. `order` picks which
 * side goes first at each such boundary, one bit per boundary, so the caller
 * can enumerate every acceptable text.
 */
function apply(base: string[], sides: Script[], order: (boundary: number) => boolean): string[] {
  const n = base.length;
  const inserts: string[][][] = Array.from({ length: n + 1 }, () => sides.map(() => []));
  const deleted = new Set<number>();
  sides.forEach((side, s) => {
    for (const add of side.adds) inserts[add.at]![s]!.push(add.line);
    for (const i of touchedBy(side)) deleted.add(i);
  });
  const out: string[] = [];
  for (let i = 0; i <= n; i++) {
    const [a = [], b = []] = inserts[i]!;
    out.push(...(order(i) ? [...a, ...b] : [...b, ...a]));
    if (i === n) break;
    if (!deleted.has(i)) out.push(base[i]!);
  }
  return out;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

/**
 * Every order of a side's own additions that share a boundary, one chunk per
 * originating op. Two readings of a move can put a moved block and an added
 * line at one boundary in either order, and only the text says which.
 */
function orderings(adds: Script["adds"], cap: number): Script["adds"][] | undefined {
  const boundaries = new Map<number, Map<number, Script["adds"]>>();
  for (const add of adds) {
    const groups = boundaries.get(add.at) ?? new Map<number, Script["adds"]>();
    groups.set(add.group, [...(groups.get(add.group) ?? []), add]);
    boundaries.set(add.at, groups);
  }
  const permutations = <T>(xs: T[]): T[][] =>
    xs.length <= 1
      ? [xs]
      : xs.flatMap((x, i) => permutations(xs.filter((_, j) => j !== i)).map((p) => [x, ...p]));
  const perBoundary = [...boundaries.values()].map((groups) =>
    permutations([...groups.values()]).map((chunks) => chunks.flat()),
  );
  const combos = product(perBoundary, cap);
  return combos?.map((c) => c.flat());
}

function product<T>(alts: T[][], cap: number): T[][] | undefined {
  let count = 1;
  for (const a of alts) {
    count *= a.length;
    if (count > cap) return undefined;
  }
  let out: T[][] = [[]];
  for (const a of alts) out = out.flatMap((list) => a.map((x) => [...list, x]));
  return out;
}

/**
 * Every way of reading one side's text as edits to the ancestor, or undefined
 * when there are too many to enumerate.
 *
 * The generator knows which line it deleted; the merge only sees the text, and
 * deleting either of two identical neighbouring lines is the same text. So an
 * oracle built from the generator's indices is more specific than the inputs
 * warrant, and refused correct merges (cases 1588232773 and 1588233015, a
 * paragraph removed along with one of the two blank lines around it). A deleted
 * run slides while the line entering it equals the line leaving it; an added
 * line may sit at either end of a run it touches, and slides across copies of
 * itself; additions sharing a boundary come in either order. Candidates are
 * generated generously and then kept only if they reproduce the side's text
 * exactly, so over-generation cannot let a wrong merge through, it can only
 * cost time.
 */
function readings(
  base: string[],
  script: Script,
  text: string[],
  cap: number,
): Script[] | undefined {
  const out: Script[] = [];
  {
    const runAlts = script.runs.map((run) => {
      const alts: [number, number][] = [run];
      const len = run[1] - run[0];
      for (let a = run[0]; a + len < base.length && base[a] === base[a + len]; a++) {
        alts.push([a + 1, a + 1 + len]);
      }
      for (let a = run[0]; a > 0 && base[a - 1] === base[a + len - 1]; a--) {
        alts.push([a - 1, a - 1 + len]);
      }
      return alts;
    });
    const addAlts = script.adds.map((add) => {
      const seeds = new Set([add.at]);
      for (const alts of runAlts) {
        for (const [s, e] of alts) {
          if (s <= add.at && add.at <= e) {
            seeds.add(s);
            seeds.add(e);
          }
        }
      }
      const ats = new Set<number>();
      for (const seed of seeds) {
        ats.add(seed);
        for (let b = seed; b < base.length && base[b] === add.line; b++) ats.add(b + 1);
        for (let b = seed; b > 0 && base[b - 1] === add.line; b--) ats.add(b - 1);
      }
      return [...ats].map((at) => ({ ...add, at }));
    });
    const runs = product(runAlts, cap);
    const adds = product(addAlts, cap);
    if (runs === undefined || adds === undefined) return undefined;
    if (runs.length * adds.length > cap) return undefined;
    for (const r of runs) {
      for (const a of adds) {
        const ordered = orderings(a, cap);
        if (ordered === undefined) return undefined;
        for (const o of ordered) {
          const candidate: Script = { runs: r, adds: o };
          if (
            sameLines(
              apply(base, [candidate], () => true),
              text,
            )
          )
            out.push(candidate);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cases.

export interface Case {
  seed: number;
  shape: string;
  base: string;
  mine: string;
  theirs: string;
  /** Every acceptable merged text, when the edits were disjoint. */
  expected?: Set<string>;
  /** What the generator did, for reading a failure. */
  ops: { mine: Op[]; theirs: Op[] };
}

export function makeCase(seed: number, collide: boolean): Case | undefined {
  const r = rng(seed);
  const shape = r.pick(collide ? ALL : DISTINCT);
  const baseLines = collide ? shape(r) : numbered(shape(r));
  const mineOps = makeSide(r, baseLines, "mine", new Set(), collide);
  const theirOps = makeSide(r, baseLines, "theirs", new Set(mineOps.flatMap(touches)), collide);
  const trailing = r.chance(0.7) ? "\n" : "";
  // No lines is no text, not one empty line.
  const join = (ls: string[]) => (ls.length === 0 ? "" : ls.join("\n") + trailing);

  // The generator's own reading is one reading; use it to produce the texts.
  const mineScript = toScript(baseLines, mineOps);
  const theirScript = toScript(baseLines, theirOps);
  const mineLines = apply(baseLines, [mineScript], () => true);
  const theirLines = apply(baseLines, [theirScript], () => true);
  const base = join(baseLines);
  const mine = join(mineLines);
  const theirs = join(theirLines);
  if (mine === base || theirs === base || mine === theirs) return undefined;

  const c: Case = {
    seed,
    shape: shape.name,
    base,
    mine,
    theirs,
    ops: { mine: mineOps, theirs: theirOps },
  };
  if (!collide) {
    // Two runs one side added at different points, with every ancestor line
    // between them deleted by the other side, arrive at one point in the
    // merge, and the ancestor no longer says which comes first. Observed
    // (case 1588243821) as mine's replacement of `step(8);` and mine's own
    // appended line swapping places when theirs deleted the `teardown();`
    // between them: both lines present, both in one order in mine's own text
    // and in the other in the merge. Nothing is lost, no line is invented,
    // and the oracle cannot say which order is right, so the mode does not
    // generate the shape. The adversarial mode does.
    const collapses = (side: Script, other: Script): boolean => {
      const gone = touchedBy(other);
      const ats = [...new Set(side.adds.map((a) => a.at))].sort((a, b) => a - b);
      return ats.some((at, i) => {
        if (i === 0) return false;
        for (let k = ats[i - 1]!; k < at; k++) if (!gone.has(k)) return false;
        return true;
      });
    };
    if (collapses(mineScript, theirScript) || collapses(theirScript, mineScript)) return undefined;

    // Every reading of each side's text as edits, and for each pair of
    // readings that still touch different lines, every order of two runs
    // added at one point. Anything the merge returns must be one of these.
    const mineReadings = readings(baseLines, mineScript, mineLines, 128);
    const theirReadings = readings(baseLines, theirScript, theirLines, 128);
    if (mineReadings === undefined || theirReadings === undefined) return undefined;
    c.expected = new Set();
    for (const m of mineReadings) {
      const mt = touchedBy(m);
      for (const t of theirReadings) {
        if ([...touchedBy(t)].some((i) => mt.has(i))) continue;
        const shared = [...new Set(t.adds.map((a) => a.at))].filter((b) =>
          m.adds.some((a) => a.at === b),
        );
        if (shared.length > 3) continue;
        for (let bits = 0; bits < 1 << shared.length; bits++) {
          const order = (b: number) => {
            const i = shared.indexOf(b);
            return i < 0 || ((bits >> i) & 1) === 0;
          };
          c.expected.add(join(apply(baseLines, [m, t], order)));
        }
      }
    }
    if (c.expected.size === 0) return undefined;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Properties.

export function tokens(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of text.split(/\s+/)) if (t !== "") m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/**
 * What the words of a correct merge have to satisfy, or undefined if they do.
 *
 * Three questions, and only one of them is an equality, because the two sides
 * in this mode may have edited the same lines and then there is no single
 * right answer for a word they both touched.
 *
 * **No word nobody wrote.** However the edits collide, a word in the result
 * that is in none of the three versions was made by joining two of them. That
 * is the failure the whole module exists to refuse, and it is the question
 * that found cases 3869907292 and 7028336.
 *
 * **A word the ancestor did not have appears exactly as often as the two sides
 * added it.** It is new, so nothing can be ambiguous about which occurrence
 * anybody meant, and a count short of that is an added word that did not
 * survive.
 *
 * **When neither device removed anything, nothing goes missing.** Where both
 * sides only added, the result keeps at least every word the ancestor had,
 * which is rule 5 asked one word at a time. The condition is the whole case
 * and not the one word, because a device that removed a line elsewhere may
 * have removed this word there and added it back here (case 16046763).
 *
 * What is deliberately not asserted is the exact count of an ancestor word one
 * side removed some of. Which of several identical words a device removed is
 * not decidable from the text: a note of `p` over and over, where one device
 * removes a `p` and the other removes one and adds one, is the same text under
 * readings that give different counts (cases 3869930650 and 3869933448). An
 * earlier version asserted an exact count there, which was asserting one
 * reading of an ambiguous input.
 */
export function tokenMismatch(
  base: string,
  mine: string,
  theirs: string,
  got: Map<string, number>,
): string | undefined {
  const b = tokens(base);
  const m = tokens(mine);
  const t = tokens(theirs);
  const known = new Set([...b.keys(), ...m.keys(), ...t.keys()]);
  for (const [k, n] of got) {
    if (!known.has(k)) return `${JSON.stringify(k)}: nobody wrote it, and it is there ${n} times`;
  }
  const additive = [...b].every(([k, bk]) => (m.get(k) ?? 0) >= bk && (t.get(k) ?? 0) >= bk);
  for (const k of known) {
    const bk = b.get(k) ?? 0;
    const mk = m.get(k) ?? 0;
    const tk = t.get(k) ?? 0;
    const n = got.get(k) ?? 0;
    if (bk === 0) {
      if (n !== mk + tk) return `${JSON.stringify(k)}: added ${mk + tk} times, got ${n}`;
    } else if (additive && n < bk) {
      return `${JSON.stringify(k)}: nobody removed anything, expected ${bk}, got ${n}`;
    }
  }
  return undefined;
}

export function report(c: Case, what: string, text?: string): string {
  const show = (s: string) => JSON.stringify(s);
  return [
    `merge fuzz case ${c.seed} (${c.shape}): ${what}`,
    `replay with MERGE_FUZZ_CASE=${c.seed}`,
    `base   ${show(c.base)}`,
    `mine   ${show(c.mine)}`,
    `theirs ${show(c.theirs)}`,
    `edits  ${JSON.stringify(c.ops)}`,
    ...(text === undefined ? [] : [`merged ${show(text)}`]),
    ...(c.expected === undefined ? [] : [...c.expected].map((e) => `wanted ${show(e)}`)),
  ].join("\n");
}

/** A text as the lines that carry something, which is what the oracle judges. */
export function written(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/** A merge, as this fuzzer needs to see it: three texts in, an outcome out. */
export type Merge = (base: string, mine: string, theirs: string) => MergeOutcome;

/**
 * What one case says about one merge.
 *
 * `kind` is the outcome, with one extra name: `blanks` is a merge that matched
 * the oracle in every line that carries something and differed only in a blank
 * line, which is not a failure and is explained below. `defect` is set when the
 * merge returned text and the text is wrong, which is the only number in this
 * file that matters.
 */
export interface Verdict {
  readonly kind: string;
  readonly defect?: string;
}

/** Runs one case against one merge, and says nothing about whether that is bad. */
export function verdict(c: Case, merge: Merge): Verdict {
  const r = merge(c.base, c.mine, c.theirs);
  if (r.kind === "conflict") return { kind: r.kind };
  if (c.expected === undefined) {
    const bad = tokenMismatch(c.base, c.mine, c.theirs, tokens(r.text));
    if (bad !== undefined) return { kind: r.kind, defect: bad };
    return { kind: r.kind };
  }
  if (c.expected.has(r.text)) return { kind: r.kind };
  // Not the exact text, which is not yet a failure. Where an addition sits at
  // the edge of a run the other side deleted, the newline between the two can
  // attach to either of them, and the two readings differ only in blank lines
  // and the final newline: mine adds a line before a paragraph theirs deletes
  // to the end of the note, and the merge puts the new line last with the
  // blank before it rather than the newline after it (case 1588238987). Both
  // readings are honest and the enumeration below keeps one, so what is
  // compared then is the lines that carry something. What that gives up is a
  // blank line more or less, which is not a lost note. What it keeps is which
  // lines exist and in what order, which is the misplacement this mode is for:
  // it still refuses cases 1588304879 and 1588275183, where a word of one
  // device ends up on a line of the other.
  const got = written(r.text);
  if ([...c.expected].some((e) => written(e) === got)) return { kind: "blanks" };
  return { kind: r.kind, defect: "not the merge of these edits" };
}

/** Runs one case; returns the outcome kind, or throws with the full triple. */
export function check(c: Case, merge: Merge): string {
  const v = verdict(c, merge);
  if (v.defect === undefined) return v.kind;
  const text = merge(c.base, c.mine, c.theirs);
  const what =
    c.expected === undefined
      ? `${v.kind} with the wrong tokens, ${v.defect}`
      : `${v.kind} to a text that is ${v.defect}`;
  throw new Error(report(c, what, text.kind === "conflict" ? undefined : text.text));
}

// ---------------------------------------------------------------------------
// The seeds. Shared, so that the suite and a long out-of-band run are talking
// about the same cases.

/** Any fixed number. Changing it changes which cases run, not what they prove. */
export const SEED = 0x5a17;

/**
 * `count` cases of one mode, in a fixed order.
 *
 * Not every seed makes a case: the generator refuses the shapes its oracle
 * cannot read, so it is asked for up to three times as many before giving up.
 * `only` replays a single seed, and throws if that seed makes nothing in this
 * mode, because a replay that silently runs zero cases looks like a pass.
 */
export function* cases(collide: boolean, count: number, only?: number): Generator<Case> {
  if (only !== undefined) {
    const c = makeCase(only, collide);
    if (c === undefined) throw new Error(`case ${only} generates nothing in this mode`);
    yield c;
    return;
  }
  let made = 0;
  for (let i = 0; made < count && i < count * 3; i++) {
    const c = makeCase((SEED * 1000003 + i * 2 + (collide ? 1 : 0)) >>> 0, collide);
    if (c === undefined) continue;
    made++;
    yield c;
  }
}
