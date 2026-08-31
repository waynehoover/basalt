# Security

[Docs index](index.md)

What this protects, what it does not, and who has to be trusted for each. Every
number here was measured and every claim was checked against the code; where
something is untested it says so rather than rounding up.

## What the server can and cannot do

The server is the interesting adversary, because it is the one part of the
system that is not on a device you are holding.

**It cannot read anything.** Note contents and filenames are both sealed on the
device before they leave it. The server holds no key, is never sent one, and
nothing in it needs one. What it stores is ciphertext, and what it can tell
about that ciphertext is its length and that two chunks are byte-identical,
which is what deduplication is made of and is stated in `crypto.ts` rather than
buried.

**It cannot write anything either, since protocol 2.** Before that it could, and
this is worth spelling out because "end-to-end encrypted" is usually taken to
mean both and only meant the first. The bytes of a file were sealed; everything
deciding what a client *did* with them was not. `deleted`, `size`, `prev` and
the chunk list travelled in the clear, and the server holds every sealed path in
the vault, so it could name any file:

| It sent | And the device | Fixed by |
|---|---|---|
| `deleted: true` | deleted that note, everywhere | the entry authenticator |
| a size with no chunks | overwrote it with zero bytes, through `write`, so not even into the trash | the authenticator, and a client-side check of an invariant `docs/protocol.md` already assigned to the server |
| another file's chunk list | replaced its contents | the authenticator, and an assembled length that must equal the declared size |
| a substituted merge ancestor | dropped chosen paragraphs as "already deleted remotely", then uploaded the result | the authenticator, and checking the ancestor against `synchash`, which is local state a server cannot move |
| a lower cursor | reported "up to date" for ever | `refuseIfBehind` |
| no `perFileMax` or `maxChunks` | applied no bound at all, because missing read as unlimited | `OWN_LIMITS`, so missing means this device's ceiling |

**What it can still do is withhold.** A batch with an empty entry list over a
covered range is legitimate, because that is how a device sees its own write, so
a server can advance a client past versions it never shows it. Nothing detects
that today. It is a liveness attack rather than a silent corruption: no note is
altered, and a person notices when two devices disagree. Catching it needs a
global hash chain over the whole log, which was measured and deliberately not
built; the reasoning is under Performance below.

## The keys

One root secret, 160 random bits, generated on the first device and never sent
to the server. Everything else is derived from it with HKDF-SHA256, one key per
purpose so that a value sealed for one can never be mistaken for another:

| Key | Does |
|---|---|
| `auth` | proves a device may connect. The server stores only a hash of it |
| `path` | seals filenames |
| `content` | seals chunk bodies |
| `nonce` | derives synthetic nonces |
| `meta` | authenticates an entry: everything about a version except its bytes |

No password stretching, deliberately: the secret is random rather than
human-chosen, and a stretching function's job is to make guessing expensive when
there is something to guess. The HKDF salt is empty for the same reason, with
the info strings doing the domain separation.

## Deterministic sealing, and what it costs

Sealing is deterministic: the nonce is an HMAC of the plaintext rather than
random. This is unusual and it is load-bearing twice. Paths must compare equal
or the server cannot tell two versions of one file apart. Chunks must compare
equal or deduplication silently does nothing, since a chunk's name is the hash
of its ciphertext.

The concession is stated rather than hidden: **the server can see that two
chunks are byte-identical.** That is what dedup is.

The construction is SIV-shaped but is not AES-GCM-SIV, and the difference
matters for the failure mode. Real GCM-SIV derives a per-message key, so a nonce
collision leaks only that two messages are equal. Here one content key is used
with a 96-bit synthetic nonce, so a collision between distinct plaintexts would
be ordinary GCM nonce reuse: plaintext XOR, and GHASH key recovery. Safety rests
entirely on the birthday bound, at roughly 2^48 distinct chunks, which at a
256 KiB average is about 2^66 bytes and unreachable for any personal vault. It
is a bound rather than an impossibility, and it is written here as one.

## What a device can do to another device

Anyone holding the vault key is a device, as far as the protocol is concerned. A
leaked pairing string, or one compromised or merely buggy device, is inside the
trust boundary and the entry authenticator does not help: it holds the key.

What is enforced regardless:

- **A path a client would never upload is one it will never accept.** The
  never-sync set used to be an upload filter only, so a peer could write
  `.obsidian/plugins/<any>/main.js`, which Obsidian executes on the next reload
  in a renderer with Node integration. Both vaults now refuse those paths in
  both directions.
- **Containment is proved against the filesystem, not the string.** A symlinked
  folder inside a vault is ordinary, and every write used to follow it. Writes,
  directory creation and removal now resolve the deepest existing ancestor and
  require it inside the resolved root.
- **A path from the wire cannot climb out** with `..`, an absolute path, or by
  any lexical trick.

## Provenance

Every artifact a release hands you is rebuilt in CI from the tag and signed
against the repository and commit it came from:

    gh attestation verify main.js --repo waynehoover/basalt-sync
    gh attestation verify basaltd-linux-amd64 --repo waynehoover/basalt-sync

Rebuilding rather than signing what was uploaded is the point: an attestation
over a file of unknown origin certifies only that the workflow saw it. It works
because both builds are reproducible per commit, which was checked rather than
assumed. `scripts/release.sh` refuses to build from a tree with uncommitted
changes.

The npm package is published from CI over OIDC, with no token stored anywhere.

## Performance, since the answer shaped the design

The authenticator costs **2.2 microseconds per entry**, computed in parallel:
0.56 ms for a full 256-entry batch, 4 ms across a 2000-file first sync whose
upload takes about 167 seconds.

A globally chained variant was measured at **12.7 microseconds per entry** and
rejected, but not for its arithmetic: 25 ms against 167 seconds is nothing. It
was rejected for what a chain does to concurrent writers. A global head has to
be known at write time, so two devices writing at once serialise and each
conflict costs a round trip, 400 ms on a slow link against 3 ms of hashing.
Binding each entry to the version it was written on keeps the ordering per path,
which needs no global position and leaves concurrency alone. The cost is that
withholding stays undetected.

## Where TLS is

Not here. The server speaks plain HTTP and expects `tailscale serve`, a tunnel,
or a reverse proxy in front of it, which is why no key material lives in this
repository and why `basaltd serve -localhost` exists for trying it on one
machine.

## What is not claimed

- **Withholding is not detected.** See above.
- **iOS is untested.** The plugin is not desktop-only and the bundle contains no
  Node built-in, so it should work. A phone has synced a 320 file vault, and
  that phone was an Android.
- **A device holding the key is trusted.** There is no per-device revocation.
- **The server can always refuse to serve.** Availability is not a property
  anything here provides, and the answer to it is `basaltd backup`.
