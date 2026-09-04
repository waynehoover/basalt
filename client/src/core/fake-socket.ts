/**
 * A socket under a test's control, and an engine wired to one.
 *
 * `server-harness.test.ts` proves the client and the real server agree. It
 * cannot prove the client is robust, because the real server never lies, so
 * this is the lying peer: it can say anything at all, in any order, and it
 * answers by echoing the id of the newest request unless told otherwise, which
 * is what a correct server does and what almost every case wants.
 *
 * Imported only by tests, like test-server.ts, so nothing here reaches a
 * shipped bundle.
 */

import { type Schedule } from "./crypto.ts";
import { TEST_DATA_KEY, testKeys, testWrapped } from "./test-keys.ts";
import { Engine } from "./engine.ts";
import { Transport, type SocketLike } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

export class FakeSocket implements SocketLike {
  binaryType = "";
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  /** Everything the client sent, in order. */
  readonly sentText: Record<string, unknown>[] = [];
  readonly sentBinary: Uint8Array[] = [];
  closed = false;
  /**
   * Answers a request the moment it is sent, on the next tick, for the cases
   * where the engine is driving and the test only watches what went out.
   */
  autoReply: ((frame: Record<string, unknown>, socket: FakeSocket) => void) | undefined;

  send(data: string | ArrayBufferLike | Uint8Array): void {
    if (typeof data === "string") {
      const frame = JSON.parse(data) as Record<string, unknown>;
      this.sentText.push(frame);
      const auto = this.autoReply;
      if (auto) setTimeout(() => auto(frame, this), 0);
    } else
      this.sentBinary.push(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(undefined);
  }

  /** The id of the newest request that carried one. */
  get lastId(): number | undefined {
    for (let i = this.sentText.length - 1; i >= 0; i--) {
      const id = this.sentText[i]!["id"];
      if (typeof id === "number") return id;
    }
    return undefined;
  }

  /** Delivers a reply, under the id of the newest request unless told otherwise. */
  reply(frame: Record<string, unknown>): void {
    const out = { ...frame };
    if (out["id"] === null) delete out["id"];
    else if (out["id"] === undefined && "res" in out && out["res"] !== "pong") {
      const id = this.lastId;
      if (id !== undefined) out["id"] = id;
    }
    this.raw(out);
  }

  /** Delivers exactly this text frame. */
  raw(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  body(bytes: Uint8Array): void {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  /** Answers a fetch: the header, then the bodies, as a protocol 4 server does. */
  bodies(...bodies: Uint8Array[]): void {
    this.reply({ res: "bodies", count: bodies.length });
    for (const b of bodies) this.body(b);
  }

  hangUp(code = 1006, reason = "gone"): void {
    this.onclose?.({ code, reason });
  }
}

/** A well-formed ready, with whatever the case wants changed. */
export function ready(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    res: "ready",
    proto: 4,
    minProto: 4,
    serverVersion: "test",
    cursor: 10,
    perFileMax: 1,
    chunkMax: 1,
    maxChunks: 1,
    maxBatchBytes: 16 << 20,
    maxFetchBytes: 64 << 20,
    // Every vault has one, so the well-formed frame carries one. A case that
    // wants a server without it passes `wrapped: undefined`.
    wrapped: RIG_WRAPPED,
    ...over,
  };
}

/** Lets queued notification work run before asserting on it. */
export const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

/** The fixed root every fake-socket rig derives its keys from. */
export const RIG_SECRET = new Uint8Array(32).fill(1);

/** The vault's data key as the rig's server holds it, wrapped under RIG_SECRET. */
const RIG_WRAPPED = await testWrapped(RIG_SECRET);

/** An engine wired to a fake socket, connected, with limits of the test's choosing. */
export async function engineOnFakeSocket(
  limits: {
    maxChunks?: number;
    perFileMax?: number;
    chunkMax?: number;
    maxBatchBytes?: number;
    maxFetchBytes?: number;
    cursor?: number;
  } = {},
  opts: { vault?: MemoryVault } = {},
): Promise<{
  engine: Engine;
  socket: FakeSocket;
  t: Transport;
  vault: MemoryVault;
  logs: string[];
  keys: Schedule;
}> {
  const socket = new FakeSocket();
  const logs: string[] = [];
  let engine!: Engine;
  const t = new Transport("ws://test", {
    onBatch: (b) => engine.acceptBatch(b),
    socketFactory: () => socket,
    timeoutMs: 2000,
    log: (m, ...rest) => void logs.push(`${m} ${rest.map((r) => JSON.stringify(r)).join(" ")}`),
  });
  const connecting = t.connect();
  socket.open();
  await connecting;

  const vault = opts.vault ?? new MemoryVault();
  const keys = await testKeys(RIG_SECRET);
  engine = new Engine({
    vault,
    store: new MemoryIndexStore(),
    dataKey: TEST_DATA_KEY,
    transport: t,
    device: "d",
    vaultId: "v",
    deviceId: "rig-device",
    token: "t",
    log: (m, ...rest) => void logs.push(`${m} ${rest.map((r) => JSON.stringify(r)).join(" ")}`),
  });
  const started = engine.start();
  await settle();
  socket.reply(
    ready({
      cursor: limits.cursor ?? 0,
      perFileMax: limits.perFileMax ?? 1 << 28,
      chunkMax: limits.chunkMax ?? 1 << 20,
      maxChunks: limits.maxChunks ?? 100,
      maxBatchBytes: limits.maxBatchBytes ?? 16 << 20,
      maxFetchBytes: limits.maxFetchBytes ?? 64 << 20,
    }),
  );
  await settle();
  socket.raw({ op: "caught-up", cursor: limits.cursor ?? 0 });
  await started;
  return { engine, socket, t, vault, logs, keys };
}
