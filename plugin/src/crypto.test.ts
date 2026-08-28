import { describe, expect, it } from "vitest";
import {
    CRYPTO_SUITE,
    PBKDF2_ITERATIONS,
    authToken,
    base64urlDecode,
    base64urlEncode,
    chunkName,
    deriveKeys,
    deriveKeysFromPassphrase,
    generateSecret,
    hex,
    open,
    openChunk,
    openPath,
    seal,
    sealChunk,
    sealPath,
    type VaultKeys,
} from "./crypto.ts";

const enc = new TextEncoder();

/** A fixed secret, so every test below is reproducible. */
const SECRET = new Uint8Array([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13,
    0x14,
]);

async function keys(): Promise<VaultKeys> {
    return deriveKeys(SECRET);
}

describe("the key schedule", () => {
    it("derives the same keys from the same secret, every time", async () => {
        // If this ever stops holding, every device pairs into a different vault
        // and none of them can read the others.
        const a = await keys();
        const b = await keys();
        expect(hex(a.auth)).toBe(hex(b.auth));
        expect(await sealPath(a, "notes/a.md")).toBe(await sealPath(b, "notes/a.md"));
    });

    it("derives different keys from different secrets", async () => {
        const other = new Uint8Array(SECRET);
        other[0] = (other[0] ?? 0) ^ 0xff;
        const a = await keys();
        const b = await deriveKeys(other);
        expect(hex(a.auth)).not.toBe(hex(b.auth));
    });

    it("separates the four keys, so one purpose cannot open another's", async () => {
        const k = await keys();
        const sealedPath = await seal(k.path, k.nonce, enc.encode("notes/secret.md"));

        // The content key must not open a path seal. Domain separation by HKDF
        // info string is what makes that true, and it is the reason compromise
        // of the auth half says nothing about the content half.
        await expect(open(k.content, sealedPath)).rejects.toThrow(/authentication/);
    });

    it("refuses a secret with too little entropy to be one", async () => {
        // Silently accepting a short secret produces a vault that looks
        // encrypted and is not.
        await expect(deriveKeys(new Uint8Array(8))).rejects.toThrow(/at least 16/);
    });

    it("derives reproducibly from a passphrase and its salt", async () => {
        const salt = new Uint8Array(16).fill(7);
        const a = await deriveKeysFromPassphrase("correct horse battery staple", salt);
        const b = await deriveKeysFromPassphrase("correct horse battery staple", salt);
        expect(hex(a.auth)).toBe(hex(b.auth));

        // The salt is not secret but it is necessary: lose it and the same
        // passphrase opens nothing.
        const other = await deriveKeysFromPassphrase("correct horse battery staple", new Uint8Array(16).fill(8));
        expect(hex(other.auth)).not.toBe(hex(a.auth));
    });

    it("keeps the PBKDF2 cost where guessing stays expensive", () => {
        // A policy assertion, not a behavioural one: lowering the count breaks
        // nothing observable, and a passphrase-derived vault becomes cheap to
        // attack. 310,000 is OWASP's figure for PBKDF2-HMAC-SHA256. Making it a
        // test means lowering it has to be deliberate.
        expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(310_000);
    });

    it("names a suite the server also names", () => {
        expect(CRYPTO_SUITE).toBe("basalt/hkdf-aes-gcm/1");
    });

    it("produces a wire-safe auth token", async () => {
        const k = await keys();
        expect(authToken(k)).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});

describe("sealing", () => {
    it("round trips", async () => {
        const k = await keys();
        const plain = enc.encode("# A note\n\nWith some content.\n");
        const sealed = await sealChunk(k, plain);
        expect(new Uint8Array(await openChunk(k, sealed))).toEqual(plain);
    });

    it("round trips an empty input", async () => {
        const k = await keys();
        const sealed = await sealChunk(k, new Uint8Array(0));
        expect((await openChunk(k, sealed)).length).toBe(0);
        // Still authenticated: nonce plus tag and nothing between.
        expect(sealed.length).toBe(12 + 16);
    });

    it("round trips bytes that are not text", async () => {
        const k = await keys();
        const plain = new Uint8Array(1024);
        for (let i = 0; i < plain.length; i++) plain[i] = (i * 7) & 0xff;
        const sealed = await sealChunk(k, plain);
        expect(new Uint8Array(await openChunk(k, sealed))).toEqual(plain);
    });

    /**
     * The property the whole design rests on, and the one whose failure is
     * silent. Without it every upload gets a fresh chunk name, content-defined
     * chunking cuts at the right boundaries, and the client re-sends everything
     * for ever while reporting success.
     */
    it("is deterministic, which is what makes deduplication work at all", async () => {
        const k = await keys();
        const plain = enc.encode("a chunk that appears in two files");

        const first = await sealChunk(k, plain);
        const second = await sealChunk(k, plain);
        expect(hex(first)).toBe(hex(second));
        expect(await chunkName(first)).toBe(await chunkName(second));
    });

    it("is deterministic across separate key derivations", async () => {
        // Two devices, same secret, same chunk. They must agree or neither
        // deduplicates against the other's uploads.
        const deviceA = await deriveKeys(SECRET);
        const deviceB = await deriveKeys(SECRET);
        const plain = enc.encode("shared paragraph");
        expect(hex(await sealChunk(deviceA, plain))).toBe(hex(await sealChunk(deviceB, plain)));
    });

    it("gives different plaintexts different nonces", async () => {
        const k = await keys();
        const a = await sealChunk(k, enc.encode("one"));
        const b = await sealChunk(k, enc.encode("two"));
        // Distinct nonces are what keeps determinism from being nonce reuse in
        // the dangerous sense.
        expect(hex(a.subarray(0, 12))).not.toBe(hex(b.subarray(0, 12)));
    });

    it("costs 28 bytes, flat", async () => {
        const k = await keys();
        for (const size of [0, 1, 100, 4096]) {
            const sealed = await sealChunk(k, new Uint8Array(size));
            expect(sealed.length).toBe(size + 28);
        }
    });

    it("refuses a tampered body rather than returning what it can", async () => {
        const k = await keys();
        const sealed = await sealChunk(k, enc.encode("the original bytes"));
        const tampered = new Uint8Array(sealed);
        tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
        await expect(openChunk(k, tampered)).rejects.toThrow(/authentication/);
    });

    it("refuses a tampered nonce", async () => {
        const k = await keys();
        const sealed = await sealChunk(k, enc.encode("the original bytes"));
        const tampered = new Uint8Array(sealed);
        tampered[0] = (tampered[0] ?? 0) ^ 0x01;
        await expect(openChunk(k, tampered)).rejects.toThrow(/authentication/);
    });

    it("refuses a value too short to be sealed", async () => {
        const k = await keys();
        await expect(openChunk(k, new Uint8Array(20))).rejects.toThrow(/too short/);
    });

    it("refuses a value sealed under another secret", async () => {
        const mine = await keys();
        const other = new Uint8Array(SECRET);
        other[19] = (other[19] ?? 0) ^ 0xff;
        const theirs = await deriveKeys(other);

        const sealed = await sealChunk(theirs, enc.encode("not for you"));
        await expect(openChunk(mine, sealed)).rejects.toThrow(/authentication/);
    });
});

describe("paths", () => {
    it("round trip, including the characters that break sync implementations", async () => {
        const k = await keys();
        const paths = [
            "note.md",
            "folder/sub folder/note.md",
            "notes/2026-08-27 meeting: with a colon.md",
            "emoji 🗿 basalt.md",
            "accents éàü and a ' quote.md",
            "very/" + "deep/".repeat(20) + "note.md",
            "trailing space .md",
            "a\\backslash.md",
        ];
        for (const p of paths) {
            const sealed = await sealPath(k, p);
            expect(sealed, `${p} must be wire safe`).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(await openPath(k, sealed), p).toBe(p);
        }
    });

    it("is deterministic, so the server can tell two versions of one file apart", async () => {
        const k = await keys();
        expect(await sealPath(k, "notes/a.md")).toBe(await sealPath(k, "notes/a.md"));
    });

    it("gives different paths different ciphertext", async () => {
        const k = await keys();
        expect(await sealPath(k, "notes/a.md")).not.toBe(await sealPath(k, "notes/b.md"));
    });

    /**
     * The trap in copying LiveSync's V2 path obfuscation, which is a one-way
     * HMAC. A device receiving an entry for a file it has never seen must
     * recover the name to write it to disk; LiveSync only gets away with a
     * hash because it keeps a second copy of the name inside the document.
     */
    it("is reversible, unlike a hash", async () => {
        const k = await keys();
        const sealed = await sealPath(k, "some/unseen/file.md");
        expect(await openPath(k, sealed)).toBe("some/unseen/file.md");
    });

    it("stays inside the server's path bound for a realistic path", async () => {
        const k = await keys();
        // The server refuses a path over 4096 bytes. Sealing adds 28 bytes and
        // base64url adds a third, so this checks the headroom is real rather
        // than assumed.
        const long = "folder/".repeat(30) + "a fairly long note title about something.md";
        const sealed = await sealPath(k, long);
        expect(long.length).toBeGreaterThan(250);
        expect(sealed.length).toBeLessThan(4096);
    });
});

describe("chunk names", () => {
    /**
     * Pinned against the Go server's chunks.Name. A disagreement here means
     * every upload is refused as corrupt, which is at least loud, but the
     * vectors make it a test failure instead of a field report.
     */
    it("agrees with the server, byte for byte", async () => {
        const vectors: [Uint8Array, string][] = [
            [new Uint8Array(0), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
            [enc.encode("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"],
            [
                enc.encode("the quick brown fox"),
                "9ecb36561341d18eb65484e833efea61edc74b84cf5e6ae1b81c63533e25fc8f",
            ],
            [
                new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0xfe, 0x01]),
                "11a374c7aa6de48cc311c32b9fcad7c0ca6c943410bbc7871458f1fb7a294b1d",
            ],
        ];
        for (const [input, want] of vectors) {
            expect(await chunkName(input)).toBe(want);
        }
    });

    it("is 64 lowercase hex characters, which is what the server accepts", async () => {
        const name = await chunkName(enc.encode("anything"));
        expect(name).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("base64url", () => {
    it("round trips every byte value", async () => {
        const all = new Uint8Array(256);
        for (let i = 0; i < 256; i++) all[i] = i;
        expect(base64urlDecode(base64urlEncode(all))).toEqual(all);
    });

    it("round trips every length modulo 3, where padding bugs live", () => {
        for (let n = 0; n <= 12; n++) {
            const bytes = new Uint8Array(n);
            for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) & 0xff;
            expect(base64urlDecode(base64urlEncode(bytes)), `length ${n}`).toEqual(bytes);
        }
    });

    it("emits no padding and nothing needing escaping in JSON or a URL", () => {
        for (let n = 1; n <= 8; n++) {
            expect(base64urlEncode(new Uint8Array(n))).toMatch(/^[A-Za-z0-9_-]+$/);
        }
    });

    it("refuses a mangled value rather than decoding around it", () => {
        // Decoding around a stray character produces plausible bytes that fail
        // authentication later, further from the cause.
        expect(() => base64urlDecode("abc$def")).toThrow(/invalid base64url/);
        expect(() => base64urlDecode("abc=")).toThrow(/invalid base64url/);
    });
});

describe("generateSecret", () => {
    it("returns 20 unpredictable bytes", () => {
        const a = generateSecret();
        const b = generateSecret();
        expect(a.length).toBe(20);
        expect(hex(a)).not.toBe(hex(b));
    });
});
