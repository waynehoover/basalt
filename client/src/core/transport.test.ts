/**
 * The transport against a server that misbehaves.
 *
 * `server-harness.test.ts` proves the client and the real server agree. It cannot
 * prove the client is robust, because the real server never lies: every
 * defensive check in the transport is unreachable when the peer is correct, and a
 * mutation pass against the integration suite showed exactly that, with nine of
 * eighteen breakages surviving.
 *
 * So this file supplies the lying peer. A gap in the batch sequence, a caught-up
 * at a cursor nobody reached, an entry outside its own range, a reply nobody
 * asked for: none of these can be produced by the Go server, and all of them can
 * be produced by a proxy, a version mismatch, or a bug on either side. The two
 * files are the same subject from opposite directions and neither is redundant.
 */

import { describe, expect, it, vi } from "vitest";
import { chunkName } from "./crypto.ts";
import { FakeSocket, engineOnFakeSocket, ready, settle } from "./fake-socket.ts";
import { Backoff, ConnectionError, ProtocolError, Transport, type Batch } from "./transport.ts";

/** A connected transport and the socket behind it. */
async function connected(
  opts: {
    onBatch?: (b: Batch) => void | Promise<void>;
    onCaughtUp?: (c: number) => void;
    timeoutMs?: number;
  } = {},
) {
  const socket = new FakeSocket();
  const batches: Batch[] = [];
  const t = new Transport("ws://test", {
    onBatch: opts.onBatch ?? ((b) => void batches.push(b)),
    ...(opts.onCaughtUp ? { onCaughtUp: opts.onCaughtUp } : {}),
    socketFactory: () => socket,
    timeoutMs: opts.timeoutMs ?? 1000,
  });
  const connecting = t.connect();
  socket.open();
  await connecting;
  return { t, socket, batches };
}

/** Completes a handshake so the tests below start from a live session. */
async function helloed(cursor = 0, opts: Parameters<typeof connected>[0] = {}) {
  const rig = await connected(opts);
  const hello = rig.t.hello({ vault: "v", deviceId: "dev", token: "tok", device: "d", cursor });
  rig.socket.reply(ready());
  await hello;
  return rig;
}

/**
 * No authenticator, for the puts below that are about the transport rather
 * than about the entry. `put` takes it rather than defaulting it, so that a
 * caller that has one cannot forget to pass it; a test that deliberately has
 * none says so here.
 */
const unsigned = { mac: "", parent: "" };

/** A body and the name it travels under, which is a hash of exactly its bytes. */
async function named(body: Uint8Array): Promise<{ body: Uint8Array; name: string }> {
  return { body, name: await chunkName(body) };
}

describe("batches from a server that skips one", () => {
  it("refuses a batch that does not continue the cursor", async () => {
    const { t, socket, batches } = await helloed(0);
    // Jumping from 0 to a batch starting at 5 means uids 1 to 4 were never
    // sent, and nothing would ask about them again.
    socket.reply({ op: "batch", from: 5, to: 6, entries: [] });
    await settle();

    expect(t.isClosed).toBe(true);
    expect(batches).toHaveLength(0);
  });

  it("accepts a batch whose range spans a hole left by a purge", async () => {
    // From and to are a covered range, not the uids present, so a purged
    // sequence is not a gap. Getting this wrong would make a client read its
    // own tidied history as lost files.
    const { t, socket, batches } = await helloed(0);
    socket.reply({ op: "batch", from: 1, to: 9, entries: [{ uid: 9, path: "p", chunks: [] }] });
    await settle();

    expect(t.isClosed).toBe(false);
    expect(batches).toHaveLength(1);
    expect(t.appliedCursor).toBe(9);
  });

  it("refuses an entry outside the range it arrived in", async () => {
    const { t, socket } = await helloed(0);
    socket.reply({ op: "batch", from: 1, to: 3, entries: [{ uid: 77, path: "p", chunks: [] }] });
    await settle();
    expect(t.isClosed).toBe(true);
  });

  it("refuses a chunk name that is not one (C-D3)", async () => {
    // history, deleted and get all check the shape of every name they are
    // given, and this did not: a name that is not a name went on to be
    // fetched as one, and the refusal came much later from somewhere with
    // nothing to say about where it had come from.
    const { t, socket, batches } = await helloed(0);
    socket.reply({
      op: "batch",
      from: 1,
      to: 1,
      entries: [{ uid: 1, path: "p", chunks: ["../../etc/passwd"] }],
    });
    await settle();
    expect(t.isClosed).toBe(true);
    expect(batches).toHaveLength(0);
  });

  it("refuses an empty range", async () => {
    const { t, socket } = await helloed(5);
    socket.reply({ op: "batch", from: 6, to: 5, entries: [] });
    await settle();
    expect(t.isClosed).toBe(true);
  });

  it("advances the cursor only after the batch has been applied", async () => {
    // Advancing first would mean a failure to apply is a file silently
    // skipped: the cursor would already be past it and nothing asks twice.
    let seen = -1;
    const { t, socket } = await helloed(0, {
      onBatch: async (b) => {
        seen = t.appliedCursor;
        void b;
      },
    });
    socket.reply({ op: "batch", from: 1, to: 4, entries: [] });
    await settle();
    expect(seen, "the cursor had already moved when the batch was handed over").toBe(0);
    expect(t.appliedCursor).toBe(4);
  });

  it("stops at the first batch the caller cannot apply", async () => {
    const { t, socket } = await helloed(0, {
      onBatch: () => {
        throw new Error("could not write the file");
      },
    });
    socket.reply({ op: "batch", from: 1, to: 1, entries: [] });
    await settle();
    // The cursor did not move, so a reconnect asks for it again.
    expect(t.appliedCursor).toBe(0);
    expect(t.isClosed).toBe(true);
  });

  it("applies batches one at a time, in order", async () => {
    // Two batches arriving together must not overlap: the second's
    // continuity check depends on the first having finished.
    const order: number[] = [];
    const { t, socket } = await helloed(0, {
      onBatch: async (b) => {
        order.push(b.from);
        await new Promise((r) => setTimeout(r, 5));
        order.push(-b.from);
      },
    });
    socket.reply({ op: "batch", from: 1, to: 1, entries: [] });
    socket.reply({ op: "batch", from: 2, to: 2, entries: [] });
    await new Promise((r) => setTimeout(r, 60));

    expect(order).toEqual([1, -1, 2, -2]);
    expect(t.appliedCursor).toBe(2);
    expect(t.isClosed).toBe(false);
  });
});

describe("caught-up", () => {
  it("is refused when it names a cursor this device never reached", async () => {
    // The server says the backlog ends somewhere the client never got to,
    // which leaves a hole nothing asks about again.
    const { t, socket } = await helloed(0);
    socket.reply({ op: "caught-up", cursor: 40 });
    await settle();
    expect(t.isClosed).toBe(true);
  });

  it("is reported when it agrees", async () => {
    const seen: number[] = [];
    const { t, socket } = await helloed(0, { onCaughtUp: (c) => seen.push(c) });
    socket.reply({ op: "batch", from: 1, to: 3, entries: [] });
    socket.reply({ op: "caught-up", cursor: 3 });
    await settle();
    expect(seen).toEqual([3]);
    expect(t.isClosed).toBe(false);
  });
});

describe("the handshake", () => {
  it("refuses a server answering in another protocol version, naming both", async () => {
    const { t, socket } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
    socket.reply(ready({ proto: 2, serverVersion: "0.2.2" }));
    await expect(hello).rejects.toMatchObject({ code: "proto" });
    await expect(hello).rejects.toThrow(/protocol 2/);
    await expect(hello).rejects.toThrow(/speaks 4/);
    await expect(hello).rejects.toThrow(/upgrade the server first/);
  });

  /**
   * review finding I9. A server that does not speak this client's protocol
   * refuses the hello before it knows anything about who is asking, so the
   * refusal carries no id and no `retryable`, only a message naming the
   * server's own range. The client turns that into a sentence naming both
   * ends and the one thing to do about it, because the upgrade order is the
   * server first and a person reading "protocol 3 not supported" on their
   * phone has no way to know which end is behind.
   */
  it("names both versions when a server refuses the protocol, and says which end to upgrade", async () => {
    const { t, socket } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
    socket.raw({
      res: "err",
      code: "proto",
      msg: "protocol 3 not supported, this server speaks 2 to 2",
    });
    await expect(hello).rejects.toMatchObject({ code: "proto", retryable: false });
    await expect(hello).rejects.toThrow(/speaks 2 to 2/);
    await expect(hello).rejects.toThrow(/This client speaks protocol 4/);
    await expect(hello).rejects.toThrow(/upgrade the server first/);
    expect(t.isClosed).toBe(true);
  });

  it("sends protocol 4, a device id, an id, and the crypto suite this client implements", async () => {
    // A client that names a scheme it does not implement gets a session it
    // cannot decrypt anything in.
    const { t, socket } = await connected();
    void t
      .hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 })
      .catch(() => {});
    await settle();
    expect(socket.sentText[0]).toMatchObject({
      op: "hello",
      proto: 4,
      crypto: "basalt/hkdf-aes-gcm/1",
    });
    expect(socket.sentText[0]!["id"]).toBe(1);
  });

  it("reads every ceiling ready carries, and the wrapped key", async () => {
    const { t, socket } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
    socket.reply(
      ready({
        minProto: 3,
        serverVersion: "1.2.3",
        maxBatchBytes: 1234,
        maxFetchBytes: 5678,
        wrapped: "AAAA",
      }),
    );
    expect(await hello).toMatchObject({
      proto: 4,
      minProto: 3,
      serverVersion: "1.2.3",
      maxBatchBytes: 1234,
      maxFetchBytes: 5678,
      wrapped: "AAAA",
    });
    expect(t.serverLimits?.maxBatchBytes).toBe(1234);
  });

  /**
   * C40. Every vault has a data key, so a `ready` without one is not a second
   * kind of vault: it is a server telling this device to derive its content
   * keys some other way, and the only other way was from the root. A device
   * that accepted it would seal its notes under keys no other device on the
   * vault derives, and both ends would report success. Refused here, before
   * a path is sealed, and the session ends.
   */
  it("ends the session on a ready with no wrapped data key", async () => {
    for (const missing of [{ wrapped: undefined }, { wrapped: "" }]) {
      const { t, socket } = await connected();
      const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
      socket.reply(ready(missing));
      await expect(hello).rejects.toMatchObject({ code: "protostate" });
      await expect(hello).rejects.toThrow(/no wrapped data key/);
      expect(t.isClosed, "carried on without the vault's keys").toBe(true);
    }
  });

  /**
   * The pin. `ready.wrapped` used to be believed on the grounds that it
   * unwrapped under this root, and the client handed the server a freshly
   * wrapped candidate on every hello, claimed vault or not. A hostile server
   * could echo that candidate back as the vault's own: it unwraps perfectly,
   * the device installs a schedule no other device on the vault derives, and
   * the server has split the vault in two without learning a key. Nothing on
   * the wire tells that from the real blob, so what tells it is having seen the
   * real blob before.
   */
  it("reports the wrapped key ready carries, which a paired device does not use", async () => {
    // Carried and reported, and nothing here derives a key from it: a device
    // holds the data key itself, handed over when it was registered by the
    // session that could unwrap this. What the field is still good for is the
    // refusal above, which says the vault is one an older build wrote.
    const { t, socket } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
    socket.reply(ready({ wrapped: "FIRST-SIGHT" }));
    expect((await hello).wrapped).toBe("FIRST-SIGHT");
  });

  it("sends the claim and its wrapped data key together, or neither", async () => {
    const { t, socket } = await connected();
    void t
      .helloAsRegistrar({
        vault: "v",
        token: "t",
        device: "d",
        claim: { auth: "AUTH", wrapped: "WRAPPED" },
      })
      .catch(() => {});
    await settle();
    // One argument on the way in, two fields on the wire, and no way to
    // express a claim that would bind a vault with no data key.
    expect(socket.sentText[0]).toMatchObject({ claim: "AUTH", wrapped: "WRAPPED" });

    const bare = await connected();
    void bare.t.helloAsRegistrar({ vault: "v", token: "t", device: "d" }).catch(() => {});
    await settle();
    expect("claim" in bare.socket.sentText[0]!).toBe(false);
    expect("wrapped" in bare.socket.sentText[0]!).toBe(false);
  });

  /**
   * A device hello names a row and a registrar hello does not, and that one
   * field is what decides whether the session may sync. Two methods rather
   * than a flag, so a caller cannot ask for the wrong one by leaving an
   * argument out. docs/protocol.md, "Authentication".
   */
  it("names the device on a device hello and no device on a registrar hello", async () => {
    const { t, socket } = await connected();
    void t
      .hello({ vault: "v", deviceId: "dev-1", token: "t", device: "d", cursor: 0 })
      .catch(() => {});
    await settle();
    expect(socket.sentText[0]).toMatchObject({ op: "hello", proto: 4, deviceId: "dev-1" });

    const reg = await connected();
    void reg.t.helloAsRegistrar({ vault: "v", token: "t", device: "d" }).catch(() => {});
    await settle();
    expect("deviceId" in reg.socket.sentText[0]!).toBe(false);
  });

  it("refuses a registrar reply that is not a registrar", async () => {
    const { t, socket } = await connected();
    const hello = t.helloAsRegistrar({ vault: "v", token: "t", device: "d" });
    // A `ready` here would be a server handing the vault's own credential a
    // syncing session, which is exactly what protocol 4 took away.
    socket.reply(ready());
    await expect(hello).rejects.toMatchObject({ code: "protostate" });
  });

  /**
   * review finding I6. Both names land in the server's log and on every entry
   * this device writes; the server refuses over 64 bytes or a control
   * character with `badname` and ends the session. Refused here first, so a
   * bad name is one error at pairing rather than a connection that dies on
   * every attempt with nothing to say.
   */
  it("refuses a vault or device name the server would refuse, before sending it", async () => {
    for (const [what, name] of [
      ["device", "x".repeat(65)],
      ["device", "é".repeat(33)], // 66 bytes of 33 characters
      ["vault", "y".repeat(65)],
      ["device", "line\nbreak"],
      ["vault", "tab\there"],
      ["device", "del\x7f"],
    ] as const) {
      const { socket, t } = await connected();
      const args = {
        vault: "v",
        deviceId: "dev",
        token: "t",
        device: "d",
        cursor: 0,
        [what]: name,
      };
      await expect(t.hello(args), `${what} ${JSON.stringify(name)}`).rejects.toMatchObject({
        code: "badname",
      });
      expect(socket.sentText, "the bad name was sent").toHaveLength(0);
    }
    // And exactly sixty-four bytes is fine, as is any printable character.
    const { socket, t } = await connected();
    void t
      .hello({ vault: "v".repeat(64), deviceId: "dev", token: "t", device: "café ~", cursor: 0 })
      .catch(() => {});
    await settle();
    expect(socket.sentText).toHaveLength(1);
  });

  it("refuses anything other than ready", async () => {
    const { t, socket } = await connected();
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
    socket.reply({ res: "pong" });
    await expect(hello).rejects.toBeInstanceOf(ProtocolError);
  });
});

describe("put, against a server that answers oddly", () => {
  it("sends bodies in the order the server asked for", async () => {
    // The server matches each body by hashing it, so a wrong order is caught
    // there. Sending the right order is still this side's job: relying on the
    // other end to notice is how the two ends end up disagreeing about how
    // many frames are left.
    const { t, socket } = await helloed(0);
    const chunks = [
      { name: "a".repeat(64), bytes: new Uint8Array([1]) },
      { name: "b".repeat(64), bytes: new Uint8Array([2]) },
      { name: "c".repeat(64), bytes: new Uint8Array([3]) },
    ];
    const put = t.put(
      "p",
      { size: 3, ctime: 0, mtime: 0 },
      chunks.map((c) => c.name),
      async (n) => chunks.find((c) => c.name === n)!.bytes,
      unsigned,
    );
    await settle();
    // Asked for out of order, and only two of the three.
    socket.reply({ res: "want", chunks: ["c".repeat(64), "a".repeat(64)] });
    await settle();
    socket.reply({ res: "ack", uid: 5 });

    expect(await put).toMatchObject({ uid: 5, uploaded: 2 });
    expect(socket.sentBinary.map((b) => b[0])).toEqual([3, 1]);
  });

  it("refuses to invent a body the server asked for", async () => {
    const { t, socket } = await helloed(0);
    const put = t.put(
      "p",
      { size: 1, ctime: 0, mtime: 0 },
      ["a".repeat(64)],
      async () => new Uint8Array([1]),
      unsigned,
    );
    await settle();
    socket.reply({ res: "want", chunks: ["z".repeat(64)] });
    await expect(put).rejects.toMatchObject({ code: "badchunk" });
  });

  it("reports have as no upload at all", async () => {
    const { t, socket } = await helloed(0);
    const put = t.put(
      "p",
      { size: 1, ctime: 0, mtime: 0 },
      ["a".repeat(64)],
      async () => new Uint8Array([1]),
      unsigned,
    );
    await settle();
    socket.reply({ res: "have", uid: 9 });
    expect(await put).toEqual({ uid: 9, uploaded: 0, bytes: 0 });
    expect(socket.sentBinary).toHaveLength(0);
  });

  it("refuses a reply that is neither want nor have", async () => {
    const { t, socket } = await helloed(0);
    const put = t.put(
      "p",
      { size: 0, ctime: 0, mtime: 0 },
      [],
      async () => new Uint8Array(0),
      unsigned,
    );
    await settle();
    socket.reply({ res: "chunks", uid: 1, size: 0, chunks: [] });
    await expect(put).rejects.toBeInstanceOf(ProtocolError);
  });

  it("carries prev only when there is a rename", async () => {
    const { t, socket } = await helloed(0);
    void t
      .put("new", { size: 0, ctime: 0, mtime: 0 }, [], async () => new Uint8Array(0), unsigned)
      .catch(() => {});
    await settle();
    expect(socket.sentText.at(-1)?.["meta"]).not.toHaveProperty("prev");

    socket.reply({ res: "have", uid: 1 });
    await settle();
    void t
      .put(
        "new",
        { size: 0, ctime: 0, mtime: 0, prev: "old" },
        [],
        async () => new Uint8Array(0),
        unsigned,
      )
      .catch(() => {});
    await settle();
    expect(socket.sentText.at(-1)?.["meta"]).toMatchObject({ prev: "old" });
  });
});

/**
 * review finding C11. The ack follows the last body, and a loopback server answers
 * inside the same tick as the send. A waiter installed after the bodies went
 * out found the answer already there, and with no waiter in place a valid
 * acknowledgement read as a reply nobody asked for and closed the connection.
 */
describe("an acknowledgement that arrives as fast as a loopback server sends it", () => {
  const one = { name: "a".repeat(64), bytes: new Uint8Array([1]) };
  const two = { name: "b".repeat(64), bytes: new Uint8Array([2]) };

  /** A socket that answers from inside `send`, the moment the last body lands. */
  class InstantSocket extends FakeSocket {
    answer: Record<string, unknown> = {};
    after = 0;
    override send(data: string | ArrayBufferLike | Uint8Array): void {
      super.send(data);
      if (typeof data !== "string" && this.sentBinary.length === this.after) {
        this.reply(this.answer);
      }
    }
  }

  /** A socket whose buffer drains on a timer, with the answer arriving mid-drain. */
  class DrainingSocket extends FakeSocket {
    buffered = 0;
    answer: Record<string, unknown> = {};
    after = 0;
    stepMs = 5;
    stepBytes = 1;
    get bufferedAmount(): number {
      return this.buffered;
    }
    override send(data: string | ArrayBufferLike | Uint8Array): void {
      super.send(data);
      if (typeof data === "string") return;
      this.buffered += this.sentBinary.at(-1)!.length;
      const tick = () => {
        this.buffered = Math.max(0, this.buffered - this.stepBytes);
        if (this.buffered > 0) setTimeout(tick, this.stepMs);
      };
      setTimeout(tick, this.stepMs);
      // The server has the bodies and answers while this side's buffer is
      // still reported as draining.
      if (this.sentBinary.length === this.after) setTimeout(() => this.reply(this.answer), 1);
    }
  }

  async function rig(socket: FakeSocket, timeoutMs = 1000) {
    const t = new Transport("ws://test", {
      onBatch: () => {},
      socketFactory: () => socket,
      timeoutMs,
    });
    const connecting = t.connect();
    socket.open();
    await connecting;
    const hello = t.hello({ vault: "v", deviceId: "dev", token: "tok", device: "d", cursor: 0 });
    socket.reply(ready());
    await hello;
    return t;
  }

  it("commits a put whose ack arrives from inside the last send", async () => {
    const socket = new InstantSocket();
    socket.answer = { res: "ack", uid: 7 };
    socket.after = 2;
    const t = await rig(socket);
    const put = t.put(
      "p",
      { size: 2, ctime: 0, mtime: 0 },
      [one.name, two.name],
      async (n) => (n === one.name ? one.bytes : two.bytes),
      unsigned,
    );
    await settle();
    socket.reply({ res: "want", chunks: [one.name, two.name] });
    expect(await put).toMatchObject({ uid: 7, uploaded: 2 });
    expect(t.isClosed).toBe(false);
  });

  it("commits a batch whose acks arrive from inside the last send", async () => {
    const socket = new InstantSocket();
    socket.answer = { res: "acks", results: [{ uid: 3 }, { uid: 4 }] };
    socket.after = 2;
    const t = await rig(socket);
    const entry = (path: string, name: string) => ({
      path,
      meta: { size: 1, ctime: 0, mtime: 0 },
      names: [name],
      mac: "m",
      parent: "",
    });
    const putting = t.putMany([entry("p", one.name), entry("q", two.name)], async (n) =>
      n === one.name ? one.bytes : two.bytes,
    );
    await settle();
    socket.reply({ res: "want", chunks: [one.name, two.name] });
    const out = await putting;
    expect(out.results.map((r) => r.uid)).toEqual([3, 4]);
    expect(t.isClosed).toBe(false);
  });

  it("commits a put whose ack arrives while the socket buffer is still draining", async () => {
    const socket = new DrainingSocket();
    socket.answer = { res: "ack", uid: 8 };
    socket.after = 1;
    socket.stepBytes = 1;
    socket.stepMs = 5;
    const t = await rig(socket);
    const body = new Uint8Array(20);
    const put = t.put(
      "p",
      { size: 20, ctime: 0, mtime: 0 },
      [one.name],
      async () => body,
      unsigned,
    );
    await settle();
    socket.reply({ res: "want", chunks: [one.name] });
    expect(await put).toMatchObject({ uid: 8, uploaded: 1, bytes: 20 });
    expect(t.isClosed).toBe(false);
  });

  it("does not time out an upload that drains slowly but steadily", async () => {
    // The drain takes several timeouts; every step is progress, and the ack
    // clock starts only once the last byte has left. C4 and C11 together.
    const socket = new DrainingSocket();
    socket.answer = { res: "ack", uid: 9 };
    socket.after = 1;
    socket.stepBytes = 1;
    socket.stepMs = 10;
    const t = await rig(socket, 100);
    const body = new Uint8Array(40); // 400 ms of drain against a 100 ms timeout
    const put = t.put(
      "p",
      { size: 40, ctime: 0, mtime: 0 },
      [one.name],
      async () => body,
      unsigned,
    );
    await settle();
    socket.reply({ res: "want", chunks: [one.name] });
    expect(await put).toMatchObject({ uid: 9, uploaded: 1 });
    expect(t.isClosed).toBe(false);
  });

  it("still closes when the buffer stops moving for a whole timeout", async () => {
    const socket = new DrainingSocket();
    socket.answer = { res: "ack", uid: 9 };
    socket.after = 99; // never answers
    socket.stepBytes = 0; // never drains
    const t = await rig(socket, 100);
    const put = t.put(
      "p",
      { size: 4, ctime: 0, mtime: 0 },
      [one.name],
      async () => new Uint8Array(4),
      unsigned,
    );
    await settle();
    socket.reply({ res: "want", chunks: [one.name] });
    await expect(put).rejects.toThrow(/stalled/);
    expect(t.isClosed).toBe(true);
  });
});

describe("errors", () => {
  it("raises a refusal rather than returning it as a reply", async () => {
    const { t, socket } = await helloed(0);
    const get = t.get(1);
    await settle();
    socket.reply({ res: "err", code: "nouid", msg: "no entry 1" });
    await expect(get).rejects.toMatchObject({ code: "nouid", message: "no entry 1" });
    // Not fatal, so the session lives.
    expect(t.isClosed).toBe(false);
  });

  it("closes the session on a fatal refusal and leaves it closed", async () => {
    const { t, socket } = await helloed(0);
    const get = t.get(1);
    await settle();
    socket.reply({ res: "err", code: "protostate", msg: "we disagree" });
    await expect(get).rejects.toMatchObject({ code: "protostate" });
    expect(t.isClosed).toBe(true);
    expect(socket.closed).toBe(true);
  });

  it("knows which codes end a session", () => {
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
   * review finding I2. Whether a loop retries is the server's `retryable`, read
   * off the frame, and the code table stands in only for an error that
   * arrived before the protocol was settled and so has no field.
   */
  it("takes retryable from the frame when it is there, and from the code only when it is not", () => {
    expect(new ProtocolError("busy", "x", { retryable: false }).fatal).toBe(true);
    expect(new ProtocolError("badname", "x", { retryable: true }).fatal).toBe(false);
    for (const code of ["busy", "nospace", "internal"]) {
      expect(new ProtocolError(code, "x").fatal, `${code} with no field`).toBe(false);
    }
    for (const code of ["proto", "auth", "cursor", "protostate", "badchunk", "toolarge"]) {
      expect(new ProtocolError(code, "x").fatal, `${code} with no field`).toBe(true);
    }
  });

  it("carries the server's retry hint on a refusal in reply", async () => {
    const { t, socket } = await helloed(0);
    const get = t.get(1);
    await settle();
    socket.reply({
      res: "err",
      code: "busy",
      msg: "8 devices connected",
      retryable: true,
      retryAfterMs: 30_000,
    });
    await expect(get).rejects.toMatchObject({
      code: "busy",
      retryable: true,
      retryAfterMs: 30_000,
      fatal: false,
    });
    expect(t.isClosed, "busy ends the session").toBe(true);
  });

  it("refuses a frame that is not JSON", async () => {
    const { t, socket } = await helloed(0);
    socket.onmessage?.({ data: "this is not json" });
    await settle();
    expect(t.isClosed).toBe(true);
  });

  it("refuses a reply nobody asked for", async () => {
    const { t, socket } = await helloed(0);
    socket.reply({ res: "pong" });
    await settle();
    expect(t.isClosed).toBe(true);
  });

  /**
   * review finding C26. On shutdown the server sends every idle session
   * `{res:"err", code:"busy"}` and then closes it. Read as a stray reply this
   * was a protocol violation, so every plugin attached to a restarting server
   * went to "stopped" instead of waiting for it to come back.
   */
  describe("an error frame nobody asked for (C26)", () => {
    async function idle() {
      const socket = new FakeSocket();
      let cause: Error | undefined;
      const t = new Transport("ws://test", {
        onBatch: () => {},
        onClosed: (c) => {
          cause = c;
        },
        socketFactory: () => socket,
        timeoutMs: 1000,
      });
      const connecting = t.connect();
      socket.open();
      await connecting;
      const hello = t.hello({ vault: "v", deviceId: "dev", token: "tok", device: "d", cursor: 0 });
      socket.reply(ready({ cursor: 0 }));
      await hello;
      return { t, socket, cause: () => cause };
    }

    it("takes busy as the connection ending, which a loop retries after the hint", async () => {
      const { t, socket, cause } = await idle();
      socket.raw({
        res: "err",
        code: "busy",
        msg: "this server is shutting down",
        retryable: true,
        retryAfterMs: 5000,
      });
      await settle();
      expect(t.isClosed).toBe(true);
      expect(cause()).toBeInstanceOf(ProtocolError);
      expect((cause() as ProtocolError).fatal, "a shutdown notice must not stop the loop").toBe(
        false,
      );
      expect((cause() as ProtocolError).retryAfterMs).toBe(5000);
      expect(cause()!.message).toMatch(/shutting down/);
    });

    it("takes a refusal that would repeat as fatal, as it would be in reply", async () => {
      for (const code of ["proto", "auth", "cursor", "protostate"]) {
        const { t, socket, cause } = await idle();
        socket.raw({ res: "err", code, msg: "no", retryable: false });
        await settle();
        expect(t.isClosed, code).toBe(true);
        expect(cause(), code).toBeInstanceOf(ProtocolError);
        expect((cause() as ProtocolError).code).toBe(code);
        expect((cause() as ProtocolError).fatal, code).toBe(true);
      }
    });

    it("reads a shutdown notice with no retryable field by its code, which is how one arrives before ready", async () => {
      const { t, socket, cause } = await idle();
      socket.raw({ res: "err", code: "busy", msg: "shutting down" });
      await settle();
      expect(t.isClosed).toBe(true);
      expect((cause() as ProtocolError).fatal).toBe(false);
    });
  });

  it("fails everything waiting when the connection goes away", async () => {
    const { t, socket } = await helloed(0);
    const get = t.get(1);
    await settle();
    socket.hangUp();
    await expect(get).rejects.toBeInstanceOf(ConnectionError);
    expect(t.isClosed).toBe(true);
  });

  it("reports itself closed after being closed", async () => {
    const { t } = await helloed(0);
    expect(t.isClosed).toBe(false);
    t.close();
    expect(t.isClosed).toBe(true);
    await expect(t.get(1)).rejects.toBeInstanceOf(ConnectionError);
  });

  /**
   * review finding I1. Two requests in flight used to be refused, because a
   * reply was matched to the one request in flight by position. Every reply
   * now echoes the id it answers, so the answers can arrive in any order and
   * each caller gets its own.
   */
  it("matches two replies in flight to their requests by id, whatever order they come in", async () => {
    const { t, socket } = await helloed(0);
    const first = t.get(1);
    const second = t.get(2);
    await settle();
    const [askOne, askTwo] = socket.sentText.slice(-2) as Record<string, unknown>[];
    expect(askOne!["id"]).not.toBe(askTwo!["id"]);
    socket.reply({ res: "chunks", id: askTwo!["id"], uid: 2, size: 0, chunks: [] });
    socket.reply({ res: "chunks", id: askOne!["id"], uid: 1, size: 0, chunks: [] });
    expect((await first).uid).toBe(1);
    expect((await second).uid).toBe(2);
    expect(t.isClosed).toBe(false);
  });

  it("gives every request a fresh id", async () => {
    const { t, socket } = await helloed(0);
    for (let i = 0; i < 5; i++) {
      const get = t.get(i + 1);
      await settle();
      socket.reply({ res: "chunks", uid: i + 1, size: 0, chunks: [] });
      await get;
    }
    const ids = socket.sentText.map((m) => m["id"]).filter((id) => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6); // the hello and five gets
  });

  it("ends the session on a reply to a request it does not have in flight", async () => {
    // The server never sends an id it was not given, so an unknown one means
    // the two ends disagree about state, and the protocol says to stop.
    const { t, socket } = await helloed(0);
    const get = t.get(1);
    await settle();
    socket.reply({ res: "chunks", id: 999, uid: 1, size: 0, chunks: [] });
    await expect(get).rejects.toMatchObject({ code: "protostate" });
    expect(t.isClosed).toBe(true);
  });

  it("carries a put's id on its want and its ack", async () => {
    const { t, socket } = await helloed(0);
    const name = "a".repeat(64);
    const put = t.put(
      "p",
      { size: 1, ctime: 0, mtime: 0 },
      [name],
      async () => new Uint8Array([1]),
      unsigned,
    );
    await settle();
    const id = socket.sentText.at(-1)!["id"];
    socket.reply({ res: "want", id, chunks: [name] });
    await settle();
    socket.reply({ res: "ack", id, uid: 4 });
    expect(await put).toMatchObject({ uid: 4 });
  });

  it("sends pings with no id, and takes the pong without one", async () => {
    const { t, socket } = await helloed(0);
    const ping = t.ping();
    await settle();
    expect("id" in socket.sentText.at(-1)!).toBe(false);
    socket.raw({ res: "pong" });
    await expect(ping).resolves.toBeUndefined();
  });

  it("closes the connection when a request goes unanswered", async () => {
    // The request may have been received and acted on, so the session's state
    // is unknown, and continuing on an unknown state is how two ends desync.
    vi.useFakeTimers();
    try {
      const { t, socket } = await connected({ timeoutMs: 50 });
      const hello = t.hello({ vault: "v", deviceId: "dev", token: "t", device: "d", cursor: 0 });
      const rejected = expect(hello).rejects.toBeInstanceOf(ConnectionError);
      await vi.advanceTimersByTimeAsync(60);
      await rejected;
      expect(socket.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * review finding C31. `connect` waited for the socket to open with no deadline, so
 * a server that accepted the TCP connection and never completed the handshake,
 * or a firewall that swallowed it, left the client hanging for as long as the
 * platform cared to wait, and the CLI held the vault's lock for the whole of it.
 */
describe("a connection that never opens (C31)", () => {
  it("gives up within the timeout and closes the socket", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const t = new Transport("ws://test", {
        onBatch: () => {},
        socketFactory: () => socket,
        timeoutMs: 50,
      });
      const connecting = t.connect();
      const rejected = expect(connecting).rejects.toThrow(
        /no connection to ws:\/\/test within 50ms/,
      );
      await vi.advanceTimersByTimeAsync(60);
      await rejected;
      expect(socket.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bodies", () => {
  it("keeps bodies that arrive before anything asks for them", async () => {
    // The server streams a fetch as binary frames with no reply in front, so
    // they can land before the loop that reads them. Dropping one loses a
    // chunk and the file it belongs to.
    const { t, socket } = await helloed(0);
    const one = await named(new Uint8Array([7]));
    const two = await named(new Uint8Array([8]));
    const fetching = t.fetch([one.name, two.name]);
    await settle();
    socket.bodies(one.body, two.body);
    const bodies = await fetching;
    expect(bodies.map((b) => b[0])).toEqual([7, 8]);
  });

  it("returns as many bodies as it asked for", async () => {
    const { t, socket } = await helloed(0);
    const parts = await Promise.all([1, 2, 3].map((n) => named(new Uint8Array([n]))));
    const fetching = t.fetch(parts.map((p) => p.name));
    await settle();
    socket.bodies(...parts.map((p) => p.body));
    expect(await fetching).toHaveLength(3);
  });

  it("expects the bodies header to announce exactly the number asked for", async () => {
    const { t, socket } = await helloed(0);
    const fetching = t.fetch(["a".repeat(64), "b".repeat(64)]);
    await settle();
    socket.reply({ res: "bodies", count: 1 });
    await expect(fetching).rejects.toMatchObject({ code: "protostate" });
    expect(t.isClosed).toBe(true);
  });

  it("refuses a body that arrives with no header in front of it", async () => {
    const { t, socket } = await helloed(0);
    const one = await named(new Uint8Array([7]));
    const fetching = t.fetch([one.name]);
    await settle();
    socket.body(one.body);
    await expect(fetching).rejects.toBeInstanceOf(Error);
    expect(t.isClosed).toBe(true);
  });

  /**
   * Bodies arrive as bare binary frames with nothing tying them to a request,
   * so the only thing connecting one to a name is the order it came in. A body
   * left over from an abandoned fetch would be taken by the next one, decrypt
   * perfectly, being a real chunk of a real file, and be assembled into the
   * wrong note. The name is a hash of exactly those bytes, so this is exact.
   */
  it("refuses a body that is not the one it asked for", async () => {
    const { t, socket } = await helloed(0);
    const wanted = await named(new Uint8Array([1, 2, 3]));
    const other = await named(new Uint8Array([9, 9, 9]));
    const fetching = t.fetch([wanted.name]);
    await settle();
    socket.bodies(other.body);
    await expect(fetching).rejects.toMatchObject({ code: "badchunk" });
    // The stream no longer says what it is answering, so there is nothing to
    // carry on to.
    expect(t.isClosed).toBe(true);
  });

  it("refuses a body nobody asked for", async () => {
    // Unbounded queueing would make this a way to exhaust the device's
    // memory, and a body outside a fetch means the two ends no longer agree
    // about what is being answered.
    const { t, socket } = await helloed(0);
    socket.body(new Uint8Array([1, 2, 3]));
    await settle();
    expect(t.isClosed).toBe(true);
  });

  /**
   * review finding C34. A fetch was once answered in bare bodies, so
   * a body left over from a refused one was consumed as the answer to the
   * next. The `bodies` header removes the class: a fetch is answered by the
   * header and exactly that many frames, or by an error and none, so there
   * is never a leftover, and a body with no header is a protocol fault.
   */
  it("does not let one fetch inherit the bodies of another", async () => {
    const { t, socket } = await helloed(0);
    const wanted = await named(new Uint8Array([4, 5, 6]));
    const stale = await named(new Uint8Array([7, 8, 9]));

    // A fetch is refused. No bodies follow a refusal.
    const abandoned = t.fetch([stale.name, wanted.name]);
    await settle();
    socket.reply({ res: "err", code: "nochunk", msg: "gone", retryable: false });
    await expect(abandoned).rejects.toMatchObject({ code: "nochunk" });
    expect(t.isClosed).toBe(false);

    // The next fetch is answered on its own terms.
    const next = t.fetch([wanted.name]);
    await settle();
    socket.bodies(wanted.body);
    expect((await next)[0]).toEqual(wanted.body);

    // And a body arriving outside any fetch, which a misbehaving server
    // could still send, ends the session rather than being kept for the
    // next question.
    socket.body(stale.body);
    await settle();
    expect(t.isClosed).toBe(true);
  });

  it("raises a refusal that arrives instead of the bodies", async () => {
    const { t, socket } = await helloed(0);
    const fetching = t.fetch(["a".repeat(64)]);
    await settle();
    socket.reply({ res: "err", code: "nochunk", msg: "not held", retryable: false });
    await expect(fetching).rejects.toMatchObject({ code: "nochunk" });
  });

  it("asks for nothing when given nothing", async () => {
    const { t, socket } = await helloed(0);
    expect(await t.fetch([])).toEqual([]);
    expect(socket.sentText).toHaveLength(1); // the hello, and nothing more
  });
});

/**
 * review finding C24. Success replies were read leniently: a missing or non-numeric
 * uid became zero and was committed to the index as a version, and a `want`
 * with a malformed member dropped it and carried on. Every field a reply is
 * acted on has one shape, and anything else ends the session.
 */
describe("a success reply that is not the shape it should be", () => {
  const name = "a".repeat(64);
  const bad = [undefined, 0, -1, "5", 1.5, null, Number.MAX_SAFE_INTEGER + 1];

  it("refuses a have whose uid is not a version number", async () => {
    for (const uid of bad) {
      const { t, socket } = await helloed(0);
      const put = t.put(
        "p",
        { size: 1, ctime: 0, mtime: 0 },
        [name],
        async () => new Uint8Array(1),
        unsigned,
      );
      await settle();
      socket.reply({ res: "have", ...(uid === undefined ? {} : { uid }) });
      await expect(put, `uid ${String(uid)}`).rejects.toMatchObject({ code: "protostate" });
      expect(t.isClosed, `uid ${String(uid)}`).toBe(true);
    }
  });

  it("refuses an ack whose uid is not a version number", async () => {
    for (const uid of bad) {
      const { t, socket } = await helloed(0);
      const put = t.put(
        "p",
        { size: 1, ctime: 0, mtime: 0 },
        [name],
        async () => new Uint8Array(1),
        unsigned,
      );
      await settle();
      socket.reply({ res: "want", chunks: [name] });
      await settle();
      socket.reply({ res: "ack", ...(uid === undefined ? {} : { uid }) });
      await expect(put, `uid ${String(uid)}`).rejects.toMatchObject({ code: "protostate" });
      expect(t.isClosed).toBe(true);
    }
  });

  it("refuses a want that names a chunk twice, or names something that is not a chunk", async () => {
    for (const chunks of [[name, name], [name, 7], [name, "not-hex"], "nope", undefined]) {
      const { t, socket } = await helloed(0);
      const put = t.put(
        "p",
        { size: 1, ctime: 0, mtime: 0 },
        [name],
        async () => new Uint8Array(1),
        unsigned,
      );
      await settle();
      socket.reply({ res: "want", ...(chunks === undefined ? {} : { chunks }) });
      await expect(put, JSON.stringify(chunks)).rejects.toBeInstanceOf(ProtocolError);
      expect(t.isClosed).toBe(true);
      expect(socket.sentBinary, "sent bodies for a want it refused").toHaveLength(0);
    }
  });

  it("refuses acks whose results carry no version number", async () => {
    const entry = {
      path: "p",
      meta: { size: 0, ctime: 0, mtime: 0 },
      names: [],
      mac: "m",
      parent: "",
    };
    for (const results of [[{ uid: 0 }], [{}], [{ uid: "3" }], [null], [{ code: 7 }]]) {
      const { t, socket } = await helloed(0);
      const putting = t.putMany([entry], async () => new Uint8Array(0));
      await settle();
      socket.reply({ res: "acks", results });
      await expect(putting, JSON.stringify(results)).rejects.toMatchObject({ code: "protostate" });
      expect(t.isClosed).toBe(true);
    }
  });

  it("refuses a chunks answer with a bad uid, size or chunk list", async () => {
    for (const reply of [
      { res: "chunks", uid: 0, size: 1, chunks: [name] },
      { res: "chunks", uid: 3, size: -1, chunks: [name] },
      { res: "chunks", uid: 3, size: 1.5, chunks: [name] },
      { res: "chunks", uid: 3, size: 1, chunks: [name, 4] },
      { res: "chunks", uid: 3, size: 1 },
    ]) {
      const { t, socket } = await helloed(0);
      const get = t.get(3);
      await settle();
      socket.reply(reply);
      await expect(get, JSON.stringify(reply)).rejects.toMatchObject({ code: "protostate" });
      expect(t.isClosed).toBe(true);
    }
  });

  it("refuses a ready whose limits are not counts", async () => {
    for (const field of [
      "cursor",
      "perFileMax",
      "chunkMax",
      "maxChunks",
      "maxBatchBytes",
      "maxFetchBytes",
      "minProto",
    ]) {
      const { t, socket } = await connected();
      const hello = t.hello({ vault: "v", deviceId: "dev", token: "tok", device: "d", cursor: 0 });
      socket.reply(ready({ [field]: "lots" }));
      await expect(hello, field).rejects.toMatchObject({ code: "protostate" });
      expect(t.isClosed).toBe(true);
    }
  });

  it("refuses a history or deleted list holding a version nobody could act on", async () => {
    for (const entry of [
      { path: "p", chunks: [] },
      { uid: 0, path: "p", chunks: [] },
      { uid: 2, chunks: [] },
      { uid: 2, path: "p" },
    ]) {
      const { t, socket } = await helloed(0);
      const asking = t.history("sealed");
      await settle();
      socket.reply({ res: "history", entries: [entry] });
      await expect(asking, JSON.stringify(entry)).rejects.toMatchObject({ code: "protostate" });
    }
  });

  it("still takes every well-formed answer", async () => {
    const { t, socket } = await helloed(0);
    const get = t.get(3);
    await settle();
    socket.reply({ res: "chunks", uid: 3, size: 0, chunks: [] });
    expect(await get).toEqual({ uid: 3, size: 0, chunks: [] });
  });
});

describe("reconnect pacing", () => {
  it("does not wait at all before the first attempt", () => {
    expect(new Backoff(0, 300_000, 5_000, false).delay()).toBe(0);
  });

  it("doubles, and stops at the ceiling", () => {
    const b = new Backoff(0, 300_000, 5_000, false);
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      b.fail();
      seen.push(b.delay());
    }
    expect(seen.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(Math.max(...seen)).toBe(300_000);
    expect(seen.at(-1)).toBe(300_000);
  });

  it("jitters between half and all of the delay", () => {
    // Not decoration: a server restarting with several devices attached would
    // otherwise have all of them return at the same instant, fail together,
    // and come back together.
    const lowest = new Backoff(0, 300_000, 5_000, true, () => 0);
    const highest = new Backoff(0, 300_000, 5_000, true, () => 1);
    lowest.fail();
    highest.fail();
    expect(lowest.delay()).toBe(2_500);
    expect(highest.delay()).toBe(5_000);
  });

  it("forgets its failures on success", () => {
    const b = new Backoff(0, 300_000, 5_000, false);
    b.fail();
    b.fail();
    expect(b.delay()).toBe(10_000);
    b.success();
    expect(b.delay()).toBe(0);
  });

  it("waits at least the floor, however the last attempt went", () => {
    const b = new Backoff(1_000, 300_000, 5_000, false);
    expect(b.delay()).toBe(1_000);
    b.success();
    expect(b.delay()).toBe(1_000);
    b.fail();
    expect(b.delay()).toBe(6_000);
  });
});

/**
 * Recovery is the one place where "there is nothing" and "I could not tell" are
 * most easily confused, and where confusing them costs most: somebody is
 * looking for a note they have lost.
 */
describe("recovery answers from a server that answers badly", () => {
  it("asks with the sealed path and reads back what it is given", async () => {
    const { t, socket } = await helloed();
    const asked = t.history("SEALED-PATH", { before: 40, limit: 5 });
    await settle();
    expect(socket.sentText.at(-1)).toMatchObject({
      op: "history",
      path: "SEALED-PATH",
      before: 40,
      limit: 5,
    });

    socket.reply({
      res: "history",
      path: "SEALED-PATH",
      entries: [
        { uid: 3, path: "SEALED-PATH", chunks: [] },
        { uid: 2, path: "SEALED-PATH", chunks: [] },
      ],
    });
    expect((await asked).map((e) => e.uid)).toEqual([3, 2]);
  });

  it("omits paging fields it was not given, rather than sending zeroes", async () => {
    // Zero means "start at the newest" to the server, which is the same
    // thing, but sending a limit of zero would ask for the default and look
    // deliberate. Absent is the honest way to say nothing was specified.
    const { t, socket } = await helloed();
    void t.history("SEALED");
    await settle();
    const sent = socket.sentText.at(-1)!;
    expect("before" in sent).toBe(false);
    expect("limit" in sent).toBe(false);
  });

  /**
   * The one that matters. A reply with no entries field, or a null one, must
   * not become "nothing was deleted": that is the answer somebody acts on by
   * concluding their note is unrecoverable.
   */
  it("carries the server saying the list was cut short", async () => {
    // Dropping this hands somebody a short list that looks complete, and
    // the note they are looking for is exactly the one that might be
    // missing from it.
    const { t, socket } = await helloed();
    const asked = t.deleted(2);
    await settle();
    expect(socket.sentText.at(-1)).toMatchObject({ op: "deleted", limit: 2 });
    socket.reply({
      res: "deleted",
      entries: [
        { uid: 9, path: "p", chunks: [] },
        { uid: 8, path: "q", chunks: [] },
      ],
      more: true,
    });
    expect((await asked).more).toBe(true);
  });

  it("refuses an answer with no list in it rather than reading it as empty", async () => {
    for (const bad of [
      { res: "deleted" },
      { res: "deleted", entries: null },
      { res: "deleted", entries: "none" },
      { res: "deleted", entries: 0 },
    ]) {
      const { t, socket } = await helloed();
      const asked = t.deleted();
      await settle();
      socket.reply(bad);
      await expect(asked, JSON.stringify(bad)).rejects.toThrow(/without a list of entries/);
    }
  });

  it("refuses a history answer with no list in it", async () => {
    const { t, socket } = await helloed();
    const asked = t.history("SEALED");
    await settle();
    socket.reply({ res: "history", path: "SEALED", entries: null });
    await expect(asked).rejects.toThrow(/without a list of entries/);
  });

  it("refuses an answer to a question it did not ask", async () => {
    const { t, socket } = await helloed();
    const asked = t.deleted();
    await settle();
    socket.reply({ res: "chunks", uid: 1, size: 0, chunks: [] });
    await expect(asked).rejects.toThrow(/expected deleted/);
  });

  it("passes on a refusal rather than reporting an empty vault", async () => {
    const { t, socket } = await helloed();
    const asked = t.history("SEALED");
    await settle();
    socket.reply({ res: "err", code: "internal", msg: "could not read history" });
    await expect(asked).rejects.toThrow(/could not read history/);
  });

  it("accepts an empty list, which is the ordinary answer", async () => {
    const { t, socket } = await helloed();
    const asked = t.deleted();
    await settle();
    socket.reply({ res: "deleted", entries: [] });
    expect(await asked).toEqual({ entries: [], more: false });
  });
});

/**
 * A device is told at hello what the server will store. Nothing used to hold
 * the server to it on the way back: a chunk list is a number the server
 * chooses, and a device that fetches and buffers however many are named runs
 * out of memory on a corrupt row as readily as on a hostile one.
 */
describe("a download against what the server said it would store", () => {
  it("refuses a version naming more chunks than the server stores", async () => {
    const { engine, socket } = await engineOnFakeSocket({ maxChunks: 4 });
    const asked = engine.contentOf(1);
    await settle();
    socket.reply({
      res: "chunks",
      uid: 1,
      size: 10,
      chunks: Array.from({ length: 5 }, (_, i) => `${i}`.repeat(64)),
    });
    await expect(asked).rejects.toThrow(/stores at most 4/);
  });

  it("accepts one within the limit", async () => {
    const { engine, socket } = await engineOnFakeSocket({ maxChunks: 4 });
    const body = new Uint8Array([1, 2, 3]);
    const name = await chunkName(body);
    const asked = engine.contentOf(1);
    await settle();
    socket.reply({ res: "chunks", uid: 1, size: 3, chunks: [name] });
    await settle();
    socket.bodies(body);
    // It gets as far as decrypting, which is where a body that is not a
    // sealed chunk fails. That is past the bound, which is the point.
    await expect(asked).rejects.not.toThrow(/stores at most/);
  });
});

/**
 * A server may advertise a smaller chunk ceiling than this client's own idea of
 * one, and the client has to cut to it. `sizesFor` took the parameter and the
 * engine never passed it, so a smaller ceiling was ignored and every chunk at
 * the boundary was refused, permanently, for any file that did not compress.
 */
describe("cutting to the ceiling the server advertised", () => {
  it("sends no body larger than the server said it would take", async () => {
    const ceiling = 64 * 1024;
    const { engine, socket, vault } = await engineOnFakeSocket({ chunkMax: ceiling });

    const bytes = new Uint8Array(1024 * 1024);
    for (let at = 0; at < bytes.length; at += 65536) {
      crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, bytes.length)));
    }
    await vault.write("clip.raw", bytes, { mtime: 1000, ctime: 1000 });

    const syncing = engine.sync();
    // Sealing a megabyte takes real time, so this waits for the put rather
    // than for one turn of the event loop.
    for (let i = 0; i < 200 && !socket.sentText.some((m) => m["op"] === "putmany"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // The put names its chunks; the server asks for all of them.
    const put = socket.sentText.find((m) => m["op"] === "putmany");
    expect(
      put,
      `nothing was put: ${JSON.stringify(socket.sentText.map((m) => m["op"]))}`,
    ).toBeDefined();
    const entries = put!["entries"] as { chunks: string[] }[];
    const names = entries.flatMap((e) => e.chunks);
    expect(names.length, "a 1 MiB file was not cut to a 64 KiB ceiling").toBeGreaterThan(8);

    socket.reply({ res: "want", chunks: names });
    await settle();
    socket.reply({ res: "acks", results: entries.map((_, i) => ({ uid: i + 1 })) });
    await syncing.catch(() => undefined);

    const worst = Math.max(...socket.sentBinary.map((b) => b.length));
    expect(
      worst,
      `the largest body sent was ${worst} against a ceiling of ${ceiling}`,
    ).toBeLessThanOrEqual(ceiling);
  });
});

/**
 * A fetch is answered in binary frames, not with a reply, so the timeout armed
 * for that reply is waiting for something that will never come. Left running it
 * fires later, in the middle of a sync, and closes the connection.
 *
 * On loopback a sync finishes long before any timeout, which is why this went
 * unnoticed. Adding four hundred milliseconds of latency to the benchmark made
 * every large sync die exactly one timeout after its first fetch, with most of
 * the vault missing and the client reporting that it had finished.
 */
describe("the timeout a fetch leaves behind", () => {
  it("does not close the connection some time after a fetch succeeded", async () => {
    const { t, socket } = await helloed(0, { timeoutMs: 120 });
    const body = new Uint8Array([1, 2, 3]);
    const name = await chunkName(body);

    const fetching = t.fetch([name]);
    await settle();
    socket.bodies(body);
    expect(await fetching).toHaveLength(1);

    // Well past the timeout that was armed for the reply.
    await new Promise((r) => setTimeout(r, 300));
    expect(t.isClosed, "the connection died after a fetch that had already succeeded").toBe(false);

    // And it is still usable, which is the property that matters.
    const pinging = t.ping();
    await settle();
    socket.reply({ res: "pong" });
    await expect(pinging).resolves.toBeUndefined();
  });

  it("does not leave one behind when a fetch fails either", async () => {
    const { t, socket } = await helloed(0, { timeoutMs: 120 });
    const fetching = t.fetch(["a".repeat(64)]);
    await settle();
    socket.reply({ res: "err", code: "nochunk", msg: "not held", retryable: false });
    await expect(fetching).rejects.toMatchObject({ code: "nochunk" });

    await new Promise((r) => setTimeout(r, 300));
    // A refusal is not a reason to close, and the timer must not make it one.
    const pinging = t.ping();
    await settle();
    socket.reply({ res: "pong" });
    await expect(pinging).resolves.toBeUndefined();
  });
});

/**
 * A batch that lost its entries must not look like a batch that had none.
 *
 * The decoder read an absent or null `entries` as `[]`. A frame mangled by a
 * proxy, or written by a future server with a bug, therefore passed the
 * continuity check, applied nothing, and advanced the cursor over real
 * versions. On reconnect the client resumed after them and never fetched them
 * again: notes missing for ever, with the client reporting success throughout.
 *
 * Empty stays legal. That is how a device receives its own committed write,
 * with the cursor advance and no payload, and refusing it would break every
 * push this device makes.
 */
describe("a batch frame that cannot be trusted", () => {
  const badFrames: { why: string; frame: Record<string, unknown> }[] = [
    { why: "no entries field at all", frame: { op: "batch", from: 1, to: 3 } },
    { why: "a null entries field", frame: { op: "batch", from: 1, to: 3, entries: null } },
    { why: "entries that is not an array", frame: { op: "batch", from: 1, to: 3, entries: {} } },
    {
      why: "an entry with no uid, which slips past a range check",
      frame: { op: "batch", from: 1, to: 3, entries: [{ path: "p", chunks: [] }] },
    },
    {
      why: "an entry with no path",
      frame: { op: "batch", from: 1, to: 3, entries: [{ uid: 2, chunks: [] }] },
    },
    {
      why: "an entry with no chunks array",
      frame: { op: "batch", from: 1, to: 3, entries: [{ uid: 2, path: "p" }] },
    },
  ];

  for (const { why, frame } of badFrames) {
    it(`refuses ${why} rather than advancing the cursor`, async () => {
      const { socket, batches } = await helloed(0);
      socket.reply(frame);
      await settle();

      expect(batches, "a malformed batch was applied").toHaveLength(0);
      expect(socket.closed, "a batch nobody can interpret has to end the session").toBe(true);
    });
  }

  it("still accepts an empty batch, which is how a device sees its own write", async () => {
    const { socket, batches } = await helloed(0);
    socket.reply({ op: "batch", from: 1, to: 1, entries: [] });
    await settle();

    expect(batches).toHaveLength(1);
    expect(batches[0]!.entries).toEqual([]);
    expect(socket.closed).toBe(false);

    // The cursor is not readable from outside, so it is observed the way it
    // matters: the next contiguous batch is accepted, which it could only
    // be if the empty one advanced it to 1.
    socket.reply({ op: "batch", from: 2, to: 2, entries: [] });
    await settle();
    expect(batches).toHaveLength(2);
    expect(socket.closed).toBe(false);
  });
});

/**
 * review finding I3. `ready` carries two caps on a batched write, the encoded
 * frame and the summed ciphertext budget, and one on a fetch. The engine used
 * a constant of its own, so a server advertising something smaller was ignored
 * and the batch refused with `toolarge`, which the engine reads as permanent
 * and wrote every note in the batch off for good.
 */
describe("keeping to the caps the server advertised", () => {
  /** A server that takes whatever is put and acknowledges it, one uid per entry. */
  function acceptEverything(socket: FakeSocket): void {
    let uid = 0;
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "putmany") {
        const entries = frame["entries"] as unknown[];
        s.reply({ res: "acks", id: frame["id"], results: entries.map(() => ({ uid: ++uid })) });
      } else if (frame["op"] === "put") {
        s.reply({ res: "have", id: frame["id"], uid: ++uid });
      } else if (frame["op"] === "ping") {
        s.raw({ res: "pong" });
      }
    };
  }

  /** Every putmany frame this socket saw, with its encoded size and summed budget. */
  function batches(socket: FakeSocket) {
    const { entryBudget } = require_transport();
    return socket.sentText
      .filter((m) => m["op"] === "putmany")
      .map((m) => {
        const entries = m["entries"] as { meta: { size: number }; chunks: string[] }[];
        return {
          count: entries.length,
          encoded: JSON.stringify(m).length,
          budget: entries.reduce((n, e) => n + entryBudget(e.meta.size, e.chunks.length), 0),
        };
      });
  }
  function require_transport(): { entryBudget: (size: number, chunks: number) => number } {
    return { entryBudget: (size, chunks) => size + 256 * chunks };
  }

  it("splits a batched write by the summed budget cap", async () => {
    const cap = 6000;
    const { engine, socket, vault } = await engineOnFakeSocket({ maxBatchBytes: cap });
    acceptEverything(socket);
    // Each note is one chunk of about 400 bytes: a budget of about 656, so
    // nine fit under the cap and thirty need four batches.
    for (let i = 0; i < 30; i++) {
      await vault.edit(`note-${String(i).padStart(2, "0")}.md`, `note ${i}\n${"x".repeat(390)}\n`);
    }
    const report = await engine.sync();
    expect(report.uploaded).toBe(30);
    expect(report.skipped).toBe(0);
    const sent = batches(socket);
    expect(sent.length, JSON.stringify(sent)).toBeGreaterThan(1);
    for (const b of sent) {
      expect(b.budget, `a batch of ${b.count} carried a budget of ${b.budget}`).toBeLessThanOrEqual(
        cap,
      );
    }
    expect(sent.reduce((n, b) => n + b.count, 0)).toBe(30);
  });

  it("splits a batched write by the encoded frame cap", async () => {
    // Empty notes cost no budget at all, so only the frame size can fill a
    // batch: each entry encodes to a few hundred bytes of sealed path, mac
    // and parent.
    const cap = 4096;
    const { engine, socket, vault } = await engineOnFakeSocket({ maxBatchBytes: cap });
    acceptEverything(socket);
    for (let i = 0; i < 40; i++) await vault.edit(`empty-${String(i).padStart(2, "0")}.md`, "");
    const report = await engine.sync();
    expect(report.uploaded).toBe(40);
    const sent = batches(socket);
    expect(sent.length).toBeGreaterThan(1);
    for (const b of sent) {
      expect(b.encoded, `a batch of ${b.count} encoded to ${b.encoded}`).toBeLessThanOrEqual(cap);
    }
    expect(sent.reduce((n, b) => n + b.count, 0)).toBe(40);
  });

  it("sends a file whose own budget is over the cap with put, and the notes beside it as a batch", async () => {
    const cap = 6000;
    const { engine, socket, vault } = await engineOnFakeSocket({ maxBatchBytes: cap });
    acceptEverything(socket);
    for (let i = 0; i < 3; i++) await vault.edit(`note-${i}.md`, `note ${i}\n`);
    const big = new Uint8Array(cap + 1000);
    crypto.getRandomValues(big);
    await vault.write("photo.bin", big, { mtime: 1000, ctime: 1000 });
    const report = await engine.sync();
    expect(report.uploaded, JSON.stringify(report)).toBe(4);
    expect(report.skipped).toBe(0);
    const puts = socket.sentText.filter((m) => m["op"] === "put");
    expect(puts, "the large file did not go alone").toHaveLength(1);
    expect(batches(socket).reduce((n, b) => n + b.count, 0)).toBe(3);
  });

  /**
   * A fetch is bounded by the summed budget of what it asks for and by a
   * count of names. The client cannot see a stored chunk's size, so it costs
   * each at its share of the file's declared size plus the allowance the
   * server's own rule grants, which is never under what the server will
   * count.
   */
  it("splits a fetch by the byte cap and asks for every chunk once", async () => {
    const { Engine, planFetches } = await import("./engine.ts");
    void Engine;
    const budget = (name: string) => Number(name.split(":")[1]);
    const names = ["a:1000", "b:1000", "c:1000", "d:2500", "e:100", "f:100", "g:5000"];
    const asks = planFetches(names, budget, 2500, 65536);
    for (const ask of asks) {
      const total = ask.reduce((n, name) => n + budget(name), 0);
      expect(total <= 2500 || ask.length === 1, `${ask.join(",")} costs ${total}`).toBe(true);
    }
    expect(asks.flat()).toEqual(names);
    expect(asks.length).toBeGreaterThan(2);
  });

  it("splits a fetch by the count of names", async () => {
    const { planFetches } = await import("./engine.ts");
    const names = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const asks = planFetches(names, () => 1, 1 << 30, 4);
    expect(asks.map((a) => a.length)).toEqual([4, 4, 2]);
    expect(asks.flat()).toEqual(names);
  });

  it("downloads a batch of files in fetches that each keep under the server's cap", async () => {
    const { macEntry, sealChunks, sealPath } = await import("./crypto.ts");
    const cap = 3000;
    const { engine, socket, vault, keys, logs } = await engineOnFakeSocket({ maxFetchBytes: cap });

    // Ten files of a kilobyte, one chunk each, so each costs 1000 + 256 and
    // two fit under the cap.
    const files: {
      path: string;
      sealedPath: string;
      body: Uint8Array;
      name: string;
      text: Uint8Array;
    }[] = [];
    for (let i = 0; i < 10; i++) {
      const text = new TextEncoder().encode(`file ${i}\n${"y".repeat(990)}`);
      const [chunk] = await sealChunks(keys, [text]);
      files.push({
        path: `f${i}.md`,
        sealedPath: await sealPath(keys, `f${i}.md`),
        body: chunk!.bytes,
        name: chunk!.name,
        text,
      });
    }
    const byName = new Map(files.map((f) => [f.name, f.body]));
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "fetch") {
        const asked = frame["chunks"] as string[];
        s.bodies(...asked.map((n) => byName.get(n)!));
      }
    };
    const entries = await Promise.all(
      files.map(async (f, i) => {
        const facts = {
          path: f.sealedPath,
          size: f.text.length,
          ctime: 1000,
          mtime: 1000,
          folder: false,
          deleted: false,
          chunks: [f.name],
          parent: "",
        };
        return {
          uid: i + 1,
          ...facts,
          device: "other",
          mac: await macEntry(keys, facts),
        };
      }),
    );
    socket.raw({ op: "batch", from: 1, to: 10, entries });
    // Accepting a batch verifies every authenticator, which is WebCrypto and
    // takes more than one turn of the event loop.
    for (let i = 0; i < 200 && engine.status().pending < 10; i++) await settle();
    expect(engine.status().pending, logs.join("\n")).toBe(10);
    const report = await engine.sync();
    expect(report.downloaded, JSON.stringify(report)).toBe(10);

    const fetches = socket.sentText.filter((m) => m["op"] === "fetch");
    expect(fetches.length, "one fetch carried everything").toBeGreaterThan(1);
    for (const f of fetches) {
      const asked = f["chunks"] as string[];
      expect(asked.length * (1000 + 256), `a fetch of ${asked.length}`).toBeLessThanOrEqual(cap);
    }
    expect(fetches.flatMap((f) => f["chunks"] as string[]).sort()).toEqual(
      files.map((f) => f.name).sort(),
    );
    for (const f of files) expect(vault.text(f.path)).toBe(new TextDecoder().decode(f.text));
  });
});
