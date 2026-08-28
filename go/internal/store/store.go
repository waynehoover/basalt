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

	"github.com/waynehoover/basalt/internal/chunks"

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

	// PerFileMax bounds one file's plaintext size as declared by the client.
	// Vaults hold attachments, so this is generous; it is bounded at all so a
	// single put cannot commit the server to unbounded work.
	PerFileMax = 1 << 28 // 256 MiB

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
  created_at INTEGER NOT NULL
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

-- Serves both "everything newer than my cursor" and "latest version of path".
CREATE INDEX IF NOT EXISTS entries_by_path ON entries(vault_id, path, uid DESC);

-- Makes the live-set query for the chunk sweep an index scan rather than a
-- table scan, and makes "is this chunk still referenced" answerable.
CREATE INDEX IF NOT EXISTS entry_chunks_by_name ON entry_chunks(vault_id, name);
`

// Store is the server's whole persistent state: entries in SQLite, bodies in a
// chunk store.
type Store struct {
	db     *sql.DB
	chunks *chunks.Store

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
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return &Store{db: db, chunks: cs}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Chunks exposes the chunk store for the put/get paths, which upload and serve
// bodies without touching an entry.
func (s *Store) Chunks() *chunks.Store { return s.chunks }

// EnsureVault creates the vault row if it is absent. now is milliseconds.
func (s *Store) EnsureVault(vaultID string, now int64) error {
	if vaultID == "" {
		return fmt.Errorf("%w: empty vault id", ErrBadEntry)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO vaults (vault_id, next_uid, created_at) VALUES (?, 1, ?)
		 ON CONFLICT(vault_id) DO NOTHING`, vaultID, now)
	return err
}

/* ---------------------------------------------------------------- *
 * Writing
 * ---------------------------------------------------------------- */

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
		`INSERT INTO entries (vault_id, uid, path, size, ctime, mtime, folder, deleted, device, prev_path)
		 VALUES (?,?,?,?,?,?,?,?,?,?)`,
		vaultID, uid, e.Path, e.Size, e.CTime, e.MTime,
		boolToInt(e.Folder), boolToInt(e.Deleted), e.Device, e.Prev); err != nil {
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

const entryCols = `uid, path, size, ctime, mtime, folder, deleted, device, prev_path`

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

// LatestForPath returns the newest version of one encrypted path, if any.
func (s *Store) LatestForPath(vaultID, path string) (Entry, bool, error) {
	return s.oneEntry(vaultID,
		`SELECT `+entryCols+` FROM entries WHERE vault_id = ? AND path = ?
		  ORDER BY uid DESC LIMIT 1`,
		vaultID, path)
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

// Deleted returns paths whose newest version is a deletion.
//
// suppressRenames drops deletions that were really the source side of a rename,
// identified by a later entry naming this path as its prev. Without it every
// rename shows up in the deleted list as a phantom deletion, and the list stops
// being usable for recovery because most of it is noise.
func (s *Store) Deleted(vaultID string, suppressRenames bool) ([]Entry, error) {
	q := `SELECT e.uid, e.path, e.size, e.ctime, e.mtime, e.folder, e.deleted, e.device, e.prev_path
	        FROM entries e
	        JOIN (SELECT path, MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path) latest
	          ON e.path = latest.path AND e.uid = latest.uid
	       WHERE e.vault_id = ? AND e.deleted = 1`
	if suppressRenames {
		q += ` AND NOT EXISTS (
		         SELECT 1 FROM entries r
		          WHERE r.vault_id = e.vault_id AND r.prev_path = e.path AND r.uid > e.uid)`
	}
	q += ` ORDER BY e.uid DESC`

	return s.manyEntries(vaultID, q, vaultID, vaultID)
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

	rows, err := tx.Query(
		`SELECT uid, ord, name FROM entry_chunks
		  WHERE vault_id = ? AND uid BETWEEN ? AND ? ORDER BY uid ASC, ord ASC`,
		vaultID, lo, hi)
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
	Files       int64 // live, non-deleted, non-folder
	Folders     int64
	Deleted     int64 // paths whose newest version is a deletion
	Bytes       int64 // sum of declared plaintext sizes of live files
	Versions    int64 // entry rows, including superseded ones
	ChunkRefs   int64 // distinct chunk names referenced by any entry
	LatestUID   int64
	AllocatedTo int64 // next_uid - 1: uids handed out, including purged ones
}

func (s *Store) Stats(vaultID string) (Stats, error) {
	var st Stats
	row := s.db.QueryRow(
		`SELECT
		   COALESCE(SUM(CASE WHEN e.deleted = 0 AND e.folder = 0 THEN 1 ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN e.folder = 1 THEN 1 ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN e.deleted = 1 THEN 1 ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN e.deleted = 0 AND e.folder = 0 THEN e.size ELSE 0 END), 0)
		 FROM entries e
		 JOIN (SELECT path, MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path) latest
		   ON e.path = latest.path AND e.uid = latest.uid
		 WHERE e.vault_id = ?`, vaultID, vaultID)
	if err := row.Scan(&st.Files, &st.Folders, &st.Deleted, &st.Bytes); err != nil {
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
	var next sql.NullInt64
	if err := s.db.QueryRow(
		`SELECT next_uid FROM vaults WHERE vault_id = ?`, vaultID).Scan(&next); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return st, err
		}
	}
	st.AllocatedTo = next.Int64 - 1
	var err error
	st.LatestUID, err = s.LatestUID(vaultID)
	return st, err
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
// Chunk links go with their entries by ON DELETE CASCADE, so the live set is
// read after the delete and is exactly what survived.
func (s *Store) Purge(vaultID string, grace time.Duration) (PurgeReport, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var rep PurgeReport
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM entries WHERE vault_id = ?`, vaultID).Scan(&rep.VersionsBefore); err != nil {
		return rep, err
	}

	res, err := s.db.Exec(
		`DELETE FROM entries
		  WHERE vault_id = ?
		    AND uid NOT IN (SELECT MAX(uid) FROM entries WHERE vault_id = ? GROUP BY path)`,
		vaultID, vaultID)
	if err != nil {
		return rep, err
	}
	rep.VersionsRemoved, _ = res.RowsAffected()

	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM entries WHERE vault_id = ?`, vaultID).Scan(&rep.VersionsAfter); err != nil {
		return rep, err
	}
	// The purge keeps one version per path, so what remains must equal the
	// number of distinct paths. Checking it here means a future change to the
	// delete predicate that removes a live entry fails immediately instead of
	// being discovered as a missing note.
	var paths int64
	if err := s.db.QueryRow(
		`SELECT COUNT(DISTINCT path) FROM entries WHERE vault_id = ?`, vaultID).Scan(&paths); err != nil {
		return rep, err
	}
	if rep.VersionsAfter != paths {
		return rep, fmt.Errorf("purge left %d versions for %d paths in vault %q",
			rep.VersionsAfter, paths, vaultID)
	}
	if rep.VersionsBefore-rep.VersionsRemoved != rep.VersionsAfter {
		return rep, fmt.Errorf("purge arithmetic: %d - %d != %d",
			rep.VersionsBefore, rep.VersionsRemoved, rep.VersionsAfter)
	}

	live, err := s.liveChunks(vaultID)
	if err != nil {
		return rep, err
	}
	rep.ChunksLive = len(live)
	rep.ChunksDeleted, rep.ChunksSpared, err = s.chunks.Sweep(vaultID, live, time.Now().Add(-grace))
	return rep, err
}

// liveChunks is every chunk name referenced by a committed entry of this vault.
// Caller must hold writeMu.
func (s *Store) liveChunks(vaultID string) (map[string]struct{}, error) {
	rows, err := s.db.Query(
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
	Chunk   string
	Reason  string // "missing" or "corrupt"
	Detail  string
}

func (f Fault) String() string {
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
	return faults, checked, rows.Err()
}

// PrunedVault names a vault removed by PruneEmptyVaults.
type PrunedVault struct {
	VaultID   string
	CreatedAt int64
}

// PruneEmptyVaults removes vaults that hold no entries at all.
//
// These accumulate from typos in a vault id, from probing and from tests: a
// connect is enough to create the row, because EnsureVault runs before anything
// is pushed. They cost almost nothing, but they make the vault list untrustworthy
// as a picture of what is stored.
//
// minAgeMillis exists because "no entries" is also what a brand-new device looks
// like during its first connect, before its initial upload lands. Deleting the
// row underneath it would make the next AppendEntry fail with unknown vault.
//
// Only genuinely empty vaults qualify. A vault whose files were all deleted
// still has rows, because deletions are entries, so it is not empty and is not
// touched. That is rule 6, and it is the reason this is safe to run unattended.
func (s *Store) PruneEmptyVaults(now, minAgeMillis int64) ([]PrunedVault, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	rows, err := s.db.Query(
		`SELECT v.vault_id, v.created_at FROM vaults v
		  WHERE v.created_at <= ?
		    AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.vault_id = v.vault_id)`,
		now-minAgeMillis)
	if err != nil {
		return nil, err
	}
	var doomed []PrunedVault
	for rows.Next() {
		var pv PrunedVault
		if err := rows.Scan(&pv.VaultID, &pv.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		doomed = append(doomed, pv)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var pruned []PrunedVault
	for _, pv := range doomed {
		// The delete re-checks emptiness rather than trusting the list above.
		// Both run under one lock today; making the delete itself conditional
		// means a future caller that forgets the lock still cannot remove a
		// vault that has gained entries.
		res, err := s.db.Exec(
			`DELETE FROM vaults WHERE vault_id = ?
			   AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.vault_id = vaults.vault_id)`,
			pv.VaultID)
		if err != nil {
			return pruned, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		pruned = append(pruned, pv)
		// The chunk directory should be absent or empty. Remove it only if
		// empty, so a surprise here leaves evidence instead of deleting data.
		dir := s.chunks.VaultDir(pv.VaultID)
		if entries, err := os.ReadDir(dir); err == nil && len(entries) == 0 {
			_ = os.Remove(dir)
		}
	}
	return pruned, nil
}

/* ---------------------------------------------------------------- */

type scannable interface {
	Scan(dest ...any) error
}

func scanEntry(r scannable) (Entry, error) {
	var e Entry
	var folder, deleted int
	err := r.Scan(&e.UID, &e.Path, &e.Size, &e.CTime, &e.MTime, &folder, &deleted, &e.Device, &e.Prev)
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
