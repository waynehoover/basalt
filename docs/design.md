# Design

[Back to the README](../README.md)

Why Basalt is built the way it is: the rules it will not break, what it refuses
to do, and what it does and does not protect against.

**Minimal, opinionated, fast, self-hosted.** In that order when they conflict,
except that nothing outranks not losing a note. Every question with a right
answer is answered once, in the source, which is why there is no settings
screen. Fast follows, because the cheapest thing a sync client can do with a
byte is not send it. Self-hosted is what makes the rest possible: one backend,
one transport, one person's devices.

When simplicity and correctness conflict, correctness wins and the feature gets
cut.

## The durability rules

Each of these came from something going wrong. The incident stays next to the
rule because a rule without its story gets softened later. Code comments cite
them by number.

1. **Acknowledge only after the write is durable.** The ack for a push waits
   until the chunk bodies and the entry are both committed. An early ack is a
   "stored" that a crash can turn into a lie.

2. **A failed read is not an empty result.** Code that read a config file,
   fell back to an empty list on error, and wrote it back disabled every plugin
   on a device. Absent and unreadable are different states. Unreadable aborts.

3. **Never delete until a verified copy exists elsewhere.** Copy, checksum both
   ends, then delete.

4. **Verify the outcome, not the exit code.** `adb push` returned 0 after
   writing one file of four. Read back what you wrote.

5. **Never write a result smaller than its input without proving that is
   right.** A merge, prune or rewrite that shrinks a list is a bug until shown
   otherwise. Refuse it and say why.

6. **Deletions are entries, not absences.** A deleted file leaves a record.
   That is what makes it recoverable, and why a vault whose files were all
   deleted is not an empty vault.

7. **A status describes the vault, not the filter.** "Fully synced" has twice
   meant something else: once at cursor 0 with 4,030 local files, once with 13
   files excluded by type. A status that cannot tell "everything is here" from
   "everything I looked at is here" is not a status.

8. **Trust the numbers, not the passes.** Most real bugs here were caught by an
   implausible figure, not a failing assertion. An impossible throughput number
   revealed that two "devices" were the same vault.

9. **A fix without a test that failed first is not finished.** Revert the fix,
   watch the test fail, restore it.

10. **Assertions must check the property that matters.** A conflict test
    asserted that two devices agreed. It passed while one side's edit had
    vanished. Agreement is not the property. Not losing an edit is.

## Conflicts: keep both

Obsidian Sync and LiveSync both merge with diff-match-patch. Obsidian discards
the array saying which hunks landed, so a hunk that does not apply is silently
dropped. Basalt uses the same library and abandons the merge if any hunk fails.
It also adds the check the library lacks: it compares which spans each side
changed and refuses before applying anything if they overlap. Two devices
rewriting one sentence differently would otherwise "apply" cleanly and produce
a sentence neither wrote. Two additions at the same point on a line boundary are
allowed, because that is two devices adding to one daily note.

When both versions are kept, the incoming one takes the conflict name. Obsidian
puts the local one there and overwrites the file you have open. A sync you did
not ask for should never rewrite the file you are editing.

## Fast, because it sends less

Notes are chunked on a rolling hash and only the chunks the server lacks are
sent. One line inserted into a 2 MiB note costs about 22 KB, most of it the
entry naming the new version's chunks. Chunks are compressed after chunking and
before encryption, which takes a vault's text to well under what the plaintext
would have cost. That order is forced: compressing first would move every
boundary on any edit, and ciphertext does not compress.

Every size and threshold came from a measurement on a real vault, and the
figures live in [compared.md](compared.md) with the corpus each was taken on,
rather than being restated here, so there is one place to correct when they are
measured again.

## Simplicity

Every option is something to explain, to get wrong, and to leave untested in
combination. So: the first device enters a server address and a token, every
device after pastes one string, and the panel has status and actions but no
configuration.

A setting earns its place only by surviving three questions. Can another device
tell us? Then it travels in the pairing string. Is there a right answer? Then it
is chosen once in the source. Is it only relevant when something specific
happens? Then it appears in that moment, like the `-allow-origin` hint inside
the error that needs it.

Six more rules: every option must justify its existence; inherit Obsidian's
judgement except where it trades away a note; fail loudly and never report
success you have not verified; the server is an opaque blob store and stays one;
verify against the artifact, never infer; everything is reversible.

## Refusals

No second backend. No peer-to-peer. No teams or shared vaults. No settings
screen. No web UI on the server, because anything it could show you it would
have to read. No merge algorithm of our own. No silent conflict resolution.

## The open one: plugins, themes and config

Obsidian Sync syncs the config folder. Basalt syncs none of it, and unlike the
refusals above this is not settled.

The reason is mechanical. Obsidian holds the config folder in memory and writes
it back, so a file changed underneath the running app is overwritten rather
than read. A config change from another device would land and be undone.
Beyond that: rule 2 came from exactly this bug; a broken config reaches every
device including the one that still worked, where a note conflict is two
visible files; the pairing secret lives in that folder; and `workspace.json` is
rewritten whenever a pane moves.

Snippets and themes are inert, so a slice limited to those is the one worth
building first. Until then the rule is simple and the same on every device:
the config folder, and any file or folder whose name starts with a dot, never
syncs in either direction. Obsidian's own index does not list dot-prefixed
paths, so a client that accepted one from a peer would write it, fail to see
it, and report it deleted. One rule in one place is what keeps the two
clients from disagreeing about what a vault contains.

## Notes first, and what that costs attachments

Somebody writing prose is the case every decision is made for. Attachments are
supported and not optimised for: chunk sizes were tuned against Markdown,
deduplication does nothing for two photographs, and a large file costs the
sender memory a note never does. So the default file limit is 64 MiB rather
than the 256 MiB the format allows, and `basaltd serve -max-file` raises it. A
vault that is mostly video wants a file sync.

## Who this is wrong for

Anyone who needs a vault shared with other people, sync without running
anything, storage they already pay for, or a vault that is mostly large binary
files. [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)
does all of that and is a better answer.

---

## What the server can and cannot do

The server is the interesting adversary. It is the one part of the system not
on a device you are holding.

**It cannot read anything.** Note contents and filenames are sealed on the
device. The server holds no key and nothing in it needs one. What it can tell
about the ciphertext is its length, and that two chunks are byte-identical,
which is what deduplication is made of.

**It cannot write anything either.** An early draft sealed the bytes of a file
and left the fields deciding what a client did with them in the clear. The
server holds every sealed path, so it could have set `deleted` on one and every
device would have deleted that note, or emptied a note by declaring a size with
no chunks, or handed one file another's chunk list. Every entry carries an HMAC
under a key the server never sees, and a device refuses an entry it cannot
verify. Clients also check what the server used to be trusted with: an
assembled file must match its declared size, the merge ancestor must match the
local `synchash`, a cursor never moves backwards, and a missing limit means this
device's own ceiling rather than no ceiling.

Recovery is held to the same standard. Every entry that history, the deleted
list or a `get` returns is checked against its authenticator before anything is
assembled, and a restore fetches exactly the chunk list the writer signed, so a
server cannot point a restore at another file's content.

**What it can still do is withhold.** A server can advance a client past
versions it never shows it, because an empty batch over a covered range is also
how a device sees its own write. Nothing detects that. It is a liveness attack
rather than a corruption: no note is altered, and a person notices when two
devices disagree. Detecting it needs a hash chain over the whole log, which was
measured and rejected because a global chain forces concurrent writers to
serialise, one round trip per collision.

### What a stranger on the port learns

Behind `tailscale serve` the port is private. Behind Caddy it is on the
internet, and an unauthenticated request can reach exactly three things: `GET
/health`, one hello frame before the server decides whether to keep talking,
and the `426` that every other path and method gets, which says `basalt speaks
websocket only`. None of them says which release is running. `/health` answers
`ok` and nothing else, the `426` names no version and sends no `Server` header,
and a hello refused for its protocol or crypto names the range the server
speaks and not its version. The version is in `ready`, which only a device
holding the vault's auth key receives, and in `basaltd version` on the machine
itself. A version string is where targeted probing starts, and the operator has
better ways to learn it than the network does.

That is a property rather than three careful strings, and it is tested as one:
a sentinel version is stamped on the server and every pre-auth response,
headers included, is checked for it.

What a stranger can still learn is that a Basalt server is here and which
protocol it speaks, because the refusal has to name the numbers for an old
client to know which end to upgrade, and that the port is up, because a
healthcheck has to say so.

## The keys

One root secret, 256 random bits, generated on the first device. Everything
else is derived with HKDF-SHA256, one key per purpose: `auth` to prove a device
may connect, of which the server stores only a hash; `path` for filenames;
`content` for chunk bodies; `nonce` for synthetic nonces; `meta` for the entry
authenticator. No password stretching, because the secret is random rather than
chosen. [protocol.md](protocol.md#crypto) has the construction.

Sealing is deterministic: the nonce is an HMAC of the plaintext. Equal paths
must seal equal or the server cannot group versions of a file, and equal chunks
must seal equal or deduplication silently does nothing. The cost is stated: the
server can see that two chunks are identical. The construction is SIV-shaped but
not AES-GCM-SIV, so a nonce collision between distinct plaintexts would be
ordinary GCM nonce reuse. Safety rests on the birthday bound at about 2^48
distinct chunks, roughly 2^66 bytes, which is unreachable for a personal vault
and is a bound rather than an impossibility.

## What a device can do to another device

Anyone holding the root secret is a device. A leaked pairing string or a buggy
device is inside the trust boundary. What is enforced regardless: a path a
client would never upload is one it will never accept, so a peer cannot write
`.obsidian/plugins/<any>/main.js`; containment is checked against the resolved
filesystem, so a symlink inside the vault cannot lead a write out; and a path
from the wire cannot climb out with `..` or an absolute path.

## A lost or stolen device

There is no per-device revocation. Every device holds the same root secret, and
that secret is also the credential, which is what makes a pairing string one
string. What you can do is rotate the secret. The vault's content is sealed
under a data key that the root secret only wraps, so `basalt rotate` gives the
vault a new root, re-wraps the same data key, and swaps the server's auth hash.
The old string stops working, history stays, and every other device pairs again
with the new string. The steps are in
[server.md](server.md#rotating-the-vault-secret).

Rotation does not unread what was already read. Whoever held the old string
could decrypt everything the server held while they had it. Do it anyway if a
pairing string has been in a chat, a screenshot, a shell history, a repository,
or on a device you no longer hold.

## Provenance

Every release asset is rebuilt in CI from the tag and attested against the
repository and commit:

```bash
gh attestation verify main.js --repo waynehoover/basalt-sync
gh attestation verify basaltd-linux-amd64 --repo waynehoover/basalt-sync
```

Both builds are reproducible per commit. The lockfile is committed, the two
packages inside the bundles are pinned to exact versions, and the npm package is
published from CI over OIDC with no stored token.

## What is not claimed

- Withholding is not detected.
- iOS is untested. It should work; the phone that has synced a vault was an
  Android.
- A device holding the key is trusted.
- Availability. The server can always refuse to serve. The answer is
  `basaltd backup`.
- TLS. The server speaks plain HTTP and expects `tailscale serve` or a proxy in
  front. No key material lives in this repository.
