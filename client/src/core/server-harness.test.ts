/**
 * The client against the real server.
 *
 * These tests build `cmd/basaltd`, run it on a loopback port with a temporary
 * data directory, and talk to it with the actual transport. Nothing is mocked:
 * the sealing is real, the chunking is real, the SQLite writes are real, and the
 * assertions are checked by asking the server's own `verify` whether what it
 * stored is serveable.
 *
 * This is the test that could not be written until both halves existed, and it is
 * the one that matters: every protocol decision in docs/protocol.md was made on
 * one side of the wire, and two implementations that each pass their own suites
 * can still disagree about the wire between them.
 *
 * They did not, here. The whole file passed on its first run, which is exactly
 * when to go looking for tests that assert nothing, so each one below was checked
 * by breaking the transport and watching it fail.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { chunkBytes, looksLikeText, sizesFor } from "./chunk.ts";
import {
  authToken,
  deriveRootKeys,
  macEntry,
  openChunk,
  openPath,
  parentOf,
  sealChunks,
  sealPath,
  type Schedule,
} from "./crypto.ts";
import { testKeys, testWrapped } from "./test-keys.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { ProtocolError, Transport, type Batch, type BatchEntry } from "./transport.ts";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The keys every client in this file shares, derived once.
 *
 * One vault, one root secret, and the auth key is a branch of the same schedule,
 * so every device that has the secret authenticates with the same key.
 */
let sharedKeys: Schedule | undefined;
async function vaultKeys(): Promise<Schedule> {
  sharedKeys ??= await testKeys(SECRET);
  return sharedKeys;
}
const enc = new TextEncoder();

/**
 * A mac of the right shape. These cases test the server's own refusals, and the
 * server holds no key: it checks that an entry carries an authenticator, never
 * what the authenticator says.
 */
/**
 * No authenticator, for the puts below that are about the transport rather
 * than about the entry. `put` takes it rather than defaulting it, so that a
 * caller that has one cannot forget to pass it; a test that deliberately has
 * none says so here.
 */
const unsigned = { mac: "", parent: "" };

const shapedMac = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const dec = new TextDecoder();

// Built once for the whole suite by vitest.global-setup.ts. This file used to
// build its own copy into its own temporary directory, which is a third `go
// build` of the same package racing the others.
beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

/**
 * The server, from `test-server.ts`.
 *
 * This file used to carry its own copy of that class, which drifted: the copy
 * kept picking a random port out of a thousand while the shared one had moved
 * to asking the operating system for a free one, so this file's tests failed
 * every so often and blamed whichever one was running.
 */
const Server = TestServer;
type Server = TestServer;

/** A client: keys, a transport, and the batches it has been given. */
class Client {
  readonly batches: Batch[] = [];
  readonly entries = new Map<number, Batch["entries"][number]>();
  caughtUpAt: number | undefined;
  transport!: Transport;

  constructor(
    readonly keys: Schedule,
    readonly device: string,
  ) {}

  async connect(server: Server, cursor = 0) {
    this.transport = new Transport(server.wsUrl, {
      onBatch: (b) => {
        this.batches.push(b);
        for (const e of b.entries) this.entries.set(e.uid, e);
      },
      onCaughtUp: (c) => {
        this.caughtUpAt = c;
      },
      timeoutMs: 15_000,
    });
    await this.transport.connect();
    return this.transport.hello({
      vault: "default",
      device: this.device,
      cursor,
      ...(await server.deviceCredentials(SECRET, await testWrapped(SECRET), this.device)),
    });
  }

  /** Chunks, seals and puts a file exactly as the engine will. */
  async write(path: string, content: string | Uint8Array, mtime = 1000) {
    const data = typeof content === "string" ? enc.encode(content) : content;
    const isText = looksLikeText(path);
    const parts = [...chunkBytes(data, sizesFor(data.length, isText), isText)].map((c) => c.bytes);
    const sealed = await sealChunks(this.keys, parts);
    const sealedPath = await sealPath(this.keys, path);
    const names = sealed.map((c) => c.name);
    const meta = { size: data.length, ctime: 1, mtime };
    // Signed, because the engine signs and this exists to do exactly what
    // the engine does.
    const parent = await parentOf("");
    const mac = await macEntry(this.keys, {
      path: sealedPath,
      size: meta.size,
      ctime: meta.ctime,
      mtime: meta.mtime,
      folder: false,
      deleted: false,
      chunks: names,
      parent,
    });
    const result = await this.transport.put(
      sealedPath,
      meta,
      names,
      async (n) => sealed.find((c) => c.name === n)!.bytes,
      { mac, parent },
    );
    return { ...result, chunks: names, plaintext: data };
  }

  /** Chunks, seals and puts several files in one batched exchange. */
  async writeMany(files: { path: string; content: string; mtime?: number }[]) {
    const bodies = new Map<string, Uint8Array>();
    const entries: BatchEntry[] = [];
    for (const f of files) {
      const data = enc.encode(f.content);
      const isText = looksLikeText(f.path);
      const parts = [...chunkBytes(data, sizesFor(data.length, isText), isText)].map(
        (c) => c.bytes,
      );
      const sealed = await sealChunks(this.keys, parts);
      for (const c of sealed) bodies.set(c.name, c.bytes);
      const path = await sealPath(this.keys, f.path);
      const meta = { size: data.length, ctime: 1, mtime: f.mtime ?? 1000 };
      const names = sealed.map((c) => c.name);
      // A real writer signs; the harness is standing in for one.
      const parent = await parentOf("");
      entries.push({
        path,
        meta,
        names,
        parent,
        mac: await macEntry(this.keys, {
          path,
          size: meta.size,
          ctime: meta.ctime,
          mtime: meta.mtime,
          folder: false,
          deleted: false,
          chunks: names,
          parent,
        }),
      });
    }
    const out = await this.transport.putMany(entries, async (n) => bodies.get(n)!);
    return { ...out, entries };
  }

  /** Downloads a version and reassembles the plaintext, as the engine will. */
  async read(uid: number): Promise<Uint8Array> {
    const meta = await this.transport.get(uid);
    if (meta.chunks.length === 0) return new Uint8Array(0);
    const bodies = await this.transport.fetch(meta.chunks);
    const opened: Uint8Array[] = [];
    for (let i = 0; i < bodies.length; i++) {
      opened.push(await openChunk(this.keys, bodies[i]!));
    }
    const total = opened.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of opened) {
      out.set(b, at);
      at += b.length;
    }
    return out;
  }

  close() {
    this.transport?.close();
  }
}

const SECRET = new Uint8Array(32).fill(21);
let server: Server;
const clients: Client[] = [];

async function newClient(device: string, cursor = 0): Promise<Client> {
  const c = new Client(await testKeys(SECRET), device);
  clients.push(c);
  await c.connect(server, cursor);
  return c;
}

beforeAll(async () => {
  // One shared server for the read-only cases; tests that need a fresh vault
  // start their own.
  server = new Server();
  await server.start();
}, 60_000);

afterAll(async () => {
  for (const c of clients) c.close();
  await server.cleanup();
});

afterEach(() => {
  while (clients.length) clients.pop()!.close();
});

/** Waits for a condition, rather than sleeping a guessed interval. */
async function until(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the handshake, against the real server", () => {
  it("agrees on the protocol and the limits", async () => {
    // The values the server enforces, which the client has to know before
    // its first put or it will send something that can never be accepted.
    const c = new Client(await testKeys(SECRET), "a");
    clients.push(c);
    const ready = await c.connect(server);
    expect(ready.proto).toBe(4);
    // One protocol, so the range the server speaks is one number wide.
    expect(ready.minProto).toBe(4);
    expect(ready.serverVersion).not.toBe("");
    // And a data key, which every vault has.
    expect(ready.wrapped).not.toBe("");
    // The two caps, at the server's own constants.
    expect(ready.maxBatchBytes).toBe(16 * 1024 * 1024);
    expect(ready.maxFetchBytes).toBe(64 * 1024 * 1024);
    expect(ready.chunkMax).toBe(1024 * 1024);
    // The default, which is a server's policy rather than the store's
    // ceiling: preparing a file to send costs the client several times the
    // file, so what the server accepts is chosen for the devices syncing it
    // and `basalt serve -max-file` moves it.
    expect(ready.perFileMax).toBe(64 * 1024 * 1024);
    expect(ready.maxChunks).toBe(65536);
  });

  it("is refused with the wrong token", async () => {
    const t = new Transport(server.wsUrl, { onBatch: () => {}, timeoutMs: 10_000 });
    await t.connect();
    await expect(
      t.hello({
        vault: "default",
        deviceId: (await server.deviceCredentials(SECRET, await testWrapped(SECRET), "impostor"))
          .deviceId,
        token: "not-the-token",
        device: "impostor",
        cursor: 0,
      }),
    ).rejects.toMatchObject({ code: "auth" });
    t.close();
  });

  it("is refused for the wrong vault, indistinguishably", async () => {
    const t = new Transport(server.wsUrl, { onBatch: () => {}, timeoutMs: 10_000 });
    await t.connect();
    await expect(
      t.hello({
        vault: "someone-elses",
        ...(await server.deviceCredentials(SECRET, await testWrapped(SECRET), "a")),
        device: "a",
        cursor: 0,
      }),
    ).rejects.toMatchObject({ code: "auth" });
    t.close();
  });

  it("is refused when this device claims a cursor the server never issued", async () => {
    // The server has lost history this device already applied, so continuing
    // would have it reissue those uids for other files.
    const t = new Transport(server.wsUrl, { onBatch: () => {}, timeoutMs: 10_000 });
    await t.connect();
    await expect(
      t.hello({
        ...(await server.deviceCredentials(SECRET, await testWrapped(SECRET), "a")),
        vault: "default",
        device: "a",
        cursor: 999_999,
      }),
    ).rejects.toMatchObject({ code: "cursor" });
    t.close();
  });
});

describe("a file, all the way there and back", () => {
  it("round trips through chunking, sealing, the wire, and the server", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);

      const content = "# A real note\n\nWith several lines.\n\nAnd a second paragraph.\n";
      const put = await c.write("notes/real.md", content);
      expect(put.uid).toBe(1);
      expect(put.uploaded).toBeGreaterThan(0);

      const back = await c.read(put.uid);
      expect(dec.decode(back)).toBe(content);

      // And the server agrees that what it stored is serveable.
      const verified = await fresh.cli("verify", "-deep");
      expect(verified).toMatch(/0 faults/);
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 60_000);

  it("round trips a file large enough to be chunked many times", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);

      let text = "";
      for (let i = 0; i < 4000; i++)
        text += `Paragraph ${i} with a reasonable number of words in it.\n\n`;
      const put = await c.write("notes/long.md", text);
      // Many chunks, not a specific number: the count depends on the size
      // the chunker picks for a file this big, and that scales with the
      // file rather than being one constant for a note and a novel.
      expect(
        put.chunks.length,
        `a ${text.length} byte note became ${put.chunks.length} chunks`,
      ).toBeGreaterThan(10);

      expect(dec.decode(await c.read(put.uid))).toBe(text);
      expect(await fresh.cli("verify", "-deep")).toMatch(/0 faults/);
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 120_000);

  it("round trips bytes that are not text", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);

      const bytes = new Uint8Array(600_000);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.imul(i, 2654435761) >>> 24) & 0xff;
      const put = await c.write("files/blob.bin", bytes);

      expect(await c.read(put.uid)).toEqual(bytes);
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 120_000);

  it("round trips an empty note, which carries no chunks at all", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);
      const put = await c.write("notes/empty.md", "");
      expect(put.uploaded).toBe(0);
      expect((await c.read(put.uid)).length).toBe(0);
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 60_000);

  it("round trips a path with the characters that break sync implementations", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);
      const path = "notes/2026-08-27 meeting: with a colon 🗿.md";
      const put = await c.write(path, "content");
      // The server never saw the name, only the sealed form, and the client
      // recovers it from the entry it gets back.
      const sealedPath = await sealPath(c.keys, path);
      expect(await openPath(c.keys, sealedPath)).toBe(path);
      expect(dec.decode(await c.read(put.uid))).toBe("content");
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 60_000);
});

describe("a batched write, which is one exchange for many notes", () => {
  // Every round trip costs a whole latency, so a vault of two hundred notes
  // used to cost two hundred of them. What follows is against the real server,
  // because the round trip count is the thing being tested and a fake socket
  // has none.
  it("commits every note and hands back a uid for each, in order", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);

      const files = Array.from({ length: 40 }, (_, i) => ({
        path: `notes/${i}.md`,
        content: `# Note ${i}\n\nEach one different, so none of them deduplicate.\n`,
      }));
      const before = c.transport.requestsSent;
      const { results, uploaded } = await c.writeMany(files);

      expect(results).toHaveLength(files.length);
      expect(results.map((r) => r.uid)).toEqual(files.map((_, i) => i + 1));
      expect(uploaded).toBe(files.length);
      // One request for forty notes. Not forty, and not forty-one.
      expect(c.transport.requestsSent - before).toBe(1);

      for (let i = 0; i < files.length; i++) {
        expect(dec.decode(await c.read(results[i]!.uid))).toBe(files[i]!.content);
      }
      expect(await fresh.cli("verify", "-deep")).toMatch(/0 faults/);
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 60_000);

  it("uploads a chunk two notes share exactly once", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);
      const same = "# Identical\n\nThe same bytes in two places.\n";
      const { results, uploaded } = await c.writeMany([
        { path: "a.md", content: same },
        { path: "b.md", content: same },
      ]);
      expect(results.every((r) => r.uid > 0)).toBe(true);
      expect(uploaded).toBe(1);
      expect(dec.decode(await c.read(results[1]!.uid))).toBe(same);
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 60_000);

  // The reason results carry errors rather than the call throwing: one note
  // the server will not take must not cost the other thirty-nine, and the
  // client has to be told which one it was without bisecting the batch.
  it("refuses one bad entry and commits the rest", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);

      const good = await sealPath(c.keys, "good.md");
      const alsoGood = await sealPath(c.keys, "also-good.md");
      const body = await sealChunks(c.keys, [enc.encode("fine")]);
      const bodies = new Map(body.map((b) => [b.name, b.bytes]));

      const { results } = await c.transport.putMany(
        [
          {
            path: good,
            meta: { size: 4, ctime: 1, mtime: 1 },
            names: [body[0]!.name],
            mac: shapedMac,
            parent: "",
          },
          // A size that no chunk list can honestly account for.
          {
            path: alsoGood,
            meta: { size: -1, ctime: 1, mtime: 1 },
            names: [],
            mac: shapedMac,
            parent: "",
          },
          {
            path: alsoGood,
            meta: { size: 4, ctime: 1, mtime: 2 },
            names: [body[0]!.name],
            mac: shapedMac,
            parent: "",
          },
        ],
        async (n) => bodies.get(n)!,
      );

      expect(results[0]!.uid).toBeGreaterThan(0);
      expect(results[1]!.uid).toBe(0);
      expect(results[1]!.error?.code).toBe("badentry");
      expect(results[2]!.uid).toBeGreaterThan(0);
      // And the session survived it.
      await c.transport.ping();
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 60_000);
});

describe("deduplication, which is the point", () => {
  it("uploads nothing for content the server already holds", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);

      const content = "# Shared\n\nThe very same words.\n";
      const first = await c.write("a.md", content);
      expect(first.uploaded).toBeGreaterThan(0);

      // The same content at a different path. Every chunk is already there.
      const second = await c.write("b.md", content);
      expect(second.uploaded).toBe(0);
      expect(second.bytes).toBe(0);
      expect(second.uid).toBe(first.uid + 1);
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 60_000);

  it("uploads only the chunks an edit changed", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);

      let text = "";
      for (let i = 0; i < 3000; i++) text += `Line ${i} of a long note with words.\n`;
      const first = await c.write("long.md", text);

      // One line inserted a third of the way in.
      const at = text.indexOf("\n", Math.floor(text.length / 3)) + 1;
      const edited = text.slice(0, at) + "An inserted line.\n" + text.slice(at);
      const second = await c.write("long.md", edited, 2000);

      // The measurement that justifies the whole design, taken through a
      // real server rather than in a benchmark.
      expect(second.uploaded).toBeLessThanOrEqual(3);
      // The ratio, not two absolute figures: the claim is that an edit
      // costs a fraction of the file, and it should survive a change to
      // the chunk sizes rather than having to be restated.
      expect(
        second.bytes * 8,
        `the first sync sent ${first.bytes} bytes and one edit cost ${second.bytes}`,
      ).toBeLessThan(first.bytes);

      expect(dec.decode(await c.read(second.uid))).toBe(edited);
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 120_000);
});

describe("two devices", () => {
  it("relays a write from one to the other, and elides the sender's own echo", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const a = new Client(await testKeys(SECRET), "a");
      const b = new Client(await testKeys(SECRET), "b");
      await a.connect(fresh);
      await b.connect(fresh);

      const put = await a.write("shared.md", "written on a");

      await until("b to receive the entry", () => b.entries.has(put.uid));
      await until("a to receive its own range", () => a.batches.some((x) => x.to === put.uid));

      // b gets the entry.
      const entry = b.entries.get(put.uid)!;
      expect(entry.size).toBe("written on a".length);
      expect(entry.chunks.length).toBeGreaterThan(0);
      expect(dec.decode(await b.read(put.uid))).toBe("written on a");

      // a gets the range and not the payload, so it never has to recognise
      // its own write.
      const echo = a.batches.find((x) => x.to === put.uid)!;
      expect(echo.from).toBe(put.uid);
      expect(echo.entries).toEqual([]);

      a.close();
      b.close();
    } finally {
      await fresh.cleanup();
    }
  }, 60_000);

  it("keeps both devices' cursors contiguous while both are writing", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const a = new Client(await testKeys(SECRET), "a");
      const b = new Client(await testKeys(SECRET), "b");
      await a.connect(fresh);
      await b.connect(fresh);

      for (let i = 0; i < 4; i++) {
        await a.write(`a${i}.md`, `from a ${i}`);
        await b.write(`b${i}.md`, `from b ${i}`);
      }

      // The transport asserts from === cursor + 1 on every batch, so
      // reaching the right cursor at all means nothing arrived out of
      // order and nothing was skipped.
      await until(
        "both to reach uid 8",
        () => a.transport.appliedCursor === 8 && b.transport.appliedCursor === 8,
      );
      expect(a.transport.appliedCursor).toBe(8);
      expect(b.transport.appliedCursor).toBe(8);

      a.close();
      b.close();
    } finally {
      await fresh.cleanup();
    }
  }, 120_000);

  it("catches a reconnecting device up from its own cursor", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const a = new Client(await testKeys(SECRET), "a");
      await a.connect(fresh);
      for (let i = 0; i < 5; i++) await a.write(`f${i}.md`, `content ${i}`);
      a.close();

      // A second device arriving late gets everything, in order.
      const late = new Client(await testKeys(SECRET), "late");
      clients.push(late);
      const ready = await late.connect(fresh, 0);
      expect(ready.cursor).toBe(5);
      await until("the backlog to drain", () => late.caughtUpAt === 5);
      expect(late.entries.size).toBe(5);

      // And one that already has part of it gets only the rest.
      const partial = new Client(await testKeys(SECRET), "partial");
      clients.push(partial);
      await partial.connect(fresh, 3);
      await until("the remainder to arrive", () => partial.caughtUpAt === 5);
      expect([...partial.entries.keys()].sort((x, y) => x - y)).toEqual([4, 5]);

      late.close();
      partial.close();
    } finally {
      await fresh.cleanup();
    }
  }, 120_000);
});

describe("refusals that the session survives", () => {
  it("reports a bad entry and stays usable", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);

      // A size with no chunks, which is indistinguishable from an empty
      // file and so is refused rather than stored as one.
      await expect(
        c.transport.put(
          await sealPath(c.keys, "bad.md"),
          { size: 4096, ctime: 1, mtime: 1 },
          [],
          async () => new Uint8Array(0),
          unsigned,
        ),
      ).rejects.toMatchObject({ code: "badentry" });

      expect(c.transport.isClosed).toBe(false);
      const good = await c.write("good.md", "this one is fine");
      expect(good.uid).toBe(1);
      c.close();
    } finally {
      await fresh.cleanup();
    }
  }, 60_000);

  it("reports an unknown uid and stays usable", async () => {
    const c = await newClient("a");
    await expect(c.transport.get(999_999)).rejects.toMatchObject({ code: "nouid" });
    expect(c.transport.isClosed).toBe(false);
    await c.transport.ping();
  });

  it("reports a chunk the server does not hold", async () => {
    const c = await newClient("a");
    const absent = "0".repeat(64);
    await expect(c.transport.fetch([absent])).rejects.toMatchObject({ code: "nochunk" });
    expect(c.transport.isClosed).toBe(false);
  });

  it("classifies which refusals end the session", () => {
    // The transport has to know, because a caller that carried on after a
    // busy would talk to a closed connection and one that tore down over a
    // badname would turn one bad file into a reconnect.
    for (const code of [
      "proto",
      "auth",
      "cursor",
      "busy",
      "protostate",
      "nospace",
      "internal",
      "rotated",
    ]) {
      expect(new ProtocolError(code, "x").endsSession, code).toBe(true);
    }
    for (const code of ["badentry", "badname", "toolarge", "nouid", "nocontent", "nochunk"]) {
      expect(new ProtocolError(code, "x").endsSession, code).toBe(false);
    }
  });

  /**
   * review finding I9. Every reply from the real server echoes the id of the
   * request it answers, on the handshake and on both halves of a put.
   */
  it("echoes the request id on ready, want and ack", async () => {
    const frames: Record<string, unknown>[] = [];
    const seen: Record<string, unknown>[] = [];
    const t = new Transport(server.wsUrl, {
      onBatch: () => {},
      timeoutMs: 10_000,
      socketFactory: (url) => {
        const ws = new WebSocket(url) as unknown as import("./transport.ts").SocketLike & {
          addEventListener(type: string, fn: (ev: { data: unknown }) => void): void;
        };
        const send = ws.send.bind(ws);
        ws.send = (data) => {
          if (typeof data === "string") frames.push(JSON.parse(data) as Record<string, unknown>);
          send(data);
        };
        ws.addEventListener("message", (ev) => {
          if (typeof ev.data === "string")
            seen.push(JSON.parse(ev.data) as Record<string, unknown>);
        });
        return ws;
      },
    });
    await t.connect();
    const keys = await vaultKeys();
    try {
      await t.hello({
        vault: "default",
        device: "ids",
        cursor: 0,
        ...(await server.deviceCredentials(SECRET, await testWrapped(SECRET), "ids")),
      });
      const hello = frames.find((f) => f["op"] === "hello")!;
      const ready = seen.find((f) => f["res"] === "ready")!;
      expect(hello["id"]).toBe(1);
      expect(ready["id"]).toBe(1);

      const body = (await sealChunks(keys, [enc.encode("ids\n")]))[0]!;
      const sealed = await sealPath(keys, "ids.md");
      const facts = {
        path: sealed,
        size: 4,
        ctime: 1,
        mtime: 1,
        folder: false,
        deleted: false,
        chunks: [body.name],
        parent: "",
      };
      const mac = await macEntry(keys, facts);
      await t.put(sealed, { size: 4, ctime: 1, mtime: 1 }, [body.name], async () => body.bytes, {
        mac,
        parent: "",
      });
      const put = frames.find((f) => f["op"] === "put")!;
      const want = seen.find((f) => f["res"] === "want")!;
      const ack = seen.find((f) => f["res"] === "ack")!;
      expect(typeof put["id"]).toBe("number");
      expect(want["id"]).toBe(put["id"]);
      expect(ack["id"]).toBe(put["id"]);
      // And the caps travel on ready.
      expect(ready["maxBatchBytes"]).toBe(16 * 1024 * 1024);
    } finally {
      t.close();
    }
  });

  /**
   * The other side of the version check: this client says `proto: 4`, and a
   * hello in any other version is refused rather than answered. A server that
   * answered an older one would hand a connection the vault's own credential
   * as a sync credential, which is exactly what per-device credentials took
   * away.
   */
  it("refuses a hello in any protocol but this one", async () => {
    const creds = server.credentials(
      authToken(await deriveRootKeys(SECRET)),
      await testWrapped(SECRET),
    );
    const ws = new WebSocket(server.wsUrl);
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") resolve(JSON.parse(ev.data) as Record<string, unknown>);
      });
      ws.addEventListener("error", () => reject(new Error("socket error")));
      ws.addEventListener("close", (ev) => reject(new Error(`closed ${ev.code}`)));
    });
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.send(
      JSON.stringify({
        op: "hello",
        proto: 3,
        crypto: "basalt/hkdf-aes-gcm/1",
        vault: "default",
        device: "old-phone",
        cursor: 0,
        token: creds.token,
        claim: creds.claim.auth,
        wrapped: creds.claim.wrapped,
      }),
    );
    const refusal = await answer;
    ws.close();
    expect(refusal["res"]).toBe("err");
    expect(refusal["code"]).toBe("proto");
    // Both numbers named, because that is how somebody works out which end to
    // upgrade. 3 stands in for any version outside the range.
    expect(String(refusal["msg"])).toMatch(/protocol 3 not supported/);
    expect(String(refusal["msg"])).toMatch(/4 to 4/);
  });
});

describe("what the server can and cannot see", () => {
  it("never receives a readable path or a readable byte", async () => {
    const fresh = new Server();
    await fresh.start();
    try {
      const c = new Client(await testKeys(SECRET), "a");
      await c.connect(fresh);
      await c.write("Personal/Diary 2026.md", "Today I wrote something private.");
      c.close();
      await fresh.stop();

      // Grep everything the server wrote. Neither the path nor the content
      // may appear anywhere on its disk.
      const { stdout } = await run("grep", ["-rl", "Diary", fresh.dataDir]).catch(() => ({
        stdout: "",
      }));
      expect(stdout.trim(), "the path appeared in the server's files").toBe("");
      const { stdout: content } = await run("grep", [
        "-rl",
        "something private",
        fresh.dataDir,
      ]).catch(() => ({
        stdout: "",
      }));
      expect(content.trim(), "the content appeared in the server's files").toBe("");
    } finally {
      await fresh.cleanup();
    }
  }, 60_000);
});
