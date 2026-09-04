/**
 * One name, two spellings, on a disk that keeps them apart.
 *
 * review finding C42. The disk-spelling map exists because a Mac stores
 * `café.md` with a combining accent and every other platform with a
 * precomposed one: the two are one name, the vault reports NFC, and reads and
 * writes have to reach the file the disk actually has. That mapping cannot be
 * exercised on the machine most of this is written on. APFS keeps the disk's
 * own NFD bytes and folds NFC and NFD at lookup, so `absolute` can drop the
 * whole map and every test still passes here, while ext4 keeps the two apart
 * and the note is lost. CI is Linux and would catch it; a local run would not,
 * and a green run that is not evidence is worse than no run at all (R9).
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

import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { JsonIndexStore, NodeVault } from "./vault.ts";
import { Client } from "../core/client.ts";
import { authToken, type VaultKeys } from "../core/crypto.ts";
import { testKeys, testWrapped } from "../core/test-keys.ts";
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

describe("a disk that keeps two spellings of one name apart", () => {
  it("lists the name in the form this vault reports, not the disk's", async () => {
    await writeFile(join(root, ON_DISK), "x");
    expect((await vault().list()).map((f) => f.path)).toEqual([NAME]);
  });

  it("reads, writes and removes through the spelling the disk has", async () => {
    await writeFile(join(root, ON_DISK), "on disk");
    const v = vault();
    await v.list();

    expect(dec.decode(await v.read(NAME))).toBe("on disk");
    expect(await v.exists(NAME)).toBe(true);

    // The property that matters (R10): not that the write succeeded, but that
    // it landed on the file that was already there. A write that missed would
    // succeed too, and leave two notes where the person has one.
    await v.write(NAME, enc.encode("updated"), times);
    expect(await onDisk(), "the write made a second file").toEqual([ON_DISK]);
    expect(await readFile(join(root, ON_DISK), "utf8")).toBe("updated");

    await v.remove(NAME);
    expect(await onDisk(), "the removal missed the file").toEqual([]);
  });

  it("maps every segment of a path, not only the last", async () => {
    await mkdir(join(root, "no~tes", "de~ep"), { recursive: true });
    await writeFile(join(root, "no~tes", "de~ep", ON_DISK), "deep");
    const v = vault();
    expect((await v.list()).map((f) => f.path).sort()).toEqual([
      "notes",
      "notes/deep",
      `notes/deep/${NAME}`,
    ]);
    expect(dec.decode(await v.read(`notes/deep/${NAME}`))).toBe("deep");

    await v.write(`notes/deep/${NAME}`, enc.encode("rewritten"), times);
    expect(await onDisk(join(root, "no~tes", "de~ep"))).toEqual([ON_DISK]);
  });

  it("does not create a second file under the name it already holds", async () => {
    await writeFile(join(root, ON_DISK), "mine");
    const v = vault();
    await v.list();
    expect(await v.create(NAME, enc.encode("theirs"), times)).toBe(false);
    expect(await onDisk()).toEqual([ON_DISK]);
    expect(await readFile(join(root, ON_DISK), "utf8")).toBe("mine");
  });

  it("refuses a vault holding both spellings rather than choosing one", async () => {
    await writeFile(join(root, ON_DISK), "one");
    await writeFile(join(root, NAME), "two");
    await expect(vault().list()).rejects.toThrow(/same path once normalized/);
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

  it("still writes a genuinely new name where the disk has nothing", async () => {
    const v = vault();
    await v.write("brand-new.md", enc.encode("new"), times);
    expect(await onDisk()).toEqual(["brand-new.md"]);
  });
});

/**
 * The same finding, through the command that has it: a restore in its own
 * process, against a real server, over a disk that keeps the spellings apart.
 */
describe("basalt restore into a vault whose disk spells a name its own way", () => {
  const SECRET = new Uint8Array(32).fill(43);
  let keys: VaultKeys;
  let wrapped: string;
  let server: TestServer;
  const open: Client[] = [];

  beforeAll(async () => {
    await serverBinary();
    keys = await testKeys(SECRET);
    wrapped = await testWrapped(SECRET);
  }, 180_000);
  afterAll(async () => await cleanupBinary());

  afterEach(async () => {
    while (open.length) open.pop()!.close();
    if (server) await server.cleanup();
  });

  function client(): Client {
    const c = new Client({
      vault: new NodeVault(root, { normalForm }),
      store: new JsonIndexStore(join(root, ".basalt", "index.json")),
      secret: SECRET,
      url: server.wsUrl,
      ...server.credentials(authToken(keys), wrapped),
      vaultId: "default",
      device: "mac",
      timeoutMs: 20_000,
      coalesceWrites: false,
    });
    open.push(c);
    return c;
  }

  it("puts the older version beside the note, and the vault still syncs", async () => {
    server = new TestServer();
    await server.start();

    await writeFile(join(root, ON_DISK), "the first version\n");
    const syncing = client();
    await syncing.connect();
    await syncing.settle();
    await writeFile(join(root, ON_DISK), "the second version\n");
    await syncing.settle();
    syncing.close();
    open.pop();

    // A separate process, which is what `basalt restore` is. Nothing here
    // has listed the vault.
    const restoring = client();
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
    // of two names they cannot tell apart.
    const report = await restoring.settle();
    expect(report.blocked, `blocked: ${JSON.stringify(report.inTheWay)}`).toBe(0);
  }, 120_000);
});
