/**
 * SPIKE, not shipped. What naming a chunk by an HMAC of its plaintext costs.
 *
 * `bun run bench-chunkid.ts` for the synthetic corpus,
 * `bun run bench-chunkid.ts <vault-path>` to measure a real vault. Read only.
 *
 * The question the brief asks is "HMAC over plaintext is extra work per chunk
 * on every device, measure it". The framing worth checking first is whether it
 * is extra work at all, because the shipped path already hashes once per chunk:
 *
 *   shipped   deflate,  AES-GCM seal,  SHA-256 over the ciphertext   (the name)
 *   spike     deflate,  AES-GCM seal,  HMAC-SHA256 over the plaintext
 *
 * Same number of WebCrypto calls. The name moves from one side of the cipher to
 * the other, and the bytes it runs over change from the sealed size to the
 * plaintext size, which for prose is larger because the seal compressed it.
 *
 * Two things this copies from `bench.ts`, because the first version of that one
 * did neither and reported a 2.7x gain where the honest figure was 1.3x: warm
 * up before timing, and alternate the order of anything being compared.
 *
 * And the same caveat: this is JavaScriptCore under bun. The shipped CLI is
 * node, and the two disagree by an order of magnitude on the chunker.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkBytes, looksLikeText, sizesFor } from "./src/core/chunk.ts";
import { chunkName, deriveSchedule, sealChunk } from "./src/core/crypto.ts";
import { SUITE_V1, chunkId, deriveChunkIdKey, type SpikeSchedule } from "./src/spike/chunkid.ts";
import { sealChunkAs } from "./src/spike/chunkid.ts";
import { SPIKE_DATA_KEY } from "./src/spike/keys.ts";

const enc = new TextEncoder();
const MIB = 1024 * 1024;

const fmt = (n: number) =>
  n < 1024 ? `${n} B` : n < MIB ? `${(n / 1024).toFixed(1)} KiB` : `${(n / MIB).toFixed(1)} MiB`;

/** Prose with enough variety to behave like real text. Same generator as bench.ts. */
function note(bytes: number, seed = 1): Uint8Array {
  let s = seed;
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff);
  let out = "";
  let n = 0;
  while (out.length < bytes) {
    const len = 3 + (rnd() % 9);
    let w = "";
    for (let i = 0; i < len; i++) w += "abcdefghijklmnopqrstuvwxyz"[rnd() % 26];
    out += w;
    out += ++n % 12 === 0 ? ".\n" : n % 60 === 0 ? "\n\n## Section\n\n" : " ";
  }
  return enc.encode(out.slice(0, bytes));
}

async function keys(): Promise<SpikeSchedule> {
  return {
    ...(await deriveSchedule(SPIKE_DATA_KEY)),
    chunkid: await deriveChunkIdKey(SPIKE_DATA_KEY),
  };
}

const med = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1]!;
};

/** Runs two variants alternately, warmed up, and returns their medians. */
async function race(a: () => Promise<void>, b: () => Promise<void>, runs = 5) {
  await a();
  await b();
  const A: number[] = [];
  const B: number[] = [];
  for (let i = 0; i < runs; i++) {
    const first = i % 2 === 0 ? a : b;
    const second = i % 2 === 0 ? b : a;
    let t = performance.now();
    await first();
    (first === a ? A : B).push(performance.now() - t);
    t = performance.now();
    await second();
    (second === a ? A : B).push(performance.now() - t);
  }
  return { a: med(A), b: med(B) };
}

function row(label: string, ms: number, bytes: number, chunks: number) {
  const rate = bytes / MIB / (ms / 1000);
  console.log(
    `  ${label.padEnd(38)} ${rate.toFixed(0).padStart(5)} MiB/s  ${ms.toFixed(1).padStart(7)} ms  ` +
      `${((ms * 1000) / chunks).toFixed(1).padStart(6)} us/chunk`,
  );
}

/**
 * The whole write path, both ways, over one file's chunks at a time.
 *
 * A file at a time is what `sealChunks` does and why: the promises overlap, so
 * the latency of a WebCrypto call stops dominating, and peak memory stays
 * bounded by one file's ciphertext.
 */
async function writePath(k: SpikeSchedule, parts: Uint8Array[][]) {
  const chunks = parts.reduce((n, f) => n + f.length, 0);
  const bytes = parts.reduce((n, f) => n + f.reduce((m, c) => m + c.length, 0), 0);

  const shipped = async () => {
    for (const file of parts) {
      await Promise.all(
        file.map(async (c) => {
          const body = await sealChunk(k, c);
          return { name: await chunkName(body), body };
        }),
      );
    }
  };
  const spike = async () => {
    for (const file of parts) {
      await Promise.all(
        file.map(async (c) => {
          const [name, body] = await Promise.all([
            chunkId(k.chunkid, c),
            sealChunkAs(k, c, { suite: SUITE_V1, level: 6 }),
          ]);
          return { name, body };
        }),
      );
    }
  };

  const r = await race(shipped, spike);
  row("shipped: seal then sha256(ciphertext)", r.a, bytes, chunks);
  row("spike:   seal and hmac(plaintext)", r.b, bytes, chunks);
  console.log(
    `  ${"difference".padEnd(38)} ${(((r.b - r.a) / r.a) * 100).toFixed(1).padStart(5)} %      ` +
      `${(((r.b - r.a) * 1000) / chunks).toFixed(2)} us/chunk`,
  );
  return { chunks, bytes, shipped: r.a, spike: r.b };
}

/** The naming call on its own, with everything else taken away. */
async function namingAlone(k: SpikeSchedule, parts: Uint8Array[]) {
  const bodies = await Promise.all(parts.map((c) => sealChunk(k, c)));
  const plainBytes = parts.reduce((n, c) => n + c.length, 0);
  const sealedBytes = bodies.reduce((n, b) => n + b.length, 0);

  const shipped = async () => {
    await Promise.all(bodies.map((b) => chunkName(b)));
  };
  const spike = async () => {
    await Promise.all(parts.map((c) => chunkId(k.chunkid, c)));
  };
  const r = await race(shipped, spike);

  console.log(
    `\n  naming alone, ${parts.length} chunks: ${fmt(plainBytes)} of plaintext, ` +
      `${fmt(sealedBytes)} of ciphertext`,
  );
  row("sha256 over the ciphertext", r.a, sealedBytes, parts.length);
  row("hmac-sha256 over the plaintext", r.b, plainBytes, parts.length);
  console.log(
    `  ${"difference".padEnd(38)} ${(((r.b - r.a) / r.a) * 100).toFixed(1).padStart(5)} %      ` +
      `${(((r.b - r.a) * 1000) / parts.length).toFixed(2)} us/chunk`,
  );
}

/**
 * The read path. Today the transport hashes each arriving frame and compares it
 * to the name it asked for; under the spike that check needs the key, so it
 * moves behind the decryption and runs over the plaintext instead.
 */
async function readPath(k: SpikeSchedule, parts: Uint8Array[]) {
  const bodies = await Promise.all(parts.map((c) => sealChunk(k, c)));
  const names = await Promise.all(bodies.map((b) => chunkName(b)));
  const ids = await Promise.all(parts.map((c) => chunkId(k.chunkid, c)));
  const { openChunk } = await import("./src/core/crypto.ts");
  const vaultKeys = { ...k } as never;

  const shipped = async () => {
    // Frame check in the transport, then open in the engine.
    const checks = bodies.map((b, i) =>
      chunkName(b).then((h) => {
        if (h !== names[i]) throw new Error("bad frame");
      }),
    );
    const opened = await Promise.all(bodies.map((b) => openChunk(vaultKeys, b)));
    await Promise.all(checks);
    return opened.length;
  };
  const spike = async () => {
    // No frame check is possible; the name is checked after opening.
    const opened = await Promise.all(bodies.map((b) => openChunk(vaultKeys, b)));
    await Promise.all(
      opened.map((p, i) =>
        chunkId(k.chunkid, p).then((h) => {
          if (h !== ids[i]) throw new Error("bad chunk");
        }),
      ),
    );
    return opened.length;
  };

  const r = await race(shipped, spike);
  const bytes = parts.reduce((n, c) => n + c.length, 0);
  console.log(`\n  read path, ${parts.length} chunks`);
  row("shipped: hash frame, then open", r.a, bytes, parts.length);
  row("spike:   open, then hmac plaintext", r.b, bytes, parts.length);
  console.log(
    `  ${"difference".padEnd(38)} ${(((r.b - r.a) / r.a) * 100).toFixed(1).padStart(5)} %      ` +
      `${(((r.b - r.a) * 1000) / parts.length).toFixed(2)} us/chunk`,
  );
}

async function synthetic() {
  const k = await keys();
  // A vault shape rather than one file: many small notes, some medium, a few
  // large. `sizesFor` picks a different chunk target for each, which is what
  // makes the per-chunk figures representative.
  const files: Uint8Array[] = [];
  for (let i = 0; i < 300; i++) files.push(note(2000 + ((i * 977) % 6000), i + 1));
  for (let i = 0; i < 40; i++) files.push(note(40_000 + ((i * 7919) % 60_000), 1000 + i));
  for (let i = 0; i < 4; i++) files.push(note(900_000, 5000 + i));

  const parts = files.map((f) =>
    [...chunkBytes(f, sizesFor(f.length, true), true)].map((c) => c.bytes),
  );
  const chunks = parts.reduce((n, f) => n + f.length, 0);
  const bytes = files.reduce((n, f) => n + f.length, 0);

  console.log(`\nsynthetic vault: ${files.length} notes, ${fmt(bytes)}, ${chunks} chunks`);
  console.log("\nthe write path, a file's chunks at a time");
  await writePath(k, parts);
  await namingAlone(k, parts.flat().slice(0, 4000));
  await readPath(k, parts.flat().slice(0, 4000));
}

async function realVault(path: string) {
  const SKIP = new Set([".obsidian", ".trash", ".git", "node_modules"]);
  const files: { path: string; data: Uint8Array }[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const data = new Uint8Array(await readFile(p));
        if (data.length) files.push({ path: p.slice(path.length + 1), data });
      }
    }
  };
  await walk(path);

  const k = await keys();
  const plain = files.reduce((n, f) => n + f.data.length, 0);
  const parts = files.map((f) => {
    const isText = looksLikeText(f.path);
    return [...chunkBytes(f.data, sizesFor(f.data.length, isText), isText)].map((c) => c.bytes);
  });
  const chunks = parts.reduce((n, f) => n + f.length, 0);
  console.log(`\nreal vault: ${files.length} files, ${fmt(plain)}, ${chunks} chunks`);
  console.log("\nthe write path, a file's chunks at a time");
  const r = await writePath(k, parts);
  console.log(
    `\n  a first sync of this vault: ${(r.shipped / 1000).toFixed(2)} s shipped, ` +
      `${(r.spike / 1000).toFixed(2)} s spike, ` +
      `${((r.spike - r.shipped) / 1000).toFixed(3)} s of difference`,
  );
}

/**
 * A corpus the shape of the real vault in `docs/compared.md`: 3,751 files and
 * 91 MB, which that run turned into 11,307 chunks at 69% of the plaintext.
 *
 * Reconstructed rather than read, because the real vault is not in this
 * repository. The two numbers it is fitted to are the file count and the chunk
 * count, and the chunk count is the one that matters here, because the cost
 * being measured is per chunk. Half the attachments are incompressible, which
 * is the shape `compared.md` describes and is what exercises the raw path.
 */
function vaultShaped() {
  const files: { path: string; data: Uint8Array }[] = [];
  // ~3,600 notes, averaging about 5 KB, which is where most chunks come from.
  for (let i = 0; i < 3600; i++) {
    files.push({ path: `notes/n${i}.md`, data: note(700 + ((i * 2711) % 4600), i + 1) });
  }
  // ~150 attachments carrying most of the bytes, half of them incompressible.
  for (let i = 0; i < 151; i++) {
    const size = 180_000 + ((i * 104_729) % 720_000);
    if (i % 2 === 0) {
      const b = new Uint8Array(size);
      let x = 0x9e3779b9 ^ i;
      for (let j = 0; j < size; j++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        b[j] = x & 0xff;
      }
      files.push({ path: `attach/a${i}.png`, data: b });
    } else {
      files.push({ path: `attach/a${i}.txt`, data: note(size, 9000 + i) });
    }
  }
  return files;
}

async function firstSync() {
  const k = await keys();
  const files = vaultShaped();
  const plain = files.reduce((n, f) => n + f.data.length, 0);
  const parts = files.map((f) => {
    const isText = looksLikeText(f.path);
    return [...chunkBytes(f.data, sizesFor(f.data.length, isText), isText)].map((c) => c.bytes);
  });
  const chunks = parts.reduce((n, f) => n + f.length, 0);
  console.log(
    `\na corpus the shape of compared.md's real vault: ${files.length} files, ` +
      `${fmt(plain)}, ${chunks} chunks`,
  );
  console.log("  (that run: 3,751 files, 91 MB, 11,307 chunks, 54 s on loopback)");
  console.log("\nthe write path, a file's chunks at a time");
  const r = await writePath(k, parts);
  console.log(
    `\n  chunk, compress, seal and name the whole vault: ` +
      `${(r.shipped / 1000).toFixed(2)} s shipped, ${(r.spike / 1000).toFixed(2)} s spike`,
  );
  console.log(
    `  the difference over a first sync: ${((r.spike - r.shipped) / 1000).toFixed(3)} s, ` +
      `against the 54 s that sync took`,
  );
}

console.log("spike: what an HMAC name costs against a hash-of-ciphertext name");
await synthetic();
await firstSync();
if (process.argv[2]) await realVault(process.argv[2]);
