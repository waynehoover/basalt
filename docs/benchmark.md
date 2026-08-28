# Benchmark

`cd client && bun run bench:sync`, and `BENCH_SCALE=1` for the full size.

Correctness is reported next to the timings. That is not this project's idea: it
is [Sync Engine](https://github.com/hesprs/sync-engine)'s, whose harness
publishes an error count beside every result and found a competitor losing 98
files. A sync benchmark that reports only speed is measuring the wrong half.

## The vault

The shape is theirs, because it is closer to somebody's actual vault than
anything measured here before: many small notes, some medium ones, a few large
files, across folders up to five deep, with deterministic paths so a failure is
the same failure when it is looked at again.

One change. Half the large files are incompressible, and that matters more than
it sounds. Prose compresses, and a chunk-size defect lived here for months
because deflate made every sealed chunk smaller than its plaintext and the
overhead vanished into the saving. With bytes from the random source, which is
what a photo or a video is, it showed up on the first run: every attachment
large enough to hit a maximum-size cut was being refused, permanently.

## Results

Apple M4 Pro, 14 cores, Bun 1.4, client and server on loopback.

| | time | on the wire |
|---|---|---|
| First sync, 700 files, 65.8 MiB, upload | 13.27 s | 673 chunks, 16.2 MiB |
| First sync, download to a second device | 4.71 s | |
| A pass with nothing changed | 0.02 s | nothing |
| 20 notes edited, upload | 0.40 s | 21 chunks, 4 KiB |
| 20 notes edited, download | 0.16 s | |

| | |
|---|---|
| Files sent | 700 |
| Files arrived | 700 |
| Wrong or missing | **0** |
| Arrived unasked for | **0** |
| Refused for good | **0** |

Two numbers are the point.

65.8 MiB of vault crosses as **16.2 MiB**, because chunks are compressed before
they are sealed and identical chunks are stored once. And twenty edited notes
cost **21 chunks**, not twenty files: an edit sends the part that changed.

The pass over an unchanged vault costs 0.02 s and sends nothing. That is the
number that decides whether a sync client is usable on a large vault, and it
does not show up on three files.

## Why there is no table with other plugins in it

Sync Engine publishes 2000 files uploaded in 9.43 minutes against Remotely
Save's 16.4. Those were measured over a link with 400 ms of latency and
throttled bandwidth, against a self-hosted Nextcloud.

Putting the numbers above next to those would be dishonest. Different backend,
different network, different machine; the figures here are loopback and say what
the software costs, not what a network costs. A table combining them would
flatter whichever row happened to run on the better wire.

An honest comparison needs one machine, one network, and every plugin measured
on it in the same afternoon. That has not been done here. What can be said
without measuring anything is structural: an edit to a large note costs a chunk
here and costs the whole file on any backend that stores files, because there is
nothing else it could cost. That follows from the design rather than from a
race.

## The other benchmark

`bun run bench` measures the parts rather than the whole: chunking throughput,
sealing, and bytes on the wire for one line inserted into a note. It warms up
before timing and alternates the order of anything being compared, because the
first version of it did neither and reported a 2.7x gain where the honest figure
was 1.3x.
