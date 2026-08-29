# Benchmark

`cd client && bun run bench:sync`. `BENCH_SCALE=1` for the full size,
`BENCH_WIRE=400` for one wire.

Correctness is reported next to the timings, which is
[Sync Engine](https://github.com/hesprs/sync-engine)'s idea. A sync benchmark
that reports only speed is measuring the wrong half, and this one has caught two
real defects.

The vault shape is theirs: many small notes, some medium, a few large, folders
several deep. Half the large files are incompressible, because prose compresses
and a chunk-size defect hid inside that for months. And the prose does not repeat
itself — the first generator cycled a dozen words, so every note was nearly every
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

Not worth doing: request ids, with 26 round trips left to overlap. Larger chunks
to cut fsyncs, which trades back a chunk size chosen by measurement against what
an edit costs.

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
