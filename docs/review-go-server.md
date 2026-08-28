# Code review: the Go server

Reviewed at commit `3b425f3`. Builds clean, `go vet` clean, `gofmt` clean, all
tests pass under `-race`.

Overall this is high quality. The durability reasoning in `chunks.Put` and the
catch-up ordering in `session.go` are careful and correct, and the comments
record *why* rather than *what*. Four findings, two worth acting on.

---

## 1. Size and chunk budget are bounded independently

`Validate` caps `Size <= 256 MiB` and `len(Chunks) <= 65536`; `chunks.Put` caps
each body at 1 MiB. Nothing cross-checks them, so the real ceiling for one entry
is their product: **64 GiB of disk**.

Verified:

```
accepted uid=1: declared size 1 byte, stored 40 chunks totalling 40 MiB
```

`CodeNoSpace` is declared in `wire.go` and never returned anywhere, and there is
no per-vault quota, so nothing downstream catches it either.

On a single-user tailnet box this is a disk-exhaustion footgun rather than a
breach. It is worth fixing because every other unbounded-work case in this
codebase is closed deliberately with a comment explaining the bound; this one is
the exception.

**Fix.** Cross-check in `Validate`. Ciphertext expansion is small and
predictable, so the chunk count should be bounded by what `Size` can plausibly
produce rather than by an independent constant.

## 2. Three wire shapes for "no chunks"

`attachChunks` sets `entries[i].Chunks = nil`, and the JSON tags disagree about
what that becomes:

| Path | Tag | Emits |
|---|---|---|
| entry inside a batch | `json:"chunks,omitempty"` | key omitted |
| `handleGet` reply | `json:"chunks"` | `"chunks": null` |
| constructed empty | — | `"chunks": []` |

This is the hazard the code already documents for `Batch.Entries`:

> Empty, never nil. A nil slice marshals to JSON null, and a client that
> iterates entries would then crash on precisely the batches it is meant to
> handle silently.

The same reasoning, unapplied one layer over.

**Fix.** Drop `omitempty` from `Entry.Chunks`, and normalise nil to `[]` on the
get path.

## 3. Zero-byte files have two legal shapes

The `Entry.Chunks` comment says "Empty for a folder, a deletion, and a zero-byte
file", but `Validate` also accepts `Size: 0` *with* chunks. Both are legal today.

A real client encrypts before chunking, and AES-GCM of empty plaintext is about
28 bytes of ciphertext, so a correct client plausibly *will* send one chunk for
an empty file.

**Fix.** Pick one shape, enforce it in `Validate`, and make the comment match.
Left as-is it is a trap for whoever writes the client.

## 4. Minor: `wire.In` advertises ops that do not exist

`Before` and `SuppressRenames` exist for `history` and `deleted`, which
`dispatch` does not handle, so they fall through to `unknown op`. Either
implement them or remove the fields until they are real.

---

## Preserve these

Recorded so none of it is refactored away later by someone who does not know
what it cost.

- **Chunk name is the hash of the ciphertext, verified on `Put` and on `Get`.**
  Makes path traversal impossible by construction *and* keeps verification.
  Most designs trade one away for the other.
- **fsync file, rename, fsync directory**, with each step's failure mode written
  down. The directory-fsync note is exactly right: it is the one server-side
  fault a client cannot detect, because it acked and will never resend.
- **The sweep grace window**, found from a real livelock in which two thirds of
  concurrent pushes starved.
- **`Batch.From`/`To` as a covered range rather than first and last uid.** This
  is what stops purge holes from looking like lost files. Subtle and
  load-bearing.
- **`readBodies` matches frames by hash, not by position.**
- **`elide` on the pusher's own echo**, which removes Obsidian's five-field
  echo-matching defect outright.
- **`attachChunks` refuses to emit an entry that declares a size with no chunk
  rows** — the read-side counterpart to `Validate`, and the direct answer to
  "a note that reads as emptied".
- **Purge's self-checks**: versions remaining equals distinct paths, plus the
  arithmetic check.
- **Refusing a client cursor ahead of the server**, with the reasoning about
  reissued uids.

Lock ordering is clean: `commitMu` then `writeMu`, and purge takes only
`writeMu`. The protocol state machine is properly gated — first frame must be
`hello`, a second `hello` is fatal, stray binary frames are fatal, and unknown
ops get a named rejection rather than silence.
