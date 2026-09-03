/**
 * Obsidian's `DataAdapter`, faked well enough to be worth testing against.
 *
 * The plugin and its vault adapter are the only code here that cannot run in a
 * test, and "cannot be tested" was becoming a reason not to test it. This is the
 * other option: implement the interface the plugin talks to, faithfully, and run
 * everything above it.
 *
 * ## What makes it worth anything
 *
 * Two things, and without both it would be a mock that agrees with whatever the
 * code does.
 *
 * It is declared `implements DataAdapter`, against the real `obsidian.d.ts`, so
 * the compiler rejects a method whose shape has drifted from the real one.
 *
 * And the behaviour that matters is determined from the shipped application
 * rather than assumed. `normalizePath` below matches what Obsidian's does, which
 * was found by reading `obsidian.asar`: it does more than the name suggests, and
 * finding that out is most of why this file exists.
 *
 * ## What it still cannot tell you
 *
 * Whether Obsidian calls these methods the way the plugin expects, whether the
 * app is in a state where the adapter is ready, and anything about the UI. Those
 * need Obsidian. What is covered here is every path through the plugin's own
 * code, which is where its bugs are.
 */

import type {
  DataAdapter,
  DataWriteOptions,
  ListedFiles,
  Stat,
  TAbstractFile,
  Vault,
} from "obsidian";

/**
 * Obsidian's `normalizePath`, as it actually ships.
 *
 * `normalizePath` is part of Obsidian's plugin API, whose declarations are
 * published under the MIT licence. The behaviour is not, so it was determined by
 * reading `Obsidian.app/Contents/Resources/obsidian.asar` and written out here as
 * the four steps it performs, so that this fake and the real adapter agree:
 *
 *   1. Collapse runs of backslash and forward slash into a single `/`.
 *   2. Strip leading and trailing slashes; an empty result becomes `/`.
 *   3. Replace U+00A0 and U+202F with an ordinary space.
 *   4. Normalize to NFC.
 *
 * Two of those four steps are surprising, and both matter to a sync client.
 *
 * It replaces a non-breaking space (U+00A0) and a narrow no-break space
 * (U+202F) with an ordinary space. A filename containing one is therefore a
 * *different filename* after normalizing, so a path handed to the adapter is not
 * always the path written.
 *
 * And it normalizes to NFC. macOS hands out filenames in NFD, so a path that
 * came from a filesystem elsewhere can change here too.
 *
 * Both mean the same thing for this client: the path the engine asked for and
 * the path that exists can differ, and the engine's whole idea of a file's
 * identity is its path.
 */
export function normalizePath(path: string): string {
  let out = path.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "");
  if (out === "") out = "/";
  return out.replace(/\u00A0|\u202F/g, " ").normalize("NFC");
}

interface FakeFile {
  binary: Uint8Array;
  ctime: number;
  mtime: number;
}

/** The adapter operations a test can make fail. */
export type FaultOp =
  | "exists"
  | "stat"
  | "list"
  | "read"
  | "readBinary"
  | "write"
  | "writeBinary"
  | "mkdir"
  | "remove"
  | "rename"
  | "copy";

/**
 * A vault held in memory, behind Obsidian's adapter interface.
 *
 * Folders are tracked separately from files, as Obsidian does, because a folder
 * exists whether or not anything is in it and `list` has to report both.
 */
export class FakeAdapter implements DataAdapter {
  private readonly files = new Map<string, FakeFile>();
  private readonly folders = new Set<string>();
  /** Everything moved to the vault-local trash, by the path it had. */
  readonly trashedLocally: string[] = [];
  /** Everything the platform's own trash accepted. */
  readonly trashedToSystem: string[] = [];
  /**
   * Whether this platform has a system trash.
   *
   * Off by default, because it is off on mobile and on plenty of Linux
   * configurations, and the fallback is the path that needs testing.
   */
  systemTrashWorks = false;
  /** Set to make `trashSystem` throw, which is what a locked file looks like. */
  systemTrashThrows = false;
  /** A clock the test controls, since a fake filesystem has no real one. */
  now = 1_700_000_000_000;

  /**
   * A fault to inject, asked before every operation.
   *
   * Return nothing to let the call through, an Error to fail it before it
   * touches anything, or a byte count to have a write land that many bytes
   * and then fail, which is what a full disk or a process killed mid-write
   * leaves behind. The plugin's staged writes exist for exactly those
   * moments, and without a way to produce them here they would be untested.
   */
  fault: ((op: FaultOp, path: string, to?: string) => Error | number | undefined) | undefined;

  /** Every operation, in order, for a test that cares about sequence. */
  readonly calls: { op: FaultOp; path: string; to?: string }[] = [];

  private check(op: FaultOp, path: string, to?: string): number | undefined {
    this.calls.push(to === undefined ? { op, path } : { op, path, to });
    const fault = this.fault?.(op, path, to);
    if (fault instanceof Error) throw fault;
    return typeof fault === "number" ? fault : undefined;
  }

  getName(): string {
    return "fake";
  }

  async exists(normalizedPath: string): Promise<boolean> {
    this.check("exists", normalizedPath);
    return this.files.has(normalizedPath) || this.folders.has(normalizedPath);
  }

  async stat(normalizedPath: string): Promise<Stat | null> {
    this.check("stat", normalizedPath);
    const file = this.files.get(normalizedPath);
    if (file) {
      return { type: "file", ctime: file.ctime, mtime: file.mtime, size: file.binary.length };
    }
    if (this.folders.has(normalizedPath) || normalizedPath === "/") {
      return { type: "folder", ctime: 0, mtime: 0, size: 0 };
    }
    return null;
  }

  /**
   * One level, with full vault-relative paths.
   *
   * Not basenames: Obsidian's adapter returns the whole path, which is why the
   * plugin's walk can push a folder straight back onto its queue.
   */
  async list(normalizedPath: string): Promise<ListedFiles> {
    this.check("list", normalizedPath);
    const prefix = normalizedPath === "/" || normalizedPath === "" ? "" : `${normalizedPath}/`;
    const files: string[] = [];
    const folders: string[] = [];
    const direct = (path: string): boolean =>
      path.startsWith(prefix) &&
      !path.slice(prefix.length).includes("/") &&
      path !== normalizedPath;

    for (const path of this.folders) if (direct(path)) folders.push(path);
    for (const path of this.files.keys()) if (direct(path)) files.push(path);
    return { files: files.sort(), folders: folders.sort() };
  }

  async read(normalizedPath: string): Promise<string> {
    this.check("read", normalizedPath);
    return new TextDecoder().decode(this.bytesOf(normalizedPath));
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    this.check("readBinary", normalizedPath);
    return this.bytesOf(normalizedPath).slice().buffer;
  }

  private bytesOf(normalizedPath: string): Uint8Array {
    const file = this.files.get(normalizedPath);
    // Obsidian throws for a missing file rather than returning empty, and
    // the difference is rule 2: an unreadable file is not an empty one.
    if (!file) throw new Error(`ENOENT: no such file or directory, open '${normalizedPath}'`);
    return file.binary;
  }

  async write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    const short = this.check("write", normalizedPath);
    this.store(normalizedPath, new TextEncoder().encode(data), options, short);
  }

  async writeBinary(
    normalizedPath: string,
    data: ArrayBuffer,
    options?: DataWriteOptions,
  ): Promise<void> {
    const short = this.check("writeBinary", normalizedPath);
    this.store(normalizedPath, new Uint8Array(data.slice(0)), options, short);
  }

  /**
   * What Obsidian's own adapters do, read out of the shipped bundle: open
   * the destination for writing, which truncates it, and then write. A
   * failure between the two leaves the file short, so an injected short
   * write lands its prefix before it fails rather than leaving the old
   * bytes, because leaving them is the outcome the real adapter cannot give.
   */
  private store(
    normalizedPath: string,
    bytes: Uint8Array,
    options: DataWriteOptions | undefined,
    short: number | undefined,
  ): void {
    // Obsidian creates the parent folder. The plugin does not rely on that
    // and creates them itself, which this does not undo.
    const existing = this.files.get(normalizedPath);
    this.files.set(normalizedPath, {
      binary: short === undefined ? bytes.slice() : bytes.slice(0, short),
      ctime: options?.ctime ?? existing?.ctime ?? this.now,
      mtime: options?.mtime ?? this.now,
    });
    if (short !== undefined) {
      throw new Error(`ENOSPC: wrote ${short} of ${bytes.length} bytes to '${normalizedPath}'`);
    }
  }

  async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    const before = this.files.has(normalizedPath) ? await this.read(normalizedPath) : "";
    await this.write(normalizedPath, before + data, options);
  }

  async appendBinary(
    normalizedPath: string,
    data: ArrayBuffer,
    options?: DataWriteOptions,
  ): Promise<void> {
    const before = this.files.get(normalizedPath)?.binary ?? new Uint8Array(0);
    const added = new Uint8Array(data);
    const both = new Uint8Array(before.length + added.length);
    both.set(before, 0);
    both.set(added, before.length);
    await this.writeBinary(normalizedPath, both.slice().buffer, options);
  }

  async process(
    normalizedPath: string,
    fn: (data: string) => string,
    options?: DataWriteOptions,
  ): Promise<string> {
    const next = fn(await this.read(normalizedPath));
    await this.write(normalizedPath, next, options);
    return next;
  }

  getResourcePath(normalizedPath: string): string {
    return `app://fake/${normalizedPath}`;
  }

  async mkdir(normalizedPath: string): Promise<void> {
    this.check("mkdir", normalizedPath);
    this.folders.add(normalizedPath);
  }

  async trashSystem(normalizedPath: string): Promise<boolean> {
    if (this.systemTrashThrows) throw new Error("the system trash refused");
    if (!this.systemTrashWorks) return false;
    this.trashedToSystem.push(normalizedPath);
    await this.remove(normalizedPath);
    return true;
  }

  async trashLocal(normalizedPath: string): Promise<void> {
    this.trashedLocally.push(normalizedPath);
    const file = this.files.get(normalizedPath);
    await this.remove(normalizedPath);
    if (file) this.files.set(`.trash/${normalizedPath}`, file);
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    this.folders.delete(normalizedPath);
    if (!recursive) return;
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${normalizedPath}/`)) this.files.delete(path);
    }
    for (const path of [...this.folders]) {
      if (path.startsWith(`${normalizedPath}/`)) this.folders.delete(path);
    }
  }

  async remove(normalizedPath: string): Promise<void> {
    this.check("remove", normalizedPath);
    this.files.delete(normalizedPath);
    this.folders.delete(normalizedPath);
  }

  /**
   * Refuses an occupied destination, as the shipped adapter does.
   *
   * Read out of `obsidian-1.13.7.asar`: `FileSystemAdapter.rename` checks the
   * destination and throws "Destination file already exists!" unless the two
   * names differ only by case on a filesystem that folds it. The first
   * version of this fake replaced the destination silently, which would have
   * let a replace-by-rename pass every test here and fail in every vault.
   *
   * Folders move with everything under them, because Obsidian reports a
   * folder rename as one event and the plugin has to handle it as one.
   */
  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    this.check("rename", normalizedPath, normalizedNewPath);
    if (normalizedPath === normalizedNewPath) return;
    if (this.files.has(normalizedNewPath) || this.folders.has(normalizedNewPath)) {
      throw new Error("Destination file already exists!");
    }
    const file = this.files.get(normalizedPath);
    if (file) {
      this.files.delete(normalizedPath);
      this.files.set(normalizedNewPath, file);
      return;
    }
    if (!this.folders.has(normalizedPath)) {
      throw new Error(`ENOENT: no such file or directory, rename '${normalizedPath}'`);
    }
    this.folders.delete(normalizedPath);
    this.folders.add(normalizedNewPath);
    const under = `${normalizedPath}/`;
    for (const path of [...this.folders]) {
      if (path.startsWith(under)) {
        this.folders.delete(path);
        this.folders.add(normalizedNewPath + path.slice(normalizedPath.length));
      }
    }
    for (const [path, f] of [...this.files]) {
      if (path.startsWith(under)) {
        this.files.delete(path);
        this.files.set(normalizedNewPath + path.slice(normalizedPath.length), f);
      }
    }
  }

  async copy(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    this.check("copy", normalizedPath, normalizedNewPath);
    const file = this.files.get(normalizedPath);
    if (file) this.files.set(normalizedNewPath, { ...file, binary: file.binary.slice() });
  }

  /* Test conveniences, outside the interface. */

  /** Puts a file there the way Obsidian would, creating the folders above it. */
  seed(path: string, text: string, mtime = this.now): void {
    const parts = path.split("/");
    parts.pop();
    let at = "";
    for (const part of parts) {
      at = at === "" ? part : `${at}/${part}`;
      this.folders.add(at);
    }
    this.files.set(path, { binary: new TextEncoder().encode(text), ctime: mtime, mtime });
  }

  text(path: string): string | undefined {
    const file = this.files.get(path);
    return file ? new TextDecoder().decode(file.binary) : undefined;
  }

  /**
   * What Obsidian's own index would hold: every file and folder, with each
   * file's times and size attached.
   *
   * The real one is in memory and already populated, which is why the plugin
   * reads it rather than asking the adapter about every file in turn.
   */
  index(): TAbstractFile[] {
    const out: TAbstractFile[] = [];
    for (const path of this.folders) {
      out.push({ path, name: path.split("/").pop() ?? path } as TAbstractFile);
    }
    for (const [path, f] of this.files) {
      out.push({
        path,
        name: path.split("/").pop() ?? path,
        stat: { ctime: f.ctime, mtime: f.mtime, size: f.binary.length },
      } as unknown as TAbstractFile);
    }
    return out;
  }

  /** Every path that exists, files and folders, for comparing two vaults. */
  everything(): string[] {
    return [...this.files.keys(), ...this.folders].sort();
  }

  filePaths(): string[] {
    return [...this.files.keys()].sort();
  }
}

/**
 * Obsidian's `Vault`, faked down to what the plugin reads from it.
 *
 * The plugin takes the vault rather than the adapter now, because the vault
 * carries the index: `getAllLoadedFiles` is what the application already has in
 * memory, and reading it costs nothing where asking the adapter about every
 * file in turn costs one call each.
 *
 * Only what is used. A plugin that started reading more of the Vault API would
 * fail here loudly rather than quietly working against a fake that agreed with
 * it.
 */
export class FakeVaultIndex {
  readonly adapter: FakeAdapter;
  configDir = ".obsidian";

  constructor(adapter: FakeAdapter = new FakeAdapter()) {
    this.adapter = adapter;
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return this.adapter.index();
  }
}

/** The fake, typed as the interface the plugin holds. */
export function asVault(index: FakeVaultIndex): Vault {
  return index as unknown as Vault;
}
