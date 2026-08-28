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

---

# What reading the two artifacts actually showed

The notes above were written from an earlier reading. This section records what
was found when both sources were read properly: Obsidian 1.13.7's `app.js`
extracted from its asar and run through prettier, and LiveSync 1.0.21 with its
two supporting libraries, `livesync-commonlib` and `octagonal-wheels`.

Everything here is cited to a line or a file, because the point of writing it
down is that neither artifact will answer these questions again without the same
day's work.

## The merge defect, verified rather than inferred

`docs/philosophy.md` claims Obsidian's merge discards the flags that say which
hunks failed. Here it is, whole, at `app.js:118574` after formatting:

```js
function bZ(e, t, n) {                 // (base, mine, theirs)
  var i = new mL(),                    // diff_match_patch
    r = i.diff_main(e, t, !0, 0);
  r.length > 2 && (i.diff_cleanupSemantic(r), i.diff_cleanupEfficiency(r));
  var o = i.patch_make(e, r);
  return i.patch_apply(o, n)[0];       // <- the flags array is index 1
}
```

Confirmed. One detail the philosophy doc does not mention and should: the diff is
passed through `diff_cleanupSemantic` and `diff_cleanupEfficiency` when it has
more than two edits. Those improve how a merge reads to a human; Basalt should
do the same, because dropping them would make our merges worse in a way that
has nothing to do with the flag bug we are fixing.

## When Obsidian merges at all

The guard, at `obsidian-sync-engine.js:1471` in the extracted region:

```js
if (p.initial || v.folder || p.folder || p.deleted ||
    "md" !== Fl(d) || p.hash === v.synchash) return [3, 54];   // skip merging
```

So a three-way merge is attempted only for a **markdown** file that is not a
folder, not deleted, not part of an initial sync, and whose server hash differs
from the remembered `synchash`. Everything else is last-writer-wins by mtime.

That last clause is the useful one: `p.hash === v.synchash` means "the server
has not moved since we last agreed", so there is nothing to merge and the local
edit simply wins. One field, one comparison, and it decides the whole question.

Its conflict branch (`conflictAction === "conflict"`) does something worth
copying and one thing worth not:

- The conflict copy is named `<name> (Conflicted copy <device> <timestamp>)`,
  the timestamp being `toLocaleString("sv")` with `[:\- ]` stripped to 12
  characters, and the device name sanitised. `vault.getAvailablePath` is used so
  a second conflict does not overwrite the first. All of that is right.
- The conflict copy receives the **local** content and the original file is
  overwritten with the **server** content. That is a defensible choice, but it
  means the file you are looking at changes under you and your version moves to
  a file you have not opened. Basalt keeps the local content in place and puts
  the incoming version in the conflict copy, so the file you are editing is
  never rewritten by a sync you did not ask for.

## LiveSync's chunker, in full

`livesync-commonlib/src/string_and_binary/chunks.ts:493`,
`splitPiecesRabinKarp`. This is content-defined chunking as actually shipped:

| | |
|---|---|
| Rolling hash | Rabin-Karp, `PRIME = 31`, 32-bit wrapping via `Math.imul` |
| Window | 48 bytes |
| Boundary test | `(hash >>> 0) % avgChunkSize === 1` |
| Text sizes | min 128 B, avg 256 B, max 1 KiB |
| Binary sizes | min 256 KiB, avg 1 MiB, max 4 MiB |
| Absolute floor on max | 30 KiB, because a 48-byte window needs room to find a boundary |

Two adaptive rules sit on top, and both exist to stop the chunk count exploding:

- Text mode is abandoned entirely for files of 4 MiB or more, because per-chunk
  overhead at 256 bytes a chunk stops being worth it.
- Below that, the text chunk unit grows in steps of 32 bytes until the estimated
  chunk count falls under `MAX_CHUNK_COUNT = 500`.

The boundary probability comment in the source is worth restating because it is
the property the whole design rests on: the chance of the hash matching is
inversely proportional to the average chunk size, so aiming for 256 bytes means
roughly a 1-in-256 chance per byte, and chunk sizes come out exponentially
distributed around the average without anything having to track position.

**UTF-8 safety.** A boundary is rejected if the *next* byte is a continuation
byte (`(buffer[pos + 1] & 0xc0) === 0x80`), so a chunk never splits a multi-byte
character. Their unit test for it is about a U+FEFF landing at the start of an
internal chunk, which suggests it was found the hard way.

**What it does that we should not.** It reads the entire file into memory with
`new Uint8Array(await dataSrc.arrayBuffer())` before chunking. For a vault of
notes that is fine and for a vault with video attachments it is not. The
algorithm is inherently streamable, since the window is 48 bytes, so Basalt
should stream it. That is a real difference, not a stylistic one.

**The older binary path**, `splitPieces2`, is worth knowing about even though it
is superseded, because it contains a good idea: split binaries on a delimiter
that recurs structurally in the format. Null by default, `/` for PDF, `,` for
JSON. And it derives the minimum chunk size by clamping the file size to
[100 KB, 100 MB] and dividing by 12.5 until under 10, giving a power of ten. It
is arbitrary but it is tuned, and the shape of the tuning is informative.

## Eden, which is a good idea we are refusing

Settings `maxChunksInEden`, `maxTotalLengthInEden`, `maxAgeInEden`. Chunks are
"incubated" inside the document itself and only "graduate to independent chunks"
once they exceed a count, a total size, or an age.

The problem it solves is real: a note edited fifty times a day generates fifty
chunk documents, most of which are dead within the hour. Keeping the churn
inline until it settles avoids that.

Basalt does not need it, and the reason is worth stating so nobody adds it
later. Eden exists because LiveSync stores each chunk as a separate CouchDB
document, so a chunk has a document's cost. Basalt stores a chunk as a file in a
content-addressed directory, and its cost is an inode and a `Purge` away. The
optimisation is a response to a constraint we do not have.

## The crypto, which settles an open question

This is the most useful thing in either source, because it answers a question
`docs/protocol.md` had answered wrongly.

`octagonal-wheels/src/encryption/hkdf.ts`:

```
passphrase --PBKDF2(SHA-256, 310_000 iterations, 32-byte salt)--> master key
master key --HKDF(SHA-256, 32-byte salt)--> AES-GCM-256 key
envelope: | iv(12) | hkdfSalt(32) | ciphertext+tag(16) |, base64, prefix "%="
```

Everything in that chain is WebCrypto-native. **Nothing uses AES-GCM-SIV**,
which matters because Basalt's handshake declares
`basalt/aes-gcm+siv/1` and WebCrypto's AES algorithm list is fixed by
specification at CBC, CTR, GCM and KW. There is no SIV mode, and this machine's
Node and OpenSSL report no `-siv` cipher either. Basalt declared a primitive its
own client platform cannot provide.

The PBKDF2 cost is memoised (`memoWithMap(10, ...)`) and it has to be: 310,000
iterations is a visible pause on a phone. Derive once per passphrase, cache the
key, never derive per file.

### Deterministic paths, and the trap in copying it

`octagonal-wheels/src/encryption/obfuscatePathV2.ts` derives an HMAC key by
HKDF and then hashes the path:

```
key  = HKDF(passphrase, salt) -> HMAC-SHA-256 key
path = "%/\\" + base64url(HMAC(key, plaintextPath))
```

Deterministic, which is what dedup and equality need. But the file's own comment
says it plainly: *"it cannot be used to decrypt the path back to its original
form."* It is one-way.

LiveSync can afford that because the real filename is also stored inside the
encrypted document, so the obfuscated path is only a lookup key. Basalt's
protocol has no such second copy: an entry's `path` is the only place the name
appears, and a device receiving an entry for a file it has never seen must
recover the name from it to write the file to disk.

So copying `obfuscatePathV2` directly would produce a vault that syncs
filenames nobody can read. The requirement is deterministic **and reversible**.

### What Basalt should do instead

One construction, used with two different keys, and it is buildable from
WebCrypto alone:

```
S                                  root secret, generated on device 1
K_auth    = HKDF(S, "basalt/auth/1")        the server stores only H(K_auth)
K_path    = HKDF(S, "basalt/path/1")
K_content = HKDF(S, "basalt/content/1")
K_nonce   = HKDF(S, "basalt/nonce/1")

nonce(p)  = HMAC-SHA-256(K_nonce, p)[:12]           synthetic, so deterministic
seal(K,p) = nonce(p) || AES-GCM(K, nonce(p), p)     reversible, deterministic
```

This is the synthetic-IV idea that GCM-SIV packages up, assembled from the two
primitives WebCrypto does provide. Same plaintext always gives the same
ciphertext, so paths compare equal and chunks deduplicate; different plaintexts
get different nonces, so the nonce-reuse hazard that makes GCM fragile does not
arise.

**And it turns out content encryption must be deterministic too.** Basalt's
protocol says a chunk name is the hash of the *encrypted* chunk, so that the
server can deduplicate without learning anything. If chunk encryption used a
random salt per chunk, as LiveSync's does, the same plaintext would encrypt
differently every time, every name would be new, and dedup would silently do
nothing at all. Content-defined chunking would still cut at the same boundaries
and every chunk would still be uploaded. That is a whole feature failing quietly,
which is this project's least favourite kind of bug, and reading the two sources
side by side is what surfaced it.

The honest cost, which belongs in the protocol's disclosure section: the server
can see when two chunks are byte-identical, within and across files. That is not
a leak we tolerate, it is the mechanism we asked for.

---

# Obsidian's headless client, and what it settles about structure

`obsidian-headless` on npm, version 0.0.14, published by the `obsidianmd` org.
Licensed UNLICENSED, so it was read the same way `app.js` was: for architecture
and interoperability, and nothing is copied.

It matters because it answers a question about Basalt's own structure that would
otherwise be guesswork: does a headless client share the sync engine with the
plugin, or is it a second implementation?

## It is one engine, not two

The engine's identifiers are all present in the headless bundle, in the same
forms they take in the desktop app: `synchash`, `previouspath`, `syncingPath`,
`fileRetry`, `skippedFiles`, `newServerFiles`, `perFileMax`,
`deterministicEncode`. Those are not names anyone arrives at twice.

So the same engine runs in both, and what changes underneath it is the platform:
in the app it drives Obsidian's Vault API, and headless it drives the
filesystem. That is the structure to copy, and it is the reason Basalt's
`client/src/core` exists.

One marker is absent, and it is interesting: `conflictAction` does not appear.
The desktop engine carries it as swappable policy defaulting to `"merge"`. Read
generously, a headless client has nobody to show a conflicted copy to.

## What it is built out of

| | |
|---|---|
| Runtime | Node 22 or newer |
| Dependencies | `better-sqlite3`, `commander`, and nothing else |
| Native code | prebuilt `btime` addons for five platforms |
| Size | one 216 KB bundled file |

Two things worth taking from that list.

**It keeps its index in SQLite**, with a schema of four tables that is almost
aggressively plain:

```
meta(key, value)
local_files(path, data)
server_files(path, data)
pending_files(uid, path, data)
```

`data` is a JSON blob per path rather than a column per field, which means the
entry shape can change without a migration. And `pending_files` is the inbound
queue *persisted*: the desktop engine keeps `newServerFiles` in memory and
rebuilds it from the server, and headless survives a restart with the work list
intact. Basalt's index should do the same, and the reason is rule 1 wearing
different clothes: a work list that only exists in memory is one a crash silently
shortens.

**It ships native addons to read file creation time.** Node's `stat` gives
`birthtime` unreliably across platforms, and they cared enough about `ctime` to
compile C for five targets. Basalt puts `ctime` on every entry too, and this is a
warning about how much it is worth: on any platform where the value is a guess,
so is anything decided from it. Nothing in Basalt's reconciliation reads `ctime`,
and after seeing this, nothing should start.

## Its command surface

```
login  logout
sync-list-remote  sync-list-local  sync-create-remote
sync-setup  sync  sync-config  sync-status  sync-unlink
publish-*
```

Plus a `--json` flag throughout. The shape is worth keeping: a one-time sync and
a continuous watch behind the same verb, status as its own command rather than
noise on every other one, and machine-readable output so the thing can be driven
from a script.

Basalt's version needs less. There are no accounts, so no `login`; one vault per
server, so no `sync-list-remote` or `sync-create-remote`; and pairing replaces
`sync-setup`. What is left is roughly `pair`, `sync`, `status`, `unlink`, which is
about the right size for a tool whose config is one string.

## What this means for Basalt's layout

```
client/src/core/      platform-free: crypto, chunk, merge, index-state, transport
client/src/obsidian/  the Vault API adapter and the plugin shell
client/src/node/      the filesystem adapter and the headless CLI
```

Everything written so far is already in `core` and already platform-free: sealing
uses WebCrypto, chunking is arithmetic, the merge is arithmetic plus
diff-match-patch, and the transport uses the platform's `WebSocket`, which Node
22 and every Obsidian target both provide. None of it had to be made portable;
it simply never reached for anything that was not.

What remains is the engine, which is policy and belongs in `core`, and two
adapters behind one interface: list, read, write, remove, rename, and watch. The
headless client is then not a second client. It is the same one with a different
adapter, which is exactly what Obsidian concluded.

# What running the plugin without Obsidian turned up

`main.ts` and `obsidian/vault.ts` were written and then not tested, because the
`obsidian` npm package is type declarations with no runtime: `"main": ""`.
Obsidian supplies the implementation when it loads a plugin, so the plugin's own
code could be compiled and never executed.

That is a reason it is hard to test, not a reason it is fine untested. The
arrangement now is:

- `src/obsidian/fake.ts` implements `DataAdapter`, and is declared
  `implements DataAdapter` against the real declarations, so the compiler
  rejects a method whose shape has drifted.
- `src/obsidian/stub.ts` is the runtime `obsidian` module: `Plugin`, `Modal`,
  `Setting`, `Notice`, an app and a vault.
- `vitest.config.ts` aliases `obsidian` to the stub **for tests only**.
  `tsconfig.json` has no such alias, so `tsc` still checks every call against
  `obsidian.d.ts`, and `esbuild.config.mjs` still marks it external so the
  shipped plugin gets Obsidian's own. Types from the declarations, behaviour
  from the stub.
- `src/build.test.ts` loads the built `dist/plugin/main.js`, hands it the stub,
  and pairs two of them against a real Go server. That tests the artifact rather
  than the source.

It found four bugs, none of which a unit test of the source would have shown.

## normalizePath is not a formatting function

Read out of `Obsidian.app/Contents/Resources/obsidian.asar`, where it is three
minified functions:

```js
Nl(e) = Dl(Bl(e)).normalize("NFC")
Bl(e) = e.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "") || "/"
Dl(e) = e.replace(/ | /g, " ")
```

Two of those steps change *which file you are talking about*. A non-breaking
space (U+00A0) or a narrow no-break space (U+202F) becomes an ordinary space,
and the result is NFC-normalized, which matters because macOS hands out
filenames in NFD.

The first version of the adapter called it on paths that had just come back from
`adapter.list`, and skipped anything whose `stat` then returned null. A note with
a non-breaking space in its name **disappeared from the listing entirely**. It
would never have synced and nothing would have said so, which is the exact shape
of failure this project exists to refuse.

The adapter now keeps one keyspace: everything the engine sees is normalized, and
where the adapter's own name for a file differs, that mapping is kept so reads
and writes still land on the real file.

## The config folder is not always `.obsidian`

`Vault.configDir` is documented as "typically `.obsidian` but it could be
different". The never-sync list hardcoded the usual name, so a vault with a
custom config folder would have uploaded the plugin's own folder, and that folder
holds `data.json`, and `data.json` holds the root secret.

The real name is now passed to `ObsidianVault` and there is no default, because a
default would be right almost always and catastrophic the rest of the time.

## `manifest.dir` is optional

`PluginManifest.dir` is `string | undefined`. Interpolating it produces the
literal path `undefined/index.json` at the vault root, which the never-sync list
has no reason to skip. The index would have synced, to itself, and every device
would have overwritten every other device's idea of what had been synced.

## Sync now did not mean now

The write debounce is Obsidian's, and it is right for a client that keeps
running. It also applied to the "Sync now" command, so a person who saved a
paragraph and immediately chose Sync now was told "up to date" while it sat
unsent. `Engine.sync` now takes a per-pass override and the command turns the
debounce off, on the grounds that the person has already said now.
