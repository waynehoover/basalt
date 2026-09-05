# Basalt client

The Obsidian plugin and the headless client are one sync engine with two
adapters, Obsidian's Vault API or the filesystem. This directory holds both.
The headless client is what npm installs.

## The headless client

For a NAS, a server, or any machine without Obsidian. One file, no
dependencies, Node 22 or newer.

```bash
npm install -g basalt-sync
cd ~/vault
basalt pair basalt3i_...       # an invite, from basalt invite on a device that has the vault
basalt sync --watch
```

Or, for the first device on a new server, the line the server printed:

```bash
basalt init 'homelab:3003#K7M2PQR4-...'
basalt sync
```

If TLS is in front, put that hostname before the `#`. `init` claims the vault
with the server's one-time token, generates the root secret, and prints the
recovery key once. Write it down and keep it offline: it is the only way back
in if every device is lost, and anyone who has it has the vault.
`--server URL --token TOKEN` also works.

To add a device, run `basalt invite` on one that already has the vault and
paste what it prints into `basalt pair` on the new one. An invite works once,
lasts ten minutes, and carries no root secret: it hands over the vault's data
key and registers the new device a credential of its own, which `basalt revoke`
can cut off without touching any other device.

The recovery key also works in `basalt pair`, for when no device is left to
invite from. Deliberately not the ordinary way in: it is written down and
offline, and adding a phone should not mean going to get it. Either way the new
device keeps only a credential of its own, neither the invite nor the key.

A config holding the recovery key and no device credential is not a device this
client can use, and every command refuses it rather than guessing. `basalt
init` leaves one when the claim goes through and the registration after it does
not. The refusal prints the recovery key out of the config, since that copy may
be the only one, and names the way back: `basalt unlink`, then `basalt pair`
with that key. `basalt status` calls such a vault neither reachable nor
refused, since nothing was asked of the server.

### Commands

```
basalt init HOST:PORT#TOKEN               start a new vault, with the line the server printed
basalt invite [--ttl 10m]                 print a single-use invite for another device
basalt uninvite ID                        cancel an outstanding invite, from basalt devices
basalt pair INVITE                        add this device to a vault, with an invite or its
                                          recovery key
basalt devices                            every device that may reach this vault
basalt revoke ID                          stop one device connecting, from basalt devices
basalt rotate RECOVERY-KEY                give the vault a new secret, keeping its history
basalt rebase --backup-taken              rejoin a server restored from an older backup
basalt sync                               sync once and exit
basalt sync --watch                       sync, then keep syncing
basalt status                             what this device thinks the state is
basalt deleted                            notes the server has and this vault does not
basalt history PATH                       every version of one note, newest first
basalt restore PATH                       put a note back
basalt unlink                             forget the pairing, keep the notes
basalt --version                          which release this is
```

| Option | |
|---|---|
| `--dir DIR` | the vault (default: the current directory) |
| `--device NAME` | this device's name (default: the hostname plus four random characters, chosen once at pairing) |
| `--vault-id ID` | which vault on the server (default `default`) |
| `--json` | machine-readable output, on every command |
| `--timeout MS` | how long to wait on the server (default 30000) |
| `--config-dir DIR` | Obsidian's config folder, if it is not `.obsidian` |
| `--ignore NAME` | a folder or file name never to sync, matched at any depth, repeatable; local to this device |
| `--uid N` | restore one exact version, from `basalt history` |
| `--to PATH` | restore somewhere other than where it came from |
| `--limit N` | how many versions `history` shows (default 20), or how many deletions `deleted` lists (default: all) |
| `--allow-last` | revoke the last device, leaving the vault reachable only by its recovery key. Needs `--recovery-key` |
| `--recovery-key K` | run `devices`, `revoke` or `uninvite` with the vault's recovery key rather than this device's own credential; any other command refuses it |
| `--` | everything after it is a word rather than an option, for a device id that begins with `-` |
| `-v`, `--verbose` | engine logging |

**Exit codes.** 0 worked. 1 failed, could not reach the server, finished with
files that can never sync, or is blocked by a name that is a file here and a
folder elsewhere. 2 the command line was wrong. A sync that gave up on a file
exits non-zero on purpose, so a broken vault in cron is heard about. Files this
device ignores are reported as ignored and exit 0.

`basalt devices` lists every device that may reach this vault: its id, its
name, when it was added and when it was last seen. The name is not an identity
and two laptops may both be called laptop; the id is, and it is what `basalt
revoke` takes.

**Watching.** `sync --watch` reconnects with backoff when the connection drops,
and when the server says it is busy, at the device limit or shutting down, it
waits the time the server suggested. It stops only on a refusal that would
repeat word for word: a wrong key, a protocol mismatch, or a server that has
lost history this device already has. It also stops after three identical
failures applying the same batch, naming the cursor and the version, so a
poisoned entry is heard about rather than replayed forever.

A row whose last seen says **never connected** is one nothing has ever signed
in under: the registration commits before the new device saves anything, so a
pairing that crashed after reaching the server strands a row, and so does a
`basalt init` whose claim went through. Those rows still hold one of the eight
slots, so a failed pairing names the row to revoke rather than sending you back
to pairing, which would register a second.

`basalt revoke ID` removes that device's row and closes any connection it has
open, in that order, so it stops at once rather than at its next reconnect. Any
device may revoke any other, or itself: cutting off a stolen laptop should not
need the recovery key out of its drawer.

Revoking the vault's **last** device does need it:

```bash
basalt revoke ID --allow-last --recovery-key basalt3_...
```

That is the one revocation nothing on a device can undo, since what it leaves
is a vault only the recovery key opens, and it costs nothing in the case it is
for: a device stolen when it was the only one wants `basalt rotate` too, which
needs the key anyway. `--recovery-key` also works in a directory that was never
paired, which is the way back into a vault whose eight rows are all crashed
pairings, since nothing can register while it is full.

**Revoking stops a device connecting. It does not unread what that device
already read**: it still holds the vault's key for every note it had synced. A
device stolen rather than merely lost wants `basalt rotate` as well.

`basalt devices` also lists the invites nobody has redeemed yet, by identifier
and expiry, and `basalt uninvite ID` cancels one. Until they were listed, an
invite was the one authority on a vault nothing could see, and the only ways to
retire one were to wait out its hour or to rotate, which retires the recovery
key too. The identifier alone redeems nothing: that also takes the invite key,
which never reaches the server and exists only in the string that was printed.

`basalt rotate RECOVERY-KEY` gives the vault a new root secret and prints the
new one. It takes the old key on the command line because no device holds one:
a device that could rotate could also register itself again after being
revoked. History survives, because the content is sealed under a data key the
root only wraps, so a new root re-wraps the same key and nothing is
re-encrypted. **No device row is touched and every device keeps syncing across
it.**

The new key is printed before the request goes out, because there is nowhere on
a device to keep a root. If the reply is lost, `rotate` asks the server which
secret it has and says which key to keep; if somebody rotated first, it says so
by name and says to cross the printed key out.

`basalt rebase` is for a server restored from an older backup, which refuses
this device with `cursor`. It prints both cursors and refuses without
`--backup-taken`; with it, it forgets the local index, rejoins from the
server's cursor, uploads what only this device holds as new versions, keeps
both where the two disagree, and deletes nothing.

`basalt status` prints the local cursor and the server cursor on separate
lines, and the ignore list. `--ignore` is local to this device, and the plugin
ignores nothing beyond the dot rule and the config folder, so the list is there
to make a divergence visible.

### State

Everything lives in `.basalt/` inside the vault, which is never synced.
`config.json`, mode 0600, holds this device's id, the secret it connects with
and the vault's data key; `index.json` plus `index.log` are what this device
knows about every path. Not the root secret, which no device holds: it goes
there only while `basalt init` is starting a vault, since a secret that claimed
a server without reaching the disk first is a vault nobody can open, and this
device's own credential replaces it the moment there is one.

The index is a snapshot plus a journal of what has changed since, so an
ordinary pass appends a few hundred bytes rather than rewriting the whole file,
and the log is folded back in once it has grown against the snapshot. Losing
its tail loses no note, because notes are made durable before the index that
names them and the engine redoes the pass. `unlink` removes all three files and
touches no notes.

One process at a time, enforced by the lock in `.basalt/lock` for every command
that writes. If something else writes the index anyway, the next save says so
on stderr and replaces both files with a fresh snapshot rather than appending
this device's changes onto somebody else's.

### Filenames

Paths travel in NFC, whatever the disk spells them in. A Mac stores `café.md`
with a combining accent (NFD) and every other platform with a precomposed one
(NFC); the two are one name, and the plugin has always normalised. The headless
client used to hand out the disk's bytes, so two devices that each created that
note reported one file `in the way` of the other on every pass for ever, naming
two strings nobody can tell apart.

NFC is the whole keyspace, in both directions: a path arriving in some other
normal form is the same path, filed under its NFC name, not a second note.

A vault synced by an older headless client on a Mac holds those paths under the
NFD spelling on the server, and the first device to meet one sends a rename:
content and history kept, the NFC name carrying the old one as the name it used
to have, nothing already on the server re-sent. One entry per name, once;
earlier versions stay under the old spelling in `basalt history`.

The disk is owed the same rename, or a Mac stays the only device holding the
spelling it invented. A name spelled on disk other than the way this client
reports it is renamed the first time the vault is listed: one `rename`, no
content copied, nothing to finish if interrupted. A read-only vault, or one
whose filesystem imposes a normal form of its own, keeps its spelling and syncs
as it always did.

Upgrade every device. A client older than this rule goes on spelling its
accented names in NFD, so it re-creates the old spelling after every rename and
the two names keep arriving. Nothing is lost while that lasts, and nothing
settles either.

A disk that keeps the two spellings apart can hold both files, and only a
person can say which was meant. That one name is blocked, both files are left
as they are, the rest of the vault carries on, and `basalt sync` counts it and
exits non-zero. Refusing the whole vault is what this used to do, over one pair
nobody could name.

A folder two names claim blocks everything under it, by the same count. Nothing
under such a name is uploaded, downloaded or reported deleted: a listing that
stopped naming a note must not become a deletion that travels to every device.

The differing characters are spelled out, because the two names print
identically:

    "cafe\u{301}.md" and "caf\u{e9}.md" are one name here, and only one of them can sync.

### What is not synced

Any file or folder whose name starts with a dot, at any depth: `.basalt`,
`.trash`, `.git`, `.DS_Store`, `.gitignore`, all of them. Also `node_modules`,
and the config folder, `.obsidian` unless `--config-dir` says otherwise. The
plugin asks Obsidian which folder that is; the headless client has to be told.
The rule applies in both directions, so a name this client would never upload
is one it will never write when a peer sends it.

Pointing `--config-dir` at some other folder makes `.obsidian` ordinary
content on this device, which is the one way to sync it. It also makes this
device disagree with the plugin, which keeps refusing that folder, so the files
travel to the server and no plugin device writes them. Left working on purpose,
but a flag to type deliberately rather than a supported arrangement.

`--ignore NAME` adds one more name, matched at any depth. One name per flag
rather than a comma-separated list, because a filename can contain a comma. It
is local to this device.

A path another device syncs and this one ignores is counted and printed on its
own line, and does not change the exit code: refusing it is the configuration
doing what it was told, and counting it as a failure made every later sync of
that vault exit 1 for ever. A path that cannot work here, a name that is a file
on this device and a folder on another, still does.

### Sync output

```
$ basalt sync
    3  uploaded
    1  downloaded
    1  kept both versions
    1  ignored here, and synced by another device
    2  chunks sent, 1.4 KiB
Look for files with "Conflicted copy" in the name. Both versions are kept.
```

Counts are separate and never totalled. If a path is a file here and a folder
on another device, nothing can be written there and the output names it: that
is the one refusal only a rename clears.

### Recovery

```bash
basalt deleted                            what the server has and this vault does not
basalt history "Quarterly plan.md"        every version, newest first
basalt restore "Quarterly plan.md"        the newest version with content
basalt restore "Q.md" --uid 42            one exact version
basalt restore "Q.md" --to old/Q.md       somewhere else
```

Restoring never overwrites. If the path is occupied the copy lands beside it as
`Q (restored 42).md`. The restored note is sent to the server right away.

**Renames become deletions here.** A filesystem scan cannot tell a rename from
a delete plus a create, so the old path is recorded as deleted and appears in
`basalt deleted`. The plugin gets Obsidian's rename event and sends a rename.
Nothing is lost either way: the content is on the server under both names, and
the second cost no upload.

## Layout

```
src/core/     platform-free: crypto, chunking, merging, the index, the transport, the engine
src/plugin/   the Obsidian plugin and its Vault API adapter
src/cli/      the headless client and its filesystem adapter
src/stress/   the hostile suite: kills, collisions, awkward names, scale
```

`core` is the whole client except for where files live. Sealing uses WebCrypto,
chunking and merging are arithmetic, and the transport uses the `WebSocket`
Node 22 and every Obsidian target provide. A sync decision that appears in
either shell is in the wrong file.

## Working on it

```bash
bun install
bun run test         # everything, including against a real Go server
bun run typecheck
bun run format       # prettier; CI fails on anything it would change
bun run stress       # the hostile suite, its own CI job
bun run scale        # what 10,000 notes cost
bun run dedup        # what deduplication saves across versions
bun run bench        # chunking, sealing, bytes on the wire
bun run bench:sync   # a whole vault, timed and checked
bun run build        # dist/basalt.mjs and dist/plugin/
```

The tests need a Go toolchain. `server-harness.test.ts` builds `basaltd`, runs
it on a loopback port, talks to it with the real transport, then asks the
server's own `verify -deep` whether what it stored can be served.
`transport.test.ts` is the other half: a fake socket that says things a correct
server never would.

The benchmarks run under bun and the shipped CLI under node. Two of the largest
performance fixes were each invisible under one of the two, so anything
measuring the chunker should run under both.

### Testing the plugin without Obsidian

The `obsidian` package is type declarations with no runtime, so the plugin
would otherwise compile and never run in a test.

- `src/plugin/fake.ts` implements `DataAdapter` against the real declarations,
  so the compiler catches drift. Its `normalizePath` matches the shipped app.
- `src/plugin/stub.ts` is a runtime `obsidian` module. `vitest.config.ts`
  aliases to it for tests only. `tsc` checks against the genuine declarations
  and the build marks `obsidian` external.
- `src/build.test.ts` loads the built `dist/plugin/main.js`, hands it the stub,
  and pairs two of them against a real Go server. It also checks the bundle for
  `node:` imports, the regression that passes every test and fails only on a
  phone.

What none of it can tell you is whether Obsidian calls these methods when the
plugin expects, or draws what it builds. That is what the screenshots in
`docs/assets/screenshots/` are for.

### Building

`bun run build` produces `dist/basalt.mjs`, the CLI with everything bundled and
only `node:` builtins left as imports, and `dist/plugin/` with the three files
Obsidian loads. Both are minified in a release build. The two packages inside
them, `diff-match-patch` and `fflate`, are pinned to exact versions.

The CLI is published to npm from CI on a `cli/vX.Y.Z` tag, over OIDC with no
stored token. The plugin is released on a bare `X.Y.Z` tag, its assets rebuilt
and attested by `.github/workflows/attest.yml`.

### For plugin reviewers

The community directory's scanner flags the same things each run. Two were real
and are fixed: release assets are rebuilt and attested in CI, and unused code
is caught by `noUnusedLocals`. The rest are correct readings of the repository
that do not apply to the plugin:

- **Node built-in imports** are all in `src/cli/` or `core/test-server.ts`. The
  shipped `dist/plugin/main.js` contains no `node:` reference, and a test
  checks that.
- **`no-unsafe-*` warnings** come from linting without the `obsidian` types
  resolved. With them installed, `tsc` under `strict` reports nothing.
- **`setTimeout` rather than `window.setTimeout`** because the timers are in
  `core/`, which the CLI also runs, and `window` does not exist in the test
  environment.
- **`globalThis`** for the same reason: `crypto.subtle` has to be found in both
  a renderer and Node.
- **`fetch` rather than `requestUrl`** is used only on `app://` resource URLs
  for files already on the device, with a `Range` header, which is what lets a
  large attachment stream instead of being read whole.
- **`.obsidian` as a literal** appears only in the headless client, which has no
  `Vault` to ask, and in test doubles.
- **One `console` call**, in the engine's failure path. A note that fails to
  send is exactly the silent failure this project exists to avoid.
- **Vault enumeration.** It is a sync engine. It cannot sync a vault it is not
  allowed to list.

## More

- [Server](https://github.com/waynehoover/basalt-sync/blob/main/docs/server.md)
- [Plugin](https://github.com/waynehoover/basalt-sync/blob/main/docs/plugin.md)
- [Design](https://github.com/waynehoover/basalt-sync/blob/main/docs/design.md)
- [Protocol](https://github.com/waynehoover/basalt-sync/blob/main/docs/protocol.md)
