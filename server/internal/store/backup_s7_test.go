package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// S7: a second backup that fails must leave the first fully restorable.
//
// The old order renamed the new snapshot over the last good database before it
// had copied the bodies that snapshot newly references. A missing source body
// then left the destination database claiming content it did not hold, and the
// previous recoverable backup gone. Now the snapshot is published only after
// its bodies are copied and verified, so a failed run leaves the first backup
// exactly as it was.
func TestS7AFailedSecondBackupLeavesTheFirstRestorable(t *testing.T) {
	h := newTestStore(t)
	first := h.file(t, "note.md", "the only durable copy of this note")
	dir := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dir, true); err != nil {
		t.Fatalf("first backup: %v", err)
	}

	// New history the second backup will try to capture, then break its source:
	// the newest version's body is removed, so the second snapshot references a
	// body the source cannot supply.
	second := h.file(t, "note.md", "a second version, whose body is about to vanish")
	p, err := h.Chunks().Path("v1", second.Chunks[len(second.Chunks)-1])
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatalf("remove: %v", err)
	}

	if _, err := h.Backup(dir, false); err == nil {
		t.Fatal("the second backup reported success with a source body missing")
	}

	// The first backup still opens, still verifies, and still holds the note.
	restored := openBackup(t, dir)
	faults, checked, err := restored.Verify(true)
	if err != nil {
		t.Fatalf("verifying the first backup after a failed second: %v", err)
	}
	if len(faults) != 0 {
		t.Fatalf("the failed second backup left the first with %d faults: %v", len(faults), faults[0])
	}
	if checked == 0 {
		t.Fatal("the first backup verified nothing, so it holds nothing")
	}
	got, ok, err := restored.EntryByUID("v1", first.UID)
	if err != nil || !ok {
		t.Fatalf("the first version is gone from the backup: ok=%v err=%v", ok, err)
	}
	body, err := restored.Chunks().Get("v1", got.Chunks[len(got.Chunks)-1])
	if err != nil {
		t.Fatalf("the first version's body is gone: %v", err)
	}
	if string(body) != "the only durable copy of this note" {
		t.Fatalf("the first version's body reads as %q", body)
	}
	restored.Close()

	// The live database is still the first backup's. A staged snapshot may
	// remain as debris, which the next run clears; what must not happen is its
	// having been published over the good database, which the verify above
	// already proved by opening basalt.db and finding it whole.
	if _, err := os.Stat(filepath.Join(dir, dbFileName)); err != nil {
		t.Fatalf("the published database is gone: %v", err)
	}
}

// S14: a backup taken after the source is purged keeps the purged history, and
// says it is keeping it rather than pretending the backup is determined by its
// newest database.
func TestS14ABackupAfterAPurgeRetainsTheOldBodies(t *testing.T) {
	h := newTestStore(t)
	old := h.file(t, "note.md", "shared head ", "the old tail")
	h.file(t, "note.md", "shared head ", "the new tail")

	dir := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dir, true); err != nil {
		t.Fatalf("first backup: %v", err)
	}

	// Purge the source: the old version and its unique tail body go.
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatalf("purge: %v", err)
	}
	oldTail := old.Chunks[len(old.Chunks)-1]
	if h.Chunks().Has("v1", oldTail) {
		t.Fatal("the purge did not remove the old version's body from the source")
	}

	// A second backup with shared chunks. It copies only the new work and
	// retains the old body, which is now only in the backup.
	rep, err := h.Backup(dir, true)
	if err != nil {
		t.Fatalf("backup after purge: %v", err)
	}
	if rep.Retained == 0 {
		t.Fatal("the backup reported no retained bodies after a source purge")
	}
	restored := openBackup(t, dir)
	if !restored.Chunks().Has("v1", oldTail) {
		t.Fatal("the backup swept the purged history it exists to keep")
	}
	// The old version's entry is gone from the newest snapshot, but its body
	// remains, which is what makes the earlier backup's history recoverable.
	body, err := restored.Chunks().Get("v1", oldTail)
	if err != nil || string(body) != "the old tail" {
		t.Fatalf("the retained old body reads as %q (err %v)", body, err)
	}
}

// S15: a destination inside the live store is refused before it can write
// anything into it, whether it is named lexically or through a symlink.
func TestS15BackupRefusesADestinationInsideTheLiveStore(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")
	before, err := h.Chunks().CountBodies()
	if err != nil {
		t.Fatalf("count: %v", err)
	}

	// Inside the chunk tree, named directly.
	inChunks := filepath.Join(h.dir, chunkDirName, "backup")
	if _, err := h.Backup(inChunks, false); err == nil {
		t.Fatal("a destination inside the chunk tree was accepted")
	} else if !strings.Contains(err.Error(), "overlaps") {
		t.Fatalf("err = %v, want it to say the destination overlaps the store", err)
	}

	// The data directory reached through a symlink, so a lexical check alone
	// would miss it.
	link := filepath.Join(t.TempDir(), "aliased")
	if err := os.Symlink(h.dir, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if _, err := h.Backup(filepath.Join(link, chunkDirName, "x"), false); err == nil {
		t.Fatal("a destination inside the chunk tree via a symlink was accepted")
	}
	if _, err := h.Backup(link, false); err == nil {
		t.Fatal("the data directory reached through a symlink was accepted as a destination")
	}

	// None of the refusals wrote into the live store.
	after, err := h.Chunks().CountBodies()
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if after != before {
		t.Fatalf("a refused backup still wrote into the live store: %d bodies before, %d after", before, after)
	}

	// An ordinary child of the data directory is fine, because it overlaps
	// neither the database nor the chunk tree.
	if _, err := h.Backup(filepath.Join(h.dir, "backup"), false); err != nil {
		t.Fatalf("an ordinary child of the data directory was refused: %v", err)
	}
}

// A destination that shares a name prefix with the data directory but is a
// sibling, not a child, is fine: the overlap check is by path segment, not by
// string prefix.
func TestS15ASiblingSharingAPrefixIsNotAnOverlap(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")
	sibling := h.dir + "-backup"
	if _, err := h.Backup(sibling, false); err != nil {
		t.Fatalf("a sibling sharing a prefix was refused: %v", err)
	}
}
