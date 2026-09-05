# The plugin

[Back to the README](../README.md)

Basalt Sync runs inside Obsidian on desktop and mobile. It needs Obsidian 1.7.2
or newer. It has no settings tab: one panel, opened from the ribbon icon, that
pairs a vault and says what is happening.

Every row in that panel is a label and one line. Three of them are on screen
when it opens, because they are what somebody opens it for: *Sync now*, *Add
another device*, *Recover a deleted note*. The four that are rare and mostly
irreversible are behind *Manage this vault*, one disclosure that starts closed:
*Devices*, *Recovery key*, *Replace the vault's secret*, *Unlink this vault*.
*Rejoin this server* appears on the panel itself, and only when a restored
server has refused this device.

Where a line cannot carry the whole answer there is a small **?** beside the
section, which Obsidian shows on hover. The rest is this page, and the panel
links to it.

## Install

Not yet in the community directory. Put `main.js`, `manifest.json` and
`styles.css` from the [latest release](https://github.com/waynehoover/basalt-sync/releases/latest)
into `<vault>/.obsidian/plugins/basalt-sync/`, then enable Basalt Sync under
Community plugins.

Every release asset is rebuilt in CI and attested. To check one:

```bash
gh attestation verify main.js --repo waynehoover/basalt-sync
```

## Pairing

Click the Basalt icon in the ribbon, or run **Basalt Sync: Show status**.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/pairing-dark.png">
  <img src="assets/screenshots/pairing.png" alt="The pairing panel: device name and an invite or the vault's recovery key to join a vault, or the server's setup string to start a new one." width="720">
</picture>

**The first device** pastes the line the server printed on its first run into
*Setup string*, under *Start a new vault*. It looks like
`192.168.1.20:3003#K7M2PQR4-...`. If TLS is in front, put that hostname before
the `#` instead: `wss://homelab.tailnet.ts.net#K7M2PQR4-...`. The plugin
generates the vault's root secret, claims the vault, and shows the recovery key
once, under *Write this down*. Write it down and keep it offline: it is the
whole vault, past and future, and the server has never seen it and cannot
reissue it. Adding a device does not need it: an invite does that.

**Every other device** is added with an invite. On a device that already has
the vault, press *Create invite* under *Add another device*; the string is
shown in the panel and copied to the clipboard where there is one. Paste it
into *Invite or recovery key* on the new device and press *Pair*. An invite
works once, lasts ten minutes, and carries no root secret: it hands the new
device the vault's data key and registers a credential of its own for it, which
the *Devices* row can cut off without touching any other device.

The recovery key works in the same field, and is what to use when no device is
left to make an invite from. It is not the ordinary way in on purpose: it is
written down and offline, and adding a phone should not mean going to get it.
That an invite carries the data key rather than the root is what makes revoking
one device mean something; [design.md](design.md#a-lost-or-stolen-device) has
the reasoning.

*Recovery key* in a paired panel is a sentence rather than a button, under
*Manage this vault*: "Written down, not kept here. An invite adds a device, not
this." The key was shown once, this device does not have it, and a device that
did could register itself again after being revoked, so revoking would stop
nothing. That last part is on the **?** beside the disclosure.

*Pair* reaches the server before it says paired, so a mistyped string is
refused on the spot and nothing is left behind. An invite is spent by the
exchange that registers the device, so nothing is written here until the server
has answered, and the recovery key path is the same: it registers first and
saves what came back. *Start a new vault* is the one that saves first, because
that handshake is what claims the vault and the secret has to be on disk before
the server binds to it; if the server then refuses, the notice says so and
offers unlink.

**A pairing that never registered a device** stops rather than retrying. That
is what is left if a vault was claimed and the registration after it failed,
and there is nothing the plugin can do about it that a person cannot see: the
panel shows the vault's recovery key, which may be the only copy of it, and
says to write it down, unlink and pair again with it.

The device name comes filled in, with what kind of machine this is and four
random characters: `mac-3f2a`, `android-91c7`, `ipad-0b55`. Type over it with
whatever you call this device: that replaces the whole suggestion, tail and
all, the way `--device` does on the command line. The tail is why two Macs left
at the suggestion do not share a name, and a name is worth having because it is
what a row in *Devices* says, what version history shows against a version, and
what a conflict copy is named after. `basalt` does the same thing with the
machine's hostname.

The pairing is stored in the plugin's own `data.json`: this device's id, the
secret it connects with, and the vault's data key, all in the clear. The root
secret is not among them, which is what makes the *Devices* row below mean
something. The data key being there is inherent: the device has to decrypt the
vault without asking anyone. It is the same exposure as any password manager's
local store, and it is why revoking a device does not unread what it already
read.

## What it does

The plugin syncs when you change something, after a 400 ms pause, and does a
full pass every 30 seconds. A quiet vault costs about a millisecond per pass
because Obsidian already keeps the file list in memory. When the connection
drops it reconnects with backoff and picks up where it left off. A server that
says it is busy, because the vault has eight devices connected or because it is
shutting down, is treated the same way: offline, then a retry after the wait
the server suggested. Only a refusal that would repeat word for word stops it.

The panel shows the local cursor and the server cursor. A device that is behind
and stays behind while nothing arrives is the one thing the protocol cannot
detect on its own, and these two numbers are how you see it.

Under them is what this device is talking to: the address it holds, whether
something in front of the server terminated TLS, and the protocol and server
build from `ready`. That is the first thing wanted when sync is not working,
and none of it costs a request. A device that is not connected shows the
address and says the protocol and the build are not known yet, because a build
missing for want of a connection looks exactly like a server that did not say.

A `wss://` address means something in front of the server terminated TLS. A
`ws://` one means nothing did, and the panel says what that costs in a clause:
"notes stay sealed, the credential and note sizes are not". In full: the
notes themselves are encrypted on this device either way, so a network in
between cannot read one, but it can see this device's credential go past and it
can see the size and the timing of every note that moves. On a home LAN or a
tailnet that is usually the trade somebody meant to make. Over anything else it
is not, and [server.md](server.md) has the two ways to put TLS in front.

The status bar icon shows the state. Obsidian mobile has no status bar, so the
same sentence is the ribbon icon's tooltip.

| | |
|---|---|
| unpaired | open the panel to pair |
| connecting, syncing | working |
| synced | up to date, with the time of the last pass |
| synced, needs attention | up to date except for files that need a person: a name that is a file here and a folder elsewhere, or a file the server refused. The panel names them. |
| failed | the last pass did not finish, with the reason; it will try again |
| offline | cannot reach the server, retrying |
| stopped | a refusal that retrying would not fix, see below |

**Stopped** means retrying will not help, and mostly that is the server
refusing this device in a way that will repeat: the protocol version differs,
the vault is not this device's, or the server has lost history this device
already has. The notice says which, and it says what to do about it. Upgrade
the server and plugin together for a protocol mismatch, and unlink and pair
again for a vault that is not this device's. For a server that has lost
history, see *Rejoin this server* below.

Two other causes are not the server's doing at all, and both stop for the same
reason. A pairing that never registered a device has nothing to connect with,
so nothing is asked of anybody; the notice names what is missing and prints the
recovery key if it is still there. And an unreadable `data.json` stops the
plugin rather than starting over, because starting over would replace what is
in it and this device would lose its row on the vault.

## Rejoining a restored server

Restoring the server from an older backup leaves every device holding versions
the server no longer has, and the server refuses those devices rather than
reissue their version numbers for other notes. That is deliberate; without it
the two ends diverge silently.

A device in that state shows **stopped** with the reason, and its panel grows a
*Rejoin this server* row. The first press asks the server where it is and shows
both versions; the second forgets what this device believed it had synced,
starts again from the server's version, and sends what only this device holds as
new versions. Nothing is deleted, here or on the server, and where the two sides
disagree both copies are kept. Back the server up first.

Unlinking and pairing again works too and is worse: it resets the merge base, so
every note comes back as a version with no ancestor and the next edit made on
two devices at once makes conflict copies instead of merging. Use Rejoin.

## Devices, and revoking one

*Devices* is under *Manage this vault*. It asks the server who may reach this
vault, on *Show devices*, and lists each one: its name, the id that identifies it, when it was added and when
it was last seen. Nothing is fetched until you press it, because it is a
request to the server rather than something this device already knows. The name
is not an identity, and two laptops may both be called laptop; the id is.

Each row has *Revoke*, behind a second press: the button becomes *Yes, revoke*
and says what that row will lose. Revoking removes the device's row and closes
any connection it has open, in that order, so it stops at once rather than the
next time it happens to reconnect. This device's own row is there too, where
the button reads *Unlink from the server*, which is what unlinking looks like
from the server's side.

The vault's **last** device has no button, and the panel says why where the
button would have been. Taking the last row off the server leaves a vault only
the recovery key opens, which is the one revocation no device can undo, so it
takes the recovery key: `basalt revoke ID --allow-last --recovery-key` on a
machine with the command line client. No device holds a recovery key, so a
button here could only ever be refused. To stop syncing on this device and
leave its row where it is, *Unlink this vault* is further down.

A row that says *never connected* is one nothing has ever signed in under. That
is what a pairing which reached the server and then crashed leaves behind, and
it holds one of the eight slots until it is revoked.

Under the rows are the invites nobody has redeemed yet, each with *Cancel*.
They belong with the list because they are the same question: a row is a device
that was added, an outstanding invite is one about to be. An invite issued on a
device you have since lost is the one worth seeing, and cancelling it retires
that string without waiting out its hour and without replacing the vault's
secret, which would retire the recovery key with it. What is shown is the
invite's identifier and when it expires, never the string itself: the server
never had the part that opens it, so nothing on this screen can add a device.

**Revoking stops a device connecting. It does not unread what that device
already read.** The summary under the rows says exactly that, beside the
buttons that do it, and it is the one sentence in the panel that was never a
candidate for cutting: the revoked device still holds the vault's key for every
note it had synced, and nothing can take that back. A device that was stolen
rather than merely lost wants its secret replaced as well, below. A panel that
let somebody read "revoked" as "the vault is safe again" would have them skip
the one step that helps.

Eight devices, and the ninth registration is refused rather than quietly
allowed and then unable to connect.

## Replacing the vault's secret

For a recovery key that has been somewhere it should not have been, and for the
second half of a stolen device: revoking it stops it connecting, and this stops
the key it was holding opening the vault again.

*Replace the vault's secret*, under *Manage this vault*, asks for the vault's
current recovery key, because no device holds one. That is the point of the
change: a device that could replace the secret could also register itself again
after being revoked. So somebody without the key cannot do it from here, and
the row says so ("Paste the vault's current recovery key") rather than letting
them find out by pressing.

The vault keeps all of its history: its content is sealed under a data key that
the root only wraps, so the wrapping changes and nothing is re-encrypted. **No
device row is touched and every device keeps syncing**, including this one.
That is the expensive half of what per-device credentials removed: it used to
disconnect every device and each one had to be added again, which for a laptop,
a phone, a desktop and a NAS is a weekend, and is the reason a leaked string
went unrotated. It cannot unread what was already read;
[design.md](design.md#a-lost-or-stolen-device) says more.

The new key is made before the request goes out and is on screen the moment the
call returns, because there is nowhere on a device to keep a root: not holding
one is the point, so the durable copy is the one you write down. If the reply
is lost, the plugin asks the server which secret it has, by trying the new one,
and says which key to keep. It never puts up a key it knows is not the vault's:
a rotation somebody else won says so and shows nothing to write down.

## Commands

| Command | |
|---|---|
| Sync now | forces a pass and reports what it did |
| Show status | opens the panel |
| Show version history | for the open note |
| Recover a deleted note | lists what the server has and this vault does not |

The panel holds the rest, in two altitudes. On screen: *Sync now*, *Add
another device*, *Recover a deleted note*, and *Rejoin this server* when a
restored server has refused this device. Behind *Manage this vault*: *Devices*,
*Recovery key*, *Replace the vault's secret*, *Unlink this vault*. *Recovery
key* is the one with no control at all: it says the key was written down and is
not kept here, and that an invite is what adds a device. Revoking, replacing
the secret and unlinking are behind warnings and confirmations; nothing there
is a setting.

Version history is also on a note's right-click menu, where Obsidian Sync puts
it. Both are registered on Obsidian's own command line as `basalt:history` and
`basalt:restore`.

## Version history

The server keeps every version of everything since the first sync. The history
view lists them newest first, shows the text of the one you pick or its
changes against what is on disk, and pages further back twenty at a time.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/changes-dark.png">
  <img src="assets/screenshots/changes.png" alt="Version history for a note: a sidebar of versions, and what changed between two of them." width="800">
</picture>

**Restoring never overwrites.** If the path is occupied, the restored copy is
written beside it as `Note (restored 42).md` and the notice says so. The
restored note keeps its original timestamp and is uploaded like any other
change. The notice separates the two outcomes: "Restored X. Sent to your other
devices." when the upload went through, and otherwise that it is on this device
and will be sent when the next sync succeeds, with the reason.

## Deleted notes

*Recover a deleted note* lists paths whose newest version is a deletion, with
when and on which device, newest first, with *Show older* for more. Restore puts
one back and sends it on. The heading counts what can be restored and what was
purged separately, and a note whose history was purged is listed without a
button, because a list that quietly dropped it would tell you a note was gone
when it was only purged.

A deletion arriving from another device is moved to the system trash, or to
the vault's `.trash` if that fails. Nothing is deleted outright.

## Conflicts

Two devices editing the same note while apart is normal. Basalt merges the two
when the changed regions do not overlap, which covers two devices appending to
one daily note. When they do overlap, or the merge cannot be verified, both
versions are kept:

```
Meeting notes.md
Meeting notes (Conflicted copy laptop 202608311412).md
```

The **incoming** version gets the conflict name. The file you have open is
never rewritten by a sync you did not ask for. Obsidian Sync does it the other
way round.

A note deleted on one device and edited on another is restored, not deleted.

## What is not synced

- `.obsidian`, or whatever your config folder is named. Settings, themes,
  snippets, plugins and workspace do not sync. Obsidian holds that folder in
  memory and writes it back, so a change arriving from elsewhere would be
  silently undone, and the pairing secret lives in there.
  [design.md](design.md) has the full reasoning and what would reopen
  it.
- Any file or folder whose name starts with a dot, at any depth. That covers
  `.basalt`, `.trash`, `.git` and `.DS_Store`, and also things like
  `.gitignore` or `.smart-env/`. Obsidian does not index dot-prefixed paths,
  so the plugin neither uploads them nor accepts them from another device.
- Files larger than the server's limit, 64 MiB by default. The plugin refuses
  them from their size before opening them. `basaltd serve -max-file` raises
  it.

Everything else in the vault syncs, attachments included. Attachments are
supported rather than optimised for; a vault that is mostly video wants a file
sync, not a note sync.

## Phones

There is no background sync on a phone. Basalt runs inside Obsidian and syncs
while Obsidian is open and in the foreground; nothing runs when the app is
closed or the screen is off, and there is no push. Open Obsidian and the vault
catches up.

Android is in daily use. Sync stops when the screen is off because Android
suspends the network, and resumes on its own. A first sync of a large vault
needs the screen on until it finishes.

iOS is untested. The plugin is not marked desktop-only and the bundle contains
nothing Node-specific, so it should run. If a new pairing never manages to
connect, the panel shows this device's origin and the `-allow-origin` flag that
would admit it, and the server logs the same thing; a pairing that has worked
before and is merely offline gets no such advice.

## Durability

Every download is written to a staging file beside the note, read back byte
for byte, and only then put in place. Obsidian's file API offers no way to
flush to disk, so on desktop the plugin uses Electron's own file system to make
a note durable before the index that names it is saved. On a phone there is no
such call, and the ordering is best effort: a power loss in the second between
a note landing and the index being written can leave the two out of step, and
the next pass repairs it from the server. A crash can leave a staging file
named `.basalt-tmp-...` beside a note; it is safe to delete.

## Unlink

*Unlink this vault* waits for the running pass to finish, removes the plugin's
index, then forgets the pairing. Every note stays where it is, here and on the
server. If a step fails the plugin stays paired and says why, and Unlink can be
tried again. Pair again to resume.
