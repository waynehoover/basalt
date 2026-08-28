# What Basalt does

Everything here is marked with whether it exists. **Built** means implemented and
tested; **partial** means some of it runs; **designed** means decided and written
down but not written. A features list that does not distinguish those is a wish
list, and this project's first rule is not to report success it has not verified.

`docs/vs-obsidian-sync.md` covers how these compare to Obsidian Sync, including
where theirs is better. This is the list on its own terms.

---

## The unusual ones

Seven things Basalt does that its two predecessors do not. If there is a reason to
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

### 5. Everything you deleted is still there, and you can get it back

**Built.** The server has kept every version of every note and every deletion
since the beginning, and now there is a way to reach it.

```
basalt deleted                      what the server still has and you do not
basalt history "Quarterly plan.md"  every version, newest first
basalt restore "Quarterly plan.md"  put it back
```

In Obsidian it is one command, "Recover a deleted note", and a list with a
button beside each.

Restoring is not a server operation. The client fetches the version it wants
with the ordinary `get`, writes it into the vault, and the ordinary sync sends
it on to the other devices. The server keeps exactly one way to change a vault,
which is the one everything else already uses.

Nothing is ever overwritten. Restoring onto a path you have since reused puts
the recovered copy beside what is there and tells you, because a recovery tool
that can destroy the thing you still have is worse than none. A restored note
keeps the timestamp it was written with rather than the moment you recovered it.

### 6. One engine, a plugin and a command line

**Built, and half of it unverified.** The sync engine, the crypto, the chunker and the merge are
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

Pairing is one string carrying the address and the root secret, with a checksum
on it, so a paste that lost its last line is refused rather than becoming a
subtly wrong key. There is no separate server token in it: the key that
authenticates is derived from the same secret that decrypts, so a vault has one
secret and eighty characters is the whole of it.

That the core really is platform-free is checked rather than asserted: the
plugin bundle is built and read, and a test fails if a single `node:` import has
reached it. That regression compiles, passes every unit test, and only shows up
when somebody opens Obsidian on a phone.

### 7. A backup that is a directory, and a server that checks itself

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
| Deletions as records, so a deleted note is recoverable | **Built**, and reachable |
| Three-way merge for text | **Built** |
| Conflict copies for anything that cannot merge | **Built** |
| A merge refused when the result stops being valid JSON | **Built** |
| Live relay between connected devices | **Built** |
| Several requests in flight at once | **Refused for now**, one at a time, see benchmark |
| Catch-up from a cursor after being offline | **Built** |
| Write coalescing, scaled by file size | **Built** |
| Per-file retry with backoff, kept apart from permanent refusals | **Built** |
| A written-off file tried again once it changes | **Built** |
| One path that is a file here and a folder there, refused and explained | **Built** |
| Fetched chunks checked against the name they were asked for | **Built** |
| Watching the vault for changes rather than polling | **Built** on the filesystem |

## The server

| | |
|---|---|
| One static binary, no cgo, no external database | **Built** |
| SQLite for entries, content-addressed files for bodies | **Built** |
| Full version history, append-only | **Built** |
| `verify`, including a deep pass that re-reads every byte | **Built** |
| `verify` checking the entries too, not only the bodies they name | **Built** |
| Refusing a `-data` path that is not already a data directory | **Built** |
| `purge` to drop history, with a grace window for in-flight uploads | **Built** |
| `backup`, incremental and self-verifying | **Built** |
| Directory locks, so maintenance cannot race a running server | **Built** |
| Refuses a client whose cursor is ahead of its own | **Built** |
| Live device limit, refused rather than degraded | **Built** |
| Exposing history and the deleted list over the wire | **Built**, read-only |
| Prometheus, a web UI, anything that reads your vault | **Refused** |

## The client

| | |
|---|---|
| Shared core between the plugin and a headless client | **Built** |
| Local index with one remembered fingerprint per file | **Built** |
| An index that shrinks again when notes are deleted | **Built** |
| Content cache, so an unchanged vault costs one stat per file | **Built** |
| Filesystem adapter | **Built**, deletions to the vault's trash |
| Obsidian Vault API adapter | **Built**, against a fake of Obsidian's own interface |
| Obsidian plugin shell | **Built**, and run once in a real vault |
| Scanning from Obsidian's own index, not one stat per file | **Built** |
| A hardened systemd unit, printed with real paths | **Built** |
| Static binaries for linux and macOS, and a plugin folder | **Built** |
| An 11 MB container image with no shell in it | **Built** |
| `stats`, saying what is stored and what a purge would drop | **Built** |
| Reconnect with backoff and jitter | **Built** |
| Headless CLI | **Built** |
| Pairing | **Built**, one string carrying the address and the secret |
| Status bar, and one modal that is not a settings tab | **Built** |

## Security and privacy

| | |
|---|---|
| AES-GCM-256 with keys derived by HKDF from one root secret | **Built** |
| Separate keys for authentication, paths, contents and nonces | **Built** |
| Deterministic sealing, so dedup works without the server holding a key | **Built** |
| Paths sealed and reversible, so a device can recover a filename | **Built** |
| Server stores no key material and terminates no TLS | **Built** |
| One secret: the auth key is derived from the root secret | **Built** |
| One-time bootstrap token, so a vault is claimed rather than assumed | **Built** |
| Server storing only a hash of the auth key | **Built** |

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
| A passphrase as a second way into a vault | One secret, or it is not one secret |
| A web UI on the server | Anything it could show you, it would have to read |
| Filters by file type or size | A status that describes a filter is not a status |
| Silent conflict resolution | Keep both, always |

## Not there yet

Stated plainly, because a features list that only lists features is marketing.

- **Nothing has synced a note between two real Obsidian vaults.** Two
  directories on a disk sync through a real server, driven through the real
  CLI, and two engines converge in memory. What no test has run is the Obsidian
  adapter, because it needs Obsidian.
- **The cost of a scan in real Obsidian is unmeasured.** The walk itself is
  linear and cheap: 26ms for 16,000 files against an in-memory adapter, 1.6
  microseconds each. What is unknown is what `DataAdapter.stat` costs per call
  in the real app, and the plugin makes one per file per pass. That is the first
  thing to measure when it loads, and the fix if it is slow is already obvious:
  `Vault.getFiles()` returns Obsidian's own index with stats already in it.
- **No mobile.** Never run on iOS or Android. What is known rather than hoped:
  the plugin bundle needs nothing from its host that a webview lacks, no
  desktop-only Obsidian API is used, and the deletion path already falls back
  from the system trash to the vault's own. What is unknown is everything else,
  and two things are known to be wrong or missing. Obsidian mobile has no status
  bar, so `addStatusBarItem` returns an element nothing displays and the
  plugin's only ongoing feedback is invisible there; the modal and its notices
  still work. And the mobile entries in the server's origin allow-list are
  Capacitor's documented defaults, never checked against a device: if they are
  wrong the phone cannot connect, so the server now names the refused origin and
  the `-allow-origin` flag that would admit it.
- **The plugin has run in Obsidian once, by hand.** A 316 file, 27 MB vault
  synced to a headless second device and back: byte identical, a real merge, a
  real conflict copy, deletions to the macOS Trash. It found two more bugs,
  including a server that refused every browser client and so had never let a
  plugin connect at all (`docs/client-design.md`). What it has not had is
  ordinary use over days, or a second real device, or a phone.
