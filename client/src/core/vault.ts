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

/** What the engine needs from a place files live. */
export interface Vault {
  /** Every file and folder, excluding anything the client should not sync. */
  list(): Promise<FileStat[]>;
  read(path: string): Promise<Uint8Array>;
  /**
   * The same bytes, in blocks, for a caller that does not need them at once.
   *
   * Optional, and the reason the engine has two paths for a large file. A
   * vault that can stream lets one be chunked, named and sent in bounded
   * memory; a vault that cannot has to hand over the whole thing.
   *
   * Obsidian's `DataAdapter` is the second kind: `readBinary` returns the
   * whole ArrayBuffer and there is no ranged or streaming read beside it, so
   * the plugin takes the buffered path and the headless client does not.
   */
  /**
   * Makes durable whatever the writes so far have left un-durable.
   *
   * Optional, because a vault whose writes are already durable when they return
   * has nothing to do here. Called once at the end of a pass, before the index
   * is saved, so that the index is never durable ahead of the notes it names.
   */
  flush?(): Promise<void>;

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
  write(path: string, bytes: Uint8Array, times: { mtime: number; ctime: number }): Promise<void>;
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
  /** Every write this vault has seen, for tests that care about how it got here. */
  readonly writeLog: string[] = [];
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

  async write(
    path: string,
    bytes: Uint8Array,
    times: { mtime: number; ctime: number },
  ): Promise<void> {
    this.files.set(path, { bytes: bytes.slice(), mtime: times.mtime, ctime: times.ctime });
    for (const parent of parents(path)) this.folders.add(parent);
    this.writeLog.push(path);
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
