package server

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/coder/websocket"

	"github.com/waynehoover/basalt/internal/chunks"
	"github.com/waynehoover/basalt/internal/store"
	"github.com/waynehoover/basalt/internal/wire"
)

/* ---------------------------------------------------------------- *
 * Handshake
 * ---------------------------------------------------------------- */

// Every ceiling the server enforces must be advertised, and advertised before
// the client's first put. A limit enforced but not announced is a put that can
// never succeed and a client that retries it forever.
func TestReadyAdvertisesTheLimitsTheStoreActuallyEnforces(t *testing.T) {
	r := newRig(t)
	ready, _ := r.dial("a").hello(0)

	if ready.Proto != wire.Proto {
		t.Fatalf("proto = %d, want %d", ready.Proto, wire.Proto)
	}
	if ready.PerFileMax != store.PerFileMax {
		t.Fatalf("perFileMax = %d, store enforces %d", ready.PerFileMax, store.PerFileMax)
	}
	if ready.ChunkMax != store.ChunkMax {
		t.Fatalf("chunkMax = %d, store enforces %d", ready.ChunkMax, store.ChunkMax)
	}
	if ready.MaxChunks != store.MaxChunksPerEntry {
		t.Fatalf("maxChunks = %d, store enforces %d", ready.MaxChunks, store.MaxChunksPerEntry)
	}
}

// Ready carries what the server holds, so a client can tell immediately how far
// behind it is rather than inferring it from a stored flag. Obsidian's `initial`
// boolean pointed at an empty vault and reported "fully synced".
func TestReadyReportsWhatTheServerHolds(t *testing.T) {
	r := newRig(t)
	r.seed("a.md", "one")
	last := r.seed("b.md", "two")

	ready, _ := r.dial("a").hello(0)
	if ready.Cursor != last.UID {
		t.Fatalf("ready cursor = %d, server holds up to %d", ready.Cursor, last.UID)
	}
}

func TestHandshakeRefusals(t *testing.T) {
	cases := []struct {
		why  string
		msg  wire.In
		code string
	}{
		{"unsupported proto", wire.In{
			Op: "hello", Proto: wire.Proto + 1, Crypto: wire.Crypto,
			Vault: testVault, Token: testToken}, wire.CodeProto},
		{"unsupported crypto", wire.In{
			Op: "hello", Proto: wire.Proto, Crypto: "rot13/1",
			Vault: testVault, Token: testToken}, wire.CodeProto},
		{"wrong token", helloMsg(testVault, "guess", "a", 0), wire.CodeAuth},
		{"unknown vault", helloMsg("someone-elses", testToken, "a", 0), wire.CodeAuth},
		{"missing vault", helloMsg("", testToken, "a", 0), wire.CodeAuth},
		{"negative cursor", helloMsg(testVault, testToken, "a", -1), wire.CodeProtoState},
		{"not hello at all", wire.In{Op: "put", Path: "a.md"}, wire.CodeProtoState},
	}
	for _, c := range cases {
		t.Run(c.why, func(t *testing.T) {
			r := newRig(t)
			cl := r.dial("a")
			cl.sendJSON(c.msg)
			cl.expectErr(c.code)
			if !cl.closed() {
				t.Fatal("session survived a refusal that should end it")
			}
		})
	}
}

// A wrong token and an unknown vault must be indistinguishable to the caller,
// or an attacker learns which half to keep guessing.
func TestAuthFailuresDoNotSayWhichHalfWasWrong(t *testing.T) {
	r := newRig(t)

	badToken := r.dial("a")
	badToken.sendJSON(helloMsg(testVault, "guess", "a", 0))
	one := badToken.expectErr(wire.CodeAuth)

	badVault := r.dial("b")
	badVault.sendJSON(helloMsg("someone-elses", testToken, "b", 0))
	two := badVault.expectErr(wire.CodeAuth)

	if one != two {
		t.Fatalf("the two failures are distinguishable:\n  %q\n  %q", one, two)
	}
}

func TestSecondHelloIsRefused(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.sendJSON(helloMsg(testVault, testToken, "a", 0))
	cl.expectErr(wire.CodeProtoState)
}

// A client whose cursor is past the server's means the server lost history the
// client already applied. Continuing would reissue those uids for other files
// and both sides would report success while diverging.
func TestAClientAheadOfTheServerIsRefused(t *testing.T) {
	r := newRig(t)
	r.seed("a.md", "one") // server is at uid 1

	cl := r.dial("restored-from-an-old-backup")
	cl.sendJSON(helloMsg(testVault, testToken, "a", 99))
	msg := cl.expectErr(wire.CodeCursor)
	if !cl.closed() {
		t.Fatal("session continued past a diverged cursor")
	}
	t.Logf("refusal read: %s", msg)
}

func TestVaultDeviceLimitIsRefusedNotDegraded(t *testing.T) {
	r := newRigWithPeers(t, 2)
	r.dial("a").hello(0)
	r.dial("b").hello(0)

	third := r.dial("c")
	third.sendJSON(helloMsg(testVault, testToken, "c", 0))
	third.expectErr(wire.CodeBusy)

	if got := r.srv.Peers(testVault); got != 2 {
		t.Fatalf("%d peers joined, limit is 2", got)
	}
}

/* ---------------------------------------------------------------- *
 * Catch-up
 * ---------------------------------------------------------------- */

func TestEmptyVaultCatchesUpImmediately(t *testing.T) {
	r := newRig(t)
	ready, entries := r.dial("a").hello(0)
	if ready.Cursor != 0 {
		t.Fatalf("cursor = %d on an empty vault", ready.Cursor)
	}
	if len(entries) != 0 {
		t.Fatalf("%d entries from an empty vault", len(entries))
	}
}

// The client helper asserts From == cursor+1 on every batch, so this exercises
// the continuity contract across many batches rather than only asserting the
// total.
func TestCatchUpDeliversEveryEntryInContiguousBatches(t *testing.T) {
	r := newRig(t)
	const total = BatchSize*2 + 37
	for i := 0; i < total; i++ {
		r.seed(fmt.Sprintf("f%04d.md", i), fmt.Sprintf("body %d", i))
	}

	_, entries := r.dial("a").hello(0)
	if len(entries) != total {
		t.Fatalf("caught up with %d entries, vault holds %d", len(entries), total)
	}
	for i, e := range entries {
		if e.UID != int64(i+1) {
			t.Fatalf("entry %d has uid %d", i, e.UID)
		}
		if len(e.Chunks) == 0 {
			t.Fatalf("entry %d arrived with no chunks", e.UID)
		}
	}
}

func TestCatchUpFromAMidwayCursorSendsOnlyWhatIsNewer(t *testing.T) {
	r := newRig(t)
	for i := 0; i < 6; i++ {
		r.seed(fmt.Sprintf("f%d.md", i), fmt.Sprintf("body %d", i))
	}

	_, entries := r.dial("a").hello(4)
	if len(entries) != 2 {
		t.Fatalf("got %d entries from cursor 4, want 2", len(entries))
	}
	if entries[0].UID != 5 || entries[1].UID != 6 {
		t.Fatalf("got uids %d and %d, want 5 and 6", entries[0].UID, entries[1].UID)
	}
}

// A purge leaves holes in the uid sequence. The covered range has to span them,
// or a client reads its own history as a set of lost files.
func TestCatchUpSpansPurgedHoles(t *testing.T) {
	r := newRig(t)
	for i := 0; i < 5; i++ {
		r.seed("note.md", fmt.Sprintf("version %d", i))
	}
	if _, err := r.st.Purge(testVault, 0); err != nil {
		t.Fatalf("purge: %v", err)
	}

	// hello asserts From == cursor+1 internally, which is the whole point: it
	// must hold across the hole left by uids 1 to 4.
	ready, entries := r.dial("a").hello(0)
	if len(entries) != 1 || entries[0].UID != 5 {
		t.Fatalf("got %d entries after purge: %v", len(entries), entries)
	}
	if ready.Cursor != 5 {
		t.Fatalf("ready cursor = %d, want 5", ready.Cursor)
	}
}

/* ---------------------------------------------------------------- *
 * Live delivery and the echo
 * ---------------------------------------------------------------- */

// Two devices, one push. The other device gets the entry; the pusher gets the
// range with no payload, so its cursor advances without it having to work out
// that the change was its own.
func TestAPushReachesOtherDevicesAndEchoesWithoutAPayload(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	b := r.dial("b")
	a.hello(0)
	b.hello(0)

	uid := a.put("note.md", "hello world")

	echo := a.nextBatch()
	if echo.From != uid || echo.To != uid {
		t.Fatalf("pusher's range is [%d,%d], want [%d,%d]", echo.From, echo.To, uid, uid)
	}
	if len(echo.Entries) != 0 {
		t.Fatalf("pusher was sent its own write back: %v", echo.Entries)
	}

	got := b.nextBatch()
	if got.From != uid || got.To != uid {
		t.Fatalf("peer's range is [%d,%d], want [%d,%d]", got.From, got.To, uid, uid)
	}
	if len(got.Entries) != 1 {
		t.Fatalf("peer got %d entries, want 1", len(got.Entries))
	}
	if got.Entries[0].Path != "note.md" || got.Entries[0].UID != uid {
		t.Fatalf("peer got %+v", got.Entries[0])
	}
}

// Both devices' cursors must still be able to advance contiguously when each of
// them is pushing. This is the property the elided echo exists to preserve: if
// the pusher were skipped entirely, its cursor would fall one behind per push
// and the next peer's change would look like a gap.
func TestCursorsStayContiguousWhenBothDevicesPush(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	b := r.dial("b")
	a.hello(0)
	b.hello(0)

	cursorA, cursorB := int64(0), int64(0)
	advance := func(name string, cursor int64, b wire.Batch) int64 {
		t.Helper()
		if b.From != cursor+1 {
			t.Fatalf("%s: batch from %d, cursor %d: gap", name, b.From, cursor)
		}
		return b.To
	}

	for i := 0; i < 4; i++ {
		uid := a.put(fmt.Sprintf("a%d.md", i), fmt.Sprintf("from a %d", i))
		cursorA = advance("a", cursorA, a.nextBatch())
		cursorB = advance("b", cursorB, b.nextBatch())
		if cursorA != uid || cursorB != uid {
			t.Fatalf("after a's push %d: cursors %d and %d", uid, cursorA, cursorB)
		}

		uid = b.put(fmt.Sprintf("b%d.md", i), fmt.Sprintf("from b %d", i))
		cursorA = advance("a", cursorA, a.nextBatch())
		cursorB = advance("b", cursorB, b.nextBatch())
		if cursorA != uid || cursorB != uid {
			t.Fatalf("after b's push %d: cursors %d and %d", uid, cursorA, cursorB)
		}
	}
}

/* ---------------------------------------------------------------- *
 * put
 * ---------------------------------------------------------------- */

func TestPutUploadsOnlyWhatTheServerLacks(t *testing.T) {
	r := newRig(t)
	// The server already holds the head chunk from another file.
	r.seed("other.md", "shared head")

	cl := r.dial("a")
	cl.hello(0)

	bodies := []string{"shared head", "unique tail"}
	names, size := chunkNames(bodies)
	cl.sendJSON(wire.In{Op: "put", Path: "note.md", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 5}})

	var want wire.Want
	cl.recvInto("want", &want)
	if len(want.Chunks) != 1 {
		t.Fatalf("server wants %d chunks, should only lack the tail: %v", len(want.Chunks), want.Chunks)
	}
	if want.Chunks[0] != names[1] {
		t.Fatalf("server wants %s, expected the tail %s", want.Chunks[0], names[1])
	}

	cl.sendBinary([]byte(bodies[1]))
	var ack wire.Ack
	cl.recvInto("ack", &ack)
	if ack.UID != 2 {
		t.Fatalf("uid = %d, want 2", ack.UID)
	}
}

// When the server already holds everything, nothing is uploaded and the reply
// says so with its own verb. `have` and `ack` are different outcomes and the
// protocol names both.
func TestPutOfAlreadyHeldContentRepliesHaveWithTheUID(t *testing.T) {
	r := newRig(t)
	r.seed("other.md", "identical content")

	cl := r.dial("a")
	cl.hello(0)
	names, size := chunkNames([]string{"identical content"})
	cl.sendJSON(wire.In{Op: "put", Path: "copy.md", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 5}})

	var have wire.Have
	cl.recvInto("have", &have)
	if have.UID != 2 {
		t.Fatalf("uid = %d, want 2", have.UID)
	}
	if r.mustStats().Files != 2 {
		t.Fatalf("the entry was not committed: %+v", r.mustStats())
	}
}

// The first durability rule. When the ack lands, the entry and every body are
// on disk, and a deep verify says so.
func TestTheAckMeansStored(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	uid := cl.put("note.md", "head", "middle", "tail")

	e, ok, err := r.st.EntryByUID(testVault, uid)
	if err != nil || !ok {
		t.Fatalf("acked uid %d is not in the store: ok=%v err=%v", uid, ok, err)
	}
	if len(e.Chunks) != 3 {
		t.Fatalf("entry has %d chunks, want 3", len(e.Chunks))
	}
	if checked := r.mustVerify(); checked != 3 {
		t.Fatalf("verified %d chunk references, want 3", checked)
	}
	for i, want := range []string{"head", "middle", "tail"} {
		body, err := r.st.Chunks().Get(testVault, e.Chunks[i])
		if err != nil {
			t.Fatalf("chunk %d: %v", i, err)
		}
		if string(body) != want {
			t.Fatalf("chunk %d is %q, want %q", i, body, want)
		}
	}
}

// A body that does not hash to the name it was asked for is refused, and
// nothing is committed. The server cannot store it under the claimed name
// without corrupting the vault, and cannot store it under its real name without
// leaving the entry pointing at nothing.
func TestABodyThatDoesNotMatchItsNameCommitsNothing(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	names, size := chunkNames([]string{"what the client promised"})
	cl.sendJSON(wire.In{Op: "put", Path: "note.md", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 5}})
	var want wire.Want
	cl.recvInto("want", &want)

	cl.sendBinary([]byte("something else entirely"))
	cl.expectErr(wire.CodeBadChunk)

	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("%d entries committed after a refused body", st.Versions)
	}
	if r.st.Chunks().Has(testVault, names[0]) {
		t.Fatal("the claimed name was stored anyway")
	}
	if r.st.Chunks().Has(testVault, chunks.Name([]byte("something else entirely"))) {
		t.Fatal("the body was stored under its own name, leaving the put half-done")
	}
}

// The client hangs up between `want` and the body. Nothing is acked, so nothing
// may be committed: the client will retry the whole put.
func TestHangingUpMidUploadCommitsNothing(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	names, size := chunkNames([]string{"never arrives"})
	cl.sendJSON(wire.In{Op: "put", Path: "note.md", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 5}})
	var want wire.Want
	cl.recvInto("want", &want)
	cl.conn.CloseNow()

	// The server notices the hang-up on its next read. Poll the store rather
	// than sleeping a fixed time.
	waitFor(t, "the session to end", func() bool { return r.srv.Peers(testVault) == 0 })
	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("%d entries committed by a put that never finished", st.Versions)
	}
}

// The same body twice means the remaining frame count is no longer agreed, so
// there is no way to carry on without guessing.
func TestARepeatedBodyIsRefused(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	bodies := []string{"first", "second"}
	names, size := chunkNames(bodies)
	cl.sendJSON(wire.In{Op: "put", Path: "note.md", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 5}})
	var want wire.Want
	cl.recvInto("want", &want)

	cl.sendBinary([]byte("first"))
	cl.sendBinary([]byte("first"))
	cl.expectErr(wire.CodeBadChunk)
	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("%d entries committed", st.Versions)
	}
}

func TestATextFrameWhereABodyWasExpectedIsRefused(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	names, size := chunkNames([]string{"a body"})
	cl.sendJSON(wire.In{Op: "put", Path: "note.md", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 5}})
	var want wire.Want
	cl.recvInto("want", &want)

	cl.sendJSON(wire.In{Op: "ping"})
	cl.expectErr(wire.CodeProtoState)
}

// docs/protocol.md: a rejected put returns an error and the session continues.
// Obsidian's protocol has no clean way to refuse a push, so a bad one costs a
// reconnect; here it costs one frame.
func TestARejectedPutLeavesTheSessionUsable(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	// A size with no chunk list: indistinguishable from an empty file, so it is
	// refused rather than stored as one.
	cl.sendJSON(wire.In{Op: "put", Path: "note.md", Meta: wire.PutMeta{Size: 4096, MTime: 5}})
	cl.expectErr(wire.CodeBadEntry)

	uid := cl.put("good.md", "this one is fine")
	if uid != 1 {
		t.Fatalf("uid = %d, want 1: the refused put must not have consumed one", uid)
	}
}

func TestPutRefusals(t *testing.T) {
	longPath := make([]byte, store.MaxPathLen+1)
	for i := range longPath {
		longPath[i] = 'x'
	}
	good := chunks.Name([]byte("x"))

	cases := []struct {
		why  string
		msg  wire.In
		code string
	}{
		{"empty path", wire.In{Op: "put", Path: "", Meta: wire.PutMeta{Size: 0}}, wire.CodeBadName},
		{"path over the bound", wire.In{Op: "put", Path: string(longPath)}, wire.CodeBadName},
		{"file over the ceiling", wire.In{Op: "put", Path: "big.md",
			Meta: wire.PutMeta{Size: store.PerFileMax + 1}}, wire.CodeToolarge},
		{"size with no chunks", wire.In{Op: "put", Path: "a.md",
			Meta: wire.PutMeta{Size: 10}}, wire.CodeBadEntry},
		{"chunks on a deletion", wire.In{Op: "put", Path: "a.md", Chunks: []string{good},
			Meta: wire.PutMeta{Deleted: true}}, wire.CodeBadEntry},
		{"folder and deletion at once", wire.In{Op: "put", Path: "a",
			Meta: wire.PutMeta{Folder: true, Deleted: true}}, wire.CodeBadEntry},
		{"prev equal to path", wire.In{Op: "put", Path: "a.md",
			Meta: wire.PutMeta{Prev: "a.md"}}, wire.CodeBadEntry},
		{"malformed chunk name", wire.In{Op: "put", Path: "a.md", Chunks: []string{"nope"},
			Meta: wire.PutMeta{Size: 1}}, wire.CodeBadEntry},
	}
	for _, c := range cases {
		t.Run(c.why, func(t *testing.T) {
			r := newRig(t)
			cl := r.dial("a")
			cl.hello(0)
			cl.sendJSON(c.msg)
			cl.expectErr(c.code)
			if st := r.mustStats(); st.Versions != 0 {
				t.Fatalf("%d entries committed by a refused put", st.Versions)
			}
		})
	}
}

// A deletion is an entry. It carries no body, so it commits in one exchange.
func TestDeletionsAndFoldersCommitWithNoUpload(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.put("note.md", "content")
	cl.nextBatch() // own echo

	cl.sendJSON(wire.In{Op: "put", Path: "note.md", Meta: wire.PutMeta{Deleted: true, MTime: 9}})
	var have wire.Have
	cl.recvInto("have", &have)

	cl.sendJSON(wire.In{Op: "put", Path: "folder", Meta: wire.PutMeta{Folder: true}})
	cl.recvInto("have", &have)

	st := r.mustStats()
	if st.Files != 0 || st.Deleted != 1 || st.Folders != 1 {
		t.Fatalf("stats = %+v, want 0 files, 1 deleted, 1 folder", st)
	}
	// Rule 6: the deletion is a record, not an absence, so the vault is not
	// empty and the file is recoverable.
	if st.Versions != 3 {
		t.Fatalf("%d versions, want 3", st.Versions)
	}
}

// A zero-byte note is a real file with no chunks, and must not be confused with
// a folder, a deletion, or a lost chunk list.
func TestAnEmptyFileRoundTrips(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	cl.sendJSON(wire.In{Op: "put", Path: "empty.md", Meta: wire.PutMeta{Size: 0, MTime: 5}})
	var have wire.Have
	cl.recvInto("have", &have)
	cl.nextBatch()

	cl.sendJSON(wire.In{Op: "get", UID: have.UID})
	var got wire.Chunks
	cl.recvInto("chunks", &got)
	if got.Size != 0 || len(got.Chunks) != 0 {
		t.Fatalf("get returned size %d with %d chunks", got.Size, len(got.Chunks))
	}
}

/* ---------------------------------------------------------------- *
 * get and fetch
 * ---------------------------------------------------------------- */

func TestGetThenFetchReturnsOnlyTheBodiesAsked(t *testing.T) {
	r := newRig(t)
	e := r.seed("note.md", "head", "middle", "tail")

	cl := r.dial("a")
	cl.hello(0)
	cl.sendJSON(wire.In{Op: "get", UID: e.UID})

	var got wire.Chunks
	cl.recvInto("chunks", &got)
	if got.UID != e.UID || got.Size != e.Size {
		t.Fatalf("get returned uid %d size %d, want %d and %d", got.UID, got.Size, e.UID, e.Size)
	}
	if len(got.Chunks) != 3 {
		t.Fatalf("got %d chunks, want 3", len(got.Chunks))
	}

	// A device that already holds the head and tail fetches only the middle.
	cl.sendJSON(wire.In{Op: "fetch", Chunks: []string{got.Chunks[1]}})
	body := cl.recvBinary()
	if string(body) != "middle" {
		t.Fatalf("fetched %q, want %q", body, "middle")
	}
	if chunks.Name(body) != got.Chunks[1] {
		t.Fatal("the body does not hash to the name it was fetched under")
	}
}

func TestFetchStreamsBodiesInTheOrderRequested(t *testing.T) {
	r := newRig(t)
	e := r.seed("note.md", "one", "two", "three")

	cl := r.dial("a")
	cl.hello(0)
	order := []string{e.Chunks[2], e.Chunks[0], e.Chunks[1]}
	cl.sendJSON(wire.In{Op: "fetch", Chunks: order})

	for i, want := range []string{"three", "one", "two"} {
		got := cl.recvBinary()
		if string(got) != want {
			t.Fatalf("body %d is %q, want %q", i, got, want)
		}
	}
}

// A fetch naming one chunk the server lacks sends no bodies at all. Failing
// halfway leaves the client unable to tell which of the frames it received.
func TestAFetchWithAMissingChunkSendsNoBodies(t *testing.T) {
	r := newRig(t)
	e := r.seed("note.md", "present")
	absent := chunks.Name([]byte("never uploaded"))

	cl := r.dial("a")
	cl.hello(0)
	cl.sendJSON(wire.In{Op: "fetch", Chunks: []string{e.Chunks[0], absent}})
	cl.expectErr(wire.CodeNoChunk)

	// The session survives, and the frame after the error is the reply to the
	// next request rather than a stray body from the refused fetch.
	cl.sendJSON(wire.In{Op: "ping"})
	if m := cl.recv(); m["res"] != "pong" {
		t.Fatalf("after a refused fetch the next frame was %v", m)
	}
}

func TestGetRefusals(t *testing.T) {
	r := newRig(t)
	live := r.seed("note.md", "content")
	if _, err := r.st.AppendEntry(testVault, store.Entry{
		Path: "gone.md", Deleted: true, MTime: 2}); err != nil {
		t.Fatalf("seed deletion: %v", err)
	}
	if _, err := r.st.AppendEntry(testVault, store.Entry{
		Path: "folder", Folder: true}); err != nil {
		t.Fatalf("seed folder: %v", err)
	}

	cl := r.dial("a")
	cl.hello(0)

	// An unknown uid, an entry with no body, and a real entry are three
	// outcomes and get three answers. Collapsing the first two would make a
	// deleted file indistinguishable from a corrupt cursor.
	cl.sendJSON(wire.In{Op: "get", UID: 999})
	cl.expectErr(wire.CodeNoUID)

	cl.sendJSON(wire.In{Op: "get", UID: 2})
	cl.expectErr(wire.CodeNoContent)

	cl.sendJSON(wire.In{Op: "get", UID: 3})
	cl.expectErr(wire.CodeNoContent)

	cl.sendJSON(wire.In{Op: "get", UID: 0})
	cl.expectErr(wire.CodeNoUID)

	cl.sendJSON(wire.In{Op: "get", UID: live.UID})
	var ok wire.Chunks
	cl.recvInto("chunks", &ok)
}

func TestFetchRefusals(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	cl.sendJSON(wire.In{Op: "fetch"})
	cl.expectErr(wire.CodeBadChunk)

	cl.sendJSON(wire.In{Op: "fetch", Chunks: []string{"not-a-hash"}})
	cl.expectErr(wire.CodeBadChunk)
}

func TestUnknownOpIsAnsweredRatherThanIgnored(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	// A client blocked on a reply it will never receive is indistinguishable
	// from a hung server.
	cl.sendJSON(wire.In{Op: "reticulate"})
	cl.expectErr(wire.CodeProtoState)

	cl.sendJSON(wire.In{Op: "ping"})
	if m := cl.recv(); m["res"] != "pong" {
		t.Fatalf("session unusable after an unknown op: %v", m)
	}
}

/* ---------------------------------------------------------------- *
 * The ciphertext budget
 * ---------------------------------------------------------------- */

// A client declaring one byte and then uploading megabytes must be stopped
// while it is uploading, not after. The store refuses the commit either way,
// but by then the bytes are on the disk this bound exists to protect.
func TestUploadsAreCutOffOnceTheyPassTheDeclaredSize(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	bodies := make([]string, 4)
	names := make([]string, 4)
	for i := range bodies {
		b := make([]byte, 64<<10) // 64 KiB each
		b[0] = byte(i)
		bodies[i] = string(b)
		names[i] = chunks.Name(b)
	}

	cl.sendJSON(wire.In{Op: "put", Path: "lie.md", Chunks: names,
		Meta: wire.PutMeta{Size: 1, MTime: 5}})
	var want wire.Want
	cl.recvInto("want", &want)
	for _, b := range bodies {
		// The server stops reading part way through, so a write can fail here.
		// That is the refusal arriving, not a test failure.
		if err := cl.conn.Write(cl.ctx, websocket.MessageBinary, []byte(b)); err != nil {
			break
		}
	}
	cl.expectErr(wire.CodeToolarge)

	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("%d entries committed", st.Versions)
	}
	// At most the first body reached the disk before the bound fired.
	stored := 0
	for _, n := range names {
		if r.st.Chunks().Has(testVault, n) {
			stored++
		}
	}
	if stored > 1 {
		t.Fatalf("%d of 4 oversized bodies were written before the refusal", stored)
	}
}

// Pointing a tiny entry at chunks the server already holds uploads nothing, so
// only the commit can refuse it. The session has to turn that into a code the
// client can act on rather than an internal fault.
func TestAnEntryPointedAtAlreadyHeldChunksIsRefusedByTheBudget(t *testing.T) {
	r := newRig(t)
	big := make([]byte, 64<<10)
	e := r.seed("big.md", string(big))

	cl := r.dial("a")
	cl.hello(0)
	cl.sendJSON(wire.In{Op: "put", Path: "tiny.md", Chunks: e.Chunks,
		Meta: wire.PutMeta{Size: 10, MTime: 5}})
	cl.expectErr(wire.CodeToolarge)

	if st := r.mustStats(); st.Files != 1 {
		t.Fatalf("stats = %+v, want only the seeded file", st)
	}
	// The session survives: this rejects one request, it does not desync.
	if uid := cl.put("fine.md", "a normal note"); uid == 0 {
		t.Fatal("the session was unusable after a budget refusal")
	}
}

// An honestly sized file must not be caught by the bound, or the fix is worse
// than the hole. This is a realistic shape: 8 KiB plaintext chunks with an
// AES-GCM nonce and tag on each.
func TestAnHonestlySizedUploadIsNotRefused(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	const plain, n = 8192, 6
	bodies := make([]string, n)
	names := make([]string, n)
	for i := range bodies {
		b := make([]byte, plain+28)
		b[0] = byte(i)
		bodies[i] = string(b)
		names[i] = chunks.Name(b)
	}
	cl.sendJSON(wire.In{Op: "put", Path: "real.md", Chunks: names,
		Meta: wire.PutMeta{Size: plain * n, MTime: 5}})
	var want wire.Want
	cl.recvInto("want", &want)
	for _, n := range want.Chunks {
		cl.sendBinary([]byte(bodyFor(t, bodies, n)))
	}
	var ack wire.Ack
	cl.recvInto("ack", &ack)
	r.mustVerify()
}

/* ---------------------------------------------------------------- *
 * Empty, never null
 * ---------------------------------------------------------------- */

// Whatever the entry, `chunks` is an array on the wire. A client that iterates
// it must not have to guard against null on folders, deletions and empty notes,
// which is the same hazard already closed for a batch's entry list.
func TestEveryEntryOnTheWireCarriesAChunkArray(t *testing.T) {
	r := newRig(t)
	r.seed("note.md", "content")
	if _, err := r.st.AppendEntry(testVault, store.Entry{Path: "folder", Folder: true}); err != nil {
		t.Fatalf("folder: %v", err)
	}
	if _, err := r.st.AppendEntry(testVault, store.Entry{
		Path: "note.md", Deleted: true, MTime: 2}); err != nil {
		t.Fatalf("deletion: %v", err)
	}
	if _, err := r.st.AppendEntry(testVault, store.Entry{
		Path: "empty.md", Size: 0, MTime: 3}); err != nil {
		t.Fatalf("empty: %v", err)
	}

	cl := r.dial("a")
	cl.sendJSON(helloMsg(testVault, testToken, "a", 0))
	cl.recvInto("ready", nil)

	// Read the raw frame, because decoding into a struct is exactly what hides
	// the difference between [] and null.
	raw := cl.recvRaw()
	if !strings.Contains(raw, `"op":"batch"`) {
		t.Fatalf("expected a batch, got %s", raw)
	}
	if strings.Contains(raw, `"chunks":null`) {
		t.Fatalf("a batch entry carried a null chunk list: %s", raw)
	}
	if !strings.Contains(raw, `"chunks":[]`) {
		t.Fatalf("expected at least one empty chunk array in %s", raw)
	}

	// Same on the get path, which builds its own reply rather than echoing an
	// entry.
	cl.recvInto("caught-up", nil)
	cl.sendJSON(wire.In{Op: "get", UID: 4})
	raw = cl.recvRaw()
	if strings.Contains(raw, `"chunks":null`) {
		t.Fatalf("get returned a null chunk list for an empty file: %s", raw)
	}
}

// A zero-byte file has one shape, and the other is refused with a message that
// says which. Both were legal, which made an empty note two different things.
func TestAZeroByteFileWithChunksIsRefused(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	names, _ := chunkNames([]string{"ciphertext of nothing"})
	cl.sendJSON(wire.In{Op: "put", Path: "empty.md", Chunks: names,
		Meta: wire.PutMeta{Size: 0, MTime: 5}})
	msg := cl.expectErr(wire.CodeBadEntry)
	if !strings.Contains(msg, "an empty file has none") {
		t.Fatalf("the refusal does not say what shape to send instead: %s", msg)
	}
}

// A full disk has its own code. Before this it arrived as an unexplained
// internal fault while `nospace` sat in the protocol's code list unused by
// anything.
//
// The classification is tested directly because a full filesystem is not
// something a test can arrange, and an approximation of it (an unwritable
// directory) produces a different errno and would pin down nothing.
func TestAFailedBodyWriteIsClassified(t *testing.T) {
	cases := []struct {
		why  string
		err  error
		want string
	}{
		{"a full disk", fmt.Errorf("writing chunk: %w", syscall.ENOSPC), wire.CodeNoSpace},
		{"an exceeded quota", fmt.Errorf("writing chunk: %w", syscall.EDQUOT), wire.CodeNoSpace},
		{"a body over the ceiling", fmt.Errorf("x: %w", chunks.ErrTooLarge), wire.CodeToolarge},
		{"anything else", errors.New("disk on fire"), wire.CodeInternal},
	}
	for _, c := range cases {
		if got := putErrorCode(c.err); got != c.want {
			t.Errorf("%s: code = %q, want %q", c.why, got, c.want)
		}
	}
}

// A body that cannot be written commits nothing. The errno depends on the
// platform, so this asserts the outcome rather than the code.
func TestABodyThatCannotBeWrittenCommitsNothing(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	dir := r.st.Chunks().VaultDir(testVault)
	if err := os.MkdirAll(dir, 0o500); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })

	names, size := chunkNames([]string{"a body that cannot be written"})
	cl.sendJSON(wire.In{Op: "put", Path: "note.md", Chunks: names,
		Meta: wire.PutMeta{Size: size, MTime: 5}})
	var want wire.Want
	cl.recvInto("want", &want)
	cl.sendBinary([]byte("a body that cannot be written"))

	if m := cl.recv(); m["res"] != "err" {
		t.Fatalf("a failed write was not reported: %v", m)
	}
	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("%d entries committed despite the write failing", st.Versions)
	}
}

// The declared size counts a repeated block once per reference, so the budget
// must too. Four references to one body is four blocks of plaintext, whatever
// the disk holds.
func TestRepeatedChunksAreBudgetedPerReferenceOverTheWire(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	body := make([]byte, 4096)
	name := chunks.Name(body)
	// Four references, but a size that only accounts for one of them.
	cl.sendJSON(wire.In{Op: "put", Path: "lie.md",
		Chunks: []string{name, name, name, name},
		Meta:   wire.PutMeta{Size: 4096, MTime: 5}})

	m := cl.recv()
	if m["res"] == "want" {
		// The body is not held yet, so the server asks for it once. Uploading
		// it stays inside the per-upload allowance; the commit is what refuses,
		// because only it counts references rather than uploads.
		cl.sendBinary(body)
		m = cl.recv()
	}
	if m["res"] != "err" || m["code"] != wire.CodeToolarge {
		t.Fatalf("four references to one body declaring one body of plaintext was accepted: %v", m)
	}
	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("%d entries committed", st.Versions)
	}
}
