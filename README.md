<div align="center">

<img src="docs/assets/logo.svg" alt="" width="140">

# Basalt Sync

> Self-hosted Obsidian sync. One binary, one pairing string.

[![CI](https://github.com/waynehoover/basalt-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/waynehoover/basalt-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Go](https://img.shields.io/badge/go-1.27-00ADD8?logo=go&logoColor=white)](server/go.mod)
[![npm](https://img.shields.io/npm/v/basalt-sync?logo=npm&label=basalt-sync)](https://www.npmjs.com/package/basalt-sync)

</div>

Basalt syncs an Obsidian vault between your own devices through a server you
run. Notes and filenames are encrypted before they leave a device. The server
stores ciphertext, keeps every version, and never holds a key.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/panel-dark.png">
  <img src="docs/assets/screenshots/panel.png" alt="The Basalt panel in Obsidian: up to date, sync now, add another device, recover a deleted note, unlink." width="800">
</picture>

## Why Basalt

- **End-to-end encrypted.** Content and filenames. Every version is also
  signed by the device that wrote it, so the server cannot forge or alter one.
- **Sends only what changed.** Notes are cut into content-defined chunks.
  Editing one line of a 2 MiB note sends about 22 KB, not 2 MB.
- **Fast.** An edit reaches another device in about a tenth of a second.
- **Never mangles a note.** Concurrent edits merge only when that is provably
  safe. Otherwise both versions are kept, and the file you have open stays put.
- **Full history.** Every version and every deletion, browsable and restorable
  from inside Obsidian.
- **Nothing to configure.** No settings screen. The first device gets a
  recovery key to write down. Every other device joins with a single-use invite.
- **One static binary.** Pure Go with embedded SQLite, 12 MB, runs from an empty
  container. No database, no broker, no accounts.
- **Works headless.** The same engine as a command-line client, for a NAS or a
  server that has no Obsidian.

Desktop and Android are in daily use. iOS is untested.

## Quick start

**1. Run the server** on a machine that stays on.

```bash
docker run -d --name basalt -p 127.0.0.1:3003:3003 \
  -v basalt-data:/data ghcr.io/waynehoover/basalt-sync:latest
docker logs basalt
```

The log prints one line for your first device, `host:3003#TOKEN`. The server
speaks plain HTTP, so put TLS in front before another device reaches it.
`tailscale serve --bg 3003` is one line. [docs/server.md](docs/server.md) has
that, Compose, systemd, and every flag.

**2. Install the plugin.** Put `main.js`, `manifest.json` and `styles.css` from
the [latest release](https://github.com/waynehoover/basalt-sync/releases/latest)
into `<vault>/.obsidian/plugins/basalt-sync/`. In Obsidian, turn off Restricted
mode under Community plugins and enable Basalt Sync.

**3. Pair.** Click the Basalt icon in the ribbon. On your first device, paste
the line from the server log under **Start a new vault**. It shows the vault's
recovery key once: write it down and keep it offline. It is the only way back
into the vault if every device is lost, and anyone who has it has the vault.

**4. Add your other devices.** On a device that has the vault, press **Add
another device** and paste the invite it shows into Basalt on the new one. An
invite works once and expires in ten minutes.

That is the whole setup. [docs/plugin.md](docs/plugin.md) covers the rest.

### Without Obsidian

```bash
npm install -g basalt-sync
basalt init 'homelab:3003#K7M2...'   # the first device, from the server log; prints the recovery key once
basalt invite                        # on a device that has the vault: a single-use invite
basalt pair basalt3i_...             # on the new device
basalt sync --watch
```

[client/README.md](client/README.md) has every command.

## History and recovery

Right-click a note for its version history, with a diff against what is on
disk. Restoring never overwrites: if the path is taken, the restored copy lands
beside it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/changes-dark.png">
  <img src="docs/assets/screenshots/changes.png" alt="Version history for a note, showing the changes between two versions." width="800">
</picture>

Deleted notes have their own list. The server keeps them until you purge.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/recover-dark.png">
  <img src="docs/assets/screenshots/recover.png" alt="The deleted notes list, with a Restore button." width="800">
</picture>

## Docs

| | |
|---|---|
| [Server](docs/server.md) | Install, TLS, backup, purge, upgrading, every command and flag |
| [Plugin](docs/plugin.md) | Pairing, status, history, conflicts, what is not synced, phones |
| [Headless client](client/README.md) | The `basalt` command, and how the client is built and tested |
| [Compared](docs/compared.md) | Against Obsidian Sync, Sync Engine and Fast Note Sync, with the measurements |
| [Design](docs/design.md) | The durability rules, what is refused, and what the server can and cannot do |
| [Protocol](docs/protocol.md) | The wire protocol |

MIT licensed.
