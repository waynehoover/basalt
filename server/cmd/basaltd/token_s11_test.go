package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// S11: the token file is written atomically, durably, at 0600, and verified.

// A fresh write lands as exactly the content given, at 0600, with no temporary
// file left beside it.
func TestS11WriteTokenFileIsExactAndPrivate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, tokenFileName)
	if err := writeTokenFile(path, "the-token\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "the-token\n" {
		t.Fatalf("content is %q", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mode is %o, want 600", perm)
	}
	assertNoTokenDebris(t, dir)
}

// Overwriting a token that an older build, or a careless copy, left at 0644
// tightens it to 0600. os.WriteFile leaves an existing file's mode alone, which
// is the hole this closes.
func TestS11OverwritingA0644TokenTightensItTo0600(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, tokenFileName)
	if err := os.WriteFile(path, []byte("old permissive\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := writeTokenFile(path, "new-token\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mode is %o after overwriting a 0644 token, want 600", perm)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "new-token\n" {
		t.Fatalf("content is %q", got)
	}
}

// copyToken puts the auth token in a backup through the same durable, private
// path, so a backup token left 0644 by a previous copy is tightened too.
func TestS11CopyTokenIntoABackupIsPrivate(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, tokenFileName), []byte("secret\n"), 0o600); err != nil {
		t.Fatalf("seed source: %v", err)
	}
	destDir := t.TempDir()
	// A stale backup token left world-readable by an earlier copy.
	if err := os.WriteFile(filepath.Join(destDir, tokenFileName), []byte("stale\n"), 0o644); err != nil {
		t.Fatalf("seed dest: %v", err)
	}

	copied, err := copyToken(dataDir, destDir)
	if err != nil || !copied {
		t.Fatalf("copyToken: copied=%v err=%v", copied, err)
	}
	info, err := os.Stat(filepath.Join(destDir, tokenFileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("the backup token is %o, want 600", perm)
	}
	got, _ := os.ReadFile(filepath.Join(destDir, tokenFileName))
	if string(got) != "secret\n" {
		t.Fatalf("the backup token is %q, want the source's", got)
	}
	assertNoTokenDebris(t, destDir)
}

// assertNoTokenDebris fails if a temporary token file was left in dir, which is
// what an atomic write must not do once it has finished.
func assertNoTokenDebris(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".auth-token.") {
			t.Fatalf("a temporary token file was left behind: %s", e.Name())
		}
	}
}
