/**
 * The line structure a three-way merge happens inside: diff3's regions, and
 * nothing else.
 *
 * This is the half of `node-diff3` that merge.ts wanted and the half it did not.
 * Wanted: the region discipline. A three-way merge is a sequence of stretches of
 * the ancestor, each one either untouched, changed by exactly one device, or
 * changed by both, and an edit belongs to exactly one of them. Not wanted: what
 * diff3 does with the third kind, which is to give up on it. A Markdown
 * paragraph is one line, so two devices editing one paragraph is a region both
 * touched, and refusing those is what made plain diff3 unacceptable here.
 *
 * So this file computes the regions and answers nothing about them. merge.ts
 * decides what a region both sides touched is worth, by running the
 * character-level merge inside it and nowhere else.
 *
 * Written here rather than taken from `node-diff3` (MIT, 3.2.1, ~15 kB) because
 * what is needed is the region walk, which is this file, and the diff it needs
 * is `diff-match-patch`'s line mode, which the bundle already carries and
 * `placements` in merge.ts already uses. A dependency for 125 lines of code
 * would be one more thing shipped to a phone and one more thing to audit.
 *
 * ## Lines keep their newline
 *
 * A line here is the text up to and including its `\n`, and the last line of a
 * file without a trailing newline is a line that does not have one. That is what
 * diff-match-patch's own line mode does, so the two agree, and it means a
 * region's text is a substring of the file rather than something joined back
 * together. It also means a file whose last line gained a newline shows up as a
 * change to that line, which is exactly what it is.
 */

import { diff_match_patch } from "diff-match-patch";

const DELETE = -1;
const EQUAL = 0;

/** A text as lines, each keeping its newline; a final line without one stays distinct. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** One stretch of the ancestor, with what each side has in its place. */
export interface Region {
  /** Which sides changed it. */
  readonly changed: "none" | "mine" | "theirs" | "both";
  /** The ancestor's text for this stretch, and each side's text in its place. */
  readonly base: string;
  readonly mine: string;
  readonly theirs: string;
  /** Where the stretch starts in the ancestor, in characters, for messages. */
  readonly at: number;
  /** Where it starts and ends in the ancestor, in lines counted from zero. */
  readonly firstLine: number;
  readonly lastLine: number;
}

/** One side's changed stretch of the ancestor, in ancestor line numbers. */
interface Hunk {
  readonly mine: boolean;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * One side's diff against the ancestor, by lines, or undefined when the line
 * encoding could not represent the file.
 *
 * diff-match-patch encodes one line as one character, and stops giving out new
 * characters after 65,535 distinct lines, lumping the rest of the text into a
 * single one. A note that large is not a note, but a wrong answer there would be
 * a merge computed against the wrong lines, so the encoding is checked against
 * the line count and the caller falls back to the character merge if it does not
 * hold. Rule 4: the library's output is verified rather than assumed.
 */
function side(base: string, baseLines: string[], text: string, mine: boolean): Hunk[] | undefined {
  const sideLines = splitLines(text);
  const dmp = new diff_match_patch();
  // No time limit. It is one character per line, so it is small, and a limit
  // would make which regions exist depend on the clock.
  dmp.Diff_Timeout = 0;
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(base, text);
  if (chars1.length !== baseLines.length || chars2.length !== sideLines.length) return undefined;
  if (lineArray.length > 65535) return undefined;
  const diff = dmp.diff_main(chars1, chars2, false);

  const hunks: Hunk[] = [];
  let b = 0;
  let s = 0;
  let open: { start: number; from: number } | undefined;
  const close = () => {
    if (open === undefined) return;
    hunks.push({ mine, start: open.start, end: b, text: sideLines.slice(open.from, s).join("") });
    open = undefined;
  };
  for (const [op, encoded] of diff) {
    const n = encoded.length;
    if (op === EQUAL) {
      close();
      b += n;
      s += n;
    } else {
      open ??= { start: b, from: s };
      if (op === DELETE) b += n;
      else s += n;
    }
  }
  close();
  return hunks;
}

/**
 * The ancestor split into regions, or undefined when the line diff could not be
 * trusted to describe it.
 *
 * Two hunks share a region when they overlap in the ancestor, or when both are
 * insertions at the same point. Touching is not overlapping: an insertion at the
 * edge of what the other device deleted is one device adding a first item while
 * the other removes the old one, and that is a merge, not a collision. Two
 * insertions at one point are the daily note, and they share a region so that
 * the character merge decides whether they read as two lines or as one run-on,
 * which is the same question merge.ts leaves to it everywhere else.
 *
 * Regions come out in ancestor order and cover it completely, so a caller that
 * concatenates them gets a file back.
 */
export function regions(base: string, mine: string, theirs: string): Region[] | undefined {
  const baseLines = splitLines(base);
  const left = side(base, baseLines, mine, true);
  const right = side(base, baseLines, theirs, false);
  if (left === undefined || right === undefined) return undefined;

  // Insertions before replacements at one point, so that a line added before
  // ancestor line p comes out before the rewrite of line p rather than after it.
  const all = [...left, ...right].sort(
    (a, b) => a.start - b.start || a.end - a.start - (b.end - b.start),
  );

  // Where each line of the ancestor begins, so a region can name its offset.
  const offsets = [0];
  for (const line of baseLines) offsets.push(offsets[offsets.length - 1]! + line.length);

  const out: Region[] = [];
  let at = 0; // the first ancestor line not yet in a region
  const stable = (upto: number) => {
    if (upto <= at) return;
    const text = baseLines.slice(at, upto).join("");
    out.push({
      changed: "none",
      base: text,
      mine: text,
      theirs: text,
      at: offsets[at]!,
      firstLine: at,
      lastLine: upto,
    });
    at = upto;
  };

  for (let i = 0; i < all.length;) {
    const first = all[i]!;
    let end = first.end;
    let j = i + 1;
    while (j < all.length) {
      const next = all[j]!;
      const overlaps = next.start < end;
      const bothPoints = next.start === next.end && next.start === first.start && first.end === end;
      if (!overlaps && !(bothPoints && end === first.start)) break;
      end = Math.max(end, next.end);
      j++;
    }
    const group = all.slice(i, j);
    const start = first.start;
    const mineHunks = group.filter((h) => h.mine);
    const theirHunks = group.filter((h) => !h.mine);
    // What one side holds where this region's ancestor lines were: its hunks
    // laid over the ancestor, with the ancestor's own lines wherever that side
    // changed nothing. Built from the hunks rather than read out of the side's
    // text by an index, because an index into the side is exactly what is not
    // available at the end of a file: a line appended there and a line
    // rewritten there both sit at the last ancestor position, and reading a
    // span by index emitted the appended line twice (fuzz case 1588258344,
    // where `MINE LINE 1` came out of both this region and the one after it).
    const span = (hunks: Hunk[]): string => {
      let out = "";
      let at = start;
      for (const h of hunks) {
        out += baseLines.slice(at, h.start).join("") + h.text;
        at = h.end;
      }
      return out + baseLines.slice(at, end).join("");
    };
    stable(start);
    out.push({
      changed:
        mineHunks.length > 0 && theirHunks.length > 0
          ? "both"
          : mineHunks.length > 0
            ? "mine"
            : "theirs",
      base: baseLines.slice(start, end).join(""),
      mine: span(mineHunks),
      theirs: span(theirHunks),
      at: offsets[start]!,
      firstLine: start,
      lastLine: end,
    });
    at = end;
    i = j;
  }
  stable(baseLines.length);
  return out;
}
