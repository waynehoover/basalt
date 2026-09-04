/**
 * The boundary between the engine and wherever the files actually live.
 *
 * Everything platform-specific about a client is behind this interface, and
 * there is deliberately not much of it. `obsidian-headless` is the same sync
 * engine as the desktop app with the Vault API swapped for the filesystem, so
 * the size of this interface is the size of the difference between a plugin and
 * a headless client.
 *
 * It is narrow enough that an in-memory implementation is a real one rather than
 * a mock, which is what lets two engines converge against a real server in a
 * test with no Obsidian and no disk involved.
 */

/** What a listing says about one path. */
export interface FileStat {
  readonly path: string;
  readonly folder: boolean;
  /** Milliseconds. Rounded up by the index, because platforms disagree below that. */
  readonly mtime: number;
  /**
   * Creation time, in milliseconds, or 0 when the platform will not say.
   *
   * Carried because the protocol carries it, and read by nothing. Obsidian
   * ships prebuilt native addons for five platforms to get this value, which
   * is a fair measure of how unreliable it is; anything deciding from it would
   * be deciding from a guess.
   */
  readonly ctime: number;
  readonly size: number;
}

/**
 * The timestamps a write carries.
 *
 * Its own name because both vaults, the engine and every test double spelled
 * it out separately, and the two fields have to travel together: a downloaded
 * file stamped with the moment it landed looks locally edited on the next
 * pass.
 */
export interface Times {
  readonly mtime: number;
  readonly ctime: number;
}

/** What the engine needs from a place files live. */
export interface Vault {
  /**
   * Every file and folder, excluding anything the client should not sync.
   *
   * Paths are reported in NFC. A Mac spells names on disk in NFD and every
   * other platform in NFC, and the two are one name, so a vault that handed
   * out the disk's bytes had two devices each refusing the other's spelling
   * of one note for ever. Both real vaults normalise here and map back on
   * the way in; the engine's own folding is the fallback for one that does
   * not, and it errs towards refusing rather than overwriting.
   */
  list(): Promise<FileStat[]>;
  read(path: string): Promise<Uint8Array>;
  /**
   * Makes durable whatever the writes so far have left un-durable.
   *
   * Optional, because a vault whose writes are already durable when they return
   * has nothing to do here. Called once at the end of a pass, before the index
   * is saved, so that the index is never durable ahead of the notes it names.
   * Obsidian's `DataAdapter` has no way to ask for this, so the plugin's vault
   * cannot offer it; see the note on `ObsidianVault` about what that costs.
   */
  flush?(): Promise<void>;
  /**
   * The same bytes, in blocks, for a caller that does not need them at once.
   *
   * Optional, and the reason the engine has two paths for a large file. A
   * vault that can stream lets one be chunked, named and sent in bounded
   * memory; a vault that cannot has to hand over the whole thing.
   *
   * Both vaults offer it. The headless client streams from the file; the
   * plugin fetches the URL Obsidian's webview already uses for a file, which
   * carries a body stream and honours a Range header on desktop. Where that
   * fetch fails, as it may on a phone, the engine falls back to `read`.
   */
  readBlocks?(path: string, blockSize?: number): AsyncIterable<Uint8Array>;
  /**
   * One byte range. Needed with `readBlocks` and for the same reason.
   *
   * The chunk names go up before any body does, so the file is read once to
   * name it and then again for the chunks the server actually asks for.
   * Without this the second pass would need the whole file in hand, which is
   * the thing being avoided.
   */
  readRange?(path: string, start: number, end: number): Promise<Uint8Array>;
  /**
   * Writes a file, creating any missing folders.
   *
   * `mtime` is set to the value given, because the engine's whole decision
   * table compares timestamps, and a downloaded file stamped with the moment
   * it landed looks locally edited on the next pass.
   */
  write(path: string, bytes: Uint8Array, times: Times): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /**
   * Whether two paths name the same file on this filesystem.
   *
   * Not the same question as string equality, and the difference loses notes.
   * macOS and Windows fold case, so `Note.md` and `NOTE.md` are two paths here
   * and one file there. A pass that writes one and deletes the other then
   * deletes what it just wrote.
   *
   * Optional, because only a vault that can ask the platform should answer.
   * When it is absent the engine assumes two paths differing only by case are
   * the same file, which is right on every platform the plugin runs on and
   * errs towards keeping a file rather than removing one.
   */
  sameFile?(a: string, b: string): Promise<boolean>;
  /**
   * The identity the filesystem gives a path, so two paths that would be one
   * file here can be told apart from two files.
   *
   * Two distinct paths on the server can alias one local file: `Note.md` and
   * `note.md` on a filesystem that folds case, or one name in NFC and NFD.
   * Written one after the other, the second replaced the first and both were
   * recorded as synced, and the next scan reported the first one deleted.
   *
   * Optional. Without it the engine folds case and Unicode normalisation
   * everywhere, which refuses two files that a case-sensitive disk could have
   * held apart, and that is the safe side to err on.
   */
  canonical?(path: string): string;
  /**
   * Writes a file only if nothing is at the path, and says whether it did.
   *
   * `exists` followed by `write` is a gap, and a conflict copy or a restore
   * landing in it replaces whatever another process put there first. That is
   * the one file the copy exists to keep. Optional, because a platform whose
   * API has no exclusive create cannot offer it; the engine then falls back
   * to the gap it always had.
   */
  create?(path: string, bytes: Uint8Array, times: Times): Promise<boolean>;
  /**
   * Watches for changes, returning a function that stops watching.
   *
   * Optional. A vault that cannot watch is polled instead, which is slower to
   * notice an edit and no less correct: the scan is what decides, and an event
   * only decides when to scan.
   */
  watch?(onChange: (path: string) => void): () => void;
}

/**
 * Where the index is kept between runs.
 *
 * Separate from the vault because the two answer to different constraints: a
 * vault holds the user's notes and this holds bookkeeping, and putting
 * bookkeeping in the vault would sync it to every device and to itself.
 */
export interface IndexStore {
  load(): Promise<StoredState | undefined>;
  save(state: StoredState): Promise<void>;
}

/** What a stat says about the index file, and all this needs of one. */
export interface IndexStamp {
  readonly size: number;
  readonly mtime: number;
}

/**
 * The last index this session wrote, so an unchanged index is not written again.
 *
 * A pass ends by saving whether or not anything happened, and a settled vault
 * passes on every watch tick and every keepalive. At 2000 files that was a
 * 9 MiB serialisation and two fsyncs every thirty seconds, for ever, to record
 * that nothing had changed; at 10k it measured 21 ms of which 11 ms was the
 * flushes. Two separate audits found this independently, which is the best
 * evidence a thing is real.
 *
 * Comparing the string is not free either, but stringify is 2.1 ms against
 * 10.7 ms of fsync, so it pays for itself the first time it matches. And a
 * write skipped because the bytes on disk are already those bytes cannot lose
 * anything: the failure it would cause is the failure it prevents.
 *
 * That last sentence holds only while the bytes are still there, which is why
 * the file is asked about as well. An index removed from outside during a
 * session used to be skipped by every later unchanged pass, and the restart
 * after it started cold over a vault this device had already synced.
 *
 * Asking whether it exists was not enough either (R3). Something overwriting
 * the index in place leaves a file that is there and is not what was written,
 * and every later unchanged pass would skip over it and preserve it for the
 * rest of the session. So what is remembered is its size and modification
 * time, and the skip needs both to match. Not the content: reading nine
 * megabytes back on every settled pass is the cost this skip exists to avoid,
 * while a stat is one call whatever the index weighs.
 *
 * The residual, stated rather than hidden: an overwrite of exactly the same
 * length inside one modification-time tick is invisible here and still skips.
 * That is a corruption-only window, narrow where the clock is fine grained
 * (APFS and ext4 record nanoseconds) and real where it is not (HFS+ ticks once
 * a second, FAT once every two). Closing it means reading the file back on
 * every settled pass, which is the whole cost this skip exists to avoid.
 *
 * Here in core because it was not: the plugin's store grew the stamp and the
 * headless client's kept an existence check, so one client carried a fix the
 * other did not. Two copies of a rule is how they come to disagree.
 */
export class LastIndexWrite {
  private text: string | undefined;
  private stamp: IndexStamp | undefined;

  /** Whether `text` is on disk already, untouched since this session put it there. */
  matches(text: string, onDisk: IndexStamp | undefined): boolean {
    const was = this.stamp;
    if (text !== this.text || was === undefined || onDisk === undefined) return false;
    return onDisk.size === was.size && onDisk.mtime === was.mtime;
  }

  /**
   * Records what was just written and how it looks on disk.
   *
   * Only ever after the write is durable. Recording it first would skip the
   * write that a failed one still owes. A stamp that could not be taken is
   * remembered as none, which makes the next save write rather than skip.
   */
  wrote(text: string, onDisk: IndexStamp | undefined): void {
    this.text = text;
    this.stamp = onDisk;
  }

  /** Forgets it, for an index that has been removed on purpose. */
  forget(): void {
    this.text = undefined;
    this.stamp = undefined;
  }
}

/**
 * Everything the client must remember across a restart.
 *
 * `pending` is the inbound work list, and it is persisted on purpose. Obsidian's
 * desktop engine keeps its equivalent in memory and rebuilds it from the server;
 * its headless client persists it. Persisting is right, and the reason is rule 1
 * in different clothes: a work list that exists only in memory is one a crash
 * silently shortens, and the shortening looks exactly like having finished.
 */
export interface StoredState {
  /** The last uid this device has applied. */
  readonly cursor: number;
  /** Index entries by path. Shape mirrors IndexEntry. */
  readonly entries: Record<string, unknown>;
  /** The server's newest word per path, by plaintext path. */
  readonly remote: Record<string, unknown>;
  /** Plaintext paths with inbound work outstanding. */
  readonly pending: string[];
}

/* ---------------------------------------------------------------- *
 * In memory, for tests and for anything that needs a vault without a disk
 * ---------------------------------------------------------------- */

interface MemoryFile {
  bytes: Uint8Array;
  mtime: number;
  ctime: number;
}

/**
 * A vault held in memory.
 *
 * Not a mock: it implements the interface completely, and the engine cannot tell
 * the difference. That is what makes it useful, because it lets two engines
 * converge against a real server in a test where the only thing being faked is
 * the disk.
 */
export class MemoryVault implements Vault {
  private readonly files = new Map<string, MemoryFile>();
  private readonly folders = new Set<string>();

  private listeners: ((path: string) => void)[] = [];
  /**
   * How many times a file has been read.
   *
   * Counted because the index's content cache is a performance property, and a
   * performance property with no observation is a claim. An unchanged pass
   * should read nothing.
   */
  reads = 0;

  async list(): Promise<FileStat[]> {
    const out: FileStat[] = [];
    for (const path of this.folders) {
      out.push({ path, folder: true, mtime: 0, ctime: 0, size: 0 });
    }
    for (const [path, f] of this.files) {
      out.push({ path, folder: false, mtime: f.mtime, ctime: f.ctime, size: f.bytes.length });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    this.reads++;
    return f.bytes;
  }

  async write(path: string, bytes: Uint8Array, times: Times): Promise<void> {
    this.files.set(path, { bytes: bytes.slice(), mtime: times.mtime, ctime: times.ctime });
    for (const parent of parents(path)) this.folders.add(parent);
    this.notify(path);
  }

  /**
   * Makes the next removal of this path fail, once.
   *
   * A test seam, and a narrow one. Applying an incoming deletion can fail for
   * ordinary reasons on a real device, a locked file being the obvious one,
   * and what the engine does next is a durability question rather than a
   * cosmetic one. There is no other way to produce it.
   */
  failRemoveOnce: string | undefined;

  async remove(path: string): Promise<void> {
    if (this.failRemoveOnce === path) {
      this.failRemoveOnce = undefined;
      throw new Error(`refusing to remove ${path}, as a locked file would`);
    }
    this.files.delete(path);
    this.folders.delete(path);
    this.notify(path);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
    for (const parent of parents(path)) this.folders.add(parent);
    this.notify(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async create(path: string, bytes: Uint8Array, times: Times): Promise<boolean> {
    if (this.files.has(path) || this.folders.has(path)) return false;
    await this.write(path, bytes, times);
    return true;
  }

  watch(onChange: (path: string) => void): () => void {
    this.listeners.push(onChange);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== onChange);
    };
  }

  private notify(path: string): void {
    for (const l of this.listeners) l(path);
  }

  /* Test conveniences, outside the interface. */

  /** Writes as a user would, so mtime moves and the engine notices. */
  async edit(path: string, content: string, mtime = Date.now()): Promise<void> {
    await this.write(path, new TextEncoder().encode(content), { mtime, ctime: mtime });
  }

  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.bytes) : undefined;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Everything in the vault, for comparing two of them. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, f] of this.files) out[path] = new TextDecoder().decode(f.bytes);
    return out;
  }
}

/** An index store held in memory, for the same reason. */
export class MemoryIndexStore implements IndexStore {
  private state: StoredState | undefined;
  saves = 0;

  async load(): Promise<StoredState | undefined> {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async save(state: StoredState): Promise<void> {
    this.state = structuredClone(state);
    this.saves++;
  }
}

/** Every folder above a path, outermost first. */
export function parents(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  const out: string[] = [];
  let at = "";
  for (const part of parts) {
    at = at ? `${at}/${part}` : part;
    out.push(at);
  }
  return out;
}
