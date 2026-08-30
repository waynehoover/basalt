<div align="center">

<img src="docs/assets/logo.svg" alt="" width="140">

# Basalt Sync

> Blazing fast self-hosted Obsidian sync that just works

[![CI](https://github.com/waynehoover/basalt/actions/workflows/ci.yml/badge.svg)](https://github.com/waynehoover/basalt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Go](https://img.shields.io/badge/go-1.27-00ADD8?logo=go&logoColor=white)](server/go.mod)
[![Client](https://img.shields.io/badge/client-TypeScript-3178C6?logo=typescript&logoColor=white)](client/)

</div>

Sync an Obsidian vault between your own devices, through a server you run. Built
for vaults rather than files: the chunking, the merge and the protocol are all
designed around Markdown notes, which is where the speed comes from.

## Features

- **End-to-end encrypted.** Notes and filenames both. The server holds no key.
- **Sends only what changed.** One line edited in a 2 MiB note costs 494 bytes.
- **Fast.** A note reaches another device in about a tenth of a second.
- **Never mangles a note.** If a merge is not provably safe, both versions are kept.
- **Full history.** Every version and every deletion, restorable from the plugin.
- **One static binary.** No database, no broker, no accounts, no settings screen.
- **Works headless.** Same engine, no GUI, for a server or a NAS.

Desktop and Android are in daily use. iOS is untested.

## Install

### 1. Run the server

```bash
docker run -d --name basalt -p 127.0.0.1:3003:3003 \
  -v basalt-data:/data ghcr.io/waynehoover/basalt:latest
docker logs basalt
```

It prints a setup string:

```
  100.80.123.79:3003#JGJFZ9SQ-5E67J3KM0VBPG15AYSF381SM
```

Put TLS in front before another device reaches it. `tailscale serve` is one line;
[`docs/running.md`](docs/running.md) has that, Compose, systemd and every flag.
Trying it on one machine? `basaltd serve -localhost` prints a string you can
paste as it is.

### 2. Install the plugin

Download `main.js` and `manifest.json` from the
[latest release](https://github.com/waynehoover/basalt/releases) into
`<your vault>/.obsidian/plugins/basalt/`.

In Obsidian: **Settings → Community plugins**, turn off Restricted mode, enable
**Basalt Sync**, paste the setup string.

Every device after the first pastes the string that one hands out, from **Add
another device**.

### Headless client

For a server or a NAS, with no Obsidian on it:

```bash
npm install -g basalt-sync
basalt pair basalt2_...
basalt sync --watch
```

[Every command it takes](client/README.md#the-headless-client), including
history and recovery.

## Docs

[Read the docs](docs/index.md).
