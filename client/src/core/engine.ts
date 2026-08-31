/**
 * The engine: everything that decides, and nothing that knows where files live.
 *
 * Structure follows Obsidian's: an orchestrator collaborating with a transport
 * that knows no policy, a filter that knows only paths, and a crypto provider
 * with no reference to the app. That
 * shape is why the same engine runs in their plugin and their headless client,
 * and it is why this one can run against a vault held in memory.
 *
 * Two properties this is built around, both from that reading:
 *
 *   - **Single flight.** One sync runs at a time, and requests to sync while one
 *     is running set a flag rather than starting a second. Two passes deciding
 *     about the same file from the same index is how a file gets uploaded twice
 *     or downloaded over itself.
 *   - **Retry and refuse are different.** A file that failed once should be tried
 *     again later; a file that can never work should not be tried forever. One
 *     work queue cannot tell those apart, which is why Obsidian keeps
 *     `fileRetry` and `skippedFiles` as separate tables and so does this.
 *
 * ## What the tests pin down
 *
 * Every one of sixteen deliberate breakages of this file is caught by two
 * engines converging through a real server. Three of them took a specific case
 * to catch, and those cases are worth knowing about because each one is a real
 * way to lose a note:
 *
 *   - Moving the ancestor when the two sides already agree. Nothing transfers,
 *     so it looks like a no-op; skip it and the next pair of edits merges
 *     against a version neither device ever had.
 *   - Recording the ancestor on the download itself. The line above would set it
 *     on the following pass anyway, so the two cover each other. The case that
 *     separates them is a user editing straight after a download, before any
 *     pass in which both sides still agree.
 *   - Uploading the conflict copy rather than waiting for the next scan to find
 *     it as a new file. The scan is a real backstop, and it is no use when the
 *     device that found the conflict syncs once and then stops: the other device
 *     downloads the winning version over its own text, and its own text is gone.
 *
 * None of the three is caught by asserting that two devices agree, which is
 * rule 10 of docs/philosophy.md in its natural habitat.
 */

import { looksLikeJson, looksLikeText, chunkBytes, chunkStream, sizesFor } from "./chunk.ts";
import {
  entryIsOurs,
  macEntry,
  openChunk,
  openPath,
  parentOf,
  sealChunks,
  sealPath,
  type SealedChunk,
  type VaultKeys,
} from "./crypto.ts";
import { conflictCopyPath, mergeText } from "./merge.ts";
import {
  decide,
  needsRehash,
  newEntry,
  observe,
  readyToSyncAgain,
  renamed,
  synced,
  type Action,
  type IndexEntry,
  type LocalState,
  type RemoteState,
} from "./index-state.ts";
import {
  MAX_BATCH_ENTRIES,
  type BatchEntry,
  type PutMeta,
  type ServerLimits,
  type Transport,
  type WireEntry,
} from "./transport.ts";
import { parents, type IndexStore, type Vault } from "./vault.ts";

/**
 * The identity of a file's content, as both sides can compute it.
 *
 * The server holds no plaintext hash, so equality of content is equality of the
 * chunk name sequence. Sealing is deterministic precisely so that works.
 *
 * An empty file gets a marker rather than the empty string, because the index
 * uses `synchash === ""` to mean "never synced". Without this an empty note that
 * had synced perfectly well would read as one that never had, and every pass
 * would treat it as new.
 */
export function contentId(chunkNames: readonly string[]): string {
  return chunkNames.length === 0 ? "-empty-" : chunkNames.join(",");
}

/**
 * Refuses a server that is behind the device talking to it.
 *
 * The docs present the client-ahead case as what catches a server restored from
 * an old backup or pointed at the wrong vault, and the refusal was implemented
 * only in the server, so it was absent exactly when it was needed: against a
 * server that is wrong. `ready.cursor` was parsed, logged, shown in the status
 * line, and never compared. Worse, the status line computed `behind` as
 * `max(0, server - local)`, so a server behind its clients displayed as zero
 * and read as being up to date.
 *
 * Its own function because a real server refuses this case first, so nothing
 * short of a lying transport reaches the check and the comparison is the part
 * worth testing.
 */
export function refuseIfBehind(serverCursor: number, ownCursor: number): void {
  if (serverCursor < ownCursor) {
    throw new Error(
      `this server is at version ${serverCursor} and this device has already seen ${ownCursor}: ` +
        `refusing to sync, because a server behind its own clients is a restored backup or the wrong vault`,
    );
  }
}

/**
 * What this device accepts whatever the server says it stores.
 *
 * The inbound guards read their bounds from `ready`, which is the party they
 * exist to bound. `numberOf()` maps a missing field to 0 and both guards read
 * `if (max > 0)`, so a server that merely omitted `perFileMax` and `maxChunks`
 * switched them both off, and a corrupt row did the same. Missing has to mean
 * this device's own ceiling, never no ceiling.
 *
 * These are the protocol's own maxima, from the server's store package, so
 * nothing a working server asks for is refused by them.
 */
export const OWN_LIMITS = {
  /** 256 MiB, the largest file any server will store. */
  perFileMax: 1 << 28,
  /** 65536, the most chunks any server records for one entry. */
  maxChunks: 1 << 16,
} as const;

/** The tighter of what the server asks for and what this device allows. */
export function boundedBy(fromServer: number, own: number): number {
  return fromServer > 0 ? Math.min(fromServer, own) : own;
}

/**
 * Refuses a batch entry that contradicts itself, before anything acts on it.
 *
 * Everything here except the sealed path arrives in the clear and unsigned, and
 * the server holds every sealed path in the vault, so it can name any file. The
 * protocol doc states this invariant and assigned it to the server: "a file
 * declaring a size names at least one chunk, since a size with no chunks is
 * byte-identical on the wire to an empty note." It was never mirrored here.
 *
 * Unmirrored, one frame emptied a note. `contentId([])` is `-empty-`,
 * `chunkNamesOf` gives it back as no chunks, nothing is fetched, and the
 * zero-length assembly is written over the file. Through `write` rather than
 * `remove`, so there is no trash copy, and the emptied note then goes to every
 * peer as an ordinary edit.
 *
 * A corrupt row does this as readily as a hostile server, which is the same
 * reason the size and chunk-count limits exist.
 */
function checkEntryShape(e: WireEntry): void {
  if (!e.folder && !e.deleted && e.size > 0 && e.chunks.length === 0) {
    throw new Error(
      `version ${e.uid} declares ${e.size} bytes and names no chunks, which cannot both be true`,
    );
  }
  if (e.chunks.length > 0 && (e.folder || e.deleted)) {
    const what = e.folder ? "a folder" : "a deletion";
    throw new Error(`version ${e.uid} is ${what} and names ${e.chunks.length} chunks`);
  }
}

/**
 * The chunk names back out of a content id.
 *
 * The id is the names joined, so this is not a lookup, it is punctuation. It
 * matters because a batch already carries the chunk list of every entry in it,
 * so a device that keeps the id keeps the list, and asking the server for it
 * again is a round trip spent learning something already known.
 *
 * A chunk name is hex, so the comma can never appear inside one.
 */
export function chunkNamesOf(id: string): string[] {
  return id === "" || id === "-empty-" ? [] : id.split(",");
}

export interface EngineOptions {
  readonly vault: Vault;
  readonly store: IndexStore;
  readonly keys: VaultKeys;
  readonly transport: Transport;
  readonly device: string;
  readonly vaultId: string;
  readonly token: string;
  /** The auth key to bind the vault to, if it has not been claimed yet. */
  readonly claim?: string;
  readonly now?: () => number;
  readonly log?: (message: string, ...rest: unknown[]) => void;
  /**
   * Called with the path being worked on, and undefined when a pass ends.
   *
   * Sending a large attachment is minutes of one await inside one pass, and
   * without this a shell has nothing to say for the whole of it: the status
   * it shows is the result of the *previous* pass, so working and idle look
   * exactly alike. That is rule 7 of docs/philosophy.md, two conditions that
   * must be told apart collapsed into one.
   *
   * A path rather than a percentage. What somebody wants to know is whether
   * it is doing something and what, and a byte counter for a file that is
   * one of forty in a pass answers a question nobody asked.
   */
  readonly onProgress?: (path: string | undefined) => void;
  /** Whether a path may be three-way merged. Defaults to text extensions. */
  readonly mergeable?: (path: string) => boolean;
  /**
   * Whether to hold back a file that was written moments ago.
   *
   * On by default, which is right for a client that keeps running. A one-shot
   * sync turns it off: deferring to a next pass that will never happen would
   * mean exiting successfully having skipped the file the user just saved.
   */
  readonly coalesceWrites?: boolean;
}

/** Overrides for a single pass. */
export interface SyncOptions {
  /**
   * Whether to hold back a file written moments ago, just for this pass.
   *
   * Defaults to whatever the engine was built with. A person choosing "sync
   * now" turns it off: they have said now, and reporting "up to date" while
   * the line they just typed sits unsent is the exact status rule 7 forbids.
   */
  readonly coalesceWrites?: boolean;
}

/**
 * What a sync did.
 *
 * Counted separately rather than summed, because rule 7 of
 * docs/philosophy.md is that a status which cannot distinguish the cases it
 * collapses is not a status. "12 files synced" hides whether anything conflicted.
 */
export interface SyncReport {
  uploaded: number;
  downloaded: number;
  merged: number;
  conflicted: number;
  deletedLocally: number;
  deletedRemotely: number;
  restored: number;
  foldersCreated: number;
  unchanged: number;
  /**
   * Files held back by the write debounce, which will go on the next pass.
   *
   * Its own counter rather than folded into `unchanged`, because rule 7 of
   * docs/philosophy.md is that a status collapsing cases it should distinguish
   * is not a status. "unchanged" for a file the user saved four seconds ago is
   * the exact lie that rule is about.
   */
  waiting: number;
  /** Files that failed and will be tried again. */
  retrying: number;
  /** Files that can never work and will not be tried again. */
  skipped: number;
  /**
   * Paths a file is standing in the way of.
   *
   * Its own counter rather than folded into `skipped`, whose label says a file
   * will not be tried again. These are tried every pass and cannot succeed
   * until somebody renames one of the two things that disagree, which is a
   * different thing to tell a person and rule 7 says to tell them apart.
   */
  blocked: number;
  /** Chunk bodies actually sent, and their size. The measure that matters. */
  chunksSent: number;
  bytesSent: number;
}

function emptyReport(): SyncReport {
  return {
    uploaded: 0,
    downloaded: 0,
    merged: 0,
    conflicted: 0,
    deletedLocally: 0,
    deletedRemotely: 0,
    restored: 0,
    foldersCreated: 0,
    unchanged: 0,
    waiting: 0,
    retrying: 0,
    skipped: 0,
    blocked: 0,
    chunksSent: 0,
    bytesSent: 0,
  };
}

interface Retry {
  count: number;
  error: string;
  /** Not before this time. */
  at: number;
}

export class Engine {
  private readonly entries = new Map<string, IndexEntry>();
  /** The server's newest word per plaintext path. */
  private readonly remote = new Map<string, RemoteState>();
  /** Plaintext paths with inbound work outstanding. */
  private readonly pending = new Set<string>();
  private readonly retries = new Map<string, Retry>();
  /** Paths that can never sync. Kept apart from retries on purpose. */
  /**
   * Paths written off, and what the file looked like when they were.
   *
   * The fingerprint is the point. "Permanent" describes the file, not the
   * path, and a file can be changed: somebody whose note is refused for being
   * too large shortens it. Without the fingerprint the path stayed written
   * off until the application restarted, and nothing said so.
   */
  private readonly skipped = new Map<string, { why: string; fingerprint: string }>();

  /**
   * Paths a file is standing in the way of, as of the last pass.
   *
   * Not written off, only noted: the condition belongs to the vault rather
   * than to the path, and it stops holding by itself when somebody renames
   * the file. Kept only so that the same complaint is not logged every pass.
   */
  private blocked = new Set<string>();

  /**
   * Set once a vault that advertised streaming failed at it. See `streamScan`:
   * the plugin's streaming is a URL the webview fetches, which is verified on
   * desktop and nowhere else.
   */
  private cannotStream = false;

  /** Writes waiting to go up together, and what they will cost to hold. */
  private outbox: Queued[] = [];
  private outboxBytes = 0;

  /** Versions waiting to come down together, and what they will cost to hold. */
  private inbox: Incoming[] = [];
  private inboxBytes = 0;

  /**
   * What the server said it would accept, kept so a download can be held to
   * it.
   *
   * The limits arrive at hello and were previously logged and dropped. They
   * bound what this device sends; nothing bounded what it would take. A chunk
   * list is a number the server chooses, and a device that fetches and buffers
   * however many are named runs out of memory on a corrupt row as readily as
   * on a hostile one.
   */
  /**
   * What the server said it will take, learned at the handshake.
   *
   * Readable because a shell has to be able to say why a file was written
   * off, and "too large" is only meaningful next to the number.
   */
  limits: ServerLimits | undefined;
  /** Sealed path to plaintext, so a path is unsealed once per session. */
  private readonly unsealed = new Map<string, string>();

  private cursor = 0;
  private syncing = false;
  private again = false;
  private started = false;

  constructor(private readonly opts: EngineOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private log(message: string, ...rest: unknown[]): void {
    this.opts.log?.(message, ...rest);
  }

  private mergeable(path: string): boolean {
    return (this.opts.mergeable ?? looksLikeText)(path);
  }

  /**
   * Chunk sizes for a file, against what this server said it would take.
   *
   * The server's ceiling was never passed. `sizesFor` takes it and defaults
   * to the client's own idea of a maximum, so a server advertising something
   * smaller was ignored and every chunk at the boundary was refused. Nothing
   * noticed because the two numbers happen to be the same, and because the
   * refusal only bites on data that does not compress.
   */
  private sizesFor(size: number, isText: boolean) {
    return sizesFor(size, isText, this.limits?.chunkMax);
  }

  private get coalesce(): boolean {
    return this.opts.coalesceWrites ?? true;
  }

  /** What this device knows, for a status line that describes the vault. */
  status(): {
    cursor: number;
    files: number;
    pending: number;
    retrying: number;
    skipped: number;
    syncing: boolean;
  } {
    let files = 0;
    for (const e of this.entries.values()) if (!e.folder) files++;
    return {
      cursor: this.cursor,
      files,
      pending: this.pending.size,
      retrying: this.retries.size,
      skipped: this.skipped.size,
      syncing: this.syncing,
    };
  }

  /**
   * Loads the index, opens the session, and drains the backlog.
   *
   * The cursor sent is this device's, from the index. Sending 0 instead would
   * work and would re-download the whole vault, and the server would refuse a
   * cursor it never issued, which is the case that catches a restored backup.
   */
  async start(): Promise<ServerLimits> {
    if (this.started) throw new Error("already started");
    this.started = true;

    const stored = await this.opts.store.load();
    if (stored) {
      this.cursor = stored.cursor;
      for (const [path, raw] of Object.entries(stored.entries)) {
        this.entries.set(path, { ...newEntry(path), ...(raw as object) });
      }
      for (const [path, raw] of Object.entries(stored.remote)) {
        this.remote.set(path, raw as RemoteState);
      }
      for (const path of stored.pending) this.pending.add(path);
      this.log("index loaded", {
        cursor: this.cursor,
        entries: this.entries.size,
        pending: this.pending.size,
      });
    }

    const limits = await this.opts.transport.hello({
      vault: this.opts.vaultId,
      token: this.opts.token,
      device: this.opts.device,
      cursor: this.cursor,
      ...(this.opts.claim !== undefined ? { claim: this.opts.claim } : {}),
    });
    // The docs present the client-ahead case as what catches a server
    // restored from an old backup or pointed at the wrong vault, and the
    // refusal lived only in the server, so it was missing exactly when it
    // was needed. A server behind this device would answer no batches, and
    // the status line reported `behind` clamped at zero, so it looked like
    // being up to date.
    refuseIfBehind(limits.cursor, this.cursor);
    this.limits = limits;
    this.log("connected", limits);
    return limits;
  }

  /**
   * Takes a batch from the transport into the remote index.
   *
   * Wired to the transport's `onBatch`. The transport has already checked that
   * the range continues this device's cursor, so what is left here is unsealing
   * the paths and remembering that these paths have work outstanding.
   *
   * A batch with no entries is this device's own write coming back: it carries
   * the cursor advance and nothing to apply.
   */
  /**
   * Authenticates one outgoing entry.
   *
   * Everything a receiving device acts on, signed with a key the server does
   * not have, plus the version this was written on top of. The uid is not in
   * it: the server assigns uids and ordering the log is its job, which this
   * does not try to take. What it settles is that the server cannot invent an
   * entry, alter one, or move one file's chunk list onto another file.
   */
  private async authFor(
    entry: { path: string; meta: PutMeta; names: readonly string[] },
    builtOn: string,
  ): Promise<{ mac: string; parent: string }> {
    const parent = await parentOf(builtOn);
    const mac = await macEntry(this.opts.keys, {
      path: entry.path,
      size: entry.meta.size,
      ctime: entry.meta.ctime,
      mtime: entry.meta.mtime,
      folder: entry.meta.folder ?? false,
      deleted: entry.meta.deleted ?? false,
      prev: entry.meta.prev,
      chunks: entry.names,
      parent,
    });
    return { mac, parent };
  }

  async acceptBatch(batch: { from: number; to: number; entries: WireEntry[] }): Promise<void> {
    // Staged, then committed once every entry has unsealed and passed its
    // checks. Applied entry by entry, a batch that failed part way through
    // left the entries before the failure recorded and no way to undo them,
    // and `save()` persists `remote` and `pending`, so they survived the
    // session dying. `deleteLocal` needs no server, so a batch of
    // [forged deletion, entry sealed under another vault's key] applied the
    // deletion on the next pass while the connection died looking like a
    // misconfiguration. "The session ended safely" is not "nothing was
    // applied" unless the state is committed together.
    // Verified and unsealed as two passes over the batch, not one crypto
    // call at a time.
    //
    // Both are WebCrypto, both are per entry, and neither depends on the
    // one before it. Serially a 2000 entry catch-up spent 25.7 ms on the
    // authenticators and 25.0 ms opening paths; together those are 11.5 ms
    // and 8.4 ms. The staging map already commits at the end, so checking
    // the whole batch before touching anything is the same all-or-nothing
    // it already had.
    const facts = batch.entries.map((e) => ({
      path: e.path,
      size: e.size,
      ctime: e.ctime,
      mtime: e.mtime,
      folder: e.folder,
      deleted: e.deleted,
      prev: e.prev,
      chunks: e.chunks,
      // A parent of "" is a real value, so a server omitting the field
      // means the same thing. A mac cannot be defaulted that way: an
      // absent one fails, which is the point.
      parent: e.parent ?? "",
    }));
    const ours = await Promise.all(
      facts.map((f, i) => entryIsOurs(this.opts.keys, f, batch.entries[i]!.mac)),
    );
    const forged = ours.indexOf(false);
    if (forged >= 0) {
      throw new Error(
        `version ${batch.entries[forged]!.uid} is not authenticated by this vault's key, ` +
          `so nothing that holds the key wrote it`,
      );
    }
    for (const e of batch.entries) checkEntryShape(e);

    const paths = await Promise.all(batch.entries.map((e) => this.plaintextPath(e.path)));
    const olds = await Promise.all(
      batch.entries.map((e) => (e.prev ? this.plaintextPath(e.prev) : undefined)),
    );

    const staged = new Map<string, RemoteState>();
    for (let at = 0; at < batch.entries.length; at++) {
      const e = batch.entries[at]!;
      const path = paths[at]!;
      staged.set(path, {
        uid: e.uid,
        folder: e.folder,
        deleted: e.deleted,
        mtime: e.mtime,
        size: e.size,
        hash: contentId(e.chunks),
      });

      if (e.prev) {
        // A rename travels as one operation, so nothing tells this
        // device the old path is gone except this field. Recorded as a
        // deletion of the old path, which is what it is, and which lets
        // the decision table handle the awkward case for free: if the
        // old path was edited here since the last sync, a deletion loses
        // to an edit and the file is kept and re-uploaded.
        const old = olds[at]!;
        staged.set(old, {
          uid: e.uid,
          folder: false,
          deleted: true,
          mtime: e.mtime,
          size: 0,
          hash: "",
        });
      }
    }

    for (const [path, state] of staged) {
      this.remote.set(path, state);
      this.pending.add(path);
    }
    this.cursor = batch.to;
  }

  private async plaintextPath(sealed: string): Promise<string> {
    const known = this.unsealed.get(sealed);
    if (known !== undefined) return known;
    const plain = await openPath(this.opts.keys, sealed);
    this.unsealed.set(sealed, plain);
    return plain;
  }

  /**
   * Runs one reconciliation pass, and only one.
   *
   * A request arriving while a pass is running sets a flag and the pass runs
   * again when it finishes, which is Obsidian's `requestSync`. Starting a
   * second pass concurrently would have two of them deciding about the same
   * file from the same index.
   */
  async sync(opts: SyncOptions = {}): Promise<SyncReport> {
    if (this.syncing) {
      this.again = true;
      return emptyReport();
    }
    this.syncing = true;
    try {
      let report = await this.pass(opts);
      while (this.again) {
        this.again = false;
        const next = await this.pass(opts);
        report = add(report, next);
      }
      return report;
    } finally {
      this.syncing = false;
    }
  }

  private async pass(opts: SyncOptions = {}): Promise<SyncReport> {
    const report = emptyReport();
    const now = this.now();
    const coalesce = opts.coalesceWrites ?? this.coalesce;

    // Both queues empty at the end of every pass that returns. One that
    // threw on its way out leaves them full, and carrying that into the next
    // pass would commit those writes against a report nobody reads, so the
    // pass that did the work would say it did none and `settle` would stop.
    //
    // Dropping them is safe and is the reason this is a discard rather than
    // a flush. Nothing queued was acknowledged, so no entry was marked
    // synced and no file was written; reconciliation sees the same
    // divergence again and queues the same work.
    if (this.outbox.length > 0 || this.inbox.length > 0) {
      this.log("a pass ended early, discarding what it had queued", {
        writes: this.outbox.length,
        reads: this.inbox.length,
      });
      this.outbox = [];
      this.outboxBytes = 0;
      this.inbox = [];
      this.inboxBytes = 0;
    }

    // 1. What the filesystem says. The index's cache means an unchanged file
    //    costs one stat, so a full pass over a large vault is affordable and
    //    there is no need to track dirtiness separately.
    const stats = await this.opts.vault.list();
    const onDisk = new Map(stats.map((s) => [s.path, s]));
    for (const stat of stats) {
      const entry = this.entryFor(stat.path);
      observe(entry, stat);
    }

    // Paths that are files, so a path whose parent is one can be spotted
    // before anything tries to create a folder there. A real filesystem
    // answers ENOTDIR, which is not a condition that improves with retrying,
    // and the retry is where this used to spend the rest of the session.
    const filePaths = new Set<string>();
    for (const [path, stat] of onDisk) {
      if (!stat.folder) filePaths.add(path);
    }
    const nowBlocked = new Set<string>();

    // 2. Every path either side knows about.
    const paths = new Set<string>([
      ...onDisk.keys(),
      ...this.entries.keys(),
      ...this.remote.keys(),
    ]);

    for (const path of [...paths].sort()) {
      const skip = this.skipped.get(path);
      if (skip) {
        if (fingerprintOf(this.entries.get(path)) === skip.fingerprint) {
          report.skipped++;
          continue;
        }
        // Changed since it was written off. Whatever was wrong with it
        // may not be any more, and the only way to find out is to try.
        this.skipped.delete(path);
        this.log("skipped file changed, trying again", path);
      }
      const blockedBy = parents(path).find((ancestor) => filePaths.has(ancestor));
      if (blockedBy !== undefined && !onDisk.has(path)) {
        // Something upstream is a file where this path needs a folder.
        // Nothing can be written here until somebody renames one of
        // them, and a real filesystem answers ENOTDIR, which does not
        // improve with retrying.
        //
        // Worked out fresh every pass rather than remembered. There is
        // no local file here to notice a change in, so a remembered
        // refusal would have nothing to clear it: the first version of
        // this kept the path written off after the blocker was renamed
        // away, and the note never arrived.
        nowBlocked.add(path);
        if (!this.blocked.has(path)) {
          this.log("cannot be both", path, `${blockedBy} is a file here and a folder elsewhere`);
        }
        report.blocked++;
        continue;
      }

      const retry = this.retries.get(path);
      if (retry && retry.at > now) {
        report.retrying++;
        continue;
      }
      try {
        this.opts.onProgress?.(path);
        await this.reconcile(path, onDisk.get(path), report, now, coalesce);
        this.retries.delete(path);
      } catch (err) {
        this.recordFailure(path, err, report);
      }
    }

    // Whatever is still queued moves now. Until these return, no write in
    // this pass has been acknowledged and no queued file is on disk.
    await this.fill(report);
    await this.applyDeletes(report);
    await this.flush(report);

    this.opts.onProgress?.(undefined);

    // Replaced rather than added to, so a path stops being blocked the
    // moment the file in its way is gone.
    this.blocked = nowBlocked;

    this.prune(onDisk);
    // Before the index, always. The index names notes, so it must not be
    // durable ahead of them; a vault that defers any part of a write makes it
    // durable here. Rule 3 in another form.
    await this.opts.vault.flush?.();
    await this.save();
    return report;
  }

  private entryFor(path: string): IndexEntry {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = newEntry(path);
      this.entries.set(path, entry);
    }
    return entry;
  }

  private async reconcile(
    path: string,
    stat: { folder: boolean; mtime: number; ctime: number; size: number } | undefined,
    report: SyncReport,
    now: number,
    coalesce: boolean,
  ): Promise<void> {
    const entry = this.entryFor(path);
    const remote = this.remote.get(path);

    // Checked from the stat, before the file is opened. The server refuses
    // an oversized file at the put, which is correct and far too late: by
    // then the client has read it, chunked it and sealed it, and a file just
    // over the limit costs several times its own size in memory to produce
    // an error that its size alone predicted. On a phone that is not a
    // wasted pass, it is the end of the process.
    const perFileMax = this.limits?.perFileMax ?? 0;
    if (stat && !stat.folder && perFileMax > 0 && stat.size > perFileMax) {
      this.recordFailure(path, tooLarge(stat.size, perFileMax), report);
      return;
    }

    let local: LocalState | undefined;
    let sealed: Scanned | undefined;
    if (stat) {
      if (!stat.folder && needsRehash(entry, Math.ceil(stat.mtime), stat.size)) {
        // The only place a file is read for its content, and only when
        // the stat says it moved.
        sealed = await this.rehash(entry, path, stat.size);
      }
      local = { folder: stat.folder, mtime: entry.mtime, size: entry.size, hash: entry.hash };
    }

    const action = decide({ local, remote, index: entry, mergeable: this.mergeable(path) });

    if (
      coalesce &&
      action.kind !== "nothing" &&
      local &&
      !stat?.folder &&
      !readyToSyncAgain(entry, now)
    ) {
      // Written very recently. Obsidian's size-scaled debounce: somebody
      // typing generates a save every few seconds, and acting on each one
      // costs more than waiting does.
      //
      // Turned off by a client that syncs once and exits, where there is no
      // next pass to defer to and the person asking has just said "now".
      report.waiting++;
      return;
    }

    await this.act(path, action, entry, local, remote, report, sealed);
    this.pending.delete(path);
  }

  /**
   * Chunks and seals a file, filling in the index's content cache.
   *
   * The sealed bodies come back so that an upload deciding to send this file
   * does not read, chunk and seal it all over again. On a first sync that
   * second pass was half of everything the client did: seventeen megabytes
   * took thirty seconds against four seconds of wire, and the four round
   * trips it now costs made the duplication the whole cost.
   *
   * Only for files small enough to hold. Above that the bodies are dropped
   * for the reason `planUpload` explains, and it does its own work.
   */
  private async rehash(entry: IndexEntry, path: string, knownSize?: number): Promise<Scanned> {
    const streamed = await this.streamScan(entry, path, knownSize);
    if (streamed) return streamed;

    const bytes = await this.opts.vault.read(path);
    const isText = this.mergeable(path);
    const pieces = [...chunkBytes(bytes, this.sizesFor(bytes.length, isText), isText)];
    const parts = pieces.map((c) => c.bytes);

    // Small enough to keep: seal it all, and the upload that is about to
    // want the bodies has them.
    if (bytes.length <= KEEP_SEALED_BELOW) {
      const sealed = await sealChunks(this.opts.keys, parts);
      entry.chunks = sealed.map((c) => c.name);
      entry.hash = contentId(entry.chunks);
      entry.size = bytes.length;
      return { bytes, pieces, names: entry.chunks, sealed };
    }

    // Too big to keep the bodies even for a moment, so only the names are
    // taken and the sealed copies are dropped a window at a time.
    entry.chunks = await this.namesOf(parts);
    entry.hash = contentId(entry.chunks);
    entry.size = bytes.length;
    return { bytes, pieces, names: entry.chunks };
  }

  /**
   * Names a large file without ever holding it, when the vault can stream.
   *
   * The buffered path holds the whole file from the moment it is read until
   * the last chunk has gone, because a wanted chunk is sealed again from the
   * bytes in hand. That is the whole of why a 256 MiB attachment costs most of
   * a gigabyte: not the sending, the holding.
   *
   * With blocks and ranges the file is read twice from disk instead: once to
   * cut and name it, keeping one chunk at a time, and again for the chunks the
   * server actually asks for. Two reads of a disk against most of a gigabyte
   * of memory is not a close trade.
   *
   * Returns undefined when the vault cannot do it, or when the file is small
   * enough that holding it is cheaper than reading it twice. Obsidian's
   * adapter is the first case: it has `readBinary` and nothing beside it.
   */
  private async streamScan(
    entry: IndexEntry,
    path: string,
    knownSize: number | undefined,
  ): Promise<Scanned | undefined> {
    const vault = this.opts.vault;
    if (!vault.readBlocks || !vault.readRange || this.cannotStream) return undefined;
    if (knownSize === undefined || knownSize <= KEEP_SEALED_BELOW) return undefined;

    try {
      return await this.streamed(entry, path, knownSize);
    } catch (err) {
      // A vault that offers these methods and cannot deliver. The Obsidian
      // adapter reaches the file through a URL the webview can fetch, and
      // that is verified on desktop and unverified anywhere else, so a
      // failure here is read as "not on this platform" rather than as a
      // failure of the file.
      //
      // Remembered, because otherwise every large file in the vault would
      // discover it again, one at a time.
      this.cannotStream = true;
      this.log("streaming is not available here, reading whole files instead", path, {
        why: (err as Error).message,
      });
      return undefined;
    }
  }

  private async streamed(entry: IndexEntry, path: string, knownSize: number): Promise<Scanned> {
    const vault = this.opts.vault;
    const isText = this.mergeable(path);
    const names: string[] = [];
    const spans: { start: number; end: number }[] = [];
    let size = 0;

    for await (const piece of chunkStream(
      vault.readBlocks!(path),
      this.sizesFor(knownSize, isText),
      isText,
    )) {
      const sealed = await sealChunks(this.opts.keys, [piece.bytes]);
      names.push(sealed[0]!.name);
      spans.push({ start: piece.offset, end: piece.offset + piece.bytes.length });
      size += piece.bytes.length;
    }

    entry.chunks = names;
    entry.hash = contentId(names);
    entry.size = size;
    return { names, spans, path, size };
  }

  /** Chunk names without keeping the bodies. See `sealedNames`. */
  private namesOf(parts: Uint8Array[]): Promise<string[]> {
    return sealedNames(this.opts.keys, parts);
  }

  private async act(
    path: string,
    action: Action,
    entry: IndexEntry,
    local: LocalState | undefined,
    remote: RemoteState | undefined,
    report: SyncReport,
    /** What the rehash read and cut, if this file was just scanned. */
    sealed?: Scanned,
  ): Promise<void> {
    switch (action.kind) {
      case "nothing":
        report.unchanged++;
        // Two sides agreeing *is* a sync: the ancestor moves, or the next
        // divergence would merge against a version neither side has.
        if (local && remote && !remote.deleted && local.hash === remote.hash) {
          synced(entry, local.hash, entry.chunks, remote.uid, this.now());
        }
        return;

      case "upload":
        await this.upload(path, entry, report, true, sealed);
        return;

      case "download":
      case "restoreLocal": {
        if (!remote) return;
        await this.receive(path, entry, remote, action.kind, action.why, report);
        return;
      }

      case "createLocalFolder":
        await this.opts.vault.mkdir(path);
        entry.folder = true;
        if (remote) synced(entry, "", [], remote.uid, this.now());
        report.foldersCreated++;
        return;

      case "clash":
        // Written off rather than retried. Trying again cannot help
        // while both devices disagree about what this path is, and the
        // alternative was one direction retrying an impossible mkdir
        // for ever while the other silently ignored the file.
        //
        // Neither side is touched. Renaming somebody's file to admit a
        // folder is a larger intervention than telling them the two
        // disagree, and only they know which they meant. The skip
        // clears by itself once the file changes, which renaming it
        // does.
        this.skipped.set(path, {
          why: `${action.why}. Rename one of them, and it will sync.`,
          fingerprint: fingerprintOf(entry),
        });
        report.skipped++;
        this.log("cannot be both", path, action.why);
        return;

      case "deleteLocal":
        // Held until the pass has written everything it is going to.
        //
        // Rule 3 argues for this on its own: never delete until a
        // verified copy exists elsewhere. A move makes it concrete. The
        // old path is deleted and the new one downloaded in the same
        // pass, and deleting first threw away the only local copy of
        // bytes the pass was about to write back, so the file came over
        // the wire instead. Deferring costs nothing and means there is
        // never a moment where neither name holds the note.
        this.pendingDeletes.push({ path, why: action.why });
        return;

      case "deleteRemote": {
        // Fixed once, because it is signed and then sent: calling now()
        // twice would sign one timestamp and send another.
        const deletedAt = this.now();
        await this.queue(
          {
            path,
            size: 0,
            entry: {
              path: await this.sealedPath(path),
              meta: { size: 0, ctime: 0, mtime: deletedAt, deleted: true },
              names: [],
              ...(await this.authFor(
                {
                  path: await this.sealedPath(path),
                  meta: { size: 0, ctime: 0, mtime: deletedAt, deleted: true },
                  names: [],
                },
                entry.synchash,
              )),
            },
            bodyOf: noBodies,
            commit: (uid) => {
              // Recorded before the entry is forgotten. This
              // device's own writes come back with no payload, so
              // nothing else will ever tell it the deletion
              // happened, and a stale entry here reads on the next
              // pass as a file to download back.
              this.remote.set(path, {
                uid,
                folder: false,
                deleted: true,
                mtime: this.now(),
                size: 0,
                hash: "",
              });
              this.entries.delete(path);
              report.deletedRemotely++;
              this.log("deleted on the server", path, action.why);
            },
          },
          report,
        );
        return;
      }

      case "merge":
        await this.merge(path, entry, remote, report);
        return;

      case "conflict":
        await this.conflict(path, entry, remote, report, action.why);
        return;
    }
  }

  /**
   * Queues a file to go up with the next batch.
   *
   * `count` is whether committing it adds to `report.uploaded`. A merge and a
   * conflict copy both upload, and both are already counted as what they are.
   */
  private async upload(
    path: string,
    entry: IndexEntry,
    report: SyncReport,
    count = false,
    /**
     * What the pass already read and cut for this exact content. Passed
     * only where the file has not been touched since: a merge rewrites it,
     * so a merge scans again.
     */
    sealed?: Scanned,
  ): Promise<void> {
    if (entry.folder) {
      await this.queue(
        {
          path,
          size: 0,
          entry: {
            path: await this.sealedPath(path),
            meta: { size: 0, ctime: 0, mtime: 0, folder: true },
            names: [],
            // A folder has no content and so no lineage.
            ...(await this.authFor(
              {
                path: await this.sealedPath(path),
                meta: { size: 0, ctime: 0, mtime: 0, folder: true },
                names: [],
              },
              "",
            )),
          },
          bodyOf: noBodies,
          commit: (uid) => {
            synced(entry, "", [], uid, this.now());
            this.remote.set(path, {
              uid,
              folder: true,
              deleted: false,
              mtime: 0,
              size: 0,
              hash: "",
            });
            if (count) report.uploaded++;
          },
        },
        report,
      );
      return;
    }

    const plan = await this.planUpload(entry, path, sealed);
    // Read now, applied later. `entry` is mutable and the commit runs after
    // the flush, so what gets recorded has to be what actually went up.
    const hash = entry.hash;
    const chunks = [...entry.chunks];
    const size = entry.size;
    const mtime = entry.mtime;

    await this.queue(
      {
        path,
        size,
        entry: {
          path: await this.sealedPath(path),
          meta: {
            size,
            ctime: entry.ctime,
            mtime,
            ...(entry.prev ? { prev: await this.sealedPath(entry.prev) } : {}),
          },
          names: plan.names,
          // Built on whatever this device last had in sync, which is
          // what lets a receiver tell a new version from a replayed
          // old one.
          ...(await this.authFor(
            {
              path: await this.sealedPath(path),
              meta: {
                size,
                ctime: entry.ctime,
                mtime,
                ...(entry.prev ? { prev: await this.sealedPath(entry.prev) } : {}),
              },
              names: plan.names,
            },
            entry.synchash,
          )),
        },
        bodyOf: plan.bodyOf,
        commit: (uid) => {
          synced(entry, hash, chunks, uid, this.now());
          // Record what the server now holds, so the next pass sees
          // agreement rather than deciding to upload again.
          this.remote.set(path, {
            uid,
            folder: false,
            deleted: false,
            mtime,
            size,
            hash,
          });
          if (count) report.uploaded++;
          this.log("uploaded", path);
        },
      },
      report,
    );
  }

  /**
   * Adds a write to the outbox, flushing when the batch is full.
   *
   * Two bounds, because they guard different things. The count is the
   * server's, and it is what makes a vault of notes one exchange instead of
   * hundreds. The byte bound is this device's: a queued file pins roughly its
   * own size in memory until the batch goes, either as sealed bodies or as the
   * plaintext its offsets point into, so batching two hundred and fifty-six
   * attachments would hold all of them at once. Notes batch to the count;
   * attachments flush almost every file, which is what this did before.
   */
  private async queue(q: Queued, report: SyncReport): Promise<void> {
    this.outbox.push(q);
    this.outboxBytes += q.size;
    if (this.outbox.length >= MAX_BATCH_ENTRIES || this.outboxBytes >= BATCH_BYTES) {
      await this.flush(report);
    }
  }

  /**
   * Sends the outbox as one exchange and applies what committed.
   *
   * Nothing here is recorded until the server has said so. An entry it refuses
   * goes through the same failure path a single put's refusal did, and the
   * rest of the batch is unaffected.
   */
  private async flush(report: SyncReport): Promise<void> {
    if (this.outbox.length === 0) return;
    const batch = this.outbox;
    this.outbox = [];
    this.outboxBytes = 0;

    // One producer per chunk name. Two notes sharing a chunk means the
    // server asks once, and it must not matter which of them is asked.
    const producers = new Map<string, (name: string) => Promise<Uint8Array>>();
    for (const q of batch) {
      for (const name of q.entry.names) {
        if (!producers.has(name)) producers.set(name, q.bodyOf);
      }
    }

    let out;
    try {
      out = await this.opts.transport.putMany(
        batch.map((q) => q.entry),
        async (name) => {
          const produce = producers.get(name);
          if (!produce) throw new Error(`server asked for ${name}, which no queued file contains`);
          return produce(name);
        },
      );
    } catch (err) {
      // The exchange itself failed, so nothing in it committed. Every path
      // in the batch is retried, exactly as it would have been alone.
      for (const q of batch) this.recordFailure(q.path, err, report);
      return;
    }

    report.chunksSent += out.uploaded;
    report.bytesSent += out.bytes;
    for (let i = 0; i < batch.length; i++) {
      const q = batch[i]!;
      const result = out.results[i]!;
      if (result.error) {
        this.recordFailure(q.path, result.error, report);
        continue;
      }
      q.commit(result.uid);
    }
  }

  /** The sealed chunks for a file, re-sealing only if the cache cannot serve. */
  /**
   * Works out what a file's chunks are called, and how to produce one.
   *
   * The names have to be known before the put is sent, because the server
   * answers with the subset it wants, so a file is chunked and sealed in full
   * either way. What changes is whether the sealed bytes are then *kept*.
   *
   * Keeping them all is what this did, and for a 256 MiB attachment, which is
   * the size the server advertises it will take, it meant 512 MiB live at
   * once: the file and a sealed copy of it. Measured rather than guessed, and
   * on a phone that is not a spike but the end of the process.
   *
   * So above a threshold the bodies are dropped and only their offsets kept,
   * and a wanted chunk is sealed again from the file still in hand. Sealing
   * is deterministic, so the second answer is the first one. It costs the
   * sealing twice for the chunks the server actually asks for, and takes the
   * peak from twice the file to the file plus one chunk.
   *
   * Below the threshold nothing is dropped, because almost every file is a
   * note and re-sealing a note to save a few kilobytes is a worse trade.
   */
  private async planUpload(entry: IndexEntry, path: string, fresh?: Scanned): Promise<UploadPlan> {
    // The scan that decided this file changed already read it, cut it and
    // sealed it. Doing that again was the single largest cost of sending a
    // large attachment: a 64 MiB file was read twice, chunked twice and
    // sealed twice, and the garbage from both passes was live at once.
    const scan = fresh ?? (await this.scan(entry, path));

    if (scan.sealed) {
      const byName = new Map(scan.sealed.map((c) => [c.name, c.bytes]));
      return {
        names: scan.names,
        bodyOf: async (name) => {
          const body = byName.get(name);
          if (!body) throw new Error(`no sealed body for ${name} of ${path}`);
          return body;
        },
      };
    }

    // Offsets only, for a file too large to hold sealed. A wanted chunk is
    // sealed again, which is deterministic and so gives back exactly what
    // was named: either from the bytes still in hand, or by reading the
    // range back off the disk if the file was never held at all.
    const keys = this.opts.keys;
    const vault = this.opts.vault;

    if (scan.spans) {
      const spanOf = new Map(scan.names.map((name, i) => [name, scan.spans[i]!]));
      return {
        names: scan.names,
        bodyOf: async (name) => {
          const span = spanOf.get(name);
          if (!span) throw new Error(`no chunk named ${name} in ${path}`);
          const range = await vault.readRange!(scan.path, span.start, span.end);
          const again = await sealChunks(keys, [range]);
          // Checked against the name it was promised under. The file
          // was read to name it and is being read again to send it,
          // so an edit in between would otherwise put bytes on the
          // wire under a name that is not theirs. The server would
          // catch that and end the session; caught here it is one
          // file to try again next pass.
          if (again[0]!.name !== name) {
            throw new Error(`${path} changed while it was being sent, so it was not sent`);
          }
          return again[0]!.bytes;
        },
      };
    }

    const spanOf = new Map<string, { start: number; end: number }>();
    for (let i = 0; i < scan.names.length; i++) {
      const piece = scan.pieces[i]!;
      spanOf.set(scan.names[i]!, { start: piece.offset, end: piece.offset + piece.bytes.length });
    }
    const bytes = scan.bytes;
    return {
      names: scan.names,
      bodyOf: async (name) => {
        const span = spanOf.get(name);
        if (!span) throw new Error(`no chunk named ${name} in ${path}`);
        const again = await sealChunks(keys, [bytes.subarray(span.start, span.end)]);
        return again[0]!.bytes;
      },
    };
  }

  /**
   * Reads and cuts a file, for an upload that arrived without a fresh scan.
   *
   * A merge and a conflict copy both rewrite the file before uploading it, so
   * whatever the pass scanned is stale by the time they are done.
   */
  private scan(entry: IndexEntry, path: string): Promise<Scanned> {
    return this.rehash(entry, path);
  }

  /**
   * Downloads one version, in one round trip.
   *
   * It used to take three: ask the server for the chunk list, fetch the
   * bodies, then ask for the same chunk list again to fill the cache. Both
   * questions were already answered. A batch carries the chunk list of every
   * entry in it, and `remote.hash` *is* that list, so the only thing the
   * server still has to be asked for is the bodies.
   *
   * On a fast link that was invisible. At four hundred milliseconds it was
   * two thirds of the time a download took.
   */
  /**
   * Queues a version to come down with the next fetch.
   *
   * A download was one round trip, which for two hundred notes was two
   * hundred of them, and on a slow link that was most of the sync. The chunk
   * names are already known, because the batch that announced the version
   * carried them, so many files' names can go up in one ask and their bodies
   * come back in one stream.
   */
  private async receive(
    path: string,
    entry: IndexEntry,
    remote: RemoteState,
    kind: "download" | "restoreLocal",
    why: string,
    report: SyncReport,
  ): Promise<void> {
    const chunks = chunkNamesOf(remote.hash);
    this.checkChunkCount(remote.uid, chunks.length);

    this.inbox.push({ path, entry, remote, chunks, kind, why });
    this.inboxBytes += remote.size;
    if (this.inbox.length >= MAX_BATCH_ENTRIES || this.inboxBytes >= BATCH_BYTES) {
      await this.fill(report);
    }
  }

  /**
   * Fetches every queued version's chunks in one ask and writes the files.
   *
   * The names are deduplicated across the batch, so two notes that share a
   * chunk cost one body, and a file whose chunks the server cannot serve
   * fails alone rather than taking the batch with it.
   */
  private async fill(report: SyncReport): Promise<void> {
    if (this.inbox.length === 0) return;
    const batch = this.inbox;
    this.inbox = [];
    this.inboxBytes = 0;

    // Bytes this device already holds are not worth asking for again.
    //
    // A move is the case that matters. Chunk names are hashes of
    // ciphertext, so moving a file costs the sender nothing: the server
    // already has every chunk and only metadata travels. The receiver had
    // no such luck, and downloaded the whole file back over a name it was
    // already storing under. Moving one folder of attachments re-pulled all
    // of it, on every other device.
    const local = new Map<Incoming, string>();
    const byContent = this.heldByContent();
    for (const d of batch) {
      const from = byContent.get(contentId(d.chunks));
      if (from !== undefined && from !== d.path) local.set(d, from);
    }

    const wanted: string[] = [];
    const seen = new Set<string>();
    for (const d of batch) {
      if (local.has(d)) continue;
      for (const name of d.chunks) {
        if (!seen.has(name)) {
          seen.add(name);
          wanted.push(name);
        }
      }
    }

    const held = new Map<string, Uint8Array>();
    if (wanted.length > 0) {
      try {
        const bodies = await this.opts.transport.fetch(wanted);
        for (let i = 0; i < wanted.length; i++) held.set(wanted[i]!, bodies[i]!);
      } catch (err) {
        // The fetch failed, so no file in it arrived. Each is retried,
        // exactly as it would have been on its own.
        for (const d of batch) this.recordFailure(d.path, err, report);
        return;
      }
    }

    for (const d of batch) {
      try {
        const from = local.get(d);
        if (from !== undefined && (await this.landFromLocal(d, from))) {
          if (d.kind === "download") report.downloaded++;
          else report.restored++;
          this.log(d.kind, d.path, `${d.why}, from ${from} without asking`);
          continue;
        }
        if (from !== undefined) {
          // The local copy did not prove out, so ask for it after all.
          // Rare, and it costs one extra round trip rather than a file.
          await this.land(d, await this.fetchFor(d));
        } else {
          await this.land(d, held);
        }
        if (d.kind === "download") report.downloaded++;
        else report.restored++;
        this.log(d.kind, d.path, d.why);
      } catch (err) {
        this.recordFailure(d.path, err, report);
      }
    }
  }

  /**
   * The local deletions this pass decided on, applied once its writes are done.
   *
   * A path is either deleted or written in one pass, never both, because
   * `decide` returns one action for it, so nothing here can undo a download.
   */
  private pendingDeletes: { path: string; why: string }[] = [];

  private async applyDeletes(report: SyncReport): Promise<void> {
    const deletes = this.pendingDeletes;
    this.pendingDeletes = [];
    for (const { path, why } of deletes) {
      try {
        await this.opts.vault.remove(path);
        this.entries.delete(path);
        report.deletedLocally++;
        this.log("deleted locally", path, why);
      } catch (err) {
        this.recordFailure(path, err, report);
      }
    }
  }

  /** Every path this device holds, by the content it holds, newest wins. */
  private heldByContent(): Map<string, string> {
    const by = new Map<string, string>();
    for (const [path, entry] of this.entries) {
      if (entry.folder || entry.hash === "" || entry.hash === "-empty-") continue;
      by.set(entry.hash, path);
    }
    return by;
  }

  /** The chunks for one entry, asked for on their own. */
  private async fetchFor(d: Incoming): Promise<Map<string, Uint8Array>> {
    const bodies = await this.opts.transport.fetch([...d.chunks]);
    const held = new Map<string, Uint8Array>();
    d.chunks.forEach((name, i) => held.set(name, bodies[i]!));
    return held;
  }

  /**
   * Writes a version from a copy this device already has, or declines to.
   *
   * Declining is the important half. The index says this path holds that
   * content, and the index can be out of date: the file may have been edited
   * between the scan and here. So the bytes are re-chunked and re-sealed and
   * the names compared, which is exact rather than trusting: sealing is
   * deterministic, so identical content gives identical names, and that is
   * the same property deduplication is built on.
   *
   * A false negative costs one round trip, which is what the old code did
   * every time. A false positive would write the wrong bytes into somebody's
   * note, so there is no version of this worth guessing at.
   */
  private async landFromLocal(d: Incoming, from: string): Promise<boolean> {
    let bytes: Uint8Array;
    try {
      bytes = await this.opts.vault.read(from);
    } catch {
      return false;
    }
    if (bytes.length !== d.remote.size) return false;

    const isText = this.mergeable(from);
    const parts = [...chunkBytes(bytes, this.sizesFor(bytes.length, isText), isText)].map(
      (c) => c.bytes,
    );
    const names = (await sealChunks(this.opts.keys, parts)).map((c) => c.name);
    if (contentId(names) !== contentId(d.chunks)) return false;

    await this.opts.vault.write(d.path, bytes, { mtime: d.remote.mtime, ctime: d.remote.mtime });
    observe(d.entry, {
      folder: false,
      mtime: d.remote.mtime,
      ctime: d.remote.mtime,
      size: bytes.length,
    });
    d.entry.chunks = [...d.chunks];
    d.entry.hash = contentId(d.chunks);
    d.entry.size = bytes.length;
    synced(d.entry, d.entry.hash, d.entry.chunks, d.remote.uid, this.now());
    return true;
  }

  /** Writes one queued version from bodies already in hand. */
  private async land(d: Incoming, held: Map<string, Uint8Array>): Promise<void> {
    const bodies = d.chunks.map((name) => {
      const body = held.get(name);
      if (!body) throw new Error(`the server did not send ${name}, which ${d.path} is made of`);
      return body;
    });
    const content = await this.assemble(d.remote.uid, bodies);
    // The declared size is the count of the bytes that were chunked, so this
    // is exact rather than approximate, and a mismatch means the chunk list
    // is not the one that file was made of. Checked here as well as on
    // arrival because this is the line that overwrites somebody's note.
    if (content.length !== d.remote.size) {
      throw new Error(
        `version ${d.remote.uid} of ${d.path} assembled to ${content.length} bytes, not the ${d.remote.size} it declares`,
      );
    }

    await this.opts.vault.write(d.path, content, { mtime: d.remote.mtime, ctime: d.remote.mtime });
    observe(d.entry, {
      folder: false,
      mtime: d.remote.mtime,
      ctime: d.remote.mtime,
      size: content.length,
    });
    // The chunk list is the server's, so the cache is filled without
    // re-chunking what was just reassembled, and without asking again.
    d.entry.chunks = [...d.chunks];
    d.entry.hash = contentId(d.chunks);
    d.entry.size = content.length;
    synced(d.entry, d.entry.hash, d.entry.chunks, d.remote.uid, this.now());
  }

  /**
   * Downloads and reassembles one version's plaintext.
   *
   * Public because recovery needs it: restoring an old version is fetching
   * its content and writing it back, and there is no reason for a second copy
   * of the reassembly to exist for that.
   */
  async contentOf(uid: number, known?: readonly string[], expected?: string): Promise<Uint8Array> {
    // `known` is what a caller already has. A download does: the batch that
    // announced the version carried its chunk list, so asking for it again
    // is a round trip spent learning something already known. A restore
    // works from a uid alone and has to ask.
    const meta = known !== undefined ? { chunks: known } : await this.opts.transport.get(uid);
    // `expected` is a content id the caller already holds for this uid, and
    // the one that matters is the merge ancestor's. A three-way merge
    // decides which side's changes are already present, so whoever chooses
    // the base chooses what can be dropped: a base equal to the local file
    // plus some paragraphs makes those paragraphs look deleted by the other
    // side, and mergeText then drops them cleanly, writes the result and
    // uploads it. No conflict copy, one counted merge, and the shortened
    // text becomes canonical everywhere.
    //
    // `entry.synchash` is this device's own record of the ancestor from the
    // last completed sync, so the server cannot move it. That is what makes
    // this check worth anything; comparing an incoming version against the
    // hash the same server announced a moment ago only catches it
    // contradicting itself.
    if (expected !== undefined && contentId(meta.chunks) !== expected) {
      throw new Error(
        `version ${uid} is made of chunks this device did not record for it, ` +
          `so it is not the version it is being offered as`,
      );
    }
    if (meta.chunks.length === 0) return new Uint8Array(0);
    this.checkChunkCount(uid, meta.chunks.length);
    return this.assemble(uid, await this.opts.transport.fetch(meta.chunks));
  }

  /**
   * Held to what the server itself advertised. Both of these are the server's
   * own numbers, so refusing past them is not a policy of this client's, it is
   * declining to be told two different things.
   */
  private checkChunkCount(uid: number, count: number): void {
    const maxChunks = boundedBy(this.limits?.maxChunks ?? 0, OWN_LIMITS.maxChunks);
    if (count > maxChunks) {
      throw new Error(
        `version ${uid} names ${count} chunks, and this server said it stores at most ${maxChunks}`,
      );
    }
  }

  /** Opens sealed bodies in order and joins the plaintext. */
  private async assemble(uid: number, bodies: readonly Uint8Array[]): Promise<Uint8Array> {
    if (bodies.length === 0) return new Uint8Array(0);
    const opened: Uint8Array[] = [];
    let total = 0;
    const perFileMax = boundedBy(this.limits?.perFileMax ?? 0, OWN_LIMITS.perFileMax);
    // A window at a time, for the reason sealChunks takes one: opening is
    // mostly waiting on WebCrypto, and one at a time leaves it idle. The
    // window is what keeps a large file from holding every opened chunk at
    // once.
    for (let at = 0; at < bodies.length; at += SEAL_WINDOW) {
      const window = await Promise.all(
        bodies.slice(at, at + SEAL_WINDOW).map((b) => openChunk(this.opts.keys, b)),
      );
      for (const part of window) {
        total += part.length;
        if (total > perFileMax) {
          throw new Error(
            `version ${uid} is over ${total} bytes, and this server said it stores at most ${perFileMax}`,
          );
        }
        opened.push(part);
      }
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of opened) {
      out.set(b, at);
      at += b.length;
    }
    return out;
  }

  private async merge(
    path: string,
    entry: IndexEntry,
    remote: RemoteState | undefined,
    report: SyncReport,
  ): Promise<void> {
    if (!remote) return;

    // Refusing to decode is the point. A file is classified as text by its
    // extension, and an extension is a claim rather than a fact: a `.md`
    // holding bytes that are not UTF-8 decodes with replacement characters,
    // merges cleanly, and is written back with those replacements in place
    // of bytes neither side edited. That is a file quietly altered by a sync
    // that reported success.
    //
    // So the merge is attempted only on text that really is text, and
    // anything else takes the conflict path, which keeps both versions
    // byte-for-byte and transforms neither.
    const dec = new TextDecoder("utf-8", { fatal: true });
    let base: string;
    let mine: string;
    let theirs: string;
    try {
      // The ancestor, fetched by the uid the index remembered. This is
      // what `synchash` and `syncuid` are for: one field to identify the
      // common ancestor and one to go and get it, with no version history
      // on the device.
      base = dec.decode(await this.contentOf(entry.syncuid, undefined, entry.synchash));
      mine = dec.decode(await this.opts.vault.read(path));
      theirs = dec.decode(await this.contentOf(remote.uid, undefined, remote.hash));
    } catch {
      const why = "one side is not valid UTF-8, so merging it would rewrite bytes nobody edited";
      this.log("merge refused", path, why);
      await this.conflict(path, entry, remote, report, why);
      return;
    }

    // A canvas that merged cleanly and no longer parses is a canvas
    // Obsidian refuses to open, and the four checks inside mergeText all
    // pass for it: nothing was lost and nothing collided.
    const outcome = mergeText(base, mine, theirs, looksLikeJson(path) ? parsesAsJson : undefined);
    if (outcome.kind === "conflict") {
      this.log("merge refused", path, outcome.why);
      await this.conflict(path, entry, remote, report, outcome.why);
      return;
    }

    const text = outcome.text;
    if (text !== mine) {
      await this.opts.vault.write(path, new TextEncoder().encode(text), {
        mtime: this.now(),
        ctime: entry.ctime,
      });
    }
    // Uploaded whatever the outcome, because even "take theirs" has to be
    // acknowledged for this path before the ancestor can move.
    observe(entry, { folder: false, mtime: this.now(), ctime: entry.ctime, size: text.length });
    await this.upload(path, entry, report);
    report.merged++;
    this.log("merged", path, outcome.kind === "merged" ? "three-way" : outcome.why);
  }

  /**
   * A conflict copy path nothing is using yet.
   *
   * The name carries the device and the time to the minute, so two conflicts
   * on one path from one device inside the same minute produced the same
   * name, and the second write replaced the first. Two passes inside a minute
   * is ordinary: the write debounce is measured in tens of seconds.
   *
   * That lost a note. A conflict copy is the only surviving record of one
   * side of a divergence, and quietly overwriting it is the failure the
   * conflict copy exists to prevent, one level up.
   */
  private freeConflictPath(path: string): Promise<string> {
    return firstFreeName(conflictCopyPath(path, this.opts.device, new Date(this.now())), (p) =>
      this.opts.vault.exists(p),
    );
  }

  /**
   * Keeps both versions.
   *
   * The local file stays where it is and the incoming version takes a new
   * name. Obsidian does the opposite, putting local content in the conflict
   * copy and overwriting the file with the server's, so a sync rewrites the
   * file you have open and your version appears somewhere you were not
   * looking.
   *
   * Both are then uploaded: the copy so other devices get it, and the local
   * file so the server's newest word for that path is what is actually here.
   */
  private async conflict(
    path: string,
    entry: IndexEntry,
    remote: RemoteState | undefined,
    report: SyncReport,
    why: string,
  ): Promise<void> {
    if (!remote) return;
    const copyPath = await this.freeConflictPath(path);
    const incoming = await this.contentOf(remote.uid, undefined, remote.hash);
    await this.opts.vault.write(copyPath, incoming, { mtime: remote.mtime, ctime: remote.mtime });

    const copyEntry = this.entryFor(copyPath);
    observe(copyEntry, {
      folder: false,
      mtime: remote.mtime,
      ctime: remote.mtime,
      size: incoming.length,
    });
    await this.upload(copyPath, copyEntry, report);
    await this.upload(path, entry, report);

    report.conflicted++;
    this.log("kept both", path, { copy: copyPath, why });
  }

  private async sealedPath(path: string): Promise<string> {
    const sealed = await sealPath(this.opts.keys, path);
    this.unsealed.set(sealed, path);
    return sealed;
  }

  /**
   * Records a failure, and decides whether the file is worth trying again.
   *
   * A protocol refusal the session survives and that names the file as the
   * problem will fail identically forever, so retrying it is noise that hides
   * everything else. Anything else gets exponential backoff, in Obsidian's
   * shape: `5 * 2^n` seconds, capped at five minutes.
   */
  private recordFailure(path: string, err: unknown, report: SyncReport): void {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code;
    const permanent = code !== undefined && ["badentry", "badname", "toolarge"].includes(code);

    if (permanent) {
      this.skipped.set(path, { why: message, fingerprint: fingerprintOf(this.entries.get(path)) });
      report.skipped++;
      this.log("skipped for good", path, message);
      return;
    }

    const retry = this.retries.get(path) ?? { count: 0, error: "", at: 0 };
    retry.count++;
    retry.error = message;
    retry.at = this.now() + Math.min(300_000, 5_000 * Math.pow(2, retry.count));
    this.retries.set(path, retry);
    report.retrying++;
    this.log("will retry", path, { attempt: retry.count, error: message });
  }

  /** Forgets index entries for paths that exist nowhere any more. */
  /**
   * Forgets what nothing can act on any more.
   *
   * Two halves, and for a long time there was only the first. `entries` was
   * pruned and `remote` was not, so a vault kept the server's word about every
   * path it had ever deleted, for ever, in a file rewritten on every sync. Six
   * hundred deleted notes cost around 60 KB and six hundred no-op decisions a
   * pass, growing for as long as the vault exists.
   *
   * The second half is not a cap and not a setting. A number would be
   * arbitrary and would evict on the wrong axis, and nobody can reasonably be
   * asked how many tombstones their index should keep. What is dropped here is
   * dropped because it is provably dead: the file is not on disk, the server's
   * newest word is a deletion, no index entry refers to it, and no inbound
   * work is outstanding. A record in that state can only produce a decision to
   * do nothing.
   *
   * Nothing is lost by forgetting it. A batch naming the path again repopulates
   * it, and a file reappearing at that path is a new file, which is what it is.
   * The server keeps the history either way, and `basalt deleted` reads it from
   * there rather than from here.
   */
  private prune(onDisk: Map<string, unknown>): void {
    for (const [path, entry] of this.entries) {
      if (onDisk.has(path)) continue;
      const remote = this.remote.get(path);
      if (remote && !remote.deleted) continue;
      if (entry.synchash === "" && entry.hash === "") this.entries.delete(path);
    }

    // After the loop above, so a path whose entry was just dropped is
    // considered in the same pass rather than the next one.
    //
    // The four clauses are one predicate: the server's last word was a
    // deletion, this device has applied it, and nothing local still refers
    // to it. Four tests fail if the whole predicate goes, and none fails if
    // any single clause does, because in the states actually reachable the
    // clauses overlap. That is a fact about the state space rather than
    // about the clauses, and shaving it down to whatever a current test can
    // tell apart would be optimising the predicate against the tests.
    for (const [path, remote] of this.remote) {
      if (!remote.deleted) continue;
      if (onDisk.has(path)) continue;
      if (this.entries.has(path)) continue;
      if (this.pending.has(path)) continue;
      this.remote.delete(path);
    }
  }

  private async save(): Promise<void> {
    const entries: Record<string, IndexEntry> = {};
    for (const [path, e] of this.entries) entries[path] = e;
    const remote: Record<string, RemoteState> = {};
    for (const [path, r] of this.remote) remote[path] = r;
    await this.opts.store.save({
      cursor: this.cursor,
      entries,
      remote,
      pending: [...this.pending],
    });
  }

  /** Records a rename the vault reported, so it travels as one operation. */
  noteRename(from: string, to: string): void {
    const entry = this.entries.get(from);
    if (!entry) return;
    this.entries.delete(from);
    renamed(entry, from, to);
    this.entries.set(to, entry);
  }
}

function add(a: SyncReport, b: SyncReport): SyncReport {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof SyncReport)[]) out[k] = a[k] + b[k];
  return out;
}

/**
 * Enough of a file to notice it changed.
 *
 * Modification time and size rather than a content hash, because this is read
 * before the pass decides whether to re-read anything, and a hash would mean
 * reading every written-off file on every pass to find out whether it was still
 * written off.
 */
function fingerprintOf(entry: IndexEntry | undefined): string {
  return entry ? `${entry.mtime}:${entry.size}` : "gone";
}

/**
 * Below this, a file's sealed chunks are kept rather than made twice.
 *
 * Almost every file is a note, and re-sealing a note to save a few kilobytes is
 * a worse trade than the memory. Above it a file is an attachment, and the
 * memory is the thing that matters.
 */
const KEEP_SEALED_BELOW = 8 * 1024 * 1024;

/** How many chunks are sealed at once when the bodies are not being kept. */
export const SEAL_WINDOW = 16;

/**
 * Chunk names, sealing a bounded window at a time.
 *
 * Sealing is deterministic, so a name can be computed and the body it came from
 * thrown away. Doing them all at once holds a sealed copy of the whole file,
 * plus the compression garbage behind it, live at the same moment.
 *
 * Measured through a whole sync of one 64 MiB attachment, peak resident in a
 * fresh process: 816 MB with everything sealed at once against 522 MB with a
 * window of sixteen. Sealing is mostly waiting on WebCrypto, and sixteen is
 * enough in flight to keep it busy, so the smaller window is not slower.
 *
 * The saving is larger than one sealed copy of the file because a changed file
 * is sealed twice: once by the rehash that decides it changed, and once by the
 * upload that sends it. Both are windowed.
 *
 * This does not contradict `sealChunks`, which measured whole-file sealing as
 * the fast path. That was 1,893 chunks of about a kilobyte, where the
 * per-promise overhead is the cost. These are hundreds of kilobytes each, where
 * the work is.
 *
 * Exported because the property worth testing is that windowing changes nothing
 * but the memory: the names must be exactly what sealing everything at once
 * produces, or a file would be stored under names no other device agrees with.
 */
export async function sealedNames(
  keys: VaultKeys,
  parts: readonly Uint8Array[],
  window = SEAL_WINDOW,
): Promise<string[]> {
  const names: string[] = [];
  for (let at = 0; at < parts.length; at += window) {
    const sealed = await sealChunks(keys, parts.slice(at, at + window));
    for (const chunk of sealed) names.push(chunk.name);
  }
  return names;
}

/**
 * How many bytes of queued file this device will hold before sending a batch.
 * See `queue`: the count bound is the server's, this one is memory.
 */
const BATCH_BYTES = 8 * 1024 * 1024;

/**
 * `base`, or the first numbered variant of it that nothing is using.
 *
 * Separated out and exported because it is the part that can be wrong: the
 * engine's use of it is one line, and the interesting cases are what happens
 * when a name is taken, when several are, and what a name with no extension
 * does.
 */
export async function firstFreeName(
  base: string,
  taken: (path: string) => Promise<boolean>,
): Promise<string> {
  if (!(await taken(base))) return base;

  const dot = base.lastIndexOf(".");
  const slash = base.lastIndexOf("/");
  const hasExt = dot > slash;
  const stem = hasExt ? base.slice(0, dot) : base;
  const ext = hasExt ? base.slice(dot) : "";

  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!(await taken(candidate))) return candidate;
  }
  // A thousand of these beside one note is not a state worth inventing a name
  // for, and inventing one silently is how the thousand-and-first overwrites
  // something.
  throw new Error(`cannot find an unused name beside ${base}`);
}

/**
 * A refusal carrying the code that makes it permanent.
 *
 * `recordFailure` classifies by code, and `toolarge` is one it writes off rather
 * than retries: a file does not become smaller by being tried again. The write
 * off is undone the moment the file changes, because the skip is keyed on the
 * entry's fingerprint, so somebody who trims an attachment sees it sync.
 */
function tooLarge(size: number, max: number): Error {
  const err = new Error(
    `${size} bytes, and this server said it stores at most ${max}, so it was not read`,
  );
  (err as Error & { code: string }).code = "toolarge";
  return err;
}

/**
 * One read of a file, cut and named, which an upload can use as it stands.
 *
 * `sealed` is present only when the file was small enough to keep the bodies;
 * above that threshold the names were taken a window at a time and the bodies
 * dropped, and a wanted chunk is sealed again from `bytes`.
 */
type Scanned =
  /** The file was read whole, because the vault could only hand it over whole. */
  | {
      readonly bytes: Uint8Array;
      readonly pieces: readonly { offset: number; bytes: Uint8Array }[];
      readonly names: string[];
      readonly sealed?: SealedChunk[];
      readonly spans?: undefined;
    }
  /** The file was streamed, and nothing of it is held but the offsets. */
  | {
      readonly names: string[];
      readonly spans: readonly { start: number; end: number }[];
      readonly path: string;
      readonly size: number;
      readonly bytes?: undefined;
      readonly sealed?: undefined;
    };

/** One version waiting for company in the inbox. */
interface Incoming {
  readonly path: string;
  readonly entry: IndexEntry;
  readonly remote: RemoteState;
  /** The server's own chunk list for this version, from the batch. */
  readonly chunks: readonly string[];
  readonly kind: "download" | "restoreLocal";
  readonly why: string;
}

/** One write waiting for company in the outbox. */
interface Queued {
  /** The plaintext path, for logging and for recording a failure against. */
  readonly path: string;
  /** Roughly what holding this until the flush costs in memory. */
  readonly size: number;
  readonly entry: BatchEntry;
  readonly bodyOf: (name: string) => Promise<Uint8Array>;
  /** Run only once the server has committed it, with the uid it was given. */
  readonly commit: (uid: number) => void;
}

/** What an upload needs: every chunk's name, and a way to get one's bytes. */
interface UploadPlan {
  readonly names: string[];
  readonly bodyOf: (name: string) => Promise<Uint8Array>;
}

/** For a put that carries no bodies at all: a folder, or a deletion. */
async function noBodies(name: string): Promise<Uint8Array> {
  throw new Error(`this put has no bodies, and the server asked for ${name}`);
}

/** Whether text is still JSON, for the formats where that is what it means to be usable. */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
