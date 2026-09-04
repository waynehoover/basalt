package store

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
)

/* ---------------------------------------------------------------- *
 * A database written by an older build
 * ---------------------------------------------------------------- */

// The whole risk in migrate is that it runs against a directory with somebody's
// notes in it, and nothing exercised it: `grep -rn migrat --include='*_test.go'`
// found nothing covering purges, rotations, auth_hash, wrapped, mac or parent.
// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
// every one of those columns is invisible to a fresh-directory test, which is
// every other test in this package. Rule 9 wants a test that fails without the
// ALTER, and this is it.
//
// oldSchema is the shape before any of them: the tables as they were, with the
// columns this build adds left out, and without the index migrate adds too.
const oldSchema = `
CREATE TABLE vaults (
  vault_id   TEXT    PRIMARY KEY,
  next_uid   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE entries (
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

CREATE TABLE entry_chunks (
  vault_id TEXT    NOT NULL,
  uid      INTEGER NOT NULL,
  ord      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  PRIMARY KEY (vault_id, uid, ord),
  FOREIGN KEY (vault_id, uid) REFERENCES entries(vault_id, uid) ON DELETE CASCADE
);

CREATE INDEX entries_by_path ON entries(vault_id, path, uid DESC);
CREATE INDEX entry_chunks_by_name ON entry_chunks(vault_id, name);
`

// writeOldDatabase makes a database in the shape an older build left, with a
// vault, three versions of one note, a folder, a deletion and a rename in it,
// so the migration has something to lose.
func writeOldDatabase(t *testing.T, dbPath string) {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(oldSchema); err != nil {
		t.Fatalf("old schema: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO vaults (vault_id, next_uid, created_at) VALUES ('v1', 7, 1000)`); err != nil {
		t.Fatalf("insert vault: %v", err)
	}
	rows := []struct {
		uid                    int64
		path                   string
		size                   int64
		folder, deleted        int
		device, prevPath, body string
	}{
		{1, "sealed-note", 11, 0, 0, "old-device", "", "version one"},
		{2, "sealed-note", 11, 0, 0, "old-device", "", "version two"},
		{3, "sealed-note", 13, 0, 0, "old-device", "", "version three"},
		{4, "sealed-folder", 0, 1, 0, "old-device", "", ""},
		{5, "sealed-gone", 0, 0, 1, "old-device", "", ""},
		{6, "sealed-new-name", 5, 0, 0, "old-device", "sealed-old-name", "moved"},
	}
	for _, r := range rows {
		if _, err := db.Exec(
			`INSERT INTO entries (vault_id, uid, path, size, ctime, mtime, folder, deleted, device, prev_path)
			 VALUES ('v1', ?, ?, ?, 0, 10, ?, ?, ?, ?)`,
			r.uid, r.path, r.size, r.folder, r.deleted, r.device, r.prevPath); err != nil {
			t.Fatalf("insert entry %d: %v", r.uid, err)
		}
		if r.body != "" {
			if _, err := db.Exec(
				`INSERT INTO entry_chunks (vault_id, uid, ord, name) VALUES ('v1', ?, 0, ?)`,
				r.uid, chunks.Name([]byte(r.body))); err != nil {
				t.Fatalf("insert chunk ref %d: %v", r.uid, err)
			}
		}
	}
}

func TestOpeningADatabaseFromAnOlderBuildAddsTheColumnsAndLosesNothing(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "basalt.db")
	writeOldDatabase(t, dbPath)

	s, err := Open(dbPath, filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("opening a database from an older build: %v", err)
	}
	defer s.Close()

	// Every column this build added since, on both tables.
	for _, c := range []struct{ table, column string }{
		{"vaults", "auth_hash"}, {"vaults", "wrapped"},
		{"vaults", "rotations"}, {"vaults", "purges"},
		{"entries", "mac"}, {"entries", "parent"},
	} {
		has, err := hasColumn(s.db, c.table, c.column)
		if err != nil {
			t.Fatalf("%s.%s: %v", c.table, c.column, err)
		}
		if !has {
			t.Fatalf("%s has no %s after migrating; this build's queries cannot run against it",
				c.table, c.column)
		}
	}

	// And the index migrate adds, which CREATE INDEX IF NOT EXISTS in the
	// schema would never reach on a table that already existed.
	var indexes int
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'entries_by_prev'`).Scan(&indexes); err != nil {
		t.Fatalf("looking for entries_by_prev: %v", err)
	}
	if indexes != 1 {
		t.Fatal("entries_by_prev is missing after migrating")
	}

	// Rule 5: a migration that makes the list smaller is a bug. Every row is
	// still there, with the values it had.
	st, err := s.Stats("v1")
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.Versions != 6 {
		t.Fatalf("%d versions survived the migration, want 6", st.Versions)
	}
	if st.OldestUID != 1 || st.LatestUID != 6 || st.AllocatedTo != 6 {
		t.Fatalf("uid range after migrating: oldest %d latest %d allocated %d, want 1, 6, 6",
			st.OldestUID, st.LatestUID, st.AllocatedTo)
	}
	// The generations start at zero, which is right: both are only ever
	// compared with another value of themselves.
	if st.Purges != 0 {
		t.Fatalf("purges = %d on a database that predates the column, want 0", st.Purges)
	}
	hash, wrapped, rotations, err := s.VaultKeys("v1")
	if err != nil {
		t.Fatalf("vault keys: %v", err)
	}
	if hash != "" || wrapped != "" || rotations != 0 {
		t.Fatalf("an unclaimed vault came back as hash %q wrapped %q rotations %d", hash, wrapped, rotations)
	}

	// The entries themselves, including the columns that were already there
	// and the ones that were not. A row written before the authenticator
	// existed keeps the empty string, because the server holds no key and
	// cannot invent one; a client refuses it, which is the point.
	e, ok, err := s.EntryByUID("v1", 3)
	if err != nil || !ok {
		t.Fatalf("uid 3 after migrating: ok=%v err=%v", ok, err)
	}
	if e.Path != "sealed-note" || e.Size != 13 || e.Device != "old-device" {
		t.Fatalf("uid 3 came back as %+v", e)
	}
	if len(e.Chunks) != 1 || e.Chunks[0] != chunks.Name([]byte("version three")) {
		t.Fatalf("uid 3 lost its chunk list: %v", e.Chunks)
	}
	if e.Mac != "" || e.Parent != "" {
		t.Fatalf("uid 3 gained an authenticator out of nowhere: mac %q parent %q", e.Mac, e.Parent)
	}
	if renamed, ok, err := s.EntryByUID("v1", 6); err != nil || !ok || renamed.Prev != "sealed-old-name" {
		t.Fatalf("uid 6 lost its rename: %+v ok=%v err=%v", renamed, ok, err)
	}

	// The migrated store is writable, and uids continue from where the old
	// build left off rather than being reissued over the top of history.
	next, err := s.AppendEntry("v1", Entry{Path: "sealed-after", Mac: testMac, MTime: 20})
	if err != nil {
		t.Fatalf("appending to a migrated store: %v", err)
	}
	if next != 7 {
		t.Fatalf("the next uid is %d, want 7", next)
	}
}

// Idempotent, because it runs on every open. The second pass must find every
// column already there and change nothing: an ALTER that ran twice would fail
// the open, and a server that starts once and not again is worse than one that
// never started.
func TestMigratingTwiceChangesNothing(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "basalt.db")
	writeOldDatabase(t, dbPath)

	first, err := Open(dbPath, filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	before := schemaOf(t, first.db)
	if err := first.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	second, err := Open(dbPath, filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("second open of an already migrated database: %v", err)
	}
	defer second.Close()
	if after := schemaOf(t, second.db); after != before {
		t.Fatalf("the second migration changed the schema:\nfirst:\n%s\nsecond:\n%s", before, after)
	}
	st, err := second.Stats("v1")
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.Versions != 6 {
		t.Fatalf("%d versions after migrating twice, want 6", st.Versions)
	}
}

// schemaOf is every table and index definition, in a stable order, so two
// migrations can be compared as strings.
func schemaOf(t *testing.T, db *sql.DB) string {
	t.Helper()
	rows, err := db.Query(
		`SELECT type, name, IFNULL(sql, '') FROM sqlite_master ORDER BY type, name`)
	if err != nil {
		t.Fatalf("reading the schema: %v", err)
	}
	defer rows.Close()
	var out string
	for rows.Next() {
		var typ, name, def string
		if err := rows.Scan(&typ, &name, &def); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out += typ + " " + name + ": " + def + "\n"
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return out
}
