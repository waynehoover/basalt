/**
 * SPIKE, not shipped. Naming a chunk by an HMAC of its plaintext.
 *
 * This sits beside `core/crypto.ts` and imports from it rather than changing
 * it, so both naming schemes can run in the same process and be compared. No
 * shipped code path imports anything here.
 *
 * ## The question
 *
 * A chunk's name today is `SHA-256(sealed bytes)`. That makes the name a
 * function of three things nobody wanted it to be a function of: the chunk-size
 * targets, the deflate level, and the sealing construction. `compared.md` says
 * so: "Changing either re-chunks every vault in existence."
 *
 * improvements.md section 3 proposes naming a chunk by the hash of its
 * plaintext. That decouples identity from encoding and it is also a security
 * regression the document does not mention: a plaintext hash is computable by
 * anyone, so the name list becomes a membership oracle over a dictionary of
 * known documents. Today only a key holder can compute a name.
 *
 * What is prototyped here instead: the name is an HMAC of the plaintext under a
 * fifth purpose in the HKDF schedule. Equal plaintext still names equal, so
 * dedup within a vault is unchanged. The name is uncomputable without the
 * vault key, so nothing leaks that does not leak today. And identity stops
 * depending on how the bytes were encoded.
 *
 * ## What actually decouples, and what does not
 *
 * Two of the three parameters decouple: the deflate level and the sealing
 * construction. The chunk-size targets do not, and the proposal is wrong about
 * them. Changing a size target moves the boundaries, which changes the
 * *plaintext* of every chunk, which changes an HMAC of the plaintext exactly as
 * much as it changes a hash of the ciphertext. `decouple.test.ts` measures
 * that rather than asserting it.
 */

import { deflateSync, inflateSync } from "fflate";
import { hex, type Schedule } from "../core/crypto.ts";

const enc = new TextEncoder();

/**
 * The new purpose in the key schedule, alongside path, content, nonce and meta.
 *
 * Its own info string for the same reason every other one has one: a value
 * derived for naming must never be usable as a value derived for sealing, and
 * compromise of one half must say nothing about the other.
 */
export const INFO_CHUNKID = "basalt/chunkid/1";

/** The shipped schedule plus the naming key. */
export interface SpikeSchedule extends Schedule {
  /** Names a chunk. Signs only; never seals anything and never leaves the device. */
  readonly chunkid: CryptoKey;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available");
  return c.subtle;
}

function buf(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/**
 * Derives the naming key from the vault's data key.
 *
 * Deliberately a separate function from `deriveSchedule` rather than an edit to
 * it: the shipped derivation must keep producing exactly the keys it produces
 * today, or the golden vectors move and this stops being a spike.
 */
export async function deriveChunkIdKey(dataKey: Uint8Array): Promise<CryptoKey> {
  const s = subtle();
  const ikm = await s.importKey("raw", buf(dataKey), "HKDF", false, ["deriveKey"]);
  return s.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(INFO_CHUNKID) },
    ikm,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * A chunk's name under the spike: the lowercase hex HMAC-SHA256 of its
 * *plaintext*, under the naming key.
 *
 * Same shape as today's name (64 hex characters), on purpose. The server's
 * `ValidName` is what makes path traversal impossible by construction, and a
 * change that widened or re-alphabetised the name would give that up for
 * nothing.
 *
 * Not truncated. 256 bits of name for a value whose whole job is to be a
 * collision-free identifier over a vault's chunks, and the 32 bytes are already
 * the size the wire format budgets (`NAME_BYTES = 64` hex characters).
 */
export async function chunkId(key: CryptoKey, plaintext: Uint8Array): Promise<string> {
  const mac = await subtle().sign("HMAC", key, buf(plaintext));
  return hex(new Uint8Array(mac));
}

/**
 * Sealing suites: how a body was sealed, as one byte in front of it.
 *
 * This byte is the *only* encoding metadata that can live outside the seal, and
 * it has to, because a reader cannot decrypt before it knows which construction
 * to decrypt with. Everything else about the encoding goes inside, where the
 * GCM tag already covers it, exactly as the shipped codec marker does.
 */
export const SUITE_V1 = 1;
export const SUITE_V2 = 2;

/** Codec markers, inside the seal. The deflate *level* is deliberately not recorded. */
const CODEC_RAW = 0;
const CODEC_DEFLATE = 1;

const NONCE_LENGTH = 12;
const TAG_BITS = 128;

/** Encoding choices a writer makes. None of them appear in the name. */
export interface EncodeParams {
  readonly suite: typeof SUITE_V1 | typeof SUITE_V2;
  /** fflate deflate level, 0 to 9. Not recorded anywhere: inflate does not need it. */
  readonly level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /**
   * Omit the suite byte from the AEAD's additional data.
   *
   * Only a demonstration wants this. `envelope.test.ts` uses it to show what a
   * forged envelope does when the suite byte is not covered by anything, which
   * is the question the report has to answer.
   */
  readonly unbound?: boolean;
}

/** How much of a chunk is tried before deciding whether to compress it. Shipped value. */
const PROBE_BYTES = 4096;

/** Whether a chunk is worth trying to compress, decided from a small prefix. */
function worthDeflating(chunk: Uint8Array, level: number): boolean {
  if (chunk.length === 0) return false;
  if (chunk.length <= PROBE_BYTES * 2) return true;
  const probe = chunk.subarray(0, PROBE_BYTES);
  return deflateSync(probe, { level: level as 6 }).length < probe.length;
}

/** How many bytes of inner header a suite puts in front of the payload. */
function headerLen(suite: number): number {
  return suite === SUITE_V1 ? 1 : 2;
}

/**
 * The nonce for a suite. Both are synthetic and deterministic, which is what
 * keeps equal plaintext sealing equal within a suite.
 *
 * V2 differs from V1 in its domain separation, so the same plaintext under the
 * same keys seals to genuinely different bytes under the two suites. That is
 * the point of having a second suite in a spike: it stands in for whatever real
 * construction change comes later, and it proves the name does not move when
 * the construction does.
 */
async function nonceFor(
  keys: SpikeSchedule,
  suite: number,
  framed: Uint8Array,
): Promise<Uint8Array> {
  if (suite === SUITE_V1) {
    const mac = await subtle().sign("HMAC", keys.nonce, buf(framed));
    return new Uint8Array(mac, 0, NONCE_LENGTH);
  }
  const salted = new Uint8Array(framed.length + 2);
  salted[0] = 0x76; // "v"
  salted[1] = 0x32; // "2"
  salted.set(framed, 2);
  const mac = await subtle().sign("HMAC", keys.nonce, buf(salted));
  return new Uint8Array(mac, 0, NONCE_LENGTH);
}

/**
 * Seals a chunk body under chosen encoding parameters.
 *
 * Layout: `suite(1) || nonce(12) || ciphertext || tag(16)`, and the suite byte
 * is passed to AES-GCM as additional data. That costs zero bytes and buys the
 * one thing an unauthenticated suite byte would not have: a body sealed under
 * suite 1 cannot be relabelled as suite 2 and handed to a reader that would
 * then decrypt it under different rules. Relabelled, it fails its tag.
 */
export async function sealChunkAs(
  keys: SpikeSchedule,
  chunk: Uint8Array,
  params: EncodeParams,
): Promise<Uint8Array> {
  // The same probe the shipped `sealChunk` does, and for the same reason: a
  // vault's large files are already compressed, and deflating them costs
  // everything and saves nothing. Leaving it out of the first draft of this
  // spike made the benchmark report a 20% regression that was entirely the
  // missing probe. Rule 8: the implausible figure was the bug.
  const worth = params.level > 0 && worthDeflating(chunk, params.level);
  const deflated = worth ? deflateSync(chunk, { level: params.level }) : undefined;
  const useDeflate = deflated !== undefined && deflated.length < chunk.length;
  const payload = useDeflate ? deflated : chunk;

  // Suite 2's inner header is two bytes rather than one. A gratuitous
  // difference in a spike, and a deliberate one: it makes a relabelled
  // envelope misframe rather than merely fail, which is what makes the
  // question in `envelope.test.ts` answerable by measurement.
  const hl = headerLen(params.suite);
  const framed = new Uint8Array(hl + payload.length);
  framed[0] = useDeflate ? CODEC_DEFLATE : CODEC_RAW;
  framed.set(payload, hl);

  const nonce = await nonceFor(keys, params.suite, framed);
  const sealed = await subtle().encrypt(
    {
      name: "AES-GCM",
      iv: buf(nonce),
      tagLength: TAG_BITS,
      ...(params.unbound ? {} : { additionalData: buf(Uint8Array.of(params.suite)) }),
    },
    keys.content,
    buf(framed),
  );

  const out = new Uint8Array(1 + NONCE_LENGTH + sealed.byteLength);
  out[0] = params.suite;
  out.set(nonce, 1);
  out.set(new Uint8Array(sealed), 1 + NONCE_LENGTH);
  return out;
}

/**
 * Opens a body sealed by `sealChunkAs`, whichever suite it claims.
 *
 * `accept` is the set of suites this reader will still honour. A suite that is
 * merely deprecated and still accepted is a downgrade waiting to happen if it
 * is ever broken, so retiring one has to mean refusing it, not preferring
 * something else.
 */
export async function openChunkAny(
  keys: SpikeSchedule,
  body: Uint8Array,
  accept: readonly number[] = [SUITE_V1, SUITE_V2],
  unbound = false,
): Promise<Uint8Array> {
  if (body.length < 1 + NONCE_LENGTH + TAG_BITS / 8) {
    throw new Error(`sealed chunk is ${body.length} bytes, too short to be one`);
  }
  const suite = body[0]!;
  if (!accept.includes(suite)) {
    throw new Error(`sealed chunk claims suite ${suite}, which this reader does not accept`);
  }
  const nonce = body.subarray(1, 1 + NONCE_LENGTH);
  const rest = body.subarray(1 + NONCE_LENGTH);
  let framed: Uint8Array;
  try {
    framed = new Uint8Array(
      await subtle().decrypt(
        {
          name: "AES-GCM",
          iv: buf(nonce),
          tagLength: TAG_BITS,
          ...(unbound ? {} : { additionalData: buf(Uint8Array.of(suite)) }),
        },
        keys.content,
        buf(rest),
      ),
    );
  } catch (cause) {
    throw new Error("sealed value failed authentication, so it is not what was stored", { cause });
  }
  const hl = headerLen(suite);
  if (framed.length < hl) throw new Error("sealed chunk carries no codec marker");
  const codec = framed[0]!;
  const payload = framed.subarray(hl);
  if (codec === CODEC_RAW) return payload;
  if (codec === CODEC_DEFLATE) return inflateSync(payload);
  throw new Error(`sealed chunk has an unknown codec marker ${codec}`);
}

/**
 * Opens a body and checks that it really is the chunk that name refers to.
 *
 * This is the check that has no counterpart today, and it is the one place the
 * scheme is *stronger* than what ships. Today `transport.fetch` verifies a
 * received frame by hashing the ciphertext, which proves the server sent the
 * bytes that were asked for. This proves the stronger thing: that the plaintext
 * inside them is the plaintext that name means. It also has to move, because it
 * needs the key, so the transport can no longer do it. That relocation is a
 * real cost and it is written up in the report rather than hidden here.
 */
export async function openAndVerify(
  keys: SpikeSchedule,
  name: string,
  body: Uint8Array,
  unbound = false,
): Promise<Uint8Array> {
  const plain = await openChunkAny(keys, body, [SUITE_V1, SUITE_V2], unbound);
  const got = await chunkId(keys.chunkid, plain);
  if (got !== name) {
    throw new Error(`chunk ${name} opened to a plaintext that names itself ${got}`);
  }
  return plain;
}

/**
 * A model of the server's chunk store, for the dedup demonstrations.
 *
 * Deliberately dumb: a name is an opaque string, a body is bytes, and a name
 * already present is a name not asked for again. That is exactly what the real
 * server does with `Missing` and `Has`, minus the durability machinery, which
 * is not what these tests are about.
 */
export class ModelStore {
  private readonly bodies = new Map<string, Uint8Array>();
  /** Names offered that the store already held. */
  public deduped = 0;
  /** Names offered that it did not. */
  public stored = 0;

  missing(names: readonly string[]): string[] {
    return names.filter((n) => !this.bodies.has(n));
  }

  /** Returns true if the body was actually written. */
  put(name: string, body: Uint8Array): boolean {
    if (this.bodies.has(name)) {
      this.deduped++;
      return false;
    }
    this.bodies.set(name, body);
    this.stored++;
    return true;
  }

  get(name: string): Uint8Array {
    const b = this.bodies.get(name);
    if (!b) throw new Error(`chunk not found: ${name}`);
    return b;
  }

  get size(): number {
    return this.bodies.size;
  }

  get bytes(): number {
    let n = 0;
    for (const b of this.bodies.values()) n += b.length;
    return n;
  }
}
