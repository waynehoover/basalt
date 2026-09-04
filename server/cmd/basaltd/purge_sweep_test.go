package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* ---------------------------------------------------------------- *
 * a purge whose sweep did not finish reports no chunk figures
 * ---------------------------------------------------------------- */

// filepath.WalkDir stops at the first error, so a stray file in the chunk
// store aborts the sweep. The whole report was printed anyway, before the
// error was returned: with the stray in a shard that sorts first, the line
// read "chunks 5 live, 0 deleted (0 B reclaimed), 0 spared as too recent to
// collect (0 B)" while every collectible orphan in the tree sat unexamined,
// and it was followed by advice to re-run with -grace 0, which aborts at the
// same file. Rule 7: a status describes the vault, not how far the walk got.
func TestPurgeDoesNotPrintAReportTheSweepDidNotFinish(t *testing.T) {
	dir := seeded(t)
	stray := filepath.Join(dir, "chunks", chunkVaultDir(t, dir), "00", "notes-backup.md")
	if err := os.MkdirAll(filepath.Dir(stray), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(stray, []byte("somebody put this here"), 0o600); err != nil {
		t.Fatalf("write stray: %v", err)
	}

	out, err := basalt(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	if err == nil {
		t.Fatalf("purge reported success over a chunk store it could not walk:\n%s", out)
	}
	if !strings.Contains(err.Error(), "unexpected file in chunk store") {
		t.Fatalf("the error does not name the stray file: %v", err)
	}

	// The versions did commit, in a transaction that ran before the sweep, so
	// that line stays: it is what went, and swallowing it would hide it.
	if !strings.Contains(out, "versions 6 -> 4 (removed 2)") {
		t.Fatalf("purge does not say what it removed:\n%s", out)
	}
	// Nothing that came from the walk.
	for _, wrong := range []string{"chunks 5 live", "spared as too recent", "-grace 0", "reclaimed"} {
		if strings.Contains(out, wrong) {
			t.Fatalf("purge printed %q from a sweep that did not finish:\n%s", wrong, out)
		}
	}
	if !strings.Contains(out, "the chunk sweep stopped before it reached the end of the store") {
		t.Fatalf("purge does not say the sweep stopped:\n%s", out)
	}
}

// The debris a sweep walks past and no grace collects. Both were invisible: a
// `.tmp-` file was skipped in silence, and a quarantined body had a count with
// no bytes beside it. Both are space this purge did not reclaim, which is the
// figure somebody purging for space came for.
func TestPurgeSaysWhatItWalkedPastAndCannotReclaim(t *testing.T) {
	dir := seeded(t)
	shard := filepath.Join(dir, "chunks", chunkVaultDir(t, dir), "ab")
	if err := os.MkdirAll(shard, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(shard, ".tmp-halfwritten"), []byte("1234567"), 0o600); err != nil {
		t.Fatalf("write temp: %v", err)
	}

	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	if !strings.Contains(out, "1 unfinished uploads (7 B)") {
		t.Fatalf("purge does not say what the temp debris costs:\n%s", out)
	}
	if !strings.Contains(out, "no grace collects these") {
		t.Fatalf("purge does not say nothing will ever collect it:\n%s", out)
	}
}

// chunkVaultDir is the directory name the chunk store gives one vault. It is
// derived rather than assumed, because this test writes into that tree and a
// test that wrote into the wrong directory would pass by proving nothing.
func chunkVaultDir(t *testing.T, dir string) string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("reading the chunk store: %v", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			return e.Name()
		}
	}
	t.Fatalf("the chunk store holds no vault directory")
	return ""
}
