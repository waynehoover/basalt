/**
 * What survives a process being taken away mid-write.
 *
 * Durability rule 1 says an ack means the body and the entry are both
 * committed. `stop()` sends SIGTERM and the server shuts down cleanly, which
 * proves nothing about that claim. These kill it outright.
 *
 * Both of these found nothing when first written, which is the point: they are
 * here so that the next change to the commit path cannot quietly break it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Client } from "../core/client.ts";
import type { VaultKeys } from "../core/crypto.ts";
import { cleanupBinary, serverBinary, TestServer } from "../core/test-server.ts";
import {
  buildVault,
  device,
  differences,
  fingerprint,
  reopen,
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

const NOTES = 600;

/** Waits until the server's own log says it has committed this many versions. */
async function committedAtLeast(s: TestServer, n: number, ms = 60_000): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = s.committed();
    if (seen >= n || Date.now() > deadline) return seen;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("a server killed while it is committing", () => {
  it("loses no note, and a new device still gets every one", async () => {
    server = new TestServer();
    await server.start();
    const a = await device(server, keys, "a", dirs, open);
    await buildVault(a.dir, NOTES);
    const before = await fingerprint(a.dir);
    expect(before.size).toBe(NOTES);

    // Killed part way through, not at a boundary chosen to be safe.
    const syncing = a.c.settle({}, 32).catch(() => undefined);
    const at = await committedAtLeast(server, 150);
    expect(at, "the server committed nothing, so nothing was under test").toBeGreaterThan(0);
    await server.kill();
    await syncing;

    // The same data directory, and it must open.
    await server.start(server.port);
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);

    // The device comes back as a new process would: same directory, whatever
    // index survived, a fresh connection.
    const again = await reopen(server, keys, "a", a.dir, open);
    await settle([again], 10);
    const b = await device(server, keys, "b", dirs, open);
    await settle([b], 10);

    const after = await fingerprint(b.dir);
    expect(differences(before, after), "a note did not survive the kill").toEqual([]);
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 900_000);
});

describe("a client killed while it is uploading", () => {
  it("leaves its own vault untouched and finishes on the next run", async () => {
    server = new TestServer();
    await server.start();
    const a = await device(server, keys, "a", dirs, open);
    await buildVault(a.dir, NOTES);
    const before = await fingerprint(a.dir);

    // Closing the socket under a sync in flight is what a killed client looks
    // like to everything else: no goodbye, and a half-sent batch.
    const syncing = a.c.settle({}, 32).catch(() => undefined);
    await committedAtLeast(server, 200);
    a.c.close();
    await syncing;

    // The vault on disk is the user's notes. A sync that died must not have
    // touched them.
    expect(differences(before, await fingerprint(a.dir))).toEqual([]);

    const again = await reopen(server, keys, "a", a.dir, open);
    await settle([again], 10);
    const b = await device(server, keys, "b", dirs, open);
    await settle([b], 10);
    expect(differences(before, await fingerprint(b.dir))).toEqual([]);
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 900_000);
});
