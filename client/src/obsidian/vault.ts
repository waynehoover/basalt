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
 * and `fake.ts` beside this file implements that interface so everything below
 * can actually be run.
 *
 * ## normalizePath is not a formatting function
 *
 * Read out of the shipped `obsidian.asar`, it does four things, and two of them
 * change what file you are talking about:
 *
 *   - collapses runs of slashes and backslashes, and strips them from the ends
 *   - an empty path becomes "/", the vault root
 *   - a non-breaking space (U+00A0) or narrow no-break space (U+202F) becomes an
 *     ordinary space
 *   - the result is normalized to NFC, and macOS hands out filenames in NFD
 *
 * So `normalizePath(p)` can name a different file than `p`. The first version of
 * this file called it on paths that had just come back from `adapter.list`, then
 * skipped anything whose `stat` came back null, and the result was that a note
 * with a non-breaking space in its name disappeared from the listing entirely.
 * It would never have synced, and nothing would have said so.
 *
 * What is below keeps one keyspace. Everything the engine sees is normalized,
 * and where the adapter's own name for a file differs, that mapping is kept so
 * reads and writes still land on the real file.
 */

import { normalizePath, type DataAdapter } from "obsidian";

import type { FileStat, IndexStore, StoredState, Vault } from "../core/vault.ts";

/**
 * Names never synced, whatever the vault is configured to call things.
 *
 * `.trash` because a deletion arriving from another device is moved there, and
 * syncing it back would undo the deletion on every other device in turn.
 *
 * Obsidian's config folder is *not* in here, and that is deliberate: it is
 * `.obsidian` in almost every vault and the API says plainly that it could be
 * something else. Hardcoding the usual name would mean a vault with a custom one
 * uploaded the plugin's own folder, and that folder holds `data.json`, and
 * `data.json` holds the root secret. So the real name is passed in and there is
 * no default.
 */
const NEVER_SYNC = new Set([".basalt", ".trash", ".git", ".DS_Store"]);

export class ObsidianVault implements Vault {
    /**
     * Normalized path to the adapter's own name for it, where they differ.
     *
     * Filled in by `list`, and empty in the ordinary case, because Obsidian
     * normalizes paths as it indexes a vault and so hands back names that
     * already survive `normalizePath`. It exists for the names that do not: a
     * non-breaking space, or a filesystem handing out NFD. Without it, the
     * engine would be given a path that nothing could then read.
     */
    private readonly actualName = new Map<string, string>();
    private readonly ignore: Set<string>;

    /**
     * @param configDir Obsidian's own config folder, from `Vault.configDir`.
     *   Required rather than defaulted, because the default would be right
     *   almost always and catastrophic the rest of the time.
     */
    constructor(
        private readonly adapter: DataAdapter,
        configDir: string
    ) {
        const name = configDir.replace(/^\/+|\/+$/g, "");
        if (name === "" || name.includes("/")) {
            // Obsidian's config dir is a single folder at the vault root. If it
            // were ever anything else, silently ignoring the wrong thing is how
            // the root secret gets uploaded.
            throw new Error(`refusing to sync: the config folder ${JSON.stringify(configDir)} is not a plain name`);
        }
        this.ignore = new Set([...NEVER_SYNC, name]);
    }

    async list(): Promise<FileStat[]> {
        const out: FileStat[] = [];
        this.actualName.clear();

        // `adapter.list` is not recursive, so this walks. Breadth-first with an
        // explicit queue rather than recursion: a vault with a pathological
        // folder depth should not decide how deep the stack goes.
        //
        // The queue holds the adapter's own names, because that is what it will
        // be asked with next. What goes into `out` is the normalized name,
        // because that is what the engine will hold and hand back.
        const queue: string[] = ["/"];
        while (queue.length > 0) {
            const dir = queue.shift()!;
            const listed = await this.adapter.list(dir);

            for (const folder of listed.folders) {
                const raw = trimLeadingSlash(folder);
                const path = this.register(raw);
                if (this.ignored(path)) continue;
                out.push({ path, folder: true, mtime: 0, ctime: 0, size: 0 });
                queue.push(raw);
            }
            for (const file of listed.files) {
                const raw = trimLeadingSlash(file);
                const path = this.register(raw);
                if (this.ignored(path)) continue;
                // Stat by the adapter's own name, not the normalized one. The
                // path came from the adapter a line ago; renaming it before
                // asking about it is how a note went missing.
                const stat = await this.adapter.stat(raw);
                // A file that is listed and then does not stat is a deletion
                // that happened in between, which is ordinary. It is only a
                // silent omission when the path was mangled first, and it is
                // not mangled here.
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

    /** Records the adapter's name for a path, and returns the normalized one. */
    private register(raw: string): string {
        const normalized = normalizePath(raw);
        if (normalized !== raw) this.actualName.set(normalized, raw);
        return normalized;
    }

    /**
     * Turns a path from anywhere into the name the adapter knows.
     *
     * Paths reach this from two directions: out of `list`, already normalized,
     * and off the wire, sealed by another device and in whatever form that
     * device's filesystem uses. Both end up normalized, and then mapped back to
     * the adapter's own name if it has a different one.
     *
     * The refusals are for the second direction. The seal on a path proves it
     * came from somebody holding the vault key; it does not prove that device is
     * well, and a bug on it is enough to be handed `../../.ssh/authorized_keys`.
     */
    private resolve(path: string): string {
        const normalized = normalizePath(path);
        if (normalized === "/") {
            // What normalizePath returns for "", "/" and "///". It is the vault
            // root, which is not a file, and quietly doing something with it is
            // worse than refusing.
            throw new Error(`refusing an empty path: ${JSON.stringify(path)}`);
        }
        // normalizePath does not resolve "..", so this has to.
        if (normalized.split("/").some((part) => part === "..")) {
            throw new Error(`refusing a path outside the vault: ${path}`);
        }
        return this.actualName.get(normalized) ?? normalized;
    }

    /** Whether any part of a path is a name that never syncs. */
    private ignored(path: string): boolean {
        for (const part of path.split("/")) {
            if (this.ignore.has(part)) return true;
        }
        return false;
    }

    async read(path: string): Promise<Uint8Array> {
        return new Uint8Array(await this.adapter.readBinary(this.resolve(path)));
    }

    async write(path: string, bytes: Uint8Array, times: { mtime: number; ctime: number }): Promise<void> {
        const normalized = this.resolve(path);
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
        const normalized = this.resolve(path);
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
        const normalized = this.resolve(path);
        if (await this.adapter.exists(normalized)) return;
        await this.ensureParents(normalized);
        await this.adapter.mkdir(normalized);
    }

    async exists(path: string): Promise<boolean> {
        return this.adapter.exists(this.resolve(path));
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
