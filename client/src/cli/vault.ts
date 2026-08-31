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
import { access, cp, mkdir, open, readFile, readdir, realpath, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { FileStat, IndexStore, StoredState, Vault } from "../core/vault.ts";

/**
 * Names never synced.
 *
 * The config folder is skipped because syncing plugins and settings is not
 * done here. That is an open question rather than a closed refusal, and
 * docs/philosophy.md now argues both sides of it; the short version is that
 * Obsidian rewrites those files from memory, so an arriving change would be
 * silently undone. One device disabling every plugin on another is also where
 * one of the durability rules came from. Which folder it is comes from
 * --config-dir, since only Obsidian knows for certain and this cannot ask.
 *
 * `.basalt` is this client's own bookkeeping, and syncing it would sync the
 * index to itself.
 */
/** Where a deletion arriving from another device goes, rather than away. */
const TRASH_DIR = ".trash";

const NEVER_SYNC = new Set([".basalt", TRASH_DIR, ".git", ".DS_Store", "node_modules"]);

/** What Obsidian calls its config folder unless the user has overridden it. */
export const DEFAULT_CONFIG_DIR = ".obsidian";

/**
 * The config folder as a single name at the vault root, or a refusal.
 *
 * The same rule the plugin applies, and for the same reason: Obsidian's config
 * folder is one folder at the root, and if it were ever anything else then
 * quietly ignoring the wrong thing is how a vault's settings get uploaded.
 */
export function configFolderName(configDir: string): string {
    const name = configDir.replace(/^\/+|\/+$/g, "");
    if (name === "" || name.includes("/")) {
        throw new Error(`refusing to sync: the config folder ${JSON.stringify(configDir)} is not a plain name`);
    }
    return name;
}

export interface NodeVaultOptions {
    /** Extra top-level names to leave alone. */
    readonly alsoIgnore?: readonly string[];
    /**
     * Obsidian's config folder, which is `.obsidian` until somebody overrides
     * it in the app.
     *
     * Defaulted here, where the plugin demands it. The plugin can ask Obsidian
     * and get the right answer; this cannot ask anything, so refusing to run
     * without being told would put a flag in front of every ordinary use. The
     * cost of the default is that a vault with an overridden config folder
     * syncs it until someone passes --config-dir, which is why the flag exists.
     */
    readonly configDir?: string;
}

export class NodeVault implements Vault {
    private readonly root: string;
    private readonly ignore: Set<string>;

    constructor(root: string, opts: NodeVaultOptions = {}) {
        this.root = resolve(root);
        const configDir = configFolderName(opts.configDir ?? DEFAULT_CONFIG_DIR);
        this.ignore = new Set([...NEVER_SYNC, configDir, ...(opts.alsoIgnore ?? [])]);
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
    /** The vault root with its links resolved, worked out once. */
    private realRootOnce: Promise<string> | undefined;

    /**
     * Proves containment against the filesystem rather than the string.
     *
     * `absolute` resolves `..` lexically. That is everything for a path trying
     * to climb out and nothing for one walking through a symlinked folder, and
     * a vault with `Attachments -> /elsewhere` is ordinary: a shared media
     * directory, a notes tree living on another disk. `list` neither follows nor
     * reports such a folder, so it never syncs out and the vault never learns it
     * is there, but every write followed it. A peer naming a path under one
     * wrote outside the vault with the user's privileges, and `remove` deleted
     * out there.
     *
     * The deepest ancestor that exists is the one worth resolving; anything
     * below it is about to be created and cannot be a link yet.
     */
    private async insideForReal(full: string): Promise<void> {
        const root = await (this.realRootOnce ??= realpath(this.root));
        let at = dirname(full);
        for (;;) {
            const real = await realpath(at).catch((err: NodeJS.ErrnoException) => {
                if (err.code === "ENOENT") return undefined;
                throw err;
            });
            if (real !== undefined) {
                if (real !== root && !real.startsWith(root + sep)) {
                    throw new Error(`refusing a path that leaves the vault through a link: ${full}`);
                }
                return;
            }
            const up = dirname(at);
            // The filesystem root, which cannot be inside the vault.
            if (up === at) return;
            at = up;
        }
    }

    private absolute(path: string): string {
        const full = resolve(this.root, path);
        const rel = relative(this.root, full);
        // `startsWith("..")` also refused a note called `..hidden.md`, which is
        // a note, not an escape, and could never sync for the life of the vault.
        if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
            throw new Error(`refusing a path outside the vault: ${path}`);
        }
        // A path this client would never upload is one it must never accept.
        //
        // The ignore set was read by `list` and `watch` and by nothing on the
        // way in, so the two directions disagreed: a peer naming
        // `.obsidian/plugins/<any>/main.js` had it written, and Obsidian runs
        // that file on the next reload in a renderer with Node integration.
        // `.basalt/config.json` holds this device's own secret and server URL,
        // and `.git/hooks/` runs on the next checkout.
        const first = rel.split(sep)[0]!;
        if (this.ignore.has(first)) {
            throw new Error(`refusing to write inside ${first}, which is never synced: ${path}`);
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
                // A write in flight, from this client. Listing one would sync a
                // half-written note under a name that is about to vanish.
                if (isTemporary(item.name)) continue;
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
     * The file in blocks, so a large one can be chunked without being held.
     *
     * A megabyte at a time: large enough that the per-read cost disappears,
     * small enough that peak memory is bounded by something other than the file.
     */
    async *readBlocks(path: string, blockSize = 1024 * 1024): AsyncGenerator<Uint8Array> {
        const handle = await open(this.absolute(path), "r");
        try {
            const buf = new Uint8Array(blockSize);
            for (;;) {
                const { bytesRead } = await handle.read(buf, 0, blockSize, null);
                if (bytesRead === 0) return;
                // Copied rather than yielded as a view, because the buffer is
                // reused for the next block and a consumer that kept the view
                // would find it rewritten underneath.
                yield buf.slice(0, bytesRead);
            }
        } finally {
            await handle.close();
        }
    }

    async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
        const handle = await open(this.absolute(path), "r");
        try {
            const out = new Uint8Array(end - start);
            let at = 0;
            while (at < out.length) {
                const { bytesRead } = await handle.read(out, at, out.length - at, start + at);
                if (bytesRead === 0) break;
                at += bytesRead;
            }
            // Short means the file shrank since it was named. The caller checks
            // the chunk against its name and fails this file rather than
            // sending bytes under a name that is not theirs.
            return at === out.length ? out : out.subarray(0, at);
        } finally {
            await handle.close();
        }
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
        await this.insideForReal(full);
        await mkdir(dirname(full), { recursive: true });
        await writeDurably(full, bytes);
        if (times.mtime > 0) {
            const seconds = times.mtime / 1000;
            await utimes(full, seconds, seconds);
        }
    }

    /**
     * Removes a path by moving it into the vault's trash.
     *
     * Not `rm`. A deletion arriving over the wire was somebody's decision on
     * another device, possibly a mistaken one, and the first rule is not to
     * lose a note. The Obsidian adapter has always trashed rather than deleted
     * and this one did not, which is the same defect Sync Engine had reported
     * against it as issue 232: files destroyed on one platform and trashed on
     * another, by the same sync.
     *
     * `.trash` is in the never-sync list, so what lands there does not travel
     * back out and undo the deletion everywhere else.
     */
    async remove(path: string): Promise<void> {
        const full = this.absolute(path);
        await this.insideForReal(full);
        try {
            await access(full, constants.F_OK);
        } catch {
            // Two devices deleting the same file produces this routinely.
            return;
        }

        const target = await this.freeTrashPath(path);
        await mkdir(dirname(target), { recursive: true });
        try {
            await rename(full, target);
            return;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        }
        // The trash is on another filesystem, which happens when a vault spans
        // mounts. Copy and then remove, so the copy exists before the original
        // stops existing.
        await cp(full, target, { recursive: true });
        await rm(full, { recursive: true, force: true });
    }

    /**
     * Where in the trash a path can go without displacing what is already there.
     *
     * Deleting, restoring and deleting again is ordinary, and the second
     * deletion overwriting the first would quietly discard a version somebody
     * might want. Numbered rather than timestamped so the order is obvious.
     */
    private async freeTrashPath(path: string): Promise<string> {
        const base = join(this.root, TRASH_DIR, path);
        const dot = basename(path).lastIndexOf(".");
        const [stem, ext] =
            dot <= 0 ? [base, ""] : [base.slice(0, base.length - (basename(path).length - dot)), base.slice(base.length - (basename(path).length - dot))];
        for (let n = 0; n < 1000; n++) {
            const candidate = n === 0 ? base : `${stem} (${n})${ext}`;
            try {
                await access(candidate, constants.F_OK);
            } catch {
                return candidate;
            }
        }
        throw new Error(`the trash already holds a thousand copies of ${path}`);
    }

    async mkdir(path: string): Promise<void> {
        const full = this.absolute(path);
        await this.insideForReal(full);
        await mkdir(full, { recursive: true });
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
                if (isTemporary(path)) return;
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

    /**
     * Writes the index durably, and only ever after the notes it describes.
     *
     * The engine writes every downloaded file in a pass and saves this once at
     * the end, so the ordering is already right. What was missing was the
     * durability underneath it: with neither the note nor the index fsynced, a
     * power cut could leave the index on disk saying a note was synced while the
     * note itself was not. On the next pass the file is missing, the index says
     * it matched the server, and `decideMissingLocally` reads that as "the user
     * deleted it" and propagates the deletion to every other device.
     *
     * That is a note lost silently, by a machine losing power at the wrong
     * moment, and it is the exact failure the first rule exists to refuse.
     */
    async save(state: StoredState): Promise<void> {
        await mkdir(dirname(this.file), { recursive: true });
        await writeDurably(this.file, new TextEncoder().encode(JSON.stringify(state)));
    }
}

/**
 * Marks this client's in-progress writes. Anything matching is not a note.
 *
 * A vault is somebody's own directory and they can name a file whatever they
 * like, so the suffix alone is not enough: the temp name used to be exactly
 * `<file>.basalt-tmp`, and a real attachment sitting at that path would be
 * overwritten by the next write of `<file>` and then renamed away. Unique names
 * make that a coincidence rather than a certainty, and creating them
 * exclusively makes it impossible.
 */
export const TEMP_MARK = ".basalt-tmp-";

/** Whether a vault-relative path is one of this client's temporary files. */
export function isTemporary(path: string): boolean {
    return path.includes(TEMP_MARK);
}

let tempCounter = 0;

/**
 * Creates a temporary file next to its destination, and never opens one that
 * already exists: `wx` fails rather than truncating, so a file somebody else
 * put there is refused instead of destroyed.
 */
async function openTemp(full: string): Promise<{ tmp: string; handle: Awaited<ReturnType<typeof open>> }> {
    for (let attempt = 0; attempt < 64; attempt++) {
        const tmp = `${full}${TEMP_MARK}${(tempCounter++).toString(36)}${attempt ? `-${attempt}` : ""}`;
        try {
            return { tmp, handle: await open(tmp, "wx") };
        } catch (err) {
            if ((err as { code?: string }).code !== "EEXIST") throw err;
        }
    }
    throw new Error(`could not find an unused temporary name beside ${full}`);
}

/**
 * Writes a file so that a crash leaves either the old contents or the new.
 *
 * The same four steps the server uses for a chunk body, and each earns its
 * keep. Writing in place would let a crash leave a half-written note. Renaming
 * without fsyncing the file means the rename can be durable while the bytes are
 * not. Renaming without fsyncing the *directory* means the bytes can be durable
 * while the name is not.
 *
 * Exported for the tests, which can check the outcome of every step except the
 * flushes themselves: whether an fsync really reached the platter is not
 * something a process can observe, on any operating system.
 */
export async function writeDurably(full: string, bytes: Uint8Array): Promise<void> {
    const { tmp, handle } = await openTemp(full);
    try {
        await handle.write(bytes);
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(tmp, full);

    const dir = await open(dirname(full), "r");
    try {
        await dir.sync();
    } finally {
        await dir.close();
    }
}
