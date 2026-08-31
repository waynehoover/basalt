<div align="center">

<img src="docs/assets/logo.svg" alt="" width="140">

# Basalt Sync

> Fast, zero-dependency, self-hosted Obsidian sync

[![CI](https://github.com/waynehoover/basalt-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/waynehoover/basalt-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Go](https://img.shields.io/badge/go-1.27-00ADD8?logo=go&logoColor=white)](server/go.mod)
[![npm](https://img.shields.io/npm/v/basalt-sync?logo=npm&label=basalt-sync)](https://www.npmjs.com/package/basalt-sync)
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
- **Zero dependencies.** The plugin is one 90 KB file that needs nothing installed;
  the CLI is 85 KB and pulls in no packages at all.
- **Works headless.** Same engine, no GUI, for a server or a NAS.

Desktop and Android are in daily use. iOS is untested.

## Install

**1. Run the server.**

```bash
docker run -d --name basalt -p 127.0.0.1:3003:3003 \
  -v basalt-data:/data ghcr.io/waynehoover/basalt-sync:latest
docker logs basalt        # prints your setup string
```

**2. Add the plugin.** Put `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/waynehoover/basalt-sync/releases/latest) into
`<vault>/.obsidian/plugins/basalt-sync/`. In Obsidian: **Community plugins**, turn off
Restricted mode, enable **Basalt Sync**, paste the string.

Done. Other devices paste the string from **Add another device**.

Put TLS in front before anything else reaches it: `tailscale serve` is one line,
and [`docs/running.md`](docs/running.md) covers that, Compose, systemd and every
flag. Trying it on one machine? `basaltd serve -localhost` prints a string that
needs no TLS.

### Headless client

No Obsidian on the machine, for a server or a NAS:

```bash
npm install -g basalt-sync
basalt pair basalt2_...
basalt sync --watch
```

[Every command it takes](client/README.md#the-headless-client), including
history and recovery.

## Docs

[Read the docs](docs/index.md).
