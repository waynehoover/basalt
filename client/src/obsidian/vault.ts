/**
 * Obsidian's vault, as a vault.
 *
 * The other half of what makes the headless client the same client. Written
 * against `DataAdapter` rather than the higher-level `Vault` API for one reason
 * that matters: `writeBinary` takes `{ mtime, ctime }`, and the engine's whole
 * decision table compares timestamps. A file written with the moment it landed
 * looks locally edited on the next pass, and the device would upload back what
 * it just received, forever.
 *
 * ## What is not verified
 *
 * Every other file in `core` is tested, most of it against a real server. This
 * one is not, and cannot be: it needs Obsidian running. So it is kept as thin as
 * it can be, with no decisions in it, and the engine above it is tested against
 * an in-memory vault that implements the same interface. What is untested here
 * is the mapping onto Obsidian's API, and it will stay untested until the plugin
 * shell runs in a real vault.
 *
 * docs/philosophy.md says to verify against the artifact and never infer. The
 * signatures used here were read out of `obsidian.d.ts` rather than remembered,
 * which is as close as this file gets until it runs.
 */

import { normalizePath, type DataAdapter } from "obsidian";

import type { FileStat, IndexStore, StoredState, Vault } from "../core/vault.ts";

/**
 * Names never synced.
 *
 * `.obsidian` because plugin and settings sync is refused; see
 * docs/philosophy.md, and note that one device disabling every plugin on another
 * is where one of the durability rules came from. `.trash` because a deletion
 * arriving from another device is moved there, and syncing it back would undo
 * the deletion on every other device in turn.
 */
const NEVER_SYNC = new Set([".obsidian", ".basalt", ".trash", ".git", ".DS_Store"]);

export class ObsidianVault implements Vault {
    constructor(private readonly adapter: DataAdapter) {}

    async list(): Promise<FileStat[]> {
        const out: FileStat[] = [];

        // `adapter.list` is not recursive, so this walks. Breadth-first with an
        // explicit queue rather than recursion: a vault with a pathological
        // folder depth should not decide how deep the stack goes.
        const queue: string[] = [""];
        while (queue.length > 0) {
            const dir = queue.shift()!;
            const listed = await this.adapter.list(dir === "" ? "/" : normalizePath(dir));

            for (const folder of listed.folders) {
                const path = trimLeadingSlash(folder);
                if (this.ignored(path)) continue;
                out.push({ path, folder: true, mtime: 0, ctime: 0, size: 0 });
                queue.push(path);
            }
            for (const file of listed.files) {
                const path = trimLeadingSlash(file);
                if (this.ignored(path)) continue;
                const stat = await this.adapter.stat(normalizePath(path));
                if (!stat || stat.type !== "file") continue;
                out.push({
                    path,
                    folder: false,
                    mtime: stat.mtime,
                    // Carried because the protocol carries it, and read by
                    // nothing that decides. Obsidian ships native addons for
                    // five platforms to get this value in its headless client,
                    // which is a fair measure of how much it is worth.
                    ctime: stat.ctime,
                    size: stat.size,
                });
            }
        }
        return out;
    }

    /** Whether any part of a path is a name that never syncs. */
    private ignored(path: string): boolean {
        for (const part of path.split("/")) {
            if (NEVER_SYNC.has(part)) return true;
        }
        return false;
    }

    async read(path: string): Promise<Uint8Array> {
        return new Uint8Array(await this.adapter.readBinary(normalizePath(path)));
    }

    async write(path: string, bytes: Uint8Array, times: { mtime: number; ctime: number }): Promise<void> {
        const normalized = normalizePath(path);
        await this.ensureParents(normalized);
        // Copied into its own buffer. A Uint8Array that is a view into a larger
        // one would hand over neighbouring bytes, and chunk reassembly produces
        // exactly that kind of view.
        const buffer = bytes.slice().buffer as ArrayBuffer;
        await this.adapter.writeBinary(normalized, buffer, {
            ...(times.mtime > 0 ? { mtime: times.mtime } : {}),
            ...(times.ctime > 0 ? { ctime: times.ctime } : {}),
        });
    }

    /**
     * Removes a path by moving it to the vault's trash.
     *
     * Not `remove`. A deletion arriving over the wire was somebody's decision on
     * another device, possibly a mistaken one, and the first rule is not to lose
     * a note. The trash makes it recoverable by hand for as long as Obsidian
     * keeps it, and `.trash` is in the never-sync list so it does not travel back
     * out and undo the deletion everywhere else.
     *
     * The system trash is tried first, because that is recoverable for longer and
     * from outside Obsidian. It returns false where the platform has none, and
     * the vault-local trash is the fallback.
     */
    async remove(path: string): Promise<void> {
        const normalized = normalizePath(path);
        if (!(await this.adapter.exists(normalized))) return;
        try {
            if (await this.adapter.trashSystem(normalized)) return;
        } catch {
            // No system trash here, or it refused. The local one is next, and a
            // failure to reach the recycle bin is not a reason to give up on the
            // deletion.
        }
        await this.adapter.trashLocal(normalized);
    }

    async mkdir(path: string): Promise<void> {
        const normalized = normalizePath(path);
        if (await this.adapter.exists(normalized)) return;
        await this.ensureParents(normalized);
        await this.adapter.mkdir(normalized);
    }

    async exists(path: string): Promise<boolean> {
        return this.adapter.exists(normalizePath(path));
    }

    /**
     * Creates the folders a path needs.
     *
     * `writeBinary` does not, and a note arriving in a folder this device has
     * never seen is the common case on a first sync.
     */
    private async ensureParents(normalizedPath: string): Promise<void> {
        const parts = normalizedPath.split("/");
        parts.pop();
        let at = "";
        for (const part of parts) {
            if (part === "") continue;
            at = at === "" ? part : `${at}/${part}`;
            if (!(await this.adapter.exists(at))) {
                await this.adapter.mkdir(at);
            }
        }
    }
}

/**
 * The index, in the plugin's own data folder.
 *
 * Kept out of the vault proper so it never syncs and never appears as a note.
 * Written through the adapter rather than the filesystem, because on mobile
 * there is no filesystem to write to.
 */
export class ObsidianIndexStore implements IndexStore {
    constructor(
        private readonly adapter: DataAdapter,
        private readonly path: string
    ) {}

    async load(): Promise<StoredState | undefined> {
        const normalized = normalizePath(this.path);
        if (!(await this.adapter.exists(normalized))) return undefined;
        // A read that fails is not an absent index. Rule 2, and the incident it
        // came from: falling back to an empty result and writing it back
        // disabled every plugin on a device.
        const text = await this.adapter.read(normalized);
        try {
            return JSON.parse(text) as StoredState;
        } catch (err) {
            throw new Error(`the index at ${this.path} is not valid JSON: ${(err as Error).message}`);
        }
    }

    async save(state: StoredState): Promise<void> {
        const normalized = normalizePath(this.path);
        const parts = normalized.split("/");
        parts.pop();
        if (parts.length > 0) {
            const dir = parts.join("/");
            if (dir !== "" && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
        }
        await this.adapter.write(normalized, JSON.stringify(state));
    }
}

function trimLeadingSlash(path: string): string {
    return path.startsWith("/") ? path.slice(1) : path;
}
