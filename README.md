<div align="center">

<img src="docs/assets/logo.svg" alt="" width="150">

# Basalt

**Self-hosted sync for Obsidian. One binary on your box, one string on each device.**

[![CI](https://github.com/waynehoover/basalt/actions/workflows/ci.yml/badge.svg)](https://github.com/waynehoover/basalt/actions/workflows/ci.yml)
[![Go](https://img.shields.io/badge/go-1.27-00ADD8?logo=go&logoColor=white)](go/go.mod)
[![Client](https://img.shields.io/badge/client-TypeScript-3178C6?logo=typescript&logoColor=white)](client/)
[![Status](https://img.shields.io/badge/status-early-orange)](#status)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

```
server   ./basalt                       prints a setup string
device   paste it                       that is the whole setup
```

## Features

- **Quick to set up.** Run the binary, paste one string on each device. No
  accounts, no subscription, no sign-in.
- **Fast.** An edit lands in about a second over a 400 ms link. A first sync of
  2000 files takes 2.8 minutes.
- **Light on the wire.** Editing one line of a 2 MiB note sends 494 bytes.
- **Encrypted before it leaves.** Notes and filenames both. The server holds no
  key and never needs one.
- **One static binary.** No database, no message broker. Docker image included.
- **It will not mangle a note.** When a merge is not provably safe it keeps both
  versions rather than dropping an edit.
- **Nothing to configure.** No settings screen.
- **Every version kept.** Old versions and deleted notes are recoverable, and
  backups verify themselves.

## Status

Early. The headless client works. The plugin has run in a real vault once, and
never on a phone.

## Docs

[Read the docs](docs/index.md).
