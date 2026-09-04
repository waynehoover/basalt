/**
 * A file larger than one batched write may carry.
 *
 * The server bounds a `putmany` by bytes as well as by count, and the engine
 * sent every write as a batch, so an attachment over that bound, and under the
 * per-file limit the server advertises, was refused and written off for good.
 * The refusal even said what to do: send it on its own with `put`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { testWrapped } from "./test-keys.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

const SECRET = new Uint8Array(32).fill(44);
let wrapped: string;
beforeAll(async () => {
  await serverBinary();
  wrapped = await testWrapped(SECRET);
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer;
const open: Client[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  if (server) await server.cleanup();
});

async function connected(name: string, vault: MemoryVault): Promise<Client> {
  const c = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(SECRET, wrapped)),
    vaultId: "default",
    device: name,
    timeoutMs: 60_000,
    coalesceWrites: false,
  });
  open.push(c);
  await c.connect();
  return c;
}

describe("an attachment over the batch byte bound", () => {
  it("is sent on its own and arrives, and the notes beside it are not written off", async () => {
    server = new TestServer();
    await server.start();
    const av = new MemoryVault();
    const a = await connected("a", av);
    for (let i = 0; i < 20; i++) await av.edit(`note-${i}.md`, `note ${i}\n`);
    // Incompressible, and over 16 MiB once sealed.
    const big = new Uint8Array(20 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 65536) {
      crypto.getRandomValues(big.subarray(at, Math.min(at + 65536, big.length)));
    }
    await av.write("photo.bin", big, { mtime: 5000, ctime: 5000 });

    const report = await a.settle();
    expect(report.skipped, `report ${JSON.stringify(report)}`).toBe(0);
    expect(report.uploaded).toBe(21);

    const bv = new MemoryVault();
    const b = await connected("b", bv);
    await b.settle();
    expect(bv.paths().length).toBe(21);
    const got = await bv.read("photo.bin");
    expect(got.length).toBe(big.length);
    expect(got.subarray(0, 4096)).toEqual(big.subarray(0, 4096));
  }, 240_000);
});
