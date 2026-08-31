/**
 * A path that is a file on one device and a folder on another.
 *
 * Uncommon, and entirely possible with extensionless names: one device has a
 * note called `notes`, another makes a folder called `notes`. The in-memory
 * vault cannot show what happens, because its mkdir is a set insert and never
 * fails. A real filesystem refuses, and what the engine does with that refusal
 * is the question.
 */

import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { authToken, deriveKeys, type VaultKeys } from "../core/crypto.ts";
import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { JsonIndexStore, NodeVault } from "./vault.ts";

let keys: VaultKeys;
beforeAll(async () => {
  await serverBinary();
  keys = await deriveKeys(new Uint8Array(20).fill(11));
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

async function device(name: string): Promise<{ c: Client; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `basalt-clash-${name}-`));
  dirs.push(dir);
  const c = new Client({
    vault: new NodeVault(dir),
    store: new JsonIndexStore(join(dir, ".basalt", "index.json")),
    keys,
    url: server.wsUrl,
    ...server.credentials(authToken(keys)),
    vaultId: "default",
    device: name,
    timeoutMs: 20_000,
    coalesceWrites: false,
  });
  open.push(c);
  await c.connect();
  return { c, dir };
}

/** Everything in the vault, so an assertion can say where a note ended up. */
async function contents(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (at: string, prefix: string): Promise<void> => {
    for (const item of await readdir(at, { withFileTypes: true })) {
      if (item.name === ".basalt") continue;
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        out.push(`${path}/`);
        await walk(join(at, item.name), path);
      } else {
        out.push(`${path}: ${(await readFile(join(at, item.name), "utf8")).trim()}`);
      }
    }
  };
  await walk(dir, "");
  return out.sort().join(" | ");
}

/**
 * Whether this filesystem folds case, asked rather than assumed.
 *
 * macOS and Windows do by default and Linux does not, and the test below is
 * only meaningful where it does. Skipping is honest; asserting case-sensitive
 * behaviour on a case-folding machine, or the reverse, is not.
 */
async function foldsCase(dir: string): Promise<boolean> {
  await writeFile(join(dir, "CaseProbe.tmp"), "probe");
  try {
    await stat(join(dir, "caseprobe.tmp"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(join(dir, "CaseProbe.tmp"), { force: true });
  }
}

describe("a rename that changes only case", () => {
  /**
   * The note went missing on the receiving device, and the server agreed.
   *
   * One device renames `Note.md` to `NOTE.md`. The other is told to write the
   * new name and delete the old, and deletions are applied after writes so a
   * move can be served from bytes already on disk. On a filesystem that folds
   * case those are one file: it wrote the note and then deleted it, then
   * reported the deletion, and the server marked the note gone. The device
   * that still had it was told so on its next pass.
   */
  it("does not delete the file it has just written", async () => {
    server = new TestServer();
    await server.start();
    const a = await device("a");
    const b = await device("b");
    if (!(await foldsCase(b.dir))) {
      // Nothing to prove here: two names, two files, and the delete is right.
      return;
    }

    await writeFile(join(a.dir, "Note.md"), "the only copy of this text\n");
    await a.c.settle({}, 8);
    await b.c.settle({}, 8);
    expect(await contents(b.dir)).toContain("Note.md: the only copy of this text");

    await rename(join(a.dir, "Note.md"), join(a.dir, "NOTE.md"));
    await a.c.settle({}, 8);
    await b.c.settle({}, 8);
    await a.c.settle({}, 8);

    // The property is the text, not the spelling. Which case each device shows
    // is the filesystem's business; that the note is readable is not.
    const onB = await contents(b.dir);
    expect(onB, `b holds: ${onB}`).toContain("the only copy of this text");
    const onA = await contents(a.dir);
    expect(onA, `a holds: ${onA}`).toContain("the only copy of this text");

    // Both devices spell it the way the rename asked for. Getting the bytes
    // right and the name wrong is not enough: the next scan would call the new
    // name missing and report a deletion nobody made.
    expect(onB).toContain("NOTE.md:");
    expect(onA).toContain("NOTE.md:");

    // The old name is deleted, which is what a rename is. The new one must not
    // be: b reporting that deletion is how the note disappeared everywhere, so
    // this is the assertion that actually pins the bug.
    const deleted = await b.c.deleted();
    const names = deleted.notes.map((n) => n.path);
    expect(names, `the server thinks these are deleted: ${names.join(", ")}`).not.toContain(
      "NOTE.md",
    );
    expect(names).toContain("Note.md");

    // And it holds after another pass each way, which is where it went wrong
    // before: the first pass looked right and the second reported the loss.
    await b.c.settle({}, 8);
    await a.c.settle({}, 8);
    expect(await contents(a.dir)).toContain("the only copy of this text");
    expect(await contents(b.dir)).toContain("the only copy of this text");
    const later = (await b.c.deleted()).notes.map((n) => n.path);
    expect(later, `after settling: ${later.join(", ")}`).not.toContain("NOTE.md");
  }, 60_000);
});

describe("a path that is a file here and a folder there", () => {
  it("keeps the note and settles on something", async () => {
    server = new TestServer();
    await server.start();
    const a = await device("a");
    const b = await device("b");

    // A has a note called `notes`. B makes a folder of the same name.
    //
    // Both decide locally before either syncs, for the reason the other two
    // tests here say: settling A first pushes `notes` to B over its live
    // connection, and then this mkdir lands on an existing file and throws
    // EEXIST. The disagreement never gets built, and whether that happens
    // is a race, so it passed here and failed on CI.
    const { writeFile, mkdir } = await import("node:fs/promises");
    await writeFile(join(a.dir, "notes"), "a file, not a folder\n");
    await mkdir(join(b.dir, "notes"));
    await writeFile(join(b.dir, "notes", "inside.md"), "in the folder\n");

    await a.c.settle();
    await b.c.settle();

    for (let i = 0; i < 5; i++) {
      await a.c.settle();
      await new Promise((r) => setTimeout(r, 60));
      await b.c.settle();
    }

    const reportA = await a.c.settle();
    const reportB = await b.c.settle();
    const held = await contents(a.dir);

    // Rule 1. Whatever was decided, the note A wrote is still there and
    // nothing renamed it to make room.
    expect(held, `A holds ${held}`).toContain("a file, not a folder");
    expect((await stat(join(a.dir, "notes"))).isFile()).toBe(true);

    // Neither device retries the impossible, and both say what is wrong
    // rather than going quiet about it.
    expect(reportA.retrying, `A: ${JSON.stringify(reportA)}`).toBe(0);
    expect(reportB.retrying, `B: ${JSON.stringify(reportB)}`).toBe(0);
    expect(
      reportA.skipped + reportA.blocked + reportB.skipped + reportB.blocked,
      `neither device reported the disagreement: A ${JSON.stringify(reportA)} B ${JSON.stringify(reportB)}`,
    ).toBeGreaterThan(0);
  }, 300_000);

  /**
   * The same disagreement seen from the other side, which used to be worse:
   * "folder exists on both sides" was returned for a folder here and a file
   * there, so the file was never downloaded and nothing said why.
   */
  it("does not silently ignore a file it cannot make room for", async () => {
    server = new TestServer();
    await server.start();
    const a = await device("a");
    const b = await device("b");

    const { writeFile, mkdir } = await import("node:fs/promises");
    // A has a folder called `notes`; B has a note of the same name.
    //
    // Both decide locally before either syncs. Settling A first pushes the
    // folder to B over its live connection, and then this writeFile lands on
    // a directory and throws EISDIR: the disagreement being tested never
    // gets set up. It failed that way on CI while passing here, because it
    // only needs B to win the race.
    await mkdir(join(a.dir, "notes"));
    await writeFile(join(a.dir, "notes", "inside.md"), "in the folder\n");
    await writeFile(join(b.dir, "notes"), "a file, not a folder\n");

    await a.c.settle();
    await b.c.settle();

    for (let i = 0; i < 5; i++) {
      await a.c.settle();
      await new Promise((r) => setTimeout(r, 60));
      await b.c.settle();
    }

    const reportA = await a.c.settle();
    const reportB = await b.c.settle();
    const held = await contents(a.dir);
    expect(held, `A holds ${held}`).toContain("notes/inside.md");
    expect((await stat(join(a.dir, "notes"))).isDirectory()).toBe(true);
    // B is the one that cannot have both, and it says so rather than
    // passing over the folder in silence, which is what it used to do.
    // Counted apart, because they are different things to be told. One
    // path can never work until somebody renames something, and one is
    // simply waiting on a name that is in the way.
    expect(
      { skipped: reportB.skipped, blocked: reportB.blocked },
      `B passed it over: ${JSON.stringify(reportB)} (A: ${JSON.stringify(reportA)})`,
    ).toEqual({ skipped: 1, blocked: 1 });
  }, 300_000);

  /** And once somebody renames one of them, it syncs like anything else. */
  it("syncs once the disagreement is resolved", async () => {
    server = new TestServer();
    await server.start();
    const a = await device("a");
    const b = await device("b");

    const { writeFile, mkdir, rename } = await import("node:fs/promises");
    // Both sides local first, for the reason above. This one raced the
    // other way and threw EEXIST on the mkdir.
    await writeFile(join(a.dir, "notes"), "a file, not a folder\n");
    await mkdir(join(b.dir, "notes"));
    await writeFile(join(b.dir, "notes", "inside.md"), "in the folder\n");

    await a.c.settle();
    await b.c.settle();
    for (let i = 0; i < 4; i++) {
      await a.c.settle();
      await b.c.settle();
    }
    // A renames its note out of the way, which is what it was told to do.
    await rename(join(a.dir, "notes"), join(a.dir, "notes.md"));
    for (let i = 0; i < 5; i++) {
      await a.c.settle();
      await new Promise((r) => setTimeout(r, 60));
      await b.c.settle();
    }

    const held = await contents(a.dir);
    expect(held, `A holds ${held}`).toContain("notes/inside.md");
    expect(held, `A holds ${held}`).toContain("a file, not a folder");
    const settled = await a.c.settle();
    expect(
      { skipped: settled.skipped, blocked: settled.blocked },
      "still refusing after the rename",
    ).toEqual({ skipped: 0, blocked: 0 });
  }, 300_000);
});

/**
 * A folder moved while another device was away.
 *
 * Reported against Fast Note Sync as issue 257: an offline device receiving a
 * directory move raised ENOENT from several nested deletions at once. The shape
 * is worth having whatever the cause was there, because it is the ordinary way
 * somebody reorganises a vault and the device that was asleep gets all of it in
 * one batch.
 */
describe("a folder reorganised while a device was away", () => {
  it("arrives whole, with nothing left behind", async () => {
    server = new TestServer();
    await server.start();
    const a = await device("a");
    const b = await device("b");

    const { writeFile, mkdir, rename } = await import("node:fs/promises");
    await mkdir(join(a.dir, "Projects", "2025", "Q1"), { recursive: true });
    for (const name of ["one.md", "two.md", "three.md"]) {
      await writeFile(join(a.dir, "Projects", "2025", "Q1", name), `note ${name}\n`);
    }
    await writeFile(join(a.dir, "Projects", "2025", "summary.md"), "the summary\n");
    await a.c.settle();
    await b.c.settle();
    expect((await contents(b.dir)).includes("Projects/2025/Q1/one.md")).toBe(true);

    // B goes away, and A reorganises three levels at once.
    b.c.close();
    await mkdir(join(a.dir, "Archive"), { recursive: true });
    await rename(join(a.dir, "Projects", "2025"), join(a.dir, "Archive", "2025"));
    await a.c.settle({}, 12);

    // B comes back to all of it in one batch.
    const b2 = await device("b2");
    await b2.c.settle({}, 12);

    const held = await contents(b2.dir);
    expect(held, `B holds ${held}`).toContain("Archive/2025/Q1/one.md");
    expect(held, `B holds ${held}`).toContain("Archive/2025/summary.md");
    // And nothing of the old arrangement is left as a live file.
    expect(held, `B holds ${held}`).not.toContain("Projects/2025/Q1/one.md: note one.md");

    const report = await b2.c.settle();
    expect(
      { retrying: report.retrying, skipped: report.skipped },
      `B is still working through it: ${JSON.stringify(report)}`,
    ).toEqual({ retrying: 0, skipped: 0 });
  }, 300_000);
});
