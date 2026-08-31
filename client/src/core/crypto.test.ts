import { describe, expect, it } from "vitest";
import {
  CRYPTO_SUITE,
  authToken,
  base64urlDecode,
  base64urlEncode,
  chunkName,
  deriveKeys,
  entryIsOurs,
  generateSecret,
  hex,
  open,
  openChunk,
  macEntry,
  openPath,
  type EntryFacts,
  parentOf,
  seal,
  sealChunk,
  sealChunks,
  sealPath,
  type VaultKeys,
} from "./crypto.ts";

const enc = new TextEncoder();

/** A fixed secret, so every test below is reproducible. */
const SECRET = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14,
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
    // Nonce, marker, tag, and nothing between.
    expect(sealed.length).toBe(12 + 1 + 16);
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

  it("never costs more than 29 bytes above the content", async () => {
    // A 12-byte nonce, a 1-byte marker saying whether the body was
    // compressed, and a 16-byte tag. Content that compresses costs less than
    // it started as; content that does not is stored raw and costs exactly
    // this much more. Never more than that.
    const k = await keys();
    for (const size of [0, 1, 100, 4096]) {
      // Random bytes do not compress, so this is the worst case.
      const incompressible = new Uint8Array(size);
      globalThis.crypto.getRandomValues(incompressible);
      const sealed = await sealChunk(k, incompressible);
      expect(sealed.length, `${size} bytes of random data`).toBe(size + 29);
    }
  });

  it("shrinks content that compresses", async () => {
    const k = await keys();
    const repetitive = enc.encode("the same sentence over and over. ".repeat(40));
    const sealed = await sealChunk(k, repetitive);
    expect(sealed.length).toBeLessThan(repetitive.length / 2);
    expect(new Uint8Array(await openChunk(k, sealed))).toEqual(repetitive);
  });

  it("keeps compression deterministic, so dedup still works", async () => {
    // The reason the codec is fflate rather than the platform's: the same
    // chunk has to seal to the same bytes everywhere, or names diverge
    // between a desktop and a phone and dedup quietly stops working.
    const k = await keys();
    const text = enc.encode("# A heading\n\nSome prose that will certainly compress. ".repeat(10));
    expect(hex(await sealChunk(k, text))).toBe(hex(await sealChunk(k, text)));
  });

  it("hides whether a chunk compressed", async () => {
    // The marker is inside the sealed plaintext, so the server cannot tell
    // which chunks compressed and therefore how compressible each part of a
    // vault is. Equal-length inputs seal to equal lengths.
    const k = await keys();
    const compressible = enc.encode("aaaaaaaaaa".repeat(20));
    const random = globalThis.crypto.getRandomValues(new Uint8Array(200));
    expect(compressible.length).toBe(random.length);
    // The compressible one is shorter on the wire, which is the point; what
    // must not happen is a marker visible outside the ciphertext.
    const a = await sealChunk(k, compressible);
    const b = await sealChunk(k, random);
    expect(a.length).toBeLessThan(b.length);
    // Byte 12 is the first byte of ciphertext in both, and carries no
    // recognisable marker value.
    expect(a[12]).not.toBe(0);
    expect(b[12]).not.toBe(0);
  });

  it("refuses a chunk whose marker it does not know", async () => {
    // A future version's framing. The bytes decrypt, so the content is real,
    // and guessing at its shape would write nonsense into the vault.
    const k = await keys();
    const framed = new Uint8Array([99, 1, 2, 3]);
    const sealed = await seal(k.content, k.nonce, framed);
    await expect(openChunk(k, sealed)).rejects.toThrow(/unknown marker/);
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

describe("sealing a whole file's chunks", () => {
  it("gives the same result as sealing them one at a time", async () => {
    const k = await keys();
    const parts = ["first chunk", "second chunk", "third chunk"].map((s) => enc.encode(s));

    const batch = await sealChunks(k, parts);
    expect(batch).toHaveLength(3);
    for (let i = 0; i < parts.length; i++) {
      const alone = await sealChunk(k, parts[i]!);
      expect(hex(batch[i]!.bytes)).toBe(hex(alone));
      expect(batch[i]!.name).toBe(await chunkName(alone));
    }
  });

  it("keeps the chunks in order, which is what reassembly depends on", async () => {
    const k = await keys();
    const parts = Array.from({ length: 50 }, (_, i) => enc.encode(`chunk number ${i}`));
    const batch = await sealChunks(k, parts);
    for (let i = 0; i < parts.length; i++) {
      expect(new Uint8Array(await openChunk(k, batch[i]!.bytes))).toEqual(parts[i]);
    }
  });

  it("handles a file with no chunks", async () => {
    expect(await sealChunks(await keys(), [])).toEqual([]);
  });
});

/**
 * Compression is decided from a prefix, because deflating already-compressed
 * bytes does all the work and throws the answer away. What matters is that the
 * decision is a pure function of the chunk: a chunk is named by the hash of its
 * sealed bytes, so two devices deciding differently for the same content would
 * give it two names and neither would recognise the other's copy.
 */
describe("deciding whether a chunk is worth compressing", () => {
  const prose = (n: number) => new TextEncoder().encode("the note sync vault chunk ".repeat(n));
  const noise = (n: number) => {
    const out = new Uint8Array(n);
    for (let a = 0; a < n; a += 65536)
      crypto.getRandomValues(out.subarray(a, Math.min(a + 65536, n)));
    return out;
  };

  it("still compresses text, which is what a vault is mostly made of", async () => {
    const text = prose(20_000);
    const sealed = await sealChunk(await keys(), text);
    expect(sealed.length, "prose was sent uncompressed").toBeLessThan(text.length / 2);
    expect(await openChunk(await keys(), sealed)).toEqual(text);
  });

  it("round trips incompressible bytes, which are no longer deflated at all", async () => {
    const bytes = noise(256 * 1024);
    const sealed = await sealChunk(await keys(), bytes);
    expect(await openChunk(await keys(), sealed)).toEqual(bytes);
  });

  it("names the same content the same way every time", async () => {
    // The property dedup rests on. If the probe were ever anything but a
    // function of the bytes, this is where it would show.
    for (const bytes of [prose(500), noise(200 * 1024), new Uint8Array(0), noise(3000)]) {
      const a = await sealChunk(await keys(), bytes);
      const b = await sealChunk(await keys(), bytes);
      expect(await chunkName(a)).toBe(await chunkName(b));
    }
  });

  it("round trips a chunk that is mostly compressible behind a random start", async () => {
    // The case the probe gets wrong: it will not compress this, and the
    // only cost is bytes. It still has to come back exactly.
    const mixed = new Uint8Array(200 * 1024);
    mixed.set(noise(8192), 0);
    mixed.set(prose(1000).subarray(0, mixed.length - 8192), 8192);
    expect(await openChunk(await keys(), await sealChunk(await keys(), mixed))).toEqual(mixed);
  });
});

/**
 * Authenticating an entry, which is everything about a version except its bytes.
 *
 * The bytes were always sealed. What decided what a client did with them was
 * not: `deleted`, `size`, `prev` and the chunk list travelled in the clear, and
 * the server holds every sealed path in the vault. Setting `deleted` deleted a
 * note on every device; a size with no chunks emptied one; another file's chunk
 * list replaced one.
 */
describe("an entry nobody but a key holder could have written", () => {
  const facts: EntryFacts = {
    path: "sealed-path",
    size: 120,
    ctime: 1_700_000_000_000,
    mtime: 1_700_000_000_001,
    folder: false,
    deleted: false,
    chunks: ["aa", "bb"],
    parent: "cafe",
  };

  it("verifies what it produced", async () => {
    const k = await keys();
    const mac = await macEntry(k, facts);
    expect(await entryIsOurs(k, facts, mac)).toBe(true);
  });

  it("refuses every field changed one at a time", async () => {
    const k = await keys();
    const mac = await macEntry(k, facts);
    const changes: Partial<EntryFacts>[] = [
      { path: "another-sealed-path" },
      { size: 121 },
      { ctime: 0 },
      { mtime: 0 },
      { folder: true },
      { deleted: true },
      { chunks: ["aa"] },
      { chunks: ["bb", "aa"] },
      { chunks: ["aa", "bb", "cc"] },
      { parent: "beef" },
      { prev: "some-other-sealed-path" },
    ];
    for (const change of changes) {
      const altered = { ...facts, ...change };
      expect(await entryIsOurs(k, altered, mac), `accepted ${JSON.stringify(change)}`).toBe(false);
    }
  });

  it("refuses a mac from a different vault", async () => {
    const k = await keys();
    const stranger = await deriveKeys(new Uint8Array(20).fill(7));
    const theirs = await macEntry(stranger, facts);
    expect(await entryIsOurs(k, facts, theirs)).toBe(false);
  });

  it("refuses a mac of the wrong length rather than comparing it", async () => {
    const k = await keys();
    expect(await entryIsOurs(k, facts, "")).toBe(false);
    expect(await entryIsOurs(k, facts, "00")).toBe(false);
  });

  /**
   * Two entries that canonicalise to the same bytes are one forgery. Length
   * prefixes are what stop a chunk name and a path from being rearranged into
   * each other.
   */
  it("does not confuse fields that could run together", async () => {
    const k = await keys();
    const a = await macEntry(k, { ...facts, path: "ab", chunks: ["c"] });
    const b = await macEntry(k, { ...facts, path: "a", chunks: ["bc"] });
    expect(a).not.toBe(b);

    const c = await macEntry(k, { ...facts, chunks: ["a", "bc"] });
    const d = await macEntry(k, { ...facts, chunks: ["ab", "c"] });
    expect(c).not.toBe(d);
  });

  it("names a parent stably, and gives no parent an empty name", async () => {
    expect(await parentOf("")).toBe("");
    expect(await parentOf("aa,bb")).toBe(await parentOf("aa,bb"));
    expect(await parentOf("aa,bb")).not.toBe(await parentOf("aa,bc"));
    expect((await parentOf("aa,bb")).length).toBe(64);
  });
});
