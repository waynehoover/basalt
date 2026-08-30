package store

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/waynehoover/basalt/server/internal/chunks"
)

// bigChunks uploads n distinct bodies of the given size and returns their names.
func (h *harness) bigChunks(t *testing.T, n, size int) []string {
	t.Helper()
	names := make([]string, n)
	for i := 0; i < n; i++ {
		body := make([]byte, size)
		// Distinct, so they are n bodies on disk rather than one deduplicated.
		body[0], body[1] = byte(i), byte(i>>8)
		names[i] = chunks.Name(body)
		if err := h.Chunks().Put("v1", names[i], body); err != nil {
			t.Fatalf("put chunk %d: %v", i, err)
		}
	}
	return names
}

// Size and chunk count used to be bounded independently, so their product was
// the real ceiling: an entry declaring one byte could reference 65536 chunks of
// a megabyte each, and neither bound was violated. That is 64 GiB of disk
// behind a metadata field that says 1.
func TestAnEntryCannotReferenceMoreCiphertextThanItsSizeAllows(t *testing.T) {
	h := newTestStore(t)
	names := h.bigChunks(t, 8, 1<<16) // 512 KiB of bodies

	_, err := h.AppendEntry("v1", Entry{Path: "lie.md", Size: 1, MTime: 1, Chunks: names})
	if !errors.Is(err, ErrOverBudget) {
		t.Fatalf("err = %v, want ErrOverBudget", err)
	}
	// The numbers are in the message, because rule 8 is that an implausible
	// figure is what makes this kind of fault visible.
	for _, want := range []string{"8 chunks", "524288", "declared size of 1"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not mention %q: %s", want, err)
		}
	}
	if st := h.mustStats(t); st.Versions != 0 {
		t.Fatalf("%d entries committed", st.Versions)
	}
}

// The budget must not refuse honest files. A real client chunks the plaintext,
// encrypts each piece, and the total is the size plus a per-chunk overhead.
func TestAnHonestlySizedEntryFitsTheBudget(t *testing.T) {
	h := newTestStore(t)

	const chunkPlain, n = 4096, 12
	names := h.bigChunks(t, n, chunkPlain+28) // 28 bytes: an AES-GCM nonce and tag
	size := int64(chunkPlain * n)

	if _, err := h.AppendEntry("v1", Entry{
		Path: "real.md", Size: size, MTime: 1, Chunks: names,
	}); err != nil {
		t.Fatalf("an honest %d byte file in %d chunks was refused: %v", size, n, err)
	}
}

// The declared size counts a repeated block twice, so the budget has to count
// its ciphertext twice as well. Comparing per distinct body against a per
// reference size would be comparing two different things.
func TestTheBudgetCountsRepeatedChunksOncePerReference(t *testing.T) {
	h := newTestStore(t)
	body := make([]byte, 2048)
	name := chunks.Name(body)
	if err := h.Chunks().Put("v1", name, body); err != nil {
		t.Fatalf("put: %v", err)
	}

	// Two references to one 2048 byte body, declaring 4096 bytes of plaintext.
	if _, err := h.AppendEntry("v1", Entry{
		Path: "repeat.md", Size: 4096, MTime: 1, Chunks: []string{name, name},
	}); err != nil {
		t.Fatalf("a file of two identical blocks was refused: %v", err)
	}
	// The same two references declaring one byte is still a lie.
	if _, err := h.AppendEntry("v1", Entry{
		Path: "lie.md", Size: 1, MTime: 1, Chunks: []string{name, name},
	}); !errors.Is(err, ErrOverBudget) {
		t.Fatalf("err = %v, want ErrOverBudget", err)
	}

	// The case that separates the two counting rules. Four references to one
	// 2048 byte body is 8192 bytes of ciphertext by reference and 2048 by
	// distinct body, so a declared size of 2048 passes one rule and fails the
	// other. Per reference is the correct one, because the declared size counts
	// the plaintext once per reference too.
	refs := []string{name, name, name, name}
	_, err := h.AppendEntry("v1", Entry{Path: "four.md", Size: 2048, MTime: 1, Chunks: refs})
	if !errors.Is(err, ErrOverBudget) {
		t.Fatalf("err = %v, want ErrOverBudget: four references to one body were counted once", err)
	}
	// Declared honestly, the same four references are fine.
	if _, err := h.AppendEntry("v1", Entry{
		Path: "four.md", Size: 4 * 2048, MTime: 1, Chunks: refs,
	}); err != nil {
		t.Fatalf("four honestly declared references were refused: %v", err)
	}
}

// Referencing chunks the server already holds needs no upload at all, so the
// bound on uploads cannot catch it. The commit-time check is what does.
func TestReferencingAlreadyHeldChunksIsStillBudgeted(t *testing.T) {
	h := newTestStore(t)

	// An honest large file, committed normally.
	const n = 16
	names := h.bigChunks(t, n, 1<<15) // 512 KiB total
	if _, err := h.AppendEntry("v1", Entry{
		Path: "big.md", Size: n * (1 << 15), MTime: 1, Chunks: names,
	}); err != nil {
		t.Fatalf("honest file refused: %v", err)
	}

	// A second entry claiming to be tiny while pointing at all of it. Nothing
	// is uploaded, so only the commit can refuse this.
	_, err := h.AppendEntry("v1", Entry{Path: "tiny.md", Size: 10, MTime: 2, Chunks: names})
	if !errors.Is(err, ErrOverBudget) {
		t.Fatalf("err = %v, want ErrOverBudget", err)
	}
}

func TestCiphertextBudgetArithmetic(t *testing.T) {
	cases := []struct {
		size int64
		n    int
		want int64
	}{
		{0, 0, 0},
		{1, 1, 1 + ChunkOverheadMax},
		{1 << 20, 128, 1<<20 + 128*ChunkOverheadMax},
	}
	for _, c := range cases {
		if got := CiphertextBudget(c.size, c.n); got != c.want {
			t.Errorf("CiphertextBudget(%d, %d) = %d, want %d", c.size, c.n, got, c.want)
		}
	}
}

/* ---------------------------------------------------------------- *
 * One shape for a zero-byte file
 * ---------------------------------------------------------------- */

// A zero-byte file used to be two legal things: no chunks, or chunks summing to
// nothing. Encrypting empty plaintext does produce ciphertext, so a client
// would plausibly have sent the second, and two shapes for one state is a trap
// for whoever writes it.
func TestAZeroByteFileHasExactlyOneShape(t *testing.T) {
	h := newTestStore(t)
	names := h.put(t, "v1", "ciphertext of nothing")

	err := Entry{Path: "empty.md", Size: 0, Chunks: names}.Validate()
	if !errors.Is(err, ErrBadEntry) {
		t.Fatalf("err = %v, want ErrBadEntry", err)
	}
	if !strings.Contains(err.Error(), "an empty file has none") {
		t.Fatalf("the refusal does not say what the right shape is: %s", err)
	}

	if err := (Entry{Path: "empty.md", Size: 0}).Validate(); err != nil {
		t.Fatalf("the legal shape was refused: %v", err)
	}
}

/* ---------------------------------------------------------------- *
 * Empty, never null
 * ---------------------------------------------------------------- */

// The hazard already documented for Batch.Entries, one layer over. A nil slice
// marshals to JSON null, and a client iterating it crashes on exactly the
// entries it is meant to handle without noticing: folders, deletions and empty
// notes.
func TestEntriesLeaveTheStoreWithAnArrayNotNull(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")
	if _, err := h.AppendEntry("v1", Entry{Path: "folder", Folder: true}); err != nil {
		t.Fatalf("folder: %v", err)
	}
	if _, err := h.AppendEntry("v1", Entry{Path: "note.md", Deleted: true, MTime: 2}); err != nil {
		t.Fatalf("deletion: %v", err)
	}
	if _, err := h.AppendEntry("v1", Entry{Path: "empty.md", Size: 0, MTime: 3}); err != nil {
		t.Fatalf("empty file: %v", err)
	}

	check := func(what string, e Entry) {
		t.Helper()
		if e.Chunks == nil {
			t.Fatalf("%s (uid %d) has a nil chunk list, which marshals to null", what, e.UID)
		}
	}

	b, ok, err := h.NextBatch("v1", 0, 10)
	if err != nil || !ok {
		t.Fatalf("batch: ok=%v err=%v", ok, err)
	}
	for _, e := range b.Entries {
		check("batch entry", e)
	}
	for uid := int64(1); uid <= 4; uid++ {
		e, ok, err := h.EntryByUID("v1", uid)
		if err != nil || !ok {
			t.Fatalf("uid %d: ok=%v err=%v", uid, ok, err)
		}
		check(fmt.Sprintf("uid %d", uid), e)
	}
	del, _, err := h.Deleted("v1", false, 0)
	if err != nil {
		t.Fatalf("deleted: %v", err)
	}
	for _, e := range del {
		check("deleted entry", e.Entry)
	}
}

func (h *harness) mustStats(t *testing.T) Stats {
	t.Helper()
	st, err := h.Stats("v1")
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	return st
}
