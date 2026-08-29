# Compared, and where it came from

Basalt was built against three other projects: Obsidian Sync, whose behaviour was
read out of the shipped app, and two self-hosted plugins whose source is public.
This is what differs, what was learned from each, and where theirs is better.

## Against Obsidian Sync

| | Obsidian Sync | Basalt |
|---|---|---|
| Where it runs | their servers | your box |
| Cost | subscription | electricity |
| Setup | sign in | run a binary, paste one string |
| Editing one line of a 2 MiB note | 2 MiB | 494 B |
| Encryption | optional | always |
| Merge conflicts | merged silently, failures dropped | merged when provably safe, both kept otherwise |
| Plugins, themes, config | syncs them | refuses to |
| Mobile | works today | never run on a phone |
| Maturity | years in production | early |

**Transfer is the real difference.** Theirs keeps one hash per file and pushes
the whole body when it changes; the 2 MB websocket pieces are framing, not
identity, so nothing can be skipped. Basalt chunks on a rolling hash and sends
only what the server lacks. One line inserted:

| Note | Theirs | Basalt | |
|---|---|---|---|
| 4 KiB | 4 KiB | 284 B | 15x |
| 128 KiB | 128 KiB | 349 B | 376x |
| 2 MiB | 2 MiB | 494 B | 4245x |

The gap grows with the file, which is the point: a vault accumulates long notes.
Basalt also deflates each chunk before sealing it, taking a full upload of a
vault's text from 108% of plaintext to 67%.

**Deletions lose to edits, in both directions.** Deleted here and changed there,
theirs propagates the delete; Basalt restores the file.

**Where theirs is better**, and it is not close in places: nothing to run, mobile
that works today, version history you can look at, and years of production
finding edge cases that were found here by reading code. Whole-file upload also
has fewer moving parts than chunking plus deterministic sealing plus
compression, and larger machinery has more ways to be wrong.

## Against Sync Engine and Fast Note Sync

[Sync Engine](https://github.com/hesprs/sync-engine) and
[Fast Note Sync](https://github.com/haierkeys/obsidian-fast-note-sync). Both are
good, both are further along, and reading them found real defects here.

**Chunks against streaming encryption.** Sync Engine encrypts as a stream with a
per-file salt: conventional, never holds a whole file, and cannot deduplicate.
Basalt seals deterministically, so an edit to a 2 MiB note costs one chunk and
the same content in two files is stored once — at the cost of holding a file plus
one chunk in memory, and of the server learning that two chunks are identical.

**Refusing a merge against merging better.** Theirs is a real diff3 that splits
a document into regions first. Basalt applies diff-match-patch patches and adds
four checks the library does not: do the changed regions overlap, does merging
both ways round agree, did every hunk apply, did every insertion survive. Ours
is character-granular, which merges two devices editing different arguments of
`compute(1, 2)`. It also merges a re-indented Python block with a line appended
to it into code that no longer runs, which their region splitter would not.

**Where theirs is ahead:** they run on phones, they have 351 and 2890 stars
against a plugin that has run in a real vault once, they work with storage you
already pay for, and they are installable from Obsidian's community list.

## What was borrowed

None of their code is copied. What was taken is ideas, parameters and bug
reports, each credited where it is used.

**[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)** (MIT) is
the largest debt. Content-defined chunking comes from `splitPiecesRabinKarp`,
including its 48-byte window, along with splitting chunk sizes by text or binary,
a regression test for U+FEFF on a boundary, and the conclusion that text merging
is solved and should not be reinvented. Three things are deliberately not taken,
all consequences of CouchDB rather than mistakes: base64 for binary chunks,
reading whole files into memory, and a one-way HMAC for paths, which cannot work
here because a device restoring a vault has to recover the real filename.

**Obsidian Sync** contributed `synchash`: one field per file remembering the
content as of the last sync turns a three-way merge into something needing no
version history. The merge construction is kept too, both cleanup passes
included, minus the step that discards which hunks applied.

**Sync Engine** contributed reporting correctness beside speed, which their
harness does and which caught a competitor losing 98 files. Also the benchmark
vault shape and their published 400 ms environment. Their issue 232 — `rm` where
the platform should trash — was a live defect here too.

**Fast Note Sync** contributed issue 257: a path that is a file on one side and a
folder on the other, which Basalt retried forever one way and ignored the other.

**obionesync**, the predecessor, is where every verified Obsidian Sync protocol
fact came from first. Every bug found in it was a silent one, which is why unit
tests are necessary here and never sufficient.

## Evaluated, not used

**node-diff3.** Maintained and pure JavaScript, with the conflicting-region
notion diff-match-patch lacks. It conflicted on five of eight cases that merge
cleanly here, including two devices appending to a daily note, and caught nothing
the existing checks miss. It is line-wise, and a Markdown paragraph is one line.

**Solid compression on a first sync.** Per-chunk deflate sends 60% of the
plaintext and one solid stream sends 57%. Five per cent, against a second code
path through the most durability-critical part of the client.

Basalt itself is MIT, like LiveSync and like Obsidian's own plugin API
declarations.

## Libraries

**diff-match-patch**, the merge, unmaintained since 2020 and a known risk.
**fflate** for deflate. **modernc.org/sqlite**, so the server is one static
binary. **github.com/coder/websocket**.
