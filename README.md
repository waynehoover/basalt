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

**One static binary.** No database, no message broker, no cgo. Drop it on a box
or run the Docker image. Backups are one command and they verify themselves.

**Setup is one string.** No accounts, no subscription, no sign-in. The address
and the key travel together; paste it on the next device and you are done.

**Encrypted before it leaves.** Every note and every filename. The server stores
ciphertext, holds no key, and never needs one. Not a setting you can forget to
turn on.

**Sends only what changed.** Editing one line of a 2 MiB note sends 494 bytes,
not 2 MiB. Chunks are compressed before they are encrypted.

**Fast on a slow link.** A first sync of 2000 files costs 26 round trips, not
2000. Twenty edited notes cost 20 chunks and about a second at 400 ms.

**It will not mangle a note.** When a merge is not provably safe it keeps both
versions instead of silently dropping an edit. Deletions lose to edits, in both
directions.

**Nothing to configure.** No settings screen, no options nobody tested. Every
question with a right answer is answered once, in the source.

**Correctness is the point.** Full version history and recovery on the server, a
benchmark that reports correctness beside speed, and ten durability rules that
each came from something going wrong.

## Status

Early. The headless client works. The plugin has run in a real vault once, and
never on a phone.

## Docs

[Read the docs](docs/index.md).
