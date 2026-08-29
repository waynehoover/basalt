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

`BENCH_SCALE=1`: 2000 files, 213.6 MiB, at 400 ms and 2.6 MiB/s. 167.2 s up,
64.2 s down, **26 round trips each way**, and an edit to 20 notes still costs
1.21 s and 21 chunks whatever the size of the vault around it.

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

The two numbers together say what the laptop figures cost. The 2000 file upload
moves 125 MiB, which the 2.6 MiB/s link carries in 48 s, and takes 167 s; its
33261 chunks account for 108 s of that at this machine's 307/s. At Linux's rate
the same chunks are 7 s, which would put the upload within a few seconds of the
bandwidth floor. That last step is arithmetic over a measured rate and not an
end-to-end measurement: the benchmark has only ever been run on macOS.

## Read beside Sync Engine, carefully

Their published figures: 2000 files uploaded in 9.43 minutes and downloaded in
5.87, over 400 ms of ping to a self-hosted Nextcloud, on NixOS with a CPU
scoring around 1700 single-core.

`BENCH_SCALE=1` is 2000 files, which is their count, at the same nominal
latency:

| 2000 files, 400 ms | upload | download |
|---|---|---|
| Sync Engine, their machine, Nextcloud over WebDAV | 9.43 min | 5.87 min |
| Basalt, this machine, Go server behind a latency proxy | **2.79 min** | **1.07 min** |
| | 0.084 s/file | 0.032 s/file |
| | *theirs: 0.283 s/file* | *theirs: 0.176 s/file* |

2000 files, 2000 arrived, 0 wrong, 0 missing. 26 round trips in each direction.

**This is not a race and must not be quoted as one.** Four things differ and
three of them favour us:

- **Their backend is Nextcloud over WebDAV**; ours is a Go binary written for
  this. Much of their per-file cost is PHP and HTTP rather than their engine.
  That gap is a real consequence of refusing every backend but one, and it is
  still not a comparison between two clients.
- **Their CPU scores around 1700 single-core; this is an M4 Pro.**
- **The 400 ms here is injected on loopback**: no jitter, no loss, no TLS, and
  none of the congestion behaviour of a real long link.
- **Vault size is unknown on their side.** Ours is 213.6 MiB, which is a large
  one. If theirs was 2000 small notes, their bytes were fewer than ours.

What survives all four, because none of it depends on the machine: 26 round
trips to move 2000 files, against an engine that has to overlap many requests to
hide one per file, and an edit to a large note that costs one chunk here and the
whole file on any backend that stores files.

The one-in-flight rule still holds and did not have to be given up to get here.
A reply carries no request id, so a second question in flight would resolve into
the first one's slot; batching sidesteps that entirely by making one question
cover two hundred files. Request ids remain unwritten and now buy very little.

What can be said without any race at all: an edit to a large note costs one
chunk here and costs the whole file on any backend that stores files. That
follows from the design, and no wire changes it.

## What is next, in the order it is worth doing

Ranked by what the measurements above say, not by what sounds interesting.

**1. Run this on Linux.** The only number here that is not honest about the
deployment. 108 of the 2000-file upload's 167 seconds are this laptop's
`F_FULLFSYNC`; on Linux the same chunks are about 7. Nothing else on this list
matters until the platform it ships on has been measured end to end, and until
it has, every upload figure in this document is a laptop's.

**2. Then stop, probably.** After that the upload is within a few seconds of
what a 2.6 MiB/s link can carry and the download already is: 64 s against a 48 s
floor. There is no round trip left to remove and no obvious byte left to save,
so the next honest step is to find that out rather than to keep optimising.

**3. Run it on a phone.** Never done. It is last on a performance list and first
on every other one: WebCrypto in a webview, memory pressure during a first sync,
and a battery are all unmeasured, and any of them could make the numbers above
irrelevant on the device most people sync to.

**4. Measure their plugin on this machine.** See below. It is the only thing
that would turn the comparison above into a comparison.

### Measured and not worth doing

**Solid compression on a first sync.** The idea: compress the whole first push
as one stream rather than each chunk separately, so the dictionary spans files.
Measured on the benchmark vault, per-chunk deflate sends 60% of the plaintext
and one solid stream sends 57%. **It saves 5%,** and it would cost a second code
path through the most durability-critical part of the client, break content
addressing (a chunk of a compressed stream is not a chunk of a file), and give
up per-edit updates for anything sent that way.

An earlier estimate of this said 43%, and it was measured against the benchmark
generator's first version, which cycled a dozen words. That is the same trap
documented at the top of this file, walked into a second time.

**Request ids, so several questions can be in flight.** Worth a great deal
before batching and very little after: there are 26 round trips in a 2000-file
sync to overlap. The one-in-flight rule stays, and it stays for free.

**Fewer, larger chunks to cut the fsync count.** 33261 chunks is 33261 file
flushes, and doubling the chunk size halves them. But the chunk size was already
chosen by measurement against what an edit costs, and 1024 beat 256 on every
axis; trading that back to save disk flushes on a first sync is optimising the
one operation that happens once. Revisit only if step 1 shows the flushes still
dominate on Linux, which the 4527/s figure says they will not.

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
