# Basalt client

The Obsidian plugin and the headless client are one sync engine with two
adapters: Obsidian's Vault API, or the filesystem. This directory holds both.
The headless client is what npm installs.

## The headless client

For a NAS, a server, or any machine without Obsidian. One file, no
dependencies, Node 22 or newer.

```bash
npm install -g basalt-sync
cd ~/vault
basalt pair basalt3i_...       # an invite from a device that has the vault
basalt sync --watch
```

Or, for the very first device on a new server, the line the server printed:

```bash
basalt init 'homelab:3003#K7M2PQR4-...'
basalt sync
```

If TLS is in front, put that hostname before the `#`. `init` claims the vault
with the server's one-time token, generates the root secret, and prints the
recovery key once. Write it down and keep it offline: it is the only way back
into the vault if every device is lost, and anyone who has it has the vault.
`--server URL --token TOKEN` still works if you would rather pass the two
halves.

To add a device, run `basalt invite` on a device that has the vault and paste
the `basalt3i_` string into `basalt pair` on the new one. An invite works once
and expires after `--ttl` (default 10m, at most 1h). It carries no secret of
its own: the new device uses it to fetch the vault's key from the server,
sealed under a key that never leaves the invite string. `basalt pair` also
accepts the recovery key, for a vault whose every device is lost.

### Commands

```
basalt init HOST:PORT#TOKEN               start a new vault, with the line the server printed
basalt invite [--ttl 10m]                 print a single-use invite for another device
basalt pair INVITE                        join a vault with an invite, or with its recovery key
basalt recovery-key                       reprint the recovery key, which is the vault itself
basalt rotate                             give the vault a new secret, keeping its history
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
| `--ignore NAME` | a folder or file name never to sync, matched at any depth, repeatable |
| `--uid N` | restore one exact version, from `basalt history` |
| `--to PATH` | restore somewhere other than where it came from |
| `--limit N` | how many versions `history` shows (default 20), or how many deletions `deleted` lists (default: all) |
| `-v`, `--verbose` | engine logging |

**Exit codes.** 0 worked. 1 failed, could not reach the server, finished with
files that can never sync, or is blocked by a name that is a file here and a
folder elsewhere. 2 the command line was wrong. A sync that gave up on a file
exits non-zero on purpose, so a broken vault in cron is heard about.

**Watching.** `sync --watch` reconnects with backoff when the connection drops,
and when the server says it is busy, at the device limit or shutting down, it
waits the time the server suggested and tries again. It stops only on a refusal
that would repeat word for word: a wrong key, a protocol mismatch, or a server
that has lost history this device already has. It also stops after three
identical failures applying the same batch, naming the cursor and the version,
so a poisoned entry is heard about rather than replayed forever.

`basalt rotate` gives the vault a new root secret and prints the new recovery
key; every other device is disconnected and is added again with `basalt
invite`. On a vault claimed under protocol 2 it says so and does nothing, since
for such a vault rotation is a new vault (see `docs/server.md`).

`basalt rebase` is for a server restored from an older backup, which refuses
this device with `cursor`. It prints both cursors and refuses without
`--backup-taken`; with it, it forgets the local index, rejoins from the server's
cursor, uploads what only this device holds as new versions, keeps both where
the two disagree, and deletes nothing.

`basalt status` prints the local cursor and the server cursor on separate
lines, and the ignore list. `--ignore` is local to this device; the plugin
ignores nothing beyond the dot rule and the config folder, so the list is there
to make a divergence visible.

### State

Everything lives in `.basalt/` inside the vault, which is never synced:
`config.json` holds the pairing and the root secret, mode 0600, and
`index.json` is what this device knows about every path. `unlink` removes both
and touches no notes.

### What is not synced

Any file or folder whose name starts with a dot, at any depth: `.basalt`,
`.trash`, `.git`, `.DS_Store`, `.gitignore`, all of them. Also `node_modules`,
and the config folder, `.obsidian` unless `--config-dir` says otherwise. The
plugin asks Obsidian which folder that is; the headless client has to be told.
The same rule applies in both directions, so a name this client would never
upload is one it will never write when a peer sends it.

`--ignore NAME` adds one more name, matched at any depth. One name per flag
rather than a comma-separated list, because a filename can contain a comma.

### Sync output

```
$ basalt sync
    3  uploaded
    1  downloaded
    1  kept both versions
    2  chunks sent, 1.4 KiB
Look for files with "Conflicted copy" in the name. Both versions are kept.
```

Counts are separate and never totalled. If a path is a file here and a folder
on another device, nothing can be written there and the output names it, since
that is the one refusal that only a rename clears.

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
Nothing is lost either way: the content is on the server under both names and
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
that Node 22 and every Obsidian target provide. A sync decision that appears
in either shell is in the wrong file.

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
it on a loopback port and talks to it with the real transport, then asks the
server's own `verify -deep` whether what it stored can be served.
`transport.test.ts` is the other half: a fake socket that says things a correct
server never would.

The benchmarks run under bun and the shipped CLI runs under node. Two of the
largest performance fixes were each invisible under one of the two, so anything
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
  and pairs two of them against a real Go server. It also checks the bundle
  contains no `node:` import, the regression that passes every test and fails
  only on a phone.

What this cannot tell you is whether Obsidian calls these methods when the
plugin expects, or draws what it builds. That is what the screenshots in
`docs/assets/screenshots/` are for.

### Building

`bun run build` produces `dist/basalt.mjs`, the CLI with everything bundled and
only `node:` builtins left as imports, and `dist/plugin/` with the three files
Obsidian loads. Both are minified in a release build. The two packages that end
up inside them, `diff-match-patch` and `fflate`, are pinned to exact versions.

The CLI is published to npm from CI on a `cli/vX.Y.Z` tag, over OIDC with no
stored token. The plugin is released on a bare `X.Y.Z` tag and its assets are
rebuilt and attested by `.github/workflows/attest.yml`.

### For plugin reviewers

The community directory's scanner flags the same things each run. Two were real
and are fixed: release assets are now rebuilt and attested in CI, and unused
code is caught by `noUnusedLocals`. The rest are correct readings of the
repository that do not apply to the plugin:

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

## More

- [Server](https://github.com/waynehoover/basalt-sync/blob/main/docs/server.md)
- [Plugin](https://github.com/waynehoover/basalt-sync/blob/main/docs/plugin.md)
- [Design](https://github.com/waynehoover/basalt-sync/blob/main/docs/design.md)
- [Protocol](https://github.com/waynehoover/basalt-sync/blob/main/docs/protocol.md)
