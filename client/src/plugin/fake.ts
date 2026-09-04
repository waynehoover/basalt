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
 * ## What was read out of 1.13.7
 *
 * Written down because a fake nobody can check is a mock. Each of these was
 * found in `Obsidian.app/Contents/Resources/obsidian.asar`, and each was
 * something this file had wrong or had not modelled at all:
 *
 *   - `normalizePath` is four steps, two of which rename the file.
 *   - `rename` refuses an occupied destination, in *both* adapters, unless the
 *     two names differ only by case on a filesystem that folds it.
 *   - `list` is `readdir` with nothing caught around it, so a directory that
 *     is not there is an error rather than an empty listing.
 *   - `trashLocal` moves the path to `.trash/<basename>`, dropping the folders
 *     it lived under and numbering a name already taken.
 *   - The index leaves out every dot-prefixed path at any depth, and holds the
 *     vault root as a folder called `/`.
 *   - The desktop `trashSystem` lets Electron's refusal throw; the Capacitor
 *     one catches it and answers false.
 *
 * ## What it still cannot tell you
 *
 * Whether Obsidian calls these methods the way the plugin expects, whether the
 * app is in a state where the adapter is ready, and anything about the UI. Those
 * need Obsidian. What is covered here is every path through the plugin's own
 * code, which is where its bugs are.
 *
 * Two known simplifications, both in the safe direction. The real adapters put
 * every call through one queue, so nothing overlaps; this one is synchronous
 * underneath, and a test that wants an interleaving arranges it through
 * `fault`. And a real filesystem folds case per path component against the
 * directory it is in, where `insensitive` below folds whole paths against the
 * entries that exist.
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

/**
 * The key a case-folding filesystem files a path under.
 *
 * Case and Unicode composition both, because macOS folds both: APFS keeps the
 * spelling it was given and answers to either form of it.
 */
function fold(path: string): string {
  return path.normalize("NFC").toLowerCase();
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
  | "copy"
  | "trashSystem"
  | "trashLocal";

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
   * Whether two spellings that differ only by case are one file.
   *
   * False, because a `Map` is case-sensitive and so is Linux. macOS and
   * Windows are not, and Obsidian carries the same distinction under the same
   * name: the shipped adapter sets `this.insensitive` by writing
   * `.OBSIDIANTEST` and asking whether `.obsidiantest` then exists.
   *
   * It is here rather than in a test's subclass because one of the two rules
   * it changes cannot be modelled from outside. The other, that a write lands
   * on the spelling already on disk, is what makes a case-only rename lose a
   * note if nothing fixes the name.
   */
  insensitive = false;

  /** How a path is spelled on this disk, which is the folded case's whole point. */
  private real(path: string): string {
    if (!this.insensitive) return path;
    let at = "";
    for (const part of path.split("/")) {
      at = this.spelledAs(at === "" ? part : `${at}/${part}`);
    }
    return at;
  }

  /** The one existing entry this path names, or the path as it was given. */
  private spelledAs(path: string): string {
    if (this.files.has(path) || this.folders.has(path)) return path;
    const key = fold(path);
    for (const other of this.folders) if (fold(other) === key) return other;
    for (const other of this.files.keys()) if (fold(other) === key) return other;
    return path;
  }

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

  /**
   * `exists`, which the declarations give a second argument this ignores.
   *
   * `exists(path, sensitive)` asks the shipped adapter for an exact-spelling
   * answer, by reading the directory and looking for the name, and only where
   * the filesystem folds case. Nothing in the plugin passes it, so nothing
   * here implements it; a plugin that started to would find the argument
   * quietly dropped, which is why it is written down.
   */
  async exists(normalizedPath: string): Promise<boolean> {
    this.check("exists", normalizedPath);
    const at = this.real(normalizedPath);
    return this.files.has(at) || this.folders.has(at);
  }

  async stat(normalizedPath: string): Promise<Stat | null> {
    this.check("stat", normalizedPath);
    const at = this.real(normalizedPath);
    const file = this.files.get(at);
    if (file) {
      return { type: "file", ctime: file.ctime, mtime: file.mtime, size: file.binary.length };
    }
    if (this.folders.has(at) || normalizedPath === "/") {
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
    const root = normalizedPath === "/" || normalizedPath === "";
    normalizedPath = root ? normalizedPath : this.real(normalizedPath);
    // `readdir` with nothing caught around it, in both shipped adapters, so a
    // directory that is not there is an error and not an empty vault (rule
    // 2). The plugin lists the folder a file is being written into, and a
    // folder that went while the write was in flight is exactly the moment
    // this has to be told apart from "the folder is empty".
    if (!root && !this.folders.has(normalizedPath)) {
      throw new Error(
        this.files.has(normalizedPath)
          ? `ENOTDIR: not a directory, scandir '${normalizedPath}'`
          : `ENOENT: no such file or directory, scandir '${normalizedPath}'`,
      );
    }
    const prefix = root ? "" : `${normalizedPath}/`;
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
    const file = this.files.get(this.real(normalizedPath));
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
    //
    // Onto the spelling already on disk where the filesystem folds case:
    // writing `NOTE.md` over an existing `Note.md` fills that file and leaves
    // its name alone, which is the whole of the bug `matchCase` exists for.
    normalizedPath = this.real(normalizedPath);
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
    this.folders.add(this.real(normalizedPath));
  }

  /**
   * The platform's own trash, which can refuse and can throw.
   *
   * Read out of 1.13.7: the desktop adapter calls Electron's `trash` and
   * returns what it returns, so a throw from it travels; the Capacitor
   * adapter wraps its own call in a try and answers false instead. Both
   * outcomes are here, because the plugin's `remove` has to survive either.
   */
  async trashSystem(normalizedPath: string): Promise<boolean> {
    this.check("trashSystem", normalizedPath);
    if (this.systemTrashThrows) throw new Error("the system trash refused");
    if (!this.systemTrashWorks) return false;
    this.trashedToSystem.push(normalizedPath);
    await this.moveInto(this.real(normalizedPath), undefined);
    return true;
  }

  /**
   * The vault's own `.trash`, as the shipped adapter fills it.
   *
   * Read out of `obsidian-1.13.7.asar`, both adapters, because the first
   * version of this method invented something easier and a test written
   * against it would have proved nothing:
   *
   *   - `.trash` is created if it is not there.
   *   - The destination is `.trash/<basename>`, so the folders a note lived
   *     under are *not* kept. Two notes called `note.md` in different folders
   *     land on one name.
   *   - A taken name is numbered: `note 2.md`, then `note 3.md`, counting up
   *     until one is free. That numbering is the only thing standing between
   *     the second deletion and the first one's content, which makes it the
   *     part of the trash a no-loss suite has to model.
   *   - It is a rename, so a folder goes in with everything under it.
   *
   * It can fail, too: it is `mkdir` and `rename` on a real filesystem. A
   * refusal here is the case the plugin's `remove` must not mistake for a
   * deletion that happened, which is why it is fault-injectable.
   */
  async trashLocal(normalizedPath: string): Promise<void> {
    this.check("trashLocal", normalizedPath);
    const from = this.real(normalizedPath);
    // The move is a rename, so a path that has gone since the caller looked
    // is an error and not a deletion that happened.
    if (!this.files.has(from) && !this.folders.has(from)) {
      throw new Error(`ENOENT: no such file or directory, rename '${normalizedPath}'`);
    }
    this.folders.add(".trash");
    const name = from.slice(from.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    const stem = dot <= 0 ? name : name.slice(0, dot);
    const ext = dot <= 0 ? "" : name.slice(dot);
    let at = `.trash/${stem}${ext}`;
    for (let n = 1; this.files.has(at) || this.folders.has(at);) {
      at = `.trash/${stem} ${++n}${ext}`;
    }
    this.trashedLocally.push(normalizedPath);
    await this.moveInto(from, at);
  }

  /**
   * Takes a path out of the vault, with everything under it if it is a
   * folder, and puts it back at `to` when there is somewhere for it to go.
   *
   * Both trashes are a move rather than a delete, so a folder that still has
   * notes in it takes them along. The system trash has nowhere in the vault
   * to put them, so they simply leave.
   */
  private async moveInto(from: string, to: string | undefined): Promise<void> {
    const under = `${from}/`;
    const at = (path: string): string | undefined =>
      to === undefined ? undefined : to + path.slice(from.length);
    for (const [path, file] of [...this.files]) {
      if (path !== from && !path.startsWith(under)) continue;
      this.files.delete(path);
      const dest = at(path);
      if (dest !== undefined) this.files.set(dest, file);
    }
    for (const path of [...this.folders]) {
      if (path !== from && !path.startsWith(under)) continue;
      this.folders.delete(path);
      const dest = at(path);
      if (dest !== undefined) this.folders.add(dest);
    }
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
    const at = this.real(normalizedPath);
    this.files.delete(at);
    this.folders.delete(at);
  }

  /**
   * Refuses an occupied destination, as the shipped adapter does.
   *
   * Read out of `obsidian-1.13.7.asar`, and in *both* adapters, which is worth
   * saying because this file's own header used to leave the mobile one open:
   * desktop and Capacitor each look the destination up and throw
   * "Destination file already exists!" before handing anything to the
   * platform, and each makes the same single exception, for two names that
   * differ only by case on a filesystem that folds it. So there is no
   * replace-by-rename on either platform. The first version of this fake
   * replaced the destination silently, which would have let a
   * replace-by-rename pass every test here and fail in every vault.
   *
   * The exemption is not a nicety. It is the one rename `matchCase` makes,
   * and on macOS it is the only way to correct a spelling in place.
   *
   * Folders move with everything under them. The *event* is not one event,
   * whatever an earlier version of this comment said: the adapter fires
   * `renamed` for the folder and then once more for every path beneath it,
   * and each one reaches a plugin as its own `rename`. `renameFolder` in the
   * event suite fires them the way the application does.
   */
  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    this.check("rename", normalizedPath, normalizedNewPath);
    if (normalizedPath === normalizedNewPath) return;
    const from = this.real(normalizedPath);
    const onto = this.real(normalizedNewPath);
    const caseOnly = this.insensitive && fold(normalizedPath) === fold(normalizedNewPath);
    if (!caseOnly && (this.files.has(onto) || this.folders.has(onto))) {
      throw new Error("Destination file already exists!");
    }
    // A rename spells the destination the way it was asked for, folding or
    // not: that is what makes it the way to correct a name's case.
    const to = normalizedNewPath;
    const file = this.files.get(from);
    if (file) {
      this.files.delete(from);
      this.files.set(to, file);
      return;
    }
    if (!this.folders.has(from)) {
      throw new Error(`ENOENT: no such file or directory, rename '${normalizedPath}'`);
    }
    this.folders.delete(from);
    this.folders.add(to);
    const under = `${from}/`;
    for (const path of [...this.folders]) {
      if (path.startsWith(under)) {
        this.folders.delete(path);
        this.folders.add(to + path.slice(from.length));
      }
    }
    for (const [path, f] of [...this.files]) {
      if (path.startsWith(under)) {
        this.files.delete(path);
        this.files.set(to + path.slice(from.length), f);
      }
    }
  }

  async copy(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    this.check("copy", normalizedPath, normalizedNewPath);
    const file = this.files.get(this.real(normalizedPath));
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
   * Whether the index leaves out dot-prefixed paths, as Obsidian's does.
   *
   * True, because that is what the application does, and the fake being
   * kinder than the application is how a filter gets tested against input it
   * will never see while the failure it exists to prevent goes unmodelled.
   * A test that wants to prove the plugin's own filter holds anyway sets this
   * false and hands the index a dotfile Obsidian would never have put there.
   */
  indexHidesDotfiles = true;

  /**
   * What Obsidian's own index holds: every file and folder, with each file's
   * times and size attached.
   *
   * The real one is in memory and already populated, which is why the plugin
   * reads it rather than asking the adapter about every file in turn.
   *
   * Two things it does that a plainer listing would not, both read out of
   * `obsidian-1.13.7.asar`:
   *
   * The vault root is in it, as a folder whose path is `/`. `fileMap` is
   * seeded with it before anything is scanned and `getAllLoadedFiles` returns
   * every value in `fileMap`, so the first entry the plugin sees is a thing
   * that is not a file and has no name.
   *
   * And nothing dot-prefixed is in it, at any depth. The scan tests each path
   * with a predicate that walks up the segments and stops at the first one
   * starting with a dot, and a path that matches is passed to
   * `reconcileDeletion` instead of being indexed. So `.obsidian/...`,
   * `.trash/...`, a `.git` anywhere, and this plugin's own staging copies are
   * invisible to `getAllLoadedFiles`, however plainly they exist on disk.
   * That is the whole reason a write under such a name can never be allowed:
   * it would land, never be listed, and be reported deleted on the next scan.
   */
  index(): TAbstractFile[] {
    const hidden = (path: string): boolean =>
      this.indexHidesDotfiles && path.split("/").some((part) => part.startsWith("."));
    const out: TAbstractFile[] = [{ path: "/", name: "" } as TAbstractFile];
    for (const path of this.folders) {
      if (hidden(path)) continue;
      out.push({ path, name: path.split("/").pop() ?? path } as TAbstractFile);
    }
    for (const [path, f] of this.files) {
      if (hidden(path)) continue;
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
