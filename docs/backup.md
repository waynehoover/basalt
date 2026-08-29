# Backup

Two different things people mean by "back up my notes", and confusing them is how
someone ends up with a directory nobody can read.

```
basalt backup -to /mnt/usb/basalt          server side, ciphertext, incremental
```

That copies everything the server holds, including full version history, into a
directory you can put anywhere. It runs while the server is up.

**It is ciphertext.** Restoring needs the vault passphrase, which the server has
never seen.

> Write the passphrase down and keep it somewhere other than the backup.
> A backup without it is not a backup.

No command can check that, which is why `basalt backup` says it every time.

## What a server backup is for

| | |
|---|---|
| The server's disk dies | Devices hold plaintext, so the current state survives. **History does not.** |
| A note was deleted a month ago | Only the server has it. |
| Every device is lost or wiped | The backup plus the passphrase is the only way back. |

Day to day, your devices are the copies. A backup is for history and for the case
where no device survives.

`purge` is the one command that destroys something no device holds. Take a backup
first; it says so afterwards, which is later than you would like.

## What it does

```
basalt backup -to DIR          copy, verify, report
basalt backup -to DIR -deep    also re-read every body already in DIR
```

- **The destination is a data directory.** Restore by copying it back, or point
  the server at it: `basalt serve -data DIR`. No archive format, no restore tool.
- **Incremental.** Bodies are named by their content hash, so one already there
  is already correct and is skipped. Cheap enough to run nightly.
- **Runs live.** The database is snapshotted with `VACUUM INTO`, a single point
  in time even with writers active. `cp` gets you a backup that opens fine and is
  missing the last few commits.
- **Every body is hashed on the way out and on the way in.** Rule 3.
- **It verifies before reporting success**, then prints its arithmetic. A backup
  is the one operation whose failure is invisible until you need it.
- **The auth token goes with it**, so a restored server does not force you to
  re-pair. Keep the backup where you would keep a credential.

The backup usually holds slightly fewer bodies than the source, and says by how
many: debris from an upload that died, referenced by nothing.

## Restoring

```
cp -a /mnt/usb/basalt /var/lib/basalt-restored
basalt verify -deep -data /var/lib/basalt-restored
basalt serve -data /var/lib/basalt-restored
```

If the backup is older than what a device already applied, that device is refused
with `code:"cursor"`. Deliberate: the server would otherwise reissue uids the
device used for different notes and the two would diverge, both reporting
success. Resync that device from zero.

## Scheduling

A systemd timer, a launchd job, or cron. Two destinations is not paranoia — a
backup on a disk in the same box is one power supply away from not existing.

```
basalt backup -to /mnt/usb/basalt && basalt backup -to /mnt/nas/basalt
```

Run `-deep` monthly, not nightly. It re-reads every body to catch bit rot on a
disk that has been sitting untouched.

## Locking

| | `serve` | `backup` | `verify` | `purge` |
|---|---|---|---|---|
| `server.lock` | exclusive | | | |
| `data.lock` | shared | shared | shared | **exclusive** |

Two servers on one directory is refused. `backup` and `verify` run alongside a
live server. `purge` deletes bodies, so it takes the data lock exclusively and
refuses while a server is up — otherwise it could sweep a body just as an entry
referencing it commits.

Refusals name the process in the way, pid included, and fail immediately. A
backup that silently blocked for an hour is one that did not run.

## The other kind

For a readable copy independent of Basalt, the server is the wrong place: it
holds ciphertext and no key. But an Obsidian vault is a directory of plain
Markdown, so this needs no feature. Time Machine, `restic backup ~/vault`, borg,
rsync, or a git repo in the vault.

| | Server backup | Device backup |
|---|---|---|
| Contents | ciphertext | plaintext |
| Needs the passphrase | yes | no |
| Full version history | yes | only what the tool keeps |
| Deleted notes | yes | only what the tool keeps |
| Readable without Basalt | no | yes |
| Survives losing every device | yes | no |

If you only do one, do the device one: it is readable. If you can do both, the
server backup holds the history.

## What the commands refuse

Only `serve` creates a data directory. `backup`, `verify` and `purge` refuse a
`-data` path that is not already one. A mistyped path used to be created on the
spot, so the backup succeeded, of nothing, and said so.

`purge` spares unreferenced bodies written in the last hour, for a push that
uploaded but had not committed. That reclaims nothing on a server stopped a
moment ago, which is when people purge to free space; `-grace 0` collects
everything unreferenced, and is safe when you stopped the server yourself.
