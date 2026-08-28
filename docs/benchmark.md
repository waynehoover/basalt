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

Apple M4 Pro, 14 cores, Bun 1.4. 200 files, 65.8 MiB as the devices see it.

| Round trip | First sync up | First sync down | 20 notes edited | Nothing changed |
|---|---|---|---|---|
| loopback | 32.7 s | 1.2 s | 0.46 s | 0.01 s |
| 100 ms | 83.2 s | 22.1 s | 4.6 s | 0.01 s |

Correct on every one of them: 200 sent, 200 arrived, **0 wrong, 0 missing, 0
refused**.

Two numbers do not move with the wire, and they are the ones that describe the
design.

**Bytes.** 17.8 MiB of vault crosses as **10.8 MiB**, and that is compression
alone: chunks are deflated before they are sealed. Deduplication contributes
nothing here, because the notes are distinct, and on a real vault they are.
Twenty edited notes cost **21 chunks**, a few KiB, rather than twenty files, and
that is what chunking is actually for.

**Round trips.** 314 to upload 200 paths, 221 to download them, at every
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
| Basalt, this machine, 400 ms | 1.02 s/file | 0.42 s/file |

**They are still faster per file on upload, and the reason is round trips.**
This client sends one request at a time: the transport allows exactly one in
flight, because a reply carries no request id and a second question would
resolve into the first one's slot. Their engine overlaps its requests.

Download used to be three round trips a file and is now one. Two of the three
were spent asking the server for a chunk list it had already sent in the batch
that announced the version. Removing them took the download at 100 ms from 64.6
seconds to 22.1.

So the honest summary is that these two designs are good at different things.
Basalt sends a quarter of the bytes and asks four times as often. On a fast link
the bytes win; on a slow one the round trips do, and theirs is the better
behaviour there today.

Upload is one request per path, which is already the minimum without changing
the protocol. Going below it means either request ids, so several questions can
be in flight at once, or a put that carries many entries. The second is the
larger win and does not touch the one-in-flight invariant: two hundred paths
would be four requests rather than three hundred. Neither is written.

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
