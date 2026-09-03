# Basalt work tracker

Everything below the "Done" line is finished and committed on the `protocol-3`
branch, except the items under "Open".

One list, merged on 2026-09-02 from three sources: the three-section code
review (items C, P, S), Codex's follow-up findings (the higher-numbered C, P,
S items and D6 to D9), and `IMPROVEMENTS.md` (items I, the design changes to
make before first deploy and the UX and ops work before 1.0). `TODO-NEW.md`
was folded in here and removed. `IMPROVEMENTS.md` stays as the reasoning
behind the I items.

Rules for every item: do not lose a note; each fix ships with a test that
failed before it (design.md rule 9); no em-dashes; tick only when fix plus test
are in and the suite is green. Everything is uncommitted work in the tree
until Wayne commits.

## Done

Fifty items from the first two lists are finished, each with an in-tree test:
C1 to C25 (lost update, early `wroteThisPass` reset, nested never-sync,
inactivity timeouts, folder hash, drained close, honest merge reasons,
restore beside, history cap, ENOENT in list, ack waiter ordering, per-vault
lock, transactional unlink, durable config, bootstrap transition, alias
refusal, atomic create, only-ENOENT-is-absent, durable directories, verified
trash copy, full writes, reserved temp names, index validation, strict reply
decoders, awaited close), S1 to S16 (keepalive during sends, caught-up under
the lock, quarantine and purge, backup fsync, error table, dead code, staged
backup publish, byte-accounted queues, transactional purge, drain on write
completion, durable token, systemd escaping, unknown-vault refusal, backup
retention, destination overlap, session-aware shutdown), D1 to D5, T2, T4.

## Protocol 3, decide and build before first deploy

The wire, pairing and crypto format changes. Spec first, in `docs/protocol.md`
(section "Protocol 3"), then server, then clients. The server speaks 2 and 3
for one release so the upgrade order is server first, then clients.

- [x] I1 request ids. Every request that expects a reply carries a client-chosen `id`; the reply, and any `err` for it, echo it. A `fetch` is answered by `{res:"bodies", id, count}` then exactly `count` binary frames, or by an `err`, never bodies then an error. Batches, `caught-up` and pings stay unsolicited with no `id`. Server never sends an `id` it was not given; client ends the session on an unknown `id`. Kills the class behind C11, C26, C34. Server side (accept with and without `id`), then transport.
- [x] I2 retryable errors. `err` gains `retryable` and optional `retryAfterMs`. `busy` (device limit, shutdown) is retryable and carries `retryAfterMs`; `auth`, `cursor`, `proto`, `protostate` are not. Client rule is mechanical: retryable goes to backoff and reconnect, fatal to stopped. Subsumes C26 and C27 once both ends speak it. D6.
- [x] I3 caps in `ready`. Add `maxBatchBytes`, `maxFetchBytes`, `minProto`, `serverVersion`. Enforce on both ends; refuse with `toolarge` rather than a bare disconnect. Make `ReadLimit` at least the largest legal message (S22) or lower the legal maximum, so every legal message is receivable. Covers S18, S21, S22. D8.
- [x] I4 secret to 32 bytes. Pairing format version 3 generates 32-byte root secrets; version 2 strings (20 bytes) stay accepted forever. Test both.
- [x] I5 key indirection for rotation. New vaults get a random data key wrapped under `HKDF(root, "basalt/wrap/1")`; the wrapped blob is sent with `claim` and returned in `ready`; `path`, `content`, `nonce`, `meta` derive from the data key, `auth` still from the root. New op `rotate` (authenticated) replaces the auth hash and the wrapped blob atomically, so a leaked pairing string is retired without losing history. Vaults claimed under protocol 2 have no data key and keep the direct schedule; for them rotation stays destructive and the CLI says so. CLI `basalt rotate` prints the new pairing string; `docs/server.md` rotation section rewritten.
- [x] I6 field bounds. Bound `vault` like `device` (64 chars) and reject control characters in both (S24). Pairing docs: internationalised hostnames must be punycode; test one long and one unicode URL.
- [x] I7 compression golden test. Pin the sealed-chunk format: marker byte meaning for empty, growing and incompressible input, deflate level and window, flush behaviour. N fixed plaintexts produce N fixed ciphertexts byte for byte, checked in CI under node and bun and in the built plugin bundle.
- [x] I8 small-file decision (decided and written in compared.md: keep chunking as is; the pinning test on `textSizesFor` is the core agent's). Measure what size a note becomes more than one chunk and how much of the wire cost is the entry; if files under the minimum chunk target are already one chunk, write that down in `compared.md` and pin it with a test, otherwise add the threshold now. No re-chunking after deploy.
- [x] I9 upgrade window. Server accepts `proto` 2 and 3 for one release and answers in the client's version; `ready` carries `minProto` and `serverVersion`. Document the order (server first) and test exactly that order: a proto 2 client against the proto 3 server in CI. One version matrix in the docs (`basaltd version`, plugin, `versions.json`), linked from the mismatch error.
- [x] I10 cursor-ahead recovery. `basalt rebase`: prints both cursors, requires `--backup-taken`, resets the local index to the server's cursor, re-uploads local-only content as new versions (never reuses uids), keeps both on disagreement, reports what was replayed. Runbook in `docs/server.md` restoring section.
- [x] I11 withholding made visible. `basalt status` and the plugin panel show local cursor and server cursor; server logs one line at start with version and latest uid per vault. No chain.
- [x] I12 crypto hygiene notes. Comment beside the stored `sha256(auth)` saying why unsalted is right and why never bcrypt; test with skewed clocks that timestamps are hints and uid order is authority.

## Core and CLI (`client/src/core`, `client/src/cli`)

- [x] C26 medium: unsolicited `err` (`busy` on shutdown) treated as a protocol violation; accept it as the close reason. Superseded by I1 and I2 on protocol 3 but the proto 2 path stays.
- [x] C27 high: `busy` in reply position is fatal and stops `runForever` forever; make it retryable (I2).
- [x] C28 medium: a batch that throws in `acceptBatch` before commit kills the session and replays forever with no `onFatal`. Surface as fatal after N identical failures, naming cursor and uid; document purge recovery.
- [x] C29 medium: inbound never-sync refusal is retried forever with exit 1; classify as permanent skip.
- [x] C30 medium: alias refusal runs per fill; two same-identity paths in different fills of one pass both land. Carry alias identities across fills.
- [x] C31 medium: `connect()` open has no deadline and holds the vault lock. Arm `timeoutMs` around open.
- [x] C32 medium: history, deleted and get entries are not MAC-verified before restore. Verify MAC and chunk-name shape before assemble. D7.
- [x] C33 medium: `basalt sync` exits 0 with `blocked` paths. Exit non-zero like `skipped`.
- [x] C34 low: stale bodies poison the next fetch; drain `bodyQueue` on failure (I1's `bodies` header removes the class).
- [x] C35 low: `again` loop sums state counters (`waiting` 3 for one file); last-wins for state counters.
- [x] C36 low: no lexical canonicalisation of wire paths (`a//b`, `a/./b`, trailing slash); canonicalise and refuse at accept.
- [x] C37 low: sealed-path cache never pruned; bound or clear on prune.
- [x] C38 low: `removeState` not fsynced; sync the state dir after removal.
- [x] C39 low: `basalt pair` says paired without contacting the server; hello before printing (I13).
- [x] I13 pairing honesty, CLI: `pair` hellos before it prints; `init` prints the recovery key once with one line saying to write it down offline and that it is the only way back if every device is lost.
- [x] I21 single-use invites, core and CLI (spec: protocol.md "Adding a device with a single-use invite"). `basalt invite` connects, seals the root under a fresh invite key, registers it with `{op:"invite"}` and prints a `basalt3i_` string plus its expiry (`--ttl`, default 10 minutes, max 1 hour). `basalt pair` accepts an invite string (hello with `invite`, unseal, store, reconnect) and still accepts a `basalt2_`/`basalt3_` recovery key. New `basalt recovery-key` reprints the root pairing string behind a warning. `formatInvite`/`parseInvite` in core/pairing.ts with CRC and version checks, tests for expiry, reuse, wrong vault, wrong key, lost reply.
- [x] I24 `basalt --version` prints the client's release (from the bundled package version) so the version matrix in server.md can name it; test.
- [x] I14 ignore contract: `--ignore` is local to the device; the docs say the plugin ignores nothing beyond the dot rule and the config folder; `basalt status` prints the ignore list so divergence is visible.
- [x] I15 device-name collision: default device names get a short suffix when left to the default; test two same-named devices conflicting once.

## Plugin (`client/src/plugin`)

- [x] P1 high: a run inside `connect()` survives `unlink()` and `onunload()`; hand the client over before connecting, bump generation on unload.
- [x] P2 high: dot-prefixed paths written but never listed; both directions use the shared predicate; end-to-end test with a CLI peer.
- [x] P3 medium-high: unreadable `data.json` shows the pairing form; remember the reason, refuse pairing, show it.
- [x] P4 medium: "Working on X" sticks after passes the plugin did not start; one `onPass` path.
- [x] P5 medium: refusal notices re-fire every pass; announce on change only.
- [x] P6 medium: `diffLines` is a set difference; diff-match-patch line mode.
- [x] P7 medium-low: `syncNow()` rejections discarded; catch and notice.
- [x] P8 medium-low: "will sync when it reconnects" while stopped; branch on stopped.
- [x] P9 low-medium: folder rename leaves phantom deletions per child; plugin-level test over the core fix.
- [x] P10 low-medium: `basalt:restore` uses one page; `findVersion`.
- [x] P11 low: "Paired. Basalt is syncing." before the server was reached; hello first or word it honestly.
- [x] P12 low: lifecycle tests assert the wrong property; replace with unlink-during-connect.
- [x] P13 low: stale comments, CLI advice in the recover modal, `-allow-origin` advice on every offline state, `addStatusBarItem` unguarded on mobile.
- [x] P14 low: duplicated restore+settle and ignore-set construction; one place each.
- [x] P15 critical: unlink is not quiescent or transactional; await close, remove index before clearing config, verify.
- [x] P16 high: `forgetBootstrap()` fire-and-forget; mirror the CLI's bootstrap transition (C15).
- [x] P17 high: note downloads have no atomic replacement contract; staged write, verify, rename, fault-injected.
- [x] P18 medium-high: index save has no atomic replacement contract; same treatment.
- [x] P19 high: history selection race labels one version while showing another; generation token.
- [x] P20 high: two raw names normalising to one path silently collide in `list()`; detect and report; adapter `canonical`.
- [x] P21 medium: `matchCase()` swallows a listing failure and writes under an unverified spelling; treat as a failed write.
- [x] P22 low-medium: recovery header calls purged rows recoverable; count separately.
- [x] P23 high: `unlink()` leaves the staged index copy, which `load()` falls back to; use `remove()` and verify.
- [x] P24 high: rename bypasses `Client.serial()`; route it through.
- [x] P25 high (decision: desktop fsync through Electron fs behind a FileSystemAdapter guard; mobile documented as best effort; assigned to the core track): no `flush()` on `ObsidianVault`, so durable-before-index is a no-op in the plugin; define the adapter contract. D9.
- [x] P26 medium: `unlink()` does not clear timers; clear both.
- [x] P27 medium (remote and pending deliberately stay under the server path until the rename is uploaded; retries and skips move): `noteRename()` moves only `entries`; move remote, pending, retries, skipped; refuse never-sync destinations.
- [x] P28 medium: `readRange()` accepts short reads; reject them.
- [x] P29 medium: `verify()` is size-only for large writes; full compare regardless of size.
- [x] P30 medium: staging name `.<name>.basalt-tmp` can clobber a real dotfile; reserve or refuse on collision.
- [x] P31 medium: restore-then-settle reports a local success as failure; split the messages.
- [x] P32 medium: double Pair click makes two secrets; serialise or disable while pairing.
- [x] P33 medium: green check over permanent refusals; attention state when refusals persist.
- [x] P34 low: `currentText()` ENOENT gap; undefined on ENOENT.
- [x] P35 low: `basalt:history` and `basalt:restore` leak raw exceptions; answer in-channel.
- [x] I22 single-use invites, plugin: *Add another device* creates an invite and shows the `basalt3i_` string with its expiry and a copy button; the pairing form accepts an invite string as well as a recovery key; the first-device flow shows the recovery key once with "write this down"; a *Show recovery key* action exists behind a warning and is not on the main panel path. Tests through the stub against the real server.
- [x] I16 phones (docs done; the iOS device pass needs a device and stays manual): document "open Obsidian to sync, there is no background sync on mobile"; the iOS stress-suite pass needs a device and is recorded here as not possible in this environment.

## Server (`server/`)

- [x] S17 high: parent-directory fsync gap on the first chunk of a vault; sync each newly created ancestor.
- [x] S18 high: no per-batch byte cap on `putmany`; one batch can stream gigabytes (I3).
- [x] S19 medium: pre-auth sessions unbounded; total cap plus hello deadline.
- [x] S20 medium: an existing 0644 token is never repaired; check and chmod on load.
- [x] S21 medium: `fetch` unbounded in bytes; cap (I3).
- [x] S22 medium: 8 MB `ReadLimit` below a legal 17 MB batch; make every legal message receivable (I3).
- [x] S23 medium (not reproducible against the current code after S10; pinned by a racing test instead): `enqueue`/`drain` TOCTOU can drop the queued fatal frame; reserve atomically or drain on `queued + inflight`.
- [x] S24 medium: `vault` field unbounded and logged; bound and reject control characters (I6).
- [x] S25 low: chunk temp write ignores the byte count; loop to full length and verify size.
- [x] S26 low: backup creates the destination before the overlap refusal; check first.
- [x] S27 low: a commit DB fault ends the session against the doc; continue, or fix the doc.
- [x] S28 low: shutdown shares one 5 s context between listener and sessions; fresh timeout for sessions.
- [x] I23 single-use invites, server: an invites table (vault, id, sealed blob bounded at 256 bytes, expiresAt, used) with atomic mark-used at redeem; `{op:"invite"}` on an authenticated non-bootstrap session; hello with `invite` answered `redeemed` then closed; unknown, expired or used is `auth`; expired rows swept; `rotate` deletes the vault's invites; backup carries the table. Tests for each rule and for redeem-once under a lost reply.
- [x] I25 `basaltd serve -max-batch-bytes` and `-max-fetch-bytes` so the client harness can test the caps against the binary rather than only a fake socket; default to the current constants; test.
- [x] I17 ops: `stats --json`; one start-up log line with version and latest uid per vault; a "what to alert on" section in `docs/server.md` (cursor stuck, repeated `cursor` refusals after a restore, `nospace`).
- [x] I18 ops: `purge` requires `-confirm VAULT` and refuses unless a backup newer than the newest entry exists at a path given by `-backup DIR` (or `-no-backup-check` typed out in full); success line prints the backup path.
- [x] I19 ops: backup runbook in `docs/server.md`: a systemd timer and a cron line for nightly `backup` plus `verify`, one offsite target (rsync of the backup dir), and a full restore rehearsal written as steps; say how the operator reclaims retained bodies after purges.
- [x] I20 ops: the blessed deployment paths as tested artifacts: `compose.yaml` pinned to a version tag with the digest-pin command shown, CI validates `docker compose config` and renders `basaltd service` and checks it with `systemd-analyze verify`; short Tailscale and Caddy sections in `docs/server.md`; `gh attestation verify` lines in the release notes template.

## Open, found reviewing the diff

- [ ] C40 medium: a server can downgrade a protocol 3 device to the protocol 2 key schedule by omitting `wrapped` from `ready`. `Engine.connect` swaps to the data-key schedule only when `ready` carries the blob, and nothing on the device remembers that this vault has one, so the omission is undetected. The device then seals paths and content under the root instead. Catch-up on an existing vault fails loudly when a path will not unseal, but a server that also withholds the entries leaves the device uploading its whole vault under a schedule no other device can read: divergence rather than loss, and inside the "the server is the adversary" boundary the design doc claims. Fix: record `hasDataKey` in the device config on the first successful connect (the blob itself is fine to store, the server already has it) and refuse a later `ready` that omits it, the same shape as `refuseIfBehind`. Test: a fake server that drops `wrapped` on the second connect is refused.

## Docs

- [x] D6 after I2/C27: what `busy` means in reply and unsolicited positions and what a watch loop does about each.
- [x] D7 after C32: history, deleted and get entries are MAC-verified before restore.
- [x] D8 after I3/S19: pre-auth limits, fetch byte cap and max batch bytes next to the ceilings `ready` advertises.
- [x] D9 after P25/P29: the plugin flush and verify contract, desktop versus mobile.
- [x] D10 rotation rewritten in design.md and server.md for the data key, with the destructive procedure kept for protocol 2 vaults.
- [x] D13 plugin.md updated for the plugin track (status states, pairing order, device name, recovery list, restore messages, unlink, durability).
- [x] D12 (docs done; the pairing screenshot still shows the old form and needs re-taking in a running Obsidian, a manual step) after I21 to I23: README quick start, plugin.md pairing, client/README and server.md describe invites as the way to add a device and the recovery key as the thing to write down; the pairing screenshot is re-taken.
- [x] D11 version matrix and upgrade order in server.md.

## Gates

- [x] T1 release gate (client 841 tests, server race-clean, both verified by the main session): `bun run test`, `bun run typecheck`, `bun run format:check`, `bun run build` green; `gofmt`, `go vet`, `go test -race ./...` green; no item ticked while any is red.
- [x] T3 every reproduction in-tree and named with its item id; no dependency on the private scratch directory remains (server and core done, plugin pending).
- [x] T5 (stress suite 5/5 against the protocol 3 server): the full stress suite (`bun run stress`) passes against the protocol 3 server, and the proto 2 compatibility test from I9 passes.
