/**
 * Rotation, the claim, and registering a device, from the client's side.
 *
 * Every case here is about a moment when the vault has two possible answers to
 * "what is the secret" or "what is the data key". A rotation whose reply is
 * lost, a claim sent to a vault that has nothing left to claim, and a
 * registration whose reply names a row this device did not ask for.
 *
 * Rotation moved off the device in protocol 4, and the reason is the shape of
 * the whole feature: a device holds no root, so it cannot rewrap the data key
 * and cannot mint a credential. What is left here is `Registrar`, which is the
 * connection somebody opens with the recovery key in their hand.
 */

import { describe, expect, it } from "vitest";

import { Registrar, wrappedForClaim } from "./client.ts";
import {
  deriveRootKeys,
  deviceAuthToken,
  generateDeviceSecret,
  generateSecret,
  unwrapDataKey,
  wrapDataKey,
} from "./crypto.ts";
import { FakeSocket, RIG_SECRET, settle } from "./fake-socket.ts";
import { TEST_DATA_KEY } from "./test-keys.ts";

/** A well-formed registrar reply, with whatever the case wants changed. */
function registrar(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    res: "registrar",
    proto: 4,
    minProto: 4,
    serverVersion: "test",
    maxDevices: 8,
    ...over,
  };
}

/** A registrar session on a socket the test drives. */
async function openRegistrar(
  opts: { secret?: Uint8Array; bootstrap?: string; claim?: { auth: string; wrapped: string } } = {},
) {
  const socket = new FakeSocket();
  const opening = Registrar.open({
    url: "ws://test",
    vaultId: "v",
    device: "d",
    secret: opts.secret ?? RIG_SECRET,
    ...(opts.bootstrap !== undefined ? { bootstrap: opts.bootstrap } : {}),
    ...(opts.claim !== undefined ? { claim: opts.claim } : {}),
    timeoutMs: 2000,
    socketFactory: () => socket,
  });
  // Waited for rather than settled once: `Registrar.open` derives the root
  // keys before it builds the transport, so the socket has no handlers for
  // several turns and an `open()` sent early is an open nobody hears.
  for (let i = 0; i < 200 && socket.onopen === null; i++) await settle();
  socket.open();
  for (let i = 0; i < 200 && !socket.sentText.some((m) => m["op"] === "hello"); i++) await settle();
  socket.reply(registrar());
  return { socket, registrar: await opening };
}

describe("the session the recovery key opens", () => {
  /**
   * The one field that decides whether a session may sync. A registrar hello
   * carries no `deviceId`, so there is no row for the server to check the
   * credential against and no syncing session it could build.
   */
  it("offers the vault's credential and names no device", async () => {
    const { socket } = await openRegistrar();
    const hello = socket.sentText.find((m) => m["op"] === "hello")!;
    expect(hello["proto"]).toBe(4);
    expect("deviceId" in hello).toBe(false);
    expect(hello["token"]).toBe(
      (await import("./crypto.ts")).authToken(await deriveRootKeys(RIG_SECRET)),
    );
  });

  it("offers the server's first-run token while the vault is being claimed", async () => {
    const claim = { auth: "AUTH", wrapped: "WRAPPED" };
    const { socket } = await openRegistrar({ bootstrap: "TOKEN", claim });
    const hello = socket.sentText.find((m) => m["op"] === "hello")!;
    // The bootstrap rather than the derived key, because the vault has no
    // hash yet for the derived key to match, and the claim beside it, because
    // a vault is bound to a credential and a data key together.
    expect(hello["token"]).toBe("TOKEN");
    expect(hello["claim"]).toBe("AUTH");
    expect(hello["wrapped"]).toBe("WRAPPED");
  });

  it("hands the registering device the data key, unwrapped", async () => {
    // The whole mechanism by which a device ends up holding the data key
    // without ever holding the root: this session can unwrap it and the
    // device it is registering never could.
    const root = await deriveRootKeys(RIG_SECRET);
    const wrapped = await wrapDataKey(root.wrap, TEST_DATA_KEY);
    const { socket, registrar: reg } = await openRegistrar();
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "register") {
        s.reply({ res: "registered", deviceId: frame["deviceId"], wrapped });
      }
    };
    const secret = generateDeviceSecret();
    const { dataKey } = await reg.register({ deviceId: "dev-1", deviceSecret: secret, name: "d" });
    expect([...dataKey]).toEqual([...TEST_DATA_KEY]);
    const sent = socket.sentText.find((m) => m["op"] === "register")!;
    // The key, not its digest: the server keeps only the digest either way,
    // and what the key buys is a floor on how short a credential may be.
    expect(sent["auth"]).toBe(await deviceAuthToken(secret));
    expect(sent["deviceId"]).toBe("dev-1");
  });

  it("refuses a registration naming a device other than the one asked for", async () => {
    // The device is about to store a credential for whatever row this names.
    // A row that is not its own is a device that drops the root and is then
    // refused at every hello.
    const { socket, registrar: reg } = await openRegistrar();
    socket.autoReply = (_frame, s) => {
      s.reply({ res: "registered", deviceId: "somebody-else", wrapped: "W" });
    };
    await expect(
      reg.register({ deviceId: "dev-1", deviceSecret: generateDeviceSecret(), name: "d" }),
    ).rejects.toThrow(/which is not the "dev-1"/);
  });

  it("refuses a registration with no wrapped data key, which no claimed vault has", async () => {
    const { socket, registrar: reg } = await openRegistrar();
    socket.autoReply = (frame, s) => {
      s.reply({ res: "registered", deviceId: frame["deviceId"] });
    };
    await expect(
      reg.register({ deviceId: "dev-1", deviceSecret: generateDeviceSecret(), name: "d" }),
    ).rejects.toThrow(/no wrapped data key/);
  });
});

describe("rotating the vault's secret", () => {
  /**
   * The point of rotating in place: the content keys do not move, so the
   * history stays readable and every device row is untouched. A wrapping of
   * anything else would be a vault whose past nothing can open.
   */
  it("sends the same data key, wrapped under the new root", async () => {
    const { socket, registrar: reg } = await openRegistrar();
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "rotate") s.reply({ res: "rotated" });
    };
    const next = generateSecret();
    const { rewrapped } = await reg.rotate(next, TEST_DATA_KEY);
    const sent = socket.sentText.find((m) => m["op"] === "rotate")!;
    expect(sent["wrapped"]).toBe(rewrapped);
    const after = await unwrapDataKey((await deriveRootKeys(next)).wrap, rewrapped);
    expect([...after]).toEqual([...TEST_DATA_KEY]);
  });

  it("sends the new auth key, which the old root does not open", async () => {
    const { socket, registrar: reg } = await openRegistrar();
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "rotate") s.reply({ res: "rotated" });
    };
    const next = generateSecret();
    await reg.rotate(next, TEST_DATA_KEY);
    const sent = socket.sentText.find((m) => m["op"] === "rotate")!;
    const { authToken } = await import("./crypto.ts");
    expect(sent["auth"]).toBe(authToken(await deriveRootKeys(next)));
    expect(sent["auth"]).not.toBe(authToken(await deriveRootKeys(RIG_SECRET)));
  });
});

/**
 * The claim, and when there is no longer any point sending one. A claim on a
 * claimed vault is ignored by an honest server and is a free wrapping for a
 * dishonest one to hand back as the vault's own.
 */
describe("what a claim carries", () => {
  it("wraps a fresh data key under the root that will hold it", async () => {
    const keys = await deriveRootKeys(RIG_SECRET);
    const wrapped = await wrappedForClaim(keys);
    // It unwraps, which is the only thing that has to be true of it: the
    // vault's data key is whatever this claim binds, and the device that made
    // it must be able to open it again.
    expect((await unwrapDataKey(keys.wrap, wrapped)).length).toBe(32);
  });

  it("makes a different key every time it is asked, so it is asked once", async () => {
    // Why one call per claim, and why nothing retries a claim from disk: two
    // calls are two candidate data keys, and a vault bound to one while the
    // device goes on offering the other is a vault it cannot read.
    const keys = await deriveRootKeys(RIG_SECRET);
    expect(await wrappedForClaim(keys)).not.toBe(await wrappedForClaim(keys));
  });
});
