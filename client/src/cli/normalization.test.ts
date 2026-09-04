/**
 * The same note created on a Mac and on anything else.
 *
 * A Mac spells `café.md` on disk with a combining accent (NFD) and every other
 * platform with a precomposed one (NFC). The bytes differ and the name does
 * not: the two are canonically equivalent, one name by definition. A sync that
 * treats them as two names has two devices each refusing the other's spelling
 * for ever, and the refusal names two strings the person cannot tell apart.
 *
 * Real filesystem on the Mac side, because the spelling is the disk's doing
 * and an in-memory vault cannot have that property. The peer is in memory and
 * spells the name the way the plugin and every non-Mac device do.
 */

import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { authToken, type VaultKeys } from "../core/crypto.ts";
import { testKeys, testWrapped } from "../core/test-keys.ts";
import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { MemoryIndexStore, MemoryVault } from "../core/vault.ts";
import { JsonIndexStore, NodeVault } from "./vault.ts";

const SECRET = new Uint8Array(32).fill(29);
let keys: VaultKeys;
let wrapped: string;
beforeAll(async () => {
  await serverBinary();
  keys = await testKeys(SECRET);
  wrapped = await testWrapped(SECRET);
}, 180_000);
afterAll(async () => await cleanupBinary());

let server: TestServer;
const open: Client[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (open.length) open.pop()!.close();
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
});

function credentials(name: string) {
  return {
    secret: SECRET,
    url: server.wsUrl,
    ...server.credentials(authToken(keys), wrapped),
    vaultId: "default",
    device: name,
    timeoutMs: 20_000,
    coalesceWrites: false,
  };
}

async function diskDevice(name: string): Promise<{ c: Client; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `basalt-nfc-${name}-`));
  dirs.push(dir);
  const c = new Client({
    vault: new NodeVault(dir),
    store: new JsonIndexStore(join(dir, ".basalt", "index.json")),
    ...credentials(name),
  });
  open.push(c);
  await c.connect();
  return { c, dir };
}

async function memoryDevice(name: string): Promise<{ c: Client; vault: MemoryVault }> {
  const vault = new MemoryVault();
  const c = new Client({ vault, store: new MemoryIndexStore(), ...credentials(name) });
  open.push(c);
  await c.connect();
  return { c, vault };
}

/**
 * How this disk spells a name, so a test can edit the file that is there.
 *
 * Not the same as the name: `café.md` reaches the file on macOS whichever
 * normal form it is in, and on ext4 only in the one the disk has. A test that
 * wants to edit a note has to open the note.
 */
async function onDiskName(dir: string, name: string): Promise<string> {
  const found = (await readdir(dir)).find((n) => n.normalize("NFC") === name);
  if (found === undefined) throw new Error(`${name} is not in ${dir}`);
  return found;
}

/** The files on disk, as text by NFC name, without the state folder. */
async function held(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of await readdir(dir)) {
    if (name.startsWith(".")) continue;
    out[name.normalize("NFC")] = await readFile(join(dir, name), "utf8");
  }
  return out;
}

const NFD = "café.md";
const NFC = "café.md";

describe("one name spelled NFD on one disk and NFC on another", () => {
  it("is one note to both devices, and neither text is lost", async () => {
    server = new TestServer();
    await server.start();
    const mac = await diskDevice("mac");
    const other = await memoryDevice("other");

    // Both create the note before either syncs, the Mac under the spelling
    // its disk uses and the other under the one everything else uses.
    await writeFile(join(mac.dir, NFD), "written on the mac\n");
    await other.vault.edit(NFC, "written elsewhere\n");

    let mine = await mac.c.settle();
    let theirs = await other.c.settle();
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 60));
      mine = await mac.c.settle();
      await new Promise((r) => setTimeout(r, 60));
      theirs = await other.c.settle();
    }

    // Neither device is left refusing the other's spelling. That refusal is
    // right for two names a person could tell apart, and these are not two
    // names.
    expect(
      { blocked: mine.blocked, skipped: mine.skipped, retrying: mine.retrying },
      `the mac is stuck: ${JSON.stringify(mine)}`,
    ).toEqual({ blocked: 0, skipped: 0, retrying: 0 });
    expect(
      { blocked: theirs.blocked, skipped: theirs.skipped, retrying: theirs.retrying },
      `the other device is stuck: ${JSON.stringify(theirs)}`,
    ).toEqual({ blocked: 0, skipped: 0, retrying: 0 });

    // Rule 10: the property is that both texts survive, on both devices.
    const onMac = await held(mac.dir);
    const onOther = other.vault.snapshot();
    for (const [name, files] of [
      ["mac", onMac],
      ["other", onOther],
    ] as const) {
      const all = Object.values(files).join("\n");
      expect(all, `${name} lost the mac's text: ${JSON.stringify(files)}`).toContain(
        "written on the mac",
      );
      expect(all, `${name} lost the other text: ${JSON.stringify(files)}`).toContain(
        "written elsewhere",
      );
    }

    // And they agree on what the vault contains: the same names, one of them
    // the note and the other its conflict copy, and the Mac's disk holds one
    // file for the name rather than one per spelling.
    expect(Object.keys(onMac).sort()).toEqual(Object.keys(onOther).sort());
    expect(Object.keys(onMac).filter((n) => n === NFC)).toEqual([NFC]);
    expect(Object.keys(onOther)).toContain(NFC);
  }, 120_000);

  it("carries an edit each way under one name", async () => {
    server = new TestServer();
    await server.start();
    const mac = await diskDevice("mac");
    const other = await memoryDevice("other");

    // The Mac has the note under its own spelling before anything syncs.
    await writeFile(join(mac.dir, NFD), "first\n");
    await mac.c.settle();
    // And after the first listing it has it under the spelling every other
    // device uses, because a vault that reports one name and holds another is
    // a vault two devices do not agree about (C44).
    expect(await readdir(mac.dir).then((n) => n.filter((f) => !f.startsWith(".")))).toEqual([NFC]);
    await other.c.settle();
    expect(other.vault.paths(), "the other device got the Mac's spelling").toEqual([NFC]);
    expect(other.vault.text(NFC)).toBe("first\n");

    // An edit from the other side lands on the file the Mac already has.
    await other.vault.edit(NFC, "second\n");
    await other.c.settle();
    await mac.c.settle();
    expect(await held(mac.dir)).toEqual({ [NFC]: "second\n" });

    // And one from the Mac travels back under the same name. Through the
    // spelling the disk has, because that is what editing the note means: the
    // literal NFD name is an edit on APFS and a second file on ext4.
    await writeFile(join(mac.dir, await onDiskName(mac.dir, NFC)), "third\n");
    await mac.c.settle();
    await other.c.settle();
    expect(other.vault.snapshot()).toEqual({ [NFC]: "third\n" });
  }, 120_000);
});

/**
 * review finding C41. The same name, already on the server in the spelling an
 * older Mac client uploaded, and a device pairing into that vault now.
 *
 * Measured before the fold: the device wrote the note under its NFC name,
 * found a name its index did not know, uploaded it as a second note, and then
 * reported `blocked: 1` on every pass for ever, naming two strings a person
 * cannot tell apart. Which is verbatim the failure normalising was added to
 * prevent.
 */
describe("a peer that spells the name NFD", () => {
  it("is one note here, and the vault settles", async () => {
    server = new TestServer();
    await server.start();

    // The old client: a vault that hands out the disk's own spelling, which
    // is what this client did before it normalised. It uploads and goes.
    const old = await memoryDevice("old");
    await old.vault.edit(NFD, "written by the old client\n");
    await old.c.settle();
    old.c.close();

    const mac = await diskDevice("mac");
    let mine = await mac.c.settle();
    // A device that has just joined a vault does not delete anything in it.
    // Without the fold it did: it uploaded the NFC name as a second note and
    // told the server the NFD one was gone, which is a deletion of somebody
    // else's note on the strength of a spelling. The correction it owes is a
    // rename, and a rename deletes nothing.
    const first = mine;
    expect(first.deletedRemotely, "the new device deleted a note on the server").toBe(0);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 60));
      mine = await mac.c.settle();
    }

    // Not blocked, not skipped, not retrying: the name is one name.
    expect(
      { blocked: mine.blocked, skipped: mine.skipped, retrying: mine.retrying },
      `the mac is stuck: ${JSON.stringify(mine)}`,
    ).toEqual({ blocked: 0, skipped: 0, retrying: 0 });

    // Rule 10: the property is one note on the disk with the text in it, not
    // a quiet report over two files nobody can tell apart.
    expect(await held(mac.dir)).toEqual({ [NFC]: "written by the old client\n" });

    // And the vault the next device pairs into holds one note as well: the
    // correction went up as a rename, so there is one name on the server.
    const next = await memoryDevice("next");
    let theirs = await next.c.settle();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 60));
      theirs = await next.c.settle();
    }
    expect(
      { blocked: theirs.blocked, skipped: theirs.skipped },
      `the next device is stuck: ${JSON.stringify(theirs)}`,
    ).toEqual({ blocked: 0, skipped: 0 });
    expect(next.vault.snapshot()).toEqual({ [NFC]: "written by the old client\n" });
  }, 120_000);

  it("carries an edit made here back to the name the vault already had", async () => {
    server = new TestServer();
    await server.start();
    const old = await memoryDevice("old");
    await old.vault.edit(NFD, "first\n");
    await old.c.settle();
    old.c.close();

    const mac = await diskDevice("mac");
    await mac.c.settle();

    // Through the name the disk actually has, which is the whole of what "an
    // edit made here" means.
    //
    // It used to write the NFD spelling literally, and that is two different
    // scenarios on two filesystems: on APFS it lands on the file already
    // there and is an edit; on ext4 it creates a second file, which is not an
    // edit and not what this test is named after. The Linux run then failed
    // on a vault holding two files, having never performed the edit it meant
    // to. A test that asserts different things on different platforms is not
    // evidence on either (R9). Two files that really do differ only by normal
    // form have their own tests, over a disk that keeps them apart on any
    // machine (cli/vault-spelling.test.ts).
    const spelled = await onDiskName(mac.dir, NFC);
    await writeFile(join(mac.dir, spelled), "second\n");
    const mine = await mac.c.settle();
    expect(mine.blocked).toBe(0);
    expect(await held(mac.dir), "the edit made a second file").toEqual({ [NFC]: "second\n" });

    const next = await memoryDevice("next");
    let theirs = await next.c.settle();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 60));
      theirs = await next.c.settle();
    }
    expect(theirs.blocked, `blocked: ${JSON.stringify(theirs.inTheWay)}`).toBe(0);
    expect(next.vault.snapshot()).toEqual({ [NFC]: "second\n" });
  }, 120_000);
});
