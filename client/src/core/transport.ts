/**
 * The wire, and nothing above it.
 *
 * This module knows the protocol and no policy: what a `put` looks like, not
 * when to send one. That boundary is the cleanest thing in Obsidian's engine,
 * where a 66-method engine collaborates with a 20-method transport that decides
 * nothing.
 *
 * ## Shape, taken from Obsidian's transport, and one thing not taken
 *
 * Read at `app.pretty.js:176823` onwards. Two decisions there are right and are
 * kept:
 *
 *   - **A queue for binary frames.** Bodies can arrive before the loop that
 *     reads them is running, so they are buffered rather than dropped.
 *     Obsidian's `dataQueue`.
 *   - **A timeout closes the connection.** A request that did not answer leaves
 *     the session's state unknown, and continuing on an unknown state is how two
 *     ends desync. Obsidian rejects and disconnects; so does this.
 *
 * The third, one promise slot resolved by the next reply that is not a
 * notification, is what this transport used to do and what request ids
 * removed. Matching a reply to a request by position produced three separate
 * defects here: an acknowledgement arriving from inside the last `send`,
 * before its waiter was armed, read as a reply nobody asked for (C11); a
 * shutdown notice read as a bad reply (C26); and the bodies of a refused fetch
 * consumed as the answer to the next one (C34). Every request now carries an
 * `id` and every reply echoes it, so a reply is matched to its request by name
 * and a reply with no name is a notification or the reason the connection is
 * closing. docs/protocol.md, "Request ids".
 *
 * And one thing every client of this protocol has to do, which is worth saying
 * plainly because the first two written against it got it wrong: **replies are
 * multiplexed with notifications.** Another device can commit at any moment, so a
 * batch can arrive between any request and its answer. Anything that assumes the
 * next frame is its reply will read a batch as an answer and hang.
 */

import { CRYPTO_SUITE, chunkName, isChunkName } from "./crypto.ts";

/**
 * The protocol version this client speaks. A mismatch is refused, not negotiated.
 *
 * Four, and nothing else. Four is not compatible with three and there is no
 * shim: a hello now carries a `deviceId` and the credential beside it is that
 * device's own, where in three it was the vault's, used by every device. A
 * client that guessed would be asking a protocol 4 server for exactly the sync
 * rights per-device credentials exist to make revocable. Three was in use by
 * one person for one day.
 *
 * The number still travels, and a mismatch still names both ends and the
 * server's version, because that is how the next upgrade gets diagnosed.
 */
export const PROTO = 4;

/** How long a request may go unanswered before the connection is considered dead. */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The most bytes a `vault` or `device` name may be, and the rule on what is in
 * it: no byte below 0x20 and not 0x7f. Both land in the server's log lines and
 * on every entry a device writes, and a newline in a log line is a forged log
 * line. The server refuses either fault with `badname` and ends the session;
 * checking here first means a bad name is one error at pairing rather than a
 * connection that dies on every attempt.
 */
export const MAX_NAME_BYTES = 64;

/**
 * The most chunk names one `fetch` may carry. The server's own bound on a chunk
 * list, and it refuses more with `toolarge`; a client splits before that.
 */
export const MAX_FETCH_NAMES = 65536;

/**
 * The ciphertext budget of one entry, as the server accounts it: its declared
 * size plus 256 bytes for each chunk it names, which covers the sealing
 * overhead and a little more. The server bounds a `putmany` by the sum of
 * these and a `fetch` by the summed stored sizes, which this is never smaller
 * than. One function, so the client and the server add the same thing up.
 */
export function entryBudget(size: number, chunkCount: number): number {
  return size + 256 * chunkCount;
}

/** An entry as it arrives from the server. Paths and chunk names are sealed. */
export interface WireDeletion extends WireEntry {
  /**
   * The newest version with content, or 0 when purge has taken them all.
   *
   * Optional because nothing validates it, and the reader defaults it to 0.
   * Declared required, the default read as dead code and the type read as a
   * promise the parser does not keep.
   */
  readonly restorable?: number;
}

/**
 * One version as the server hands it over.
 *
 * `uid`, `path` and `chunks` are the three the parsers check, because they are
 * the three a reader cannot do without. The rest carries no check here and
 * needs none: every field below except `uid`, `mac` and `device` is covered by
 * the entry's authenticator, so a server that alters one produces an entry no
 * device will accept. `uid` is the server's to assign, `mac` is what is being
 * checked, and `device` is a label shown to a person and acted on by nothing.
 */
export interface WireEntry {
  readonly uid: number;
  readonly path: string;
  /** The writer's authenticator over this entry. Anything that does not verify is refused. */
  readonly mac: string;
  /**
   * The version this entry was written on top of, as `parentOf` names it.
   *
   * Optional for the same reason `restorable` is: nothing validates it, and a
   * missing one is read as "" by everything that uses it, which is what an
   * entry with no parent carries anyway.
   */
  readonly parent?: string;
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
  /** The oldest protocol the server still answers. */
  readonly minProto: number;
  /** The server's release, for an error that names both ends. */
  readonly serverVersion: string;
  /** The newest uid the server holds. */
  readonly cursor: number;
  readonly perFileMax: number;
  readonly chunkMax: number;
  readonly maxChunks: number;
  /** The largest encoded `putmany` frame, and the largest summed entry budget in one. */
  readonly maxBatchBytes: number;
  /** The most body bytes one `fetch` may ask for, as summed entry budget. */
  readonly maxFetchBytes: number;
  /**
   * The vault's data key, wrapped under a key derived from the root secret.
   *
   * Every vault has one, so this is not optional: see `readReady` for what an
   * absent one would mean. docs/protocol.md, "The data key".
   *
   * A protocol 4 device does not use it. It was handed the data key itself
   * when it was registered, by the session holding the root that could unwrap
   * this, and it has held it ever since. What the field is still good for is
   * the check in `readReady`: a vault with a hash and no data key is one an
   * older build wrote, and nothing here can read it.
   */
  readonly wrapped: string;
}

/**
 * What the server advertises in reply to a hello that offered the vault's own
 * credential rather than a device's.
 *
 * Four fields, and deliberately not `ServerLimits`. A registrar may register a
 * device and rotate the vault's secret; it gets no cursor, no ceilings and no
 * catch-up, because it may not put anything and nothing will be sent to it.
 * Giving it the same type would be a promise of a backlog nobody would send.
 */
export interface RegistrarLimits {
  readonly proto: number;
  readonly minProto: number;
  readonly serverVersion: string;
  /** The most devices this vault may have registered at once. */
  readonly maxDevices: number;
}

/**
 * One outstanding invite, as the server hands it over.
 *
 * The identifier and the expiry, and deliberately nothing else. Redeeming an
 * invite also takes the invite key, which never reached the server and lives
 * only in the string somebody is holding, so a reader of this list cannot
 * redeem one. What the identifier is for is saying which invite to cancel.
 */
export interface InviteRow {
  readonly id: string;
  /** When it stops working, in server milliseconds. */
  readonly expiresAt: number;
}

/** One device's row in the vault's list, as the server hands it over. */
export interface DeviceRow {
  /** The identity: chosen by that device, unique in the vault, never the name. */
  readonly id: string;
  /** A label a person reads. Two devices may share one. */
  readonly name: string;
  readonly createdAt: number;
  /** Zero until that device has connected once. */
  readonly lastSeen: number;
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

/** One version in a batched write. */
export interface BatchEntry {
  readonly path: string;
  readonly meta: PutMeta;
  readonly names: readonly string[];
  readonly mac: string;
  readonly parent: string;
}

/** What became of one entry in a batch. */
export interface BatchResult {
  /** The uid the server gave it, or zero if this entry alone was refused. */
  readonly uid: number;
  /** Why it was refused. The other entries in the batch still committed. */
  readonly error?: ProtocolError;
}

/**
 * The most entries one batch may hold. The server refuses more; this matches
 * wire.MaxBatchEntries so a client splits rather than being told to.
 */
export const MAX_BATCH_ENTRIES = 256;

/** The meta a put sends. Written once, because two copies drift. */
function wireMeta(meta: PutMeta): Record<string, unknown> {
  return {
    size: meta.size,
    ctime: meta.ctime,
    mtime: meta.mtime,
    folder: meta.folder ?? false,
    deleted: meta.deleted ?? false,
    ...(meta.prev ? { prev: meta.prev } : {}),
  };
}

/** One entry as it travels inside a `putmany`. */
function wireEntry(e: BatchEntry): Record<string, unknown> {
  return {
    path: e.path,
    meta: wireMeta(e.meta),
    chunks: [...e.names],
    mac: e.mac,
    parent: e.parent,
  };
}

/**
 * How many bytes one entry adds to an encoded `putmany` frame.
 *
 * Measured by encoding it, because an estimate is the kind of thing that is
 * right until a path is long. Every field is ASCII on the wire (sealed paths
 * are base64url, chunk names hex), so the string length is the byte length.
 * The one byte is the comma between entries.
 */
export function encodedEntryBytes(e: BatchEntry): number {
  return JSON.stringify(wireEntry(e)).length + 1;
}

/**
 * What an encoded `putmany` costs before any entry is in it: the op, the id
 * at its widest, and the brackets. Generous rather than exact, because the
 * client has to stay under a cap it cannot measure until the frame exists.
 */
export const PUTMANY_FRAME_OVERHEAD = 64;

/**
 * Codes after which the session is over, whatever else is true.
 *
 * The "session" column of the error table in docs/protocol.md. A caller that
 * carried on after one of these would be talking to a connection the server
 * has closed, or one where the two ends no longer agree how many frames are
 * outstanding. `internal` is in the list because the doc ends the session on
 * it during handshake and catch-up, and a client cannot always tell which
 * phase a reply belongs to; the cost of closing on the other kind is a
 * reconnect, not a note.
 */
const ENDS_SESSION = new Set([
  "proto",
  "auth",
  "cursor",
  "busy",
  "protostate",
  "nospace",
  "internal",
  // A rotate refused because another device rotated first. The credential this
  // session is holding is not the vault's any more, so there is nothing else
  // it could usefully do.
  "rotated",
]);

/**
 * Whether reconnecting later can succeed, by code alone.
 *
 * The "retryable" column of the error table, as a default for a frame that
 * arrives without the field. That is not an older protocol, of which there is
 * none: it is an error the server sends before it has parsed the hello, when
 * it knows nothing about who is asking, such as a refusal at admission during
 * shutdown or at the pre-auth cap. The server sets the field on those too, so
 * in practice this is never consulted, and it stays because a client that
 * guessed "retry" at a `proto` mismatch would loop for ever and one that
 * guessed "stop" at a `busy` would stop on every server restart.
 */
function retryableByCode(code: string): boolean {
  return code === "busy" || code === "nospace" || code === "internal";
}

/**
 * A refusal from the server, carrying the code it sent.
 *
 * `code` is what a client acts on and `message` is what a person reads;
 * docs/protocol.md requires both, because an error a device cannot act on and a
 * person cannot read is how a silent failure starts.
 */
export class ProtocolError extends Error {
  /**
   * Whether reconnecting later can succeed where retrying the same request
   * cannot. The server says so on every error, and a watching client has
   * nothing to interpret: back off and reconnect on true, stop on false. Read
   * from the frame, and from the code table only as a default for a frame
   * that somehow carries no such field.
   */
  readonly retryable: boolean;
  /** How long the server suggests waiting before reconnecting, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly code: string,
    message: string,
    opts: { retryable?: boolean | undefined; retryAfterMs?: number | undefined } = {},
  ) {
    super(message);
    this.name = "ProtocolError";
    this.retryable = opts.retryable ?? retryableByCode(code);
    this.retryAfterMs = opts.retryAfterMs;
  }

  /**
   * Whether trying again could never help.
   *
   * The complement of `retryable`, kept under the name the loops read it by:
   * a caller that retried a `proto` mismatch would loop forever, and one that
   * stopped on a `busy` would stop on every server restart.
   */
  get fatal(): boolean {
    return !this.retryable;
  }

  /** Whether this refusal ends the session, as the protocol's table says. */
  get endsSession(): boolean {
    return ENDS_SESSION.has(this.code);
  }
}

/** Builds the error a frame describes, reading every field it carries. */
function errorFrom(frame: Reply): ProtocolError {
  const retryable = frame["retryable"];
  const after = frame["retryAfterMs"];
  return new ProtocolError(
    String(frame["code"] ?? "unknown"),
    String(frame["msg"] ?? "no message"),
    {
      retryable: typeof retryable === "boolean" ? retryable : undefined,
      retryAfterMs: typeof after === "number" && after > 0 ? after : undefined,
    },
  );
}

/**
 * The one thing a failed `wss://` connection is most often missing.
 *
 * A bare host in a pairing string becomes `wss://`, which is right for the
 * tunnel or the tailnet this is meant to be reached through: a server with TLS
 * in front of it. A server without TLS in front of it answers nothing at all,
 * and the failure looks exactly like a wrong address or a machine that is off.
 *
 * Cost an hour the first time it was hit, against a server on localhost. The
 * address is in the message already; this adds the one word that turns it into
 * something to try.
 */
function plainTextHint(url: string): string {
  if (!url.startsWith("wss://")) return "";
  return `. If that server has no TLS in front of it, pair with ws://${url.slice("wss://".length)} instead`;
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
   * the first kind. `retryable` on the error says whether trying again could
   * ever help.
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
  /**
   * Bytes handed to `send` and not yet on the wire, where the platform says.
   *
   * Browsers and Node's WebSocket both do. A socket that does not is sent to
   * without pacing, which is what every socket was before this existed.
   */
  readonly bufferedAmount?: number;
}

type Reply = Record<string, unknown>;

/**
 * A request waiting for its reply, by id.
 *
 * Each carries its own inactivity clock. An inactivity timer rather than a
 * deadline: a fetch is answered in bodies, and a large file over a slow link
 * delivers them steadily for longer than any sensible timeout. A timer
 * measuring the whole fetch killed it however well it was going, and the
 * client reconnected into the same download for ever. What a timeout is for
 * is a server that has stopped talking, so everything the server sends for a
 * request starts its clock again.
 */
interface Pending {
  readonly what: string;
  resolve: (value: Reply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the clock is running. A put's is stopped while its bodies go out. */
  armed: boolean;
}

export class Transport {
  private socket: SocketLike | undefined;

  /** Requests in flight, by the id they were sent with. */
  private readonly pending = new Map<number, Pending>();
  /**
   * The id the next request gets. Ids are 1 to 2^32-1 and wrap, which at one
   * request a millisecond is a hundred and forty years per connection; a wrap
   * onto an id still in flight is refused rather than reused.
   */
  private nextId = 1;
  /**
   * The ping waiting for its pong. Pings carry no id in either direction and
   * pongs are matched by being the only thing a pong could answer, so at most
   * one is in flight.
   */
  private pinging: Pending | undefined;

  /**
   * The fetch collecting bodies, if one is. The `bodies` header says exactly
   * how many binary frames follow and this is what reads them; a body with no
   * fetch collecting is a body nobody asked for.
   *
   * `waiter` is the reader of that same fetch, waiting on a body that has not
   * arrived. It used to be a field of its own, which described one in-progress
   * fetch in two places; there is only ever one fetch, so there is only ever
   * one waiter, and the two can no more disagree now than they were allowed to
   * before.
   */
  private collecting:
    { pending: Pending; want: number; got: Uint8Array[]; waiter?: () => void } | undefined;

  /**
   * How many requests this connection has sent.
   *
   * Latency multiplies round trips the way bandwidth multiplies bytes, so
   * this is the number that says how a design behaves on a slow wire. Kept
   * here rather than measured outside because only this class knows what a
   * request is: a fetch is one, however many bodies come back.
   */
  requestsSent = 0;
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
  /** What the server said at hello, for the bounds this side keeps to. */
  private limits: ServerLimits | undefined;

  constructor(
    private readonly url: string,
    private readonly opts: TransportOptions,
  ) {}

  private log(message: string, ...rest: unknown[]): void {
    this.opts.log?.(message, ...rest);
  }

  /** The cursor this client has applied up to. */
  get appliedCursor(): number {
    return this.cursor;
  }

  /** What the server advertised at hello, or undefined before it. */
  get serverLimits(): ServerLimits | undefined {
    return this.limits;
  }

  /**
   * Opens the socket, within the timeout.
   *
   * The open used to have no deadline at all (C31). A server that accepts the
   * TCP connection and never completes the handshake, or a firewall that
   * swallows the SYN, left `connect` hanging for as long as the platform
   * cared to wait, and the CLI held the vault's lock for the whole of it.
   */
  async connect(): Promise<void> {
    if (this.socket) throw new Error("already connected");
    const factory = this.opts.socketFactory ?? defaultSocketFactory;
    const socket = factory(this.url);
    // Bodies as bytes. Browsers default to Blob, which would mean an await
    // per frame and a different code path from Node.
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    const timeoutMs = this.timeoutMs;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ConnectionError(`no connection to ${this.url} within ${timeoutMs}ms`));
        try {
          socket.close();
        } catch {
          // Never opened, so there is nothing to close.
        }
      }, timeoutMs);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      socket.onopen = () => done(resolve);
      socket.onerror = () =>
        done(() =>
          reject(new ConnectionError(`could not connect to ${this.url}${plainTextHint(this.url)}`)),
        );
      socket.onclose = (ev) =>
        done(() =>
          reject(new ConnectionError(`connection closed before opening: ${describeClose(ev)}`)),
        );
    });

    socket.onerror = () => this.die(new ConnectionError("the connection failed"));
    socket.onclose = (ev) =>
      this.die(new ConnectionError(`the connection closed: ${describeClose(ev)}`));
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
    const waiting = [...this.pending.values()];
    this.pending.clear();
    const ping = this.pinging;
    this.pinging = undefined;
    const body = this.collecting?.waiter;
    this.collecting = undefined;
    for (const p of waiting) {
      this.disarm(p);
      p.reject(cause);
    }
    if (ping) {
      this.disarm(ping);
      ping.reject(cause);
    }
    // A body reader is woken with nothing, and finds the transport closed.
    body?.();
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

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Starts, or restarts, the clock on one request's answer. */
  private arm(p: Pending): void {
    if (p.timer !== undefined) clearTimeout(p.timer);
    p.armed = true;
    const timeoutMs = this.timeoutMs;
    p.timer = setTimeout(() => {
      this.die(new ConnectionError(`no ${p.what} within ${timeoutMs}ms`));
    }, timeoutMs);
  }

  private disarm(p: Pending): void {
    if (p.timer !== undefined) clearTimeout(p.timer);
    p.timer = undefined;
    p.armed = false;
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
        this.die(
          new ProtocolError(
            "protostate",
            `server sent a frame that is not JSON: ${data.slice(0, 120)}`,
          ),
        );
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
    const fetch = this.collecting;
    if (!fetch || fetch.got.length >= fetch.want) {
      // A body nobody asked for. The `bodies` header said how many were
      // coming and this is one more, or there was no header at all; either
      // way the two ends no longer agree about what is being answered, and
      // a queue not bounded by that would be a way for a peer to exhaust
      // this device's memory.
      this.die(
        new ProtocolError(
          "protostate",
          `server sent a ${bytes.length} byte body with nothing outstanding to receive it`,
        ),
      );
      return;
    }
    // Progress on the fetch, so its clock restarts.
    this.arm(fetch.pending);
    fetch.got.push(bytes);
    const waiter = fetch.waiter;
    if (waiter) {
      delete fetch.waiter;
      waiter();
    }
  }

  private onTextFrame(frame: Reply): void {
    // Notifications first, and by name. Everything else is the answer to a
    // request, matched by id; see the note at the top about why a client that
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
              `server says caught up at ${cursor}, this device reached ${this.cursor}`,
            ),
          );
          return;
        }
        this.opts.onCaughtUp?.(cursor);
      });
      return;
    }

    const id = frame["id"];
    if (id !== undefined) {
      if (typeof id !== "number" || !Number.isInteger(id)) {
        this.die(
          new ProtocolError("protostate", `server sent a reply whose id is ${JSON.stringify(id)}`),
        );
        return;
      }
      const waiting = this.pending.get(id);
      if (!waiting) {
        // The server never sends an id it was not given, so this is an
        // answer to a request this client does not have in flight: one it
        // already answered, or one it never sent. Either way the two ends
        // disagree about state, and the protocol says to end the session.
        this.die(
          new ProtocolError(
            "protostate",
            `server sent a reply to request ${id}, which is not in flight: ${JSON.stringify(frame)}`,
          ),
        );
        return;
      }
      this.pending.delete(id);
      this.disarm(waiting);
      waiting.resolve(frame);
      return;
    }

    if (frame["res"] === "pong") {
      const ping = this.pinging;
      if (!ping) {
        this.die(new ProtocolError("protostate", "server sent a pong with no ping in flight"));
        return;
      }
      this.pinging = undefined;
      this.disarm(ping);
      ping.resolve(frame);
      return;
    }

    if (frame["res"] === "err") {
      // An error nobody asked for is the server saying why it is about to
      // hang up, and the protocol says so: on shutdown every idle session is
      // sent `busy` and then closed, and a rotation sends every other
      // device `auth`. Read as a stray reply this was a protocol violation,
      // so a server restarting put every plugin into "stopped" when what it
      // meant was "not now" (C26). Whether a loop retries is the error's
      // own `retryable`, which the server set.
      this.die(errorFrom(frame));
      return;
    }
    // Nothing asked for this. Either the server sent an unsolicited reply
    // or this client lost track, and both mean the two ends disagree about
    // state.
    this.die(
      new ProtocolError("protostate", `server sent an unexpected reply: ${JSON.stringify(frame)}`),
    );
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
    // Required to be present, though it may be empty. An absent or null
    // `entries` used to be read as an empty batch, so a frame that lost the
    // field advanced the cursor over real versions and this device never
    // fetched them: a note missing for ever, on a client reporting success.
    // Empty stays legal, because that is how a device gets its own writes
    // back without the payload.
    const raw = frame["entries"];
    if (!Array.isArray(raw)) {
      throw new ProtocolError(
        "protostate",
        `batch ${from} to ${to} carries no entries array, so an empty batch cannot be told from a lost one`,
      );
    }
    const entries = raw as WireEntry[];

    // The continuity check the batch shape exists for. From and to are a
    // covered range, not the uids present, so a purged hole in the sequence
    // is not a gap; anything else is.
    if (from !== this.cursor + 1) {
      throw new ProtocolError(
        "protostate",
        `batch covers ${from} to ${to} but this device has applied up to ${this.cursor}, so something was skipped`,
      );
    }
    if (to < from) {
      throw new ProtocolError("protostate", `batch covers an empty range, ${from} to ${to}`);
    }
    for (const e of entries) {
      // Checked to be a number before it is compared. An entry with no
      // uid at all made both comparisons false and sailed through, which
      // is the range check passing by not being performed.
      if (typeof e?.uid !== "number" || !Number.isFinite(e.uid)) {
        throw new ProtocolError("protostate", `batch ${from}..${to} contains an entry with no uid`);
      }
      if (typeof e.path !== "string" || e.path === "") {
        throw new ProtocolError(
          "protostate",
          `batch ${from}..${to} contains uid ${e.uid} with no path`,
        );
      }
      if (!Array.isArray(e.chunks)) {
        throw new ProtocolError(
          "protostate",
          `batch ${from}..${to} contains uid ${e.uid} with no chunks array`,
        );
      }
      // Each name's shape, which history, deleted and get all check and this
      // did not. A name that is not a name is fetched as one, and the reply
      // to that is refused much later and by something with less to say
      // about where it came from.
      for (const name of e.chunks as unknown[]) {
        if (!isChunkName(name)) {
          throw new ProtocolError(
            "protostate",
            `batch ${from}..${to} contains uid ${e.uid} naming ${JSON.stringify(name)}, ` +
              `which is not a chunk name`,
          );
        }
      }
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

  /** A text frame or a body, over a socket that is still there. */
  private send(data: string | Uint8Array): void {
    if (this.closed || !this.socket) {
      throw this.closeReason ?? new ConnectionError("not connected");
    }
    this.socket.send(data);
  }

  /** A fresh request id, never one still in flight. */
  private takeId(): number {
    for (let tries = 0; tries < 8; tries++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
      if (!this.pending.has(id)) return id;
    }
    throw new Error("every request id is in flight, which cannot happen");
  }

  /**
   * Sends a request under a fresh id and waits for the reply that echoes it.
   *
   * A timeout closes the connection rather than only rejecting. The request
   * may have been received and acted on, so the session's state is unknown,
   * and the only safe next step is to start again.
   *
   * `clock` says whether the reply is expected straight away. A put's reply
   * follows its bodies, and the sending phase has its own measure of progress
   * (`drained`), so the clock on the reply starts once every body is with the
   * socket, from `awaitReply`.
   */
  private begin(value: Record<string, unknown>, what: string, clock = true): Promise<Reply> {
    const id = this.takeId();
    const text = JSON.stringify({ ...value, id });
    this.requestsSent++;
    const reply = new Promise<Reply>((resolve, reject) => {
      if (this.closed) {
        reject(this.closeReason ?? new ConnectionError("not connected"));
        return;
      }
      const p: Pending = { what, resolve, reject, timer: undefined, armed: false };
      this.pending.set(id, p);
      if (clock) this.arm(p);
      try {
        this.send(text);
      } catch (err) {
        this.pending.delete(id);
        this.disarm(p);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    // Nobody may await this until later, and a connection that dies before
    // then rejects it now. The caller sees that failure through its own
    // send; this only keeps the rejection from being reported as one nobody
    // handled. `awaitReply` still sees it.
    reply.catch(() => {});
    return reply;
  }

  /**
   * Waits for a reply and raises a refusal as an error.
   *
   * A refusal that ends the session closes the transport as well, so nothing
   * else is sent down a connection the server is about to close.
   */
  private async awaitReply(reply: Promise<Reply>): Promise<Reply> {
    const frame = await reply;
    if (frame["res"] === "err") {
      const err = errorFrom(frame);
      if (err.endsSession) this.die(err);
      throw err;
    }
    return frame;
  }

  /** One round trip: send, wait, and refuse a refusal. */
  private async request(value: Record<string, unknown>, what: string): Promise<Reply> {
    return this.awaitReply(this.begin(value, what));
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
  async hello(args: {
    vault: string;
    /** This device's row in the vault's device list. */
    deviceId: string;
    /** This device's own auth key, derived from its own secret. */
    token: string;
    device: string;
    cursor: number;
  }): Promise<ServerLimits> {
    checkName("vault", args.vault);
    checkName("device", args.device);
    this.cursor = args.cursor;
    let reply: Reply;
    try {
      reply = await this.request(
        {
          op: "hello",
          proto: PROTO,
          crypto: CRYPTO_SUITE,
          vault: args.vault,
          deviceId: args.deviceId,
          token: args.token,
          device: args.device,
          cursor: args.cursor,
        },
        "ready",
      );
    } catch (err) {
      throw protoRefusal(err);
    }
    return this.readReady(reply);
  }

  /**
   * Opens a registrar session: a hello offering the vault's own credential,
   * with no `deviceId`.
   *
   * What comes back may register a device and rotate the vault's secret, and
   * may do nothing else. It is given no `ready`, no cursor and no place in the
   * vault's fan-out, so there is deliberately no `ServerLimits` here: a caller
   * that was handed ceilings and a cursor would be holding the promise of a
   * catch-up nobody is going to send.
   *
   * `claim` binds an unclaimed vault to this key and data key. It is sent only
   * while this device still holds the server's first-run token, and the same
   * pair every time, so a claim retried after a lost reply offers the key it
   * offered before rather than a second candidate.
   */
  async helloAsRegistrar(args: {
    vault: string;
    token: string;
    device: string;
    claim?: { auth: string; wrapped: string };
  }): Promise<RegistrarLimits> {
    checkName("vault", args.vault);
    checkName("device", args.device);
    let reply: Reply;
    try {
      reply = await this.request(
        {
          op: "hello",
          proto: PROTO,
          crypto: CRYPTO_SUITE,
          vault: args.vault,
          token: args.token,
          device: args.device,
          cursor: 0,
          ...(args.claim !== undefined
            ? { claim: args.claim.auth, wrapped: args.claim.wrapped }
            : {}),
        },
        "registrar",
      );
    } catch (err) {
      throw protoRefusal(err);
    }
    if (reply["res"] !== "registrar") {
      throw new ProtocolError("protostate", `expected registrar, got ${JSON.stringify(reply)}`);
    }
    const version = reply["serverVersion"];
    const limits: RegistrarLimits = {
      proto: this.count(reply, "proto", "registrar"),
      minProto: this.count(reply, "minProto", "registrar"),
      serverVersion: typeof version === "string" ? version : "unknown",
      maxDevices: this.count(reply, "maxDevices", "registrar"),
    };
    if (limits.proto !== PROTO) {
      const err = new ProtocolError(
        "proto",
        `server (version ${limits.serverVersion}) answered in protocol ${limits.proto}, ` +
          `this client speaks ${PROTO}; upgrade the server first`,
      );
      this.die(err);
      throw err;
    }
    this.log("registrar", limits);
    return limits;
  }

  /**
   * Redeems a single-use invite, which is how this device is registered.
   *
   * The hello carries the invite in place of a credential and, beside it, the
   * device row it is asking for: an id of its own and the auth key it will
   * connect with. Both halves are one server transaction, so a redemption is
   * either an invite spent and a row written or neither of the two, and a
   * refusal leaves the string in somebody's hand still working.
   *
   * It has to be one exchange. Under protocol 4 the device that issued the
   * invite holds no root, so it cannot register a row for the newcomer, and
   * the newcomer holds nothing the server would accept a registration under.
   * The invite is the only authority either of them has, and it is a good one:
   * unguessable, single use and expiring.
   *
   * What comes back is the vault's data key sealed under the invite key, which
   * never reached the server, and the id of the row that was written. The
   * server closes the session after it: this connection has proved that
   * somebody held an invite and not that anybody holds the key just
   * registered. The caller writes both down and connects again as a device,
   * and that hello is the proof. docs/protocol.md, "Adding a device with a
   * single-use invite".
   */
  async redeem(args: {
    vault: string;
    device: string;
    invite: string;
    /** The row this device is asking the invite to register. */
    deviceId: string;
    /** The auth key that row will be recognised by, derived from a fresh device secret. */
    auth: string;
    /** The label for the row. Defaults, at the server, to `device`. */
    name?: string;
  }): Promise<{ sealed: string; deviceId: string }> {
    checkName("vault", args.vault);
    checkName("device", args.device);
    let reply: Reply;
    try {
      reply = await this.request(
        {
          op: "hello",
          proto: PROTO,
          crypto: CRYPTO_SUITE,
          vault: args.vault,
          device: args.device,
          cursor: 0,
          invite: args.invite,
          deviceId: args.deviceId,
          auth: args.auth,
          ...(args.name !== undefined ? { name: args.name } : {}),
        },
        "redeemed",
      );
    } catch (err) {
      throw protoRefusal(err);
    }
    if (reply["res"] !== "redeemed") {
      throw new ProtocolError("protostate", `expected redeemed, got ${JSON.stringify(reply)}`);
    }
    const sealed = reply["sealed"];
    if (typeof sealed !== "string" || sealed === "") {
      throw this.malformed("redeemed with no sealed data key");
    }
    if (reply["deviceId"] !== args.deviceId) {
      // The reply names the row that was written. A different id means this
      // device is about to store a credential for a row that is not its own,
      // and it would be refused at every hello from then on with nothing to
      // say why. The same check `register` makes, for the same reason.
      throw this.malformed(
        `a redeemed naming device ${JSON.stringify(reply["deviceId"])}, which is not the ${JSON.stringify(args.deviceId)} that was redeemed for`,
      );
    }
    return { sealed, deviceId: args.deviceId };
  }

  private readReady(reply: Reply): ServerLimits {
    if (reply["res"] !== "ready") {
      throw new ProtocolError("protostate", `expected ready, got ${JSON.stringify(reply)}`);
    }
    const version = reply["serverVersion"];
    const wrapped = reply["wrapped"];
    if (typeof wrapped !== "string" || wrapped === "") {
      // C40. Every vault has a data key, so an absent one is not a second
      // kind of vault to accommodate: it is a server saying "derive your
      // content keys some other way", and the only other way was the
      // root-derived schedule. A device that took the hint would seal its
      // notes under keys no other device on the vault derives, and both ends
      // would report success while the vault quietly split in two. Refused
      // here, before a single path is sealed, and the session ends.
      throw this.malformed(
        "a ready with no wrapped data key, which no vault has; this device will not seal anything under a key the rest of the vault cannot derive",
      );
    }
    const limits: ServerLimits = {
      proto: this.count(reply, "proto", "ready"),
      minProto: this.count(reply, "minProto", "ready"),
      serverVersion: typeof version === "string" ? version : "unknown",
      cursor: this.count(reply, "cursor", "ready"),
      perFileMax: this.count(reply, "perFileMax", "ready"),
      chunkMax: this.count(reply, "chunkMax", "ready"),
      maxChunks: this.count(reply, "maxChunks", "ready"),
      maxBatchBytes: this.count(reply, "maxBatchBytes", "ready"),
      maxFetchBytes: this.count(reply, "maxFetchBytes", "ready"),
      wrapped,
    };
    if (limits.proto !== PROTO) {
      // A server answers in the version the client asked for, so a ready in
      // another version is a server that did not understand the question.
      const err = new ProtocolError(
        "proto",
        `server (version ${limits.serverVersion}) answered in protocol ${limits.proto}, ` +
          `this client speaks ${PROTO}; upgrade the server first`,
      );
      this.die(err);
      throw err;
    }
    this.limits = limits;
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
    names: readonly string[],
    /**
     * The sealed bytes of one chunk, asked for only if the server wants it.
     *
     * A callback rather than the bodies themselves, because a put used to
     * take every sealed chunk of a file at once and a 256 MiB attachment,
     * which is the size the server advertises it will take, meant 512 MiB
     * live: the file and a sealed copy of it. Measured, not guessed. On a
     * phone that is not a spike, it is the end of the process.
     *
     * The caller decides what that costs it. A small file keeps its bodies
     * and this is a map lookup; a large one keeps offsets and seals the
     * chunk again, which is deterministic and so gives the same bytes.
     */
    bodyOf: (name: string) => Promise<Uint8Array>,
    /**
     * The authenticator and parent this entry travels with.
     *
     * Required, with no default. It had one, an empty mac and an empty
     * parent, so that transport tests need not build a real entry; what a
     * default also does is let a caller that forgot send an unsigned put,
     * which every device on the vault would then refuse to act on and
     * nothing here would have said so.
     */
    auth: { mac: string; parent: string },
  ): Promise<{ uid: number; uploaded: number; bytes: number }> {
    const reply = await this.request(
      {
        op: "put",
        path,
        meta: wireMeta(meta),
        chunks: [...names],
        mac: auth.mac,
        parent: auth.parent,
      },
      "want or have",
    );

    if (reply["res"] === "have") {
      return { uid: this.uid(reply, "have"), uploaded: 0, bytes: 0 };
    }
    if (reply["res"] !== "want") {
      throw new ProtocolError("protostate", `expected want or have, got ${JSON.stringify(reply)}`);
    }

    const offered = new Set(names);
    const wanted = this.wanted(reply, offered);

    // The ack answers the same id as the put, so the waiter for it is the
    // one taken out again here, before any body goes out: a loopback server
    // acks from inside the last send (C11), and a waiter installed after
    // the bodies found the answer already there.
    const id = idOf(reply);
    const ack = this.expectMore(id, "acknowledgement");
    const bytes = await this.sendBodies(wanted, offered, bodyOf, "put");
    const acked = await this.awaitPhase(ack, id);
    if (acked["res"] !== "ack") {
      throw new ProtocolError("protostate", `expected ack, got ${JSON.stringify(acked)}`);
    }
    return { uid: this.uid(acked, "ack"), uploaded: wanted.length, bytes };
  }

  /**
   * Writes many versions in one exchange, and returns one result per entry in
   * the order they were given.
   *
   * A put is one round trip in the good case and two when bodies have to go,
   * which on a loopback socket is nothing and on a link with four hundred
   * milliseconds in it is the whole cost of a sync. Two hundred notes were two
   * hundred conversations. This is one: every entry's chunk names go up
   * together, the server answers with the union of what it lacks, and the
   * bodies follow in that order.
   *
   * An entry the server refuses does not refuse the batch. Its result carries
   * the error and the others carry their uids, because a batch that fails as a
   * unit leaves a client bisecting it to find out which note it was.
   *
   * The caller splits by the caps `ready` advertised (the engine does); this
   * checks the count, which is the one bound that predates the caps, and the
   * frame size, as a tripwire for a caller that did not.
   */
  async putMany(
    entries: readonly BatchEntry[],
    bodyOf: (name: string) => Promise<Uint8Array>,
  ): Promise<{ results: BatchResult[]; uploaded: number; bytes: number }> {
    if (entries.length === 0) return { results: [], uploaded: 0, bytes: 0 };
    if (entries.length > MAX_BATCH_ENTRIES) {
      throw new ProtocolError(
        "toolarge",
        `${entries.length} entries in one batch, the limit is ${MAX_BATCH_ENTRIES}`,
      );
    }
    const frame = { op: "putmany", entries: entries.map(wireEntry) };
    const cap = this.limits?.maxBatchBytes;
    if (cap !== undefined && cap > 0) {
      // A plain error, not a refusal: the server would answer `toolarge`
      // and the engine would write every note in the batch off for good,
      // when what happened is that the caller did not split. Raised as a
      // fault of this program, it is retried like a dropped connection.
      const encoded = JSON.stringify(frame).length + 24;
      if (encoded > cap) {
        throw new Error(
          `a putmany of ${entries.length} entries encodes to ${encoded} bytes, over the server's ${cap}; it should have been split`,
        );
      }
    }

    const reply = await this.request(frame, "want or acks");

    let acks = reply;
    let uploaded = 0;
    let bytes = 0;

    if (reply["res"] === "want") {
      const offered = new Set<string>();
      for (const e of entries) for (const name of e.names) offered.add(name);
      const wanted = this.wanted(reply, offered);

      const id = idOf(reply);
      const pending = this.expectMore(id, "acknowledgement");
      bytes = await this.sendBodies(wanted, offered, bodyOf, "batch");
      uploaded = wanted.length;
      acks = await this.awaitPhase(pending, id);
    }

    if (acks["res"] !== "acks") {
      throw new ProtocolError("protostate", `expected acks, got ${JSON.stringify(acks)}`);
    }

    // Results are matched to entries by position and nothing else, so a
    // count that does not line up is not something to paper over: the uid
    // that would be recorded against a note would be another note's.
    const raw = acks["results"];
    if (!Array.isArray(raw) || raw.length !== entries.length) {
      throw new ProtocolError(
        "protostate",
        `${entries.length} entries went up and ${Array.isArray(raw) ? raw.length : "no"} results came back`,
      );
    }

    const results = raw.map((r, i): BatchResult => {
      if (typeof r !== "object" || r === null) {
        throw this.malformed(`acks[${i}] is not an object`);
      }
      const row = r as Record<string, unknown>;
      if (row["code"] !== undefined) {
        if (typeof row["code"] !== "string")
          throw this.malformed(`acks[${i}].code is not a string`);
        return { uid: 0, error: errorFrom(row) };
      }
      return { uid: this.uid(row, `acks[${i}]`) };
    });

    // A per-entry refusal is survivable; one that ends the session is not,
    // and the session has to end for the same reason it would on a single put.
    for (const r of results) {
      if (r.error?.endsSession) this.die(r.error);
    }

    return { results, uploaded, bytes };
  }

  /**
   * Sends the bodies the server asked for, paced against the socket's buffer.
   *
   * Every name is checked against what was offered before anything goes out,
   * because sending a body the put never named is caught by the server as a
   * protocol failure and ends the session.
   */
  private async sendBodies(
    wanted: readonly string[],
    offered: ReadonlySet<string>,
    bodyOf: (name: string) => Promise<Uint8Array>,
    what: string,
  ): Promise<number> {
    let bytes = 0;
    for (const name of wanted) {
      if (!offered.has(name)) {
        // Already checked when the reply was read; kept because this is
        // the line that sends bytes, and it should not trust a list.
        throw new ProtocolError(
          "badchunk",
          `server asked for ${name}, which this ${what} does not contain`,
        );
      }
      const body = await bodyOf(name);
      this.send(body);
      bytes += body.length;
      await this.drained(UPLOAD_HIGH_WATER);
    }
    // Every body is with the socket before the clock on the ack starts. The
    // ack follows the last body, so a timer armed while bodies were still
    // queued measured the upload rather than the server.
    await this.drained(0);
    return bytes;
  }

  /**
   * Waits until the socket has handed its queued bytes on, down to `below`.
   *
   * Bodies used to be pushed into the socket as fast as they could be sealed,
   * and the timer for the ack was armed for the whole drain. A file larger
   * than the link could carry inside one timeout could therefore never be
   * sent: the ack was always late, the connection was closed, and the client
   * reconnected to try the same file again. Pacing the sends against the
   * socket's own buffer keeps memory bounded, and measuring progress rather
   * than the total is what lets a slow link finish.
   *
   * A stall, meaning the buffer has not shrunk in a whole timeout, is the
   * connection being dead, and is treated as one.
   */
  private async drained(below: number): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.bufferedAmount === undefined) return;
    let last = socket.bufferedAmount;
    let movedAt = Date.now();
    while (socket.bufferedAmount > below) {
      if (this.closed) throw this.closeReason ?? new ConnectionError("not connected");
      await sleep(DRAIN_POLL_MS);
      const now = socket.bufferedAmount;
      if (now < last) {
        last = now;
        movedAt = Date.now();
      } else if (Date.now() - movedAt > this.timeoutMs) {
        this.die(
          new ConnectionError(`upload stalled: ${now} bytes unsent for ${this.timeoutMs}ms`),
        );
        throw this.closeReason ?? new ConnectionError("not connected");
      }
    }
  }

  /**
   * Re-opens a request's slot for the second reply it will get, with no clock.
   *
   * A put is answered twice under one id: `want`, then `ack` after the bodies.
   * The slot is taken again *before* the bodies go out, because a loopback
   * server acks inside the same tick as the last send (C11), and a waiter
   * installed afterwards found the answer already there. No timer, because
   * the sending phase has its own: `drained` watches the socket for progress,
   * which is the honest measure of an upload. The clock on the reply itself
   * starts in `awaitPhase`, once every body is with the socket.
   */
  private expectMore(id: number, what: string): Promise<Reply> {
    if (this.pending.has(id)) throw new Error(`request ${id} is already waiting for a reply`);
    const pending = new Promise<Reply>((resolve, reject) => {
      if (this.closed) {
        reject(this.closeReason ?? new ConnectionError("not connected"));
        return;
      }
      this.pending.set(id, { what, resolve, reject, timer: undefined, armed: false });
    });
    pending.catch(() => {});
    return pending;
  }

  /** Waits for a reply `expectMore` was told to expect, from now with a clock. */
  private async awaitPhase(pending: Promise<Reply>, id: number): Promise<Reply> {
    const p = this.pending.get(id);
    // Still waiting: the clock starts now that the bodies are sent.
    if (p) this.arm(p);
    return this.awaitReply(pending);
  }

  /** Asks where a version's content lives. */
  async get(uid: number): Promise<{ uid: number; size: number; chunks: string[] }> {
    const reply = await this.request({ op: "get", uid }, "chunks");
    if (reply["res"] !== "chunks") {
      throw new ProtocolError("protostate", `expected chunks, got ${JSON.stringify(reply)}`);
    }
    return {
      uid: this.uid(reply, "chunks"),
      size: this.count(reply, "size", "chunks"),
      chunks: this.chunkNames(reply["chunks"], "chunks"),
    };
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
    opts: { before?: number; limit?: number } = {},
  ): Promise<WireEntry[]> {
    const reply = await this.request(
      {
        op: "history",
        path: sealedPath,
        ...(opts.before !== undefined ? { before: opts.before } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      },
      "history",
    );
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
  async deleted(limit?: number): Promise<{ entries: WireDeletion[]; more: boolean }> {
    const reply = await this.request(
      { op: "deleted", ...(limit !== undefined ? { limit } : {}) },
      "deleted",
    );
    if (reply["res"] !== "deleted") {
      throw new ProtocolError("protostate", `expected deleted, got ${JSON.stringify(reply)}`);
    }
    // `more` says the server cut the list short. Dropping it would hand
    // somebody a short list that looks complete, and the note they are
    // looking for is exactly the one that might be missing from it.
    return {
      entries: entriesOf(reply["entries"], "deleted") as WireDeletion[],
      more: reply["more"] === true,
    };
  }

  /**
   * Downloads chunk bodies, in the order asked for.
   *
   * The answer is `{res:"bodies", count}` and then exactly `count` binary
   * frames, or an `err` and no frames; the server refuses the whole fetch if
   * it lacks any of them, so a partial answer is not a case to handle and
   * bodies from a refused fetch can no longer be taken as the answer to the
   * next one (C34).
   *
   * Every body is checked against the name it was asked for, here rather than
   * in the caller. Bodies arrive as bare binary frames with nothing but their
   * order tying them to a name, and the name is a hash of exactly these bytes,
   * so the check is exact and costs one digest.
   *
   * The caller keeps within `maxFetchBytes` and `MAX_FETCH_NAMES`; this
   * refuses a list over the count, which is the one bound it can see whole.
   */
  async fetch(names: readonly string[]): Promise<Uint8Array[]> {
    if (names.length === 0) return [];
    if (names.length > MAX_FETCH_NAMES) {
      throw new Error(
        `a fetch of ${names.length} chunks is over the ${MAX_FETCH_NAMES} the server takes; it should have been split`,
      );
    }
    if (this.collecting) {
      // Two fetches at once would interleave their bodies on one stream with
      // nothing but arrival order to tell them apart. The engine is
      // single-flight and never does this; the check makes that a property.
      throw new Error("a fetch is already collecting bodies");
    }
    // The collector is in place before the request goes, because the
    // server sends the first body straight after the header, in the same
    // instant on loopback, and a body arriving with nothing collecting is
    // read as one nobody asked for. The bodies get a clock of their own,
    // restarted by every frame that lands.
    const collector: Pending = {
      what: "chunk body",
      resolve: () => {},
      reject: () => {},
      timer: undefined,
      armed: false,
    };
    const got: Uint8Array[] = [];
    this.collecting = { pending: collector, want: names.length, got };
    const checks: Promise<void>[] = [];
    try {
      const started = this.begin({ op: "fetch", chunks: [...names] }, "bodies");
      const header = await this.awaitReply(started);
      if (header["res"] !== "bodies") {
        throw new ProtocolError("protostate", `expected bodies, got ${JSON.stringify(header)}`);
      }
      const count = this.count(header, "count", "bodies");
      if (count !== names.length) {
        // The server promised a different number of frames from the number
        // of names asked for. Whatever follows cannot be matched to a name.
        throw this.malformed(`bodies announcing ${count} frames for a fetch of ${names.length}`);
      }
      this.arm(collector);
      for (let i = 0; i < count; i++) {
        const next = await this.body(i);
        // Hashed alongside the next body rather than in front of it.
        //
        // The bodies arrive in order and must be read in order, but
        // verifying one has nothing to do with receiving the next, and
        // waiting for each digest made the check 90% of what a fetch
        // costs this side: 21.6 ms of a 23.9 ms fetch of 2000 bodies,
        // against 5.1 ms taken together.
        //
        // Not dropped, only moved. The session still ends on a mismatch, a
        // few bodies later than it used to, and nothing is written before
        // the check settles.
        const want = names[i]!;
        checks.push(
          chunkName(next).then((hash) => {
            if (hash !== want) {
              throw new ProtocolError(
                "badchunk",
                `asked for ${want} and received ${next.length} bytes that hash to ${hash}`,
              );
            }
          }),
        );
      }
      await Promise.all(checks);
    } catch (err) {
      if (err instanceof ProtocolError && err.code === "badchunk") this.die(err);
      throw err;
    } finally {
      this.disarm(collector);
      this.collecting = undefined;
    }
    return got;
  }

  /** Waits for the i-th body of the fetch in progress. */
  private async body(i: number): Promise<Uint8Array> {
    const fetch = this.collecting;
    if (!fetch || this.closed) throw this.closeReason ?? new ConnectionError("not connected");
    if (fetch.got.length <= i) {
      await new Promise<void>((resolve) => {
        fetch.waiter = resolve;
      });
      if (this.closed) throw this.closeReason ?? new ConnectionError("not connected");
    }
    return fetch.got[i]!;
  }

  /**
   * Registers a device row and returns the vault's wrapped data key.
   *
   * A registrar's operation, because it is the vault's credential that
   * authorises it: a device holds no root and so may not add a device.
   *
   * `auth` is the new device's auth key rather than its digest, for the same
   * reason a claim is the key: the server stores only the digest either way,
   * so the key reveals nothing the digest would have hidden, and what it buys
   * is that a credential short enough to guess can be refused.
   *
   * **Registering the same id with the same key again succeeds**, and is the
   * registration having happened: the row committed, the reply was lost, and
   * a caller told `badentry` there would retry for ever. A *different* key
   * under an id the vault already holds is somebody else's device and is
   * refused.
   * docs/protocol.md, "The device list".
   */
  async register(args: {
    deviceId: string;
    auth: string;
    name?: string;
  }): Promise<{ deviceId: string; wrapped: string }> {
    const reply = await this.request(
      {
        op: "register",
        deviceId: args.deviceId,
        auth: args.auth,
        ...(args.name !== undefined ? { name: args.name } : {}),
      },
      "registered",
    );
    if (reply["res"] !== "registered") {
      throw new ProtocolError("protostate", `expected registered, got ${JSON.stringify(reply)}`);
    }
    const deviceId = reply["deviceId"];
    const wrapped = reply["wrapped"];
    if (deviceId !== args.deviceId) {
      // The reply names the row that was written. A different id means the
      // server registered something other than what was asked for, and this
      // device is about to store a credential for a row that is not its own:
      // it would drop the root and then be refused at every hello.
      throw this.malformed(
        `a registered naming device ${JSON.stringify(deviceId)}, which is not the ${JSON.stringify(args.deviceId)} that was registered`,
      );
    }
    if (typeof wrapped !== "string" || wrapped === "") {
      // Every claimed vault has a data key, and this is how the registering
      // session hands it over. Without it there is nothing to unwrap and the
      // device would have a row it could connect with and no way to read a
      // note; see readReady for the other half of the same rule.
      throw this.malformed("a registered with no wrapped data key, which no claimed vault has");
    }
    return { deviceId, wrapped };
  }

  /**
   * Registers a single-use invite: an identifier, and the vault's data key
   * sealed under a key the server never sees. Returns when it expires, in
   * server milliseconds.
   *
   * A device's operation, and only a device's: the sealed blob is the data
   * key, which is exactly what a paired device holds and a registrar does not.
   * The server holds a blob it cannot open under a name it cannot guess, for a
   * few minutes.
   */
  async invite(args: { invite: string; sealed: string; ttlMs?: number }): Promise<number> {
    const reply = await this.request(
      {
        op: "invite",
        invite: args.invite,
        sealed: args.sealed,
        ...(args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {}),
      },
      "invited",
    );
    if (reply["res"] !== "invited") {
      throw new ProtocolError("protostate", `expected invited, got ${JSON.stringify(reply)}`);
    }
    return this.count(reply, "expiresAt", "invited");
  }

  /**
   * Cancels an outstanding invite, so the string somebody is holding stops
   * working before it expires.
   *
   * Either credential may send it, the same as `revoke`: an invite is part of
   * who may reach the vault rather than part of its content. An identifier
   * that is unknown, expired or already redeemed is one refusal, `badentry`,
   * saying which of the three to nobody.
   */
  async uninvite(invite: string): Promise<void> {
    const reply = await this.request({ op: "uninvite", invite }, "uninvited");
    if (reply["res"] !== "uninvited") {
      throw new ProtocolError("protostate", `expected uninvited, got ${JSON.stringify(reply)}`);
    }
    if (reply["invite"] !== invite) {
      throw this.malformed(
        `an uninvited naming ${JSON.stringify(reply["invite"])}, which is not the ${JSON.stringify(invite)} that was cancelled`,
      );
    }
  }

  /**
   * Every device that may reach this vault, the cap on how many there may be,
   * and every invite that could still add one.
   *
   * The invites come with the devices because they are one answer: a row is
   * what has been added and an outstanding invite is what is about to be.
   */
  async devices(): Promise<{
    devices: DeviceRow[];
    maxDevices: number;
    invites: InviteRow[];
  }> {
    const reply = await this.request({ op: "devices" }, "devices");
    if (reply["res"] !== "devices") {
      throw new ProtocolError("protostate", `expected devices, got ${JSON.stringify(reply)}`);
    }
    const list = reply["devices"];
    if (!Array.isArray(list)) {
      throw this.malformed("a devices reply with no list of devices");
    }
    // A server that answers no `invites` at all is a malformed reply, the same
    // as one with no `devices`: both are always sent, and reading a missing
    // list as "none outstanding" would show an empty invite list with as much
    // confidence as a true one. That is rule 7 in miniature.
    const invites = reply["invites"];
    if (!Array.isArray(invites)) {
      throw this.malformed("a devices reply with no list of invites");
    }
    return {
      devices: list.map((raw, i) => this.deviceRow(raw, i)),
      maxDevices: this.count(reply, "maxDevices", "devices"),
      invites: invites.map((raw, i) => this.inviteRow(raw, i)),
    };
  }

  /** One invite, read as strictly as a device row and for the same reason. */
  private inviteRow(raw: unknown, i: number): InviteRow {
    const row = raw as Record<string, unknown>;
    const id = row?.["id"];
    if (typeof id !== "string" || id === "") {
      throw this.malformed(`a devices reply whose invite ${i} has no id`);
    }
    const expiresAt = row["expiresAt"];
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) {
      // An expiry is what says whether the string is still live, so a missing
      // one cannot become zero: that reads as "expired in 1970" and would have
      // a person ignore an invite that still works.
      throw this.malformed(`a devices reply whose invite ${i} has no expiry`);
    }
    return { id, expiresAt };
  }

  /** One row, read strictly: a list somebody acts on is not a place to guess. */
  private deviceRow(raw: unknown, i: number): DeviceRow {
    const row = raw as Record<string, unknown>;
    const id = row?.["id"];
    if (typeof id !== "string" || id === "") {
      throw this.malformed(`a devices reply whose entry ${i} has no id`);
    }
    const name = row["name"];
    const num = (key: string): number => {
      const v = row[key];
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    };
    return {
      id,
      name: typeof name === "string" ? name : "",
      createdAt: num("createdAt"),
      lastSeen: num("lastSeen"),
    };
  }

  /**
   * Removes a device's row and closes every session it has open.
   *
   * The reply means both, in that order, and the ordering is the guarantee:
   * see docs/protocol.md, "The device list". `allowLast` is the caller saying
   * out loud that it means to leave the vault reachable only by the recovery
   * key; without it the last device is refused with `badentry`.
   *
   * `self` says the row removed was this session's own, in which case this is
   * the last frame on the connection.
   */
  async revoke(args: {
    deviceId: string;
    allowLast?: boolean;
  }): Promise<{ deviceId: string; self: boolean }> {
    const reply = await this.request(
      {
        op: "revoke",
        deviceId: args.deviceId,
        ...(args.allowLast ? { allowLast: true } : {}),
      },
      "revoked",
    );
    if (reply["res"] !== "revoked") {
      throw new ProtocolError("protostate", `expected revoked, got ${JSON.stringify(reply)}`);
    }
    const deviceId = reply["deviceId"];
    if (deviceId !== args.deviceId) {
      throw this.malformed(
        `a revoked naming device ${JSON.stringify(deviceId)}, which is not the ${JSON.stringify(args.deviceId)} that was revoked`,
      );
    }
    return { deviceId, self: reply["self"] === true };
  }

  /**
   * Replaces the vault's auth hash and wrapped data key together.
   *
   * `auth` is the new auth key and `wrapped` the same data key under the new
   * root. Every other session on the vault is closed by the server with
   * `auth` before this returns, so "rotated" also means nobody else is still
   * writing under the old string.
   */
  async rotate(args: { auth: string; wrapped: string }): Promise<void> {
    const reply = await this.request(
      { op: "rotate", auth: args.auth, wrapped: args.wrapped },
      "rotated",
    );
    if (reply["res"] !== "rotated") {
      throw new ProtocolError("protostate", `expected rotated, got ${JSON.stringify(reply)}`);
    }
  }

  /* ------------------------------------------------------------ *
   * Strict reading of what the server answered
   * ------------------------------------------------------------ */

  /**
   * A malformed reply ends the session.
   *
   * Success replies were read as leniently as the batch frames were read
   * strictly: a missing or non-numeric uid became zero and was committed to
   * the index as the version of a note, and a `want` with a malformed member
   * dropped it and went on. A server that answers in a shape this client does
   * not know is a server this client does not understand, and the only safe
   * thing to do about that is stop.
   */
  private malformed(what: string): ProtocolError {
    const err = new ProtocolError("protostate", `server sent ${what}`);
    this.die(err);
    return err;
  }

  /** A non-negative integer field, or the end of the session. */
  private count(reply: Reply, field: string, of: string): number {
    const v = reply[field];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      throw this.malformed(
        `${of} with ${field} = ${JSON.stringify(v)}, not a non-negative integer`,
      );
    }
    return v;
  }

  /** A version number, which is a positive integer, or the end of the session. */
  private uid(reply: Reply, of: string): number {
    const v = this.count(reply, "uid", of);
    if (v === 0) throw this.malformed(`${of} with uid 0, which no version has`);
    return v;
  }

  /** A list of chunk names, or the end of the session. */
  private chunkNames(v: unknown, of: string): string[] {
    if (!Array.isArray(v)) throw this.malformed(`${of} with no chunks list`);
    for (const name of v) {
      if (!isChunkName(name)) {
        throw this.malformed(`${of} naming ${JSON.stringify(name)}, which is not a chunk name`);
      }
    }
    return v as string[];
  }

  /**
   * What a `want` asks for: chunk names, each offered by this put, none twice.
   *
   * A name that was never offered is the server asking for bytes this put
   * does not have, which is `badchunk` and ends the session; a duplicate
   * would have the same body sent twice under one name, which the server
   * cannot mean.
   */
  private wanted(reply: Reply, offered: ReadonlySet<string>): string[] {
    const names = reply["chunks"];
    if (!Array.isArray(names)) throw this.malformed("want with no chunks list");
    const seen = new Set<string>();
    for (const name of names) {
      if (typeof name !== "string") {
        throw this.malformed(`want naming ${JSON.stringify(name)}, which is not a chunk name`);
      }
      // Offered is the test of a name here, not its shape: what was offered
      // is by construction well formed, and anything else is the server
      // asking for bytes this put does not have.
      if (!offered.has(name)) {
        const err = new ProtocolError(
          "badchunk",
          `server asked for ${name}, which this put does not contain`,
        );
        this.die(err);
        throw err;
      }
      if (seen.has(name)) throw this.malformed(`want naming ${name} twice`);
      seen.add(name);
    }
    return names as string[];
  }

  /**
   * Says something, so the connection is not idle, and hears something back.
   *
   * Pings carry no id, in either direction, so this is the one exchange still
   * matched by position: a pong answers the ping in flight, and there is at
   * most one.
   */
  async ping(): Promise<void> {
    if (this.pinging) throw new Error("a ping is already in flight");
    this.requestsSent++;
    const reply = await new Promise<Reply>((resolve, reject) => {
      if (this.closed) {
        reject(this.closeReason ?? new ConnectionError("not connected"));
        return;
      }
      const p: Pending = { what: "pong", resolve, reject, timer: undefined, armed: false };
      this.pinging = p;
      this.arm(p);
      try {
        this.send(JSON.stringify({ op: "ping" }));
      } catch (err) {
        this.pinging = undefined;
        this.disarm(p);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    if (reply["res"] !== "pong") {
      throw new ProtocolError("protostate", `expected pong, got ${JSON.stringify(reply)}`);
    }
  }
}

/**
 * Refuses a `vault` or `device` name the server would refuse, before it goes.
 *
 * Bounded in bytes, not characters, because that is how the server counts,
 * and a name of sixty-four accented letters is more than sixty-four bytes.
 */
export function checkName(what: "vault" | "device", name: string): void {
  const bytes = new TextEncoder().encode(name).length;
  if (bytes > MAX_NAME_BYTES) {
    throw new ProtocolError(
      "badname",
      `the ${what} name is ${bytes} bytes, and the server takes at most ${MAX_NAME_BYTES}`,
    );
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new ProtocolError(
        "badname",
        `the ${what} name contains a control character at position ${i}, which the server refuses because the name lands in its log`,
      );
    }
  }
}

/**
 * Names both protocol versions in a `proto` refusal, and says which end to
 * upgrade.
 *
 * A server that does not speak this client's protocol refuses the hello, and
 * the refusal arrives here as the close reason. Its message names the server's
 * range and version; this adds the client's version and the one instruction
 * that follows from the upgrade order, which is the server first. Kept against
 * the next version, not for any version that exists.
 */
function protoRefusal(err: unknown): unknown {
  if (err instanceof ProtocolError && err.code === "proto") {
    return new ProtocolError(
      "proto",
      `${err.message}. This client speaks protocol ${PROTO}; upgrade the server first`,
      { retryable: false },
    );
  }
  return err;
}

/** The id a reply came back under, which every reply reaching a caller has. */
function idOf(reply: Reply): number {
  const id = reply["id"];
  if (typeof id !== "number") throw new Error("a matched reply lost its id, which cannot happen");
  return id;
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

  constructor(
    private readonly min = 0,
    private readonly max = 300_000,
    private readonly base = 5_000,
    private readonly jitter = true,
    private readonly random: () => number = Math.random,
  ) {}

  /** Records a success: the next attempt waits only the floor. */
  success(): void {
    this.count = 0;
  }

  fail(): void {
    this.count++;
  }

  /** How long the next attempt waits, given the failures so far. */
  delay(): number {
    if (this.count === 0) return this.min;
    let t = this.base * Math.pow(2, this.count - 1);
    if (this.jitter) t *= 0.5 + 0.5 * this.random();
    return Math.floor(Math.min(this.max, this.min + t));
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
  return new ctor(url) as SocketLike;
}

/**
 * How much may sit in the socket's buffer before the next body waits.
 *
 * Enough to keep the link busy between one body being sealed and the next,
 * not so much that a large attachment is held twice, once by the caller and
 * once by the socket.
 */
const UPLOAD_HIGH_WATER = 4 * 1024 * 1024;

/** How often the socket buffer is looked at while an upload drains. */
const DRAIN_POLL_MS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
  value.forEach((e, i) => {
    // The same shape a batch entry is held to. A recovery list is read by a
    // person deciding what to bring back, and a version with no uid or no
    // path is one they cannot act on and must not be shown as if they could.
    const row = e as Partial<WireEntry> | null;
    if (typeof row?.uid !== "number" || !Number.isSafeInteger(row.uid) || row.uid <= 0) {
      throw new ProtocolError("protostate", `${what}[${i}] has no usable uid`);
    }
    if (typeof row.path !== "string" || row.path === "") {
      throw new ProtocolError("protostate", `${what}[${i}] has no path`);
    }
    if (!Array.isArray(row.chunks)) {
      throw new ProtocolError("protostate", `${what}[${i}] has no chunks list`);
    }
    // Every name the shape a chunk name has, before anything is fetched by
    // it (C32). A `get` is held to this already; a recovery list was not.
    for (const name of row.chunks) {
      if (!isChunkName(name)) {
        throw new ProtocolError(
          "protostate",
          `${what}[${i}] names ${JSON.stringify(name)}, which is not a chunk name`,
        );
      }
    }
  });
  return value as WireEntry[];
}
