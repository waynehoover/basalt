# Backup

There are two different things people mean by "back up my notes", and they need
different answers. Getting them confused is how someone ends up with a directory
of files nobody can read.

## The short version

```
basalt backup -to /mnt/usb/basalt          server side, ciphertext, incremental
```

That copies everything the server holds, including full version history, into a
directory you can then put anywhere: a USB disk, Time Machine, restic, rsync to
another box. It runs while the server is up.

**It is ciphertext.** Restoring it needs the vault passphrase, which the server
has never seen and never will. So:

> Write the passphrase down and keep it somewhere other than the backup.
> A backup without it is not a backup.

That is the one part of this no command can check, which is why `basalt backup`
says it every time it runs.

For a copy of your notes you can read *without* Basalt, see
[the other kind of backup](#the-other-kind-of-backup) below. It is a
device-side job, and the server cannot do it.

## What a server backup protects you from

| | |
|---|---|
| The server's disk dies | Devices still hold plaintext, so the current state survives without a backup. **History does not.** |
| A note was deleted a month ago | Only the server has it. Without a backup taken while it was still there, it is gone. |
| Every device is lost or wiped | The backup plus the passphrase is the only way back. |
| A bad sync propagated a deletion | Deletions are entries, so an earlier version is on the server, until someone runs `purge`. |

The pattern: a backup is for **history and for the case where no device
survives**. Day to day, your devices are the copies.

`purge` is the one command that destroys something no device holds: old versions
and the deletion records that make a deleted note recoverable. Take a backup
first. `purge` says so after the fact, which is later than you would like.

## What it does, and why

```
basalt backup -to DIR          copy, verify, report
basalt backup -to DIR -deep    also re-read every body already in DIR
```

- **The destination is a data directory.** Restoring is copying it back, or
  pointing the server straight at it: `basalt serve -data DIR`. There is no
  archive format to unpack and no restore tool to keep working.
- **It is incremental.** Chunk bodies are named by the hash of their contents, so
  a body already in the backup is already correct and is skipped. The first run
  copies everything; later runs copy what changed. That is what makes it cheap
  enough to run nightly.
- **It runs while the server runs.** The database is snapshotted with SQLite's
  `VACUUM INTO`, which is a single point in time even with writers active.
  Copying the files with `cp` instead gets you a backup that opens fine and is
  missing the last few commits.
- **Every body is hashed on the way out and on the way in.** Rule 3: copy,
  checksum both ends.
- **It verifies itself before reporting success**, then prints its arithmetic:
  references walked, bodies copied, bodies either side, references verified. A
  backup is the one operation whose failure is invisible until you need it, so
  "done" is not an acceptable thing for it to say.
- **The auth token goes with it**, so a restored server does not generate a new
  one and force you to re-pair every device. The backup therefore contains a
  credential for ciphertext it already contains in full; keep it where you would
  keep a credential.

The backup usually holds slightly **fewer** bodies than the source, and the
report says by how many. Those are bodies no entry references: debris from an
upload that died, or one still in flight. They are not part of the vault.

## Restoring

```
cp -a /mnt/usb/basalt /var/lib/basalt-restored
basalt verify -deep -data /var/lib/basalt-restored     # check before trusting
basalt serve -data /var/lib/basalt-restored
```

One thing to expect: if the backup is **older than what a device has already
applied**, that device will be refused at connect with `code:"cursor"`. That is
deliberate. The server would otherwise hand out uids the device has already used
for different notes, and the two would diverge with both sides reporting
success. The fix is to have that device resync from zero, which re-pushes
anything the restored server is missing.

## Scheduling it

Nothing here is special. A `systemd` timer, a `launchd` job, or a line in cron:

```
basalt backup -to /mnt/usb/basalt && basalt backup -to /mnt/nas/basalt
```

Two destinations is not paranoia. A backup on a disk in the same box as the
server is one power supply away from not existing.

Run `-deep` occasionally, not every time. It re-reads every body in the backup
to catch bit rot on a disk that has been sitting untouched, which is worth doing
monthly and wasteful nightly.

## Locking, and why backup does not need downtime

A data directory has two locks, because "one server at a time" and "nobody is
deleting while somebody is reading" are different questions.

| | `serve` | `backup` | `verify` | `purge` |
|---|---|---|---|---|
| `server.lock` | exclusive | | | |
| `data.lock` | shared | shared | shared | **exclusive** |

So: two servers on one directory is refused. `backup` and `verify` run happily
alongside a live server. `purge` is the only thing that deletes chunk bodies, so
it takes the data lock exclusively and refuses while a server is up.

This exists because the store's own write mutex is per process, and the
maintenance commands are separate processes. Without the locks, `basalt purge`
run against a live server would sweep bodies with nothing holding off that
server's commits, and an entry could be committed referencing a body deleted a
moment earlier. The locks close within a directory what the mutex closes within
a process.

Refusals name the process in the way, pid included, and fail immediately rather
than waiting. A backup that silently blocked for an hour is a backup that did
not run, and nothing would say so until it was needed.

## The other kind of backup

If what you want is a readable copy of your notes, independent of Basalt and of
the passphrase, then the server is the wrong place to look. It holds ciphertext
and no key, by design, and that is the property the whole project rests on.

The good news is that this needs no feature at all. **An Obsidian vault is a
directory of plain Markdown files.** So on any device:

- Time Machine, or File History, or whatever the OS already does.
- `restic backup ~/vault`, `borg`, `rsync` to another machine.
- A git repository in the vault, if you want a history you can read with `git
  log`.

Any of these gives you plaintext you can open with a text editor in twenty
years, with no Basalt and no passphrase involved.

The two kinds are complementary, and it is worth being clear about which does
what:

| | Server backup | Device backup |
|---|---|---|
| Contents | ciphertext | plaintext |
| Needs the passphrase to restore | yes | no |
| Has full version history | yes | only what the tool keeps |
| Has deleted notes | yes | only what the tool keeps |
| Readable without Basalt | no | yes |
| Survives losing every device | yes | no |

If you only do one, do the device one: it is readable. If you can do both, the
server backup is what holds the history and what survives losing everything you
type on.
