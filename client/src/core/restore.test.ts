/**
 * Putting a version back beside what is already there.
 *
 * A restore never overwrites the file at the path, and the copy it writes
 * instead must not overwrite either: restoring the same version twice is
 * ordinary, and the second copy landing on the first replaced the one thing a
 * restore exists to give back.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client, restoredCopyPath } from "./client.ts";
import { authToken, type VaultKeys } from "./crypto.ts";
import { testKeys, testWrapped } from "./test-keys.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

const SECRET = new Uint8Array(32).fill(23);
let keys: VaultKeys;
let wrapped: string;
beforeAll(async () => {
  await serverBinary();
  keys = await testKeys(SECRET);
  wrapped = await testWrapped(SECRET);
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
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
    secret: SECRET,
    url: server.wsUrl,
    ...server.credentials(authToken(keys), wrapped),
    vaultId: "default",
    device: "a",
    timeoutMs: 20_000,
    coalesceWrites: false,
  });
  await client.connect();
  return { client, vault };
}

describe("restoring onto an occupied path (C8)", () => {
  it("numbers a second restored copy rather than writing over the first", async () => {
    const { client: c, vault } = await ready();
    await vault.edit("note.md", "the old text\n");
    await c.settle();
    await vault.edit("note.md", "the text now\n");
    await c.settle();

    const old = (await c.history("note.md")).at(-1)!; // newest first, so the oldest is last
    const first = await c.restore(old);
    expect(first.path).toBe(restoredCopyPath("note.md", old));
    expect(vault.text(first.path)).toBe("the old text\n");

    // Somebody edits the restored copy, then restores the same version again.
    await vault.edit(first.path, "edited after restoring\n");
    const second = await c.restore(old);

    expect(second.path).not.toBe(first.path);
    expect(vault.text(first.path), "the first restored copy was overwritten").toBe(
      "edited after restoring\n",
    );
    expect(vault.text(second.path)).toBe("the old text\n");
    expect(vault.text("note.md")).toBe("the text now\n");
  }, 120_000);

  /**
   * review finding C17. The name was checked free and then written to with a
   * replacing write, so a file appearing in between was replaced by the
   * restore.
   */
  it("does not replace a file that appeared under the chosen name in the gap", async () => {
    server = new TestServer();
    await server.start();
    const vault = new RacyVault();
    client = new Client({
      vault,
      store: new MemoryIndexStore(),
      secret: SECRET,
      url: server.wsUrl,
      ...server.credentials(authToken(keys), wrapped),
      vaultId: "default",
      device: "a",
      timeoutMs: 20_000,
      coalesceWrites: false,
    });
    await client.connect();
    await vault.edit("note.md", "the old text\n");
    await client.settle();
    await vault.edit("note.md", "the text now\n");
    await client.settle();
    const old = (await client.history("note.md")).at(-1)!;

    const done = await client.restore(old);
    expect(vault.raced.length).toBeGreaterThan(0);
    for (const taken of vault.raced) {
      expect(done.path).not.toBe(taken);
      expect(vault.text(taken), "the file that appeared was replaced").toBe(
        `somebody else's ${taken}\n`,
      );
    }
    expect(vault.text(done.path)).toBe("the old text\n");
  }, 120_000);
});

/** A vault where a name just found free is taken before it is written to, once per name. */
class RacyVault extends MemoryVault {
  raced: string[] = [];
  override async exists(path: string): Promise<boolean> {
    const was = await super.exists(path);
    if (!was && path.includes("(restored") && this.raced.length === 0) {
      this.raced.push(path);
      await super.write(path, new TextEncoder().encode(`somebody else's ${path}\n`), {
        mtime: 1,
        ctime: 1,
      });
    }
    return was;
  }
}
