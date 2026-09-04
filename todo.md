# Todo

Bugs and defects to fix, from reading the code and docs.

Status as of 2026-09-04. Items marked done carry the test that failed first;
items marked not reproduced were investigated and the concern did not survive
contact with the code, which is recorded rather than deleted so nobody
re-opens them from the same reading.

**Rule 9 applies to every item:** a fix without a test that failed first
is not finished. Items marked `[needs-repro]` are suspected from reading
and must reproduce (failing test, reverted fix, restored fix) before they
count. Items marked `[verified-by-reading]` were confirmed in the source
but still want the failing test.

Severity is about notes at risk, in this order: silent data loss >
refused-but-confusing > operational footguns > leaks/hardening.

---

## Silent-loss or wrong-data risks

- [x] **`sameLines` order-insensitivity could pass a misplaced hunk.**
  **Done, and it was real.** The fuzzer produced the case the docs only
  suspected: a line inserted before `setup(); (1)` coming out before
  `setup(); (2)`, every line present, wrong section. Replaced by
  `samePlacement`, a line diff tagged by ancestor position; the five
  daily-note cases that force order-insensitivity still merge.

- [x] **diff-match-patch fuzzy matcher is the untested core.** **Done, and
  it found three more defects.** A seeded fuzzer over `mergeText`: 2.4 million
  cases across twelve base seeds out of band, with a fast subset in the suite.
  It found three shapes that produce text neither device wrote while all four
  existing checks report success. Spans separated by the space after a bullet,
  so nothing overlaps. A rewrite sharing a prefix, which is an insertion rather
  than a replacement and lands exactly where the other device's edit lands. And
  a splice inside a word, where no span is guilty and only the outcome is
  (`- line hereirs0`). Two new checks, `splicedAdditions` and `inventedWord`,
  at a measured 0.18% of previously clean merges becoming conflict copies. A
  fourth rule was tried and rejected at 0.3% for partial coverage. A residue of
  about two per 100,000 is documented with its reproduction case numbers rather
  than claimed clean.

- [x] **Unicode normalization across platforms (NFC vs NFD).** **Done,
  and it was real.** The engine folds NFC for its alias check and the
  plugin normalises through Obsidian, but `NodeVault.list()` handed out
  whatever bytes `readdir` returned, so a Mac running the headless client
  synced accented names under a spelling no other device produces. Two
  devices that each created the note refused the other's copy for ever as
  "in the way", naming two strings nobody can tell apart. No note lost,
  the alias refusal saw to that, but the vault never converged. Fixed at
  one point per shell: `list()` reports NFC and remembers the disk's
  spelling, `absolute()` maps back segment by segment. Migration note in
  `client/README.md`. Three tests fail without the fold.
- [x] **Case-only collisions between case-sensitive and
  case-insensitive filesystems.** **Not reproduced, no change.** Current
  behaviour is by design and loses nothing: `refuseAliases` sees the local
  `note.md` in the way of an incoming `Note.md`, writes neither, and names
  the blocker every pass. Two tests added, one with a real APFS vault as
  the Mac, asserting the Mac's own text is untouched, the other side keeps
  both texts, and the server marks nothing deleted.
- [x] **Symlink scanning.** **Not reproduced, no change.** `readdir`
  with `withFileTypes` answers for the entry itself, so a symlink reports
  neither `isFile()` nor `isDirectory()` and the existing filter drops it
  before anything can follow it. Verified against the runtime, not
  inferred. Four tests cover a link to a file, a link to a folder, a
  cyclic link, and a peer writing over a link (which replaces the link and
  leaves its target alone). Left open deliberately: the skip is silent,
  with no reason reported. That is visibility, not durability.
- [ ] **Clock skew writes confusing history, and `readyToSyncAgain`
  trusts the local clock.** `[verified-by-reading]`. `ctime`/`mtime`
  are client-supplied; a skewed device writes entries that sort oddly
  and a debounce that misbehaves. Content safety does not depend on
  clocks (hashes + uids — good), so this is UI/confusion-severity,
  not loss-severity. Fix: server stamps arrival time; UI prefers it.
- [ ] **Whole-file fallback on mobile can OOM before the 64 MiB limit
  helps.** `[verified-by-reading]` (`compared.md`: mobile streaming
  untested, fallback reads whole file at ~210 MB + 2.7 MB/MiB;
  `server.md`: default limit "set for a phone"). The limit was sized
  from a desktop-class memory curve. An older phone syncing a 40–64
  MiB attachment may be jetsammed mid-pass. The staging design means
  no note is lost — but the file never syncs and the failure mode is
  a dead app, not an error. Needs a real-device measurement (see
  `improvements.md` §6); possible mitigations: lower advertised
  `perFileMax` from the plugin on low-memory devices, or chunked
  reads via the mobile URL scheme actually tested.

## Refused-but-confusing / repair-path gaps

- [x] **`compose.yaml` pinned a stale image.** **Done, and the premise
  needed correcting.** The pin was behind, but not because the repo is at
  0.3.2: the image builds on a `server/v*` tag, and 0.3.2 was a
  client-only release, so no 0.3.2 image exists and none should. A check
  against `manifest.json` would fail every client-only release. Pinned to
  the newest server release with a digest read from the registry, and
  `docs/server.md` carried the same stale tag in its Docker runbooks,
  which are copied at least as readily. A CI job now compares both against
  the newest server tag: older fails, equal or newer passes, so the
  version-bump commit that lands before its tag is not blocked.

- [x] **Plugin has no rebase; post-restore path is "unlink and pair
  again."** **Done, and the code was less shared than it looked.** The
  primitives were in core, but the procedure (probe the cursor, refuse
  unless ahead, drop the index, settle) lived entirely inside the CLI's
  `cmdRebase`, welded to `Args`, `Console` and the filesystem. What was
  extractable is now in core as `rebaseCursors` and `refuseUnlessAhead`,
  and both shells call them, so the panel and the command line cannot
  disagree about where the two ends are or when this is allowed. The
  panel grows a *Rejoin this server* row only while that device is the
  one being refused, behind two presses: the first shows both versions,
  which is `--backup-taken`'s job on a surface where a flag has to be
  typed and a button is one thumb away. Removing the row fails
  "the panel offered no way back"; removing `refuseUnlessAhead` makes
  `rebase()` resolve on a device with nothing to rebase.
- [x] **Plugin cannot rotate; rotation needs the CLI.** **Done, in
  full, and the load-bearing part was not the button.** The plugin's run
  loop only ever had the spent-bootstrap fallback, so a rotation whose
  reply was lost would have left the new secret in `data.json` with
  nothing that would ever try it: intact ciphertext and no way in. The
  CLI's `candidates` and `settle` are now `credentialCandidates` and
  `settledConfig` in core and both shells use them, and the plugin writes
  the staged secret and reads it back (rule 4) before the request goes
  out. `plugin/rotate.test.ts` is `cli/rotate.test.ts`'s shape against a
  real server: drop the pending candidate and the after-commit test ends
  at "not authorised for this vault"; move the save after the send and
  two tests find no `pendingSecret`; write it to the file and not to the
  running plugin and the device that rotated needs an Obsidian restart to
  come back.
- [x] **`busy` conflates "vault full" with "server shutting down".**
  **Decided against splitting, recorded in `docs/protocol.md`.** Real
  ambiguity, but the client picks retryability from an allowlist, so a
  code it has never seen is not retryable: send a device at the connection
  limit a new `full` today and it stops for good, in the one case that
  most needs a retry. Nothing is lost meanwhile. Both want the same thing
  from a client, and they already differ in the two ways that carry, the
  retry hint and the message ("this server is shutting down" against
  "vault has 8 devices connected, limit is 8"), so the log-grepping
  complaint does not hold. If it is ever split, the client learns the code
  first and only then may a server send it.

- [x] **Lowering `-max-file` strands existing files.** **Done.** `serve`
  now refuses to start when the advertised ceiling is below a live file the
  vault already holds, naming the files by uid and size (paths are sealed,
  so that is all the server can say) and saying how to recover. Refuse
  rather than warn: a warning is read later by whoever reads journals, a
  refusal is read now by whoever typed the flag, and nothing can be lost
  by refusing. History and deleted files over the ceiling deliberately do
  not count.

- [x] **Purge's `-grace` silently reclaimed nothing.** **Done.** Purge
  now reports what it did not do, with the sweep's own byte counts rather
  than estimates, and names the `-grace 0` re-run.

- [x] **`cursor` refusal after restore: the log names the device, but
  nothing tells the device's human what to do.** **Done, at both ends
  that produce the refusal.** `refuseIfBehind` names both recoveries and
  what the blunt one costs, and it throws a `ProtocolError` under the
  server's own code rather than a plain `Error`: as a plain one
  `runForever` retried it three times and then reported it under a
  message about an entry no device can apply, which is a different fault
  with a different fix. The server's copy of the refusal cannot be
  changed from here and does not need to be, because the recovery is a
  client command the server has never heard of: the CLI appends it in
  `withRecovery` and the plugin recognises the code and puts the row on
  screen. Four tests fail without it, one of them the CLI's own restore
  test.

## Hardening / leaks

- [x] **Version string disclosed pre-auth.** **Done, and the leak was
  somewhere else.** `/health` already answered `ok` with no version, and
  `ready.serverVersion` already came after auth. The actual pre-auth leak
  was the protocol and crypto refusals, which any stranger triggers with
  one frame and which said "this server (version 0.3.2) speaks 3 to 3".
  They now name the range and not the release. `docs/design.md` gained
  "What a stranger on the port learns", including what is still learnable
  and why: that a Basalt server is there, and which protocol it speaks,
  because an old client has to be told which end to upgrade.

- [ ] **Pre-auth error codes distinguish failure kinds (`proto` /
  `badname` / `busy` vs `auth`).** `[needs-repro]`. `auth` correctly
  never says which of token/vault was wrong, but the surrounding codes
  still oracle "this vault id parses / this proto is old / server is
  full." Assess whether the distinction is needed before hello; if it
  is, say why in the protocol doc.
- [x] **`fflate` upgrade can silently change sealed bytes.** **Already
  gated, no change.** The concern was that the golden vectors run without
  blocking. They block: corrupting one vector makes the runner exit 1, and
  it is a CI step. Verified by corrupting a vector rather than by reading
  the workflow.

- [x] **Backup retention had no metadata.** **Done.** `basaltd backup`
  writes a versioned `backup.json` beside the database recording, per
  vault, the uid range covered, the version count, the uid counter and the
  purge generation, plus when it was taken. Written after the snapshot is
  published, so it can lag by one run but never claim more than the
  database holds. `stats -json` gained the same generation, so a script can
  compare the two without opening SQLite, and the runbook now has an
  explicit verify-before-deleting step.

## Found by the canvas corpus, not yet acted on

- [ ] **Only `.canvas` and `.json` get a validity gate.** `.svg`, `.xml`,
  `.yml`, `.yaml`, `.csv` and the source extensions are all in
  `TEXT_EXTENSIONS`, so they are merged as text with no `stillValid` at all. A
  malformed merge of an SVG or an XML file is the same failure the canvas case
  turned out to be, and nothing would catch it. Real validators mean real
  parsers, which is a dependency shipped to a phone, so this wants a cheap
  well-formedness check or a decision to refuse merging those types.
- [ ] **An Excalidraw drawing is `name.excalidraw.md`**, so its extension is
  `md` and it merges as markdown with no gate, although its body is a JSON
  block. Worth checking what a bad merge does to one.
- [ ] **A node deleted on one device against an edge drawn to it on the other**
  merges to valid JSON holding an orphaned edge, which Obsidian silently drops
  on the next save. Not a merge the code invented, since there is no third
  answer, but it is a silent edit loss. Telling it from an edge the ancestor
  already had needs `stillValid` to see the ancestor and both sides, which is a
  signature change. Pinned as a test with the reasoning.

## Protocol 4 (per-device credentials): review of the uncommitted tree

Server (protocol 4, device registry, redeem-registers) plus client
(conversion, invites, device sessions) reviewed 2026-09-04 with all suites
green: `go test -count=1 ./...` passes, `vitest run` passes 52 files /
1110 tests. No code changed by this review. Findings, sharpest first:

- [ ] **Docs overclaim: a device CAN add another device behind you.**
  `[verified-by-reading]`. `docs/design.md` ("What a device cannot do is
  add another one behind you") and `session.go`'s register refusal ("a
  stolen laptop ... cannot add a ninth device to the vault behind you")
  are both false via invites: any device session may `invite`, and redeeming
  registers exactly one device, so a compromised laptop issues a string on
  itself and redeems it on the attacker's machine. The *register* op is
  registrar-gated, but the invite path reaches the same row. This is not a
  regression (old invites carried the root, so old devices trivially could),
  and the design requires device-issued invites (recovery key stays
  offline), so the fix is honesty, not removal: state the real boundary
  (register / rotate / the recovery key itself), and say what makes
  invite-added rows survivable — they are visible in `basalt devices` with
  `added <when>` / `last seen`, revokable by any device, and outstanding
  (unredeemed) invites die on rotation and within the hour on expiry. Gap
  inside the gap: there is no visibility into *outstanding* invites at all.
  `devices` lists rows; an attacker-issued string sitting live for up to an
  hour is invisible until redeemed. Consider listing live invites (ids and
  expiry, never the blob) beside the device list, or record the decision
  not to.
- [ ] **Any device can revoke any device, including `--allow-last`.**
  `[verified-by-reading]`. `handleRevoke` has no registrar gate and honours
  `AllowLast` from a device session, so a compromised device can delete every
  other row and leave the vault reachable only by the recovery key. Usability
  demands device-may-revoke (the phone revoking the stolen laptop without
  typing the recovery key is the whole point of revocation over rotation),
  and it is recoverable (offline key re-registers), so this is almost
  certainly accept-and-document rather than fix — but it is a cross-device
  destructive power the docs never state. Record it next to the invite
  finding above, and consider whether `--allow-last` specifically should
  need the registrar: nothing about the common case needs it, and it is the
  one revocation that cannot be undone without the recovery key.
- [ ] **Lost redeem replies leave orphan rows against the 8-device cap.**
  `[verified-by-reading]` (design choice, documented in `redeemInvite`'s
  comment: save-nothing-first so a crash strands a server row, not a local
  device). The row is visible (`last seen never`) and revokable, and the
  alternative order strands the device instead, so the choice is right — but
  eight crashes, or eight attacker-added rows, fill the vault and `register`
  / redeem then refuse until a human revokes. Attack plus accident share one
  cap with no reclamation and no prompt. Cheap mitigations: `devices` could
  flag never-connected rows for cleanup, or invites could carry a
  replace-an-orphan hint. At minimum the cap-full refusal should name
  revocation of never-seen rows as the fix.
- [ ] **The index journal is built, tested, and not wired in.**
  `[verified-by-reading]`. `index-journal.ts` + `index-journal-store.ts` +
  two test files exist and pass, but nothing outside their own tests imports
  them; the engine still runs on the rewrite-the-JSON store. Until wiring
  lands this is dead code with a passing suite — the exact shape rule 9
  guards against drifting. Wiring wants three things the spec already names:
  the engine actually using it, migration of existing `index-state.json`
  (byte-identical-journal requirement is specified, good), and the
  single-writer rule enforced rather than commented (two shells, one vault
  dir, is the configuration that silently drops a journal of state).
- [x] **Protocol 3 dropped, both sides speak only 4.** Checked, no change.
  `MinProto = Proto = 4`, client refuses anything but 4, and `docs/server.md`
  already records that 3 lived one day with one user before replacement. An
  un-upgraded client gets a clean `proto` refusal naming the range, and
  conversion needs only the old root from the local config, so the upgrade
  order (server, then each client) still works. Nothing to fix; recorded so
  nobody re-opens it.
- [x] **Compose pin still current.** Checked, no change. Newest `server/v*`
  tag is v0.3.2 and the pin is 0.3.2; the manifest's 0.3.4 is the plugin
  moving on its own clock, which the CI check correctly ignores.

Done well, noted so the pattern repeats:

- `deviceAuth` gets its own HKDF string precisely so a device secret equal to
  the root cannot derive the vault credential — the confusion made
  unexpressible rather than unlikely, with the comment saying so.
- `generateDeviceId` refuses ids starting with `-` (a CLI option word), with
  the entropy cost stated (one char of 128 bits) and why it is affordable
  (the primary key, not randomness, makes collisions safe).
- `convertToDevice` carries six crash-point tests against the real server,
  including the lost-`registered`-reply fault injected exactly after commit —
  the window timing could never hit. Same device as the server's
  `betweenSpendAndRegister` hook for the redeem transaction. This is the
  rule-9 pattern at its best: the untestable window gets a hook, the hook
  gets the test.
- `RedeemInviteFor`'s comment states the rotation race explicitly (no vault
  hash needed because rotation deletes invites in its own transaction) with
  the test name attached. The claim is checkable, which is the point.

## Known divergence between the two shells

- [ ] **The plugin still throws on a name clash; the CLI blocks the pair.**
  `list()` in `cli/vault.ts` leaves two names that normalise together out of
  the listing and reports them through `ambiguous()`, so the rest of the vault
  syncs. `plugin/vault.ts` still raises. Unreachable today, because Obsidian's
  index is NFC before this code sees it, so it cannot hold both spellings. It
  is still two shells behaving differently where they are meant to be one
  engine with two adapters, and the CLI's rendering of the clash message has
  no test.

## Promoted out of improvements.md, with verdicts

These sat in prose in sections 4, 5 and 7 and never reached that document's
suggested order. Verdicts recorded so they are not re-argued from scratch.

- [ ] **Purge tells you when it is worth running. Worth doing.** Unpurged
  servers grow until `nospace` refuses uploads, and the documented answer is
  the heaviest ceremony there is: stop, back up, purge, start. The server
  already knows how many bytes are reclaimable, so say it in `stats` and in
  the startup line. Then a purge happens because somebody was told, not
  because the disk filled. Explicitly only the visibility half: an online
  purge is more code in the most durability-critical layer, and purge is the
  one command that destroys something no device holds. That stays a separate
  decision.
- [ ] **One "needs attention" list in the output, four maps underneath. Worth
  doing, in part.** Rule 7 says four categories is three distinctions a person
  must learn, and that is right about what is printed and wrong about the
  model: `blocked`, `skipped`, `ignored` and `refusedInbound` each came from a
  real incident and carry different exit-code semantics. Simplify the report,
  leave the engine alone. Merging the maps would throw away four incidents'
  worth of learning to save a noun.
- [ ] **Rename resolution at scan time. Declined.** The proposal is to drop
  the stateful `prev` chain and infer a rename by matching content hashes when
  scanning. The heuristic is more ambiguous than the state it replaces:
  identical files are ordinary in a vault (empty notes, templates), a rename
  plus an edit changes the hash and stops looking like a rename, and a delete
  then create of identical content becomes a false one. The current code also
  deliberately matches Obsidian's own `previouspath` behaviour. Its bugs were
  real and they were found, fixed and pinned. Rewriting scarred code in the
  path that produced those incidents, to trade state for a guess, is the wrong
  way round. Revisit if renames start producing new bugs.
- [ ] **Server-side streaming import for a first sync. Declined for now, and
  the source agrees.** improvements.md says "measure first; the current
  numbers may already be good enough". The numbers exist: 54 s up and 22 s
  down for a real 3,751-file vault. A first sync happens once per device.
  A second path through the most durability-critical code is a poor trade for
  that. Measure over real tailscale latency before reopening, not before
  building.

## Owed after protocol 4, before it can be called finished

- [ ] **The docs describe a product that no longer exists.** Protocol 4
  changed the key model, what a device stores, how a device is added, what
  rotation does and what revocation means. `docs/design.md`'s keys section,
  `docs/plugin.md`, `docs/server.md`'s runbooks, `client/README.md` and the
  README's security graphic all need going through against the code rather
  than patching the sentences that happen to be noticed. The security SVG in
  particular draws the old three-key derivation and is now wrong as a picture.
- [ ] **New screenshots.** The panel gained a device list and revocation, the
  pairing flow changed, and the recovery-key copy was rewritten. The four in
  the README are from the protocol 3 panel. Retake with the capturePage
  recipe (Electron, background throttling off), which does not steal focus.

## Test-coverage debts (not bugs, tracked here so they don't drift)

- [x] Merge fuzz harness. Done, see above.

- [x] Recorded-Obsidian-event fidelity suite for `plugin/vault.ts`. Done, and
  the fake it runs against was not faithful, which is the thing that would have
  made it worthless. Six divergences found by reading the shipped Obsidian
  binary: the index reported dot-prefixed paths it actually hides, there was no
  case-folding model at all and the one in the test file had the refusal rule
  missing, `trashLocal` kept the full path instead of moving to a basename that
  can collide, `list` on a missing directory answered empty rather than
  throwing, the index omitted the vault root, and a comment claimed a folder
  rename is one event when it is one per descendant. It then found a real
  ordering bug: a write landing during a flush could be crossed off as durable
  without being fsynced, with the index then naming it durable. Not reachable
  today, because the engine awaits a whole pass before flushing, so it is the
  file's own documented claim made true rather than a live loss.
- [x] Canvas/JSON structured-file merge corpus for `stillValid`. Done, and the
  check turned out to be load-bearing rather than speculative as the comments
  claimed. The ordinary case: a board with two cards and no arrows, each device
  draws one. `"edges":[]` is one line in the ancestor and three on each side, so
  both changed the same line and the character merge concatenated two edge
  objects with no comma between them. Every other check passed. Measured over
  the corpus, 193 of 4,420 merges produce a file Obsidian will not open, and
  nothing but `stillValid` sees any of them. Verified against the shipped
  Obsidian binary rather than inferred: the canvas writer puts each node and
  edge on its own line, and the reader has no catch above `JSON.parse`.
- [x] Index rewrite cost measured at 1k/10k/50k notes; the SQLite question
  is answered no, and the numbers are in `docs/compared.md` under measured
  and deliberately not done. Four milliseconds at ten thousand notes.
- [ ] Restore-rehearsal-in-CI with a fixture backup (candidate rule 11).
- [ ] iOS: first-sync of the real-vault corpus, memory ceiling on an
  old phone, kill-and-resume — numbers, not "should work."
