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
