import { describe, expect, it } from "vitest";
import { diff_match_patch } from "diff-match-patch";
import { conflictCopyPath, mergeText, mergeTextCharacters, sanitiseDevice } from "./merge.ts";

/**
 * diff-match-patch used the way its own documentation shows, with none of the
 * checks this module adds. The baseline the tests below measure against.
 *
 * Diff the ancestor against the local side, clean the diff up when it has more
 * than two edits, turn it into patches and apply them to the incoming side.
 * `patch_apply` returns a pair; take the text and ignore the flags.
 *
 * That last step is the whole subject of this file. It is also what Obsidian
 * ships, which was verified by reading `app.js:118574` in the released
 * application, and it is written here as the library's own usage pattern rather
 * than as a copy of theirs, because that is what it is: there is no other
 * obvious way to call these four functions.
 */
function unguardedMerge(base: string, mine: string, theirs: string): string {
  const dmp = new diff_match_patch();
  const diff = dmp.diff_main(base, mine, true, 0);
  if (diff.length > 2) {
    dmp.diff_cleanupSemantic(diff);
    dmp.diff_cleanupEfficiency(diff);
  }
  return dmp.patch_apply(dmp.patch_make(base, diff), theirs)[0];
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
    const base = [
      "# Title",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
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

    const obsidian = unguardedMerge(base, mine, theirs);
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

  /**
   * The invariant, over a spread of shapes rather than one case, asked of the
   * character merge, whose unit is a run of inserted characters.
   *
   * It is not asked of the merge that ships, and the reason is not that it
   * fails: a run of characters one device inserted can legitimately arrive with
   * the other device's insertion in the middle of it, because a region merge
   * places each device's lines separately. `onE\nINSERTED AT THE TOP\ntwo` is
   * the correct merge of a device that capitalised every `e` and a device that
   * added a line, and the run `E\ntwo` is no longer a substring of it. What is
   * asked of the shipped merge is the property under that one, which is that no
   * word of an insertion goes missing; see the test below.
   */
  it("never returns a character merge that has lost a local insertion", () => {
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
      () => "",
      (s: string) => s.split("\n").reverse().join("\n"),
    ];

    let mergedCount = 0;
    for (const base of bases) {
      for (const a of edits) {
        for (const b of edits) {
          const mine = a(base);
          const theirs = b(base);
          const r = mergeTextCharacters(base, mine, theirs);
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

  it("never returns a merge that has lost a word somebody typed", () => {
    // The same grid against the merge that ships. Every word of every local
    // insertion is in the result, and the count is here because it is also the
    // measurement: the region merge returns text for 36 of these 100 pairs
    // where the character merge returns text for 20, and neither loses a word.
    // Rule 8, and the reason the count is asserted rather than mentioned: a
    // merge that grew more cautious would still pass the word property.
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
      () => "",
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
            if (op !== 1) continue;
            for (const word of text.split(/\s+/)) {
              if (word === "") continue;
              expect(r.text, `lost ${JSON.stringify(word)}`).toContain(word);
            }
          }
        }
      }
    }
    expect(mergedCount).toBe(36);
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
      "notes/Meeting (Conflicted copy Waynes-MacBook 202608271504).md",
    );
  });

  it("sanitises the device name on the way into the path", () => {
    // A device name with a slash in it would otherwise create a folder, and
    // one with a space is merely ugly. Passing it through unsanitised was
    // untested while the fixture above happened to contain nothing unsafe.
    const at = new Date(2026, 7, 27, 15, 4);
    expect(conflictCopyPath("n.md", "Wayne's iPad / spare", at)).toBe(
      "n (Conflicted copy Wayne's-iPad-spare 202608271504).md",
    );
  });

  it("keeps the extension where an extension belongs", () => {
    const at = new Date(2026, 0, 2, 3, 4);
    expect(conflictCopyPath("a/b.tar.gz", "dev", at)).toBe(
      "a/b.tar (Conflicted copy dev 202601020304).gz",
    );
    // No extension: nothing is invented.
    expect(conflictCopyPath("a/README", "dev", at)).toBe(
      "a/README (Conflicted copy dev 202601020304)",
    );
    // A dot in a folder name is not an extension.
    expect(conflictCopyPath("a.b/note", "dev", at)).toBe(
      "a.b/note (Conflicted copy dev 202601020304)",
    );
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
    const spliced = unguardedMerge(base, mine, theirs);
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
   *
   * And it is the clearest case for merging by regions instead, so both are
   * here. There is nothing to place: line 15 is the only line the two devices
   * did not both leave alone, one of them changed it, and its text is copied
   * across. Context only matters to something that goes looking, so the
   * character merge refuses a merge that the region merge simply has.
   */
  it("refuses a character merge whose edit has nowhere left to apply", () => {
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

    const obsidian = unguardedMerge(base, mine, theirs);
    const ours = mergeTextCharacters(base, mine, theirs);

    if (!obsidian.includes("LOCAL REWROTE LINE FIFTEEN")) {
      // The backstops are what catch this: the spans do not overlap, so
      // the overlap check passes it through.
      expect(ours.kind).toBe("conflict");
    } else {
      expect(ours.kind === "merged" && ours.text).toContain("LOCAL REWROTE LINE FIFTEEN");
    }

    // And the merge that ships returns the answer, exactly: every line theirs
    // rewrote, with mine's line 15 in the one place it was ever written.
    const want = [...theirLines];
    want[15] = "LOCAL REWROTE LINE FIFTEEN";
    const r = mergeText(base, mine, theirs);
    expect(r.kind).toBe("merged");
    expect(r.kind === "merged" && r.text).toBe(want.join("\n"));
  });

  it("merges spans that abut exactly", () => {
    // Overlap has to mean crossing, not touching. Local rewrites a word and
    // the other device breaks the line straight after it, so the changed
    // regions share a boundary and nothing else. Testing `<=` instead of `<`
    // would turn ordinary editing into conflicts.
    //
    // This case used to be `abcdefghij` against `ABCDEfghij` and
    // `abcdeFGHIJ`, two devices rewriting different halves of one word. That
    // is a conflict now, and deliberately: see inventedWord in merge.ts.
    const base = "- buy milk today";
    const mine = "- buy oats today";
    const theirs = "- buy milk\ntoday";

    const r = mergeText(base, mine, theirs);
    expect(r.kind).toBe("merged");
    if (r.kind !== "merged") return;
    expect(r.text).toBe("- buy oats\ntoday");
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
   *
   * The merge that ships never asks. Mine deleted four lines and theirs rewrote
   * the sixteen around them, and those are different lines, so each device's
   * text is copied into its own region and no hunk is placed anywhere. The
   * answer is below, exactly, and it is the one both people meant.
   */
  it("refuses a character merge whose hunk diff-match-patch could not place", () => {
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

    expect(mergeTextCharacters(base, mine, theirs).kind).toBe("conflict");

    const r = mergeText(base, mine, theirs);
    expect(r.kind).toBe("merged");
    expect(r.kind === "merged" && r.text).toBe(
      [
        ...before.map((_, i) => `entirely rewritten above ${i} with no words in common`),
        ...after.map((_, i) => `entirely rewritten below ${i} with no words in common`),
      ].join("\n"),
    );
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
    const theirs = base.replace(
      "the contested line here",
      "the contested line here as they put it",
    );

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
    const spliced = unguardedMerge(base, mine, theirs);
    // The edit is present, so nothing looking for a lost edit would notice.
    expect(spliced).toContain("EDITED LOCALLY");
    // And it is attached to the wrong item.
    expect(spliced).not.toContain("Item 3 EDITED LOCALLY");
    expect(spliced).toContain("Item 6 EDITED LOCALLY");
  });

  it("is refused by the character merge", () => {
    const r = mergeTextCharacters(base, mine, theirs);
    expect(r.kind).toBe("conflict");
    expect(r.kind === "conflict" && r.why).toMatch(/either order/);
  });

  it("does not happen at all when the merge is done by regions", () => {
    // The flagship case for the region merge, and the reason it is worth
    // having: not that it refuses this, but that it gets it right. Mine
    // changed one line; theirs deleted three sections; those are different
    // lines of the ancestor, so mine's line is copied into the region it
    // belongs to and there is no search that could put it on Item 6.
    const r = mergeText(base, mine, theirs);
    expect(r.kind).toBe("merged");
    expect(r.kind === "merged" && r.text).toBe(theirs.replace("Item 3", "Item 3 EDITED LOCALLY"));
  });

  it("does not turn ordinary merges into conflicts", () => {
    // The check earns its place only if it is quiet on everything else. The
    // legitimate merges above all still merge, and these are the shapes most
    // likely to trip an order comparison.
    const cases: [string, string, string][] = [
      ["a\nb\nc\nd\n", "a\nMINE\nb\nc\nd\n", "a\nb\nc\nTHEIRS\nd\n"],
      ["x y z\n", "X y z\n", "x y Z\n"],
      ["one\ntwo\n", "one\ntwo\nthree mine\n", "one\ntwo\nthree theirs\n"],
      [
        "p\n".repeat(30),
        "p\n".repeat(15) + "MINE\n" + "p\n".repeat(15),
        "p\n".repeat(30) + "THEIRS\n",
      ],
    ];
    for (const [b, m, t] of cases) {
      expect(mergeText(b, m, t).kind, `${JSON.stringify(b.slice(0, 20))} became a conflict`).toBe(
        "merged",
      );
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
    // Of the character merge's checks. The regions the shipped merge works in
    // are what stop the hunk being misplaced in the first place, which is the
    // line above this list in merge.ts: a check that asks whether a wrong
    // answer looks wrong is worth less than not producing one.
    const block = (i: number) => `## Section\n\nSome shared boilerplate text here.\n\nItem ${i}\n`;
    const base = Array.from({ length: 12 }, (_, i) => block(i)).join("\n");
    const mine = base.replace("Item 3", "Item 3 EDITED LOCALLY");
    const theirs = Array.from({ length: 12 }, (_, i) => block(i))
      .slice(3)
      .join("\n");
    const r = mergeTextCharacters(base, mine, theirs);
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
    expect(mergeText(line, `${line} as I wrote it`, `${line} as they wrote it`).kind).toBe(
      "conflict",
    );
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

/**
 * A structured file that merged cleanly and no longer parses.
 *
 * Every other check in mergeText passes for this: nothing was lost, nothing
 * collided, both directions agree. The file is simply no longer a canvas, and
 * Obsidian refuses to open it.
 *
 * The corpus is in canvas.test.ts, against canvases written the way Obsidian
 * writes them. These are the small cases that were here first.
 */
describe("a merge that stops the file being what it was", () => {
  const parsesAsJson = (t: string) => {
    try {
      JSON.parse(t);
      return true;
    } catch {
      return false;
    }
  };

  it("keeps a merge that is still valid", async () => {
    const base = '{\n  "nodes": [\n    {"id": "a"}\n  ],\n  "edges": []\n}';
    const mine = base.replace('"edges": []', '"edges": [{"id": "e1"}]');
    const theirs = base.replace('{"id": "a"}', '{"id": "a", "text": "hello"}');

    const out = mergeText(base, mine, theirs, parsesAsJson);
    if (out.kind !== "merged") throw new Error(`refused a good merge: ${out.why}`);
    expect(parsesAsJson(out.text)).toBe(true);
  });

  /**
   * These particular shapes are refused before the parse check is reached, by
   * the two-directions check, and that is worth knowing rather than assuming:
   *
   *   appending while the other side deletes, two appends to one array, and
   *   adding and removing canvas nodes.
   *
   * It used to say here that no test isolated the parse check because nothing
   * got that far. That was true of these three toy arrays and false of a
   * canvas. See "the first arrow, drawn on two devices at once" in
   * canvas.test.ts, which is a merge nothing else refuses.
   */
  it("already refuses the shapes that would break a canvas", () => {
    const shapes: [string, string, string, string][] = [
      ["append against delete", "[\n  1,\n  2\n]", "[\n  1,\n  2,\n  3\n]", "[\n  1\n]"],
      ["two appends", "[\n  1\n]", "[\n  1,\n  2\n]", "[\n  1,\n  3\n]"],
      [
        "canvas nodes added and removed",
        '{"nodes":[\n{"id":"a"},\n{"id":"b"}\n],"edges":[]}',
        '{"nodes":[\n{"id":"a"},\n{"id":"b"},\n{"id":"c"}\n],"edges":[]}',
        '{"nodes":[\n{"id":"a"}\n],"edges":[]}',
      ],
    ];
    for (const [name, base, mine, theirs] of shapes) {
      const out = mergeText(base, mine, theirs, parsesAsJson);
      if (out.kind === "merged") {
        expect(parsesAsJson(out.text), `${name} merged into something that is not JSON`).toBe(true);
      } else {
        expect(out.kind, name).toBe("conflict");
      }
    }
  });

  /**
   * The check is only asked of files where it means something. Prose has no
   * such property, and refusing a merge because a note is not JSON would
   * refuse every merge there is.
   */
  it("asks nothing of prose", () => {
    const base = ["# Note", "", "First.", "", "Second."].join("\n");
    const mine = base.replace("First.", "First, edited here.");
    const theirs = base.replace("Second.", "Second, edited there.");
    const out = mergeText(base, mine, theirs);
    if (out.kind !== "merged") throw new Error(`refused a good merge: ${out.why}`);
    expect(out.text).toContain("edited here");
    expect(out.text).toContain("edited there");
  });
});

/**
 * The hole the two-directions check was documented to have, and then found by
 * the fuzzer in merge.fuzz.test.ts before it was constructed by hand.
 *
 * `sameLines` compared the two directions as multisets of lines, so a change
 * that lands in the wrong place without changing which lines exist passed. Two
 * shapes do that in repetitive content: a line *inserted* into the wrong
 * section, and a line *deleted* from the wrong section when every section has
 * one. The observed misplacement (Item 3's edit landing on Item 6) was a
 * replacement, which changes the line text and so was caught; these two are
 * the same misplacement with the text unchanged.
 */
describe("a hunk placed in the wrong place, with every line still present", () => {
  const block = (i: number) => `## Section\n\nSome shared boilerplate text here.\n\nItem ${i}\n`;
  const blocks = Array.from({ length: 12 }, (_, i) => block(i));
  const base = blocks.join("\n");
  // Sections 0 to 2 removed on the other device, so every offset shifts by
  // three sections and the matcher's target lands on text that looks right.
  const theirs = blocks.slice(3).join("\n");

  it("refuses a new line that landed in another section", () => {
    const mine = base.replace("Item 3\n", "Item 3\nNEW LINE ADDED LOCALLY\n");

    // The library, unaided, puts the new line under Item 6.
    const spliced = unguardedMerge(base, mine, theirs);
    expect(spliced).toContain("Item 6\nNEW LINE ADDED LOCALLY");
    expect(spliced).not.toContain("Item 3\nNEW LINE ADDED LOCALLY");

    const r = mergeText(base, mine, theirs);
    if (r.kind === "merged") {
      // Merging is acceptable only if the line is where it was written.
      expect(r.text).toContain("Item 3\nNEW LINE ADDED LOCALLY");
    } else {
      expect(r.kind).toBe("conflict");
    }
  });

  it("refuses a deletion that removed the same line from another section", () => {
    const parts = [...blocks];
    parts[3] = "## Section\n\n\nItem 3\n";
    const mine = parts.join("\n");

    // Unaided, the library strips the boilerplate from the section holding
    // Item 6 and leaves the one holding Item 3 intact.
    const spliced = unguardedMerge(base, mine, theirs);
    expect(spliced).toContain("## Section\n\n\nItem 6\n");
    expect(spliced).toContain("Some shared boilerplate text here.\n\nItem 3\n");

    const r = mergeText(base, mine, theirs);
    if (r.kind === "merged") {
      expect(r.text).toContain("## Section\n\n\nItem 3\n");
      expect(r.text).not.toContain("## Section\n\n\nItem 6\n");
    } else {
      expect(r.kind).toBe("conflict");
    }
  });

  it("still lets two devices append to one daily note", () => {
    // The reason the comparison is not string equality, restated next to the
    // thing that tightened it. The order of two additions at one point is
    // arbitrary and must not become a conflict.
    const day = "# 2026-09-02\n\n- first thing\n";
    const r = mergeText(day, day + "- mine\n", day + "- theirs\n");
    expect(r.kind).toBe("merged");
  });

  it("still lets a device append a line identical to the last one", () => {
    // An added line that happens to repeat an existing one is the case where
    // a line-level alignment can wander, so it is pinned as a merge.
    const base = "- p\n- p\n";
    const r = mergeText(base, base + "- p\n", base + "- q\n");
    expect(r.kind).toBe("merged");
    if (r.kind !== "merged") return;
    expect(r.text.split("\n").filter((l) => l === "- p")).toHaveLength(3);
    expect(r.text).toContain("- q");
  });
});

/**
 * A splice both directions agree on, found by the token property of the fuzzer.
 *
 * One device writes into a blank line; the other deletes that blank line. At
 * the character level the write is an insertion at a point and the deletion is
 * the one newline that gave the blank line its width, and the point sits on the
 * span's edge rather than inside it, because an empty line has no inside. So
 * the overlap check let it through, and applying either way round removed the
 * only separator the new line had:
 *
 * ```
 * base    line text here.\n\nhere again.\n
 * mine    line text here.\nmine0\nhere again.\n
 * theirs  line text here.\nhere again.\n
 * merged  line text here.\nmine0here again.\n
 * ```
 *
 * A line neither device wrote, from two edits that both applied, in both
 * directions. Rule 10: the property is that no edit was lost, and "mine0" as
 * a line was.
 */
describe("an addition whose separator the other side deleted", () => {
  it("refuses writing into a blank line the other side removed", () => {
    const base = "line text here.\n\nhere again.\n";
    const mine = "line text here.\nmine0\nhere again.\n";
    const theirs = "line text here.\nhere again.\n";

    expect(unguardedMerge(base, mine, theirs)).toBe("line text here.\nmine0here again.\n");

    const r = mergeText(base, mine, theirs);
    if (r.kind === "merged") {
      expect(r.text.split("\n")).toContain("mine0");
    } else {
      expect(r.kind).toBe("conflict");
    }
  });

  it("refuses a new line that would run into the other side's new line", () => {
    // Fuzz case 1588232853, and the reason the check asks the general
    // question. Theirs added lines in front of the blank line; mine removed
    // the blank line and everything after it, and added a line of its own
    // at the end. What follows theirs' last line after the merge is not a
    // character of the ancestor at all, it is mine's addition.
    const base = "# 2026-09-02\n\n- note text\n- text here\n";
    const mine = "# 2026-09-02\nMINE LINE\n";
    const theirs = "# 2026-09-02\nTHEIRS TWO\n\nTHEIRS ONE\n- note text\n- text here\n";

    expect(unguardedMerge(base, mine, theirs)).toContain("THEIRS ONEMINE LINE");

    const r = mergeText(base, mine, theirs);
    if (r.kind === "merged") {
      const lines = r.text.split("\n");
      expect(lines).toContain("THEIRS ONE");
      expect(lines).toContain("MINE LINE");
    } else {
      expect(r.kind).toBe("conflict");
    }
  });

  it("refuses a new line that would run into a line the other side rewrote", () => {
    // Case 1588285323, and the one shape in this file that only this check
    // sees. Mine cut most of the note and left `mine added 1` as a line of
    // its own, whose closing newline was the newline of the line after it.
    // Theirs rewrote that line. Neither addition is spliced into a word, so
    // every word in the result is somebody's, and both directions agree, so
    // the only thing wrong is that `mine added 1` is no longer a line.
    const base =
      "# 2026-09-02\n\n- here\n- text the\n- here line\n- text note same\n" +
      "- note note note\n- text here\n- the\n- the the text\n- line note here again\n";
    const mine =
      "# 2026-09-02\n\n- mine2\n- the\nmine added 1\n- the the text\n- line note here again\n";
    const theirs =
      "# 2026-09-02\n- theirs text sync 1\n\n- here\n- text the\n- here line\n" +
      "- text note same\n- note note note\n- text here\n- the the theirs0\n- line note here again\n";

    expect(unguardedMerge(base, mine, theirs)).toContain("mine added 1 the theirs0");

    const r = mergeText(base, mine, theirs);
    if (r.kind === "merged") {
      expect(r.text.split("\n")).toContain("mine added 1");
    } else {
      expect(r.kind).toBe("conflict");
    }
  });

  it("still merges an appended line against a deleted last line", () => {
    // The mirror image, which is fine: the deleted line took its own newline
    // with it and the appended line brought its own.
    const base = "# day\n\n- first\n- last\n";
    const r = mergeText(base, base + "- new\n", "# day\n\n- first\n");
    expect(r.kind).toBe("merged");
    expect(r.kind === "merged" && r.text).toBe("# day\n\n- first\n- new\n");
  });

  it("still merges a new first item against a deleted first item", () => {
    const base = "# day\n\n- a\n- b\n";
    const r = mergeText(base, "# day\n\n- new\n- a\n- b\n", "# day\n\n- b\n");
    expect(r.kind).toBe("merged");
    expect(r.kind === "merged" && r.text).toBe("# day\n\n- new\n- b\n");
  });
});

/**
 * Two devices rewriting one line, with their character spans missing each
 * other, which is the overlap check's own failure reached by a route it cannot
 * see. Both found by the placed property of merge.fuzz.test.ts.
 */
describe("two rewrites of one line that miss each other", () => {
  it("refuses two edits whose spans are a space apart across a line end", () => {
    // Case 1588304879. Each device rewrote a different bullet of a short
    // list and the bullets are next to each other, so diff-match-patch reads
    // theirs as deleting "- here\n-" and mine as deleting "line sync\n-".
    // The two deletions are separated by the single space after a bullet, so
    // nothing overlaps, and the two additions land side by side.
    const base = "# 2026-09-02\n\n- here\n- line sync\n- line";
    const mine = "# 2026-09-02\n\n- here\n- mine line here 1\n- line sync\nmine0 line";
    const theirs = "# 2026-09-02\n\ntheirs added 0\ntheirs1 line sync\n- line";

    // Unaided, the library makes a line neither device wrote and leaves the
    // line theirs meant to rewrite exactly as the ancestor had it.
    const spliced = unguardedMerge(base, mine, theirs);
    expect(spliced).toContain("theirs1 mine line here 1");
    expect(spliced).toContain("- line sync");

    const r = mergeText(base, mine, theirs);
    if (r.kind === "merged") {
      expect(r.text).not.toContain("theirs1 mine line here 1");
    } else {
      expect(r.kind).toBe("conflict");
    }
  });

  it("refuses a word replacement that meets the other side's new line", () => {
    // Case 1588275183, the same shape from the other direction: mine
    // rewrote the marker of a line theirs replaced the text of, so mine's
    // word ends up on theirs' new line and the line mine edited survives
    // untouched.
    const base = "# 2026-09-02\n\n- here the same the\n- line line\n- here note\n";
    const mine = "# 2026-09-02\nmine0 here the same the\n- line line\n";
    const theirs =
      "# 2026-09-02\n\n- theirs line again 0\n- here the same the\nTHEIRS LINE 2\n- here note\n";

    expect(unguardedMerge(base, mine, theirs)).toContain("mine0 theirs line again 0");

    const r = mergeText(base, mine, theirs);
    if (r.kind === "merged") {
      expect(r.text).not.toContain("mine0 theirs line again 0");
    } else {
      expect(r.kind).toBe("conflict");
    }
  });

  it("refuses two rewrites of one word that arrive at the same point", () => {
    // Case 3869976870. `theirs0` begins with `the`, so theirs' edit is four
    // characters inserted after `- the` and nothing deleted, at exactly the
    // point where mine's own replacement of that word is inserted. Two
    // additions at one point are the daily note and are allowed, except when
    // a device also took text away there, which is what this is.
    const base = "# 2026-09-02\n\n- again\n- text note\n- the the\n";
    const mine = "\n- again\n# 2026-09-02\n- text note\n- mine1 the\n";
    const theirs = "# 2026-09-02\n\n- again\n- text note\n- theirs0 the\n";

    expect(unguardedMerge(base, mine, theirs)).toContain("- mine1irs0 the");

    const r = mergeText(base, mine, theirs);
    if (r.kind === "merged") {
      expect(r.text).not.toContain("mine1irs0");
    } else {
      expect(r.kind).toBe("conflict");
    }
  });

  it("refuses a line whose first word the other device took away", () => {
    // Case 7028336. Theirs wrote `- theirs text note 1` over `- the`, which
    // reads as everything from the fourth letter being inserted after
    // `- the`, and mine deleted `- the` and put a line of its own in its
    // place. The two additions arrive one after the other with nothing of the
    // ancestor between them, and what is left of theirs' line is
    // `irs text note 1`. Found by the token property, refused by this check:
    // both are true of it and either alone would do.
    const base = "# 2026-09-02\n\n- the\n- the again";
    const mine = "- mine note sync 0\n\n- the again";
    const theirs = "# 2026-09-02\n\n- theirs text note 1\n- the\nTHEIRS LINE 0\n- the theirs2";

    expect(unguardedMerge(base, mine, theirs)).toContain("\nirs text note 1");

    const r = mergeText(base, mine, theirs);
    if (r.kind === "merged") {
      expect(r.text).not.toContain("\nirs text note 1");
    } else {
      expect(r.kind).toBe("conflict");
    }
  });

  it("still merges two devices changing adjacent words of one sentence", () => {
    // The cost this check must not have. Only a space separates the two
    // edits here too, and neither deletion took a line end with it, so the
    // result is the sentence both people meant.
    const r = mergeText("The cat sat.", "The dog sat.", "The cat ran.");
    expect(r.kind).toBe("merged");
    expect(r.kind === "merged" && r.text).toBe("The dog ran.");
  });

  it("still lets two devices append to one daily note", () => {
    // Two additions at one point stay the daily note. They are only refused
    // when a device also took text away at that point.
    const day = "# 2026-09-02\n\n- first thing\n";
    const r = mergeText(day, day + "- mine\n", day + "- theirs\n");
    expect(r.kind).toBe("merged");
  });
});

/**
 * The three things that can go wrong once a merge is done region by region,
 * each one found by merge.fuzz.run.ts while the region merge was being built,
 * and none of them reachable by the character merge because it has no regions.
 *
 * They are all the same shape underneath: a region is a piece of the answer,
 * and a piece can be emitted twice, dropped, or joined to its neighbour.
 */
describe("merging inside line regions", () => {
  it("does not repeat a line appended past the lines the other device rewrote", () => {
    // Fuzz case 1588258344, trimmed. Mine rewrote the first item and appended a
    // line at the end; theirs replaced every item with one line of its own. The
    // append and the rewrite are two of mine's changes, and at the end of a file
    // they sit at the same ancestor position: there is no line after the last
    // one to tell them apart. Reading mine's text for the region by index took
    // the appended line into the region as well, and the region after it emitted
    // the line again. `MINE LINE 1` appeared twice, in a merge reported clean.
    const base = "# 2026-09-02\n\n- the sync\n- sync\n- sync here the\n";
    const mine = "# 2026-09-02\n\nmine0 the sync\n- sync\n- sync here the\nMINE LINE 1\n";
    const theirs = "# 2026-09-02\n\n- theirs1\n";

    const r = mergeText(base, mine, theirs);
    if (r.kind !== "merged") throw new Error(`refused a good merge: ${r.why}`);
    expect(r.text.split("\n").filter((l) => l === "MINE LINE 1")).toHaveLength(1);
  });

  it("keeps both copies when both devices added the same line", () => {
    // Fuzz case 1588279904, trimmed. Both devices put the same line at the same
    // point, so the two texts for that region are equal and the character merge
    // reads equal texts as agreement and returns one copy. Which is a line a
    // device wrote and the merge did not: rule 5, a result smaller than its
    // input with nothing to say that is right.
    //
    // Keeping both is what the character merge itself does as soon as anything
    // stops the two region texts being identical, so this is consistency, and a
    // duplicate line is visible where a dropped one is not.
    const base = "- a\n- b\n";
    const mine = "- a\n- SAME\n- b\n- mine\n";
    const theirs = "- a\n- SAME\n- b\n- theirs\n";

    const r = mergeText(base, mine, theirs);
    if (r.kind !== "merged") throw new Error(`refused a good merge: ${r.why}`);
    expect(r.text.split("\n").filter((l) => l === "- SAME")).toHaveLength(2);
    expect(r.text).toContain("- mine");
    expect(r.text).toContain("- theirs");
  });

  it("refuses a region whose merge would run into the next region", () => {
    // The region form of `fusedLine`, and the case that needs it: mine wrote
    // into a blank line, theirs deleted that blank line, and the region holding
    // it merges to `mine0` with no newline left. Concatenated with the region
    // after it that is `mine0here again.`, a line neither device wrote, out of
    // a merge every check inside the region was happy with. The check is on the
    // pieces rather than on the text, because by the time it is one string the
    // join has already happened.
    const base = "line text here.\n\nhere again.\n";
    const mine = "line text here.\nmine0\nhere again.\n";
    const theirs = "line text here.\nhere again.\n";

    const r = mergeText(base, mine, theirs);
    expect(r.kind).toBe("conflict");
    expect(r.kind === "conflict" && r.why).toMatch(/run into/);
  });

  it("still merges the ordinary shapes it would be easy to refuse with them", () => {
    // The cost the three checks above must not have. A line appended by one
    // device while the other rewrites earlier lines, one device adding the line
    // the other one also added *somewhere else*, and a line appended after one
    // the other device rewrote, which is the shape the boundary check is
    // nearest to refusing.
    //
    // Not in the list, and worth saying: the same last case without a trailing
    // newline is a conflict, and it is one in the character merge too. A device
    // that appends to a note whose last line has no newline is editing that
    // line, and `fusedLine` has refused that since before there were regions.
    const cases: [string, string, string][] = [
      ["a\nb\nc\n", "A\nb\nc\nmine\n", "a\nB\nc\n"],
      ["- a\n- b\n", "- SAME\n- a\n- b\n", "- a\n- b\n- SAME\n"],
      ["a\nb\n", "a\nB\n", "a\nb\nc\n"],
    ];
    for (const [b, m, t] of cases) {
      expect(mergeText(b, m, t).kind, `${JSON.stringify(b)} became a conflict`).toBe("merged");
    }
  });
});

/**
 * A splice inside a word, which every check that compares spans lets through
 * because both spans are innocent. Found by the token property of
 * merge.fuzz.test.ts.
 */
describe("a word neither device wrote", () => {
  it("refuses a fragment of a word the other device deleted the front of", () => {
    // Case 3869907292, trimmed. Theirs rewrote `- the` as `- theirs0`, which
    // begins with the same three letters, so diff-match-patch reads it as
    // `irs0` inserted after `- the` and nothing deleted. Mine deleted the
    // lines that `- the` was one of. Nothing overlaps, and `irs0` lands on
    // the end of whatever line is left.
    const base = "- line here\n- note line\n- the\n";
    const mine = "- mine line line 0\n- line here\n";
    const theirs = "- line here\n- note line\n- theirs0\n";

    expect(unguardedMerge(base, mine, theirs)).toContain("- line hereirs0");

    const r = mergeText(base, mine, theirs);
    if (r.kind === "merged") {
      expect(r.text).not.toContain("hereirs0");
    } else {
      expect(r.kind).toBe("conflict");
    }
  });

  it("still merges two edits to different words of one line", () => {
    // The check asks about words, not about lines, so a line neither device
    // wrote is still the right answer when every word in it is somebody's.
    const r = mergeText("a b c\n", "a B c\n", "a b C\n");
    expect(r.kind).toBe("merged");
    expect(r.kind === "merged" && r.text).toBe("a B C\n");
  });
});
