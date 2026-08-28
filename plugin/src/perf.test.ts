/**
 * Speed, as tests.
 *
 * Most of these assert **bytes on the wire**, not elapsed time, and that is
 * deliberate. Wall-clock assertions fail on a busy machine and pass on a fast
 * one, so they get loosened until they mean nothing; and the reason Basalt is
 * fast is not that its arithmetic is clever, it is that it sends less. That is a
 * property, and a property can be asserted exactly.
 *
 * The comparison throughout is against **whole-file sync**, which is what
 * Obsidian Sync does: its engine keeps one hash per file and pushes the entire
 * body on any change, verified in the extracted engine at
 * `obsidian-sync-engine.js:1778` where `readBinary(path)` feeds straight into
 * `push(..., hash, data)`. There is no chunk-level dedup to be had there, so an
 * edit to a large note costs the note.
 *
 * Wall-clock throughput lives in `bench.ts` and is reported, not asserted. The
 * chunker measures 575 MiB/s under `bun run` and 32 MiB/s under vitest, an 18x
 * spread from the runner alone, and a floor loose enough to survive that would
 * catch nothing. Reporting a number somebody reads beats a gate nobody trusts.
 */

import { describe, expect, it } from "vitest";
import { chunkBytes, sizesFor, type ChunkSizes } from "./chunk.ts";
import { deriveKeys, sealChunks } from "./crypto.ts";

const enc = new TextEncoder();

/**
 * Bytes on the wire are measured by sealing for real, not estimated.
 *
 * Sealing compresses, so a plaintext length plus a constant would understate the
 * win and, worse, would stop tracking the thing being claimed. It costs a few
 * hundred milliseconds across this file and it means these numbers are the
 * numbers.
 */
const KEY = await deriveKeys(new Uint8Array(20).fill(11));

/** Prose with enough variety to behave like real text. */
function note(bytes: number, seed = 1): Uint8Array {
    let s = seed;
    const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff);
    let out = "# A note\n\n";
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

function key(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

/** What a client would actually transmit to sync `edited` when the server already has `original`. */
async function bytesOnWire(original: Uint8Array, edited: Uint8Array, sizes: ChunkSizes, isText: boolean) {
    const held = new Set([...chunkBytes(original, sizes, isText)].map((c) => key(c.bytes)));
    let bytes = 0;
    let changed = 0;
    let total = 0;
    const send: Uint8Array[] = [];
    for (const c of chunkBytes(edited, sizes, isText)) {
        total++;
        if (!held.has(key(c.bytes))) {
            changed++;
            send.push(c.bytes);
        }
    }
    for (const sealed of await sealChunks(KEY, send)) bytes += sealed.bytes.length;
    return { bytes, changed, total };
}

/** Random bytes of any length. getRandomValues caps each call at 64 KiB. */
function randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let at = 0; at < n; at += 65536) {
        globalThis.crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, n)));
    }
    return out;
}

/** Inserts a line at a line boundary about a third of the way in. */
function insertLine(data: Uint8Array, text = "\nA line added by hand.\n"): Uint8Array {
    const ins = enc.encode(text);
    const at = data.indexOf(10, Math.floor(data.length / 3)) + 1;
    const out = new Uint8Array(data.length + ins.length);
    out.set(data.subarray(0, at));
    out.set(ins, at);
    out.set(data.subarray(at), at + ins.length);
    return out;
}

describe("what an edit costs", () => {
    /**
     * The headline. Editing one line of a large note should cost a chunk, not a
     * note. Whole-file sync cannot do better than the file.
     */
    it("sends a small multiple of the edit, not the note", async () => {
        for (const size of [64 * 1024, 256 * 1024, 1024 * 1024]) {
            const original = note(size);
            const edited = insertLine(original);
            const sizes = sizesFor(original.length, true);

            const { bytes, changed, total } = await bytesOnWire(original, edited, sizes, true);

            // A one-line insert touches the chunk containing it, and sometimes
            // the one after, since the boundary may move once before the hash
            // re-syncs. More than a handful would mean the rolling hash is not
            // doing its job.
            expect(changed, `${size} byte note changed ${changed} of ${total} chunks`).toBeLessThanOrEqual(3);

            // And in bytes, against sending the file.
            const ratio = edited.length / bytes;
            expect(ratio, `${size} byte note: only ${ratio.toFixed(0)}x better than whole-file`).toBeGreaterThan(
                size / 8192
            );
        }
    });

    it("beats whole-file sync by more, the larger the note", async () => {
        // The advantage is not a constant factor, it grows with the file, which
        // is the property that matters for a vault of long notes.
        const ratios: number[] = [];
        for (const size of [32 * 1024, 128 * 1024, 512 * 1024]) {
            const original = note(size);
            const edited = insertLine(original);
            const { bytes } = await bytesOnWire(original, edited, sizesFor(size, true), true);
            ratios.push(edited.length / bytes);
        }
        expect(ratios[0]!).toBeLessThan(ratios[1]!);
        expect(ratios[1]!).toBeLessThan(ratios[2]!);
        expect(ratios[2]!).toBeGreaterThan(50);
    });

    it("sends nothing at all for a file that did not change", async () => {
        // The cheapest case has to actually be free. A client that re-sends
        // unchanged chunks would be slower than whole-file sync, not faster,
        // because it would also pay per-chunk overhead.
        const data = note(128 * 1024);
        const { bytes, changed } = await bytesOnWire(data, data, sizesFor(data.length, true), true);
        expect(changed).toBe(0);
        expect(bytes).toBe(0);
    });

    it("sends only the appended part when a note is appended to", async () => {
        // The daily-note case, and the most common write there is.
        const original = note(256 * 1024);
        const extra = enc.encode("\n- one more line for today\n");
        const edited = new Uint8Array(original.length + extra.length);
        edited.set(original);
        edited.set(extra, original.length);

        const { bytes } = await bytesOnWire(original, edited, sizesFor(original.length, true), true);
        // The tail chunk is rewritten, so a few hundred bytes rather than 256 KiB.
        expect(bytes).toBeLessThan(4096);
    });

    it("sends only the changed region of a large attachment", async () => {
        // Binary chunking is coarser, so the win is smaller, and it should still
        // be a fraction of the file rather than all of it.
        const size = 8 * 1024 * 1024;
        const original = new Uint8Array(size);
        for (let i = 0; i < size; i++) original[i] = (Math.imul(i, 2654435761) >>> 24) & 0xff;
        const edited = new Uint8Array(original);
        edited.set(enc.encode("a patch applied in the middle"), size >> 1);

        const sizes = sizesFor(size, false);
        const { bytes, changed, total } = await bytesOnWire(original, edited, sizes, false);
        expect(changed, `${changed} of ${total} chunks`).toBeLessThanOrEqual(2);
        expect(bytes).toBeLessThan(size / 4);
    });

    it("sends a full upload for less than the plaintext", async () => {
        // The per-chunk overhead is 29 bytes, which at prose chunk sizes is
        // about 11% on top. Compression more than pays for it, so a first sync
        // moves fewer bytes than the vault contains. Measured at 67% of
        // plaintext across a real vault's text.
        const data = note(512 * 1024);
        const sizes = sizesFor(data.length, true);
        const chunks = [...chunkBytes(data, sizes, true)].map((c) => c.bytes);
        const sealed = await sealChunks(KEY, chunks);
        const wire = sealed.reduce((n, c) => n + c.bytes.length, 0);
        const ratio = wire / data.length;
        expect(ratio, `a full upload cost ${(ratio * 100).toFixed(0)}% of the plaintext`).toBeLessThan(1);
    });

    it("never costs more than 29 bytes a chunk, even on incompressible content", async () => {
        // The bound that has to hold whatever the content: an attachment full of
        // already-compressed bytes must not grow beyond the marker, nonce and
        // tag. LiveSync base64s binary chunks, which is a third on top of
        // everything; sending bytes as bytes is what avoids that.
        const size = 512 * 1024;
        const data = randomBytes(size);
        const chunks = [...chunkBytes(data, sizesFor(size, false), false)].map((c) => c.bytes);
        const sealed = await sealChunks(KEY, chunks);
        const wire = sealed.reduce((n, c) => n + c.bytes.length, 0);
        expect(wire).toBe(size + 29 * chunks.length);
        expect((wire - size) / size).toBeLessThan(0.01);
    });
});

describe("cost per file, in operations", () => {
    it("costs three crypto calls per chunk and no more", async () => {
        // The driver of initial-sync time, and a number rather than a feeling:
        // an HMAC for the nonce, the seal, and a SHA-256 for the name. Anything
        // that adds a fourth doubles a large vault's first sync for a third more
        // work, so the count is pinned.
        const k = await deriveKeys(new Uint8Array(20).fill(3));
        const subtle = globalThis.crypto.subtle;
        const counts: Record<string, number> = {};
        const wrap = <T extends keyof SubtleCrypto>(name: T) => {
            const original = subtle[name] as (...a: unknown[]) => unknown;
            return (...args: unknown[]) => {
                const alg = args[0];
                const label = typeof alg === "string" ? alg : ((alg as { name: string })?.name ?? String(name));
                counts[`${String(name)}:${label}`] = (counts[`${String(name)}:${label}`] ?? 0) + 1;
                return original.apply(subtle, args);
            };
        };
        const originals = { sign: subtle.sign, encrypt: subtle.encrypt, digest: subtle.digest };
        (subtle as unknown as Record<string, unknown>).sign = wrap("sign");
        (subtle as unknown as Record<string, unknown>).encrypt = wrap("encrypt");
        (subtle as unknown as Record<string, unknown>).digest = wrap("digest");
        try {
            await sealChunks(k, [enc.encode("one"), enc.encode("two"), enc.encode("three")]);
        } finally {
            Object.assign(subtle, originals);
        }

        expect(counts["sign:HMAC"]).toBe(3);
        expect(counts["encrypt:AES-GCM"]).toBe(3);
        expect(counts["digest:SHA-256"]).toBe(3);
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(9);
    });

    it("derives keys once, not once per chunk", async () => {
        // 310,000 PBKDF2 iterations is a visible pause on a phone. Doing it per
        // file would make a first sync unusable, and the only thing stopping
        // that is that the key schedule is separate from sealing.
        const k = await deriveKeys(new Uint8Array(20).fill(5));
        const subtle = globalThis.crypto.subtle;
        const original = subtle.deriveKey;
        let derived = 0;
        (subtle as unknown as Record<string, unknown>).deriveKey = (...args: unknown[]) => {
            derived++;
            return (original as (...a: unknown[]) => unknown).apply(subtle, args);
        };
        try {
            await sealChunks(k, Array.from({ length: 20 }, (_, i) => enc.encode(`chunk ${i}`)));
        } finally {
            subtle.deriveKey = original;
        }
        expect(derived).toBe(0);
    });
});
