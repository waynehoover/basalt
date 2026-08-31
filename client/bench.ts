/**
 * Throughput and bandwidth, reported rather than asserted.
 *
 * `bun run bench` for synthetic prose, `bun run bench <vault-path>` to measure a
 * real vault. Read only: it never writes into the vault.
 *
 * This is a script and not a test on purpose. The chunker measures 575 MiB/s
 * under `bun run` and 32 MiB/s under vitest, so a floor loose enough to survive
 * that would catch nothing. The deterministic half of performance, bytes on the
 * wire, is asserted in `src/perf.test.ts` where it belongs.
 *
 * That spread was written down as the runner's doing and it is not. It is the
 * engine: bun is JavaScriptCore and vitest is V8, and the boundary test in
 * `chunk.ts` costs 32 MiB/s on one and 996 MiB/s on the other, because
 * `(hash >>> 0) % avg` is a double modulo and V8 calls out to fmod for it once
 * per byte. Measured here at 252 ms against 8 ms over 8 MiB, same boundaries
 * either way.
 *
 * Which matters more than a benchmark footnote, because the shipped CLI is
 * `#!/usr/bin/env node`. The number this script prints under bun is not the
 * number the thing people install runs at.
 *
 * Two things every measurement here does, because the first version of it did
 * neither and reported a 2.7x gain where the honest figure was 1.3x:
 * warm up before timing, and alternate the order of anything being compared.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BINARY_SIZES,
  TEXT_SIZES,
  chunkBytes,
  looksLikeText,
  sizesFor,
  type ChunkSizes,
} from "./src/core/chunk.ts";
import { chunkName, deriveKeys, sealChunk, sealChunks } from "./src/core/crypto.ts";

const enc = new TextEncoder();
const MIB = 1024 * 1024;

const fmt = (n: number) =>
  n < 1024 ? `${n} B` : n < MIB ? `${(n / 1024).toFixed(1)} KiB` : `${(n / MIB).toFixed(1)} MiB`;

/** Prose with enough variety to behave like real text. */
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

/** Median of several runs, after two warm-up passes. */
function timed(fn: () => void, runs = 5): number {
  fn();
  fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[times.length >> 1]!;
}

function row(label: string, ms: number, bytes: number, extra = "") {
  const rate = bytes / MIB / (ms / 1000);
  console.log(
    `  ${label.padEnd(36)} ${rate.toFixed(0).padStart(5)} MiB/s   ${ms.toFixed(1).padStart(6)} ms  ${extra}`,
  );
}

async function chunking() {
  console.log("\nchunking (pure JavaScript, no crypto)");
  const text = note(2 * MIB);
  let n = 0;
  row(
    "text sizes 128/256/1K",
    timed(() => {
      n = 0;
      for (const _ of chunkBytes(text, TEXT_SIZES, true)) n++;
    }),
    text.length,
    `${n} chunks`,
  );

  const bin = new Uint8Array(8 * MIB);
  for (let i = 0; i < bin.length; i++) bin[i] = (Math.imul(i, 2654435761) >>> 24) & 0xff;
  row(
    "binary sizes 128K/256K/1M",
    timed(() => {
      n = 0;
      for (const _ of chunkBytes(bin, BINARY_SIZES, false)) n++;
    }),
    bin.length,
    `${n} chunks`,
  );
}

async function sealing() {
  console.log("\nsealing: compress, encrypt, name (three WebCrypto calls a chunk)");
  const keys = await deriveKeys(new Uint8Array(20).fill(9));
  const parts = [...chunkBytes(note(512 * 1024), sizesFor(512 * 1024, true), true)].map(
    (c) => c.bytes,
  );
  const bytes = parts.reduce((n, b) => n + b.length, 0);

  const serial = async () => {
    for (const b of parts) await chunkName(await sealChunk(keys, b));
  };
  const parallel = async () => {
    await sealChunks(keys, parts);
  };

  await serial();
  await parallel();

  const S: number[] = [];
  const P: number[] = [];
  for (let i = 0; i < 5; i++) {
    // Alternate, so neither variant always benefits from running second.
    const first = i % 2 === 0 ? serial : parallel;
    const second = i % 2 === 0 ? parallel : serial;
    let t = performance.now();
    await first();
    (first === serial ? S : P).push(performance.now() - t);
    t = performance.now();
    await second();
    (second === serial ? S : P).push(performance.now() - t);
  }
  const med = (a: number[]) => {
    a.sort((x, y) => x - y);
    return a[a.length >> 1]!;
  };
  const s = med(S);
  const p = med(P);
  row("awaiting each chunk", s, bytes, `${((s * 1000) / parts.length).toFixed(0)} us/chunk`);
  row("a file's chunks at once", p, bytes, `${((p * 1000) / parts.length).toFixed(0)} us/chunk`);
  console.log(`  ${"gain from overlapping the latency".padEnd(36)} ${(s / p).toFixed(2)}x`);
}

/** Bytes a client sends to bring the server from `original` to `edited`. */
async function wire(
  original: Uint8Array,
  edited: Uint8Array,
  sizes: ChunkSizes,
  isText: boolean,
  keys: Awaited<ReturnType<typeof deriveKeys>>,
) {
  const held = new Set(
    [...chunkBytes(original, sizes, isText)].map((c) => Buffer.from(c.bytes).toString("base64")),
  );
  const send: Uint8Array[] = [];
  let total = 0;
  for (const c of chunkBytes(edited, sizes, isText)) {
    total++;
    if (!held.has(Buffer.from(c.bytes).toString("base64"))) send.push(c.bytes);
  }
  const sealed = await sealChunks(keys, send);
  return { bytes: sealed.reduce((n, c) => n + c.bytes.length, 0), changed: send.length, total };
}

async function bandwidth() {
  console.log("\nbytes on the wire for one line inserted into a note");
  console.log("  note size    basalt      whole file    ratio    chunks changed");
  const keys = await deriveKeys(new Uint8Array(20).fill(11));
  for (const size of [4096, 32 * 1024, 128 * 1024, 512 * 1024, 2 * MIB]) {
    const original = note(size);
    const ins = enc.encode("A line added by hand.\n");
    const at = original.indexOf(10, Math.floor(size / 3)) + 1;
    const edited = new Uint8Array(original.length + ins.length);
    edited.set(original.subarray(0, at));
    edited.set(ins, at);
    edited.set(original.subarray(at), at + ins.length);

    const r = await wire(original, edited, sizesFor(size, true), true, keys);
    console.log(
      `  ${fmt(size).padStart(9)}  ${fmt(r.bytes).padStart(9)}   ${fmt(edited.length).padStart(9)}` +
        `   ${(edited.length / Math.max(1, r.bytes)).toFixed(0).padStart(6)}x   ${r.changed} of ${r.total}`,
    );
  }
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

  const plain = files.reduce((n, f) => n + f.data.length, 0);
  console.log(`\nreal vault: ${files.length} files, ${fmt(plain)}`);

  const keys = await deriveKeys(new Uint8Array(20).fill(13));
  const started = performance.now();
  let chunks = 0;
  let onWire = 0;
  for (const f of files) {
    const isText = looksLikeText(f.path);
    const parts = [...chunkBytes(f.data, sizesFor(f.data.length, isText), isText)].map(
      (c) => c.bytes,
    );
    chunks += parts.length;
    for (const c of await sealChunks(keys, parts)) onWire += c.bytes.length;
  }
  const seconds = (performance.now() - started) / 1000;

  console.log(
    `  first sync: ${chunks} chunks, ${fmt(onWire)} on the wire ` +
      `(${((onWire / plain) * 100).toFixed(0)}% of the plaintext)`,
  );
  console.log(
    `  took ${seconds.toFixed(1)} s to chunk, compress, encrypt and name the whole vault ` +
      `(${(plain / MIB / seconds).toFixed(0)} MiB/s end to end)`,
  );
}

console.log("basalt: chunking, sealing and bandwidth");
await chunking();
await sealing();
await bandwidth();
if (process.argv[2]) await realVault(process.argv[2]);
