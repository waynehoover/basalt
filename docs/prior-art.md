# Prior art

Nothing here was invented from nothing. This is every project that shaped
Basalt, what specifically came from each, and where it is used. It is a credits
list and also a map: if you want to know why a decision was made, the answer is
usually in one of these.

None of their code is copied. What was taken is ideas, parameters, measurements,
and bug reports, and each is attributed at the place it is used as well as here.

---

## Self-hosted LiveSync

<https://github.com/vrtmrz/obsidian-livesync> · MIT · **the largest debt**

The source of the central idea. Read at 1.0.21.

- **Content-defined chunking.** `splitPiecesRabinKarp` is where the whole
  approach comes from: a rolling hash decides boundaries, so inserting a line
  near the start of a note changes one chunk instead of shifting every chunk
  after it. The 48-byte window is theirs and is kept. `client/src/core/chunk.ts`
  documents the algorithm in full, including the two places it departs.
- **Separate chunk sizes for text and binary**, for the reason they separate
  them.
- **The confirmation that text merging is a solved problem** rather than
  something to invent, and that diff-match-patch is what solves it.
- **A regression test for U+FEFF** landing on a chunk boundary, which they carry
  and which is now carried here.
- **What not to do, in three places, all of them consequences of CouchDB rather
  than mistakes:** base64-encoding binary chunks (a third on top of the wire),
  reading whole files into memory instead of streaming, and a one-way HMAC for
  path obfuscation. The last is the interesting one: it is smaller than what
  Basalt does, and it cannot work here, because a device restoring a vault has
  to recover the real filename to write it to disk. `client/src/core/crypto.ts`
  has the trap written out.
- **Eden**, their small-file optimisation, which is not taken and is explained
  in `docs/client-design.md`.

LiveSync does considerably more than this will: CouchDB and S3 backends,
peer-to-peer, plugin sync, conflict dialogs. If you need any of that, use it.

## Obsidian Sync

Not a repository. Closed source, verified by reading the shipped bundle
(`app.js`, extracted from the asar and run through prettier).

- **`synchash` as the three-way-merge common ancestor.** The single most useful
  idea in their engine: one field per file remembering the content as of the
  last successful sync turns a three-way merge into something that needs no
  version history at all. `docs/client-design.md`.
- **The merge construction at `app.js:118574`**, kept almost entirely, including
  both diff-match-patch cleanup passes.
- **The defect in it**, which is the reason this project exists. `patch_apply`
  returns `[text, appliedFlags]` and theirs takes `[0]`, so a hunk that could
  not be placed is dropped and the result returned as a success. That is a lost
  edit reported as a success. `client/src/core/merge.ts` inverts it.
- **The size-scaled write debounce**, because somebody typing generates a save
  every few seconds and acting on each one costs more than waiting does.
- **Six more silent failures**, each of which a rule in `docs/protocol.md`
  inverts. `docs/vs-obsidian-sync.md` is the comparison, including where theirs
  is better.

## Sync Engine

<https://github.com/hesprs/sync-engine> · **the sharpest benchmark**

- **Reporting correctness next to speed.** Their harness prints an error count
  beside every timing, and it caught a competitor losing 98 files. A sync
  benchmark that reports only speed is measuring the wrong half. Copied
  wholesale, and it has already earned its keep here.
- **The benchmark vault shape**: many small notes, some medium, a few large,
  across folders several deep. `client/bench-sync.ts`, with two changes of our
  own that are documented there.
- **Their published environment**, 400 ms and 2.6 MiB/s, which is why
  `client/src/core/latency.ts` exists at all and why a figure from this project
  can be read beside theirs. `docs/benchmark.md`.
- **Their issue 232**, `rm` where the platform should trash. The headless client
  here had the same defect, word for word, and it was destroying files.
  `client/src/node/vault.ts`.
- **An overwrite risk on canvas files** reported against their neighbours, which
  is why `mergeText` takes a `stillValid` predicate.
- **Region-aware diff3**, which they have and this does not. It handles a case
  Basalt gets wrong, named in `docs/tradeoffs.md`.
- **Streaming encryption with a per-file salt**, the design this one is
  measured against in `docs/tradeoffs.md`.

## Fast Note Sync

<https://github.com/haierkeys/obsidian-fast-note-sync>

The same shape as this project: a Go server and a TypeScript plugin.

- **Their issue 257**: an offline device receiving a path that is a file on one
  side and a folder on the other. Basalt retried it for ever in one direction
  and silently ignored it in the other. `client/src/node/clash.test.ts`.

## obionesync

`~/code/obionesync`, not public. The predecessor, which piggybacks Obsidian's
own engine rather than replacing it.

- **Every verified protocol fact about Obsidian Sync** in this repository came
  from there first.
- **The reason this project exists.** Every real bug found in it was a *silent*
  failure that only appeared when the system ran, which is why `CLAUDE.md` says
  unit tests are necessary and never sufficient.

---

## Evaluated and not used

Recorded because a rejection with a measurement behind it is worth more than one
without.

- **node-diff3** (<https://github.com/bhousel/node-diff3>, 3.2.1). Maintained,
  pure JavaScript, and has the notion of a conflicting region that
  diff-match-patch lacks. It conflicted on five of the eight cases that merge
  cleanly here, including two devices appending to a daily note, and caught
  nothing the existing checks miss. It is line-wise, and a Markdown paragraph is
  one line. `client/src/core/merge.ts`.

## Libraries relied on

- **diff-match-patch** — the merge. Unmaintained since 2020, which
  `client/src/core/merge.ts` records as a known risk.
- **fflate** — deflate, in the browser and in Node.
- **modernc.org/sqlite** — pure-Go SQLite, so the server is one static binary
  with no cgo.
- **github.com/coder/websocket** — the server's WebSocket.
