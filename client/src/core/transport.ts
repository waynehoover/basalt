/**
 * The wire, and nothing above it.
 *
 * This module knows the protocol and no policy: what a `put` looks like, not
 * when to send one. docs/client-design.md singles that boundary out as the
 * cleanest thing in Obsidian's engine, where a 66-method engine collaborates
 * with a 20-method transport that decides nothing.
 *
 * ## Shape, taken from Obsidian's transport
 *
 * Read at `app.pretty.js:176823` onwards. Three decisions there are right and are
 * kept:
 *
 *   - **One outstanding request, not a map of them.** A single promise slot,
 *     resolved by the next reply that is not a notification. It works because the
 *     protocol is sequential per session: the server reads one op, answers it,
 *     and reads the next. A correlation id would be machinery for a concurrency
 *     the protocol does not have.
 *   - **A queue for binary frames.** Bodies can arrive before anything asks for
 *     them, so they are buffered rather than dropped. Obsidian's `dataQueue`.
 *   - **A timeout closes the connection.** A request that did not answer leaves
 *     the session's state unknown, and continuing on an unknown state is how two
 *     ends desync. Obsidian rejects and disconnects; so does this.
 *
 * And one thing every client of this protocol has to do, which is worth saying
 * plainly because the first two written against it got it wrong: **replies are
 * multiplexed with notifications.** Another device can commit at any moment, so a
 * batch can arrive between any request and its answer. Anything that assumes the
 * next frame is its reply will read a batch as an answer and hang.
 */

import { CRYPTO_SUITE, type SealedChunk } from "./crypto.ts";

/** The protocol version this client speaks. A mismatch is refused, not negotiated. */
export const PROTO = 1;

/** How long a request may go unanswered before the connection is considered dead. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** An entry as it arrives from the server. Paths and chunk names are sealed. */
export interface WireEntry {
    readonly uid: number;
    readonly path: string;
    readonly size: number;
    readonly ctime: number;
    readonly mtime: number;
    readonly folder: boolean;
    readonly deleted: boolean;
    readonly device: string;
    readonly prev?: string;
    readonly chunks: string[];
}

/** A covered range of the uid sequence, with everything in it that exists. */
export interface Batch {
    readonly from: number;
    readonly to: number;
    readonly entries: WireEntry[];
}

/** What the server advertises in reply to hello. */
export interface ServerLimits {
    readonly proto: number;
    /** The newest uid the server holds. */
    readonly cursor: number;
    readonly perFileMax: number;
    readonly chunkMax: number;
    readonly maxChunks: number;
}

/** Metadata for a put. Mirrors the protocol's `meta` object exactly. */
export interface PutMeta {
    readonly size: number;
    readonly ctime: number;
    readonly mtime: number;
    readonly folder?: boolean;
    readonly deleted?: boolean;
    /** The previous path on a rename, so a rename is one operation. */
    readonly prev?: string;
}

/**
 * A refusal from the server, carrying the code it sent.
 *
 * `code` is what a client acts on and `message` is what a person reads;
 * docs/protocol.md requires both, because an error a device cannot act on and a
 * person cannot read is how a silent failure starts.
 */
export class ProtocolError extends Error {
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "ProtocolError";
    }

    /**
     * Whether this refusal ends the session.
     *
     * The list is docs/protocol.md's, and it is the transport's job to know it:
     * a caller that retried a `proto` mismatch would loop forever, and one that
     * tore down the connection over a `badname` would turn one bad file into a
     * reconnect.
     */
    get fatal(): boolean {
        return ["proto", "auth", "cursor", "busy", "protostate", "badchunk", "internal"].includes(this.code);
    }
}

/** Raised when the connection went away rather than answering. */
export class ConnectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConnectionError";
    }
}

export interface TransportOptions {
    /**
     * Called for every batch, in the order the server sent them.
     *
     * Both catch-up and live changes arrive here, because they are the same
     * message. A batch whose entry list is empty is this device's own write: it
     * carries the cursor advance and not the payload, so there is nothing to
     * apply and the cursor still moves.
     */
    readonly onBatch: (batch: Batch) => void | Promise<void>;
    /** Called once when the backlog is drained. */
    readonly onCaughtUp?: (cursor: number) => void;
    /**
     * Called once when the connection has ended, for any reason.
     *
     * This class deliberately does not reconnect: a client that keeps running
     * wants backoff and a client that syncs once and exits wants to fail, and
     * that is a decision for whoever is running it. `Backoff` below is here for
     * the first kind. `fatal` on the error says whether trying again could ever
     * help.
     */
    readonly onClosed?: (cause: Error) => void;
    readonly log?: (message: string, ...rest: unknown[]) => void;
    /** Injectable for tests. Defaults to the platform's WebSocket. */
    readonly socketFactory?: (url: string) => SocketLike;
    readonly timeoutMs?: number;
}

/**
 * The subset of WebSocket this uses.
 *
 * Narrowed to what is needed, so a test can supply a socket without simulating a
 * browser and so the type does not depend on which platform's DOM types happen
 * to be loaded.
 */
export interface SocketLike {
    binaryType: string;
    onopen: ((this: void, ev: unknown) => void) | null;
    onclose: ((this: void, ev: { code?: number; reason?: string }) => void) | null;
    onerror: ((this: void, ev: unknown) => void) | null;
    onmessage: ((this: void, ev: { data: unknown }) => void) | null;
    send(data: string | ArrayBufferLike | Uint8Array): void;
    close(code?: number, reason?: string): void;
}

interface Waiter<T> {
    resolve: (value: T) => void;
    reject: (err: Error) => void;
}

type Reply = Record<string, unknown>;

export class Transport {
    private socket: SocketLike | undefined;
    private replyWaiter: Waiter<Reply> | undefined;
    private bodyWaiter: Waiter<Uint8Array> | undefined;
    /** Bodies that arrived before anything asked for them. Obsidian's dataQueue. */
    private readonly bodyQueue: Uint8Array[] = [];
    private closed = false;
    private closeReason: Error | undefined;
    /**
     * The cursor as the client understands it, advanced only by batches.
     *
     * Held here so the continuity check has something to compare against. The
     * protocol's rule is `from === cursor + 1`, and a gap means a file was
     * skipped, which is the one thing the batch shape exists to make visible.
     */
    private cursor = 0;
    /** Notifications are handled in arrival order, never overlapped. */
    private notifying: Promise<void> = Promise.resolve();

    constructor(
        private readonly url: string,
        private readonly opts: TransportOptions
    ) {}

    private log(message: string, ...rest: unknown[]): void {
        this.opts.log?.(message, ...rest);
    }

    /** The cursor this client has applied up to. */
    get appliedCursor(): number {
        return this.cursor;
    }

    async connect(): Promise<void> {
        if (this.socket) throw new Error("already connected");
        const factory = this.opts.socketFactory ?? defaultSocketFactory;
        const socket = factory(this.url);
        // Bodies as bytes. Browsers default to Blob, which would mean an await
        // per frame and a different code path from Node.
        socket.binaryType = "arraybuffer";
        this.socket = socket;

        await new Promise<void>((resolve, reject) => {
            socket.onopen = () => resolve();
            socket.onerror = () => reject(new ConnectionError(`could not connect to ${this.url}`));
            socket.onclose = (ev) => reject(new ConnectionError(`connection closed before opening: ${describeClose(ev)}`));
        });

        socket.onerror = () => this.die(new ConnectionError("the connection failed"));
        socket.onclose = (ev) => this.die(new ConnectionError(`the connection closed: ${describeClose(ev)}`));
        socket.onmessage = (ev) => this.onFrame(ev.data);
    }

    /**
     * Ends the connection and fails anything waiting on it.
     *
     * Everything that stops this transport goes through here, so there is one
     * place a waiter can be left hanging and it is covered.
     */
    private die(cause: Error): void {
        if (this.closed) return;
        this.closed = true;
        this.closeReason = cause;
        this.log("transport closed", cause.message);
        const reply = this.replyWaiter;
        const body = this.bodyWaiter;
        this.replyWaiter = undefined;
        this.bodyWaiter = undefined;
        reply?.reject(cause);
        body?.reject(cause);
        try {
            this.socket?.close();
        } catch {
            // Already gone. Nothing to do and nothing worth reporting.
        }
        try {
            this.opts.onClosed?.(cause);
        } catch {
            // A listener that throws does not get to leave the transport in a
            // half-closed state; it is already closed by this point.
        }
    }

    close(): void {
        this.die(new ConnectionError("closed by this device"));
    }

    get isClosed(): boolean {
        return this.closed;
    }

    private onFrame(data: unknown): void {
        if (typeof data === "string") {
            let frame: Reply;
            try {
                frame = JSON.parse(data) as Reply;
            } catch {
                // A frame that is not JSON means the two ends disagree about the
                // protocol. Guessing at it is worse than stopping.
                this.die(new ProtocolError("protostate", `server sent a frame that is not JSON: ${data.slice(0, 120)}`));
                return;
            }
            this.onTextFrame(frame);
            return;
        }

        const bytes = toBytes(data);
        if (bytes === undefined) {
            this.die(new ProtocolError("protostate", `server sent a frame of an unexpected type`));
            return;
        }
        const waiter = this.bodyWaiter;
        if (waiter) {
            this.bodyWaiter = undefined;
            waiter.resolve(bytes);
        } else {
            this.bodyQueue.push(bytes);
        }
    }

    private onTextFrame(frame: Reply): void {
        // Notifications first, and by name. Everything else is the answer to the
        // request in flight; see the note at the top about why a client that
        // skips this reads a batch as its reply and hangs.
        if (frame["op"] === "batch") {
            this.queueNotification(() => this.onBatchFrame(frame));
            return;
        }
        if (frame["op"] === "caught-up") {
            const cursor = numberOf(frame["cursor"]);
            this.queueNotification(async () => {
                if (cursor !== this.cursor) {
                    // The server says the backlog ends somewhere this client
                    // never reached. Continuing would leave a hole nothing asks
                    // about again.
                    this.die(
                        new ProtocolError(
                            "protostate",
                            `server says caught up at ${cursor}, this device reached ${this.cursor}`
                        )
                    );
                    return;
                }
                this.opts.onCaughtUp?.(cursor);
            });
            return;
        }

        const waiter = this.replyWaiter;
        if (!waiter) {
            // Nothing asked for this. Either the server sent an unsolicited
            // reply or this client lost track, and both mean the two ends
            // disagree about state.
            this.die(new ProtocolError("protostate", `server sent an unexpected reply: ${JSON.stringify(frame)}`));
            return;
        }
        this.replyWaiter = undefined;
        waiter.resolve(frame);
    }

    /**
     * Runs notifications one at a time, in arrival order.
     *
     * Batches must be applied in order or the cursor walks backwards over files
     * that were never received. Obsidian serialises them through a `notifyQueue`
     * for the same reason.
     */
    private queueNotification(work: () => void | Promise<void>): void {
        this.notifying = this.notifying.then(work).catch((err: unknown) => {
            this.die(err instanceof Error ? err : new Error(String(err)));
        });
    }

    private async onBatchFrame(frame: Reply): Promise<void> {
        const from = numberOf(frame["from"]);
        const to = numberOf(frame["to"]);
        const entries = Array.isArray(frame["entries"]) ? (frame["entries"] as WireEntry[]) : [];

        // The continuity check the batch shape exists for. From and to are a
        // covered range, not the uids present, so a purged hole in the sequence
        // is not a gap; anything else is.
        if (from !== this.cursor + 1) {
            throw new ProtocolError(
                "protostate",
                `batch covers ${from} to ${to} but this device has applied up to ${this.cursor}, so something was skipped`
            );
        }
        if (to < from) {
            throw new ProtocolError("protostate", `batch covers an empty range, ${from} to ${to}`);
        }
        for (const e of entries) {
            if (e.uid < from || e.uid > to) {
                throw new ProtocolError("protostate", `batch ${from}..${to} contains uid ${e.uid}`);
            }
        }

        await this.opts.onBatch({ from, to, entries });
        // Advanced only after the caller has applied it. Advancing first would
        // mean a failure to apply is a file silently skipped.
        this.cursor = to;
    }

    /* ------------------------------------------------------------ *
     * Sending
     * ------------------------------------------------------------ */

    private send(value: unknown): void {
        if (this.closed || !this.socket) {
            throw this.closeReason ?? new ConnectionError("not connected");
        }
        this.socket.send(JSON.stringify(value));
    }

    private sendBody(bytes: Uint8Array): void {
        if (this.closed || !this.socket) {
            throw this.closeReason ?? new ConnectionError("not connected");
        }
        this.socket.send(bytes);
    }

    /**
     * Sends a request and waits for the reply that is not a notification.
     *
     * A timeout closes the connection rather than only rejecting. The request
     * may have been received and acted on, so the session's state is unknown,
     * and the only safe next step is to start again.
     */
    private async request(value: unknown): Promise<Reply> {
        if (this.replyWaiter) {
            // Two requests in flight would resolve into each other's slot. The
            // caller above is single-flight; this makes that a checked property
            // rather than a convention.
            throw new Error("a request is already in flight");
        }
        const timeoutMs = this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
        const reply = await new Promise<Reply>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.die(new ConnectionError(`no reply within ${timeoutMs}ms`));
            }, timeoutMs);
            this.replyWaiter = {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            };
            try {
                this.send(value);
            } catch (err) {
                clearTimeout(timer);
                this.replyWaiter = undefined;
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });

        if (reply["res"] === "err") {
            const err = new ProtocolError(String(reply["code"] ?? "unknown"), String(reply["msg"] ?? "no message"));
            if (err.fatal) this.die(err);
            throw err;
        }
        return reply;
    }

    /** Waits for one binary frame, taking a queued one if there is any. */
    private async body(): Promise<Uint8Array> {
        const queued = this.bodyQueue.shift();
        if (queued) return queued;
        if (this.closed) throw this.closeReason ?? new ConnectionError("not connected");
        return new Promise<Uint8Array>((resolve, reject) => {
            this.bodyWaiter = { resolve, reject };
        });
    }

    /* ------------------------------------------------------------ *
     * Operations
     * ------------------------------------------------------------ */

    /**
     * Opens the session and returns the limits the server advertises.
     *
     * The cursor sent is what this device has applied. The reply's cursor is what
     * the *server* holds, so the difference says how far behind this device is
     * without anything having remembered a verdict from last time.
     */
    async hello(args: { vault: string; token: string; device: string; cursor: number }): Promise<ServerLimits> {
        this.cursor = args.cursor;
        const reply = await this.request({
            op: "hello",
            proto: PROTO,
            crypto: CRYPTO_SUITE,
            vault: args.vault,
            token: args.token,
            device: args.device,
            cursor: args.cursor,
        });
        if (reply["res"] !== "ready") {
            throw new ProtocolError("protostate", `expected ready, got ${JSON.stringify(reply)}`);
        }
        const limits: ServerLimits = {
            proto: numberOf(reply["proto"]),
            cursor: numberOf(reply["cursor"]),
            perFileMax: numberOf(reply["perFileMax"]),
            chunkMax: numberOf(reply["chunkMax"]),
            maxChunks: numberOf(reply["maxChunks"]),
        };
        if (limits.proto !== PROTO) {
            throw new ProtocolError("proto", `server speaks protocol ${limits.proto}, this client speaks ${PROTO}`);
        }
        this.log("ready", limits);
        return limits;
    }

    /**
     * Writes a version of a file and returns the uid it was given.
     *
     * `uploaded` is how many chunk bodies actually went over the wire, which is
     * the number worth logging: it is the difference between this and whole-file
     * sync, and a client re-sending chunks the server already holds would look
     * identical without it.
     */
    async put(
        path: string,
        meta: PutMeta,
        chunks: readonly SealedChunk[]
    ): Promise<{ uid: number; uploaded: number; bytes: number }> {
        const reply = await this.request({
            op: "put",
            path,
            meta: {
                size: meta.size,
                ctime: meta.ctime,
                mtime: meta.mtime,
                folder: meta.folder ?? false,
                deleted: meta.deleted ?? false,
                ...(meta.prev ? { prev: meta.prev } : {}),
            },
            chunks: chunks.map((c) => c.name),
        });

        if (reply["res"] === "have") {
            return { uid: numberOf(reply["uid"]), uploaded: 0, bytes: 0 };
        }
        if (reply["res"] !== "want") {
            throw new ProtocolError("protostate", `expected want or have, got ${JSON.stringify(reply)}`);
        }

        const wanted = stringsOf(reply["chunks"]);
        const byName = new Map(chunks.map((c) => [c.name, c.bytes]));
        let bytes = 0;

        // The reply names what to send. Sending anything else, or sending them in
        // another order, is caught by the server, which hashes each body and
        // matches it against what it asked for.
        for (const name of wanted) {
            const body = byName.get(name);
            if (!body) {
                throw new ProtocolError("badchunk", `server asked for ${name}, which this put does not contain`);
            }
            this.sendBody(body);
            bytes += body.length;
        }

        const ack = await this.awaitAck();
        return { uid: ack, uploaded: wanted.length, bytes };
    }

    /**
     * Waits for the ack that follows a body upload.
     *
     * A separate wait rather than another request, because the bodies were sent
     * without a reply between them: the protocol acknowledges the whole put once,
     * after every body and the entry are durable.
     */
    private async awaitAck(): Promise<number> {
        const reply = await new Promise<Reply>((resolve, reject) => {
            if (this.closed) {
                reject(this.closeReason ?? new ConnectionError("not connected"));
                return;
            }
            const timeoutMs = this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
            const timer = setTimeout(() => {
                this.die(new ConnectionError(`no acknowledgement within ${timeoutMs}ms`));
            }, timeoutMs);
            this.replyWaiter = {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            };
        });
        if (reply["res"] === "err") {
            const err = new ProtocolError(String(reply["code"] ?? "unknown"), String(reply["msg"] ?? "no message"));
            if (err.fatal) this.die(err);
            throw err;
        }
        if (reply["res"] !== "ack") {
            throw new ProtocolError("protostate", `expected ack, got ${JSON.stringify(reply)}`);
        }
        return numberOf(reply["uid"]);
    }

    /** Asks where a version's content lives. */
    async get(uid: number): Promise<{ uid: number; size: number; chunks: string[] }> {
        const reply = await this.request({ op: "get", uid });
        if (reply["res"] !== "chunks") {
            throw new ProtocolError("protostate", `expected chunks, got ${JSON.stringify(reply)}`);
        }
        return { uid: numberOf(reply["uid"]), size: numberOf(reply["size"]), chunks: stringsOf(reply["chunks"]) };
    }

    /**
     * Every version of one path, newest first.
     *
     * The path goes up sealed and comes back sealed. The server has never been
     * able to read one and this does not change that: recovery is a client
     * asking a blind store what it is holding.
     *
     * An empty list means the server has no versions of that path. It cannot
     * tell "never existed" from "history purged", so neither can this.
     */
    async history(
        sealedPath: string,
        opts: { before?: number; limit?: number } = {}
    ): Promise<WireEntry[]> {
        const reply = await this.request({
            op: "history",
            path: sealedPath,
            ...(opts.before !== undefined ? { before: opts.before } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        });
        if (reply["res"] !== "history") {
            throw new ProtocolError("protostate", `expected history, got ${JSON.stringify(reply)}`);
        }
        return entriesOf(reply["entries"], "history");
    }

    /**
     * Every path whose newest version is a deletion, newest first.
     *
     * Renames are suppressed by the server and not optionally: a rename leaves
     * a deletion behind at the old path, and a recovery list that is mostly
     * phantom deletions of files that still exist is one nobody reads.
     */
    async deleted(limit?: number): Promise<{ entries: WireEntry[]; more: boolean }> {
        const reply = await this.request({ op: "deleted", ...(limit !== undefined ? { limit } : {}) });
        if (reply["res"] !== "deleted") {
            throw new ProtocolError("protostate", `expected deleted, got ${JSON.stringify(reply)}`);
        }
        // `more` says the server cut the list short. Dropping it would hand
        // somebody a short list that looks complete, and the note they are
        // looking for is exactly the one that might be missing from it.
        return { entries: entriesOf(reply["entries"], "deleted"), more: reply["more"] === true };
    }

    /**
     * Downloads chunk bodies, in the order asked for.
     *
     * The server refuses the whole fetch if it lacks any of them, so a partial
     * answer is not a case to handle. Each body is still checked against the name
     * it was requested under by the caller, which is what the names being hashes
     * is for.
     */
    async fetch(names: readonly string[]): Promise<Uint8Array[]> {
        if (names.length === 0) return [];
        const reply = this.request({ op: "fetch", chunks: [...names] });

        // The bodies come as binary frames with no reply frame in front of them,
        // so this collects them while the request promise stays unresolved. It
        // will only settle if the server refuses, which is why it is raced rather
        // than awaited.
        const bodies: Uint8Array[] = [];
        for (let i = 0; i < names.length; i++) {
            const next = await Promise.race([
                this.body(),
                reply.then((r) => {
                    throw new ProtocolError("protostate", `expected a chunk body, got ${JSON.stringify(r)}`);
                }),
            ]);
            bodies.push(next);
        }
        // Nothing is coming for the request slot, so release it: the fetch is
        // answered entirely in binary frames.
        this.replyWaiter = undefined;
        return bodies;
    }

    async ping(): Promise<void> {
        const reply = await this.request({ op: "ping" });
        if (reply["res"] !== "pong") {
            throw new ProtocolError("protostate", `expected pong, got ${JSON.stringify(reply)}`);
        }
    }
}

/* ---------------------------------------------------------------- *
 * Reconnect pacing
 * ---------------------------------------------------------------- */

/**
 * Exponential backoff with jitter, in Obsidian's shape.
 *
 * Read at `app.pretty.js:176896`, and used by its engine as
 * `new Backoff(0, 300_000, 5_000, true)`: no delay on the first attempt, five
 * seconds doubling, capped at five minutes.
 *
 * The jitter is 50% to 100% of the computed delay, and it is not decoration. A
 * server restarting with several devices attached would otherwise have all of
 * them return at the same instant, fail together, and come back together.
 */
export class Backoff {
    private count = 0;
    private nextAt = 0;

    constructor(
        private readonly min = 0,
        private readonly max = 300_000,
        private readonly base = 5_000,
        private readonly jitter = true,
        private readonly random: () => number = Math.random
    ) {}

    /** Records a success: the next attempt waits only the floor. */
    success(now: number): void {
        this.count = 0;
        this.nextAt = now + this.delay();
    }

    fail(now: number): void {
        this.count++;
        this.nextAt = now + this.delay();
    }

    /** How long the next attempt waits, given the failures so far. */
    delay(): number {
        if (this.count === 0) return this.min;
        let t = this.base * Math.pow(2, this.count - 1);
        if (this.jitter) t *= 0.5 + 0.5 * this.random();
        return Math.floor(Math.min(this.max, this.min + t));
    }

    readyAt(): number {
        return this.nextAt;
    }

    isReady(now: number): boolean {
        return now >= this.nextAt;
    }

    get failures(): number {
        return this.count;
    }
}

/* ---------------------------------------------------------------- *
 * Plumbing
 * ---------------------------------------------------------------- */

function defaultSocketFactory(url: string): SocketLike {
    const ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
    if (!ctor) {
        throw new Error("no WebSocket available in this environment");
    }
    return new ctor(url) as unknown as SocketLike;
}

/**
 * Chooses the scheme for a host from the pairing string.
 *
 * Plain WebSocket only for loopback, where there is no network to protect and no
 * certificate to have. Everything else is `wss`, because TLS is terminated in
 * front of the server by `tailscale serve` or a tunnel and the server itself
 * holds no key material. Obsidian's engine makes the same call at
 * `obsidian-sync-engine.js:937`.
 */
export function urlForHost(hostAndPort: string): string {
    const host = hostAndPort.replace(/^wss?:\/\//, "");
    const local = host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]");
    return `${local ? "ws" : "wss"}://${host}`;
}

function toBytes(data: unknown): Uint8Array | undefined {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return undefined;
}

function numberOf(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringsOf(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string");
}

function describeClose(ev: { code?: number; reason?: string }): string {
    const code = ev.code ?? 0;
    const reason = ev.reason ? `, ${ev.reason}` : "";
    return `code ${code}${reason}`;
}

/**
 * Reads an entry list off the wire, refusing anything that is not one.
 *
 * Not `Array.isArray(x) ? x : []`. A server that answered null, or answered
 * with a field missing, would become "there is nothing to recover", and the one
 * moment somebody runs this is the moment they have lost a note. An unreadable
 * answer has to be an error.
 */
function entriesOf(value: unknown, what: string): WireEntry[] {
    if (!Array.isArray(value)) {
        throw new ProtocolError("protostate", `${what} came back without a list of entries`);
    }
    return value as WireEntry[];
}
