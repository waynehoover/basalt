# Design philosophy

**Minimal, opinionated, fast, self-hosted.** In that order when they conflict,
except that nothing outranks not losing a note.

Every question with a right answer is answered once, in the source, with the
reasoning beside it, so it never becomes a row in a settings screen. Fast follows
from that, because the fastest thing a sync client can do with a byte is not send
it. Self-hosted is what makes the rest achievable: you can be sure about one
backend, one transport and one platform, and you cannot be sure about six.

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

Obsidian and LiveSync both merge with diff-match-patch. Obsidian applies the
patches and returns the text, discarding the array saying which hunks landed, so
**hunks that do not apply are silently dropped**: rule 10 wearing a different
hat.

Basalt uses the same library and the same construction, then diverges: if any
hunk fails, the merge is abandoned and both versions are kept, one renamed as a
conflict copy. A visible duplicate is a small annoyance; a silently mangled note
is what this project exists to prevent.

Checking the flags was not enough, and the reason is the same failure one level
deeper. diff-match-patch has **no notion of a conflicting region**: it
fuzzy-matches each hunk and reports whether it found somewhere to put it. Two
devices rewriting one sentence differently both "apply":

```
base    The original sentence.
mine    My completely different sentence.
theirs  Their entirely other sentence.
merged  My completely different entirely other sentence.
```

Every hunk applied, every insertion is present, and the meaning is gone. So
Basalt does what diff3 and git do and this library does not: it compares which
regions each side changed and refuses before applying anything if they collide.
Two additions at one point are allowed on a line boundary, because whole lines
concatenate readably and two devices adding to one daily note is the common case.

And the *incoming* version goes in the conflict copy, where Obsidian puts the
local one and overwrites the file with the server's. A sync you did not ask for
should never rewrite the file you have open.

## Fast, because it sends less

Basalt chunks on a rolling hash and sends only the chunks that moved, where
whole-file sync sends the body. One line inserted: 284 B against 4 KiB at 4 KiB,
494 B against 2 MiB at 2 MiB. The advantage grows with the file, which is the
property that matters.

Chunks are compressed before they are encrypted, taking a full upload of a
vault's text from 108% of plaintext to 67%. That ordering is forced: after
chunking, because compressing first would move every boundary on any edit; before
encrypting, because ciphertext does not compress.

Four rules behind that:

1. **Send less before doing less work.** Bandwidth is what a phone on a train
   actually lacks.
2. **Measure on a real vault, then decide.** Every size and threshold here came
   from a measurement, not an argument.
3. **Report numbers, do not assert them.** Wall-clock assertions in a test suite
   fail on a busy machine and teach people to ignore them.
4. **Warm up, and alternate the order.** The first benchmark here did neither and
   reported a 2.7x gain where the honest figure was 1.3x.

## Simplicity

Customisation is a tax: every option is something to explain, to get wrong, to
leave untested in combination, and it multiplies the state space nobody tested.

| | |
|---|---|
| First device | one field, one button. Passphrase generated and shown once |
| Every device after | one string, no decisions |
| Settings screen | status and actions. No configuration |

The host lives **inside** the pairing string:

```
homelab.example.ts.net:3003#K7M2PQR4-9XBCDEFGHJKMNPQRSTVWXYZ23456789
└──────────── where to ask ───────┘ └──── what unlocks the answer ────┘
```

A setting earns a row only by surviving three questions. Can another device tell
us? Then it travels in the pairing string. Is there a right answer? Then it is
chosen once in the source. Is it only relevant when something specific happens?
Then it appears in that moment: capabilities in the command palette, fixes
inside the error that needs them.

## Rules

1. **Every option must justify its own existence.**
2. **Inherit Obsidian's judgement wherever it exists**, except where it trades
   away a note.
3. **Fail loudly, and never report success you have not verified.**
4. **The server is an opaque blob store and stays one.**
5. **Verify against the artifact, never infer.**
6. **Everything is reversible.**

## Refusals

No second backend. No peer-to-peer. No teams or shared vaults. No settings for
things with a right answer, and no settings screen. No web UI on the server,
because anything it could show you, it would have to read. No merge of our own; two
independent projects chose diff-match-patch. No silent conflict resolution.

## Who this is wrong for

Anyone needing a vault shared with other people, sync without running anything, a
hosted option, or storage they already pay for.
[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) does all of
that, is MIT licensed, and is a better answer.
