# Todo

Bugs and defects to fix, from reading the code and docs.

Status as of 2026-09-03. Items marked done carry the test that failed first;
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

## Test-coverage debts (not bugs, tracked here so they don't drift)

- [x] Merge fuzz harness. Done, see above.

- [ ] Recorded-Obsidian-event fidelity suite for `plugin/vault.ts`
  (rename storms, rapid saves, trash vs `.trash`, dotfile gaps).
- [ ] Canvas/JSON structured-file merge corpus for `stillValid`.
- [x] Index rewrite cost measured at 1k/10k/50k notes; the SQLite question
  is answered no, and the numbers are in `docs/compared.md` under measured
  and deliberately not done. Four milliseconds at ten thousand notes.
- [ ] Restore-rehearsal-in-CI with a fixture backup (candidate rule 11).
- [ ] iOS: first-sync of the real-vault corpus, memory ceiling on an
  old phone, kill-and-resume — numbers, not "should work."
