# The Basalt wire protocol, v1

Basalt does not speak Obsidian Sync's protocol. This document exists because
that protocol has seven defects we hit in practice, six of which fail silently,
and each rule below is the inversion of one of them.

Transport is a single WebSocket. Text frames are JSON control messages, binary
frames are chunk bodies. Everything except sizes and timestamps is encrypted by
the client before it is sent.


## Design rules

**Name the outcome.** No reply means "success" generically. In Obsidian's
protocol `{res:"ok"}` on a push means *discard the upload*, so the most natural
success reply is the destructive one. Basalt uses verbs: `have`, `want`, `ack`,
`err`.

**Never require a device to recognise its own echo.** Obsidian's pusher receives
its own change back and must match it on five fields byte-identically or it
downloads its own file over itself. Basalt acks with the assigned uid, and a
device never treats its own write as remote.

**Ordering is a property of a message, not of the stream.** Catch-up arrives as
batches carrying explicit `from` and `to`, so a client can detect a gap. In
Obsidian the client assigns `version = uid` unconditionally, which makes the
server solely responsible for wire ordering and makes a gap invisible.

**No persisted boolean decides whether a vault uploads.** A client announces
what it holds; the server answers with what it holds. Obsidian's `initial` flag
is stored per sync record, and a record carrying `false` pointed at an empty
vault reports "Fully synced" having uploaded nothing.

**Validate on the way in.** A name the client cannot later write is rejected at
`put` with a reason. Obsidian validates on download only, so a file containing
`:` uploads happily and can never come back down, on any device, forever.

Paths reach the server encrypted, so the rule splits: the client checks the name
before encrypting, and the server checks structure, bounds and internal
consistency — including that a file declaring a size names at least one chunk,
since a size with no chunks is byte-identical on the wire to an empty note.

**Namespace by string, version the protocol.** `basalt/hkdf-aes-gcm/1`, not an
integer shared with other implementations. The handshake carries a protocol
version and a mismatch is refused, not negotiated.

## Handshake

```
-> {op:"hello", proto:1, vault, token, device, crypto:"basalt/hkdf-aes-gcm/1", cursor}
<- {res:"ready", cursor, perFileMax, chunkMax}
```

`cursor` is the last uid the client has applied, or 0. The server refuses on a
`proto` or `crypto` it does not implement, with `{res:"err", code:"proto"}`,
rather than trying to interoperate.

`ready` carries every ceiling the server enforces, and it arrives before any
catch-up, so a client knows all of them before its first `put` rather than
discovering one by being rejected. Its `cursor` is what the *server* holds.

A client whose cursor is **ahead** of the server's is refused with
`{res:"err", code:"cursor"}`. It means the server has lost history the client
already applied: restored from an old backup, or pointed at the wrong vault.
Continuing would have the server reissue those uids for different content, and
the two would diverge with both sides reporting success. A refusal needs a human
and is reversible; silent divergence is neither.

## Catch-up

The server sends everything after `cursor` as ordered batches, then `ready`.

```
<- {res:"ready", ...}
<- {op:"batch", from:120, to:139, entries:[...]}
<- {op:"batch", from:140, to:151, entries:[...]}
<- {op:"caught-up", cursor:151}
```

`batch` is the only message that carries entries. A live change is a batch of
one, so catch-up and live delivery are the same shape and cannot diverge.

A device receives its **own** committed write as a batch with `entries: []`: the
cursor advance without the payload, so there is nothing to mistake for a remote
file. Skipping it entirely would leave the cursor one behind for every push, and
the next peer's change would look like a gap.

Batches leave the server in uid order, always, including under simultaneous
pushes. That is what makes the continuity check worth having: a gap a client sees
is real, never two commits racing. An assertion that cries wolf gets switched
off.

`from` and `to` are a *covered range*, not the first and last uid present: every
entry with `from <= uid <= to` is in the batch. That matters because a purge
leaves holes in the uid sequence, and under the other reading every hole would
read as a lost file. The check is `from == cursor + 1`, which a purge cannot
break and a real gap cannot satisfy.

Live changes that arrive mid-catch-up are held by the server and released in
order once the backlog is on the wire. Dropping them instead would satisfy
ordering while losing a file.

## Writing a file

Content-defined chunking, taken from LiveSync's approach. Boundaries fall where
a rolling hash says, so inserting a line near the start of a large note changes
one chunk instead of shifting every chunk after it.

```
-> {op:"put", path, meta:{size, ctime, mtime, folder, deleted, prev}, chunks:[h1,h2,h3]}
<- {res:"want", chunks:[h2]}          only what the server lacks
-> binary frame for h2
<- {res:"ack", uid:152}
```

- `chunks` are hashes of the *encrypted* chunks, so the server dedups without
  learning anything. A chunk hash is the lowercase hex SHA-256 of the encrypted
  chunk bytes, exactly 64 characters, one spelling only.

  Naming the function is what lets the server verify what it stores: it
  recomputes the hash on the way in and on the way out, so a body that does not
  match its name is refused rather than filed under a name it does not have, and
  bit rot surfaces as an error naming the chunk rather than as ciphertext a
  device cannot decrypt for reasons it cannot diagnose. The fixed width is also
  what makes the name safe to use as a filename. Uppercase is refused rather
  than normalised, because two spellings of one hash are two bodies on disk and
  a dedup miss that presents as unexplained upload volume.
- The chunks an entry references must be consistent with the `size` it declares.
  The server accepts at most `size + 256*len(chunks)` bytes of stored ciphertext
  for one entry, counting a repeated chunk once per reference because `size`
  counts its plaintext once per reference too. Over that is `toolarge`.

  This exists because `size` and `len(chunks)` were bounded independently, and
  their product was the real ceiling: an entry declaring one byte could
  reference 65536 chunks of a megabyte each without violating either bound. The
  bound is enforced twice, as uploads arrive so the bytes never reach the disk,
  and again at commit so referencing chunks the server already holds cannot slip
  past it.
- A file has chunks **if and only if** it has content. A zero-byte note carries
  none, and so do folders and deletions. Encrypting empty plaintext does produce
  ciphertext, so a client has to special case an empty file either way; fixing
  the shape means the server can check the relationship completely instead of
  accepting two different things for one state.
- `chunks` is always an array, never absent and never `null`, on every entry in
  every direction. A client iterating it must not have to guard the cases it
  should be able to ignore.
- `{res:"have", uid}` means the server already held every chunk, so nothing was
  uploaded and the entry is recorded. It carries the uid for the same reason
  `ack` does. `have` and `ack` are different outcomes and both are named.
- Uploaded bodies are matched to the names in `want` by **hashing the body**,
  not by their position in the stream. A chunk name is the hash of its body, so
  the server can check rather than trust: a client that reorders, repeats or
  skips a frame is caught at the moment it happens instead of storing one body
  under another's name.
- A reply arriving before the one you asked for is normal. Another device can
  commit at any moment, so a batch can land between any request and its
  response, and every client has to demultiplex on `op` before matching a `res`
  to the request in flight.
- The ack carries the assigned uid and is withheld until every chunk and the
  entry are durable. "Acked" means stored.
- `prev` is the previous path on a rename, so a rename is one operation rather
  than a delete plus an add.
- A rejected `put` returns `{res:"err", code, msg}` and the session continues.
  Obsidian's protocol has no clean way to refuse a push, which is why a bad one
  has to close the connection.

## Writing many files at once

A `put` is one round trip, or two when bodies have to go. Two hundred notes were
two hundred conversations, and at 400 ms that was most of a first sync. `putmany`
is the same exchange for up to 256 entries.

```
-> {op:"putmany", entries:[{path, meta, chunks:[h1,h2]}, {path, meta, chunks:[h2,h3]}, ...]}
<- {res:"want", chunks:[h1,h2,h3]}    the union of what the server lacks
-> binary frames, in that order
<- {res:"acks", results:[{uid:152}, {uid:153}, ...]}
```

- The `want` list is the **union** across the batch, deduplicated. Two notes
  containing the same chunk cost one body.
- `results` has exactly one entry per entry sent, **in the order they were
  sent**. A client matches them by position and nothing else, so a count that
  does not line up is a protocol fault rather than something to work around.
- A refused entry appears as `{code, msg}` in its slot and **does not refuse the
  batch**. The rest commit and are acked. A batch that failed as a unit would
  leave a client bisecting two hundred notes to find out which one the server
  would not take, and the offending note is usually the least important one in
  the vault.
- Every other rule of `put` applies unchanged: bodies are matched by hashing
  them, the size budget is enforced per entry both as bodies arrive and at
  commit, and an ack is withheld until every chunk and every entry that it
  covers is durable.
- An empty batch is `badentry`; more than 256 entries is `toolarge`. Neither
  ends the session.
- `put` is unchanged and still there. `putmany` of one entry is the same thing
  with a different reply shape, and a client with one file to write may use
  either.

## Reading a file

```
-> {op:"get", uid}
<- {res:"chunks", uid, size, chunks:[h1,h2,h3]}
-> {op:"fetch", chunks:[h2]}          only what this device lacks
<- binary frame for h2
```

A device that already holds `h1` and `h3` from another version of the file never
downloads them again.

One `fetch` may name the chunks of many files. The chunk list of every version
in a catch-up batch is already known from the batch itself, so a client with two
hundred files to download asks for all of their chunks at once, deduplicated,
and reads the bodies back in the order it asked. That is what takes a first
download from one round trip per file to a handful.

A `fetch` naming any chunk the server lacks sends **no** bodies at all and
returns `nochunk`. Failing halfway through leaves a client unable to tell which
of the frames it received. Bodies are verified against their names on the way
out too, so a chunk that rotted on disk is reported rather than shipped to a
device that would fail to decrypt it for reasons it cannot diagnose.

A `get` for a uid that does not exist is `nouid`; one for a folder or a deletion
is `nocontent`. They are separate because a deleted file and a corrupt cursor
need different responses, and because an empty chunk list already means
something else: a real, zero-byte note.

## Deleting

A deletion is an entry with `deleted:true`, not the absence of one. That record
is what makes the file recoverable and what stops a vault of deleted files from
looking like an empty vault.

## Recovery

Two operations, both read-only. Between them a client can find out what the
server is holding that the vault no longer has, and then use the ordinary `get`
to pull it back.

| | |
|---|---|
| `history` | `{op, path, before?, limit?}` answered by `{res:"history", path, entries}` |
| `deleted` | `{op, limit?}` answered by `{res:"deleted", entries, more}` |

`path` is sealed, going up and coming back. The server has never been able to
read a path and recovery does not change that: it is a key in a table.

`history` returns every version of one path, newest first, deletions included,
because a history stopping at the last version with content does not say what
happened. `before` pages backwards. An empty list is not an error and is
indistinguishable from a purged history, because the server cannot tell those
apart and inventing the distinction would be a lie in a recovery tool.

`deleted` returns paths whose newest version is a deletion, newest first, renames
suppressed, bounded at 1000. `more` says the list was cut short and a client must
show it: a truncated list that does not say so is one somebody reads before
concluding their note is gone. Suppression is not optional — a rename retires the
old path, so without it most of the list is phantom deletions.

`entries` is an array in both, never null. A client iterating null crashes on
exactly the answer it exists to handle, and for `deleted` that is the common
case.

### Restoring is not an operation

There is no `restore` on the wire and there is not going to be one. A client
asks for the history, fetches the version it wants with `get`, writes it into
the vault, and the ordinary sync uploads it as a new version. That leaves the
server with one way to change a vault, the one that is already tested to death,
and the client had to download the content regardless.

## Authentication

One secret. The auth key is a branch of the same HKDF schedule that produces the
content and path keys, so holding the vault's root secret is what it means to
have the vault. There is no second credential to keep, and a pairing string
carries the address and the secret and nothing else.

`hello` sends `token`, and may send `claim`.

| Vault state | What opens it | What `claim` does |
|---|---|---|
| unclaimed | the server's first-run token | binds the vault to the offered auth key |
| claimed | the auth key, checked against a stored hash | ignored |

The server stores only `sha256` of the auth key, per vault: it never needs the
key, only checks one offered. A stolen disk yields ciphertext without also
handing over the ability to add to it.

Claiming is one-time and cannot be undone over the wire; a second device offering
its own key to a claimed vault is refused, or the first would be locked out of
its own notes. Trust on first connection would mean whoever reached the port
first owned the vault, which is why the bootstrap token exists.

A device sends `claim` on every hello, so it never has to work out whether it is
the first. The first-run token is kept only until it has been spent.

## Which clients may connect

The websocket library verifies the `Origin` header and refuses a cross-origin
handshake. A Go or Node client sends none and is always allowed. A browser
client always sends one, and an Obsidian plugin is a browser client: desktop is
`app://obsidian.md`, verified from a running app, and the two mobile origins are
Capacitor's documented defaults and have never been checked against a device.

A refused handshake logs the origin and the `-allow-origin` flag that would admit
it. This exact gap once meant no plugin could connect at all while every test
passed.

## Crypto

`crypto:"basalt/hkdf-aes-gcm/1"` names this, and a mismatch is refused rather
than negotiated.

One root secret is generated on the first device and never leaves it. Everything
else is derived, so there is one thing to write down and one thing to lose:

```
S                                       root secret, 160 bits
K_auth    = HKDF(S, "basalt/auth/1")    the server stores only H(K_auth)
K_path    = HKDF(S, "basalt/path/1")
K_content = HKDF(S, "basalt/content/1")
K_nonce   = HKDF(S, "basalt/nonce/1")
```

Paths and chunks are both sealed with the same construction, under different
keys. The nonce is synthetic, derived from the plaintext, which is what makes
the result deterministic:

```
nonce(p)  = HMAC-SHA-256(K_nonce, p)[:12]
seal(K,p) = nonce(p) || AES-GCM-256(K, nonce(p), p)
```

A chunk body is compressed before it is sealed, and the sealed plaintext is one
marker byte followed by the payload: `0` for stored as-is, `1` for raw deflate. A
chunk that does not shrink is stored as-is, so a sealed chunk is never more than
29 bytes larger than its content.

The ordering is forced in both directions. Compression goes *after* chunking,
because compressing a file first would move every byte of the compressed stream
on any edit and the content-defined boundaries would all shift. It goes *before*
sealing, because ciphertext does not compress. Measured on a real vault, this
takes a full upload of its text from 108% of the plaintext to 67%.

The marker is inside the sealed plaintext rather than beside it. It costs the
same byte and it means the server cannot tell which chunks compressed, so it
learns nothing about how compressible each part of a vault is, and the marker is
covered by the authentication tag.

The codec is raw deflate at level 6, and a client must use an implementation
whose output does not vary by platform. Determinism is load-bearing: the same
chunk has to seal to the same bytes on a desktop and a phone, or the names
diverge and dedup silently stops working. "Whatever zlib this runtime shipped"
is not that guarantee.

Determinism is not a stylistic choice, it is load-bearing twice over. Equal paths
must produce equal ciphertext or the server cannot tell two versions of a file
apart. Equal chunks must produce equal ciphertext or dedup does nothing: chunk
names are hashes of the *encrypted* chunk, so a random nonce per chunk would give
every upload a fresh name, and content-defined chunking would cut at exactly the
right boundaries and then send everything anyway. That failure is completely
silent, which is why it is written down here.

AES-GCM with a synthetic nonce is the deterministic-AEAD construction that
AES-GCM-SIV packages up. It is spelled out from HMAC and AES-GCM rather than
named as GCM-SIV because WebCrypto's AES modes are fixed by specification at CBC,
CTR, GCM and KW, with no SIV, and the client runs in a webview on at least one
platform. A protocol that names a primitive its own client cannot provide is a
protocol nobody can implement.

The usual nonce-reuse hazard does not arise: a nonce repeats only for identical
plaintext under the same key, which is precisely the equality the design is
asking for, and distinct plaintexts get distinct nonces.

## What the server can see

Sizes, timestamps, chunk counts, the number of files, and which encrypted path
changed when. Paths are deterministically encrypted, so the server can tell that
two entries concern the same file without knowing its name.

It can also tell when two chunks are byte-identical, within a file, across
versions and across files. That is not a leak being tolerated, it is the
mechanism dedup is made of: asking the server to store one copy of a repeated
chunk is asking it to recognise the repeat.

The server cannot see file contents, file names, or folder structure, and holds
no key for any of it.

## Errors

```
<- {res:"err", code, msg}
```

`code` is for the client, `msg` is for the human. Every rejection has one of
each, because an error a device cannot act on and a person cannot read is how a
silent failure starts.

The session **continues** after `badentry`, `badname`, `toolarge`, `nospace`,
`nouid`, `nocontent` and `nochunk`: these reject one request. It **ends** after
`proto`, `auth`, `cursor`, `busy`, `protostate` and `badchunk`, either because
the connection should never have been opened or because the two ends no longer
agree how many frames are outstanding and carrying on would mean guessing.

| code | meaning |
|---|---|
| `proto` | unsupported `proto` or `crypto` |
| `auth` | bad token or vault, never saying which |
| `cursor` | the client is ahead of the server; see the handshake |
| `busy` | the vault's device limit |
| `protostate` | a message that does not belong in the current state |
| `badentry` | a structurally invalid put |
| `badname` | a path the server cannot store |
| `badchunk` | a body that does not hash to the name it was asked for |
| `toolarge` | above an advertised ceiling, or more ciphertext than the declared size allows |
| `nospace` | refused for want of disk, or an exceeded quota |
| `nouid` | no such entry |
| `nocontent` | the entry is a folder or a deletion |
| `nochunk` | the server does not hold that chunk |
