# The wire protocol, v4

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

A hello offers one of three credentials, and which one it offers decides what
the session may do.

**A device connecting.** `deviceId` names its row in the vault's device list
and `token` is that device's own auth key.

```
-> {op:"hello", id, proto:4, vault, deviceId, token, device,
    crypto:"basalt/hkdf-aes-gcm/1", cursor}
<- {res:"ready", id, proto:4, minProto:4, serverVersion, cursor,
    perFileMax, chunkMax, maxChunks, maxBatchBytes, maxFetchBytes, wrapped}
```

**The vault's own credential.** No `deviceId`, and `token` is the key derived
from the root secret, which is the recovery key. What comes back is a
registrar session: it may `register` a device and `rotate` the vault's secret,
and it may do nothing else.

```
-> {op:"hello", id, proto:4, vault, token, device, crypto, claim?, wrapped?}
<- {res:"registrar", id, proto:4, minProto:4, serverVersion, maxDevices}
```

A registrar gets no `ready`, no catch-up and no place in the vault's fan-out,
because there is nothing it may be sent. `ready` promises the ceilings for a
`put` and a backlog behind it, and a reply that promised a catch-up nobody
would send is how a client comes to wait for a frame that is not coming.

**An invite being redeemed.** `invite` in place of a token, beside the device
row the redemption is to register. It is answered `redeemed` and closed; see
**Adding a device with a single-use invite**, which is the ordinary way a
device is added and the reason the recovery key stays offline.

```
-> {op:"hello", id, proto:4, vault, device, crypto, invite, deviceId, auth, name?}
<- {res:"redeemed", id, sealed, deviceId}
```

`cursor` is the last uid the client applied, or 0. The server speaks every
version from `minProto` to `proto` and answers in the version the client asked
for, so the upgrade order is the server first, then each client. Today that
range is one version wide, and anything outside it, or a `crypto` the server
does not implement, is refused with `{res:"err", code:"proto"}` naming both
numbers. That refusal does not name the server's version: nothing has
authenticated when it is sent, and `serverVersion` travels in `ready` and in
`registrar`, after a hello has succeeded.

**Protocol 4 is not compatible with 3, and there is no shim.** A protocol 3
hello carries no `deviceId`, and its `token` was the vault's credential used as
a sync credential, which is exactly what 4 took away. A server that guessed
would be handing a connection the sync rights per-device credentials exist to
make revocable. So a protocol 3 client is refused at hello, naming its number
and the server's range, and upgrades. Protocol 3 was in use by one person for
one day.

`claim` and `wrapped` travel together, and a hello carrying a claim without a
valid `wrapped` is refused with `badentry` and ends, whatever state the vault
is in. Every claimed vault therefore has a data key and every `ready` carries
one.

A client sends the pair only while it is still claiming, which is while it
holds the server's first-run token, and sends the same `wrapped` every time: a
claim retried after a lost reply must offer the key it offered before, or the
vault can be bound to one candidate while the device goes on proposing another.
It stops once the token is spent. A claim on a claimed vault changes nothing on
the server, but it hands a wrapping of a data key to a server that has no
honest use for it, and a dishonest one can return that wrapping as the vault's
own; see **The data key** for the other half of that.

`vault` and `device` are at most 64 characters and contain no control
characters; either fault is `badname` and ends the session, because both land
in logs and file paths. `deviceId` is at most 64 characters of base64url, with
no minimum: the server cannot check that sixteen random bytes were random, and
a minimum would admit a string of A's anyway. A malformed one is `badname` too,
rather than `auth`, because it is a fact about the request and answering it
with `auth` would make the shape of an id look like the answer to whether that
device is registered. A hello carrying a `deviceId` and also a `claim` is
`badentry`: one is a registered device connecting and the other is how a vault
is bound, and a server that picked one would be choosing which the client
meant. A `deviceId` beside an `invite` is not that case and is required: see
**Adding a device with a single-use invite**.

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
`get`, `fetch`, `history`, `deleted`, `invite`, `rotate`, `register`,
`devices`, `revoke`. The reply echoes it,
and so does an `err` refusing that request. A request with no `id`, or one
outside that range, is `protostate` and ends the session. `batch`, `caught-up` and pings are
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

Two credentials, deliberately separated, and the separation is the point.

| credential | held by | may |
|---|---|---|
| the vault's auth key, derived from the root secret | nobody, offline, written down as the recovery key | register a device, rotate the vault's secret, administer the device list |
| a device's auth key | one device | connect and sync as that device, and revoke any device but the last |

The server stores only `sha256` of either key, unsalted. That is right for a
random 256-bit key, where there is nothing to guess and nothing for a slow hash
to slow down, and it must never be reused for anything a person chose. A stolen
disk yields ciphertext without the ability to add to it.

**The vault's credential may not sync.** Through protocol 3 it was the sync
credential: every device held the root, derived the same key, and matching the
stored hash was what a hello proved. That is why revocation would have meant
nothing then, and why the narrowing had to come before the device list. A vault
whose devices can all be bypassed by the one credential they were meant to
replace has a device list and no revocation, which is worse than having no
list, because it looks like it works.

It is enforced by there being one code path that builds a syncing session, and
the only way into it is a `deviceId` whose stored hash matched the offered key.
A registrar session is refused every op that reads or writes a note, is in no
fan-out, and is not counted against the vault's connected-device limit, because
it is not a device.

What a registrar may also do is read the device list and take a row off it. The
list is who may connect rather than what the vault holds, it carries no key
material, and two things need the recovery key to reach it: emptying the vault
is the recovery key's alone, below, and a vault whose every row is a pairing
that crashed refuses each new registration with `full`, leaving no device to
prune the list from. The cost is stated rather than hidden: a leaked root can
stop devices connecting, where before it could only read and add. Rotation is
what answers a leaked root, and every write a registrar makes, `revoke`
included, is conditional on the credential it authenticated under still being
the vault's.

**Claiming.** A vault with no auth hash is opened only by the server's
first-run token, in exchange for `claim`, the key it is to be bound to, and
`wrapped`. Claiming is one-time and cannot be undone over the wire, or a second
device could lock the first out. A device sends `claim` while it still holds
the bootstrap token and not after, so it never has to work out whether it is
first. A hello that claims is a registrar session like any other, so creating
a vault is: claim, `register` the first device, then connect as that device.
A session that authenticated with the bootstrap token may not `rotate`, because
it proved nothing about holding the old root.

### The device list

A device is a row: an id it chose, a name a person reads, the hash of its own
auth key, when it was created and when it was last seen. The id is the
identity; the name is never one, and two laptops may both be called laptop.

```
-> {op:"register", id, deviceId, auth, name?}     registrar sessions only
<- {res:"registered", id, deviceId, wrapped}

-> {op:"devices", id}                             either credential
<- {res:"devices", id, devices, maxDevices, invites}

-> {op:"revoke", id, deviceId, allowLast?}        either credential
<- {res:"revoked", id, deviceId, self}            allowLast: registrar only
```

`auth` is the new device's auth key, not its hash, for the same reason `claim`
is the key: the server keeps only the digest either way, so the key reveals
nothing the digest would have hidden, and what it buys is that a credential
short enough to guess can be refused. `name` defaults to the session's own
`device`. `wrapped` comes back because the registering session holds the root
and can unwrap it, which is how a device ends up holding the data key without
ever holding the root.

Registering the same `deviceId` with the same key again succeeds and is the
registration having happened. That is the half-finished registration: the row
committed and the reply was lost. Answering `badentry` there would leave a
device retrying for ever, which is the same defect a duplicate invite
identifier had. A *different* key under an id the vault already holds is
somebody else's device and is `badentry`, and nothing is overwritten.

**A device may not register a device.** It holds no vault credential, so a
stolen laptop can read what it already had and cannot add a device of its own.
It may list, and revoke any device but the vault's last, including itself,
which is what unlinking is.

**Revoking closes the device's live sessions**, and the reply means both. The
row alone would be a revocation the revoked device never notices: it holds an
authenticated connection, nothing on a live session is re-checked, and it
would go on receiving every note pushed to the vault while the panel said it
was gone. The order is the guarantee. A revoke deletes the row and only then
collects the sessions to close; a connecting device joins the fan-out and only
then stamps its `lastSeen`. So either the delete is first and the stamp finds
no row, and the connect is refused, or the join is first and the revoke finds
the session. There is no interleaving that leaves a revoked device connected.

**Emptying the vault takes the recovery key.** Ordinary revocation is any
device's: a phone cutting off a stolen laptop without anybody digging out the
recovery key is why there is revocation here rather than only rotation. The
last row is the exception, and the only one. `allowLast` is honoured on a
registrar session and refused with `auth` on a device's, because it is the one
revocation nothing on a device can undo: what it leaves is a vault only the
recovery key opens, so a compromised device could otherwise delete every row
and the last one with it and leave its owner holding devices that cannot reach
their own notes. It costs nothing in the case it is for, since a device stolen
when it was the only one wants a rotation as well, and rotating already needs
the key. A registrar still has to send `allowLast`, and without it gets
`badentry`: the confirmation is still asked, now of the credential that can
undo the answer. Revoking an id the vault does not have is `nodevice`, which
says the list you were reading is stale.

Revoking stops a device connecting. It does not un-read what that device
already read: it still holds the data key and can decrypt every note it had
synced. A device that was stolen rather than merely lost wants a rotation too.

**Eight devices.** `maxDevices` is in `registrar` and in the device list, so a
client knows the cap before it registers rather than discovering it by being
refused. The ninth registration is `full`, which is not `busy`: `busy` means
come back later and this never becomes true by waiting, because somebody has to
revoke a device.

`full` names how many of the vault's rows have never connected, and both
clients flag those rows in the list. They are the reclaimable ones, and they
are what the redemption ordering costs: the row is written before the device
redeeming it saves anything, so a pairing that reaches the server and then
crashes strands a row rather than a device that believes it is paired. That is
the right way round and does not change, but eight of them, or eight an
attacker minted invites for, fill the cap. Nothing reclaims one on its own; a
server deleting a device row because it looks unused is the failure the cap
decision already refused. What the refusal can do is point at the rows worth
looking at, so that "the vault is full" is an instruction rather than a choice
between somebody's working devices. It is the same eight as the connected-device limit, and a test
pins the two together, because a vault that could register more devices than it
can connect would have one that registers and is then refused with `busy` for
ever with nothing saying why. A vault that somehow already holds more keeps
every row and every one of those devices goes on syncing: the cap bounds
growth, and enforcing it backwards would mean the server choosing which of
somebody's devices stops working, silently.

### The data key, and rotating a leaked secret

Every claimed vault has a **data key**: 32 random bytes generated by the first
device, wrapped under a key derived from the root secret, and stored on the
server as an opaque blob. Every key that touches content derives from the data
key; only the vault's auth key and the wrapping key derive from the root. The
server returns the blob in `ready` and hands it to a registrar in `registered`.
The server cannot open it: it holds neither key.

That indirection is what separates the two credentials. A device is given the
data key when it is registered, by the registrar that could unwrap it, so a
device never needs the root and never holds it. It is also what makes a leaked
recovery key survivable, below.

Rotating is a registrar's op, because it is the root that is being replaced:

```
-> {op:"rotate", id, auth, wrapped}       registrar sessions only
<- {res:"rotated", id}
```

`auth` is the new auth key and `wrapped` the same data key wrapped under the
new root. The server replaces the stored hash and blob in one transaction, and
from then on only the new root opens the vault. History is untouched, because
nothing sealed under the data key changed.

**A rotation touches no device row, and every device keeps syncing across
one**, mid-session, without pairing again. That is the expensive half of what
per-device credentials removed: under protocol 3 the vault's hash *was* the
credential every device held, so a rotation evicted the lot and each one had to
be paired again from the new string, which for a laptop, a phone, a desktop and
a NAS is a weekend, and is the reason a leaked string went unrotated.

What a rotation does close is every *other* registrar session on the vault,
with an unsolicited `{res:"err", code:"auth"}`. Those are holding the root that
was just retired.

Every write a registrar makes is conditional on the credential its session
authenticated under still being the vault's, so a retired root can make none of
them. A second `rotate` is refused with `rotated`, and so are a `register` and
a `revoke`. Closing a socket does not stop a request already in flight, so an
unconditional swap let the loser overwrite the winner and the device the winner
was revoking ended up owning the vault.

The two device-list ops are the same race with worse prizes, and both turn on
the one fact that a rotation deliberately leaves every device row alone. A
device registered a millisecond too late by the leaked key would still be there
afterwards, which is permanent access outliving the rotation meant to end it. A
row deleted a millisecond too late is the other direction: the retired root
answers the rotation by locking every real device out of the vault.

A client that has a rotation outstanding, sent with no reply, keeps both
secrets and tries the new one first on its next connect, falling back to the
old one. The server commits before it answers, so a lost reply is otherwise a
vault whose new root exists only in the process that made it.

Every vault has a data key, so rotation always works in place and never costs
the history.

### Adding a device with a single-use invite

The root secret is shown once, to the person who starts the vault, as a
recovery key to write down. It is never shown again, and adding a device does
not need it. A device that already has the vault issues an invite instead:

```
-> {op:"invite", id, invite, sealed, ttlMs?}      device sessions only
<- {res:"invited", id, expiresAt}
```

`invite` is a random 128-bit identifier and `sealed` is the **vault's data
key** sealed under a random 256-bit invite key, `n || AES-GCM-256(K_inv, n,
K_data)`, both base64url. The server stores the identifier, the blob and an
expiry, and returns nothing but the expiry. `ttlMs` defaults to ten minutes and
may not exceed one hour. The issuing device hands the person an invite string:
`basalt3i_` followed by base64url of a version byte, the identifier, the invite
key, the length-prefixed server address and vault id, and a CRC-32. The invite
key never reaches the server, so a stolen disk holds blobs it cannot open, and
the identifier is unguessable, so a stranger cannot redeem one by trying.

The data key and not the root, since protocol 4. A device holds no root, so it
has none to seal, and an invite that carried one would hand the new device the
credential that registers devices and rewraps the vault: everything revoking a
device is meant to take back.

An invite that has not been redeemed is visible, and can be cancelled:

```
-> {op:"uninvite", id, invite}                    either credential
<- {res:"uninvited", id, invite}
```

Outstanding invites ride on the device list, in `invites`, as an identifier and
an expiry each and never the sealed blob. They are the same question the rows
answer: a row is a device that was added, an outstanding invite is one about to
be. Before they were listed, an invite was the one authority on a vault that
nothing could see, so a string issued on a stolen laptop stayed invisible until
somebody redeemed it, for up to an hour. Seeing the identifier redeems nothing:
that also takes the invite key, which never reaches the server and exists only
in the string somebody is holding. What the identifier is for is `uninvite`,
which deletes the row so the string stops working before it expires. Without
it, the only ways to retire an invite were to wait out the hour or to rotate,
which retires the recovery key with it. An identifier that is unknown, expired
or already redeemed is one `badentry`, saying which of the three to nobody, for
the reason every other invite refusal is one answer, and the message says to
look at the device list, because a redeemed invite is a row there now.

The new device redeems it at hello, in place of a token, and names the device
row it is asking for:

```
-> {op:"hello", id, proto:4, vault, device, crypto, invite, deviceId, auth, name?}
<- {res:"redeemed", id, sealed, deviceId}
```

**Redeeming registers the device.** The invite is unguessable, single use,
server tracked and expiring, which is exactly the authority to register exactly
one device, and it has to be: the issuing device holds no root and so cannot
register a row on the newcomer's behalf, and the newcomer holds nothing else
the server would accept a registration under. `deviceId` and `auth` are the
row's id and the key its hash is taken from, the same fields `register` takes
and bounded the same way; `name` defaults to `device`.

The spend and the insert are one transaction. An invite is never spent without
a row, and no row is ever written under an invite that is still live, so every
refusal below leaves the string in somebody's hand still working.

The session closes after `redeemed`. It is not a device session: nothing on it
has proved that anybody holds the key just registered, and the redeemer has to
write that key and the data key down before it can use either. Its next hello,
as an ordinary device, is the proof. There is no `wrapped` in the reply and
there must not be: the wrapping opens under the root and a redeemer holds none.

Refusals. An unknown, expired, already used or malformed invite is `auth`,
never saying which, and an unclaimed vault is the same answer. A hello carrying
an invite without a `deviceId`, or with an `auth` key shorter than 32
characters, or with a name the server will not store, is `badname` or
`badentry`: those are facts about the frame rather than about the vault, and
naming them cannot leak whether the invite exists. An id the vault already
holds is `badentry`, and the invite stays unspent so the redeemer can pick
another. A vault already at its device cap is `full`, not `busy`, because
waiting never makes room; revoke a device and the same string works, and the
refusal says how many rows have never connected, because those are the ones
that cost nothing to revoke. A hello
carrying both a token and an invite, or both a claim and an invite, is
`badentry`, because an invite stands in for the one and excludes the other, and
sending both leaves the server choosing which credential was meant. Issuing an
invite under an identifier the vault already holds is `badentry` too, rather
than a retryable `internal` a client would repeat for ever.

`rotate` deletes every outstanding invite on the vault. That is the same guard
registration has: a rotation exists to end access somebody should not have, and
an invite issued before one is a device somebody could still add after it.
`invite` is refused with `auth` on a registrar session, which is what a session
holding the vault credential or the bootstrap token gets: an invite seals the
data key, which a registrar does not hold. `uninvite` is not, because
cancelling one needs nothing but the identifier.

The recovery key is still a pairing string (`basalt3_`) and `pair` still
accepts one, because a vault whose every device is lost has nothing else: it is
the credential that opens a registrar session, registers a device and hands it
the data key. That is the last resort, not the ordinary path, and both shells
say so where they offer it.

## Which clients may connect

The server verifies the `Origin` header. A Go or Node client sends none and is
allowed. Browser clients, which include Obsidian, must match `app://obsidian.md`,
`capacitor://localhost` or `http://localhost`, or a `-allow-origin` value. A
refused handshake logs the origin and the flag that would admit it.

## Crypto

`basalt/hkdf-aes-gcm/1` names the sealing construction. It is versioned
separately from the wire, because how a chunk is sealed and how two ends talk
change for different reasons.

```
S                                       root secret, 256 bits, in a basalt3_ recovery key
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

There is one schedule and every content key hangs off `D`. That is not a
simplification, it is the reason a leaked `S` can be retired: nothing sealed
depends on it. It also removes a state a server could otherwise choose. When a
vault might or might not have had a data key, a server could pick the schedule
a device used by leaving `wrapped` out of `ready`, and the device had no way to
know it had been moved onto keys no other device could read.

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
device refused for the device limit does not hot-loop. The two causes carry
different hints: 30 seconds at the device limit, where a slot frees when
somebody closes a laptop, and 5 seconds on shutdown, where the server is
expected straight back.

Every error carries `retryable`, including the ones sent before a hello has
been read. A client still keeps a default by code for a frame that arrives
without the field, which is a defence against a malformed answer rather than a
second shape to support: a refusal at admission during shutdown or at the pre-auth cap, a
first frame that is not a hello, or an unsupported `proto`. What such an error
lacks is an `id`, because it answers no request, and so do the shutdown and
rotation notices.

The session **continues** after a code that rejects one request, and **ends**
after one that means the connection should not have been opened or the two ends
no longer agree how many frames are outstanding.

| code | meaning | retryable | session |
|---|---|---|---|
| `proto` | unsupported `proto` or `crypto`, or a vault an older build claimed with no data key | no | ends; it is only sent at hello |
| `auth` | bad token, vault or device, never saying which; or an op, or a field of one, this session's credential may not send | no | ends at hello, continues when it refuses one op |
| `cursor` | the client is ahead of the server | no | ends |
| `rotated` | a `rotate`, `register` or `revoke` whose credential is no longer the vault's, because somebody rotated first | no | ends |
| `busy` | the vault's device limit, or the server is shutting down | yes, with `retryAfterMs` | ends |
| `protostate` | a message that does not belong in the current state | no | ends, except an unknown op or a negative `before` on a `history`, which reject that one request and continue |
| `badchunk` | a body that does not hash to the name asked for, or a malformed chunk name | no | continues, except a bad body arriving mid-upload, which ends because the two ends no longer agree how many frames remain |
| `badentry` | a structurally invalid put, or a well-formed request the vault's state refuses: a duplicate device id, or the last device without `allowLast`. A device sending `allowLast` is `auth` instead, because that is about its credential | no | continues, except a claim at hello carrying no valid `wrapped`, which ends |
| `badname` | a path the server cannot store, or a malformed device id | no | continues, except an over-long device name or a malformed device id at hello, which end |
| `toolarge` | above an advertised ceiling, or more ciphertext than the size allows | no | continues, except uploads passing the declared size mid-put, which ends |
| `nospace` | refused for want of disk | yes | ends; it can only arise mid-upload, where the frame count is no longer agreed |
| `nouid` | no such entry | no | continues |
| `nocontent` | the entry is a folder or a deletion | no | continues |
| `nochunk` | the server does not hold that chunk | no | continues; a body that fails its own hash is found before the header, quarantined, and refused with no bodies sent |
| `nodevice` | this vault has no device with that id; the list you read is stale | no | continues |
| `full` | the vault already has as many devices as it may register | no | continues |
| `internal` | a server-side fault; the put is not committed | yes | ends during handshake or catch-up, otherwise continues |

### Why `busy` is still not two codes

`busy` covers the vault's connected-device limit and a server shutting down,
which are unrelated conditions, and splitting them has been proposed more than
once. Protocol 4 did add a `full`, and it is deliberately not this: `full` is
the *registration* cap, which no amount of waiting clears, and the two limits
are answered differently for exactly that reason. A connection refused at the
device limit succeeds when somebody closes a laptop; a ninth registration
succeeds when somebody revokes a device.

The reason the connection limit keeps sharing `busy` is in the client: a client
decides whether to retry from an allowlist of codes it knows, so a code it has
never seen is not retryable. Send a device at the connection limit a code it
does not know and it stops for good, where `busy` has it come back. That is the
failure the allowlist exists to prevent, aimed at the one case that most needs
a retry.

Nothing is lost by the sharing. Both conditions want the same thing from a
client, come back later, and they already differ in the only two ways that
carry: `retryAfterMs`, which says how much later, and the message, which says
`this server is shutting down, reconnect in a moment` or
`vault has 8 devices connected, limit is 8`. No client branches on the
distinction and a person reading a log has the sentence, not just the number.

If it is ever split, both ends move together: the client learns the new code
first and only then may a server send it.
