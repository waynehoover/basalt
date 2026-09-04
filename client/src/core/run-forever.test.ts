/**
 * The long-running loop, and what a shell can rely on from it.
 *
 * `runForever` builds a client, syncs, waits for the connection to end and
 * builds another. The gaps between those steps are where a shell gets hurt: a
 * pass still writing when the next client loads the index, a handshake that
 * cannot be stopped once started, a pass that ran and nobody was told.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client, runForever, type ClientOptions } from "./client.ts";
import { authToken, type VaultKeys } from "./crypto.ts";
import { testKeys, testWrapped } from "./test-keys.ts";
import type { SyncReport } from "./engine.ts";
import { TestServer, cleanupBinary, serverBinary, until } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault, type Times } from "./vault.ts";

const SECRET = new Uint8Array(32).fill(21);
let keys: VaultKeys;
let wrapped: string;
beforeAll(async () => {
  await serverBinary();
  keys = await testKeys(SECRET);
  wrapped = await testWrapped(SECRET);
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer;
const open: Client[] = [];
const loops: Promise<void>[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await Promise.all(loops.splice(0));
  if (server) await server.cleanup();
});

function options(
  name: string,
  vault: MemoryVault,
  extra: Partial<ClientOptions> = {},
): ClientOptions {
  return {
    vault,
    store: new MemoryIndexStore(),
    secret: SECRET,
    url: server.wsUrl,
    ...server.credentials(authToken(keys), wrapped),
    vaultId: "default",
    device: name,
    timeoutMs: 20_000,
    coalesceWrites: false,
    ...extra,
  };
}

async function connected(name: string, vault = new MemoryVault()): Promise<Client> {
  const c = new Client(options(name, vault));
  open.push(c);
  await c.connect();
  return c;
}

/** A vault whose writes wait until the test says go. */
class SlowWriteVault extends MemoryVault {
  gate: Promise<void> = Promise.resolve();
  writesStarted = 0;
  writesFinished = 0;
  override async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    this.writesStarted++;
    await this.gate;
    await super.write(path, bytes, times);
    this.writesFinished++;
  }
}

describe("a connection that ends while a pass is running (C6)", () => {
  /**
   * `runUntilClosed` resolved the moment the transport closed, while a pass
   * started by a batch arriving could still be writing the vault and the
   * index. The loop then reported the client gone and built a new one that
   * loaded the index the old engine was about to overwrite.
   */
  it("finishes the pass before reporting the client gone", async () => {
    server = new TestServer();
    await server.start();
    const av = new MemoryVault();
    const a = await connected("a", av);

    const slow = new SlowWriteVault();
    let live: Client | undefined;
    let running = true;
    let goneWithWritesFinished = -1;
    loops.push(
      runForever(options("b", slow), {
        onClient: (client) => {
          if (client) {
            live = client;
            return;
          }
          // The moment the loop says this client is finished with.
          goneWithWritesFinished = slow.writesFinished;
          running = false;
        },
        keepGoing: () => running,
      }),
    );
    await until("b to connect", () => live !== undefined);

    // A write arrives and b's pass gets stuck writing it.
    let release!: () => void;
    slow.gate = new Promise<void>((r) => (release = r));
    await av.edit("note.md", "from a\n");
    await a.settle();
    await until("b to start writing", () => slow.writesStarted > 0);

    // The connection drops under the running pass. The pass is let go
    // shortly after, as a slow disk would.
    live!.transport.close();
    setTimeout(release, 700);
    await until("the loop to report b gone", () => goneWithWritesFinished >= 0, 20_000);

    expect(goneWithWritesFinished, "reported gone while its pass was still writing").toBe(1);
    expect(slow.text("note.md")).toBe("from a\n");
  }, 120_000);
});

describe("a settle that is between passes when the client closes (C6)", () => {
  /**
   * `settle` sleeps between passes, outside the serial queue. `close` drained
   * an idle queue and resolved, and the next pass then ran against the closed
   * transport and saved the index, after whoever closed the client had
   * removed it.
   */
  it("starts no further pass, so nothing is saved after close resolves", async () => {
    server = new TestServer();
    await server.start();
    const vault = new MemoryVault();
    const store = new MemoryIndexStore();
    const c = new Client({ ...options("a", vault), store });
    open.push(c);
    await c.connect();
    await vault.edit("note.md", "one\n");

    // Pass one does something, so settle will sleep and go again.
    const settling = c.settle();
    await until("the first pass to save", () => store.saves >= 1, 10_000);
    await c.close();
    const saves = store.saves;
    await settling.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(store.saves, "a pass ran after close had resolved").toBe(saves);
  }, 60_000);
});

describe("what a shell is handed and when", () => {
  /**
   * The first settle has to happen whether or not anybody asked to hear
   * about it. It was the argument of an optional call to `onSynced`, and an
   * optional call on nothing skips its arguments, so a shell that listened
   * through `onPass` instead never had its first sync until the ticker.
   */
  it("settles on connecting even when nobody listens for the report", async () => {
    server = new TestServer();
    await server.start();
    const vault = new MemoryVault();
    await vault.edit("note.md", "here\n");
    const passes: SyncReport[] = [];
    let running = true;
    let live: Client | undefined;
    const loop = runForever(options("a", vault, { onPass: (r) => void passes.push(r) }), {
      onClient: (c) => {
        live = c ?? live;
      },
      keepGoing: () => running,
    });
    loops.push(loop);
    await until("the first pass", () => passes.length > 0, 10_000);
    expect(passes[0]!.uploaded).toBe(1);
    running = false;
    await live?.close();
  }, 60_000);

  it("hands over the client before it connects, and stops if told to during the handshake", async () => {
    server = new TestServer();
    await server.start();

    let connecting: Client | undefined;
    let running = true;
    const clients: (Client | undefined)[] = [];
    let synced = 0;
    await runForever(options("b", new MemoryVault()), {
      onConnecting: (client) => {
        connecting = client;
        // The shell decides to stop while the handshake is in flight.
        running = false;
      },
      onClient: (client) => void clients.push(client),
      onSynced: () => void synced++,
      keepGoing: () => running,
    });

    expect(connecting).toBeInstanceOf(Client);
    // It never became the live client and never synced: stopped means stopped.
    expect(clients.filter((c) => c !== undefined)).toEqual([]);
    expect(synced).toBe(0);
    expect(connecting!.transport.isClosed).toBe(true);
  }, 120_000);

  /**
   * Every pass, from one place. A pass can start from the ticker, from a
   * batch arriving, from the watcher or from a shell asking, and a shell that
   * hooked each of those separately missed some.
   */
  it("reports every pass, whether the ticker or an arrival started it", async () => {
    server = new TestServer();
    await server.start();
    const av = new MemoryVault();
    const a = await connected("a", av);

    const reports: SyncReport[] = [];
    const vault = new MemoryVault();
    const b = new Client(options("b", vault, { onPass: (r) => void reports.push(r) }));
    open.push(b);
    await b.connect();
    const running = b.runUntilClosed(200);

    // The ticker, with nothing to do.
    await until("a ticker pass", () => reports.length >= 1);
    expect(reports[0]!.downloaded).toBe(0);

    // An arrival: a writes, the batch reaches b, and b's own pass fetches it.
    await av.edit("note.md", "from a\n");
    await a.settle();
    await until("an arrival pass", () => reports.some((r) => r.downloaded === 1));
    expect(vault.text("note.md")).toBe("from a\n");

    await b.close();
    await running;
  }, 120_000);
});

/**
 * I2 and review finding C27. `busy` used to be in the loop's fatal list, so a
 * device refused for the device limit, or told the server was shutting down,
 * stopped for good. The server now says on every error whether reconnecting
 * can help, and the loop has nothing to interpret: retryable goes to backoff,
 * anything else stops it. The hint that travels with busy lengthens the wait.
 */
describe("what the loop does with a refusal (I2, C27)", () => {
  it("retries a busy and stops on an auth, by the server's word rather than a list", async () => {
    const { isFatal, retryWait } = await import("./client.ts");
    const { ProtocolError } = await import("./transport.ts");
    expect(isFatal(new ProtocolError("busy", "shutting down", { retryable: true }))).toBe(false);
    expect(
      isFatal(new ProtocolError("busy", "device limit", { retryable: true, retryAfterMs: 30_000 })),
    ).toBe(false);
    expect(isFatal(new ProtocolError("auth", "no", { retryable: false }))).toBe(true);
    expect(isFatal(new ProtocolError("cursor", "ahead", { retryable: false }))).toBe(true);
    // The field wins over the code, in both directions.
    expect(isFatal(new ProtocolError("busy", "x", { retryable: false }))).toBe(true);
    expect(isFatal(new ProtocolError("badname", "x", { retryable: true }))).toBe(false);
    // A connection that simply dropped is not a refusal, and is retried.
    expect(isFatal(new Error("the connection closed"))).toBe(false);

    // The wait is the backoff, or the server's hint if that is longer.
    expect(
      retryWait(new ProtocolError("busy", "x", { retryable: true, retryAfterMs: 30_000 }), 5_000),
    ).toBe(30_000);
    expect(
      retryWait(new ProtocolError("busy", "x", { retryable: true, retryAfterMs: 1_000 }), 5_000),
    ).toBe(5_000);
    expect(retryWait(new Error("dropped"), 2_500)).toBe(2_500);
  });

  it("comes back after the server restarts, rather than stopping", async () => {
    server = new TestServer();
    await server.start();
    // Claimed first by a throwaway client, so the loop below authenticates
    // with the derived key on every connection, as a shell does once its
    // bootstrap is spent. Options are built once and reused by the loop.
    const warm = await connected("warm", new MemoryVault());
    await warm.close();
    const vault = new MemoryVault();
    let running = true;
    let fatal: Error | undefined;
    const disconnects: Error[] = [];
    let connections = 0;
    const loop = runForever(options("a", vault), {
      onClient: (c) => {
        if (c) connections++;
      },
      onDisconnected: (cause) => void disconnects.push(cause),
      onFatal: (cause) => {
        fatal = cause;
      },
      keepGoing: () => running,
    });
    loops.push(loop);
    await until("the first connection", () => connections === 1);

    // A restart: the server sends every idle session busy and closes it.
    const port = server.port;
    await server.stop();
    await until("the loop to notice", () => disconnects.length >= 1, 20_000);
    expect(fatal, "a shutdown notice stopped the loop for good").toBeUndefined();
    await server.start(port);
    await until("the loop to reconnect", () => connections === 2, 60_000);
    running = false;
    // The loop is waiting inside runUntilClosed; end its connection to let it see keepGoing.
    await server.stop();
    await loop;
  }, 120_000);
});
