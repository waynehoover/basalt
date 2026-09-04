/**
 * One name, two spellings, on a disk that keeps them apart.
 *
 * review finding C42. A Mac stores `café.md` with a combining accent and every
 * other platform with a precomposed one: the two are one name, the vault
 * reports NFC, and reads, writes and the disk itself have to end up agreeing.
 * None of that can be exercised on the machine most of this is written on.
 * APFS folds NFC and NFD at lookup, so a vault can drop the whole mechanism
 * and every test still passes here, while ext4 keeps the two apart and the
 * note is lost. CI is Linux and would catch it; a local run would not, and a
 * green run that is not evidence is worse than no run at all (R9).
 *
 * So the normal form is injected. Here it is "the name without its tildes",
 * and `cafe~.md` and `cafe.md` are two files on every filesystem there is,
 * including this one. Nothing being checked below is a fact about Unicode: it
 * is one name, two spellings, and a disk that files them separately, which is
 * exactly what ext4 does with NFC and NFD.
 *
 * The NFC-specific behaviour keeps its own tests next door in vault.test.ts,
 * where they run against real NFD names and a real Mac disk.
 */

import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { JsonIndexStore, NodeVault } from "./vault.ts";
import { Client } from "../core/client.ts";
import { testWrapped } from "../core/test-keys.ts";
import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";

/** The disk's spelling of the name, and the one this vault reports. */
const ON_DISK = "cafe~.md";
const NAME = "cafe.md";

/** A normal form a Mac cannot fold away, standing in for NFC. */
const normalForm = (name: string): string => name.replaceAll("~", "");

const times = { mtime: 1_700_000_000_000, ctime: 1_700_000_000_000 };
const enc = new TextEncoder();
const dec = new TextDecoder();

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basalt-spelling-"));
});
afterEach(async () => {
  await removeTree(root);
});

/** The vault's files as the disk spells them, without the state folder. */
async function onDisk(dir = root): Promise<string[]> {
  return (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
}

function vault(): NodeVault {
  return new NodeVault(root, { normalForm });
}

/**
 * review finding C44. Reporting one spelling while holding another is half a
 * fix, and the half that is missing loses the vault's whole promise.
 *
 * Shipped in 0.3.3: a Mac created `écombining.md` with a combining acute, this
 * vault reported it precomposed, uploaded it precomposed, and every other
 * device wrote it precomposed. Nothing ever went back for the Mac's own copy,
 * so the device that had the note kept the one spelling nothing else had, for
 * ever. On APFS that is invisible and on ext4 it is two different filenames in
 * two vaults that are supposed to be one, which is verbatim the divergence
 * normalising was added to end, moved from the wire to the disk.
 *
 * The correction a device owes the server for a name spelled the old way is a
 * rename. This is the same correction, owed to its own disk.
 */
describe("a name the disk spells its own way", () => {
  it("is listed in the form this vault reports", async () => {
    await writeFile(join(root, ON_DISK), "x");
    expect((await vault().list()).map((f) => f.path)).toEqual([NAME]);
  });

  it("is renamed on disk to the spelling every other device will use", async () => {
    await writeFile(join(root, ON_DISK), "the note");
    await vault().list();
    expect(await onDisk(), "the disk kept a spelling no other device produces").toEqual([NAME]);
    // A rename, not a copy: the bytes were never rewritten and there is one
    // file, not two (R5, and the first rule).
    expect(await readFile(join(root, NAME), "utf8")).toBe("the note");
  });

  it("renames every segment of a path, not only the last", async () => {
    await mkdir(join(root, "no~tes", "de~ep"), { recursive: true });
    await writeFile(join(root, "no~tes", "de~ep", ON_DISK), "deep");
    const v = vault();
    expect((await v.list()).map((f) => f.path).sort()).toEqual([
      "notes",
      "notes/deep",
      `notes/deep/${NAME}`,
    ]);
    expect(await onDisk(join(root, "notes", "deep"))).toEqual([NAME]);
    expect(dec.decode(await v.read(`notes/deep/${NAME}`))).toBe("deep");
  });

  it("reads, writes and removes the one file it left behind", async () => {
    await writeFile(join(root, ON_DISK), "on disk");
    const v = vault();
    await v.list();

    expect(dec.decode(await v.read(NAME))).toBe("on disk");
    expect(await v.exists(NAME)).toBe(true);

    // The property that matters (R10): not that the write succeeded, but that
    // it landed on the file that was already there. A write that missed would
    // succeed too, and leave two notes where the person has one.
    await v.write(NAME, enc.encode("updated"), times);
    expect(await onDisk(), "the write made a second file").toEqual([NAME]);
    expect(await readFile(join(root, NAME), "utf8")).toBe("updated");

    await v.remove(NAME);
    expect(await onDisk(), "the removal missed the file").toEqual([]);
  });

  it("does not create a second file under the name it already holds", async () => {
    await writeFile(join(root, ON_DISK), "mine");
    const v = vault();
    await v.list();
    expect(await v.create(NAME, enc.encode("theirs"), times)).toBe(false);
    expect(await onDisk()).toEqual([NAME]);
    expect(await readFile(join(root, NAME), "utf8")).toBe("mine");
  });

  it("leaves it alone, under the spelling it has, when the rename cannot happen", async () => {
    // The one case where the normal form is not free. `rename` replaces what
    // is at the destination without a word, and taking that name would
    // destroy the other note (R3): the two files are the whole of what a
    // person needs to decide which they meant.
    await writeFile(join(root, ON_DISK), "the disk's spelling");
    await writeFile(join(root, NAME), "the normal one");
    const v = vault();
    await v.list();
    expect(await onDisk()).toEqual([NAME, ON_DISK]);
    expect(await readFile(join(root, ON_DISK), "utf8")).toBe("the disk's spelling");
    expect(await readFile(join(root, NAME), "utf8")).toBe("the normal one");
  });
});

/**
 * Two files on disk that are one path once normalized.
 *
 * It used to throw out of `list`, which stopped the whole vault: one ambiguous
 * pair and every other note in the vault went nowhere, including the ones
 * somebody was writing that minute, until a person renamed one of two names
 * that look identical. Failing loudly is the rule and naming the pair is what
 * satisfies it; stopping four thousand other notes is not what it asks for,
 * and a vault that syncs nothing is the larger risk to the first rule.
 */
describe("a vault holding both spellings", () => {
  it("names the pair rather than refusing the whole vault", async () => {
    await writeFile(join(root, ON_DISK), "one");
    await writeFile(join(root, NAME), "two");
    await writeFile(join(root, "unrelated.md"), "fine");
    const v = vault();

    const listed = (await v.list()).map((f) => f.path);
    expect(listed, "the rest of the vault stopped as well").toEqual(["unrelated.md"]);
    expect(v.ambiguous()).toEqual([{ path: NAME, spellings: [NAME, ON_DISK] }]);
  });

  it("names the pair with the folder it is in", async () => {
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", ON_DISK), "one");
    await writeFile(join(root, "notes", NAME), "two");
    const v = vault();
    await v.list();
    expect(v.ambiguous()).toEqual([
      { path: `notes/${NAME}`, spellings: [`notes/${NAME}`, `notes/${ON_DISK}`] },
    ]);
  });

  it("stops naming it the moment one of the two is renamed", async () => {
    await writeFile(join(root, ON_DISK), "one");
    await writeFile(join(root, NAME), "two");
    const v = vault();
    await v.list();
    expect(v.ambiguous()).toHaveLength(1);

    await rename(join(root, ON_DISK), join(root, "decided.md"));
    expect((await v.list()).map((f) => f.path).sort()).toEqual([NAME, "decided.md"]);
    expect(v.ambiguous(), "the refusal outlived what caused it").toEqual([]);
  });

  it("does not walk into a folder two names claim", async () => {
    // Neither subtree is listed, because no path inside a folder nobody can
    // name is a path anything can act on. The engine blocks the folder and
    // everything under it, which is why nothing below is reported gone.
    await mkdir(join(root, "no~tes"), { recursive: true });
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "no~tes", "a.md"), "a");
    await writeFile(join(root, "notes", "b.md"), "b");
    const v = vault();
    expect(await v.list()).toEqual([]);
    expect(v.ambiguous()).toEqual([{ path: "notes", spellings: ["notes", "no~tes"] }]);
  });
});

/**
 * review finding C43. The spellings were learned only by `list`, and the
 * commands that recover a note never call it: `basalt restore` is its own
 * process, and it went straight to `exists` and a write.
 *
 * On a disk that keeps the two spellings apart that made restore invisible to
 * itself. The note was there under the disk's name, `exists` asked about the
 * other one and was told no, and the restore landed beside the note instead of
 * being numbered past it. The next `basalt sync` then refused the whole vault:
 * two files, one path once normalized, and two names on screen that look
 * identical. One note recovered, every note stopped.
 *
 * `list` now renames such a name into its normal form, so the map below is
 * what a vault falls back on when it has not listed or when the rename could
 * not happen: a read-only vault, a filesystem that stores a normal form of its
 * own, or exactly this, a fresh process that was asked to recover one note.
 */
describe("a vault nothing has listed", () => {
  it("still resolves a name the disk spells its own way", async () => {
    await writeFile(join(root, ON_DISK), "already here");
    // No `list()`. This is a fresh process that was asked to recover a note.
    const v = vault();
    expect(await v.exists(NAME), "restore would write a second file").toBe(true);
    expect(dec.decode(await v.read(NAME))).toBe("already here");
    expect(await v.create(NAME, enc.encode("second"), times)).toBe(false);
    expect(await onDisk()).toEqual([ON_DISK]);
  });

  it("resolves a name inside a folder the disk spells its own way", async () => {
    await mkdir(join(root, "no~tes"), { recursive: true });
    await writeFile(join(root, "no~tes", ON_DISK), "deep and already here");
    const v = vault();
    expect(await v.exists(`notes/${NAME}`)).toBe(true);
    expect(dec.decode(await v.read(`notes/${NAME}`))).toBe("deep and already here");
  });

  it("writes and removes through that spelling rather than beside it", async () => {
    await writeFile(join(root, ON_DISK), "on disk");
    const v = vault();
    await v.write(NAME, enc.encode("updated"), times);
    expect(await onDisk(), "the write made a second file").toEqual([ON_DISK]);
    expect(await readFile(join(root, ON_DISK), "utf8")).toBe("updated");
    await v.remove(NAME);
    expect(await onDisk(), "the removal missed the file").toEqual([]);
  });

  it("still writes a genuinely new name where the disk has nothing", async () => {
    const v = vault();
    await v.write("brand-new.md", enc.encode("new"), times);
    expect(await onDisk()).toEqual(["brand-new.md"]);
  });
});

/** Everything below runs a real client against a real server. */
const SECRET = new Uint8Array(32).fill(43);
let wrapped: string;
let server: TestServer;
const open: Client[] = [];
const extra: string[] = [];

beforeAll(async () => {
  await serverBinary();
  wrapped = await testWrapped(SECRET);
}, 180_000);
afterAll(async () => await cleanupBinary());

afterEach(async () => {
  while (open.length) open.pop()!.close();
  while (extra.length) await removeTree(extra.pop()!);
  if (server) await server.cleanup();
});

async function client(dir = root, device = "mac", form = normalForm): Promise<Client> {
  const c = new Client({
    vault: new NodeVault(dir, { normalForm: form }),
    store: new JsonIndexStore(join(dir, ".basalt", "index.json")),
    url: server.wsUrl,
    ...(await server.deviceCredentials(SECRET, wrapped)),
    vaultId: "default",
    device,
    timeoutMs: 20_000,
    coalesceWrites: false,
  });
  open.push(c);
  return c;
}

async function second(name: string): Promise<{ c: Client; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `basalt-spelling-${name}-`));
  extra.push(dir);
  const c = await client(dir, name);
  await c.connect();
  return { c, dir };
}

/**
 * The whole of failure C44, end to end, on the disk that cannot hide it.
 *
 * This is the shape of the stress suite's "round-trips every one to another
 * device", which is where it was found, run here against the injected normal
 * form so it fails on any machine rather than only on Linux (R9).
 */
describe("two devices, both on disks that keep the spellings apart", () => {
  it("end up holding the same names, not one each", async () => {
    server = new TestServer();
    await server.start();

    await writeFile(join(root, ON_DISK), "written the disk's way\n");
    const a = await client();
    await a.connect();
    await a.settle();

    const b = await second("b");
    await b.c.settle();

    // Rule 10: the property is that the two vaults are one vault. Two
    // devices each holding a spelling the other does not is the divergence
    // normalising exists to end, and it agrees on every count while it
    // happens.
    expect(await onDisk(b.dir), "the second device did not get the note").toEqual([NAME]);
    expect(await onDisk(root), "the first device kept a spelling nothing else has").toEqual([NAME]);
    expect(await readFile(join(b.dir, NAME), "utf8")).toBe("written the disk's way\n");
  }, 120_000);
});

/**
 * Two files that genuinely differ only by normal form, with a vault around
 * them, and the question of what that should cost the rest of the vault.
 */
describe("a disk that holds both spellings, with a server behind it", () => {
  it("blocks the one name two files claim and syncs the rest of the vault", async () => {
    server = new TestServer();
    await server.start();

    await writeFile(join(root, ON_DISK), "one\n");
    await writeFile(join(root, NAME), "two\n");
    await writeFile(join(root, "unrelated.md"), "fine\n");
    const mac = await client();
    await mac.connect();
    const report = await mac.settle();

    // Named, so a person can act on it, and spelled out, because the whole
    // difficulty is that the two names look identical printed plainly.
    expect(report.blocked, "the pair went through unremarked").toBeGreaterThan(0);
    expect(report.inTheWay.map((b) => b.path)).toEqual([NAME]);
    const why = report.inTheWay[0]!.why ?? "";
    expect(why, `nothing in the message tells the two apart: ${why}`).toContain(ON_DISK);
    expect(why).toContain(NAME);

    // And the rest of the vault went, which is the whole point of blocking
    // one name rather than refusing the vault.
    const other = await second("other");
    await other.c.settle();
    expect(await onDisk(other.dir)).toEqual(["unrelated.md"]);

    // Neither file was touched, and neither was uploaded under the shared
    // name: only a person can say which they meant.
    expect(await readFile(join(root, ON_DISK), "utf8")).toBe("one\n");
    expect(await readFile(join(root, NAME), "utf8")).toBe("two\n");
  }, 120_000);

  it("does not report the note gone when a second spelling appears beside it", async () => {
    server = new TestServer();
    await server.start();

    await writeFile(join(root, NAME), "the note\n");
    const mac = await client();
    await mac.connect();
    await mac.settle();
    const other = await second("other");
    await other.c.settle();
    expect(await onDisk(other.dir)).toEqual([NAME]);

    // Somebody drops the other spelling in. The vault can no longer say which
    // file the path means, so nothing syncs under it. What must not happen is
    // the note being reported deleted because the listing stopped naming it:
    // that is a deletion on the strength of a spelling, and it would travel
    // to every other device (R6, and the first rule).
    await writeFile(join(root, ON_DISK), "and another\n");
    const report = await mac.settle();
    expect(report.deletedRemotely, "the note was deleted on the server").toBe(0);
    expect(report.blocked).toBeGreaterThan(0);

    const theirs = await other.c.settle();
    expect(theirs.deletedLocally, "the other device lost the note").toBe(0);
    expect(await readFile(join(other.dir, NAME), "utf8")).toBe("the note\n");

    // And once a person has said which they meant, it clears itself.
    await rename(join(root, ON_DISK), join(root, "decided.md"));
    const after = await mac.settle();
    expect(after.blocked, `still blocked: ${JSON.stringify(after.inTheWay)}`).toBe(0);
    await other.c.settle();
    expect(await onDisk(other.dir)).toEqual([NAME, "decided.md"]);
  }, 120_000);

  it("does not report a subtree gone when two names claim its folder", async () => {
    server = new TestServer();
    await server.start();

    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "a.md"), "a\n");
    await writeFile(join(root, "notes", "b.md"), "b\n");
    const mac = await client();
    await mac.connect();
    await mac.settle();
    const other = await second("other");
    await other.c.settle();
    expect(await onDisk(join(other.dir, "notes"))).toEqual(["a.md", "b.md"]);

    // A second folder appears that is the same name once normalized. Neither
    // is walked into, because no path inside a folder nobody can name means
    // anything, so every note under it drops out of the listing at once.
    //
    // That is the dangerous shape: a path in the index and not in the listing
    // is a path this device reports deleted, and here it would be two notes
    // it can plainly see, deleted everywhere, on the strength of a spelling
    // (R6, and the first rule).
    await mkdir(join(root, "no~tes"), { recursive: true });
    await writeFile(join(root, "no~tes", "c.md"), "c\n");
    const report = await mac.settle();
    expect(report.deletedRemotely, "the subtree was deleted on the server").toBe(0);
    expect(report.blocked, "the folder went through unremarked").toBeGreaterThan(0);
    expect(report.inTheWay.map((b) => b.path).sort()).toEqual([
      "notes",
      "notes/a.md",
      "notes/b.md",
    ]);

    const theirs = await other.c.settle();
    expect(theirs.deletedLocally, "the other device lost the subtree").toBe(0);
    expect(await onDisk(join(other.dir, "notes"))).toEqual(["a.md", "b.md"]);
  }, 120_000);
});

/**
 * The message, over a pair whose spellings do not survive being printed.
 *
 * `JSON.stringify` escapes quotes and control characters and leaves the rest
 * alone, so the refusal that names two normal forms of one name printed the
 * same string twice and asked a person to rename one of them. Everything else
 * here uses tildes, which are visible, so this is the one place the escaping
 * itself is on the line: the seam folds a slashed o to a plain one, which no
 * filesystem does, and prints as a character `JSON.stringify` passes through.
 */
describe("naming two spellings a person cannot tell apart", () => {
  const FOLDED = "n\u00f8te.md";
  const PLAIN = "note.md";
  // Not the sharp s, which was the first choice here: APFS folds it to "ss"
  // at lookup and the two files were one file, so the test proved nothing.
  const slashFolds = (name: string): string => name.replaceAll("\u00f8", "o");

  it("spells both of them out", async () => {
    server = new TestServer();
    await server.start();
    await writeFile(join(root, FOLDED), "one\n");
    await writeFile(join(root, PLAIN), "two\n");

    const mac = await client(root, "mac", slashFolds);
    await mac.connect();
    const report = await mac.settle();

    const why = report.inTheWay[0]?.why ?? "";
    expect(why, `nothing was said: ${JSON.stringify(report.inTheWay)}`).toContain(PLAIN);
    expect(why, `the two names print the same: ${why}`).toContain("n\\u{f8}te.md");
  }, 120_000);
});

/**
 * The same C43 finding, through the command that has it: a restore in its own
 * process, against a real server, over a disk that keeps the spellings apart.
 *
 * The vault is put back into the disk's own spelling by hand before the
 * restore, because a listing now corrects that: this is the vault an older
 * client left behind, met by a process that goes straight to `exists` and a
 * write without listing anything.
 */
describe("basalt restore into a vault whose disk spells a name its own way", () => {
  it("puts the older version beside the note, and the vault still syncs", async () => {
    server = new TestServer();
    await server.start();

    await writeFile(join(root, NAME), "the first version\n");
    const syncing = await client();
    await syncing.connect();
    await syncing.settle();
    await writeFile(join(root, NAME), "the second version\n");
    await syncing.settle();
    syncing.close();
    open.pop();

    // What a client older than the rename rule left on the disk.
    await rename(join(root, NAME), join(root, ON_DISK));

    // A separate process, which is what `basalt restore` is. Nothing here
    // has listed the vault.
    const restoring = await client();
    await restoring.connect();
    const versions = await restoring.history(NAME);
    expect(versions.length, "the note has no history to restore from").toBeGreaterThanOrEqual(2);
    const first = versions.find((v) => v.size === "the first version\n".length);
    expect(first, "the first version is not in the history").toBeDefined();
    const put = await restoring.restore(first!);

    // Beside the note, never over it and never under its own name: the disk
    // holds the note it had, plus one restored copy.
    expect(put.path).not.toBe(NAME);
    const held = await onDisk();
    expect(held, `restore did not go beside the note: ${JSON.stringify(held)}`).toHaveLength(2);
    expect(held).toContain(ON_DISK);
    expect(await readFile(join(root, ON_DISK), "utf8")).toBe("the second version\n");

    // And the vault still syncs. This is where it used to stop: two files,
    // one path once normalized, and nothing moves until a person renames one
    // of two names they cannot tell apart. The listing now puts the note back
    // under the name the vault reports, and the restored copy keeps its own.
    const report = await restoring.settle();
    expect(report.blocked, `blocked: ${JSON.stringify(report.inTheWay)}`).toBe(0);
    expect(await onDisk()).toContain(NAME);
  }, 120_000);
});
