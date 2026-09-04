package store

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
)

/* ---------------------------------------------------------------- *
 * Purge tells you when it is worth running
 * ---------------------------------------------------------------- */

// The whole feature in one assertion: predict, then purge, then compare.
//
// Reclaimable exists so `stats` and the startup line can say what a purge
// would give back, and the only way that figure is worth anything is if it is
// the same figure the purge then reports. The two are computed by different
// SQL: Purge deletes every entry that is not MAX(uid) per path and sweeps what
// the survivors no longer reference; Reclaimable asks the inverse question of
// the same subquery and walks without deleting. Two predicates that must agree
// forever is exactly the kind of pair that drifts, and a preview promising
// space a purge does not free is worse than no preview, because somebody stops
// the server for it.
//
// So this does not check a number against a constant. It checks the prediction
// against the outcome, on a vault with every shape that matters in it: a path
// with history, a path with none, a deleted path, a multi-chunk file, a body
// two versions share, and an orphan no entry ever referenced.
func TestReclaimablePredictsExactlyWhatAPurgeThenFrees(t *testing.T) {
	h := newTestStore(t)

	// Three versions of one note, and the third reuses the first's body, so a
	// naive "count the bodies of the versions being dropped" would overcount.
	shared := "shared body"
	h.file(t, "note.md", shared, "v1 tail")
	h.file(t, "note.md", shared, "v2 tail")
	h.file(t, "note.md", shared, "v3 tail")
	// A path with no history at all: nothing here is reclaimable.
	h.file(t, "only.md", "one and only")
	// A multi-chunk attachment, superseded once.
	h.file(t, "att.bin", "part one ", "part two ", "part three")
	h.file(t, "att.bin", "part one ", "part two ", "part four!")
	// A deleted path whose earlier content version a purge drops.
	h.file(t, "gone.md", "about to go")
	if _, err := h.AppendEntry("v1", Entry{Path: "gone.md", Deleted: true, MTime: 20, Mac: testMac}); err != nil {
		t.Fatalf("append deletion: %v", err)
	}
	// An orphan: a body uploaded by a push whose entry never committed. A
	// purge collects it, so the prediction has to include it.
	orphan := "never referenced by anything"
	if err := h.Chunks().Put("v1", chunks.Name([]byte(orphan)), []byte(orphan)); err != nil {
		t.Fatalf("put orphan: %v", err)
	}

	// Grace zero on both sides, because a body written a moment ago is spared
	// at any real grace and this test is about the predicate, not the window.
	// The window has its own test below.
	predicted, err := h.Reclaimable("v1", 0)
	if err != nil {
		t.Fatalf("reclaimable: %v", err)
	}
	if !predicted.Complete {
		t.Fatal("the walk did not finish, so there is nothing to compare")
	}
	if predicted.Versions == 0 || predicted.Bodies == 0 || predicted.Bytes == 0 {
		t.Fatalf("predicted nothing to reclaim on a vault built to have some: %+v", predicted)
	}

	rep, err := h.Purge("v1", 0)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if predicted.Versions != rep.VersionsRemoved {
		t.Errorf("predicted %d versions would go, purge removed %d",
			predicted.Versions, rep.VersionsRemoved)
	}
	if predicted.Bodies != rep.ChunksDeleted {
		t.Errorf("predicted %d bodies would go, purge deleted %d",
			predicted.Bodies, rep.ChunksDeleted)
	}
	if predicted.Bytes != rep.BytesDeleted {
		t.Errorf("predicted %d bytes would come back, purge reclaimed %d",
			predicted.Bytes, rep.BytesDeleted)
	}

	// And having purged, there is nothing left to promise. A preview that
	// still claimed reclaimable space here would send somebody through the
	// ceremony a second time for nothing.
	after, err := h.Reclaimable("v1", 0)
	if err != nil {
		t.Fatalf("reclaimable after the purge: %v", err)
	}
	if after.Versions != 0 || after.Bodies != 0 || after.Bytes != 0 {
		t.Fatalf("a purged vault still offers %+v", after)
	}
}

// The grace window is reported separately, never folded in.
//
// This is the case an operator purging for space actually lands in: they stop
// the server and purge, and every body the sweep would have taken was written
// within the hour, so the purge reclaims nothing and says it spared them. A
// preview that summed the two would have promised the space that purge then
// refuses to take. Rule 8: the number that says what did not happen is a
// number too.
func TestReclaimableKeepsTheGraceWindowAsItsOwnFigure(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "one")
	h.file(t, "note.md", "two")
	h.file(t, "note.md", "three")

	// Everything above was written a moment ago, so at the default grace
	// nothing is collectible and all of it is in the window.
	fresh, err := h.Reclaimable("v1", chunks.DefaultGrace)
	if err != nil {
		t.Fatalf("reclaimable: %v", err)
	}
	if fresh.Bodies != 0 || fresh.Bytes != 0 {
		t.Fatalf("bodies written a moment ago are offered as reclaimable: %+v", fresh)
	}
	if fresh.RecentBodies == 0 || fresh.RecentBytes == 0 {
		t.Fatalf("the window is holding bodies back and nothing says so: %+v", fresh)
	}
	// The history count does not depend on the window at all: those versions
	// go whatever the grace is.
	if fresh.Versions != 2 {
		t.Fatalf("history = %d, want 2", fresh.Versions)
	}

	// The same store at grace zero moves the whole figure across.
	open, err := h.Reclaimable("v1", 0)
	if err != nil {
		t.Fatalf("reclaimable: %v", err)
	}
	if open.Bodies != fresh.RecentBodies || open.Bytes != fresh.RecentBytes {
		t.Fatalf("at grace 0 the spared bodies did not become the reclaimable ones: %+v against %+v",
			open, fresh)
	}
	if open.RecentBodies != 0 {
		t.Fatalf("grace 0 still spares something: %+v", open)
	}
}

// A vault whose chunk tree has never been written to is not an error and not a
// missing answer: it reclaims nothing, and the walk finished, because there
// was nothing to walk. Reported wrongly this would read as "the walk stopped",
// which tells an operator to run verify against a vault with no fault in it.
func TestReclaimableOnAVaultWithNoBodiesIsACompleteZero(t *testing.T) {
	h := newTestStore(t)
	rec, err := h.Reclaimable("v1", 0)
	if err != nil {
		t.Fatalf("reclaimable: %v", err)
	}
	if !rec.Complete {
		t.Fatal("an empty vault reports an unfinished walk")
	}
	if rec.Versions != 0 || rec.Bodies != 0 || rec.Bytes != 0 || rec.RecentBodies != 0 {
		t.Fatalf("an empty vault offers %+v", rec)
	}
}

// A walk that stopped is not a figure. Reclaimable inherits the sweep's rule
// 7 behaviour, and it has to, because the two are one walk: an unreadable
// shard means the numbers describe how far it got, and a caller that printed
// them would tell somebody a mostly-full store has nothing to reclaim.
func TestReclaimableSaysWhenTheWalkDidNotFinish(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "one")
	h.file(t, "note.md", "two")

	// A file in the chunk tree that is not a chunk, which is what the sweep
	// refuses to walk past. Same fault, same abort, same silence about
	// figures.
	stray := filepath.Join(h.Chunks().VaultDir("v1"), "not-a-chunk")
	if err := os.WriteFile(stray, []byte("evidence"), 0o600); err != nil {
		t.Fatalf("planting a stray file: %v", err)
	}
	rec, err := h.Reclaimable("v1", 0)
	if err == nil {
		t.Fatal("an unexpected file in the chunk store did not stop the walk")
	}
	if rec.Complete {
		t.Fatalf("the walk stopped and the report says it finished: %+v", rec)
	}
}
