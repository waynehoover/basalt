# Improvements

Notes from reading the repo as a prototype we have learned a lot by.
Nothing here changes code. The premise: lines of code are free,
direction changes are on the table, and the philosophy itself is
under review. Arguments first, conclusions second.

---

## 1. The philosophy: what survived contact with the prototype

**"No settings screen" is becoming fiction.** The docs say every question
with a right answer is answered once in the source. Count what is actually
a setting today: `-max-file`, `-max-batch-bytes`, `-max-fetch-bytes`,
`-allow-origin` (repeatable), `-grace`, `-ttl`, `--ignore` (repeatable,
per-device), `--timeout`, `coalesceWrites`, the 8-device cap, the 30s/5s
retry hints, the 400ms debounce, the 30s full pass. That is a settings
screen distributed across flags, CLI options, and constants — with the
worst property of both worlds: no single place to see them, and the
"answered once in the source" ones (`OWN_LIMITS`, chunk targets) are the
ones a phone user most needs to change and least can.

Two honest directions, pick one:

- **(a) Stay the course but centralise.** One documented table of every
  tunable, its default, and why it is not in the UI — `compared.md`
  already does this for chunking; do it for everything. The current
  state (some in `docs/server.md`, some in comments, some only in code)
  is how a default gets changed in one place and not the other.
- **(b) Admit a small config surface.** A read-only-on-devices,
  server-advertised config (`ready` already carries ceilings; extend it
  to policy: max-file, retention, invite default TTL) plus a local
  device config (ignore patterns, debounce). The protocol already
  solved the hard part — capability advertisement at hello. Policy
  advertisement is the same mechanism.

The argument *for* the current refusal is real: every option multiplies
untested combinations, and the test suite is the project's crown jewel.
But several refusals have already been re-litigated by reality
(`-allow-origin` exists because phones exist; `--ignore` exists because
vaults contain things people don't want synced). A philosophy that keeps
losing the same fight should be amended, not re-asserted.

**"One person's devices" vs. the trust model.** Every device holds the
same root secret; there is no revocation, only rotation plus re-pairing
every device. That is coherent for one person — until the person has a
phone, a laptop, a work machine, and a NAS, and rotation means touching
all four while the plugin (the thing on three of them) cannot rotate.
The current answer to "stolen laptop" is: find a machine with the CLI,
rotate, re-invite everything. For a notes app, that is a weekend. The
rethink: **per-device credentials** (server stores a device list, each
device holds its own key derived from the root, revocation is deleting a
row). It costs the "pairing string is one string" elegance and adds
exactly one server-side concept (a device registry). It also fixes the
8-device cap's cliff (refused with `busy`, which also means "server
shutting down" — two unrelated conditions sharing one code and one
retry hint). Worth pricing out; it is the single biggest gap between
"one person's devices" as a scope decision and as a security story.

**"The server is an opaque blob store and stays one" — mostly true,
two leaks to look at.** The server learns chunk equality (stated,
load-bearing for dedup) and per-path activity/timing/sizes (stated).
Both are accepted. What is *not* stated anywhere: the unauthenticated
`/health` endpoint plus the handshake's `serverVersion` and vault
existence oracles give an internet-facing prober a version string,
vault names validity (`auth` never says which of token/vault was wrong —
good — but hello still distinguishes `proto`/`badname`/`busy` from
`auth`, which is a small oracle). None of this threatens ciphertext.
But "TLS terminates in front, port is open to the internet" (Caddy
setup) plus version-string disclosure is how targeted exploitation
starts. Cheap fix, no philosophy change: minimal health body, no
version before auth, and say so in `design.md`.

---

## 2. The merge: the bravest code in the repo, and the riskiest dependency

`merge.ts` is superbly reasoned and carries four checks to reconstruct
what diff-match-patch lacks (conflict regions, misplaced-hunk
detection via two-directions merge, applied-flags, insertion
survival). The comments even document which check catches what,
measured by disabling each in turn. That is the standard everything
else should be held to.

The problem is structural, not logical: **the entire correctness
argument rests on `diff-match-patch`, unmaintained since 2020**, with a
fuzzy matcher that has been *observed* to land a hunk on the wrong
section with every flag green. The four checks convert "silently wrong"
into "conflict copy" in every case tested — but the test corpus is
finite and the library's failure modes are not enumerated anywhere.
The `sameLines` comparison explicitly concedes a hole (a line moved to
different places by the two directions passes) because the daily-note
case forces order-insensitivity. So the merge is: brilliant mitigation
around an unmaintained core, with one documented hole, defending the
most important property in the system ("do not lose a note").

Candidate rethinks, in increasing order of ambition:

1. **Fuzz the merge.** The module is pure (`base, mine, theirs` in,
   outcome out) — the cheapest high-value work in the repo. Property:
   every non-whitespace token of both sides survives in `merged`
   output, or the outcome is `conflict`. The existing tests are
   hand-built cases; a fuzzer with repetitive content (the observed
   failure shape: N similar sections) would attack exactly the fuzzy
   matcher. This is not a direction change, just an unfinished job.
2. **Line-anchored hybrid.** diff3's region discipline (proper conflict
   regions) for line structure plus diff-match-patch *within* a
   conflicting line for prose granularity. `node-diff3` was rejected
   because line granularity conflicts on any two edits to one
   paragraph — but that rejection tested diff3 *alone*. A hybrid
   (diff3 regions; character merge only inside a region both sides
   touched, refused if it spans regions) keeps the daily-note merge
   and gains real regions. Prototype it against `merge.test.ts`
   before deciding; the suite is the referee.
3. **A CRDT for text (Automerge/Yjs).** The actual direction change.
   Kills the merge module, the `synchash` ancestor scheme, and the
   whole class of "placed wrongly" failures — at the cost of a
   document model (char-level ops history), larger metadata, and a
   dependency with its own complexity. For prose notes edited on two
   devices, CRDTs are the solved answer; the reason to hesitate is
   that Basalt's merge is *already* good for the common cases and a
   CRDT is a rewrite of the sync core, not a swap of one module.
   Recommendation: do (1) now, spike (2), keep (3) as the named
   alternative in `design.md` so the next merge bug has somewhere to go.

Also: `stillValid` (JSON validity for canvas files) is plumbed but the
docs admit it came from reading others' issues, not from a failure.
Structured-file merging deserves its own test corpus before someone's
canvas won't open.

---

## 3. Crypto and chunking: the coupling that can never be retuned

Three parameters are **baked into chunk names** (hash of sealed
ciphertext): chunk-size targets, the deflate level, the sealing
construction. `compared.md` says so explicitly: "Changing either
re-chunks every vault in existence." That was fine for a prototype.
For a system with users, it means the most performance-critical
numbers in the codebase are immutable without a flag day — and there
is no migration mechanism (protocol 4's compatibility "gets written
then, against a protocol 3 that has actually run" — i.e., not yet).

The rethink: **decouple identity from encoding.** Name a chunk by the
hash of its *plaintext* (dedup still works — equal plaintext still
names equal; the server can still verify *a* hash, just not recompute
the seal), and carry the encoding parameters as a versioned envelope
beside the body. Then chunking v2 can coexist with v1: old chunks keep
their names, new writes use new params, and the server (which treats
names as opaque strings already) needs no change. The cost: the
server's bit-rot check (`Name` recomputed on the way out) becomes
"hash matches the envelope claim" rather than self-verifying, and the
envelope is one more thing the entry MAC must cover (it already covers
the chunk list; extend to per-chunk params or a single scheme id).
This is a protocol-4-shaped change and should be designed *before*
protocol 4 is needed for something urgent.

Smaller crypto notes:

- **Deterministic sealing's equality leak** is stated and accepted.
  Fine. But the docs should also state the *cross-version*
  consequence: equal chunks across different notes/versions are
  visibly equal to the server *forever*, including after rotation
  (rotation rewraps the data key; chunk ciphertext does not change,
  so pre- and post-rotation stores are correlatable by the server).
  Rotation "cannot unread what was already read" covers the key
  holder; the server-side correlatability is a separate sentence
  that belongs in `design.md`.
- **The 2^48-chunk birthday bound** is correctly dismissed as
  unreachable. Keep dismissing it, but note it assumes HMAC-SHA256
  truncation behaves randomly — standard, fine, just say it once.
- **`fflate` determinism** is load-bearing (same chunk must seal
  identically on desktop and phone) and currently asserted by golden
  vectors (`compression-golden`). Good. The risk is a future `fflate`
  upgrade silently changing bytes: pin the version (done) *and* make
  the golden test a CI gate that blocks dependency bumps (check that
  it is — a test that exists but doesn't gate is documentation).

---

## 4. Sync core: the index is a JSON file doing a database's job

The engine is the best-tested part of the system and it shows: every
major invariant has a comment citing the incident that produced it.
Three structural observations:

- **The whole index is stringified and rewritten on every change.**
  At 10,000 notes the index is 5.6 MiB; the `packed`/`unpacked`
  dance already exists because chunk names were stored 3x. This is a
  durability smell (a torn write during a 5.6 MiB rewrite is the
  failure `validateStoredState` exists to catch — good) and a
  performance cliff (41 ms passes today; linear growth says 100k
  notes is 400+ ms per pass plus full rewrites). SQLite is *already*
  a dependency (server side). A local SQLite index (or even
  append-only journal + snapshot) removes the rewrite cliff and makes
  per-file durability atomic. Counter-argument: `data.json` must stay
  readable/writable through Obsidian's API on phones, where SQLite
  availability is the question. At minimum: fsync the index file
  where possible, and measure rewrite cost at 10k/50k notes so the
  cliff has a number.
- **`synchash` per file is elegant; the rename chain (`prev`) is
  fragile.** `prev` is set on first rename and frozen (matching
  Obsidian) — correct for A→B→C, but the comments show rename
  handling has produced multiple real bugs (conflict-copy upload
  timing, case-only renames needing `wroteThisPass` lifetime fixes).
  Renames are one operation on the wire but N edge cases in the
  engine. Consider: resolve renames at scan time (match by content
  id: disappeared path + appeared path with identical `hash` =
  rename) instead of tracking `prev` across passes. Content ids
  already exist; the scan already hashes everything. That collapses
  a stateful chain into a stateless observation.
- **The `blocked`/`skipped`/`ignored`/`refusedInbound` taxonomy is
  four maps doing one job** ("paths we are not acting on, and why").
  Each was added for a real incident and each comment justifies its
  separation. But rule 7 cuts both ways: four categories is three
  distinctions a user must learn. `ignored` (user-configured) vs.
  everything else is the one distinction that matters; consider
  merging `blocked`+`skipped`+`refusedInbound` into one
  "needs attention" set with reasons, keeping `ignored` apart (it
  already has its own exit-code semantics, R2).

---

## 5. Operations: the backup/purge/restore story is safe and heavy

The safety properties are genuinely good: backup verifies before
reporting success, stages-then-renames, never deletes; purge demands
the vault name *and* proof of a fresh backup; restore rehearsal is
documented step by step. This is the part of the repo most shaped by
"do not lose a note," and it reads like it.

The cost is operational weight, and three things deserve rethinking:

- **Purge requires stopping the server.** The stated reason (exclusive
  `data.lock`) is sound, but the consequence is that reclamation —
  the most routine maintenance — is the highest-ceremony operation
  (stop, backup, purge, start; under Docker, a multi-container
  dance). An online purge (snapshot the live set, delete only bodies
  unreferenced by *both* the snapshot and anything written since,
  under a grace window) is strictly more code in the most
  durability-critical layer — or, alternatively, make the server
  *do* the purge itself on a timer/SIGUSR with the backup check
  built in. The current design optimises for "purge must never be
  wrong" over "purge must actually happen"; unpurged servers grow
  until the disk fills (`nospace` refuses uploads — safe, but the
  alert table's answer is "purge after a backup," i.e., the heavy
  path under pressure).
- **Backups grow forever by design** ("start a fresh backup dir after
  a purge, keep the old one, delete it whole"). Honest, but "delete
  it whole" is a retention policy expressed as a shell command with
  no schedule, no reminder, and no verification that the fresh dir
  is complete before the old one goes. At minimum: `basaltd backup`
  should record generation metadata (uid range, timestamp, purge
  generation) so a script — or a future `basaltd retention` — can
  decide what is safe to drop. The metadata is also what makes
  "which backup covers this uid" answerable without opening SQLite.
- **Rebase is CLI-only, and the plugin path is "unlink and pair
  again."** After a restore, *every plugin device* must be manually
  unlinked and re-paired, and re-pairing resets the merge base, so
  the device's notes come back as new versions with no ancestor —
  the exact state in which the next concurrent edit cannot merge
  and produces conflict copies. The restore runbook should say this
  plainly (it hints at it: "come back as new versions either way"),
  and the plugin needs rebase (or the engine needs "adopt server
  cursor + re-upload diverged files as new versions," which is what
  CLI rebase does — the code exists, it is just not wired to the
  plugin). Mobile users hitting the hardest recovery path with the
  bluntest tool is the sharpest edge in the current UX.

---

## 6. Platform: iOS is the roadmap's load-bearing "should"

"iOS is untested. It should work." The bundle contains nothing
Node-specific — true, and insufficient. Known unknowns, all named in
the docs but not tracked as work: streaming fallback reads whole
files on mobile (memory curve sets the 64 MiB default, but that curve
was measured on desktop-class memory — an older iPhone jetsamming
mid-sync is a data-loss-adjacent event only by luck of staging);
no fsync on phones (note-then-index ordering is best effort, crash
window is real); background sync doesn't exist on either mobile OS
(stated) but the *first-sync-needs-screen-on* requirement has no
progress UI beyond a status line; `-allow-origin` for future Obsidian
builds is reactive (log grep) rather than proactive. None of this is
an argument against shipping — Android-in-daily-use is real
validation. It is an argument for a **mobile test plan with numbers**:
memory ceiling on a specific old phone, first-sync time for the
3,751-file real vault over real latency, kill-and-resume behavior.
"Should work" graduating to "measured on" is one TestFlight session
plus a borrowed iPhone.

Related: the **plugin's two unverified files** (`main.ts`,
`vault.ts` — "this is the one file that cannot be tested") are the
files that touch real user data on real devices. The Obsidian stubs
(`stub.ts`, `fake.ts`) exist; the question is whether they are
faithful enough that passing against them means anything. The highest
value test investment after merge fuzzing: a **vault-fidelity suite**
that replays recorded Obsidian event sequences (rename storms,
rapid saves, trash behavior, `.trash` vs system trash, dotfile
indexing gaps) through the real `ObsidianVault` adapter against the
fake API, asserting no-loss invariants rather than UI behavior.

---

## 7. Protocol and transport: keep the wire, fix the edges

The protocol doc's six inversions of Obsidian Sync's defects are the
clearest writing in the repo, and request ids + `retryable` + named
outcomes (`have`/`want`/`ack`) are all load-bearing lessons. No
direction change proposed. Edges worth smoothing in a protocol 4:

- **`busy` means two things** (device limit vs. shutdown) with
  different retry hints (30s vs 5s). Split the code (`busy`/`full`?
  or a `reason` field). Clients already branch on the hint; make the
  contract explicit instead of numeric.
- **Single-vault server.** `serve -vault default` serves one vault;
  multi-vault means multi-process. For "one person's devices" that
  is arguably correct (one vault per server keeps the blob store
  trivially partitionable and the backup story simple). But it makes
  the server a poor fit the moment someone has two vaults (work +
  personal) — two ports, two volumes, two backup timers. Decide and
  document: either "one vault per server, forever" (and simplify:
  drop `-vault`?) or a vault namespace with per-vault auth. Drifting
  between the two (a `-vault` flag on a one-vault server) is the
  worst option.
- **Batching caps are asymmetric by construction** (`maxBatchBytes`
  lowerable-not-raisable, frame limit 2x largest legal message).
  Fine. But the 16 MiB `putmany` cap plus per-entry budget means a
  first sync of a large vault is many round trips *by policy*, and
  the measured numbers (54s up / 22s down for the real vault on
  loopback) will be worse over tailscale latency. A **server-side
  streaming import** (one long-lived `putmany` stream rather than
  N capped batches) would cut handshake overhead for the bulk case
  without touching the steady state. Measure first; the current
  numbers may already be good enough.
- **Timestamps (`ctime`/`mtime`) are client-supplied and MAC-covered
  but not verified** — a device with a skewed clock writes history
  entries that sort oddly in the UI. Content never depends on them
  (merge uses hashes, cursor uses uids — good design), so this is
  cosmetic. Cheap fix: server stamps arrival time alongside, UI
  prefers it.

---

## 8. What should not change

- **One static binary, pure-Go SQLite, no TLS in the server.**
  Every part of this is load-bearing for the homelab story. The
  Docker image at 5.2 MB compressed is a feature.
- **Ack-after-durable, deletions-as-entries, verify-the-outcome.**
  The durability rules read like scar tissue because they are. Rules
  1–10 stay verbatim; only *add* (candidate rule 11: "a recovery
  path tested only in docs is a rumour" — the restore rehearsal
  exists as prose; promote a rehearsal to CI with a fixture backup).
- **Incident-next-to-rule documentation.** The comment style (rule
  number + story + test that pins it) is the reason this codebase
  can be reasoned about. `compared.md`'s "measured and deliberately
  not done" section is the best scope defense in the repo — every
  rejected idea with its number attached. Extend the pattern to the
  merge's rejected alternatives (done) and the server's rejected
  features (partially done).
- **The test-first-fix discipline (rule 9).** `todo.md` marks every
  item with whether a failing test exists yet. Nothing below is
  "finished" until the test fails first.

---

## 9. Suggested order, if any of this is taken up

Status as of 2026-09-03.

1. **Fuzz the merge.** Done, and it was the highest value item here by a
   distance. Four defects in total, every one producing text neither device
   wrote with all existing checks green: a line added into a blank line the
   other side deleted, spans separated by the space after a bullet, a rewrite
   sharing a prefix that inserts rather than replaces, and a splice inside a
   word. The `sameLines` hole in section 2 is real too and is now closed. Cost
   measured at 0.18% of clean merges becoming conflict copies, a fourth rule
   rejected at 0.3%, and the remaining residue documented with case numbers.
2. **`compose.yaml` pin + mobile test plan.** Pin done, and the reasoning here
   was wrong: the image builds on a `server/v*` tag, so a client-only release
   correctly ships no image and a check against the plugin's manifest would
   fail every time. Checked in CI now, docs included, since `docs/server.md`
   had gone stale the same way. Mobile test plan still needs a phone.
3. **Plugin rebase + rotate visibility.** Done, and full rotate rather than
   a link. The claim that the rebase code "exists and is simply not wired" was
   half right: the primitives were in core, the procedure was welded to the
   CLI. Wiring it found the real reason a rotate button would have been unsafe,
   which was not the button: the plugin's run loop never tried an outstanding
   `pending` rotation, so a rotation whose reply was lost on a phone left the
   new secret written down with nothing that would ever try it. A vault locked
   by a dropped packet. Both shells now share one credential list.
4. **Backup generation metadata to a retention story.** Done. `backup.json`
   records uid range, version count, uid counter and purge generation per
   vault, and `stats -json` reports the generation, so "which backup covers
   this uid" and "is the fresh one complete" are both answerable without
   opening SQLite.
5. **Chunk identity and envelope design for protocol 4.** Not started. This is
   a design decision, not a fix, and wants deciding before protocol 4 is
   needed for something urgent.
6. **Per-device credentials spike.** Not started. The biggest philosophy
   decision in this document and the one least suited to being done quietly:
   it trades the one-string pairing for a device registry on the server.
7. **Index storage measurement at 10k/50k notes.** Done, and it answers the
   SQLite question no. A full index rewrite costs 4 ms at ten thousand notes
   and 14 ms at fifty thousand, against passes measured in tens of
   milliseconds. Numbers, caveats and the one cold-cache outlier are in
   `docs/compared.md`.

Also done, from section 1 and section 3: the pre-auth version disclosure, which
turned out not to be `/health` or `ready` (both already fine) but the protocol
and crypto refusals; the `fflate` golden gate, which was already blocking and
is now verified to block by corrupting a vector rather than by reading the
workflow; `-max-file` refusing to strand files at startup; and purge saying
what it did not reclaim.

Decided against, with the reasoning recorded in `docs/protocol.md`: splitting
`busy` into two codes. The client picks retryability from an allowlist, so a
code it has never seen is not retryable, and a device at the connection limit
would stop for good rather than come back.
