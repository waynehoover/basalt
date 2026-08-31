# Running it

[Docs index](index.md)

One binary on a machine that stays on, and a plugin on each device.

## Docker

The image is a single static binary on an empty filesystem: 11 MB, no shell, no
package manager, nothing to update. Pure-Go SQLite is what makes
`CGO_ENABLED=0` work and `CGO_ENABLED=0` is what makes `scratch` possible.

```
docker compose up -d
docker compose logs basalt
```

The log holds the pairing string for the first device. It is a bootstrap: the
first device claims the vault with it and it stops working afterwards, so the
server stops printing it and says the vault is claimed instead. Adding a device
after that is done from a device that already has the vault, not from here.

`compose.yaml` publishes to `127.0.0.1:3003` rather than to every interface,
because there is no TLS in this binary and something in front should be the only
thing that can reach it. It also runs read-only with every capability dropped,
which is checked rather than assumed: the server starts and stays healthy under
`--read-only --cap-drop ALL --security-opt no-new-privileges`.

The healthcheck runs `basaltd health` from inside the image, because there is no
curl in there to write one with and adding a base image to get one would undo
the point.

Maintenance goes through the same binary:

```
docker exec basalt /basaltd stats
docker exec basalt /basaltd verify -deep
docker exec basalt /basaltd backup -data /data -to /data/backup
```

Purge needs the directory to itself, so the server steps aside:

```
docker compose stop basalt
docker run --rm -v basalt_basalt-data:/data \
  ghcr.io/waynehoover/basalt-sync:latest purge -data /data -grace 0
docker compose start basalt
```

### Volumes and who owns them

A named volume works with nothing else done: Docker initialises it from the
image, and the image ships `/data` owned by the unprivileged user the server
runs as. A bind mount does not, because the host directory's ownership wins:

```
sudo chown -R 65532:65532 /srv/basalt
```

That was found by running the image rather than by reading it. Without the
ownership the server cannot write its lock file and the container exits.

## Without Docker: the server

If you would rather not run a container, take a binary from a
[server release](https://github.com/waynehoover/basalt-sync/releases?q=server),
which is tagged `server/vX.Y.Z` and is separate from the plugin's releases
because the two move on their own clocks. `scripts/release.sh` builds the same
binaries locally, into `release/server/`.

There is one for linux/amd64, linux/arm64 and both macOS architectures, and they
need nothing on the machine they land on: pure-Go SQLite is what makes
`CGO_ENABLED=0` work, and that is the whole reason to insist on it.

```
scp release/server/basaltd-linux-amd64 homelab:/usr/local/bin/basaltd
ssh homelab
sudo mkdir -p /var/lib/basalt && sudo chown $USER /var/lib/basalt
basaltd service -data /var/lib/basalt -addr 127.0.0.1:3003
```

That prints a systemd unit with the real paths already in it, and the commands
to install it underneath. It is printed rather than written: putting something
in `/etc` needs root, and a program that asks for root to do a thing you could
read first is one that gets run as root for the rest of its life.

The unit is hardened, because this process holds every note you have and needs
one directory and one socket. `ProtectSystem=strict`, an empty
`CapabilityBoundingSet`, `SystemCallFilter=@system-service`, and address
families limited to what a socket needs. `ProtectHome` goes on only when the
data directory is not inside a home directory, since otherwise the most
obviously correct hardening line is the one that stops the server starting.

The pairing string it prints on first run is in the journal:

```
journalctl -u basalt
```

That token is a bootstrap. The first device claims the vault with it and it
stops working, and the server then prints that the vault is claimed rather than
printing a string that would fail. See `docs/protocol.md`.

## TLS

There is none here, on purpose: no key material lives in this binary. Bind it to
localhost and put something in front.

```
tailscale serve --bg 3003
```

Then pair devices against `wss://<machine>.<tailnet>.ts.net`. `basalt pair`
accepts a bare hostname and assumes `wss://`, because the plain case is the one
worth being explicit about.

## Backups and purges, and which needs the server stopped

Backup only reads, so it runs against a live server. Put it on a timer from the
first day.

```
basaltd backup -data /var/lib/basalt -to /backups/basalt
```

Purge deletes chunk bodies, so it takes the data directory exclusively and will
refuse while the server is running. That refusal is the point.

```
systemctl stop basalt && basaltd purge -data /var/lib/basalt && systemctl start basalt
```

Purge spares unreferenced bodies written in the last hour, in case they belong
to a push that had not committed. On a server you stopped yourself nothing was
in flight, so `-grace 0` is what actually reclaims the space.

## The plugin

`release/plugin/` is the folder Obsidian wants.

```
scp -r release/plugin/ vault/.obsidian/plugins/basalt-sync/
```

Then enable it in community plugins. On the first device, open it from the
ribbon, choose "Start a new vault", and give it the address and the token from
the journal. On every device after that, paste the pairing string.

## On a phone

Run on Android 17, a Pixel 9 Pro XL, against a server behind `tailscale serve`.
What it did:

- Loaded and enabled from `<vault>/.obsidian/plugins/basalt-sync/`.
- Paired over `wss://` through Tailscale's TLS, with the Capacitor origin the
  server already allows.
- Pulled a whole vault down: 320 files, 25 MiB, every one byte-identical to the
  desktop's copy.
- Took a note written on the desktop in about **0.15 seconds**, and a deletion
  after it, which went to the vault's `.trash` rather than away.

**Sync stops when the screen goes off.** Android's doze suspends the app's
network, the connection drops, and nothing moves until the phone is awake again.
It resumes on its own and loses nothing, but a first sync of a large vault will
not finish in a pocket: leave the screen on until it has. This is the platform
rather than the plugin, and Obsidian's own sync has the same shape.

The origins the server accepts are Capacitor's documented defaults, and they
worked here as they stand. If some future version of the app connects from
somewhere else the server logs what it refused:

```
journalctl -u basalt | grep 'accept refused'
basaltd serve -data /var/lib/basalt -allow-origin capacitor://localhost
```

Obsidian mobile has no status bar, so the plugin's state is on the ribbon icon's
tooltip instead. Everything else is the same.

## What is in there

```
basaltd stats
```

Files, folders, deletions still recoverable, versions in all, and how many of
those versions are history a purge would drop. Separate numbers rather than a
total, because a total does not tell you whether a purge would help.

## Commands and flags

Every command takes `-data`, the directory holding the database, chunk bodies and
the auth token. It defaults to `~/.basalt`, and only `serve` will create one:
the others refuse a path that is not already a data directory, because a mistyped
path used to be created on the spot and the backup then succeeded, of nothing.

| | |
|---|---|
| `basaltd serve` | run the server. The default command, so bare `basaltd` is this |
| `basaltd backup -to DIR` | copy everything, verified, while the server runs |
| `basaltd verify` | check the store against itself |
| `basaltd purge` | reclaim space from unreferenced bodies |
| `basaltd stats` | what the vault holds |
| `basaltd service` | print a hardened systemd unit |
| `basaltd health` | ask a running server if it is well, for a container probe |
| `basaltd version` | what this binary is |

### serve

| flag | default | |
|---|---|---|
| `-addr` | `:3003` | listen address |
| `-localhost` | off | bind to loopback and print a `ws://` string, for trying it on one machine |
| `-vault` | `default` | the one vault this server serves |
| `-max-file` | 67108864 (64 MiB) | largest file to accept |
| `-allow-origin` | none | an extra browser origin, repeatable |
| `-v` | off | verbose logging |

`-max-file` is bounded by what the sending device can hold, not by anything the
server pays, and the two clients differ.

The headless client streams: it reads a large file in blocks to name it and in
ranges to send it, so memory is nearly flat and a 256 MiB attachment costs it
about 290 MB. The plugin cannot, because Obsidian's adapter hands over whole
files and offers nothing else, so it costs about 210 MB plus 2.7 MB per MiB:
430 MB at 64 MiB, about 900 MB at 256.

The default is set for the weaker of the two and for a phone that has never been
tested. Raise it as far as 256 MiB if the large files in your vault are only ever
moved by the headless client. The ceiling holds whatever you pass, because that
is what the store will accept.

One caveat if you ever lower it: a client also refuses to *download* a version
larger than what the server advertises, so lowering the limit below a file
already in the vault leaves that file unreachable on a new device. Raising it is
always safe.

On a wildcard bind, which is what `:3003` and `0.0.0.0:3003` both mean, the setup
string names the addresses of this machine's interfaces rather than the bind
address. A bind address is not an address: pasting `0.0.0.0:3003` into a device
asks it to connect to nothing at all, and the failure looks exactly like a server
that is down.

`-localhost` is for trying this out on one machine. It binds to loopback and
prints a string with `ws://` on the front, because a pairing string with no
scheme becomes `wss://`, which is right behind a tunnel and wrong for a server
with no TLS in front of it.

`-allow-origin` is for a browser client whose origin is not one of the three
built in. A refused handshake logs the origin it refused and this flag, so the
answer is in the log rather than in this document.

### backup, verify, purge

| flag | on | |
|---|---|---|
| `-to DIR` | backup | where to copy to, required |
| `-deep` | backup, verify | re-read every body and check it against its name |
| `-grace` | purge | spare unreferenced bodies written this recently (default 1h) |
| `-vault` | purge | which vault to purge (default `default`) |

`docs/backup.md` covers what each of these saves you from and which needs the
server stopped.

### service and health

| flag | on | |
|---|---|---|
| `-addr`, `-vault` | service | what the generated unit should use |
| `-user` | service | user to run as, defaulting to whoever runs it |
| `-binary` | service | path to the binary, defaulting to this one |
| `-addr` | health | the server to ask (default `127.0.0.1:3003`) |
| `-timeout` | health | how long to wait (default 5s) |

## Version

```
basaltd version
```

Also the first line the server logs at startup, so the journal on every machine
says what is running there.
