# The index as a journal and a snapshot

A spec, not an implementation. It replaces rewriting the whole index on every
change with appending what changed, and it exists because the index is the one
client file whose corruption the first rule is about.

Nothing here is decided until the crash semantics below are agreed, because
that is the part that cannot be fixed later by a patch.

## Why, and why not a database

`improvements.md` section 4 asks for a database, and the honest reasons against
it are not about speed. A full rewrite costs 4 ms at ten thousand notes
(`docs/compared.md`), so the cliff it worried about is not there. The reasons
are:

- **SQLite cannot ship where the problem is.** The plugin has no Node on
  mobile, so SQLite means WASM, which persists as one file blob written through
  the same adapter: the identical whole-file write, plus a WASM dependency,
  plus a second storage path through the file the first rule is about.
- **IndexedDB cannot ship where the CLI is.** Node has no IndexedDB. It works
  well in the plugin, and obsidian-livesync proves it at scale on both
  platforms, but adopting it means SQLite or a shim on the CLI: two
  implementations of one index, kept identical by hand forever.

A journal is the only option that is **one implementation on both shells**,
because both already have the primitive. Obsidian's `DataAdapter` has `append`
and `appendBinary`; Node has `appendFile`. It also keeps the index inside the
vault directory, where the rest of the device's state lives.

## The invariant everything rests on

From `plugin/vault.ts`, on choosing the live index over a staged copy:

> an older index is always safe, because notes are durable before the index
> that names them.

This is what makes a journal viable. Losing the tail of the index is not
losing data, it is redoing work: the engine rescans, re-derives, and reapplies
from an older cursor. So the recovery rule for every ambiguous case below is
the same, **fall back to something older**, never to something empty (rule 2)
and never to something guessed.

## Files

Two, both beside today's index, in the plugin's data folder or the CLI's
config dir.

| file | what it is |
|---|---|
| `index.json` | a snapshot: exactly today's `StoredState` JSON, plus a `seq` |
| `index.log` | records appended since that snapshot |

`index.json` keeping today's shape is deliberate: a vault with a snapshot and
no log loads exactly as it does now, so there is no migration step.

## Record format

One record per line, newline terminated:

```
<seq> <crc32> <json>\n
```

- `seq` is a decimal integer, strictly increasing, never reused.
- `crc32` is a hex CRC-32 of the JSON text alone.
- `json` is an object holding **absolute values, never increments**, so that
  replaying a record twice is the same as replaying it once.

```json
{ "cursor": 51, "set": { "Note.md": { ... } }, "del": ["Old.md"],
  "remote": { "Note.md": { ... } }, "unremote": [], "pending": ["A.md"] }
```

`pending` is written whole because it is small and order matters. `entries`
and `remote` are written as `set` and `del` because they are the large ones and
a pass touches few of them.

A record is **valid** only if the line is newline terminated, the CRC matches,
and the JSON parses. Anything else ends the journal at that point.

## Save

1. Compute the delta against the last saved state held in memory.
2. If the delta is empty, write nothing. (Today's `LastIndexWrite` exists for
   exactly this; a settled vault must stay silent.)
3. Append one record. Flush, and fsync where the shell can.
4. Verify the outcome, not the call (rule 4): stat the log and confirm it grew
   by the bytes written. A short append is a failure and must raise.
5. If the log now exceeds the snapshot policy below, snapshot.

## Snapshot

Written with the machinery that already exists, unchanged: the CLI stages to a
temp and renames; the plugin stages a copy, writes in place, and reads it back
to verify, because its adapter will not rename onto an occupied file.

Ordering, and it is the only ordering that is correct:

1. Write the new `index.json` (containing `seq` = the last record folded in)
   and make it durable.
2. **Only then** truncate `index.log`.

A crash between the two leaves a snapshot at seq N and a log containing records
up to and including seq N. That is why records carry `seq`: on load, every
record with `seq <= snapshot.seq` is skipped. The window is exact, not
idempotent-by-luck.

Truncating rather than deleting keeps the file present, so a missing log and an
empty log stay distinguishable.

**Policy:** snapshot when the log exceeds 25% of the snapshot's size, or 1000
records, whichever comes first. Both are guesses and both must be measured
before they are believed; the test that pins them should assert the policy, not
the constants.

## Load

1. Read `index.json`. If it is absent, treat the snapshot as empty at seq 0.
   If it is present but unreadable or does not parse, **refuse** (rule 2, and
   the incident behind it: falling back to empty and writing that back
   disabled every plugin on a device).
2. `validateStoredState` it, as today.
3. Read `index.log` if present. Replay records in order:
   - skip any with `seq <= snapshot.seq`;
   - stop at the first invalid record, and discard it and everything after it;
   - stop also at a `seq` that is not greater than the previous one applied.
4. `validateStoredState` the result. If the replayed state fails validation but
   the snapshot alone passes, **use the snapshot alone** and say so in the log.
   An older index is safe; a self-inconsistent one is not.
5. Record the recovered state as "what is on disk", so a first pass that
   changes nothing writes nothing.

## What can go wrong, and what happens

| situation | what load does |
|---|---|
| no snapshot, no log | fresh device, empty state |
| snapshot only | loads as today |
| torn last record | discard it, keep everything before it |
| corruption mid-log | discard from there on, keep everything before it |
| log entirely garbage | use the snapshot alone, log loudly |
| log's first seq > snapshot.seq + 1 | records were lost; use the snapshot alone, log loudly |
| log seq <= snapshot.seq | already folded in, skip |
| snapshot unreadable, log intact | **refuse.** The log is a delta against a base that cannot be read, so applying it would invent a state that never existed |
| snapshot corrupt, log absent | refuse, as today |

The mid-log and torn-tail cases cannot be told apart, and do not need to be:
truncating at the first bad record yields an older index either way.

## What this does not fix

- **fsync on phones.** The plugin's adapter offers no way to force one, so a
  journal there is as best-effort as today's write. This is not a regression,
  and it is not an improvement either. `improvements.md` section 6 already
  tracks it.
- **Two writers.** A journal has the same single-writer requirement the current
  file has. The CLI's lock still governs; the plugin is one instance.
- **A downgrade.** An older client reads `index.json` and ignores the log,
  silently dropping up to one journal's worth of recent state. Safe by the
  invariant, bounded by the snapshot policy, but it should be stated in the
  release notes rather than discovered.

## Tests that must exist before this is finished

Rule 9 applies to each: write it, watch it fail, then make it pass.

1. A record torn mid-line is discarded and everything before it survives.
2. A record with a good line and a bad CRC is discarded (a torn write that
   happens to land on a newline).
3. NUL padding after the last record, which some filesystems leave on a crash,
   is discarded and does not parse as a record.
4. A crash between snapshot and truncate: snapshot at seq N, log holding
   1..N, loads to exactly the snapshot, and no record is applied twice.
5. A log whose first seq skips ahead falls back to the snapshot alone.
6. An unreadable snapshot with a healthy log refuses, and does not write
   anything back.
7. A settled vault appends nothing across many passes.
8. The snapshot policy triggers, and the log is empty afterwards while the
   state is unchanged across the boundary.
9. Both shells produce byte-identical journals for the same sequence of
   changes, which is the property that keeps one implementation honest.
10. A vault holding today's `index.json` and no log loads unchanged.

## Order of work

1. The record codec and replay, pure and in `core`, with tests 1 to 5 and 10.
   No I/O, so this is where the crash semantics get pinned cheaply.
2. The two adapter methods, `append` and a size stat, one per shell.
3. Wire `IndexStore`, keeping `load` and `save` exactly as they are to callers.
4. Snapshot policy, then measure it and replace the guesses.
