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
import { Backoff, ConnectionError, ProtocolError, Transport, urlForHost, type Batch, type SocketLike } from "./transport.ts";

/** A socket under the test's control, which can say anything at all. */
class FakeSocket implements SocketLike {
    binaryType = "";
    onopen: ((ev: unknown) => void) | null = null;
    onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;

    /** Everything the client sent, in order. */
    readonly sentText: Record<string, unknown>[] = [];
    readonly sentBinary: Uint8Array[] = [];
    closed = false;

    send(data: string | ArrayBufferLike | Uint8Array): void {
        if (typeof data === "string") this.sentText.push(JSON.parse(data) as Record<string, unknown>);
        else this.sentBinary.push(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
    }

    close(): void {
        this.closed = true;
    }

    open(): void {
        this.onopen?.(undefined);
    }

    /** Delivers a text frame, as the server would. */
    reply(frame: unknown): void {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }

    body(bytes: Uint8Array): void {
        this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }

    hangUp(code = 1006, reason = "gone"): void {
        this.onclose?.({ code, reason });
    }
}

/** A connected transport and the socket behind it. */
async function connected(opts: {
    onBatch?: (b: Batch) => void | Promise<void>;
    onCaughtUp?: (c: number) => void;
    timeoutMs?: number;
} = {}) {
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
    const hello = rig.t.hello({ vault: "v", token: "tok", device: "d", cursor });
    rig.socket.reply({ res: "ready", proto: 1, cursor: 10, perFileMax: 1, chunkMax: 1, maxChunks: 1 });
    await hello;
    return rig;
}

/** A body and the name it travels under, which is a hash of exactly its bytes. */
async function named(body: Uint8Array): Promise<{ body: Uint8Array; name: string }> {
    return { body, name: await chunkName(body) };
}

/** Lets queued notification work run before asserting on it. */
const settle = () => new Promise((r) => setTimeout(r, 0));

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
    it("refuses a server speaking another protocol version", async () => {
        const { t, socket } = await connected();
        const hello = t.hello({ vault: "v", token: "t", device: "d", cursor: 0 });
        socket.reply({ res: "ready", proto: 2, cursor: 0, perFileMax: 1, chunkMax: 1, maxChunks: 1 });
        await expect(hello).rejects.toMatchObject({ code: "proto" });
    });

    it("sends the crypto suite this client actually implements", async () => {
        // A client that names a scheme it does not implement gets a session it
        // cannot decrypt anything in.
        const { t, socket } = await connected();
        void t.hello({ vault: "v", token: "t", device: "d", cursor: 0 }).catch(() => {});
        await settle();
        expect(socket.sentText[0]).toMatchObject({ op: "hello", proto: 1, crypto: "basalt/hkdf-aes-gcm/1" });
    });

    it("refuses anything other than ready", async () => {
        const { t, socket } = await connected();
        const hello = t.hello({ vault: "v", token: "t", device: "d", cursor: 0 });
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
        const put = t.put("p", { size: 3, ctime: 0, mtime: 0 }, chunks.map((c) => c.name), async (n) => chunks.find((c) => c.name === n)!.bytes);
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
        const put = t.put("p", { size: 1, ctime: 0, mtime: 0 }, ["a".repeat(64)], async () => new Uint8Array([1]));
        await settle();
        socket.reply({ res: "want", chunks: ["z".repeat(64)] });
        await expect(put).rejects.toMatchObject({ code: "badchunk" });
    });

    it("reports have as no upload at all", async () => {
        const { t, socket } = await helloed(0);
        const put = t.put("p", { size: 1, ctime: 0, mtime: 0 }, ["a".repeat(64)], async () => new Uint8Array([1]));
        await settle();
        socket.reply({ res: "have", uid: 9 });
        expect(await put).toEqual({ uid: 9, uploaded: 0, bytes: 0 });
        expect(socket.sentBinary).toHaveLength(0);
    });

    it("refuses a reply that is neither want nor have", async () => {
        const { t, socket } = await helloed(0);
        const put = t.put("p", { size: 0, ctime: 0, mtime: 0 }, [], async () => new Uint8Array(0));
        await settle();
        socket.reply({ res: "chunks", uid: 1, size: 0, chunks: [] });
        await expect(put).rejects.toBeInstanceOf(ProtocolError);
    });

    it("carries prev only when there is a rename", async () => {
        const { t, socket } = await helloed(0);
        void t.put("new", { size: 0, ctime: 0, mtime: 0 }, [], async () => new Uint8Array(0)).catch(() => {});
        await settle();
        expect(socket.sentText.at(-1)?.["meta"]).not.toHaveProperty("prev");

        socket.reply({ res: "have", uid: 1 });
        await settle();
        void t.put("new", { size: 0, ctime: 0, mtime: 0, prev: "old" }, [], async () => new Uint8Array(0)).catch(() => {});
        await settle();
        expect(socket.sentText.at(-1)?.["meta"]).toMatchObject({ prev: "old" });
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
        for (const code of ["proto", "auth", "cursor", "busy", "protostate", "badchunk", "internal"]) {
            expect(new ProtocolError(code, "x").fatal, code).toBe(true);
        }
        for (const code of ["badentry", "badname", "toolarge", "nospace", "nouid", "nocontent", "nochunk"]) {
            expect(new ProtocolError(code, "x").fatal, code).toBe(false);
        }
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

    it("refuses two requests at once rather than crossing their replies", async () => {
        // Two in flight would resolve into each other's slot, and the caller
        // would receive the wrong answer with nothing reporting it.
        const { t } = await helloed(0);
        void t.get(1).catch(() => {});
        await expect(t.get(2)).rejects.toThrow(/already in flight/);
    });

    it("closes the connection when a request goes unanswered", async () => {
        // The request may have been received and acted on, so the session's state
        // is unknown, and continuing on an unknown state is how two ends desync.
        vi.useFakeTimers();
        try {
            const { t, socket } = await connected({ timeoutMs: 50 });
            const hello = t.hello({ vault: "v", token: "t", device: "d", cursor: 0 });
            const rejected = expect(hello).rejects.toBeInstanceOf(ConnectionError);
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
        socket.body(one.body);
        socket.body(two.body);
        const bodies = await fetching;
        expect(bodies.map((b) => b[0])).toEqual([7, 8]);
    });

    it("returns as many bodies as it asked for", async () => {
        const { t, socket } = await helloed(0);
        const parts = await Promise.all([1, 2, 3].map((n) => named(new Uint8Array([n]))));
        const fetching = t.fetch(parts.map((p) => p.name));
        for (const p of parts) socket.body(p.body);
        expect(await fetching).toHaveLength(3);
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
        socket.body(other.body);
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

    it("does not let one fetch inherit the bodies of another", async () => {
        const { t, socket } = await helloed(0);
        const wanted = await named(new Uint8Array([4, 5, 6]));
        const stale = await named(new Uint8Array([7, 8, 9]));

        // A fetch is abandoned with a body still to come.
        const abandoned = t.fetch([stale.name, wanted.name]);
        socket.body(stale.body);
        socket.reply({ res: "err", code: "nochunk", msg: "gone" });
        await expect(abandoned).rejects.toMatchObject({ code: "nochunk" });

        // Whatever happens next, it is not that the leftover is served as the
        // answer to a different question.
        const next = t.fetch([wanted.name]).catch((e: Error) => e);
        socket.body(wanted.body);
        const result = await next;
        if (result instanceof Error) return; // refused outright, which is fine
        expect(result[0], "a fetch was answered with another fetch's body").toEqual(wanted.body);
    });

    it("raises a refusal that arrives instead of the bodies", async () => {
        const { t, socket } = await helloed(0);
        const fetching = t.fetch(["a".repeat(64)]);
        await settle();
        socket.reply({ res: "err", code: "nochunk", msg: "not held" });
        await expect(fetching).rejects.toMatchObject({ code: "nochunk" });
    });

    it("asks for nothing when given nothing", async () => {
        const { t, socket } = await helloed(0);
        expect(await t.fetch([])).toEqual([]);
        expect(socket.sentText).toHaveLength(1); // the hello, and nothing more
    });
});

describe("the scheme for a host", () => {
    it("uses plain websocket only for loopback", () => {
        expect(urlForHost("127.0.0.1:3003")).toBe("ws://127.0.0.1:3003");
        expect(urlForHost("localhost:3003")).toBe("ws://localhost:3003");
        expect(urlForHost("[::1]:3003")).toBe("ws://[::1]:3003");
    });

    it("uses TLS for everything else", () => {
        // TLS is terminated in front of the server, which holds no key material,
        // so anything not on this machine has to be wss.
        expect(urlForHost("homelab.example.ts.net:3003")).toBe("wss://homelab.example.ts.net:3003");
        expect(urlForHost("192.168.1.10:3003")).toBe("wss://192.168.1.10:3003");
    });

    it("tolerates a scheme already being there", () => {
        expect(urlForHost("wss://host:1")).toBe("wss://host:1");
        expect(urlForHost("ws://127.0.0.1:1")).toBe("ws://127.0.0.1:1");
    });
});

describe("reconnect pacing", () => {
    it("does not wait at all before the first attempt", () => {
        const b = new Backoff(0, 300_000, 5_000, false);
        expect(b.delay()).toBe(0);
        expect(b.isReady(0)).toBe(true);
    });

    it("doubles, and stops at the ceiling", () => {
        const b = new Backoff(0, 300_000, 5_000, false);
        const seen: number[] = [];
        for (let i = 0; i < 10; i++) {
            b.fail(0);
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
        lowest.fail(0);
        highest.fail(0);
        expect(lowest.delay()).toBe(2_500);
        expect(highest.delay()).toBe(5_000);
    });

    it("forgets its failures on success", () => {
        const b = new Backoff(0, 300_000, 5_000, false);
        b.fail(0);
        b.fail(0);
        expect(b.failures).toBe(2);
        b.success(0);
        expect(b.failures).toBe(0);
        expect(b.delay()).toBe(0);
    });

    it("respects a floor between attempts", () => {
        const b = new Backoff(1_000, 300_000, 5_000, false);
        b.success(0);
        expect(b.isReady(500)).toBe(false);
        expect(b.isReady(1_000)).toBe(true);
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

        socket.reply({ res: "history", path: "SEALED-PATH", entries: [{ uid: 3 }, { uid: 2 }] });
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
        socket.reply({ res: "deleted", entries: [{ uid: 9 }, { uid: 8 }], more: true });
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
        socket.reply({ res: "chunks", uid: 1, size: 10, chunks: Array.from({ length: 5 }, (_, i) => `${i}`.repeat(64)) });
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
        socket.body(body);
        // It gets as far as decrypting, which is where a body that is not a
        // sealed chunk fails. That is past the bound, which is the point.
        await expect(asked).rejects.not.toThrow(/stores at most/);
    });
});

/** An engine wired to a fake socket, connected, with limits of the test's choosing. */
async function engineOnFakeSocket(limits: { maxChunks?: number; perFileMax?: number; chunkMax?: number }) {
    const { Engine } = await import("./engine.ts");
    const { deriveKeys } = await import("./crypto.ts");
    const { MemoryIndexStore, MemoryVault } = await import("./vault.ts");
    const socket = new FakeSocket();
    const t = new Transport("ws://test", { onBatch: () => {}, socketFactory: () => socket, timeoutMs: 2000 });
    const connecting = t.connect();
    socket.open();
    await connecting;

    const vault = new MemoryVault();
    const engine = new Engine({
        vault,
        store: new MemoryIndexStore(),
        keys: await deriveKeys(new Uint8Array(20).fill(1)),
        transport: t,
        device: "d",
        vaultId: "v",
        token: "t",
    });
    const started = engine.start();
    await settle();
    socket.reply({
        res: "ready",
        proto: 1,
        cursor: 0,
        perFileMax: limits.perFileMax ?? 1 << 28,
        chunkMax: limits.chunkMax ?? 1 << 20,
        maxChunks: limits.maxChunks ?? 100,
    });
    await settle();
    socket.reply({ op: "caught-up", cursor: 0 });
    await started;
    return { engine, socket, t, vault };
}

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
        expect(put, `nothing was put: ${JSON.stringify(socket.sentText.map((m) => m["op"]))}`).toBeDefined();
        const entries = put!["entries"] as { chunks: string[] }[];
        const names = entries.flatMap((e) => e.chunks);
        expect(names.length, "a 1 MiB file was not cut to a 64 KiB ceiling").toBeGreaterThan(8);

        socket.reply({ res: "want", chunks: names });
        await settle();
        socket.reply({ res: "acks", results: entries.map((_, i) => ({ uid: i + 1 })) });
        await syncing.catch(() => undefined);

        const worst = Math.max(...socket.sentBinary.map((b) => b.length));
        expect(worst, `the largest body sent was ${worst} against a ceiling of ${ceiling}`).toBeLessThanOrEqual(
            ceiling
        );
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
        socket.body(body);
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
        socket.reply({ res: "err", code: "nochunk", msg: "not held" });
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
            const { t, socket, batches } = await helloed(0);
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
