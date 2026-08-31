# Benchmark

[Docs index](index.md)

`cd client && bun run bench:sync`. `BENCH_SCALE=1` for the full size,
`BENCH_WIRE=400` for one wire.

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
| loopback | 12.1 s | 0.63 s | 0.25 s | 0.12 s | 0.01 s |
| 20 ms | 12.5 s | 0.67 s | 0.30 s | 0.14 s | 0.01 s |
| 100 ms | 12.7 s | 0.85 s | 0.45 s | 0.23 s | 0.01 s |
| 400 ms, 2.6 MiB/s | 14.7 s | 5.60 s | 1.07 s | 0.63 s | 0.01 s |

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

## Beside Sync Engine, carefully

`BENCH_SCALE=1` is 2000 files, which is their published count, at the same
latency:

| 2000 files, 400 ms | up | down |
|---|---|---|
| Sync Engine, their machine, Nextcloud over WebDAV | 9.43 min | 5.87 min |
| Basalt, this machine, Go server behind a latency proxy | 2.79 min | 1.07 min |

26 round trips each way. 2000 arrived, 0 wrong.

**Not a race.** Their backend is Nextcloud over WebDAV, so much of their per-file
cost is PHP and HTTP rather than their engine. Their CPU scores around 1700
single-core against an M4 Pro. The latency here is injected on loopback, with no
jitter or loss. And their vault size is not published, where ours is 213.6 MiB.

What survives all four: 26 round trips to move 2000 files, against an engine that
overlaps requests to hide one per file, and an edit to a large note that costs
one chunk here and the whole file on any backend that stores files.

## What is next

1. **Run it on Linux.** 108 of the 2000-file upload's 167 seconds are this
   laptop's `F_FULLFSYNC`. Every upload figure above is a laptop's until then.
2. **Then probably stop.** After that, upload is within seconds of what the link
   can carry and download already is: 64 s against a 48 s floor.
3. **Run it on a phone.** Never done. WebCrypto in a webview, memory during a
   first sync, and battery are all unmeasured.
4. **Measure their plugin on this machine.** It needs Obsidian, a WebDAV server,
   and every candidate measured the same afternoon. Until then their numbers are
   theirs.

Since measured, and worth doing, from an audit of the two client shells on a
10,000 note vault:

5. **The headless walk stats one file at a time.** 138 ms at 10k files, of which
   112 ms is waiting: `readdir` over the same tree is 25 ms. Issuing each
   directory's stats together takes it to 27 ms. It runs on every pass, so an
   idle vault pays it every keepalive tick. The plugin does not have this
   problem, because it reads Obsidian's own index instead: 10 ms at 10k, about a
   fourteenth of the cost per file, and the best decision in either shell.
6. **The index is rewritten in full on passes that changed nothing.** 21 ms at
   10k entries, of which 11 ms is two fsyncs of a byte-identical 5.3 MiB file,
   every thirty seconds, forever. Remembering the last string written takes the
   idle pass from 37 ms to 10 ms.
7. **`writeDurably` flushes a directory per file.** Files sharing a folder
   re-flush the same directory: 2000 files across 200 folders cost 10.7 s with
   16 in flight, and 6.1 s flushing each directory once. This one touches the
   durability contract, so it goes last and with a failing test first.
8. **The plugin's block re-assembly reallocates per stream chunk.** Moving
   64 MiB copies 2144 MiB and allocates 4160 buffers at a 16 KiB fetch chunk
   size. A preallocated block buffer makes it 128 MiB and 65. Small in wall
   clock, and the allocation churn is on the axis that matters on a phone.

Not worth doing: request ids, with 26 round trips left to overlap. Larger chunks
to cut fsyncs, which trades back a chunk size chosen by measurement against what
an edit costs. Raising `UV_THREADPOOL_SIZE`, which was measured at 16 and made
the pooled walk 2.6x worse than the default 4.

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
