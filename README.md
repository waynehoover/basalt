<div align="center">

<img src="docs/assets/logo.svg" alt="" width="140">

# Basalt Sync

> Blazing fast self-hosted Obsidian sync that just works

[![CI](https://github.com/waynehoover/basalt/actions/workflows/ci.yml/badge.svg)](https://github.com/waynehoover/basalt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Go](https://img.shields.io/badge/go-1.27-00ADD8?logo=go&logoColor=white)](server/go.mod)
[![Client](https://img.shields.io/badge/client-TypeScript-3178C6?logo=typescript&logoColor=white)](client/)

</div>

**Basalt Sync** syncs an Obsidian vault between your own devices, through a
server you run. It is engineered for vaults rather than for files: the chunking,
the merge, the encryption and the wire protocol are all designed around Markdown
notes that one person owns. That is where the speed comes from. A generic file
syncer cannot send a few hundred bytes for an edit to a long note, because it
does not know what it is carrying.

## Install

Two steps. Run the server, paste what it prints.

### 1. Run the server

```bash
docker run -d --name basalt \
  -p 127.0.0.1:3003:3003 \
  -v basalt-data:/data \
  ghcr.io/waynehoover/basalt:latest
docker logs basalt
```

It prints a setup string the first time it runs:

```
basaltd 0.1.0 listening on 0.0.0.0:3003, serving vault "default"
  100.80.123.79:3003#JGJFZ9SQ-5E67J3KM0VBPG15AYSF381SM
```

Put TLS in front of it before another device can reach it. `tailscale serve` is
one line and gives you a real certificate; `docs/running.md` covers that, Docker
Compose, systemd, and every flag.

Trying it on one machine first? `basaltd serve -localhost` prints a string you
can paste as it is.

### 2. Install the plugin

Until it is in the community list, put it in the vault by hand. From the
[latest release](https://github.com/waynehoover/basalt/releases), download
`main.js` and `manifest.json` into:

```
<your vault>/.obsidian/plugins/basalt/
```

Then in Obsidian: **Settings → Community plugins**, turn off Restricted mode,
enable **Basalt Sync**, and paste the setup string into the pairing box.

That is it. Every device after the first pastes the string that one hands out,
from **Add another device** in the plugin.

### Syncing a machine with no Obsidian on it

A server, a NAS, a backup box. Same engine, no GUI:

```bash
npm install -g basalt-sync
basalt pair basalt2_...
basalt sync --watch
```

[`client/README.md`](client/README.md#the-headless-client) documents every
command it takes, including version history and recovery.

## Features

| Feature | Status |
|---|---|
| **End-to-end encryption** | ✅ Stable |
| **Chunked sync** | ✅ Stable |
| **Three-way merge** | ✅ Stable |
| **Version history and recovery** | ✅ Stable |
| **Obsidian plugin, desktop** | ✅ Stable |
| **Obsidian plugin, Android** | ✅ Stable |
| **Headless CLI** | ✅ Stable |
| **Backup, verify, restore** | ✅ Stable |
| **Docker and systemd** | ✅ Stable |
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

## Docs

[Read the docs](docs/index.md).
