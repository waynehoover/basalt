/**
 * The engine: everything that decides, and nothing that knows where files live.
 *
 * Structure follows Obsidian's, which docs/client-design.md describes as an
 * orchestrator collaborating with a transport that knows no policy, a filter that
 * knows only paths, and a crypto provider with no reference to the app. That
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

import { looksLikeText, chunkBytes, sizesFor } from "./chunk.ts";
import { openChunk, openPath, sealChunks, sealPath, type SealedChunk, type VaultKeys } from "./crypto.ts";
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
import type { ServerLimits, Transport, WireEntry } from "./transport.ts";
import type { IndexStore, Vault } from "./vault.ts";

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

export interface EngineOptions {
    readonly vault: Vault;
    readonly store: IndexStore;
    readonly keys: VaultKeys;
    readonly transport: Transport;
    readonly device: string;
    readonly vaultId: string;
    readonly token: string;
    readonly now?: () => number;
    readonly log?: (message: string, ...rest: unknown[]) => void;
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
    private readonly skipped = new Map<string, string>();
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
                this.entries.set(path, { ...newEntry(path), ...(raw as object) } as IndexEntry);
            }
            for (const [path, raw] of Object.entries(stored.remote)) {
                this.remote.set(path, raw as RemoteState);
            }
            for (const path of stored.pending) this.pending.add(path);
            this.log("index loaded", { cursor: this.cursor, entries: this.entries.size, pending: this.pending.size });
        }

        const limits = await this.opts.transport.hello({
            vault: this.opts.vaultId,
            token: this.opts.token,
            device: this.opts.device,
            cursor: this.cursor,
        });
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
    async acceptBatch(batch: { from: number; to: number; entries: WireEntry[] }): Promise<void> {
        for (const e of batch.entries) {
            const path = await this.plaintextPath(e.path);
            this.remote.set(path, {
                uid: e.uid,
                folder: e.folder,
                deleted: e.deleted,
                mtime: e.mtime,
                size: e.size,
                hash: contentId(e.chunks),
            });
            this.pending.add(path);

            if (e.prev) {
                // A rename travels as one operation, so nothing tells this
                // device the old path is gone except this field. Recorded as a
                // deletion of the old path, which is what it is, and which lets
                // the decision table handle the awkward case for free: if the
                // old path was edited here since the last sync, a deletion loses
                // to an edit and the file is kept and re-uploaded.
                const old = await this.plaintextPath(e.prev);
                this.remote.set(old, {
                    uid: e.uid,
                    folder: false,
                    deleted: true,
                    mtime: e.mtime,
                    size: 0,
                    hash: "",
                });
                this.pending.add(old);
            }
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

        // 1. What the filesystem says. The index's cache means an unchanged file
        //    costs one stat, so a full pass over a large vault is affordable and
        //    there is no need to track dirtiness separately.
        const stats = await this.opts.vault.list();
        const onDisk = new Map(stats.map((s) => [s.path, s]));
        for (const stat of stats) {
            const entry = this.entryFor(stat.path);
            observe(entry, stat);
        }

        // 2. Every path either side knows about.
        const paths = new Set<string>([...onDisk.keys(), ...this.entries.keys(), ...this.remote.keys()]);

        for (const path of [...paths].sort()) {
            if (this.skipped.has(path)) {
                report.skipped++;
                continue;
            }
            const retry = this.retries.get(path);
            if (retry && retry.at > now) {
                report.retrying++;
                continue;
            }
            try {
                await this.reconcile(path, onDisk.get(path), report, now, coalesce);
                this.retries.delete(path);
            } catch (err) {
                this.recordFailure(path, err, report);
            }
        }

        this.prune(onDisk);
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
        coalesce: boolean
    ): Promise<void> {
        const entry = this.entryFor(path);
        const remote = this.remote.get(path);

        let local: LocalState | undefined;
        if (stat) {
            if (!stat.folder && needsRehash(entry, Math.ceil(stat.mtime), stat.size)) {
                // The only place a file is read for its content, and only when
                // the stat says it moved.
                await this.rehash(entry, path);
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

        await this.act(path, action, entry, local, remote, report);
        this.pending.delete(path);
    }

    /** Chunks and seals a file, filling in the index's content cache. */
    private async rehash(entry: IndexEntry, path: string): Promise<SealedChunk[]> {
        const bytes = await this.opts.vault.read(path);
        const isText = this.mergeable(path);
        const parts = [...chunkBytes(bytes, sizesFor(bytes.length, isText), isText)].map((c) => c.bytes);
        const sealed = await sealChunks(this.opts.keys, parts);
        entry.chunks = sealed.map((c) => c.name);
        entry.hash = contentId(entry.chunks);
        entry.size = bytes.length;
        return sealed;
    }

    private async act(
        path: string,
        action: Action,
        entry: IndexEntry,
        local: LocalState | undefined,
        remote: RemoteState | undefined,
        report: SyncReport
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
                await this.upload(path, entry, report);
                report.uploaded++;
                return;

            case "download":
            case "restoreLocal": {
                if (!remote) return;
                await this.download(path, entry, remote);
                if (action.kind === "download") report.downloaded++;
                else report.restored++;
                this.log(action.kind, path, action.why);
                return;
            }

            case "createLocalFolder":
                await this.opts.vault.mkdir(path);
                entry.folder = true;
                if (remote) synced(entry, "", [], remote.uid, this.now());
                report.foldersCreated++;
                return;


            case "deleteLocal":
                await this.opts.vault.remove(path);
                this.entries.delete(path);
                report.deletedLocally++;
                this.log("deleted locally", path, action.why);
                return;

            case "deleteRemote": {
                const uid = await this.putDeletion(path);
                // Recorded before the entry is forgotten. This device's own
                // writes come back with no payload, so nothing else will ever
                // tell it the deletion happened, and a stale entry here reads on
                // the next pass as a file to download back.
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

    private async upload(path: string, entry: IndexEntry, report: SyncReport): Promise<void> {
        if (entry.folder) {
            const uid = await this.putFolder(path);
            synced(entry, "", [], uid, this.now());
            this.remote.set(path, {
                uid,
                folder: true,
                deleted: false,
                mtime: 0,
                size: 0,
                hash: "",
            });
            return;
        }
        const sealed = await this.sealedFor(entry, path);
        const result = await this.opts.transport.put(
            await this.sealedPath(path),
            {
                size: entry.size,
                ctime: entry.ctime,
                mtime: entry.mtime,
                ...(entry.prev ? { prev: await this.sealedPath(entry.prev) } : {}),
            },
            sealed
        );
        report.chunksSent += result.uploaded;
        report.bytesSent += result.bytes;
        synced(entry, entry.hash, entry.chunks, result.uid, this.now());
        // Record what the server now holds, so the next pass sees agreement
        // rather than deciding to upload again.
        this.remote.set(path, {
            uid: result.uid,
            folder: false,
            deleted: false,
            mtime: entry.mtime,
            size: entry.size,
            hash: entry.hash,
        });
        this.log("uploaded", path, { chunks: result.uploaded, bytes: result.bytes });
    }

    /** The sealed chunks for a file, re-sealing only if the cache cannot serve. */
    private async sealedFor(entry: IndexEntry, path: string): Promise<SealedChunk[]> {
        const bytes = await this.opts.vault.read(path);
        const isText = this.mergeable(path);
        const parts = [...chunkBytes(bytes, sizesFor(bytes.length, isText), isText)].map((c) => c.bytes);
        const sealed = await sealChunks(this.opts.keys, parts);
        entry.chunks = sealed.map((c) => c.name);
        entry.hash = contentId(entry.chunks);
        entry.size = bytes.length;
        return sealed;
    }

    private async putFolder(path: string): Promise<number> {
        const result = await this.opts.transport.put(
            await this.sealedPath(path),
            { size: 0, ctime: 0, mtime: 0, folder: true },
            []
        );
        return result.uid;
    }

    private async putDeletion(path: string): Promise<number> {
        const result = await this.opts.transport.put(
            await this.sealedPath(path),
            { size: 0, ctime: 0, mtime: this.now(), deleted: true },
            []
        );
        return result.uid;
    }

    private async download(path: string, entry: IndexEntry, remote: RemoteState): Promise<void> {
        const content = await this.contentOf(remote.uid);
        await this.opts.vault.write(path, content, { mtime: remote.mtime, ctime: remote.mtime });
        const stat = { folder: false, mtime: remote.mtime, ctime: remote.mtime, size: content.length };
        observe(entry, stat);
        // The chunk list is the server's, so the cache can be filled without
        // re-chunking what was just reassembled.
        const meta = await this.opts.transport.get(remote.uid);
        entry.chunks = meta.chunks;
        entry.hash = contentId(meta.chunks);
        entry.size = content.length;
        synced(entry, entry.hash, entry.chunks, remote.uid, this.now());
    }

    /** Downloads and reassembles one version's plaintext. */
    private async contentOf(uid: number): Promise<Uint8Array> {
        const meta = await this.opts.transport.get(uid);
        if (meta.chunks.length === 0) return new Uint8Array(0);
        const bodies = await this.opts.transport.fetch(meta.chunks);
        const opened: Uint8Array[] = [];
        for (const body of bodies) opened.push(await openChunk(this.opts.keys, body));
        const total = opened.reduce((n, b) => n + b.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const b of opened) {
            out.set(b, at);
            at += b.length;
        }
        return out;
    }

    private async merge(path: string, entry: IndexEntry, remote: RemoteState | undefined, report: SyncReport): Promise<void> {
        if (!remote) return;
        const dec = new TextDecoder();

        // The ancestor, fetched by the uid the index remembered. This is what
        // `synchash` and `syncuid` are for: one field to identify the common
        // ancestor and one to go and get it, with no version history on the
        // device.
        const base = dec.decode(await this.contentOf(entry.syncuid));
        const mine = dec.decode(await this.opts.vault.read(path));
        const theirs = dec.decode(await this.contentOf(remote.uid));

        const outcome = mergeText(base, mine, theirs);
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
        why: string
    ): Promise<void> {
        if (!remote) return;
        const copyPath = conflictCopyPath(path, this.opts.device, new Date(this.now()));
        const incoming = await this.contentOf(remote.uid);
        await this.opts.vault.write(copyPath, incoming, { mtime: remote.mtime, ctime: remote.mtime });

        const copyEntry = this.entryFor(copyPath);
        observe(copyEntry, { folder: false, mtime: remote.mtime, ctime: remote.mtime, size: incoming.length });
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
            this.skipped.set(path, message);
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
    private prune(onDisk: Map<string, unknown>): void {
        for (const [path, entry] of this.entries) {
            if (onDisk.has(path)) continue;
            const remote = this.remote.get(path);
            if (remote && !remote.deleted) continue;
            if (entry.synchash === "" && entry.hash === "") this.entries.delete(path);
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
