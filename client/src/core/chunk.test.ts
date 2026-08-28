import { describe, expect, it } from "vitest";
import {
    BINARY_SIZES,
    TEXT_AS_BINARY_ABOVE,
    TEXT_SIZES,
    WINDOW,
    blobBlocks,
    chunkBytes,
    chunkStream,
    looksLikeText,
    sizesFor,
    textSizesFor,
    type Chunk,
    type ChunkSizes,
} from "./chunk.ts";
import { SEAL_OVERHEAD, deriveKeys, sealChunks } from "./crypto.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function collect(data: Uint8Array, sizes: ChunkSizes, isUtf8 = true): Chunk[] {
    return [...chunkBytes(data, sizes, isUtf8)];
}

async function collectStream(data: Uint8Array, sizes: ChunkSizes, isUtf8 = true, blockSize = 7): Promise<Chunk[]> {
    async function* blocks() {
        for (let i = 0; i < data.length; i += blockSize) {
            yield data.subarray(i, Math.min(i + blockSize, data.length));
        }
    }
    const out: Chunk[] = [];
    for await (const c of chunkStream(blocks(), sizes, isUtf8)) out.push(c);
    return out;
}

function joined(chunks: Chunk[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.bytes.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        out.set(c.bytes, at);
        at += c.bytes.length;
    }
    return out;
}

/**
 * Prose-like text, deterministic so failures reproduce.
 *
 * The variety matters. An earlier version cycled eleven words, and chunks then
 * repeated so often by chance that a splitter with its rolling window removed
 * still scored above 90% on the locality test. Measured against real markdown
 * the difference is 98.7% against 21.4%, so the corpus has to be varied enough
 * to show it.
 */
function prose(bytes: number, seed = 1): Uint8Array {
    let s = seed;
    const rnd = () => {
        s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
        return s;
    };
    let out = "";
    let n = 0;
    while (out.length < bytes) {
        // A pronounceable nonsense word, so every position is close to unique.
        const len = 3 + (rnd() % 8);
        let w = "";
        for (let i = 0; i < len; i++) {
            w += "abcdefghijklmnopqrstuvwxyz"[rnd() % 26];
        }
        out += w;
        n++;
        out += n % 13 === 0 ? ".\n" : n % 41 === 0 ? "\n\n## Heading\n\n" : " ";
    }
    return enc.encode(out.slice(0, bytes));
}

describe("reassembly", () => {
    it("loses nothing, at any size", () => {
        for (const size of [0, 1, 47, 48, 49, 127, 128, 1000, 10_000, 100_000]) {
            const data = prose(size);
            const chunks = collect(data, TEXT_SIZES);
            expect(joined(chunks), `size ${size}`).toEqual(data);
        }
    });

    it("reports offsets that describe where the bytes came from", () => {
        const data = prose(50_000);
        let expected = 0;
        for (const c of collect(data, TEXT_SIZES)) {
            expect(c.offset).toBe(expected);
            expect(c.bytes).toEqual(data.subarray(c.offset, c.offset + c.bytes.length));
            expected += c.bytes.length;
        }
        expect(expected).toBe(data.length);
    });

    it("produces no chunks for an empty file", () => {
        // Not one empty chunk. The protocol says a file has chunks if and only
        // if it has content, and the server refuses a zero-byte file that
        // carries any.
        expect(collect(new Uint8Array(0), TEXT_SIZES)).toHaveLength(0);
    });

    it("handles bytes that are not text at all", () => {
        const data = new Uint8Array(200_000);
        for (let i = 0; i < data.length; i++) data[i] = (Math.imul(i, 2654435761) >>> 24) & 0xff;
        const chunks = collect(data, { min: 1024, avg: 4096, max: 16384 }, false);
        expect(joined(chunks)).toEqual(data);
    });
});

describe("the size bounds", () => {
    it("keeps every chunk inside min and max, except the last", () => {
        const data = prose(200_000);
        const chunks = collect(data, TEXT_SIZES);
        chunks.forEach((c, i) => {
            expect(c.bytes.length, `chunk ${i} over max`).toBeLessThanOrEqual(TEXT_SIZES.max);
            if (i < chunks.length - 1) {
                // The last chunk is whatever is left and may be short; every
                // other one was cut deliberately.
                expect(c.bytes.length, `chunk ${i} under min`).toBeGreaterThanOrEqual(TEXT_SIZES.min);
            }
        });
    });

    it("cuts at the maximum when the content offers no boundary", () => {
        // A single repeated byte gives the rolling hash nothing to vary, so
        // without a forced cut this would be one chunk of 100 KB and the server
        // would refuse it.
        const data = new Uint8Array(100_000).fill(0x41);
        const chunks = collect(data, TEXT_SIZES);
        for (const c of chunks.slice(0, -1)) {
            expect(c.bytes.length).toBeLessThanOrEqual(TEXT_SIZES.max);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(Math.floor(100_000 / TEXT_SIZES.max));
        expect(joined(chunks)).toEqual(data);
    });

    it("averages somewhere near the target", () => {
        // Rule 8: the figure is the evidence. An average far from the target
        // means the boundary test is not firing as designed, which no
        // correctness assertion would catch.
        const data = prose(400_000);
        const chunks = collect(data, TEXT_SIZES);
        const mean = data.length / chunks.length;
        expect(mean).toBeGreaterThan(TEXT_SIZES.min);
        expect(mean).toBeLessThan(TEXT_SIZES.max);
    });
});

describe("insert locality, which is the whole point", () => {
    /**
     * The property content-defined chunking exists for. With fixed offsets, an
     * insert near the start shifts every later boundary and the entire file
     * re-uploads. Here it should change one chunk.
     */
    it("an insert near the start changes almost nothing further down", () => {
        const original = prose(200_000);
        const insert = enc.encode("A NEW SENTENCE INSERTED HERE. ");
        const edited = new Uint8Array(original.length + insert.length);
        edited.set(original.subarray(0, 1000), 0);
        edited.set(insert, 1000);
        edited.set(original.subarray(1000), 1000 + insert.length);

        const before = collect(original, TEXT_SIZES).map((c) => dec.decode(c.bytes));
        const after = collect(edited, TEXT_SIZES).map((c) => dec.decode(c.bytes));

        const shared = new Set(before);
        const reused = after.filter((c) => shared.has(c)).length;
        const fraction = reused / after.length;

        // Measured at 98.7% on 316 real markdown files over 8 KB, against 21.4%
        // for the same splitter with its rolling window removed. The bar is 95%:
        // high enough that losing the window fails, loose enough that the test
        // is about the property and not this corpus.
        expect(fraction, `only ${(fraction * 100).toFixed(1)}% of chunks were reused`).toBeGreaterThan(0.95);
    });

    it("a fixed-size split would not manage that", () => {
        // The comparison that justifies the algorithm. Same edit, fixed 256-byte
        // boundaries: everything after the insert shifts and almost nothing is
        // reusable.
        const original = prose(200_000);
        const insert = enc.encode("A NEW SENTENCE INSERTED HERE. ");
        const edited = new Uint8Array(original.length + insert.length);
        edited.set(original.subarray(0, 1000), 0);
        edited.set(insert, 1000);
        edited.set(original.subarray(1000), 1000 + insert.length);

        const fixed = (d: Uint8Array) => {
            const out: string[] = [];
            for (let i = 0; i < d.length; i += 256) out.push(dec.decode(d.subarray(i, i + 256)));
            return out;
        };
        const before = new Set(fixed(original));
        const after = fixed(edited);
        const fraction = after.filter((c) => before.has(c)).length / after.length;
        expect(fraction).toBeLessThan(0.2);
    });

    it("an append leaves the earlier chunks alone", () => {
        const original = prose(100_000);
        const extra = prose(5_000, 99);
        const appended = new Uint8Array(original.length + extra.length);
        appended.set(original, 0);
        appended.set(extra, original.length);

        const before = collect(original, TEXT_SIZES);
        const after = collect(appended, TEXT_SIZES);

        // Every chunk of the original except its last, which was a short
        // remainder and is now part of a full one, should reappear unchanged.
        for (let i = 0; i < before.length - 1; i++) {
            expect(dec.decode(after[i]!.bytes), `chunk ${i} moved`).toBe(dec.decode(before[i]!.bytes));
        }
    });
});

describe("UTF-8 boundaries", () => {
    it("never cuts a multi-byte character", () => {
        // Dense multi-byte content at a small chunk size, so boundary
        // candidates land inside characters constantly.
        let text = "";
        for (let i = 0; i < 4000; i++) text += "日本語のノート🗿 basalt ";
        const data = enc.encode(text);
        const sizes: ChunkSizes = { min: 64, avg: 128, max: 512 };

        for (const c of chunkBytes(data, sizes, true)) {
            // A continuation byte first means the previous chunk ended inside a
            // character.
            expect((c.bytes[0]! & 0xc0) === 0x80, `chunk at ${c.offset} starts mid-character`).toBe(false);
        }
        expect(joined([...chunkBytes(data, sizes, true)])).toEqual(data);
    });

    it("keeps each chunk independently decodable", () => {
        let text = "";
        for (let i = 0; i < 2000; i++) text += `émoji 🗿 ${i} ünïcödé `;
        const data = enc.encode(text);
        const strict = new TextDecoder("utf-8", { fatal: true });

        let rebuilt = "";
        for (const c of chunkBytes(data, { min: 64, avg: 128, max: 512 }, true)) {
            // Would throw if the chunk were not valid UTF-8 on its own. That is
            // what makes a chunk something a human can look at.
            rebuilt += strict.decode(c.bytes);
        }
        expect(rebuilt).toBe(text);
    });
});

describe("streaming", () => {
    it("agrees with the in-memory splitter, byte for byte", async () => {
        // Two implementations of one algorithm is two chances to be wrong, so
        // they are pinned to each other rather than each to a fixture.
        for (const size of [0, 1, 200, 5_000, 60_000]) {
            const data = prose(size, 5);
            const memory = collect(data, TEXT_SIZES);
            const streamed = await collectStream(data, TEXT_SIZES);
            expect(streamed.map((c) => c.bytes.length), `size ${size} lengths`).toEqual(
                memory.map((c) => c.bytes.length)
            );
            expect(joined(streamed), `size ${size} content`).toEqual(data);
        }
    });

    it("agrees with the in-memory splitter on multi-byte text too", async () => {
        // The ASCII case above never exercises the trim, and the trim is where
        // the two implementations previously disagreed: one deferred its
        // decision by a byte and the other did not, so forced cuts came out
        // differently and nothing noticed.
        let text = "";
        for (let i = 0; i < 2500; i++) text += `日本語 ${i} ünïcödé 🗿 `;
        const data = enc.encode(text);
        const sizes: ChunkSizes = { min: 64, avg: 128, max: 300 };

        const memory = collect(data, sizes, true);
        for (const blockSize of [1, 5, 64, 4096]) {
            const streamed = await collectStream(data, sizes, true, blockSize);
            expect(streamed.map((c) => c.bytes.length), `blocks of ${blockSize}`).toEqual(
                memory.map((c) => c.bytes.length)
            );
            expect(joined(streamed)).toEqual(data);
        }
    });

    it("agrees when the minimum is below the window, where the hash reset matters", async () => {
        // With min above WINDOW the rolling hash has forgotten everything before
        // the chunk by the time a boundary can fire, so resetting it at each cut
        // changes nothing observable. Below the window it does: a boundary can
        // be tested while the hash still carries bytes from the previous chunk,
        // and the two implementations only agree because both reset.
        const data = prose(40_000, 13);
        const sizes: ChunkSizes = { min: 16, avg: 32, max: 128 };
        expect(sizes.min).toBeLessThan(WINDOW);

        const memory = collect(data, sizes, true);
        const streamed = await collectStream(data, sizes, true, 11);
        expect(streamed.map((c) => c.bytes.length)).toEqual(memory.map((c) => c.bytes.length));
        expect(joined(memory)).toEqual(data);
    });

    it("does not care how the input is blocked", async () => {
        const data = prose(30_000, 7);
        const reference = collect(data, TEXT_SIZES).map((c) => c.bytes.length);
        for (const blockSize of [1, 3, 47, 48, 49, 1024, 100_000]) {
            const streamed = await collectStream(data, TEXT_SIZES, true, blockSize);
            expect(streamed.map((c) => c.bytes.length), `blocks of ${blockSize}`).toEqual(reference);
        }
    });

    it("keeps multi-byte characters whole, one byte at a time", async () => {
        // The streaming path takes its boundary decision one byte late, against
        // the byte already in hand, because a stream offers no lookahead. Every
        // other streaming test here is ASCII, so without this the lookahead is
        // untested.
        let text = "";
        for (let i = 0; i < 3000; i++) text += "日本語のノート🗿 basalt ";
        const data = enc.encode(text);
        const sizes: ChunkSizes = { min: 64, avg: 128, max: 512 };

        const streamed = await collectStream(data, sizes, true, 5);
        const strict = new TextDecoder("utf-8", { fatal: true });
        let rebuilt = "";
        for (const c of streamed) {
            expect((c.bytes[0]! & 0xc0) === 0x80, `chunk at ${c.offset} starts mid-character`).toBe(false);
            rebuilt += strict.decode(c.bytes);
        }
        expect(rebuilt).toBe(text);
    });

    it("streams a blob through in blocks", async () => {
        const data = prose(20_000, 11);
        const out: Chunk[] = [];
        const blob = new Blob([data.slice()]);
        for await (const c of chunkStream(blobBlocks(blob, 512), TEXT_SIZES, true)) out.push(c);
        expect(joined(out)).toEqual(data);
    });

    it("holds no more than one chunk plus a window, whatever the file size", async () => {
        // The reason to stream at all. LiveSync reads the whole file into memory
        // before chunking; a vault with video attachments cannot afford that on
        // a phone.
        const sizes: ChunkSizes = { min: 1024, avg: 2048, max: 4096 };
        let peak = 0;
        async function* blocks() {
            for (let i = 0; i < 400; i++) {
                const block = new Uint8Array(1024);
                for (let j = 0; j < block.length; j++) block[j] = (Math.imul(i * 1024 + j, 2654435761) >>> 24) & 0xff;
                yield block;
            }
        }
        for await (const c of chunkStream(blocks(), sizes, false)) {
            peak = Math.max(peak, c.bytes.length);
        }
        expect(peak).toBeLessThanOrEqual(sizes.max);
    });
});

describe("choosing sizes", () => {
    it("uses text sizes for small text and binary sizes for the rest", () => {
        // The maximum is the one number that is not simply the table's: room is
        // reserved for what sealing adds, or a chunk cut at the ceiling is a
        // sealed chunk over it.
        // Only bites when the table's own maximum is at or above the ceiling,
        // which is the binary case and not the text one.
        const reserved = (t: { min: number; avg: number; max: number }) => ({
            ...t,
            max: Math.min(t.max, BINARY_SIZES.max - SEAL_OVERHEAD),
        });
        expect(sizesFor(1000, true)).toEqual(reserved(TEXT_SIZES));
        expect(sizesFor(1000, false)).toEqual(reserved(BINARY_SIZES));
        // A very large text file is data, not prose, and chunking it at 256
        // bytes would produce tens of thousands of chunks.
        expect(sizesFor(TEXT_AS_BINARY_ABOVE, true)).toEqual(reserved(BINARY_SIZES));
        // Just under the threshold it is still text, and text sizes now scale
        // with the file rather than being one number for a note and a novel.
        expect(sizesFor(TEXT_AS_BINARY_ABOVE - 1, true)).toEqual(reserved(textSizesFor(TEXT_AS_BINARY_ABOVE - 1)));
    });

    it("clamps to what the server said it would accept", () => {
        // Producing a chunk the server will refuse is a put that can never
        // succeed, and the client would retry it for ever.
        // Below the default, or the assertion holds without the clamp doing
        // anything and the test proves nothing.
        const sizes = sizesFor(10_000_000, false, 256 * 1024);
        expect(sizes.max).toBeLessThanOrEqual(256 * 1024);
        expect(sizes.max).toBeLessThan(BINARY_SIZES.max);
        expect(sizes.min).toBeLessThanOrEqual(sizes.max);
        expect(sizes.avg).toBeLessThanOrEqual(sizes.max);
    });

    it("refuses to go below a window's worth, however small the server's limit", () => {
        // A maximum under the window makes every cut a forced one and the
        // rolling hash pointless.
        const sizes = sizesFor(10_000, false, 8);
        expect(sizes.max).toBeGreaterThanOrEqual(WINDOW);
    });

    it("guesses text from the extension", () => {
        expect(looksLikeText("note.md")).toBe(true);
        expect(looksLikeText("Notes/A Note.MD")).toBe(true);
        expect(looksLikeText("drawing.canvas")).toBe(true);
        expect(looksLikeText("photo.png")).toBe(false);
        expect(looksLikeText("video.mp4")).toBe(false);
        expect(looksLikeText("no-extension")).toBe(false);
    });
});

describe("the server's ceiling", () => {
    /**
     * The default binary sizes must fit inside what the server enforces without
     * relying on the clamp. Measured on a real vault, LiveSync's sizes produced
     * a 4 MiB chunk and the server's chunkMax is 1 MiB, so a put would have been
     * refused for a file the user simply had.
     *
     * Hardcoded rather than imported, because the point is to notice when the
     * two drift apart.
     */
    const SERVER_CHUNK_MAX = 1024 * 1024;

    it("never proposes a chunk larger than the server chunk ceiling", () => {
        expect(BINARY_SIZES.max).toBeLessThanOrEqual(SERVER_CHUNK_MAX);
        expect(TEXT_SIZES.max).toBeLessThanOrEqual(SERVER_CHUNK_MAX);
    });

    it("stays under the maximum even when a character straddles it", () => {
        // Keeping the character whole by *extending* would also read cleanly and
        // would push the chunk over the maximum. The maximum is what the server
        // advertised as chunkMax, so three bytes over is a refused put.
        let text = "";
        for (let i = 0; i < 4000; i++) text += "🗿🗿🗿🗿";
        const data = enc.encode(text);
        const sizes: ChunkSizes = { min: 61, avg: 97, max: 131 };
        for (const c of chunkBytes(data, sizes, true)) {
            expect(c.bytes.length, `chunk at ${c.offset} is over the maximum`).toBeLessThanOrEqual(sizes.max);
        }
    });

    it("produces nothing over the ceiling on content with no boundaries in it", () => {
        // The worst case for a forced cut: content the rolling hash cannot find
        // a boundary in, at binary sizes.
        const data = new Uint8Array(3 * 1024 * 1024).fill(0x7a);
        for (const c of chunkBytes(data, BINARY_SIZES, false)) {
            expect(c.bytes.length).toBeLessThanOrEqual(SERVER_CHUNK_MAX);
        }
    });
});

/**
 * Whether a file is treated as text is decided by its extension, not by its
 * contents, so bytes that are not valid UTF-8 reach the UTF-8 path routinely:
 * anything at all named `.md`.
 *
 * That path backs a boundary off the end of an incomplete character, and
 * backing off to the start of the chunk would rewind the loop to where it
 * already was. `trimIncompleteCharacter` returns the untrimmed end rather than
 * the start for exactly that reason, and the reasoning is subtle enough that
 * the consequence of getting it wrong, a client that hangs on a note, deserves
 * to be checked rather than argued.
 */
describe("bytes that are not valid UTF-8, on the UTF-8 path", () => {
    const sizes = { min: 8, avg: 16, max: 64 };

    const shouldTerminate = (name: string, data: Uint8Array) => {
        it(`terminates on ${name}`, () => {
            const chunks = [...chunkBytes(data, sizes, true)];
            // Every byte accounted for exactly once, in order.
            const total = chunks.reduce((n, c) => n + c.bytes.length, 0);
            expect(total).toBe(data.length);
            let at = 0;
            for (const c of chunks) {
                expect(c.offset).toBe(at);
                expect(c.bytes.length).toBeGreaterThan(0);
                at += c.bytes.length;
            }
        });
    };

    // A long run of continuation bytes with no lead byte in sight.
    shouldTerminate("a run of continuation bytes", new Uint8Array(4096).fill(0x80));
    // Lead bytes promising more than follows, back to back.
    shouldTerminate(
        "truncated sequences end to end",
        new Uint8Array(Array.from({ length: 2048 }, (_, i) => (i % 2 === 0 ? 0xf0 : 0x80)))
    );
    // Every byte value, which includes every malformed shape.
    shouldTerminate(
        "every byte value repeated",
        new Uint8Array(Array.from({ length: 4096 }, (_, i) => i & 0xff))
    );
    shouldTerminate("a single continuation byte", new Uint8Array([0x80]));
    shouldTerminate("one lead byte and nothing after it", new Uint8Array([0xf0]));
});

/**
 * The server's ceiling is on the *sealed* chunk, and sealing adds a nonce, a
 * tag and a marker byte. A cut made at exactly the ceiling produces a body the
 * server refuses, permanently, and the file it belongs to never syncs.
 *
 * Nothing caught this for a long time because the test data compressed: deflate
 * made the sealed chunk smaller than the plaintext and the overhead vanished
 * into the saving. An attachment is a photo or a video and does not compress,
 * which is how it was eventually found: a 12 MiB file of real random bytes,
 * refused with "chunk exceeds chunkMax: 1048605 > 1048576".
 */
describe("chunks that have to survive being sealed", () => {
    it("leaves room for what sealing adds", () => {
        const sizes = sizesFor(64 * 1024 * 1024, false, 1024 * 1024);
        expect(sizes.max + SEAL_OVERHEAD).toBeLessThanOrEqual(1024 * 1024);
    });

    it("respects a ceiling smaller than its own idea of one", () => {
        // The parameter existed and the engine never passed it, so a server
        // advertising something smaller was ignored.
        const sizes = sizesFor(64 * 1024 * 1024, false, 64 * 1024);
        expect(sizes.max).toBeLessThanOrEqual(64 * 1024 - SEAL_OVERHEAD);
    });

    it("keeps every sealed chunk of incompressible data under the ceiling", async () => {
        const ceiling = 256 * 1024;
        const keys = await deriveKeys(new Uint8Array(20).fill(4));
        const bytes = new Uint8Array(4 * 1024 * 1024);
        for (let at = 0; at < bytes.length; at += 65536) {
            crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, bytes.length)));
        }

        const sizes = sizesFor(bytes.length, false, ceiling);
        const parts = [...chunkBytes(bytes, sizes, false)].map((c) => c.bytes);
        const sealed = await sealChunks(keys, parts);

        expect(sealed.length).toBeGreaterThan(8);
        const worst = Math.max(...sealed.map((c) => c.bytes.length));
        expect(worst, `the largest sealed chunk was ${worst} against a ceiling of ${ceiling}`).toBeLessThanOrEqual(
            ceiling
        );
    });
});
