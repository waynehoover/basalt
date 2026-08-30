package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
)

type harness struct {
	*Store
	dir string
}

func newTestStore(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	h := openAt(t, dir)
	if err := h.EnsureVault("v1", 1000); err != nil {
		t.Fatalf("ensure vault: %v", err)
	}
	return h
}

func openAt(t *testing.T, dir string) *harness {
	t.Helper()
	s, err := Open(filepath.Join(dir, "basalt.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return &harness{Store: s, dir: dir}
}

// put uploads bodies and returns their names, in order. This is what a client
// does before a put's entry is committed.
func (h *harness) put(t *testing.T, vaultID string, bodies ...string) []string {
	t.Helper()
	names := make([]string, 0, len(bodies))
	for _, b := range bodies {
		n := chunks.Name([]byte(b))
		if err := h.Chunks().Put(vaultID, n, []byte(b)); err != nil {
			t.Fatalf("put chunk: %v", err)
		}
		names = append(names, n)
	}
	return names
}

// file uploads the bodies and commits an entry referencing them.
func (h *harness) file(t *testing.T, path string, bodies ...string) Entry {
	t.Helper()
	e, err := h.write(path, bodies...)
	if err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return e
}

// push is file for use inside a goroutine, where t.Fatalf is not allowed.
func (h *harness) push(path string, bodies ...string) error {
	_, err := h.write(path, bodies...)
	return err
}

// write is the whole push sequence in the order the protocol requires: every
// body durable first, then the entry.
func (h *harness) write(path string, bodies ...string) (Entry, error) {
	names := make([]string, 0, len(bodies))
	size := 0
	for _, b := range bodies {
		n := chunks.Name([]byte(b))
		if err := h.Chunks().Put("v1", n, []byte(b)); err != nil {
			return Entry{}, fmt.Errorf("put chunk: %w", err)
		}
		names = append(names, n)
		size += len(b)
	}
	e := Entry{Path: path, Size: int64(size), MTime: 42, Device: "d1", Chunks: names}
	uid, err := h.AppendEntry("v1", e)
	if err != nil {
		return Entry{}, err
	}
	e.UID = uid
	return e, nil
}

/* ---------------------------------------------------------------- *
 * uid allocation: the cursor contract
 * ---------------------------------------------------------------- */

func TestAppendAssignsSequentialUIDs(t *testing.T) {
	h := newTestStore(t)
	for i := 1; i <= 5; i++ {
		e := h.file(t, fmt.Sprintf("f%d.md", i), fmt.Sprintf("body %d", i))
		if e.UID != int64(i) {
			t.Fatalf("uid = %d, want %d", e.UID, i)
		}
	}
}

// uids must be unique and strictly increasing even when several devices push at
// once. A duplicate or a gap makes a client using uid as a resume cursor skip a
// file, silently.
func TestConcurrentAppendsProduceUniqueMonotonicUIDs(t *testing.T) {
	h := newTestStore(t)

	const writers, each = 8, 25
	var wg sync.WaitGroup
	uids := make(chan int64, writers*each)

	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				body := fmt.Sprintf("w%d-%d", w, i)
				name := chunks.Name([]byte(body))
				if err := h.Chunks().Put("v1", name, []byte(body)); err != nil {
					t.Errorf("put chunk: %v", err)
					return
				}
				uid, err := h.AppendEntry("v1", Entry{
					Path: fmt.Sprintf("w%d-%d.md", w, i), Size: int64(len(body)),
					Chunks: []string{name},
				})
				if err != nil {
					t.Errorf("append: %v", err)
					return
				}
				uids <- uid
			}
		}(w)
	}
	wg.Wait()
	close(uids)

	seen := map[int64]bool{}
	var max int64
	for uid := range uids {
		if seen[uid] {
			t.Fatalf("duplicate uid %d", uid)
		}
		seen[uid] = true
		if uid > max {
			max = uid
		}
	}
	if len(seen) != writers*each {
		t.Fatalf("got %d uids, want %d", len(seen), writers*each)
	}
	if max != int64(writers*each) {
		t.Fatalf("highest uid %d, want %d: the sequence has a hole", max, writers*each)
	}
}

func TestAppendToUnknownVaultFails(t *testing.T) {
	h := newTestStore(t)
	names := h.put(t, "ghost", "body")
	_, err := h.AppendEntry("ghost", Entry{Path: "a.md", Size: 4, Chunks: names})
	if !errors.Is(err, ErrUnknownVault) {
		t.Fatalf("err = %v, want ErrUnknownVault", err)
	}
}

/* ---------------------------------------------------------------- *
 * The invariant: committed implies serveable
 * ---------------------------------------------------------------- */

// An entry whose chunks are not on disk must not exist. A dangling reference
// makes the client retry that download forever, which presents as a sync that
// never finishes rather than as an error anyone can see.
func TestAppendRefusesAnEntryWhoseChunksAreAbsent(t *testing.T) {
	h := newTestStore(t)
	present := h.put(t, "v1", "uploaded")
	absent := chunks.Name([]byte("never uploaded"))

	_, err := h.AppendEntry("v1", Entry{
		Path: "a.md", Size: 20, Chunks: []string{present[0], absent},
	})
	if !errors.Is(err, ErrChunkMissing) {
		t.Fatalf("err = %v, want ErrChunkMissing", err)
	}
	if uid, err := h.LatestUID("v1"); err != nil || uid != 0 {
		t.Fatalf("LatestUID = %d (err %v), want 0: a refused entry was committed", uid, err)
	}
	st, err := h.Stats("v1")
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.Versions != 0 {
		t.Fatalf("%d versions after a refused append", st.Versions)
	}
}

// A chunk uploaded to one vault does not satisfy another vault's entry. Without
// this, an entry could name a chunk it has no right to and the server would
// serve another vault's ciphertext.
func TestAppendDoesNotAcceptAnotherVaultsChunk(t *testing.T) {
	h := newTestStore(t)
	if err := h.EnsureVault("v2", 1000); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	names := h.put(t, "v1", "vault one content")

	_, err := h.AppendEntry("v2", Entry{Path: "a.md", Size: 17, Chunks: names})
	if !errors.Is(err, ErrChunkMissing) {
		t.Fatalf("err = %v, want ErrChunkMissing", err)
	}
}

/* ---------------------------------------------------------------- *
 * Validation on the way in
 * ---------------------------------------------------------------- */

func TestValidateRejectsStructurallyBadEntries(t *testing.T) {
	good := chunks.Name([]byte("x"))
	cases := []struct {
		why   string
		entry Entry
	}{
		{"empty path", Entry{Path: "", Size: 1, Chunks: []string{good}}},
		{"oversized path", Entry{Path: string(make([]byte, MaxPathLen+1)), Size: 0}},
		{"prev equals path", Entry{Path: "a.md", Prev: "a.md"}},
		{"folder and deletion at once", Entry{Path: "a", Folder: true, Deleted: true}},
		{"negative size", Entry{Path: "a.md", Size: -1}},
		{"size over the ceiling", Entry{Path: "a.md", Size: PerFileMax + 1}},
		{"chunks on a deletion", Entry{Path: "a.md", Deleted: true, Chunks: []string{good}}},
		{"chunks on a folder", Entry{Path: "a", Folder: true, Chunks: []string{good}}},
		{"size on a deletion", Entry{Path: "a.md", Deleted: true, Size: 10}},
		{"content with no chunks", Entry{Path: "a.md", Size: 10}},
		{"malformed chunk name", Entry{Path: "a.md", Size: 1, Chunks: []string{"nope"}}},
	}
	for _, c := range cases {
		if err := c.entry.Validate(); !errors.Is(err, ErrBadEntry) {
			t.Errorf("%s: err = %v, want ErrBadEntry", c.why, err)
		}
	}
}

// This is the one that matters most in the list above, so it also gets checked
// at the store boundary: an entry with a size and no chunks is indistinguishable
// from an empty file, so a push that lost its chunk list would look like the
// note having been emptied.
func TestAppendRefusesContentWithNoChunks(t *testing.T) {
	h := newTestStore(t)
	_, err := h.AppendEntry("v1", Entry{Path: "a.md", Size: 4096})
	if !errors.Is(err, ErrBadEntry) {
		t.Fatalf("err = %v, want ErrBadEntry", err)
	}
}

// A genuinely empty file is legal and carries no chunks. It must round trip, or
// creating an empty note fails to sync.
func TestZeroByteFileIsAcceptedWithNoChunks(t *testing.T) {
	h := newTestStore(t)
	uid, err := h.AppendEntry("v1", Entry{Path: "empty.md", Size: 0, MTime: 1})
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	got, ok, err := h.EntryByUID("v1", uid)
	if err != nil || !ok {
		t.Fatalf("read back: ok=%v err=%v", ok, err)
	}
	if len(got.Chunks) != 0 || got.Size != 0 {
		t.Fatalf("got size %d with %d chunks, want 0 and 0", got.Size, len(got.Chunks))
	}
}

/* ---------------------------------------------------------------- *
 * Chunk lists
 * ---------------------------------------------------------------- */

func TestChunkListRoundTripsInOrder(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "chunk one", "chunk two", "chunk three")

	got, ok, err := h.EntryByUID("v1", e.UID)
	if err != nil || !ok {
		t.Fatalf("read back: ok=%v err=%v", ok, err)
	}
	if len(got.Chunks) != len(e.Chunks) {
		t.Fatalf("got %d chunks, want %d", len(got.Chunks), len(e.Chunks))
	}
	for i := range e.Chunks {
		if got.Chunks[i] != e.Chunks[i] {
			t.Fatalf("chunk %d: got %s, want %s", i, got.Chunks[i], e.Chunks[i])
		}
	}
}

// Content-defined chunking produces repeats: a file with two identical blocks
// stores one body and references it twice. The reference list must keep both
// positions, or the file reassembles short.
func TestRepeatedChunkKeepsBothPositions(t *testing.T) {
	h := newTestStore(t)
	a := chunks.Name([]byte("AAAA"))
	b := chunks.Name([]byte("BBBB"))
	h.put(t, "v1", "AAAA", "BBBB")

	uid, err := h.AppendEntry("v1", Entry{
		Path: "repeat.md", Size: 12, Chunks: []string{a, b, a},
	})
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	got, _, err := h.EntryByUID("v1", uid)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	want := []string{a, b, a}
	if len(got.Chunks) != 3 {
		t.Fatalf("got %d chunks, want 3: %v", len(got.Chunks), got.Chunks)
	}
	for i := range want {
		if got.Chunks[i] != want[i] {
			t.Fatalf("position %d: got %s, want %s", i, got.Chunks[i], want[i])
		}
	}
}

// Two versions of one note that share a chunk must share one body. That sharing
// is the entire point of content-defined chunking, and it is also what makes the
// purge's live set non-trivial.
func TestChunksAreSharedBetweenVersions(t *testing.T) {
	h := newTestStore(t)
	v1 := h.file(t, "note.md", "unchanged head", "original tail")
	v2 := h.file(t, "note.md", "unchanged head", "edited tail")

	if v1.Chunks[0] != v2.Chunks[0] {
		t.Fatal("identical content produced different chunk names")
	}
	st, err := h.Stats("v1")
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.ChunkRefs != 3 {
		t.Fatalf("ChunkRefs = %d, want 3 (one shared, two distinct)", st.ChunkRefs)
	}
}

// An entry that reaches a client with a size and no chunks is byte-identical to
// an empty file, so a lost chunk list would present as the note having been
// emptied on every device. The store must refuse to hand one out.
//
// The corruption is injected with raw SQL because no code path can produce it;
// that is the point. This asserts what happens when the invariant is broken by
// something outside this package, which is the only way it can break.
func TestReadingAnEntryWhoseChunkRowsVanishedIsAnError(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "content that matters")

	if _, err := h.db.Exec(
		`DELETE FROM entry_chunks WHERE vault_id = 'v1' AND uid = ?`, e.UID); err != nil {
		t.Fatalf("inject: %v", err)
	}

	if _, _, err := h.EntryByUID("v1", e.UID); err == nil {
		t.Fatal("EntryByUID returned an entry with a size and no chunks")
	}
	if _, _, err := h.NextBatch("v1", 0, 10); err == nil {
		t.Fatal("NextBatch delivered an entry with a size and no chunks")
	}
	if _, _, err := h.LatestForPath("v1", "note.md"); err == nil {
		t.Fatal("LatestForPath returned an entry with a size and no chunks")
	}
}

// ord is the order the client reassembles the file in. A gap in it concatenates
// the chunks wrongly, and the result is ciphertext that fails to decrypt for
// reasons the client cannot diagnose.
func TestReadingAnOutOfSequenceChunkListIsAnError(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "first", "second")

	if _, err := h.db.Exec(
		`UPDATE entry_chunks SET ord = 5 WHERE vault_id = 'v1' AND uid = ? AND ord = 1`,
		e.UID); err != nil {
		t.Fatalf("inject: %v", err)
	}

	got, _, err := h.EntryByUID("v1", e.UID)
	if err == nil {
		t.Fatalf("out-of-sequence chunk list was returned as %v", got.Chunks)
	}
}

/* ---------------------------------------------------------------- *
 * Catch-up batching
 * ---------------------------------------------------------------- */

func TestBatchesCoverTheWholeSequenceWithoutGaps(t *testing.T) {
	h := newTestStore(t)
	const total = 25
	for i := 0; i < total; i++ {
		h.file(t, fmt.Sprintf("f%02d.md", i), fmt.Sprintf("body %d", i))
	}

	cursor := int64(0)
	seen := 0
	for batches := 0; ; batches++ {
		if batches > total {
			t.Fatal("NextBatch never reported caught-up")
		}
		b, ok, err := h.NextBatch("v1", cursor, 7)
		if err != nil {
			t.Fatalf("next batch: %v", err)
		}
		if !ok {
			break
		}
		// This is the continuity check a client performs. If it ever fails, the
		// client has silently skipped a file.
		if b.From != cursor+1 {
			t.Fatalf("batch from %d, want %d: gap", b.From, cursor+1)
		}
		if b.To < b.From {
			t.Fatalf("batch range [%d,%d] is empty", b.From, b.To)
		}
		for i, e := range b.Entries {
			if e.UID < b.From || e.UID > b.To {
				t.Fatalf("entry %d uid %d outside range [%d,%d]", i, e.UID, b.From, b.To)
			}
			if i > 0 && e.UID <= b.Entries[i-1].UID {
				t.Fatalf("entries not uid-ascending at %d", i)
			}
			if len(e.Chunks) == 0 {
				t.Fatalf("entry uid %d arrived with no chunks", e.UID)
			}
		}
		seen += len(b.Entries)
		cursor = b.To
	}
	if seen != total {
		t.Fatalf("caught up after %d entries, want %d", seen, total)
	}
	if cursor != total {
		t.Fatalf("final cursor %d, want %d", cursor, total)
	}
}

func TestNextBatchOnAnEmptyVaultReportsCaughtUp(t *testing.T) {
	h := newTestStore(t)
	if _, ok, err := h.NextBatch("v1", 0, 10); err != nil || ok {
		t.Fatalf("ok=%v err=%v, want caught-up on an empty vault", ok, err)
	}
}

// Purge leaves holes in the uid sequence. From/To are a covered range, so a
// client crossing a hole must not read it as a gap and must still end up with a
// cursor at the newest uid.
func TestBatchRangeSpansPurgedHoles(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 5; i++ {
		h.file(t, "note.md", fmt.Sprintf("version %d", i))
	}
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatalf("purge: %v", err)
	}

	b, ok, err := h.NextBatch("v1", 0, 10)
	if err != nil || !ok {
		t.Fatalf("next batch: ok=%v err=%v", ok, err)
	}
	if len(b.Entries) != 1 {
		t.Fatalf("got %d entries after purge, want 1", len(b.Entries))
	}
	if b.From != 1 || b.To != 5 {
		t.Fatalf("range [%d,%d], want [1,5]: the covered range must span the hole", b.From, b.To)
	}
	if _, ok, err := h.NextBatch("v1", b.To, 10); err != nil || ok {
		t.Fatalf("not caught up after applying the batch: ok=%v err=%v", ok, err)
	}
}

/* ---------------------------------------------------------------- *
 * Deletions and renames
 * ---------------------------------------------------------------- */

// A vault whose files were all deleted is not an empty vault. The deletion
// records are what make the files recoverable, and Stats must not collapse the
// two states into one number.
func TestAVaultOfDeletedFilesIsNotAnEmptyVault(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 3; i++ {
		h.file(t, fmt.Sprintf("f%d.md", i), "content")
	}
	for i := 0; i < 3; i++ {
		if _, err := h.AppendEntry("v1", Entry{
			Path: fmt.Sprintf("f%d.md", i), Deleted: true, MTime: 99,
		}); err != nil {
			t.Fatalf("delete: %v", err)
		}
	}

	st, err := h.Stats("v1")
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.Files != 0 {
		t.Fatalf("Files = %d, want 0", st.Files)
	}
	if st.Deleted != 3 {
		t.Fatalf("Deleted = %d, want 3", st.Deleted)
	}
	if st.Versions != 6 {
		t.Fatalf("Versions = %d, want 6: deletions are entries", st.Versions)
	}
	del, _, err := h.Deleted("v1", true, 0)
	if err != nil {
		t.Fatalf("deleted: %v", err)
	}
	if len(del) != 3 {
		t.Fatalf("deleted list has %d entries, want 3", len(del))
	}
}

// A rename is one operation. The deletion it leaves at the old path is not a
// real deletion, and listing it as one makes the recovery list mostly noise.
func TestRenameDeletionIsSuppressedInTheDeletedList(t *testing.T) {
	h := newTestStore(t)
	old := h.file(t, "old.md", "the note")

	if _, err := h.AppendEntry("v1", Entry{Path: "old.md", Deleted: true, MTime: 50}); err != nil {
		t.Fatalf("delete old: %v", err)
	}
	if _, err := h.AppendEntry("v1", Entry{
		Path: "new.md", Prev: "old.md", Size: old.Size, MTime: 50, Chunks: old.Chunks,
	}); err != nil {
		t.Fatalf("append new: %v", err)
	}

	suppressed, _, err := h.Deleted("v1", true, 0)
	if err != nil {
		t.Fatalf("deleted: %v", err)
	}
	if len(suppressed) != 0 {
		t.Fatalf("rename shows as %d deletions: %v", len(suppressed), suppressed[0].Path)
	}
	// Unsuppressed it is still visible, because the record itself is real.
	raw, _, err := h.Deleted("v1", false, 0)
	if err != nil {
		t.Fatalf("deleted: %v", err)
	}
	if len(raw) != 1 {
		t.Fatalf("raw deleted list has %d entries, want 1", len(raw))
	}
}

func TestHistoryForPathIsNewestFirstAndPaginates(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 5; i++ {
		h.file(t, "note.md", fmt.Sprintf("version %d", i))
	}

	page1, err := h.HistoryForPath("v1", "note.md", 0, 2)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(page1) != 2 || page1[0].UID != 5 || page1[1].UID != 4 {
		t.Fatalf("page 1 = %v", uids(page1))
	}
	page2, err := h.HistoryForPath("v1", "note.md", page1[1].UID, 2)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(page2) != 2 || page2[0].UID != 3 || page2[1].UID != 2 {
		t.Fatalf("page 2 = %v", uids(page2))
	}
	for _, e := range append(page1, page2...) {
		if len(e.Chunks) == 0 {
			t.Fatalf("history entry uid %d has no chunks", e.UID)
		}
	}
}

func TestLatestForPathReturnsTheNewestVersion(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "old")
	newest := h.file(t, "note.md", "new")
	h.file(t, "other.md", "unrelated")

	got, ok, err := h.LatestForPath("v1", "note.md")
	if err != nil || !ok {
		t.Fatalf("latest: ok=%v err=%v", ok, err)
	}
	if got.UID != newest.UID {
		t.Fatalf("uid = %d, want %d", got.UID, newest.UID)
	}
	if len(got.Chunks) != 1 || got.Chunks[0] != newest.Chunks[0] {
		t.Fatalf("chunks = %v, want %v", got.Chunks, newest.Chunks)
	}
	if _, ok, err := h.LatestForPath("v1", "absent.md"); err != nil || ok {
		t.Fatalf("absent path: ok=%v err=%v", ok, err)
	}
}

/* ---------------------------------------------------------------- *
 * Purge and the chunk sweep
 * ---------------------------------------------------------------- */

func TestPurgeKeepsTheNewestVersionAndItsChunks(t *testing.T) {
	h := newTestStore(t)
	old := h.file(t, "note.md", "head", "old tail")
	newest := h.file(t, "note.md", "head", "new tail")

	rep, err := h.Purge("v1", 0)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if rep.VersionsBefore != 2 || rep.VersionsRemoved != 1 || rep.VersionsAfter != 1 {
		t.Fatalf("report = %+v", rep)
	}

	if _, ok, err := h.EntryByUID("v1", old.UID); err != nil || ok {
		t.Fatalf("old version survived the purge: ok=%v err=%v", ok, err)
	}
	got, ok, err := h.EntryByUID("v1", newest.UID)
	if err != nil || !ok {
		t.Fatalf("newest version did not survive: ok=%v err=%v", ok, err)
	}
	if len(got.Chunks) != 2 {
		t.Fatalf("surviving entry has %d chunks, want 2", len(got.Chunks))
	}

	// The shared head chunk is still referenced and must survive; the old tail
	// is referenced by nothing and must go.
	if !h.Chunks().Has("v1", newest.Chunks[0]) {
		t.Fatal("purge deleted a chunk the surviving entry references")
	}
	if !h.Chunks().Has("v1", newest.Chunks[1]) {
		t.Fatal("purge deleted the newest version's own chunk")
	}
	if h.Chunks().Has("v1", old.Chunks[1]) {
		t.Fatal("purge kept an orphaned chunk")
	}
	if rep.ChunksDeleted != 1 {
		t.Fatalf("ChunksDeleted = %d, want 1", rep.ChunksDeleted)
	}
	if rep.ChunksLive != 2 {
		t.Fatalf("ChunksLive = %d, want 2", rep.ChunksLive)
	}
}

// A chunk shared by two different paths must survive a purge that removes one
// path's history. Reference counting by content, not by entry, is the property.
func TestPurgeKeepsAChunkStillReferencedByAnotherPath(t *testing.T) {
	h := newTestStore(t)
	a := h.file(t, "a.md", "shared block")
	h.file(t, "b.md", "shared block")
	h.file(t, "a.md", "different now") // supersedes a.md's first version

	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if !h.Chunks().Has("v1", a.Chunks[0]) {
		t.Fatal("purge deleted a chunk that b.md still references")
	}
	body, err := h.Chunks().Get("v1", a.Chunks[0])
	if err != nil {
		t.Fatalf("get shared chunk: %v", err)
	}
	if string(body) != "shared block" {
		t.Fatalf("shared chunk body = %q", body)
	}
}

// The purge must leave the vault serveable. Verify is the check, and it runs
// after every purge in the tests for the same reason it exists at all: a purge
// that removes a live chunk is silent until a client asks for it.
func TestVerifyIsCleanAfterPurge(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 4; i++ {
		h.file(t, "note.md", "head", fmt.Sprintf("tail %d", i))
		h.file(t, "other.md", fmt.Sprintf("body %d", i))
	}
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatalf("purge: %v", err)
	}

	faults, checked, err := h.Verify(true)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(faults) != 0 {
		t.Fatalf("faults after purge: %v", faults)
	}
	// Zero faults out of zero checks is not a healthy vault. Two surviving
	// entries: note.md with two chunks, other.md with one.
	if checked != 3 {
		t.Fatalf("checked %d chunk references, want 3", checked)
	}
}

// uids are never reused. A purged uid coming back would collide with a cursor a
// client is still holding, and the client would skip the new entry.
func TestPurgeDoesNotRewindTheUIDSequence(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 4; i++ {
		h.file(t, "note.md", fmt.Sprintf("version %d", i))
	}
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatalf("purge: %v", err)
	}
	next := h.file(t, "note.md", "after the purge")
	if next.UID != 5 {
		t.Fatalf("next uid = %d, want 5", next.UID)
	}
}

// Rule 8: trust the numbers, not the pass. A purge reports its arithmetic so an
// implausible figure is visible, and a second purge of an already-purged vault
// must remove nothing rather than quietly finding more to delete.
func TestPurgeReportsConsistentArithmeticAndIsIdempotent(t *testing.T) {
	h := newTestStore(t)
	for i := 0; i < 3; i++ {
		h.file(t, "a.md", fmt.Sprintf("a %d", i))
		h.file(t, "b.md", fmt.Sprintf("b %d", i))
	}

	first, err := h.Purge("v1", 0)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if first.VersionsBefore != 6 || first.VersionsAfter != 2 || first.VersionsRemoved != 4 {
		t.Fatalf("first purge = %+v, want 6 -> 2 removing 4", first)
	}
	if first.ChunksDeleted != 4 || first.ChunksLive != 2 {
		t.Fatalf("first purge chunks = %d deleted, %d live; want 4 and 2", first.ChunksDeleted, first.ChunksLive)
	}

	second, err := h.Purge("v1", 0)
	if err != nil {
		t.Fatalf("second purge: %v", err)
	}
	if second.VersionsRemoved != 0 || second.ChunksDeleted != 0 {
		t.Fatalf("second purge removed %d versions and %d chunks, want none: %+v",
			second.VersionsRemoved, second.ChunksDeleted, second)
	}
	if second.VersionsBefore != first.VersionsAfter {
		t.Fatalf("second purge saw %d versions, first left %d",
			second.VersionsBefore, first.VersionsAfter)
	}
}

// A purge running alongside pushes must not stop the pushes from completing.
//
// This test is the reason chunks.DefaultGrace exists. A push uploads its bodies
// and only then commits the entry that references them, so in between those two
// steps its bodies are unreferenced and a sweep will collect them; the commit
// then fails, the client re-uploads, and the next sweep takes them again. With a
// zero grace window and a purge loop, a third of the pushes here never
// committed at all.
func TestPushesCompleteWhileAPurgeIsRunning(t *testing.T) {
	h := newTestStore(t)

	const writers, each = 6, 30
	var pushers, purger sync.WaitGroup
	var raced, committed atomic.Int64
	stop := make(chan struct{})

	purger.Add(1)
	go func() {
		defer purger.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := h.Purge("v1", chunks.DefaultGrace); err != nil {
				t.Errorf("purge: %v", err)
				return
			}
		}
	}()

	for w := 0; w < writers; w++ {
		pushers.Add(1)
		go func(w int) {
			defer pushers.Done()
			for i := 0; i < each; i++ {
				// Every version shares a chunk with the one before it, so the
				// purge always has history to collect and is genuinely
				// deleting while the pushes run.
				path := fmt.Sprintf("f%d.md", w)
				tail := fmt.Sprintf("tail %d-%d", w, i)
				if err := h.push(path, "shared head", tail); err != nil {
					raced.Add(1)
					t.Errorf("push lost to the sweep despite the grace window: %v", err)
					return
				}
				committed.Add(1)
			}
		}(w)
	}

	pushers.Wait()
	close(stop)
	purger.Wait()

	if committed.Load() != writers*each || raced.Load() != 0 {
		t.Fatalf("%d of %d pushes committed, %d lost a body to the sweep",
			committed.Load(), writers*each, raced.Load())
	}
	faults, checked, err := h.Verify(true)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(faults) != 0 {
		t.Fatalf("%d entries unserveable after a concurrent purge: %v", len(faults), faults[0])
	}
	if checked == 0 {
		t.Fatal("verify checked nothing, so the test proved nothing")
	}
}

// The write lock spans a filesystem check and a SQL commit, which no transaction
// can cover. Without it a sweep can delete a chunk between the moment
// AppendEntry confirms it is present and the moment the entry is committed, and
// the vault then holds an entry it cannot serve. SQLite's own write lock is not
// a substitute: it serialises the commit, not the check before it.
//
// The grace window does not cover this case. A client whose put is answered
// "have" sends no body, so the chunk it references can be an old one that
// nothing currently points at, which is exactly what the sweep collects. That
// happens whenever an old version is restored or an edit is reverted.
//
// A push losing this race is allowed, and fails with ErrChunkMissing so the
// client re-uploads. A push winning it and committing something unserveable is
// not.
func TestAnEntryIsNeverCommittedWhileItsChunkIsBeingSwept(t *testing.T) {
	h := newTestStore(t)

	// Bodies the server already holds, aged past any grace window, referenced by
	// nothing. This is the state a chunk is in when a client reverts an edit.
	const n = 150
	aged := make([]string, n)
	old := time.Now().Add(-2 * chunks.DefaultGrace)
	for i := range aged {
		body := []byte(fmt.Sprintf("previously uploaded %d", i))
		aged[i] = chunks.Name(body)
		if err := h.Chunks().Put("v1", aged[i], body); err != nil {
			t.Fatalf("put: %v", err)
		}
		p, err := h.Chunks().Path("v1", aged[i])
		if err != nil {
			t.Fatalf("path: %v", err)
		}
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatalf("backdate: %v", err)
		}
	}

	var purger sync.WaitGroup
	var swept, committed atomic.Int64
	stop := make(chan struct{})

	purger.Add(1)
	go func() {
		defer purger.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			rep, err := h.Purge("v1", chunks.DefaultGrace)
			if err != nil {
				t.Errorf("purge: %v", err)
				return
			}
			swept.Add(int64(rep.ChunksDeleted))
		}
	}()

	for i, name := range aged {
		// No Put: the server said it had this chunk, so the client sent nothing.
		_, err := h.AppendEntry("v1", Entry{
			Path: fmt.Sprintf("reverted%d.md", i), Size: 20, MTime: 7,
			Chunks: []string{name},
		})
		switch {
		case err == nil:
			committed.Add(1)
		case errors.Is(err, ErrChunkMissing):
			// The sweep got there first. Loud, and the client re-uploads.
		default:
			t.Fatalf("append: %v", err)
		}
	}
	close(stop)
	purger.Wait()

	faults, _, err := h.Verify(true)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(faults) != 0 {
		t.Fatalf("%d committed entries are unserveable: %v", len(faults), faults[0])
	}
	t.Logf("%d entries committed, %d chunks swept out from under the rest",
		committed.Load(), swept.Load())
	if swept.Load() == 0 {
		t.Skip("the sweep never deleted anything, so the lock was not exercised")
	}
}

/* ---------------------------------------------------------------- *
 * Verify
 * ---------------------------------------------------------------- */

func TestVerifyFindsAMissingChunk(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "will vanish")

	p, err := h.Chunks().Path("v1", e.Chunks[0])
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatalf("remove: %v", err)
	}

	faults, checked, err := h.Verify(false)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if checked != 1 {
		t.Fatalf("checked %d, want 1", checked)
	}
	if len(faults) != 1 || faults[0].Reason != "missing" {
		t.Fatalf("faults = %v, want one missing", faults)
	}
	if faults[0].UID != e.UID || faults[0].Chunk != e.Chunks[0] {
		t.Fatalf("fault does not name the entry and chunk: %+v", faults[0])
	}
}

func TestDeepVerifyFindsACorruptChunk(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "original")

	p, err := h.Chunks().Path("v1", e.Chunks[0])
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.WriteFile(p, []byte("tampered"), 0o600); err != nil {
		t.Fatalf("tamper: %v", err)
	}

	// A shallow verify only asks whether the file is there, and it is.
	shallow, _, err := h.Verify(false)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(shallow) != 0 {
		t.Fatalf("shallow verify reported %v; it checks presence only", shallow)
	}

	deep, _, err := h.Verify(true)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(deep) != 1 || deep[0].Reason != "corrupt" {
		t.Fatalf("deep verify = %v, want one corrupt", deep)
	}
}

/* ---------------------------------------------------------------- *
 * Vault lifecycle
 * ---------------------------------------------------------------- */

func TestPruneRemovesOnlyGenuinelyEmptyVaults(t *testing.T) {
	h := newTestStore(t)
	for _, v := range []string{"typo", "young", "deleted-only"} {
		if err := h.EnsureVault(v, 1000); err != nil {
			t.Fatalf("ensure %s: %v", v, err)
		}
	}
	if err := h.EnsureVault("brand-new", 9_000); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	// "deleted-only" holds nothing but a deletion. It is not empty: that record
	// is what makes the file recoverable.
	if _, err := h.AppendEntry("deleted-only", Entry{Path: "gone.md", Deleted: true}); err != nil {
		t.Fatalf("append deletion: %v", err)
	}
	h.file(t, "kept.md", "content") // v1 has entries

	pruned, err := h.PruneEmptyVaults(10_000, 5_000)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}

	got := map[string]bool{}
	for _, p := range pruned {
		got[p.VaultID] = true
	}
	if !got["typo"] || !got["young"] {
		t.Fatalf("pruned = %v, want the two empty old vaults", got)
	}
	if got["deleted-only"] {
		t.Fatal("pruned a vault holding a deletion record")
	}
	if got["brand-new"] {
		t.Fatal("pruned a vault younger than minAge, whose first upload may be in flight")
	}
	if got["v1"] {
		t.Fatal("pruned a vault with entries")
	}

	remaining, err := h.Vaults()
	if err != nil {
		t.Fatalf("vaults: %v", err)
	}
	if len(remaining) != 3 {
		t.Fatalf("%d vaults remain, want 3: %v", len(remaining), remaining)
	}
}

// Everything acked must still be there after a restart. This is the whole point
// of the fsync ordering in the chunk store and of SyncFull in the entry store.
func TestEntriesAndChunksSurviveAReopen(t *testing.T) {
	dir := t.TempDir()
	h := openAt(t, dir)
	if err := h.EnsureVault("v1", 1000); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	want := h.file(t, "note.md", "head", "tail")
	if err := h.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	again := openAt(t, dir)
	got, ok, err := again.EntryByUID("v1", want.UID)
	if err != nil || !ok {
		t.Fatalf("entry gone after reopen: ok=%v err=%v", ok, err)
	}
	if len(got.Chunks) != 2 || got.Chunks[0] != want.Chunks[0] || got.Chunks[1] != want.Chunks[1] {
		t.Fatalf("chunks = %v, want %v", got.Chunks, want.Chunks)
	}
	body, err := again.Chunks().Get("v1", got.Chunks[0])
	if err != nil || string(body) != "head" {
		t.Fatalf("chunk body after reopen = %q, err %v", body, err)
	}
	faults, checked, err := again.Verify(true)
	if err != nil || len(faults) != 0 || checked != 2 {
		t.Fatalf("verify after reopen: faults=%v checked=%d err=%v", faults, checked, err)
	}
	// The next uid continues from where it left off.
	next := again.file(t, "note.md", "after restart")
	if next.UID != want.UID+1 {
		t.Fatalf("uid after reopen = %d, want %d", next.UID, want.UID+1)
	}
}

func TestStatsCountsFoldersSeparatelyFromFiles(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "notes/a.md", "content a")
	h.file(t, "notes/b.md", "content b")
	if _, err := h.AppendEntry("v1", Entry{Path: "notes", Folder: true}); err != nil {
		t.Fatalf("append folder: %v", err)
	}

	st, err := h.Stats("v1")
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.Files != 2 {
		t.Fatalf("Files = %d, want 2", st.Files)
	}
	if st.Folders != 1 {
		t.Fatalf("Folders = %d, want 1", st.Folders)
	}
	if st.Bytes != int64(len("content a")+len("content b")) {
		t.Fatalf("Bytes = %d, want %d", st.Bytes, len("content a")+len("content b"))
	}
	if st.LatestUID != 3 || st.AllocatedTo != 3 {
		t.Fatalf("LatestUID = %d, AllocatedTo = %d, want 3 and 3", st.LatestUID, st.AllocatedTo)
	}
}

func TestOpenRefusesAnInvalidSyncMode(t *testing.T) {
	dir := t.TempDir()
	if _, err := OpenWithSync(filepath.Join(dir, "db"), filepath.Join(dir, "c"), "SOMETIMES"); err == nil {
		t.Fatal("OpenWithSync accepted an unknown sync mode")
	}
}

func uids(entries []Entry) []int64 {
	out := make([]int64, len(entries))
	for i, e := range entries {
		out[i] = e.UID
	}
	return out
}

// The other order, which is the one clients actually produce.
//
// A rename is two entries, and a client publishes the new path before retiring
// the old one, because that is the order its scan reaches them in. The original
// suppression asked for "a later entry names this path as its prev", which is
// only true when the deletion is written first, and the only test it had used
// exactly that order. Every real rename showed up as a phantom deletion.
func TestRenameDeletionIsSuppressedWhenTheNewPathIsPublishedFirst(t *testing.T) {
	h := newTestStore(t)
	old := h.file(t, "old.md", "the note")

	// New path first, carrying prev. Then the old path is retired.
	if _, err := h.AppendEntry("v1", Entry{
		Path: "new.md", Prev: "old.md", Size: old.Size, MTime: 50, Chunks: old.Chunks,
	}); err != nil {
		t.Fatalf("append new: %v", err)
	}
	if _, err := h.AppendEntry("v1", Entry{Path: "old.md", Deleted: true, MTime: 51}); err != nil {
		t.Fatalf("delete old: %v", err)
	}

	got, _, err := h.Deleted("v1", true, 0)
	if err != nil {
		t.Fatalf("deleted: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("a rename shows as %d deletions: %v", len(got), got[0].Path)
	}
}

// And the case the ordering requirement exists to protect: a path renamed away
// and then used again by a different file. That file's deletion is real, and
// hiding it forever because the name was once renamed would lose it.
func TestADeletionIsStillListedWhenThePathWasReusedAfterARename(t *testing.T) {
	h := newTestStore(t)
	first := h.file(t, "notes.md", "the original")
	if _, err := h.AppendEntry("v1", Entry{
		Path: "moved.md", Prev: "notes.md", Size: first.Size, MTime: 11, Chunks: first.Chunks,
	}); err != nil {
		t.Fatalf("append rename: %v", err)
	}
	if _, err := h.AppendEntry("v1", Entry{Path: "notes.md", Deleted: true, MTime: 12}); err != nil {
		t.Fatalf("delete after rename: %v", err)
	}

	// Later, something new takes the name and is then deleted for real.
	h.file(t, "notes.md", "a different note entirely")
	if _, err := h.AppendEntry("v1", Entry{Path: "notes.md", Deleted: true, MTime: 31}); err != nil {
		t.Fatalf("delete the reused path: %v", err)
	}

	got, _, err := h.Deleted("v1", true, 0)
	if err != nil {
		t.Fatalf("deleted: %v", err)
	}
	if len(got) != 1 || got[0].Path != "notes.md" {
		t.Fatalf("a real deletion was hidden by an old rename: %v", got)
	}
}

// The fault verify could not see.
//
// Its query joined entries to their chunk rows, so an entry whose chunk rows are
// gone had nothing to join to and was never examined. An entry declaring a size
// with no chunks behind it is a note that reads as empty rather than as an
// error, and `basalt verify` called the vault clean.
func TestVerifyNoticesAnEntryWhoseChunksAreGone(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "the content of a note")
	h.file(t, "fine.md", "still intact")

	// Exactly what a botched migration or a bad row delete leaves behind. The
	// bodies are still on disk; nothing points at them any more.
	if _, err := h.db.Exec(`DELETE FROM entry_chunks WHERE vault_id = 'v1' AND uid = ?`, e.UID); err != nil {
		t.Fatalf("detach chunks: %v", err)
	}

	faults, _, err := h.Verify(false)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(faults) != 1 {
		t.Fatalf("verify found %d faults, want 1: %v", len(faults), faults)
	}
	if faults[0].Reason != "nochunks" || faults[0].Path != "note.md" {
		t.Fatalf("verify reported %v, want nochunks for note.md", faults[0])
	}
}

// The other half of the biconditional: content attached to something that
// should have none is a folder or a deletion carrying bytes nobody will read.
func TestVerifyNoticesChunksOnSomethingThatShouldHaveNone(t *testing.T) {
	h := newTestStore(t)
	e := h.file(t, "note.md", "content")
	if _, err := h.db.Exec(
		`INSERT INTO entries (vault_id, uid, path, size, ctime, mtime, folder, deleted, device, prev_path)
		 VALUES ('v1', ?, 'folder', 0, 1, 1, 1, 0, 'test', '')`, e.UID+1000); err != nil {
		t.Fatalf("seed folder: %v", err)
	}
	if _, err := h.db.Exec(
		`INSERT INTO entry_chunks (vault_id, uid, ord, name) VALUES ('v1', ?, 0, ?)`,
		e.UID+1000, e.Chunks[0]); err != nil {
		t.Fatalf("attach chunk to folder: %v", err)
	}

	faults, _, err := h.Verify(false)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	found := false
	for _, f := range faults {
		if f.Reason == "straychunks" {
			found = true
		}
	}
	if !found {
		t.Fatalf("verify did not notice chunks on a folder: %v", faults)
	}
}

// And a healthy vault is still reported healthy, so the new checks are not
// simply refusing everything.
func TestVerifyIsQuietOnAHealthyVault(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content", "more content")
	h.file(t, "empty.md")
	if _, err := h.AppendEntry("v1", Entry{Path: "gone.md", Deleted: true, MTime: 3}); err != nil {
		t.Fatalf("seed deletion: %v", err)
	}
	if _, err := h.AppendEntry("v1", Entry{Path: "dir", Folder: true, MTime: 4}); err != nil {
		t.Fatalf("seed folder: %v", err)
	}

	faults, checked, err := h.Verify(true)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(faults) != 0 {
		t.Fatalf("a healthy vault reported %d faults: %v", len(faults), faults)
	}
	if checked == 0 {
		t.Fatal("verify checked nothing and called it clean")
	}
}
