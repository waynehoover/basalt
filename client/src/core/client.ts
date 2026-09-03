/**
 * A connected client, which is everything both shells have in common.
 *
 * The plugin and the headless CLI each assemble a vault, an index store, a
 * transport and an engine, wait for the backlog, sync until settled, and
 * reconnect when the connection goes. That is not shell-specific work, and the
 * two shells doing it separately is two chances to get the reconnect wrong in
 * one of them.
 *
 * So it is here, and a shell is left with what a shell should be: reading
 * arguments or drawing a status bar, and nothing that decides anything.
 *
 * The transport deliberately does not reconnect itself, because a client that
 * exits wants to fail where a client that stays wants to wait. Both kinds are
 * below: `Client` is one connection, and `runForever` is the loop.
 */

import {
  Engine,
  contentId,
  firstFreeName,
  placeBeside,
  type SyncOptions,
  type SyncReport,
} from "./engine.ts";
import {
  Backoff,
  ConnectionError,
  ProtocolError,
  Transport,
  type ServerLimits,
  type SocketLike,
  type WireEntry,
} from "./transport.ts";
import type { IndexStore, Vault } from "./vault.ts";
import {
  authToken,
  base64urlEncode as encodeBase64url,
  deriveKeys,
  entryIsOurs,
  generateDataKey,
  openPath,
  randomBytes,
  sealPath,
  sealSecret,
  unsealSecret,
  unwrapDataKey,
  wrapDataKey,
  type VaultKeys,
} from "./crypto.ts";
import { INVITE_ID_LENGTH, INVITE_KEY_LENGTH, formatInvite, type Invite } from "./pairing.ts";

export interface ClientOptions {
  readonly vault: Vault;
  readonly store: IndexStore;
  /** The keys derived from the root secret alone. See EngineOptions. */
  readonly keys: VaultKeys;
  /**
   * The root secret, so the data key `ready` returns can be unwrapped, an
   * invite can seal it, and a rotation can replace it. A shell always passes
   * it; only a test that knows its vault has no data key leaves it out.
   */
  readonly secret?: Uint8Array;
  /** WebSocket URL of the server. */
  readonly url: string;
  readonly token: string;
  /** The auth key to bind the vault to, if it has not been claimed yet. */
  readonly claim?: string;
  /** A fresh wrapped data key to store with the claim. See EngineOptions. */
  readonly wrapped?: string;
  readonly vaultId: string;
  readonly device: string;
  readonly timeoutMs?: number;
  /** Whether to hold back a file written moments ago. See EngineOptions. */
  readonly coalesceWrites?: boolean;
  readonly log?: (message: string, ...rest: unknown[]) => void;
  /** The path being worked on, and undefined when a pass ends. */
  readonly onProgress?: (path: string | undefined) => void;
  /**
   * Called with the report of every pass, whatever started it.
   *
   * A pass can start from the ticker, from a batch arriving, from the
   * watcher, from a shell asking, or from `settle`, and a shell that wants
   * to say what the vault looks like had to hook each of those separately
   * and missed some. One place, every pass. A pass that threw reports
   * nothing here; the error goes to whoever asked for it.
   */
  readonly onPass?: (report: SyncReport) => void;
  /** Injectable for tests, and for a platform whose WebSocket is not global. */
  readonly socketFactory?: (url: string) => SocketLike;
}

/** One connection, from hello to close. */
/**
 * How long to wait after a batch arrives before fetching what it named.
 *
 * Long enough that a burst of catch-up batches becomes one pass, short enough
 * that two devices side by side look immediate.
 */
const ARRIVAL_DELAY_MS = 150;

export class Client {
  readonly engine: Engine;
  readonly transport: Transport;
  private limits: ServerLimits | undefined;
  private soonTimer: ReturnType<typeof setTimeout> | undefined;
  private caughtUp = false;
  /** When the last batch arrived, for the catch-up wait in `connect`. */
  private lastBatchAt = Date.now();
  private endedWith: Error | undefined;
  private notifyEnded: ((cause: Error) => void) | undefined;

  constructor(private readonly opts: ClientOptions) {
    let engine!: Engine;
    this.transport = new Transport(opts.url, {
      onBatch: async (batch) => {
        this.lastBatchAt = Date.now();
        await engine.acceptBatch(batch);
        // Accepting a batch records what the server has; it does not
        // fetch it. Without this the download waited for the next tick,
        // so a note written on one device took up to thirty seconds to
        // appear on another that was connected and idle the whole time.
        // Measured on a phone: 0.2 s, 9.2 s, 14.2 s, and one that had
        // not arrived after half a minute.
        //
        // An empty batch is this device's own write coming back, and
        // there is nothing to fetch for it.
        if (batch.entries.length > 0) this.soon();
      },
      onCaughtUp: () => {
        this.caughtUp = true;
      },
      onClosed: (cause) => {
        this.endedWith = cause;
        this.notifyEnded?.(cause);
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      ...(opts.socketFactory !== undefined ? { socketFactory: opts.socketFactory } : {}),
    });
    engine = new Engine({
      vault: opts.vault,
      store: opts.store,
      keys: opts.keys,
      ...(opts.secret !== undefined ? { secret: opts.secret } : {}),
      transport: this.transport,
      device: opts.device,
      vaultId: opts.vaultId,
      token: opts.token,
      ...(opts.claim !== undefined ? { claim: opts.claim } : {}),
      ...(opts.wrapped !== undefined ? { wrapped: opts.wrapped } : {}),
      ...(opts.coalesceWrites !== undefined ? { coalesceWrites: opts.coalesceWrites } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
    });
    this.engine = engine;
  }

  /**
   * One thing at a time on the wire.
   *
   * The transport allows a single request in flight and throws otherwise, on
   * purpose: replies carry no request id, so a second question would resolve
   * into the first one's slot. The engine is single-flight and so never trips
   * it, which was the whole story until recovery arrived.
   *
   * Recovery is not part of the engine. Somebody browsing deleted notes while
   * the background sync ticks is two callers, and they collide. So everything
   * here that touches the wire queues behind everything else that does.
   *
   * The granularity is one engine pass, not one settle, so a question does
   * not wait behind eight of them.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(work: () => Promise<T>): Promise<T> {
    // Runs on both paths: one caller's failure must not stop the next.
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** How many requests this client has sent, which is what latency multiplies. */
  get requestsSent(): number {
    return this.transport.requestsSent;
  }

  /** The newest uid the server held when this client said hello. */
  get serverCursor(): number {
    return this.limits?.cursor ?? 0;
  }

  /** Everything the server advertised at hello, or undefined before it. */
  get serverLimits(): ServerLimits | undefined {
    return this.limits;
  }

  /**
   * The vault's wrapped data key as the server holds it, or undefined for a
   * vault claimed under protocol 2, which has none.
   */
  get wrapped(): string | undefined {
    return this.limits?.wrapped;
  }

  /** The keys in use, which after `ready` may be the data key's rather than the root's. */
  get keys(): VaultKeys {
    return this.engine.vaultKeys;
  }

  /**
   * Connects, says hello, and waits for the backlog.
   *
   * The wait is not optional. A pass that runs before catch-up finishes sees a
   * vault the server already has files for, decides they are local-only, and
   * uploads the lot.
   */
  async connect(): Promise<ServerLimits> {
    await this.transport.connect();
    this.lastBatchAt = Date.now();
    this.limits = await this.engine.start();

    // An inactivity bound, not a total one. A device that has been away for
    // a while has a long backlog, and over a slow link the whole of it can
    // take longer than the timeout while batches arrive steadily the entire
    // time. Bounding the total made that device reconnect into the same
    // backlog for ever; what a timeout is for is a server that has stopped
    // talking, and that is measured from the last thing it said.
    const timeout = this.opts.timeoutMs ?? 30_000;
    while (!this.caughtUp) {
      if (this.endedWith) throw this.endedWith;
      if (Date.now() - this.lastBatchAt > timeout) {
        throw new Error("the server never finished sending what it already had");
      }
      await sleep(25);
    }
    return this.limits;
  }

  /**
   * Syncs until a pass finds nothing left to do, and reports the total.
   *
   * The passes are added together rather than the last one returned, because
   * the last pass is by construction the one that found nothing: returning it
   * would tell every successful sync that it had done no work. That was a real
   * bug, caught by the first end-to-end test that read the output.
   */
  async settle(opts: SyncOptions = {}, maxPasses = 8): Promise<SyncReport> {
    // Each pass queues separately, so a recovery question asked halfway
    // through waits for one pass rather than for all of them.
    let pass = await this.pass(opts);
    let total = pass;
    for (let i = 0; i < maxPasses && didSomething(pass); i++) {
      await sleep(60);
      pass = await this.pass(opts);
      total = accumulate(total, pass);
    }
    return total;
  }

  private pass(opts: SyncOptions): Promise<SyncReport> {
    return this.serial(async () => {
      // A closed client starts no pass. `close` drains the queue, and a
      // settle sleeping between two passes was not in the queue: it woke
      // after the drain, ran a pass against the closed transport, and saved
      // the index that unlink had just removed.
      if (this.closing) throw new ConnectionError("this client has been closed");
      const report = await this.engine.sync(opts);
      this.opts.onPass?.(report);
      return report;
    });
  }

  /**
   * Waits for everything queued on the wire to finish, including work queued
   * while waiting.
   *
   * `runUntilClosed` used to resolve the moment the transport closed, while a
   * pass started by the ticker or the watcher could still be writing the
   * vault and the index. `runForever` then built a new client that loaded
   * the index the old engine was about to overwrite. Two engines on one
   * index is the state the single-flight rule exists to prevent.
   */
  private async drain(): Promise<void> {
    let seen: Promise<unknown> | undefined;
    while (this.queue !== seen) {
      seen = this.queue;
      await seen;
    }
  }

  /**
   * Keeps syncing until the connection ends, and resolves with the reason.
   *
   * The watcher says when to look and the timer is the backstop for a platform
   * where watching does not work. Neither decides anything: the scan does, and
   * it re-reads the vault every time, so a missed event costs latency and
   * never correctness.
   */
  async runUntilClosed(tickMs = 30_000): Promise<Error> {
    if (this.endedWith) return this.endedWith;
    const stop = this.opts.vault.watch?.(() => void this.sync());
    // A sync with nothing to do sends nothing, so a settled vault is a
    // silent connection, and the server closes a silent one after five
    // minutes. Observed against a real server: a vault that had finished
    // syncing dropped its connection every five minutes for ever, each time
    // reconnecting and replaying the handshake to discover it was already up
    // to date. Nothing was lost and nothing said why.
    //
    // One frame every half minute is cheaper than that, and it is also how a
    // device finds out promptly that a connection has died under it.
    const ticker = setInterval(() => {
      void this.sync().then(() => this.keepalive());
    }, tickMs);
    let cause: Error;
    try {
      cause = await new Promise<Error>((resolve) => {
        this.notifyEnded = resolve;
      });
    } finally {
      clearInterval(ticker);
      stop?.();
    }
    // Nothing else starts a pass now, and the one that may be running gets
    // to finish writing before this client is reported gone.
    await this.drain();
    return cause;
  }

  /**
   * Says something, so the connection is not idle.
   *
   * Failures are swallowed: a ping that cannot be sent means the connection
   * has already gone, which the run loop is about to be told by the read side.
   * Reporting it here would report it twice.
   */
  private async keepalive(): Promise<void> {
    try {
      await this.transport.ping();
    } catch {
      /* the connection is gone; the loop around this will hear about it */
    }
  }

  /**
   * Syncs shortly, coalescing a run of arrivals into one pass.
   *
   * Catch-up is many batches in a row and a pass per batch would be a pass
   * per batch for nothing: they all want the same thing, which is one pass
   * once they have stopped coming. Short enough that it still reads as
   * immediate to somebody watching two devices.
   */
  private soon(): void {
    if (this.soonTimer !== undefined) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = undefined;
      void this.sync();
    }, ARRIVAL_DELAY_MS);
  }

  /**
   * A sync whose failure does not become an unhandled rejection.
   *
   * Public because a shell with its own reason to sync needs it: the plugin
   * hears about a saved file from Obsidian rather than from a watcher.
   * Failures are logged rather than thrown, because the caller is an event
   * handler and there is nothing useful for it to do with an exception.
   */
  async sync(opts: SyncOptions = {}): Promise<SyncReport | undefined> {
    try {
      return await this.pass(opts);
    } catch (err) {
      this.opts.log?.("sync failed", (err as Error).message);
      return undefined;
    }
  }

  /**
   * Records a rename the host reported, once nothing else is touching the
   * index.
   *
   * `Engine.noteRename` rewrites entries synchronously, and a shell that
   * called it directly did so between the awaits of whatever pass was
   * running: the pass had an entry in hand for the old name, the rename
   * moved it, and the pass went on to upload under the old name while the
   * new one held a stale copy. Queued like a pass, it lands between them.
   */
  noteRename(from: string, to: string): Promise<void> {
    return this.serial(async () => this.engine.noteRename(from, to));
  }

  /* ------------------------------------------------------------ *
   * Recovery
   * ------------------------------------------------------------ */

  /**
   * Every version of one note, newest first.
   *
   * The path is sealed on the way out and the answer's paths are unsealed on
   * the way back, so the server takes no part in any of it beyond looking up
   * a key in a table.
   */
  async history(path: string, opts: { before?: number; limit?: number } = {}): Promise<Version[]> {
    const sealed = await sealPath(this.keys, path);
    const entries = await this.serial(() => this.transport.history(sealed, opts));
    await this.mustBeOurs(entries);
    return entries.map((e) => this.asVersion(e, path));
  }

  /**
   * Refuses a recovery list holding an entry this vault's key did not sign.
   *
   * The ordinary sync path checks every batch entry's authenticator before it
   * acts on it. Recovery did not (C32): a `history` was shown, a `deleted`
   * list was offered for restore, and the version chosen was fetched and
   * written, all on the server's word. The server holds every sealed path
   * and could name any file; an entry it invented would decrypt, being made
   * of real chunks, and be written into the vault as a restored note.
   */
  private async mustBeOurs(entries: readonly WireEntry[]): Promise<void> {
    const keys = this.keys;
    const ours = await Promise.all(
      entries.map((e) =>
        entryIsOurs(
          keys,
          {
            path: e.path,
            size: e.size,
            ctime: e.ctime,
            mtime: e.mtime,
            folder: e.folder,
            deleted: e.deleted,
            prev: e.prev,
            chunks: e.chunks,
            parent: e.parent ?? "",
          },
          e.mac,
        ),
      ),
    );
    const forged = ours.indexOf(false);
    if (forged >= 0) {
      throw new Error(
        `version ${entries[forged]!.uid} is not authenticated by this vault's key, ` +
          `so nothing that holds the key wrote it, and it is not shown`,
      );
    }
  }

  /**
   * Every note whose newest version is a deletion, newest first.
   *
   * This is the list somebody reads when they know a note is gone and cannot
   * remember what it was called, which is why the paths are unsealed here
   * rather than left for the caller.
   */
  async deleted(limit?: number): Promise<DeletedList> {
    const answer = await this.serial(() => this.transport.deleted(limit));
    await this.mustBeOurs(answer.entries);
    const notes: Deletion[] = [];
    for (const e of answer.entries) {
      notes.push({
        ...this.asVersion(e, await openPath(this.keys, e.path)),
        // Zero means purge has taken every version that had content.
        // The note is still listed, and there is nothing to bring back.
        restorable: e.restorable ?? 0,
      });
    }
    return { notes, more: answer.more };
  }

  /**
   * Puts a version back into the vault.
   *
   * Deliberately not a server operation. Restoring is fetching the content
   * and writing it where it belongs; the ordinary sync then uploads it as a
   * new version, through the one put path that everything else already uses
   * and that is tested to death. A server-side restore would be a second way
   * to change a vault, and the client would have had to download the content
   * anyway.
   *
   * Nothing is overwritten. If something already occupies the path, the
   * restored copy goes beside it under a distinct name and both are returned,
   * because a recovery tool that can destroy the thing you have is worse than
   * no recovery tool.
   */
  /**
   * The bytes of one version, without writing anything.
   *
   * What a history view needs and what restore cannot give it: somebody
   * deciding whether to put a version back has to read it first, and reading
   * it must not be the act of restoring it.
   *
   * Queued for the same reason restore is: reassembling a version is several
   * requests and a sync starting in the middle of them would collide.
   */
  async contentAt(version: Version): Promise<Uint8Array> {
    if (version.deleted || version.folder) return new Uint8Array(0);
    return this.serial(() => this.engine.contentOf(version.uid, undefined, version.contentId));
  }

  async restore(version: Version, to?: string): Promise<{ path: string; bytes: number }> {
    if (version.deleted) {
      throw new Error(
        `version ${version.uid} of ${version.path} is the deletion itself, not a version to restore`,
      );
    }
    if (version.folder) {
      const at = to ?? version.path;
      await this.opts.vault.mkdir(at);
      return { path: at, bytes: 0 };
    }

    // Queued like a pass, because reassembling a version is several
    // requests and a sync starting in the middle of them would collide. The
    // chunk list the signed history entry named is what `get` must answer
    // with; anything else is not this version (C32).
    const content = await this.serial(() =>
      this.engine.contentOf(version.uid, undefined, version.contentId),
    );
    const wanted = to ?? version.path;
    const vault = this.opts.vault;
    const exists = (p: string) => vault.exists(p);
    const times = { mtime: version.mtime, ctime: version.ctime };
    // Never over what is there, and never in the gap between looking and
    // writing either. The copy's name is numbered past whatever exists:
    // restoring the same version twice is ordinary, and the second copy
    // landing on the first replaced the one thing a restore gives back.
    const at = await placeBeside(
      async () =>
        (await exists(wanted)) ? firstFreeName(restoredCopyPath(wanted, version), exists) : wanted,
      content,
      times,
      vault,
    );
    return { path: at, bytes: content.length };
  }

  /**
   * The newest version of a path that had content, or undefined.
   *
   * Not queued itself: it is a call to `history`, which is. Queuing here as
   * well would be a lock waiting for itself.
   */
  async newestContentVersion(path: string): Promise<Version | undefined> {
    return this.findVersion(path, (v) => !v.deleted);
  }

  /**
   * The newest version of a path that satisfies `match`, paging as far back as
   * it has to.
   *
   * A single page used to be all anybody looked at: fifty versions for the
   * newest with content, five hundred for a version by uid. A note edited
   * more often than that, or deleted and re-created enough times, had older
   * versions that `basalt history` would list and `basalt restore --uid`
   * would then say did not exist. Recovery is the one place that answer must
   * not be a page size.
   *
   * `pageSize` is a parameter so a test can make the paging happen with a
   * handful of versions rather than hundreds.
   */
  async findVersion(
    path: string,
    match: (v: Version) => boolean,
    pageSize = 100,
  ): Promise<Version | undefined> {
    let before: number | undefined;
    for (;;) {
      const page = await this.history(
        path,
        before === undefined ? { limit: pageSize } : { before, limit: pageSize },
      );
      const found = page.find(match);
      if (found) return found;
      if (page.length < pageSize) return undefined;
      before = page[page.length - 1]!.uid;
    }
  }

  private asVersion(e: WireEntry, path: string): Version {
    return {
      uid: e.uid,
      path,
      size: e.size,
      ctime: e.ctime,
      mtime: e.mtime,
      folder: e.folder,
      deleted: e.deleted,
      device: e.device,
      chunks: e.chunks?.length ?? 0,
      contentId: contentId(e.chunks ?? []),
    };
  }

  /* ------------------------------------------------------------ *
   * Adding a device, and retiring a leaked secret
   * ------------------------------------------------------------ */

  /**
   * Issues a single-use invite for another device.
   *
   * The root secret is sealed under a fresh key the server never sees and
   * stored under a fresh identifier it cannot guess, for `ttlMs` (the
   * server's default and cap apply when this is absent or over). What comes
   * back is the string to hand over and the moment it stops working, in
   * server milliseconds. The string is the only copy of the key; nothing here
   * keeps it.
   */
  async invite(ttlMs?: number): Promise<{ invite: string; expiresAt: number }> {
    const secret = this.opts.secret;
    if (secret === undefined) {
      throw new Error(
        "this client was given no root secret, so it has nothing to put in an invite",
      );
    }
    const id = randomBytes(INVITE_ID_LENGTH);
    const key = randomBytes(INVITE_KEY_LENGTH);
    const sealed = await sealSecret(key, secret);
    const expiresAt = await this.serial(() =>
      this.transport.invite({
        invite: base64url(id),
        sealed,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      }),
    );
    const invite: Invite = { url: this.opts.url, vaultId: this.opts.vaultId, id, key };
    return { invite: formatInvite(invite), expiresAt };
  }

  /**
   * Gives the vault a new root secret, keeping its history.
   *
   * The data key does not change; it is unwrapped under the old root and
   * wrapped again under the new one, and the server swaps the auth hash and
   * the blob together. Only a vault with a data key can do this: one claimed
   * under protocol 2 seals its content under the root itself, so for it the
   * only rotation is a new vault, and this says so rather than doing anything.
   * The caller saves the new secret once this returns; until then nothing has
   * changed on either end.
   */
  async rotate(newSecret: Uint8Array): Promise<void> {
    const secret = this.opts.secret;
    if (secret === undefined) {
      throw new Error("this client was given no root secret, so it cannot rotate one");
    }
    const wrapped = this.wrapped;
    if (wrapped === undefined) {
      throw new Error(
        "this vault was claimed under protocol 2, rotation is a new vault, see docs/server.md",
      );
    }
    const old = await deriveKeys(secret);
    const dataKey = await unwrapDataKey(old.wrap, wrapped);
    const fresh = await deriveKeys(newSecret);
    const rewrapped = await wrapDataKey(fresh.wrap, dataKey);
    await this.serial(() => this.transport.rotate({ auth: authToken(fresh), wrapped: rewrapped }));
  }

  /**
   * Closes the connection and resolves once nothing of this client is still
   * running.
   *
   * The transport is closed first, so a pass in flight fails its remaining
   * wire work quickly and records it for retry rather than waiting out a
   * timeout. Then that pass is waited for, because it may still be writing
   * files and the index, and whoever called this is about to reuse both.
   */
  private closing = false;

  async close(): Promise<void> {
    this.closing = true;
    // Or a pass fires against a closed transport after the caller has
    // finished with this client, which in a test is a leak and in a plugin
    // is a sync running after the vault was unlinked.
    if (this.soonTimer !== undefined) {
      clearTimeout(this.soonTimer);
      this.soonTimer = undefined;
    }
    this.transport.close();
    await this.drain();
  }
}

/**
 * What the server is still holding that the vault is not.
 *
 * `more` rather than just a list, because the answer is bounded and a truncated
 * list that does not say so is one somebody reads and concludes their note is
 * gone.
 */
export interface DeletedList {
  readonly notes: Deletion[];
  readonly more: boolean;
}

/**
 * A deleted note, and whether anything survives to bring it back.
 *
 * The two are separate facts. Purge keeps only the newest version per path, and
 * for a deleted note that is the deletion record, so a note can be listed here
 * with its content gone. Saying "all still recoverable" over this list without
 * looking tells somebody their note is safe when it is not.
 */
export interface Deletion extends Version {
  /** The newest version with content, or 0 when there is none left. */
  readonly restorable: number;
}

/** One version of one note, as recovery talks about it. */
export interface Version {
  readonly uid: number;
  /** Plaintext, unsealed by whoever asked. */
  readonly path: string;
  readonly size: number;
  readonly ctime: number;
  readonly mtime: number;
  readonly folder: boolean;
  /** True for the record of a deletion, which is a version like any other. */
  readonly deleted: boolean;
  /** The device that wrote it. */
  readonly device: string;
  /** How many chunks it is stored in. Zero for a folder, a deletion, or empty. */
  readonly chunks: number;
  /**
   * The chunk list as the signed entry named it, in the engine's content id
   * form. What a restore holds `get` to, so the server cannot answer with
   * another file's chunks.
   */
  readonly contentId: string;
}

/**
 * Where a restore goes when the path is already occupied.
 *
 * Same shape as a conflict copy and the same reason: the thing you already have
 * is never overwritten by something arriving from elsewhere. Somebody restoring
 * a note from last week onto a note they have been editing today should end up
 * with both.
 */
export function restoredCopyPath(path: string, version: Version): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? "" : name.slice(dot);
  return `${dir}${stem} (restored ${version.uid})${ext}`;
}

/** What a long-running client tells whoever is watching it. */
export interface ForeverHooks {
  /** After each settle, whether or not it did anything. */
  onSynced?(report: SyncReport, serverCursor: number): void;
  /**
   * A client that is about to connect, before it has.
   *
   * `onClient` fires only once the handshake has succeeded, which is right
   * for a shell that reads success into it, and too late for one that needs
   * to stop the attempt: a vault unlinked or a plugin unloaded during a slow
   * handshake had no handle on the client doing it, so the connection went
   * on to succeed and the loop went on to sync. This hands the shell the
   * client while it can still be closed.
   */
  onConnecting?(client: Client): void;
  /**
   * The live client, each time a new one connects, and undefined when it goes.
   *
   * For a shell that has its own reason to sync: the plugin gets file events
   * from Obsidian and wants to act on them, and it cannot without a handle on
   * whichever client is currently connected.
   */
  onClient?(client: Client | undefined): void;
  /** The connection ended, and how long until the next attempt. */
  onDisconnected?(cause: Error, retryInMs: number): void;
  /** A connection could not be made, and how long until the next attempt. */
  onUnreachable?(cause: Error, retryInMs: number): void;
  /**
   * Something that will fail identically forever, so the loop has stopped.
   *
   * A bad token or an impossible cursor. Retrying those is a loop that never
   * ends and never tells anybody why.
   */
  onFatal?(cause: Error): void;
  /** Whether to keep going. Lets a shell stop the loop without an exception. */
  keepGoing?(): boolean;
  /** How the loop waits between attempts. Injectable so a test need not. */
  sleep?(ms: number): Promise<void>;
}

/**
 * How many times the same failure may end a connection before the loop
 * stops and says so.
 *
 * A batch the engine cannot apply ends the session, the loop reconnects, the
 * server sends the same batch, and round it goes for ever with nothing said
 * (C28). Three identical failures in a row are not a network; they are a
 * wall, and the person is told where it is.
 */
export const IDENTICAL_FAILURES_BEFORE_STOPPING = 3;

/**
 * Syncs, then keeps syncing, reconnecting for as long as it is worth it.
 *
 * A network that comes and goes is the normal case for a laptop rather than an
 * error, so a dropped connection waits and tries again. `Backoff` is Obsidian's,
 * with its jitter: several devices attached to a server that restarts would
 * otherwise all return at the same instant, fail together, and come back
 * together.
 *
 * Resolves when a fatal refusal arrives or `keepGoing` says to stop.
 */
export async function runForever(opts: ClientOptions, hooks: ForeverHooks = {}): Promise<void> {
  const backoff = new Backoff(0, 300_000, 5_000, true);
  const wait = hooks.sleep ?? sleep;
  let lastFailure = "";
  let repeats = 0;

  while (hooks.keepGoing?.() ?? true) {
    let client: Client | undefined;
    let cause: Error | undefined;
    let reachedTheServer = false;

    try {
      client = new Client(opts);
      hooks.onConnecting?.(client);
      await client.connect();
      reachedTheServer = true;
      backoff.success(Date.now());
      // Asked again here, not only at the top of the loop. A shell that
      // said stop during the handshake has nothing else to say it with,
      // and a settle on a vault somebody has just unlinked is exactly the
      // sync they were trying to prevent.
      if (!(hooks.keepGoing?.() ?? true)) return;
      hooks.onClient?.(client);
      // Settled first, then reported. Written as one line before, with the
      // settle as the hook's argument, which meant a shell that passed no
      // `onSynced` never had the settle run at all: an optional call skips
      // its arguments, and the first sync waited for the ticker.
      const report = await client.settle();
      hooks.onSynced?.(report, client.serverCursor);
      cause = await client.runUntilClosed();
    } catch (err) {
      cause = err as Error;
    } finally {
      hooks.onClient?.(undefined);
      // Awaited: the next client loads the index this one may still be
      // writing, and two engines on one index is the state the
      // single-flight rule exists to prevent.
      await client?.close();
    }

    if (cause && isFatal(cause)) {
      hooks.onFatal?.(cause);
      return;
    }
    // The same failure, word for word, on consecutive connections is not a
    // network coming and going; it is something the server sends every time
    // and this device cannot take, and retrying it is a loop that never ends
    // and never tells anybody why (C28). A dropped connection is excused,
    // because that is what a network does, and so is a refusal the server
    // marked retryable, because `busy` on a full vault is the same words
    // every time and is still meant to be waited out. What is left is this
    // device's own failure to apply what it was sent.
    if (cause && !(cause instanceof ConnectionError) && !(cause instanceof ProtocolError)) {
      repeats = cause.message === lastFailure ? repeats + 1 : 1;
      lastFailure = cause.message;
      if (repeats >= IDENTICAL_FAILURES_BEFORE_STOPPING) {
        hooks.onFatal?.(
          new Error(
            `${cause.message}. This has failed ${repeats} times in a row with this device at cursor ` +
              `${client?.engine.status().cursor ?? 0}, so waiting will not help; ` +
              `docs/server.md says how to recover from an entry no device can apply`,
          ),
        );
        return;
      }
    } else {
      repeats = 0;
      lastFailure = "";
    }
    if (!(hooks.keepGoing?.() ?? true)) return;

    backoff.fail(Date.now());
    const why = cause ?? new Error("the connection ended");
    const delay = retryWait(why, backoff.delay());
    if (reachedTheServer) hooks.onDisconnected?.(why, delay);
    else hooks.onUnreachable?.(why, delay);
    await wait(delay);
  }
}

/**
 * Whether trying again could ever help.
 *
 * "Closed by this device" is not a failure, it is this client shutting down, and
 * treating it as fatal would stop a loop that was asked to stop anyway. A
 * refusal the server marked as not retryable will be repeated word for word
 * forever; one it marked retryable, `busy` on a restart above all, is the
 * connection ending for a reason a retry outlives (C27).
 */
export function isFatal(cause: Error): boolean {
  return cause instanceof ProtocolError && cause.fatal;
}

/**
 * How long to wait before the next attempt: the backoff, or longer if the
 * server said so.
 *
 * `retryAfterMs` travels with `busy`. A device refused for the vault's device
 * limit is told thirty seconds, because the other devices' sessions have to
 * go away first; one refused for a shutdown is told five, because the server
 * is about to be back. Neither is a reason to wait less than the backoff
 * already would, so the longer of the two wins.
 */
export function retryWait(cause: Error, backoffMs: number): number {
  const hint = cause instanceof ProtocolError ? cause.retryAfterMs : undefined;
  return Math.max(backoffMs, hint ?? 0);
}

/**
 * A fresh data key for a vault this device is about to claim, wrapped under
 * its root so the server can store it.
 *
 * Made once per connection attempt and used only if the claim goes through,
 * because the key a vault actually has comes back in `ready`. A claim that
 * committed while its reply was lost leaves the server holding the key it
 * stored, and the next attempt's fresh one is ignored like the claim it came
 * with.
 */
export async function wrappedForClaim(keys: VaultKeys): Promise<string> {
  return wrapDataKey(keys.wrap, generateDataKey());
}

/**
 * Redeems an invite: one connection that carries the invite in place of a
 * token, takes the sealed root, and closes.
 *
 * Returns the root secret and, for a vault with a data key, the wrapped key
 * the server holds. The caller stores the secret and connects again as a
 * device. Nothing here is a device: the connection proved only that it held
 * an unused invite, which the server burned before answering, so a reply lost
 * on the way leaves the invite spent and the caller with nothing saved, which
 * is a usable state: the issuing device makes another.
 */
export async function redeemInvite(
  invite: Invite,
  device: string,
  opts: { timeoutMs?: number; socketFactory?: (url: string) => SocketLike } = {},
): Promise<{ secret: Uint8Array; wrapped?: string }> {
  const transport = new Transport(invite.url, {
    onBatch: () => {},
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.socketFactory !== undefined ? { socketFactory: opts.socketFactory } : {}),
  });
  try {
    await transport.connect();
    const redeemed = await transport.redeem({
      vault: invite.vaultId,
      device,
      invite: base64url(invite.id),
    });
    const secret = await unsealSecret(invite.key, redeemed.sealed);
    return { secret, ...(redeemed.wrapped !== undefined ? { wrapped: redeemed.wrapped } : {}) };
  } finally {
    transport.close();
  }
}

function base64url(bytes: Uint8Array): string {
  // The same alphabet crypto.ts uses, imported from there to keep one copy.
  return encodeBase64url(bytes);
}

/**
 * Adds a pass onto a running total.
 *
 * The work counters add up, because they count things that happened. The state
 * counters do not: `unchanged`, `waiting`, `retrying` and `skipped` describe how
 * the vault looks at the end of a pass, and summing them would report one
 * unchanged file four times for having been looked at four times.
 */
export function accumulate(total: SyncReport, pass: SyncReport): SyncReport {
  return {
    uploaded: total.uploaded + pass.uploaded,
    downloaded: total.downloaded + pass.downloaded,
    merged: total.merged + pass.merged,
    conflicted: total.conflicted + pass.conflicted,
    deletedLocally: total.deletedLocally + pass.deletedLocally,
    deletedRemotely: total.deletedRemotely + pass.deletedRemotely,
    restored: total.restored + pass.restored,
    foldersCreated: total.foldersCreated + pass.foldersCreated,
    chunksSent: total.chunksSent + pass.chunksSent,
    bytesSent: total.bytesSent + pass.bytesSent,
    unchanged: pass.unchanged,
    waiting: pass.waiting,
    retrying: pass.retrying,
    skipped: pass.skipped,
    blocked: pass.blocked,
    // A state, like the four above it: the newest pass's answer, not every
    // pass's answers concatenated.
    inTheWay: pass.inTheWay,
  };
}

/** Whether a pass did anything that could produce more work. */
export function didSomething(r: SyncReport): boolean {
  return (
    r.uploaded +
      r.downloaded +
      r.merged +
      r.conflicted +
      r.deletedLocally +
      r.deletedRemotely +
      r.restored +
      r.foldersCreated +
      r.waiting >
    0
  );
}

/** A one-line summary for a status bar, which has room for one line. */
export function summarise(r: SyncReport): string {
  const bits: string[] = [];
  const add = (n: number, what: string) => {
    if (n > 0) bits.push(`${n} ${what}`);
  };
  add(r.uploaded, "sent");
  add(r.downloaded, "received");
  add(r.merged, "merged");
  add(r.conflicted, "conflicted");
  add(r.deletedLocally + r.deletedRemotely, "deleted");
  add(r.restored, "restored");
  add(r.retrying, "retrying");
  add(r.skipped, "stuck");
  add(r.blocked, "in the way");
  return bits.length === 0 ? "up to date" : bits.join(", ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
