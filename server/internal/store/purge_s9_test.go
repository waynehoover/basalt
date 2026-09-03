package store

import (
	"errors"
	"testing"
)

// S9: a query that fails after the purge's DELETE must leave the history
// standing, because a rolled-back delete can be retried and a committed one
// that then fails its own checks cannot.
//
// The DELETE used to run in autocommit, so by the time a later count or the
// live-set query failed the versions were already gone and the error was a
// report of loss rather than a refusal. Now the delete and its checks are one
// transaction, and a failure in any of them rolls the delete back.
func TestS9AFailedCheckAfterTheDeleteRollsThePurgeBack(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "one")
	h.file(t, "note.md", "two")
	h.file(t, "note.md", "three")
	h.file(t, "other.md", "only")

	before := versionCount(t, h, "v1")
	if before != 4 {
		t.Fatalf("seeded %d versions, want 4", before)
	}

	// Any post-delete step failing, stood in for by the hook.
	boom := errors.New("injected failure after the delete")
	h.afterPurgeDelete = func() error { return boom }

	if _, err := h.Purge("v1", 0); !errors.Is(err, boom) {
		t.Fatalf("purge err = %v, want the injected failure", err)
	}

	// The history is all still there: the delete was rolled back, not committed
	// and then regretted.
	if after := versionCount(t, h, "v1"); after != before {
		t.Fatalf("%d versions after a failed purge, want %d: the delete was not rolled back",
			after, before)
	}

	// And a real purge still works once the fault is gone, so the rollback left
	// the database usable rather than wedged.
	h.afterPurgeDelete = nil
	rep, err := h.Purge("v1", 0)
	if err != nil {
		t.Fatalf("purge after the fault cleared: %v", err)
	}
	if rep.VersionsAfter != 2 {
		t.Fatalf("purge kept %d versions, want 2 (one per path)", rep.VersionsAfter)
	}
}

func versionCount(t *testing.T, h *harness, vaultID string) int64 {
	t.Helper()
	var n int64
	if err := h.db.QueryRow(`SELECT COUNT(*) FROM entries WHERE vault_id = ?`, vaultID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// The rolled-back purge also has to report nothing removed. VersionsRemoved is
// set from RowsAffected inside the transaction, and the purge CLI prints the
// report before it checks the error, on purpose: a sweep that fails after the
// commit has still done real work and rule 8 says print the numbers. So a
// report from a rolled-back transaction printed rows as removed that are still
// in the database, which is the one number a destructive command must not get
// wrong.
func TestS9ARolledBackPurgeReportsNothingRemoved(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "one")
	h.file(t, "note.md", "two")
	h.file(t, "other.md", "only")

	boom := errors.New("injected failure after the delete")
	h.afterPurgeDelete = func() error { return boom }

	rep, err := h.Purge("v1", 0)
	if !errors.Is(err, boom) {
		t.Fatalf("purge err = %v, want the injected failure", err)
	}
	if rep.VersionsRemoved != 0 {
		t.Fatalf("a rolled-back purge reported %d versions removed; they are all still there",
			rep.VersionsRemoved)
	}
	if rep != (PurgeReport{}) {
		t.Fatalf("a rolled-back purge reported %+v, want every count zero", rep)
	}
	if after := versionCount(t, h, "v1"); after != 3 {
		t.Fatalf("%d versions after a failed purge, want 3", after)
	}
}
