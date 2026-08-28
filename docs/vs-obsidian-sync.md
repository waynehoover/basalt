# Basalt and Obsidian Sync, side by side

Every claim about Obsidian Sync here was read out of the shipped artifact:
`app.js` from Obsidian 1.13.7, extracted from its asar and formatted. Line
references are into that formatted file, or into
`obsidian-sync-engine.js`, the 1,851-line region containing the engine. Nothing
here is inferred from documentation or from behaviour.

Where Obsidian Sync is better, it says so. A comparison that finds no fault with
the thing writing it is not a comparison.

## The short version

| | Obsidian Sync | Basalt |
|---|---|---|
| Where it runs | their servers | your box |
| Cost | subscription | electricity |
| Setup | sign in | run a binary, paste one string |
| What travels for an edit | the whole file | the chunks that changed |
| Editing one line of a 2 MiB note | 2 MiB | 494 B |
| Encryption | optional end-to-end | always, and not optional |
| Merge conflicts | merged silently, failures dropped | merged when provably safe, both kept otherwise |
| Version history | in their UI | on the server, not yet exposed |
| Plugins, themes, config | syncs them | refuses to |
| Mobile | works today | untested, no client yet |
| Maturity | years in production | early |

## Transfer, which is the biggest difference

Obsidian Sync keeps **one hash per file** and pushes the whole body whenever that
hash changes. In `obsidian-sync-engine.js` the upload path reads the file with
`readBinary(path)` and hands the entire buffer to `push(path, previouspath,
folder, deleted, ctime, mtime, hash, data)` at line 1787. The body is split into
2 MB pieces for the websocket, but those pieces are framing, not deduplication:
there is no per-piece identity, so nothing can be skipped.

Basalt chunks on a rolling hash and sends only the chunks the server lacks.
Measured, one line inserted into a note:

| Note | Obsidian Sync sends | Basalt sends | |
|---|---|---|---|
| 4 KiB | 4 KiB | 284 B | 15x less |
| 32 KiB | 32 KiB | 359 B | 91x less |
| 128 KiB | 128 KiB | 349 B | 376x less |
| 512 KiB | 512 KiB | 444 B | 1181x less |
| 2 MiB | 2 MiB | 494 B | 4245x less |

The gap grows with the file, which is the property that matters: a vault
accumulates long notes, and the cost of editing one should not grow with it.

Both do avoid the pointless case. Obsidian skips the upload when the server's
hash already matches (line 1786), so saving a file without changing it costs
nothing on either system.

Basalt also compresses each chunk before encrypting it, which takes a full
upload of a vault's text from 108% of its plaintext to 67%. Obsidian Sync sends
bodies uncompressed as far as the engine shows.

## Encryption

| | Obsidian Sync | Basalt |
|---|---|---|
| End-to-end | optional, per vault | always |
| Server sees file names | yes, unless E2E is on | never |
| Server sees content | yes, unless E2E is on | never |
| Key derivation | on the device | on the device |
| Deduplication under encryption | none to lose | works, because sealing is deterministic |

With end-to-end encryption enabled, Obsidian's engine encrypts paths
deterministically too: the push path calls `deterministicDecodeStr` on both
`path` and `hash` when a change arrives (`obsidian-sync-engine.js` around line
1770), so the server is comparing opaque equal-for-equal strings exactly as
Basalt's does.

The difference is that in Basalt it is not a setting. There is no configuration in
which the server can read a note, and no code path that would let it.

## Conflicts and merging

This is where Basalt deliberately does more work, and it is worth being precise
because the difference is not "ours is better", it is "ours refuses more often".

Obsidian's merge, whole, at `app.js:118574`:

```js
function bZ(base, mine, theirs) {
  const r = dmp.diff_main(base, mine, true, 0);
  if (r.length > 2) { dmp.diff_cleanupSemantic(r); dmp.diff_cleanupEfficiency(r); }
  return dmp.patch_apply(dmp.patch_make(base, r), theirs)[0];
}
```

`patch_apply` returns `[text, appliedFlags]`. Taking `[0]` discards which hunks
landed, so a hunk that could not be placed is dropped and the result is returned
as a success.

Basalt uses the same construction, keeps both cleanup passes, and then adds three
checks. Each was measured, by disabling it and seeing what broke:

| Check | Catches |
|---|---|
| Changed regions overlap | two sides rewriting the same sentence, which the library splices into a sentence neither wrote |
| Merge both ways round, compare | a hunk placed in the wrong place, which the library does in repetitive content and reports as success |
| Applied flags, insertion survival | nothing any constructed input reaches; kept as backstops |

The two failures worth seeing, both produced by the real library:

```
base    The original sentence.
mine    My completely different sentence.
theirs  Their entirely other sentence.
result  My completely different entirely other sentence.
```

```
a note of twelve similar sections
mine    edits section 3
theirs  deletes sections 0 to 2
result  the edit lands on section 6, every flag true
```

Neither loses text. Both change meaning, and both report success.

When Basalt refuses, it keeps both versions and names one a conflict copy, using
Obsidian's naming shape. It differs on which version moves: Obsidian puts the
**local** content in the conflict copy and overwrites the file with the
**server's**, so a sync rewrites the file you have open and your version appears
somewhere you were not looking. Basalt leaves local in place and gives the
incoming version the new name.

Obsidian also merges only markdown, and only when the server's hash differs from
the remembered one (`obsidian-sync-engine.js:1471`). Everything else is
last-writer-wins by mtime. Basalt keeps the same guard and, where Obsidian
resolves by mtime with no common ancestor, keeps both instead.

## Deletions

| Situation | Obsidian Sync | Basalt |
|---|---|---|
| Deleted here, unchanged there | propagates the delete | propagates the delete |
| Deleted there, unchanged here | propagates the delete | propagates the delete |
| Deleted here, **changed** there | propagates the delete | restores the file |
| Deleted there, **changed** here | conflicted copy | keeps local and re-uploads |
| Recovering a deletion | version history in their UI | server holds it; no client-side recovery yet |

The two middle rows are the same decision twice: a deletion can be repeated, and
an edit that is gone from both the device that made it and the server cannot be
recovered. Basalt keeps the note and says so in the log.

## What each one syncs

| | Obsidian Sync | Basalt |
|---|---|---|
| Notes and attachments | yes | yes |
| Folder structure | yes | yes |
| Plugins, themes, snippets | yes, selectively | refused |
| Core and plugin settings | yes, selectively | refused |
| Hidden and config files | yes, via `scanSpecialFiles` | refused |
| Excluding files by type or size | settings for it | no |

The refusals are in `docs/philosophy.md` and are decisions rather than gaps.
Plugin sync in particular means one device can disable every plugin on another,
which is where one of the durability rules came from.

## The index each keeps

Nearly identical, and Basalt's is Obsidian's with one field added. Obsidian's
entry shape, at `obsidian-sync-engine.js:838`:

```
path, previouspath, folder, ctime, mtime, size, hash, synctime, synchash
```

`synchash` is the content hash as of the last successful sync: the common
ancestor, which turns a three-way merge into something that needs no version
history on the device. It is one field, and it is the best idea in the engine.

Basalt keeps all of that, plus the **chunk list** for the cached hash. Obsidian
stops at the hash because it uploads whole files; Basalt uploads chunks, so a
cached hash with no chunk list would still mean re-reading, re-chunking,
re-compressing and re-encrypting a file to learn what it already knows.

Both invalidate the cache the same way, and it is the whole cost of a routine
scan: if mtime and size have not moved, the file is not opened. Obsidian's line
is `(i.mtime && i.mtime === o && i.size === r.size) || (i.hash = "")`.

## Rate limiting and retries

Copied from Obsidian almost unchanged, because it is well judged:

| | |
|---|---|
| Write coalescing | 10 s under 10 KiB, 20 s under 100 KiB, 30 s above (`:930`) |
| Per-file retry backoff | `5 * 2^n` seconds, capped at 5 minutes (`:960`) |
| A failing path blocks its children | a retry entry blocks any path with it as a prefix |
| Reconnect backoff | `base * 2^(n-1)`, jittered to 50-100%, capped at 5 minutes |
| Retries surfaced as | an error status, not hidden |

The size-scaled debounce is the part worth pointing at. Somebody typing in a
large note saves every few seconds, and for Obsidian re-uploading a large file
that often costs more than the delay does. It costs Basalt far less, and the
thresholds are kept anyway: each push is still a round trip and an entry in the
vault's history.

## Where Obsidian Sync is better

Not close, in several places.

- **It exists and it works.** Basalt has no client yet. Nothing in this document
  has synced a real note between two real devices.
- **Nothing to run.** No box, no tunnel, no backups, no disk filling up at 2am.
  For most people that is the whole argument and it is a good one.
- **Mobile.** Theirs works on iOS today. Basalt's client has never run there, and
  the platform is the reason its crypto had to be built from WebCrypto primitives
  rather than named as AES-GCM-SIV.
- **Version history you can look at.** A viewer, a diff, a restore button.
  Basalt's server keeps full history and exposes none of it: no `history` or
  `restore` operation is implemented on the wire.
- **Simplicity where it counts.** Whole-file upload has fewer moving parts than
  content-defined chunking, deterministic sealing and per-chunk compression.
  Basalt's transfer story is better and its machinery is larger, and larger
  machinery has more ways to be wrong.
- **It syncs the rest of the vault.** Plugins, themes and settings across
  devices, which Basalt refuses and which plenty of people want.
- **Years of production.** Every edge case in this document was found by reading
  code and running measurements. Theirs were found by users.

## Where Basalt is better

- **Transfer**, by one to three orders of magnitude on any note worth calling
  long, and it compresses.
- **Encryption is not a setting.** No configuration in which the server can read
  a note.
- **It refuses to mangle a note.** Three checks the shipped merge does not make,
  two of which catch failures demonstrated above against the real library.
- **Deletions lose to edits.** In both directions.
- **No settings screen**, so no combination of options nobody tested.
- **The server is one static binary** with no external database, and a backup is
  a directory you can copy.
- **It says why.** Every refusal carries a code for the client and a sentence for
  the person, and every decision the index makes carries its reasoning.
