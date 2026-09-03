import { describe, expect, it } from "vitest";

import { configFolderName, isNeverSynced } from "./paths.ts";

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
