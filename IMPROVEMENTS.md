# Improvements and adversarial notes

Status: pre-deploy. Nothing here has shipped to a real user yet, so breaking
the protocol, the pairing format, and the on-disk index is still cheap. After
the first device pairs against a real server, everything in the "now or never"
section gets roughly ten times more expensive. This file is the list to decide
before that.

It sits beside `TODO.md` (known bugs) and `TODO-NEW.md` (follow-up findings).
Those are defects against the current design. This file questions the design.

Verdict up front: the core shape is right. Opaque blob server, one secret,
deterministic sealing for grouping and dedup, deletions as entries, no restore
op, conflicts keep both, no settings screen. I would not change any of that.
The items below are the places where a hostile reader, a careless user, or a
homelab at 2 AM would still find the edge.

## How to read this

- "Now or never" means a wire, pairing, or crypto-format change. Decide before
  first deploy, even if the decision is "keep it and write down why".
- "Before 1.0" means UX or ops work that does not break the wire but will
  embarrass the project if it ships without it.
- "Explicitly not" means something I considered and would keep as is, with the
  reason, so it does not get relitigated later.

## Protocol: now or never

### 1. Request IDs (the one I would definitely add)

The transport demultiplexes on `op` before matching a `res`, with one reply
waiter per phase. That is the entire class behind C11 (fast ack with no waiter
looks unsolicited, transport closes), C26 (unsolicited `busy` as close reason),
and C34 (stale bodies poison the next fetch). Every fix so far makes one phase
safer. None of them removes the shape.

Proposal: protocol 3 adds an optional `id` (client-chosen nonce, e.g. uint32)
to every request that expects a reply (`hello`, `put`, `putmany`, `get`,
`fetch`, `history`, `deleted`), echoed on the matching reply and on bodies
belonging to it. Batches and pings stay unsolicited and carry no `id`. Server
rule: never send a reply with an `id` the client did not ask for; client rule:
a reply with an unknown `id` ends the session, a reply with no `id` goes down
the existing path. Old clients omit `id` and get exactly today's behavior, so
the server can speak both during an upgrade window.

Cost: small, mechanical, touches every handler and every client call site.
Benefit: kills the whole unsolicited-reply confusion class instead of
patching each phase. If there is one breaking change to spend pre-deploy
capital on, this is it.

### 2. Secret size and key indirection (cheap now, painful later)

The root secret is 20 bytes (160 bits). That is fine for security (well above
128-bit strength through HKDF-SHA256), but it is unusual enough that every
auditor will ask whether it was a truncation bug. More important is the
structure: every key (auth, path, content, nonce, meta) derives directly from
the root, so rotation means a new vault and lost history by construction. The
"lost or stolen device" answer today is: take a backup, rotate, lose history,
re-pair everything. Users will have the pairing string in chats, screenshots,
password managers, and repos. That procedure will be exercised.

Two separable proposals:

- (a) Bump new secrets to 32 bytes at format version 3, keep accepting 20-byte
  version 2 strings forever. One-line change in `generateSecret`, version byte
  already exists. Do it now so there is never a migration.
- (b) Add one level of indirection: a random vault data key wrapped by the
  root. All HKDF branches derive from the data key, not the root. Rotation is
  then: generate a new root, re-wrap the data key, swap the server auth hash.
  History survives, old strings stop working, new pairing strings go out. This
  is the standard KEK pattern and it turns the worst day (leaked string) from
  "lose history" into "re-issue". It costs one wrapped-key record on the server
  (opaque blob, still no key material in clear) and a rotation ceremony in the
  CLI. If that sounds like too much, at minimum document that rotation destroys
  history and make `purge`-style confirmation and backup-reminder part of the
  rotation command, because that command will be typed under stress.

Without (b), rotation stays destructive. That is a defensible choice for one
person's devices, but it should be an explicit choice, not something discovered
during an incident.

### 3. Pairing string is the crown jewels (adversarial UX)

Today `basalt2_` carries url, vault id, and root secret with a CRC-32 against
paste damage. Anyone holding it has the vault forever, read and write, past
and future (up to rotation, which destroys history, see above). There is no
expiry, no single-use, no per-device scope. Copying it into a chat is
equivalent to copying the vault.

For the stated scope (one person's devices on a private network) this is
arguably correct: one string, typed once per device, always. But consider what
users actually do: they will email it to themselves, leave it in shell history
(`basalt pair basalt2_...` is in `.bash_history` on day one), and screenshot
the modal. Shell history alone means the "one string" lives on every device
that ever paired, in clear, outside the config file.

Options, in increasing complexity:

- Minimum: `invite` prints a warning every time (it already says anyone
  holding this has the vault; keep that, and add shell-history advice: quote
  it, clear it, or pair from a prompt that does not echo). Document rotation
  before first release so the procedure exists when needed.
- Middle: single-use invite codes. A paired device asks the server for a
  short-lived invite token; the new device exchanges it (plus its own
  device-generated public key, if device keys ever exist) for the wrapped root.
  The long-lived secret never appears on screen again after the first device.
  This needs server state for outstanding invites and is real work.
- Maximum: per-device keys with revocation (each device generates ed25519,
  root signs it, server stores the device list, revocation is a signed entry).
  This is the full teams-lite design and I would refuse it: it reintroduces
  identity, PKI, and server-side policy, which the refusals section exists to
  keep out.

Recommendation: ship the single secret, add (2b) so rotation is cheap, add the
shell-history warning, and stop there. Revisit single-use invites only if
rotation gets exercised more than once a year.

Decision (2026-09-02): the middle option instead. Single-use invites are the way
to add a device; the root secret is shown once as a recovery key and never on
the add-a-device path. Spec in `docs/protocol.md`, work items I21 to I23 in
`TODO.md`.

### 4. `busy` needs a retryable bit (small wire change, big UX change)

`busy` today means two different things: "vault is full, try later" (transient)
and "server is shutting down" (transient), but the client files it with the
fatal refusals that stop a watch loop forever (C27, and C26 for the
unsolicited path). The server comment says the client treats busy as "not now,
reconnect". The client does not.

Proposal: every `err` gains `"retryable": true/false`, or `busy` splits into
`busy` (retryable, with optional `retryAfterMs`) vs keeping `auth/cursor/proto`
fatal. Client rule becomes mechanical: retryable goes to backoff and reconnect,
fatal goes to stopped. Advertise `retryAfterMs` on the device-limit path so a
fourth device does not hot-loop. This composes with request IDs (item 1):
a reply `err` with the request `id` and `retryable: true` is unambiguous.

### 5. Chunk identity: ciphertext hash is load-bearing and fragile

Chunk names are hex SHA-256 of ciphertext. That gives dedup on the wire, but
it couples three things that could move independently: chunking boundaries,
compression output, and encryption output. The compression layer (raw deflate
level 6 via fflate, marker byte inside the sealed bytes) must be byte-identical
across every present and future client (Node CLI, Electron, Android webview,
untested iOS, any future Go or Rust client), or the same plaintext gets
different names and dedup silently stops working while reporting success.
LiveSync deduplicates on plaintext hash with per-chunk salt and can afford
nondeterminism; Basalt cannot, by construction.

This is correct as designed, but it needs pinning before deploy:

- Pin the exact compression input (define what "marker 0 vs 1" means for empty
  input, for input that grows, for already-compressed data), the level, the
  window, and the library behavior on flush boundaries. Add a cross-platform
  golden test: N fixed plaintexts compress to N fixed ciphertexts, byte for
  byte, run in CI on Node and in the plugin bundle.
- Decide the small-file story explicitly. Most vaults are thousands of files
  under 64 KB, where content-defined chunking buys little and the per-version
  chunk list dominates the entry (the 22 KB-for-one-line figure is mostly entry,
  not chunks). A whole-file fast path (single chunk, or inline body under some
  threshold) would cut round trips (`put` is 2 RTT plus bodies today) and index
  bloat. If kept, set the threshold now, because changing chunking later
  renames every chunk.
- Consider naming chunks by plaintext hash and verifying ciphertext hash on
  receipt, which would decouple compression determinism from identity. That is
  a bigger change with its own confirmation-attack surface (plaintext hash is
  a stronger oracle than ciphertext equality), so I would not do it without a
  written threat note. Mentioned here so the alternative is on record.

### 6. Batch and fetch caps belong in `ready` (protocol-adjacent)

S18 (no per-batch byte cap, ~20 GB theoretical) and S21 (unbounded `fetch`,
~64 GB theoretical) are filed as server bugs, but the client cannot stay within
limits it cannot see. `ready` already advertises `perFileMax`, `chunkMax`,
`maxChunks`. Add `maxBatchBytes` and `maxFetchBytes` (or one `maxRequestBytes`)
to `ready`, enforce them on both ends, and refuse cleanly with `toolarge`
instead of a bare disconnect (S22: a legal 256-entry batch today exceeds the
8 MB `ReadLimit` and dies with no code, so the client retries the identical
batch forever). The 8 MB read limit vs 17 MB legal batch is a protocol bug, not
just a server constant: either the batch max or the read limit has to move so
that every legal message is receivable.

### 7. Cursor-ahead needs a recovery ceremony, not just a refusal

Refusing a client whose cursor is ahead of the server (old backup restored,
wrong vault) is correct and must stay: reissuing uids for different content
with both ends reporting success is the nightmare case. But today the refusal
is the end of the story, and the recovery is manual DB surgery or wiping the
client index (which replays from 0 into a server that already forgot). For a
self-hosted operator who just restored a backup, this is the first error they
will ever see, at the worst moment.

Proposal: a documented, confirmed, backup-first `basalt rebase` (name TBD)
that: prints both cursors, requires a fresh `backup`, uploads local-only
versions as new entries on top of the restored server (never reuses uids), and
reports what was replayed vs what needs manual review. The wire needs nothing
new; the client needs the courage to say "your server lost history, here is
the one safe thing to do". Write the runbook before the first backup is ever
restored.

### 8. Version negotiation and the upgrade window

`proto` and `crypto` are exact-match, refused not negotiated, and 0.2.0 moved
all three (server, CLI, plugin) together. That is fine for a homelab the same
person updates, and the refusal names both numbers (good). What is missing is
the window: server on 3 with a phone on 2 during the week between updates.
Options: server speaks N and N-1 for one release with a deprecation warning in
`ready` (`"minProto"`, `"serverVersion"`), or keep exact-match and document
"upgrade the server last, upgrade clients first" (or the reverse; pick one and
test it). Either way, `basaltd version` vs plugin version vs `versions.json`
should be one matrix in the docs, and the client's proto-mismatch error should
link it. Decide the upgrade order now and test exactly that order in CI.

### 9. Withholding: keep accepting it, but say so louder at the right moment

The design already states the server can withhold versions (empty batch over a
covered range is indistinguishable from your own write) and rejects a global
hash chain because it serializes concurrent writers. I agree with that call
for this scope. The gap is not the cryptography, it is when the user learns
about it: today, when two devices disagree and a person notices. That is
acceptable for notes (a person does notice) and unacceptable to discover from
the docs after the fact.

No protocol change. But add the cheap detectors: clients already check
`from == cursor + 1`, size matches, merge ancestor matches `synchash`, cursor
never moves backwards. Log the server cursor from `ready` on every connect at
a level the user can see (`status` shows server cursor vs local cursor), so "I
am 40 behind and nothing is arriving" is visible rather than philosophical.
If paranoia is ever wanted later, the path is out-of-band head comparison
(devices show each other their heads via QR, or a LAN gossip), not a chain.

### 10. Small crypto hygiene, all cheap pre-deploy

- `sha256(auth)` stored unsalted on the server is fine for a 160/256-bit
  random token (brute force is infeasible), but write that assumption down next
  to the code so nobody "upgrades" it to bcrypt and blocks the event loop, and
  so nobody reuses the pattern for a password later.
- Timestamps (`ctime`, `mtime`) are client-asserted and server-visible. Clock
  skew between devices already causes confusing merge/conflict ordering; the
  engine should treat timestamps as hints (display, tiebreak) and never as
  ordering authority (uid order is authority). If that is already true, assert
  it in a test with skewed clocks.
- `vault` id is unbounded and logged (S24); bound it like `device` (64 chars)
  and reject control characters, since it lands in logs and paths.
- Pairing length byte caps url and vault id at 255 bytes each. Fine, but the
  error should say which field is long (it does) and the docs should say
  internationalized domain names must be punycode before pairing, if that is
  true. Test one long and one unicode URL once.

## Sync engine and storage (no wire change, but decide early)

- Whole-file vs chunked threshold (see item 5). If a threshold is added, it
  changes chunk boundaries for files around it; do it before any vault has
  history worth keeping.
- Rename as first-class op: `prev` already makes rename one operation (good).
  Keep it. Do not add a separate rename op later; the current shape (new
  version with `prev` pointer, MAC covers `prev`) is the minimal correct thing.
- Folder semantics: folders are entries with no chunks, deletions are entries.
  The folder-resurrect and folder-vs-file `blocked` cases show this is the
  sharpest corner of the model. Keep the "refuse and name both, touch neither"
  rule for collisions (C16) and make `blocked` exit nonzero (C33). Do not add
  folder merge; there is nothing to merge.
- Dotfile rule: "config folder and any dot-prefixed segment never syncs either
  direction" is the right rule and the reason is mechanical (Obsidian index
  omits them, so accepting one manufactures a deletion). Keep it, unify the
  predicate in core (P14), and make sure help, README, and implementation agree
  (D4). The only alternative worth naming is syncing `.obsidian/snippets` and
  themes later as an explicit allowlist; do not drift there by accident.

## UX: plugin and CLI (before 1.0)

### Pairing ceremony honesty

- Never print "Paired. Basalt is syncing." before the first successful server
  round trip (P11, C39). `init` already connects and claims before printing;
  `pair` should hello before printing. The first thing a mistyped address
  should produce is an error at pair time, not silence until the first sync.
- Double-Pair clicks must be serialized or disabled while pairing (P32). A
  modal button that can be double-clicked into two secrets is a classic.
- `invite` output should remind the user it is the vault (see item 3) and how
  to clear shell history. One line, not a lecture.

### Status must describe the vault, not the filter (rule 7)

- One `synced` state with an attention variant: clean vs "synced with N
  permanently refused, tap to see". Today a permanently refused file shows the
  same green check as a clean vault (P33), and cron `sync` exits 0 over a
  split vault (C33). Both collapse "needs a person" into "success". Fix both
  together with the same predicate.
- Stuck "Working on X" after passes the plugin did not start (P4), re-firing
  notices every pass (P5), and "will sync when it reconnects" while stopped
  (P8) are all the same bug class: the panel branches on the wrong state.
  An `onPass` hook from core used by every path (ticker, arrival, manual) plus
  "announce counters on change only" fixes all three. Worth doing before daily
  use because notification fatigue is how users learn to ignore the one notice
  that matters.
- Show numbers users can trust (rule 8): local cursor, server cursor, pending,
  last error. `status` already avoids totals that lie; add the two cursors so
  "behind" is visible (see item 9).

### History, diff, restore

- `diffLines` as set difference (P6) is the one place the product visibly lies
  today ("No difference" over a reorder). Use diff-match-patch line mode before
  anyone relies on the history pane to decide what to keep.
- History selection race (P19: select A then B, A's slow load overwrites B's
  pane, restore then restores the wrong version) is the scariest plugin bug in
  the new list because the pane labels one version while showing another.
  Generation token, no exceptions.
- Restore-then-settle conflates local success with upload success (P31).
  Separate the messages: "restored beside the original" (local, durable) vs
  "uploaded" (server). A restore that landed on disk but did not upload is a
  success with a pending upload, not a failure that invites a duplicate retry.
- Recovery header calls everything "recoverable" including purged rows (P22).
  Count restorable vs purged separately once, in the same fix as the diff.

### Ignore rules

- `--ignore NAME` at any depth (current implementation) vs top-level (current
  help) must be decided, tested, and documented in one place (D4). Whichever
  wins, the plugin and CLI must share the predicate (P14). Do not ship a flag
  the phone cannot express: either ignores travel in the pairing string
  (another device can tell us, so it travels) or they are explicitly local-only
  and the docs say the phone ignores nothing. Silent divergence (desktop
  ignores, phone uploads) manufactures conflicts.

### Phones

- iOS is untested and the phones that have synced are one Android. WebCrypto,
  adapter atomicity (`writeBinary` truncation behavior differs per platform),
  background kill timing, and the missing status bar (called unguarded, P13)
  are all platform-shaped. Minimum before 1.0: one iOS vault through the
  stress suite, background/foreground transitions logged, and the documented
  expectation "open Obsidian to sync; there is no background sync on mobile".
  Do not promise push; there is no push.

### Conflicts

- Keep "incoming takes the conflict name, never rewrite the open file". It is
  the kindest correct choice and inverts Obsidian's worst habit.
- Device name defaults to hostname, so two fresh laptops called `macbook` will
  collide in conflict filenames. `firstFreeName` already disambiguates, but the
  names will still confuse. Consider appending a short random suffix at first
  pair (shown once, editable nowhere because there is no settings screen; or
  just accept it). At minimum test two same-named devices conflicting once.

## Self-hosted ops (before anyone depends on this)

- TLS story is right (plain HTTP behind `tailscale serve` or a proxy, no key
  material in the repo). What is missing is the blessed path tested end to end:
  one Compose file, one systemd unit, one Tailscale page, one Caddy page, each
  copied from CI rather than hand-maintained. The `service` generator with
  proper escaping (S12) is the right mechanism; make its output a tested
  artifact.
- Backup is well designed (staged, verified, atomic publish, retain-never-sweep
  after purge) but unproven where it matters: off the machine and back. Before
  1.0: one documented offsite target (rsync the backup dir elsewhere is enough),
  one scheduled `backup` plus `verify` in cron/systemd-timer form, and one
  full restore rehearsal (new disk, copy back, `verify`, all devices reconnect)
  written up as a runbook. A backup nobody restored is a rumor. Also decide
  retention explicitly (S14 says retain and report; then the destination grows
  forever after purges, so say how the operator reclaims it).
- Health and monitoring for a box that stays on: `health` exists, `stats`
  exists (and no longer calls purged deletions recoverable). Add `--json` to
  `stats` for scripts, one log line per start with version and cursors, and a
  documented "what to alert on" (cursor stuck, repeated `cursor` refusals after
  a restore, disk full with `nospace`). No Prometheus, no web UI; the refusals
  mean it. Rule 8 (trust the numbers) applies to operations too.
- Quotas: per-file max is advertised and enforced (good). Add the batch and
  fetch byte caps (item 6) and a documented vault-size expectation (SQLite + flat
  chunks on one disk; "a vault that is mostly video wants a file sync" is
  honest, keep it prominent). A single authenticated batch must never be able
  to fill the disk (S18); that is a ship blocker, not tuning.
- Destructive commands need friction proportional to irreversibility: `purge`
  with a typo'd vault succeeding `0 -> 0` (S13) is fixed by refusing unknown
  vaults; go one further and require `--confirm VAULT` plus a fresh-backup
  check for purge, and print the backup path in the success line. Future
  rotation (item 2b) gets the same treatment.
- Upgrades: pin the server image by digest in Compose, not `latest`, and test
  the documented upgrade order (item 8) with the actual artifacts (rebuilt in
  CI, attested, reproducible per the provenance section). The attestation story
  is already good; make `gh attestation verify` lines copy-pasteable from the
  release notes.

## Explicitly not changing (on purpose)

- No second backend, no peer-to-peer, no teams or shared vaults, no settings
  screen, no web UI on the server, no own merge algorithm, no silent conflict
  resolution. Each refusal is load-bearing; teams-lite or a settings tab would
  reintroduce exactly the state space the test suite cannot cover.
- Server stays an opaque blob store: no plaintext, no passphrase, sizes and
  timing only. Anything a proposed server feature needs the key for is refused
  by definition.
- One way to change a vault (upload a new version; restore is just an upload).
  No server-side restore op, no admin edit. That property is what makes backup,
  purge, and verification reason about one log instead of many.
- WebSocket with JSON control plus binary bodies. Not gRPC, not REST polling.
  The framing needs request IDs (item 1), not a new transport.
- Content-defined chunking with compress-then-seal. Questioned above, kept
  unless the golden test or the small-file analysis says otherwise.

## Suggested order

Before first deploy (wire/format freezes):

1. Request IDs, `retryable`/`retryAfterMs`, batch/fetch caps in `ready`,
   read-limit vs batch-max consistency (items 1, 4, 6).
2. Secret size bump and KEK rotation decision (item 2). Even "rotation stays
   destructive" must be written down with its ceremony.
3. Compression golden test and small-file threshold decision (item 5).
4. Vault/device field bounds, upgrade order, cursor-ahead runbook (items 8, 10, 7).

Before 1.0 (UX/ops):

5. Pair-then-hello honesty, double-Pair serialization, shell-history note.
6. Status attention state plus CLI exit on `blocked`; `onPass` hook and
   announce-on-change; two cursors in `status`.
7. History diff mode, selection generation token, restore message split,
   restorable vs purged counts.
8. Ignore contract unified in core plus docs.
9. iOS pass, background expectation documented, mobile status-bar guard.
10. Backup offsite plus restore rehearsal runbook, `stats --json`, purge
    confirmation with backup check, pinned image digests.

Never (kept refusals): second backend, P2P, teams, settings, server web UI,
own merge, silent resolution, server-side restore.
