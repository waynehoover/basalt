/**
 * Adding a device with a single-use invite, at the core.
 *
 * An invite is how a device is added, and the recovery key is not. The key is
 * written down and offline; requiring it to add a phone would mean fetching
 * it, typing it into the phone and leaving it on one more surface than it
 * should ever be on. The panel and the design doc both say so, and this is the
 * mechanism that makes it true.
 *
 * What changed at protocol 4 is what an invite carries. It used to carry the
 * vault's root secret, which a device held; a device holds no root now, so it
 * has none to seal, and one that arrived by invite would be able to register a
 * third device and rewrap the vault, which is everything revoking a device is
 * meant to take back. So an invite carries the **data key**, and the
 * redemption registers the redeeming device's own row, in one server
 * transaction. Both halves or neither.
 *
 * Against the real server, because the properties being relied on are the
 * server's: single use, and that the spend and the registration commit
 * together.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client, Registrar, redeemInvite } from "./client.ts";
import { authToken, deriveRootKeys, deviceAuthToken, generateSecret } from "./crypto.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { parseInvite } from "./pairing.ts";
import { testWrapped } from "./test-keys.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer | undefined;
afterEach(async () => {
  if (server) await server.cleanup();
  server = undefined;
});

/** A vault with one device on it, connected, holding the data key. */
async function vaultWithADevice(): Promise<{ client: Client; dataKey: Uint8Array }> {
  server = new TestServer();
  await server.start();
  const secret = generateSecret();
  const wrapped = await testWrapped(secret);
  const claiming = await Registrar.open({
    url: server.wsUrl,
    vaultId: "default",
    device: "first",
    secret,
    ...server.registrarCredentials(authToken(await deriveRootKeys(secret)), wrapped),
    timeoutMs: 15_000,
  });
  claiming.close();
  const first = await server.deviceCredentials(secret, wrapped, "laptop");
  const client = new Client({
    vault: new MemoryVault(),
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    vaultId: "default",
    device: "laptop",
    deviceId: first.deviceId,
    token: first.token,
    dataKey: first.dataKey,
    timeoutMs: 15_000,
  });
  await client.connect();
  return { client, dataKey: first.dataKey };
}

describe("issuing an invite", () => {
  it("seals the vault's data key, and nothing that could add a device later", async () => {
    const { client, dataKey } = await vaultWithADevice();
    try {
      const { invite, expiresAt } = await client.invite();
      expect(invite).toMatch(/^basalt3i_/);
      expect(expiresAt).toBeGreaterThan(Date.now());

      // The string carries where to ask, which vault, and the key to open
      // what is handed back. It does not carry the vault's secret: the whole
      // difference between an invite and the recovery key is that this can be
      // read off a screen by somebody standing next to you.
      const parsed = parseInvite(invite);
      expect(parsed.vaultId).toBe("default");
      expect(parsed.key).toHaveLength(32);

      // Redeeming it yields the data key this device holds, which is the
      // property the whole redesign turns on: the same key, not the root that
      // wraps it.
      const redeemed = await redeemInvite(parsed, "phone", { timeoutMs: 15_000 });
      expect(
        [...redeemed.dataKey],
        "an invite handed over something other than the data key",
      ).toEqual([...dataKey]);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("registers the redeeming device, so it needs no recovery key of its own", async () => {
    const { client } = await vaultWithADevice();
    try {
      const { invite } = await client.invite();
      const redeemed = await redeemInvite(parseInvite(invite), "phone", { timeoutMs: 15_000 });

      // A row of its own, a credential for it, and no root. The redemption is
      // the registration: there is no second call, because the device that
      // issued the invite holds no root and could not have made the row.
      expect(redeemed.deviceId).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(redeemed.deviceSecret).toHaveLength(32);
      const listed = await client.devices();
      const row = listed.devices.find((d) => d.id === redeemed.deviceId);
      expect(row, "redeeming an invite registered no device").toBeDefined();
      expect(row!.name).toBe("phone");
      expect(row!.lastSeen).toBe(0);

      // And the credential works: this is what a device is.
      const phone = new Client({
        vault: new MemoryVault(),
        store: new MemoryIndexStore(),
        url: server!.wsUrl,
        vaultId: "default",
        device: "phone",
        deviceId: redeemed.deviceId,
        token: await deviceAuthToken(redeemed.deviceSecret),
        dataKey: redeemed.dataKey,
        timeoutMs: 15_000,
      });
      await phone.connect();
      await phone.close();
    } finally {
      await client.close();
    }
  }, 120_000);

  it("works once, and the refusal leaves the vault with one new device", async () => {
    const { client } = await vaultWithADevice();
    try {
      const { invite } = await client.invite();
      const first = await redeemInvite(parseInvite(invite), "phone", { timeoutMs: 15_000 });
      await expect(
        redeemInvite(parseInvite(invite), "tablet", { timeoutMs: 15_000 }),
      ).rejects.toThrow(/not authorised/);

      const listed = await client.devices();
      expect(listed.devices.map((d) => d.name).sort()).toEqual(["laptop", "phone"]);
      expect(listed.devices.some((d) => d.id === first.deviceId)).toBe(true);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("cannot be opened by anything but the key in the string", async () => {
    // The invite key travels in the string and never to the server, so a
    // stolen disk holds a blob under a name it cannot guess and a key it does
    // not have. A wrong key fails here rather than later as content that will
    // not decrypt.
    const { client } = await vaultWithADevice();
    try {
      const { invite } = await client.invite();
      const wrong = { ...parseInvite(invite), key: new Uint8Array(32).fill(7) };
      await expect(redeemInvite(wrong, "phone", { timeoutMs: 15_000 })).rejects.toThrow(
        /invite key does not open/,
      );
    } finally {
      await client.close();
    }
  }, 120_000);
});
