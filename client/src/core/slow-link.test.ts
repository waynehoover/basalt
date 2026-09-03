/**
 * Work that takes longer than one timeout, over a link that is slow but alive.
 *
 * Every wait in the transport was a deadline on the whole exchange: a fetch
 * had one timer across all its bodies, an upload one timer across the whole
 * drain, and the catch-up wait one across the whole backlog. A file larger
 * than the link could carry inside one timeout, or a backlog longer than
 * that, could therefore never complete, and the client reconnected into the
 * same work for ever. Nothing was lost and nothing arrived.
 *
 * The timeouts here are short and the link is throttled, so the work takes
 * several timeouts while bytes flow the whole time. What is being asserted is
 * that a timeout measures silence, not size.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { authToken, deriveKeys, type VaultKeys } from "./crypto.ts";
import { LatencyProxy } from "./latency.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

let keys: VaultKeys;
beforeAll(async () => {
  await serverBinary();
  keys = await deriveKeys(new Uint8Array(20).fill(36));
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer | undefined;
let proxy: LatencyProxy | undefined;
const open: Client[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  if (proxy) await proxy.stop();
  proxy = undefined;
  if (server) await server.cleanup();
  server = undefined;
});

async function client(
  name: string,
  url: string,
  timeoutMs: number,
  vault = new MemoryVault(),
): Promise<{ c: Client; vault: MemoryVault; logs: string[] }> {
  const logs: string[] = [];
  const c = new Client({
    vault,
    store: new MemoryIndexStore(),
    keys,
    url,
    ...server!.credentials(authToken(keys)),
    vaultId: "default",
    device: name,
    timeoutMs,
    coalesceWrites: false,
    log: (m, ...rest) => void logs.push(`${m} ${rest.map(String).join(" ")}`),
  });
  open.push(c);
  await c.connect();
  return { c, vault, logs };
}

/** Bytes that do not compress, so the wire carries every one of them. */
function incompressible(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += 65536) {
    crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, size)));
  }
  return out;
}

/** About four seconds of wire at the rate below, against a two second timeout. */
const BIG = 2 * 1024 * 1024;
const RATE = 500_000;
const TIMEOUT = 2_000;

/**
 * The upload case needs more. A sender can only see its own socket buffer,
 * and on loopback the kernel absorbs several megabytes before anything is
 * slowed, so a two megabyte file looks sent in a moment. Measured: 4 MiB
 * reported drained in 256 ms against a reader taking 500 KB/s. The file has
 * to be large next to that, and the link fast enough to carry it in a test.
 */
const BIG_UP = 32 * 1024 * 1024;
const RATE_UP = 4_000_000;
const TIMEOUT_UP = 3_000;

describe("a large file over a slow link (C4)", () => {
  it("arrives, because bodies keep coming even though the whole takes longer than the timeout", async () => {
    server = new TestServer();
    await server.start();
    const fast = await client("fast", server.wsUrl, 20_000);
    await fast.vault.write("photo.bin", incompressible(BIG), { mtime: 5, ctime: 5 });
    await fast.c.settle();

    proxy = new LatencyProxy("127.0.0.1", server.port, { rttMs: 20, bytesPerSecond: RATE });
    await proxy.start();
    const slow = await client("slow", proxy.url, TIMEOUT);
    const report = await slow.c.settle();

    expect(
      slow.vault.paths(),
      `report ${JSON.stringify(report)}\n${slow.logs.join("\n")}`,
    ).toContain("photo.bin");
    expect(slow.c.transport.isClosed).toBe(false);
  }, 120_000);

  it("is sent, because the ack is waited for from the last body rather than the first", async () => {
    server = new TestServer();
    await server.start();
    proxy = new LatencyProxy("127.0.0.1", server.port, { rttMs: 20, bytesPerSecond: RATE_UP });
    await proxy.start();
    const slow = await client("slow", proxy.url, TIMEOUT_UP);
    const fast = await client("fast", server.wsUrl, 20_000);

    const bytes = incompressible(BIG_UP);
    await slow.vault.write("photo.bin", bytes, { mtime: 5, ctime: 5 });
    const report = await slow.c.settle();
    expect(report.uploaded, slow.logs.join("\n")).toBe(1);
    expect(slow.c.transport.isClosed).toBe(false);

    await fast.c.settle();
    expect(fast.vault.paths()).toContain("photo.bin");
    expect((await fast.vault.read("photo.bin")).length).toBe(BIG_UP);
  }, 120_000);
});

describe("a long backlog over a slow link (C4)", () => {
  it("is caught up on, because the wait is measured from the last batch", async () => {
    server = new TestServer();
    await server.start();
    const fast = await client("fast", server.wsUrl, 20_000);
    // The server sends catch-up in frames of two hundred entries, each a few
    // hundred sealed bytes, so three frames of about 90 KB each: at the rate
    // below one frame fits inside the timeout and the whole backlog does
    // not. A frame is the smallest thing a WebSocket client can see arrive,
    // so that is the granularity progress has here.
    for (let i = 0; i < 600; i++) await fast.vault.edit(`n${i}.md`, `note ${i}\n`);
    await fast.c.settle();

    proxy = new LatencyProxy("127.0.0.1", server.port, { rttMs: 20, bytesPerSecond: 50_000 });
    await proxy.start();
    const slow = await client("slow", proxy.url, 3_000);
    expect(slow.c.transport.isClosed).toBe(false);
    expect(slow.c.serverCursor).toBeGreaterThan(0);
  }, 120_000);
});
