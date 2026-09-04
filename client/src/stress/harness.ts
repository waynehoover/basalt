/**
 * Shared parts for the stress suite.
 *
 * Separate from the unit tests because these are slow and hostile on purpose:
 * they kill processes, build vaults of hundreds of notes, and let two devices
 * disagree. `npm test` should stay fast enough that people run it; this should
 * stay nasty enough that it finds things.
 */

import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "../core/client.ts";
import { testWrapped } from "../core/test-keys.ts";
import { removeTree, TestServer } from "../core/test-server.ts";
import { JsonIndexStore, NodeVault } from "../cli/vault.ts";

export const enc = new TextEncoder();

/** One root for the whole suite: these tests are not about key derivation. */
export const SUITE_SECRET = new Uint8Array(32).fill(23);

export interface Device {
  readonly c: Client;
  readonly dir: string;
}

/** A device on its own directory, connected. */
export async function device(
  server: TestServer,
  name: string,
  dirs: string[],
  open: Client[],
): Promise<Device> {
  const dir = await mkdtemp(join(tmpdir(), `basalt-stress-${name}-`));
  dirs.push(dir);
  return reopen(server, name, dir, open);
}

/**
 * The same device again, as a new process would find it.
 *
 * A killed client does not resume; it starts over against the directory it
 * left behind, with whatever its index last managed to write. Reconnecting the
 * old object would test a reconnection nobody performs.
 */
export async function reopen(
  server: TestServer,
  name: string,
  dir: string,
  open: Client[],
): Promise<Device> {
  const c = new Client({
    vault: new NodeVault(dir),
    store: new JsonIndexStore(join(dir, ".basalt", "index.json")),
    url: server.wsUrl,
    ...(await server.deviceCredentials(SUITE_SECRET, await testWrapped(SUITE_SECRET), name)),
    vaultId: "default",
    device: name,
    timeoutMs: 120_000,
    coalesceWrites: false,
  });
  open.push(c);
  await c.connect();
  return { c, dir };
}

/**
 * Notes with distinct prose, so nothing deduplicates by accident.
 *
 * The first generator here cycled a dozen words and every note was nearly
 * every other note, which made cross-file deduplication look like it saved
 * eighty per cent. It was measuring the generator.
 */
export async function buildVault(dir: string, count: number): Promise<void> {
  let seed = 1;
  const rnd = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
  for (let i = 1; i <= count; i++) {
    const path = join(dir, `folder${i % 7}`, `note-${i}.md`);
    await mkdir(dirname(path), { recursive: true });
    let body = `# Note ${i}\n\n`;
    for (let line = 0; line < 20; line++) {
      const words: string[] = [];
      for (let w = 0; w < 10; w++) {
        let word = "";
        const len = 3 + (rnd() % 8);
        for (let c = 0; c < len; c++) word += "abcdefghijklmnopqrstuvwxyz"[rnd() % 26];
        words.push(word);
      }
      body += `${words.join(" ")}.\n`;
    }
    await writeFile(path, body);
  }
}

/** Every file's path and hash, for comparing one vault against another. */
export async function fingerprint(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (at: string, prefix: string): Promise<void> => {
    for (const item of await readdir(at, { withFileTypes: true })) {
      if (item.name === ".basalt" || item.name === ".trash") continue;
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(at, item.name), path);
      else {
        // `new Uint8Array(...)`, and neither `.buffer` nor `.slice()`.
        //
        // readFile hands back a Buffer, which for a small file is a view into
        // a shared pool, so `.buffer` is the pool and an empty file hashes
        // eight kilobytes of its neighbours. `.slice()` does not save it:
        // Buffer overrides slice to mean subarray, so it returns another view
        // of the same pool, which is what made two identical empty files hash
        // differently here. Only the constructor copies.
        //
        // The vault does the same thing for the same reason, and `toBuffer` in
        // crypto.ts is the third place this hazard has had to be handled.
        const bytes = new Uint8Array(await readFile(join(at, item.name)));
        const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
        out.set(path, Buffer.from(digest).toString("hex"));
      }
    }
  };
  await walk(dir, "");
  return out;
}

/** What differs between two vaults, as something an assertion can print. */
export function differences(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, hash] of a) {
    const other = b.get(path);
    if (other === undefined) out.push(`only in the first: ${path}`);
    else if (other !== hash) out.push(`different bytes: ${path}`);
  }
  for (const path of b.keys()) if (!a.has(path)) out.push(`only in the second: ${path}`);
  return out;
}

/** Syncs until nothing changes, or gives up loudly rather than quietly. */
export async function settle(devices: Device[], rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const d of devices) await d.c.settle({}, 16);
  }
}

export async function tidy(open: Client[], dirs: string[], server?: TestServer): Promise<void> {
  while (open.length) open.pop()!.close();
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
}
