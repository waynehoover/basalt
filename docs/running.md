# Running it

One binary on a machine that stays on, and a plugin on each device.

## The server

`scripts/release.sh` builds static binaries for linux/amd64, linux/arm64 and
both macOS architectures. They need nothing on the machine they land on: pure-Go
SQLite is what makes `CGO_ENABLED=0` work, and that is the whole reason to
insist on it.

```
scp release/basalt-linux-amd64 homelab:/usr/local/bin/basalt
ssh homelab
sudo mkdir -p /var/lib/basalt && sudo chown $USER /var/lib/basalt
basalt service -data /var/lib/basalt -addr 127.0.0.1:3003
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

The token it prints on first run is in the journal:

```
journalctl -u basalt | grep '#'
```

That token is a bootstrap. The first device claims the vault with it and it
stops working; see `docs/protocol.md`.

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
basalt backup -data /var/lib/basalt -to /backups/basalt
```

Purge deletes chunk bodies, so it takes the data directory exclusively and will
refuse while the server is running. That refusal is the point.

```
systemctl stop basalt && basalt purge -data /var/lib/basalt && systemctl start basalt
```

Purge spares unreferenced bodies written in the last hour, in case they belong
to a push that had not committed. On a server you stopped yourself nothing was
in flight, so `-grace 0` is what actually reclaims the space.

## The plugin

`release/plugin/` is the folder Obsidian wants.

```
scp -r release/plugin/ vault/.obsidian/plugins/basalt/
```

Then enable it in community plugins. On the first device, open it from the
ribbon, choose "Start a new vault", and give it the address and the token from
the journal. On every device after that, paste the pairing string.

## What to check on a phone

Obsidian mobile has no status bar, so the plugin's state is on the ribbon icon's
tooltip instead. Everything else is the same.

The one thing that may need a change on the server: it refuses a browser origin
it does not recognise, and the mobile origins it knows are Capacitor's
documented defaults, never checked against a device. If a phone will not
connect, the plugin's own window says what its origin is, and the server logs
the same thing:

```
journalctl -u basalt | grep 'accept refused'
```

Add it and restart:

```
basalt serve -data /var/lib/basalt -allow-origin capacitor://localhost
```

## Version

```
basalt version
```

Also the first line the server logs at startup, so the journal on every machine
says what is running there.
