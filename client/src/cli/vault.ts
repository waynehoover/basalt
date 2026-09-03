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
import { createHash } from "node:crypto";
import {
  access,
  cp,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { configFolderName, foldPath, isNeverSynced, neverSync, splitName } from "../core/paths.ts";
import type { FileStat, IndexStore, StoredState, Vault } from "../core/vault.ts";

/**
 * Where a deletion arriving from another device goes, rather than away.
 *
 * Dot-prefixed, so `isNeverSynced` keeps it out of the listing and what lands
 * there does not travel back out and undo the deletion everywhere else.
 */
const TRASH_DIR = ".trash";

/**
 * Names this client leaves alone on top of the rule in core/paths.ts.
 *
 * Every dot-prefixed segment is already refused there: the config folder,
 * `.basalt` (this client's own bookkeeping, and syncing it would sync the
 * index to itself), the trash, `.git`. What is left is the one name a headless
 * client meets that Obsidian does not.
 *
 * The config folder is added too, because somebody can rename it to something
 * without a dot. Syncing plugins and settings is not done here; that is an
 * open question rather than a closed refusal, and docs/design.md argues both
 * sides of it. Which folder it is comes from --config-dir, since only Obsidian
 * knows for certain and this cannot ask.
 */
const NEVER_SYNC = new Set(["node_modules"]);

/** What Obsidian calls its config folder unless the user has overridden it. */
export const DEFAULT_CONFIG_DIR = ".obsidian";

export { configFolderName };

export interface NodeVaultOptions {
  /** Extra names to leave alone, at any depth. */
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

  /** The vault root with its links resolved, worked out once. */
  private realRootOnce: Promise<string> | undefined;

  /**
   * Directories written to since the last flush.
   *
   * A set, because the saving is entirely in not flushing the same folder once
   * per file in it.
   */
  private readonly unflushed = new Set<string>();

  /**
   * Makes durable the directory entries of everything written since the last
   * call. The engine calls this before it saves the index, which is what keeps
   * the index from being durable ahead of the notes it names.
   */
  async flush(): Promise<void> {
    const dirs = [...this.unflushed];
    this.unflushed.clear();
    // Every directory is attempted, and the ones that failed go back on
    // the list. Clearing first and syncing second lost the retry: a sync
    // that failed once was never asked for again, and the next otherwise
    // clean pass saved an index naming files whose directory entries had
    // never been made durable.
    const outcomes = await Promise.allSettled(dirs.map((d) => syncDirectory(d)));
    let first: unknown;
    outcomes.forEach((o, i) => {
      if (o.status === "rejected") {
        this.unflushed.add(dirs[i]!);
        first ??= o.reason;
      }
    });
    if (first !== undefined) throw first;
  }

  /**
   * Remembers that a path's directory entries changed, so `flush` makes them
   * durable before the index is saved.
   *
   * Every ancestor that did not exist before is new content in *its* parent,
   * so the directories from the deepest one that already existed down to the
   * path's parent are all dirty. Only writes used to register, so a folder
   * made for a note, a case rename, a move into the trash and the copy across
   * a mount all changed names on disk that nothing then synced.
   */
  private dirty(full: string, deepestExisting: string): void {
    let at = dirname(full);
    this.unflushed.add(at);
    while (at !== deepestExisting && at.startsWith(this.root) && at !== this.root) {
      at = dirname(at);
      this.unflushed.add(at);
    }
  }

  /** The deepest ancestor of a path that exists now, before anything is created. */
  private async deepestExisting(full: string): Promise<string> {
    let at = dirname(full);
    for (;;) {
      try {
        await access(at, constants.F_OK);
        return at;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const up = dirname(at);
      if (up === at) return at;
      at = up;
    }
  }

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
    const outside = relative(this.root, full);
    if (outside === "" || outside === ".." || outside.startsWith(`..${sep}`)) {
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
    //
    // Then it was read on the way in for the first segment only, while
    // `list` skipped every depth, so `notes/.git/hooks/post-checkout` from
    // a peer was written, never listed, and reported deleted on the next
    // pass. One predicate, the same one `list` and `watch` use.
    if (this.neverSynced(outside.split(sep).join("/"))) {
      throw neverSync(`refusing to write inside a folder that is never synced: ${path}`);
    }
    return full;
  }

  /** The one answer to "does this path sync", asked the same way in every direction. */
  private neverSynced(rel: string): boolean {
    return isNeverSynced(rel, this.ignore);
  }

  /** Temporary files of a crashed earlier run that `list` has removed. */
  reaped = 0;

  /**
   * Removes staged temporaries that nothing is writing and that are old.
   *
   * A crash mid-write leaves its temporary behind, and the staging folder is
   * never listed, so left alone it would sit there for ever, unseen. Anything
   * older than the grace period and not open in this process cannot be an
   * in-flight write, so it is removed and counted. Read errors here are
   * ignored: the folder may not exist yet, and a reaper that stops a sync is
   * worse than a temporary that waits.
   */
  private async reapStaleTemps(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.staging);
    } catch {
      return;
    }
    const cutoff = Date.now() - STALE_TEMP_MS;
    for (const name of names) {
      const full = join(this.staging, name);
      if (liveTemps.has(full)) continue;
      try {
        if ((await stat(full)).mtimeMs < cutoff) {
          await rm(full, { force: true });
          this.reaped++;
        }
      } catch {
        // Gone, or not ours to judge. Next time.
      }
    }
  }

  /**
   * Every file and folder in the vault, with the stats the engine decides on.
   *
   * The stats go together rather than one after another. Serially this was
   * 14 us a file and 138 ms over ten thousand of them, of which 112 ms was
   * nothing but waiting: `readdir` over the same tree is 25 ms. It runs on
   * every pass, so a settled vault paid it on every watch tick and every
   * keepalive, for ever. Together it is 27 ms.
   *
   * The engine's own comment, that an unchanged file costs one stat and so a
   * full pass is affordable, was right about the number of syscalls and wrong
   * about the wall clock, purely because they were issued one at a time.
   *
   * Order is unchanged and deliberately so: a folder is listed before
   * anything inside it, because that is the order folders have to be created
   * in. Each directory returns its own list and they are assembled in the
   * order they were read, so concurrency cannot reshuffle them.
   *
   * Do not raise UV_THREADPOOL_SIZE to go further. Measured at 16 it made this
   * 2.6x worse than the default 4.
   */
  async list(): Promise<FileStat[]> {
    await this.reapStaleTemps();
    const walk = async (dir: string, prefix: string): Promise<FileStat[]> => {
      let items;
      try {
        items = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        // Rule 2: absent and unreadable are different states. A directory
        // that cannot be read is not an empty one, and treating it as
        // empty would report every file in it as deleted.
        throw new Error(`cannot read ${dir}: ${(err as Error).message}`);
      }

      // Symlinks and anything else are left alone: following one would
      // sync a file that is not in the vault, and copying it as a link
      // would sync a path that means nothing elsewhere.
      //
      // A write in flight from this client is skipped too. Listing one
      // would sync a half-written note under a name about to vanish.
      const kept = items.filter(
        (i) =>
          !this.neverSynced(prefix ? `${prefix}/${i.name}` : i.name) &&
          !isTemporary(i.name, join(dir, i.name)) &&
          (i.isDirectory() || i.isFile()),
      );

      // A file deleted between the readdir and its stat is absent, which is
      // an ordinary state and not a failure of the listing. Anything else
      // the stat says is still rule 2: unreadable is not the same as gone,
      // and one unreadable file is a reason to stop rather than to report
      // the rest of the vault as the whole of it.
      const stats = await Promise.all(
        kept.map((i) =>
          i.isFile()
            ? stat(join(dir, i.name)).catch((err: NodeJS.ErrnoException) => {
                if (err.code === "ENOENT") return undefined;
                throw err;
              })
            : undefined,
        ),
      );
      const children = await Promise.all(
        kept.map((i) =>
          i.isDirectory()
            ? walk(join(dir, i.name), prefix ? `${prefix}/${i.name}` : i.name)
            : undefined,
        ),
      );

      const out: FileStat[] = [];
      for (let k = 0; k < kept.length; k++) {
        const item = kept[k]!;
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) {
          out.push({ path, folder: true, mtime: 0, ctime: 0, size: 0 });
          out.push(...children[k]!);
        } else {
          const s = stats[k];
          if (s === undefined) continue; // gone since the readdir
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
      }
      return out;
    };
    return walk(this.root, "");
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
  async write(
    path: string,
    bytes: Uint8Array,
    times: { mtime: number; ctime: number },
  ): Promise<void> {
    const full = this.absolute(path);
    await this.insideForReal(full);
    const had = await this.deepestExisting(full);
    await mkdir(dirname(full), { recursive: true });
    await this.matchCase(full);
    await writeDurably(full, bytes, false, { mtime: times.mtime, stageIn: this.staging });
    this.dirty(full, had);
  }

  /** Where this vault's temporary files live: under its own state folder, never beside a note. */
  private get staging(): string {
    return join(this.root, ".basalt", "tmp");
  }

  /**
   * Renames an existing file to the spelling being written, where they differ.
   *
   * On a filesystem that folds case, writing `NOTE.md` over an existing
   * `Note.md` writes the same file and leaves the directory entry spelled the
   * old way. The bytes are then right and the name is not, so the next scan
   * reports `NOTE.md` missing, the engine calls it deleted, and the deletion
   * travels to every other device. A rename that only changed case therefore
   * lost the note everywhere, one pass later than it looked.
   *
   * Only reached when the target already exists, which for a first download is
   * never, so it costs nothing on the path that moves the most files.
   */
  private async matchCase(full: string): Promise<void> {
    let there;
    try {
      there = await stat(full);
    } catch (err) {
      // Only absence means absent. Anything else is a disk that would not
      // answer, and writing on top of an answer it did not give is how a
      // note ends up spelled one way on disk and another in the index.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (there.isDirectory()) return;

    const dir = dirname(full);
    const want = basename(full);
    const entries = await readdir(dir);
    if (entries.includes(want)) return; // Spelled the way it is being written.

    const folded = foldPath(want);
    const actual = entries.find((e) => foldPath(e) === folded);
    if (actual === undefined) return;
    await rename(join(dir, actual), full);
    this.unflushed.add(dir);
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
    } catch (err) {
      // Two devices deleting the same file produces this routinely. Only
      // this, though: a file that cannot be looked at is not a file that
      // is gone, and saying it was removed would have the index agree.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    const target = await this.freeTrashPath(path);
    const had = await this.deepestExisting(target);
    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(full, target);
      this.unflushed.add(dirname(full));
      this.dirty(target, had);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    }
    // The trash is on another filesystem, which happens when a vault spans
    // mounts. Copied, checked byte for byte, and only then removed.
    await copyVerifiedThenRemove(full, target);
    this.unflushed.add(dirname(full));
    this.dirty(target, had);
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
    // Split on the vault-relative path, which always uses forward slashes,
    // and take the extension off the joined absolute one, which may not.
    const { ext } = splitName(path);
    const stem = ext === "" ? base : base.slice(0, base.length - ext.length);
    for (let n = 0; n < 1000; n++) {
      const candidate = n === 0 ? base : `${stem} (${n})${ext}`;
      try {
        await access(candidate, constants.F_OK);
      } catch (err) {
        // Free only if absent. A name that cannot be looked at may well be
        // occupied, and moving a note onto it would replace what is there.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return candidate;
        throw err;
      }
    }
    throw new Error(`the trash already holds a thousand copies of ${path}`);
  }

  async mkdir(path: string): Promise<void> {
    const full = this.absolute(path);
    await this.insideForReal(full);
    const had = await this.deepestExisting(join(full, "x"));
    await mkdir(full, { recursive: true });
    this.dirty(join(full, "x"), had);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.absolute(path), constants.F_OK);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      // Not "no": a disk that would not answer. The callers here go on to
      // write beside or over the answer, so an honest error beats a guess.
      throw err;
    }
  }

  /**
   * The name this filesystem will actually file a path under.
   *
   * Case folding is asked of the disk once, by creating a probe under the
   * state folder and looking for it under the other spelling. Unicode is
   * folded to NFC whatever the disk does: HFS+ normalises and APFS does
   * not, and a note that syncs between the two is one file on one and two
   * on the other, so treating them as one everywhere is the side that keeps
   * both copies.
   */
  canonical(path: string): string {
    const nfc = path.normalize("NFC");
    return this.foldsCaseSync ? nfc.toLowerCase() : nfc;
  }

  /**
   * Whether this filesystem folds case, worked out on first use.
   *
   * Synchronous once known, because `canonical` is called per path inside a
   * loop. Until the probe has run the answer is "yes", which is the safe
   * side: it refuses two files where one would do, never the reverse.
   */
  private foldsCaseSync = true;
  private probed: Promise<void> | undefined;

  /** Runs the case probe, so `canonical` answers for this disk rather than for the worst one. */
  probeCase(): Promise<void> {
    return (this.probed ??= (async () => {
      const dir = join(this.root, ".basalt");
      const probe = join(dir, `.CaseProbe-${process.pid}`);
      try {
        await mkdir(dir, { recursive: true });
        await (await open(probe, "wx")).close();
        try {
          await access(join(dir, `.caseprobe-${process.pid}`), constants.F_OK);
          this.foldsCaseSync = true;
        } catch {
          this.foldsCaseSync = false;
        }
      } catch {
        // Could not probe. The default stands, and it is the safe one.
      } finally {
        await rm(probe, { force: true }).catch(() => {});
      }
    })());
  }

  /**
   * Writes a file only if nothing is at the path, atomically.
   *
   * The bytes go to a temporary first, as every write does, and then a hard
   * link puts them under the final name: `link` fails with EEXIST if the name
   * is taken, and there is no moment in which the name exists half written.
   * Where the filesystem has no hard links, the file is opened exclusively
   * instead, which is exclusive but can leave a partial file after a crash.
   */
  async create(
    path: string,
    bytes: Uint8Array,
    times: { mtime: number; ctime: number },
  ): Promise<boolean> {
    const full = this.absolute(path);
    await this.insideForReal(full);
    const had = await this.deepestExisting(full);
    await mkdir(dirname(full), { recursive: true });
    const { tmp, handle } = await openTemp(full, undefined, this.staging);
    try {
      try {
        await writeAll(handle, bytes);
        if (times.mtime > 0) await handle.utimes(times.mtime / 1000, times.mtime / 1000);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tmp, full);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return false;
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw err;
        // No hard links here. Exclusive open, then the bytes again.
        let exclusive;
        try {
          exclusive = await open(full, "wx");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw e;
        }
        try {
          await writeAll(exclusive, bytes);
          if (times.mtime > 0) await exclusive.utimes(times.mtime / 1000, times.mtime / 1000);
          await exclusive.sync();
        } finally {
          await exclusive.close();
        }
      }
      this.dirty(full, had);
      return true;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
      liveTemps.delete(tmp);
    }
  }

  /**
   * Whether two paths are one file, asked of the filesystem rather than guessed.
   *
   * Device and inode, which is the only answer that holds everywhere: case
   * folding on macOS and Windows, Unicode normalisation on HFS+, and a hard
   * link, which no amount of comparing strings would catch. A path that is not
   * there is not the same file as anything, including another path that is not
   * there.
   */
  async sameFile(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    try {
      const [x, y] = await Promise.all([stat(this.absolute(a)), stat(this.absolute(b))]);
      return x.dev === y.dev && x.ino === y.ino;
    } catch (err) {
      // Absent is not the same file as anything. Anything else is thrown,
      // and the caller, which is deciding whether a deletion would remove a
      // file this pass wrote, records a failure and keeps the file.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
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
        if (this.neverSynced(path)) return;
        if (isTemporary(basename(path), join(this.root, path))) return;
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
/** Whether a path is still on disk, for the skip that assumes it is. */
async function stillThere(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class JsonIndexStore implements IndexStore {
  constructor(private readonly file: string) {}

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
   *
   * That last sentence holds only while the bytes are still there, which is
   * why `save` asks for the file as well as comparing the string. An index
   * removed from outside while a watcher is running would otherwise be
   * skipped by every unchanged pass after it, and the next start would read
   * a vault it has already synced as one it has never seen.
   */
  private lastWritten: string | undefined;

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
    let state: StoredState;
    try {
      state = JSON.parse(text) as StoredState;
    } catch (err) {
      throw new Error(
        `the index at ${this.file} is not valid JSON, so it cannot be trusted: ${(err as Error).message}`,
      );
    }
    // What is on disk is what was last written, so the first pass of a vault
    // with nothing to do writes nothing rather than serialising the whole
    // index and fsyncing it twice to say so.
    this.lastWritten = text;
    return state;
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
    const text = JSON.stringify(state);
    if (text === this.lastWritten && (await stillThere(this.file))) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeDurably(this.file, new TextEncoder().encode(text), true, {
      stageIn: join(dirname(this.file), "tmp"),
    });
    // Only after it is durable. Recording it first would skip the write
    // that a failed one still owes.
    this.lastWritten = text;
  }
}

/**
 * Marks this client's in-progress writes.
 *
 * A vault is somebody's own directory and they can name a file whatever they
 * like, so the suffix alone is not enough: the temp name used to be exactly
 * `<file>.basalt-tmp`, and a real attachment sitting at that path would be
 * overwritten by the next write of `<file>` and then renamed away. Unique names
 * make that a coincidence rather than a certainty, and creating them
 * exclusively makes it impossible.
 *
 * Temporaries live under the vault's own state folder, which is never listed,
 * so ordinarily none of this touches the listing at all. The marker still
 * matters for the one case a temporary is made beside its destination, when
 * the destination is on another filesystem and a rename from the staging
 * folder would not work.
 */
export const TEMP_MARK = ".basalt-tmp-";

/** Temporaries open in this process, by full path. Exact, so a note is never mistaken for one. */
const liveTemps = new Set<string>();

/** How old a staged temporary must be before it is taken for a crash's leftover. */
const STALE_TEMP_MS = 60 * 60 * 1000;

/**
 * Whether a directory entry is one of this client's temporary files.
 *
 * Exactly, not by containing the marker. `notes.basalt-tmp-1.md` is a note
 * with an odd name, and it used to vanish from the listing for the life of the
 * vault. A temporary of ours ends with the marker and its counter and nothing
 * after, and while it is being written this process knows its full path.
 */
export function isTemporary(name: string, full?: string): boolean {
  if (full !== undefined && liveTemps.has(full)) return true;
  return /\.basalt-tmp-[0-9a-z]+(-\d+)?$/.test(name);
}

let tempCounter = 0;

/**
 * Creates a temporary file, and never opens one that already exists: `wx`
 * fails rather than truncating, so a file somebody else put there is refused
 * instead of destroyed.
 *
 * Under `stageIn` when given, and beside the destination otherwise. The
 * staging folder is the ordinary case; beside is the fallback for a
 * destination on another filesystem, where the rename into place would fail.
 */
async function openTemp(
  full: string,
  mode?: number,
  stageIn?: string,
): Promise<{ tmp: string; handle: Awaited<ReturnType<typeof open>> }> {
  if (stageIn !== undefined) await mkdir(stageIn, { recursive: true });
  const base = stageIn !== undefined ? join(stageIn, basename(full)) : full;
  for (let attempt = 0; attempt < 64; attempt++) {
    const tmp = `${base}${TEMP_MARK}${(tempCounter++).toString(36)}${attempt ? `-${attempt}` : ""}`;
    try {
      const handle = await open(tmp, "wx", mode);
      liveTemps.add(tmp);
      return { tmp, handle };
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not find an unused temporary name for ${full}`);
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
export async function writeDurably(
  full: string,
  bytes: Uint8Array,
  /**
   * Whether to make the directory entry durable here.
   *
   * Two flushes cost about the same, and files sharing a folder re-flush the
   * same folder. Measured over 600 files across 60 folders: 3230 ms flushing
   * per file against 1685 ms flushing each folder once, so a vault write defers
   * this and `NodeVault.flush` does it a folder at a time, before the index is
   * written.
   *
   * The file's own flush is never deferred, and the ordering that matters is
   * unchanged: the index must not be durable before the notes it names, and it
   * still is not, because the folder flushes land ahead of it. What a deferred
   * folder flush risks is a crash in the window leaving a file whose bytes are
   * on disk and whose name is not, and the index does not name it either, so
   * the next pass fetches it again. Nothing claims to hold what it does not.
   */
  syncDir = true,
  opts: {
    /** Permission bits for the file, set on the temporary before it is renamed into place. */
    mode?: number;
    /** Modification time in milliseconds, set on the handle before it is synced. */
    mtime?: number;
    /** A folder to stage the temporary in, rather than beside the destination. */
    stageIn?: string;
  } = {},
): Promise<void> {
  const staged = await writeTemp(full, bytes, opts, opts.stageIn);
  try {
    await rename(staged, full);
  } catch (err) {
    await rm(staged, { force: true }).catch(() => {});
    liveTemps.delete(staged);
    if ((err as NodeJS.ErrnoException).code !== "EXDEV" || opts.stageIn === undefined) throw err;
    // The destination is on another filesystem than the staging folder,
    // which a vault spanning mounts produces. Beside it, then.
    const beside = await writeTemp(full, bytes, opts, undefined);
    try {
      await rename(beside, full);
    } catch (again) {
      await rm(beside, { force: true }).catch(() => {});
      throw again;
    } finally {
      liveTemps.delete(beside);
    }
  }
  liveTemps.delete(staged);

  if (syncDir) await syncDirectory(dirname(full));
}

/** Writes and syncs a temporary holding `bytes`, cleaning up after itself on failure. */
async function writeTemp(
  full: string,
  bytes: Uint8Array,
  opts: { mode?: number; mtime?: number },
  stageIn: string | undefined,
): Promise<string> {
  const { tmp, handle } = await openTemp(full, opts.mode, stageIn);
  try {
    try {
      await writeAll(handle, bytes);
      if (opts.mode !== undefined) await handle.chmod(opts.mode);
      // Set through the handle, before the sync, so the timestamp is part
      // of what the sync makes durable. Set afterwards on the path, it was
      // metadata changed after the last fsync with none following.
      if (opts.mtime !== undefined && opts.mtime > 0) {
        await handle.utimes(opts.mtime / 1000, opts.mtime / 1000);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return tmp;
  } catch (err) {
    // A failed attempt leaves nothing behind. The temporary is invisible
    // to the listing, so left in place it would sit there for ever.
    await rm(tmp, { force: true }).catch(() => {});
    liveTemps.delete(tmp);
    throw err;
  }
}

/**
 * Moves a file or tree across filesystems the long way: copy, prove the copy,
 * then remove the original.
 *
 * Rule 3, literally. `cp` followed by `rm` trusted the copy, and a short copy,
 * a descendant the copy missed, a source changed while it was being read or a
 * name taken at the destination all ended with the original gone and the
 * "copy" not what it was. Every file is compared by size and digest, every
 * directory by presence, and a copy that does not prove out is removed so it
 * cannot be mistaken for the real thing later.
 *
 * Exported for the tests, which are the only way to reach this on a machine
 * with one filesystem.
 */
export async function copyVerifiedThenRemove(source: string, target: string): Promise<void> {
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  try {
    await sameTree(source, target);
  } catch (err) {
    await rm(target, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `refusing to remove ${source}: its copy at ${target} does not match: ${(err as Error).message}`,
    );
  }
  await rm(source, { recursive: true, force: true });
}

async function sameTree(source: string, target: string): Promise<void> {
  const s = await stat(source);
  const t = await stat(target).catch(() => undefined);
  if (t === undefined) throw new Error(`${target} is missing`);
  if (s.isDirectory()) {
    if (!t.isDirectory()) throw new Error(`${target} is not a directory`);
    for (const name of await readdir(source))
      await sameTree(join(source, name), join(target, name));
    return;
  }
  if (!s.isFile()) return; // Anything else was not copied and is not a note.
  if (!t.isFile() || t.size !== s.size)
    throw new Error(`${target} is ${t.size} bytes, not ${s.size}`);
  const [a, b] = await Promise.all([digestOf(source), digestOf(target)]);
  if (a !== b) throw new Error(`${target} does not have the same bytes as ${source}`);
}

async function digestOf(path: string): Promise<string> {
  // No close here: createReadStream closes the handle itself.
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Writes every byte, or fails.
 *
 * `FileHandle.write` reports how much it wrote and may report less than it
 * was given. The count was ignored, so a short write was fsynced and renamed
 * into place as a complete note, or a complete index. Rule 5 in its smallest
 * form: a result shorter than its input is a bug until shown otherwise, and
 * here it is shown by writing the rest. Zero progress is refused rather than
 * looped on for ever.
 */
export async function writeAll(
  handle: { write(data: Uint8Array): Promise<{ bytesWritten: number }> },
  bytes: Uint8Array,
): Promise<void> {
  let at = 0;
  while (at < bytes.length) {
    const { bytesWritten } = await handle.write(bytes.subarray(at));
    if (bytesWritten <= 0) {
      throw new Error(
        `wrote 0 of the ${bytes.length - at} bytes remaining, so the write is not progressing`,
      );
    }
    at += bytesWritten;
  }
}

/** Makes a directory's own entries durable. */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
