/**
 * Content-defined chunking: a Rabin-Karp rolling hash decides where chunks end.
 *
 * The idea and the parameters come from LiveSync's `splitPiecesRabinKarp`, read
 * at `livesync-commonlib/src/string_and_binary/chunks.ts:493` and recorded in
 * docs/client-design.md. Two things are done differently and both are
 * deliberate; they are noted where they occur.
 *
 * ## Why a rolling hash rather than fixed offsets
 *
 * Cut a file every 64 KiB and inserting one line near the top shifts every
 * subsequent boundary, so every chunk after the edit is new and the whole file
 * uploads again. Cut where a hash of the last 48 bytes says to, and an insert
 * changes the one chunk containing it: the boundaries either side are decided by
 * content that did not move.
 *
 * The property that makes it work is worth stating because it is not obvious.
 * The boundary test is `hash % average === 1`, so each position has a 1-in-average
 * chance of ending a chunk, independent of where it is. Chunk lengths come out
 * exponentially distributed around the average without anything tracking
 * position, which is why an insert cannot shift the pattern downstream.
 */

/**
 * Rolling hash window, in bytes.
 *
 * 48 is LiveSync's, and the size matters in one direction: the window is the
 * amount of context deciding each boundary, so too small and boundaries move
 * with tiny edits, too large and the hash takes longer to forget an edit that
 * has passed. It is not a tunable and there is no setting for it.
 */
export const WINDOW = 48;

/** Multiplier for the rolling hash. */
const PRIME = 31;

/**
 * The residue that ends a chunk. Any fixed value in range does; this one is
 * LiveSync's.
 *
 * `hash % avg` reads only the low bits when `avg` is a power of two, and a
 * polynomial hash with PRIME = 31 is often said to mix those badly, since
 * 31 = 32 - 1. Measured against 15.4 MiB of real markdown the worry does not
 * survive: the mean chunk came out at 352 B against a 384 B target, a ratio of
 * 0.92. A prime modulus or skipping the low byte both reach 0.97, which is 3.7%
 * fewer chunks and not worth diverging from a well-tested reference for. Written
 * down so the measurement does not have to be repeated to settle it again.
 */
const BOUNDARY = 1;

/**
 * Chunk size targets.
 *
 * Text and binary get different sizes for the same reason LiveSync separates
 * them: prose is edited in small pieces and deduplicates well at a few hundred
 * bytes, while an attachment is either the same file or a different one and
 * chunking it finely buys nothing but overhead.
 *
 * Every one of these is a constant with its reasoning attached rather than a
 * setting. docs/philosophy.md: a question with a right answer is answered once
 * in the source.
 */
export interface ChunkSizes {
    readonly min: number;
    readonly avg: number;
    readonly max: number;
}

/**
 * Text: 128 B / 256 B / 1 KiB, as LiveSync uses.
 *
 * The minimum matters more than it looks. Without it a run of low-entropy
 * content can fire the boundary test repeatedly and produce a chunk every few
 * bytes, and per-chunk overhead is 28 bytes of sealing plus 64 characters of
 * name on the wire. At a 128-byte floor the overhead is bounded at roughly a
 * quarter; without one it is unbounded.
 */
export const TEXT_SIZES: ChunkSizes = { min: 128, avg: 256, max: 1024 };

/**
 * Binary: 128 KiB / 256 KiB / 1 MiB.
 *
 * LiveSync uses 256 KiB / 1 MiB / 4 MiB here, and this is a deliberate departure
 * measured against a real vault rather than argued. Chunked with LiveSync's
 * numbers, that vault produced a single 4 MiB chunk, which the server refuses:
 * its `chunkMax` is 1 MiB. So the choice was to raise the server's ceiling or
 * lower these, and lowering them wins on every count that matters here.
 *
 * A 1 MiB ceiling means a phone never holds four megabytes for one chunk, and
 * the chunk counts stay trivial either way. Measured on that vault: its largest
 * file is 7.2 MiB, which was 4 chunks at LiveSync's sizes and is 19 at these,
 * and no chunk in 78.8 MiB across 3,730 files now exceeds 1.0 MiB. Nineteen is
 * nothing, and finer chunks deduplicate better when a large attachment is
 * edited rather than replaced.
 *
 * LiveSync's larger sizes are not a mistake on their side. Each of their chunks
 * is a CouchDB document, so a chunk carries a document's cost and fewer is
 * better. Basalt writes a file into a content-addressed directory.
 */
export const BINARY_SIZES: ChunkSizes = { min: 128 * 1024, avg: 256 * 1024, max: 1024 * 1024 };

/**
 * Above this, a text file is chunked as binary.
 *
 * LiveSync's threshold, and its reasoning holds here: a 4 MiB note at a 256-byte
 * average is sixteen thousand chunks, and sixteen thousand of anything per file
 * is a performance problem in whichever layer touches it first. A note that
 * large is not prose being edited, it is data in a text file.
 */
export const TEXT_AS_BINARY_ABOVE = 4 * 1024 * 1024;

/**
 * Chooses sizes for a file, clamped to what the server will accept.
 *
 * `serverChunkMax` comes from the handshake. Clamping here rather than trusting
 * the constants means a server with a smaller ceiling produces smaller chunks
 * instead of rejected puts, and a client that has not asked yet still gets
 * something sane.
 */
export function sizesFor(size: number, isText: boolean, serverChunkMax = BINARY_SIZES.max): ChunkSizes {
    const base = isText && size < TEXT_AS_BINARY_ABOVE ? TEXT_SIZES : BINARY_SIZES;

    const max = Math.min(base.max, serverChunkMax);
    // A window's worth of data is the least that can produce a boundary at all,
    // so a maximum below it would make every chunk a forced cut and the rolling
    // hash pointless. Clamping up keeps the algorithm meaningful even if a
    // server advertises something absurd.
    const clampedMax = Math.max(max, WINDOW * 4);
    return {
        min: Math.min(base.min, clampedMax),
        avg: Math.min(base.avg, clampedMax),
        max: clampedMax,
    };
}

/**
 * Moves a cut back off an incomplete character.
 *
 * The question is asked of the chunk itself, not of the byte after it: does
 * `data[start..end)` end part way through a UTF-8 sequence? That is decidable
 * from the trailing bytes alone, and it matters because a streaming splitter has
 * no next byte to look at. An earlier version asked the lookahead question and
 * needed a one-byte delay to answer it, which made the streaming and in-memory
 * paths disagree on forced cuts; asking it this way lets both share one rule.
 *
 * Backing off rather than extending is deliberate. Extending past the character
 * keeps it whole too, and makes the chunk exceed the maximum, and the maximum is
 * what the server advertised as `chunkMax`. Three bytes over a limit is a put
 * refused for a file the user simply has.
 *
 * Returns `end` unchanged when backing off would empty the chunk, which needs a
 * maximum smaller than one character. `sizesFor` will not produce one, but a
 * zero-length chunk is worth closing rather than reasoning away.
 */
function trimIncompleteCharacter(data: Uint8Array, start: number, end: number): number {
    // Find the lead byte of the last sequence.
    let lead = end - 1;
    while (lead > start && (data[lead]! & 0xc0) === 0x80) lead--;
    if (lead < start) return end;

    const b = data[lead]!;
    const expected = b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
    if (end - lead >= expected) return end; // complete, nothing to do
    return lead > start ? lead : end;
}

/** One chunk: where it came from, and its bytes. */
export interface Chunk {
    readonly offset: number;
    readonly bytes: Uint8Array;
}

/**
 * Splits bytes into content-defined chunks.
 *
 * A generator, and synchronous, because the caller decides what to do with each
 * chunk (seal it, name it, decide whether the server already has it) and holding
 * a whole file's worth of chunks to hand back at the end would double the peak
 * memory for no gain.
 *
 * ## The two departures from LiveSync
 *
 * It takes a `Uint8Array` and never a Blob. LiveSync reads the entire file into
 * memory with `await dataSrc.arrayBuffer()` before chunking, which for a vault
 * of notes is fine and for a vault with video attachments is not. The algorithm
 * only ever looks at a 48-byte window, so it is inherently streamable;
 * `chunkStream` below does that, and this function is the in-memory case it is
 * built from.
 *
 * It does not base64 anything. LiveSync encodes binary chunks because CouchDB
 * stores strings; Basalt sends binary WebSocket frames, so the bytes go as
 * bytes and a third of the transfer is not spent on encoding.
 */
export function* chunkBytes(data: Uint8Array, sizes: ChunkSizes, isUtf8: boolean): Generator<Chunk> {
    const { min, avg, max } = sizes;
    const length = data.length;

    // An empty input yields nothing, and needs no special case to do it: the
    // loop does not run and the trailing yield is guarded. That is the right
    // answer rather than an accident. The protocol says a file has chunks if and
    // only if it has content, so an empty note carries none and the server
    // refuses one that carries any.

    // PRIME^(WINDOW-1), for removing the byte leaving the window. Math.imul
    // keeps the arithmetic in 32 bits, which is what makes the rolling update
    // exact rather than drifting through float precision.
    let pPowW = 1;
    for (let i = 0; i < WINDOW - 1; i++) pPowW = Math.imul(pPowW, PRIME);

    let start = 0;
    let hash = 0;

    for (let pos = 0; pos < length; pos++) {
        const byte = data[pos]!;

        if (pos >= start + WINDOW) {
            // Roll: drop the byte that has left the window, take in the new one.
            hash = (hash - Math.imul(data[pos - WINDOW]!, pPowW)) | 0;
            hash = Math.imul(hash, PRIME);
            hash = (hash + byte) | 0;
        } else {
            // Still filling the first window of this chunk.
            hash = Math.imul(hash, PRIME);
            hash = (hash + byte) | 0;
        }

        const size = pos - start + 1;
        let boundary = size >= min && (hash >>> 0) % avg === BOUNDARY;
        // A forced cut at the maximum. Without it a file with no boundary in it
        // is one chunk however large, which the server would refuse.
        if (size >= max) boundary = true;

        if (boundary) {
            // Sealing and reassembly are byte exact, so splitting a character
            // would corrupt nothing. It would make a chunk that is not valid
            // UTF-8 on its own, which cannot be diffed, logged or looked at, and
            // LiveSync carries a regression test for a U+FEFF landing here.
            const end = isUtf8 ? trimIncompleteCharacter(data, start, pos + 1) : pos + 1;
            yield { offset: start, bytes: data.subarray(start, end) };
            start = end;
            hash = 0;
            // The bytes backed over have not been hashed into the new chunk, so
            // rewind to re-read them. `end > start` always holds, so this
            // terminates.
            pos = end - 1;
        }
    }

    if (start < length) {
        yield { offset: start, bytes: data.subarray(start, length) };
    }
}

/**
 * Splits a stream into content-defined chunks, holding at most one chunk plus a
 * window in memory.
 *
 * This is the departure from LiveSync that matters most. The boundary decision
 * needs 48 bytes of history and nothing else, so there is no reason to hold a
 * 700 MB attachment in memory to chunk it, and on a phone there is every reason
 * not to.
 *
 * The chunk being accumulated is bounded by `sizes.max`, so peak memory is that
 * plus one incoming block, whatever the file size.
 */
export async function* chunkStream(
    blocks: AsyncIterable<Uint8Array>,
    sizes: ChunkSizes,
    isUtf8: boolean
): AsyncGenerator<Chunk> {
    const { min, avg, max } = sizes;

    let pPowW = 1;
    for (let i = 0; i < WINDOW - 1; i++) pPowW = Math.imul(pPowW, PRIME);

    // The chunk under construction. Sized to the maximum once, then reused.
    const buf = new Uint8Array(Math.max(max, WINDOW * 2));
    let used = 0;
    let hash = 0;
    let offset = 0;

    // Trimming an incomplete character looks only at bytes already in the
    // buffer, so this needs no lookahead and no pending state. That is what lets
    // both implementations share one rule.
    const cut = (): Chunk => {
        const end = isUtf8 ? trimIncompleteCharacter(buf, 0, used) : used;
        const chunk = { offset, bytes: buf.slice(0, end) };
        offset += end;
        // Whatever was backed over stays, and is rehashed as the next chunk's
        // opening bytes.
        const carry = used - end;
        buf.copyWithin(0, end, used);
        used = carry;
        hash = 0;
        for (let i = 0; i < carry; i++) {
            hash = Math.imul(hash, PRIME);
            hash = (hash + buf[i]!) | 0;
        }
        return chunk;
    };

    for await (const block of blocks) {
        for (let i = 0; i < block.length; i++) {
            const byte = block[i]!;
            buf[used++] = byte;
            if (used >= WINDOW + 1) {
                hash = (hash - Math.imul(buf[used - 1 - WINDOW]!, pPowW)) | 0;
                hash = Math.imul(hash, PRIME);
                hash = (hash + byte) | 0;
            } else {
                hash = Math.imul(hash, PRIME);
                hash = (hash + byte) | 0;
            }

            if (used >= max || (used >= min && (hash >>> 0) % avg === BOUNDARY)) {
                yield cut();
            }
        }
    }

    if (used > 0) {
        // The remainder, whatever it is. No backing off: there is no next
        // character to protect.
        const chunk = { offset, bytes: buf.slice(0, used) };
        offset += used;
        used = 0;
        yield chunk;
    }
}

/**
 * Reads a Blob as blocks, for feeding chunkStream.
 *
 * 1 MiB blocks: large enough that the per-slice cost disappears, small enough
 * that peak memory is bounded by something other than the file.
 */
export async function* blobBlocks(blob: Blob, blockSize = 1024 * 1024): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < blob.size; at += blockSize) {
        yield new Uint8Array(await blob.slice(at, Math.min(at + blockSize, blob.size)).arrayBuffer());
    }
}

/**
 * Guesses whether a path holds text, for choosing chunk sizes.
 *
 * A guess, and only ever used to pick sizes: getting it wrong costs efficiency
 * and never correctness, because both paths are byte exact. Extension based
 * rather than content sniffing, because the answer is wanted before the file is
 * read.
 */
const TEXT_EXTENSIONS = new Set([
    "md",
    "txt",
    "canvas",
    "json",
    "csv",
    "yml",
    "yaml",
    "xml",
    "html",
    "css",
    "js",
    "ts",
    "svg",
    "bib",
    "tex",
]);

export function looksLikeText(path: string): boolean {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return false;
    return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
