# Per-device credentials

A spec, not an implementation. It gives each device its own credential and the
server a list of them, so one device can be revoked without touching the others.

The prototype question this has to answer first is not "how", it is **whether
revocation means anything**. Under today's model it would not, and the reason
is the most important paragraph here.

## The gap this closes, which is already visible in the product

The panel says, of the recovery key:

> It is for writing down in case every device is lost, not for adding one:
> use an invite for that.

That is the right model and the implementation does not match it. Every device
stores the root secret (`DeviceConfig.secret`, commented "Anyone holding this
has the vault"), because the root derives `auth` to connect and `wrap` to open
the data key. So the thing the UI calls an offline last resort is sitting on
the phone in your pocket.

That is why revocation cannot work today. Deleting a device's row would stop
nothing: it holds the root, so it re-derives the same credential and
reconnects, or simply re-registers. **Per-device credentials only mean
something if devices stop holding the root.** Everything below follows from
that one change, and without it the rest is theatre.

## What it buys, and what it does not

Buys:

- **Revoking one device**, without re-pairing every other one. Today the answer
  to a stolen laptop is rotate the root and re-pair the phone, the desktop and
  the NAS. For a notes app that is a weekend.
- **A list of devices with names and last-seen**, which is the only way to
  answer "what is still connected to this vault".
- **The 8-device cap becomes a managed list** rather than a connection-count
  cliff that refuses with `busy` (see docs/protocol.md on why `busy` stays one
  code).
- **The implementation matching what the panel already promises.**

Does not buy, and the spec must say so plainly:

- **It does not un-read what a device already read.** A revoked device keeps
  the data key and can still decrypt every note it had synced. Revocation
  stops future connection, not past knowledge.
- **It does not replace rotation.** A device that is compromised rather than
  merely lost still calls for a new data key, because the old one is out.
  Revocation is the cheap, common case; rotation is the expensive, rare one.

Selling revocation as "the vault is safe again" would be a lie, and the panel
copy must not.

## What each credential can do

Three, deliberately separated. The privilege separation is the point.

| credential | held by | may |
|---|---|---|
| root secret (the recovery key) | nobody, offline, written down | register a device, rewrap the data key |
| device secret | one device | connect and sync as that device |
| data key | every paired device | read and write content |

A device holds the **device secret** and the **data key**. It does not hold the
root. So a stolen device cannot register itself again, cannot mint a
credential for anything else, and cannot show you the recovery key, which the
panel already says it should not be doing.

The root is used exactly twice in a vault's life: when it is created, and when
every device is gone.

## The devices table

```sql
CREATE TABLE IF NOT EXISTS devices (
  vault_id   TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,   -- 16 random bytes, base64url, chosen by the device
  name       TEXT    NOT NULL DEFAULT '',
  auth_hash  TEXT    NOT NULL,   -- hex SHA-256 of this device's auth key
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, device_id)
);
```

Revoking is `DELETE`, not a `revoked_at` column. A tombstone invites the
question "is this row still checked", and the answer must never be "it depends
on a flag". Gone is gone. The audit trail already exists: `entries.device`
records which device wrote every version, and that history is not touched by
revoking.

`vaults.auth_hash` stays, with its meaning narrowed to **may register a
device, may not sync**. That is what lets the recovery key add the first device
back after everything is lost.

## The name

Optional, free text, 64 bytes, the same limit `device` already has on the wire.
It defaults to the `--device` name the client already sends, which today is
only stamped on entries as authorship. So names are not new; they finally have
somewhere to live and something to identify.

Set at registration, changeable later by that device or by any device with a
session. Never unique, never an identifier: `device_id` is the identity and the
name is for a person reading a list. Two laptops both called "laptop" is a
person's problem to fix and not the server's to prevent.

## Flows

**Create a vault.** Generate the root, derive `auth`, register the vault as
today. Then generate a device secret, register the first device row, and show
the recovery key once. The device stores its device secret, the data key and
the wrapped blob. It does not store the root.

**Add a device (invite).** Unchanged from the outside: `basalt invite` on a
paired device, paste into the new one. The invite carries the data key sealed
under the invite key, where it used to carry the root. The new device generates
its own secret and sends the hash while redeeming, so the server never sees the
secret. Redeeming creates the device row.

**Add a device (recovery key).** The only path that needs the root. Prove
ownership with the root-derived `auth`, register a device row, receive the
wrapped data key. The session may do nothing else.

**Connect.** Hello carries `deviceId` and the device's auth key. The server
looks up the row, compares the hash, updates `last_seen`. No row, or a hash
that does not match, is the same `auth` refusal it is today, saying neither
which.

**List.** A new op returning id, name, created, last seen for every device.
Shown by `basalt devices` and in the panel.

**Revoke.** A new op taking a `device_id`. Deletes the row and closes any live
session for it. A device may revoke itself (that is what unlink becomes) and
may revoke another. Revoking the last device is refused: it would leave a vault
only the recovery key can reach, and if that is what somebody wants they should
be made to say so.

**Rotate.** Gets simpler. Device credentials are independent of the root, so
rotation replaces the root and rewraps the data key without touching a single
device row. Every device keeps syncing.

## Protocol 4

Not backward compatible, and there is no point pretending otherwise: hello
gains a `deviceId`, the credential it carries means something different, and
the vault-level `auth` stops being a sync credential. Protocol 3 has been in
use by one person for a day, so this is the moment.

`minProto` and `serverVersion` machinery already exists from protocol 3 and a
mismatch already refuses at hello naming both numbers.

## Migration

A protocol 3 vault has one `auth_hash` and no device rows. On upgrade, the
server keeps `vaults.auth_hash` as the registration credential. The first
protocol 4 connection from each device registers a row using the root it still
has, then rewrites its own config to hold the device secret and the data key
and drops the root.

That means each device, once, silently converts itself. Two things must be
true for that to be safe: it must be idempotent, because a crash mid-convert
must not strand the device, and dropping the root must happen only after the
device row is confirmed registered and read back (rule 4, and the same
save-before-send ordering rotation already uses).

The alternative is telling people to re-pair everything, which is exactly the
weekend this feature exists to abolish. Doing it automatically is worth the
care it needs.

## What can go wrong

| situation | what happens |
|---|---|
| revoked device is mid-sync | its session is closed; it reconnects, gets `auth`, stops and says so |
| revoked device still holds the data key | it can read what it already had. Stated in the panel, not hidden |
| device loses its secret but has the vault | it cannot connect. Re-add it with an invite from another device |
| every device revoked or lost | the recovery key registers a new one. This is what it is for |
| two devices register the same id | 16 random bytes; the primary key refuses the second |
| convert crashes after registering, before dropping the root | idempotent: the device has a row and still has the root, so it converts again and drops it |
| convert crashes before registering | the device is unchanged and protocol 3 shaped; it tries again |
| the last device revokes itself | refused, unless it says so explicitly |

## Tests owed, each failing first

1. A revoked device cannot connect, and says why in words a person can act on.
2. Revoking one device does not disturb any other device's session or sync.
3. A revoked device cannot re-register itself, because it has no root.
4. A device that has converted no longer holds the root secret on disk.
5. Conversion is idempotent across a crash at each of its two steps.
6. Rotation leaves every device row untouched and every device syncing.
7. The recovery key can register a device and can do nothing else with that
   session.
8. Revoking the last device is refused unless explicitly confirmed.
9. `last_seen` moves on connect and not otherwise.
10. Two devices may share a name, and the list stays usable.
11. A protocol 3 client is refused at hello naming both numbers.

## Order of work

1. The devices table and the registration and revoke operations, server side,
   with no client change. Testable on its own.
2. Hello carrying `deviceId`, and the vault credential narrowed to
   registration only.
3. The client's conversion, which is the part that can strand a device and so
   goes last and gets the most tests.
4. `basalt devices` and the panel list.
