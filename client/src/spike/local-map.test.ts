/**
 * SPIKE, not shipped. The alternative that needs no protocol change at all.
 *
 * The problem section 3 names is real: change the deflate level and every chunk
 * seals to different bytes, so every chunk gets a different name, so a note the
 * server already holds uploads again in full the next time it is edited. That
 * is what makes the level immutable in practice.
 *
 * The HMAC naming scheme fixes it by making the name independent of the
 * encoding, at the price of a protocol change, a flag day, and the server's
 * ability to check its own bodies.
 *
 * There is a third option, and this measures it against the other two: keep the
 * wire name exactly as it is, and let each device remember, locally, which name
 * it uploaded a given *plaintext* chunk under. A chunk this device has already
 * sent keeps the name it was sent under, whatever the encoding parameters are
 * today. Nothing new goes on the wire, so nothing new leaks and nothing needs
 * migrating; the digest is a plain SHA-256 because it never leaves the device.
 *
 * Three columns, one question: after the deflate level changes, how much of an
 * edited note does the server have to be sent again?
 */

import { describe, expect, it } from "vitest";
import { chunkBytes, textSizesFor } from "../core/chunk.ts";
import { chunkName } from "../core/crypto.ts";
import { ModelStore, SUITE_V1, chunkId, sealChunkAs } from "./chunkid.ts";
import { spikeKeys } from "./keys.ts";

const enc = new TextEncoder();

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

/** The plaintext digest a device keeps to itself. Never sent, so never a leak. */
const localDigest = (b: Uint8Array) =>
  crypto.subtle.digest("SHA-256", b.slice()).then((d) => Buffer.from(d).toString("hex"));

const SIZE = 256 * 1024;

describe("retuning the deflate level, three ways", () => {
  it("measures what an edited note costs the wire after the change", async () => {
    const keys = await spikeKeys();
    const original = note(SIZE, 3);
    const ins = enc.encode("A line added by hand after the deflate level changed.\n");
    const at = original.indexOf(10, Math.floor(SIZE / 3)) + 1;
    const edited = new Uint8Array(original.length + ins.length);
    edited.set(original.subarray(0, at));
    edited.set(ins, at);
    edited.set(original.subarray(at), at + ins.length);

    const sizes = textSizesFor(SIZE);
    const before = [...chunkBytes(original, sizes, true)].map((c) => c.bytes);
    const after = [...chunkBytes(edited, sizes, true)].map((c) => c.bytes);

    // ---- The vault as it stands: everything uploaded at level 6.
    const shippedStore = new ModelStore();
    const spikeStore = new ModelStore();
    /** The local map the third option adds: plaintext digest -> the name it went up as. */
    const localNames = new Map<string, string>();

    for (const c of before) {
      const body = await sealChunkAs(keys, c, { suite: SUITE_V1, level: 6 });
      const name = await chunkName(body);
      shippedStore.put(name, body);
      localNames.set(await localDigest(c), name);
      spikeStore.put(await chunkId(keys.chunkid, c), body);
    }

    // ---- The level changes to 1, and the note is edited.
    const LEVEL = 1 as const;

    // (a) shipped, no local map: re-seal at the new level and see what the
    //     server lacks.
    let naiveNew = 0;
    let naiveBytes = 0;
    for (const c of after) {
      const body = await sealChunkAs(keys, c, { suite: SUITE_V1, level: LEVEL });
      const name = await chunkName(body);
      if (shippedStore.missing([name]).length) {
        naiveNew++;
        naiveBytes += body.length;
      }
    }

    // (b) shipped, with the local map: a plaintext this device has already sent
    //     keeps the name it was sent under, and is not re-sealed at all.
    let mappedNew = 0;
    let mappedBytes = 0;
    for (const c of after) {
      const known = localNames.get(await localDigest(c));
      if (known !== undefined && !shippedStore.missing([known]).length) continue;
      const body = await sealChunkAs(keys, c, { suite: SUITE_V1, level: LEVEL });
      const name = await chunkName(body);
      if (shippedStore.missing([name]).length) {
        mappedNew++;
        mappedBytes += body.length;
      }
    }

    // (c) the spike: the name never depended on the level in the first place.
    let spikeNew = 0;
    let spikeBytes = 0;
    for (const c of after) {
      const name = await chunkId(keys.chunkid, c);
      if (spikeStore.missing([name]).length) {
        spikeNew++;
        const body = await sealChunkAs(keys, c, { suite: SUITE_V1, level: LEVEL });
        spikeBytes += body.length;
      }
    }

    const fmt = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);
    console.log(`  a ${SIZE / 1024} KiB note, ${after.length} chunks, one line inserted,`);
    console.log("  the deflate level having changed from 6 to 1 in between");
    console.log(
      `    shipped, no local map:  ${String(naiveNew).padStart(4)} chunks, ${fmt(naiveBytes)}`,
    );
    console.log(
      `    shipped + local map:    ${String(mappedNew).padStart(4)} chunks, ${fmt(mappedBytes)}`,
    );
    console.log(
      `    spike, hmac names:      ${String(spikeNew).padStart(4)} chunks, ${fmt(spikeBytes)}`,
    );

    // Without a map, the level change costs essentially the entire note again.
    // Not quite all of it: a chunk the new level happens to compress to the
    // same bytes keeps its name by luck, which is not a property to rely on.
    expect(naiveNew).toBeGreaterThan(after.length * 0.9);
    // With one, it costs what an edit costs, which is what the chunker promised.
    expect(mappedNew).toBeLessThanOrEqual(3);
    // The spike costs the same, having changed the protocol to get there.
    expect(spikeNew).toBe(mappedNew);
  });

  it("does the same for a change of sealing construction", async () => {
    const keys = await spikeKeys();
    const file = note(64 * 1024, 5);
    const sizes = textSizesFor(file.length);
    const parts = [...chunkBytes(file, sizes, true)].map((c) => c.bytes);

    const store = new ModelStore();
    const localNames = new Map<string, string>();
    for (const c of parts) {
      const body = await sealChunkAs(keys, c, { suite: SUITE_V1, level: 6 });
      const name = await chunkName(body);
      store.put(name, body);
      localNames.set(await localDigest(c), name);
    }

    // The construction changes. Nothing about the file did.
    let naive = 0;
    let mapped = 0;
    for (const c of parts) {
      const body = await sealChunkAs(keys, c, { suite: 2, level: 6 });
      if (store.missing([await chunkName(body)]).length) naive++;
      const known = localNames.get(await localDigest(c));
      if (known === undefined || store.missing([known]).length) mapped++;
    }

    console.log(`  the same file after a change of sealing construction, ${parts.length} chunks`);
    console.log(`    shipped, no local map:  ${naive} re-uploaded`);
    console.log(`    shipped + local map:    ${mapped} re-uploaded`);
    expect(naive).toBe(parts.length);
    expect(mapped).toBe(0);
  });

  it("costs the local index one digest per chunk, and nothing on the wire", async () => {
    // 21,641 chunks is compared.md's 10,000 note vault. A 32 byte digest per
    // chunk, stored as hex beside the name the index already holds.
    const chunks = 21_641;
    const hexDigest = 64;
    const added = chunks * hexDigest;
    console.log(`  a 10,000 note vault: ${chunks} chunks`);
    console.log(`    local index grows by ${(added / 1024 / 1024).toFixed(2)} MiB of hex digests`);
    console.log("    against the 5.6 MiB compared.md measures that index at today");
    console.log("    bytes added to the wire: 0");
    expect(added).toBeLessThan(2 * 1024 * 1024);
  });
});
