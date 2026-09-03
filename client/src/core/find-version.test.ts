/**
 * Recovery must not stop at a page.
 *
 * `history` is paged, and both places that looked for one version used to read
 * a single page and give up: the newest version with content, and a version
 * by uid. `basalt history` would list a version that `basalt restore --uid`
 * then said did not exist.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { authToken, deriveKeys, type VaultKeys } from "./crypto.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

let keys: VaultKeys;
beforeAll(async () => {
  await serverBinary();
  keys = await deriveKeys(new Uint8Array(20).fill(3));
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer;
let client: Client | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  if (server) await server.cleanup();
});

async function ready(): Promise<{ client: Client; vault: MemoryVault }> {
  server = new TestServer();
  await server.start();
  const vault = new MemoryVault();
  client = new Client({
    vault,
    store: new MemoryIndexStore(),
    keys,
    url: server.wsUrl,
    ...server.credentials(authToken(keys)),
    vaultId: "default",
    device: "a",
    timeoutMs: 20_000,
    coalesceWrites: false,
  });
  await client.connect();
  return { client, vault };
}

describe("finding one version among many", () => {
  it("pages back past the first page to find a version by uid", async () => {
    const { client: c, vault } = await ready();
    for (let i = 0; i < 7; i++) {
      await vault.edit("note.md", `version ${i}\n`);
      await c.settle();
    }
    const all = await c.history("note.md", { limit: 50 });
    expect(all.length).toBe(7);
    const oldest = all[all.length - 1]!;

    // A page of two, so the oldest is four pages back.
    const found = await c.findVersion("note.md", (v) => v.uid === oldest.uid, 2);
    expect(found?.uid).toBe(oldest.uid);
    expect(await c.findVersion("note.md", (v) => v.uid === oldest.uid + 1000, 2)).toBeUndefined();
  }, 120_000);

  it("finds the newest version with content behind a run of deletions", async () => {
    const { client: c, vault } = await ready();
    await vault.edit("note.md", "the content\n");
    await c.settle();
    // Deleted, recreated empty, deleted again: several versions with nothing
    // to restore stacked on top of the one that has.
    for (let i = 0; i < 3; i++) {
      await vault.remove("note.md");
      await c.settle();
      await vault.edit("note.md", "");
      await c.settle();
    }
    await vault.remove("note.md");
    await c.settle();

    const newest = await c.findVersion("note.md", (v) => !v.deleted && v.size > 0, 2);
    expect(newest).toBeDefined();
    expect(newest!.size).toBe("the content\n".length);
  }, 120_000);
});
