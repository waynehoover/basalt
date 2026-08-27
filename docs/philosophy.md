# Design philosophy

## First principle: do not lose a note

Everything else in this document exists to serve that, including the simplicity.
A sync tool that loses an edit has failed at the only job it has, and no amount
of elegance elsewhere compensates.

The narrow scope is not a separate goal. It is how correctness becomes
achievable: you can be sure about one backend, one transport and one platform.
You cannot be sure about six.

When simplicity and correctness conflict, correctness wins and the feature gets
cut instead.

## The durability rules

Each of these came from something actually going wrong. They are listed with the
incident because a rule without its story gets softened later by someone who does
not know what it cost.

1. **Acknowledge only after the write is durable.**
   The final ack for a push is withheld until the body and the entry are both
   committed. An early ack means "stored" was a lie a crash can expose.

2. **A failed read is not an empty result.**
   Code that read a config file, fell back to an empty list on error, and wrote
   the result disabled every plugin on a device. Absent and unreadable are
   different states. Unreadable must abort.

3. **Never delete until a verified copy exists elsewhere.**
   Copy, checksum both ends, then delete. Not copy, assume, delete.

4. **Verify the outcome, not the exit code.**
   `adb push` returned 0 while writing one file of four, because the tool being
   driven consumed the loop's stdin. Read back what you wrote.

5. **Never write a result smaller than its input without proving that is right.**
   Any merge, prune or rewrite that shrinks a list is a bug until demonstrated
   otherwise. Refuse it and say why.

6. **Deletions are entries, not absences.**
   A deleted file leaves a record. That record is what makes it recoverable, and
   it is why a vault whose files were all deleted is not an empty vault.

7. **A status describes the vault, not the filter.**
   "Fully synced" has twice meant something other than synced: once at cursor 0
   with 4,030 local files, once while 13 files were excluded by type. If a
   status cannot distinguish "everything is here" from "everything I chose to
   look at is here", it is not a status.

8. **Trust the numbers, not the passes.**
   Most real bugs here were caught by a figure being implausible, not by an
   assertion failing. An impossible throughput number revealed two "devices"
   were the same vault.

9. **A fix without a test that failed first is not finished.**
   Revert the fix, watch the test fail, restore it. A test written after the fix
   that has never been seen to fail is a test of nothing.

10. **Assertions must check the property that matters.**
    A conflict test asserted the two devices *agreed*. It passed while one
    side's edit had silently vanished. Agreement is not the property; not losing
    an edit is.

## Conflicts: keep both, always

Obsidian and LiveSync both merge with diff-match-patch. Obsidian's merge is:

```js
patch_apply(patch_make(base, diff(base, mine)), theirs)[0]
```

`patch_apply` returns `[text, appliedFlags]`. Taking `[0]` discards which hunks
failed. **Hunks that do not apply are silently dropped**, which is precisely
rule 10's failure wearing a different hat.

Basalt uses the same library and the same three-way construction, and then
diverges: if any hunk fails to apply, the merge is abandoned and both versions
are kept, one renamed as a conflict copy. A visible duplicate is a small
annoyance. A silently mangled note is the thing this project exists to prevent.

This is not a criticism of either project. It is the one place where being
scoped to a single use case lets us take the more conservative option.

## The simplicity principle

As easy as possible at both ends. The server is one binary. The client asks for
less than Obsidian's own sync plugin does, because a self-hosted vault needs
fewer decisions, not more. Everything else takes a sensible default and is never
shown.

Customisation is a tax. Every option is something to explain, to get wrong, to
leave untested in combination, and a row in a screen that makes a simple tool
feel complicated. It is also a correctness cost: every option multiplies the
state space nobody tested.

### Setup, as a target

| | |
|---|---|
| First device | one field, one button. Passphrase generated and shown once |
| Every device after | one string, no decisions |
| Settings screen | status and actions. No configuration |

The host lives **inside** the pairing string, not beside it:

```
homelab.example.ts.net:3003#K7M2PQR4-9XBCDEFGHJKMNPQRSTVWXYZ23456789
└──────────── where to ask ───────┘ └──── what unlocks the answer ────┘
```

### Where a setting goes instead

Asked in this order. Only a question surviving all three earns a row.

1. **Can another device tell us?** Then it travels in the pairing string.
2. **Is there a right answer?** Then it is chosen once in the source, with the
   reasoning in a comment.
3. **Is it only relevant when something specific happens?** Then it appears in
   that moment. Capabilities live in the command palette; fixes live inside the
   error that needs them.

## Rules

1. **Every option must justify its own existence.**
2. **Inherit Obsidian's judgement wherever it exists**, except where it trades
   away a note, as with silent merge failures.
3. **Fail loudly, and never report success you have not verified.**
4. **The server is an opaque blob store and stays one.** It never sees plaintext
   or the passphrase.
5. **Verify against the artifact, never infer.**
6. **Everything is reversible.**

## Refusals

- **No second backend.** No S3, no CouchDB, no bring-your-own-storage.
- **No peer-to-peer.** Good feature; doubles the transports.
- **No teams or shared vaults.** Invites permissions, quotas and identity.
- **No settings for things with a right answer.**
- **No settings screen.** Status and actions only.
- **No web UI on the server.** Anything it could show you, it would have to read.
- **No merge of our own.** Two independent projects chose diff-match-patch.
- **No silent conflict resolution.** If the merge is not clean, keep both.

## Who this is wrong for

Anyone needing a vault shared with other people, sync without running anything,
a hosted option, or storage they already pay for.
[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) does all of
that, is MIT licensed, and is a better answer for those cases.
