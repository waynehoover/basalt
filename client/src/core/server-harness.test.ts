/**
 * The client against the real server.
 *
 * These tests build `cmd/basalt`, run it on a loopback port with a temporary
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
import { authToken, deriveKeys, openChunk, sealChunks, sealPath, openPath, type VaultKeys } from "./crypto.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { ProtocolError, Transport, type Batch } from "./transport.ts";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The keys every client in this file shares, derived once.
 *
 * One vault, one root secret, and the auth key is a branch of the same schedule,
 * so every device that has the secret authenticates with the same key.
 */
let sharedKeys: VaultKeys | undefined;
async function vaultKeys(): Promise<VaultKeys> {
    sharedKeys ??= await deriveKeys(SECRET);
    return sharedKeys;
}
const enc = new TextEncoder();
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
        readonly keys: VaultKeys,
        readonly device: string
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
            ...server.credentials(authToken(this.keys)),
        });
    }

    /** Chunks, seals and puts a file exactly as the engine will. */
    async write(path: string, content: string | Uint8Array, mtime = 1000) {
        const data = typeof content === "string" ? enc.encode(content) : content;
        const isText = looksLikeText(path);
        const parts = [...chunkBytes(data, sizesFor(data.length, isText), isText)].map((c) => c.bytes);
        const sealed = await sealChunks(this.keys, parts);
        const result = await this.transport.put(
            await sealPath(this.keys, path),
            { size: data.length, ctime: 1, mtime }, sealed.map((c) => c.name), async (n) => sealed.find((c) => c.name === n)!.bytes);
        return { ...result, chunks: sealed.map((c) => c.name), plaintext: data };
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

const SECRET = new Uint8Array(20).fill(21);
let server: Server;
const clients: Client[] = [];

async function newClient(device: string, cursor = 0): Promise<Client> {
    const c = new Client(await deriveKeys(SECRET), device);
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
        const c = new Client(await deriveKeys(SECRET), "a");
        clients.push(c);
        const ready = await c.connect(server);
        expect(ready.proto).toBe(1);
        expect(ready.chunkMax).toBe(1024 * 1024);
        expect(ready.perFileMax).toBe(256 * 1024 * 1024);
        expect(ready.maxChunks).toBe(65536);
    });

    it("is refused with the wrong token", async () => {
        const t = new Transport(server.wsUrl, { onBatch: () => {}, timeoutMs: 10_000 });
        await t.connect();
        await expect(
            t.hello({ vault: "default", token: "not-the-token", device: "impostor", cursor: 0 })
        ).rejects.toMatchObject({ code: "auth" });
        t.close();
    });

    it("is refused for the wrong vault, indistinguishably", async () => {
        const t = new Transport(server.wsUrl, { onBatch: () => {}, timeoutMs: 10_000 });
        await t.connect();
        await expect(
            t.hello({ vault: "someone-elses", token: authToken(await vaultKeys()), device: "a", cursor: 0 })
        ).rejects.toMatchObject({ code: "auth" });
        t.close();
    });

    it("is refused when this device claims a cursor the server never issued", async () => {
        // The server has lost history this device already applied, so continuing
        // would have it reissue those uids for other files.
        const t = new Transport(server.wsUrl, { onBatch: () => {}, timeoutMs: 10_000 });
        await t.connect();
        await expect(
            t.hello({ ...server.credentials(authToken(await vaultKeys())), vault: "default", device: "a", cursor: 999_999 })
        ).rejects.toMatchObject({ code: "cursor" });
        t.close();
    });
});

describe("a file, all the way there and back", () => {
    it("round trips through chunking, sealing, the wire, and the server", async () => {
        const fresh = new Server();
        await fresh.start();
        try {
            const c = new Client(await deriveKeys(SECRET), "a");
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
            const c = new Client(await deriveKeys(SECRET), "a");
            await c.connect(fresh);

            let text = "";
            for (let i = 0; i < 4000; i++) text += `Paragraph ${i} with a reasonable number of words in it.\n\n`;
            const put = await c.write("notes/long.md", text);
            // Many chunks, not a specific number: the count depends on the size
            // the chunker picks for a file this big, and that scales with the
            // file rather than being one constant for a note and a novel.
            expect(put.chunks.length, `a ${text.length} byte note became ${put.chunks.length} chunks`).toBeGreaterThan(
                10
            );

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
            const c = new Client(await deriveKeys(SECRET), "a");
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
            const c = new Client(await deriveKeys(SECRET), "a");
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
            const c = new Client(await deriveKeys(SECRET), "a");
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

describe("deduplication, which is the point", () => {
    it("uploads nothing for content the server already holds", async () => {
        const fresh = new Server();
        await fresh.start();
        try {
            const c = new Client(await deriveKeys(SECRET), "a");
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
            const c = new Client(await deriveKeys(SECRET), "a");
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
                `the first sync sent ${first.bytes} bytes and one edit cost ${second.bytes}`
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
            const a = new Client(await deriveKeys(SECRET), "a");
            const b = new Client(await deriveKeys(SECRET), "b");
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
            const a = new Client(await deriveKeys(SECRET), "a");
            const b = new Client(await deriveKeys(SECRET), "b");
            await a.connect(fresh);
            await b.connect(fresh);

            for (let i = 0; i < 4; i++) {
                await a.write(`a${i}.md`, `from a ${i}`);
                await b.write(`b${i}.md`, `from b ${i}`);
            }

            // The transport asserts from === cursor + 1 on every batch, so
            // reaching the right cursor at all means nothing arrived out of
            // order and nothing was skipped.
            await until("both to reach uid 8", () => a.transport.appliedCursor === 8 && b.transport.appliedCursor === 8);
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
            const a = new Client(await deriveKeys(SECRET), "a");
            await a.connect(fresh);
            for (let i = 0; i < 5; i++) await a.write(`f${i}.md`, `content ${i}`);
            a.close();

            // A second device arriving late gets everything, in order.
            const late = new Client(await deriveKeys(SECRET), "late");
            clients.push(late);
            const ready = await late.connect(fresh, 0);
            expect(ready.cursor).toBe(5);
            await until("the backlog to drain", () => late.caughtUpAt === 5);
            expect(late.entries.size).toBe(5);

            // And one that already has part of it gets only the rest.
            const partial = new Client(await deriveKeys(SECRET), "partial");
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
            const c = new Client(await deriveKeys(SECRET), "a");
            await c.connect(fresh);

            // A size with no chunks, which is indistinguishable from an empty
            // file and so is refused rather than stored as one.
            await expect(
                c.transport.put(await sealPath(c.keys, "bad.md"), { size: 4096, ctime: 1, mtime: 1 }, [], async () => new Uint8Array(0))
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
        // The transport has to know, because a caller that retried a proto
        // mismatch would loop and one that tore down over a badname would turn
        // one bad file into a reconnect.
        for (const code of ["proto", "auth", "cursor", "busy", "protostate", "badchunk", "internal"]) {
            expect(new ProtocolError(code, "x").fatal, code).toBe(true);
        }
        for (const code of ["badentry", "badname", "toolarge", "nospace", "nouid", "nocontent", "nochunk"]) {
            expect(new ProtocolError(code, "x").fatal, code).toBe(false);
        }
    });
});

describe("what the server can and cannot see", () => {
    it("never receives a readable path or a readable byte", async () => {
        const fresh = new Server();
        await fresh.start();
        try {
            const c = new Client(await deriveKeys(SECRET), "a");
            await c.connect(fresh);
            await c.write("Personal/Diary 2026.md", "Today I wrote something private.");
            c.close();
            await fresh.stop();

            // Grep everything the server wrote. Neither the path nor the content
            // may appear anywhere on its disk.
            const { stdout } = await run("grep", ["-rl", "Diary", fresh.dataDir]).catch(() => ({ stdout: "" }));
            expect(stdout.trim(), "the path appeared in the server's files").toBe("");
            const { stdout: content } = await run("grep", ["-rl", "something private", fresh.dataDir]).catch(() => ({
                stdout: "",
            }));
            expect(content.trim(), "the content appeared in the server's files").toBe("");
        } finally {
            await fresh.cleanup();
        }
    }, 60_000);
});
