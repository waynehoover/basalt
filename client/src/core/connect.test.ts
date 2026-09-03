/**
 * R1. What a connection has to wait for depends on what the caller is going
 * to do with it.
 *
 * Anything that syncs waits for the backlog, because a pass that runs before
 * catch-up finishes sees a vault the server already has files for and uploads
 * the lot. `basalt status` and the cursor probe in `basalt rebase` do not
 * sync: they read the server's cursor out of the handshake and close. Making
 * them wait meant a device weeks behind unsealed and MAC checked every entry
 * of the backlog before printing one line.
 */

import { describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { FakeSocket, RIG_SECRET, ready, settle } from "./fake-socket.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

/** A client on a socket that will say `ready` and never say `caught-up`. */
function clientOnFakeSocket(): { socket: FakeSocket; client: Client } {
  const socket = new FakeSocket();
  const client = new Client({
    vault: new MemoryVault(),
    store: new MemoryIndexStore(),
    secret: RIG_SECRET,
    url: "ws://test",
    token: "t",
    vaultId: "v",
    device: "d",
    timeoutMs: 2000,
    socketFactory: () => socket,
  });
  return { socket, client };
}

/** Opens the socket and answers the hello, leaving the backlog outstanding. */
async function sayReady(socket: FakeSocket, cursor: number): Promise<void> {
  await settle();
  socket.open();
  for (let i = 0; i < 50 && !socket.sentText.some((m) => m["op"] === "hello"); i++) await settle();
  socket.reply(ready({ cursor }));
  await settle();
}

/** Whether a promise has settled, without waiting on it. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  const first = await Promise.race([p.then(() => true), Promise.resolve(pending)]);
  await settle();
  return first !== pending;
}

describe("connecting only as far as the handshake (R1)", () => {
  it("resolves with the server's own cursor without waiting for the backlog", async () => {
    const { socket, client } = clientOnFakeSocket();
    const connecting = client.connect({ waitForBacklog: false });
    await sayReady(socket, 4211);

    // No `caught-up` is ever sent, and the number is the server's own, out of
    // `ready`, which is what status prints.
    const limits = await connecting;
    expect(limits.cursor).toBe(4211);
    expect(client.serverCursor).toBe(4211);
    await client.close();
  });

  it("still waits for the backlog by default, which is what a sync needs", async () => {
    const { socket, client } = clientOnFakeSocket();
    const connecting = client.connect();
    // It fails on its own timeout eventually. What matters here is that it
    // has not finished while the server is still owed a `caught-up`.
    connecting.catch(() => undefined);
    // At zero, because the transport refuses a catch-up ahead of the batches
    // it was given, and this rig sends none.
    await sayReady(socket, 0);

    expect(await settled(connecting), "a sync connected before catch-up").toBe(false);

    socket.raw({ op: "caught-up", cursor: 0 });
    expect((await connecting).cursor).toBe(0);
    await client.close();
  });
});
