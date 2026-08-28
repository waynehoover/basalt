/**
 * Three-way text merge, and the one place Basalt deliberately behaves worse than
 * Obsidian in order to behave correctly.
 *
 * ## The construction, and the defect it inherits
 *
 * Obsidian's merge, verified in the shipped bundle at `app.js:118574`:
 *
 * ```js
 * function bZ(base, mine, theirs) {
 *   const r = dmp.diff_main(base, mine, true, 0);
 *   if (r.length > 2) { dmp.diff_cleanupSemantic(r); dmp.diff_cleanupEfficiency(r); }
 *   return dmp.patch_apply(dmp.patch_make(base, r), theirs)[0];
 * }
 * ```
 *
 * `patch_apply` returns `[text, appliedFlags]`. Taking `[0]` discards which
 * hunks applied, so a hunk that could not be placed is dropped and the result is
 * returned as though it had succeeded. That is a lost edit, reported as a
 * success, which is the failure this project exists to prevent.
 *
 * Everything else about that function is right and is kept, including the two
 * cleanup passes, which make a merge read the way a human would write it.
 * Dropping them would make our merges worse in a way unrelated to the bug.
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
 * checked to be present in the result. Rule 4 of docs/philosophy.md is about
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
 *
 * The last two stay for the cost of a comparison over data already at hand, and
 * because the flags are the precise defect this module exists to invert. What is
 * not done is pretending they are tested.
 *
 * ## Why not node-diff3, which is the algorithm git uses
 *
 * `node-diff3` (3.2.1, June 2026, pure JS) does a real three-way merge with
 * proper conflict regions, which is precisely the notion diff-match-patch lacks
 * and which the four checks above exist to reconstruct. On the face of it, it
 * should replace all of them.
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
 * So the trade is real and it goes the other way: diff3 is safer per line and
 * far too coarse per note. It is worth revisiting if character-level three-way
 * merging appears in a maintained library; diff-match-patch has shipped nothing
 * since 2020, which is a risk this file carries knowingly.
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

/** diff-match-patch's operation codes, named so the intent is readable. */
const DELETE = -1;
const EQUAL = 0;
const INSERT = 1;

/**
 * A region of the base that one side changed, in base coordinates.
 *
 * `start === end` is an insertion point: nothing was removed, text was added
 * there. A wider span is text that was deleted or replaced.
 */
interface Span {
    readonly start: number;
    readonly end: number;
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
            spans.push({ start: at, end: at + text.length });
            // Deleted text still occupied space in the base, so the cursor has
            // to move past it or every later span is recorded too early. No test
            // reaches this on its own any more: the two-directions check catches
            // whatever a wrong offset lets through, and the tests for ordinary
            // merges catch a wrong offset that invents a collision.
            at += text.length;
        } else {
            spans.push({ start: at, end: at });
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
 * Merges `mine` and `theirs` over their common ancestor `base`.
 *
 * `base` is the content as of the last successful sync, which the local index
 * remembers as one hash per file. docs/client-design.md: that single field is
 * the most useful thing in Obsidian's engine, because it turns a three-way merge
 * into something that needs no version history at all.
 */
export function mergeText(
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
    stillValid: (text: string) => boolean = () => true
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
    const collision = conflictingSpans(changedSpans(diff), changedSpans(theirDiff));
    if (collision !== undefined) {
        return {
            kind: "conflict",
            why:
                `both devices changed the same text, at characters ` +
                `${collision.start} to ${collision.end} of the last synced version`,
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

    if (!sameLines(forward.text, reverse.text)) {
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

    if (!stillValid(forward.text)) {
        return {
            kind: "conflict",
            why: "both sides merged cleanly and the result is no longer a valid file of its kind",
        };
    }

    return { kind: "merged", text: forward.text };
}

/**
 * Whether two merge results hold the same lines, in any order.
 *
 * Comparing the strings outright is too strict, and the case that shows it is
 * the common one: two devices each appending a line to a daily note. Both orders
 * lose nothing, and only the order differs, so demanding identical strings would
 * produce a conflict copy a day. Comparing line multisets accepts that and still
 * catches a misplaced hunk, because a hunk that lands in the wrong place changes
 * *which* lines exist rather than their order.
 *
 * When the two orders differ, the forward result is the one returned: local
 * changes applied to the incoming version. Arbitrary, and fixed, which is what
 * matters.
 */
/**
 * Whether two merges produced the same content, allowing for ordering.
 *
 * The sort is the whole point and it is not a shortcut. Two devices appending
 * to the same daily note is the commonest concurrent edit there is, and it is
 * order-ambiguous: merging their change into mine puts theirs last, merging
 * mine into theirs puts mine last, and both are right. Comparing the strings
 * exactly turns that into a conflict, which was measured rather than guessed:
 * five tests fail, the daily note among them.
 *
 * What it gives up is narrow and worth naming. Two merges that produce the same
 * lines in a different order look identical here, so a line moved to different
 * places by the two directions would pass. A hunk placed wrongly does not, and
 * that is the failure this exists for: a misplaced edit changes the text of a
 * line, so the two multisets differ and the check fires.
 */
function sameLines(a: string, b: string): boolean {
    if (a === b) return true;
    const x = a.split("\n").sort();
    const y = b.split("\n").sort();
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
}

/** Applies one side's changes to the other, reporting how many hunks landed. */
function applyOneWay(
    dmp: InstanceType<typeof diff_match_patch>,
    base: string,
    diff: Diff[],
    onto: string
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
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const hasExt = dot > slash;
    const stem = hasExt ? path.slice(0, dot) : path;
    const ext = hasExt ? path.slice(dot) : "";

    const p = (n: number, width = 2) => String(n).padStart(width, "0");
    const stamp =
        `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` + `${p(at.getHours())}${p(at.getMinutes())}`;

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
