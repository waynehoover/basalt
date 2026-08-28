# Benchmark

`cd client && bun run bench:sync`, `BENCH_SCALE=1` for the full size,
`BENCH_WIRE=400` for one wire.

Correctness is reported next to the timings. That is
[Sync Engine](https://github.com/hesprs/sync-engine)'s idea, whose harness
prints an error count beside every result and caught a competitor losing 98
files. A sync benchmark that reports only speed is measuring the wrong half, and
this one has already earned its keep: it caught two real defects the moment
latency was added, described at the bottom.

## The vault and the wire

The vault shape is theirs: many small notes, some medium, a few large, across
folders several deep, with deterministic paths. Two changes, and both matter.

Half the large files are incompressible, because prose compresses and a
chunk-size defect lived here for months hidden inside that saving.

And the prose does not repeat itself. The first version of this generator cycled
a dozen words, so every note was nearly every other note, and cross-file
deduplication appeared to be saving eighty per cent of the first sync. It was
measuring the generator. Real notes are distinct, and on distinct notes
cross-file deduplication saves nothing at all.

Latency is injected by a proxy in front of the server, applied to each direction
at half the round trip, with optional bandwidth throttling. 400ms and 2.6 MiB/s
is Sync Engine's published environment, so a figure here can at least be read
beside theirs.

## Results

Apple M4 Pro, 14 cores, Bun 1.4. `BENCH_SCALE=0.1`: 200 files, 17.8 MiB as the
devices see it.

| Round trip | First sync up | First sync down | 20 notes up | 20 notes down | Nothing changed |
|---|---|---|---|---|---|
| loopback | 12.1 s | 0.63 s | 0.25 s | 0.12 s | 0.01 s |
| 20 ms | 12.5 s | 0.67 s | 0.30 s | 0.14 s | 0.01 s |
| 100 ms | 12.7 s | 0.85 s | 0.45 s | 0.23 s | 0.01 s |
| 400 ms, 2.6 MiB/s | 14.7 s | 5.60 s | 1.07 s | 0.63 s | 0.01 s |

Correct on every one of them: 200 sent, 200 arrived, **0 wrong, 0 missing, 0
refused**.

Three numbers describe the design better than the timings do.

**Bytes.** 17.8 MiB of vault crosses as **10.7 MiB**, and that is compression
alone: chunks are deflated before they are sealed. Deduplication contributes
nothing here, because the notes are distinct, and on a real vault they are.
Twenty edited notes cost **20 chunks**, a few KiB, rather than twenty files, and
that is what chunking is actually for.

**Round trips.** **4 to upload 200 paths and 4 to download them**, at every
latency. It was 314 and 221, one per file, and that was the number latency
multiplied: at 400 ms it was two minutes of asking permission. A batched write
sends every entry's chunk names together and gets back one list of what the
server lacks; a batched read asks for every file's chunks in one fetch. The
batch is bounded at 256 entries and at 8 MiB of queued file, the second because
a queued file is pinned in memory until its batch goes.

**What is left is not the wire.** At 400 ms the upload spends 14.7 s to move
10.7 MiB, which the link itself would carry in 4. Almost all of the rest is the
server's `fsync`: a chunk costs one file flush and its share of a directory
flush, and an ack must not be sent before both. Doing them one at a time was
**29 of the first sync's 30 seconds** with the wire and most of the disk idle.
They now run sixteen at a time and each directory is flushed once per batch
rather than once per chunk, which is the same guarantee with less waiting.

That last figure is a laptop's. On Linux, where this actually runs, the same
3000 chunks go at 4527/s against 307/s here, because Go issues `F_FULLFSYNC` for
`File.Sync` on darwin and it flushes the whole drive cache. `go test
./internal/chunks -bench WriterWidth` prints both.

## Read beside Sync Engine, carefully

Their published figures: 2000 files uploaded in 9.43 minutes and downloaded in
5.87, over 400 ms of ping to a self-hosted Nextcloud, on NixOS with a CPU
scoring around 1700 single-core.

Different machine, different backend, different vault. Per file, at roughly the
same latency:

| | upload | download |
|---|---|---|
| Sync Engine, their machine, WebDAV | 0.28 s/file | 0.18 s/file |
| Basalt, this machine, 400 ms | 0.073 s/file | 0.028 s/file |

Read that as an order of magnitude and not as a race. Their number includes a
Nextcloud, a slower CPU, and ten times the files; ours includes a Go server on
the same laptop. What can be compared is the shape: their engine overlaps many
requests to hide latency, and this one now sends four requests in total, so
latency has almost nothing left to multiply.

The one-in-flight rule still holds and did not have to be given up to get here.
A reply carries no request id, so a second question in flight would resolve into
the first one's slot; batching sidesteps that entirely by making one question
cover two hundred files. Request ids remain unwritten and now buy very little.

What can be said without any race at all: an edit to a large note costs one
chunk here and costs the whole file on any backend that stores files. That
follows from the design, and no wire changes it.

## Why there is no table with their plugin measured on this machine

There should be one. It needs Obsidian, a Nextcloud or WebDAV server, their
plugin configured with its encryption, and every candidate measured in the same
afternoon on the same wire. That has not been done, and until it is, the numbers
above are ours and theirs are theirs.

## What adding latency found

Both were invisible on loopback and neither was subtle once the wire was slow.

A fetch is answered in binary frames rather than with a reply, so the timeout
armed for that reply was never disarmed. It fired later, mid-sync, and closed
the connection. On loopback every sync finishes long before a timeout; at 400 ms
each one died exactly one timeout after its first fetch, with most of the vault
missing.

And it reported success. The settle loop stops when a pass produces no work, and
a pass in which everything failed produces none, so a sync that lost its
connection half way through said it had finished. A run that ends with files
still failing now exits non-zero.

And once the round trips were gone, the benchmark stopped measuring the wire and
started measuring the server's disk, which is how the serial `fsync` above was
found. It had been there from the first commit, hidden behind three hundred
round trips that cost more.

## The other benchmark

`bun run bench` measures the parts rather than the whole: chunking throughput,
sealing, and bytes on the wire for one line inserted into a note. It warms up
before timing and alternates the order of anything compared, because the first
version did neither and reported a 2.7x gain where the honest figure was 1.3x.
