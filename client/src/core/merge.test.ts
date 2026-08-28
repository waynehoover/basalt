import { describe, expect, it } from "vitest";
import { diff_match_patch } from "diff-match-patch";
import { conflictCopyPath, mergeText, sanitiseDevice } from "./merge.ts";

/** Obsidian's merge, as shipped, for comparison. Verified at app.js:118574. */
function obsidianMerge(base: string, mine: string, theirs: string): string {
    const dmp = new diff_match_patch();
    const r = dmp.diff_main(base, mine, true, 0);
    if (r.length > 2) {
        dmp.diff_cleanupSemantic(r);
        dmp.diff_cleanupEfficiency(r);
    }
    return dmp.patch_apply(dmp.patch_make(base, r), theirs)[0];
}

describe("the cases that need no merge", () => {
    it("takes either side when they already agree", () => {
        const r = mergeText("base", "same", "same");
        expect(r).toEqual({ kind: "take", text: "same", why: "both sides already agree" });
    });

    it("takes the incoming version when local never moved", () => {
        const r = mergeText("a\nb\n", "a\nb\n", "a\nb\nc\n");
        expect(r.kind).toBe("take");
        expect(r.kind === "take" && r.text).toBe("a\nb\nc\n");
    });

    it("keeps the local version when the incoming one is the ancestor", () => {
        const r = mergeText("a\nb\n", "a\nb\nlocal\n", "a\nb\n");
        expect(r.kind).toBe("take");
        expect(r.kind === "take" && r.text).toBe("a\nb\nlocal\n");
    });
});

describe("merging edits that do not collide", () => {
    it("keeps both sides when they touched different parts of the note", () => {
        const base = ["# Title", "", "First paragraph.", "", "Second paragraph.", "", "Third paragraph."].join("\n");
        const mine = base.replace("First paragraph.", "First paragraph, edited locally.");
        const theirs = base.replace("Third paragraph.", "Third paragraph, edited on the other device.");

        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("merged");
        if (r.kind !== "merged") return;
        // The property that matters: neither edit was lost.
        expect(r.text).toContain("edited locally");
        expect(r.text).toContain("edited on the other device");
    });

    it("merges an append against an edit elsewhere", () => {
        const base = "line one\nline two\nline three\n";
        const mine = base + "line four, added here\n";
        const theirs = base.replace("line two", "line two, changed there");

        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("merged");
        if (r.kind !== "merged") return;
        expect(r.text).toContain("line four, added here");
        expect(r.text).toContain("line two, changed there");
    });

    it("merges into a long note without disturbing the rest of it", () => {
        const lines = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} with some words in it.`);
        const base = lines.join("\n\n");
        const mine = base.replace("Paragraph 10 ", "Paragraph 10 LOCAL ");
        const theirs = base.replace("Paragraph 300 ", "Paragraph 300 REMOTE ");

        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("merged");
        if (r.kind !== "merged") return;
        expect(r.text).toContain("LOCAL");
        expect(r.text).toContain("REMOTE");
        expect(r.text.split("\n\n")).toHaveLength(400);
    });
});

describe("refusing to merge rather than losing an edit", () => {
    /**
     * Both sides rewrote the same line differently. There is no correct merge,
     * and Obsidian's version silently picks one.
     */
    it("keeps both when the two sides rewrote the same line", () => {
        const base = "# Note\n\nThe original sentence.\n";
        const mine = "# Note\n\nMy completely different sentence.\n";
        const theirs = "# Note\n\nTheir entirely other sentence.\n";

        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("conflict");
        if (r.kind !== "conflict") return;
        // The message goes to a human who has just found a conflict copy.
        expect(r.why.length).toBeGreaterThan(10);
    });

    /**
     * The comparison that justifies the whole module. Same inputs, and
     * Obsidian's shipped merge returns a result with the local edit gone while
     * reporting nothing at all.
     */
    it("catches the case where Obsidian's merge drops a local edit silently", () => {
        const base = "alpha\nbravo\ncharlie\ndelta\n";
        const mine = "alpha\nbravo\nCHARLIE WAS REWRITTEN LOCALLY\ndelta\n";
        // The other device deleted the very line the local edit rewrote, so
        // there is nowhere for the local change to go.
        const theirs = "alpha\nbravo\ndelta\n";

        const obsidian = obsidianMerge(base, mine, theirs);
        const ours = mergeText(base, mine, theirs);

        if (!obsidian.includes("REWRITTEN LOCALLY")) {
            // This is the defect, demonstrated rather than described: the merge
            // returned successfully and the edit is not in the result.
            expect(ours.kind).toBe("conflict");
        } else {
            // If the library ever places it, a merge is the right answer and the
            // edit still has to be there.
            expect(ours.kind).toBe("merged");
            expect(ours.kind === "merged" && ours.text).toContain("REWRITTEN LOCALLY");
        }
    });

    it("never returns a merge that has lost a local insertion", () => {
        // The invariant, over a spread of shapes rather than one case. Whatever
        // the inputs, a "merged" outcome contains every local insertion of three
        // characters or more.
        const dmp = new diff_match_patch();
        const bases = [
            "one\ntwo\nthree\nfour\nfive\n",
            "# Heading\n\nSome prose here.\n\n- a list item\n- another\n",
            "same line\n".repeat(20),
            "a\n",
        ];
        const edits = [
            (s: string) => s.replace("\n", "\nINSERTED AT THE TOP\n"),
            (s: string) => `${s}APPENDED AT THE BOTTOM\n`,
            (s: string) => s.replace(/e/g, "E"),
            (s: string) => "",
            (s: string) => s.split("\n").reverse().join("\n"),
        ];

        let mergedCount = 0;
        for (const base of bases) {
            for (const a of edits) {
                for (const b of edits) {
                    const mine = a(base);
                    const theirs = b(base);
                    const r = mergeText(base, mine, theirs);
                    if (r.kind !== "merged") continue;
                    mergedCount++;

                    const diff = dmp.diff_main(base, mine, true, 0);
                    if (diff.length > 2) {
                        dmp.diff_cleanupSemantic(diff);
                        dmp.diff_cleanupEfficiency(diff);
                    }
                    for (const [op, text] of diff) {
                        if (op === 1 && text.length >= 3) {
                            expect(r.text, `lost ${JSON.stringify(text)}`).toContain(text);
                        }
                    }
                }
            }
        }
        // Rule 8: without a count, "every merge was clean" is also what zero
        // merges looks like.
        expect(mergedCount).toBeGreaterThan(10);
    });

    it("refuses when a local deletion cannot be placed", () => {
        // Local removed a block; the other device rewrote the same block. There
        // is no merge that honours both.
        const base = "keep\n" + "delete me\n".repeat(5) + "keep too\n";
        const mine = "keep\nkeep too\n";
        const theirs = "keep\n" + "rewritten entirely\n".repeat(5) + "keep too\n";

        const r = mergeText(base, mine, theirs);
        expect(["conflict", "merged"]).toContain(r.kind);
        if (r.kind === "merged") {
            // If it merges, the deletion must actually have happened.
            expect(r.text).not.toContain("delete me");
        }
    });
});

describe("conflict copy names", () => {
    it("reads as a conflict copy, with the device and when", () => {
        const at = new Date(2026, 7, 27, 15, 4);
        expect(conflictCopyPath("notes/Meeting.md", "Waynes-MacBook", at)).toBe(
            "notes/Meeting (Conflicted copy Waynes-MacBook 202608271504).md"
        );
    });

    it("sanitises the device name on the way into the path", () => {
        // A device name with a slash in it would otherwise create a folder, and
        // one with a space is merely ugly. Passing it through unsanitised was
        // untested while the fixture above happened to contain nothing unsafe.
        const at = new Date(2026, 7, 27, 15, 4);
        expect(conflictCopyPath("n.md", "Wayne's iPad / spare", at)).toBe(
            "n (Conflicted copy Wayne's-iPad-spare 202608271504).md"
        );
    });

    it("keeps the extension where an extension belongs", () => {
        const at = new Date(2026, 0, 2, 3, 4);
        expect(conflictCopyPath("a/b.tar.gz", "dev", at)).toBe("a/b.tar (Conflicted copy dev 202601020304).gz");
        // No extension: nothing is invented.
        expect(conflictCopyPath("a/README", "dev", at)).toBe("a/README (Conflicted copy dev 202601020304)");
        // A dot in a folder name is not an extension.
        expect(conflictCopyPath("a.b/note", "dev", at)).toBe("a.b/note (Conflicted copy dev 202601020304)");
    });

    it("pads every part of the stamp, so names sort chronologically", () => {
        const at = new Date(2026, 0, 2, 3, 4);
        const name = conflictCopyPath("n.md", "d", at);
        expect(name).toContain("202601020304");
    });

    it("makes a device name safe on every platform", () => {
        expect(sanitiseDevice("Wayne's MacBook Pro")).toBe("Wayne's-MacBook-Pro");
        expect(sanitiseDevice('bad/\\:*?"<>|chars')).toBe("bad-chars");
        // A leading dot would make the conflict copy invisible in the moment
        // somebody is looking for it.
        expect(sanitiseDevice(".hidden")).toBe("hidden");
        expect(sanitiseDevice("...")).toBe("device");
        expect(sanitiseDevice("")).toBe("device");
        expect(sanitiseDevice("x".repeat(100)).length).toBeLessThanOrEqual(32);
    });
});

describe("the splice that diff-match-patch is happy to produce", () => {
    /**
     * The finding that made this module more than a wrapper. Two devices rewrote
     * one sentence differently. Every hunk applies, every insertion is present in
     * the result, and the sentence is one neither person wrote.
     */
    it("refuses two different rewrites of the same sentence", () => {
        const base = "# Note\n\nThe original sentence.\n";
        const mine = "# Note\n\nMy completely different sentence.\n";
        const theirs = "# Note\n\nTheir entirely other sentence.\n";

        // What the library does, unaided, and what Obsidian therefore ships.
        const spliced = obsidianMerge(base, mine, theirs);
        expect(spliced).toBe("# Note\n\nMy completely different entirely other sentence.\n");
        // Note what that defeats: both edits *are* present, so a check for a
        // lost insertion passes. Only an overlap check catches it.
        expect(spliced).toContain("completely different");
        expect(spliced).toContain("entirely other");

        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("conflict");
        expect(r.kind === "conflict" && r.why).toMatch(/same text/);
    });

    it("refuses when one side edits text the other deleted", () => {
        const base = "keep\nthe middle line\nkeep too\n";
        const mine = "keep\nthe middle line, refined\nkeep too\n";
        const theirs = "keep\nkeep too\n";

        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("conflict");
    });

    it("still merges edits that are merely close together", () => {
        // The overlap check must not be so eager that ordinary editing conflicts.
        const base = "line one\nline two\nline three\nline four\n";
        const mine = base.replace("line one", "line one, mine");
        const theirs = base.replace("line four", "line four, theirs");

        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("merged");
        if (r.kind !== "merged") return;
        expect(r.text).toContain("line one, mine");
        expect(r.text).toContain("line four, theirs");
    });

    it("allows two devices to append to the same daily note", () => {
        // Both insert at the end, so nothing is destroyed and only the order is
        // arbitrary. Refusing this would produce a conflict copy every day for
        // no gain, which is why two insertion points at one offset are allowed.
        const base = "# 2026-08-27\n\n- first thing\n";
        const mine = base + "- something I added\n";
        const theirs = base + "- something they added\n";

        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("merged");
        if (r.kind !== "merged") return;
        expect(r.text).toContain("something I added");
        expect(r.text).toContain("something they added");
    });

    it("allows insertions in different places in one note", () => {
        const base = "a\nb\nc\nd\ne\n";
        const mine = base.replace("b\n", "b\nMINE\n");
        const theirs = base.replace("d\n", "d\nTHEIRS\n");

        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("merged");
        if (r.kind !== "merged") return;
        expect(r.text).toContain("MINE");
        expect(r.text).toContain("THEIRS");
    });

    it("merges two edits on one line when they touch different words", () => {
        // Not a splice: local changed one word and the other device changed a
        // different one, so a line neither of them typed is the correct answer.
        // An earlier version of this test asserted every line of a merge came
        // from one of the inputs, which is simply wrong about what merging is.
        const r = mergeText("a b c\n", "a B c\n", "a b C\n");
        expect(r.kind).toBe("merged");
        expect(r.kind === "merged" && r.text).toBe("a B C\n");
    });

    it("refuses a rewrite of the same words, however small the note", () => {
        // The difference from the case above is that both sides changed the
        // *same* word, so no answer honours both.
        const r = mergeText("the quick fox\n", "the SLOW fox\n", "the RAPID fox\n");
        expect(r.kind).toBe("conflict");
    });
});

describe("the guards behind the overlap check", () => {
    /**
     * The overlap check fires first for most conflicts, which leaves the flag
     * check and the insertion check as backstops. This is the case that reaches
     * them: the two sides changed *different* text, so there is no overlap, but
     * the other device rewrote everything around the local edit, so the patch has
     * no context left to match against.
     *
     * diff-match-patch places a hunk by matching four lines of context either
     * side. Destroy all eight and the hunk cannot be placed, and Obsidian's
     * version returns the result anyway with the local edit gone.
     */
    it("refuses when a non-overlapping edit has nowhere left to apply", () => {
        const lines = Array.from({ length: 30 }, (_, i) => `original line ${i}`);
        const base = lines.join("\n");

        const mineLines = [...lines];
        mineLines[15] = "LOCAL REWROTE LINE FIFTEEN";
        const mine = mineLines.join("\n");

        // Everything around line 15 replaced, line 15 itself untouched, so the
        // changed regions do not overlap.
        const theirLines = [...lines];
        for (let i = 0; i < 30; i++) {
            if (i !== 15) theirLines[i] = `completely different content ${i} with nothing in common`;
        }
        const theirs = theirLines.join("\n");

        const obsidian = obsidianMerge(base, mine, theirs);
        const ours = mergeText(base, mine, theirs);

        if (!obsidian.includes("LOCAL REWROTE LINE FIFTEEN")) {
            // The backstops are what catch this: the spans do not overlap, so
            // the overlap check passes it through.
            expect(ours.kind).toBe("conflict");
        } else {
            expect(ours.kind === "merged" && ours.text).toContain("LOCAL REWROTE LINE FIFTEEN");
        }
    });

    it("merges spans that abut exactly", () => {
        // Overlap has to mean crossing, not touching. Local changes the first
        // half and the other device changes the second, so the changed regions
        // share a boundary and nothing else. Testing `<=` instead of `<` would
        // turn ordinary editing into conflicts.
        const base = "abcdefghij";
        const mine = "ABCDEfghij";
        const theirs = "abcdeFGHIJ";

        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("merged");
        if (r.kind !== "merged") return;
        expect(r.text).toBe("ABCDEFGHIJ");
    });

    it("locates changed regions by their real offsets", () => {
        // The overlap check works in base coordinates, so the walk has to
        // advance past equal and deleted runs alike. If it did not, every span
        // would collapse toward zero and edits at opposite ends of a note would
        // look like they collided.
        const filler = Array.from({ length: 200 }, (_, i) => `filler line ${i}`).join("\n");
        const base = `first line\n${filler}\nlast line\n`;
        const mine = base.replace("first line", "first line, changed locally");
        const theirs = base.replace("last line", "last line, changed remotely");

        const r = mergeText(base, mine, theirs);
        expect(r.kind, "edits 200 lines apart were treated as colliding").toBe("merged");
        if (r.kind !== "merged") return;
        expect(r.text).toContain("changed locally");
        expect(r.text).toContain("changed remotely");
    });

    it("still refuses two edits at the same deep offset", () => {
        // The other half of the same property: correct offsets must also make a
        // real collision deep in a file collide.
        const filler = Array.from({ length: 200 }, (_, i) => `filler line ${i}`).join("\n");
        const base = `${filler}\nthe contested line\nmore filler\n`;
        const mine = base.replace("the contested line", "the contested line as I wrote it");
        const theirs = base.replace("the contested line", "the contested line as they wrote it");

        expect(mergeText(base, mine, theirs).kind).toBe("conflict");
    });
});

describe("a hunk that did not apply", () => {
    /**
     * A case Obsidian gets wrong in a way no amount of inspecting the result
     * reveals. Local deleted a block, so there is no insertion to go missing;
     * one hunk fails to apply because the other device rewrote all its context;
     * and the text that comes back still looks correct, because the hunks that
     * did apply happened to achieve the deletion between them. The only thing
     * that knows is the flags array, which Obsidian discards.
     *
     * Worth being straight about what this test does and does not pin down.
     * Basalt refuses it, but the overlap check is what refuses it, not the
     * flags: destroying enough context for a hunk to fail also puts the two
     * sides' changed regions close enough to collide. Disabling the flag check
     * leaves this test passing.
     *
     * Which is the honest state of that check: after the overlap check went in,
     * the flags became a backstop that no constructed case reaches. It stays
     * because it is one comparison, and because it is the exact defect this
     * module exists to invert, so removing it on the grounds that nothing
     * currently reaches it would be removing the seatbelt for never crashing.
     */
    it("refuses whenever diff-match-patch reports a hunk it could not place", () => {
        const before = Array.from({ length: 8 }, (_, i) => `context above ${i}`);
        const block = Array.from({ length: 4 }, (_, i) => `doomed line ${i}`);
        const after = Array.from({ length: 8 }, (_, i) => `context below ${i}`);
        const base = [...before, ...block, ...after].join("\n");
        const mine = [...before, ...after].join("\n");
        const theirs = [
            ...before.map((_, i) => `entirely rewritten above ${i} with no words in common`),
            ...block,
            ...after.map((_, i) => `entirely rewritten below ${i} with no words in common`),
        ].join("\n");

        // What the library reports, which is the fact the merge has to act on.
        const dmp = new diff_match_patch();
        const diff = dmp.diff_main(base, mine, true, 0);
        if (diff.length > 2) {
            dmp.diff_cleanupSemantic(diff);
            dmp.diff_cleanupEfficiency(diff);
        }
        const [obsidianText, applied] = dmp.patch_apply(dmp.patch_make(base, diff), theirs);

        expect(applied, "the fixture no longer produces a failed hunk").toContain(false);
        // And this is why reading the result is not enough: it looks correct.
        expect(obsidianText).not.toContain("doomed line 0");

        expect(mergeText(base, mine, theirs).kind).toBe("conflict");
    });
});

describe("offsets, in the presence of more than one change", () => {
    /**
     * The span walk has to advance past deleted text as well as equal text, or
     * every change after the first deletion is recorded at the wrong offset.
     *
     * One change is not enough to show it, because the first span starts at the
     * right place either way. This has a deletion early and an insertion later,
     * against an insertion at the same later place, so the collision is only
     * found if the deletion moved the cursor along.
     */
    it("still finds a collision that comes after a deletion", () => {
        const head = Array.from({ length: 20 }, (_, i) => `head line ${i}`).join("\n");
        const base = `${head}\nremove this whole line\nthe contested line here\ntail\n`;

        const mine = base
            .replace("remove this whole line\n", "")
            .replace("the contested line here", "the contested line here as I put it");
        const theirs = base.replace("the contested line here", "the contested line here as they put it");

        expect(mergeText(base, mine, theirs).kind).toBe("conflict");
    });
});

describe("a hunk placed in the wrong place, which reports success", () => {
    /**
     * The fourth failure mode, and the one that made the merge run twice.
     *
     * `patch_apply` finds each hunk's home by fuzzy search. In repetitive
     * content it will find somewhere that looks right and is not, and report
     * success: every flag true, the inserted text present, the regions not
     * overlapping. Every other check in this module passes and the note is wrong.
     */
    const block = (i: number) => `## Section\n\nSome shared boilerplate text here.\n\nItem ${i}\n`;
    const base = Array.from({ length: 12 }, (_, i) => block(i)).join("\n");
    const mine = base.replace("Item 3", "Item 3 EDITED LOCALLY");
    // Sections 0 to 2 removed, so everything shifts up and the matcher's target
    // offset lands on text that looks identical.
    const theirs = Array.from({ length: 12 }, (_, i) => block(i))
        .slice(3)
        .join("\n");

    it("is exactly what the library does, unaided", () => {
        const spliced = obsidianMerge(base, mine, theirs);
        // The edit is present, so nothing looking for a lost edit would notice.
        expect(spliced).toContain("EDITED LOCALLY");
        // And it is attached to the wrong item.
        expect(spliced).not.toContain("Item 3 EDITED LOCALLY");
        expect(spliced).toContain("Item 6 EDITED LOCALLY");
    });

    it("is refused", () => {
        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("conflict");
        expect(r.kind === "conflict" && r.why).toMatch(/either order/);
    });

    it("does not turn ordinary merges into conflicts", () => {
        // The check earns its place only if it is quiet on everything else. The
        // legitimate merges above all still merge, and these are the shapes most
        // likely to trip an order comparison.
        const cases: [string, string, string][] = [
            ["a\nb\nc\nd\n", "a\nMINE\nb\nc\nd\n", "a\nb\nc\nTHEIRS\nd\n"],
            ["x y z\n", "X y z\n", "x y Z\n"],
            ["one\ntwo\n", "one\ntwo\nthree mine\n", "one\ntwo\nthree theirs\n"],
            ["p\n".repeat(30), "p\n".repeat(15) + "MINE\n" + "p\n".repeat(15), "p\n".repeat(30) + "THEIRS\n"],
        ];
        for (const [b, m, t] of cases) {
            expect(mergeText(b, m, t).kind, `${JSON.stringify(b.slice(0, 20))} became a conflict`).toBe("merged");
        }
    });

    it("returns the same content whichever order it merged in", () => {
        // When the two orders differ only in the order of two additions, the
        // result returned is the forward one. Whatever it is, it must contain
        // both additions.
        const b = "# day\n\n- first\n";
        const r = mergeText(b, b + "- mine\n", b + "- theirs\n");
        expect(r.kind).toBe("merged");
        if (r.kind !== "merged") return;
        expect(r.text).toContain("- mine");
        expect(r.text).toContain("- theirs");
    });
});

describe("which check catches what", () => {
    /**
     * Recorded because it was measured, by disabling each check in turn, and
     * because it is the answer to "why are there four of these".
     *
     * These are not tests of the checks; they are the cases that distinguish
     * them, kept together so that removing one and finding the suite still green
     * is not mistaken for the check being useless.
     */
    it("only the overlap check catches a symmetric splice", () => {
        // Both sides rewrote the same sentence. diff-match-patch splices them,
        // and it does so the same way in both directions, so merging both ways
        // round agrees on the same mangled answer.
        const base = "# Note\n\nThe original sentence.\n";
        const mine = "# Note\n\nMy completely different sentence.\n";
        const theirs = "# Note\n\nTheir entirely other sentence.\n";
        expect(mergeText(base, mine, theirs).kind).toBe("conflict");
    });

    it("only the two-directions check catches a misplaced hunk", () => {
        const block = (i: number) => `## Section\n\nSome shared boilerplate text here.\n\nItem ${i}\n`;
        const base = Array.from({ length: 12 }, (_, i) => block(i)).join("\n");
        const mine = base.replace("Item 3", "Item 3 EDITED LOCALLY");
        const theirs = Array.from({ length: 12 }, (_, i) => block(i))
            .slice(3)
            .join("\n");
        const r = mergeText(base, mine, theirs);
        expect(r.kind).toBe("conflict");
        expect(r.kind === "conflict" && r.why).toMatch(/either order/);
    });

    it("only the two-directions check separates a run-on from two added lines", () => {
        // Structurally identical: two additions at one offset. One reads as two
        // list items, the other as a sentence neither person wrote, and the
        // difference is only visible in the result.
        const day = "# 2026-08-27\n\n- first thing\n";
        expect(mergeText(day, day + "- mine\n", day + "- theirs\n").kind).toBe("merged");

        const line = "the contested line";
        expect(mergeText(line, `${line} as I wrote it`, `${line} as they wrote it`).kind).toBe("conflict");
    });

    it("returns the same side's result every time, so a merge is reproducible", () => {
        // When the two orders differ only in the order of two additions, either
        // is defensible and the choice has to be fixed. An unstable choice makes
        // a merge non-reproducible, and two devices merging the same three
        // versions would then disagree and conflict for ever.
        const day = "# day\n\n- first\n";
        const once = mergeText(day, day + "- mine\n", day + "- theirs\n");
        for (let i = 0; i < 5; i++) {
            const again = mergeText(day, day + "- mine\n", day + "- theirs\n");
            expect(again).toEqual(once);
        }
        // Which order comes out is arbitrary. Pinned so that a change to it is
        // a deliberate act: two devices merging the same three versions must
        // reach the same answer, or they conflict with each other for ever.
        expect(once.kind === "merged" && once.text).toBe("# day\n\n- first\n- mine\n- theirs\n");
    });
});
