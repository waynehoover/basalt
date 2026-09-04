# Todo

Bugs and defects to fix, from reading the code and docs.

Status as of 2026-09-04. Closed items are deleted, not kept: the commit
that closed each one holds the reasoning, and "Closed" at the bottom names
them so a re-proposal can find it. What stays here is open work. Verified
this pass with everything green: `scripts/check.sh --skip-docker` 14
passed 0 failed (3 docker-only steps skipped as asked), `go test
-count=1 ./...` passes, `vitest run` passes 55 files / 1195 tests, and the
restore rehearsal passes under its CI tag: all on the tree as of ~09:22.

The tree moved during this review and is still moving: a pairing-flow
refactor is in flight in the dirty tree (`convertToDevice` and
`needsConversion` gone from core, `registerAsDevice` in their place, the
plugin's runLoop/pair/pairFirst reworked around register-then-save, plus
the continuing protocol-4 comment/docs pass). It is uncommitted, it is not
this review's scope, and its suite is red while it moves, a later client
run failed 190 with edits landing mid-run, and a rerun still fails 5 in
`main.test.ts` with files changing underneath it. Nothing below judges it;
re-review it once it commits and its own suite is green.

**Rule 9 applies to every item:** a fix without a test that failed first
is not finished. Items marked `[needs-repro]` are suspected from reading
and must reproduce (failing test, reverted fix, restored fix) before they
count. Items marked `[verified-by-reading]` were confirmed in the source
but still want the failing test.

Severity is about notes at risk, in this order: silent data loss >
refused-but-confusing > operational footguns > leaks/hardening.

---

## Silent-loss or wrong-data risks

- [ ] **Whole-file fallback on mobile can OOM before the 64 MiB limit
  helps.** `[verified-by-reading]` (`compared.md`: mobile streaming
  untested, fallback reads whole file at ~210 MB + 2.7 MB/MiB;
  `server.md`: default limit "set for a phone"). The limit was sized
  from a desktop-class memory curve. An older phone syncing a 40–64
  MiB attachment may be jetsammed mid-pass. The staging design means
  no note is lost, but the file never syncs and the failure mode is
  a dead app, not an error. Needs a real-device measurement (see
  `improvements.md` §6); possible mitigations: lower advertised
  `perFileMax` from the plugin on low-memory devices, or chunked
  reads via the mobile URL scheme actually tested.
- [ ] **A node deleted on one device against an edge drawn to it on the other**
  merges to valid JSON holding an orphaned edge, which Obsidian silently drops
  on the next save. Not a merge the code invented, since there is no third
  answer, but it is a silent edit loss. Telling it from an edge the ancestor
  already had needs `stillValid` to see the ancestor and both sides, which is a
  signature change. Pinned as a test with the reasoning. Still open: verified
  this pass that `stillValid` is still `(text: string) => boolean`, so the
  Excalidraw gate did not change this.

## In progress, uncommitted

- [ ] **The protocol 4 docs pass.** `README.md`, the security SVGs and
  `docs/protocol.md` are dirty in the tree: the README's security copy now
  describes device credentials and revocation, the picture draws the new
  derivation, and the protocol doc states the honest boundary ("it cannot do
  so unseen", rows plus outstanding invites in one `devices` listing) with the
  new `uninvite` op. Finish and commit; until then the docs describe the
  product in two voices.
- [ ] **New screenshots.** The panel gained a device list, revocation and
  outstanding invites, the pairing flow changed, and the recovery-key copy was
  rewritten. The set in `docs/assets/screenshots/` is from 2026-09-03, before
  the Sep-04 devices work. Retake with the capturePage recipe (Electron,
  background throttling off), which does not steal focus.

## Test-coverage debts (not bugs, tracked here so they don't drift)

- [ ] iOS: first-sync of the real-vault corpus, memory ceiling on an
  old phone, kill-and-resume: numbers, not "should work."

## Closed (bodies deleted; the named commit holds the reasoning)

Earlier passes: merge fuzz plus `samePlacement`; NFC normalisation; case
collisions and symlinks (both by design, tested); compose pin plus its CI
check; plugin rebase and rotate (shared into core); `busy` split declined;
`-max-file` stranding refused at startup; purge reporting what it did not
reclaim; cursor-refusal wording under the server's own code; pre-auth
version disclosure; `fflate` golden gate verified to block; backup
generation metadata; canvas/JSON corpus; Obsidian fidelity plus the
flush-ordering fix; index measurement answering the SQLite question no.

Protocol 4 review (2026-09-04): the two overclaiming sentences fixed with
the honest boundary; `--allow-last` gated to the registrar with list
access admitted alongside it; orphan rows flagged, counted and named by
the full refusal; journal wired in; proto 3 drop and compose pin checked.

2026-09-04, `57d2e20` journal wiring: snapshot-without-sequence taking
another device's deltas, two writers silently discarding, quadratic
replay (454 ms start at 10k notes).

2026-09-04, `3e19e70` devices: allow-last gate, outstanding invites in
the `devices` listing with `uninvite` on both credentials, rotation-race
guard on revoke, recovery-key list/prune with the widened power written
in `design.md`.

2026-09-04, `1e408a3` server: reclaimable bytes in `stats` and the
startup line (preview mirrors the delete's predicate, drift-tested);
restore rehearsal in CI under `-tags rehearsal` as its own job, rule 11
earned (`CLAUDE.md` says eleven); clock skew declined (uids order,
same-clock comparison cancels, server time would ride uncovered) with a
once-per-session report past one day; pre-auth oracles assessed with a
byte-identical-frames test, served vault against unknown.

2026-09-04, `cac0651` client: Excalidraw gate abstaining unless all three
versions hold a scene; SVG/XML gate declined on the corpus (0 broken in
53,260, JSON control 299 in 17,414, refusing would conflict 53% to catch
none); plugin clash parity with the CLI including the rendering fix;
needs-attention as a projection over the four untouched maps, one
renderer for CLI, panel, status and glyph.

Declined and staying declined: rename resolution at scan time (a guess
more ambiguous than the state); server-side streaming import (once per
device against a second path through durable code; re-measure over
tailscale first).
