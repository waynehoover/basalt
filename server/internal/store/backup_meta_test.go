package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* ---------------------------------------------------------------- *
 * backup.json describes the database beside it, or it is not there
 * ---------------------------------------------------------------- */

// The comment on the publish sequence used to argue that a crash between the
// database rename and the coverage file was harmless, because the coverage
// left behind "claims less than the directory holds". That is only true when
// nothing has been purged since the previous run. After a purge the previous
// run's coverage is the larger, older range: uids 1 to 6 and generation 0 in
// backup.json, beside a database holding 3 to 6 at generation 1. The retention
// query in docs/server.md then picks this directory for a uid it no longer
// has, which is the one question the file exists to answer.
//
// So the old file is unpublished before the database it describes is. A crash
// in that window leaves no coverage, which every reader already handles: rule
// 2, absent and unreadable are different states, and so are absent and wrong.
func TestBackupLeavesNoCoverageRatherThanStaleCoverage(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "version one")
	h.file(t, "note.md", "version two")
	h.file(t, "note.md", "version three")

	dir := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dir, false); err != nil {
		t.Fatalf("first backup: %v", err)
	}
	first, err := ReadBackupMeta(dir)
	if err != nil {
		t.Fatalf("reading the first coverage: %v", err)
	}
	if first.Vaults[0].Versions != 3 || first.Vaults[0].Purges != 0 {
		t.Fatalf("the first backup covers %+v, want 3 versions at generation 0", first.Vaults[0])
	}

	// A purge, so the next snapshot is the smaller one and the stale coverage
	// would be the larger.
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatalf("purge: %v", err)
	}

	// Crash between the rename and the coverage file.
	boom := errors.New("the machine went away")
	h.afterPublish = func() error { return boom }
	if _, err := h.Backup(dir, false); !errors.Is(err, boom) {
		t.Fatalf("the injected failure did not come back: %v", err)
	}
	h.afterPublish = nil

	// The database is the new one.
	restored := openBackup(t, dir)
	st, err := restored.Stats("v1")
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.Versions != 1 {
		t.Fatalf("the published database holds %d versions, want 1", st.Versions)
	}

	// And there is no coverage claiming the three the previous run had.
	if _, err := os.Stat(filepath.Join(dir, BackupMetaFile)); !os.IsNotExist(err) {
		got, readErr := ReadBackupMeta(dir)
		t.Fatalf("%s survived a crash before it was rewritten: %+v (err %v, stat %v)",
			BackupMetaFile, got, readErr, err)
	}

	// The next run puts it back, describing what is actually there.
	if _, err := h.Backup(dir, false); err != nil {
		t.Fatalf("third backup: %v", err)
	}
	again, err := ReadBackupMeta(dir)
	if err != nil {
		t.Fatalf("reading the coverage after the next run: %v", err)
	}
	if again.Vaults[0].Versions != 1 || again.Vaults[0].Purges != 1 {
		t.Fatalf("coverage after the next run: %+v, want 1 version at generation 1", again.Vaults[0])
	}
}

// The other way the file goes stale, which no ordering here can prevent: a
// build that does not write it republishes the database into the same
// directory. The coverage then describes a snapshot that is gone, for ever,
// because nothing corrects it. So it is stamped with the size of the database
// it describes and the stamp is checked on every read.
func TestCoverageIsStampedAgainstTheDatabaseBesideIt(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "version one")
	dir := filepath.Join(t.TempDir(), "backup")
	rep, err := h.Backup(dir, false)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}

	dbPath, _ := DataDir(dir)
	info, err := os.Stat(dbPath)
	if err != nil {
		t.Fatalf("stat the published database: %v", err)
	}
	if rep.Meta.Database.Bytes != info.Size() {
		t.Fatalf("the coverage stamps %d bytes, the database beside it is %d",
			rep.Meta.Database.Bytes, info.Size())
	}
	if rep.Meta.Database.ModifiedAt == "" {
		t.Fatal("the coverage records no modification time for the database")
	}
	if _, err := ReadBackupMeta(dir); err != nil {
		t.Fatalf("reading back what was just written: %v", err)
	}

	// Something else republishes the database. The coverage is now a summary
	// of a snapshot that is not here.
	f, err := os.OpenFile(dbPath, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open the database: %v", err)
	}
	if _, err := f.Write(make([]byte, 4096)); err != nil {
		t.Fatalf("append: %v", err)
	}
	f.Close()

	_, err = ReadBackupMeta(dir)
	if err == nil {
		t.Fatal("the coverage was read as a summary of a database it does not describe")
	}
	if !strings.Contains(err.Error(), "republished") {
		t.Fatalf("the refusal does not say what happened: %v", err)
	}
}
