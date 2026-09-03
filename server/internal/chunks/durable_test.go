package chunks

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// S17 and S25: the two ways a body could be on disk and not be durable, or be
// present and not be the body.

// recordingSyncs replaces the store's directory fsync with one that records
// what was flushed, and still flushes it.
func recordingSyncs(s *Store) *[]string {
	var flushed []string
	s.sync = func(dir string) error {
		flushed = append(flushed, dir)
		return syncDir(dir)
	}
	return &flushed
}

func sorted(in []string) []string {
	out := append([]string{}, in...)
	sort.Strings(out)
	return out
}

// The first chunk of a vault creates <root>/<vault>/<ab>/. Flushing <ab>/
// alone makes the body's name durable inside directories whose own names are
// not; each newly created level's parent is flushed too, up to the store root.
func TestS17TheFirstChunkFlushesEveryDirectoryItCreated(t *testing.T) {
	s := newTestStore(t)
	flushed := recordingSyncs(s)

	body := []byte("the very first body in this vault")
	name := Name(body)
	if err := s.Put("v1", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}
	leaf := filepath.Dir(s.path("v1", name))
	vault := filepath.Dir(leaf)
	want := sorted([]string{s.dir, vault, leaf})
	if got := sorted(*flushed); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("flushed %v\nwant    %v", got, want)
	}

	// A second chunk in the same fan-out directory creates nothing, so only
	// the leaf is flushed.
	*flushed = nil
	body2 := []byte("a second body")
	if Name(body2)[:2] == name[:2] {
		t.Skip("the two test bodies happen to share a fan-out directory")
	}
	// Force it into the same leaf by choosing a body until one lands there.
	for i := 0; Name(body2)[:2] != name[:2]; i++ {
		body2 = []byte("candidate " + strings.Repeat("x", i))
	}
	if err := s.Put("v1", Name(body2), body2); err != nil {
		t.Fatalf("put: %v", err)
	}
	if got := *flushed; len(got) != 1 || got[0] != leaf {
		t.Fatalf("a chunk into an existing directory flushed %v, want only %s", got, leaf)
	}
}

// The batch writer gathers the same directories and flushes them at Close.
func TestS17ABatchFlushesTheDirectoriesItCreated(t *testing.T) {
	s := newTestStore(t)
	flushed := recordingSyncs(s)
	w := s.NewWriter("v1")
	body := []byte("first body through the batch writer")
	if err := w.Add(Name(body), body); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	leaf := filepath.Dir(s.path("v1", Name(body)))
	want := sorted([]string{s.dir, filepath.Dir(leaf), leaf})
	if got := sorted(*flushed); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("flushed %v\nwant    %v", got, want)
	}
}

// A write that stops short and says nothing must not leave a body under the
// name: a present body of the wrong length is one every client is told the
// server holds, for ever.
func TestS25AShortWriteIsRefusedAndStoresNothing(t *testing.T) {
	s := newTestStore(t)
	s.write = func(f *os.File, body []byte) error {
		_, err := f.Write(body[:len(body)/2])
		return err // nil: the short write reported success
	}
	body := []byte("a body of some length that will be cut in half")
	name := Name(body)
	err := s.Put("v1", name, body)
	if err == nil {
		t.Fatal("a short write was stored as a body")
	}
	if !strings.Contains(err.Error(), "of") {
		t.Fatalf("the error does not say how much was written: %v", err)
	}
	if s.Has("v1", name) {
		t.Fatal("the truncated body is present under the chunk's name")
	}
	entries, _ := os.ReadDir(s.VaultDir("v1"))
	for _, e := range entries {
		sub, _ := os.ReadDir(filepath.Join(s.VaultDir("v1"), e.Name()))
		for _, f := range sub {
			if strings.HasPrefix(f.Name(), tmpPrefix) {
				t.Fatalf("a temp file was left behind: %s", f.Name())
			}
		}
	}
	// Through the batch writer too.
	w := s.NewWriter("v1")
	_ = w.Add(name, body)
	if err := w.Close(); err == nil {
		t.Fatal("the batch writer stored a short write")
	}
	if s.Has("v1", name) {
		t.Fatal("the batch writer left the truncated body under the chunk's name")
	}
	// And a real disk error is still reported as itself.
	s.write = func(*os.File, []byte) error { return errors.New("disk on fire") }
	if err := s.Put("v1", name, body); err == nil || !strings.Contains(err.Error(), "fire") {
		t.Fatalf("err = %v", err)
	}
}

// Two sessions storing the first chunk of one vault at the same time: the one
// that loses the Mkdir race must not report its body stored before the
// directory holding it has a durable name.
//
// The loser used to get ErrExist, take that as "whoever created it is flushing
// it", flush only its leaf and return. The winner's flush of <vault>/ had not
// necessarily happened, so a crash in between lost both bodies with one of them
// already acknowledged to a client that will never send it again (rule 1).
func TestS17AConcurrentFirstChunkWaitsForTheDirectoryToBeDurable(t *testing.T) {
	s := newTestStore(t)

	first := []byte("the body that wins the race")
	second := []byte("the body that loses it")
	// Both into the same fan-out directory, so they race on the same Mkdir.
	for Name(second)[:2] != Name(first)[:2] {
		second = append(second, 'x')
	}
	vaultDir := s.VaultDir("v1")

	var vaultFlushed atomic.Bool
	rootFlushed := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	s.sync = func(dir string) error {
		if dir == s.dir {
			// The store root is flushed first, which is after both directories
			// have been created: the moment the loser can see them.
			once.Do(func() { close(rootFlushed) })
			return syncDir(dir)
		}
		if dir == vaultDir {
			// A slow fsync, which is what an fsync is.
			<-release
			err := syncDir(dir)
			vaultFlushed.Store(true)
			return err
		}
		return syncDir(dir)
	}

	winner := make(chan error, 1)
	go func() { winner <- s.Put("v1", Name(first), first) }()
	<-rootFlushed

	// What the loser saw when it returned: was the directory its body is named
	// in durable yet?
	loser := make(chan bool, 1)
	go func() {
		if err := s.Put("v1", Name(second), second); err != nil {
			t.Errorf("put by the second writer: %v", err)
		}
		loser <- vaultFlushed.Load()
	}()

	early := false
	select {
	case durable := <-loser:
		// It got all the way through while the winner is still inside the
		// fsync. Only acceptable if the directory was already durable.
		early = !durable
	case <-time.After(500 * time.Millisecond):
		// Still waiting, which is the point.
	}
	close(release)

	if err := <-winner; err != nil {
		t.Fatalf("put by the first writer: %v", err)
	}
	if early {
		t.Fatal("the second body was reported stored while the directory holding its name was still unflushed")
	}
	if durable := <-loser; !durable {
		t.Fatal("the second writer returned before the directory holding its name was flushed")
	}
	for _, b := range [][]byte{first, second} {
		if !s.Has("v1", Name(b)) {
			t.Fatalf("body %q is not stored", b)
		}
	}
}
