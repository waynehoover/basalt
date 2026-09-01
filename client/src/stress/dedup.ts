/**
 * What deduplication is actually for.
 *
 * Two different questions get the same name. Across *files*, does one note
 * share chunks with another? Across *versions*, does today's note share chunks
 * with yesterday's? The first is what "dedup" sounds like and the second is
 * what pays for the machinery.
 */
import { deriveKeys, sealChunks } from "../core/crypto.ts";
import { chunkBytes, sizesFor } from "../core/chunk.ts";

const enc = new TextEncoder();
const keys = await deriveKeys(new Uint8Array(20).fill(7));

async function namesOf(text: string): Promise<string[]> {
  const bytes = enc.encode(text);
  const parts = [...chunkBytes(bytes, sizesFor(bytes.length, true), true)].map((c) => c.bytes);
  return (await sealChunks(keys, parts)).map((c) => c.name);
}

function prose(seed: number, paras: number): string {
  let s = seed;
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff);
  const w = [
    "meeting",
    "design",
    "protocol",
    "because",
    "however",
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
  ];
  let out = "";
  for (let p = 0; p < paras; p++) {
    for (let l = 0; l < 4; l++) {
      const parts = [];
      for (let i = 0; i < 12; i++) parts.push(w[rnd() % w.length]);
      out += parts.join(" ") + ".\n";
    }
    out += "\n";
  }
  return out;
}

for (const [label, paras] of [
  ["a short note (2 KB)", 4],
  ["a long note (40 KB)", 90],
] as const) {
  // Somebody's week: append a paragraph a day, twenty times.
  let text = prose(1, paras);
  const all: string[] = [];
  const unique = new Set<string>();
  let versions = 0;
  for (let day = 0; day < 20; day++) {
    const names = await namesOf(text);
    versions++;
    for (const n of names) {
      all.push(n);
      unique.add(n);
    }
    text += prose(1000 + day, 1) + "\n";
  }
  const bytes = Buffer.byteLength(text);
  console.log(`\n${label}, ${versions} versions, ending at ${(bytes / 1024).toFixed(1)} KiB`);
  console.log(`  chunk references over all versions  ${all.length}`);
  console.log(`  distinct chunks actually stored     ${unique.size}`);
  console.log(
    `  stored / referenced                 ${((100 * unique.size) / all.length).toFixed(0)}%  -> dedup across versions saves ${(100 * (1 - unique.size / all.length)).toFixed(0)}%`,
  );
}
