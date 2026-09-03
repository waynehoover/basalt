package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// S26: a destination that is refused for overlapping the live store is refused
// before it is created, so the refusal leaves no directory in the chunk tree.
func TestS26ARefusedDestinationIsNotCreated(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")

	inChunks := filepath.Join(h.dir, chunkDirName, "backup")
	if _, err := h.Backup(inChunks, false); err == nil {
		t.Fatal("a destination inside the chunk tree was accepted")
	}
	if _, err := os.Stat(inChunks); !os.IsNotExist(err) {
		t.Fatalf("the refused destination exists in the chunk tree (stat: %v)", err)
	}
	// Nor anywhere else that was refused.
	if _, err := h.Backup(h.dir, false); err == nil {
		t.Fatal("the data directory itself was accepted")
	}
	// A sweep afterwards finds nothing it did not put there.
	if _, _, _, err := h.Chunks().Sweep("v1", map[string]struct{}{}, time0()); err != nil {
		t.Fatalf("the chunk tree has something in it the sweep does not recognise: %v", err)
	}
}

// time0 is a zero cutoff: nothing is spared, which is fine for a sweep that
// exists only to walk the tree.
func time0() time.Time { return time.Time{} }
