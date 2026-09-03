/**
 * Rotation and the claim, from the client's side.
 *
 * Three review findings meet here, and all three are about a moment when the
 * vault has two possible answers to "what is the secret" or "what is the data
 * key". A rotation whose reply is lost, a rotation followed by an invite, and a
 * claim sent to a vault that has nothing left to claim.
 */

import { describe, expect, it } from "vitest";

import { Client, claimFor } from "./client.ts";
import { deriveRootKeys, generateSecret, unwrapDataKey } from "./crypto.ts";
import { FakeSocket, RIG_SECRET, ready, settle } from "./fake-socket.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

async function connectedClient() {
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
  const connecting = client.connect();
  await settle();
  socket.open();
  for (let i = 0; i < 50 && !socket.sentText.some((m) => m["op"] === "hello"); i++) await settle();
  socket.reply(ready({ cursor: 0 }));
  await settle();
  socket.raw({ op: "caught-up", cursor: 0 });
  await connecting;
  return { socket, client };
}

/** Answers the rotate the moment it is sent, as a server that stays up does. */
function answerRotate(socket: FakeSocket): void {
  socket.autoReply = (frame, s) => {
    if (frame["op"] === "rotate") s.reply({ res: "rotated" });
  };
}

describe("a rotation whose reply may never arrive", () => {
  /**
   * The server commits, closes every other session, and only then replies. A
   * socket that drops in between used to leave the caller throwing with nothing
   * saved: the old root no longer authenticated and the only copy of the new
   * one was in a process about to exit, which is intact ciphertext nobody can
   * ever open. So the new secret is handed to the caller, and the caller is
   * given the chance to write it down, before the request goes out.
   */
  it("hands over the re-wrapped key and waits for the caller before sending", async () => {
    const { socket, client } = await connectedClient();
    answerRotate(socket);
    const next = generateSecret();
    let sentWhenCalled: unknown[] = [];
    let handed: string | undefined;
    await client.rotate(next, async (rewrapped) => {
      handed = rewrapped;
      sentWhenCalled = socket.sentText.filter((m) => m["op"] === "rotate");
      await Promise.resolve();
    });
    expect(handed, "the caller was never handed the new wrapping").toBeDefined();
    expect(sentWhenCalled, "the rotate went out before the caller could save it").toEqual([]);
    expect(socket.sentText.filter((m) => m["op"] === "rotate")).toHaveLength(1);
  });

  it("hands over a wrapping of the same data key, under the new root", async () => {
    // The point of rotating in place: the content keys do not move, so the
    // history stays readable. A wrapping of anything else would be a vault
    // whose past nothing can open.
    const { socket, client } = await connectedClient();
    answerRotate(socket);
    const old = await deriveRootKeys(RIG_SECRET);
    const before = await unwrapDataKey(old.wrap, client.wrapped!);
    const next = generateSecret();
    let handed = "";
    await client.rotate(next, (rewrapped) => {
      handed = rewrapped;
    });
    const after = await unwrapDataKey((await deriveRootKeys(next)).wrap, handed);
    expect([...after]).toEqual([...before]);
    expect(handed).not.toBe(client.wrapped);
  });

  it("does not save anything when the caller's own save fails", async () => {
    // A caller that cannot write the pending secret must not have the rotation
    // sent on its behalf: an uncommitted rotation is recoverable and a
    // committed one whose secret was never written down is not.
    const { socket, client } = await connectedClient();
    answerRotate(socket);
    await expect(
      client.rotate(generateSecret(), () => {
        throw new Error("the disk is full, as it were");
      }),
    ).rejects.toThrow(/disk is full/);
    expect(socket.sentText.filter((m) => m["op"] === "rotate")).toEqual([]);
  });
});

/**
 * review finding on a rotated client. `rotate` changed neither the secret this
 * object holds nor the wrapping it connected under, and nothing marked the
 * client spent, so a later `invite` sealed the retired root and handed somebody
 * a way in that no longer works: they redeem it, store it, and are refused.
 */
describe("a client whose secret was rotated under it", () => {
  it("refuses to issue an invite, rather than sealing the retired root", async () => {
    const { socket, client } = await connectedClient();
    answerRotate(socket);
    await client.rotate(generateSecret());
    const sentBefore = socket.sentText.length;
    await expect(client.invite()).rejects.toThrow(/old secret/);
    await expect(client.invite()).rejects.toThrow(/Reconnect with the new secret/);
    expect(socket.sentText.length, "an invite was put on the wire anyway").toBe(sentBefore);
  });

  it("refuses a second rotation, which would re-wrap under the retired root", async () => {
    const { socket, client } = await connectedClient();
    answerRotate(socket);
    await client.rotate(generateSecret());
    await expect(client.rotate(generateSecret())).rejects.toThrow(/old secret/);
    expect(socket.sentText.filter((m) => m["op"] === "rotate")).toHaveLength(1);
  });
});

/**
 * The claim, and when there is no longer any point sending one. A claim on a
 * claimed vault is ignored by an honest server and is a free wrapping for a
 * dishonest one to hand back in `ready` as the vault's own.
 */
describe("what a hello offers to claim with", () => {
  it("sends nothing once the bootstrap has been spent", async () => {
    const keys = await deriveRootKeys(RIG_SECRET);
    expect(await claimFor({}, "AUTH", keys)).toBeUndefined();
    expect(await claimFor({ claimWrapped: "STORED" }, "AUTH", keys)).toBeUndefined();
  });

  it("sends the same data key on every attempt while the vault is being claimed", async () => {
    // A fresh candidate per attempt meant a claim retried after a lost reply
    // proposed a different key from the one that may already have committed.
    const keys = await deriveRootKeys(RIG_SECRET);
    const config = { bootstrap: "TOKEN", claimWrapped: "STORED" };
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await claimFor(config, "AUTH", keys)).toEqual({ auth: "AUTH", wrapped: "STORED" });
    }
  });
});
