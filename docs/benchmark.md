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
folders several deep, with deterministic paths. One change, and it matters. Half
the large files are incompressible, because prose compresses and a chunk-size
defect lived here for months hidden inside that saving.

Latency is injected by a proxy in front of the server, applied to each direction
at half the round trip, with optional bandwidth throttling. 400ms and 2.6 MiB/s
is Sync Engine's published environment, so a figure here can at least be read
beside theirs.

## Results

Apple M4 Pro, 14 cores, Bun 1.4. 200 files, 65.8 MiB as the devices see it.

| Round trip | First sync up | First sync down | 20 notes edited | Nothing changed |
|---|---|---|---|---|
| loopback | 6.2 s | 3.0 s | 0.48 s | 0.01 s |
| 20 ms | 17.0 s | 16.2 s | 1.4 s | 0.01 s |
| 100 ms | 56.2 s | 64.6 s | 4.6 s | 0.01 s |
| 400 ms, 2.6 MiB/s | 203.5 s | 247.8 s | 16.6 s | 0.01 s |

Correct on every one of them: 200 sent, 200 arrived, **0 wrong, 0 missing, 0
refused**.

Two numbers do not move with the wire, and they are the ones that describe the
design.

**Bytes.** 65.8 MiB of vault crosses as **16.2 MiB**, because chunks are
compressed before they are sealed and identical chunks are stored once. Twenty
edited notes cost **21 chunks**, about 4 KiB, rather than twenty files.

**Round trips.** 314 to upload 200 files, 661 to download them, at every
latency. That is the number latency multiplies, and it is where this design is
weak.

## Read beside Sync Engine, carefully

Their published figures: 2000 files uploaded in 9.43 minutes and downloaded in
5.87, over 400 ms of ping to a self-hosted Nextcloud, on NixOS with a CPU
scoring around 1700 single-core.

Different machine, different backend, different vault. Per file, at roughly the
same latency:

| | upload | download |
|---|---|---|
| Sync Engine, their machine, WebDAV | 0.28 s/file | 0.18 s/file |
| Basalt, this machine, 400 ms | 1.02 s/file | 1.24 s/file |

**They are several times faster per file, and the reason is round trips.** This
client sends one request at a time: the transport allows exactly one in flight,
because a reply carries no request id and a second question would resolve into
the first one's slot. At 400 ms, 661 serialised round trips is 264 seconds
before anything else is counted, and that is essentially the whole download
time. Their engine overlaps its requests.

So the honest summary is that these two designs are good at different things.
Basalt sends a quarter of the bytes and asks four times as often. On a fast link
the bytes win; on a slow one the round trips do, and theirs is the better
behaviour there today.

Fixing it means request ids in the protocol, so several questions can be in
flight and matched to their answers. That is a real change to a load-bearing
invariant, it is not written, and it is the largest performance improvement
available here.

What can be said without any of this: an edit to a large note costs one chunk
here and costs the whole file on any backend that stores files. That follows
from the design rather than from a race, and no wire changes it.

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

## The other benchmark

`bun run bench` measures the parts rather than the whole: chunking throughput,
sealing, and bytes on the wire for one line inserted into a note. It warms up
before timing and alternates the order of anything compared, because the first
version did neither and reported a 2.7x gain where the honest figure was 1.3x.
