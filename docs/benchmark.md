# Benchmark

[Docs index](index.md)

`cd client && bun run bench:sync`, which is 2000 files over four wires.
`BENCH_SCALE=0.1` for a tenth of the vault, `BENCH_WIRE=400` for one wire.

Correctness is reported next to the timings, which is
[Sync Engine](https://github.com/hesprs/sync-engine)'s idea. A sync benchmark
that reports only speed is measuring the wrong half, and this one has caught two
real defects.

The vault shape is theirs: many small notes, some medium, a few large, folders
several deep. Half the large files are incompressible, because prose compresses
and a chunk-size defect hid inside that for months. And the prose does not repeat
itself. The first generator cycled a dozen words, so every note was nearly every
other note and cross-file deduplication looked like it saved eighty per cent. It
was measuring the generator. On distinct notes it saves nothing.

Latency is injected by a proxy in front of the server. 400 ms and 2.6 MiB/s is
Sync Engine's published environment.

## Results

Apple M4 Pro, Bun 1.4. 200 files, 17.8 MiB.

| Round trip | Up | Down | 20 notes up | 20 notes down | Nothing changed |
|---|---|---|---|---|---|
| loopback | 12.2 s | 0.60 s | 0.25 s | 0.11 s | 0.00 s |
| 20 ms | 12.1 s | 0.64 s | 0.28 s | 0.14 s | 0.00 s |
| 100 ms | 12.2 s | 0.81 s | 0.46 s | 0.23 s | 0.00 s |
| 400 ms, 2.6 MiB/s | 15.0 s | 5.60 s | 1.09 s | 0.63 s | 0.01 s |

200 sent, 200 arrived, 0 wrong, 0 missing, 0 refused, on every row.

Three numbers describe the design better than the timings:

**Bytes.** 17.8 MiB crosses as 10.7 MiB, from compression alone. Deduplication
contributes nothing, because the notes are distinct. Twenty edited notes cost 20
chunks rather than twenty files.

**Round trips.** 4 up and 4 down, at every latency. It was 314 and 221, one per
file, which at 400 ms was two minutes of asking permission. Batches are bounded
at 256 entries and 8 MiB of queued file, the second because a queued file is
pinned in memory until its batch goes.

**The rest is the disk, not the wire.** At 400 ms the upload moves 10.7 MiB,
which the link carries in 4 s, and takes 14.7. Almost all the difference is
`fsync`: a chunk costs one file flush and its share of a directory flush, and an
ack must not precede either. Serially that was 29 of the first sync's 30 seconds.
They now run sixteen at a time with one directory flush per batch.

That last figure is a laptop's. On Linux the same 3000 chunks go at 4527/s
against 307/s here, because Go issues `F_FULLFSYNC` on darwin. `go test
./internal/chunks -bench WriterWidth` prints both.

**The download column nearly stopped meaning anything.** Both devices used to be
created before the vault was built, so the second one followed the first live
and its "first sync" was whatever was left over. That had always been true and
had never mattered, because downloads were slower than uploads; once they were
not, the row collapsed to 0.3 s for a 213 MiB vault, which is a plausible-looking
number for something that did not happen. The second device is created after the
upload now. Every figure above is from the fixed harness, and they came back the
same, which is the reason to trust them.

## Beside Sync Engine, carefully

`BENCH_SCALE=1` is 2000 files, which is their published count, at the same
latency:

| 2000 files, 400 ms | up | down |
|---|---|---|
| Sync Engine, their machine, Nextcloud over WebDAV | 9.43 min | 5.87 min |
| Basalt, this machine, Go server behind a latency proxy | 2.79 min | 1.06 min |

26 round trips each way. 2000 arrived, 0 wrong.

**Not a race.** Their backend is Nextcloud over WebDAV, so much of their per-file
cost is PHP and HTTP rather than their engine. Their CPU scores around 1700
single-core against an M4 Pro. The latency here is injected on loopback, with no
jitter or loss. And their vault size is not published, where ours is 213.6 MiB.

What survives all four: 26 round trips to move 2000 files, against an engine that
overlaps requests to hide one per file, and an edit to a large note that costs
one chunk plus its entry here and the whole file on any backend that stores
files.

## What three audits found, and what was done

The client shells, the engine and the server were each audited against a 10,000
note vault. Everything below was measured before and after; the fixes are in.

**The engine's two biggest were the same defect seen twice, and neither showed
up under the runtime the benchmarks used.** Every number in this document was
taken under bun, and the shipped CLI is `#!/usr/bin/env node`.

| | Was | Now |
|---|---|---|
| Boundary test, a double modulo V8 answers with `fmod` | 32 MiB/s on node | 996 MiB/s, identical boundaries |
| The byte loop inside an async generator, which JavaScriptCore leaves unoptimised | 39 MiB/s on bun | 700 MiB/s |

The two are disjoint, one per engine, so both were needed. Together, scanning a
64 MiB attachment went from 1.77 s to 0.19 s on bun and 0.49 s on node. iOS is
JavaScriptCore, so the second is the one that mattered for a phone, and the
plugin runs all of it on Obsidian's render thread, which is what a stall on save
would have been.

Also in the engine: `transport.fetch` verified each body's hash serially, 90% of
the client cost of a fetch and 4.3x taken together; `assemble` and `acceptBatch`
were serial for the same reason, 1.3x and 2.2x; a path was sealed twice per
upload, and building the entry once instead also means the MAC cannot drift from
what is sent; and `toBuffer` copied every buffer where the hazard it guards
cannot arise, 1.06x on sealing an attachment.

**The two client shells**, where an idle vault paid on every keepalive tick:

| | Was | Now |
|---|---|---|
| The headless walk, one stat at a time | 138 ms at 10k files | 27 ms, each directory's stats issued together |
| The index rewritten in full on a pass that changed nothing | 21 ms, two fsyncs of a byte-identical 5.3 MiB file | skipped; the idle pass went 37 ms to 10 ms |
| `writeDurably` flushing a directory per file | 10.7 s for 2000 files across 200 folders | 6.1 s, each directory flushed once |
| The plugin's block re-assembly, reallocating per stream chunk | 2144 MiB copied, 4160 buffers | 128 MiB, 65 |

The plugin never had the walk problem, because it reads Obsidian's own index:
10 ms at 10k files, a fourteenth of the cost per file, and the best decision in
either shell.

**The server was not the bottleneck and still is not.** A whole sync on loopback
profiles at 10.4% CPU, of which `chunks.place` is 64% and its fsync another 16%.
Everything that is not the chunk fsync, meaning the websocket, the JSON, the
want list and all of SQLite, is under 1.6% of an upload. So none of these were
on the sync path, and all are fixed:

| | Was | Now |
|---|---|---|
| `Deleted()` scanning for its rename suppression, with no index on `prev_path` | 112 ms | 5.6 ms; the index costs 5 us on an insert whose fsync is 7.8 ms |
| `HistoryForPath` attaching chunks by `uid BETWEEN`, a range spanning the vault's whole life | 6.1 ms at 10k, 83 ms at 100k | 0.07 ms and 0.3 ms, keyed on the actual uids |
| An already-held chunk stat'ed three times per put, the whole server cost of a batch where nothing is new | 3.37 ms per 512 chunks | 1.08 ms |
| The backup ordering by more than its contract, forcing a non-covering scan | 10 ms over 20k rows | under 1 ms |

And one that was a memory bound rather than a speed one: the send queue was
bounded at 256 frames and not in bytes, so a peer that stopped reading grew the
heap by 272 MB, measured, with an arithmetic bound of 256 MiB per peer. It is
bounded in bytes now. A vault of incompressible attachments produces chunks at
the 1 MiB ceiling, which is exactly when that bit.

## What is next

1. **Run it on Linux.** 108 of the 2000-file upload's 167 seconds are this
   laptop's `F_FULLFSYNC`. Every upload figure above is a laptop's until then.
2. **Then probably stop.** After that, upload is within seconds of what the link
   can carry and download already is: 64 s against a 48 s floor.
3. **What a large attachment costs on a phone.** A phone has synced a 320 file
   vault, so the platform is no longer the unknown; the memory curve below is a
   laptop's, and the file limit is set from it.
4. **Measure their plugin on this machine.** It needs Obsidian, a WebDAV server,
   and every candidate measured the same afternoon. Until then their numbers are
   theirs.

## Measured and deliberately not done

**A global hash chain over the log**, which would catch a server withholding
versions. 12.7 us per entry against 2.2, which is nothing; it was rejected for
what a global head does to concurrent writers, and `docs/security.md` says what
that leaves undetected.

**One transaction per `putmany`.** A genuine 10x on the SQL, worth 0.7% of an
upload, in exchange for making "an ack means durable" a per-batch argument.

**`entry_chunks` as `WITHOUT ROWID`.** 36% faster to insert and 20% faster to
read, and all of SQLite is 0.25 s of a 29 s upload, so it is worth about 0.05 s.
It cannot be done with `ALTER`: the table has to be rebuilt and copied. That is
a migration of the metadata store for a twentieth of a second.

**A different deflate level, or different chunk-size targets.** The level is
baked into the sealed bytes, which are the chunk name, which is what dedup is.
Changing any of them re-chunks every vault in existence.

**Request ids**, with 26 round trips left to overlap. **Larger chunks** to cut
fsyncs, which trades back a chunk size chosen by measurement against what an
edit costs. **Raising `UV_THREADPOOL_SIZE`**, measured at 16 and 2.6x worse than
the default 4.

Measured and already fast, so left alone: the realpath containment check added
to every write, at 0.2 to 0.6% of one; CLI cold start, which is 30 ms of which
22 ms is Node itself and 0.1 ms is the key schedule; the plugin's status bar and
per-event work, none of which is O(vault).

## What a large attachment costs in memory

Separate from the timings, and the number that matters on a phone. Peak resident
for a whole sync of one 64 MiB attachment, in a fresh process:

| | peak |
|---|---|
| sealing every chunk at once | 816 MB |
| sealing sixteen at a time | **522 MB** |

A changed file is sealed twice, once by the rehash that decides it changed and
once by the upload that sends it, so dropping the sealed bodies between windows
saves more than one copy of the file. It is not slower: sealing is mostly
waiting on WebCrypto and sixteen in flight keeps it busy.

What was left at that point was the plaintext itself. The vault handed over a
whole file, `DataAdapter` offers no streaming read beside it, and so the floor
for a file was the file. `chunkStream` existed for a vault that could be read in
blocks and nothing called it.

That is what the rest of this section is about. It is called now, by the engine,
for any vault offering `readBlocks` and `readRange`, which both the headless
client and the plugin do. The floor is gone, and the numbers below are what
replaced it.

Peak resident and wall clock for a whole sync of one attachment, measured on
this laptop, with the headless client:

| file | peak | time |
|---|---|---|
| 16 MiB | 144 MB | 0.4 s |
| 64 MiB | 220 MB | 1.6 s |
| 128 MiB | 229 MB | 3.3 s |
| 256 MiB | 291 MB | 6.5 s |

Nearly flat, and for a 256 MiB file the peak is now smaller than the file, which
is the point: it is never held. Getting there took three things.

**It was read, cut and sealed twice.** Once by the scan that decides a file has
changed and again by the upload that sends it, with both passes' garbage live at
once. The scan hands its work forward now.

**Every chunk was deflated whether or not it could compress.** For photographs,
PDFs and video that is a compressor's worst case: all of the work, an output the
size of the input, nothing found, the answer discarded. A chunk is probed on its
first four kilobytes. Over 64 MiB of incompressible data: 763 ms and 260 MB
became 24 ms and 131 MB, with identical bytes on the wire.

**The file was held from the first read until the last chunk went.** That was
the rest of it. A vault that can hand over blocks and ranges is now read twice
from disk instead: once to cut and name it, keeping one chunk at a time, and
again for the chunks the server asks for. Two disk reads against most of a
gigabyte of memory is not a close trade, and it costs about 13% more wall clock.

Together, a 64 MiB attachment went from 6.8 s and 636 MB to 1.6 s and 220 MB,
and a 256 MiB one from about 900 MB to 291 MB.

**The plugin gets all three.** `DataAdapter` offers `readBinary` and nothing
beside it, but `getResourcePath` returns the URL the webview already fetches to
show an image, and that response carries a body stream and honours a Range
header. Verified in a running Obsidian, and then measured there: a 20 MiB
attachment, written into a real vault and synced by the plugin to a real server,
went in **2.9 seconds**, and the server's `verify -deep` found 0 faults across
479 chunk references.

Mobile is Capacitor and its resource URLs are a different scheme, which nothing
has tested. A failure is treated as "not on this platform": the engine remembers
it and everything after takes the buffered path, which is what it did before.

For comparison, Obsidian Sync reads the whole file, encrypts it in one call and
slices the ciphertext into 2 MiB wire frames, so it holds about twice the file.

That curve is what sets the default file limit, rather than any cost to the
server, and it is set for the weakest device rather than the strongest: 64 MiB,
because the plugin buffers and this curve was measured on a laptop. A phone has
since synced a vault, so "never run on a phone" is no longer the reason; what is
still unmeasured is what a large attachment costs on one, and a limit set from a
laptop's memory is not evidence about a phone's. A client refuses
anything larger from its stat, before opening it. `basaltd serve -max-file` raises
it as far as 256 MiB, which is comfortable for a vault whose large files are only
ever moved by the headless client.

## What a move costs

Moving files was already free for the sender. Chunk names are hashes of
ciphertext, so the server holds every chunk already and only metadata travels.
Twenty notes moved into another folder:

    uploaded=21  chunksSent=0  bytesSent=0

The receiver used to pay full price for the same move. It downloaded each file
back under a name it was already storing the identical bytes under, because the
fetch asked the server for chunks without looking at what the device had. One
6.2 MiB attachment moved meant 6.2 MiB re-downloaded, on every other device.

A download whose content id matches a file this device holds is now written from
those bytes. The local copy is re-chunked and re-sealed and the names compared
before anything is written, which is exact rather than trusting: sealing is
deterministic, so identical content gives identical names.

Measured by emptying the server. Every chunk body deleted before the receiving
device syncs, so a byte off the wire would fail rather than merely be slower:

    server holds 0 chunk bodies
    downloaded=1  retrying=0        byte identical to the source device

Deletions had to move for it to work. They were applied before the pass wrote
anything, so a move deleted the only local copy of the bytes it was about to
want. They are deferred until after the writes now, which durability rule 3
argues for on its own.

## What the entry authenticator costs

Protocol 2 authenticates every entry. Measured before it was built, because the
answer decided the design:

| | per entry | 256-entry batch | 2000-file first sync |
|---|---|---|---|
| Per-entry, parallel | 2.2 us | 0.56 ms | 4 ms |
| Globally chained, sequential | 12.7 us | 3.26 ms | 25 ms |

Against 167 seconds of upload, both are nothing. The chain was rejected for what
it does to concurrent writers rather than for its arithmetic: a global head must
be known at write time, so two devices writing at once serialise and each
conflict costs a round trip, 400 ms against 3 ms of hashing.

On the wire it is 149 bytes per entry, flat:

| | before | after | |
|---|---|---|---|
| A one-chunk note | 274 B | 423 B | +54% |
| A 1024-chunk attachment | 68815 B | 68964 B | +0.2% |
| 2000-file first sync, metadata | 535 KB | 826 KB | +2.7% of the upload |

## What adding latency found

Both were invisible on loopback. A fetch is answered in binary frames rather than
a reply, so the timeout armed for that reply was never disarmed; it fired
mid-sync and closed the connection. At 400 ms every sync died one timeout after
its first fetch with most of the vault missing.

And it reported success, because the settle loop stops when a pass produces no
work and a pass in which everything failed produces none. A run that ends with
files still failing now exits non-zero.

## The other benchmark

`bun run bench` measures the parts: chunking throughput, sealing, and bytes on
the wire for one line inserted. It warms up and alternates the order of anything
compared, because the first version did neither and reported a 2.7x gain where
the honest figure was 1.3x.

Its bandwidth table counted only chunk bodies until recently, and the entry
carrying their names is most of what a large note costs:

| Note | Whole file | Basalt | of that, the entry | |
|---|---|---|---|---|
| 4 KiB | 4.4 KiB | 1.9 KiB | 624 B | 2x |
| 32 KiB | 32.4 KiB | 4.9 KiB | 1.3 KiB | 7x |
| 128 KiB | 128.4 KiB | 5.8 KiB | 2.7 KiB | 22x |
| 512 KiB | 512.4 KiB | 9.6 KiB | 4.8 KiB | 54x |
| 2 MiB | 2.0 MiB | 21.7 KiB | 9.0 KiB | 94x |

Counting bodies alone read 494 B and 4245x at 2 MiB, and was quoted in three
documents. It also flattered a chunk size that has since been tuned: the same
note was 5638 chunks when that figure was taken and is 133 now, so the old sizes
really did send a smaller body and paid for it with 5638 names in every version.
The entry is what bounds the gap, and it is why chunk size is chosen by
`sqrt(NAME_BYTES * size)` rather than by what one edit costs.

The generator writes random words, which deflate barely helps, so the body
column is a floor rather than a typical note.
