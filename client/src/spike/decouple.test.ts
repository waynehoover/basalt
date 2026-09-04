/**
 * SPIKE, not shipped. Does naming a chunk by an HMAC of its plaintext actually
 * decouple identity from encoding?
 *
 * The whole idea rests on one property, so it is measured here rather than
 * asserted anywhere: two chunks of the same plaintext, sealed with different
 * encoding parameters, must share a name and deduplicate. And the parameter
 * the proposal is wrong about, the chunk-size targets, must be shown not to.
 *
 * Every test prints its numbers, because the report quotes them.
 */

import { describe, expect, it } from "vitest";
import { chunkBytes, textSizesFor, type ChunkSizes } from "../core/chunk.ts";
import { chunkName, sealChunk } from "../core/crypto.ts";
import {
  ModelStore,
  SUITE_V1,
  SUITE_V2,
  chunkId,
  openAndVerify,
  openChunkAny,
  sealChunkAs,
  type EncodeParams,
} from "./chunkid.ts";
import { OTHER_DATA_KEY, spikeKeys } from "./keys.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

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

describe("identity against encoding", () => {
  it("names the same plaintext the same at every deflate level, and dedups it", async () => {
    const keys = await spikeKeys();
    const plain = note(3000, 7);

    const levels: EncodeParams["level"][] = [0, 1, 3, 6, 9];
    const shipped = new ModelStore();
    const spike = new ModelStore();
    const spikeName = await chunkId(keys.chunkid, plain);
    const distinct = new Set<string>();
    const rows: string[] = [];

    for (const level of levels) {
      const body = await sealChunkAs(keys, plain, { suite: SUITE_V1, level });
      const todayName = await chunkName(body); // SHA-256 of the sealed bytes
      distinct.add(Buffer.from(body).toString("hex"));
      shipped.put(todayName, body);
      spike.put(spikeName, body);
      rows.push(
        `    level ${level === 0 ? "off " : `${level}   `}: ${String(body.length).padStart(5)} B body, today ${todayName.slice(0, 12)}`,
      );
    }

    console.log("  deflate level against identity");
    for (const r of rows) console.log(r);
    console.log(`    spike name (all five): ${spikeName.slice(0, 12)}`);
    console.log(
      `    distinct bodies ${distinct.size} of ${levels.length}; stored: today ${shipped.size}, spike ${spike.size}`,
    );

    // Every distinct body gets its own name today, so retuning the level gives
    // the store a second copy of a chunk it already has. Levels 3, 6 and 9
    // happen to agree on prose this short, which is a finding in itself and is
    // why this counts distinct bodies rather than assuming five.
    expect(shipped.size).toBe(distinct.size);
    expect(distinct.size).toBeGreaterThan(1);
    // Under the spike they are one name and one stored copy, whatever the level.
    expect(spike.size).toBe(1);
    expect(spike.deduped).toBe(levels.length - 1);
  });

  it("names the same plaintext the same under two sealing constructions", async () => {
    const keys = await spikeKeys();
    const plain = note(3000, 11);

    const v1 = await sealChunkAs(keys, plain, { suite: SUITE_V1, level: 6 });
    const v2 = await sealChunkAs(keys, plain, { suite: SUITE_V2, level: 6 });

    // Genuinely different bytes: different nonce derivation, different inner framing.
    expect(Buffer.from(v1).equals(Buffer.from(v2))).toBe(false);
    expect(await chunkName(v1)).not.toBe(await chunkName(v2));

    const name1 = await chunkId(keys.chunkid, plain);
    const name2 = await chunkId(keys.chunkid, plain);
    expect(name1).toBe(name2);

    console.log("  sealing construction against identity");
    console.log(`    suite 1 body ${v1.length} B, today ${(await chunkName(v1)).slice(0, 12)}`);
    console.log(`    suite 2 body ${v2.length} B, today ${(await chunkName(v2)).slice(0, 12)}`);
    console.log(`    spike name (both):     ${name1.slice(0, 12)}`);

    // And a reader handles either, which is what coexistence requires.
    expect(dec.decode(await openAndVerify(keys, name1, v1))).toBe(dec.decode(plain));
    expect(dec.decode(await openAndVerify(keys, name1, v2))).toBe(dec.decode(plain));
  });

  it("lets a v2 writer meet a v1 store and upload nothing", async () => {
    const keys = await spikeKeys();
    const store = new ModelStore();
    const file = note(40_000, 13);
    const sizes = textSizesFor(file.length);
    const parts = [...chunkBytes(file, sizes, true)].map((c) => c.bytes);

    // Device A, the old client: suite 1, deflate 6.
    for (const p of parts) {
      const name = await chunkId(keys.chunkid, p);
      if (store.missing([name]).length) {
        store.put(name, await sealChunkAs(keys, p, { suite: SUITE_V1, level: 6 }));
      }
    }
    const afterA = store.size;

    // Device B, the new client: suite 2, deflate 9. Same file, same boundaries.
    let asked = 0;
    for (const p of parts) {
      const name = await chunkId(keys.chunkid, p);
      if (store.missing([name]).length) {
        asked++;
        store.put(name, await sealChunkAs(keys, p, { suite: SUITE_V2, level: 9 }));
      }
    }

    console.log("  a v2 writer against a v1 store");
    console.log(`    ${parts.length} chunks, ${afterA} stored by the v1 device`);
    console.log(`    the v2 device was asked for ${asked} of them`);

    expect(afterA).toBe(parts.length);
    expect(asked).toBe(0);
    expect(store.size).toBe(afterA);

    // And device B can read back what device A wrote, byte for byte.
    const out: Uint8Array[] = [];
    for (const p of parts) {
      const name = await chunkId(keys.chunkid, p);
      out.push(await openAndVerify(keys, name, store.get(name)));
    }
    const joined = Buffer.concat(out.map((b) => Buffer.from(b)));
    expect(joined.equals(Buffer.from(file))).toBe(true);
  });
});

describe("the parameter that does not decouple", () => {
  it("gives the same file entirely new names when the chunk targets move", async () => {
    const keys = await spikeKeys();
    const file = note(200_000, 17);

    const at = async (sizes: ChunkSizes) => {
      const parts = [...chunkBytes(file, sizes, true)].map((c) => c.bytes);
      const spike = new Set<string>();
      const today = new Set<string>();
      for (const p of parts) {
        spike.add(await chunkId(keys.chunkid, p));
        today.add(await chunkName(await sealChunk(keys, p)));
      }
      return { count: parts.length, spike, today };
    };

    const a = await at({ min: 512, avg: 1024, max: 4096 });
    const b = await at({ min: 2048, avg: 4096, max: 16384 });

    const sharedSpike = [...a.spike].filter((n) => b.spike.has(n)).length;
    const sharedToday = [...a.today].filter((n) => b.today.has(n)).length;

    console.log("  chunk-size targets against identity");
    console.log(`    avg 1024: ${a.count} chunks;  avg 4096: ${b.count} chunks`);
    console.log(`    names shared, today's scheme: ${sharedToday} of ${a.spike.size}`);
    console.log(`    names shared, spike scheme:   ${sharedSpike} of ${a.spike.size}`);

    // The point: the spike is no better here, because the *plaintexts* differ.
    // A hash of the ciphertext and an HMAC of the plaintext are equally
    // sensitive to a boundary that moved.
    expect(sharedSpike).toBe(sharedToday);
    expect(sharedSpike / a.spike.size).toBeLessThan(0.05);
  });
});

describe("what the name leaks", () => {
  it("is uncomputable without the vault key, and a plaintext hash is not", async () => {
    const mine = await spikeKeys();
    const theirs = await spikeKeys(OTHER_DATA_KEY);
    const known = enc.encode("A chunk of a document an adversary already has a copy of.\n");

    // The proposal as written: SHA-256 of the plaintext. Anyone can compute it,
    // and it is the same number in every vault on earth.
    const plainHashMine = Buffer.from(
      await crypto.subtle.digest("SHA-256", known.slice()),
    ).toString("hex");
    const plainHashTheirs = Buffer.from(
      await crypto.subtle.digest("SHA-256", known.slice()),
    ).toString("hex");
    expect(plainHashMine).toBe(plainHashTheirs);

    // The correction: an HMAC under a per-vault key. Two vaults holding the
    // same document name that chunk differently, so a name list confirms
    // nothing and correlates nothing across vaults.
    const idMine = await chunkId(mine.chunkid, known);
    const idTheirs = await chunkId(theirs.chunkid, known);
    expect(idMine).not.toBe(idTheirs);

    console.log("  the same chunk of a known document");
    console.log(`    sha256(plaintext), vault A: ${plainHashMine.slice(0, 16)}`);
    console.log(`    sha256(plaintext), vault B: ${plainHashTheirs.slice(0, 16)}  identical`);
    console.log(`    hmac name,         vault A: ${idMine.slice(0, 16)}`);
    console.log(`    hmac name,         vault B: ${idTheirs.slice(0, 16)}  unrelated`);
  });

  it("still leaks equality within a vault, exactly as today does", async () => {
    const keys = await spikeKeys();
    const p = note(2000, 23);
    // Two files sharing a chunk name is what dedup is, and it is what the
    // server sees. The spike neither adds to that nor takes it away.
    expect(await chunkId(keys.chunkid, p)).toBe(await chunkId(keys.chunkid, p.slice()));
    expect(await chunkName(await sealChunk(keys, p))).toBe(
      await chunkName(await sealChunk(keys, p.slice())),
    );
  });
});

describe("the reader's end-to-end check", () => {
  it("refuses a body that opens to the wrong plaintext", async () => {
    const keys = await spikeKeys();
    const a = note(1500, 29);
    const b = note(1500, 31);
    const nameA = await chunkId(keys.chunkid, a);
    const bodyB = await sealChunkAs(keys, b, { suite: SUITE_V1, level: 6 });

    // A server serving chunk B's body for chunk A's name. The body is validly
    // sealed under the vault key, so AES-GCM is happy with it.
    await expect(openChunkAny(keys, bodyB)).resolves.toBeInstanceOf(Uint8Array);
    // The name check is what catches it, and it is a check on the plaintext.
    await expect(openAndVerify(keys, nameA, bodyB)).rejects.toThrow(/names itself/);
  });
});
