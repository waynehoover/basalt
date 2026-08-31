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

import {
  normalizePath,
  type DataAdapter,
  type TAbstractFile,
  type Vault as ObsidianVaultApi,
} from "obsidian";

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

/**
 * A file's size and times, or undefined when the thing is a folder.
 *
 * Structural rather than an `instanceof TFile`, because class identity across a
 * plugin boundary works until a build changes and then fails in a way that
 * looks like an empty vault.
 */
function statOf(item: TAbstractFile): { mtime: number; ctime: number; size: number } | undefined {
  const stat = (item as { stat?: { mtime: number; ctime: number; size: number } }).stat;
  return stat && typeof stat.size === "number" ? stat : undefined;
}

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
  private readonly adapter: DataAdapter;

  /**
   * @param vault Obsidian's own vault, read for its index of what exists.
   * @param configDir Obsidian's own config folder, from `Vault.configDir`.
   *   Required rather than defaulted, because the default would be right
   *   almost always and catastrophic the rest of the time.
   */
  constructor(
    private readonly vault: ObsidianVaultApi,
    configDir: string,
  ) {
    this.adapter = vault.adapter;
    const name = configDir.replace(/^\/+|\/+$/g, "");
    if (name === "" || name.includes("/")) {
      // Obsidian's config dir is a single folder at the vault root. If it
      // were ever anything else, silently ignoring the wrong thing is how
      // the root secret gets uploaded.
      throw new Error(
        `refusing to sync: the config folder ${JSON.stringify(configDir)} is not a plain name`,
      );
    }
    this.ignore = new Set([...NEVER_SYNC, name]);
  }

  /**
   * Everything in the vault, from Obsidian's own index.
   *
   * `getAllLoadedFiles` returns what the application already has in memory,
   * with each file's size and times attached. The alternative, and what this
   * did first, was to walk `adapter.list` and `stat` every file. That is one
   * call per file per pass through the adapter, which on a desktop is merely
   * wasteful and on a phone is the difference between a scan you do not
   * notice and one you do. The walk is gone; nothing is read that Obsidian
   * has not already read.
   *
   * A folder is told from a file structurally, by whether it carries a
   * `stat`, rather than by `instanceof`. Class identity across a plugin
   * boundary is a thing that works until a build changes.
   */
  /**
   * The file in blocks, without `DataAdapter` having a streaming read.
   *
   * `getResourcePath` returns the URL the webview already uses to show an
   * image or play an audio note, and that URL can be fetched. The response
   * carries a body stream, so a large attachment can be cut and named a chunk
   * at a time instead of being handed over whole.
   *
   * Verified in a running Obsidian on desktop: fetch succeeds, `res.body` is
   * a stream, and a ranged request returns the right bytes from the middle of
   * a file rather than the first N. Mobile is Capacitor and its resource URLs
   * are a different scheme, which nothing here has tested, so the engine
   * treats a failure as "this platform cannot" and falls back to reading the
   * file whole.
   */
  async *readBlocks(path: string, blockSize = 1024 * 1024): AsyncGenerator<Uint8Array> {
    const res = await fetch(this.resourceUrl(path));
    if (!res.ok || !res.body) {
      throw new Error(`cannot stream ${path}: the vault answered ${res.status}`);
    }
    const reader = res.body.getReader();
    // Re-blocked rather than passed through, because what a fetch hands back
    // is whatever the transport felt like and the chunker should not have
    // its memory decided by that.
    //
    // Filled into one buffer rather than grown by concatenation. Growing it
    // reallocated and copied everything held on every arriving piece, so moving
    // 64 MiB copied 2144 MiB and allocated 4160 buffers when the pieces came
    // 16 KiB at a time: 33x the file, to move the file. This is 128 MiB and 65
    // buffers. Wall clock barely notices on a laptop; allocation churn is the
    // axis that matters on a phone, which is where this path runs.
    //
    // `subarray` was the other half of it: the remainder kept the whole block
    // alive to hold a few spare kilobytes.
    const block = new Uint8Array(blockSize);
    let filled = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (value && value.length > 0) {
        let at = 0;
        while (at < value.length) {
          const take = Math.min(blockSize - filled, value.length - at);
          block.set(value.subarray(at, at + take), filled);
          filled += take;
          at += take;
          if (filled === blockSize) {
            yield block.slice(0, blockSize);
            filled = 0;
          }
        }
      }
      if (done) break;
    }
    if (filled > 0) yield block.slice(0, filled);
  }

  async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
    const res = await fetch(this.resourceUrl(path), {
      headers: { Range: `bytes=${start}-${end - 1}` },
    });
    if (!res.ok)
      throw new Error(`cannot read ${path} at ${start}: the vault answered ${res.status}`);
    const got = new Uint8Array(await res.arrayBuffer());
    // A handler that ignored the Range would answer with the whole file,
    // which would then be sealed and refused for not matching its name. Said
    // here instead, where the reason is knowable.
    if (got.length > end - start) {
      throw new Error(`this vault does not honour ranged reads, so ${path} cannot be streamed`);
    }
    return got;
  }

  /** Where the webview can fetch a file from. */
  private resourceUrl(path: string): string {
    return this.vault.adapter.getResourcePath(this.resolve(path));
  }

  async list(): Promise<FileStat[]> {
    const out: FileStat[] = [];
    this.actualName.clear();

    for (const item of this.vault.getAllLoadedFiles()) {
      const raw = trimLeadingSlash(item.path);
      if (raw === "" || raw === "/") continue; // the vault root itself
      const path = this.register(raw);
      if (this.ignored(path)) continue;

      const stat = statOf(item);
      if (stat === undefined) {
        out.push({ path, folder: true, mtime: 0, ctime: 0, size: 0 });
        continue;
      }
      out.push({
        path,
        folder: false,
        mtime: stat.mtime,
        // Carried because the protocol carries it, and read by nothing
        // that decides. Obsidian ships native addons for five platforms
        // to get this value in its headless client, which is a fair
        // measure of how much it is worth.
        ctime: stat.ctime,
        size: stat.size,
      });
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
    // The same rule as the headless client, and for the same reason: this
    // set was consulted on the way out and not on the way in, so a path the
    // plugin would never upload was one it would write. Under the config
    // folder that means `main.js` of an installed plugin, which Obsidian
    // executes on the next reload, and this plugin's own `data.json`.
    if (this.ignored(normalized)) {
      throw new Error(`refusing to write inside a folder that is never synced: ${path}`);
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

  async write(
    path: string,
    bytes: Uint8Array,
    times: { mtime: number; ctime: number },
  ): Promise<void> {
    const normalized = this.resolve(path);
    await this.ensureParents(normalized);
    await this.matchCase(normalized);
    // Copied into its own buffer. A Uint8Array that is a view into a larger
    // one would hand over neighbouring bytes, and chunk reassembly produces
    // exactly that kind of view.
    const buffer = bytes.slice().buffer;
    await this.adapter.writeBinary(normalized, buffer, {
      ...(times.mtime > 0 ? { mtime: times.mtime } : {}),
      ...(times.ctime > 0 ? { ctime: times.ctime } : {}),
    });
  }

  /**
   * Renames an existing file to the spelling being written, where they differ.
   *
   * macOS and Windows fold case, so writing `NOTE.md` over an existing
   * `Note.md` writes the same file and leaves the name spelled the old way.
   * The bytes are then right and the name is not, the next scan calls the new
   * name missing, and the deletion that follows travels to every device. A
   * rename that changed only case lost the note, one pass after it looked
   * fine. Obsidian's own index is asked rather than the platform guessed at.
   */
  private async matchCase(normalized: string): Promise<void> {
    if (!(await this.adapter.exists(normalized))) return;

    const cut = normalized.lastIndexOf("/");
    const dir = cut === -1 ? "/" : normalized.slice(0, cut);
    let listed;
    try {
      listed = await this.adapter.list(dir);
    } catch {
      return;
    }
    if (listed.files.includes(normalized)) return; // Already spelled this way.

    const folded = normalized.normalize("NFC").toLowerCase();
    const actual = listed.files.find((f) => f.normalize("NFC").toLowerCase() === folded);
    if (actual === undefined || actual === normalized) return;
    await this.adapter.rename(actual, normalized);
    this.actualName.delete(actual);
  }

  /**
   * Whether two paths are one file, according to Obsidian's own listing.
   *
   * Two spellings that fold together and appear once between them are one
   * file. The engine asks before applying a deletion, because deleting the old
   * name of a case-only rename would delete the note it just wrote.
   */
  async sameFile(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const left = this.resolve(a);
    const right = this.resolve(b);
    if (left === right) return true;
    if (left.normalize("NFC").toLowerCase() !== right.normalize("NFC").toLowerCase()) return false;

    const cut = left.lastIndexOf("/");
    const dir = cut === -1 ? "/" : left.slice(0, cut);
    try {
      const listed = await this.adapter.list(dir);
      // Both spellings present means two files, and both deserve their fate.
      return !(listed.files.includes(left) && listed.files.includes(right));
    } catch {
      return true;
    }
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
    private readonly path: string,
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

  /**
   * The last thing written, so an unchanged index is not written again.
   *
   * A pass ends by saving whether or not anything happened, and a settled
   * vault passes on every watch tick and every keepalive. At 2000 files that
   * was a 9 MiB serialisation and two fsyncs every thirty seconds, for ever,
   * to record that nothing had changed; at 10k it measured 21 ms of which 11
   * ms was the flushes. Two separate audits found this independently, which is
   * the best evidence a thing is real.
   *
   * Comparing the string is not free either, but stringify is 2.1 ms against
   * 10.7 ms of fsync, so it pays for itself the first time it matches. And a
   * write skipped because the bytes on disk are already those bytes cannot
   * lose anything: the failure it would cause is the failure it prevents.
   */
  private lastWritten: string | undefined;

  async save(state: StoredState): Promise<void> {
    const text = JSON.stringify(state);
    if (text === this.lastWritten) return;
    const normalized = normalizePath(this.path);
    const parts = normalized.split("/");
    parts.pop();
    if (parts.length > 0) {
      const dir = parts.join("/");
      if (dir !== "" && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    }
    await this.adapter.write(normalized, text);
    this.lastWritten = text;
  }
}

function trimLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}
