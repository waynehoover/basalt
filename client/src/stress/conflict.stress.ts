/**
 * Two devices disagreeing, at a scale where a single lost edit hides.
 *
 * Rule 10: the property is not that the devices agree. Two devices agree
 * perfectly when one of them has thrown an edit away. So these assert that
 * every edit made is readable somewhere on both devices afterwards, and check
 * convergence separately.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Client } from "../core/client.ts";
import type { VaultKeys } from "../core/crypto.ts";
import { cleanupBinary, serverBinary, TestServer } from "../core/test-server.ts";
import {
  buildVault,
  device,
  differences,
  fingerprint,
  settle,
  suiteKeys,
  tidy,
} from "./harness.ts";

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

/** Every scrap of text in a vault, so a search can say whether an edit lived. */
async function allText(dir: string): Promise<string> {
  const seen = await fingerprint(dir);
  const parts: string[] = [];
  for (const path of seen.keys()) parts.push(await readFile(join(dir, path), "utf8"));
  return parts.join("\n");
}

describe("forty edits made on two devices at once", () => {
  it("keeps every one of them, on both devices", async () => {
    server = new TestServer();
    await server.start();
    const a = await device(server, keys, "a", dirs, open);
    await buildVault(a.dir, 40);
    await settle([a]);
    const b = await device(server, keys, "b", dirs, open);
    await settle([b]);

    // Twenty notes, edited on both, neither having seen the other. Half append
    // at the end, which merges; half rewrite the title, which does not overlap
    // the append and also merges. Both must survive either way.
    const markers: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const path = join(`folder${i % 7}`, `note-${i}.md`);
      const one = `EDIT-FROM-A-${i}`;
      const two = i % 2 === 0 ? `EDIT-FROM-B-${i}` : `TITLE-FROM-B-${i}`;
      markers.push(one, two);

      const body = await readFile(join(a.dir, path), "utf8");
      await writeFile(join(a.dir, path), `${body}\n${one} at the end.\n`);

      const theirs = await readFile(join(b.dir, path), "utf8");
      await writeFile(
        join(b.dir, path),
        i % 2 === 0
          ? `${theirs}\n${two} at the end too.\n`
          : theirs.replace(/^# Note \d+$/m, `# ${two}`),
      );
    }

    await settle([a, b], 8);

    const onA = await allText(a.dir);
    const onB = await allText(b.dir);
    const lost = markers.filter((m) => !onA.includes(m) || !onB.includes(m));
    expect(lost, `these edits are not on both devices: ${lost.join(", ")}`).toEqual([]);
    expect(differences(await fingerprint(a.dir), await fingerprint(b.dir))).toEqual([]);
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 900_000);
});

describe("two devices rewriting the same sentence", () => {
  it("keeps both versions rather than picking one", async () => {
    server = new TestServer();
    await server.start();
    const a = await device(server, keys, "a", dirs, open);
    for (let i = 1; i <= 10; i++) {
      await writeFile(join(a.dir, `note-${i}.md`), `The original sentence ${i}.\nA second line.\n`);
    }
    await settle([a]);
    const b = await device(server, keys, "b", dirs, open);
    await settle([b]);

    for (let i = 1; i <= 10; i++) {
      await writeFile(join(a.dir, `note-${i}.md`), `A REWROTE ${i} completely.\nA second line.\n`);
      await writeFile(
        join(b.dir, `note-${i}.md`),
        `B WROTE SOMETHING ELSE ${i}.\nA second line.\n`,
      );
    }
    await settle([a, b], 8);

    const onA = await allText(a.dir);
    const onB = await allText(b.dir);
    for (let i = 1; i <= 10; i++) {
      for (const marker of [`A REWROTE ${i} completely`, `B WROTE SOMETHING ELSE ${i}`]) {
        expect(onA, `${marker} is not on device a`).toContain(marker);
        expect(onB, `${marker} is not on device b`).toContain(marker);
      }
    }

    // A conflict copy per note, because the two changed the same region and no
    // merge of them is safe.
    const files = [...(await fingerprint(a.dir)).keys()];
    expect(files.filter((f) => f.includes("Conflicted copy"))).toHaveLength(10);
    expect(differences(await fingerprint(a.dir), await fingerprint(b.dir))).toEqual([]);
  }, 900_000);
});
