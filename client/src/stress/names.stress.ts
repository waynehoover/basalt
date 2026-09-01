/**
 * Filenames people actually have, and the ones that break sync clients.
 *
 * Emoji, right-to-left text, combining marks, a name at the length limit, an
 * empty file. Every one of these round-trips or the vault is not somebody's
 * vault. Kept here rather than in the unit tests because it needs a real
 * filesystem and a real server: the interesting failures are in what the
 * platform does with the name, not in what the engine does with the string.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Client } from "../core/client.ts";
import type { VaultKeys } from "../core/crypto.ts";
import { cleanupBinary, serverBinary, TestServer } from "../core/test-server.ts";
import { device, differences, fingerprint, settle, suiteKeys, tidy } from "./harness.ts";

let keys: VaultKeys;
beforeAll(async () => {
  await serverBinary();
  keys = await suiteKeys();
}, 300_000);
afterAll(async () => await cleanupBinary());

let server: TestServer;
const open: Client[] = [];
const dirs: string[] = [];
afterEach(async () => await tidy(open, dirs, server));

const AWKWARD: [string, string][] = [
  ["folder with spaces/a note with spaces.md", "spaces"],
  ["accented café/résumé.md", "accents"],
  ["emoji 📁/note 🎉.md", "emoji"],
  ["deep/a/b/c/d/e/f/g/deep.md", "seven folders down"],
  ["a #hashtag note.md", "hash"],
  ["[bracketed] note.md", "brackets, which Obsidian links use"],
  ["note (with parens).md", "parens"],
  ["rock & roll.md", "ampersand"],
  ["it's a note.md", "an apostrophe"],
  ["-leading-dash.md", "a leading dash, which argument parsers eat"],
  ["note.with.dots.md", "dots"],
  ["日本語のノート.md", "japanese"],
  ["מסמך.md", "right to left"],
  ["écombining.md", "a combining acute, which HFS+ normalises"],
  [`${"a".repeat(180)}.md`, "a name near the length limit"],
  ["100% done.md", "a percent, which url encoding eats"],
  ["a+b=c.md", "plus and equals"],
  ["@mention.md", "at"],
  ["empty.md", ""],
];

describe("a vault full of awkward names", () => {
  it("round-trips every one to another device", async () => {
    server = new TestServer();
    await server.start();
    const a = await device(server, keys, "a", dirs, open);

    for (const [path, body] of AWKWARD) {
      const full = join(a.dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body === "" ? "" : `${body}\n`);
    }
    const before = await fingerprint(a.dir);
    expect(before.size).toBe(AWKWARD.length);

    await settle([a]);
    const b = await device(server, keys, "b", dirs, open);
    await settle([b]);

    const gaps = differences(before, await fingerprint(b.dir));
    expect(gaps, `these names did not survive: ${gaps.join(", ")}`).toEqual([]);
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 900_000);
});
