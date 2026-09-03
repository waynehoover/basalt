# Basalt Sync

Self-hosted sync for Obsidian. One binary, one pairing string.

## Layout

- `server/` is the Go server. Its binary is `basaltd`, and every subcommand it
  has is a server operation: serve, backup, verify, purge, stats, service,
  health.
- `client/src/core` is the sync engine, which knows nothing about where files
  live. `client/src/cli` is the headless client, whose binary is `basalt`.
  `client/src/plugin` is the Obsidian plugin.
- Two binaries, two names, because a homelab runs both.

Read `docs/design.md` before adding anything. It is short and it is the
point of the project.

## The first rule

**Do not lose a note.** When simplicity and correctness conflict, correctness
wins and the feature gets cut instead. `docs/design.md` lists ten durability
rules, each with the incident that produced it; they are not aspirational.

## Scope, and what is refused

One backend, one transport, one platform, one person's devices on a private
network. No S3, no CouchDB, no peer-to-peer, no teams, no web UI, no settings
screen. Refusals are in the philosophy doc and are decisions, not gaps.

## Protocol

`docs/protocol.md`. Basalt does not speak Obsidian Sync's protocol; every rule
in ours inverts a specific defect in theirs, six of which fail silently.

## Conventions

- The server is a single static binary: pure-Go SQLite, no cgo, no external
  database, no message broker. TLS is terminated in front of it by
  `tailscale serve` or a tunnel, so no key material lives here.
- The server never sees plaintext or the passphrase, and must never need to.
- Every vault write on a dev machine goes through the `obsidian` CLI, never
  `mv`/`rm`/`cp`. Obsidian's index and any sync engine learn about changes
  through the file watcher; writes behind its back are invisible to sync and
  not reliably repairable.
- Verify against the shipped artifact, never infer. Where an artifact cannot
  answer, say so rather than guess.

## Testing

Unit tests are necessary and never sufficient here. Every real bug found in the
predecessor was a *silent* failure that only appeared when the system ran. A fix
without a test that failed before it is not finished: revert the fix, watch the
test fail, restore it.

## Prior art

`docs/compared.md` credits every project this one learned from. Add to it when
reading someone else's code changes something here. The two that come up most:

- `~/code/obionesync`, the predecessor, which piggybacks Obsidian's own engine.
  Its README and CLAUDE.md hold the verified protocol facts about Obsidian Sync.
- [obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync), MIT. Source
  of the content-defined chunking idea and the confirmation that text merging is
  solved. Considerably broader in scope; see the philosophy doc on why we are not.
