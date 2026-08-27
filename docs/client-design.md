# Client design notes

What was learned by reading Obsidian's sync engine and LiveSync's source, kept
here because the reasoning is not recoverable from either artifact later.

Obsidian's engine was read by enumerating it on a running app (its shipped code
is minified and mangled, so the bundle alone does not answer these). LiveSync is
MIT and public. Neither is copied; both informed the shape below.

## Reconciliation needs one scalar per file, not a history

Obsidian keeps two indexes, keyed by path:

```
localFiles[path]   path, previouspath, folder, ctime, mtime, size, hash, synctime, synchash
serverFiles[path]  path, size, hash, ctime, mtime, folder, deleted, uid, device, user, initial
```

`synchash` is the content hash **as of the last successful sync**. That is the
common ancestor. Local hash, `synchash` and server hash give the three points a
three-way merge needs, with no version store involved.

This is the single most useful thing in the engine and it is one field. Getting
it wrong from first principles would mean either storing full history locally or
having no base to merge from.

Basalt keeps the same idea: one remembered fingerprint per file, written only
when a sync completes.

## Conflict handling is a policy slot, and ours is different

Obsidian carries `conflictAction` as engine state, defaulting to `"merge"`.
Treating the strategy as swappable rather than hardcoded is right, and Basalt
keeps that shape.

Where we diverge is the default. Obsidian's merge is:

```js
patch_apply(patch_make(base, diff_main(base, mine)), theirs)[0]
```

`patch_apply` returns `[text, appliedFlags]`. Taking `[0]` discards the flags, so
hunks that fail to apply are dropped without anything being reported.

Basalt checks the flags. Any failed hunk abandons the merge and keeps both
versions, one as a conflict copy. See the philosophy doc: not losing a note beats
avoiding a duplicate.

## Renames are reconstructed, not observed

`previouspath` sits on the local index entry and becomes the rename field on the
wire. The engine works out that a rename happened from its own index rather than
trusting a filesystem rename event.

This matters because rename is where sync implementations usually break: editors
save by writing a temp file and renaming over the target, cloud storage produces
placeholder files, and case-only renames are invisible on case-insensitive
filesystems. An index diff sees the truth; an event does not.

## It is a single-flight state machine with side tables, not one queue

Obsidian's engine state, which is worth copying almost directly:

| Field | Purpose |
|---|---|
| `syncing`, `syncingPath` | single-flight, and what it is working on |
| `fileRetry` | per-file retry, so one bad file does not stall the rest |
| `skippedFiles` | permanent refusals, distinct from things to retry |
| `newServerFiles` | inbound queue |
| `dirty` + a debounce timer | persistence, coalesced |
| `backoff` | reconnect policy |

The obvious first design is one big work queue. That loses the distinction
between "retry this later" and "never do this", which is exactly the distinction
that keeps a permanently-invalid file from being retried forever.

## What LiveSync does that we take

- **Content-defined chunking.** `splitPiecesRabinKarp` splits on a rolling hash
  of the content, so an insert near the start of a large file changes one chunk
  instead of shifting all of them. Fixed-offset chunking re-uploads the whole
  file for a one-line edit. This is in `protocol.md` as part of the wire format.
- **diff-match-patch for text merging.** Two independent projects chose it. This
  is not where a sync project should spend its risk budget.

## What LiveSync does that we do not

Its client is 56 modules across 9 directories with a 20-module services layer, a
separate core package, and 21 runtime dependencies including an AWS S3 client. It
ships a 3.4 MB bundle.

None of that is bad engineering. It is the honest price of supporting CouchDB,
S3, peer-to-peer, hidden-file sync, config sync, plugin sync and a cross-app
bridge. The architecture is the size of the scope.

The lesson is therefore not "structure it better". It is that our smallness has
to come from refusing features, and if we ever accept a second backend we should
expect to pay the same price.

## Obsidian's own decomposition, for reference

Worth imitating: an engine that orchestrates, collaborating with a transport
that knows no policy, a filter that knows only paths, and an encryption provider
that is a pure interface with no reference to the app.

```
engine    66 methods / 53 fields    orchestration, events, status, history
server    20 methods                transport only
filter     7 methods                path policy
provider   6 members                pure crypto interface
```

The provider boundary is so clean it can be tested with no app present at all,
which is the property to aim for with every part of Basalt's client.
