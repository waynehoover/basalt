/**
 * Two things asking the server at once.
 *
 * The transport allows one request in flight and throws otherwise, on purpose:
 * replies carry no request id, so a second question would resolve into the
 * first one's slot. The engine is single-flight and so never trips it.
 *
 * Recovery is not part of the engine. Somebody browsing deleted notes while the
 * background sync ticks is two callers, and nothing was stopping them.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { deriveKeys, type VaultKeys } from "./crypto.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

let keys: VaultKeys;
beforeAll(async () => {
    await serverBinary();
    keys = await deriveKeys(new Uint8Array(20).fill(9));
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
        token: server.token,
        vaultId: "default",
        device: "a",
        timeoutMs: 20_000,
        coalesceWrites: false,
    });
    await client.connect();
    return { client, vault };
}

describe("a recovery question during a sync", () => {
    it("does not collide with the sync in progress", async () => {
        const { client: c, vault } = await ready();
        for (let i = 0; i < 12; i++) await vault.edit(`note-${i}.md`, `body ${i}\n`);
        await c.settle();
        await vault.remove("note-3.md");
        await c.settle();

        // Both started without waiting for the other, which is what a person
        // opening the recovery list during a background sync produces.
        for (let round = 0; round < 5; round++) {
            await vault.edit(`churn-${round}.md`, `round ${round}\n`);
            const syncing = c.settle();
            const asking = c.deleted();
            const [, gone] = await Promise.all([syncing, asking]);
            expect(gone.notes.map((v) => v.path)).toContain("note-3.md");
        }
    }, 300_000);

    it("does not collide with another recovery question", async () => {
        const { client: c, vault } = await ready();
        await vault.edit("note.md", "one\n");
        await c.settle();
        await vault.edit("note.md", "two\n");
        await c.settle();

        const [history, deleted] = await Promise.all([c.history("note.md"), c.deleted()]);
        expect(history.length).toBe(2);
        expect(deleted.notes).toEqual([]);
    }, 300_000);

    it("restores while a sync is running", async () => {
        const { client: c, vault } = await ready();
        await vault.edit("gone.md", "# Gone\n");
        await c.settle();
        await vault.remove("gone.md");
        await c.settle();

        const version = await c.newestContentVersion("gone.md");
        await vault.edit("busy.md", "keeping the engine occupied\n");
        const [, restored] = await Promise.all([c.settle(), c.restore(version!)]);
        expect(restored.path).toBe("gone.md");
        expect(vault.text("gone.md")).toBe("# Gone\n");
    }, 300_000);
});
