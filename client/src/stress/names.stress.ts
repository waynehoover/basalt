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
import { cleanupBinary, serverBinary, TestServer } from "../core/test-server.ts";
import { device, differences, fingerprint, settle, tidy } from "./harness.ts";

beforeAll(async () => {
  await serverBinary();
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
    const a = await device(server, "a", dirs, open);

    for (const [path, body] of AWKWARD) {
      const full = join(a.dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body === "" ? "" : `${body}\n`);
    }
    expect((await fingerprint(a.dir)).size).toBe(AWKWARD.length);

    await settle([a]);
    const b = await device(server, "b", dirs, open);
    await settle([b]);

    // A's own disk after it has synced, not before.
    //
    // It used to be the snapshot taken before A had ever listed, and that
    // compared the names somebody typed against the names the vault has,
    // which are not the same question and were not the same answer.
    // `écombining.md` was written with a combining acute; the vault spells it
    // precomposed, uploads it precomposed, and B writes it precomposed, so
    // the two disks held one name in two spellings for ever and the
    // assertion blamed both devices for it. The property is that the two
    // vaults are the same vault, so both sides of the comparison have to be
    // a vault (R10).
    const onA = await fingerprint(a.dir);
    const gaps = differences(onA, await fingerprint(b.dir));
    expect(gaps, `these names did not survive: ${gaps.join(", ")}`).toEqual([]);

    // And nothing was lost on the way to agreeing: every name that went in is
    // here, under the one spelling this project has for it. Agreement is not
    // the property on its own, and two empty vaults agree (R10).
    const expected = AWKWARD.map(([path]) => path.normalize("NFC")).sort();
    expect([...onA.keys()].sort()).toEqual(expected);

    // The disk itself, not the listing: a device that reports NFC while
    // holding NFD is exactly the state this test could not see before. Both
    // devices, because only one of them wrote the awkward spelling and only
    // the other one had to be told about it.
    for (const [who, files] of [
      ["a", onA],
      ["b", await fingerprint(b.dir)],
    ] as const) {
      for (const name of files.keys()) {
        expect(name, `${who} holds a name the rest of the vault cannot spell`).toBe(
          name.normalize("NFC"),
        );
      }
    }
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 900_000);
});
