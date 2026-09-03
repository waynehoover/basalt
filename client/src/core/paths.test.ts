import { describe, expect, it } from "vitest";

import { configFolderName, foldsTogether, isNeverSynced, splitName } from "./paths.ts";

const none: ReadonlySet<string> = new Set();

describe("what never syncs (P2, C3, T4)", () => {
  it("refuses a dot-prefixed segment wherever it sits", () => {
    for (const path of [
      ".obsidian",
      ".obsidian/plugins/x/main.js",
      "notes/.git/hooks/post-checkout",
      ".basalt/config.json",
      "a/b/.DS_Store",
      "deep/er/.hidden.md",
      ".trash/note.md",
    ]) {
      expect(isNeverSynced(path, none), path).toBe(true);
    }
  });

  it("lets ordinary notes through, dots inside a name included", () => {
    for (const path of ["note.md", "a/b/c.md", "notes/a..b.md", "v1.2/release.md", "x/.."]) {
      expect(isNeverSynced(path, none), path).toBe(false);
    }
  });

  it("adds what a shell tells it to, at any depth", () => {
    const extra = new Set(["node_modules", "config"]);
    expect(isNeverSynced("node_modules/lib.md", extra)).toBe(true);
    expect(isNeverSynced("proj/node_modules/lib.md", extra)).toBe(true);
    expect(isNeverSynced("config/app.json", extra)).toBe(true);
    expect(isNeverSynced("proj/lib.md", extra)).toBe(false);
  });
});

describe("the config folder's name", () => {
  it("is one plain name at the root, or a refusal", () => {
    expect(configFolderName(".obsidian")).toBe(".obsidian");
    expect(configFolderName("/.obsidian/")).toBe(".obsidian");
    for (const bad of ["", "/", "a/b", "/a/b/"]) {
      expect(() => configFolderName(bad), JSON.stringify(bad)).toThrow(/not a plain name/);
    }
  });
});

/**
 * The four callers that name a file beside another one all split the name the
 * same way now, and they used to disagree about one case.
 *
 * Two wrote `dot > slash`, which reads `.gitignore` as an empty stem with a
 * `.gitignore` extension and numbers it ` 2.gitignore`; two wrote `dot <= 0`,
 * which reads it as a name with no extension and numbers it `.gitignore 2`.
 * The second is the answer, and it is pinned here rather than left to whichever
 * caller a reader happens to open.
 */
describe("splitting a name from its extension", () => {
  it("takes the last dot after the last slash", () => {
    expect(splitName("note.md")).toEqual({ stem: "note", ext: ".md" });
    expect(splitName("a/b/note.md")).toEqual({ stem: "a/b/note", ext: ".md" });
    expect(splitName("a/b.tar.gz")).toEqual({ stem: "a/b.tar", ext: ".gz" });
  });

  it("finds no extension where there is none", () => {
    expect(splitName("README")).toEqual({ stem: "README", ext: "" });
    expect(splitName("a/README")).toEqual({ stem: "a/README", ext: "" });
  });

  it("does not read a folder's dot as the file's extension", () => {
    expect(splitName("a.b/note")).toEqual({ stem: "a.b/note", ext: "" });
  });

  it("does not read a leading dot as an extension, which is the reconciled case", () => {
    expect(splitName(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
    expect(splitName("a/.gitignore")).toEqual({ stem: "a/.gitignore", ext: "" });
    // A dotfile that really does carry one still splits at it.
    expect(splitName(".config.json")).toEqual({ stem: ".config", ext: ".json" });
  });
});

/**
 * The fallback answer to "are these two paths one file", for the platforms
 * that fold and the vaults that cannot ask.
 */
describe("folding two paths together", () => {
  it("folds case and Unicode normalisation", () => {
    expect(foldsTogether("Note.md", "note.md")).toBe(true);
    expect(foldsTogether("a/Caf\u00e9.md", "a/Cafe\u0301.md")).toBe(true);
  });

  it("keeps two real files apart", () => {
    expect(foldsTogether("note.md", "notes.md")).toBe(false);
    expect(foldsTogether("a/note.md", "b/note.md")).toBe(false);
  });
});
