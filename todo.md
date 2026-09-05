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
the continuing protocol-4 comment/docs pass). That work has since
committed (`dfa0d2b` and friends) and is reviewed in `todo-new.md`, which
carries this file's open items forward with the new findings. The
mid-review red suite was edits landing mid-run, not real breakage: the
committed tree is green except the `format`/`typecheck` gate (B1 in
`todo-new.md`).

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

- [x] **The protocol 4 docs pass.** Done, `bc18bb6`. Found four more claims of
  the same shape as the two already fixed, including a third instance of "a
  device cannot add a device of its own", plus nine code comments saying a
  device holds the root, which is presumably why the docs kept saying it. The
  security graphic was redrawn: it drew the old derivation as a picture.
  Original entry: `README.md`, the security SVGs and
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

## From collie's pairing screen, 2026-09-04

Collie shows "Nothing is paired, so writes are ungated. Pair a device to
require a credential." That model does not transfer: in Basalt the credential
is the encryption key, not an access gate, so there is no readable state to
leave ungated and nothing to retrofit encryption onto later. There should
never be a Basalt screen that says writes are ungated. Three things next to it
are worth taking.

- [x] **Claim without a token when the server is bound to loopback.**
  **Refused, and the reasoning is in `docs/design.md` so it is not proposed
  again.** Loopback is not a reliable signal of "same machine" here, and this
  project's own deployment docs are why: `server.md` says to bind 127.0.0.1
  and put `tailscale serve` or Caddy in front, and the systemd unit does
  exactly that. Both proxies run on the machine and dial loopback, so in the
  arrangement where the whole tailnet can reach the port, and the Caddy one
  where the whole internet can, the bind is loopback and the peer address is
  127.0.0.1. A rule keyed on either hands an unclaimed vault to whoever asks
  first. Containers are worse: compose publishes on the host's loopback while
  the server inside binds a wildcard. The only genuine same-machine proofs are
  a unix socket with peer credentials, or being able to read a file in the
  data directory, and the second one is the token. So the token is not
  ceremony, it is the proof. Shipped instead: a test that a claimed vault
  refuses the next claim against the running binary, since the existing
  coverage was at the authenticator, which is a function call and not a door.
- [x] **Ask for the device's name when pairing, in the panel.** **Done, and
  this entry was wrong.** The panel has always asked; the field existed from
  the first commit. The real gap was that it was empty behind a placeholder,
  and a placeholder is not a value, so blank became `obsidian-3f2a` on every
  device and a list read from inside Obsidian where every row says Obsidian
  identifies nothing. The field is prefilled now (`mac-3f2a`, `android-91c7`,
  `ipad-0b55`), mirroring the CLI's own naming. The platform check asks the
  mobile flags first, because Obsidian's types document `isMacOS` as true on
  iPhones and iPads, so the other order calls every iPad a Mac.
- [x] **A connection block in the panel.** Done, one line under the cursors,
  built only from what the client already holds: address, whether TLS
  terminates in front, protocol, server build. A `ws://` connection names what
  that costs exactly rather than vaguely, and disconnected says so rather than
  leaving a gap, because a build missing for want of a connection reads like a
  server that did not say.
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
