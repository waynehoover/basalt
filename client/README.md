# Basalt client

One sync engine, two things to run it: the Obsidian plugin and a headless client.

```
src/core/       platform-free. crypto, chunking, merging, the index, the transport
src/obsidian/   the Vault API adapter and the plugin shell
src/node/       the filesystem adapter and the headless CLI
```

`core` is the whole client except for the parts that have to know where files
live. It never reaches for a platform: sealing uses WebCrypto, chunking and
merging are arithmetic, and the transport uses the `WebSocket` that Node 22 and
every Obsidian target both provide. So the headless client is not a second
client, it is the same one with a different adapter.

That structure is not a guess. Obsidian ships `obsidian-headless` and it is the
same engine as the desktop app with the Vault API swapped out;
`docs/client-design.md` records how that was established and what else the
headless client is built from.

## Working on it

```
bun install
bun run test         # everything, including against a real server
bun run typecheck
bun run bench        # throughput and bandwidth, reported not asserted
bun run bench ~/vault
```

The tests need a Go toolchain. `src/core/server-harness.test.ts` builds
`cmd/basalt`, runs it on a loopback port with a temporary data directory, and
talks to it with the real transport. Nothing there is mocked, and its assertions
are checked by asking the server's own `verify -deep` whether what it stored can
be served.

`src/core/transport.test.ts` is the other half of the same subject: a fake socket
that says things a correct server never would. The integration tests prove the
two implementations agree about the wire; these prove the client survives one
that does not.

## What is here and what is not

| | |
|---|---|
| `core/crypto.ts` | key schedule, deterministic sealing, chunk names |
| `core/chunk.ts` | Rabin-Karp content-defined chunking, streaming |
| `core/merge.ts` | three-way merge, and four checks the shipped one does not make |
| `core/index-state.ts` | the local index and the reconciliation decision |
| `core/transport.ts` | the wire, and reconnect pacing |
| `core/engine.ts` | not yet written |
| `obsidian/`, `node/` | not yet written |

Nothing here has synced a real note between two real devices. The engine and the
two adapters are what stands between it and that.

## The headless client

Built from the same `src/core` as the plugin, with `src/node/vault.ts` in place
of Obsidian's API. `bun run build` produces `dist/basalt.mjs`, a single file with
nothing to install alongside it.

```
basalt init --server wss://host --token TOKEN   # the first device
basalt pair basalt1_...                          # every other device
basalt sync                                      # once, and exit
basalt sync --watch                              # and keep going
basalt status
basalt unlink                                    # forget the pairing, keep the notes
```

`--dir` chooses the vault and defaults to the current directory. `--json` on any
command gives machine-readable output. `basalt invite` reprints the pairing
string for another device.

State lives in `.basalt/` inside the vault, which is in the never-sync list:
`config.json` (0600, holds the root secret) and `index.json`.

### What the shells are for

`cli.ts` takes an argv and two output functions and returns an exit code, so
`cli.test.ts` drives the whole client against a real server with real
directories and no subprocess. `bin.ts` is the six lines that connect that to a
terminal, and is the only part of the headless client no test covers.

The plugin shell will be the same arrangement: assemble a vault, an index store,
a transport and an engine, and own nothing else. Any sync decision that appears
in a shell is in the wrong file.

### Exit codes

`0` worked. `1` failed, or finished with files that can never sync, or could not
reach the server. `2` the command line was wrong. A sync that skipped a file for
good exits non-zero on purpose: a broken vault that exits zero is a broken vault
nobody hears about.

## The plugin

`src/obsidian/main.ts` is the other shell, and it does the same job: assemble a
vault, an index store, a transport and a client, then draw a status bar. There is
no settings tab, on purpose (`docs/philosophy.md`); there is one modal, it exists
to pair a vault and to say what is happening, and it has no options in it.

`bun run build` writes `dist/plugin/main.js` and `dist/plugin/manifest.json`.
Copy both into `.obsidian/plugins/basalt/` in a vault.

Config lives in the plugin's own `data.json`, under `.obsidian`, which Obsidian
never syncs. The index sits beside it.

### Neither shell is tested, and they are built so that matters less

`main.ts` and `obsidian/vault.ts` need Obsidian running, so no test here touches
them. What holds them up is that everything they could get wrong is somewhere
else: the reconnect loop, the settle loop and the report arithmetic are in
`core/client.ts`, which the CLI test drives against a real server.

What is checked, in `src/build.test.ts`, is that the plugin bundle needs nothing
but `obsidian` and contains no `node:` import. That is the regression that would
otherwise compile, pass every test, and fail only on a phone.

### How the plugin is tested without Obsidian

The `obsidian` package is type declarations with no runtime (`"main": ""`), so
`main.ts` and `obsidian/vault.ts` could be compiled and never executed.

- `src/obsidian/fake.ts` implements `DataAdapter`, declared against the real
  declarations so the compiler catches drift. Its `normalizePath` was read out
  of the shipped `obsidian.asar`, not assumed.
- `src/obsidian/stub.ts` is the runtime `obsidian` module.
- `vitest.config.ts` aliases `obsidian` to the stub **for tests only**.
  `tsconfig.json` does not, so `tsc` checks against the genuine declarations;
  `esbuild.config.mjs` marks it external, so the shipped plugin gets Obsidian's.
- `src/build.test.ts` loads the built `dist/plugin/main.js`, hands it the stub,
  and pairs two of them against a real Go server.

Eighteen deliberate breakages of the plugin and its adapter are all caught. What
this cannot tell you is whether Obsidian calls these methods when the plugin
expects, or draws what it builds. That needs Obsidian.

### Installing it into a vault

```
bun run build
cp -r dist/plugin /path/to/vault/.obsidian/plugins/basalt
```

Then enable it in Obsidian's community plugins list. Note that the root secret
lives in `.obsidian/plugins/basalt/data.json` in the clear, which is the same
exposure as the headless client's `config.json` and is inherent: the device has
to be able to decrypt the vault without asking anybody.

## Recovery

The server has kept every version of every note and every deletion since the
first commit. These are how you reach it.

```
basalt deleted                       what the server still has and this vault does not
basalt history "Quarterly plan.md"   every version, newest first, deletions included
basalt restore "Quarterly plan.md"   put the newest version with content back
basalt restore "Q.md" --uid 42       put one exact version back
basalt restore "Q.md" --to old/Q.md  put it somewhere else
```

In the plugin it is one command, "Recover a deleted note", and a list with a
button beside each.

Two things worth knowing. Restoring never overwrites: if the path is occupied
the recovered copy lands beside it under `(restored N)` and says so. And a
restored note keeps the timestamp it was written with, not the moment it was
recovered, so a note from March does not sort to the top of everything.

Restoring is not a server operation. The client fetches the version with the
ordinary `get`, writes it, and the ordinary sync sends it on. The server keeps
one way to change a vault.

### Renames, and why the headless client reports them as deletions

A filesystem scan cannot tell a rename from a delete plus a create: one path is
gone, another has arrived, and nothing connects them. Obsidian does know, and
its rename event carries the old path, so the plugin tells the engine and the
rename travels as one operation and stays out of the deleted list.

The headless client gets no such event and reports what it saw. Nothing is lost
either way: the content is on the server under both names, and deduplication
means the second name cost nothing to store.
