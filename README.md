<div align="center">

<img src="docs/assets/logo.svg" alt="" width="140">

# Basalt

> Blazing fast self-hosted Obsidian sync that just works

[![CI](https://github.com/waynehoover/basalt/actions/workflows/ci.yml/badge.svg)](https://github.com/waynehoover/basalt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Go](https://img.shields.io/badge/go-1.27-00ADD8?logo=go&logoColor=white)](go/go.mod)
[![Client](https://img.shields.io/badge/client-TypeScript-3178C6?logo=typescript&logoColor=white)](client/)

</div>

**Basalt** syncs an Obsidian vault between your own devices, through a server you
run. It is engineered for vaults rather than for files: the chunking, the merge,
the encryption and the wire protocol are all designed around Markdown notes that
one person owns. That is where the speed comes from. A generic file syncer cannot
send a few hundred bytes for an edit to a long note, because it does not know
what it is carrying.

```
server   ./basalt                       prints a setup string
device   paste it                       that is the whole setup
```

## Features

| Feature | Status |
|---|---|
| **End-to-end encryption** | ✅ Stable |
| **Chunked sync** | ✅ Stable |
| **Three-way merge** | ✅ Stable |
| **Version history and recovery** | ✅ Stable |
| **Headless CLI** | ✅ Stable |
| **Backup, verify, restore** | ✅ Stable |
| **Docker and systemd** | ✅ Stable |
| **Obsidian plugin, desktop** | 🧪 Beta |
| **Obsidian plugin, Android** | 🧪 Beta |
| **Obsidian plugin, iOS** | 🗓️ Untested |
| **Community plugin listing** | 🗓️ Planned |

### End-to-end encryption
Notes and filenames are sealed on the device. The server stores ciphertext, holds
no key, and never needs one. Not a setting you can forget to turn on.

### Chunked sync
A rolling hash splits each note, and only the chunks that changed are sent.
Editing one line of a 2 MiB note costs 494 bytes. Chunks are compressed before
they are encrypted, and identical content is stored once.

### Three-way merge
Two devices editing one note usually merge cleanly. When a merge is not provably
safe, both versions are kept instead of one being silently dropped, and the
incoming version is the one renamed, so a sync never rewrites the file you have
open.

### Version history and recovery
Every version of every note is on the server, deletions included. Right-click a
note for its history, with a diff against what is on disk and a restore that
never overwrites. Deleted notes have their own recovery list.

### Fast on a slow link
A note written on one device appears on another in about a tenth of a second,
measured desktop to phone. A first sync of 2000 files costs 26 round trips, not
2000, and twenty edited notes take about a second over 400 ms of latency.
`docs/benchmark.md` has the numbers and the machine they were measured on.

### Notes first, attachments second
Everything here is built around Markdown: the chunk sizes, the merge, the
scanning, the round trips. Attachments sync and are not the point. Large binary
files work and are capped at 64 MiB by default, because sending one costs the
device memory that a note never does. If your vault is mostly video, this is the
wrong tool and `docs/philosophy.md` says why.

### Nothing to configure
No accounts, no subscription, no settings screen. One binary, one pairing string,
and every question with a right answer answered once in the source.

## Install

The server is one static binary with no database and no message broker.

```bash
docker compose up -d          # or: go build ./cmd/basalt && ./basalt
```

It prints a pairing string on first run. Paste that into the plugin, or into the
headless client:

```bash
basalt pair basalt2_...
basalt sync --watch
```

`docs/running.md` covers the tunnel, systemd, and putting the plugin in a vault.

## Status

Early, and further along than it was. The headless client works. The plugin syncs
a real vault on desktop and on Android, including a whole vault pulled onto a
phone with every file byte-identical. It has never run on iOS.

## Docs

[Read the docs](docs/index.md).
