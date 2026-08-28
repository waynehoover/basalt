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

Paths reach the server encrypted, so this rule splits in two. The *name* check
is the client's, applied to the plaintext before encryption, because the server
holds no key and cannot see a `:`. The server validates what it can see:
structure, bounds, and the internal consistency of the entry, including that a
file declaring a size names at least one chunk. That last one matters because an
entry with a size and no chunks is byte-identical on the wire to an empty file,
so a lost chunk list would present to every device as the note having been
emptied.

**Namespace by string, version the protocol.** `basalt/aes-gcm+siv/1`, not an
integer shared with other implementations. The handshake carries a protocol
version and a mismatch is refused, not negotiated.

## Handshake

```
-> {op:"hello", proto:1, vault, token, device, crypto:"basalt/aes-gcm+siv/1", cursor}
<- {res:"ready", cursor, perFileMax, chunkMax}
```

`cursor` is the last uid the client has applied, or 0. The server refuses on a
`proto` or `crypto` it does not implement, with `{res:"err", code:"proto"}`,
rather than trying to interoperate.

## Catch-up

The server sends everything after `cursor` as ordered batches, then `ready`.

```
<- {op:"batch", from:120, to:139, entries:[...]}
<- {op:"batch", from:140, to:151, entries:[...]}
<- {op:"caught-up", cursor:151}
```

Entries within a batch are uid-ascending, and `from`/`to` let the client assert
continuity. A client that sees a gap asks again from its own cursor instead of
silently advancing past it.

`from` and `to` are a *covered range*, not the first and last uid present. Every
entry that exists with `from <= uid <= to` is in the batch, and a client that has
applied everything up to `from - 1` may set its cursor to `to`. The distinction
matters because history can be purged, so the uid sequence has holes; if
`from`/`to` meant "the uids in this batch", every hole would read as a lost file.
The continuity check is therefore `from == cursor + 1`, which a purge cannot
break and a genuine gap cannot satisfy.

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
- `{res:"have"}` with no `chunks` means the server already holds every chunk and
  the entry is recorded; nothing more is sent.
- The ack carries the assigned uid and is withheld until every chunk and the
  entry are durable. "Acked" means stored.
- `prev` is the previous path on a rename, so a rename is one operation rather
  than a delete plus an add.
- A rejected `put` returns `{res:"err", code, msg}` and the session continues.
  Obsidian's protocol has no clean way to refuse a push, which is why a bad one
  has to close the connection.

## Reading a file

```
-> {op:"get", uid}
<- {res:"chunks", chunks:[h1,h2,h3], size}
-> {op:"fetch", chunks:[h2]}          only what this device lacks
<- binary frame for h2
```

A device that already holds `h1` and `h3` from another version of the file never
downloads them again.

## Deleting

A deletion is an entry with `deleted:true`, not the absence of one. That record
is what makes the file recoverable and what stops a vault of deleted files from
looking like an empty vault.

## What the server can see

Sizes, timestamps, chunk counts, the number of files, and which encrypted path
changed when. Paths are deterministically encrypted, so the server can tell that
two entries concern the same file without knowing its name. This is a deliberate
trade: determinism is what makes dedup and equality work.

The server cannot see file contents, file names, or folder structure, and holds
no key for any of it.

## Errors

```
<- {res:"err", code:"proto"|"auth"|"badname"|"toolarge"|"nospace", msg}
```

`code` is for the client, `msg` is for the human. Every rejection has one of
each, because an error a device cannot act on and a person cannot read is how a
silent failure starts.
