# What Basalt does

Everything here is marked with whether it exists. **Built** means implemented and
tested; **partial** means some of it runs; **designed** means decided and written
down but not written. A features list that does not distinguish those is a wish
list, and this project's first rule is not to report success it has not verified.

`docs/vs-obsidian-sync.md` covers how these compare to Obsidian Sync, including
where theirs is better. This is the list on its own terms.

---

## The unusual ones

Six things Basalt does that its two predecessors do not. If there is a reason to
use this rather than either, it is these.

### 1. A merge that refuses rather than mangling

**Built.** Both Obsidian Sync and Self-hosted LiveSync merge text with
diff-match-patch. Obsidian's merge discards the array saying which hunks applied,
so a hunk that could not be placed is dropped and the result returned as a
success. Basalt reads it, and then makes three checks the library does not:

| Check | The failure it catches |
|---|---|
| Do the changed regions overlap? | Two sides rewriting one sentence get **spliced** into a sentence neither wrote |
| Does merging both ways round agree? | A hunk **placed in the wrong place**, which happens in repetitive content and reports success |
| Did every local insertion survive? | The library's own report being wrong |

Both of the first two were demonstrated against the real library, and both leave
every hunk "applied" with every insertion present. Nothing is lost and the note
is wrong, which is the failure mode this project is named after.

When a merge is refused, both versions are kept. The **incoming** one takes the
conflict copy's name and the local file stays where it is, so a sync you did not
ask for never rewrites the file you have open. Obsidian does the opposite.

### 2. Deletions lose to edits, in both directions

**Built.** Deleted on this device, changed on another: the file comes back.
Deleted on another, changed here: the file stays and is re-sent. A deletion can
be repeated by hand; an edit that is gone from the device that made it and from
the server cannot be recovered.

### 3. Encryption is not a setting

**Built.** There is no configuration in which the server can read a note, and no
code path that would let it. Paths, contents and folder structure are all sealed
on the device.

The unusual part is that **deduplication still works**. Sealing is deterministic:
the nonce is derived from the plaintext, so identical content produces identical
ciphertext and the server can recognise a chunk it already holds without holding
a key. Most encrypted sync gives that up.

### 4. Editing a large note costs a chunk, not a note

**Built.** Content-defined chunking with a rolling hash, so an insert near the
top of a long note changes one chunk instead of shifting every boundary after it.
Measured against whole-file sync:

| Note | Basalt sends | Whole file | |
|---|---|---|---|
| 4 KiB | 284 B | 4 KiB | 15x less |
| 128 KiB | 349 B | 128 KiB | 376x less |
| 2 MiB | 494 B | 2 MiB | 4245x less |

Chunks are compressed before they are encrypted, which takes a full first sync of
a vault's text from 108% of its plaintext to 67%.

### 5. One engine, a plugin and a command line

**Partly built.** The sync engine, the crypto, the chunker and the merge are
platform-free; Obsidian's Vault API and the filesystem are two adapters behind
one small interface. The headless client is not a second client, it is the same
one with a different adapter, so a bug fixed in one is fixed in both.

Obsidian ships a headless client too, and reading it is what settled that this
is the right shape rather than a guess (`docs/client-design.md`). Theirs is
proprietary and requires a subscription. This one is a 145 KB file that needs no
npm install:

```
basalt init --server wss://laptop.tailnet.ts.net --token TOKEN
basalt pair basalt1_AW_gf1nhnyhf86NO...      # on the next device
basalt sync                                   # or sync --watch
basalt status
```

Pairing is one string carrying the address, the token and the root secret, with
a checksum on it, so a paste that lost its last line is refused rather than
becoming a subtly wrong key.

### 6. A backup that is a directory, and a server that checks itself

**Built.** `basalt backup -to DIR` produces a directory that *is* a data
directory: restoring is copying it back. Incremental, because chunks are named by
their content. Verified before it reports success, and it prints its arithmetic
rather than saying "done".

`basalt verify -deep` re-reads every chunk and checks it against its name, so bit
rot is found rather than served. The server can do this because chunk names are
hashes of the ciphertext, which is also what lets it refuse a body that does not
match on the way in.

---

## Syncing

| | |
|---|---|
| Notes and attachments of any type | **Built** |
| Folder structure | **Built** |
| Content-defined chunking, so only changed regions travel | **Built** |
| Per-chunk deduplication across files and versions | **Built** |
| Compression before encryption | **Built** |
| Renames as one operation rather than a delete and an add | **Built** |
| Deletions as records, so a deleted note is recoverable | **Built** server side |
| Three-way merge for text | **Built** |
| Conflict copies for anything that cannot merge | **Built** |
| Live relay between connected devices | **Built** |
| Catch-up from a cursor after being offline | **Built** |
| Write coalescing, scaled by file size | **Built** |
| Per-file retry with backoff, kept apart from permanent refusals | **Built** |
| Watching the vault for changes rather than polling | **Built** on the filesystem |

## The server

| | |
|---|---|
| One static binary, no cgo, no external database | **Built** |
| SQLite for entries, content-addressed files for bodies | **Built** |
| Full version history, append-only | **Built** |
| `verify`, including a deep pass that re-reads every byte | **Built** |
| `purge` to drop history, with a grace window for in-flight uploads | **Built** |
| `backup`, incremental and self-verifying | **Built** |
| Directory locks, so maintenance cannot race a running server | **Built** |
| Refuses a client whose cursor is ahead of its own | **Built** |
| Live device limit, refused rather than degraded | **Built** |
| Exposing history or restore over the wire | **Designed** |
| Prometheus, a web UI, anything that reads your vault | **Refused** |

## The client

| | |
|---|---|
| Shared core between the plugin and a headless client | **Built** |
| Local index with one remembered fingerprint per file | **Built** |
| Content cache, so an unchanged vault costs one stat per file | **Built** |
| Filesystem adapter | **Built** |
| Obsidian Vault API adapter | **Partial**, written and untested |
| Obsidian plugin shell | **Designed** |
| Reconnect with backoff and jitter | **Built** |
| Headless CLI | **Built** |
| Pairing | **Built**, one string carrying the address, the token and the secret |
| Status and actions in Obsidian's settings pane | **Designed** |

## Security and privacy

| | |
|---|---|
| AES-GCM-256 with keys derived by HKDF from one root secret | **Built** |
| Separate keys for authentication, paths, contents and nonces | **Built** |
| Deterministic sealing, so dedup works without the server holding a key | **Built** |
| Paths sealed and reversible, so a device can recover a filename | **Built** |
| Server stores no key material and terminates no TLS | **Built** |
| PBKDF2 at 310,000 iterations for a passphrase-derived vault | **Built** |
| Authentication by token, compared in constant time | **Built** |
| Server storing only a hash of the auth key | **Designed** |

### What the server can see

Sizes, timestamps, chunk counts, how many files there are, and which sealed path
changed when. It can tell that two chunks are identical, which is not a leak
being tolerated but the mechanism deduplication is made of. It cannot see file
contents, file names, or folder structure.

---

## What Basalt refuses

These are decisions with reasoning in `docs/philosophy.md`, not gaps.

| | Why |
|---|---|
| A second storage backend | One backend is how being sure becomes possible |
| Peer to peer | A good feature that doubles the transports |
| Teams or shared vaults | Invites permissions, quotas and identity |
| Syncing plugins, themes or settings | One device can disable every plugin on another |
| Syncing hidden and config files | Same reason |
| A settings screen | Every option multiplies a state space nobody tested |
| A web UI on the server | Anything it could show you, it would have to read |
| Filters by file type or size | A status that describes a filter is not a status |
| Silent conflict resolution | Keep both, always |

## Not there yet

Stated plainly, because a features list that only lists features is marketing.

- **Nothing has synced a note between two real Obsidian vaults.** Two
  directories on a disk sync through a real server, driven through the real
  CLI, and two engines converge in memory. What no test has run is the Obsidian
  adapter, because it needs Obsidian.
- **No mobile.** Never run on iOS or Android. The crypto was built from WebCrypto
  primitives specifically so it could be, and that is not the same as having
  tried.
- **No plugin.** The headless client runs; the Obsidian plugin has an adapter
  and no shell around it, so there is nothing to install in Obsidian yet.
- **No recovery interface.** The server keeps every version and every deletion
  and exposes none of it: there is no `history` or `restore` operation on the
  wire, so a deleted note is safe and not yet reachable.
- **No packaging.** No release, no plugin listing, no systemd unit.
