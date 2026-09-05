# The server

[Back to the README](../README.md)

`basaltd` is one static binary. It serves one vault, stores encrypted chunks
and a SQLite database in one directory, and never sees a key. Every subcommand
is a server operation:

```
basaltd serve                 run it (the default, so bare basaltd is this)
basaltd backup -to DIR        copy everything, verified, while the server runs
basaltd verify [-deep]        check the store against itself
basaltd purge -confirm VAULT -backup DIR
                              reclaim space from old versions; server must be stopped
basaltd stats [-json]         what the vault holds
basaltd service               print a hardened systemd unit
basaltd health                ask a running server if it is well
basaltd version
```

Every command takes `-data DIR`, the data directory. It defaults to
`$BASALT_DATA`, then `~/.basalt`. Only `serve` will create one. The others
refuse a path that is not already a data directory, because a mistyped path
once produced a successful backup of nothing.

## Install

### Docker

The image is the binary on an empty filesystem: no shell, no package manager,
nothing to update. For 0.3.1 on linux/amd64 that is 5.2 MB of compressed layers
to pull and a 12.0 MB binary on disk, checkable for any release with
`docker buildx imagetools inspect ghcr.io/waynehoover/basalt-sync:<tag> --raw`.
`latest` is for trying it out; pin the tag and its digest for a server you keep,
the way `compose.yaml` does, so a pull cannot move you to an image nobody
tested against your devices.

```bash
docker run -d --name basalt -p 127.0.0.1:3003:3003 \
  -v basalt-data:/data ghcr.io/waynehoover/basalt-sync:latest
docker logs basalt
```

Or `docker compose up -d` with the `compose.yaml` in this repository, which
also runs read-only with every capability dropped.

Publish to `127.0.0.1`, not every interface: there is no TLS in the binary, so
only the thing terminating it should reach the port.

A named volume works as is. A bind mount needs to be owned by the user the
server runs as:

```bash
sudo chown -R 65532:65532 /srv/basalt
```

Maintenance runs through the same image:

```bash
docker exec basalt /basaltd stats
docker exec basalt /basaltd verify -deep
docker exec basalt /basaltd backup -to /data/backup
```

### A binary

Take one from a [server release](https://github.com/waynehoover/basalt-sync/releases?q=server)
for linux/amd64, linux/arm64, darwin/arm64 or darwin/amd64. It needs nothing
installed beside it.

```bash
scp basaltd-linux-amd64 homelab:/usr/local/bin/basaltd
ssh homelab
sudo mkdir -p /var/lib/basalt && sudo chown $USER /var/lib/basalt
basaltd service -data /var/lib/basalt -addr 127.0.0.1:3003
```

`service` prints a systemd unit with the real paths filled in, followed by the
commands to install it. It prints rather than writes because installing needs
root. The unit is hardened: `ProtectSystem=strict`, an empty capability set, a
syscall filter, and address families limited to sockets. `ProtectHome` is added
only when the data directory is outside a home directory, since otherwise it
would stop the server starting.

It restarts from anything, but not for ever: five failures inside five minutes
and systemd stops, so a server that is *refusing* rather than crashing shows up
as `failed` rather than reprinting the same refusal every five seconds. Once
the reason is fixed, `systemctl reset-failed basalt` before starting it again.
Every flag the unit runs with is written out, `-max-file` included, so
upgrading the binary cannot move a running server's ceiling underneath it.

The server's own releases are tagged `server/vX.Y.Z`, the plugin's are bare
version tags, because the two move on different clocks. A client and server
that disagree on the protocol version refuse each other by name, so a mismatch
never half-works.

### Upgrade order

The server first, then each client. The handshake carries the range of
protocol versions a server speaks, and a device outside it is refused at hello
with both numbers: read that as "upgrade the server". The refusal names no
release, because nothing has authenticated when it is sent; `basaltd version`
on the server does.

Today that range is one version wide. Protocol 4 is the only protocol: the
three before it were removed rather than carried, because a compatibility path
is a second set of code paths through the part of the system that must not be
wrong, and 3 had been in use by one person for one day when 4 replaced it. The
range stays in the handshake for the next version, whose compatibility gets
written against a protocol 4 that has actually run.

| Release | Protocol | Notes |
|---|---|---|
| plugin, `basalt` and `basaltd` 0.1.x and 0.2.x | 1 and 2 | withdrawn before deployment; a data directory from one of these cannot be served |
| 0.3.x | 3 | request ids, retryable errors, the data key, invites |
| current | 4 | per-device credentials: a hello names a device and carries that device's own key, and an invite registers the device that redeems it |

The protocol version is what decides whether two releases can talk. Every
plugin release needs Obsidian 1.7.2 or newer (`versions.json`). `basaltd
version` prints the server's release, and the plugin's is in its manifest.

## TLS

None in the binary, on purpose. No key material lives here. Bind to localhost
and put something in front. Two arrangements are known to work.

### Tailscale

```bash
tailscale serve --bg 3003
```

Devices then pair against `wss://<machine>.<tailnet>.ts.net`. A bare hostname
in the plugin's server field or in `basalt init --server` is taken as `wss://`.
Nothing is reachable from outside the tailnet, and Tailscale manages the
certificate.

### Caddy

For a machine with a public name, Caddy fetches the certificate and proxies
WebSockets without being told to. The whole `Caddyfile`:

```
sync.example.org
reverse_proxy 127.0.0.1:3003
```

Then `systemctl reload caddy` and pair against `wss://sync.example.org`. Keep
`basaltd` bound to `127.0.0.1:3003`, as the unit and the compose file do, so
the only way in is through Caddy. The port is open to the internet, so the
first thing on it is the auth check, which is why the vault and device names
are bounded and the pre-auth limits in the reference table exist.

For trying it on one machine, `basaltd serve -localhost` binds to loopback and
prints a `ws://` address that needs no TLS.

The first-device token below is required on every bind, loopback included. A
loopback bind is exactly what both arrangements above proxy to, so it says
nothing about who is on the other end;
[design.md](design.md#why-a-loopback-bind-is-not-the-token) has the reasoning
and what the token really proves.

## The first device

On first run the server generates a bootstrap token, stores it in
`auth-token` inside the data directory, and prints one line per interface:

```
No device has claimed this vault yet. Paste one of these lines into
Basalt on your first device, under "Start a new vault", or run
`basalt init <line>` there:

  192.168.1.20:3003#K7M2PQR4-9XBCDEFGHJKMNPQRSTVWXYZ2

If TLS is in front, use that hostname instead: wss://your-host#K7M2PQR4-9XBCDEFGHJKMNPQRSTVWXYZ2

The part after the # is a one-time token. It is not the encryption key:
the vault secret is generated on your first device and this server
never sees it, so it cannot read anything it stores.
```

Paste the whole line as is, into the plugin's *Setup string* field or as the
argument to `basalt init`. The addresses are this machine's interfaces. If TLS
terminates elsewhere, put that hostname in front of the `#`, as the second line
shows.

The first device then shows the vault's recovery key once. Write it down and
keep it offline: it is the whole vault, and this server has never seen it and
cannot reissue it. Every device after the first is added with an invite from a
device that has the vault, `basalt invite` or *Add another device* in the
plugin, which works once and expires after ten minutes; adding a device never
needs the recovery key. The server stores an invite as an identifier and a blob
it cannot open, and deletes every outstanding invite on `basalt rotate`.
`basalt devices` lists the unredeemed ones and `basalt uninvite ID` cancels one.

The token is one-time. The first device claims the vault with it and generates
the root secret; from then on the server accepts only a key derived from that
secret, stored as a hash. Once claimed, it stops printing the token and says to
pair further devices from one that already has the vault.

Under Docker or systemd the token is in the log:

```bash
docker logs basalt
journalctl -u basalt
```

## Backup

```bash
basaltd backup -to /mnt/usb/basalt
```

This copies everything the server holds, history included, into a directory
that is itself a data directory. It runs against a live server, it is
incremental because chunk bodies are named by content hash, and it verifies the
copy before reporting success. The database is snapshotted with `VACUUM INTO`,
so the copy is a single point in time. The auth token is copied too, so a
restored server does not force re-pairing.

A run replaces the previous backup only at the very end: the new snapshot is
staged under a temporary name, its bodies copied, the whole thing verified, and
only then is it renamed over the last good database and the directory flushed
to disk. A run that fails partway, for a missing body, a full disk, or a crash,
leaves the previous backup exactly as it was.

Stale bodies are never deleted. Once the source purges old versions the next
snapshot stops referencing their bodies, but those bodies are the history the
backup exists to keep, so they are retained and the report counts them as
history kept rather than bodies not copied.

The token is written the same careful way as everything else it protects: to a
private temporary file, flushed, renamed into place, and read back to confirm
both its contents and its `0600` mode, so a crash cannot leave it half written
and a restore cannot inherit a world-readable credential.

Beside the database the backup writes `backup.json`: when the snapshot was
taken, which database it describes, and, per vault, the uid range it covers and
the purge generation the source was at. It is what lets a script answer "which
backup covers uid 4021" or "which directory still has the history I purged"
without opening SQLite:

```json
{
  "format": 2,
  "takenAt": "2026-09-03T03:30:12Z",
  "database": {"bytes": 5292032, "modifiedAt": "2026-09-03T03:30:12.418Z"},
  "vaults": [
    {"vault": "default", "oldestUid": 1, "latestUid": 4188,
     "allocatedTo": 4188, "versions": 4188, "purges": 0}
  ]
}
```

The file is either a summary of the `basalt.db` beside it or it is absent. The
previous run's copy is removed before the new database is published and the new
one written after, so a crash in between leaves no `backup.json` rather than a
stale one, and the next run writes it again. `database` covers what no ordering
can, a build that does not write this file republishing into the same
directory: if `bytes` does not match `basalt.db` beside it, every command that
reads it refuses rather than answering from it. `modifiedAt` is the stronger
check for a directory nobody has copied, since copying moves it.

```bash
jq '.vaults[] | select(.vault == "default" and .oldestUid <= 4021 and 4021 <= .latestUid)' \
  /srv/basalt-backup*/backup.json
```

`versions` against the span says whether the snapshot has holes, which a purge
leaves; `purges` is the generation, and `basaltd stats -json` reports the live
store's as `purges` too. The database is the authority and this is a summary of
it; `verify` still reads the database.

**The backup is ciphertext.** Reading it back needs a device that is still
paired, since a paired device holds the vault's data key, or the recovery key
if none is. Keep that key somewhere other than the backup, because a backup and
a key in the same place is one loss rather than two. The command reminds you
every time because no command can check it.

What a server backup is for:

| | |
|---|---|
| The server's disk dies | Your devices hold the current notes. The history is only in the backup. |
| A note deleted months ago | Only the server has it. |
| Every device is lost or wiped | Backup plus pairing string is the only way back. |

Run it nightly from a timer, ideally to two places. Add `-deep` monthly: it
re-reads every body already in the destination to catch bit rot, and decodes
the device rows and invites, which nothing else opens until a device cannot
connect.

### Nightly, then off the machine

Two units: a service that backs up and then verifies the copy, and a timer
that runs it. Put them in `/etc/systemd/system/` and enable the timer.

```ini
# basalt-backup.service
[Unit]
Description=Basalt backup and verify
After=basalt.service

[Service]
Type=oneshot
User=basalt
ExecStart=/usr/local/bin/basaltd backup -data /var/lib/basalt -to /srv/basalt-backup
ExecStart=/usr/local/bin/basaltd verify -data /srv/basalt-backup
```

```ini
# basalt-backup.timer
[Unit]
Description=Nightly Basalt backup

[Timer]
OnCalendar=*-*-* 03:30
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now basalt-backup.timer
systemctl list-timers basalt-backup.timer
```

The same thing as one cron line, for a machine without systemd:

```
30 3 * * * /usr/local/bin/basaltd backup -data /var/lib/basalt -to /srv/basalt-backup && /usr/local/bin/basaltd verify -data /srv/basalt-backup
```

A backup on the same disk as the data is a copy, not a backup. Send the backup
directory somewhere else every night, after the verify. `rsync` is enough,
because the chunk tree is content-addressed: a body that is there is finished,
so an interrupted transfer resumes cleanly.

```
45 3 * * * rsync -a --delete /srv/basalt-backup/ offsite:/backups/basalt/
```

`--delete` is safe here because the backup directory never loses a body it
still needs, and it keeps the offsite copy from growing past the local one. Do
not point it at the live data directory: the database there is mid-write.

### Restore rehearsal

A backup nobody has restored is a rumour. CI runs these steps on every push,
against the built binary and a vault generated for the run: back up, lose the
original, copy the backup somewhere fresh, `verify -deep` it, check what it
holds against what `backup.json` claims, start a server on it, and read every
version and every chunk body back over a real socket. It is its own job, `the
restore rehearsal`, and `scripts/check.sh` runs it too.

What CI cannot rehearse is your copy: your offsite directory, your disk, your
rsync. Do the steps below by hand once, then once a year, on a machine or
directory that is not the live one:

1. Copy the offsite backup to a fresh directory:
   `rsync -a offsite:/backups/basalt/ /tmp/restore/`.
2. Check it against itself: `basaltd verify -deep -data /tmp/restore`. It must
   say `0 faults` over a non-zero number of references.
3. Compare its newest uid with the live server's: `basaltd stats -json` against
   both directories. The difference is what a real restore would lose, and it
   should be one night's work.
4. Start a server on it, on another port, with no devices pointed at it:
   `basaltd serve -data /tmp/restore -addr 127.0.0.1:3004`. Its startup line
   must say `claimed=true` and the uid from step 3.
5. Stop it and delete `/tmp/restore`.

Reading a note back over a real connection is the other check that matters, and
the one your own copy cannot get: a device cannot be aimed at the rehearsal
port, because the recovery key carries the server's address. By hand the
equivalent is the real restore below, at the address every paired device
already points at.

Step 2 is the one that pays for itself. A body that rotted in the offsite copy
is still there and still the right length, so a shallow verify walks past it;
`-deep` re-reads every body against its name, which for a content-addressed
store is complete for the bytes. It also decodes the device rows and invites
and counts them, because a copy that rotted one device's credential verifies
clean otherwise and leaves that device refused with `not authorised`. What it
cannot tell you is that the vault serves, the clause rule 11 turns on, or that
a credential is the *right* one.

For the real thing, the steps are the same with the live directory as the
destination:

```bash
systemctl stop basalt
mv /var/lib/basalt /var/lib/basalt.broken
rsync -a offsite:/backups/basalt/ /var/lib/basalt/
basaltd verify -deep -data /var/lib/basalt
systemctl start basalt
```

A device that has already seen versions newer than the backup is refused with
`code:"cursor"`. That is deliberate. Continuing would reissue version numbers
for different content and the two would silently diverge.

Both clients have the same way back. On the headless client it is `basalt
rebase --backup-taken`, which prints both cursors, rejoins from the server's,
and re-uploads what only that device holds as new versions, deleting nothing.
See [the client README](../client/README.md#commands). In the plugin it is
*Rejoin this server*, which appears in the panel only while that device is the
one being refused: the first press shows both versions and asks again, the
second does it.

Unlinking and pairing again also gets a device back on, and costs more than it
looks: re-pairing resets the merge base, so every note returns as a version with
no ancestor and the next edit made on two devices at once cannot merge. Prefer
the rebase, on either client.

### After a purge: the bodies the backup keeps

A backup never deletes. After you purge the live store, the next backup stops
referencing the purged bodies, but the directory still holds them and reports
them as retained history. That is the point of the backup, and also why the
directory only grows.

The honest answer on reclaiming that space: start a fresh backup directory
after a purge, keep the old one for as long as you might want the history it
holds, then delete it whole. There is no command that removes bodies from a
backup, on purpose, because a tool that deletes from the one copy of what was
purged is the tool that gets run with the wrong path.

`backup.json` is what tells the two directories apart. The old one says a
lower `purges` than the live store (`basaltd stats -json`) and a lower
`oldestUid` than the new one: it is the one with the history in it. Before the
old directory goes, in this order:

1. Take a backup into the fresh directory and read its `backup.json`. Its
   `purges` must equal the live store's and its `latestUid` must be at least
   the live store's newest uid.
2. `basaltd verify -deep -data /srv/basalt-backup-new`, and it must say
   `0 faults` over a non-zero number of chunk references and, on a vault
   anybody has paired with, a non-zero number of registry rows.
3. Only then delete the old directory whole. A script deciding this compares
   the two `backup.json` files and never has to open a database.

### Your notes are also plain files

An Obsidian vault is a directory of Markdown. Time Machine, restic, rsync, or a
git repository in the vault give you a readable copy that needs no Basalt and
no recovery key. If you only do one backup, do that one. The server backup is
what holds the history.

## Purge

Purge drops every version except the newest of each path and deletes the chunk
bodies nothing references any more. It is the only command that destroys
something no device holds, so it wants the vault's name typed again and proof
of a backup already holding everything it is about to drop.

```bash
systemctl stop basalt
basaltd backup -data /var/lib/basalt -to /srv/basalt-backup
basaltd purge -data /var/lib/basalt -confirm default -backup /srv/basalt-backup -grace 0
systemctl start basalt
```

Under Docker it needs the container stopped, so it cannot go through `docker
exec`: purge takes the data directory exclusively and refuses while a server
holds it. Run it as its own container against the same volume.

```bash
docker compose stop basalt
docker run --rm -v basalt_basalt-data:/data ghcr.io/waynehoover/basalt-sync:0.4.0 \
  backup -data /data -to /data/backup
docker run --rm -v basalt_basalt-data:/data ghcr.io/waynehoover/basalt-sync:0.4.0 \
  purge -data /data -confirm default -backup /data/backup -grace 0
docker compose start basalt
```

`-confirm` must be the vault's name exactly. `-backup` names a backup
directory; purge opens it and refuses unless its copy of the vault is at least
as new as the live one, by uid, and the success line says which backup it
checked and how far it reaches. `-no-backup-check`, typed in full, waives the
check and is printed in the report so the transcript says so too. A refused
purge deletes nothing.

It refuses to run while the server is up. By default it spares unreferenced
bodies written in the last hour, in case they belong to an interrupted upload;
on a server you just stopped nothing was in flight, so `-grace 0` is what
actually reclaims the space. A purge that spared anything says so on its own
line, with the count, the bytes left behind and the flag that would take them:

```
chunks 5 live, 0 deleted (0 B reclaimed), 2 spared as too recent to collect (22 B)
reclaimed nothing: spared 2 bodies (22 B) written within the last 1h0m0s, in case a push was interrupted mid-upload.
Nothing is in flight on a stopped server, and purge only runs on one, so re-run with -grace 0 to reclaim them.
```

Two other kinds of file the sweep walks past get their own line when there are
any, with their bytes, because both are space the purge did not reclaim:
quarantined bodies, which stay until a device resends the real chunk, and
unfinished uploads, which no grace collects at all.

If the sweep cannot finish, no chunk figures are printed. It stops at the first
thing in the tree it does not recognise, so its counts would describe how far
it got rather than what the vault holds. The versions line stays, because that
ran in a transaction that committed, and the error names the file to remove.

A deleted note's newest version is its deletion record, so purge removes its
content while the path stays listed as deleted. `basalt deleted` marks those
`(content purged)` and `stats` counts them separately.

### Locks

| | `serve` | `backup` | `verify` | `purge` |
|---|---|---|---|---|
| `server.lock` | exclusive | | | |
| `data.lock` | shared | shared | shared | exclusive |

Two servers on one directory is refused. Backup and verify run beside a live
server. Purge needs the directory to itself. Every refusal names the process in
the way and fails at once rather than waiting.

## What is in there

The numbers below are an example of the shape, not a measurement of anything.

```
$ basaltd stats
vault "default"
  1834 files, 212 folders, 61.2 MiB of notes as the devices see them
  17 deleted and still recoverable
  9120 versions in all, 22384 chunks referenced
  7057 of those versions are history, which purge would drop
  purge would reclaim 14.8 MiB in 8931 chunk bodies nothing still references
  newest uid 9120
21117 chunk bodies on disk
purge spares bodies newer than 1h0m0s unless -grace says otherwise
```

The numbers are separate rather than totalled, because a total does not say
whether a purge would help.

The reclaim line answers whether the ceremony below is worth starting. A
version count does not: seven thousand versions is four kilobytes or four
gigabytes. The same figure is on the startup line, so a restart says it whether
or not anybody runs `stats`, and it is the only figure here needing a walk of
the chunk tree, measured at 56 ms over ten thousand bodies.

It is a preview and nothing else. Nothing purges on a timer, nothing purges
while the server is up, and the number is a snapshot a later push can move. On
a server that has just stopped, every collectible body was written within the
grace window, so this line says so and names the bytes the window is holding
back rather than promising space the purge then spares.

`stats -json` prints the same numbers as one object, for scripts. The vaults
are an array:

```json
{ "version": "0.3.1", "bodies": 21117, "graceMs": 3600000,
  "vaults": [ { "vault": "default", "claimed": true, "files": 1834,
                "folders": 212, "bytes": 64193000, "deleted": 17,
                "recoverable": 17, "purged": 0, "versions": 9120,
                "history": 7057, "chunkRefs": 22384, "latestUid": 9120,
                "allocatedTo": 9120, "invites": 0,
                "reclaimBytes": 15518000, "reclaimBodies": 8931,
                "recentBytes": 0, "recentBodies": 0,
                "reclaimComplete": true } ] }
```

Again an example, not a measurement. Two of the fields are not guessable from
their names: `latestUid` is the newest version the vault still holds, and
`allocatedTo` is the highest uid ever handed out, including ones a purge has
since removed, so the two are equal until you purge and `allocatedTo` is the
one that never goes backwards.

`reclaimBytes` is the alertable form of the reclaim line, and `recentBytes`
what the grace window is holding back from it; the two are never summed for
you, because on a stopped server the first is zero and the second is the whole
figure. `reclaimComplete` is false when the chunk walk stopped early, and then
all four describe how far it got rather than what the vault holds: alert on
that field before the others, and run `basaltd verify` when it is false.

## What to alert on

There is no dashboard, on purpose. Seven things are worth a check from a cron
job or whatever watches your machines, all readable without a key.

| Signal | How to read it | What it means |
|---|---|---|
| Health failing | `basaltd health` exits non-zero | The server is down or not answering. systemd restarts it, and after five failures in five minutes gives up and marks the unit `failed`; `journalctl -u basalt` has the reason. |
| Cursor stuck | `latestUid` from `stats -json` unchanged for days while you have been writing | Devices are not reaching the server, or one device's `basalt status` shows a server cursor ahead of its own and nothing arriving. Check the device before the server. |
| Repeated `cursor` refusals | `journalctl -u basalt | grep 'code=cursor'` after a restore | Devices hold versions the restored server does not, expected after restoring an older backup. `basalt rebase --backup-taken` on the headless client, or *Rejoin this server* in the plugin panel, rejoins without losing what only that device holds. The log names the device. |
| `nospace` | `journalctl -u basalt | grep nospace` | The disk is full. Nothing is lost, uploads are refused until it is not. Purge after a backup, or give it a bigger disk. |
| A device with a wrong clock | `journalctl -u basalt \| grep 'timestamps from the future'` | That device is stamping notes with a date that has not happened. Nothing is at risk: history is ordered by arrival, merging is by content hash. Fix the clock on the device the line names. Reported once per connection. |
| A device you did not add | `journalctl -u basalt \| grep -E 'device registered\|invite redeemed'` | Somebody joined a device to the vault. Any device that has the vault can issue an invite, so this is what a compromised device adding another looks like, and why it cannot do so unseen. Match the log against `basalt devices` and `basalt revoke` a row you do not recognise. A `device auth failed` line beside it is a revoked device still trying. |
| A purge is worth running | `reclaimBytes` from `stats -json`, against how much disk you have | Old versions are holding space nothing needs. Start the ceremony because this said so rather than because uploads stopped and the row above fired. Check `reclaimComplete` first. |

The startup line is the other thing to grep for after a restart, with the same
made-up numbers as the example above:

```
msg=starting version=0.3.1 vault=default latest=9120 claimed=true reclaimable="14.8 MiB"
```

`latest` is the uid every device compares itself against. If a device says it
is behind that number and nothing arrives, that is the withholding
[design.md](design.md#what-the-server-can-and-cannot-do) says cannot be
detected by the protocol; it is detected by you, here.

`reclaimable` is what a purge would give back, and it is on this line because a
restart is when somebody is looking. It reads `the chunk walk stopped early;
run basaltd verify` when the walk could not finish, rather than a figure that
would describe how far it got.

## Rotating the vault secret

If a recovery key has been somewhere it should not have been, give the vault a
new secret. This is not how a lost device is answered: since protocol 4 each
device connects with a credential of its own, so a device is revoked on its own
with `basalt revoke ID`, and rotation is for the root itself.

Every vault has a data key wrapped under the root, so the root can change
without the history changing. Either client can do it, from any device that
still has the vault, and it takes the current recovery key on the command line
because no device holds one:

```bash
basalt rotate basalt3_...
```

In Obsidian it is *Replace the vault's secret* in the panel, behind a warning
and two presses. It matters that the plugin has this: the device somebody loses
is usually a phone, and so, often, is the only other one they have with them.

The server replaces the auth hash and the wrapped key in one transaction,
deletes every outstanding invite, and from then on only the new secret opens
the vault. The device that rotated prints the new recovery key, to write down
in place of the old.

**Every device keeps syncing.** A rotation replaces the vault's credential and
touches no device row, so re-pairing the laptop, the phone and the NAS is no
longer the price of retiring a leaked key. What a rotation does not do is
remove a device somebody else added: check `basalt devices` afterwards and
`basalt revoke` anything you do not recognise. Outstanding invites go because
an invite is a standing authority to add a device, which is the thing a
rotation exists to take away.

It does end what the old key could do to the device list. A revoke sent under a
retired root is refused with `rotated`, the same as a registration, which is
what stops whoever had the leaked key from answering the rotation by revoking
every device you have.

Nothing on the server is re-encrypted and no history is lost. It cannot unread
what was already read. [design.md](design.md#a-lost-or-stolen-device) says more.

There is nowhere on a device to stage a new root, because not holding one is
the point, so the durable copy is the one on paper and it goes there first.
`basalt rotate` prints the key before the request goes out and says to write it
down before pressing on; the plugin makes it first and puts it in the panel the
moment the call returns.

A lost reply is settled by asking: both clients try to open a session with the
new secret, which succeeds if and only if the server took it, and then say
which key to keep. Three answers: it committed and the new key is the vault's,
it did not and the old one still is, or the server could not be reached, in
which case keep both and run it again with whichever the server accepts.
`basalt rotate` exits non-zero on the last two.

If two devices rotate at once the loser is refused with `rotated`, nothing of
its rotation committed, and it is told to cross out the key it printed. No
device has to pair again either way.

## A data directory from before protocol 3

The 0.1 and 0.2 releases spoke protocols 1 and 2 and were withdrawn before
anyone deployed them. A vault claimed by one of those builds has no data key,
so this server refuses every session on it at hello, naming the reason. Start a
fresh data directory and pair the first device again. Your notes are on your
devices in plaintext; what does not carry over is the server's history of them.

## Phones

Android is in daily use over `tailscale serve`. A 320 file vault came down
byte-identical, and a note written on the desktop arrived in about 0.15 s.

Sync stops when the screen goes off, because Android suspends the app's
network. It resumes on its own and loses nothing, but a first sync of a large
vault needs the screen on until it is finished.

The server allows the browser origins Obsidian uses: `app://obsidian.md` on
desktop, `capacitor://localhost` and `http://localhost` on mobile. If a future
build connects from somewhere else, the refusal is logged with the flag that
would admit it:

```bash
journalctl -u basalt | grep 'accept refused'
basaltd serve -allow-origin capacitor://localhost
```

## Reference

### serve

| flag | default | |
|---|---|---|
| `-addr` | `:3003` | listen address |
| `-localhost` | off | bind to loopback and print a `ws://` address, for one machine |
| `-vault` | `default` | the one vault this server serves |
| `-max-file` | 64 MiB | largest file to accept, up to 256 MiB |
| `-max-batch-bytes` | 16 MiB | most bytes one `putmany` may carry; can be lowered, not raised, and never below one chunk |
| `-max-fetch-bytes` | 64 MiB | most body bytes one `fetch` may ask for, between one chunk and 256 MiB |
| `-allow-origin` | none | an extra browser origin, repeatable |
| `-v` | off | verbose logging |

Each vault accepts eight simultaneous devices. More are refused with
`code:"busy"`, which says come back later. A vault may also have eight devices
*registered*, and the ninth registration is refused with `code:"full"`, which
waiting never clears: `basalt revoke` a device you no longer use. The two are
deliberately the same number, so a vault cannot register a device it could
never connect.

`-max-file` is bounded by the sending device's memory, not by anything the
server pays. The headless client streams large files and stays under 300 MB at
256 MiB. The plugin cannot stream on every platform and costs roughly 210 MB
plus 2.7 MB per MiB. The default is set for a phone. Raise it if your large
files only ever move through the headless client. It is in bytes, with no
suffixes: 128 MiB is `-max-file 134217728`.

Lowering it below a file already in the vault would leave that file unreachable
to a device paired afterwards, which would report the vault synced without it,
so `serve` refuses to start under a ceiling below a live file it holds, and
names the uid and size of each. Superseded versions and deleted files over the
ceiling do not count, because no device asks for them on a first sync.

You can reach that refusal without touching a flag: restore a backup taken
before the large file was deleted and it is live again under a ceiling below
it. The only remedy is then the flag, because a device deletes by pushing an
entry and there is nothing running to push to, and purge keeps the newest
version of every path. Raising it loses nothing, since the file is already
there. To bring the ceiling back down: raise, start, delete or shrink the file
on a device, wait for that to reach the server, stop, lower.

So the flag has to be reachable wherever the server runs. `basaltd service
-max-file N` writes it into the unit, and refuses to print a unit whose ceiling
is below a file the data directory already holds, so you find out here rather
than from the journal. Under Docker it goes in the command:

```yaml
command: ["serve", "-addr", "0.0.0.0:3003", "-max-file", "134217728"]
```

On a wildcard bind such as `:3003`, the printed address names this machine's
interfaces rather than `0.0.0.0`, which a device cannot connect to.

### Ceilings

Every one of these is advertised in `ready` or enforced at the door, and a
request over one is refused with a code rather than dropped. The constants live
next to their reasoning in the source; these are the numbers.

| | | |
|---|---|---|
| file | 64 MiB by default, `-max-file` up to 256 MiB | `perFileMax` |
| chunk body | 1 MiB | `chunkMax` |
| chunks per entry, per fetch | 65536 | `maxChunks` |
| encrypted path | 4096 bytes | |
| entries per `putmany` | 256 | |
| one `putmany`, frame and summed budget | 16 MiB | `maxBatchBytes` |
| bodies one `fetch` may ask for | 64 MiB | `maxFetchBytes` |
| one frame, after hello | 32 MiB | twice the largest legal message, so every legal one is read and refused with a code |
| one frame, before hello | 64 KiB | a hello is a few hundred bytes |
| devices registered on a vault | 8 | the ninth registration is refused with `full`, which no waiting clears |
| devices connected at once | 8 | refused with `busy`, `retryAfterMs` 30 s |
| connections waiting to say hello | 32 in all | refused with `busy` |
| shutting down | | every idle session gets `busy`, `retryAfterMs` 5 s |
| time allowed to say hello | 10 s | closed with `protostate` |
| `vault` and `device` names | 64 bytes, no control characters | `badname`, ends the session |
| wrapped data key, sealed invite | 256 bytes of base64url | |
| invite lifetime | 10 minutes by default, 1 hour at most | |
| deletions per `deleted` list | 1000, with `more` | |

### backup, verify, purge, stats

| flag | on | |
|---|---|---|
| `-to DIR` | backup | destination, required |
| `-deep` | backup, verify | re-read every body against its name, and decode every device row and invite |
| `-vault` | purge | which vault (default `default`) |
| `-confirm VAULT` | purge | the vault's name again, exactly; required |
| `-backup DIR` | purge | a backup that must hold the vault up to its newest uid; required unless the check is waived |
| `-no-backup-check` | purge | waive the backup check, typed in full |
| `-grace` | purge | spare unreferenced bodies newer than this (default `1h`) |
| `-json` | stats | one JSON object instead of prose |

### service, health

| flag | on | |
|---|---|---|
| `-addr`, `-vault` | service | what the unit should run with |
| `-max-file` | service | the file ceiling to write into the unit, in bytes |
| `-user` | service | user to run as (default: you) |
| `-binary` | service | path to the binary (default: this one) |
| `-addr` | health | server to ask (default `127.0.0.1:3003`) |
| `-timeout` | health | how long to wait (default `5s`) |

`health` does a GET on `/health`. It exists so the container has a healthcheck
without a shell or curl in the image.

### version

`basaltd version` prints the version, platform and Go toolchain. The server
logs it on startup, on the same line as the served vault's latest uid and
whether it is claimed, and advertises it to every device in `ready` as
`serverVersion`. Nothing that has not authenticated learns it: see
[design.md](design.md#what-a-stranger-on-the-port-learns).
