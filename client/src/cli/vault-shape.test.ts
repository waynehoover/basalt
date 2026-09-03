/**
 * A vault shaped like somebody's actual vault.
 *
 * Every other test here uses a handful of files chosen to exercise one thing.
 * This one is the whole shape at once, borrowed from Sync Engine's benchmark
 * harness, which builds 1880 small notes, 100 medium files and 20 large ones
 * across folders up to six deep. That distribution is the useful part and it is
 * not what this project was testing against.
 *
 * Scaled down so it runs in a suite rather than a benchmark, and with one
 * change that matters: half the large files are incompressible. Their generator
 * writes prose, and prose is what hid the chunk-ceiling defect here for months,
 * because deflate made the sealed chunk smaller than the plaintext and the
 * overhead vanished into the saving.
 */

import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { authToken, type VaultKeys } from "../core/crypto.ts";
import { testKeys, testWrapped } from "../core/test-keys.ts";
import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { JsonIndexStore, NodeVault } from "./vault.ts";

const SECRET = new Uint8Array(32).fill(23);
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

async function device(name: string): Promise<{ c: Client; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `basalt-shape-${name}-`));
  dirs.push(dir);
  const c = new Client({
    vault: new NodeVault(dir),
    store: new JsonIndexStore(join(dir, ".basalt", "index.json")),
    secret: SECRET,
    url: server.wsUrl,
    ...server.credentials(authToken(keys), wrapped),
    vaultId: "default",
    device: name,
    timeoutMs: 60_000,
    coalesceWrites: false,
  });
  open.push(c);
  await c.connect();
  return { c, dir };
}

/* ---------------------------------------------------------------- *
 * The vault
 * ---------------------------------------------------------------- */

// Their folder names, because the shape of a real vault is folders like these
// rather than dir1/dir2, and because path length and depth are what a sync gets
// wrong.
const FOLDER_LEVELS = [
  [
    "Daily Notes",
    "Projects",
    "Areas",
    "Resources",
    "Work",
    "Personal",
    "Ideas",
    "Reference",
    "Archive",
  ],
  ["2024", "2025", "2026", "Current", "Backlog", "Inbox"],
  ["Inbox", "Ideas", "Weekly", "Monthly", "Research", "Notes", "Planning", "Tasks"],
  ["Q1", "Q2", "Q3", "Q4", "Design", "Engineering"],
  ["Active", "Archived", "Drafts", "Review"],
  ["Personal", "Technical", "Client", "Internal"],
];

/** Deterministic, so a failure is the same failure when it is looked at again. */
function pathFor(kind: string, index: number, ext: string): string {
  const depth = (index + kind.length) % (FOLDER_LEVELS.length + 1);
  const folders = Array.from({ length: depth }, (_, level) => {
    const choices = FOLDER_LEVELS[level]!;
    return choices[(index * 7919 + kind.length * 104_729 + level * 97) % choices.length]!;
  });
  const number = String(index + 1).padStart(4, "0");
  return `${folders.length > 0 ? `${folders.join("/")}/` : ""}${kind}-${number}.${ext}`;
}

function sizeFor(index: number, min: number, max: number): number {
  return min + ((index * 7919) % (max - min + 1));
}

/** Prose, which compresses, and is what a note is. */
function prose(bytes: number, seed: number): string {
  const words = "the quick brown fox jumps over a lazy dog while nobody is watching it".split(" ");
  let out = "";
  let i = seed;
  while (out.length < bytes) out += words[i++ % words.length] + (i % 11 === 0 ? "\n" : " ");
  return out.slice(0, bytes);
}

/** Bytes that do not compress, which is what an attachment is. */
function noise(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let at = 0; at < out.length; at += 65536) {
    crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, out.length)));
  }
  return out;
}

/**
 * Writes the vault and returns what is in it.
 *
 * The counts are Sync Engine's proportions divided by ten and the sizes divided
 * by roughly the same, so the shape survives and the suite still finishes.
 */
async function buildVault(dir: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const write = async (path: string, body: Uint8Array | string) => {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
    sizes.set(path, typeof body === "string" ? Buffer.byteLength(body) : body.length);
  };

  for (let i = 0; i < 188; i++) {
    await write(pathFor("small", i, "md"), prose(sizeFor(i, 50, 8 * 1024), i));
  }
  for (let i = 0; i < 10; i++) {
    await write(pathFor("medium", i, "md"), prose(sizeFor(i, 64 * 1024, 256 * 1024), i));
  }
  // Half incompressible, which is the change from their generator and the
  // thing that would have caught the chunk-ceiling defect on the first run.
  for (let i = 0; i < 4; i++) {
    const size = sizeFor(i, 1024 * 1024, 3 * 1024 * 1024);
    if (i % 2 === 0) await write(pathFor("large", i, "bin"), noise(size));
    else await write(pathFor("large", i, "md"), prose(size, i));
  }
  return sizes;
}

/** Everything in a vault, by path, with a hash of its bytes. */
async function contentsOf(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (at: string, prefix: string): Promise<void> => {
    for (const item of await readdir(at, { withFileTypes: true })) {
      if (item.name === ".basalt" || item.name === ".trash") continue;
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(at, item.name), path);
      else {
        const body = await readFile(join(at, item.name));
        const digest = await crypto.subtle.digest("SHA-256", body.slice().buffer as ArrayBuffer);
        out.set(path, Buffer.from(digest).toString("hex"));
      }
    }
  };
  await walk(dir, "");
  return out;
}

describe("a vault shaped like a real one", () => {
  it("arrives on the other device, every file of it", async () => {
    server = new TestServer();
    await server.start();
    const a = await device("a");
    const b = await device("b");

    const written = await buildVault(a.dir);
    expect(written.size).toBe(202);

    const sent = await a.c.settle({}, 24);
    expect(sent.skipped, `files were written off: ${JSON.stringify(sent)}`).toBe(0);
    expect(sent.retrying, `files were left retrying: ${JSON.stringify(sent)}`).toBe(0);

    await b.c.settle({}, 24);

    const before = await contentsOf(a.dir);
    const after = await contentsOf(b.dir);
    expect(after.size, `${before.size} files were sent and ${after.size} arrived`).toBe(
      before.size,
    );
    for (const [path, digest] of before) {
      expect(after.get(path), `${path} did not arrive intact`).toBe(digest);
    }
  }, 600_000);

  /**
   * The second sync of an unchanged vault should cost nothing. A pass that
   * re-uploads what is already there is the failure that makes a sync client
   * unusable on a large vault, and it does not show up on three files.
   */
  it("costs nothing to sync a vault that has not changed", async () => {
    server = new TestServer();
    await server.start();
    const a = await device("a");
    await buildVault(a.dir);
    await a.c.settle({}, 24);

    const again = await a.c.settle({}, 4);
    expect(
      { uploaded: again.uploaded, chunksSent: again.chunksSent, bytesSent: again.bytesSent },
      `a settled vault re-sent something: ${JSON.stringify(again)}`,
    ).toEqual({ uploaded: 0, chunksSent: 0, bytesSent: 0 });
  }, 600_000);
});
