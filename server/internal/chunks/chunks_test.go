package chunks

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "chunks"), ChunkMaxForTest)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	return s
}

// ChunkMaxForTest is small enough that the size ceiling can be exercised
// without allocating a megabyte.
const ChunkMaxForTest = 1024

func TestValidNameAcceptsOnlyLowercaseHexSHA256(t *testing.T) {
	good := Name([]byte("hello"))
	if len(good) != NameLen {
		t.Fatalf("Name returned %d chars, want %d", len(good), NameLen)
	}
	if !ValidName(good) {
		t.Fatalf("ValidName rejected %q", good)
	}

	bad := map[string]string{
		"empty":        "",
		"too short":    good[:NameLen-1],
		"too long":     good + "0",
		"uppercase":    strings.ToUpper(good),
		"non-hex":      strings.Repeat("g", NameLen),
		"traversal":    strings.Repeat("../", NameLen/3),
		"path segment": good[:NameLen-2] + "/x",
	}
	for why, n := range bad {
		if ValidName(n) {
			t.Errorf("ValidName accepted %s: %q", why, n)
		}
	}
}

// Uppercase and lowercase spellings of one hash would be two files on disk and
// a dedup miss. That presents as unexplained upload volume, not as an error, so
// the wire format has exactly one spelling and the store enforces it.
func TestUppercaseNameIsRejectedRatherThanNormalised(t *testing.T) {
	s := newTestStore(t)
	body := []byte("note")
	up := strings.ToUpper(Name(body))

	if err := s.Put("v1", up, body); !errors.Is(err, ErrBadName) {
		t.Fatalf("Put with uppercase name: err = %v, want ErrBadName", err)
	}
	if s.Has("v1", up) {
		t.Fatal("Has accepted an uppercase name")
	}
}

func TestPutGetRoundTrip(t *testing.T) {
	s := newTestStore(t)
	body := []byte("encrypted bytes")
	name := Name(body)

	if s.Has("v1", name) {
		t.Fatal("Has true before Put")
	}
	if err := s.Put("v1", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}
	if !s.Has("v1", name) {
		t.Fatal("Has false after Put")
	}
	got, err := s.Get("v1", name)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if string(got) != string(body) {
		t.Fatalf("got %q, want %q", got, body)
	}
}

// A body that does not hash to its claimed name is either a client bug or a
// corrupted upload. Storing it under the claimed name corrupts the vault
// silently; storing it under the computed name leaves the entry pointing at
// nothing. Neither happens.
func TestPutRefusesBodyThatDoesNotMatchItsName(t *testing.T) {
	s := newTestStore(t)
	claimed := Name([]byte("what the client said"))
	actual := []byte("what the client sent")

	err := s.Put("v1", claimed, actual)
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("err = %v, want ErrCorrupt", err)
	}
	if s.Has("v1", claimed) {
		t.Fatal("chunk stored under the claimed name")
	}
	if s.Has("v1", Name(actual)) {
		t.Fatal("chunk stored under the computed name")
	}
	assertNoTempFiles(t, s, "v1")
}

func TestPutRefusesOversizedBody(t *testing.T) {
	s := newTestStore(t)
	body := make([]byte, ChunkMaxForTest+1)
	name := Name(body)

	if err := s.Put("v1", name, body); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if s.Has("v1", name) {
		t.Fatal("oversized chunk was stored")
	}
}

func TestPutIsIdempotentAndLeavesNoTempFiles(t *testing.T) {
	s := newTestStore(t)
	body := []byte("same bytes twice")
	name := Name(body)

	for i := 0; i < 3; i++ {
		if err := s.Put("v1", name, body); err != nil {
			t.Fatalf("put %d: %v", i, err)
		}
	}
	if got, err := s.Get("v1", name); err != nil || string(got) != string(body) {
		t.Fatalf("get after repeat put: %q, %v", got, err)
	}
	assertNoTempFiles(t, s, "v1")
}

// Bit rot, a truncated restore, or anything else that changes a body under the
// server's feet must surface as an error naming the chunk, not as bytes the
// client cannot decrypt for reasons it has no way to diagnose.
func TestGetDetectsCorruptionOnDisk(t *testing.T) {
	s := newTestStore(t)
	body := []byte("original ciphertext")
	name := Name(body)
	if err := s.Put("v1", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}

	p, err := s.Path("v1", name)
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.WriteFile(p, []byte("tampered ciphertext"), 0o600); err != nil {
		t.Fatalf("tamper: %v", err)
	}

	got, err := s.Get("v1", name)
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("err = %v, want ErrCorrupt", err)
	}
	if got != nil {
		t.Fatalf("corrupt body returned to caller: %q", got)
	}
	if err := s.Check("v1", name); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Check err = %v, want ErrCorrupt", err)
	}
}

func TestGetDistinguishesAbsentFromCorrupt(t *testing.T) {
	s := newTestStore(t)
	name := Name([]byte("never uploaded"))

	_, err := s.Get("v1", name)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if errors.Is(err, ErrCorrupt) {
		t.Fatal("absent reported as corrupt")
	}
}

// A vault must not be able to read or overwrite another vault's content by
// naming its chunk. Each vault encrypts with its own key, so cross-vault dedup
// buys nothing and this costs nothing.
func TestChunksAreNamespacedPerVault(t *testing.T) {
	s := newTestStore(t)
	body := []byte("vault A content")
	name := Name(body)
	if err := s.Put("A", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}

	if s.Has("B", name) {
		t.Fatal("vault B sees vault A's chunk")
	}
	if _, err := s.Get("B", name); !errors.Is(err, ErrNotFound) {
		t.Fatalf("vault B Get: err = %v, want ErrNotFound", err)
	}
	missing, _, err := s.Missing("B", []string{name})
	if err != nil {
		t.Fatalf("missing: %v", err)
	}
	if len(missing) != 1 {
		t.Fatalf("vault B wants %d chunks, want 1", len(missing))
	}
}

func TestMissingPreservesOrderAndDeduplicates(t *testing.T) {
	s := newTestStore(t)
	a, b, c := []byte("a"), []byte("b"), []byte("c")
	na, nb, nc := Name(a), Name(b), Name(c)
	if err := s.Put("v1", nb, b); err != nil {
		t.Fatalf("put: %v", err)
	}

	// nb is held; na and nc are not. The repeat of na must not produce two
	// requests for the same body.
	got, sizes, err := s.Missing("v1", []string{na, nb, nc, na})
	if err != nil {
		t.Fatalf("missing: %v", err)
	}
	want := []string{na, nc}
	if len(got) != len(want) {
		t.Fatalf("got %d names, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("position %d: got %s, want %s", i, got[i], want[i])
		}
	}

	// The sizes come from the same stat that decided presence, so a caller
	// totalling held bytes does not have to stat them all over again.
	if len(sizes) != 1 {
		t.Fatalf("sizes covers %d chunks, want 1 (the held one)", len(sizes))
	}
	if _, ok := sizes[nb]; !ok {
		t.Fatalf("the held chunk has no size")
	}
	for _, n := range []string{na, nc} {
		if _, ok := sizes[n]; ok {
			t.Fatalf("a missing chunk was given a size")
		}
	}
}

// A malformed name must not simply be dropped from the want list. Dropping it
// makes the list shorter, the client uploads nothing for it, and the entry then
// references a chunk that can never arrive.
func TestMissingRefusesToShrinkOnABadName(t *testing.T) {
	s := newTestStore(t)
	good := Name([]byte("fine"))

	got, _, err := s.Missing("v1", []string{good, "not-a-hash"})
	if !errors.Is(err, ErrBadName) {
		t.Fatalf("err = %v, want ErrBadName", err)
	}
	if got != nil {
		t.Fatalf("returned a partial list alongside the error: %v", got)
	}
}

func TestSweepDeletesUnreferencedAndKeepsLive(t *testing.T) {
	s := newTestStore(t)
	keep, drop := []byte("still referenced"), []byte("orphaned")
	nk, nd := Name(keep), Name(drop)
	for _, pair := range [][2]any{{nk, keep}, {nd, drop}} {
		if err := s.Put("v1", pair[0].(string), pair[1].([]byte)); err != nil {
			t.Fatalf("put: %v", err)
		}
	}

	deleted, spared, err := s.Sweep("v1", map[string]struct{}{nk: {}}, time.Now())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if deleted != 1 || spared != 0 {
		t.Fatalf("deleted %d, spared %d; want 1 and 0", deleted, spared)
	}
	if !s.Has("v1", nk) {
		t.Fatal("sweep deleted a live chunk")
	}
	if s.Has("v1", nd) {
		t.Fatal("sweep kept an orphan")
	}
}

// An in-progress Put is a temp file. Deleting it pulls the body out from under a
// live upload, which the entry commit would then reject; the upload is wasted
// and the client retries for no reason.
func TestSweepLeavesInProgressWritesAlone(t *testing.T) {
	s := newTestStore(t)
	dir := filepath.Join(s.VaultDir("v1"), "ab")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	tmp := filepath.Join(dir, tmpPrefix+"inflight")
	if err := os.WriteFile(tmp, []byte("half written"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, _, err := s.Sweep("v1", nil, time.Now()); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if _, err := os.Stat(tmp); err != nil {
		t.Fatalf("sweep removed an in-progress write: %v", err)
	}
}

// An unexplained file in the chunk tree is evidence of something this package
// did not do. Deleting it destroys the evidence; reporting it does not.
func TestSweepRefusesToDeleteAFileItDidNotWrite(t *testing.T) {
	s := newTestStore(t)
	dir := filepath.Join(s.VaultDir("v1"), "cd")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	stray := filepath.Join(dir, "notes-backup.md")
	if err := os.WriteFile(stray, []byte("someone put this here"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, _, err := s.Sweep("v1", nil, time.Now()); err == nil {
		t.Fatal("sweep reported success over a file it did not recognise")
	}
	if _, err := os.Stat(stray); err != nil {
		t.Fatalf("sweep deleted the unrecognised file: %v", err)
	}
}

func TestSweepOfAnUntouchedVaultIsNotAnError(t *testing.T) {
	s := newTestStore(t)
	deleted, _, err := s.Sweep("never-used", map[string]struct{}{}, time.Now())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if deleted != 0 {
		t.Fatalf("deleted %d from an empty vault", deleted)
	}
}

func TestNewRefusesANonPositiveMax(t *testing.T) {
	for _, max := range []int64{0, -1} {
		if _, err := New(filepath.Join(t.TempDir(), "c"), max); err == nil {
			t.Fatalf("New accepted max %d", max)
		}
	}
}

func assertNoTempFiles(t *testing.T, s *Store, vaultID string) {
	t.Helper()
	root := s.VaultDir(vaultID)
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return
	}
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if strings.HasPrefix(d.Name(), tmpPrefix) {
			t.Errorf("temp file left behind: %s", p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// The grace window is what stops the sweep from collecting bodies a push has
// uploaded but not yet committed. Without it a purge running alongside pushes
// starves them: see DefaultGrace.
func TestSweepSparesRecentlyWrittenChunks(t *testing.T) {
	s := newTestStore(t)
	body := []byte("uploaded a moment ago, not yet referenced")
	name := Name(body)
	if err := s.Put("v1", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}

	deleted, spared, err := s.Sweep("v1", nil, time.Now().Add(-DefaultGrace))
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if deleted != 0 || spared != 1 {
		t.Fatalf("deleted %d, spared %d; want 0 and 1", deleted, spared)
	}
	if !s.Has("v1", name) {
		t.Fatal("sweep deleted a body an in-flight push may still reference")
	}
}

// The window is a delay, not a reprieve. Debris from a crashed push must be
// collected once it is older than the window, or the store grows forever.
func TestSweepCollectsChunksOlderThanTheGraceWindow(t *testing.T) {
	s := newTestStore(t)
	body := []byte("orphaned by a push that died")
	name := Name(body)
	if err := s.Put("v1", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}
	p, err := s.Path("v1", name)
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	old := time.Now().Add(-2 * DefaultGrace)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	deleted, spared, err := s.Sweep("v1", nil, time.Now().Add(-DefaultGrace))
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if deleted != 1 || spared != 0 {
		t.Fatalf("deleted %d, spared %d; want 1 and 0", deleted, spared)
	}
}

// A referenced chunk is kept whatever its age. The grace window only ever adds
// protection; it must never be the thing that decides a live body's fate.
func TestSweepKeepsAnOldChunkThatIsStillReferenced(t *testing.T) {
	s := newTestStore(t)
	body := []byte("old but still in use")
	name := Name(body)
	if err := s.Put("v1", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}
	p, _ := s.Path("v1", name)
	old := time.Now().Add(-100 * DefaultGrace)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	deleted, spared, err := s.Sweep("v1", map[string]struct{}{name: {}}, time.Now())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if deleted != 0 || spared != 0 {
		t.Fatalf("deleted %d, spared %d; want 0 and 0 (kept as live, not as spared)", deleted, spared)
	}
	if !s.Has("v1", name) {
		t.Fatal("sweep deleted a referenced chunk")
	}
}

// ChunksSpared means "unreferenced but too young to collect", not merely
// "young". A live chunk is kept because it is live, and the two reasons must not
// be conflated: a counter that reports every recent chunk as spared makes it
// impossible to tell a working grace window from a sweep that is collecting
// nothing.
func TestSweepCountsALiveRecentChunkAsLiveNotSpared(t *testing.T) {
	s := newTestStore(t)
	body := []byte("written a moment ago and already referenced")
	name := Name(body)
	if err := s.Put("v1", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}

	deleted, spared, err := s.Sweep("v1", map[string]struct{}{name: {}}, time.Now().Add(-DefaultGrace))
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if deleted != 0 || spared != 0 {
		t.Fatalf("deleted %d, spared %d; want 0 and 0", deleted, spared)
	}
}

// Size and Has must agree, and neither may treat a directory as a chunk. Has is
// defined in terms of Size, so the risk is that Size loosens what counts.
func TestSizeAndHasAgree(t *testing.T) {
	s := newTestStore(t)
	body := []byte("some ciphertext")
	name := Name(body)

	if size, ok := s.Size("v1", name); ok || size != 0 {
		t.Fatalf("Size reported %d, %v before the chunk existed", size, ok)
	}
	if err := s.Put("v1", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}
	size, ok := s.Size("v1", name)
	if !ok || size != int64(len(body)) {
		t.Fatalf("Size = %d, %v; want %d, true", size, ok, len(body))
	}
	if !s.Has("v1", name) {
		t.Fatal("Has disagrees with Size")
	}

	// A directory where a chunk should be is not a chunk. Without the regular
	// file check its size would be reported as a body's.
	other := Name([]byte("never uploaded"))
	p, err := s.Path("v1", other)
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.MkdirAll(p, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if size, ok := s.Size("v1", other); ok {
		t.Fatalf("a directory was reported as a chunk of %d bytes", size)
	}
	if s.Has("v1", other) {
		t.Fatal("Has accepted a directory")
	}
}
