/**
 * The vault adapter, driven through sequences of Obsidian's own events.
 *
 * `vault.test.ts` beside this one asks whether each method does what it says.
 * This one asks a different question: after a run of the things a person does
 * to a vault, with the engine's reads and writes interleaved among them, is
 * every note still there and still itself. The methods can all be right and
 * the sequence still lose a note, because what a sequence changes is which
 * facts were true when.
 *
 * Five invariants are asserted rather than behaviour, and they are the whole
 * point of the file:
 *
 *   1. No note's content is lost, and no note holds another note's content.
 *   2. A write lands on the path it was given and on no other.
 *   3. Nothing is recorded as synced that is not on the disk that way.
 *   4. An interrupted sequence leaves a state the next pass can finish from.
 *   5. Nothing that still exists is missing from the listing, because a file
 *      the listing does not name is a file the engine reports deleted, and a
 *      deletion travels to every device (rule 6).
 *
 * The fifth is the one that catches the most, and it is the reason the fake's
 * index was made to hide dot-prefixed paths the way Obsidian's does: with a
 * kinder index the failure it describes cannot be reproduced at all.
 *
 * What is still not covered, and cannot be here: whether Obsidian fires these
 * events in this order in a real vault. The order below was read out of
 * `obsidian.asar` 1.13.7 rather than remembered, and the first describe pins
 * what was read so a future version changing it is noticed here.
 */

import { describe, expect, it } from "vitest";

import { isNeverSynced } from "../core/paths.ts";
import { FakeAdapter, FakeVaultIndex, asVault, normalizePath } from "./fake.ts";
import { ObsidianVault, type FsyncFs } from "./vault.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const times = { mtime: 1000, ctime: 1000 };

/** What Obsidian tells a plugin, in the shape the plugin's handlers take. */
interface VaultEvent {
  kind: "create" | "modify" | "delete" | "rename";
  path: string;
  oldPath?: string;
}

/**
 * Electron's adapter, as far as the vault can tell: it knows the disk path.
 *
 * The flush is the only thing that asks, and it asks so it can fsync. A phone
 * has no answer and gets a flush that does nothing.
 */
class DesktopAdapter extends FakeAdapter {
  getBasePath(): string {
    return "/home/me/vault";
  }
  getFullPath(normalizedPath: string): string {
    return normalizedPath === "" ? this.getBasePath() : `${this.getBasePath()}/${normalizedPath}`;
  }
}

/**
 * A vault, the app on top of it, and the events the app would have fired.
 *
 * Every method here is a thing a person does, done the way Obsidian does it:
 * a rename is `adapter.rename`, not a delete and a create, and a folder that
 * moves takes its contents with it. The events are recorded rather than
 * dispatched, because what this file tests is the adapter underneath, and the
 * plugin's own handling of them is in `main.test.ts`. Recording them still
 * matters: a sequence is only worth running if it is a sequence that happens,
 * and the event log is what says which one was run.
 */
class Session {
  readonly adapter: DesktopAdapter;
  readonly vault: ObsidianVault;
  readonly events: VaultEvent[] = [];
  readonly logged: string[] = [];

  constructor(opts: { insensitive?: boolean; configDir?: string; fs?: FsyncFs } = {}) {
    this.adapter = new DesktopAdapter();
    this.adapter.insensitive = opts.insensitive ?? false;
    this.vault = new ObsidianVault(
      asVault(new FakeVaultIndex(this.adapter)),
      opts.configDir ?? ".obsidian",
      (message, ...rest) => this.logged.push([message, ...rest.map(String)].join(" ")),
      opts.fs ? { fs: opts.fs } : {},
    );
  }

  /** Somebody typing: a create the first time, a modify after that. */
  typed(path: string, text: string): void {
    const kind = this.adapter.filePaths().includes(path) ? "modify" : "create";
    this.adapter.seed(path, text);
    this.events.push({ kind, path });
  }

  /**
   * A rename, and the events it fires.
   *
   * One per path, not one per rename. The adapter triggers `renamed` for the
   * thing that moved and then again for every path beneath it, and the vault
   * turns each into its own `rename` with the old path attached. A folder of
   * forty notes is forty-one events, which is why the plugin's handler has to
   * be cheap and why "a rename storm" is a thing that happens without anybody
   * renaming much.
   */
  async renamed(from: string, to: string): Promise<void> {
    const under = this.adapter
      .everything()
      .filter((p) => p.startsWith(`${from}/`))
      .sort();
    await this.adapter.rename(from, to);
    this.events.push({ kind: "rename", path: to, oldPath: from });
    for (const path of under) {
      this.events.push({ kind: "rename", path: to + path.slice(from.length), oldPath: path });
    }
  }

  /**
   * A deletion made in Obsidian, which is a move to a trash and not a remove.
   *
   * The children go first and the folder last, because that is the order the
   * adapter's own reconcile removes them in, and a plugin that assumed the
   * folder came first would see notes it thought were still there.
   */
  async deletedByHand(path: string): Promise<void> {
    const under = this.adapter
      .everything()
      .filter((p) => p.startsWith(`${path}/`))
      .sort();
    if (!(await this.adapter.trashSystem(path))) await this.adapter.trashLocal(path);
    for (const child of under) this.events.push({ kind: "delete", path: child });
    this.events.push({ kind: "delete", path });
  }

  /** The vault as the engine would see it: every syncable path, sorted. */
  async listed(): Promise<string[]> {
    return (await this.vault.list()).map((f) => f.path).sort();
  }

  /** What the disk holds, note by note, ignoring anything that never syncs. */
  notes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of this.adapter.filePaths()) {
      if (isNeverSynced(path, new Set([".obsidian"]))) continue;
      out[path] = this.adapter.text(path)!;
    }
    return out;
  }

  /** Everything in the vault's own trash, by the name it landed under. */
  trash(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of this.adapter.filePaths()) {
      if (path.startsWith(".trash/")) out[path.slice(".trash/".length)] = this.adapter.text(path)!;
    }
    return out;
  }
}

/**
 * Invariant 5, and the one worth running after everything.
 *
 * Every file on the disk that is not excluded by the one rule both shells
 * share appears in the listing, under a name that reads back. A file that
 * exists and is not listed is a file the next scan calls deleted, and rule 6
 * makes that deletion an entry that every other device applies. The engine
 * never sees the disk; it sees this listing, so this listing is where the
 * difference between "gone" and "not looked at" is decided (rule 7).
 */
async function nothingIsSilentlyMissing(session: Session): Promise<void> {
  const listed = new Set(await session.listed());
  const ignore = new Set([".obsidian"]);
  const missing = session.adapter
    .filePaths()
    .filter((path) => !isNeverSynced(path, ignore))
    .filter((path) => !listed.has(normalizePath(path)));
  expect(missing, "on disk, not in the listing, so the next scan calls them deleted").toEqual([]);
  // And every listed path is one that can be read back, because a path the
  // engine cannot read is one it will report as a failure for ever.
  for (const path of listed) {
    if ((await session.vault.list()).find((f) => f.path === path)?.folder) continue;
    await expect(session.vault.read(path), path).resolves.toBeInstanceOf(Uint8Array);
  }
}

/**
 * Invariant 1, as a multiset.
 *
 * Compared as counted contents rather than as a set, because two notes that
 * both end up holding the third one's text is exactly the failure this is
 * for, and a set would call that fine.
 */
function contentsOf(session: Session): string[] {
  return Object.values(session.notes()).sort();
}

/* ---------------------------------------------------------------- *
 * What was read out of the shipped application
 * ---------------------------------------------------------------- */

/**
 * These are not tests of this project's code, and they fail if Obsidian
 * changes rather than if Basalt does. They are here because every sequence
 * below is only worth running if the fake answers the way the application
 * does, and "the fake is faithful" is a claim that has to be written down
 * somewhere a test runner can check it against the next version.
 *
 * Each was read out of `Obsidian.app/Contents/Resources/obsidian.asar` at
 * 1.13.7, desktop and Capacitor adapters both.
 */
describe("what the fake claims Obsidian does", () => {
  it("refuses a rename onto an occupied path, with the message the app uses", async () => {
    const s = new Session();
    s.typed("a.md", "alpha");
    s.typed("b.md", "beta");
    await expect(s.adapter.rename("a.md", "b.md")).rejects.toThrow(
      "Destination file already exists!",
    );
    // Both adapters check before handing anything to the platform, so there
    // is no replace-by-rename on either. Nothing moved and nothing was lost.
    expect(s.notes()).toEqual({ "a.md": "alpha", "b.md": "beta" });
  });

  it("allows the one rename that is the point: a name whose case is being corrected", async () => {
    const folding = new Session({ insensitive: true });
    folding.typed("Note.md", "alpha");
    // The destination exists as far as the filesystem is concerned, and the
    // adapter lets it through anyway because the two names fold together.
    await expect(folding.adapter.rename("Note.md", "NOTE.md")).resolves.toBeUndefined();
    expect(folding.notes()).toEqual({ "NOTE.md": "alpha" });

    // And refuses it when they do not, even though the destination differs
    // only in case from something that is there. This is the half a subclass
    // in the other test file used to get wrong, and getting it wrong makes
    // `create` look exclusive when it is not.
    folding.typed("temp.md", "beta");
    await expect(folding.adapter.rename("temp.md", "note.md")).rejects.toThrow(
      "Destination file already exists!",
    );
  });

  it("fires a rename for the folder and one more for every path under it", async () => {
    const s = new Session();
    s.typed("work/one.md", "one");
    s.typed("work/deep/two.md", "two");
    await s.renamed("work", "archive");

    expect(s.events.filter((e) => e.kind === "rename")).toEqual([
      { kind: "rename", path: "archive", oldPath: "work" },
      { kind: "rename", path: "archive/deep", oldPath: "work/deep" },
      { kind: "rename", path: "archive/deep/two.md", oldPath: "work/deep/two.md" },
      { kind: "rename", path: "archive/one.md", oldPath: "work/one.md" },
    ]);
  });

  it("leaves every dot-prefixed path out of the index, and puts the root in it", () => {
    const s = new Session();
    s.typed("real.md", "x");
    s.adapter.seed(".obsidian/plugins/basalt/data.json", "the root secret");
    s.adapter.seed("notes/.git/config", "[core]");
    s.adapter.seed(".trash/old.md", "deleted last week");

    const index = new FakeVaultIndex(s.adapter).getAllLoadedFiles().map((f) => f.path);
    expect(index).toContain("/");
    expect(index).toContain("real.md");
    expect(index.filter((p) => p.split("/").some((part) => part.startsWith(".")))).toEqual([]);
  });

  it("drops the folders a trashed note lived under, and numbers a name already taken", async () => {
    const s = new Session();
    s.typed("work/note.md", "the work one");
    s.typed("home/note.md", "the home one");
    await s.adapter.trashLocal("work/note.md");
    await s.adapter.trashLocal("home/note.md");

    // Flattened, so the second one would have landed on the first. The
    // numbering is the only thing between them, which is why it is modelled.
    expect(s.trash()).toEqual({ "note.md": "the work one", "note 2.md": "the home one" });
  });

  it("errors on a directory that is not there rather than calling it empty", async () => {
    const s = new Session();
    // Rule 2 in the adapter itself: `list` is `readdir` with nothing caught
    // around it, so absent and empty are different answers.
    await expect(s.adapter.list("gone")).rejects.toThrow(/ENOENT/);
    await expect(s.adapter.list("/")).resolves.toEqual({ files: [], folders: [] });
  });
});

/* ---------------------------------------------------------------- *
 * Rename storms
 * ---------------------------------------------------------------- */

describe("rename storms", () => {
  it("keeps the note through A to B to C before anything syncs", async () => {
    const s = new Session();
    s.typed("a.md", "the only copy");
    await s.renamed("a.md", "b.md");
    await s.renamed("b.md", "c.md");

    expect(await s.listed()).toEqual(["c.md"]);
    expect(dec.decode(await s.vault.read("c.md"))).toBe("the only copy");
    // The names it used to have are gone, and the engine is told so by their
    // absence from the listing rather than by anything asserting it.
    expect(await s.vault.exists("a.md")).toBe(false);
    expect(await s.vault.exists("b.md")).toBe(false);
    await nothingIsSilentlyMissing(s);
  });

  it("keeps both notes through a swap, which Obsidian can only do with a third name", async () => {
    const s = new Session();
    s.typed("a.md", "alpha");
    s.typed("b.md", "beta");
    const before = contentsOf(s);

    await s.renamed("a.md", "swap.md");
    // Checked in the middle, because the middle is where a swap loses one:
    // there are three names involved and only two notes, and at no point may
    // there be fewer than two notes.
    expect(contentsOf(s)).toEqual(before);
    await s.renamed("b.md", "a.md");
    expect(contentsOf(s)).toEqual(before);
    await s.renamed("swap.md", "b.md");

    expect(s.notes()).toEqual({ "a.md": "beta", "b.md": "alpha" });
    await nothingIsSilentlyMissing(s);
  });

  it("writes where it was told when the note it scanned has been renamed away", async () => {
    const s = new Session();
    s.typed("a.md", "the note");
    // The engine scanned, then the person renamed, then the engine's download
    // for the old path landed. The old name is free now, so the write is a
    // create: what it must not do is follow the note to its new name.
    await s.renamed("a.md", "b.md");
    await s.vault.write("a.md", enc.encode("from the server"), times);

    expect(s.notes()).toEqual({ "a.md": "from the server", "b.md": "the note" });
    await nothingIsSilentlyMissing(s);
  });

  it("does not let a write follow a note that was renamed onto the path being written", async () => {
    const s = new Session();
    s.typed("a.md", "alpha");
    s.typed("b.md", "beta");
    // The engine decided to write b.md. Between its check and its rename,
    // the person renames b.md away and puts something else there. The write
    // must fail rather than land on top of whatever is at that name now.
    await s.adapter.remove("b.md");
    let raced = false;
    s.adapter.fault = (op, path) => {
      // The staged copy is about to be renamed into place, which is the last
      // instant at which the destination can change under the write.
      if (op === "rename" && path.includes(".basalt-tmp-") && !raced) {
        raced = true;
        s.adapter.seed("b.md", "arrived while the write was in flight");
      }
      return undefined;
    };

    await expect(s.vault.write("b.md", enc.encode("from the server"), times)).rejects.toThrow(
      "Destination file already exists!",
    );
    expect(s.notes()["b.md"]).toBe("arrived while the write was in flight");
    // And the failed write left nothing of itself behind.
    expect(s.adapter.filePaths().filter((p) => p.includes(".basalt-tmp-"))).toEqual([]);
  });

  it("keeps a folder rename's notes, all of them, under the new folder", async () => {
    const s = new Session();
    for (const name of ["one", "two", "three"]) s.typed(`work/${name}.md`, name);
    s.typed("work/deep/four.md", "four");
    const before = contentsOf(s);

    await s.renamed("work", "archive");

    expect(contentsOf(s)).toEqual(before);
    expect(await s.listed()).toEqual([
      "archive",
      "archive/deep",
      "archive/deep/four.md",
      "archive/one.md",
      "archive/three.md",
      "archive/two.md",
    ]);
    await nothingIsSilentlyMissing(s);
  });

  it("survives a case-only rename made while the engine holds the old spelling", async () => {
    const s = new Session({ insensitive: true });
    s.typed("Note.md", "the note");
    await s.renamed("Note.md", "note.md");

    // The engine scanned before the rename and is writing the old spelling.
    // On a folding disk the write lands in the same file, so the name has to
    // be corrected or the next scan calls Note.md missing and deletes it
    // everywhere. One file either way: never two, never none.
    await s.vault.write("Note.md", enc.encode("from the server"), times);
    expect(s.notes()).toEqual({ "Note.md": "from the server" });
    await nothingIsSilentlyMissing(s);
  });
});

/* ---------------------------------------------------------------- *
 * Rapid saves
 * ---------------------------------------------------------------- */

describe("rapid saves", () => {
  it("reads the last of several saves inside one window, never an earlier one", async () => {
    const s = new Session();
    for (let i = 1; i <= 5; i++) s.typed("note.md", `save ${i}`);

    expect(s.events.map((e) => e.kind)).toEqual(["create", "modify", "modify", "modify", "modify"]);
    expect(dec.decode(await s.vault.read("note.md"))).toBe("save 5");
    const listed = await s.vault.list();
    // The size the listing reports is the size of what a read returns. They
    // come from two places, the index and the file, and a scan that pairs one
    // note's size with another's bytes is how a truncated upload happens.
    expect(listed[0]!.size).toBe("save 5".length);
  });

  it("catches a save that lands between writing a note and reading it back (rule 4)", async () => {
    const s = new Session();
    s.typed("note.md", "what was there");
    // Same length, so nothing but reading every byte finds it. The engine's
    // write has landed and is being verified when the person's own save
    // overwrites it: the write must not be reported as done.
    s.adapter.fault = (op, path) => {
      if (op === "stat" && path === "note.md") s.adapter.seed("note.md", "AAAAAAAAAAAAAAAA");
      return undefined;
    };
    await expect(s.vault.write("note.md", enc.encode("from the server"), times)).rejects.toThrow(
      /reads back differently|is \d+ bytes after writing/,
    );
    // And the complete new copy is beside it, named in the error, so the
    // next pass has something to finish from rather than a half-written note.
    const staged = s.adapter.filePaths().filter((p) => p.includes(".basalt-tmp-"));
    expect(staged).toHaveLength(1);
    expect(s.adapter.text(staged[0]!)).toBe("from the server");
  });

  it("keeps owing a file written while the flush was running", async () => {
    const { fs, synced, during } = flushingFs();
    const s = new Session({ fs });
    await s.vault.write("first.md", enc.encode("one"), times);

    // A download lands while the pass is being made durable. The file it
    // wrote has to survive to the next flush: forgetting it would let the
    // index be saved naming a note that was never fsynced, which is the one
    // ordering rule 3 forbids here.
    during.push(async () => {
      await s.vault.write("second.md", enc.encode("two"), times);
    });
    await s.vault.flush();
    expect(synced).toContain("/home/me/vault/first.md");
    expect(synced).not.toContain("/home/me/vault/second.md");

    await s.vault.flush();
    expect(synced).toContain("/home/me/vault/second.md");
  });

  it("keeps owing a file whose second write landed while the first was being synced", async () => {
    const { fs, synced, during } = flushingFs();
    const s = new Session({ fs });
    await s.vault.write("note.md", enc.encode("one"), times);

    // The same file twice, which is the harder case: the flush is holding
    // that name and is about to cross it off, and the bytes underneath it
    // change while it does. Crossing it off would record as durable a
    // version that was never synced.
    during.push(async () => {
      await s.vault.write("note.md", enc.encode("two"), times);
    });
    await s.vault.flush();
    await s.vault.flush();

    const forThatNote = synced.filter((p) => p.endsWith("/note.md"));
    expect(
      forThatNote,
      "the second write of note.md was never made durable, and the index would say it was",
    ).toHaveLength(2);
  });

  it("does not lose a save that arrives between the listing and the read", async () => {
    const s = new Session();
    s.typed("note.md", "before");
    const listed = await s.vault.list();
    expect(listed[0]!.size).toBe("before".length);

    s.typed("note.md", "after, and longer");
    // What comes back is the file, not the listing's idea of it. The engine
    // compares the two and re-scans; what it must never get is the old bytes
    // under the new size or the reverse.
    const back = dec.decode(await s.vault.read("note.md"));
    expect(back).toBe("after, and longer");
    expect(back.length).not.toBe(listed[0]!.size);
  });
});

/**
 * A Node fs whose fsync can be interrupted, so a test can land a write in the
 * middle of a flush.
 *
 * Everything queued in `during` runs inside the first `sync`, which is the
 * only moment where the flush is holding a name it has not yet crossed off.
 */
function flushingFs(): { fs: FsyncFs; synced: string[]; during: (() => Promise<void>)[] } {
  const synced: string[] = [];
  const during: (() => Promise<void>)[] = [];
  const fs: FsyncFs = {
    promises: {
      async open(path: string) {
        return {
          async sync() {
            while (during.length) await during.shift()!();
            synced.push(path);
          },
          async close() {},
        };
      },
    },
  };
  return { fs, synced, during };
}

/* ---------------------------------------------------------------- *
 * The trash, both of them
 * ---------------------------------------------------------------- */

describe("deleting, and where the note goes", () => {
  it("prefers the system trash, which is recoverable from outside Obsidian", async () => {
    const s = new Session();
    s.adapter.systemTrashWorks = true;
    s.typed("note.md", "keep me somewhere");
    await s.vault.remove("note.md");

    expect(s.adapter.trashedToSystem).toEqual(["note.md"]);
    expect(s.trash()).toEqual({});
    expect(await s.listed()).toEqual([]);
  });

  it("falls back to the vault's trash where there is no system one", async () => {
    const s = new Session();
    s.typed("work/note.md", "keep me somewhere");
    await s.vault.remove("work/note.md");

    expect(s.trash()).toEqual({ "note.md": "keep me somewhere" });
    // And the trash never syncs back out, or the deletion would be undone on
    // every other device by the copy that was kept for safety.
    expect(await s.listed()).toEqual(["work"]);
    await nothingIsSilentlyMissing(s);
  });

  it("keeps both notes when two deletions collide on one name in the trash", async () => {
    const s = new Session();
    s.typed("work/note.md", "the work one");
    s.typed("home/note.md", "the home one");
    await s.vault.remove("work/note.md");
    await s.vault.remove("home/note.md");

    // The trash is flat, so these are one name until the adapter numbers the
    // second. Both are recoverable by hand, which is the whole reason the
    // deletion goes here rather than through `remove`.
    expect(Object.values(s.trash()).sort()).toEqual(["the home one", "the work one"]);
  });

  it("falls back when the system trash throws rather than merely refusing", async () => {
    const s = new Session();
    s.adapter.systemTrashThrows = true;
    s.typed("note.md", "keep me somewhere");
    await s.vault.remove("note.md");

    expect(s.trash()).toEqual({ "note.md": "keep me somewhere" });
    expect(await s.listed()).toEqual([]);
  });

  it("reports a deletion that did not happen as a failure, and keeps the note listed", async () => {
    const s = new Session();
    s.typed("note.md", "still here");
    s.adapter.fault = (op) =>
      op === "trashLocal" ? new Error("EACCES: read-only vault") : undefined;

    await expect(s.vault.remove("note.md")).rejects.toThrow(/EACCES/);
    // The note is on disk, so it is in the listing, so nothing tells another
    // device it is gone. Rule 6 makes a deletion an entry that travels, and
    // the trash refusing is not a deletion.
    expect(s.notes()).toEqual({ "note.md": "still here" });
    expect(await s.listed()).toEqual(["note.md"]);
    await nothingIsSilentlyMissing(s);
  });

  it("still owes a file to the flush when the trash refused it", async () => {
    const { fs, synced } = flushingFs();
    const s = new Session({ fs });
    await s.vault.write("note.md", enc.encode("written this pass"), times);
    s.adapter.fault = (op) =>
      op === "trashLocal" ? new Error("EACCES: read-only vault") : undefined;
    await expect(s.vault.remove("note.md")).rejects.toThrow(/EACCES/);

    // The file is there and was written this pass, so it is still owed. A
    // deletion that failed must not be what stops it being made durable.
    await s.vault.flush();
    expect(synced).toContain("/home/me/vault/note.md");
  });

  it("takes a folder's notes with it, and can give every one of them back", async () => {
    const s = new Session();
    s.typed("work/one.md", "one");
    s.typed("work/two.md", "two");
    s.typed("work/deep/three.md", "three");
    await s.vault.remove("work");

    expect(await s.listed()).toEqual([]);
    // Everything that was under it is in the trash, still itself. Deleting a
    // folder with notes in it is the deletion most likely to be a mistake.
    expect(s.trash()).toEqual({
      "work/one.md": "one",
      "work/two.md": "two",
      "work/deep/three.md": "three",
    });
    await nothingIsSilentlyMissing(s);
  });

  it("says nothing happened when the note had already gone", async () => {
    const s = new Session();
    s.typed("note.md", "x");
    await s.adapter.remove("note.md");
    await expect(s.vault.remove("note.md")).resolves.toBeUndefined();
    expect(s.adapter.trashedLocally).toEqual([]);
  });

  it("fails rather than claiming a deletion when the note goes between the look and the move", async () => {
    const s = new Session();
    s.typed("note.md", "x");
    s.adapter.fault = (op, path) => {
      // `remove` on the fake has nothing to await before it takes the file
      // away, so by the time the trash looks the note is already gone.
      if (op === "trashLocal" && path === "note.md") void s.adapter.remove("note.md");
      return undefined;
    };
    await expect(s.vault.remove("note.md")).rejects.toThrow(/ENOENT/);
  });
});

/* ---------------------------------------------------------------- *
 * Dotfiles, and what Obsidian does not report
 * ---------------------------------------------------------------- */

describe("the gap a dot-prefixed name leaves", () => {
  /**
   * The reason the refusal in `resolve` is a refusal and not a filter.
   *
   * Obsidian's index leaves out every dot-prefixed path, so a file written
   * under one exists on the disk and is invisible to everything above it.
   * The engine would write it, fail to see it on the next scan, and report it
   * deleted: a note that never existed anywhere would arrive at every device
   * as a deletion, and a real one under the same name elsewhere would go.
   * This test builds that state by hand, to show it is a state, and then
   * shows the vault will not create it.
   */
  it("is a file that exists and cannot be seen, which is why writing one is refused", async () => {
    const s = new Session();
    s.typed("real.md", "a note");
    // Put it there behind the vault's back, the way a peer's write would if
    // nothing refused it.
    await s.adapter.writeBinary(".obsidian/plugins/other/main.js", enc.encode("run me").buffer);

    expect(s.adapter.filePaths()).toContain(".obsidian/plugins/other/main.js");
    expect(await s.listed()).toEqual(["real.md"]);
    expect(
      new FakeVaultIndex(s.adapter)
        .getAllLoadedFiles()
        .map((f) => f.path)
        .filter((p) => p.startsWith(".obsidian")),
    ).toEqual([]);

    // And the vault refuses to be the one that puts a file there.
    //
    // Always with the never-synced refusal, never the ignored-here one, and
    // that is worth writing down because the code offers both. The dot rule
    // wins wherever it applies, and Obsidian's `validateConfigDir` requires
    // the config folder to start with a dot: it refuses anything else and
    // falls back to `.obsidian`. So the config folder is always caught by the
    // dot rule first, and the other branch is reachable only from the
    // headless client, whose `--ignore` names folders a person chose.
    await expect(
      s.vault.write(".obsidian/plugins/other/main.js", enc.encode("run me"), times),
    ).rejects.toThrow(/never synced/);
    await expect(s.vault.write(".git/config", enc.encode("[core]"), times)).rejects.toThrow(
      /never synced/,
    );
    await expect(s.vault.write("notes/.git/config", enc.encode("[core]"), times)).rejects.toThrow(
      /never synced/,
    );
  });

  it("refuses the config folder this device actually has, whatever it is called", async () => {
    const s = new Session({ configDir: ".my-config" });
    s.typed("real.md", "a note");
    await expect(
      s.vault.write(".my-config/plugins/basalt/data.json", enc.encode("{}"), times),
    ).rejects.toThrow(/never synced/);
    // A peer whose config folder is called something else uploads paths under
    // that name, and this device refusing them is the arrangement working.
    await expect(
      s.vault.write(".obsidian/appearance.json", enc.encode("{}"), times),
    ).rejects.toThrow(/never synced/);
    expect(await s.listed()).toEqual(["real.md"]);
  });

  it("leaves a staging copy the index cannot see, and the next pass still finishes", async () => {
    const s = new Session();
    s.typed("note.md", "what was there");
    // The replace fails after the staged copy is complete, so the copy stays:
    // it is the only whole copy of the new version on this device.
    s.adapter.fault = (op, path) =>
      op === "writeBinary" && path === "note.md" ? new Error("ENOSPC: disk full") : undefined;
    await expect(s.vault.write("note.md", enc.encode("from the server"), times)).rejects.toThrow(
      /The complete new content is beside it at \.basalt-tmp-/,
    );

    // Invisible to Obsidian and to the listing, so it is not a note that
    // appeared and it is not one that vanished. Invariant 5 still holds.
    const staged = s.adapter.filePaths().filter((p) => p.includes(".basalt-tmp-"));
    expect(staged).toHaveLength(1);
    expect(await s.listed()).toEqual(["note.md"]);
    await nothingIsSilentlyMissing(s);

    // And the next pass finishes the job, because the old note is untouched
    // and the write is simply tried again.
    expect(s.adapter.text("note.md")).toBe("what was there");
    s.adapter.fault = undefined;
    await s.vault.write("note.md", enc.encode("from the server"), times);
    expect(s.adapter.text("note.md")).toBe("from the server");
  });
});

/* ---------------------------------------------------------------- *
 * Things that go between one call and the next
 * ---------------------------------------------------------------- */

describe("a file that goes between the event and the read", () => {
  it("says the read failed rather than handing back nothing (rule 2)", async () => {
    const s = new Session();
    s.typed("note.md", "a note");
    const listed = await s.listed();
    expect(listed).toEqual(["note.md"]);

    await s.adapter.remove("note.md");
    // An empty result here would be uploaded as an empty note and would
    // replace the real one on every other device. Absent and unreadable are
    // both errors, and neither is zero bytes.
    await expect(s.vault.read("note.md")).rejects.toThrow(/ENOENT/);
  });

  it("finishes a flush for a file that has gone rather than blocking every later one", async () => {
    const { fs, synced } = flushingFs();
    const s = new Session({ fs });
    await s.vault.write("first.md", enc.encode("one"), times);
    await s.vault.write("second.md", enc.encode("two"), times);
    await s.adapter.remove("first.md");

    // Nothing to make durable, so the name is dropped rather than failing for
    // the rest of the session and holding up every index save behind it.
    await expect(s.vault.flush()).resolves.toBeUndefined();
    expect(synced).toContain("/home/me/vault/second.md");
  });

  it("puts the folder back when it went between the scan and the write", async () => {
    const s = new Session();
    s.typed("work/note.md", "a note");
    await s.adapter.rmdir("work", true);

    await s.vault.write("work/note.md", enc.encode("from the server"), times);
    expect(s.notes()).toEqual({ "work/note.md": "from the server" });
    await nothingIsSilentlyMissing(s);
  });
});

describe("a folder deleted with files still in it", () => {
  it("reports none of it once Obsidian has taken it away", async () => {
    const s = new Session();
    s.typed("work/one.md", "one");
    s.typed("work/deep/two.md", "two");
    s.typed("keep.md", "keep");
    await s.deletedByHand("work");

    // The children are reported before the folder, which is the order the
    // adapter removes them in, and a handler that assumed otherwise would
    // treat notes it had already been told about as still there.
    expect(s.events.filter((e) => e.kind === "delete").map((e) => e.path)).toEqual([
      "work/deep",
      "work/deep/two.md",
      "work/one.md",
      "work",
    ]);
    expect(await s.listed()).toEqual(["keep.md"]);
    await expect(s.vault.read("work/one.md")).rejects.toThrow(/ENOENT/);
    // Recoverable by hand, all of it, because Obsidian moved it rather than
    // removing it.
    expect(Object.values(s.trash()).sort()).toEqual(["one", "two"]);
    await nothingIsSilentlyMissing(s);
  });

  it("does not report a note deleted because the folder above it went", async () => {
    const s = new Session();
    s.typed("work/one.md", "one");
    // Only the folder record goes, which is what a folder rename that fails
    // half way leaves behind. The notes are still on the disk, so they are
    // still in the listing: a missing folder entry must not be read as a
    // missing note.
    await s.adapter.remove("work");
    expect(await s.listed()).toContain("work/one.md");
    await nothingIsSilentlyMissing(s);
  });
});
