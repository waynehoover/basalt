/**
 * Deterministic authenticated encryption, and the key schedule above it.
 *
 * This module has no reference to Obsidian, to the transport, or to any state.
 * docs/client-design.md notes that the cleanest boundary in Obsidian's own
 * engine is its encryption provider, testable with no app present at all; this
 * is the equivalent here, and everything in it can be exercised with WebCrypto
 * and nothing else.
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

/** Root secret length in bytes. */
export const SECRET_LENGTH = 20;

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
    path: "basalt/path/1",
    content: "basalt/content/1",
    nonce: "basalt/nonce/1",
} as const;

/**
 * The keys derived from one root secret.
 *
 * `auth` is raw bytes because it goes on the wire; the others are CryptoKeys
 * because they must not. WebCrypto is asked for non-extractable keys, so the
 * content key cannot be read back out of this object even by our own code,
 * which is one fewer way for it to end up somewhere it should not be.
 */
export interface VaultKeys {
    /** Sent to the server, which stores only a hash of it. */
    readonly auth: Uint8Array;
    /** Seals paths. Deterministic, and reversible: a device must recover the name. */
    readonly path: CryptoKey;
    /** Seals chunk bodies. */
    readonly content: CryptoKey;
    /** Derives synthetic nonces. Never seals anything itself. */
    readonly nonce: CryptoKey;
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
    const c = globalThis.crypto;
    if (!c?.getRandomValues) {
        // Same reasoning as `subtle` above, and more urgent: a secret from a
        // weak source is worse than no secret, because it looks like one.
        throw new Error("no secure random source is available, so a vault cannot be created here");
    }
    return c.getRandomValues(new Uint8Array(SECRET_LENGTH));
}

/**
 * Derives every key from a root secret.
 *
 * The secret is used as HKDF input keying material directly, with no password
 * stretching, because it is 160 random bits rather than something a human
 * chose. A stretching function's
 * job is to make guessing expensive, and there is nothing here to guess.
 * choose it.
 *
 * Salt is empty and deliberately so. HKDF's salt defends against related-input
 * attacks on low-entropy material; with a uniformly random secret the info
 * string is doing the domain separation and a salt would be one more value to
 * transport, store and lose.
 */
export async function deriveKeys(secret: Uint8Array): Promise<VaultKeys> {
    if (secret.length < 16) {
        // A short secret is a bug somewhere upstream, and silently accepting it
        // would produce a vault that looks encrypted and is not.
        throw new Error(`root secret is ${secret.length} bytes, need at least 16`);
    }
    const s = subtle();
    const ikm = await s.importKey("raw", toBuffer(secret), "HKDF", false, ["deriveKey", "deriveBits"]);

    const hkdf = (info: string) => ({
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: enc.encode(info),
    });

    const [auth, path, content, nonce] = await Promise.all([
        s.deriveBits(hkdf(INFO.auth), ikm, 256),
        s.deriveKey(hkdf(INFO.path), ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
        s.deriveKey(hkdf(INFO.content), ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
        s.deriveKey(hkdf(INFO.nonce), ikm, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    ]);

    return { auth: new Uint8Array(auth), path, content, nonce };
}


/**
 * Seals bytes: deterministic, authenticated, reversible.
 *
 * Output is `nonce(12) || ciphertext || tag(16)`, so the overhead is 28 bytes
 * flat. The nonce is prepended rather than recomputed on open, because opening
 * would need the plaintext to recompute it and the plaintext is what it is
 * trying to produce.
 */
export async function seal(key: CryptoKey, nonceKey: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
    const s = subtle();
    const nonce = await syntheticNonce(nonceKey, plaintext);
    const sealed = await s.encrypt(
        { name: "AES-GCM", iv: toBuffer(nonce), tagLength: TAG_BITS },
        key,
        toBuffer(plaintext)
    );
    const out = new Uint8Array(NONCE_LENGTH + sealed.byteLength);
    out.set(nonce, 0);
    out.set(new Uint8Array(sealed), NONCE_LENGTH);
    return out;
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
        throw new Error(`sealed value is ${sealed.length} bytes, too short to contain a nonce and a tag`);
    }
    const s = subtle();
    const nonce = sealed.subarray(0, NONCE_LENGTH);
    const body = sealed.subarray(NONCE_LENGTH);
    try {
        const plain = await s.decrypt({ name: "AES-GCM", iv: toBuffer(nonce), tagLength: TAG_BITS }, key, toBuffer(body));
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
export async function sealPath(keys: VaultKeys, path: string): Promise<string> {
    return base64urlEncode(await seal(keys.path, keys.nonce, enc.encode(path)));
}

export async function openPath(keys: VaultKeys, sealedPath: string): Promise<string> {
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
export async function sealChunk(keys: VaultKeys, chunk: Uint8Array): Promise<Uint8Array> {
    const deflated = chunk.length === 0 ? undefined : deflateSync(chunk, { level: 6 });
    const useDeflate = deflated !== undefined && deflated.length < chunk.length;
    const payload = useDeflate ? deflated : chunk;

    const framed = new Uint8Array(1 + payload.length);
    framed[0] = useDeflate ? CHUNK_DEFLATE : CHUNK_RAW;
    framed.set(payload, 1);
    return seal(keys.content, keys.nonce, framed);
}

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
export async function sealChunks(keys: VaultKeys, chunks: Iterable<Uint8Array>): Promise<SealedChunk[]> {
    return Promise.all(
        [...chunks].map(async (chunk) => {
            const bytes = await sealChunk(keys, chunk);
            return { name: await chunkName(bytes), bytes };
        })
    );
}

export async function openChunk(keys: VaultKeys, sealed: Uint8Array): Promise<Uint8Array> {
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

/** The auth token as it goes on the wire. */
export function authToken(keys: VaultKeys): string {
    return base64urlEncode(keys.auth);
}

/* ---------------------------------------------------------------- *
 * Encoding
 * ---------------------------------------------------------------- */

/**
 * Copies a view's bytes into a standalone ArrayBuffer.
 *
 * WebCrypto accepts a BufferSource, but a Uint8Array that is a *view* into a
 * larger buffer has caused real bugs in this shape of code: passing the view
 * where the whole buffer is read hands over neighbouring data. Copying is cheap
 * at chunk sizes and removes the question.
 */
function toBuffer(view: Uint8Array): ArrayBuffer {
    return view.slice().buffer as ArrayBuffer;
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
    return out.subarray(0, o);
}
