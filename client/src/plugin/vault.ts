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
 * docs/design.md says to verify against the artifact and never infer. The
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
 *
 * ## What the adapter's own writes are
 *
 * Also read out of the shipped bundle (`obsidian-1.13.7.asar`), because the
 * declarations do not say. `FileSystemAdapter.write` and `writeBinary` are
 * `fs.promises.writeFile` on the destination itself: the file is opened with
 * truncation and then written, so a full disk or a process killed between the
 * two leaves a note empty or short with no copy of what it held. And
 * `FileSystemAdapter.rename` throws "Destination file already exists!" when the
 * target exists, unless the two names differ only by case on a filesystem that
 * folds it. The Capacitor adapter was read again for 1.13.7 and makes the same
 * check with the same message and the same single exception before it hands
 * anything to the platform plugin, so the refusal is not desktop-only: what is
 * still the platform's is what happens if the destination appears between that
 * check and the rename, which is why `create` looks once more just before it.
 * So there is no replace-by-rename through this API on either platform, and
 * `replace` below says what is done instead.
 */

import {
  normalizePath,
  type DataAdapter,
  type TAbstractFile,
  type Vault as ObsidianVaultApi,
} from "obsidian";

import {
  configFolderName,
  firstFreeName,
  foldPath,
  foldsTogether,
  ignoredHere,
  ignoredHereError,
  isNeverSynced,
  neverSync,
} from "../core/paths.ts";
import { LastIndexWrite } from "../core/vault.ts";
import type { FileStat, IndexStamp, IndexStore, StoredState, Times, Vault } from "../core/vault.ts";

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

/**
 * The name every staging copy carries, so one can be told from a file of the
 * user's. Reserved: nothing else in a vault is expected to start with it.
 */
const STAGING_MARK = ".basalt-tmp-";

/**
 * Where a staged copy of `path` goes: beside it, under a name nothing syncs.
 *
 * Dot-prefixed, so `isNeverSynced` keeps it out of every listing and
 * Obsidian's own index never shows it as a note. Beside the destination
 * rather than in one folder, so the rename that lands it never crosses a
 * mount and the copy a failure leaves behind is next to the note it was for.
 *
 * With a random part, and looked for before use. A fixed name was a name a
 * person could have given a real dotfile, which the listing never shows and
 * a sync of the note beside it would have overwritten without a word.
 */
function stagingPath(normalized: string, nonce: string): string {
  const cut = normalized.lastIndexOf("/");
  const dir = cut === -1 ? "" : normalized.slice(0, cut + 1);
  const name = cut === -1 ? normalized : normalized.slice(cut + 1);
  return `${dir}${STAGING_MARK}${nonce}-${name}`;
}

/**
 * A staging name beside `normalized` that nothing occupies.
 *
 * The same search as the conflict copy and the trash, with a fresh nonce for
 * each try rather than a number: the name is random by design, and a numbered
 * second try would be exactly as guessable as the first. `stagingPath` puts
 * the dot prefix back on every candidate, which is what keeps the temporary
 * out of Obsidian's listing.
 */
async function freeStagingPath(adapter: Writer, normalized: string): Promise<string> {
  const named = () => stagingPath(normalized, nonce());
  return firstFreeName(named(), (path) => adapter.exists(path), named);
}

function nonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Writes and reads, minus the paths: what staging needs from an adapter. */
type Writer = Pick<
  DataAdapter,
  "writeBinary" | "readBinary" | "stat" | "exists" | "rename" | "remove"
>;

/**
 * Puts a staged copy of `bytes` at `temp` and proves it is all there.
 *
 * A failure leaves nothing behind: a short or refused staging copy is removed
 * before the error travels, because a temp that nothing will look at again is
 * clutter and a temp somebody might mistake for the note is worse.
 */
async function stage(
  adapter: Writer,
  temp: string,
  bytes: Uint8Array,
  options: { mtime?: number; ctime?: number },
): Promise<void> {
  try {
    await adapter.writeBinary(temp, bytes.slice().buffer, options);
    await verify(adapter, temp, bytes);
  } catch (err) {
    await adapter.remove(temp).catch(() => undefined);
    throw err;
  }
}

/**
 * Reads back what was written, or says how it differs. Rule 4.
 *
 * Every byte, whatever the size. A first version trusted the length alone
 * above a few megabytes to spare a phone a second copy of a large attachment,
 * and a staged copy of the right length with the wrong bytes would have been
 * renamed into place and become the note. The memory is a moment; the
 * corruption would have been for good.
 */
async function verify(adapter: Writer, path: string, bytes: Uint8Array): Promise<void> {
  const stat = await adapter.stat(path);
  if (stat === null || stat.type !== "file") {
    throw new Error(`${path} is not there after writing it`);
  }
  if (stat.size !== bytes.length) {
    throw new Error(`${path} is ${stat.size} bytes after writing ${bytes.length}`);
  }
  const back = new Uint8Array(await adapter.readBinary(path));
  if (back.length !== bytes.length) {
    throw new Error(`${path} reads back as ${back.length} bytes after writing ${bytes.length}`);
  }
  for (let i = 0; i < bytes.length; i++) {
    if (back[i] !== bytes[i]) {
      throw new Error(`${path} reads back differently from what was written, at byte ${i}`);
    }
  }
}

/**
 * What a desktop fsync needs from Node's `fs`, so a test can hand in a fake.
 *
 * The shape of `fs.promises.open` and the handle it returns, and nothing
 * else. Named rather than imported: the plugin bundle may not reference a
 * `node:` module, because on a phone there is none, and the build test reads
 * the bundle to make sure.
 */
export interface FsyncFs {
  promises: {
    open(path: string, flags: string): Promise<{ sync(): Promise<void>; close(): Promise<void> }>;
  };
}

/**
 * Node's `fs`, where Electron provides it, and nothing anywhere else.
 *
 * Obsidian's desktop renderer runs with Node integration, so `require` is a
 * global there and hands over the real module. On a phone there is no such
 * global, and the answer is undefined. Looked up through `globalThis` rather
 * than written as `require("fs")`, because the bundler would try to resolve
 * that and the build test would rightly refuse a bundle that names a Node
 * module.
 */
function electronFs(): FsyncFs | undefined {
  const req = (globalThis as { require?: (name: string) => unknown }).require;
  if (typeof req !== "function") return undefined;
  try {
    const mod = req("fs") as Partial<FsyncFs> | undefined;
    return mod?.promises && typeof mod.promises.open === "function" ? (mod as FsyncFs) : undefined;
  } catch {
    return undefined;
  }
}

/** The one method a `FileSystemAdapter` has that the Capacitor adapter does not. */
type DesktopAdapter = DataAdapter & { getFullPath(normalizedPath: string): string };

function isDesktopAdapter(adapter: DataAdapter): adapter is DesktopAdapter {
  return typeof (adapter as Partial<DesktopAdapter>).getFullPath === "function";
}

/** Opens one path for reading and fsyncs it, leaving no handle behind. */
async function fsyncPath(fs: FsyncFs, adapter: DesktopAdapter, path: string): Promise<void> {
  const handle = await fs.promises.open(adapter.getFullPath(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
  private readonly log: (message: string, ...rest: unknown[]) => void;

  /**
   * What this pass has written and not yet made durable: files, and the
   * directories whose entries changed under them. Cleared by `flush`.
   *
   * Each name carries the number of the write that owed it, counted from
   * `owed` below, so a flush can tell the write it is syncing from a later
   * one for the same name. Crossing a name off without that check crossed off
   * a write it had never seen: see `forget`.
   */
  private readonly unsynced = { files: new Map<string, number>(), dirs: new Map<string, number>() };
  /** Counts writes, so two of one file are two things owed and not one. */
  private owed = 0;
  /** Node's fs where there is one; resolved once, on the first flush. */
  private fsync: FsyncFs | undefined | null = null;
  private readonly fsOverride: FsyncFs | undefined;
  private saidNoDirSync = false;

  /**
   * @param vault Obsidian's own vault, read for its index of what exists.
   * @param configDir Obsidian's own config folder, from `Vault.configDir`.
   *   Required rather than defaulted, because the default would be right
   *   almost always and catastrophic the rest of the time.
   * @param log Where a non-fatal oddity is reported, such as a staging copy
   *   that could not be removed after the note it staged was verified.
   */
  constructor(
    private readonly vault: ObsidianVaultApi,
    configDir: string,
    log: (message: string, ...rest: unknown[]) => void = () => undefined,
    /** A stand-in for Node's fs, for tests. Never set in the plugin. */
    opts: { fs?: FsyncFs } = {},
  ) {
    this.adapter = vault.adapter;
    this.log = log;
    this.fsOverride = opts.fs;
    // Obsidian's config folder is *not* assumed to be `.obsidian`: the API
    // says plainly that it could be something else, and that folder holds
    // this plugin's `data.json`, which holds the root secret. So the real
    // name is passed in, and it is the one thing added to the rule in
    // core/paths.ts, which already covers every dot-prefixed name.
    this.ignore = new Set([configFolderName(configDir)]);
  }

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
    // And a short answer is not the range either. A file cut down between
    // being scanned and being fetched used to hand back what was left, which
    // was sealed as the chunk it no longer was and refused much later, by
    // name, with nothing pointing back here. Rule 4.
    if (got.length < end - start) {
      throw new Error(
        `${path} answered ${got.length} bytes for a read of ${end - start} at ${start}; it has changed since it was scanned`,
      );
    }
    return got;
  }

  /** Where the webview can fetch a file from. */
  private resourceUrl(path: string): string {
    return this.vault.adapter.getResourcePath(this.resolve(path));
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
   *
   * Two raw names that normalize to one path are refused, by name. The map
   * used to let the second one win, so one of two real files was read and
   * written under the other's name and recorded as synced, and the next scan
   * called the loser deleted. Nothing syncs until somebody renames one,
   * which is the only outcome that does not lose a note.
   */
  async list(): Promise<FileStat[]> {
    const out: FileStat[] = [];
    this.actualName.clear();
    const seen = new Map<string, string>();
    const items = this.vault.getAllLoadedFiles();
    await this.probeCase(items);

    for (const item of items) {
      const raw = trimLeadingSlash(item.path);
      if (raw === "" || raw === "/") continue; // the vault root itself
      const path = this.register(raw);
      const other = seen.get(path);
      if (other !== undefined && other !== raw) {
        throw new Error(
          `two files in this vault are the same path once normalized, ${JSON.stringify(other)} and ` +
            `${JSON.stringify(raw)}, and only one of them can sync. Rename one of them.`,
        );
      }
      seen.set(path, raw);
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
   * What the disk files a path under, so two paths that are one file here can
   * be told from two files.
   *
   * `normalizePath` first, because that is the keyspace everything else here
   * uses and it already folds NFC and Obsidian's no-break spaces. Case is
   * folded only where the adapter has been seen to fold it, and until it has
   * been asked the answer is that it does, which refuses two files where one
   * would have done rather than the reverse.
   */
  canonical(path: string): string {
    const normalized = normalizePath(path);
    return this.foldsCase ? normalized.toLowerCase() : normalized;
  }

  private foldsCase = true;
  private probed = false;

  /**
   * Asks the adapter whether it folds case, once, without writing anything.
   *
   * `exists` on a folding filesystem answers yes for a spelling that differs
   * from the real one only by case, and no on one that does not. So the
   * first file in the index with a letter in it is asked about under a
   * flipped spelling, provided nothing is really spelled that way. Obsidian
   * itself knows the answer but does not expose it.
   */
  private async probeCase(items: TAbstractFile[]): Promise<void> {
    if (this.probed) return;
    const paths = new Set(items.map((i) => trimLeadingSlash(i.path)));
    let looked = false;
    for (const item of items) {
      if (statOf(item) === undefined) continue;
      looked = true;
      const raw = trimLeadingSlash(item.path);
      const flipped = flipCase(raw);
      if (flipped === raw) continue;
      // Both spellings in the index is the answer already: a filesystem that
      // folded case could not hold them both.
      this.foldsCase = paths.has(flipped) ? false : await this.adapter.exists(flipped);
      this.probed = true;
      return;
    }
    // Files were looked at and none of them has a letter in it. A vault of
    // numeric names would otherwise be walked in full on every `list()`, for
    // ever, to reach the same answer (B12). Settling for the default is
    // settling on the safe side: folding refuses two paths a case-sensitive
    // disk could have held apart, rather than overwriting one with the other.
    // An empty listing is not an answer and does not settle anything.
    if (looked) this.probed = true;
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
      // Two refusals, because they mean different things to the engine (R2).
      // A dot-prefixed name cannot work here and never will. The config
      // folder is this device's configuration: a peer whose config folder is
      // named something else uploads paths under it, and this device saying
      // no to those is the arrangement working, not a fault.
      throw ignoredHere(normalized, this.ignore)
        ? ignoredHereError(`not writing under a name this device does not sync: ${path}`)
        : neverSync(`refusing to write inside a folder that is never synced: ${path}`);
    }
    return this.actualName.get(normalized) ?? normalized;
  }

  /**
   * Whether any part of a path is a name that never syncs.
   *
   * The shared rule, so both shells and both directions agree. Obsidian's
   * index omits every dot-prefixed path, so the listing here could never
   * name one; a filter on the way in that refused only five names accepted
   * the rest, and a file written and never listed is reported deleted.
   */
  private ignored(path: string): boolean {
    return isNeverSynced(path, this.ignore);
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.adapter.readBinary(this.resolve(path)));
  }

  async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    const normalized = this.resolve(path);
    await this.ensureParents(normalized);
    await this.matchCase(normalized);
    // Copied into its own buffer. A Uint8Array that is a view into a larger
    // one would hand over neighbouring bytes, and chunk reassembly produces
    // exactly that kind of view.
    await this.replace(normalized, bytes.slice(), writeOptions(times));
    this.wrote(normalized);
  }

  /** Remembers a file whose bytes or name changed, for `flush`. */
  private wrote(normalized: string): void {
    this.unsynced.files.set(normalized, ++this.owed);
    this.entryChanged(normalized);
  }

  /** Remembers the directory a path lives in, whose entries have changed. */
  private entryChanged(normalized: string): void {
    const cut = normalized.lastIndexOf("/");
    this.unsynced.dirs.set(cut === -1 ? "" : normalized.slice(0, cut), ++this.owed);
  }

  /**
   * Crosses a name off, unless something owed it again while it was in hand.
   *
   * The flush syncs a name and then forgets it, and between those two it has
   * awaited. A write that landed in that gap put the same name back, and the
   * forget used to take it away again: the bytes it wrote were never fsynced
   * and the index that followed named them as durable, which is the one
   * ordering rule 3 forbids here. A different file was already safe, because
   * the flush had never held its name; the same file was not, and neither was
   * the directory a new file had just appeared in.
   *
   * Nothing in the engine writes during a flush today, because a pass is
   * awaited end to end and passes are queued one at a time. This is what the
   * file said it did, made true, so that the ordering does not rest on a
   * property of a caller in another module.
   */
  private forget(owed: Map<string, number>, path: string, stamp: number): void {
    if (owed.get(path) === stamp) owed.delete(path);
  }

  /**
   * Makes this pass's writes durable, on desktop.
   *
   * The engine calls this before it saves the index, so the index is never
   * durable ahead of the notes it names (rule 3, in the form the header of
   * core/vault.ts gives it). `DataAdapter` has no way to ask for this, so
   * for a long time the plugin's answer was nothing at all and the ordering
   * the engine relies on held only by luck (P25).
   *
   * On desktop the adapter is Electron's `FileSystemAdapter`, the vault is
   * a real directory, and Node's fs is a `require` away: every file written
   * this pass is opened and fsynced, and so is every directory whose
   * entries changed, because a rename or a create is durable only once its
   * directory is. On a phone the adapter is Capacitor's, there is no fs to
   * reach, and this does nothing: durability there is whatever the platform
   * gives the adapter's own writes, which docs/plugin.md calls best effort.
   *
   * A directory that cannot be opened for syncing is logged once and not
   * raised. Windows refuses it, and a note that is itself synced with its
   * directory entry pending is a far better state than a pass that cannot
   * finish.
   *
   * A file is forgotten when it has been synced and not before. This used to
   * empty both sets first and stop at the first file that would not open, so
   * one transient failure skipped every later file in the pass and then lost
   * the record of all of them: the retry found nothing to flush, and the
   * index could be saved over notes that had never been made durable. Now
   * every file is attempted, the ones that failed stay for the next pass, and
   * the first failure is what the pass fails with.
   *
   * Keeping failures is only safe while a path that has gone is not one of
   * them. A file written and then deleted, here or by anybody else, cannot be
   * opened to be synced and has nothing left to make durable; counted as a
   * failure it would stay in the set, fail again on every later flush, and
   * block index saves for the rest of the session (R6).
   */
  async flush(): Promise<void> {
    const files = [...this.unsynced.files];
    const dirs = [...this.unsynced.dirs];
    if (this.fsync === null) {
      this.fsync = this.fsOverride ?? (isDesktopAdapter(this.adapter) ? electronFs() : undefined);
    }
    const fs = this.fsync;
    if (fs === undefined || !isDesktopAdapter(this.adapter)) {
      // Nothing here can ever sync them, so holding on to the names is a set
      // that grows for the life of the session and syncs nothing.
      this.unsynced.files.clear();
      this.unsynced.dirs.clear();
      return;
    }
    const adapter = this.adapter;
    let failure: unknown;
    for (const [path, stamp] of files) {
      try {
        await fsyncPath(fs, adapter, path);
        // Dropped one at a time rather than cleared, and only the write this
        // one synced, so a write that landed while it was running is still
        // waiting for the next flush.
        this.forget(this.unsynced.files, path, stamp);
      } catch (err) {
        // Gone rather than unopenable: there is nothing to make durable, so
        // the name is dropped and the pass carries on. Asked of the adapter
        // rather than read off the error, because a platform is free to
        // report a missing file however it likes.
        if (!(await this.adapter.exists(path))) {
          this.forget(this.unsynced.files, path, stamp);
          continue;
        }
        failure ??= err;
      }
    }
    for (const [dir, stamp] of dirs) {
      try {
        await fsyncPath(fs, adapter, dir);
      } catch (err) {
        if (!this.saidNoDirSync) {
          this.saidNoDirSync = true;
          this.log(
            "this platform will not sync a directory, so a new file's name is durable when the disk says",
            (err as Error).message,
          );
        }
      }
      // Dropped either way: this failure is tolerated rather than retried,
      // and a platform that refuses would refuse for ever. Still only the
      // change this one synced, for the reason `forget` gives.
      this.forget(this.unsynced.dirs, dir, stamp);
    }
    if (failure !== undefined) throw failure;
  }

  /**
   * Lands bytes at a path without a moment in which the note is half written
   * and nowhere complete.
   *
   * The adapter's own write truncates the destination and then fills it (see
   * the header), so a failure in between used to leave the note empty with
   * no copy of what it held or of what was arriving. Now the bytes go to a
   * staged copy beside the destination first and are read back from it.
   *
   * Onto a path with nothing at it, the staged copy is renamed into place,
   * which the desktop adapter does atomically. Onto an occupied path it
   * cannot be: `rename` refuses an existing destination, verified in the
   * shipped bundle, so the fallback is the adapter's own write in place,
   * taken only once the staged copy has been proven complete and kept until
   * the destination has been read back too. The window in which the
   * destination is short still exists on that path, but for the whole of it
   * a verified copy of the new bytes sits beside it and the old bytes are the
   * server's newest version; a failure names the copy so a person can find
   * it.
   */
  private async replace(
    normalized: string,
    bytes: Uint8Array,
    options: { mtime?: number; ctime?: number },
  ): Promise<void> {
    const temp = await freeStagingPath(this.adapter, normalized);
    await stage(this.adapter, temp, bytes, options);

    if (!(await this.adapter.exists(normalized))) {
      try {
        await this.adapter.rename(temp, normalized);
        await verify(this.adapter, normalized, bytes);
      } catch (err) {
        await this.adapter.remove(temp).catch(() => undefined);
        throw err;
      }
      return;
    }

    try {
      await this.adapter.writeBinary(normalized, bytes.slice().buffer, options);
      await verify(this.adapter, normalized, bytes);
    } catch (err) {
      // The staged copy stays. It is the only complete copy of the new
      // version on this device, and the destination may now be short.
      throw new Error(
        `writing ${normalized} failed: ${(err as Error).message}. ` +
          `The complete new content is beside it at ${temp}`,
      );
    }
    await this.discardStaging(temp);
  }

  /**
   * Removes a staging copy the destination no longer needs.
   *
   * A failure here is logged and not raised. The note is complete and
   * verified; raising would have the engine write it again next pass, fail
   * the same cleanup, and go round for ever with a correct file on disk.
   */
  private async discardStaging(temp: string): Promise<void> {
    try {
      await this.adapter.remove(temp);
    } catch (err) {
      this.log(
        "could not remove a staging copy after the note it staged was verified; it is safe to delete",
        temp,
        (err as Error).message,
      );
    }
  }

  /**
   * Writes a file only if nothing is at the path, and says whether it did.
   *
   * The staged copy is renamed into place, and `rename` refusing an occupied
   * destination is what makes the claim exclusive on desktop. The Capacitor
   * adapter's answer to an occupied destination is the platform's, so the
   * path is looked at once more just before the rename to make the gap as
   * narrow as this API allows, and a refusal is read as "taken" whenever
   * something is there afterwards.
   */
  async create(path: string, bytes: Uint8Array, times: Times): Promise<boolean> {
    const normalized = this.resolve(path);
    if (await this.adapter.exists(normalized)) return false;
    await this.ensureParents(normalized);
    const temp = await freeStagingPath(this.adapter, normalized);
    await stage(this.adapter, temp, bytes.slice(), writeOptions(times));

    if (await this.adapter.exists(normalized)) {
      await this.discardStaging(temp);
      return false;
    }
    try {
      await this.adapter.rename(temp, normalized);
    } catch (err) {
      await this.adapter.remove(temp).catch(() => undefined);
      if (await this.adapter.exists(normalized)) return false;
      throw err;
    }
    await verify(this.adapter, normalized, bytes);
    this.wrote(normalized);
    return true;
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
   *
   * A listing that fails fails the write. It used to be skipped, and the
   * write went ahead under a spelling nothing had checked: the old spelling
   * stayed on disk, the engine recorded the new one as synced, and the next
   * scan reported it deleted.
   */
  private async matchCase(normalized: string): Promise<void> {
    if (!(await this.adapter.exists(normalized))) return;

    const cut = normalized.lastIndexOf("/");
    const dir = cut === -1 ? "/" : normalized.slice(0, cut);
    let listed;
    try {
      listed = await this.adapter.list(dir);
    } catch (err) {
      throw new Error(
        `cannot check how ${normalized} is spelled on disk, so it was not written: ${(err as Error).message}`,
      );
    }
    if (listed.files.includes(normalized)) return; // Already spelled this way.

    const folded = foldPath(normalized);
    const actual = listed.files.find((f) => foldPath(f) === folded);
    if (actual === undefined || actual === normalized) return;
    await this.adapter.rename(actual, normalized);
    this.actualName.delete(actual);
    // A rename is a changed entry in the directory holding it, and durable
    // only when that directory is. The write that follows records the file.
    this.entryChanged(normalized);
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
    if (!foldsTogether(left, right)) return false;

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
    if (!(await this.adapter.exists(normalized))) {
      // Already gone, by hand or by another pass. It still owes nothing: a
      // write earlier in this pass may have left the name owed, and there is
      // no file left to open and fsync for it. The next flush's own check
      // would drop it a cycle later; dropping it here is where the fact is
      // known (N7, R6).
      this.wentAway(normalized);
      return;
    }
    // Either way it left its directory, and a pass that only deleted used to
    // save the index without ever fsyncing the directory it changed.
    try {
      if (await this.adapter.trashSystem(normalized)) {
        this.wentAway(normalized);
        return;
      }
    } catch {
      // No system trash here, or it refused. The local one is next, and a
      // failure to reach the recycle bin is not a reason to give up on the
      // deletion.
    }
    await this.adapter.trashLocal(normalized);
    this.wentAway(normalized);
  }

  /**
   * Records a path that has left the vault.
   *
   * Its directory has a changed entry, as any deletion does. The file itself
   * is dropped from what the flush owes: there is nothing at that name to open
   * and sync, and a write earlier in the same pass may well have left one
   * owed. Kept, it would fail every flush from here on and block the index
   * saves that follow them (R6). Only after the deletion has actually
   * happened, so a trash that refused still leaves the file owed.
   */
  private wentAway(normalized: string): void {
    this.unsynced.files.delete(normalized);
    this.entryChanged(normalized);
  }

  async mkdir(path: string): Promise<void> {
    const normalized = this.resolve(path);
    if (await this.adapter.exists(normalized)) return;
    await this.ensureParents(normalized);
    await this.adapter.mkdir(normalized);
    // A new directory is an entry in its parent, durable when the parent is.
    this.entryChanged(normalized);
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
        this.entryChanged(at);
      }
    }
  }
}

/** The adapter's write options for the times the engine hands over. */
function writeOptions(times: Times): {
  mtime?: number;
  ctime?: number;
} {
  return {
    ...(times.mtime > 0 ? { mtime: times.mtime } : {}),
    ...(times.ctime > 0 ? { ctime: times.ctime } : {}),
  };
}

/** The same path with the case of its first cased letter flipped, or itself. */
function flipCase(path: string): string {
  for (let i = 0; i < path.length; i++) {
    const c = path[i]!;
    const upper = c.toUpperCase();
    const lower = c.toLowerCase();
    if (upper === lower) continue;
    return path.slice(0, i) + (c === upper ? lower : upper) + path.slice(i + 1);
  }
  return path;
}

/**
 * The index, in the plugin's own data folder.
 *
 * Kept out of the vault proper so it never syncs and never appears as a note.
 * Written through the adapter rather than the filesystem, because on mobile
 * there is no filesystem to write to.
 *
 * Written the way notes are, staged and read back, because the adapter's write
 * truncates first. An index cut short by a crash was not valid JSON, and an
 * index that is not valid JSON stops the plugin on every load (rule 2), so one
 * bad moment put a vault whose notes were all fine behind a plugin that would
 * not start. The staged copy is the way back: `load` reads it when the live
 * file cannot be read, because it is complete and describes a state at least as
 * new.
 */
export class ObsidianIndexStore implements IndexStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly path: string,
  ) {}

  private get live(): string {
    return normalizePath(this.path);
  }

  /**
   * A fixed name, unlike a note's staging copy, because `load` has to find it
   * after a restart. Inside the plugin's own folder, so nothing of the user's
   * can be there under that name.
   */
  private get temp(): string {
    return stagingPath(this.live, "index");
  }

  async load(): Promise<StoredState | undefined> {
    const live = await this.readIndex(this.live);
    if (live.state !== undefined) {
      // A staging copy left behind means a save was interrupted after the
      // live file was complete, or never got as far as touching it. The
      // live file is complete and parses, so it is the state to start
      // from; an older index is always safe, because notes are durable
      // before the index that names them.
      if (await this.adapter.exists(this.temp)) await this.adapter.remove(this.temp);
      // What is on disk is what was last written, so a first pass that
      // changes nothing writes nothing. Only from the live file: a state
      // read out of the staging copy is not what the live file holds.
      this.last.wrote(live.text!, await this.stamp());
      return live.state;
    }
    const staged = await this.readIndex(this.temp);
    if (staged.state !== undefined) return staged.state;
    if (live.error !== undefined) {
      // A read that fails is not an absent index. Rule 2, and the incident
      // it came from: falling back to an empty result and writing it back
      // disabled every plugin on a device.
      throw new Error(`the index at ${this.path} is not valid JSON: ${live.error}`);
    }
    return undefined;
  }

  /** One index file: its state, or the reason it has none. */
  private async readIndex(
    path: string,
  ): Promise<{ state?: StoredState; text?: string; error?: string; absent?: true }> {
    if (!(await this.adapter.exists(path))) return { absent: true };
    const text = await this.adapter.read(path);
    try {
      return { state: JSON.parse(text) as StoredState, text };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /**
   * What this session last wrote, and how it looked on disk (R3).
   *
   * The rule, and the reasoning behind it, is `LastIndexWrite` in core, shared
   * with the headless client's store so the two cannot drift apart again.
   */
  private readonly last = new LastIndexWrite();

  /** The live index's size and modification time, or undefined if it is not a file. */
  private async stamp(): Promise<IndexStamp | undefined> {
    const stat = await this.adapter.stat(this.live);
    if (stat === null || stat.type !== "file") return undefined;
    return { size: stat.size, mtime: stat.mtime };
  }

  async save(state: StoredState): Promise<void> {
    const text = JSON.stringify(state);
    const live = this.live;
    if (this.last.matches(text, await this.stamp())) return;
    const parts = live.split("/");
    parts.pop();
    if (parts.length > 0) {
      const dir = parts.join("/");
      if (dir !== "" && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    }

    const temp = this.temp;
    const bytes = new TextEncoder().encode(text);
    await stage(this.adapter, temp, bytes, {});
    if (!(await this.adapter.exists(live))) {
      try {
        await this.adapter.rename(temp, live);
        await verify(this.adapter, live, bytes);
      } catch (err) {
        await this.adapter.remove(temp).catch(() => undefined);
        throw err;
      }
    } else {
      // In place, because rename refuses an occupied destination (see the
      // header of this file). The staged copy stays until the live file has
      // been read back, and stays for good if it never is: `load` finds it.
      await this.adapter.write(live, text);
      await verify(this.adapter, live, bytes);
      // The live index is verified, so a staged copy that will not go is
      // clutter and not a failure: raising here would have the next pass
      // write the same index again and fail the same way, for ever. `load`
      // removes it the next time the plugin starts.
      await this.adapter.remove(temp).catch(() => undefined);
    }
    this.last.wrote(text, await this.stamp());
  }

  /**
   * Removes the index, both copies, and proves they are gone.
   *
   * What unlink needs. An index left behind is read by the next pairing as
   * the truth about a server that has never seen this device, and a staged
   * copy left behind is read by `load` as the index.
   */
  async remove(): Promise<void> {
    for (const path of [this.live, this.temp]) {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
      if (await this.adapter.exists(path)) {
        throw new Error(`${path} is still there after removing it`);
      }
    }
    this.last.forget();
  }
}

function trimLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}
