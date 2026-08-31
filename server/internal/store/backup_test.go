package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
)

// openBackup opens a backup directory the way the server would, which is the
// point of writing a backup as a data directory: restoring is copying it back.
func openBackup(t *testing.T, dir string) *Store {
	t.Helper()
	dbPath, chunkDir := DataDir(dir)
	s, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatalf("opening the backup as a data directory: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// A backup has to be restorable, not merely written. This checks the whole
// round trip: every entry, every chunk list, every body, and a deep verify.
func TestABackupRestoresEverything(t *testing.T) {
	h := newTestStore(t)
	var want []Entry
	for i := 0; i < 5; i++ {
		want = append(want, h.file(t, fmt.Sprintf("f%d.md", i), "shared head", fmt.Sprintf("tail %d", i)))
	}
	// History, a folder, a deletion and an empty note, so the backup is not
	// only tested on the easy shape.
	want = append(want, h.file(t, "f0.md", "shared head", "a second version"))
	for _, e := range []Entry{
		{Path: "folder", Mac: testMac, Folder: true},
		{Path: "f1.md", Mac: testMac, Deleted: true, MTime: 9},
		{Path: "empty.md", Mac: testMac, Size: 0, MTime: 9},
	} {
		uid, err := h.AppendEntry("v1", e)
		if err != nil {
			t.Fatalf("append: %v", err)
		}
		e.UID = uid
		want = append(want, e)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	rep, err := h.Backup(dir, true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	t.Log(rep)

	// The backup's own arithmetic. Six distinct bodies: one shared head plus
	// five tails, plus the second version's body.
	if rep.Vaults != 1 {
		t.Fatalf("Vaults = %d, want 1", rep.Vaults)
	}
	if rep.Copied != 7 {
		t.Fatalf("Copied = %d bodies, want 7", rep.Copied)
	}
	if rep.Verified != int(rep.Refs) {
		t.Fatalf("verified %d of %d references", rep.Verified, rep.Refs)
	}
	if rep.SourceBodies != rep.DestBodies {
		t.Fatalf("%d bodies at source, %d in the backup", rep.SourceBodies, rep.DestBodies)
	}

	restored := openBackup(t, dir)
	for _, e := range want {
		got, ok, err := restored.EntryByUID("v1", e.UID)
		if err != nil || !ok {
			t.Fatalf("uid %d missing from the backup: ok=%v err=%v", e.UID, ok, err)
		}
		if got.Path != e.Path || got.Size != e.Size || got.Deleted != e.Deleted || got.Folder != e.Folder {
			t.Fatalf("uid %d came back as %+v, want %+v", e.UID, got, e)
		}
		if len(got.Chunks) != len(e.Chunks) {
			t.Fatalf("uid %d has %d chunks, want %d", e.UID, len(got.Chunks), len(e.Chunks))
		}
		for i := range e.Chunks {
			if got.Chunks[i] != e.Chunks[i] {
				t.Fatalf("uid %d chunk %d differs", e.UID, i)
			}
			body, err := restored.Chunks().Get("v1", got.Chunks[i])
			if err != nil {
				t.Fatalf("uid %d chunk %d body: %v", e.UID, i, err)
			}
			srcBody, err := h.Chunks().Get("v1", e.Chunks[i])
			if err != nil {
				t.Fatalf("source body: %v", err)
			}
			if string(body) != string(srcBody) {
				t.Fatalf("uid %d chunk %d body differs", e.UID, i)
			}
		}
	}

	// The restored store must be usable, not just readable: uids continue from
	// where they left off rather than being reissued.
	next, err := restored.AppendEntry("v1", Entry{Path: "after.md", Mac: testMac, Size: 0, MTime: 10})
	if err != nil {
		t.Fatalf("appending to a restored backup: %v", err)
	}
	if next != want[len(want)-1].UID+1 {
		t.Fatalf("next uid after restore = %d, want %d", next, want[len(want)-1].UID+1)
	}
}

// The second backup into the same directory copies only what is missing. This is
// what makes a backup cheap enough to run often, and it works only because a
// body is named by its hash, so one already there is already correct.
func TestASecondBackupCopiesOnlyWhatIsNew(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 4; i++ {
		h.file(t, fmt.Sprintf("f%d.md", i), fmt.Sprintf("body %d", i))
	}
	dir := filepath.Join(t.TempDir(), "backup")

	first, err := h.Backup(dir, false)
	if err != nil {
		t.Fatalf("first backup: %v", err)
	}
	if first.Copied != 4 {
		t.Fatalf("first backup copied %d bodies, want 4", first.Copied)
	}

	second, err := h.Backup(dir, false)
	if err != nil {
		t.Fatalf("second backup: %v", err)
	}
	if second.Copied != 0 || second.Bytes != 0 {
		t.Fatalf("second backup copied %d bodies (%d bytes), want none",
			second.Copied, second.Bytes)
	}
	if second.Refs != first.Refs {
		t.Fatalf("second backup saw %d references, first saw %d", second.Refs, first.Refs)
	}

	// New work, then a third backup that copies exactly the new body.
	h.file(t, "new.md", "brand new body")
	third, err := h.Backup(dir, true)
	if err != nil {
		t.Fatalf("third backup: %v", err)
	}
	if third.Copied != 1 {
		t.Fatalf("third backup copied %d bodies, want 1", third.Copied)
	}
	if third.Refs != first.Refs+1 {
		t.Fatalf("third backup saw %d references, want %d", third.Refs, first.Refs+1)
	}
}

// A commit landing while a backup runs must not make the backup inconsistent.
//
// The ordering that guarantees this is not enforced by a comment: the list of
// bodies to copy comes from the *snapshot*, so a body cannot be copied for an
// entry the snapshot does not have, and the snapshot cannot contain an entry
// whose bodies were not already durable. Copying bodies first is not merely
// wrong, it is unexpressible, because there would be no reference list yet.
//
// What is worth pinning down is the consequence: the backup contains exactly
// what its own database claims, and the entry committed mid-run is simply
// absent, because a backup is a point in time.
func TestABackupNeverHoldsAnEntryWithoutItsBodies(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 3; i++ {
		h.file(t, fmt.Sprintf("f%d.md", i), fmt.Sprintf("body %d", i))
	}

	dir := filepath.Join(t.TempDir(), "backup")
	// Commit while the backup is between its snapshot and its body copy. The
	// hook fires on every reference, and the first one is comfortably after the
	// snapshot was taken.
	var once bool
	h.duringBackup = func() {
		if once {
			return
		}
		once = true
		h.file(t, "raced.md", "committed mid backup")
	}

	rep, err := h.Backup(dir, true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if !once {
		t.Fatal("the interleaving never happened, so this test proved nothing")
	}

	// The backup is self-consistent: everything its database claims, it holds.
	restored := openBackup(t, dir)
	faults, checked, err := restored.Verify(true)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(faults) != 0 {
		t.Fatalf("the backup holds %d entries it cannot serve: %v", len(faults), faults[0])
	}
	if checked == 0 {
		t.Fatal("verify checked nothing")
	}
	// The raced entry is absent, and so is its body. A backup that copied
	// bodies for entries newer than its own snapshot would hold something its
	// database does not reference, which makes the backup's contents no longer
	// determined by the backup.
	if _, ok, err := restored.LatestForPath("v1", "raced.md"); err != nil {
		t.Fatalf("latest: %v", err)
	} else if ok {
		t.Fatal("an entry committed after the snapshot is in the backup")
	}
	if rep.DestBodies != 3 {
		t.Fatalf("the backup holds %d bodies for a 3 entry snapshot: it copied bodies "+
			"for work committed after the snapshot", rep.DestBodies)
	}
	if rep.SourceBodies != 4 {
		t.Fatalf("SourceBodies = %d, want 4: the raced commit added one", rep.SourceBodies)
	}
	t.Log(rep)
}

// The verify pass at the end of a backup is what turns "written" into
// "restorable". Without it a backup that lost a body between copying it and
// finishing would still be reported as a success, and nothing looks at a backup
// again until it is the only copy left.
//
// The body is removed from the *destination* after being copied, because a body
// missing at the source fails at the copy and never reaches the verify.
func TestABackupVerifiesWhatItWroteAndNotWhatItIntendedTo(t *testing.T) {
	h := newTestStore(t)
	var first Entry
	for i := 0; i < 4; i++ {
		e := h.file(t, fmt.Sprintf("f%d.md", i), fmt.Sprintf("body %d", i))
		if i == 0 {
			first = e
		}
	}

	dir := filepath.Join(t.TempDir(), "backup")
	_, destChunkDir := DataDir(dir)

	// On the third reference, delete the body copied on the first.
	calls := 0
	h.duringBackup = func() {
		calls++
		if calls != 3 {
			return
		}
		cs, err := chunks.New(destChunkDir, ChunkMax)
		if err != nil {
			t.Fatalf("opening the backup's chunk store: %v", err)
		}
		p, err := cs.Path("v1", first.Chunks[0])
		if err != nil {
			t.Fatalf("path: %v", err)
		}
		if err := os.Remove(p); err != nil {
			t.Fatalf("removing a copied body: %v", err)
		}
	}

	_, err := h.Backup(dir, false)
	if err == nil {
		t.Fatal("the backup reported success after losing a body it had already copied")
	}
	if !strings.Contains(err.Error(), "missing") {
		t.Fatalf("err = %v, want it to say what is missing", err)
	}
	if calls < 3 {
		t.Fatalf("the hook fired %d times, so the body was never removed", calls)
	}
}

// Bit rot at the source must fail the backup rather than being copied onward,
// and it must blame the source.
//
// The write end would refuse it anyway, since Put verifies what it is given. The
// value of reading through Get is the diagnosis: a body that rotted on the
// source disk reported as a fault at the destination sends someone to check the
// wrong disk.
func TestABackupRefusesACorruptBodyAndBlamesTheSource(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "the original bytes")
	p, err := h.Chunks().Path("v1", e.Chunks[0])
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.WriteFile(p, []byte("something else entirely"), 0o600); err != nil {
		t.Fatalf("tamper: %v", err)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	_, err = h.Backup(dir, false)
	if err == nil {
		t.Fatal("a corrupt body was copied into the backup and reported as a success")
	}
	if !strings.Contains(err.Error(), "reading") {
		t.Fatalf("the failure does not say the body was bad on the way out of the source, "+
			"so it points at the wrong disk: %v", err)
	}
}

// SnapshotInto never writes over an existing file. SQLite enforces this, not
// this package, so the test is here to notice if that ever stops being true
// rather than to cover a check of our own.
func TestSnapshotIntoRefusesAnExistingFile(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")

	target := filepath.Join(t.TempDir(), "snap.db")
	if err := h.SnapshotInto(target); err != nil {
		t.Fatalf("first snapshot: %v", err)
	}
	if err := h.SnapshotInto(target); err == nil {
		t.Fatal("the second snapshot overwrote the first")
	}
}

// A backup that cannot find a body it needs fails, loudly. Reporting success
// here is the one outcome that must never happen, because nothing looks at a
// backup again until it is the only copy left.
func TestABackupFailsWhenABodyIsMissing(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "will vanish")
	p, err := h.Chunks().Path("v1", e.Chunks[0])
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatalf("remove: %v", err)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dir, false); err == nil {
		t.Fatal("the backup reported success with a body missing from the source")
	}
}

// Backing up into the data directory would half work, which is worse than
// failing.
func TestABackupRefusesTheDataDirectoryItself(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")

	if _, err := h.Backup(h.dir, false); err == nil {
		t.Fatal("the backup accepted the data directory as its destination")
	} else if !strings.Contains(err.Error(), "data directory itself") {
		t.Fatalf("err = %v, want it to say why", err)
	}
}

// An interrupted backup must leave the previous database in place rather than a
// half-written one, so a failed run does not destroy the last good backup.
func TestAnInterruptedSnapshotLeavesThePreviousBackupIntact(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "the only copy")
	dir := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dir, false); err != nil {
		t.Fatalf("first backup: %v", err)
	}

	// Debris from a run that died between the snapshot and the rename.
	tmp := filepath.Join(dir, ".basalt.db.snapshot")
	if err := os.WriteFile(tmp, []byte("half a database"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	// The previous backup still opens and still holds the note.
	restored := openBackup(t, dir)
	if _, ok, err := restored.LatestForPath("v1", "note.md"); err != nil || !ok {
		t.Fatalf("the previous backup was damaged: ok=%v err=%v", ok, err)
	}
	restored.Close()

	// And the next run clears the debris rather than tripping over it.
	if _, err := h.Backup(dir, true); err != nil {
		t.Fatalf("backup after an interrupted one: %v", err)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Fatalf("the snapshot temporary file survived: %v", err)
	}
}

// A backup holds full history, not just the current state. That is most of the
// reason to keep one: a deleted note is recoverable from the server only while
// the server still has the entry that deleted it.
func TestABackupKeepsHistoryAndDeletions(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "version one")
	h.file(t, "note.md", "version two")
	if _, err := h.AppendEntry("v1", Entry{Path: "note.md", Mac: testMac, Deleted: true, MTime: 9}); err != nil {
		t.Fatalf("delete: %v", err)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dir, true); err != nil {
		t.Fatalf("backup: %v", err)
	}

	restored := openBackup(t, dir)
	history, err := restored.HistoryForPath("v1", "note.md", 0, 10)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(history) != 3 {
		t.Fatalf("the backup holds %d versions of note.md, want 3", len(history))
	}
	// The first version's body is still there, which is what makes it
	// recoverable.
	oldest := history[len(history)-1]
	body, err := restored.Chunks().Get("v1", oldest.Chunks[0])
	if err != nil {
		t.Fatalf("the oldest version's body is gone from the backup: %v", err)
	}
	if string(body) != "version one" {
		t.Fatalf("oldest body is %q", body)
	}
	del, _, err := restored.Deleted("v1", true, 0)
	if err != nil {
		t.Fatalf("deleted: %v", err)
	}
	if len(del) != 1 {
		t.Fatalf("the backup lists %d deletions, want 1", len(del))
	}
}

// Multiple vaults are namespaced in the backup exactly as they are at source, so
// one vault's backup cannot serve another vault's body.
func TestABackupKeepsVaultsSeparate(t *testing.T) {
	h := newTestStore(t)
	if err := h.EnsureVault("v2", 1); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	h.file(t, "shared.md", "identical content")
	name := chunks.Name([]byte("identical content"))
	if err := h.Chunks().Put("v2", name, []byte("identical content")); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := h.AppendEntry("v2", Entry{
		Path: "shared.md", Mac: testMac, Size: 17, MTime: 1, Chunks: []string{name},
	}); err != nil {
		t.Fatalf("append: %v", err)
	}

	dir := filepath.Join(t.TempDir(), "backup")
	rep, err := h.Backup(dir, true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if rep.Vaults != 2 {
		t.Fatalf("Vaults = %d, want 2", rep.Vaults)
	}
	// The same content in two vaults is two bodies, at source and in the backup,
	// because vaults do not share chunk storage.
	if rep.Copied != 2 {
		t.Fatalf("Copied = %d, want 2: vaults must not share bodies", rep.Copied)
	}

	restored := openBackup(t, dir)
	for _, v := range []string{"v1", "v2"} {
		if !restored.Chunks().Has(v, name) {
			t.Fatalf("vault %s lost its body in the backup", v)
		}
	}
}

// mustPath is used only by the mutation pass, to stand in for a copy that reads
// the body without checksumming it.
func mustPath(s *Store, vaultID, name string) string {
	p, err := s.Chunks().Path(vaultID, name)
	if err != nil {
		panic(err)
	}
	return p
}

// The body counts either side of a backup are what explain why the backup is
// smaller. A temporary file counted as a body makes that explanation wrong, and
// an unexplained discrepancy in a backup report is exactly what rule 5 is about.
func TestBackupCountsIgnoreInProgressWrites(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")

	// An upload in flight, or the debris of one that died.
	dir := filepath.Join(h.Chunks().VaultDir("v1"), "ab")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".tmp-inflight"), []byte("half"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	rep, err := h.Backup(filepath.Join(t.TempDir(), "backup"), true)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if rep.SourceBodies != 1 {
		t.Fatalf("SourceBodies = %d, want 1: a temporary file was counted as a body",
			rep.SourceBodies)
	}
	if rep.DestBodies != 1 {
		t.Fatalf("DestBodies = %d, want 1", rep.DestBodies)
	}
}
