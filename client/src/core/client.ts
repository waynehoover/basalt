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

import { Engine, type SyncOptions, type SyncReport } from "./engine.ts";
import {
    Backoff,
    ProtocolError,
    Transport,
    type ServerLimits,
    type SocketLike,
    type WireEntry,
} from "./transport.ts";
import type { IndexStore, Vault } from "./vault.ts";
import { openPath, sealPath, type VaultKeys } from "./crypto.ts";

export interface ClientOptions {
    readonly vault: Vault;
    readonly store: IndexStore;
    readonly keys: VaultKeys;
    /** WebSocket URL of the server. */
    readonly url: string;
    readonly token: string;
    /** The auth key to bind the vault to, if it has not been claimed yet. */
    readonly claim?: string;
    readonly vaultId: string;
    readonly device: string;
    readonly timeoutMs?: number;
    /** Whether to hold back a file written moments ago. See EngineOptions. */
    readonly coalesceWrites?: boolean;
    readonly log?: (message: string, ...rest: unknown[]) => void;
    /** Injectable for tests, and for a platform whose WebSocket is not global. */
    readonly socketFactory?: (url: string) => SocketLike;
}

/** One connection, from hello to close. */
export class Client {
    readonly engine: Engine;
    readonly transport: Transport;
    private limits: ServerLimits | undefined;
    private caughtUp = false;
    private endedWith: Error | undefined;
    private notifyEnded: ((cause: Error) => void) | undefined;

    constructor(private readonly opts: ClientOptions) {
        let engine!: Engine;
        this.transport = new Transport(opts.url, {
            onBatch: async (batch) => {
                await engine.acceptBatch(batch);
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
            transport: this.transport,
            device: opts.device,
            vaultId: opts.vaultId,
            token: opts.token,
            ...(opts.claim !== undefined ? { claim: opts.claim } : {}),
            ...(opts.coalesceWrites !== undefined ? { coalesceWrites: opts.coalesceWrites } : {}),
            ...(opts.log !== undefined ? { log: opts.log } : {}),
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

    /** The newest uid the server held when this client said hello. */
    get serverCursor(): number {
        return this.limits?.cursor ?? 0;
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
        this.limits = await this.engine.start();

        const timeout = this.opts.timeoutMs ?? 30_000;
        const deadline = Date.now() + timeout;
        while (!this.caughtUp && Date.now() < deadline) {
            if (this.endedWith) throw this.endedWith;
            await sleep(25);
        }
        if (!this.caughtUp) throw new Error("the server never finished sending what it already had");
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
        return this.serial(() => this.engine.sync(opts));
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
        const ticker = setInterval(() => void this.sync(), tickMs);
        try {
            return await new Promise<Error>((resolve) => {
                this.notifyEnded = resolve;
            });
        } finally {
            clearInterval(ticker);
            stop?.();
        }
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
        const sealed = await sealPath(this.opts.keys, path);
        const entries = await this.serial(() => this.transport.history(sealed, opts));
        return entries.map((e) => this.asVersion(e, path));
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
        const notes: Deletion[] = [];
        for (const e of answer.entries) {
            notes.push({
                ...this.asVersion(e, await openPath(this.opts.keys, e.path)),
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
    async restore(version: Version, to?: string): Promise<{ path: string; bytes: number }> {
        if (version.deleted) {
            throw new Error(`version ${version.uid} of ${version.path} is the deletion itself, not a version to restore`);
        }
        if (version.folder) {
            const at = to ?? version.path;
            await this.opts.vault.mkdir(at);
            return { path: at, bytes: 0 };
        }

        // Queued like a pass, because reassembling a version is several
        // requests and a sync starting in the middle of them would collide.
        const content = await this.serial(() => this.engine.contentOf(version.uid));
        const wanted = to ?? version.path;
        const at = (await this.opts.vault.exists(wanted)) ? restoredCopyPath(wanted, version) : wanted;
        await this.opts.vault.write(at, content, { mtime: version.mtime, ctime: version.ctime });
        return { path: at, bytes: content.length };
    }

    /**
     * The newest version of a path that had content, or undefined.
     *
     * Not queued itself: it is a call to `history`, which is. Queuing here as
     * well would be a lock waiting for itself.
     */
    async newestContentVersion(path: string): Promise<Version | undefined> {
        const versions = await this.history(path, { limit: 50 });
        return versions.find((v) => !v.deleted);
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
        };
    }

    close(): void {
        this.transport.close();
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
}

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

    while (hooks.keepGoing?.() ?? true) {
        let client: Client | undefined;
        let cause: Error | undefined;
        let reachedTheServer = false;

        try {
            client = new Client(opts);
            await client.connect();
            reachedTheServer = true;
            backoff.success(Date.now());
            hooks.onClient?.(client);
            hooks.onSynced?.(await client.settle(), client.serverCursor);
            cause = await client.runUntilClosed();
        } catch (err) {
            cause = err as Error;
        } finally {
            hooks.onClient?.(undefined);
            client?.close();
        }

        if (cause && isFatal(cause)) {
            hooks.onFatal?.(cause);
            return;
        }
        if (!(hooks.keepGoing?.() ?? true)) return;

        backoff.fail(Date.now());
        const wait = backoff.delay();
        const why = cause ?? new Error("the connection ended");
        if (reachedTheServer) hooks.onDisconnected?.(why, wait);
        else hooks.onUnreachable?.(why, wait);
        await sleep(wait);
    }
}

/**
 * Whether trying again could ever help.
 *
 * "Closed by this device" is not a failure, it is this client shutting down, and
 * treating it as fatal would stop a loop that was asked to stop anyway. Anything
 * the protocol marked fatal is a refusal that will be repeated word for word
 * forever.
 */
export function isFatal(cause: Error): boolean {
    return cause instanceof ProtocolError && cause.fatal;
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
    return bits.length === 0 ? "up to date" : bits.join(", ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
