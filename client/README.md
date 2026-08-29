# Basalt client

[Docs index](../docs/index.md)

One sync engine, two things to run it: the Obsidian plugin and a headless client.

```
src/core/       platform-free. crypto, chunking, merging, the index, the transport
src/obsidian/   the Vault API adapter and the plugin shell
src/node/       the filesystem adapter and the headless CLI
```

`core` is the whole client except the parts that have to know where files live.
Sealing uses WebCrypto, chunking and merging are arithmetic, and the transport
uses the `WebSocket` that Node 22 and every Obsidian target both provide. So the
headless client is not a second client, it is the same one with a different
adapter, which is how Obsidian's own `obsidian-headless` is built.

Any sync decision that appears in a shell is in the wrong file.

## Working on it

```
bun install
bun run test         # everything, including against a real server
bun run typecheck
bun run bench        # throughput and bandwidth, reported not asserted
bun run bench:sync   # a whole vault, timed and checked
```

The tests need a Go toolchain. `src/core/server-harness.test.ts` builds
`cmd/basalt`, runs it on a loopback port, and talks to it with the real
transport. Nothing is mocked, and its assertions are checked by asking the
server's own `verify -deep` whether what it stored can be served.
`src/core/transport.test.ts` is the other half: a fake socket that says things a
correct server never would.

## The headless client

`bun run build` produces `dist/basalt.mjs`, one file with nothing to install
beside it.

```
basalt init --server wss://host --token TOKEN   # the first device
basalt pair basalt2_...                          # every other device
basalt sync                                      # once, and exit
basalt sync --watch                              # and keep going
basalt status
basalt invite                                    # reprint the pairing string
basalt unlink                                    # forget the pairing, keep the notes
```

`--dir` chooses the vault, defaulting to the current directory. `--json` on any
command gives machine-readable output. State lives in `.basalt/` inside the
vault, which is never synced: `config.json` (0600, holds the root secret) and
`index.json`.

`cli.ts` takes an argv and two output functions and returns an exit code, so
`cli.test.ts` drives the whole client against a real server with no subprocess.
`bin.ts` is the six lines connecting that to a terminal, and the only part no
test covers.

**Exit codes.** `0` worked. `1` failed, or finished with files that can never
sync, or could not reach the server. `2` the command line was wrong. A sync that
skipped a file for good exits non-zero on purpose: a broken vault that exits zero
is a broken vault nobody hears about.

## The plugin

`src/obsidian/main.ts` does the same job and then draws a status bar. No settings
tab, on purpose; one modal, which pairs a vault and says what is happening.

```
bun run build
cp -r dist/plugin /path/to/vault/.obsidian/plugins/basalt
```

Then enable it in the community plugins list. Config lives in the plugin's own
`data.json`. The root secret is in there in the clear, which is the same exposure
as the headless client's `config.json` and is inherent: the device has to decrypt
the vault without asking anybody.

### Tested without Obsidian

The `obsidian` package is type declarations with no runtime (`"main": ""`), so
`main.ts` and `obsidian/vault.ts` would otherwise compile and never run.

- `src/obsidian/fake.ts` implements `DataAdapter`, declared against the real
  declarations so the compiler catches drift. Its `normalizePath` matches what
  the shipped app does, which was read rather than assumed.
- `src/obsidian/stub.ts` is the runtime `obsidian` module. `vitest.config.ts`
  aliases to it **for tests only**: `tsconfig.json` does not, so `tsc` checks
  against the genuine declarations, and `esbuild.config.mjs` marks it external so
  the shipped plugin gets Obsidian's.
- `src/build.test.ts` loads the built `dist/plugin/main.js`, hands it the stub,
  and pairs two of them against a real Go server. It also checks the bundle needs
  nothing but `obsidian` and contains no `node:` import, the regression that
  would otherwise pass every test and fail only on a phone.

Deliberate breakages of the plugin and its adapter are all caught. What this
cannot tell you is whether Obsidian calls these methods when the plugin expects,
or draws what it builds.

## Recovery

The server has kept every version and every deletion since the first commit.

```
basalt deleted                       what the server has and this vault does not
basalt history "Quarterly plan.md"   every version, newest first
basalt restore "Quarterly plan.md"   the newest version with content
basalt restore "Q.md" --uid 42       one exact version
basalt restore "Q.md" --to old/Q.md  somewhere else
```

In the plugin there are two ways in. Right-click a note for "Basalt: version
history", or the "Show version history" command, which opens a sidebar of every
version newest first with a diff against what is on disk. Deleted notes have
their own command, "Recover a deleted note", because a note that is gone cannot
be right-clicked. Both are also registered as `basalt:history` and
`basalt:restore` on Obsidian's own command line, next to its `sync:history`.

Restoring never overwrites: if the path is occupied the copy lands beside it
under `(restored N)` and says so. A restored note keeps the timestamp it was
written with, so a note from March does not sort to the top. And restoring is not
a server operation. The client fetches the version with an ordinary `get`,
writes it, and the ordinary sync sends it on, so the server keeps one way to
change a vault.

### Renames become deletions, headless only

A filesystem scan cannot tell a rename from a delete plus a create. Obsidian can,
and its rename event carries the old path, so the plugin sends the rename as one
operation and it stays out of the deleted list. The headless client reports what
it saw. Nothing is lost either way: the content is on the server under both
names, and deduplication means the second name cost nothing.
