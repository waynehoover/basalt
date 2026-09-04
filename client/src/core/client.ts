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
  checkEntryShape,
  combinePasses,
  contentId,
  mustBeOurs,
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
import { MemoryIndexStore, type IndexStore, type Vault } from "./vault.ts";
import { validateStoredState } from "./stored-state.ts";
import {
  authToken,
  base64urlEncode,
  deriveRootKeys,
  generateDataKey,
  openPath,
  randomBytes,
  sealPath,
  sealSecret,
  unsealSecret,
  unwrapDataKey,
  wrapDataKey,
  type RootKeys,
  type VaultKeys,
} from "./crypto.ts";
import {
  INVITE_ID_LENGTH,
  INVITE_KEY_LENGTH,
  encodeConfig,
  formatInvite,
  type DeviceConfig,
  type Invite,
} from "./pairing.ts";
import { firstFreeName, splitName } from "./paths.ts";

export interface ClientOptions {
  readonly vault: Vault;
  readonly store: IndexStore;
  /**
   * The root secret: what unwraps the data key `ready` returns, what an
   * invite seals, and what a rotation replaces. See EngineOptions.
   */
  readonly secret: Uint8Array;
  /** WebSocket URL of the server. */
  readonly url: string;
  readonly token: string;
  /** What to bind the vault to if it has not been claimed. See EngineOptions. */
  readonly claim?: { auth: string; wrapped: string };
  /**
   * The vault's wrapped data key as this device last saw it. A `ready` with a
   * different blob is refused. See DeviceConfig.
   */
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

/**
 * How long to wait after a batch arrives before fetching what it named.
 *
 * Long enough that a burst of catch-up batches becomes one pass, short enough
 * that two devices side by side look immediate.
 */
const ARRIVAL_DELAY_MS = 150;

/** One connection, from hello to close. */
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
      secret: opts.secret,
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
   * One operation at a time on the wire.
   *
   * Not because replies could be confused with one another: protocol 3 gives
   * every request an id and the transport keeps a map of what is outstanding,
   * so two questions in flight resolve into their own slots. That was the
   * original reason and it is gone, and the queue is still needed.
   *
   * What it protects is the state either side of the wire. A pass reads the
   * vault, decides, writes and saves an index; a restore fetches a version
   * and writes it into the same vault; a rebase rewrites the cursor. Two of
   * those interleaving is two callers deciding from the same starting state
   * and one of them acting on a vault the other has already changed. Somebody
   * browsing deleted notes while the background sync ticks is exactly that,
   * and it is ordinary rather than rare.
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

  /**
   * The newest uid the server is known to hold: what `ready` announced at
   * hello, raised by every batch since, because a batch is the server
   * handing over a uid it holds. `caught-up` is no use for this, being sent
   * once per connection when the backlog drains.
   *
   * Not the hello number alone. The panel prints this beside the local
   * cursor so that a server withholding versions can be seen (I11), and on
   * a connection that stays up for days the hello number is frozen: a vault
   * paired when it was empty went on reporting a server holding nothing
   * however much it went on to hold.
   */
  get serverCursor(): number {
    return Math.max(this.limits?.cursor ?? 0, this.transport.appliedCursor);
  }

  /** The vault's wrapped data key as the server holds it, once connected. */
  get wrapped(): string | undefined {
    return this.limits?.wrapped;
  }

  /** The keys in use, which are the data key's and are known from `ready` onwards. */
  get keys(): VaultKeys {
    return this.engine.vaultKeys;
  }

  /**
   * Connects, says hello, and waits for the backlog.
   *
   * The wait is not optional for anything that then syncs. A pass that runs
   * before catch-up finishes sees a vault the server already has files for,
   * decides they are local-only, and uploads the lot.
   *
   * `waitForBacklog: false` is for the two callers that ask a question and
   * close: `basalt status` and the cursor probe in `basalt rebase`. Both want
   * `ready.cursor`, which is the server's own number and is already here when
   * `start` returns, and a device weeks behind was paying minutes of unsealing
   * and MAC checking to print one line (R1). Closing straight after is what
   * makes it cheap on the other end too: the server stops streaming. Nothing
   * that syncs may pass it.
   */
  async connect(opts: { waitForBacklog?: boolean } = {}): Promise<ServerLimits> {
    await this.transport.connect();
    this.lastBatchAt = Date.now();
    this.limits = await this.engine.start();
    if (opts.waitForBacklog === false) return this.limits;

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
      total = combinePasses(total, pass);
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
    await this.recoveryIsOurs(entries);
    return entries.map((e) => this.asVersion(e, path));
  }

  /**
   * Refuses a recovery list holding an entry this vault's key did not sign.
   *
   * The same check the sync path runs on every batch entry, which for a while
   * recovery did not run at all (C32); `mustBeOurs` in the engine holds the
   * reason. What is added here is the tail of the sentence: nothing forged is
   * acted on, and nothing forged is put in front of somebody either.
   *
   * Both of the sync path's checks, not one. A signature says who wrote an
   * entry and not that the entry makes sense, and the two are separate
   * failures: an entry declaring 500 bytes and naming no chunks is signed by
   * this vault's key and restores as an empty file, which is a note lost to a
   * recovery tool. `acceptBatch` has always refused that shape.
   */
  private async recoveryIsOurs(entries: readonly WireEntry[]): Promise<void> {
    await mustBeOurs(this.keys, entries, ", and it is not shown");
    for (const e of entries) checkEntryShape(e);
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
    await this.recoveryIsOurs(answer.entries);
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
    return this.serial(() => this.engine.contentOf(version.uid, version.contentId, version.size));
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
      this.engine.contentOf(version.uid, version.contentId, version.size),
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
      chunks: e.chunks.length,
      contentId: contentId(e.chunks),
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
    this.refuseIfRotated("issue an invite");
    const secret = this.opts.secret;
    const id = randomBytes(INVITE_ID_LENGTH);
    const key = randomBytes(INVITE_KEY_LENGTH);
    const sealed = await sealSecret(key, secret);
    const expiresAt = await this.serial(() =>
      this.transport.invite({
        invite: base64urlEncode(id),
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
   * Always available, and it always keeps the history: the data key does not
   * change, it is unwrapped under the old root and wrapped again under the
   * new one, and the server swaps the auth hash and the blob together.
   *
   * `beforeSend` is handed the re-wrapped data key and is awaited before the
   * request goes out, so a caller can put the new secret somewhere durable
   * first. It is not optional in spirit: the server commits, evicts every other
   * session and only then replies, so a socket that drops in between leaves a
   * vault whose new root exists nowhere but in this process. Whatever this
   * callback wrote is what the next connection tries.
   *
   * After this returns the client is spent, and says so on every later
   * operation; see `refuseIfRotated`.
   */
  async rotate(
    newSecret: Uint8Array,
    beforeSend?: (rewrapped: string) => Promise<void> | void,
  ): Promise<void> {
    this.refuseIfRotated("rotate the vault's secret");
    const wrapped = this.wrapped;
    if (wrapped === undefined) {
      // Not a vault without a data key, of which there are none: a client
      // that has not connected, and so has not been told what to re-wrap.
      throw new Error("this client is not connected, so it cannot rotate the vault's secret");
    }
    const old = await deriveRootKeys(this.opts.secret);
    const dataKey = await unwrapDataKey(old.wrap, wrapped);
    const fresh = await deriveRootKeys(newSecret);
    const rewrapped = await wrapDataKey(fresh.wrap, dataKey);
    await beforeSend?.(rewrapped);
    await this.serial(() => this.transport.rotate({ auth: authToken(fresh), wrapped: rewrapped }));
    this.rotated = true;
  }

  /**
   * Whether this client's root secret has been replaced under it.
   *
   * A rotation retires the secret this object was built with, and nothing here
   * adopts the new one: `opts.secret` is what an invite seals and what the next
   * rotation would unwrap with, and both would be the retired root. Refusing is
   * the simpler half of the choice. Adopting would mean this object holding two
   * answers to "what is the vault's secret" for the rest of its life, with
   * every later operation having to pick the right one, and the shells close
   * the client immediately after rotating anyway. So the connection stays
   * usable for nothing: whoever rotated saved the new secret and reconnects
   * with it.
   *
   * What is refused is everything that uses the root: `invite`, which would
   * seal a secret the server no longer accepts and hand it to somebody as a way
   * in, and a second `rotate`, which would re-wrap under a key derived from the
   * retired root. Syncing is not refused, because nothing it touches changed: a
   * rotation replaces the wrapping of the data key and not the data key, and
   * this session is the one the server did not evict.
   */
  private rotated = false;

  private refuseIfRotated(what: string): void {
    if (!this.rotated) return;
    throw new Error(
      `this client's connection holds the vault's old secret, which was retired by the rotation ` +
        `it just performed, so it cannot ${what}. Reconnect with the new secret.`,
    );
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
  const { stem, ext } = splitName(path);
  return `${stem} (restored ${version.uid})${ext}`;
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
      backoff.success();
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

    backoff.fail();
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
 * A fresh data key for a vault about to be claimed, wrapped under its root so
 * the server can store it.
 *
 * Made once, when the vault is started, and written into the device config.
 * It used to be made per connection attempt, on the reasoning that only one
 * claim can win. What that missed is the retry: a claim whose reply was lost
 * came back with a different candidate, so the vault could be bound to one key
 * while the device that bound it went on offering another.
 */
export async function wrappedForClaim(keys: RootKeys): Promise<string> {
  return wrapDataKey(keys.wrap, generateDataKey());
}

/**
 * The claim to send with a hello, or nothing.
 *
 * Nothing, once the vault is known to be claimed, which is when the bootstrap
 * has been spent. A claim after that is ignored by an honest server and is a
 * gift to a dishonest one: it is a wrapping of a data key, made by this device
 * and unwrappable by it, which the server can hand back in `ready` as the
 * vault's own. The device would install a schedule no other device derives, and
 * the server would have split the vault in two without learning a key. Not
 * sending it is what makes that unexpressible; the pinned blob in DeviceConfig
 * is what covers everything else.
 *
 * One function rather than the same condition in both shells, because two
 * copies of a rule are two rules and only one of them has a test.
 *
 * The fallback is for a config written before `claimWrapped` existed, which can
 * only be one whose init never got its claim committed. It behaves as that
 * build did rather than refusing to connect at all.
 */
export async function claimFor(
  config: { readonly bootstrap?: string | undefined; readonly claimWrapped?: string | undefined },
  auth: string,
  keys: RootKeys,
): Promise<{ auth: string; wrapped: string } | undefined> {
  if (config.bootstrap === undefined) return undefined;
  return { auth, wrapped: config.claimWrapped ?? (await wrappedForClaim(keys)) };
}

/**
 * The half of a client's options that says who this device is.
 *
 * Which key authenticates, and what the vault gets bound to if it is not
 * bound yet. Both shells worked this out for themselves, from the same stored
 * config, in the same four steps, with near-verbatim copies of the comments
 * below; the two copies were the highest-consequence drift point in the
 * client, because a shell that got the token-or-bootstrap choice wrong
 * authenticates as nobody and a shell that got the claim wrong binds the
 * vault to a data key the rest of the vault cannot derive.
 *
 * It takes a whole `DeviceConfig` rather than the fields it reads, because
 * the set of fields it reads is exactly the thing that keeps changing.
 */
export async function credentialsFor(
  config: DeviceConfig,
): Promise<
  Pick<ClientOptions, "secret" | "url" | "token" | "claim" | "wrapped" | "vaultId" | "device">
> {
  const keys = await deriveRootKeys(config.secret);
  const derived = authToken(keys);
  const claim = await claimFor(config, derived, keys);
  return {
    secret: config.secret,
    url: config.url,
    // The bootstrap while there is one, and what the root secret derives
    // once the vault has been claimed.
    token: config.bootstrap ?? derived,
    // A claim only while this device is still claiming, and always with the
    // same data key; see claimFor.
    ...(claim !== undefined ? { claim } : {}),
    // And the blob this device has already seen, so a server that returns a
    // different one is refused rather than believed.
    ...(config.wrapped !== undefined ? { wrapped: config.wrapped } : {}),
    vaultId: config.vaultId,
    device: config.device,
  };
}

/**
 * The credentials to try, best first, for a config that may be mid-rotation or
 * mid-claim.
 *
 * An outstanding rotation goes first, because if it committed then it is the
 * only thing that opens the vault, and it carries the wrapping the server holds
 * so the pin does not refuse the very connection that resolves it. Then the
 * config as it stands. Then, for the first device only, the config without its
 * bootstrap.
 *
 * That last one is the narrow case in which a bootstrap can be proven spent.
 * Starting a vault writes the config with the bootstrap, claims the vault, and
 * writes it again without. If the second write fails, or the claim commits and
 * its reply is lost, the next run offers the bootstrap first and is refused, for
 * ever. The refusal is `auth`, which is also what a wrong token and another
 * device's vault produce, so it does not on its own say what happened. What does
 * say is the key derived from this config's root secret: the server compares it
 * against the hash it bound the vault to, so that key being accepted proves the
 * vault was claimed with this secret.
 *
 * One function rather than the same list in both shells. The headless client had
 * all three and the plugin had only the bootstrap one, so a rotation whose reply
 * was lost on a phone left the new secret on disk with nothing that would ever
 * try it: intact ciphertext and no way in. `plugin/rotate.test.ts` pins it.
 */
export function credentialCandidates(config: DeviceConfig): DeviceConfig[] {
  const out: DeviceConfig[] = [];
  if (config.pending) {
    const promoted: DeviceConfig = {
      ...config,
      secret: config.pending.secret,
      wrapped: config.pending.wrapped,
    };
    delete (promoted as { bootstrap?: string }).bootstrap;
    delete (promoted as { pending?: unknown }).pending;
    out.push(promoted);
  }
  out.push(config);
  if (config.bootstrap !== undefined) {
    const spent: DeviceConfig = { ...config };
    delete (spent as { bootstrap?: string }).bootstrap;
    out.push(spent);
  }
  return out;
}

/**
 * What the stored config should say now that a connection has succeeded, or
 * undefined when it already says it.
 *
 * `used` is the credential that actually authenticated, which is `stored` for an
 * ordinary device and one of the fallbacks in `credentialCandidates` otherwise.
 * The one thing neither of them knows is the vault's wrapped data key, because
 * that arrives in `ready`.
 *
 * Compared against what is stored rather than against `used`, because the whole
 * reason a fallback was needed is that the two disagree.
 *
 * One function rather than the same three deletions in both shells: a shell that
 * forgot `pending` would keep trying a retired secret first on every connection,
 * and one that forgot `bootstrap` would offer a spent token for ever.
 */
export function settledConfig(
  stored: DeviceConfig,
  used: DeviceConfig,
  wrapped: string | undefined,
): DeviceConfig | undefined {
  const next: DeviceConfig = { ...used, ...(wrapped !== undefined ? { wrapped } : {}) };
  delete (next as { bootstrap?: string }).bootstrap;
  // The claim candidate goes with the bootstrap: nothing sends a claim once the
  // vault is known to be claimed, so keeping it is keeping a wrapping of a data
  // key the vault never adopted.
  delete (next as { claimWrapped?: string }).claimWrapped;
  delete (next as { pending?: unknown }).pending;
  return sameConfig(next, stored) ? undefined : next;
}

function sameConfig(a: DeviceConfig, b: DeviceConfig): boolean {
  return JSON.stringify(encodeConfig(a)) === JSON.stringify(encodeConfig(b));
}

/**
 * Where this device and the server each are, for deciding whether a rebase is
 * the answer.
 *
 * The server's number is asked for from a connection that carries no index and
 * so cannot be refused for being ahead, which is the whole difficulty: the
 * device that needs this is the one the server will not talk to. The backlog is
 * not waited for either, because with an empty index the backlog is the whole
 * vault and this connection is closed the moment the number is out of the
 * handshake.
 *
 * This device's number comes from the store in `opts`, so the two shells cannot
 * disagree about which index they are comparing.
 */
export async function rebaseCursors(
  opts: ClientOptions,
): Promise<{ local: number; server: number }> {
  const local = validateStoredState(await opts.store.load())?.cursor ?? 0;
  const probe = new Client({ ...opts, store: new MemoryIndexStore() });
  try {
    await probe.connect({ waitForBacklog: false });
    return { local, server: probe.serverCursor };
  } finally {
    await probe.close();
  }
}

/**
 * Refuses a rebase that is not the answer to anything.
 *
 * A rebase forgets what this device believed it had synced, and the only thing
 * that makes that safe is being ahead of the server: everything both sides hold
 * identically is agreed again, and what only this device holds goes up as new
 * versions. A device that is not ahead has nothing to rejoin from, and throwing
 * away its index would re-upload the vault for no reason.
 *
 * One function rather than one comparison per shell, because the panel and the
 * command line must not disagree about when this is allowed.
 */
export function refuseUnlessAhead(at: { local: number; server: number }): void {
  if (at.local > at.server) return;
  throw new Error(
    `this device is not ahead of the server (${at.local} against ${at.server}), ` +
      `so there is nothing to rebase: an ordinary sync is enough`,
  );
}

/**
 * Redeems an invite: one connection that carries the invite in place of a
 * token, takes the sealed root, and closes.
 *
 * Returns the root secret, which is all a device needs: it connects again as
 * an ordinary device and takes the vault's data key from that connection's
 * `ready`. Nothing here is a device: the connection proved only that it held
 * an unused invite, which the server burned before answering, so a reply lost
 * on the way leaves the invite spent and the caller with nothing saved, which
 * is a usable state: the issuing device makes another.
 */
export async function redeemInvite(
  invite: Invite,
  device: string,
  opts: { timeoutMs?: number; socketFactory?: (url: string) => SocketLike } = {},
): Promise<{ secret: Uint8Array }> {
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
      invite: base64urlEncode(invite.id),
    });
    return { secret: await unsealSecret(invite.key, redeemed.sealed) };
  } finally {
    transport.close();
  }
}

/**
 * Whether a pass did anything that could produce more work.
 *
 * `waiting` is not on the list, and used to be. A waiting file is one whose
 * write debounce has not run out, which is tens of seconds; counting it here
 * had `settle` re-stat the whole vault eight times at 60 ms intervals to find
 * the same file still waiting, and then return anyway. The follow-on work that
 * is real is handled inside a pass by `again`, which reruns while there is
 * something to do rather than while there is something to wait for.
 */
export function didSomething(r: SyncReport): boolean {
  return (
    r.uploaded +
      r.downloaded +
      r.merged +
      r.conflicted +
      r.deletedLocally +
      r.deletedRemotely +
      r.restored +
      r.foldersCreated >
    0
  );
}

/**
 * A one-line summary for a status bar, which has room for one line.
 *
 * Every counter the report has, because the plugin paints this string into
 * its state and nothing else of the pass reaches the panel. `waiting` was
 * left out, so a file still inside its write debounce, which is tens of
 * seconds, produced "up to date" while a save was owed: rule 7, and the kind
 * of lie a person acts on by closing the laptop. `foldersCreated` was left
 * out with it, and a pass that only made folders said nothing at all.
 */
export function summarise(r: SyncReport): string {
  const bits: string[] = [];
  const add = (n: number, many: string, one = many) => {
    if (n > 0) bits.push(`${n} ${n === 1 ? one : many}`);
  };
  add(r.uploaded, "sent");
  add(r.downloaded, "received");
  add(r.merged, "merged");
  add(r.conflicted, "conflicted");
  add(r.deletedLocally + r.deletedRemotely, "deleted");
  add(r.restored, "restored");
  add(r.foldersCreated, "folders", "folder");
  add(r.waiting, "waiting");
  add(r.retrying, "retrying");
  add(r.skipped, "stuck");
  add(r.ignored, "ignored");
  add(r.blocked, "in the way");
  return bits.length === 0 ? "up to date" : bits.join(", ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
