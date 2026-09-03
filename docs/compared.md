# Compared, and measured

[Back to the README](../README.md)

Basalt was built against three other projects: Obsidian Sync, read out of the
shipped app, and two self-hosted plugins with public source. This is what
differs, what was learned from each, where theirs is better, and the numbers
behind the claims.

## Against Obsidian Sync

| | Obsidian Sync | Basalt |
|---|---|---|
| Where it runs | their servers | your box |
| Cost | subscription | electricity |
| Setup | sign in | run a binary, paste one string |
| Editing one line of a 2 MiB note | 2 MiB | 21.7 KiB |
| Encryption | optional | always |
| A server forging a version | not tested here | refused; every entry is authenticated by its writer |
| Merge conflicts | merged silently, failed hunks dropped | merged when provably safe, both kept otherwise |
| Plugins, themes, config | synced | not synced, and that one is still open |
| Mobile | iOS and Android | Android in daily use, iOS untested |
| Version history | in the app | in the app, and restoring never overwrites |
| Maturity | years in production | early |

**Transfer is the real difference.** Theirs keeps one hash per file and sends
the whole body when it changes. Basalt chunks on a rolling hash and sends only
what the server lacks. One line inserted, from `cd client && bun run bench`:

| Note | Whole file | Basalt | of that, the entry | |
|---|---|---|---|---|
| 4 KiB | 4.4 KiB | 1.9 KiB | 624 B | 2x |
| 32 KiB | 32.4 KiB | 4.9 KiB | 1.3 KiB | 7x |
| 128 KiB | 128.4 KiB | 5.8 KiB | 2.7 KiB | 22x |
| 512 KiB | 512.4 KiB | 9.6 KiB | 4.8 KiB | 54x |
| 2 MiB | 2.0 MiB | 21.7 KiB | 9.0 KiB | 94x |

Both columns include the entry, because both protocols send one. Ours names
every chunk of the new version, which is most of what a large note costs and
bounds the gap. That is why chunk size is chosen by `sqrt(NAME_BYTES * size)`
rather than by what one edit costs alone.

**Deletions lose to edits.** Deleted here and changed there, theirs propagates
the delete. Basalt restores the file.

**Where theirs is better**, and it is not close in places: nothing to run,
iOS, and years of production finding edge cases that were found here by reading
code. Whole-file upload also has fewer moving parts than chunking plus
deterministic sealing plus compression.

## Against Sync Engine and Fast Note Sync

[Sync Engine](https://github.com/hesprs/sync-engine) and
[Fast Note Sync](https://github.com/haierkeys/obsidian-fast-note-sync). Both are
good, both are further along, and reading them found real defects here.

**Chunks against streaming encryption.** Sync Engine encrypts as a stream with a
per-file salt: conventional, never holds a whole file, cannot deduplicate.
Basalt seals deterministically, so an edit to a large note costs one chunk and
a version history costs 73% to 90% less storage. The cost is that the server
learns when two chunks are identical.

**Refusing a merge against merging better.** Theirs is a real diff3 that splits
a document into regions first. Basalt applies diff-match-patch and adds four
checks: do the changed regions overlap, do both merge orders agree, did every
hunk apply, did every insertion survive. Ours is character-granular, so it
merges two devices editing different arguments of one function call. It also
merges a re-indented code block with a line appended to it into code that no
longer runs, which their region splitter would not.

**Where theirs is ahead:** hundreds and thousands of stars against a plugin
nobody has installed yet, storage you already pay for, and a listing in
Obsidian's community directory.

### Beside Sync Engine's published numbers, carefully

| 2000 files, 400 ms round trip | up | down |
|---|---|---|
| Sync Engine, their machine, Nextcloud over WebDAV | 9.43 min | 5.87 min |
| Basalt, Apple M4 Pro, Go server behind a latency proxy | 3.00 min | 1.89 min |

18 round trips up and 27 down, for 2000 files. 2000 arrived, 0 wrong. Not a
race: their backend is Nextcloud over WebDAV, their CPU is far slower, the
latency here is injected on loopback with no jitter, and their vault size is not
published. What survives all four is that moving 2000 files takes tens of round
trips rather than thousands, and that an edit to a large note costs one chunk
here and the whole file on any backend that stores files.

## Measured

```bash
cd client
bun run bench:sync      # a whole vault over four wires, timed and checked
bun run bench           # chunking, sealing, bytes on the wire
bun run scale           # 1,000 and 10,000 notes
bun run dedup           # what deduplication saves
```

Correctness is reported beside the timings, which is Sync Engine's idea, and it
has caught two real defects here. The vault shape is theirs: many small notes,
some medium, a few large, half the large ones incompressible, and prose that
does not repeat. Latency is injected by a proxy; 400 ms at 2.6 MiB/s is Sync
Engine's published environment.

**A whole vault.** 200 files, 17.8 MiB, Apple M4 Pro, under protocol 3. 200
arrived, 0 wrong, on every row.

| Round trip | Up | Down | 20 notes up | 20 notes down | Nothing changed |
|---|---|---|---|---|---|
| loopback | 11.9 s | 0.62 s | 0.24 s | 0.11 s | 0.00 s |
| 20 ms | 12.7 s | 0.85 s | 0.29 s | 0.13 s | 0.00 s |
| 100 ms | 12.6 s | 1.90 s | 0.44 s | 0.23 s | 0.00 s |
| 400 ms, 2.6 MiB/s | 15.8 s | 10.1 s | 1.07 s | 0.63 s | 0.01 s |

17.8 MiB crosses as 10.8 MiB from compression alone; dedup contributes nothing
because the notes are distinct. Four round trips each way at every latency, and
a pass over a settled vault is unmeasurable.

The download column is slower than this document used to claim, and the reason
is the harness rather than the client. The proxy now applies real back-pressure
in both directions, which it did not before, so a rate of 2.6 MiB/s is now
actually enforced on the way down: 10.8 MiB cannot arrive in less than about
four seconds, and it takes ten. The older figure was measured against a link
that was not really throttling, and it should not be compared with this one.

The upload cost is `fsync`, and macOS pays four to six times more of it than
Linux because Go issues `F_FULLFSYNC` there. Measured under an earlier protocol,
the same 200 files uploaded in 2.8 s on Linux against 12.2 s here, and the
400 ms upload was close to link-bound, so there is no large win left in the
server for a vault of notes. That comparison has not been repeated under
protocol 3 and is quoted as the earlier measurement it is.

**Scale.** Ten thousand notes of distinct prose, 21.1 MiB.

| | 1,000 notes | 10,000 notes |
|---|---|---|
| Chunks, of which distinct | 2,198 / 2,198 | 21,641 / 21,617 |
| Sealed bodies | 0.8 MiB | 8.1 MiB |
| Local index | 0.6 MiB | 5.6 MiB |
| A pass over an unchanged vault | 7 ms | 41 ms |
| Twenty notes edited | 20 chunks, 8.0 KiB | 20 chunks, 8.0 KiB |

Everything is linear in the note count, and editing twenty notes costs the same
at any vault size. Deduplication across files is worth 0.11%. Across versions
it is worth 73% to 90%: a note edited twenty times stores 26 chunks for 95
references when short and 41 for 410 when long. The machinery pays by noticing
that today's note is mostly yesterday's, which is also what makes an edit cost
one chunk on the wire.

**A large attachment**, whole sync, headless client, which streams:

| file | peak memory | time |
|---|---|---|
| 16 MiB | 144 MB | 0.4 s |
| 64 MiB | 220 MB | 1.6 s |
| 256 MiB | 291 MB | 6.5 s |

The plugin streams on desktop through the resource URL the webview already uses
for images. Mobile uses a different URL scheme that is untested and falls back
to reading the file whole, at roughly 210 MB plus 2.7 MB per MiB. That curve
sets the default 64 MiB file limit.

**A real vault.** The numbers above are a generated corpus. Run against a copy
of a real one, 3,751 files and 91 MB of notes and attachments, on loopback: the
first device uploaded it in 54 seconds as 11,307 chunks and 62.7 MiB on the
wire, which is 69% of the plaintext, and a second device joining by invite
downloaded the whole vault in 22 seconds. Every file arrived byte-identical,
and the server's own `verify -deep` checked 11,762 chunk references with 0
faults. An edit, a rename, a merge, a two-device conflict and a deletion all
behaved as documented, and the vault's dot-prefixed folders stayed where they
were.

**The entry authenticator** costs 2.2 microseconds per entry and 149 bytes on
the wire, about 2.7% of a first sync. A globally chained variant that would also
detect a withholding server was 12.7 microseconds and was rejected for what it
does to concurrent writers, not for its arithmetic.

### Measured and deliberately not done

- **A whole-file fast path for small notes.** Considered because most vaults
  are thousands of notes under 64 KB. Chunk size already scales with the file
  as `sqrt(64 * size)`, clamped to a 1 KiB average and a 512 byte floor, so a
  4 KiB note is about four chunks and an edit to it costs 1.9 KiB against
  4.4 KiB for the whole file. One chunk per small note would send more on
  every edit and store about a third more history, and a body inlined in the
  `put` would save one round trip that batching already amortises, at the
  price of a second code path through the most durability-critical part of the
  client. Kept as is, and the sizing constants are pinned by a test so the
  decision cannot drift into a re-chunk of every vault.
- **A global hash chain**, which would catch withholding. Serialises writers.
- **One transaction per batch.** 10x on the SQL, worth 0.7% of an upload, in
  exchange for making "an ack means durable" a per-batch argument.
- **A different deflate level or chunk-size targets.** Both are baked into the
  chunk name. Changing either re-chunks every vault in existence.
- **Larger chunks** to cut fsyncs. Trades back a size chosen by measurement.
- **Solid compression on a first sync.** 57% against 60% of plaintext, for a
  second code path through the most durability-critical part of the client.
- **node-diff3** for the merge. It conflicted on five of eight cases that merge
  cleanly here, including two devices appending to a daily note.

## What was borrowed

None of their code. Ideas, parameters and bug reports, each credited where used.

**[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)** (MIT) is
the largest debt: content-defined chunking from `splitPiecesRabinKarp` with its
48-byte window, chunk sizes split by text or binary, a regression test for
U+FEFF on a boundary, and the conclusion that text merging is solved. Not taken:
base64 for binary chunks, whole files in memory, and one-way HMAC for paths, all
consequences of CouchDB, and the last impossible here because a device restoring
a vault has to recover the real filename.

**Obsidian Sync** contributed `synchash`, one field per file remembering the
content as of the last sync, which turns a three-way merge into something
needing no version history. The merge construction is kept too, minus the step
that discards which hunks applied.

**Sync Engine** contributed reporting correctness beside speed, the benchmark
vault shape, and the 400 ms environment. Their issue 232, `rm` where the
platform should trash, was a live defect here too.

**Fast Note Sync** contributed issue 257: a path that is a file on one side and
a folder on the other, which Basalt retried forever one way and ignored the
other.

**obionesync**, the predecessor, is where every verified fact about Obsidian
Sync's protocol came from. Every bug found in it was silent, which is why unit
tests here are necessary and never sufficient.

## Libraries

**diff-match-patch** for the merge, unmaintained since 2020 and pinned to an
exact version. **fflate** for deflate. **modernc.org/sqlite**, so the server is
one static binary. **github.com/coder/websocket**.

Basalt is MIT, like LiveSync and like Obsidian's own plugin API declarations.
