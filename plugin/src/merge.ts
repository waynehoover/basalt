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
 * ## The three checks, and which one actually fires
 *
 * In order: overlapping regions, then the applied flags, then insertion
 * survival. Stated plainly because the ordering has a consequence worth
 * knowing: the overlap check turned out to subsume the other two in every case
 * that could be constructed for it, including a lost deletion that leaves the
 * output looking correct. Disabling either of the later two leaves the whole
 * suite passing.
 *
 * They stay anyway. Each is a comparison over data already computed, the flags
 * are the precise defect this module exists to invert, and "nothing currently
 * reaches it" is a description of today's test cases rather than of the space of
 * inputs a vault will produce. What is not done is pretending they are tested.
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
/**
 * Whether an offset sits where a line begins, which is where two additions can
 * be concatenated without running into each other.
 */
function atLineBoundary(base: string, at: number): boolean {
    if (at === 0) return true;
    if (at >= base.length) return base.endsWith("\n");
    return base[at - 1] === "\n";
}

function changedSpans(diff: Diff[]): Span[] {
    const spans: Span[] = [];
    let at = 0;
    for (const [op, text] of diff) {
        if (op === EQUAL) {
            at += text.length;
        } else if (op === DELETE) {
            spans.push({ start: at, end: at + text.length });
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
 * Two insertion points at the same offset are treated by where they land.
 *
 * At a line boundary they are allowed: both texts survive as separate lines,
 * only their order is arbitrary, and two devices adding to one daily note is
 * the common case. Refusing it would produce a conflict copy a day for no gain.
 *
 * Mid-line they are refused, because concatenating them produces a run-on
 * sentence neither person wrote:
 *
 * ```
 * base   the contested line
 * mine   the contested line as I wrote it
 * theirs the contested line as they wrote it
 * merged the contested line as I wrote it as they wrote it
 * ```
 *
 * Structurally those two cases are identical, which is why an earlier version
 * allowed both. The distinction that matters is whether the result reads as two
 * additions or as one mangled sentence, and a line boundary is exactly that
 * line.
 */
function conflictingSpans(base: string, mine: Span[], theirs: Span[]): Span | undefined {
    for (const l of mine) {
        for (const r of theirs) {
            const lPoint = l.start === l.end;
            const rPoint = r.start === r.end;
            if (lPoint && rPoint) {
                // Coincident additions. Whole lines concatenate readably;
                // fragments do not.
                if (l.start === r.start && !atLineBoundary(base, l.start)) return l;
                continue;
            }
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
export function mergeText(base: string, mine: string, theirs: string): MergeOutcome {
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
    const collision = conflictingSpans(base, changedSpans(diff), changedSpans(theirDiff));
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
    const patches = dmp.patch_make(base, diff);
    const [text, applied] = dmp.patch_apply(patches, theirs);

    const failed = applied.filter((ok) => !ok).length;
    if (failed > 0) {
        return {
            kind: "conflict",
            why: `${failed} of ${applied.length} changes could not be placed in the incoming version`,
        };
    }

    // The flags say every hunk was placed. That is the library's account of its
    // own work, so check the thing that actually matters.
    const missing = missingInsertions(diff, text);
    if (missing !== undefined) {
        return {
            kind: "conflict",
            why: `the merge reported success but ${describe(missing)} is not in the result`,
        };
    }

    return { kind: "merged", text };
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
