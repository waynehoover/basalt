# Design philosophy

**Minimal, opinionated, fast, self-hosted.** In that order when they conflict,
except that nothing outranks not losing a note.

Minimal and opinionated are the same decision seen from two sides: every
question with a right answer is answered once, in the source, with the reasoning
beside it, so that it never becomes a row in a settings screen. Fast follows from
minimal more often than it competes with it, because the fastest thing a sync
client can do with a byte is not send it. Self-hosted is the constraint that
makes the other three achievable: one backend, one transport, one person's
devices.

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

Checking the flags turned out not to be enough, and the reason is worth recording
because it is the same failure one level deeper. diff-match-patch has **no notion
of a conflicting region**: it fuzzy-matches each hunk and reports whether it
found somewhere to put it. So two devices rewriting one sentence differently both
"apply", and the result is a sentence neither person wrote:

```
base    The original sentence.
mine    My completely different sentence.
theirs  Their entirely other sentence.
merged  My completely different entirely other sentence.
```

Every hunk applied. Every insertion is present, so a check for a lost edit passes.
The meaning is gone. So Basalt also does what diff3 and git do and this library
does not: it compares which regions of the ancestor each side changed, and refuses
before applying anything if they collide. Two additions at one point are allowed
when they land on a line boundary, because whole lines concatenate readably and
two devices adding to one daily note is the common case; mid-line they are
refused, because that is how the sentence above happens.

And Basalt puts the *incoming* version in the conflict copy, where Obsidian puts
the local one and overwrites the original with the server's. A sync you did not
ask for should never rewrite the file you have open.

This is not a criticism of either project. It is the one place where being
scoped to a single use case lets us take the more conservative option.

## Fast, and where the speed comes from

Speed here is not an optimisation pass. It is a consequence of sending less, and
the numbers are worth stating because "fast" is otherwise just a word.

The comparison is Obsidian Sync, which keeps one hash per file and pushes the
whole body on any change. Basalt chunks on a rolling hash and sends only the
chunks that moved. Measured, one line inserted into a note:

| Note | Basalt sends | Whole-file sends | |
|---|---|---|---|
| 4 KiB | 284 B | 4 KiB | 15x less |
| 128 KiB | 349 B | 128 KiB | 376x less |
| 2 MiB | 494 B | 2 MiB | 4245x less |

The advantage grows with the file, which is the property that matters: a vault
accumulates long notes, and the cost of editing one should not.

Chunks are compressed before they are encrypted, which takes a full upload of a
vault's text from 108% of its plaintext to 67%. That ordering is forced: after
chunking, because compressing the file first would move every boundary on any
edit; before encrypting, because ciphertext does not compress.

A whole 78.8 MiB vault chunks, compresses, encrypts and names in 2.5 seconds,
once, and moves 66.8 MiB.

### Rules for making it fast

1. **Send less before doing less work.** Bandwidth is the resource a phone on a
   train actually lacks.
2. **Measure on a real vault, then decide.** Every size and threshold in the
   chunker was chosen from a measurement against 78.8 MiB of real notes, and two
   plausible-sounding improvements were dropped because the measurement said they
   were worth 3.7% and 1.7x-once-against-2.2KB-forever.
3. **Report numbers, do not assert them.** Wall-clock assertions in a test suite
   get loosened until they mean nothing; the same chunker measures 575 MiB/s
   under one runner and 32 under another. Bytes on the wire is deterministic, so
   that is what the tests assert, and throughput is a benchmark somebody reads.
4. **Warm up, and alternate the order.** The first version of the benchmark here
   measured one variant cold and its rival warm, and reported a 2.7x gain where
   the truth was 1.3x.
5. **A cache keyed on what the filesystem already tells you.** Obsidian's engine
   keeps a content hash per file and invalidates it only when mtime or size
   moves, so an unchanged vault costs one stat per file. Copy that, and extend it
   to the chunk list.

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
