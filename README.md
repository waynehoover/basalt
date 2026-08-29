<div align="center">

<img src="docs/assets/logo.svg" alt="" width="150">

# Basalt

**Self-hosted sync for Obsidian. One binary on your box, one string on each device.**

[![CI](https://github.com/waynehoover/basalt/actions/workflows/ci.yml/badge.svg)](https://github.com/waynehoover/basalt/actions/workflows/ci.yml)
[![Go](https://img.shields.io/badge/go-1.27-00ADD8?logo=go&logoColor=white)](go/go.mod)
[![Client](https://img.shields.io/badge/client-TypeScript-3178C6?logo=typescript&logoColor=white)](client/)
[![Status](https://img.shields.io/badge/status-early-orange)](#status)

</div>

```
server   ./basalt                       prints a setup string
device   paste it                       that is the whole setup
```

Built for one person's devices on a private network, reached over Tailscale or a
Cloudflare tunnel. That assumption is what lets it be small: no accounts, no
subscription, no external database, no settings screen.

Notes are encrypted before they leave the device. The server stores ciphertext
and encrypted paths and has no key for either.

## Why

|  |  |
|---|---|
| **Editing one line of a 2 MiB note** | sends 494 B, not 2 MiB |
| **A merge it cannot make safely** | keeps both versions instead of silently dropping an edit |
| **A first sync of 2000 files** | 26 round trips, not 2000 |
| **The server** | one static binary, no database, no key material |

`docs/benchmark.md` has the measurements and the machine they were taken on.

## Backing it up

```
basalt backup -to /mnt/usb/basalt
```

Incremental, verified, and it runs while the server does. The copy is ciphertext,
so keep the passphrase somewhere else. For a copy you can read without Basalt,
back up the vault folder with whatever you already use — it is plain Markdown.

## Status

Early. The headless client works; the plugin has run in a real vault once. It has
never run on a phone.

- `docs/running.md` — server, devices, Docker
- `docs/philosophy.md` — the ten durability rules and what it refuses to do
- `docs/protocol.md` — the wire protocol
- `docs/benchmark.md` — speed and correctness, measured together
- `docs/compared.md` — Obsidian Sync, the two self-hosted plugins, what was borrowed
- `docs/backup.md` — the two kinds of backup
- `client/README.md` — how the plugin and the headless client share one engine
