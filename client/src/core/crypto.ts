/**
 * Deterministic authenticated encryption, and the key schedule above it.
 *
 * This module has no reference to Obsidian, to the transport, or to any state.
 * The cleanest boundary in Obsidian's own engine is its encryption provider,
 * testable with no app present at all. This is the equivalent, and everything in
 * it can be exercised with WebCrypto and nothing else.
 *
 * ## Why the sealing is deterministic
 *
 * Every other encryption layer you will read randomises its nonce, and for good
 * reason: reusing an AES-GCM nonce under one key is catastrophic. This one does
 * not, and the reason is load-bearing twice over.
 *
 * Paths must compare equal, or the server cannot tell two versions of one file
 * apart, and it holds no key with which to work it out.
 *
 * Chunks must compare equal, or deduplication silently does nothing. A chunk's
 * name is the hash of its *ciphertext*, so a random nonce would give every
 * upload a fresh name; content-defined chunking would still cut at exactly the
 * right boundaries and the client would then send every chunk anyway, for ever,
 * reporting success throughout. LiveSync randomises its per-chunk salt and can
 * afford to because it deduplicates on the plaintext hash instead. Basalt
 * deduplicates on the wire, so the determinism has to be in the cipher.
 *
 * The nonce is therefore synthetic: HMAC of the plaintext under a separate key.
 * This is the construction AES-GCM-SIV packages up, spelled out from the two
 * primitives WebCrypto actually provides, because WebCrypto's AES modes are
 * fixed by specification at CBC, CTR, GCM and KW and the client runs in a
 * webview on mobile.
 *
 * The nonce-reuse hazard does not arise: a nonce repeats only for identical
 * plaintext under the same key, which is exactly the equality being asked for,
 * and distinct plaintexts get distinct nonces from the HMAC.
 *
 * What this concedes, and it belongs stated rather than buried: the server can
 * see that two chunks are byte-identical. That is not a leak being tolerated,
 * it is what dedup is made of.
 */

/** The crypto suite named in the handshake. A mismatch is refused, not negotiated. */
export const CRYPTO_SUITE = "basalt/hkdf-aes-gcm/1";

/** AES-GCM nonce length in bytes. 96 bits is the size the mode is built for. */
const NONCE_LENGTH = 12;

/** AES-GCM authentication tag length in bits. */
const TAG_BITS = 128;

/**
 * What sealing adds to a chunk: a nonce, an authentication tag, and the one
 * byte saying whether the payload was deflated.
 *
 * Exported because the chunker has to reserve it. A chunk cut to exactly the
 * server's ceiling seals to more than the ceiling, and the server refuses it,
 * for ever, and the file it belongs to never syncs.
 */
export const SEAL_OVERHEAD = NONCE_LENGTH + TAG_BITS / 8 + 1;

/**
 * Root secret length in bytes. Thirty-two, and only thirty-two.
 *
 * Twenty would be enough through HKDF-SHA256 and unusual enough that every
 * reader asks whether it is a truncation bug. A pairing string carries this
 * length or it is refused.
 */
export const SECRET_LENGTH = 32;

/** The data key length in bytes: what every content key derives from. */
export const DATA_KEY_LENGTH = 32;

/**
 * A device secret's length in bytes.
 *
 * The same thirty-two as the root, and for the same reason: it is a random
 * credential rather than something a person chose, so the only thing length
 * buys is the guessing bound, and there is no reason for one of the two
 * secrets in this system to be weaker than the other.
 */
export const DEVICE_SECRET_LENGTH = 32;

import { deflateSync, inflateSync } from "fflate";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * HKDF info strings. Each key gets its own, so that a value sealed for one
 * purpose can never be mistaken for one sealed for another, and so that
 * compromise of the auth half says nothing about the content half.
 *
 * These strings are part of the wire format: changing one changes every key
 * derived from every existing secret. They are versioned for that reason.
 */
const INFO = {
  auth: "basalt/auth/1",
  wrap: "basalt/wrap/1",
  path: "basalt/path/1",
  content: "basalt/content/1",
  nonce: "basalt/nonce/1",
  meta: "basalt/meta/1",
  /**
   * A device's own auth key, from its own secret.
   *
   * Its own string rather than reusing `auth`, so that the two can never come
   * out equal by accident. If a device secret were ever set to the vault's
   * root, sharing the string would derive the vault's credential and register
   * a device row whose hash is the vault's hash: a device that the recovery
   * key also authenticates as, and a revocation that removes a row while the
   * credential behind it still opens the vault. Different strings make that
   * unexpressible rather than merely unlikely.
   */
  deviceAuth: "basalt/device-auth/1",
} as const;

/**
 * The two keys the root secret produces on its own.
 *
 * All a device has before the handshake, and all it needs there: `auth` to
 * prove it may connect, `wrap` to open the vault's data key when the server
 * hands it over. Nothing here seals a path or a chunk, which is the point.
 * Rotation replaces exactly these two.
 */
export interface RootKeys {
  /** Sent to the server, which stores only a hash of it. */
  readonly auth: Uint8Array;
  /** Wraps the data key, and unwraps it again on every device holding the root. */
  readonly wrap: CryptoKey;
}

/**
 * Every key a device uses: the root's two, and the four the data key gives.
 *
 * `auth` is raw bytes because it goes on the wire; the others are CryptoKeys
 * because they must not. WebCrypto is asked for non-extractable keys, so the
 * content key cannot be read back out of this object even by our own code,
 * which is one fewer way for it to end up somewhere it should not be.
 */
export interface VaultKeys extends RootKeys {
  /** Seals paths. Deterministic, and reversible: a device must recover the name. */
  readonly path: CryptoKey;
  /** Seals chunk bodies. */
  readonly content: CryptoKey;
  /** Derives synthetic nonces. Never seals anything itself. */
  readonly nonce: CryptoKey;
  /**
   * Authenticates an entry: everything about a version except its bytes.
   *
   * The bytes were always sealed. What decides what a client *does* with them
   * was not: `deleted`, `size`, `prev` and the chunk list travelled in the
   * clear, and the server holds every sealed path in the vault, so it could
   * name any file and say anything about it. Setting `deleted` deleted a note
   * everywhere; a size with no chunks emptied one; a chunk list borrowed from
   * another file replaced one.
   */
  readonly meta: CryptoKey;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    // Not a condition to work around. Without WebCrypto there is no way to
    // read the vault, and pretending otherwise would write plaintext.
    throw new Error("WebCrypto is unavailable, so this vault cannot be opened");
  }
  return c.subtle;
}

/** A fresh root secret. This is the one thing the user has to keep. */
export function generateSecret(): Uint8Array {
  return randomBytes(SECRET_LENGTH);
}

/** A fresh data key, made once by the first device and wrapped for the server. */
export function generateDataKey(): Uint8Array {
  return randomBytes(DATA_KEY_LENGTH);
}

/**
 * A fresh device secret: the credential one device connects with, and the only
 * credential a paired device holds.
 *
 * It derives one key and unwraps nothing. That is the shape of the privilege
 * separation in docs/protocol.md, "Authentication": the root registers devices
 * and rewraps the data key, a device secret connects and syncs, and neither can
 * be used for the other's job.
 */
export function generateDeviceSecret(): Uint8Array {
  return randomBytes(DEVICE_SECRET_LENGTH);
}

/** Random bytes from the platform, or a refusal. */
export function randomBytes(n: number): Uint8Array {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) {
    // Not a condition to work around, and more urgent than a missing
    // `subtle`: a secret from a weak source is worse than no secret, because
    // it looks like one.
    throw new Error("no secure random source is available, so a vault cannot be created here");
  }
  return c.getRandomValues(new Uint8Array(n));
}

/**
 * Derives every key a device needs, from its root secret and the vault's
 * wrapped data key.
 *
 * The secret is used as HKDF input keying material directly, with no password
 * stretching, because it is random rather than something a human chose. A
 * stretching function's job is to make guessing expensive, and there is
 * nothing here to guess.
 *
 * Salt is empty and deliberately so. HKDF's salt defends against related-input
 * attacks on low-entropy material; with a uniformly random secret the info
 * string is doing the domain separation and a salt would be one more value to
 * transport, store and lose.
 *
 * `auth` and `wrap` come from the root. Everything that touches content comes
 * from the data key the root unwraps, which is what lets a leaked root be
 * rotated without the history going with it. `wrapped` is required because
 * every vault has a data key: when it was optional, a server could put a
 * device on the root-derived schedule by leaving it out of `ready`, and that
 * device sealed its notes under keys no other device would ever derive.
 */
export async function deriveKeys(secret: Uint8Array, wrapped: string): Promise<VaultKeys> {
  const root = await deriveRootKeys(secret);
  const data = await unwrapDataKey(root.wrap, wrapped);
  return { ...root, ...(await deriveSchedule(data)) };
}

/**
 * The two keys that come from the root and nothing else.
 *
 * What a device can derive before it has spoken to the server: enough to
 * authenticate and to unwrap what `ready` returns, and not enough to seal
 * anything. A shell derives these, connects, and gets the rest.
 */
export async function deriveRootKeys(secret: Uint8Array): Promise<RootKeys> {
  const { s, ikm, hkdf } = await ikmOf(secret);
  const [auth, wrap] = await Promise.all([
    s.deriveBits(hkdf(INFO.auth), ikm, 256),
    s.deriveKey(hkdf(INFO.wrap), ikm, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
  ]);
  return { auth: new Uint8Array(auth), wrap };
}

/** The four keys that seal a vault's content, all from the data key. */
export type Schedule = Pick<VaultKeys, "path" | "content" | "nonce" | "meta">;

/**
 * The content key schedule, from the vault's data key.
 *
 * Separate from `deriveKeys` because the golden vectors in
 * compression-golden.ts pin the sealed bytes for a fixed key and need to
 * derive that schedule without a root secret or a wrapping in front of it.
 */
export async function deriveSchedule(dataKey: Uint8Array): Promise<Schedule> {
  const { s, ikm, hkdf } = await ikmOf(dataKey);
  const [path, content, nonce, meta] = await Promise.all([
    s.deriveKey(hkdf(INFO.path), ikm, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
    s.deriveKey(hkdf(INFO.content), ikm, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
    s.deriveKey(hkdf(INFO.nonce), ikm, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    s.deriveKey(hkdf(INFO.meta), ikm, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ]);
  return { path, content, nonce, meta };
}

/** HKDF input keying material and the parameter builder, for the two derivations above. */
async function ikmOf(root: Uint8Array) {
  if (root.length < 16) {
    // The last guard rather than the first: a pairing string, a stored config
    // and an unsealed invite each refuse anything but SECRET_LENGTH, and a
    // data key is checked when it is unwrapped. What is left for this to
    // catch is keying material truncated in transit between those checks,
    // which would produce a vault that looks encrypted and is not.
    throw new Error(`keying material is ${root.length} bytes, need at least 16`);
  }
  const s = subtle();
  const ikm = await s.importKey("raw", toBuffer(root), "HKDF", false, ["deriveKey", "deriveBits"]);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: enc.encode(info),
  });
  return { s, ikm, hkdf };
}

/**
 * Wraps the data key for the server to hold: `n || AES-GCM-256(K_wrap, n, D)`,
 * base64url, with a random nonce.
 *
 * Random rather than synthetic, unlike everything else sealed here, because
 * nothing needs two wrappings of one key to compare equal and a fresh nonce
 * costs nothing. The server stores the result and cannot open it; it holds
 * neither the root nor the data key.
 */
export async function wrapDataKey(wrap: CryptoKey, dataKey: Uint8Array): Promise<string> {
  if (dataKey.length !== DATA_KEY_LENGTH) {
    throw new Error(`a data key is ${DATA_KEY_LENGTH} bytes, not ${dataKey.length}`);
  }
  return base64urlEncode(await sealRandom(wrap, dataKey));
}

/**
 * Opens what `wrapDataKey` produced, under the root that wrapped it.
 *
 * A failure is a root that does not match: a pairing string for another
 * vault, or one from before a rotation. Said as such, because "sealed value
 * failed authentication" sends somebody looking at the wrong thing.
 */
export async function unwrapDataKey(wrap: CryptoKey, wrapped: string): Promise<Uint8Array> {
  let dataKey: Uint8Array;
  try {
    dataKey = await open(wrap, base64urlDecode(wrapped));
  } catch (cause) {
    throw new Error(
      "this root secret does not open the vault's data key, so it is not this vault's current secret",
      { cause },
    );
  }
  if (dataKey.length !== DATA_KEY_LENGTH) {
    throw new Error(
      `the vault's data key unwrapped to ${dataKey.length} bytes, not ${DATA_KEY_LENGTH}`,
    );
  }
  return dataKey;
}

/**
 * Seals the vault's data key under an invite key: `n || AES-GCM-256(K_inv, n,
 * K_data)`, base64url. What an invite stores on the server, and what the
 * server cannot open because the invite key travels in the invite string and
 * never to it.
 *
 * The data key and not the root, since protocol 4. A device holds no root, so
 * it has none to seal, and an invite that carried one would hand the newcomer
 * the credential that registers devices and rewraps the vault: everything
 * revoking a device is meant to take back. What the newcomer gets is what a
 * device has, the data key, and a credential of its own that the redemption
 * registers.
 */
export async function sealSecret(inviteKey: Uint8Array, secret: Uint8Array): Promise<string> {
  const key = await importAesKey(inviteKey);
  return base64urlEncode(await sealRandom(key, secret));
}

/** Opens what `sealSecret` produced. A failure is the wrong invite key. */
export async function unsealSecret(inviteKey: Uint8Array, sealed: string): Promise<Uint8Array> {
  const key = await importAesKey(inviteKey);
  let secret: Uint8Array;
  try {
    secret = await open(key, base64urlDecode(sealed));
  } catch (cause) {
    throw new Error("the invite key does not open what the server holds for this invite", {
      cause,
    });
  }
  if (secret.length !== SECRET_LENGTH) {
    throw new Error(
      `the invite unsealed to ${secret.length} bytes, and the vault's data key is ${SECRET_LENGTH} bytes`,
    );
  }
  return secret;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error(`an invite key is 32 bytes, not ${raw.length}`);
  return subtle().importKey("raw", toBuffer(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * AES-GCM under a nonce the caller chose, with that nonce in front.
 *
 * Output is `nonce(12) || ciphertext || tag(16)`, so the overhead is 28 bytes
 * flat. The nonce is prepended rather than recomputed on open, because opening
 * would need the plaintext to recompute it and the plaintext is what it is
 * trying to produce.
 *
 * Choosing the nonce is the only thing the two callers below disagree about,
 * and it is the whole of the difference between them, so it is the only thing
 * they are left doing.
 */
async function sealUnder(
  key: CryptoKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const sealed = await subtle().encrypt(
    { name: "AES-GCM", iv: toBuffer(nonce), tagLength: TAG_BITS },
    key,
    toBuffer(plaintext),
  );
  const out = new Uint8Array(NONCE_LENGTH + sealed.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(sealed), NONCE_LENGTH);
  return out;
}

/** A random nonce, for the two places determinism buys nothing. */
function sealRandom(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  return sealUnder(key, randomBytes(NONCE_LENGTH), plaintext);
}

/** Seals bytes: deterministic, authenticated, reversible. */
export async function seal(
  key: CryptoKey,
  nonceKey: CryptoKey,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return sealUnder(key, await syntheticNonce(nonceKey, plaintext), plaintext);
}

/**
 * Opens what seal produced.
 *
 * A failure here is never recovered from and never retried. AES-GCM refusing to
 * authenticate means the bytes are not what was sealed, and the only honest
 * responses are to say so and to leave the file alone. Returning partial or
 * empty content would write that emptiness into the vault.
 */
export async function open(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < NONCE_LENGTH + TAG_BITS / 8) {
    throw new Error(
      `sealed value is ${sealed.length} bytes, too short to contain a nonce and a tag`,
    );
  }
  const s = subtle();
  const nonce = sealed.subarray(0, NONCE_LENGTH);
  const body = sealed.subarray(NONCE_LENGTH);
  try {
    const plain = await s.decrypt(
      { name: "AES-GCM", iv: toBuffer(nonce), tagLength: TAG_BITS },
      key,
      toBuffer(body),
    );
    return new Uint8Array(plain);
  } catch (cause) {
    throw new Error("sealed value failed authentication, so it is not what was stored", { cause });
  }
}

/**
 * The synthetic nonce: HMAC of the plaintext, truncated.
 *
 * Truncating a 256-bit MAC to 96 bits is what the nonce length allows. The
 * collision risk that matters is two *different* plaintexts landing on the same
 * nonce under the same key, which needs about 2^48 distinct chunks before it is
 * worth thinking about, and a vault is many orders of magnitude away from that.
 */
async function syntheticNonce(nonceKey: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const mac = await subtle().sign("HMAC", nonceKey, toBuffer(plaintext));
  return new Uint8Array(mac, 0, NONCE_LENGTH);
}

/**
 * Seals a path and encodes it for the wire.
 *
 * base64url, because the result travels in JSON and is used as a database key.
 * The one-way HMAC that LiveSync uses for paths would be smaller and is not an
 * option: a device receiving an entry for a file it has never seen has to
 * recover the name to write it to disk, and LiveSync only gets away with it
 * because it keeps a second copy of the name inside the encrypted document.
 */
export async function sealPath(keys: Schedule, path: string): Promise<string> {
  return base64urlEncode(await seal(keys.path, keys.nonce, enc.encode(path)));
}

export async function openPath(keys: Schedule, sealedPath: string): Promise<string> {
  const plain = await open(keys.path, base64urlDecode(sealedPath));
  return dec.decode(plain);
}

/**
 * Marker bytes for what is inside a sealed chunk.
 *
 * The marker sits *inside* the sealed plaintext, not beside it. That costs the
 * same byte and buys two things: the server cannot tell which chunks compressed,
 * which would otherwise leak how compressible each part of a vault is, and the
 * marker is covered by the authentication tag so it cannot be flipped to make a
 * reader inflate something that is not deflate.
 */
const CHUNK_RAW = 0;
const CHUNK_DEFLATE = 1;

/**
 * Seals a chunk body, compressing it when that helps.
 *
 * Compression has to happen here rather than anywhere else in the pipeline, and
 * the ordering is the whole reason it works:
 *
 *   - After chunking, never before. Compressing the file first would shift every
 *     byte of the compressed stream on any edit, and the content-defined
 *     boundaries that make an edit cost one chunk would all move.
 *   - Before sealing, never after. Ciphertext is incompressible by design.
 *
 * Measured on a real vault, per-chunk deflate takes a full upload of its text
 * from 108% of the plaintext to 67%. Larger chunks compress better, but that
 * trade was measured too and lost: going from 256 B to 4 KiB averages saves
 * 3.8 MiB once and costs about 2.2 KB on every subsequent edit, so it pays back
 * after roughly seventeen hundred edits and a vault does far more than that.
 *
 * The codec is fflate rather than the platform's, because determinism is
 * load-bearing here. The same chunk has to seal to the same bytes on a desktop
 * and a phone or the names diverge and dedup silently stops working, and
 * "whatever zlib this runtime shipped" is not a guarantee. fflate is pure
 * JavaScript, so it is the same code everywhere, and its level 6 output is
 * byte-identical to zlib's anyway.
 *
 * A chunk that does not shrink is stored raw. The result is never larger than
 * the plaintext plus 29 bytes.
 */
export async function sealChunk(keys: Schedule, chunk: Uint8Array): Promise<Uint8Array> {
  const deflated = worthDeflating(chunk) ? deflateSync(chunk, { level: 6 }) : undefined;
  const useDeflate = deflated !== undefined && deflated.length < chunk.length;
  const payload = useDeflate ? deflated : chunk;

  const framed = new Uint8Array(1 + payload.length);
  framed[0] = useDeflate ? CHUNK_DEFLATE : CHUNK_RAW;
  framed.set(payload, 1);
  return seal(keys.content, keys.nonce, framed);
}

/**
 * Whether a chunk is worth trying to compress, decided from a small prefix.
 *
 * Deflating already-compressed bytes is the worst case of a compressor: it does
 * all the work, allocates an output the size of its input, finds nothing, and
 * the result is thrown away. A vault's large files are exactly that kind of
 * data, because photographs, PDFs and video are compressed already.
 *
 * Measured over 64 MiB of incompressible data in chunks of 384 KiB: 763 ms and
 * 260 MB peak resident deflating every chunk, against 24 ms and 131 MB probing
 * first. The bytes on the wire are identical, because none of that work was
 * ever going to be used.
 *
 * The decision is a pure function of the chunk, which it has to be: a chunk is
 * named by the hash of its sealed bytes, so two devices that decided this
 * differently for the same content would give it two names and neither would
 * ever recognise the other's copy.
 *
 * A chunk whose first four kilobytes do not compress but whose remainder would
 * loses that compression. It costs bytes, never correctness, and the shape of
 * file where that happens is rare enough to prefer the measurement.
 */
function worthDeflating(chunk: Uint8Array): boolean {
  if (chunk.length === 0) return false;
  // Below the probe size there is nothing to save by probing: deflating the
  // whole thing costs about what deflating the prefix would.
  if (chunk.length <= PROBE_BYTES * 2) return true;
  const probe = chunk.subarray(0, PROBE_BYTES);
  return deflateSync(probe, { level: 6 }).length < probe.length;
}

/** How much of a chunk is tried before deciding whether to compress it. */
const PROBE_BYTES = 4096;

/** A sealed chunk and the name the server will know it by. */
export interface SealedChunk {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Seals and names a whole file's chunks at once.
 *
 * This exists because of a measurement, and it is the default path so that the
 * fast one is not something anyone has to remember. Sealing a chunk costs three
 * WebCrypto calls (an HMAC for the nonce, the AES-GCM seal, a SHA-256 for the
 * name), and each is a promise whose latency dominates the arithmetic at the
 * chunk sizes prose produces. Measured over 1,893 chunks of a real vault:
 *
 * ```
 * awaiting each chunk in turn   38 us/chunk    56 MiB/s
 * one file's chunks at once     14 us/chunk   151 MiB/s
 * every chunk at once           11 us/chunk   192 MiB/s
 * ```
 *
 * So the work is not the cost, the waiting is, and a file at a time recovers
 * most of it. A file at a time rather than everything at once on purpose: peak
 * memory then stays bounded by one file's ciphertext, and a 3.5x gain that holds
 * for a 700 MB attachment beats a 3.7x gain that does not.
 */
export async function sealChunks(
  keys: Schedule,
  chunks: Iterable<Uint8Array>,
): Promise<SealedChunk[]> {
  return Promise.all(
    [...chunks].map(async (chunk) => {
      const bytes = await sealChunk(keys, chunk);
      return { name: await chunkName(bytes), bytes };
    }),
  );
}

export async function openChunk(keys: Schedule, sealed: Uint8Array): Promise<Uint8Array> {
  const framed = await open(keys.content, sealed);
  if (framed.length === 0) {
    throw new Error("sealed chunk carries no marker byte");
  }
  const marker = framed[0]!;
  const payload = framed.subarray(1);
  if (marker === CHUNK_RAW) return payload;
  if (marker === CHUNK_DEFLATE) {
    try {
      return inflateSync(payload);
    } catch (cause) {
      // Authenticated, so the bytes are what was sealed, which means the
      // writer produced something this reader cannot inflate. Never
      // recovered from: returning anything here would write a truncated
      // note over a good one.
      throw new Error("sealed chunk claims to be deflated and is not", { cause });
    }
  }
  // A marker from a future version. Refusing is the only honest answer: the
  // bytes decrypt, so the content is real, and guessing at its framing would
  // write nonsense into the vault.
  throw new Error(`sealed chunk has an unknown marker byte ${marker}`);
}

/**
 * A chunk's name: the lowercase hex SHA-256 of its sealed bytes.
 *
 * Must agree with the server's `chunks.Name` exactly. The server recomputes this
 * from the body it receives and refuses a mismatch, so a disagreement here is
 * caught on the first upload rather than becoming a corrupt vault.
 */
export async function chunkName(sealedChunk: Uint8Array): Promise<string> {
  const digest = await subtle().digest("SHA-256", toBuffer(sealedChunk));
  return hex(new Uint8Array(digest));
}

/**
 * Whether a string has the shape `chunkName` produces, and nothing else has.
 *
 * Beside the function that makes one, because the shape is that function's
 * output and nothing else. Three readers check it: a `get`, a recovery list
 * (C32) and the stored index. Each one is about to fetch by the name or key
 * something on it, and each had the pattern written out again.
 */
export function isChunkName(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

/** The auth token as it goes on the wire. Derived from the root, so a device has it before it connects. */
export function authToken(keys: RootKeys): string {
  return base64urlEncode(keys.auth);
}

/**
 * A device's own auth token, from its own secret.
 *
 * What `deviceId` is checked against on a protocol 4 hello, and what
 * `register` hands the server so it can store the digest. Derived rather than
 * sent raw for the same reason the vault's is: the secret on disk is a seed,
 * and the thing on the wire is a key with one purpose written into its
 * derivation.
 *
 * The server keeps only `sha256` of what it is sent, so what travels is the
 * key rather than the digest: a digest is a credential nobody can judge, and
 * the server enforces a floor on the length of what it is offered. The floor
 * is 32 characters and this is 43, being base64url of 32 bytes.
 */
export async function deviceAuthToken(deviceSecret: Uint8Array): Promise<string> {
  const { s, ikm, hkdf } = await ikmOf(deviceSecret);
  const auth = await s.deriveBits(hkdf(INFO.deviceAuth), ikm, 256);
  return base64urlEncode(new Uint8Array(auth));
}

/* ---------------------------------------------------------------- *
 * Encoding
 * ---------------------------------------------------------------- */

/**
 * A standalone ArrayBuffer holding exactly a view's bytes.
 *
 * WebCrypto accepts a BufferSource, but a Uint8Array that is a *view* into a
 * larger buffer has caused real bugs in this shape of code: passing the view
 * where the whole buffer is read hands over neighbouring data. So the buffer
 * that leaves here always holds the view's bytes and nothing else.
 *
 * A view that already spans its whole buffer is that buffer, and copying it
 * only makes a second one with the same contents. The hazard cannot arise, so
 * the copy is skipped. It is the common case: a chunk read from a file owns
 * its bytes, and copying every one of them cost 1.36x on attachments.
 */
function toBuffer(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer as ArrayBuffer;
  }
  return view.slice().buffer;
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * base64url without padding, implemented rather than borrowed.
 *
 * `btoa` works on a string of char codes and needs a conversion that is easy to
 * get wrong for bytes above 0x7f, and Node's Buffer is not available in a
 * webview. Sixteen lines removes a platform difference from the one code path
 * where an encoding bug would corrupt every path in the vault.
 */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64URL[b0 >> 2]!;
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += B64URL[b2 & 0x3f]!;
  }
  return out;
}

const B64URL_INDEX = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) m[B64URL.charCodeAt(i)] = i;
  return m;
})();

/**
 * Decodes base64url, refusing anything that is not exactly one encoding of the
 * bytes it produces.
 *
 * The two refusals at the end are what make the total-failure contract above
 * hold, and both were once accepted. A length leaving six unconsumed bits is a
 * string with one character too many: those six bits produce no output byte, so
 * a recovery key or an invite with a character appended decoded to the original
 * bytes and passed its CRC, and a damaged credential was taken for the real
 * one. Nonzero bits below the last output byte are the same fault in the other
 * direction: the low bits of a final partial sextet are not read, so they could
 * be flipped without changing a byte, and the checksum never saw the difference.
 *
 * A canonical encoder never produces either, so nothing legitimate is refused.
 */
export function base64urlDecode(s: string): Uint8Array {
  const n = s.length;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const code = s.charCodeAt(i);
    const v = code < 128 ? B64URL_INDEX[code]! : -1;
    if (v < 0) {
      // Not silently skipped. A stray character means the value was
      // mangled in transit or storage, and decoding around it would
      // produce plausible bytes that fail authentication later, further
      // from the cause.
      throw new Error(`invalid base64url character ${JSON.stringify(s[i])} at position ${i}`);
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits === 6) {
    throw new Error(
      `this base64url value is ${n} characters, which is one more than a whole number of bytes: ` +
        "the last character adds no byte and something has been added to it or lost from it",
    );
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new Error(
      `this base64url value ends with ${bits} bits that no byte uses, and they are not zero, ` +
        "so it is not the encoding of the bytes it decodes to",
    );
  }
  return out.subarray(0, o);
}

/**
 * What an entry's authentication covers.
 *
 * Everything the receiving client acts on, and nothing the server assigns. The
 * uid is the server's, so it cannot be in here; ordering is the server's job and
 * this does not try to take it. What this settles is that the server cannot
 * invent an entry, alter one, or move one file's chunk list onto another file.
 *
 * Length-prefixed rather than delimited, because a delimiter is a character
 * somebody's filename eventually contains, and two different entries that
 * canonicalise to the same bytes are one forgery.
 */
export interface EntryFacts {
  readonly path: string;
  readonly size: number;
  readonly ctime: number;
  readonly mtime: number;
  readonly folder: boolean;
  readonly deleted: boolean;
  readonly prev?: string | undefined;
  readonly chunks: readonly string[];
  /** The version this was written on top of, as `parentOf` produces it. */
  readonly parent: string;
}

function canonical(e: EntryFacts): Uint8Array {
  const parts = [
    e.path,
    String(e.size),
    String(e.ctime),
    String(e.mtime),
    e.folder ? "1" : "0",
    e.deleted ? "1" : "0",
    e.prev ?? "",
    e.parent,
    String(e.chunks.length),
    ...e.chunks,
  ];
  return enc.encode(parts.map((p) => `${p.length}:${p}`).join(""));
}

/** The authenticator for one entry, as hex. */
export async function macEntry(keys: Schedule, e: EntryFacts): Promise<string> {
  const mac = await subtle().sign("HMAC", keys.meta, toBuffer(canonical(e)));
  return hex(new Uint8Array(mac));
}

/**
 * Whether an entry is one a holder of this vault's key wrote.
 *
 * Compared in constant time. A server learning which byte of a guess was wrong
 * is a server that can guess the rest, and this runs on every entry of every
 * batch.
 */
export async function entryIsOurs(keys: Schedule, e: EntryFacts, mac: string): Promise<boolean> {
  const want = await macEntry(keys, e);
  if (want.length !== mac.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ mac.charCodeAt(i);
  return diff === 0;
}

/**
 * A short, stable name for the version an entry was written on top of.
 *
 * The content id is the chunk names joined, which for a large file is tens of
 * kilobytes, and it would travel on every entry. A digest of it is 64 characters
 * and says the same thing. Empty means there was no parent: a file this device
 * had never synced.
 */
export async function parentOf(contentId: string): Promise<string> {
  if (contentId === "") return "";
  const d = await subtle().digest("SHA-256", toBuffer(enc.encode(contentId)));
  return hex(new Uint8Array(d));
}
