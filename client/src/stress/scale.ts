/**
 * What a 10,000 note vault costs, and where the cost sits.
 *
 * Not a speed benchmark. The question is whether the chunking and dedup design
 * still makes sense at that size: how much of the upload is chunk names rather
 * than content, how much deduplication actually saves on distinct prose, and
 * what the local index grows to.
 */
import { mkdtemp, mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "../core/client.ts";
import { authToken, deriveKeys, sealChunks } from "../core/crypto.ts";
import { chunkBytes, sizesFor } from "../core/chunk.ts";
import { TestServer } from "../core/test-server.ts";
import { JsonIndexStore, NodeVault } from "../cli/vault.ts";

const COUNT = Number(process.env["NOTES"] ?? 10000);
const enc = new TextEncoder();

/** Distinct prose. A generator that repeats itself measures the generator. */
function note(i: number): string {
  let seed = i * 2654435761;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
  const words = [
    "meeting",
    "design",
    "protocol",
    "because",
    "however",
    "perhaps",
    "chunk",
    "server",
    "vault",
    "content",
    "decision",
    "measure",
    "boundary",
    "identity",
    "release",
    "review",
    "January",
    "refactor",
    "interface",
    "threshold",
    "migration",
    "observed",
    "argument",
  ];
  let out = `# Note ${i}\n\n`;
  const paras = 2 + (rnd() % 6);
  for (let p = 0; p < paras; p++) {
    const lines = 2 + (rnd() % 5);
    for (let l = 0; l < lines; l++) {
      const n = 8 + (rnd() % 12);
      const parts: string[] = [];
      for (let w = 0; w < n; w++)
        parts.push(words[rnd() % words.length]! + (rnd() % 7 === 0 ? `-${rnd() % 9999}` : ""));
      out += parts.join(" ") + ".\n";
    }
    out += "\n";
  }
  return out;
}

const dir = await mkdtemp(join(tmpdir(), "basalt-scale-"));
let plaintext = 0;
for (let i = 1; i <= COUNT; i++) {
  const path = join(dir, `folder${i % 40}`, `note-${i}.md`);
  await mkdir(dirname(path), { recursive: true });
  const body = note(i);
  plaintext += Buffer.byteLength(body);
  await writeFile(path, body);
}
console.log(`${COUNT} notes, ${(plaintext / 1048576).toFixed(1)} MiB of prose`);

// What chunking produces, before any server is involved.
const keys = await deriveKeys(new Uint8Array(20).fill(7));
let chunks = 0;
const names = new Set<string>();
let sealedBytes = 0;
for (let i = 1; i <= COUNT; i++) {
  const bytes = enc.encode(note(i));
  const parts = [...chunkBytes(bytes, sizesFor(bytes.length, true), true)].map((c) => c.bytes);
  chunks += parts.length;
  for (const c of await sealChunks(keys, parts)) {
    names.add(c.name);
    sealedBytes += c.bytes.length;
  }
}
const NAME_ON_WIRE = 67,
  ENTRY_BASE = 356;
const metadata = COUNT * ENTRY_BASE + chunks * NAME_ON_WIRE;
console.log(
  `  chunks           ${chunks} (${(chunks / COUNT).toFixed(2)} per note, avg ${(plaintext / chunks / 1024).toFixed(1)} KiB)`,
);
console.log(
  `  unique chunks    ${names.size}  -> dedup saves ${(100 * (1 - names.size / chunks)).toFixed(2)}%`,
);
console.log(
  `  sealed bodies    ${(sealedBytes / 1048576).toFixed(1)} MiB  (${((100 * sealedBytes) / plaintext).toFixed(0)}% of plaintext)`,
);
console.log(
  `  entry metadata   ${(metadata / 1048576).toFixed(1)} MiB  (${((100 * metadata) / (metadata + sealedBytes)).toFixed(1)}% of the upload)`,
);

const server = new TestServer();
await server.start();
const client = new Client({
  vault: new NodeVault(dir),
  store: new JsonIndexStore(join(dir, ".basalt", "index.json")),
  keys,
  url: server.wsUrl,
  ...server.credentials(authToken(keys)),
  vaultId: "default",
  device: "scale",
  timeoutMs: 600_000,
  coalesceWrites: false,
});
await client.connect();
const t0 = performance.now();
const up = await client.settle({}, 200);
const upMs = performance.now() - t0;
console.log(
  `\nfirst sync         ${(upMs / 1000).toFixed(1)} s, ${up.uploaded} uploaded, ${up.chunksSent} chunks, ${(up.bytesSent / 1048576).toFixed(1)} MiB sent`,
);

const t1 = performance.now();
await client.settle({}, 2);
console.log(`idle pass          ${(performance.now() - t1).toFixed(0)} ms`);
console.log(
  `local index        ${((await stat(join(dir, ".basalt", "index.json"))).size / 1048576).toFixed(1)} MiB`,
);
console.log(
  `server database    ${((await stat(join(server.dataDir, "basalt.db"))).size / 1048576).toFixed(1)} MiB`,
);

// A day's editing.
for (let i = 1; i <= 20; i++) {
  const path = join(dir, `folder${(i * 37) % 40}`, `note-${(i * 37) % COUNT || 1}.md`);
  try {
    await writeFile(path, (await readFile(path, "utf8")) + "\na line added today.\n");
  } catch {}
}
const t2 = performance.now();
const day = await client.settle({}, 8);
console.log(
  `20 notes edited    ${((performance.now() - t2) / 1000).toFixed(2)} s, ${day.chunksSent} chunks, ${(day.bytesSent / 1024).toFixed(1)} KiB`,
);

client.close();
await server.cleanup();
