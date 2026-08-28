# Basalt

Self-hosted sync for Obsidian. One binary on your box, one string on each device.

```
server   ./basalt                       prints a setup string
device   paste it                       that is the whole setup
```

Basalt is built for one person's devices on a private network, reached over
Tailscale or a Cloudflare tunnel. That assumption is what lets it be small: no
accounts, no subscription, no external database, no settings screen.

Your notes are encrypted before they leave the device. The server stores
ciphertext and deterministically-encrypted paths, and has no key for either.

## Backing it up

```
basalt backup -to /mnt/usb/basalt
```

Incremental, verified, and it runs while the server does. The copy is ciphertext,
so keep the passphrase somewhere other than the backup: without it the backup
restores nothing.

For a copy of your notes you can read without Basalt, back up the vault folder on
any device with whatever you already use. It is plain Markdown. `docs/backup.md`
explains why both kinds are worth having and what each one covers.

## Status

Early. See `docs/` for the design this is being built to:

- `docs/features.md`, everything it does, marked built, partial or designed
- `docs/philosophy.md` — what it refuses to do, and why
- `docs/protocol.md` — the wire protocol, and the seven defects it exists to avoid
- `docs/backup.md`, on the two kinds of backup and which one saves you from what
- `docs/vs-obsidian-sync.md`, a side by side comparison, including where theirs wins
- `client/README.md`, how the plugin and the headless client share one engine

## Not LiveSync

[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) is excellent,
MIT-licensed, and does considerably more than this will: CouchDB and S3 backends,
peer-to-peer sync, hidden-file sync, plugin sync, a bridge to other apps. Basalt
deliberately does none of that. If you need any of it, use LiveSync.

Basalt takes two things from reading it: content-defined chunking, so editing a
large note re-uploads one chunk rather than all of them, and the conclusion that
text merging is solved and should not be reimplemented.
