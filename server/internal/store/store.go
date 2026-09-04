// Package store persists vault metadata in SQLite and delegates chunk bodies to
// the chunks package.
//
// The server never sees plaintext. Paths arrive already encrypted by the client,
// deterministically, so equality and dedup still work; chunk names are hashes of
// ciphertext. This layer therefore treats both as opaque strings and never needs
// to understand vault content.
//
// Entries are append-only. A change, a rename and a delete each add a row rather
// than mutating one, which is what makes the uid sequence usable as a resume
// cursor and what makes a deletion a record instead of an absence.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"

	_ "modernc.org/sqlite"
)

// Limits the server enforces and the handshake advertises.
//
// These are constants, not settings. Per the philosophy doc, a question with a
// right answer is answered once in the source with the reasoning next to it,
// rather than becoming a row in a screen that multiplies the untested state
// space.
const (
	// ChunkMax bounds a single chunk body. Content-defined chunking aims for an
	// average far below this; the ceiling exists so that a stretch of content
	// where the rolling hash never fires still produces a chunk the server will
	// accept, and so that one frame can never be arbitrarily large.
	ChunkMax = 1 << 20 // 1 MiB

	// PerFileMax is the largest file this store will ever accept, whatever a
	// server is configured to advertise. It is the bound Validate enforces, and
	// a server's own limit may be lower but never higher.
	//
	// Separate from that limit because they answer different questions. This one
	// is "what can the format hold"; the server's is "what is worth carrying",
	// which depends on the vault and on the devices syncing it.
	PerFileMax = 1 << 28 // 256 MiB

	// DefaultPerFileMax is what a server advertises unless told otherwise.
	//
	// The cost is the client's, not the server's: preparing a file to send holds
	// the plaintext, the sealed window and whatever the last of it left behind.
	// Measured through a whole sync on this laptop, peak resident is about
	// 210 MB plus 2.7 MB per MiB of file, so 64 MiB costs about 430 MB and the
	// 256 MiB ceiling about 900 MB.
	//
	// 64 MiB by default because the smallest device syncing a vault sets the
	// limit and the plugin has never run on a phone. It covers images, PDFs and
	// an hour of recorded audio, refuses long video loudly with the number in
	// the message, and -max-file raises it as far as the ceiling for a vault
	// that really does hold video on devices that can carry it.
	DefaultPerFileMax = 1 << 26 // 64 MiB

	// MaxChunksPerEntry bounds the chunk list on a put. At PerFileMax with an
	// 8 KiB chunking average a real file needs about 32k chunks, so this is
	// twice the honest worst case. It is bounded because the count is
	// client-supplied and arrives before any body does: without a ceiling a
	// client could claim millions of chunks and park the session.
	MaxChunksPerEntry = 1 << 16 // 65536

	// MaxPathLen bounds an encrypted path. Ciphertext plus encoding is a few
	// times the plaintext, and Obsidian's own paths are bounded by the
	// filesystem, so this has room to spare while still being a bound.
	MaxPathLen = 4096

	// MaxDeviceLen bounds a device name.
	//
	// It is a label somebody reads next to a version, nothing more, and it was
	// unbounded: an authenticated client could send megabytes of it, and the
	// server would store a copy on every entry that device ever wrote and put
	// another copy in every broadcast frame. 64 bytes is more than any name
	// anybody would type.
	MaxDeviceLen = 64

	// MaxVaultLen bounds a vault id, for the same reason as MaxDeviceLen and
	// one more: it lands in log lines on every refusal, and it was unbounded
	// (S24). It is hashed before it touches the filesystem, so the bound is
	// about logs and memory rather than paths. 64 is the device bound, and a
	// vault name is the same kind of thing.
	MaxVaultLen = 64

	// MaxWrappedLen bounds the wrapped data key a device stores at claim. The
	// real thing is 60 bytes of nonce and AES-GCM output, 80
	// characters in base64url; 256 leaves room for a scheme that pads without
	// letting an authenticated client park kilobytes in a row the server hands
	// to every device at hello.
	MaxWrappedLen = 256

	// MaxSealedLen bounds the sealed root secret an invite carries, and
	// MaxInviteLen the invite identifier. A sealed 32-byte secret is 60 bytes,
	// 80 in base64url; a 128-bit identifier is 22. The bounds are generous for
	// the same reason MaxWrappedLen is and for the same cost.
	MaxSealedLen = 256
	MaxInviteLen = 64

	// ChunkOverheadMax bounds what encryption adds to one chunk: a nonce, an
	// authentication tag, and any framing. AES-GCM-SIV needs 12 plus 16, so
	// this is an order of magnitude of headroom, which is deliberate: it is the
	// slack a future scheme, or padding to obscure sizes, would need. Anything
	// wanting more than this is a protocol version, not a bigger constant.
	ChunkOverheadMax = 256
)

// CiphertextBudget is the most stored ciphertext an entry may reference, given
// the plaintext size it declares and how many chunks it splits into.
//
// A client chunks size bytes of plaintext into n pieces and encrypts each, so
// the honest total is size + n*overhead and this is an upper bound on it.
//
// It exists because size and chunk count were bounded independently, and their
// product was the real ceiling: an entry declaring one byte could reference
// 65536 chunks of a megabyte each, and neither bound was violated. Every other
// unbounded case in this package is closed with a comment saying why; this one
// was the exception.
//
// The comparison is per *reference*, not per distinct body. A file with two
// identical blocks counts that ciphertext twice, because its declared size
// counts the plaintext twice, and the two numbers have to be about the same
// thing to be comparable.
func CiphertextBudget(size int64, n int) int64 {
	return size + int64(n)*ChunkOverheadMax
}

var (
	// ErrUnknownVault is a write against a vault id with no row. Callers must
	// EnsureVault first; failing here rather than creating one on the fly means
	// a typo cannot silently become a new empty vault.
	ErrUnknownVault = errors.New("unknown vault")

	// ErrChunkMissing is an entry whose chunks are not all on disk. The entry is
	// not committed. This is the invariant that stops a dangling reference from
	// existing at all: an entry the server cannot serve would make the client
	// retry that download forever, which presents as a sync that never
	// finishes rather than as an error.
	ErrChunkMissing = errors.New("entry references a chunk the server does not hold")

	// ErrBadEntry is a structurally invalid entry, rejected on the way in.
	// docs/protocol.md: validate at put, with a reason, rather than discovering
	// it on download when it is too late to refuse.
	ErrBadEntry = errors.New("invalid entry")

	// ErrOverBudget is an entry referencing more ciphertext than its declared
	// plaintext size can account for. See CiphertextBudget.
	ErrOverBudget = errors.New("entry references more ciphertext than its declared size allows")

	// ErrRotated is a rotation whose compare-and-swap found another hash in
	// the row: somebody else rotated the vault between this session's
	// authentication and its rotate.
	//
	// It is a distinct error rather than ErrUnknownVault because the two mean
	// opposite things to the caller. An unknown vault is nothing to replace; a
	// lost race is a vault that now belongs to a credential this session does
	// not hold, and the one thing it must not do is replace it anyway. That is
	// exactly what an unconditional update did: two devices connected under one
	// root both rotated, the second overwrote the first, and the device the
	// first was revoking owned the vault.
	ErrRotated = errors.New("the vault was rotated by another device")
)

// Entry is one version of one file.
//
// There is no user or owner field. Basalt syncs one person's devices, so
// identity would be a column that is always the same value, and the philosophy
// doc refuses teams outright rather than half-building them.
type Entry struct {
	UID     int64  `json:"uid"`
	Path    string `json:"path"`  // deterministically encrypted by the client
	Size    int64  `json:"size"`  // plaintext size, as declared by the client
	CTime   int64  `json:"ctime"` // milliseconds, client clock
	MTime   int64  `json:"mtime"`
	Folder  bool   `json:"folder"`
	Deleted bool   `json:"deleted"`
	Device  string `json:"device"`

	// Prev is the previous path on a rename, so a rename is one operation
	// rather than an unrelated delete plus add. It is also what lets the
	// deleted-files list suppress the phantom deletion a rename leaves behind.
	Prev string `json:"prev,omitempty"`

	// Mac authenticates everything in this entry except the uid, and Parent
	// names the version it was written on top of. Both are the client's, both
	// are opaque here, and the server can check neither: it holds no key. It
	// stores them and hands them back so that the devices can, which is the
	// whole point. An entry without them is one a server could say anything
	// about: which is why every entry has them.
	// Always sent, never omitted. An absent field arrives as undefined rather
	// than as the empty string, and a parent of "" is a real value: the first
	// version of a file, written on top of nothing.
	Mac    string `json:"mac"`
	Parent string `json:"parent"`

	// Chunks names the encrypted chunks of this version, in order. Empty for a
	// folder, a deletion, and a zero-byte file, and empty rather than absent:
	// there is no omitempty here, and the read paths fill in an empty slice, so
	// the field is always an array on the wire. A nil slice marshals to JSON
	// null, and a client that iterates it crashes on exactly the entries it is
	// meant to handle without noticing.
	Chunks []string `json:"chunks"`
}

// HasBody reports whether this entry is expected to have chunk bodies behind it.
func (e Entry) HasBody() bool { return !e.Folder && !e.Deleted }

// SyncMode controls SQLite's durability/throughput trade.
//
// FULL fsyncs the WAL on every commit, so a power cut cannot lose an
// acknowledged write. NORMAL is faster and can lose the last few commits, which
// for a sync server means acking a push and then forgetting it. FULL is the
// default because losing a note is worse than a slower write; NORMAL exists for
// tests and benchmarks and is never the shipped setting.
type SyncMode string

const (
	SyncFull   SyncMode = "FULL"
	SyncNormal SyncMode = "NORMAL"
)

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vaults (
  vault_id   TEXT    PRIMARY KEY,
  next_uid   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  -- Hex SHA-256 of the device auth key, or empty before a device has claimed
  -- the vault. The key itself is never stored: a server holding one could
  -- write to the vault it is meant only to keep, and a stolen disk already
  -- yields every byte of ciphertext without also handing over the credential.
  auth_hash  TEXT    NOT NULL DEFAULT '',
  -- The vault's data key, wrapped by the first device under a key derived
  -- from the root secret, and empty only before a device has claimed the
  -- vault. The server cannot open it and never needs to; it stores it so
  -- every device holding the root secret can, and so a rotate can swap hash
  -- and blob in one statement without any device losing the history sealed
  -- under it.
  wrapped    TEXT    NOT NULL DEFAULT '',
  -- How many times the vault's secret has been rotated. Bumped inside the
  -- rotation transaction, so it moves at exactly the moment the credential
  -- and the blob do.
  --
  -- It exists because authenticating, reading the blob, joining the fan-out
  -- and rotating are four steps, not one. A device that passed auth under the
  -- old root and paused before joining would join after the rotation's
  -- eviction had already swept the hub, and go on reading and writing under a
  -- credential the vault no longer knows. A session captures this number with
  -- the hash it authenticated under and checks it again after joining; if it
  -- moved, the session is refused. Reading hash and blob in one query does not
  -- close that, because the window is after the read.
  rotations  INTEGER NOT NULL DEFAULT 0,
  -- How many purges have dropped history from this vault. Bumped inside the
  -- purge transaction, and only when the purge removed something, so it moves
  -- exactly when versions leave the store for good.
  --
  -- It exists for backups. A backup directory never deletes a body, so after a
  -- purge it holds history the source no longer has, and the runbook is to
  -- start a fresh directory and keep the old one. Deciding which directory is
  -- the one with the history in it needs a number that says which side of a
  -- purge each was taken on, and this is that number; backup.json records it.
  purges     INTEGER NOT NULL DEFAULT 0
);

-- Single-use invites for adding a device without showing the root secret
-- again. sealed is the root sealed under an invite key the server never sees;
-- used is flipped in the same statement that reads the row, so a reply lost
-- on the wire still burns the invite. Expired rows are swept lazily whenever
-- an invite is added to the vault, and every row goes when the vault's secret
-- is rotated, because they seal the root that was just retired.
CREATE TABLE IF NOT EXISTS invites (
  vault_id   TEXT    NOT NULL,
  invite     TEXT    NOT NULL,
  sealed     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, invite)
);

CREATE TABLE IF NOT EXISTS entries (
  vault_id  TEXT    NOT NULL,
  uid       INTEGER NOT NULL,
  path      TEXT    NOT NULL,
  size      INTEGER NOT NULL DEFAULT 0,
  ctime     INTEGER NOT NULL DEFAULT 0,
  mtime     INTEGER NOT NULL DEFAULT 0,
  folder    INTEGER NOT NULL DEFAULT 0,
  deleted   INTEGER NOT NULL DEFAULT 0,
  device    TEXT    NOT NULL DEFAULT '',
  prev_path TEXT    NOT NULL DEFAULT '',
  -- The client's authenticator over everything in this row that is not the
  -- uid, and the version it was written on top of. Opaque here: the server
  -- holds no key, cannot check either, and stores them so the devices can.
  mac       TEXT    NOT NULL DEFAULT '',
  parent    TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (vault_id, uid)
);

-- One row per chunk reference, ordered. A serialised list on the entry would be
-- smaller, but the live set for the chunk sweep would then have to be recovered
-- by parsing every row, and a parse failure there deletes data.
CREATE TABLE IF NOT EXISTS entry_chunks (
  vault_id TEXT    NOT NULL,
  uid      INTEGER NOT NULL,
  ord      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  PRIMARY KEY (vault_id, uid, ord),
  FOREIGN KEY (vault_id, uid) REFERENCES entries(vault_id, uid) ON DELETE CASCADE
);

-- Serves "latest version of path" and the per-path grouping behind Deleted,
-- Stats and Purge. "Everything newer than my cursor" is the primary key.
CREATE INDEX IF NOT EXISTS entries_by_path ON entries(vault_id, path, uid DESC);

-- Makes the live-set query for the chunk sweep an index scan rather than a
-- table scan, and makes "is this chunk still referenced" answerable.
CREATE INDEX IF NOT EXISTS entry_chunks_by_name ON entry_chunks(vault_id, name);

-- Deleted() suppresses a deletion whose path was reused by a later rename, and
-- that subquery matches on prev_path, which was in no index. It scanned every
-- entry newer than the deletion and filtered in memory, once per deleted path:
-- 112 ms against 5.6 ms with this, and the write it costs is 5 us against a
-- chunk fsync of 7.8 ms.
CREATE INDEX IF NOT EXISTS entries_by_prev ON entries(vault_id, prev_path, uid);
`

// Store is the server's whole persistent state: entries in SQLite, bodies in a
// chunk store.
type Store struct {
	db     *sql.DB
	chunks *chunks.Store
	dbPath string

	// writeMu serialises writes.
	//
	// It does two things that are not interchangeable with a transaction. It
	// makes uids both allocated and *visible* in order, because a uid that
	// became visible out of order would make a client using it as a cursor skip
	// a file. And it spans the gap between "these chunks are on disk" and "this
	// entry is committed", which is a filesystem check followed by a SQL commit
	// and therefore cannot be one transaction. The chunk sweep takes the same
	// lock, which is what makes that pair atomic with respect to deletion.
	writeMu sync.Mutex

	// duringBackup runs once per chunk reference while a backup copies bodies,
	// and is nil in every non-test build.
	//
	// It exists because the order inside Backup is the whole correctness
	// argument, and the window it protects is a few microseconds wide. A test
	// that tried to commit inside it by timing would be a test that passes when
	// the machine is busy.
	duringBackup func()

	// afterPublish runs inside Backup, after the snapshot has been renamed over
	// the previous one and before backup.json is written, and is nil in every
	// non-test build. Returning an error from it stands in for a crash in that
	// window, which is the window the coverage file's whole ordering argument
	// is about.
	afterPublish func() error

	// afterPurgeDelete runs inside Purge's transaction, after the DELETE and
	// before the checks, and is nil in every non-test build. Returning an error
	// from it stands in for any post-delete query failing, so a test can prove
	// the delete rolls back rather than standing with the history already gone.
	afterPurgeDelete func() error
}

// Open uses SyncFull. Use OpenWithSync only to trade durability for speed in a
// test or a benchmark.
func Open(dbPath, chunkDir string) (*Store, error) {
	return OpenWithSync(dbPath, chunkDir, SyncFull)
}

func OpenWithSync(dbPath, chunkDir string, mode SyncMode) (*Store, error) {
	if mode != SyncFull && mode != SyncNormal {
		return nil, fmt.Errorf("invalid sync mode %q", mode)
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return nil, err
	}
	cs, err := chunks.New(chunkDir, ChunkMax)
	if err != nil {
		return nil, err
	}
	dsn := dbPath + "?_pragma=busy_timeout(5000)" +
		"&_pragma=synchronous(" + string(mode) + ")" +
		"&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrating: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return &Store{db: db, chunks: cs, dbPath: dbPath}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Chunks exposes the chunk store for the put/get paths, which upload and serve
// bodies without touching an entry.
func (s *Store) Chunks() *chunks.Store { return s.chunks }

// EnsureVault creates the vault row if it is absent. now is milliseconds.
func (s *Store) EnsureVault(vaultID string, now int64) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.ensureVaultLocked(vaultID, now)
}

// ensureVaultLocked is EnsureVault for a caller already holding writeMu.
func (s *Store) ensureVaultLocked(vaultID string, now int64) error {
	if vaultID == "" {
		return fmt.Errorf("%w: empty vault id", ErrBadEntry)
	}
	_, err := s.db.Exec(
		`INSERT INTO vaults (vault_id, next_uid, created_at) VALUES (?, 1, ?)
		 ON CONFLICT(vault_id) DO NOTHING`, vaultID, now)
	return err
}

/* ---------------------------------------------------------------- *
 * Writing
 * ---------------------------------------------------------------- */

// isHex64 is the shape of a SHA-256 digest written out, which is what both the
// authenticator and the parent name are.
func isHex64(v string) bool {
	if len(v) != 64 {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Validate checks an entry's shape. Exported so the session can reject a put
// before reading any body, and so the reason is the same one in both places.
func (e Entry) Validate() error {
	if e.Path == "" {
		return fmt.Errorf("%w: empty path", ErrBadEntry)
	}
	if len(e.Path) > MaxPathLen {
		return fmt.Errorf("%w: path is %d bytes, max %d", ErrBadEntry, len(e.Path), MaxPathLen)
	}
	if len(e.Prev) > MaxPathLen {
		return fmt.Errorf("%w: prev path is %d bytes, max %d", ErrBadEntry, len(e.Prev), MaxPathLen)
	}
	if e.Prev == e.Path && e.Prev != "" {
		return fmt.Errorf("%w: prev path equals path", ErrBadEntry)
	}
	if e.Folder && e.Deleted {
		// The client has to decide which one it means; a row that is both is a
		// row nothing can reconstruct a vault from.
		return fmt.Errorf("%w: entry is both a folder and a deletion", ErrBadEntry)
	}
	if e.Size < 0 || e.Size > PerFileMax {
		return fmt.Errorf("%w: size %d outside [0, %d]", ErrBadEntry, e.Size, PerFileMax)
	}
	if len(e.Chunks) > MaxChunksPerEntry {
		return fmt.Errorf("%w: %d chunks, max %d", ErrBadEntry, len(e.Chunks), MaxChunksPerEntry)
	}
	for i, n := range e.Chunks {
		if !chunks.ValidName(n) {
			return fmt.Errorf("%w: chunk %d: %q is not a chunk name", ErrBadEntry, i, n)
		}
	}

	if !e.HasBody() {
		// A folder or a deletion with chunks attached is a client bug, and
		// accepting it would put bodies into the live set that nothing serves.
		if len(e.Chunks) > 0 {
			return fmt.Errorf("%w: folder or deletion carries %d chunks", ErrBadEntry, len(e.Chunks))
		}
		if e.Size != 0 {
			return fmt.Errorf("%w: folder or deletion declares size %d", ErrBadEntry, e.Size)
		}
		return nil
	}

	// A file has chunks if and only if it has content.
	//
	// The forward half: an entry with a size and no chunks reads exactly like an
	// empty file, so a push that lost its chunk list would present as the note
	// having been emptied. That is the silent failure this whole layer exists to
	// refuse.
	if e.Size > 0 && len(e.Chunks) == 0 {
		return fmt.Errorf("%w: size %d with no chunks", ErrBadEntry, e.Size)
	}
	// The reverse half: a zero-byte file carries no chunks. Both shapes were
	// legal, which made an empty note two different things on the wire and a
	// trap for whoever writes the client. Encrypting empty plaintext does
	// produce a chunk's worth of ciphertext, so a client has to special case
	// this either way; the biconditional at least means the server can check
	// the relationship completely, and an empty note costs no body.
	if e.Size == 0 && len(e.Chunks) > 0 {
		return fmt.Errorf("%w: zero-byte file carries %d chunks; an empty file has none",
			ErrBadEntry, len(e.Chunks))
	}

	// Last, so that an entry which is wrong in some other way says so first: a
	// missing authenticator is the least specific thing that can be wrong with
	// it, and the most confusing to be told when the real fault is the path.
	//
	// An entry nothing can authenticate is a poison pill. Every reader refuses
	// it, for ever, and the only party in a position to notice is the one that
	// wrote it. The server holds no key and cannot check the value, but it can
	// insist there is one of the right shape, so the refusal lands on the writer
	// at the moment of writing rather than on everybody else afterwards.
	if !isHex64(e.Mac) {
		return fmt.Errorf("%w: mac is not a 64 character hex digest", ErrBadEntry)
	}
	if e.Parent != "" && !isHex64(e.Parent) {
		return fmt.Errorf("%w: parent is neither empty nor a 64 character hex digest", ErrBadEntry)
	}
	return nil
}

// AppendEntry validates the entry, confirms every chunk is already durable, and
// commits it with the next uid.
//
// The order is the durability rule: bodies first, entry second, ack last. The
// caller must have completed every Put before calling this, and must not
// acknowledge the push until this returns. An ack sent earlier means "stored"
// was a claim a crash can expose.
func (s *Store) AppendEntry(vaultID string, e Entry) (int64, error) {
	if err := e.Validate(); err != nil {
		return 0, err
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	// Presence is checked here, under the lock, and not by the caller. A caller
	// that checked earlier would be racing the chunk sweep; holding the lock
	// across the check and the commit is what makes "committed implies
	// serveable" true rather than likely.
	//
	// The same stat yields each body's size, and the total is checked against
	// what the declared plaintext size can account for. This is the
	// authoritative check: the session bounds uploads as they arrive so a
	// hostile client cannot write the disk full before being refused, but that
	// pre-check can be bypassed by referencing chunks the server already holds,
	// and this one cannot be bypassed at all.
	var stored int64
	for i, n := range e.Chunks {
		size, ok := s.chunks.Size(vaultID, n)
		if !ok {
			return 0, fmt.Errorf("%w: chunk %d of %d: %s", ErrChunkMissing, i+1, len(e.Chunks), n)
		}
		stored += size
	}
	if budget := CiphertextBudget(e.Size, len(e.Chunks)); stored > budget {
		return 0, fmt.Errorf("%w: %d chunks holding %d bytes for a declared size of %d, budget %d",
			ErrOverBudget, len(e.Chunks), stored, e.Size, budget)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var uid int64
	err = tx.QueryRow(
		`UPDATE vaults SET next_uid = next_uid + 1 WHERE vault_id = ?
		 RETURNING next_uid - 1`, vaultID).Scan(&uid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("%w: %q", ErrUnknownVault, vaultID)
	}
	if err != nil {
		return 0, err
	}

	if _, err := tx.Exec(
		`INSERT INTO entries (vault_id, uid, path, size, ctime, mtime, folder, deleted, device, prev_path, mac, parent)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		vaultID, uid, e.Path, e.Size, e.CTime, e.MTime,
		boolToInt(e.Folder), boolToInt(e.Deleted), e.Device, e.Prev, e.Mac, e.Parent); err != nil {
		return 0, err
	}

	for i, n := range e.Chunks {
		if _, err := tx.Exec(
			`INSERT INTO entry_chunks (vault_id, uid, ord, name) VALUES (?,?,?,?)`,
			vaultID, uid, i, n); err != nil {
			return 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return uid, nil
}

/* ---------------------------------------------------------------- *
 * Reading
 * ---------------------------------------------------------------- */

const entryCols = `uid, path, size, ctime, mtime, folder, deleted, device, prev_path, mac, parent`

// Batch is a covered range of the uid sequence, in the shape the wire protocol
// sends it.
//
// From and To are a *range*, not the first and last uid present. Every entry
// that exists with From <= uid <= To is in Entries, and a client that has
// applied up to From-1 can apply this batch and set its cursor to To. The
// distinction matters because Purge removes history, so the sequence has holes;
// treating From/To as "the uids in this batch" would make every purged hole look
// like a lost file.
type Batch struct {
	From    int64   `json:"from"`
	To      int64   `json:"to"`
	Entries []Entry `json:"entries"`
}

// NextBatch returns the next batch after cursor, or ok=false when the client is
// caught up.
//
// Both queries run in one read transaction so the entries and their chunk lists
// come from the same snapshot. Reading them separately would let a concurrent
// Purge drop the chunk rows of an entry already read, and the entry would then
// be delivered with an empty chunk list: a note that reads as emptied rather
// than as an error.
func (s *Store) NextBatch(vaultID string, cursor int64, limit int) (Batch, bool, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	if cursor < 0 {
		return Batch{}, false, fmt.Errorf("%w: negative cursor %d", ErrBadEntry, cursor)
	}

	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Batch{}, false, err
	}
	defer tx.Rollback()

	rows, err := tx.Query(
		`SELECT `+entryCols+` FROM entries
		  WHERE vault_id = ? AND uid > ? ORDER BY uid ASC LIMIT ?`,
		vaultID, cursor, limit)
	if err != nil {
		return Batch{}, false, err
	}
	entries, err := scanEntries(rows)
	rows.Close()
	if err != nil {
		return Batch{}, false, err
	}
	if len(entries) == 0 {
		return Batch{}, false, nil
	}

	b := Batch{From: cursor + 1, To: entries[len(entries)-1].UID, Entries: entries}
	if err := attachChunks(tx, vaultID, b.Entries); err != nil {
		return Batch{}, false, err
	}
	return b, true, nil
}

// EntryByUID returns one version, with its chunk list.
func (s *Store) EntryByUID(vaultID string, uid int64) (Entry, bool, error) {
	return s.oneEntry(vaultID,
		`SELECT `+entryCols+` FROM entries WHERE vault_id = ? AND uid = ?`,
		vaultID, uid)
}

func (s *Store) oneEntry(vaultID, query string, args ...any) (Entry, bool, error) {
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Entry{}, false, err
	}
	defer tx.Rollback()

	e, err := scanEntry(tx.QueryRow(query, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return Entry{}, false, nil
	}
	if err != nil {
		return Entry{}, false, err
	}
	one := []Entry{e}
	if err := attachChunks(tx, vaultID, one); err != nil {
		return Entry{}, false, err
	}
	return one[0], true, nil
}

// HistoryForPath returns versions of one path, newest first.
//
// beforeUID paginates: pass the oldest uid already held to fetch the page before
// it. Zero starts from the newest.
func (s *Store) HistoryForPath(vaultID, path string, beforeUID int64, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT ` + entryCols + ` FROM entries WHERE vault_id = ? AND path = ?`
	args := []any{vaultID, path}
	if beforeUID > 0 {
		q += ` AND uid < ?`
		args = append(args, beforeUID)
	}
	q += ` ORDER BY uid DESC LIMIT ?`
	args = append(args, limit)

	return s.manyEntries(vaultID, q, args...)
}

// DeletedMax is the most deletions one call will return.
//
// Bounded because a vault accumulates deletions for as long as it exists, and
// an unbounded answer is a single frame that grows without limit. The caller is
// told when it was truncated rather than being handed a short list that looks
// complete: rule 7, and a recovery list quietly missing the note somebody is
// looking for is the worst version of it.
const DeletedMax = 1000

// Deletion is a deleted path, and whether anything survives to restore it from.
//
// The two are separate facts and used to be conflated. Purge keeps only the
// newest version per path, which for a deleted note is the deletion record, so
// after a purge the note is still listed and its content is gone. A client
// saying "all still recoverable" over that list, which one did, is telling
// somebody their note is safe when it is not.
type Deletion struct {
	Entry
	// RestorableUID is the newest version of this path with content in it, or
	// zero when purge has taken them all.
	RestorableUID int64 `json:"restorable"`
}

// Deleted returns paths whose newest version is a deletion, newest first, and
// whether there were more than it returned.
//
// suppressRenames drops deletions that were really the source side of a rename.
// Without it every rename shows up as a phantom deletion of a file that still
// exists under another name, and a recovery list that is mostly noise is one
// nobody reads.
//
// # Recognising the tail of a rename
//
// A rename is two entries: the new path carrying prev, and the old path
// retired. The test for "this deletion is a rename" cannot be "some later entry
// names this path as its prev", because a client does the two halves in
// whichever order its scan reaches them, and the natural order is to publish
// the new path first. That version of this query suppressed one order and not
// the other, and the only test it had used the order clients do not produce.
//
// Nor can the ordering be dropped altogether. A path can be renamed away and
// then used again by a new file, and the deletion of *that* file is real and
// must be listed; a bare "anything ever named this as its prev" would hide it
// forever.
//
// So the test is whether the rename happened after the version of this path
// that is now being deleted, rather than after the deletion record itself:
// there is no intervening incarnation of the path between the rename and the
// deletion. That holds for both orders of the two halves, and stops holding as
// soon as the path is reused.
func (s *Store) Deleted(vaultID string, suppressRenames bool, limit int) ([]Deletion, bool, error) {
	q := `SELECT e.uid, e.path, e.size, e.ctime, e.mtime, e.folder, e.deleted, e.device, e.prev_path, e.mac, e.parent,
	             COALESCE((SELECT MAX(r.uid) FROM entries r
	                        WHERE r.vault_id = e.vault_id AND r.path = e.path
	                          AND r.deleted = 0 AND r.folder = 0 AND r.uid < e.uid), 0)
	        FROM entries e
	        JOIN (SELECT path, MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path) latest
	          ON e.path = latest.path AND e.uid = latest.uid
	       WHERE e.vault_id = ? AND e.deleted = 1`
	if suppressRenames {
		q += ` AND NOT EXISTS (
		         SELECT 1 FROM entries r
		          WHERE r.vault_id = e.vault_id
		            AND r.prev_path = e.path
		            AND r.uid > COALESCE(
		                  (SELECT MAX(p.uid) FROM entries p
		                    WHERE p.vault_id = e.vault_id AND p.path = e.path AND p.uid < e.uid),
		                  0))`
	}
	if limit <= 0 || limit > DeletedMax {
		limit = DeletedMax
	}
	// One more than asked for, so "there are more" is a fact rather than a
	// guess from a full page.
	q += ` ORDER BY e.uid DESC LIMIT ?`

	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()

	rows, err := tx.Query(q, vaultID, vaultID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	out := []Deletion{}
	for rows.Next() {
		var d Deletion
		var prev sql.NullString
		if err := rows.Scan(&d.UID, &d.Path, &d.Size, &d.CTime, &d.MTime,
			&d.Folder, &d.Deleted, &d.Device, &prev, &d.Mac, &d.Parent, &d.RestorableUID); err != nil {
			return nil, false, err
		}
		d.Prev = prev.String
		// A deletion carries no bodies of its own, and the field is an array on
		// the wire for the same reason every other entry list is.
		d.Chunks = []string{}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(out) > limit {
		return out[:limit], true, nil
	}
	return out, false, nil
}

func (s *Store) manyEntries(vaultID, query string, args ...any) ([]Entry, error) {
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	rows, err := tx.Query(query, args...)
	if err != nil {
		return nil, err
	}
	out, err := scanEntries(rows)
	rows.Close()
	if err != nil {
		return nil, err
	}
	if err := attachChunks(tx, vaultID, out); err != nil {
		return nil, err
	}
	return out, nil
}

// listedUIDsMax bounds the IN list, because a parameter list is not free and
// SQLite has its own ceiling on how many it will take. Above it the range read
// is the better shape anyway: that many entries at once is a batch.
const listedUIDsMax = 500

// attachChunks fills in Chunks for every entry, in one query.
//
// It reads the whole uid span rather than one query per entry so that a batch of
// 200 entries is two round trips, not 201.
func attachChunks(tx *sql.Tx, vaultID string, entries []Entry) error {
	if len(entries) == 0 {
		return nil
	}
	byUID := make(map[int64]int, len(entries))
	lo, hi := entries[0].UID, entries[0].UID
	for i, e := range entries {
		byUID[e.UID] = i
		if e.UID < lo {
			lo = e.UID
		}
		if e.UID > hi {
			hi = e.UID
		}
		// Empty, not nil: see Entry.Chunks. Every entry leaving this package
		// carries an array, even when it carries no chunks.
		entries[i].Chunks = []string{}
	}

	// A range for a batch, a list for anything scattered.
	//
	// A catch-up batch is contiguous, so BETWEEN reads exactly the rows it
	// wants. A page of one file's history is not: version 1 and version 5 of a
	// note sit thousands of uids apart, so the same range read nearly every
	// chunk row in the vault and threw almost all of it away. Measured at 6.1 ms
	// for a 100 row page over 10k entries, and 83 ms over 100k, against 0.07 ms
	// and 0.3 ms keyed on the uids actually wanted. It grew with the vault's
	// history rather than with the page, and history is paged.
	span := hi - lo + 1
	useList := len(entries) <= listedUIDsMax && span > int64(len(entries))*4

	var rows *sql.Rows
	var err error
	if useList {
		args := make([]any, 0, len(entries)+1)
		args = append(args, vaultID)
		marks := make([]byte, 0, len(entries)*2)
		for i, e := range entries {
			if i > 0 {
				marks = append(marks, ',')
			}
			marks = append(marks, '?')
			args = append(args, e.UID)
		}
		rows, err = tx.Query(
			`SELECT uid, ord, name FROM entry_chunks
			  WHERE vault_id = ? AND uid IN (`+string(marks)+`) ORDER BY uid ASC, ord ASC`,
			args...)
	} else {
		rows, err = tx.Query(
			`SELECT uid, ord, name FROM entry_chunks
			  WHERE vault_id = ? AND uid BETWEEN ? AND ? ORDER BY uid ASC, ord ASC`,
			vaultID, lo, hi)
	}
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var uid, ord int64
		var name string
		if err := rows.Scan(&uid, &ord, &name); err != nil {
			return err
		}
		i, ok := byUID[uid]
		if !ok {
			continue // a uid inside the span that this result set does not cover
		}
		// ord is the wire order of the chunks and the order the client
		// reassembles in. A gap here would concatenate the file wrongly and
		// produce plaintext that fails to decrypt, so it is checked rather
		// than assumed.
		if int(ord) != len(entries[i].Chunks) {
			return fmt.Errorf("entry %d: chunk ord %d out of sequence at position %d",
				uid, ord, len(entries[i].Chunks))
		}
		entries[i].Chunks = append(entries[i].Chunks, name)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	// The property that matters is not "the query returned rows", it is that no
	// entry leaves this layer without the content it claims to have. An entry
	// with a size and no chunks is byte-identical on the wire to an empty file,
	// so a lost chunk list would present to every device as the note having
	// been emptied. Checking it here rather than in each caller means no read
	// path can be added that forgets to.
	for _, e := range entries {
		if e.HasBody() && e.Size > 0 && len(e.Chunks) == 0 {
			return fmt.Errorf("entry %d of vault %q declares size %d and has no chunk rows",
				e.UID, vaultID, e.Size)
		}
	}
	return nil
}

/* ---------------------------------------------------------------- *
 * Vault-level facts
 * ---------------------------------------------------------------- */

// LatestUID is the newest uid in the vault, or 0 if it holds nothing. This is
// the server's cursor in the handshake.
func (s *Store) LatestUID(vaultID string) (int64, error) {
	var uid sql.NullInt64
	if err := s.db.QueryRow(
		`SELECT MAX(uid) FROM entries WHERE vault_id = ?`, vaultID).Scan(&uid); err != nil {
		return 0, err
	}
	return uid.Int64, nil
}

// Stats describes what the vault holds.
//
// Every count is separate on purpose. "Fully synced" has twice meant something
// other than synced in the predecessor, once at cursor 0 against a vault of
// 4,030 files and once with files silently excluded, so this type refuses to
// collapse into a single number or a boolean. A caller that wants a headline
// figure has to choose which of these it means.
type Stats struct {
	Files   int64 // live, non-deleted, non-folder
	Folders int64
	Deleted int64 // paths whose newest version is a deletion
	// Recoverable is how many of those still have a version with content
	// behind them. Purge keeps only the newest version per path, and for a
	// deleted note that is the deletion record, so a purge can leave a path
	// deleted and unrecoverable. Reporting only Deleted said "still
	// recoverable" over those, which is rule 7: the two are separate facts.
	Recoverable int64
	Bytes       int64 // sum of declared plaintext sizes of live files
	Versions    int64 // entry rows, including superseded ones
	ChunkRefs   int64 // distinct chunk names referenced by any entry
	LatestUID   int64
	// OldestUID is the smallest uid still present, or 0 for an empty vault.
	// With LatestUID it is the range a backup of this vault covers; a purge
	// moves it up as the oldest versions go.
	OldestUID   int64
	AllocatedTo int64 // next_uid - 1: uids handed out, including purged ones
	// Purges is how many purges have dropped history from this vault; see the
	// column's comment in the schema.
	Purges int64
}

func (s *Store) Stats(vaultID string) (Stats, error) {
	var st Stats
	row := s.db.QueryRow(
		`SELECT
		   COALESCE(SUM(CASE WHEN e.deleted = 0 AND e.folder = 0 THEN 1 ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN e.folder = 1 THEN 1 ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN e.deleted = 1 THEN 1 ELSE 0 END), 0),
		   -- The same "is there anything behind it" question Deleted() asks, and
		   -- for the same reason. A deletion with no earlier version holding
		   -- content cannot be restored from, whatever the list says.
		   COALESCE(SUM(CASE WHEN e.deleted = 1 AND EXISTS (
		       SELECT 1 FROM entries r
		        WHERE r.vault_id = e.vault_id AND r.path = e.path
		          AND r.deleted = 0 AND r.folder = 0 AND r.uid < e.uid)
		     THEN 1 ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN e.deleted = 0 AND e.folder = 0 THEN e.size ELSE 0 END), 0)
		 FROM entries e
		 JOIN (SELECT path, MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path) latest
		   ON e.path = latest.path AND e.uid = latest.uid
		 WHERE e.vault_id = ?`, vaultID, vaultID)
	if err := row.Scan(&st.Files, &st.Folders, &st.Deleted, &st.Recoverable, &st.Bytes); err != nil {
		return st, err
	}
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM entries WHERE vault_id = ?`, vaultID).Scan(&st.Versions); err != nil {
		return st, err
	}
	if err := s.db.QueryRow(
		`SELECT COUNT(DISTINCT name) FROM entry_chunks WHERE vault_id = ?`,
		vaultID).Scan(&st.ChunkRefs); err != nil {
		return st, err
	}
	var next, purges sql.NullInt64
	if err := s.db.QueryRow(
		`SELECT next_uid, purges FROM vaults WHERE vault_id = ?`, vaultID).Scan(&next, &purges); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return st, err
		}
	}
	st.AllocatedTo = next.Int64 - 1
	st.Purges = purges.Int64
	var oldest sql.NullInt64
	if err := s.db.QueryRow(
		`SELECT MIN(uid) FROM entries WHERE vault_id = ?`, vaultID).Scan(&oldest); err != nil {
		return st, err
	}
	st.OldestUID = oldest.Int64
	var err error
	st.LatestUID, err = s.LatestUID(vaultID)
	return st, err
}

// Oversize is a live file whose declared size is above some ceiling: the uid
// of its newest version and that size. Paths are sealed, so these two are all
// the server can say about it.
type Oversize struct {
	UID  int64
	Size int64
}

// FilesOver lists the files a device syncing this vault today would download
// and could not, if the server advertised limit as its file ceiling: the
// newest version of each path that is neither deleted nor a folder, where the
// declared size is over limit. Largest first.
//
// Only the newest version per path counts. A superseded version over the
// ceiling is history nobody is sent on a first sync, and a deleted file's
// newest version is its deletion record, which has no size. Counting either
// would mean a ceiling could never be lowered after one large upload without
// a purge, which is a stricter rule than "do not strand a file" needs.
func (s *Store) FilesOver(vaultID string, limit int64) ([]Oversize, error) {
	rows, err := s.db.Query(
		`SELECT e.uid, e.size
		   FROM entries e
		   JOIN (SELECT path, MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path) latest
		     ON e.path = latest.path AND e.uid = latest.uid
		  WHERE e.vault_id = ? AND e.deleted = 0 AND e.folder = 0 AND e.size > ?
		  ORDER BY e.size DESC, e.uid ASC`, vaultID, vaultID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Oversize
	for rows.Next() {
		var o Oversize
		if err := rows.Scan(&o.UID, &o.Size); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// Vaults lists every vault id, oldest first.
func (s *Store) Vaults() ([]string, error) {
	rows, err := s.db.Query(`SELECT vault_id FROM vaults ORDER BY created_at ASC, vault_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

/* ---------------------------------------------------------------- *
 * Maintenance
 * ---------------------------------------------------------------- */

// PurgeReport says what a purge did. Rule 5: an operation that makes a list
// smaller reports its arithmetic, so an implausible figure is visible rather
// than inferred from a success message.
type PurgeReport struct {
	VersionsBefore  int64
	VersionsRemoved int64
	VersionsAfter   int64
	ChunksDeleted   int
	ChunksLive      int
	// ChunksSpared were unreferenced but newer than the grace window, so they
	// were kept in case an in-flight push is about to reference them. Reported
	// rather than folded into the deleted count so the numbers add up and a
	// grace window that is doing nothing is visible.
	ChunksSpared int
	// BytesDeleted is what the sweep reclaimed and BytesSpared what the grace
	// window kept from it. Counts alone hid the one figure an operator purging
	// for space came for: "2 spared" is two kilobytes or two gigabytes, and a
	// purge on a just-stopped server spares everything it would otherwise take.
	BytesDeleted int64
	BytesSpared  int64
	// ChunksQuarantined were set aside because they failed their own hash. They
	// are kept until a client resends the real chunk, so a purge counts them
	// rather than collecting them, and reports the count so a body that has gone
	// bad is visible rather than silently sitting in the tree.
	//
	// ChunksTemp is `.tmp-` debris, which nothing removes at any grace. Both
	// carry their bytes, because both are space the purge did not reclaim and
	// a count without bytes is the figure an operator purging for space cannot
	// use.
	ChunksQuarantined int
	ChunksTemp        int
	BytesQuarantined  int64
	BytesTemp         int64

	// SweepComplete says the chunk sweep reached the end of the tree. When it
	// is false every chunk figure above describes how far the walk got rather
	// than what the vault holds, and a caller must not print them as a status
	// (rule 7). The version figures are unaffected: they come from a committed
	// transaction that ran before the sweep.
	SweepComplete bool
}

// Purge drops version history, keeping only the newest entry per path, then
// deletes chunk bodies that no surviving entry references and that are older
// than grace.
//
// grace protects bodies belonging to a push that has uploaded but not yet
// committed; pass chunks.DefaultGrace, and see its comment for the livelock that
// makes it necessary. Zero is only correct where nothing can be in flight.
//
// The write lock is held across the sweep as well as the delete. Releasing it in
// between would let a push store a chunk after the live set was computed but
// before the walk reached it, and the walk would delete a chunk a
// just-committed entry references. Purge is a rare manual operation, so blocking
// writes for its duration is the right trade.
//
// The delete, every invariant that proves it right, and the live set the sweep
// uses are all one transaction (S9). The delete is irreversible history loss,
// so it must not be left standing when a check that would have caught a mistake
// cannot even run. Before this, the DELETE ran in autocommit and a later query
// failing returned an error with the history already gone. Now a failure in any
// of those steps rolls the whole thing back, so the versions are still there to
// try again. The transaction commits before the filesystem sweep, because the
// sweep is not reversible SQL and a body it removes is unreferenced by the
// committed result; a chunk link goes with its entry by ON DELETE CASCADE, so
// the live set read inside the transaction is exactly what survives.
//
// The report describes what committed. A transaction that rolls back returns a
// zeroed one, because its counts were read inside a delete that no longer
// stands.
func (s *Store) Purge(vaultID string, grace time.Duration) (PurgeReport, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var rep PurgeReport
	var live map[string]struct{}

	// Everything that reads or writes the entries, in one transaction, so the
	// history is only gone once the proof that the purge was right has passed.
	err := s.inTx(func(tx *sql.Tx) error {
		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM entries WHERE vault_id = ?`, vaultID).Scan(&rep.VersionsBefore); err != nil {
			return err
		}

		res, err := tx.Exec(
			`DELETE FROM entries
			  WHERE vault_id = ?
			    AND uid NOT IN (SELECT MAX(uid) FROM entries WHERE vault_id = ? GROUP BY path)`,
			vaultID, vaultID)
		if err != nil {
			return err
		}
		rep.VersionsRemoved, _ = res.RowsAffected()

		if s.afterPurgeDelete != nil {
			if err := s.afterPurgeDelete(); err != nil {
				return err
			}
		}

		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM entries WHERE vault_id = ?`, vaultID).Scan(&rep.VersionsAfter); err != nil {
			return err
		}
		// The purge keeps one version per path, so what remains must equal the
		// number of distinct paths. Checking it inside the transaction means a
		// future change to the delete predicate that removes a live entry rolls
		// back here instead of being discovered as a missing note.
		var paths int64
		if err := tx.QueryRow(
			`SELECT COUNT(DISTINCT path) FROM entries WHERE vault_id = ?`, vaultID).Scan(&paths); err != nil {
			return err
		}
		if rep.VersionsAfter != paths {
			return fmt.Errorf("purge left %d versions for %d paths in vault %q",
				rep.VersionsAfter, paths, vaultID)
		}
		if rep.VersionsBefore-rep.VersionsRemoved != rep.VersionsAfter {
			return fmt.Errorf("purge arithmetic: %d - %d != %d",
				rep.VersionsBefore, rep.VersionsRemoved, rep.VersionsAfter)
		}

		// The generation moves with the history, in the same transaction, and
		// only when history actually left: a purge that found nothing to drop
		// changes what a backup taken before it is the last copy of not at
		// all. See the column's comment in the schema, and
		// TestAPurgeThatDropsNothingDoesNotMoveTheGeneration.
		if rep.VersionsRemoved > 0 {
			if _, err := tx.Exec(
				`UPDATE vaults SET purges = purges + 1 WHERE vault_id = ?`, vaultID); err != nil {
				return err
			}
		}

		// The live set is read here, after the delete and inside the same
		// transaction, so it is exactly what the committed result references.
		live, err = liveChunks(tx, vaultID)
		return err
	})
	if err != nil {
		// Nothing was removed: the delete rolled back with everything else in
		// the transaction. The counts were filled in inside it, and
		// VersionsRemoved comes from RowsAffected on a statement that no longer
		// stands, so reporting them would print history as gone that is still
		// there. A destructive command's own arithmetic has to describe what
		// committed (rule 8), and on this path nothing did.
		return PurgeReport{}, err
	}

	rep.ChunksLive = len(live)
	swept, err := s.chunks.Sweep(vaultID, live, time.Now().Add(-grace))
	rep.ChunksDeleted, rep.ChunksSpared = swept.Deleted, swept.Spared
	rep.ChunksQuarantined, rep.ChunksTemp = swept.Quarantined, swept.Temp
	rep.BytesDeleted, rep.BytesSpared = swept.DeletedBytes, swept.SparedBytes
	rep.BytesQuarantined, rep.BytesTemp = swept.QuarantinedBytes, swept.TempBytes
	rep.SweepComplete = swept.Complete
	return rep, err
}

// inTx runs fn in a transaction, committing if it returns nil and rolling back
// otherwise. It is the shape a purge needs: an irreversible delete and the
// checks that prove it right have to stand or fall together.
//
// The two key-material writes now rely on it for the same all-or-nothing
// reason. AddInvite checks that the vault is claimed, sweeps the expired rows
// and inserts; Rotate swaps the auth hash and the wrapped data key in one
// statement and then deletes every outstanding invite, because they seal the
// root being retired. Half of either is a vault whose credential and whose key
// material disagree.
func (s *Store) inTx(fn func(*sql.Tx) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		// Rollback's own error is not worth returning over fn's: fn's is why
		// the purge is being abandoned, and it is the one a caller can act on.
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// liveChunks is every chunk name referenced by a committed entry of this vault,
// read within the caller's transaction so it matches the rest of that snapshot.
func liveChunks(tx *sql.Tx, vaultID string) (map[string]struct{}, error) {
	rows, err := tx.Query(
		`SELECT DISTINCT name FROM entry_chunks WHERE vault_id = ?`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	live := map[string]struct{}{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		live[n] = struct{}{}
	}
	return live, rows.Err()
}

// Fault is a stored entry whose bodies do not back it up.
type Fault struct {
	VaultID string
	UID     int64
	Path    string
	// Chunk is empty for a fault about the entry itself rather than a body.
	Chunk  string
	Reason string // "missing", "corrupt", "nochunks" or "straychunks"
	Detail string
}

func (f Fault) String() string {
	if f.Chunk == "" {
		return fmt.Sprintf("vault %s uid %d: %s (%s)", f.VaultID, f.UID, f.Reason, f.Detail)
	}
	return fmt.Sprintf("vault %s uid %d chunk %s: %s (%s)",
		f.VaultID, f.UID, f.Chunk, f.Reason, f.Detail)
}

// Verify walks every live entry and checks that its chunks exist. With deep, it
// also reads each chunk and checks the body against its name.
//
// A dangling reference makes a client retry one download forever, which presents
// as a sync that never finishes rather than as an error, so it is surfaced
// explicitly. The corollary of chunk names being hashes of ciphertext is that
// deep verification is complete for the bytes: there is no equivalent of the
// predecessor's size-mismatch check, and none is needed. What the server still
// cannot verify is Entry.Size, the *plaintext* size the client declared, because
// it never sees plaintext. That is a deliberate consequence of the server
// holding no key, not an omission here.
//
// Returns the faults found and the number of chunk references checked. Both
// matter: zero faults out of zero checks is not a healthy vault, and rule 8 says
// to trust the numbers rather than the pass.
func (s *Store) Verify(deep bool) ([]Fault, int, error) {
	rows, err := s.db.Query(
		`SELECT e.vault_id, e.uid, e.path, c.name
		   FROM entries e JOIN entry_chunks c
		     ON c.vault_id = e.vault_id AND c.uid = e.uid
		  ORDER BY e.vault_id, e.uid, c.ord`)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var faults []Fault
	checked := 0
	for rows.Next() {
		var f Fault
		if err := rows.Scan(&f.VaultID, &f.UID, &f.Path, &f.Chunk); err != nil {
			return faults, checked, err
		}
		checked++
		if !s.chunks.Has(f.VaultID, f.Chunk) {
			f.Reason = "missing"
			faults = append(faults, f)
			continue
		}
		if deep {
			if err := s.chunks.Check(f.VaultID, f.Chunk); err != nil {
				f.Reason = "corrupt"
				f.Detail = err.Error()
				faults = append(faults, f)
			}
		}
	}
	if err := rows.Err(); err != nil {
		return faults, checked, err
	}

	entryFaults, err := s.verifyEntries()
	return append(faults, entryFaults...), checked, err
}

// verifyEntries checks the entries themselves, rather than the bodies they name.
//
// The loop above joins entries to their chunk rows, so an entry whose chunk rows
// are gone is not examined at all: it has nothing to join to. That is the worst
// thing this tool could miss. An entry declaring a size with no chunks behind it
// is a note that reads as empty rather than as an error, which is the failure
// this whole project is arranged against, and `verify` reported the vault clean.
//
// Both directions are checked, because the invariant is a biconditional and the
// opposite fault, chunks attached to something that should have none, means a
// folder or a deletion carrying content nobody will ever read.
func (s *Store) verifyEntries() ([]Fault, error) {
	rows, err := s.db.Query(
		`SELECT e.vault_id, e.uid, e.path, e.size, e.folder, e.deleted,
		        (SELECT COUNT(*) FROM entry_chunks c WHERE c.vault_id = e.vault_id AND c.uid = e.uid)
		   FROM entries e
		  ORDER BY e.vault_id, e.uid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var faults []Fault
	for rows.Next() {
		var f Fault
		var size int64
		var folder, deleted bool
		var chunkCount int
		if err := rows.Scan(&f.VaultID, &f.UID, &f.Path, &size, &folder, &deleted, &chunkCount); err != nil {
			return faults, err
		}
		wantsChunks := size > 0 && !folder && !deleted
		switch {
		case wantsChunks && chunkCount == 0:
			f.Reason = "nochunks"
			f.Detail = fmt.Sprintf("declares %d bytes and names no chunks, so it would read as empty", size)
			faults = append(faults, f)
		case !wantsChunks && chunkCount > 0:
			f.Reason = "straychunks"
			f.Detail = fmt.Sprintf("names %d chunks but should have none", chunkCount)
			faults = append(faults, f)
		}
	}
	return faults, rows.Err()
}

/* ---------------------------------------------------------------- */

type scannable interface {
	Scan(dest ...any) error
}

func scanEntry(r scannable) (Entry, error) {
	var e Entry
	var folder, deleted int
	err := r.Scan(&e.UID, &e.Path, &e.Size, &e.CTime, &e.MTime, &folder, &deleted, &e.Device, &e.Prev, &e.Mac, &e.Parent)
	e.Folder = folder != 0
	e.Deleted = deleted != 0
	return e, err
}

func scanEntries(rows *sql.Rows) ([]Entry, error) {
	var out []Entry
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// migrate brings an older database up to the current schema.
//
// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
// column added to the schema above never reaches a database made before it.
// Additive only, and each step is idempotent, because the alternative is a
// server that starts fine on a fresh directory and fails on the one that has
// somebody's notes in it.
func migrate(db *sql.DB) error {
	// Nothing to migrate before the table exists; the schema will create it.
	var tables int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'vaults'`).Scan(&tables); err != nil {
		return err
	}
	if tables == 0 {
		return nil
	}

	// auth_hash arrived with the one-secret model, wrapped with the data key. A
	// database written before either keeps the empty string in the new column.
	// An unclaimed vault is an ordinary state; a claimed one with no data key
	// is a vault an older build wrote, and the server refuses that session at
	// hello rather than guessing at a key schedule that no longer exists.
	for _, col := range []string{"auth_hash", "wrapped"} {
		has, err := hasColumn(db, "vaults", col)
		if err != nil {
			return err
		}
		if !has {
			if _, err := db.Exec(`ALTER TABLE vaults ADD COLUMN ` + col + ` TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
		}
	}

	// The rotation generation. A database written before it starts at zero,
	// which is right: the count is only ever compared with itself, within one
	// handshake, so where it starts does not matter and only that it moves
	// does.
	if has, err := hasColumn(db, "vaults", "rotations"); err != nil {
		return err
	} else if !has {
		if _, err := db.Exec(
			`ALTER TABLE vaults ADD COLUMN rotations INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}

	// The purge generation. A database written before it starts at zero, which
	// is right for the same reason rotations is: a backup taken from it says
	// generation zero, the first purge afterwards makes it one, and the only
	// comparison anyone makes is between two of these numbers.
	if has, err := hasColumn(db, "vaults", "purges"); err != nil {
		return err
	} else if !has {
		if _, err := db.Exec(
			`ALTER TABLE vaults ADD COLUMN purges INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}

	// The index behind Deleted()'s rename suppression. Belt and braces: unlike
	// CREATE TABLE IF NOT EXISTS, the CREATE INDEX IF NOT EXISTS in the schema
	// does reach a table that already exists, so this is a second statement
	// saying the same thing rather than the only one that says it. It stays so
	// the migration reads as the complete list of what an older database is
	// missing. TestOpeningADatabaseFromAnOlderBuildAddsTheColumnsAndLosesNothing
	// asserts the index is there, not which statement made it.
	if _, err := db.Exec(
		`CREATE INDEX IF NOT EXISTS entries_by_prev ON entries(vault_id, prev_path, uid)`); err != nil {
		return err
	}

	// Every entry carries its own authenticator. A row written before the
	// columns existed has none and cannot be given one here, because the server
	// has no key: it keeps the empty string, and a client refuses it.
	for _, col := range []string{"mac", "parent"} {
		has, err := hasColumn(db, "entries", col)
		if err != nil {
			return err
		}
		if !has {
			if _, err := db.Exec(`ALTER TABLE entries ADD COLUMN ` + col + ` TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
		}
	}
	return nil
}

func hasColumn(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

/* ---------------------------------------------------------------- *
 * Who may write to a vault
 * ---------------------------------------------------------------- */

// AuthHash returns the hex SHA-256 of the vault's auth key, or empty when no
// device has claimed it yet.
func (s *Store) AuthHash(vaultID string) (string, error) {
	var hash string
	err := s.db.QueryRow(`SELECT auth_hash FROM vaults WHERE vault_id = ?`, vaultID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return hash, err
}

// ValidWrapped reports whether a wrapped data key is one the server will store:
// non-empty, within MaxWrappedLen, and base64url with optional padding. The
// server cannot check what it means; it can refuse a shape nothing could have
// produced, so a client bug lands on the writer at claim rather than on every
// other device at hello.
func ValidWrapped(w string) bool { return validBase64URL(w, MaxWrappedLen) }

// ValidSealed is ValidWrapped for the sealed root secret an invite carries.
func ValidSealed(s string) bool { return validBase64URL(s, MaxSealedLen) }

// ValidInvite is the same check for an invite identifier.
func ValidInvite(s string) bool { return validBase64URL(s, MaxInviteLen) }

func validBase64URL(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	padded := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '=':
			// Padding is the end of the string and at most two characters of
			// it. Allowing "=" anywhere in the last two positions accepted
			// "ab=c", which is not base64 of anything. Nothing here is ever
			// decoded, so this is shape only, but a shape check that admits a
			// string no encoder produces is not checking the shape.
			if i < len(s)-2 {
				return false
			}
			padded = true
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
			if padded {
				return false
			}
		default:
			return false
		}
	}
	return true
}

// AddInvite stores a single-use invite for a claimed vault, expiring at
// expiresAt (milliseconds), and sweeps that vault's expired invites while it is
// there. Sweeping at insert rather than on a timer keeps the table bounded by
// what was issued since the last issue, with no goroutine to forget to start;
// a vault that never issues another invite keeps a handful of dead rows, which
// redeem refuses anyway.
//
// An identifier that is already there is ErrBadEntry, which the session turns
// into `badentry`: a refusal a retry cannot fix, so the device stops rather
// than retrying an identifier this vault will never accept again.
func (s *Store) AddInvite(vaultID, invite, sealed string, expiresAt, now int64) error {
	if !ValidInvite(invite) {
		return fmt.Errorf("%w: invite identifier is %d bytes and must be base64url of at most %d",
			ErrBadEntry, len(invite), MaxInviteLen)
	}
	if !ValidSealed(sealed) {
		return fmt.Errorf("%w: sealed secret is %d bytes and must be base64url of at most %d",
			ErrBadEntry, len(sealed), MaxSealedLen)
	}
	if expiresAt <= now {
		return fmt.Errorf("%w: invite would expire before it was issued", ErrBadEntry)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTx(func(tx *sql.Tx) error {
		var hash string
		err := tx.QueryRow(`SELECT auth_hash FROM vaults WHERE vault_id = ?`, vaultID).Scan(&hash)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && hash == "") {
			// An unclaimed vault has no root to seal, so nothing to invite to.
			return fmt.Errorf("%w: %q is not a claimed vault", ErrUnknownVault, vaultID)
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM invites WHERE vault_id = ? AND expires_at < ?`, vaultID, now); err != nil {
			return err
		}
		// An identifier already in use is refused as the client's mistake, not
		// as a server fault. It used to reach the primary key as a bare insert
		// and come back as `internal`, which is retryable, so a device that
		// retried the same invite after a lost reply retried it for ever.
		//
		// Refused rather than answered as a success, because the row that is
		// already there may have been redeemed a moment ago: the sweep above
		// has just removed the expired ones, and used is not a thing this can
		// see without racing the redeem. Reporting `invited` for an invite that
		// is already spent is a success nothing verified, and the device
		// holding the string would find out only when it failed to pair.
		var exists int
		switch err := tx.QueryRow(
			`SELECT 1 FROM invites WHERE vault_id = ? AND invite = ?`, vaultID, invite).Scan(&exists); {
		case err == nil:
			return fmt.Errorf("%w: this vault already has an invite under that identifier; issue a new one", ErrBadEntry)
		case errors.Is(err, sql.ErrNoRows):
		default:
			return err
		}
		_, err = tx.Exec(
			`INSERT INTO invites (vault_id, invite, sealed, expires_at, used) VALUES (?, ?, ?, ?, 0)`,
			vaultID, invite, sealed, expiresAt)
		return err
	})
}

// RedeemInvite marks an invite used and returns its sealed secret, or reports
// ok false for one that is unknown, expired or already used, without saying
// which. The read and the mark are one statement, so two devices redeeming at
// once cannot both succeed, and a reply lost after this returns has still
// burned the invite: one use means one, not one delivered.
func (s *Store) RedeemInvite(vaultID, invite string, now int64) (sealed string, ok bool, err error) {
	if !ValidInvite(invite) {
		return "", false, nil
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	err = s.db.QueryRow(
		`UPDATE invites SET used = 1
		  WHERE vault_id = ? AND invite = ? AND used = 0 AND expires_at >= ?
		  RETURNING sealed`, vaultID, invite, now).Scan(&sealed)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return sealed, true, nil
}

// OutstandingInvites counts invites that could still be redeemed: unused and
// not yet expired at now.
func (s *Store) OutstandingInvites(vaultID string, now int64) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM invites WHERE vault_id = ? AND used = 0 AND expires_at >= ?`,
		vaultID, now).Scan(&n)
	return n, err
}

// InviteRows counts every invite row for a vault, expired and used included,
// so a test can see the sweep.
func (s *Store) InviteRows(vaultID string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM invites WHERE vault_id = ?`, vaultID).Scan(&n)
	return n, err
}

// Wrapped returns the vault's wrapped data key, or empty for a vault nothing
// has claimed. A claimed vault with no key can only have come from an older
// build, and the server refuses such a session at hello rather than serving it.
func (s *Store) Wrapped(vaultID string) (string, error) {
	var w string
	err := s.db.QueryRow(`SELECT wrapped FROM vaults WHERE vault_id = ?`, vaultID).Scan(&w)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return w, err
}

// VaultKeys returns the vault's auth hash, its wrapped data key and how many
// times it has been rotated. Hash and blob are empty for a vault nothing has
// claimed.
//
// One query for the three, because they are three columns of the same row and
// a hello wants all of them. It does not read the row for the whole hello,
// though: a first device's claim writes hash and blob while it authenticates,
// so the row is read once on each side of authentication rather than once
// before it. Reading earlier would send that device an empty wrapped in ready.
//
// One query is also not on its own enough to keep a rotation from cutting
// across a handshake. The window that matters is between this read and the
// join, so the caller re-reads Rotations after joining; see the column's
// comment in the schema.
func (s *Store) VaultKeys(vaultID string) (hash, wrapped string, rotations int64, err error) {
	err = s.db.QueryRow(
		`SELECT auth_hash, wrapped, rotations FROM vaults WHERE vault_id = ?`,
		vaultID).Scan(&hash, &wrapped, &rotations)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", 0, nil
	}
	return hash, wrapped, rotations, err
}

// Rotations is the vault's rotation generation on its own, for the re-read a
// session does after joining the fan-out. Zero for a vault with no row, which
// is also where a vault starts, so a vault that disappeared mid-handshake
// reads as unrotated and is caught by the hash check instead.
func (s *Store) Rotations(vaultID string) (int64, error) {
	var n int64
	err := s.db.QueryRow(`SELECT rotations FROM vaults WHERE vault_id = ?`, vaultID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

// ClaimVault records the auth key hash and the wrapped data key for a vault
// that has no hash yet, and reports whether this call is the one that did it.
//
// The write is conditional in SQL rather than checked and then written, so two
// devices arriving at once cannot both believe they claimed it. The loser is
// told no and can decide what that means; silently accepting the second would
// hand the vault to whichever connection happened to finish last. Hash and
// blob go in one statement, because a vault with a hash and no blob is a vault
// no device can open.
//
// An empty wrapped is not refused here, because this is the primitive and the
// rule about what a claim must carry belongs where the claim arrives: the
// session refuses one without a data key and DerivedAuth refuses it again.
// Leaving the primitive able to write the row is also what lets a test build
// the one an older build could have left behind, to check it is refused.
func (s *Store) ClaimVault(vaultID, hash, wrapped string, now int64) (bool, error) {
	if hash == "" {
		return false, errors.New("refusing to claim a vault with an empty auth hash")
	}
	if wrapped != "" && !ValidWrapped(wrapped) {
		return false, fmt.Errorf("%w: wrapped data key is %d bytes and must be base64url of at most %d",
			ErrBadEntry, len(wrapped), MaxWrappedLen)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	if err := s.ensureVaultLocked(vaultID, now); err != nil {
		return false, err
	}
	res, err := s.db.Exec(
		`UPDATE vaults SET auth_hash = ?, wrapped = ? WHERE vault_id = ? AND auth_hash = ''`,
		hash, wrapped, vaultID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// Rotate replaces a claimed vault's auth hash and wrapped data key, bumps its
// rotation generation, and deletes every invite on the vault, in one
// transaction, so there is no moment at which the new credential opens a vault
// whose blob the new root cannot unwrap, or the other way round, and no invite
// survives that would hand out the root just retired.
//
// It is a compare-and-swap, not an update: prevHash is the hash the caller
// authenticated under, and the row is only replaced while it still holds that
// hash. Zero rows affected on a claimed vault means somebody rotated first, and
// the answer is ErrRotated rather than a quiet success.
//
// The condition used to be `auth_hash != ”`, which any claimed vault meets.
// Two devices connected under one root both sent rotate; the first committed
// and evicted the second, but closing a socket does not stop a database call
// already in flight, so the second's unconditional update replaced the first's
// and the revoked device owned the vault. A caller may only replace the
// credential it proved it holds.
//
// An unclaimed vault, or one with no row, is refused with ErrUnknownVault,
// because there is nothing to replace. There is no case for a vault with no
// data key: a claim without one is refused, so every claimed vault has one.
func (s *Store) Rotate(vaultID, prevHash, hash, wrapped string) error {
	if prevHash == "" {
		return errors.New("refusing to rotate without the hash the caller authenticated under")
	}
	if hash == "" {
		return errors.New("refusing to rotate to an empty auth hash")
	}
	if !ValidWrapped(wrapped) {
		return fmt.Errorf("%w: wrapped data key is %d bytes and must be base64url of at most %d",
			ErrBadEntry, len(wrapped), MaxWrappedLen)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	return s.inTx(func(tx *sql.Tx) error {
		res, err := tx.Exec(
			`UPDATE vaults SET auth_hash = ?, wrapped = ?, rotations = rotations + 1
			  WHERE vault_id = ? AND auth_hash = ?`,
			hash, wrapped, vaultID, prevHash)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			// Which of the two it is, read inside the same transaction so the
			// answer describes the row the swap was refused against.
			var current string
			switch err := tx.QueryRow(
				`SELECT auth_hash FROM vaults WHERE vault_id = ?`, vaultID).Scan(&current); {
			case errors.Is(err, sql.ErrNoRows), err == nil && current == "":
				return fmt.Errorf("%w: %q", ErrUnknownVault, vaultID)
			case err != nil:
				return err
			}
			return fmt.Errorf("%w: %q", ErrRotated, vaultID)
		}
		_, err = tx.Exec(`DELETE FROM invites WHERE vault_id = ?`, vaultID)
		return err
	})
}
