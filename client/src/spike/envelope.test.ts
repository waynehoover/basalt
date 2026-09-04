/**
 * SPIKE, not shipped. What has to cover the envelope, and what a forged one does.
 *
 * Under the shipped scheme the envelope needs no protection of its own, because
 * the name *is* a hash of the whole body: every byte of the framing is covered
 * for free, and `transport.fetch` catches a flipped one before anything is
 * decrypted. Naming by an HMAC of the plaintext gives that up. The name now
 * says nothing about the bytes that carry the plaintext, so whatever sits
 * outside the seal is metadata an adversary can rewrite.
 *
 * These tests answer: exactly what must be covered, by what, and what a forgery
 * buys if it is not.
 */

import { describe, expect, it } from "vitest";
import { chunkName } from "../core/crypto.ts";
import {
  SUITE_V1,
  SUITE_V2,
  chunkId,
  openAndVerify,
  openChunkAny,
  sealChunkAs,
} from "./chunkid.ts";
import { spikeKeys } from "./keys.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const PLAIN = enc.encode(
  "The one thing the envelope has to say is which construction opened this, " +
    "because a reader cannot decrypt before it knows. Everything else belongs inside.\n",
);

/** An incompressible chunk, so it is stored raw and a misframe just shifts bytes. */
const RANDOM = (() => {
  const b = new Uint8Array(1024);
  let x = 0x2f6f2b79;
  for (let i = 0; i < b.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 0xff;
  }
  return b;
})();

describe("the suite byte, the only thing that must live outside the seal", () => {
  it("is caught when it is relabelled, if it is bound as additional data", async () => {
    const keys = await spikeKeys();
    const body = await sealChunkAs(keys, PLAIN, { suite: SUITE_V1, level: 6 });

    const forged = Uint8Array.from(body);
    forged[0] = SUITE_V2; // the server rewrites one byte in flight

    await expect(openChunkAny(keys, forged)).rejects.toThrow(/failed authentication/);
    console.log("  suite byte bound as AAD: a relabelled envelope fails its tag");
  });

  it("silently corrupts a note when it is not bound", async () => {
    const keys = await spikeKeys();
    // An incompressible chunk, which is stored raw: an attachment, or any of
    // the half of a real vault's large files that are already compressed.
    const raw = RANDOM;
    // Sealed by a design that left the suite byte unauthenticated.
    const body = await sealChunkAs(keys, raw, { suite: SUITE_V1, level: 6, unbound: true });

    const forged = Uint8Array.from(body);
    forged[0] = SUITE_V2;

    // It opens. The ciphertext was not touched and the nonce travels with it,
    // so AES-GCM authenticates exactly what was sealed. What changed is how the
    // reader frames the authenticated plaintext: suite 2's header is two bytes
    // rather than one, so it strips a byte the writer meant as content.
    const good = await openChunkAny(keys, body, [SUITE_V1, SUITE_V2], true);
    const out = await openChunkAny(keys, forged, [SUITE_V1, SUITE_V2], true);

    expect(Buffer.from(good).equals(Buffer.from(raw))).toBe(true);
    expect(Buffer.from(out).equals(Buffer.from(raw))).toBe(false);
    expect(out.length).toBe(good.length - 1);
    console.log("  suite byte unbound: the same body opens two ways, neither erroring");
    console.log(`    as sealed:     ${good.length} bytes, correct`);
    console.log(`    as relabelled: ${out.length} bytes, off by one and silent`);
  });

  it("usually fails loudly on a deflated chunk, which is luck rather than a defence", async () => {
    const keys = await spikeKeys();
    const body = await sealChunkAs(keys, PLAIN, { suite: SUITE_V1, level: 6, unbound: true });
    const forged = Uint8Array.from(body);
    forged[0] = SUITE_V2;
    // A deflate stream missing its first byte is usually not a deflate stream,
    // so inflate refuses. That is the compressor noticing, not the format.
    await expect(openChunkAny(keys, forged, [SUITE_V1, SUITE_V2], true)).rejects.toThrow();
    console.log(
      "  a misframed deflate stream tends to refuse to inflate, but nothing guarantees it",
    );
  });

  it("is caught by the name check even when it is not bound", async () => {
    const keys = await spikeKeys();
    const name = await chunkId(keys.chunkid, RANDOM);
    const body = await sealChunkAs(keys, RANDOM, { suite: SUITE_V1, level: 6, unbound: true });
    const forged = Uint8Array.from(body);
    forged[0] = SUITE_V2;

    // Defence in depth, not a substitute: the reader recomputes the name from
    // the plaintext it got and finds it is not the plaintext it asked for.
    await expect(openAndVerify(keys, name, forged, true)).rejects.toThrow(/names itself/);
    console.log("  the reader's own name check catches the same forgery, one layer later");
  });

  it("needs no protection at all under the shipped scheme", async () => {
    const keys = await spikeKeys();
    const body = await sealChunkAs(keys, PLAIN, { suite: SUITE_V1, level: 6, unbound: true });
    const forged = Uint8Array.from(body);
    forged[0] = SUITE_V2;

    // Today's name is a hash of every byte of the body, envelope included, and
    // the transport checks it on arrival. The forgery never reaches the cipher.
    expect(await chunkName(forged)).not.toBe(await chunkName(body));
    console.log("  under the shipped scheme the envelope is inside the name, so this is free");
  });
});

describe("what belongs inside the seal, and stays there", () => {
  it("keeps the codec marker unforgeable, as it already is", async () => {
    const keys = await spikeKeys();
    const body = await sealChunkAs(keys, PLAIN, { suite: SUITE_V1, level: 6 });

    // The first ciphertext byte is where the codec marker was sealed. Flipping
    // it is flipping ciphertext, which AES-GCM refuses.
    const forged = Uint8Array.from(body);
    forged[13]! ^= 0x01;
    await expect(openChunkAny(keys, forged)).rejects.toThrow(/failed authentication/);
    console.log("  codec marker inside the seal: a flip fails the tag, as today");
  });

  it("does not record the deflate level, because nothing reads it", async () => {
    const keys = await spikeKeys();
    // Sealed at 9, opened by a reader that has never heard of level 9.
    const body = await sealChunkAs(keys, PLAIN, { suite: SUITE_V1, level: 9 });
    expect(dec.decode(await openChunkAny(keys, body))).toBe(dec.decode(PLAIN));
    console.log("  the deflate level appears nowhere in the format: inflate does not need it");
  });
});

describe("why the entry MAC is the wrong place for encoding parameters", () => {
  it("would have to say two things about one chunk", async () => {
    const keys = await spikeKeys();
    const shared = enc.encode("A boilerplate paragraph that two notes both contain.\n");
    const name = await chunkId(keys.chunkid, shared);

    // Two entries reference the same chunk. Its encoding is a property of the
    // stored body, of which there is one, so putting the parameters in each
    // entry means two signed claims about a single object. A writer that
    // encoded differently from the device that stored it would sign a claim
    // that is false, and a reader that believed the entry rather than the
    // envelope would misframe a chunk that is perfectly good.
    const stored = await sealChunkAs(keys, shared, { suite: SUITE_V1, level: 6 });
    const wouldHaveSealed = await sealChunkAs(keys, shared, { suite: SUITE_V2, level: 9 });

    expect(await chunkId(keys.chunkid, shared)).toBe(name);
    expect(Buffer.from(stored).equals(Buffer.from(wouldHaveSealed))).toBe(false);
    // Entry A signs "suite 1", entry B signs "suite 2", one body exists.
    console.log("  one chunk name, two entries, two encodings a writer might have signed");
    console.log("    so the encoding belongs to the body, not to the entry");
  });
});
