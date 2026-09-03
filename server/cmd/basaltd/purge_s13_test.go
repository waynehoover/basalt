package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/basalt-sync/server/internal/store"
)

// emptyDataDir is a real data directory the server would accept, with the
// database created but no vault claimed yet, which is what a store looks like
// after a connect that never pushed.
func emptyDataDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "basalt.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return dir
}

// S13: purge refuses a vault it does not hold, before deleting anything, and
// names the vaults that are there.

// A typo used to purge a vault that was not there, delete nothing, verify the
// other vaults, and report "0 -> 0" as a success. Now it refuses and lists the
// real names.
func TestS13PurgeRefusesAMisspeltVaultAndListsTheRealOnes(t *testing.T) {
	dir := seeded(t) // holds vault "default"

	out, err := basalt(t, "purge", "-data", dir, "-vault", "defualt", "-confirm", "defualt", "-no-backup-check")
	if err == nil {
		t.Fatalf("purge of a misspelt vault succeeded:\n%s", out)
	}
	if !strings.Contains(err.Error(), "defualt") || !strings.Contains(err.Error(), "default") {
		t.Fatalf("the refusal does not name the typo and the real vault: %v", err)
	}
	// It refused rather than running: no report line was printed.
	if strings.Contains(out, "versions") {
		t.Fatalf("purge printed a report for a vault it should have refused:\n%s", out)
	}
}

// An empty store says so plainly rather than offering an empty list.
func TestS13PurgeOfAVaultInAnEmptyStoreSaysThereAreNone(t *testing.T) {
	dir := emptyDataDir(t)
	_, err := basalt(t, "purge", "-data", dir, "-vault", "whatever", "-confirm", "whatever", "-no-backup-check")
	if err == nil {
		t.Fatal("purge of a vault in an empty store succeeded")
	}
	if !strings.Contains(err.Error(), "no vaults at all") {
		t.Fatalf("err = %v, want it to say the store is empty", err)
	}
}
