# The wire protocol, v3

[Back to the README](../README.md)

One WebSocket. Text frames are JSON control messages, binary frames are chunk
bodies. Everything except sizes and timestamps is encrypted by the client
before it is sent.

Basalt does not speak Obsidian Sync's protocol. That protocol has seven defects
we hit in practice, six of which fail silently, and each design rule below
inverts one.

## Design rules

1. **Name the outcome.** In Obsidian's protocol `{res:"ok"}` on a push means
   *discard the upload*, so the most natural success reply is the destructive
   one. Basalt uses verbs: `have`, `want`, `ack`, `err`.

2. **Never require a device to recognise its own echo.** Obsidian's pusher
   receives its own change back and must match it on five fields or it
   downloads its own file over itself. Basalt acks with the assigned uid, and a
   device's own write comes back as an empty batch.

3. **Ordering is a property of a message, not of the stream.** Batches carry
   `from` and `to`, so a gap is detectable. Obsidian makes the server solely
   responsible for wire ordering and a gap invisible.

4. **No persisted boolean decides whether a vault uploads.** The client says
   what it holds, the server says what it holds. Obsidian's `initial` flag,
   stored per sync record, once reported "Fully synced" over an empty vault.

5. **Validate on the way in.** A name the client cannot later write is rejected
   at `put` with a reason. Obsidian validates on download only, so a file with
   `:` in its name uploads and can never come back down. Paths are encrypted,
   so the client checks the name and the server checks structure and bounds.

6. **Namespace by string, version the protocol.** The crypto scheme is
   `basalt/hkdf-aes-gcm/1`, not an integer shared with other implementations.
   A version mismatch is refused, not negotiated.

## Handshake

```
-> {op:"hello", id, proto:3, vault, token, device, crypto:"basalt/hkdf-aes-gcm/1",
    cursor, claim?, wrapped?}
<- {res:"ready", id, proto:3, minProto:2, serverVersion, cursor,
    perFileMax, chunkMax, maxChunks, maxBatchBytes, maxFetchBytes, wrapped?}
```

`cursor` is the last uid the client applied, or 0. The server speaks every
version from `minProto` to `proto` and answers in the version the client asked
for, so the upgrade order is the server first, then each client. A `proto`
outside that range, or a `crypto` it does not implement, is refused with
`{res:"err", code:"proto"}` naming both numbers and `serverVersion`. `proto`
and `crypto` move separately: `crypto` names how a chunk is sealed, which has
not changed since protocol 1, so every chunk ever written still opens.

`vault` and `device` are at most 64 characters and contain no control
characters; either fault is `badname` and ends the session, because both land
in logs and file paths.

`ready` carries every ceiling the server enforces, before any catch-up, so a
client knows all of them before its first `put`: the largest file, chunk and
chunk list, the largest encoded `putmany` frame (`maxBatchBytes`) and the most
body bytes one `fetch` may ask for (`maxFetchBytes`). A request over a ceiling
is refused with `toolarge`, never with a bare disconnect, and every legal
message fits under the server's read limit. `ready.cursor` is what the server
holds. `wrapped` is the vault's wrapped data key when it has one; see
**Authentication**.

## Request ids

Every request that expects a reply carries `id`, a client-chosen integer from 1
to 2^32-1, unique among the requests in flight: `hello`, `put`, `putmany`,
`get`, `fetch`, `history`, `deleted`, `invite`, `rotate`. The reply echoes it,
and so does an `err` refusing that request. A protocol 3 request with no `id`,
or one outside that range, is `protostate` and ends the session. `batch`, `caught-up` and pings are
unsolicited and carry no `id`. The server never sends an `id` it was not given.
A client ends the session on a reply whose `id` it does not recognise, and
treats an `err` with no `id` as the reason the connection is about to close.

Before ids, a reply was matched to the one request in flight by position, and
three separate defects came from that: a fast acknowledgement arriving before
its waiter was armed, a shutdown notice mistaken for a bad reply, and bodies
from a refused fetch consumed by the next one.

A client whose cursor is **ahead** of the server's is refused with
`code:"cursor"`. The server has lost history the client already applied, from
an old backup or the wrong vault. Continuing would reissue those uids for
different content and the two would diverge with both reporting success.

## Catch-up

```
<- {res:"ready", ...}
<- {op:"batch", from:120, to:139, entries:[...]}
<- {op:"batch", from:140, to:151, entries:[...]}
<- {op:"caught-up", cursor:151}
```

`batch` is the only message that carries entries. A live change is a batch of
one, so catch-up and live delivery share one code path.

`from` and `to` are a covered range: every entry with `from <= uid <= to` is in
the batch. Purge leaves holes in the uid sequence, and this reading means a
hole is not a lost file. The continuity check is `from == cursor + 1`.

Batches leave the server in uid order, always, including under concurrent
pushes. A device's own committed write arrives as a batch with `entries: []`,
so the cursor advances and there is nothing to mistake for a remote file. Live
changes that arrive mid-catch-up are held and released in order afterwards.

## Writing a file

```
-> {op:"put", id, path, meta:{size, ctime, mtime, folder, deleted, prev?},
    chunks:[h1,h2,h3], mac, parent}
<- {res:"want", id, chunks:[h2]}      only what the server lacks
-> binary frame for h2
<- {res:"ack", id, uid:152}
```

- Chunking is content-defined on a rolling hash, so inserting a line near the
  start of a large note changes one chunk instead of shifting all of them.
- `chunks` are lowercase hex SHA-256 hashes of the **encrypted** chunks, exactly
  64 characters. The server recomputes the hash on the way in and on the way
  out, so a body that does not match its name is refused, and bit rot surfaces
  as an error naming the chunk. Uploaded bodies are matched to `want` by
  hashing them, not by position.
- The stored ciphertext for one entry may not exceed `size + 256 * len(chunks)`
  bytes, counting repeated chunks once per reference. Over that is `toolarge`.
  Enforced as bodies arrive and again at commit.
- A file has chunks if and only if it has content. Zero-byte notes, folders and
  deletions carry none. `chunks` is always an array, in every direction.
- `{res:"have", uid}` means the server already held every chunk and the entry is
  recorded. `have` and `ack` are different outcomes and both are named.
- The ack is withheld until every chunk and the entry are durable.
- `prev` is the previous path on a rename, so a rename is one operation.
- `mac` and `parent` authenticate the entry; see below. The server holds no key
  and checks neither, but refuses an entry with no `mac` of the right shape.
- A rejected `put` returns `{res:"err", code, msg}` and the session continues.
- A quiet connection is kept. The server pings an idle session and expects a
  pong; it does not ping while frames are queued or a request is in flight,
  because a client busy reading a large fetch cannot answer. A client that
  stops answering is closed within a ping interval.
- On shutdown the server sends every idle session `{res:"err", code:"busy"}`
  with a reason and closes it; a request in flight is allowed to finish first.
  A client treats an error it did not ask for as the close reason.
- A reply can arrive before the one you asked for, because another device can
  commit at any moment. Clients demultiplex on `op` before matching a `res`.

## Writing many files at once

```
-> {op:"putmany", id, entries:[{path, meta, chunks, mac, parent}, ...]}
<- {res:"want", id, chunks:[h1,h2,h3]}    the union of what the server lacks
-> binary frames, in that order
<- {res:"acks", id, results:[{uid:152}, {uid:153}, {code, msg}, ...]}
```

Up to 256 entries, at most `maxBatchBytes` of encoded request, and at most
`maxBatchBytes` of summed ciphertext budget (`size + 256 * len(chunks)` over
every entry); a client splits a batch that would exceed any of the three, and
sends a file whose own budget exceeds it with `put`. `results` has one slot per entry, in the order sent. A
refused entry appears as `{code, msg}` in its slot and does not refuse the
batch, so a client never has to bisect two hundred notes to find the one the
server would not take. An empty batch is `badentry`; over 256 is `toolarge`.
Every rule of `put` applies.

## Authenticating an entry

The `mac` is an HMAC under a key derived for this alone, over a canonical
encoding of the sealed path, the size and times, the flags, `prev`, the chunk
list in order, and `parent`. Fields are length-prefixed rather than delimited,
because a delimiter is a character somebody's filename eventually contains.

The uid is not covered. The server assigns uids and ordering the log is its
job.

`parent` is a digest of the content id of the version the writer built on, or
empty for a file it had never synced. It tells a new version from an old one
replayed. It is per path rather than global, which keeps concurrent writers
from serialising. The cost is that a server withholding a version is
undetectable.

## Reading a file

```
-> {op:"get", id, uid}
<- {res:"chunks", id, uid, size, chunks:[h1,h2,h3]}
-> {op:"fetch", id, chunks:[h2]}      only what this device lacks
<- {res:"bodies", id, count:1}
<- binary frame for h2
```

One `fetch` may name the chunks of many files, up to `maxFetchBytes` of them,
so a first download is a handful of round trips rather than one per file. The
answer is either `bodies`, announcing exactly how many binary frames follow in
the order asked, or an `err`, and never bodies followed by an error. A `fetch`
naming any chunk the server lacks is `nochunk` with no bodies, because failing
halfway leaves a client unable to tell which frames it received.

A `get` for a missing uid is `nouid`. One for a folder or a deletion is
`nocontent`, distinct from an empty chunk list, which is a real zero-byte note.

## Deleting

A deletion is an entry with `deleted: true`, not the absence of one. The record
is what makes the file recoverable.

## Recovery

Two read-only operations:

| | |
|---|---|
| `{op:"history", id, path, before?, limit?}` | `{res:"history", id, path, entries}` |
| `{op:"deleted", id, limit?}` | `{res:"deleted", id, entries, more}` |

`path` is sealed in both directions. `history` returns every version of one
path newest first, deletions included; `before` pages backwards. An empty list
is indistinguishable from a purged history, because the server cannot tell them
apart. `deleted` returns paths whose newest version is a deletion, renames
suppressed, bounded at 1000, with `more` set when cut short. Each entry
carries `restorable`, the uid of the newest version with content, or 0 after a
purge.

There is no `restore` operation. A client fetches the version with `get`,
writes it, and the ordinary sync uploads it as a new version. The server keeps
one way to change a vault.

## Authentication

One secret. The auth key is derived from the root secret, so holding the root
secret is what it means to have the vault.

| Vault state | What opens it | What `claim` does |
|---|---|---|
| unclaimed | the server's first-run token | binds the vault to the offered auth key and stores `wrapped` |
| claimed | the auth key, checked against a stored hash, or a single-use invite | ignored |

The server stores only `sha256` of the auth key, unsalted. That is right for a
random 256-bit key, where there is nothing to guess and nothing for a slow hash
to slow down, and it must never be reused for anything a person chose. A stolen
disk yields ciphertext without the ability to add to it. Claiming is one-time
and cannot be undone over the wire, or a second device could lock the first
out. A device sends `claim` on every hello, so it never has to work out whether
it is first.

### The data key, and rotating a leaked secret

A vault claimed under protocol 3 has a **data key**: 32 random bytes generated
by the first device, wrapped under a key derived from the root secret, and
stored on the server as an opaque blob. Every key that touches content derives
from the data key; only the auth key and the wrapping key derive from the root.
The server returns the blob in `ready` so every device that holds the root
secret can unwrap it. The server cannot: it holds neither key.

That indirection is what makes a leaked pairing string survivable:

```
-> {op:"rotate", id, auth, wrapped}
<- {res:"rotated", id}
```

`auth` is the new auth key and `wrapped` the same data key wrapped under the
new root. The server replaces the stored hash and blob in one transaction,
closes every other session on the vault with `{res:"err", code:"auth"}`, and
from then on only the new root opens the vault. History is untouched, because
nothing sealed under the data key changed. The device that rotated prints a
new pairing string and every other device pairs again with it. `rotate` is
refused with `auth` on a session that authenticated with the bootstrap token
and with `badentry` on a vault that has no data key.

A vault claimed under protocol 2 has no data key: its content keys derive from
the root directly, and the only rotation is a new vault, which loses the
server's history. `ready` carries no `wrapped` for such a vault and the CLI
says so before it does anything.

### Adding a device with a single-use invite

The root secret is shown once, to the person who starts the vault, as a
recovery key to write down. It is never shown again to add a device. A device
that already has the vault issues an invite instead:

```
-> {op:"invite", id, invite, sealed, ttlMs?}
<- {res:"invited", id, expiresAt}
```

`invite` is a random 128-bit identifier and `sealed` is the root secret sealed
under a random 256-bit invite key, `n || AES-GCM-256(K_inv, n, S)`, both
base64url. The server stores the identifier, the blob and an expiry, and
returns nothing but the expiry. `ttlMs` defaults to ten minutes and may not
exceed one hour. The issuing device hands the person an invite string:
`basalt3i_` followed by base64url of a version byte, the identifier, the invite
key, the length-prefixed server address and vault id, and a CRC-32. The invite
key never reaches the server, so a stolen disk holds blobs it cannot open, and
the identifier is unguessable, so a stranger cannot redeem one by trying.

The new device redeems it at hello, in place of a token:

```
-> {op:"hello", id, proto:3, vault, device, crypto, invite}
<- {res:"redeemed", id, sealed, wrapped?}
```

The server marks the invite used before it answers, so it can be redeemed once
even if the reply is lost, and then closes the session. The new device unseals
the root secret with the invite key, stores it, and connects again with the
derived auth key like any other device. An unknown, expired or already used
invite is `auth`, never saying which. `rotate` deletes every outstanding
invite on the vault, because they seal the root that was just retired.
`invite` is refused with `auth` on a session that authenticated with the
bootstrap token.

The recovery key is still a pairing string (`basalt3_`) and `pair` still
accepts one, because a vault whose every device is lost has nothing else. The
CLI reprints it only on request and says what it is each time.

## Which clients may connect

The server verifies the `Origin` header. A Go or Node client sends none and is
allowed. Browser clients, which include Obsidian, must match `app://obsidian.md`,
`capacitor://localhost` or `http://localhost`, or a `-allow-origin` value. A
refused handshake logs the origin and the flag that would admit it.

## Crypto

`basalt/hkdf-aes-gcm/1` names the sealing construction, unchanged since
protocol 1.

```
S                                       root secret: 256 bits in a basalt3_ pairing
                                        string, 160 bits in a basalt2_ one, both accepted
K_auth    = HKDF(S, "basalt/auth/1")    the server stores only H(K_auth)
K_wrap    = HKDF(S, "basalt/wrap/1")
D         = 32 random bytes             the data key, generated once by the first device
wrapped   = n || AES-GCM-256(K_wrap, n, D)   n a random 12-byte nonce; stored by the server

K_path    = HKDF(D, "basalt/path/1")
K_content = HKDF(D, "basalt/content/1")
K_nonce   = HKDF(D, "basalt/nonce/1")
K_meta    = HKDF(D, "basalt/meta/1")

nonce(p)  = HMAC-SHA-256(K_nonce, p)[:12]
seal(K,p) = nonce(p) || AES-GCM-256(K, nonce(p), p)
```

A vault claimed under protocol 2 has no `D`; its four content keys derive from
`S` with the same info strings. Which schedule applies is decided by whether
`ready` carries `wrapped`, never by the pairing string's version.

Paths and chunks use the same construction under different keys. The nonce is
derived from the plaintext, so sealing is deterministic. Equal paths must seal
equal or the server cannot group versions of a file. Equal chunks must seal
equal or dedup does nothing, since chunk names are hashes of ciphertext. A
nonce repeats only for identical plaintext under the same key, which is exactly
the equality being asked for.

A chunk body is compressed before sealing. The sealed plaintext is one marker
byte, `0` for stored as-is or `1` for raw deflate at level 6, then the payload.
A chunk that does not shrink is stored as-is, so a sealed chunk is never more
than 29 bytes larger than its content. The marker is inside the sealed bytes,
so the server cannot tell which chunks compressed. The deflate implementation
must be deterministic across platforms, or the same chunk gets different names
on a desktop and a phone and dedup silently stops.

It is spelled out from HMAC and AES-GCM rather than named AES-GCM-SIV because
WebCrypto has no SIV mode, and the client runs in a webview on at least one
platform.

## What the server can see

Sizes, timestamps, chunk counts, the number of files, which sealed path changed
when, and which chunks are byte-identical. Not contents, not names, not folder
structure.

## Errors

```
<- {res:"err", id?, code, msg, retryable, retryAfterMs?}
```

`code` is for the client, `msg` is for the human. Every rejection has both.
`id` is present when the error answers a request. `retryable` says whether
reconnecting later can succeed where retrying the same request cannot: a
watching client backs off and reconnects on a retryable error and stops on any
other, with nothing to interpret. `retryAfterMs` is a hint on `busy`, so a
device refused for the device limit does not hot-loop.

An error sent before the server knows which protocol the client speaks, such
as a refusal at admission during shutdown or at the pre-auth cap, a first frame
that is not a hello, or a `proto` below the minimum, has the protocol 2 shape:
no `id` and no `retryable`. A client treats those by code.

The session **continues** after a code that rejects one request, and **ends**
after one that means the connection should not have been opened or the two ends
no longer agree how many frames are outstanding.

| code | meaning | retryable | session |
|---|---|---|---|
| `proto` | unsupported `proto` or `crypto` | no | ends; it is only sent at hello |
| `auth` | bad token or vault, never saying which | no | ends |
| `cursor` | the client is ahead of the server | no | ends |
| `busy` | the vault's device limit, or the server is shutting down | yes, with `retryAfterMs` | ends |
| `protostate` | a message that does not belong in the current state | no | ends, except an unknown op or a negative `before` on a `history`, which reject that one request and continue |
| `badchunk` | a body that does not hash to the name asked for, or a malformed chunk name | no | continues, except a bad body arriving mid-upload, which ends because the two ends no longer agree how many frames remain |
| `badentry` | a structurally invalid put | no | continues |
| `badname` | a path the server cannot store | no | continues, except an over-long device name at hello, which ends |
| `toolarge` | above an advertised ceiling, or more ciphertext than the size allows | no | continues, except uploads passing the declared size mid-put, which ends |
| `nospace` | refused for want of disk | yes | ends; it can only arise mid-upload, where the frame count is no longer agreed |
| `nouid` | no such entry | no | continues |
| `nocontent` | the entry is a folder or a deletion | no | continues |
| `nochunk` | the server does not hold that chunk | no | continues, except a body found unreadable mid-fetch, which ends |
| `internal` | a server-side fault; the put is not committed | yes | ends during handshake or catch-up, otherwise continues |

## Protocol 2 sessions

The server accepts `proto: 2` for one release, on vaults that have no data
key. A protocol 2 hello on a vault claimed under protocol 3 is refused with
`proto`, because that client would seal under the root-derived schedule and
nothing else on the vault could read what it wrote. Such a session has no ids, no
`bodies` header, no `retryable` field, no `wrapped`, and no `invite` or
`rotate`; it is
answered exactly as protocol 2 was, and `ready` still carries the new ceilings,
which a protocol 2 client ignores. A protocol 3 client against a protocol 2
server is refused at hello with both numbers. Upgrade the server first.
