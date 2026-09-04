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
screen distributed across flags, CLI options, and constants, with the
worst property of both worlds: no single place to see them, and the
"answered once in the source" ones (`OWN_LIMITS`, chunk targets) are the
ones a phone user most needs to change and least can.

Two honest directions, pick one:

- **(a) Stay the course but centralise.** One documented table of every
  tunable, its default, and why it is not in the UI: `compared.md`
  already does this for chunking; do it for everything. The current
  state (some in `docs/server.md`, some in comments, some only in code)
  is how a default gets changed in one place and not the other.
- **(b) Admit a small config surface.** A read-only-on-devices,
  server-advertised config (`ready` already carries ceilings; extend it
  to policy: max-file, retention, invite default TTL) plus a local
  device config (ignore patterns, debounce). The protocol already
  solved the hard part: capability advertisement at hello. Policy
  advertisement is the same mechanism.

The argument *for* the current refusal is real: every option multiplies
untested combinations, and the test suite is the project's crown jewel.
But several refusals have already been re-litigated by reality
(`-allow-origin` exists because phones exist; `--ignore` exists because
vaults contain things people don't want synced). A philosophy that keeps
losing the same fight should be amended, not re-asserted.

**"One person's devices" vs. the trust model.** Every device holds the
same root secret; there is no revocation, only rotation plus re-pairing
every device. That is coherent for one person, until the person has a
phone, a laptop, a work machine, and a NAS, and rotation means touching
all four while the plugin (the thing on three of them) cannot rotate.
The current answer to "stolen laptop" is: find a machine with the CLI,
rotate, re-invite everything. For a notes app, that is a weekend. The
rethink was **per-device credentials** (server stores a device list, each
device holds its own key derived from the root, revocation is deleting a
row). It costs the "pairing string is one string" elegance and adds
exactly one server-side concept (a device registry). It also fixes the
8-device cap's cliff (refused with `busy`, which also means "server
shutting down", two unrelated conditions sharing one code and one
retry hint). Taken, as protocol 4: the server stores a device list, each device
holds its own secret plus the data key, revocation is deleting a row,
rotation touches no row, and the root lives offline as the recovery key.
It cost the one-string pairing (an invite string plus a device row
instead) and one server-side concept (the registry), as predicted. What
the review of that work found is that two sentences now overclaim the
boundary. "A device cannot add another one behind you" is false via
device-issued invites (any device may `invite`, and redeeming registers a
row: necessarily so, since the recovery key stays offline), and any
device can revoke any other device including `--allow-last`. Both are
probably accept-and-document: the invite path is the design,
revocation-by-phone is the point, rows are visible with creation times,
and everything is recoverable via the offline key. But the philosophy doc
should state the real boundary (register / rotate / the key itself)
instead of the comforting one. Done since: the sentences state the honest
boundary (a device cannot add unseen, rows plus outstanding invites ride
in one `devices` listing), `--allow-last` is the registrar's alone, and a
recovery key that could not prune the list would leave a vault of eight
crashed pairings with no way back, so list/prune were admitted to it with
the widened power written in `design.md` rather than quietly taken.

**"The server is an opaque blob store and stays one": mostly true,
two leaks to look at.** The server learns chunk equality (stated,
load-bearing for dedup) and per-path activity/timing/sizes (stated).
Both are accepted. What is *not* stated anywhere: the unauthenticated
`/health` endpoint plus the handshake's `serverVersion` and vault
existence oracles give an internet-facing prober a version string,
vault names validity (`auth` never says which of token/vault was wrong: 
good, but hello still distinguishes `proto`/`badname`/`busy` from
`auth`, which is a small oracle). None of this threatens ciphertext.
But "TLS terminates in front, port is open to the internet" (Caddy
setup) plus version-string disclosure is how targeted exploitation
starts. Since: the version is gone from pre-auth refusals, and the
remaining oracles were assessed rather than collapsed, two are decided
against constants published in `protocol.md` before any credential is
read (a client must be told which end to upgrade), the third is not
reachable before auth at all, and the property is now a test: the same
probe against a served vault and an unknown one must give byte-identical
frames.

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
into "conflict copy" in every case tested, but the test corpus is
finite and the library's failure modes are not enumerated anywhere.
The `sameLines` comparison explicitly concedes a hole (a line moved to
different places by the two directions passes) because the daily-note
case forces order-insensitivity. So the merge is: brilliant mitigation
around an unmaintained core, with one documented hole, defending the
most important property in the system ("do not lose a note"). Since:
the fuzzer closed the documented hole, the hybrid shipped as the default
with both modes measured on the same seeds, and the corpus work moved the
remaining residue from mangled text to ambiguous ancestors, which is what
item (3) below now concedes as its territory.

Candidate rethinks, in increasing order of ambition:

1. **Fuzz the merge.** The module is pure (`base, mine, theirs` in,
   outcome out), the cheapest high-value work in the repo. Property:
   every non-whitespace token of both sides survives in `merged`
   output, or the outcome is `conflict`. The existing tests are
   hand-built cases; a fuzzer with repetitive content (the observed
   failure shape: N similar sections) would attack exactly the fuzzy
   matcher. This is not a direction change, just an unfinished job.
2. **Line-anchored hybrid. Built, measured, and shipped as the
   default.** diff3's region discipline for line structure plus
   diff-match-patch *within* a region both sides touched. The rejection
   of `node-diff3` had tested diff3 *alone*, which conflicts on any two
   edits to one paragraph; the hybrid keeps the daily-note merge and
   gains real regions. `merge-regions.ts` computes the regions (125
   lines of code, no new dependency: the line diff it needs is
   diff-match-patch's own, already in the bundle), `mergeText` walks
   them, and `mergeTextCharacters` is the old whole-file merge, kept as
   the fallback for a note whose line structure cannot be computed and
   still tested as a merge in its own right.

   Measured by `merge.fuzz.run.ts`, a million generated cases per mode,
   both merges on the same seeds, per hundred thousand cases:

   |            |         | merged | conflicts | defects |
   | ---------- | ------- | -----: | --------: | ------: |
   | **placed** | classic | 70,184 |    29,816 |     1.8 |
   |            | regions | 94,519 |     5,481 |     1.6 |
   | **tokens** | classic | 57,321 |    42,679 |     0.2 |
   |            | regions | 85,266 |    14,734 |     0.1 |

   A defect is a `merged` outcome whose text is not a merge of what the
   two devices wrote. Both numbers improve, which is unusual enough to
   distrust, so: the residue also changed in kind. Over 300,000 oracle
   cases every one of the character merge's defects is a line neither
   device wrote, and none of the region merge's are; what is left there
   is an added line placed against the wrong paragraph, in ancestors
   that genuinely read two ways. The defect this file's own fuzzer
   documented as unfixed (`mine1` landing on the other device's new
   line) now merges, correctly. Swapping the two devices over changes
   the lines in neither merge over 200,000 cases per mode, which is the
   one check with no model of a right answer behind it. It is also
   about twice as fast on a large note.

   The cost, because a merge that refuses less decides more: a device
   that deletes a paragraph while the other appends now merges to the
   appended text where the old merge kept both copies, and the order of
   two lines added at one point can differ from what the character
   merge chose. Four cases in `merge.test.ts` that used to be conflicts
   are now exact texts, each checked by hand against what the two
   devices meant; the character merge's behaviour on all four is still
   pinned, on the fallback entry point.

3. **A CRDT for text (Automerge/Yjs).** The actual direction change.
   Kills the merge module, the `synchash` ancestor scheme, and the
   whole class of "placed wrongly" failures, at the cost of a
   document model (char-level ops history), larger metadata, and a
   dependency with its own complexity. For prose notes edited on two
   devices, CRDTs are the solved answer; the reason to hesitate is
   that Basalt's merge is *already* good for the common cases and a
   CRDT is a rewrite of the sync core, not a swap of one module.
   Recommendation: (1) and (2) are done. Keep (3) as the named
   alternative in `design.md` so the next merge bug has somewhere to go,
   and note that (2) moved the target: what is left to a CRDT is the
   residue of ambiguous ancestors, not mangled text.

Also: `stillValid` turned out to be load-bearing rather than speculative: 
the corpus built for it (193 of 4,420 canvas merges producing a file
Obsidian will not open, every one a missing comma between siblings) is
what catches them. Excalidraw got the same treatment: `name.excalidraw.md`
merged as prose with no gate, empty drawings both sides drew on broke 744
times in 4,882, and the gate abstains unless all three versions hold a
readable scene. SVG and XML were measured and declined: no separator
between siblings means the same edit stays well formed (0 broken in 53,260
against 299 in 17,414 for the JSON control), and refusing those types would
turn 53% of merges into conflict copies to catch nothing. Still open: the
orphaned edge, which needs `stillValid` to see the ancestor and both sides.

---

## 3. Crypto and chunking: the coupling that can never be retuned

Three parameters are **baked into chunk names** (hash of sealed
ciphertext): chunk-size targets, the deflate level, the sealing
construction. `compared.md` says so explicitly: "Changing either
re-chunks every vault in existence." That was fine for a prototype.
For a system with users, it means the most performance-critical
numbers in the codebase are immutable without a flag day, and there
is no migration mechanism. Protocol 4 declined to be the vehicle (spent
on credentials; old versions dropped after a day of single-user use), so
this waits for protocol 5, with the stated rule for how compatibility gets
written then.

**Spiked on 2026-09-04, and not taken. What the spike found:**

The section below proposes naming a chunk by the hash of its plaintext. That is
a security regression the proposal does not mention, and it is worse than it
looks. A plaintext hash is computable by anyone, so a name list becomes a
confirmation oracle against a dictionary of known documents. It is also the
same number in every Basalt vault that will ever exist, so one table serves all
of them. And a note below the chunk minimum is a single chunk of its exact
bytes, which makes its name a hash of the whole note: for guessable content
that is not membership testing, it is recovery. All three contradict
design.md's stated leak, which is length and equality and nothing else.

Naming by an HMAC of the plaintext under a key derived from the data key fixes
all of that and keeps dedup. It was prototyped. It still should not ship:

- **It decouples two parameters of three, and not the one that matters.** The
  deflate level and the sealing construction come apart. Chunk-size targets do
  not and cannot: moving a boundary changes the plaintext, so an HMAC of the
  plaintext is exactly as sensitive to it as a hash of the ciphertext. Measured
  at 0 names shared of 126 under both schemes.
- **The server stops being able to check itself.** `chunks.Name(body)` is
  recomputed in five places, and a keyed name kills all of them: put-time
  verification, frame matching by hash, `Get`'s bit-rot check with its
  quarantine and self-heal, and `verify -deep`. Rot would surface on a device
  as a note that will not decrypt. It can be rebuilt by having the client send
  a body hash the server files under, but that is a schema change, a wire
  change and a table whose loss orphans every body, which is most of the cost
  the proposal says it does not have.
- **The migration is the most expensive one this project will ever pay**, and
  paying it now removes a hypothetical one later. Old names cannot be mapped to
  new ones by anything but a device holding the plaintext, so the first touch
  of every file re-uploads it in full and the store roughly doubles for good.

Runtime cost, in fairness, is nothing: the HMAC replaces the existing hash
rather than adding one, and end to end it is inside noise.

**Also record two things this document has wrong.** "Changing either re-chunks
every vault in existence" is loose: changing the level moves no boundaries, so
it re-names and re-uploads rather than re-chunking. And the same sentence in
compared.md wants the same correction.

**The cheap alternative, also not taken, and for a better reason.** A device
can remember locally which name it uploaded a given plaintext chunk under, so a
parameter change costs it nothing on the wire (measured: 2 chunks and 12.5 KiB
against 43 and 156 KiB). It needs no protocol change and leaks nothing. It is
still not worth building today, because its benefit is exactly zero until
somebody retunes a parameter, it pays for itself the moment they do, and it
costs about 23 per cent of the index, which is the file the first rule is
about. Build it on the day a retune is actually wanted, not before.

**Keep the HMAC design on file for one case only:** a construction change that
is forced rather than chosen. If AES-GCM or the SIV shape ever has to go,
re-sealing under today's naming renames every chunk, which rewrites every
entry's chunk list, which re-MACs the whole of history. Under HMAC naming
history survives intact. That is a genuinely better migration and the only
argument here that does not concede.

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
  truncation behaves randomly, standard, fine, just say it once.
- **`fflate` determinism** is load-bearing (same chunk must seal
  identically on desktop and phone) and currently asserted by golden
  vectors (`compression-golden`). Good. The risk is a future `fflate`
  upgrade silently changing bytes: pin the version (done) *and* make
  the golden test a CI gate that blocks dependency bumps (check that
  it is, a test that exists but doesn't gate is documentation).

---

## 4. Sync core: the index is a JSON file doing a database's job

The engine is the best-tested part of the system and it shows: every
major invariant has a comment citing the incident that produced it.
Three structural observations:

- **The journal is wired in, and wiring found three things reading had not.** The rethink grew a spec, an implementation and tests, and then
, the part reading could not do, callers: both shells are thin wrappers
  over it with load and save unchanged to theirs, so neither shell's
  call sites needed edits. A snapshot with no sequence took another device's deltas by
  coincidence, so a log is never applied to one: such a device takes a
  whole snapshot to establish a sequence, then journals, losing no cursor.
  Two writers were demonstrated, not argued about: both number their next
  record one, replay stops at the collision, everything after is discarded,
  three saves recovered as the first with one note gone and neither writer
  noticing. Made loud rather than locked (the CLI lock already covers every
  writer, the plugin keeps its index elsewhere): both files stamped and
  checked, a foreign file answered with a whole snapshot and a warning.
  Replay was quadratic at 454 ms to start a client at ten thousand notes;
  rule 8, fixed before it shipped.
- **The whole index is stringified and rewritten on every change.**
  At 10,000 notes the index is 5.6 MiB; the `packed`/`unpacked`
  dance already exists because chunk names were stored 3x. This is a
  durability smell (a torn write during a 5.6 MiB rewrite is the
  failure `validateStoredState` exists to catch: good) and a
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
  Obsidian): correct for A→B→C, but the comments show rename
  handling has produced multiple real bugs (conflict-copy upload
  timing, case-only renames needing `wroteThisPass` lifetime fixes).
  Renames are one operation on the wire but N edge cases in the
  engine. Consider: resolve renames at scan time (match by content
  id: disappeared path + appeared path with identical `hash` =
  rename) instead of tracking `prev` across passes. Content ids
  already exist; the scan already hashes everything. That collapses
  a stateful chain into a stateless observation. Declined, and the trial is
  worth recording because the proposal reads so plausibly: identical files
  are ordinary in a vault (empty notes, templates), a rename plus an edit
  changes the hash and stops looking like one, a delete then create of
  identical content becomes a false one, and the current code deliberately
  matches Obsidian's own `previouspath`. Scarred code in the path that
  produced the incidents is not the place to trade state for a guess.
  Revisit if renames start producing new bugs.
- **The `blocked`/`skipped`/`ignored`/`refusedInbound` taxonomy is
  four maps doing one job** ("paths we are not acting on, and why").
  Each was added for a real incident and each comment justifies its
  separation. But rule 7 cuts both ways: four categories is three
  distinctions a user must learn. `ignored` (user-configured) vs.
  everything else is the one distinction that matters; consider
  merging `blocked`+`skipped`+`refusedInbound` into one
  "needs attention" set with reasons, keeping `ignored` apart (it
  already has its own exit-code semantics, R2). Done, and half the proposal
  was wrong in the instructive direction: the report is now one list, but
  the four maps underneath are byte-identical: each came from its own
  incident, and merging them would throw away four incidents' worth of
  learning to save a noun. One renderer drives the CLI, the panel notice,
  the status line and the glyph, so the two shells cannot drift into
  separate vocabularies again.

---

## 5. Operations: the backup/purge/restore story is safe and heavy

The safety properties are genuinely good: backup verifies before
reporting success, stages-then-renames, never deletes; purge demands
the vault name *and* proof of a fresh backup; the restore rehearsal is
documented step by step *and* runs in CI as its own job, with injected
faults. This is the part of the repo most shaped by
"do not lose a note," and it reads like it.

The cost is operational weight, and three things deserve rethinking:

- **Purge requires stopping the server.** The stated reason (exclusive
  `data.lock`) is sound, but the consequence is that reclamation: 
  the most routine maintenance: is the highest-ceremony operation
  (stop, backup, purge, start; under Docker, a multi-container
  dance). An online purge (snapshot the live set, delete only bodies
  unreferenced by *both* the snapshot and anything written since,
  under a grace window) is strictly more code in the most
  durability-critical layer, or, alternatively, make the server
  *do* the purge itself on a timer/SIGUSR with the backup check
  built in. The current design optimises for "purge must never be
  wrong" over "purge must actually happen"; unpurged servers grow
  until the disk fills (`nospace` refuses uploads: safe, but the
  alert table's answer is "purge after a backup," i.e., the heavy
  path under pressure). Since: the visibility half is built: `stats` says
  reclaimable bytes in prose and JSON, the startup line carries it, and the
  preview mirrors the delete's own predicate (drift-tested), so a purge
  happens because somebody was told, not because the disk filled. No new
  deletion path, no timer, no online purge: that stays a stopped-server
  ceremony because purge is the one command that destroys what no device
  holds, and that stays a separate decision.
- **Backups grow forever by design** ("start a fresh backup dir after
  a purge, keep the old one, delete it whole"). Honest, but "delete
  it whole" is a retention policy expressed as a shell command with
  no schedule, no reminder, and no verification that the fresh dir
  is complete before the old one goes. At minimum: `basaltd backup`
  should record generation metadata (uid range, timestamp, purge
  generation) so a script, or a future `basaltd retention`: can
  decide what is safe to drop. The metadata is also what makes
  "which backup covers this uid" answerable without opening SQLite.
  Done: `backup.json` records uid range, version count, uid counter and
  purge generation per vault, `stats -json` reports the generation, and the
  runbook has an explicit verify-before-deleting step.
- **Rebase is CLI-only, and the plugin path is "unlink and pair
  again."** After a restore, *every plugin device* must be manually
  unlinked and re-paired, and re-pairing resets the merge base, so
  the device's notes come back as new versions with no ancestor: 
  the exact state in which the next concurrent edit cannot merge
  and produces conflict copies. The restore runbook should say this
  plainly (it hints at it: "come back as new versions either way"),
  and the plugin needs rebase (or the engine needs "adopt server
  cursor + re-upload diverged files as new versions," which is what
  CLI rebase does, the code exists, it is just not wired to the
  plugin). Done: the procedure was extracted into core (`rebaseCursors`,
  `refuseUnlessAhead`) and the panel grows a *Rejoin this server* row only
  while that device is the one refused, and wiring it is what found that a
  rotate button would have been unsafe for a different reason (the plugin's
  run loop never tried an outstanding `pending` rotation), fixed by sharing
  one credential list across both shells.

---

## 6. Platform: iOS is the roadmap's load-bearing "should"

"iOS is untested. It should work." The bundle contains nothing
Node-specific: true, and insufficient. Known unknowns, all named in
the docs but not tracked as work: streaming fallback reads whole
files on mobile (memory curve sets the 64 MiB default, but that curve
was measured on desktop-class memory, an older iPhone jetsamming
mid-sync is a data-loss-adjacent event only by luck of staging);
no fsync on phones (note-then-index ordering is best effort, crash
window is real); background sync doesn't exist on either mobile OS
(stated) but the *first-sync-needs-screen-on* requirement has no
progress UI beyond a status line; `-allow-origin` for future Obsidian
builds is reactive (log grep) rather than proactive. None of this is
an argument against shipping: Android-in-daily-use is real
validation. It is an argument for a **mobile test plan with numbers**:
memory ceiling on a specific old phone, first-sync time for the
3,751-file real vault over real latency, kill-and-resume behavior.
"Should work" graduating to "measured on" is one TestFlight session
plus a borrowed iPhone.

Related: the **plugin's two unverified files** (`main.ts`,
`vault.ts`: "this is the one file that cannot be tested") are the
files that touch real user data on real devices. The Obsidian stubs
(`stub.ts`, `fake.ts`) exist; the question is whether they are
faithful enough that passing against them means anything. The highest
value test investment after merge fuzzing: a **vault-fidelity suite**
that replays recorded Obsidian event sequences (rename storms,
rapid saves, trash behavior, `.trash` vs system trash, dotfile
indexing gaps) through the real `ObsidianVault` adapter against the
fake API, asserting no-loss invariants rather than UI behavior. Done, and
the suite's first finding was that the fake was not faithful: six
divergences from the shipped Obsidian binary (hidden dot paths, no
case-folding model, `trashLocal` keeping full paths, empty-vs-throwing
`list`, the missing vault root, one-event-per-descendant renames), fixed
before any assertion could mean anything. It then found a real ordering
bug, a write landing during a flush crossed off as durable without being
fsynced: unreachable today (the engine awaits a whole pass before
flushing) and fixed as a documented claim made true. What has not moved is
everything in the paragraph above: iOS is still untested, and the mobile
memory curve is still desktop-class.

---

## 7. Protocol and transport: keep the wire, fix the edges

The protocol doc's six inversions of Obsidian Sync's defects are the
clearest writing in the repo, and request ids + `retryable` + named
outcomes (`have`/`want`/`ack`) are all load-bearing lessons. No
direction change proposed. Protocol 4 has since happened: spent on
per-device credentials, with protocols 1–3 removed rather than carried
(the range stays in the handshake for next time). Edges worth smoothing
in a protocol 5:

- **`busy` means two things** (device limit vs. shutdown) with
  different retry hints (30s vs 5s). Split the code (`busy`/`full`?
  or a `reason` field). Decided against splitting (see §9): an unseen
  code is not retryable under the client's allowlist, so the device that
  most needs a retry would stop for good.
- **Single-vault server.** `serve -vault default` serves one vault;
  multi-vault means multi-process. For "one person's devices" that
  is arguably correct (one vault per server keeps the blob store
  trivially partitionable and the backup story simple). But it makes
  the server a poor fit the moment someone has two vaults (work +
  personal), two ports, two volumes, two backup timers. Decide and
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
  without touching the steady state. Declined (see §9): a first sync
  happens once per device, a poor trade against a second path through
  the most durability-critical code. Re-measure over real tailscale
  latency before reopening, not before building.
- **Timestamps (`ctime`/`mtime`) are client-supplied and MAC-covered
  but not verified**, a device with a skewed clock writes history
  entries that sort oddly in the UI. Content never depends on them
  (merge uses hashes, cursor uses uids: good design), so this is
  cosmetic. Cheap fix: server stamps arrival time alongside, UI
  prefers it. Declined, with the checking behind it: nothing sorts by a
  clock (history is ordered by uid) and `readyToSyncAgain` compares two
  reads of the same clock so a constant offset cancels, a skewed device
  mislabels a version rather than misplacing it. The proposed fix would put
  server-written time, covered by no key, in front of a person choosing
  which version to restore, trading away "it cannot write anything
  either" for a nicer label. What shipped instead is one report per
  session when a device declares times more than a day ahead.

---

## 8. What should not change

- **One static binary, pure-Go SQLite, no TLS in the server.**
  Every part of this is load-bearing for the homelab story. The
  Docker image at 5.2 MB compressed is a feature.
- **Ack-after-durable, deletions-as-entries, verify-the-outcome.**
  The durability rules read like scar tissue because they are. Rules
  1–10 stay verbatim; only *add* (candidate rule 11: "a recovery
  path tested only in docs is a rumour", the restore rehearsal
  exists as prose; promote a rehearsal to CI with a fixture backup).
  Earned 2026-09-04: the rehearsal runs on every push as its own CI job
  (`-tags rehearsal`), backing up, losing the original, verifying deep,
  serving, and reading every version and body back over a real connection,
  with four injected faults, three caught by backup checks or `verify
  -deep`, the fourth (a restored vault serving fewer versions than the
  backup held) caught by nothing but the read-back, which is the clause the
  rule turns on. `CLAUDE.md` says eleven rules now.
- **Incident-next-to-rule documentation.** The comment style (rule
  number + story + test that pins it) is the reason this codebase
  can be reasoned about. `compared.md`'s "measured and deliberately
  not done" section is the best scope defense in the repo: every
  rejected idea with its number attached. Extend the pattern to the
  merge's rejected alternatives (done) and the server's rejected
  features (partially done).
- **The test-first-fix discipline (rule 9).** `todo.md` marks every
  item with whether a failing test exists yet. Nothing below is
  "finished" until the test fails first.

---

## 9. Suggested order, if any of this is taken up

Status as of 2026-09-04.

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
5. **Chunk identity and envelope design.** Not started, and it is the only
   substantive design item left here. It was written as "for protocol 4" and
   protocol 4 has since been spent on per-device credentials, so it is
   protocol 5 now. Still a decision rather than a fix, and still wanting to be
   made before something urgent forces it. What has improved meanwhile is that
   the compatibility story now has a worked example, protocol 3 dropped after
   a day of single-user use, and a stated rule: the range stays in the
   handshake, and next time compatibility gets written against a protocol that
   has actually run.
6. **Per-device credentials.** Done, as protocol 4. This was called the
   biggest philosophy decision in this document and the one least suited to
   being done quietly, and it was done loudly: a device registry, redemption
   that registers in one transaction, silent self-conversion with a test per
   crash point, and invites carrying the data key instead of the root. It cost
   the one-string pairing and added exactly one server-side concept, as
   predicted. The review pass found two sentences that overclaimed the
   boundary and one visibility gap, all in `todo.md`. What it did not find is
   a reason the trade was wrong: rotation without re-pairing every device is
   the feature that justifies the registry.
7. **Index storage measurement at 10k/50k notes.** Done, and it answers the
   SQLite question no. A full index rewrite costs 4 ms at ten thousand notes
   and 14 ms at fifty thousand, against passes measured in tens of
   milliseconds. Numbers, caveats and the one cold-cache outlier are in
   `docs/compared.md`.
8. **Journal wiring.** Done, and it paid for itself three times: the
   sequence-less snapshot taking another device's deltas, the two-writer
   collision discarding records silently, the quadratic replay. The spec
   got all three wrong; building beat reasoning, as it usually does when
   the thing being built is a store.
9. **Devices gaps from the protocol-4 review.** Done: `--allow-last` gated
   to the registrar (with list/prune admitted alongside it, or a vault of
   eight crashed pairings has no way back), outstanding invites riding the
   `devices` listing with `uninvite` on both credentials, the rotation-race
   guard carried from `register` to `revoke`, never-connected rows flagged
   and counted with the full refusal naming them. The two overclaiming
   sentences now state the honest boundary.
10. **Purge visibility plus the restore rehearsal.** Done: reclaimable
    bytes in `stats` and on the startup line, preview mirroring the
    delete's predicate under a drift test; the rehearsal in CI as its own
    job, four faults injected, rule 11 earned. The online purge stays a
    separate decision, deliberately not taken.
11. **Excalidraw, clash parity, one attention list.** Done, plus one
    measured refusal: the drawing gate (abstaining unless all three hold a
    scene), the plugin blocking a clash pair like the CLI, the four maps
    kept with one renderer over them, and no SVG/XML gate, because the
    corpus says zero broken in 53,260 and refusing would conflict 53% to
    catch none.

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

Also declined, each with the measurement or the argument in the commit that
declined it: server-stamped arrival time for clock skew (uids order, offsets
cancel, one report per session past a day); collapsing the pre-auth oracles
(clients must be told which end to upgrade; byte-identical-frames test instead);
rename resolution at scan time (a guess more ambiguous than the state);
server-side streaming import (once per device against a second durable path);
an SVG/XML validity gate (zero broken in 53,260; refusing would conflict 53%
to catch none).
