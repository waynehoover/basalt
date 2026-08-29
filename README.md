# Basalt

Self-hosted sync for Obsidian. One binary on your box, one string on each device.

```
server   ./basalt                       prints a setup string
device   paste it                       that is the whole setup
```

Built for one person's devices on a private network, reached over Tailscale or a
Cloudflare tunnel. That assumption is what lets it be small: no accounts, no
subscription, no external database, no settings screen.

Notes are encrypted before they leave the device. The server stores ciphertext
and encrypted paths and has no key for either.

## Backing it up

```
basalt backup -to /mnt/usb/basalt
```

Incremental, verified, and it runs while the server does. The copy is ciphertext,
so keep the passphrase somewhere else. For a copy you can read without Basalt,
back up the vault folder with whatever you already use — it is plain Markdown.
`docs/backup.md` covers what each kind saves you from.

## Status

Early. The headless client works; the plugin has run in a real vault once. It has
never run on a phone.

- `docs/running.md` — server, devices, Docker
- `docs/philosophy.md` — the ten durability rules and what it refuses to do
- `docs/protocol.md` — the wire protocol
- `docs/benchmark.md` — speed and correctness, measured together
- `docs/compared.md` — Obsidian Sync, the two self-hosted plugins, and what was
  borrowed from each
- `docs/backup.md` — the two kinds of backup
- `client/README.md` — how the plugin and the headless client share one engine
