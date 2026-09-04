/**
 * Becoming a device, and every way it can be interrupted.
 *
 * This is the step of per-device credentials that can strand a device, so it
 * gets a test per crash point rather than one for the happy path. A protocol 3
 * device holds the vault's root and no row on the server; a protocol 4 server
 * will not talk to it until it has one. Every device therefore converts itself
 * once, silently, and if that goes wrong in the wrong place the device has
 * neither credential and a person has a phone that will not sync and no shell
 * to fix it with.
 *
 * The ordering under test, from `convertToDevice`:
 *
 *   1. choose an id and a secret, and save them, before anything is sent
 *   2. register, and save the data key it hands back
 *   3. connect as the device, which is what confirms the row
 *   4. drop the root
 *
 * Six crash points, one test each: before save 1, after save 1, after the
 * registration committed with its reply lost, after save 2, after the
 * confirming connection, and on save 3. Every one of them must leave a device
 * that converts on the next attempt, and none of them may leave the vault with
 * two rows for one device: eight is the cap, and a conversion that burned one
 * per crash would fill it with ghosts nobody can name.
 *
 * Against the real server, because the thing being relied on is the server's
 * own rule that registering the same id with the same key again succeeds.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Registrar, convertToDevice } from "./client.ts";
import { authToken, deriveRootKeys, generateSecret } from "./crypto.ts";
import { needsConversion, type DeviceConfig } from "./pairing.ts";
import { testWrapped } from "./test-keys.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { Transport, type SocketLike } from "./transport.ts";

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
  reader = undefined;
});

/** What each connection this conversion makes should do. */
type Fault = "ok" | "lose-registered" | "refuse";

/**
 * A socket factory that can break the nth connection.
 *
 * `lose-registered` is the lost reply, and it is the one fault that has to be
 * precise: the register goes out, the server commits the row, and the
 * `registered` frame is thrown away on the way back. Cutting the socket
 * instead cannot be told to land after the commit rather than before it, and
 * which side of the commit it lands on is the whole difference between two of
 * the cases below.
 */
function faulty(faults: Fault[]): { factory: (url: string) => SocketLike; count: () => number } {
  let n = 0;
  const factory = (url: string): SocketLike => {
    const fault = faults[n++] ?? "ok";
    if (fault === "refuse") {
      // A socket that never opens, which is what a server that has gone away
      // looks like from here.
      const dead: SocketLike = {
        binaryType: "arraybuffer",
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        send: () => {},
        close: () => {},
      };
      setTimeout(() => dead.onclose?.({ code: 1006, reason: "gone" }), 0);
      return dead;
    }
    const ws = new WebSocket(url);
    const proxy: SocketLike = {
      binaryType: "arraybuffer",
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: (d) => ws.send(d as never),
      close: () => ws.close(),
    };
    ws.binaryType = "arraybuffer";
    ws.onopen = (ev) => proxy.onopen?.(ev);
    ws.onclose = (ev) => proxy.onclose?.(ev as { code?: number; reason?: string });
    ws.onerror = (ev) => proxy.onerror?.(ev);
    ws.onmessage = (ev) => {
      if (fault === "lose-registered" && typeof ev.data === "string") {
        const frame = JSON.parse(ev.data) as Record<string, unknown>;
        if (frame["res"] === "registered") return;
      }
      proxy.onmessage?.(ev as { data: unknown });
    };
    return proxy;
  };
  return { factory, count: () => n };
}

/** A saver that records what it was handed and can fail on the nth call. */
function saver(failOn?: number): {
  save: (c: DeviceConfig) => Promise<void>;
  saved: DeviceConfig[];
  disk: () => DeviceConfig | undefined;
} {
  const saved: DeviceConfig[] = [];
  return {
    saved,
    disk: () => saved[saved.length - 1],
    save: async (c) => {
      if (saved.length + 1 === failOn) {
        throw new Error(`the disk is full, as it were (save ${failOn})`);
      }
      saved.push(c);
    },
  };
}

/**
 * A vault with a credential, a data key and one device on it, plus a protocol
 * 3 shaped config for a second device.
 *
 * The device already on it is the reader below, which is how the rows are
 * counted: listing devices is a device's operation and a registrar reads
 * nothing, so somebody has to be on the vault to ask. It is filtered out of
 * every count, because what is being counted is what the *conversion* left.
 */
let reader: { deviceId: string; token: string } | undefined;

async function vaultAndUnconverted(): Promise<{ secret: Uint8Array; config: DeviceConfig }> {
  server = new TestServer();
  await server.start();
  const secret = generateSecret();
  const wrapped = await testWrapped(secret);
  // Claimed through the harness, so the first-run token is spent exactly once
  // and every later session offers the derived key, as the shells do.
  const claiming = await Registrar.open({
    url: server.wsUrl,
    vaultId: "default",
    device: "first",
    secret,
    ...server.registrarCredentials(authToken(await deriveRootKeys(secret)), wrapped),
    timeoutMs: 15_000,
  });
  claiming.close();
  reader = await server.deviceCredentials(secret, wrapped, "reader");
  return {
    secret,
    config: { url: server.wsUrl, vaultId: "default", device: "laptop", secret },
  };
}

/** Every device row the vault holds except the reader's, which is doing the asking. */
async function rows(_secret: Uint8Array): Promise<{ id: string; name: string }[]> {
  const t = new Transport(server!.wsUrl, { onBatch: () => {}, timeoutMs: 15_000 });
  await t.connect();
  try {
    await t.hello({
      vault: "default",
      deviceId: reader!.deviceId,
      token: reader!.token,
      device: "reader",
      cursor: 0,
    });
    const { devices } = await t.devices();
    return devices
      .filter((d) => d.id !== reader!.deviceId)
      .map((d) => ({ id: d.id, name: d.name }));
  } finally {
    t.close();
  }
}

/** Converts, with no faults, and returns what ended up on disk. */
async function finish(config: DeviceConfig): Promise<DeviceConfig> {
  const s = saver();
  return convertToDevice(config, s.save, { timeoutMs: 15_000 });
}

describe("converting a protocol 3 device", () => {
  it("registers a row, takes the data key, and drops the root", async () => {
    const { secret, config } = await vaultAndUnconverted();
    const s = saver();
    const converted = await convertToDevice(config, s.save, { timeoutMs: 15_000 });

    expect(converted.secret, "the root is still on this device").toBeUndefined();
    expect(converted.bootstrap).toBeUndefined();
    expect(converted.claimWrapped).toBeUndefined();
    expect(converted.wrapped).toBeUndefined();
    expect(converted.deviceId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(converted.deviceSecret?.length).toBe(32);
    expect(converted.dataKey?.length).toBe(32);
    expect(needsConversion(converted)).toBe(false);

    // One row, named for this device, and nothing else.
    expect(await rows(secret)).toEqual([{ id: converted.deviceId!, name: "laptop" }]);
  }, 60_000);

  /**
   * The id and the secret reach the disk before a single frame goes out. That
   * is the ordering rotation established after a real incident, and here it is
   * load-bearing for a different reason: without it a crash after the
   * registration leaves a committed row whose credential nothing remembers,
   * and the retry registers a second one.
   */
  it("saves the id and the secret before it sends anything", async () => {
    const { config } = await vaultAndUnconverted();
    const s = saver();
    await convertToDevice(config, s.save, { timeoutMs: 15_000 });
    const first = s.saved[0]!;
    expect(first.deviceId, "the first save carried no device id").toBeDefined();
    expect(first.deviceSecret, "the first save carried no device secret").toBeDefined();
    // And it still has the root at that point: the root goes last, after the
    // row has been used, or a crash here would leave a device with neither
    // credential.
    expect(first.secret).toBeDefined();
    expect(first.dataKey, "the data key cannot be known before registering").toBeUndefined();
  }, 60_000);

  it("does nothing to a config that has already converted", async () => {
    const { config } = await vaultAndUnconverted();
    const converted = await finish(config);
    const s = saver();
    expect(await convertToDevice(converted, s.save, { timeoutMs: 15_000 })).toBe(converted);
    expect(s.saved, "a converted device wrote its config again").toEqual([]);
  }, 60_000);
});

describe("a conversion interrupted, at each of its steps", () => {
  /**
   * Crash 1: before the first save. Nothing was written and nothing was sent,
   * so the device is exactly the protocol 3 device it was.
   */
  it("leaves the config untouched when the first save fails", async () => {
    const { secret, config } = await vaultAndUnconverted();
    const s = saver(1);
    await expect(convertToDevice(config, s.save, { timeoutMs: 15_000 })).rejects.toThrow(/save 1/);
    expect(s.saved).toEqual([]);
    expect(await rows(secret), "a row was registered before the id was saved").toEqual([]);

    const converted = await finish(config);
    expect(converted.secret).toBeUndefined();
    expect(await rows(secret)).toHaveLength(1);
  }, 60_000);

  /**
   * Crash 2: the id and the secret are on disk and the server was never
   * reached. The retry uses the same id, so there is still one row.
   */
  it("converts again with the same id when the registration never went out", async () => {
    const { secret, config } = await vaultAndUnconverted();
    const s = saver();
    const { factory } = faulty(["refuse"]);
    await expect(
      convertToDevice(config, s.save, { timeoutMs: 5_000, socketFactory: factory }),
    ).rejects.toThrow();
    const partial = s.disk()!;
    expect(partial.deviceId).toBeDefined();
    expect(partial.secret, "the root was dropped before there was a row").toBeDefined();
    expect(await rows(secret)).toEqual([]);

    const converted = await finish(partial);
    expect(converted.deviceId, "the retry chose a new id").toBe(partial.deviceId);
    expect(converted.secret).toBeUndefined();
    expect(await rows(secret)).toEqual([{ id: partial.deviceId!, name: "laptop" }]);
  }, 60_000);

  /**
   * Crash 3, and the one the server's duplicate rule exists for. The row is
   * committed and the reply never arrives, so the device does not know it has
   * one. Registering the same id with the same key again succeeds and is the
   * registration having happened; answering `badentry` there would leave this
   * device retrying for ever.
   */
  it("converts again after a registration that committed with its reply lost", async () => {
    const { secret, config } = await vaultAndUnconverted();
    const s = saver();
    const { factory } = faulty(["lose-registered"]);
    await expect(
      convertToDevice(config, s.save, { timeoutMs: 5_000, socketFactory: factory }),
    ).rejects.toThrow();
    const partial = s.disk()!;
    expect(partial.deviceId).toBeDefined();
    expect(partial.dataKey, "a data key was saved from a reply that never came").toBeUndefined();
    expect(partial.secret).toBeDefined();
    // The server did commit, which is what makes this different from the case
    // above and is the whole reason the id had to be on disk first.
    expect(await rows(secret)).toEqual([{ id: partial.deviceId!, name: "laptop" }]);

    const converted = await finish(partial);
    expect(converted.secret).toBeUndefined();
    expect(converted.deviceId).toBe(partial.deviceId);
    expect(await rows(secret), "the retry registered a second row").toHaveLength(1);
  }, 60_000);

  /**
   * Crash 4: the row is registered and the data key could not be written down.
   * The device still holds the root, so it can unwrap it again next time.
   */
  it("converts again when the data key could not be saved", async () => {
    const { secret, config } = await vaultAndUnconverted();
    const s = saver(2);
    await expect(convertToDevice(config, s.save, { timeoutMs: 15_000 })).rejects.toThrow(/save 2/);
    const partial = s.disk()!;
    expect(partial.dataKey).toBeUndefined();
    expect(partial.secret).toBeDefined();
    expect(await rows(secret)).toHaveLength(1);

    const converted = await finish(partial);
    expect(converted.dataKey?.length).toBe(32);
    expect(converted.secret).toBeUndefined();
    expect(await rows(secret)).toHaveLength(1);
  }, 60_000);

  /**
   * Crash 5: everything is on disk and the confirming connection did not
   * happen. The root is still there, so this is the state step 1 detects and
   * finishes rather than starting again.
   */
  it("converts again when the confirming connection could not be made", async () => {
    const { secret, config } = await vaultAndUnconverted();
    const s = saver();
    // The registrar connection is the first; the device hello is the second.
    const { factory } = faulty(["ok", "refuse"]);
    await expect(
      convertToDevice(config, s.save, { timeoutMs: 5_000, socketFactory: factory }),
    ).rejects.toThrow();
    const partial = s.disk()!;
    expect(partial.dataKey).toBeDefined();
    expect(partial.secret, "the root was dropped on an unconfirmed row").toBeDefined();

    const converted = await finish(partial);
    expect(converted.secret).toBeUndefined();
    expect(await rows(secret)).toHaveLength(1);
  }, 60_000);

  /**
   * Crash 6, which the spec calls out by name: registered, confirmed, and the
   * root not yet dropped. The device has a row and still has the root, so it
   * must finish rather than start again.
   */
  it("finishes, rather than starting again, when only the root is left to drop", async () => {
    const { secret, config } = await vaultAndUnconverted();
    const s = saver(3);
    await expect(convertToDevice(config, s.save, { timeoutMs: 15_000 })).rejects.toThrow(/save 3/);
    const partial = s.disk()!;
    expect(partial.deviceId).toBeDefined();
    expect(partial.dataKey).toBeDefined();
    expect(partial.secret, "the root went before the save that removes it").toBeDefined();
    expect(await rows(secret)).toHaveLength(1);

    const converted = await finish(partial);
    expect(converted.secret).toBeUndefined();
    expect(converted.deviceId).toBe(partial.deviceId);
    expect([...converted.dataKey!]).toEqual([...partial.dataKey!]);
    expect(await rows(secret), "finishing registered a second row").toHaveLength(1);
  }, 60_000);

  /**
   * Rule 5, in the shape it takes here. One device, interrupted three times in
   * three different places and then allowed to finish, and the vault holds one
   * row for it rather than four. The cap is eight, and a conversion that left a
   * row behind per crash would fill a vault with devices nobody can name and
   * refuse the ninth real one with `full`.
   */
  it("leaves one row however often it is interrupted", async () => {
    const { secret, config } = await vaultAndUnconverted();
    let disk = config;
    const attempt = async (
      s: ReturnType<typeof saver>,
      opts: { socketFactory?: (url: string) => SocketLike } = {},
    ) => {
      await expect(convertToDevice(disk, s.save, { timeoutMs: 5_000, ...opts })).rejects.toThrow();
      if (s.disk()) disk = s.disk()!;
    };

    // Registered, and the data key not written down.
    await attempt(saver(2));
    // Registered again, the same id and the same key, and interrupted again.
    await attempt(saver(1));
    // Data key written down, and the confirming connection could not be made.
    await attempt(saver(), { socketFactory: faulty(["ok", "refuse"]).factory });

    const converted = await finish(disk);
    expect(converted.secret).toBeUndefined();
    expect(await rows(secret)).toEqual([{ id: converted.deviceId!, name: "laptop" }]);
  }, 90_000);
});
