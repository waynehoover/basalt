/**
 * Three-way text merge, and the one place Basalt deliberately behaves worse than
 * Obsidian in order to behave correctly.
 *
 * Two merges live here, and the order they are written in is the order they
 * were built in. `mergeTextCharacters` is the character merge, which is most of
 * this file and every one of the seven checks below. `mergeText`, near the
 * bottom, is what a note actually goes through: it splits the ancestor into
 * diff3's regions and runs the character merge inside one of them at a time.
 * Read this header for what the character merge is doing and why it needs the
 * checks; read `mergeText` for what changed and what it was measured to be
 * worth. The character merge is still called on a whole file when a note has no
 * line structure to compute, so nothing here is dead.
 *
 * ## The construction, and the defect it inherits
 *
 * Obsidian's merge is diff-match-patch used the way its own documentation shows,
 * verified by reading `app.js:118574` in the released application. Four steps:
 * diff the ancestor against the local side; if the diff has more than two edits,
 * run `diff_cleanupSemantic` and then `diff_cleanupEfficiency` over it; build
 * patches from it with `patch_make`; apply them to the incoming side.
 *
 * `patch_apply` returns `[text, appliedFlags]`, and theirs returns index 0.
 * Discarding index 1 discards which hunks applied, so a hunk that could not be
 * placed is dropped and the result is returned as though it had succeeded. That
 * is a lost edit, reported as a success, which is the failure this project
 * exists to prevent.
 *
 * Every other step is right and is kept, including the two cleanup passes, which
 * make a merge read the way a human would write it. Dropping them would make our
 * merges worse in a way unrelated to the bug.
 *
 * ## What this does instead
 *
 * The flags are checked, and any failure abandons the merge. The caller then
 * keeps both versions, one as a conflict copy. A visible duplicate is a small
 * annoyance; a silently mangled note is not.
 *
 * And then the outcome is verified rather than trusted. The flags are the
 * library's claim about its own work; what matters is the property, which is
 * that no local edit vanished. So every insertion the patch was built from is
 * checked to be present in the result. Rule 4 of docs/design.md is about
 * exactly this distance between an exit code and an outcome, and rule 10 is
 * about asserting the property that matters rather than a proxy for it: a
 * conflict test that asserts two devices *agree* passes while one side's edit
 * has silently vanished.
 *
 * Which turned out not to be enough on its own, and finding that out is the
 * reason this module is longer than a wrapper. diff-match-patch has no notion of
 * a conflicting region: it fuzzy-matches each hunk and says whether it landed
 * somewhere. So two devices rewriting one sentence differently both "apply",
 * and the result is a sentence neither of them wrote, with every insertion
 * present and the meaning destroyed. `conflictingSpans` is the check diff3 and
 * git make and this library does not, and it runs before anything is applied.
 *
 * ## The fourth failure, and why the merge runs twice
 *
 * Three checks were not enough, and the fourth one is the interesting one.
 *
 * `patch_apply` matches each hunk into the target by fuzzy search. In repetitive
 * content it can find somewhere that looks like the right place and is not.
 * Observed, with the real library, on a note of twelve similar sections: a local
 * edit to section 3 landed on section 6. Every flag true. The inserted text
 * present. The regions did not overlap. Every check above passes and the note is
 * wrong.
 *
 * So the merge is computed both ways round, and the two results must hold the
 * same lines. Applying the remote change to the local file has no reason to make
 * the same mistake as applying the local change to the remote file, so a
 * misplacement shows up as a disagreement about *which* lines exist.
 *
 * Same lines rather than the same string, because the two orders legitimately
 * differ in one common case: two devices each appending to a daily note. Nothing
 * is lost either way and only the order is arbitrary, so demanding identical
 * output would produce a conflict copy a day. A misplaced hunk changes which
 * lines exist, not their order, so the weaker comparison still catches it.
 *
 * ## The three the fuzzer found, and what a fuzzer is for here
 *
 * The four above each came from a note going wrong. Three more came from
 * merge.fuzz.test.ts, which generates the shapes nobody thought of and holds
 * the outcome to two properties: that a merge of edits on different lines is
 * the merge of those edits, and that every word in the result is a word
 * somebody wrote. All three are the same failure as the overlap check exists
 * for, a line or a word neither device wrote, reached by routes the overlap
 * check cannot see, because it compares spans and spans can miss each other by
 * one character.
 *
 * `fusedLine` is an added line whose only separator the other device deleted.
 * `splicedAdditions` is two devices rewriting one line with a space left
 * between their spans, so the two rewrites run together. `inventedWord` is the
 * outcome check under all of it: a word in the result that none of the three
 * versions holds. Each is documented where it is defined, with the case that
 * produced it and the cases that must go on merging.
 *
 * ## Which check catches what, measured
 *
 * Each of these was disabled in turn to find out, rather than reasoned about:
 *
 *   - **Overlapping regions** catches exactly one thing the rest do not: two
 *     sides rewriting the same sentence differently. diff-match-patch splices
 *     those, and it does so symmetrically, so merging both ways round gives the
 *     same mangled answer and the two-directions check sees nothing wrong.
 *   - **Two directions** catches a misplaced hunk, and catches two additions at
 *     one point that do not concatenate cleanly. Disabling it leaves four tests
 *     failing.
 *   - **The applied flags** catch nothing any constructed input reaches: with
 *     non-overlapping regions, `patch_apply` placed every hunk in every case
 *     tried, including with all four lines of context either side destroyed.
 *   - **Insertion survival** likewise. It is a check on the library's own report.
 *   - **fusedLine** catches a splice both directions agree on. Disabling it
 *     leaves two tests failing and, with `inventedWord` still in place, one
 *     generated case in a hundred thousand: a run-on of two real lines, where
 *     no single word is wrong.
 *   - **splicedAdditions** catches two rewrites of one line whose spans miss
 *     each other. Disabling it leaves two tests failing, and nothing else sees
 *     those: every word in the result is somebody's.
 *   - **inventedWord** catches a splice inside a word, which no span check
 *     sees because both spans are innocent. Disabling it leaves three tests
 *     failing.
 *
 * The applied flags and insertion survival stay for the cost of a comparison
 * over data already at hand, and because the flags are the precise defect this
 * module exists to invert. What is not done is pretending they are tested.
 *
 * ## Why not node-diff3, which is the algorithm git uses
 *
 * `node-diff3` (3.2.1, June 2026, pure JS) does a real three-way merge with
 * proper conflict regions, which is precisely the notion diff-match-patch lacks
 * and which the checks above exist to reconstruct. On the face of it, it should
 * replace all of them.
 *
 * It was tried against the cases in merge.test.ts. It conflicted on five of the
 * eight that merge cleanly here, and caught nothing that the checks above miss:
 *
 *   - two devices appending to a daily note
 *   - two devices inserting at the same point
 *   - two words changed in one long paragraph
 *   - two words changed in one sentence
 *
 * The reason is granularity. diff3 is line-wise, and a Markdown paragraph is one
 * line, so any two edits to one paragraph collide. Basalt's notes are prose,
 * where that is the common case rather than the rare one, and it would mean a
 * conflict copy most days for the most ordinary thing two devices do.
 *
 * That is still true of diff3 whole, and it is why `mergeText` takes diff3's
 * regions and not its answer: a region both devices touched goes to the
 * character merge instead of to a conflict marker. The library is still not
 * used, because what was wanted from it is a hundred and twenty-five lines of
 * code and the diff it needs is already in the bundle; see merge-regions.ts.
 *
 * diff-match-patch has shipped nothing since 2020, which is a risk this file
 * carries knowingly, and one that regions reduce rather than remove: the fuzzy
 * matcher now searches a few lines instead of a note.
 *
 * ## Where this sits between the two predecessors
 *
 * Obsidian merges silently and drops what does not fit. LiveSync mostly opens a
 * dialog and asks (`ModuleConflictResolver`), falling back to newest-wins for
 * binaries and identical content. Basalt merges when it is clean and keeps both
 * when it is not, and never asks: there is no settings screen and no decision to
 * put in front of someone who wanted to write a note.
 */

import { diff_match_patch, type Diff } from "diff-match-patch";

import { regions } from "./merge-regions.ts";
import { splitName } from "./paths.ts";

/** diff-match-patch's operation codes, named so the intent is readable. */
const DELETE = -1;
const EQUAL = 0;
const INSERT = 1;

/**
 * A region of the base that one side changed, in base coordinates.
 *
 * `start === end` is an insertion point: nothing was removed, text was added
 * there, and `text` is what was added. A wider span is text that was deleted
 * or replaced, and `text` is what was removed.
 */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * The regions of the base a diff changes.
 *
 * Replacements arrive from diff-match-patch as a delete next to an insert, so
 * they produce a wide span and a point at the same place. Both are kept: they
 * describe the same edit and neither is wrong.
 */
function changedSpans(diff: Diff[]): Span[] {
  const spans: Span[] = [];
  let at = 0;
  for (const [op, text] of diff) {
    if (op === EQUAL) {
      at += text.length;
    } else if (op === DELETE) {
      spans.push({ start: at, end: at + text.length, text });
      // Deleted text still occupied space in the base, so the cursor has
      // to move past it or every later span is recorded too early. No test
      // reaches this on its own any more: the two-directions check catches
      // whatever a wrong offset lets through, and the tests for ordinary
      // merges catch a wrong offset that invents a collision.
      at += text.length;
    } else {
      spans.push({ start: at, end: at, text });
    }
  }
  return spans;
}

/**
 * Whether two sides changed regions that cannot both be honoured.
 *
 * This is the check diff3 and git perform and that diff-match-patch does not.
 * `patch_apply` has no notion of a conflicting region at all: it fuzzy-matches
 * each hunk into the target and reports whether it found somewhere to put it. So
 * two devices rewriting the same sentence differently do not fail, they get
 * spliced, and the result is a sentence neither person wrote.
 *
 * Observed, with the real library:
 *
 * ```
 * base   The original sentence.
 * mine   My completely different sentence.
 * theirs Their entirely other sentence.
 * merged My completely different entirely other sentence.
 * ```
 *
 * Every hunk applied, every insertion is present, and the meaning is gone. So
 * "no edit was lost" is necessary and not sufficient, and this is the check that
 * covers the rest.
 *
 * Two additions at the same offset are not a collision here. Nothing was
 * destroyed, so this check has nothing to say about them, and the two-directions
 * check below decides whether concatenating them reads as two additions or as
 * one mangled sentence. An earlier version tried to make that call here by
 * asking whether the offset was at a line boundary; it gave the same answers and
 * needed a concept of its own to do it.
 *
 * An addition at the *edge* of text the other side removed is not a collision
 * here either, and one shape of it is refused: see `fusedLine`.
 */
function conflictingSpans(mine: Span[], theirs: Span[]): Span | undefined {
  for (const l of mine) {
    for (const r of theirs) {
      const lPoint = l.start === l.end;
      const rPoint = r.start === r.end;
      // Two additions at one point are never a collision here, whether
      // they land on a line boundary or inside a sentence. Nothing was
      // destroyed, so this check has nothing to say about them; whether
      // concatenating them reads as two additions or as one mangled
      // sentence is decided by the two-directions check below, which
      // catches the mangled case and lets the daily-note case through.
      if (lPoint && rPoint) continue;
      if (lPoint) {
        // An insertion into text the other side removed.
        if (r.start < l.start && l.start < r.end) return l;
        continue;
      }
      if (rPoint) {
        if (l.start < r.start && r.start < l.end) return r;
        continue;
      }
      if (l.start < r.end && r.start < l.end) return l;
    }
  }
  return undefined;
}

/**
 * The first added run that would no longer be a line of its own once the other
 * side's changes are applied around it, or undefined if every one keeps its
 * boundaries.
 *
 * Touching is not overlapping, and an addition next to a deletion is usually
 * fine: one device appends to a list while the other removes the last item, or
 * adds a first item while the other removes the old first one. Those merge, and
 * must go on merging. The exception is a blank line. It has no inside, so
 * writing into it is, in character terms, an addition at the edge of the one
 * newline that gave it its width, and if the other device deleted that blank
 * line the new line has lost the only separator it had:
 *
 * ```
 * base    line text here.\n\nhere again.\n
 * mine    line text here.\nmine0\nhere again.\n
 * theirs  line text here.\nhere again.\n
 * merged  line text here.\nmine0here again.\n
 * ```
 *
 * Found by the token property of merge.fuzz.test.ts, not constructed. Every
 * hunk applied, every addition is present, and both directions agree on the
 * run-on, so this is the one place the two-directions check does not decide
 * whether two edits concatenate cleanly, and the line-boundary concept it was
 * spared has to be asked here after all. Rule 10: a line neither device wrote
 * is a lost edit, whatever the flags say.
 *
 * The question asked is the general one, because the first version asked a
 * narrower one and the fuzzer went straight past it (case 1588232853): what
 * follows an addition after the merge need not be a character of the ancestor,
 * it can be the other side's own addition at the far end of what it deleted.
 * So, for each run one side added: if in that side's own version it began a
 * line without bringing the newline itself, then after the merge whatever can
 * precede it must still be a line end, and likewise at the back. What can
 * precede it is found by walking back over every deletion of either side that
 * ends there, and includes the other side's additions at that point, because
 * the order of two additions at one point is the one thing this module leaves
 * open. A run that sat mid-line, or brings its own newline, asks nothing, so
 * two devices editing one sentence at different words still merge.
 *
 * Pinned in merge.test.ts under "an addition whose separator the other side
 * deleted", alongside the adjacent shapes that must keep merging.
 */
function fusedLine(base: string, own: Span[], other: Span[]): Span | undefined {
  const boundary = (i: number) => i < 0 || i >= base.length || base[i] === "\n";
  const ownDeletions = own.filter((s) => s.start < s.end);
  const allDeletions = [...ownDeletions, ...other.filter((s) => s.start < s.end)];
  const otherAdditions = other.filter((s) => s.start === s.end);

  // Where a walk from `at` over deleted text comes to rest, in each direction.
  const after = (at: number, deletions: Span[]): number => {
    const d = deletions.find((s) => s.start === at);
    return d === undefined ? at : after(d.end, deletions);
  };
  const before = (at: number, deletions: Span[]): number => {
    const d = deletions.find((s) => s.end === at);
    return d === undefined ? at : before(d.start, deletions);
  };

  for (const p of own) {
    if (p.start !== p.end) continue;
    if (!p.text.startsWith("\n") && boundary(before(p.start, ownDeletions) - 1)) {
      // It began a line in its own version. Whatever can come before it
      // after the merge has to end one.
      const at = before(p.start, allDeletions);
      if (!boundary(at - 1)) return p;
      for (const q of otherAdditions) {
        if (at <= q.start && q.start <= p.start && !q.text.endsWith("\n")) return p;
      }
    }
    if (!p.text.endsWith("\n") && boundary(after(p.start, ownDeletions))) {
      // It ended a line in its own version. Whatever can come after it
      // after the merge has to begin one.
      const at = after(p.start, allDeletions);
      if (!boundary(at)) return p;
      for (const q of otherAdditions) {
        if (p.start <= q.start && q.start <= at && !q.text.startsWith("\n")) return p;
      }
    }
  }
  return undefined;
}

/**
 * The first addition that the merge would join to the other device's addition,
 * making one line neither device wrote, or undefined if none would.
 *
 * `conflictingSpans` asks about characters, and two devices rewriting the same
 * line can leave spans that miss each other. Found by the fuzzer's placed
 * property (case 1588304879), on a three-item list where each device rewrote a
 * different bullet and the bullets were next to each other:
 *
 * ```
 * base    - here\n- line sync\n- line
 * mine    - here\n- mine line here 1\n- line sync\nmine0 line
 * theirs  theirs added 0\ntheirs1 line sync\n- line
 * merged  theirs added 0\ntheirs1 mine line here 1\n- line sync\nmine0 line
 * ```
 *
 * `theirs1 mine line here 1` is a line neither device wrote, and `- line sync`,
 * the line theirs meant to rewrite, is left exactly as the ancestor had it. The
 * spans miss each other by the single space after a bullet: theirs deleted
 * `- here\n-` and mine deleted `line sync\n-`, so nothing overlaps, both
 * directions agree, every hunk lands and every insertion is present. This is
 * the failure the module's second paragraph promises to catch, escaping through
 * a one-character gap.
 *
 * So: two additions, one from each device, that end up on one line with only
 * spaces of the ancestor left between them are refused, but only when a
 * deletion across that gap took a newline with it. Both halves are needed and
 * both were measured:
 *
 *   - Without the gap test, two devices changing different words of one
 *     paragraph would be refused, which is the thing diff3 was rejected for.
 *   - Without the newline test, two devices changing *adjacent* words would be
 *     refused: `The cat sat.` against `The dog sat.` and `The cat ran.` leaves
 *     one space between the two edits and merges to `The dog ran.`, which is
 *     what both people meant. What makes the case above different is that the
 *     deletions took line ends with them, so the text each addition was written
 *     against is not merely edited, it is somewhere else.
 *
 * Two additions at one point are the other half of the same question. That is
 * the daily note when both are whole lines, so it stays a merge, and it is two
 * devices rewriting one word when either of them also took text away there
 * (case 3869976870, `- the the` against `- mine1 the` and `- theirs0 the`,
 * where theirs shares the opening letters and so deletes nothing, arriving at
 * exactly the point mine's replacement arrives at). Both orders have to keep
 * the two apart, because which comes first is the one thing this module leaves
 * open.
 *
 * What this does not close is written down rather than guessed at. The same
 * shape with ancestor text left standing between the two edits, where that
 * text is then absorbed into a word of the other side's insertion, still
 * merges wrongly at about two cases in a hundred thousand. It is described
 * with a reproduction in the header of merge.fuzz.test.ts, along with the rule
 * that would refuse it and what that rule was measured to cost.
 *
 * Pinned in merge.test.ts under "two rewrites of one line that miss each
 * other", with the adjacent-words merge and the daily note next to it.
 */
function splicedAdditions(base: string, mine: Span[], theirs: Span[]): Span | undefined {
  const points = (spans: Span[]) => spans.filter((s) => s.start === s.end);
  const mineAdds = points(mine);
  const theirAdds = points(theirs);
  if (mineAdds.length === 0 || theirAdds.length === 0) return undefined;
  const deletions = [...mine, ...theirs].filter((s) => s.start < s.end);
  if (deletions.length === 0) return undefined;

  // What of the ancestor is left between two points, counted from the start so
  // that asking is a subtraction rather than a scan. Spaces and tabs do not
  // count: they are what two texts joined on one line are separated by.
  const gone = new Uint8Array(base.length);
  for (const d of deletions) gone.fill(1, d.start, d.end);
  const kept = new Int32Array(base.length + 1);
  for (let i = 0; i < base.length; i++) {
    const c = base[i]!;
    kept[i + 1] = kept[i]! + (gone[i] === 1 || c === " " || c === "\t" ? 0 : 1);
  }

  // Whether `x` followed by `y` puts a line end between them.
  const apart = (x: Span, y: Span) => x.text.endsWith("\n") || y.text.startsWith("\n");

  for (const l of mineAdds) {
    for (const r of theirAdds) {
      const [first, second] = l.start <= r.start ? [l, r] : [r, l];
      if (first.start === second.start) {
        // Two additions at one point, which is the daily note when both are
        // whole lines, and is two devices rewriting one word when one of them
        // also took text away there. The order is arbitrary, so both orders
        // have to keep them apart.
        if (apart(first, second) && apart(second, first)) continue;
        if (deletions.some((d) => d.start <= first.start && d.end >= first.start)) return first;
        continue;
      }
      // Both orders, not just the one their offsets suggest. With nothing of
      // the ancestor left between them the merge can put either first, and
      // does: case 16087566 has theirs' whole line, newline and all, arriving
      // after mine's word rather than before it.
      if (apart(first, second) && apart(second, first)) continue;
      if (kept[second.start]! - kept[first.start]! > 0) continue;
      const structural = deletions.some(
        (d) => d.start <= second.start && d.end >= first.start && d.text.includes("\n"),
      );
      if (structural) return first;
    }
  }
  return undefined;
}

export type MergeOutcome =
  /** Nothing to do: the two sides already agree, or only one of them moved. */
  | { readonly kind: "take"; readonly text: string; readonly why: string }
  /** A clean three-way merge, verified to contain both sides' edits. */
  | { readonly kind: "merged"; readonly text: string }
  /**
   * Not merged, and deliberately so. The caller keeps both versions rather
   * than choosing, and `why` is for the human who finds the conflict copy.
   */
  | { readonly kind: "conflict"; readonly why: string };

/**
 * The character-level merge, which is the fallback and was for a long time the
 * whole of this module.
 *
 * Everything above describes it. It looks at the note as one string, and where
 * a change goes is decided by `patch_apply`'s fuzzy search over that string,
 * which is what the seven checks are for. `mergeText` now runs it only inside
 * one region of a note, where the search has almost nothing to search; it is
 * still called on a whole file when the line structure cannot be computed, and
 * it is still tested as a merge in its own right, because it is what the note
 * falls back to.
 */
export function mergeTextCharacters(
  base: string,
  mine: string,
  theirs: string,
  /**
   * Whether the merged text is still the kind of thing it was.
   *
   * For prose there is nothing to ask: any arrangement of lines is a valid
   * note. For a structured file there is, and a line-wise merge does not know
   * it: two edits to different parts of a canvas can each apply cleanly and
   * leave JSON that does not parse, which Obsidian then refuses to open. The
   * four checks below all pass, because nothing was lost and nothing
   * collided; the file is simply no longer a canvas.
   *
   * Reported against Sync Engine's neighbours as an overwrite risk on canvas
   * files, and found here by reading their issues rather than by anything
   * failing.
   */
  stillValid: (text: string) => boolean = () => true,
): MergeOutcome {
  return mergeCore(base, mine, theirs, stillValid, 0);
}

/**
 * The merge above, told where in a larger file it is happening.
 *
 * `at` is added to every character offset a refusal names, and is zero for a
 * whole file. It is not zero when `mergeTextHybrid` runs this inside one region
 * of a note, where an offset counted from the region would send somebody
 * looking in the wrong place. Nothing else about the merge changes.
 */
function mergeCore(
  base: string,
  mine: string,
  theirs: string,
  stillValid: (text: string) => boolean,
  at: number,
): MergeOutcome {
  if (mine === theirs) {
    return { kind: "take", text: mine, why: "both sides already agree" };
  }
  if (base === mine) {
    // Local never diverged from the ancestor, so the incoming version is
    // simply newer. Nothing to merge and nothing at risk.
    return { kind: "take", text: theirs, why: "no local change since the last sync" };
  }
  if (base === theirs) {
    // The incoming version *is* the ancestor, so only local moved.
    return { kind: "take", text: mine, why: "no remote change since the last sync" };
  }

  const dmp = new diff_match_patch();
  const diff = dmp.diff_main(base, mine, true, 0);
  if (diff.length > 2) {
    // Both passes, as Obsidian does. They do not change what the patch
    // means, they change how the result reads.
    dmp.diff_cleanupSemantic(diff);
    dmp.diff_cleanupEfficiency(diff);
  }

  // Refuse before attempting anything, when both sides changed the same text.
  // patch_apply would succeed and splice them together; see conflictingSpans.
  const theirDiff = dmp.diff_main(base, theirs, true, 0);
  if (theirDiff.length > 2) {
    dmp.diff_cleanupSemantic(theirDiff);
    dmp.diff_cleanupEfficiency(theirDiff);
  }
  const mineSpans = changedSpans(diff);
  const theirSpans = changedSpans(theirDiff);
  const collision = conflictingSpans(mineSpans, theirSpans);
  if (collision !== undefined) {
    return {
      kind: "conflict",
      why:
        `both devices changed the same text, at characters ` +
        `${at + collision.start} to ${at + collision.end} of the last synced version`,
    };
  }

  // Also before applying anything: an added line whose separator the other
  // side removed would be spliced onto its neighbour, and both directions
  // agree on the splice, so nothing later would notice. See fusedLine.
  const fused = fusedLine(base, mineSpans, theirSpans) ?? fusedLine(base, theirSpans, mineSpans);
  if (fused !== undefined) {
    return {
      kind: "conflict",
      why:
        `a line added on one device would run into text changed on the other, ` +
        `at character ${at + fused.start} of the last synced version`,
    };
  }

  // And still before applying anything: two additions that would land on one
  // line with only a space of the ancestor between them. See splicedAdditions.
  // One call, not two: unlike fusedLine this asks about a pair, so swapping
  // the sides asks the same question.
  const spliced = splicedAdditions(base, mineSpans, theirSpans);
  if (spliced !== undefined) {
    return {
      kind: "conflict",
      why:
        `each device rewrote the same line differently, and the two rewrites ` +
        `would run together at character ${at + spliced.start} of the last synced version`,
    };
  }

  // No guard on an empty patch list. A non-empty diff always produces at
  // least one patch, and if it ever did not, the result would simply be
  // `theirs` and the insertion check below is exactly what notices that.
  // Merge in both directions and require the same answer.
  //
  // This is what catches a misplaced hunk, and a misplaced hunk is a real
  // thing patch_apply does: its matcher is fuzzy, so in repetitive content it
  // will find somewhere that *looks* like the right place and report success.
  // Observed, with the real library, on a note of twelve similar sections:
  // a local edit to section 3 landed on section 6, every flag true, the
  // inserted text present, and the note wrong.
  //
  // Neither the overlap check nor the insertion check sees that, because
  // nothing was lost and nothing collided. What does see it is asking the
  // question the other way round: applying the *remote* change to the *local*
  // file has no reason to make the same mistake, so the two results diverge.
  // A merge worth having is one that does not depend on which side you start
  // from.
  const forward = applyOneWay(dmp, base, diff, theirs);
  const reverse = applyOneWay(dmp, base, theirDiff, mine);

  if (forward.failed > 0 || reverse.failed > 0) {
    const failed = Math.max(forward.failed, reverse.failed);
    const total = Math.max(forward.total, reverse.total);
    return {
      kind: "conflict",
      why: `${failed} of ${total} changes could not be placed in the other version`,
    };
  }

  if (!samePlacement(base, forward.text, reverse.text)) {
    return {
      kind: "conflict",
      why: "merging the two versions in either order gives different content, so at least one change was placed wrongly",
    };
  }

  // Both directions agree and every hunk was placed. That is the library's
  // account of its own work, twice over, so check the thing that matters.
  const missing = missingInsertions(diff, forward.text);
  if (missing !== undefined) {
    return {
      kind: "conflict",
      why: `the merge reported success but ${describe(missing)} is not in the result`,
    };
  }

  // And the same question the fuzzer asks of a whole note, asked of this one:
  // is every word in the result a word somebody wrote. See inventedWord.
  const invented = inventedWord(base, mine, theirs, forward.text);
  if (invented !== undefined) {
    return {
      kind: "conflict",
      why:
        `the merge produced ${JSON.stringify(invented.slice(0, 40))}, ` +
        `which is not a word in the last synced version or in either device's`,
    };
  }

  if (!stillValid(forward.text)) {
    return {
      kind: "conflict",
      why: "both sides merged cleanly and the result is no longer a valid file of its kind",
    };
  }

  // The forward result, which is the local changes applied to the incoming
  // version. When the two directions agree on the lines and differ only in
  // their order, one of them has to be picked; arbitrary, and fixed, which is
  // what matters.
  return { kind: "merged", text: forward.text };
}

/**
 * Merges `mine` and `theirs` over their common ancestor `base`.
 *
 * `base` is the content as of the last successful sync, which the local index
 * remembers as one hash per file. That single field is the most useful idea in
 * Obsidian's engine: it turns a three-way merge into something that needs no
 * version history at all.
 *
 * ## Regions, and why the merge no longer searches the note for a place to put
 * things
 *
 * Everything above reconstructs, from character spans, the one notion
 * diff-match-patch does not have: which stretch of the note each device
 * changed. Seven checks, each one a note or a fuzz case that went wrong first.
 * They work. What they are working around is that `patch_apply` decides where a
 * change goes by fuzzy search over the whole file, and a search over a whole
 * file can land in the wrong section. After that, every check is asking whether
 * a wrong answer looks wrong.
 *
 * diff3 does not search. It diffs both sides against the ancestor by lines and
 * cuts the ancestor into stretches: untouched, changed by one device, changed by
 * both. A change belongs to one stretch and cannot move to another, because
 * nothing looks for it a second time. merge-regions.ts computes that, and this
 * is what it is for.
 *
 * A stretch one device changed is **copied** from that device. No patch, no
 * matcher, no fuzz: the only decision anybody made about those lines was which
 * stretch they belong to, and the line diff made it. A stretch both devices
 * changed is the case plain diff3 gives up on, and giving up on it is why
 * node-diff3 was rejected here, because in prose it is two people editing one
 * paragraph. So that is the one place the character merge runs, on those few
 * lines, with all seven checks and nothing else in the file to misplace
 * anything into.
 *
 * ## Why checking the seams is enough
 *
 * The merged pieces are concatenated, and concatenation is where a merge invents
 * a line. So every piece but the last has to end a line. With that held, no line
 * and no word can span two pieces, because `\n` ends both, which is why the word
 * check inside a region is enough for the whole note and there is no second one
 * out here: a word the merge invented would have to be inside some region, and
 * that region already refused it against a smaller vocabulary than the note's.
 *
 * Without the seam check, the case that made `fusedLine` necessary walks
 * straight back in: one device writes into a blank line the other removed, the
 * region merges to a line with no newline left, and the next region runs into
 * it. Pinned in merge.test.ts under "merging inside line regions".
 *
 * ## What it is worth, measured
 *
 * merge.fuzz.run.ts, a million generated cases per mode, both merges on the same
 * seeds. Per hundred thousand cases:
 *
 * ```
 *                       merged   conflicts   defects
 *   placed   character  70,184      29,816       1.8
 *            regions    94,519       5,481       1.6
 *   tokens   character  57,321      42,679       0.2
 *            regions    85,266      14,734       0.1
 * ```
 *
 * A defect is a `merged` outcome whose text is not a merge of what the two
 * devices wrote, which is the only number that decides anything; the merge rate
 * is the number a person sees, because every conflict is a duplicate file
 * somebody has to reconcile by hand. Both improve, which is unusual enough to
 * be suspicious of, so the rest of this is what was done about the suspicion.
 *
 * The residue is not the same residue, and that matters more than the counts.
 * Over 300,000 cases of the oracle mode, all four of the character merge's
 * defects are a line neither device wrote, which is the failure this module
 * exists to prevent. Neither of the region merge's two is: every line in them is
 * some device's own line, and what is wrong is that an added line sits against
 * the wrong paragraph, in ancestors that genuinely read two ways. The one
 * documented in merge.fuzz.ts, where `mine1` lands on the other device's new
 * line, is gone; it now merges, correctly.
 *
 * The oracle's own bias is the thing to be honest about: the placed mode judges
 * a merge by applying two line-level edit scripts, which is close to what this
 * merge computes, so "fewer defects there" is weaker evidence for it than the
 * same number would be for the character merge. Three things that are not
 * circular say the same: the token mode has no model of a merge at all and finds
 * nothing; swapping the two devices over and merging again changes the lines in
 * neither merge, in 200,000 cases of each mode, which is the one property here
 * with no notion of a right answer behind it; and the four cases in
 * merge.test.ts that used to be refusals are now exact texts, checked by hand
 * against what the two devices meant.
 *
 * It is also about twice as fast on a large note, because two line diffs and a
 * handful of tiny merges cost less than four whole-file patch applications.
 *
 * ## What it costs, which is not nothing
 *
 * A merge that refuses less is a merge that decides more. Three specific things
 * to know:
 *
 *   - Where the ancestor reads two ways, the line diff picks one, and the merge
 *     is right about that reading rather than about what somebody meant. That is
 *     the whole of the remaining residue.
 *   - A device that deletes a whole paragraph while the other appends to the end
 *     now merges to the appended line, where the character merge kept both
 *     copies. Both edits are honoured and the note is much smaller. Rule 5 says
 *     a result smaller than its input is a bug until shown otherwise; here it is
 *     shown, by the device that did the deleting, and it is still the shape most
 *     worth watching.
 *   - The order of two lines added at one point can differ from what the
 *     character merge chose. Either is defensible, both devices compute the same
 *     one, and the daily note is pinned in merge.test.ts so a change to it is a
 *     deliberate act.
 */
export function mergeText(
  base: string,
  mine: string,
  theirs: string,
  stillValid: (text: string) => boolean = () => true,
): MergeOutcome {
  if (mine === theirs) {
    return { kind: "take", text: mine, why: "both sides already agree" };
  }
  if (base === mine) {
    return { kind: "take", text: theirs, why: "no local change since the last sync" };
  }
  if (base === theirs) {
    return { kind: "take", text: mine, why: "no remote change since the last sync" };
  }

  const parts = regions(base, mine, theirs);
  // The line encoding could not describe this file, which means there are no
  // regions to work in. Rule 2: an answer that could not be computed is not an
  // empty answer, so this falls back to the merge that needs no line structure
  // rather than pretending the note is one region.
  if (parts === undefined) return mergeTextCharacters(base, mine, theirs, stillValid);

  const pieces: string[] = [];
  for (const region of parts) {
    if (region.changed === "none") pieces.push(region.base);
    else if (region.changed === "mine") pieces.push(region.mine);
    else if (region.changed === "theirs") pieces.push(region.theirs);
    else if (region.base === "" && region.mine === region.theirs) {
      // Two devices that added the same line at the same point made two
      // additions, not one agreement, and `mergeCore` would read the two
      // equal texts as agreement and keep one copy. That is a line a device
      // wrote and the merge did not, which is rule 5 in one line: a result
      // smaller than its input, with nothing to say it is right.
      //
      // Keeping both is also what the character merge already does whenever
      // any other edit is near enough to stop the two sides being identical
      // texts, so this is consistency rather than a new opinion; a duplicate
      // line is visible and a dropped one is not. Found by the token property
      // at five cases in a hundred thousand, all one shape, case 1588279904
      // among them, where the line diff read mine's copy as a line that had
      // moved. Pinned in merge.test.ts, "keeps both copies when both devices
      // added the same line".
      pieces.push(region.mine + region.theirs);
    } else {
      // The one place the character merge runs, and it sees this region and
      // nothing else, so a hunk it misplaces can only be misplaced within a
      // stretch both devices were editing. `stillValid` is asked of the whole
      // file at the end, not of a fragment that is not one.
      const inner = mergeCore(region.base, region.mine, region.theirs, () => true, region.at);
      if (inner.kind === "conflict") return inner;
      pieces.push(inner.text);
    }
  }

  // Every piece but the last has to end a line, or the next one runs into it.
  // This is the region equivalent of `fusedLine`, and it is needed for the same
  // reason: a device writing into a blank line the other device removed leaves
  // a region whose merge is a line with no newline left, and concatenating that
  // with the next region makes a line neither device wrote. Pinned in
  // merge.test.ts under "an addition whose separator the other side deleted"
  // and again as "refuses a region whose merge would run into the next region".
  //
  // The offset named is the seam, which is where the ancestor's own text ends
  // for the region that lost its newline, because that is the place a person
  // would go and look.
  for (let i = pieces.length - 1, seen = false; i >= 0; i--) {
    const piece = pieces[i]!;
    if (piece === "") continue;
    if (seen && !piece.endsWith("\n")) {
      const region = parts[i]!;
      return {
        kind: "conflict",
        why:
          `a change on one device would run into the next line, at character ` +
          `${region.at + region.base.length} of the last synced version`,
      };
    }
    seen = true;
  }

  const text = pieces.join("");
  if (!stillValid(text)) {
    return {
      kind: "conflict",
      why: "both sides merged cleanly and the result is no longer a valid file of its kind",
    };
  }
  return { kind: "merged", text };
}

/**
 * Whether two merges made the same changes to the ancestor, in the same places.
 *
 * Not string equality, and the reason is not a shortcut. Two devices appending
 * to the same daily note is the commonest concurrent edit there is, and it is
 * order-ambiguous: merging their change into mine puts theirs last, merging
 * mine into theirs puts mine last, and both are right. Comparing the strings
 * exactly turns that into a conflict, which was measured rather than guessed:
 * five tests fail, the daily note among them.
 *
 * The first version of this compared the two results as multisets of lines,
 * and documented what that gave up: a line moved to different places by the two
 * directions compares equal. That was written down as a narrow hole and it was
 * not one. The fuzzer in merge.fuzz.test.ts reached it within its first few
 * hundred cases, and a hand-built case followed: a line added under Item 3
 * lands under Item 6 when the other device has removed the first three
 * sections, the same misplacement the two-directions check exists to catch,
 * with the text of every line unchanged. The same happens to a deletion when
 * every section holds a copy of the deleted line. Both are in merge.test.ts
 * under "with every line still present".
 *
 * So each result is described by where it changed the ancestor: every line it
 * added, tagged with the ancestor line it was added before, and every ancestor
 * line it removed, by index. Two results agree when those descriptions agree.
 * Two additions at one point by the two sides carry the same tag whichever
 * comes first, so the daily note still merges; a line added under the wrong
 * section carries a different tag and does not.
 *
 * Which lines are added and removed is decided by a line-wise diff of the
 * ancestor against each result, run to completion with no time limit. It is
 * one character per line, so it is small, and a time limit would make the
 * answer depend on the clock. The alignment it picks is a choice, and when a
 * result repeats a line that was already there, the choice could in principle
 * differ between the two results and refuse a good merge. The pinned case of
 * appending a line identical to the last one is there to notice if it ever
 * does; refusing is the safe direction, and it has not.
 */
function samePlacement(base: string, a: string, b: string): boolean {
  if (a === b) return true;
  const x = placements(base, a);
  const y = placements(base, b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Every line `result` adds to or removes from `base`, each tagged with the
 * ancestor line it happened at, sorted so that two lists compare as multisets.
 */
function placements(base: string, result: string): string[] {
  const dmp = new diff_match_patch();
  dmp.Diff_Timeout = 0;
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(base, result);
  const diff = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diff, lineArray);

  const out: string[] = [];
  let at = 0;
  for (const [op, text] of diff) {
    // Each line keeps its newline, so a final line without one stays distinct.
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (op === EQUAL) {
      at += lines.length;
    } else if (op === DELETE) {
      for (const line of lines) out.push(`-${at++} ${line}`);
    } else {
      for (const line of lines) out.push(`+${at} ${line}`);
    }
  }
  return out.sort();
}

/** Applies one side's changes to the other, reporting how many hunks landed. */
function applyOneWay(
  dmp: InstanceType<typeof diff_match_patch>,
  base: string,
  diff: Diff[],
  onto: string,
): { text: string; failed: number; total: number } {
  const [text, applied] = dmp.patch_apply(dmp.patch_make(base, diff), onto);
  return { text, failed: applied.filter((ok: boolean) => !ok).length, total: applied.length };
}

/**
 * Returns the first inserted run absent from the merge result, or undefined if
 * every one survived.
 *
 * Every insertion is checked, including single characters. An earlier version
 * skipped runs under three characters on the grounds that a short string turns
 * up by chance anyway, which is true and is an argument for the check being
 * *weak* there, not for removing it. A hunk that applied put its text in the
 * result whatever its length; skipping short runs only hid whether it had.
 */
function missingInsertions(diff: Diff[], result: string): string | undefined {
  for (const [op, text] of diff) {
    if (op !== INSERT) continue;
    if (!result.includes(text)) return text;
  }
  return undefined;
}

/**
 * The first word in the result that none of the three versions contains, or
 * undefined if every word came from somewhere.
 *
 * Every check above asks about spans before anything is applied, and a span is
 * innocent when the damage is inside a word. diff-match-patch works in
 * characters, so a device rewriting a word into one that shares its opening
 * letters deletes nothing at all: `- the` becoming `- theirs0` is the four
 * characters `irs0` inserted after `- the`. If the other device then removes
 * the line those letters were leaning on, they land on whatever line is left:
 *
 * ```
 * base    - line here\n- note line\n- the
 * mine    - mine line line 0\n- line here
 * theirs  - line here\n- note line\n- theirs0
 * merged  - mine line line 0\n- line hereirs0
 * ```
 *
 * `hereirs0` is not a word anybody typed, and every span involved is somewhere
 * it is entitled to be. Found by the token property of merge.fuzz.test.ts
 * (cases 3869907292 and 3869956296), which is the same question asked of a whole
 * note, so asking it here holds every real merge to what the fuzzer holds a
 * generated one to. Rule 4 once more: the checks above are an account of the
 * work, and this is the outcome.
 *
 * The cost is measured rather than assumed. Two devices rewriting different
 * halves of one word can no longer merge, which changed one test: `abcdefghij`
 * against `ABCDEfghij` and `abcdeFGHIJ` used to give `ABCDEFGHIJ`. Prose does
 * not edit half a word, and over 400,000 generated merges this refused one
 * that the oracle called clean. What it buys is every splice that mangles a
 * word, which no span check can see.
 *
 * Not a replacement for `fusedLine`, which was tested against it: a run-on
 * whose two halves are each somebody's real words, `mine added 1 the theirs0`
 * from case 1588285323, has nothing wrong with any word in it.
 *
 * Pinned in merge.test.ts under "a word neither device wrote".
 */
function inventedWord(
  base: string,
  mine: string,
  theirs: string,
  merged: string,
): string | undefined {
  const known = new Set<string>();
  for (const text of [base, mine, theirs]) for (const word of text.split(/\s+/)) known.add(word);
  for (const word of merged.split(/\s+/)) if (word !== "" && !known.has(word)) return word;
  return undefined;
}

function describe(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const shown = oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
  return `a local edit (${JSON.stringify(shown)})`;
}

/**
 * The name for the copy kept when a merge is abandoned.
 *
 * Shaped after Obsidian's, which is `<name> (Conflicted copy <device> <stamp>)`
 * with the stamp being `toLocaleString("sv")` stripped of separators to twelve
 * characters. Same idea, built from parts rather than from a locale, because
 * depending on Swedish formatting to produce an ISO-like date is a fine trick
 * and not one to rely on.
 *
 * Basalt differs in *which* version gets this name. Obsidian puts the local
 * content in the conflict copy and overwrites the original with the server's, so
 * the file you have open changes under you and your version moves somewhere you
 * are not looking. Here the local content stays where it is and the incoming
 * version takes the new name: a sync you did not ask for never rewrites the file
 * you are editing.
 */
export function conflictCopyPath(path: string, device: string, at: Date): string {
  const { stem, ext } = splitName(path);

  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `${p(at.getHours())}${p(at.getMinutes())}`;

  return `${stem} (Conflicted copy ${sanitiseDevice(device)} ${stamp})${ext}`;
}

/**
 * Reduces a device name to something safe in a filename on every platform.
 *
 * Obsidian sanitises its device name for the same reason. The set here is the
 * union of what Windows, macOS and Linux object to, plus the leading dot, since
 * a conflict copy that starts with one becomes invisible in the very moment
 * somebody needs to find it.
 */
export function sanitiseDevice(device: string): string {
  const cleaned = device
    .replace(/[-\\/:*?"<>|\s]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "")
    .slice(0, 32);
  return cleaned || "device";
}
