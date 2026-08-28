/**
 * The filesystem, as a vault.
 *
 * Half of what makes the headless client the same client: the engine above this
 * cannot tell whether it is talking to a directory or to Obsidian's Vault API.
 *
 * Nothing here decides anything. It lists, reads, writes and removes, and every
 * question about *whether* to is answered a layer up.
 */

import { constants, watch as fsWatch, type FSWatcher } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { FileStat, IndexStore, StoredState, Vault } from "../core/vault.ts";

/**
 * Names never synced.
 *
 * `.obsidian` is refused because plugin and settings sync is refused; see
 * docs/philosophy.md, and note that one device disabling every plugin on another
 * is where one of the durability rules came from. `.basalt` is this client's own
 * bookkeeping, and syncing it would sync the index to itself.
 */
const NEVER_SYNC = new Set([".obsidian", ".basalt", ".trash", ".git", ".DS_Store", "node_modules"]);

export interface NodeVaultOptions {
    /** Extra top-level names to leave alone. */
    readonly alsoIgnore?: readonly string[];
}

export class NodeVault implements Vault {
    private readonly root: string;
    private readonly ignore: Set<string>;

    constructor(root: string, opts: NodeVaultOptions = {}) {
        this.root = resolve(root);
        this.ignore = new Set([...NEVER_SYNC, ...(opts.alsoIgnore ?? [])]);
    }

    /**
     * Turns a vault-relative path into an absolute one, refusing to escape.
     *
     * Paths arrive from the server, sealed by another device, and a client that
     * joined `../../.ssh/authorized_keys` onto the vault root without looking
     * would write outside it. The seal proves the path came from someone holding
     * the vault key; it does not prove they meant this device well, and a bug on
     * another device is enough.
     */
    private absolute(path: string): string {
        const full = resolve(this.root, path);
        const rel = relative(this.root, full);
        if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
            throw new Error(`refusing a path outside the vault: ${path}`);
        }
        return full;
    }

    async list(): Promise<FileStat[]> {
        const out: FileStat[] = [];
        const walk = async (dir: string, prefix: string): Promise<void> => {
            let items;
            try {
                items = await readdir(dir, { withFileTypes: true });
            } catch (err) {
                // Rule 2: absent and unreadable are different states. A directory
                // that cannot be read is not an empty one, and treating it as
                // empty would report every file in it as deleted.
                throw new Error(`cannot read ${dir}: ${(err as Error).message}`);
            }
            for (const item of items) {
                if (this.ignore.has(item.name)) continue;
                const path = prefix ? `${prefix}/${item.name}` : item.name;
                const full = join(dir, item.name);
                if (item.isDirectory()) {
                    out.push({ path, folder: true, mtime: 0, ctime: 0, size: 0 });
                    await walk(full, path);
                } else if (item.isFile()) {
                    const s = await stat(full);
                    out.push({
                        path,
                        folder: false,
                        mtime: s.mtimeMs,
                        // birthtimeMs is unreliable across platforms, which
                        // Obsidian cared about enough to ship native addons for.
                        // Carried because the protocol carries it, and read by
                        // nothing that decides.
                        ctime: s.birthtimeMs || s.ctimeMs,
                        size: s.size,
                    });
                }
                // Symlinks and anything else are left alone: following one would
                // sync a file that is not in the vault, and copying it as a link
                // would sync a path that means nothing elsewhere.
            }
        };
        await walk(this.root, "");
        return out;
    }

    async read(path: string): Promise<Uint8Array> {
        return new Uint8Array(await readFile(this.absolute(path)));
    }

    /**
     * Writes a file, then sets its modification time to the one given.
     *
     * The timestamp is not decoration. The engine's decision table compares
     * mtimes, so a downloaded file stamped with the moment it landed looks
     * locally edited on the very next pass, and the device would upload back what
     * it just received, forever.
     */
    async write(path: string, bytes: Uint8Array, times: { mtime: number; ctime: number }): Promise<void> {
        const full = this.absolute(path);
        await mkdir(dirname(full), { recursive: true });
        // Written to a temporary name and renamed, so a crash or a concurrent
        // read never sees a half-written note. The same reason the server does it
        // for chunk bodies.
        const tmp = `${full}.basalt-tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, full);
        if (times.mtime > 0) {
            const seconds = times.mtime / 1000;
            await utimes(full, seconds, seconds);
        }
    }

    async remove(path: string): Promise<void> {
        await rm(this.absolute(path), { recursive: true, force: true });
    }

    async mkdir(path: string): Promise<void> {
        await mkdir(this.absolute(path), { recursive: true });
    }

    async exists(path: string): Promise<boolean> {
        try {
            await access(this.absolute(path), constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Reports changes under the vault, coalesced.
     *
     * What this is and is not: it decides *when to look*, never *what changed*.
     * The scan is what decides, and it re-reads the vault from scratch, so a
     * missed event costs latency and never correctness. That is the reason this
     * can be built on recursive `fs.watch` at all, which is documented as
     * best-effort and is not available on every platform.
     *
     * Coalesced on a short timer because saving one file in an editor produces
     * several events, and because a folder copied into the vault produces one
     * per file. Without it the engine would start a pass per event and spend the
     * copy re-scanning.
     */
    watch(onChange: (path: string) => void): () => void {
        let timer: NodeJS.Timeout | undefined;
        let last = "";
        let watcher: FSWatcher | undefined;

        try {
            watcher = fsWatch(this.root, { recursive: true, persistent: true }, (_event, filename) => {
                if (!filename) return;
                const path = filename.toString().split(sep).join("/");
                // The state folder changes on every single pass, because that is
                // where the index is written. Watching it would mean each pass
                // scheduled the next one, forever.
                if (path.split("/").some((part) => this.ignore.has(part))) return;
                if (path.endsWith(".basalt-tmp")) return;
                last = path;
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    timer = undefined;
                    onChange(last);
                }, 150);
            });
            watcher.on("error", () => {
                // A watch that fails is a vault that gets scanned on a timer
                // instead. Slower to notice, and no less correct.
            });
        } catch {
            // Recursive watching is not available everywhere. The caller polls.
            return () => {};
        }

        return () => {
            if (timer) clearTimeout(timer);
            watcher?.close();
        };
    }
}

/**
 * The index, in a JSON file beside the vault.
 *
 * Obsidian's headless client keeps its index in SQLite, with a JSON blob per
 * path. This keeps the JSON and drops the SQLite, for now: the whole index of a
 * four thousand note vault is a few hundred kilobytes, rewriting it costs
 * milliseconds, and a native dependency is a real cost for a client that
 * otherwise needs none. If a vault ever grows to where that stops being true,
 * the shape here is already the shape a table would hold.
 *
 * The write is atomic. An index truncated by a crash is worse than no index at
 * all: no index re-reads the vault and recovers, while a half-written one is
 * read as fact and quietly disagrees with the server about what has been synced.
 */
export class JsonIndexStore implements IndexStore {
    constructor(private readonly file: string) {}

    async load(): Promise<StoredState | undefined> {
        let text: string;
        try {
            text = await readFile(this.file, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            // Rule 2 again, and this is the incident it came from: code that read
            // a config file, fell back to an empty result on error and wrote that
            // back disabled every plugin on a device. Unreadable must stop.
            throw new Error(`cannot read the index at ${this.file}: ${(err as Error).message}`);
        }
        try {
            return JSON.parse(text) as StoredState;
        } catch (err) {
            throw new Error(
                `the index at ${this.file} is not valid JSON, so it cannot be trusted: ${(err as Error).message}`
            );
        }
    }

    async save(state: StoredState): Promise<void> {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, JSON.stringify(state));
        await rename(tmp, this.file);
    }
}
