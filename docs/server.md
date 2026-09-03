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

The image is the binary on an empty filesystem: about 5 MB to pull, 12 MB on
disk, no shell, nothing to update. `latest` is for trying it out; pin the tag
and its digest for a server you keep, the way `compose.yaml` does, so a pull
cannot move you to an image nobody tested against your devices.

```bash
docker run -d --name basalt -p 127.0.0.1:3003:3003 \
  -v basalt-data:/data ghcr.io/waynehoover/basalt-sync:latest
docker logs basalt
```

Or `docker compose up -d` with the `compose.yaml` in this repository, which
also runs read-only with every capability dropped.

Publish to `127.0.0.1`, not every interface. There is no TLS in the binary, so
only the thing terminating TLS should be able to reach it.

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
root, and you should be able to read what you are about to run as root. The
unit is hardened: `ProtectSystem=strict`, an empty capability set, a syscall
filter, and address families limited to sockets. `ProtectHome` is added only
when the data directory is outside a home directory, since otherwise it would
stop the server starting.

The server's own releases are tagged `server/vX.Y.Z`. The plugin is released
separately, on bare version tags, because the two move on different clocks. A
client and server that disagree on the protocol version refuse each other by
name, so a mismatch never half-works.

### Upgrade order

The server first, then each client. The handshake carries the range of
protocol versions a server speaks, and a device outside it is refused at hello
with both numbers and the server's version, which is the message to read as
"upgrade the server".

Today that range is one version wide. Protocol 3 is the only protocol: the two
before it were removed rather than carried, because nothing had been deployed
under them and a compatibility path nobody would use is a second set of code
paths through the part of the system that must not be wrong. The range stays in
the handshake for the next version, whose compatibility gets written then,
against a protocol 3 that has actually run.

| Release | Protocol | Notes |
|---|---|---|
| plugin, `basalt` and `basaltd` 0.1.x and 0.2.x | 1 and 2 | withdrawn before deployment; a data directory from one of these cannot be served |
| current | 3 | request ids, retryable errors, the data key, invites |

The plugin, the headless client and the server are released on their own tags
and move on their own clocks, and the protocol version is what decides whether
two of them can talk. Every plugin release needs Obsidian 1.7.2 or newer
(`versions.json`).
`basaltd version` prints the server's release, and the plugin's is in its
manifest.

## TLS

None in the binary, on purpose. No key material lives here. Bind to localhost
and put something in front. Two arrangements are known to work.

### Tailscale

```bash
tailscale serve --bg 3003
```

Then devices pair against `wss://<machine>.<tailnet>.ts.net`. A bare hostname
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

The whole line is pasted as is, into the plugin's *Setup string* field or as
the argument to `basalt init`. The addresses are this machine's interfaces. If
TLS terminates elsewhere, put that hostname in front of the `#`, as the second
line shows.

The first device then shows the vault's recovery key once. Write it down and
keep it offline: it is the whole vault, and this server has never seen it and
cannot reissue it. Every device after the first is added with an invite from a
device that has the vault, `basalt invite` or *Add another device* in the
plugin, which works once and expires after ten minutes; the recovery key is
never needed to add a device. The server stores an invite as an identifier and
a blob it cannot open, and deletes every outstanding invite on `basalt rotate`.

The token is one-time. The first device claims the vault with it and generates
the root secret. From then on the server accepts only a key derived from that
secret, which it stores as a hash. Once claimed, the server stops printing the
token and says to pair further devices from one that already has the vault.

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

A run replaces the previous backup only at the very end. The new snapshot is
staged under a temporary name, its bodies are copied and the whole thing is
verified, and only then is the snapshot renamed over the last good database and
the directory flushed to disk. So a run that fails partway, for a missing body,
a full disk, or a crash, leaves the previous backup exactly as it was: it still
opens and still verifies, and the failed run has changed none of what it needs.
When the backup holds more bodies than the source, the report says so as
history it kept rather than as bodies that were not copied. Stale bodies are
never deleted. Once the source purges old versions the next
snapshot stops referencing their bodies, but those bodies are the history the
backup exists to keep and the source no longer has them, so they are retained
and the report says how many. The token is written the same careful way as
everything else it protects: to a private temporary file, flushed, renamed into
place, and read back to confirm both its contents and its `0600` mode, so a
crash cannot leave it half written and a restore cannot inherit a world-readable
credential.

**The backup is ciphertext.** Restoring it needs the vault's root secret, which
lives on your devices and in the pairing string. Keep the pairing string
somewhere other than the backup. The command reminds you every time because no
command can check it.

What a server backup is for:

| | |
|---|---|
| The server's disk dies | Your devices hold the current notes. The history is only in the backup. |
| A note deleted months ago | Only the server has it. |
| Every device is lost or wiped | Backup plus pairing string is the only way back. |

Run it nightly from a timer, ideally to two places. Add `-deep` monthly: it
re-reads every body already in the destination to catch bit rot.

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

A backup nobody has restored is a rumour. Once, and then once a year, on a
machine or directory that is not the live one:

1. Copy the offsite backup to a fresh directory:
   `rsync -a offsite:/backups/basalt/ /tmp/restore/`.
2. Check it against itself: `basaltd verify -deep -data /tmp/restore`. It must
   say `0 faults` over a non-zero number of references.
3. Compare its newest uid with the live server's: `basaltd stats -json -data
   /tmp/restore` and the same against the live data directory. The difference is
   what a real restore would lose, and it should be one night's work.
4. Start a server on it, on another port, with no devices pointed at it:
   `basaltd serve -data /tmp/restore -addr 127.0.0.1:3004`. It must print its
   startup line with `claimed=true` and the uid from step 3.
5. Point one device at it with a copy of the pairing string, read a note back,
   and check the history of a file. Then unlink that device from the rehearsal
   server, so it does not carry a cursor that is ahead of the live one.
6. Stop it and delete `/tmp/restore`.

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

On the headless client the way back is `basalt rebase --backup-taken`, which
prints both cursors, rejoins from the server's, and re-uploads what only that
device holds as new versions, deleting nothing. See
[the client README](../client/README.md#commands). The plugin has no rebase,
so a plugin device is unlinked and paired again; its notes are on the device
and come back as new versions either way.

### After a purge: the bodies the backup keeps

A backup never deletes. After you purge the live store, the next backup stops
referencing the purged bodies, but the backup directory still holds them, and
reports them as retained history. That is the point of the backup and it is
also why the directory only grows.

The honest answer on reclaiming that space: start a fresh backup directory
after a purge, and keep the old one for as long as you might want the history
it holds, then delete it whole. There is no command that removes bodies from a
backup, on purpose, because a tool that deletes from the one copy of what was
purged is the tool that gets run with the wrong path.

### Your notes are also plain files

An Obsidian vault is a directory of Markdown. Time Machine, restic, rsync, or a
git repository in the vault give you a readable copy that needs no Basalt and
no recovery key. If you only do one backup, do that one. The server backup is
what holds the history.

## Purge

Purge drops every version except the newest of each path and deletes the chunk
bodies nothing references any more. It is the only command that destroys
something no device holds, so it wants the vault's name typed again and proof
of a backup that already holds everything it is about to drop.

```bash
systemctl stop basalt
basaltd backup -data /var/lib/basalt -to /srv/basalt-backup
basaltd purge -data /var/lib/basalt -confirm default -backup /srv/basalt-backup -grace 0
systemctl start basalt
```

Under Docker the same thing needs the container stopped, so it cannot go
through `docker exec`: purge takes the data directory exclusively and refuses
while a server holds it. Run it as its own container against the same volume.

```bash
docker compose stop basalt
docker run --rm -v basalt_basalt-data:/data ghcr.io/waynehoover/basalt-sync:0.3.0 \
  backup -data /data -to /data/backup
docker run --rm -v basalt_basalt-data:/data ghcr.io/waynehoover/basalt-sync:0.3.0 \
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
bodies written in the last hour, in case they belong to an upload that was
interrupted. On a server you just stopped nothing was in flight, so `-grace 0`
is what actually reclaims the space.

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
  newest uid 9120
21117 chunk bodies on disk
purge spares bodies newer than 1h0m0s unless -grace says otherwise
```

The numbers are separate rather than totalled, because a total does not say
whether a purge would help.

`stats -json` prints the same numbers as one object, for scripts. The vaults
are an array, so the shape is worth having in front of you:

```json
{ "version": "0.3.0", "bodies": 21117, "graceMs": 3600000,
  "vaults": [ { "vault": "default", "claimed": true, "files": 1834,
                "folders": 212, "bytes": 64193000, "deleted": 17,
                "recoverable": 17, "purged": 0, "versions": 9120,
                "history": 7057, "chunkRefs": 22384, "latestUid": 9120,
                "allocatedTo": "laptop", "invites": 0 } ] }
```

The numbers above are an example, not a measurement of anything.

## What to alert on

There is no dashboard, on purpose. Four things are worth a check from a cron
job or whatever watches your machines, all readable without a key.

| Signal | How to read it | What it means |
|---|---|---|
| Health failing | `basaltd health` exits non-zero | The server is down or not answering. systemd restarts it; if it keeps failing, `journalctl -u basalt` has the reason. |
| Cursor stuck | `latestUid` from `stats -json` unchanged for days while you have been writing | Devices are not reaching the server, or one device's `basalt status` shows a server cursor ahead of its own and nothing arriving. Check the device before the server. |
| Repeated `cursor` refusals | `journalctl -u basalt | grep 'code=cursor'` after a restore | Devices hold versions the restored server does not, which is the expected state after restoring an older backup. On the headless client, `basalt rebase --backup-taken` rejoins without losing what only that device holds. The plugin has no rebase, so those devices are unlinked and paired again. The log names the device. |
| `nospace` | `journalctl -u basalt | grep nospace` | The disk is full. Nothing is lost, uploads are refused until it is not. Purge after a backup, or give it a bigger disk. |

The startup line is the other thing to grep for after a restart:

```
msg=starting version=0.3.0 vault=default latest=9120 claimed=true
```

`latest` is the uid every device compares itself against. If a device says it
is behind that number and nothing arrives, that is the withholding
[design.md](design.md#what-the-server-can-and-cannot-do) says cannot be
detected by the protocol; it is detected by you, here.

## Rotating the vault secret

Every device holds the same root secret, and that secret is also the
credential. There is no per-device revocation. If a pairing string has been
somewhere it should not have been, give the vault a new secret.

Every vault has a data key wrapped under the root, so the root can change
without the history changing. Rotation is a headless-client command; the
plugin has no rotate, so run it from a machine with the CLI paired to the
vault:

```bash
basalt rotate
```

The server replaces the auth hash and the wrapped key in one transaction,
deletes every outstanding invite, closes every other device's session with
`code:"auth"`, and from then on only the new secret opens the vault. The device
that rotated prints the new recovery key, to write down in place of the old
one, and every other device is added again with a fresh `basalt invite`.
Nothing on the server is re-encrypted and no history is lost. It cannot unread
what was already read. [design.md](design.md#a-lost-or-stolen-device) says more.

The new secret is written into the device's config before the request goes out,
so a reply lost on the way cannot leave a vault whose new root nobody holds.
`basalt rotate` prints the key and exits non-zero if that happens, saying it may
have committed; the next `basalt sync` here tries the new secret first and
settles which one the vault has. Keep both keys until it has. If two devices
rotate at once, one is refused with `rotated` and pairs again with the string
the other printed.

## A data directory from before protocol 3

The 0.1 and 0.2 releases spoke protocols 1 and 2 and were withdrawn before
anyone deployed them. A vault claimed by one of those builds has no data key,
and this server refuses every session on it at hello, naming the reason, rather
than serving it under a key schedule that no longer exists. Start a fresh data
directory and pair the first device again. Your notes are on your devices in
plaintext; what does not carry over is the server's history of them.

## Phones

Android is in daily use over `tailscale serve`. A 320 file vault came down
byte-identical, and a note written on the desktop arrived in about 0.15 s.

Sync stops when the screen goes off, because Android suspends the app's
network. It resumes on its own and loses nothing, but a first sync of a large
vault needs the screen on until it finishes.

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
`code:"busy"`.

`-max-file` is bounded by the sending device's memory, not by anything the
server pays. The headless client streams large files and stays under 300 MB at
256 MiB. The plugin cannot stream on every platform and costs roughly 210 MB
plus 2.7 MB per MiB. The default is set for a phone. Raise it if your large
files only ever move through the headless client. Lowering it below a file
already in the vault leaves that file unreachable to a new device.

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
| devices per vault | 8 | refused with `busy`, `retryAfterMs` 30 s |
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
| `-deep` | backup, verify | re-read every body and check it against its name |
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
| `-user` | service | user to run as (default: you) |
| `-binary` | service | path to the binary (default: this one) |
| `-addr` | health | server to ask (default `127.0.0.1:3003`) |
| `-timeout` | health | how long to wait (default `5s`) |

`health` does a GET on `/health`. It exists so the container has a healthcheck
without a shell or curl in the image.

### version

`basaltd version` prints the version, platform and Go toolchain. The server
logs the version on startup, on the same line as the served vault's latest uid
and whether it is claimed, and advertises it to every device in `ready` as
`serverVersion`.
