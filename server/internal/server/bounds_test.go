package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// shutdownRig runs Server.Shutdown with a generous deadline and fails the test
// if it reports anything.
func shutdownRig(t *testing.T, r *rig) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}

/* ---------------------------------------------------------------- *
 * S18: the batch byte cap
 * ---------------------------------------------------------------- */

// A batch whose entries could upload more than maxBatchBytes between them is
// refused before the want list goes out, with toolarge and a message that says
// to split, and the session continues. 256 entries at the file limit used to
// be 16 GiB of allowed upload in one exchange.
func TestS18ABatchOverTheByteBudgetIsRefused(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	// Two entries of 9 MiB each: neither is over the file limit, together
	// they are over the batch cap. No body is ever sent, so the chunks need
	// not exist.
	big := wire.PutEntry{Path: "a.bin", Chunks: []string{chunks.Name([]byte("a"))}, Mac: testMac,
		Meta: wire.PutMeta{Size: 9 << 20, MTime: 1}}
	other := big
	other.Path = "b.bin"
	cl.sendJSON(wire.In{Op: "putmany", Entries: []wire.PutEntry{big, other}})
	msg := cl.expectErr(wire.CodeToolarge)
	if !strings.Contains(msg, "split") {
		t.Fatalf("the refusal does not tell the client what to do: %q", msg)
	}
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("%d versions committed from a refused batch", st.Versions)
	}

	// The same two files one at a time are fine: the cap is per exchange.
	body := strings.Repeat("x", 100)
	cl.put("a.bin", body)
}

/* ---------------------------------------------------------------- *
 * S22: every legal message is receivable
 * ---------------------------------------------------------------- */

// The read limit is above every frame the protocol allows, so a frame over the
// advertised batch cap is read and refused with a code rather than dropped at
// the socket. Before this the limit was 8 MiB and a legal 256 entry batch was
// 17 MB: the connection closed with nothing said and the client retried the
// identical batch for ever.
func TestS22AFrameOverTheBatchCapIsRefusedNotDisconnected(t *testing.T) {
	// The arithmetic, pinned against the constants it is about.
	if ReadLimit < wire.MaxBatchBytes {
		t.Fatalf("ReadLimit %d is below MaxBatchBytes %d", ReadLimit, wire.MaxBatchBytes)
	}
	largestPut := store.MaxPathLen + store.MaxChunksPerEntry*(chunks.NameLen+3) + 4096
	if ReadLimit < largestPut {
		t.Fatalf("ReadLimit %d is below the largest single put, about %d", ReadLimit, largestPut)
	}
	if ReadLimit < store.ChunkMax {
		t.Fatalf("ReadLimit %d is below ChunkMax %d", ReadLimit, store.ChunkMax)
	}
	hello, _ := json.Marshal(wire.In{Op: "hello", ID: wire.MaxRequestID, Proto: wire.Proto, Crypto: wire.Crypto,
		Vault: strings.Repeat("v", store.MaxVaultLen), Device: strings.Repeat("d", store.MaxDeviceLen),
		Token: strings.Repeat("t", 64), Claim: strings.Repeat("c", 64),
		Wrapped: strings.Repeat("w", store.MaxWrappedLen), Cursor: 1 << 62})
	if HelloReadLimit < len(hello) {
		t.Fatalf("HelloReadLimit %d is below the largest hello, %d bytes", HelloReadLimit, len(hello))
	}

	// End to end: a putmany just over the cap, well under the read limit.
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	names := make([]string, 0, 1000)
	for i := 0; i < 1000; i++ {
		names = append(names, chunks.Name([]byte{byte(i), byte(i >> 8)}))
	}
	entries := make([]wire.PutEntry, 0, wire.MaxBatchEntries)
	for i := 0; i < wire.MaxBatchEntries; i++ {
		entries = append(entries, wire.PutEntry{Path: strings.Repeat("p", 64), Chunks: names, Mac: testMac,
			Meta: wire.PutMeta{Size: 1, MTime: 1}})
	}
	frame, _ := json.Marshal(wire.In{Op: "putmany", ID: 1, Entries: entries})
	if int64(len(frame)) <= wire.MaxBatchBytes || len(frame) >= ReadLimit {
		t.Fatalf("the test frame is %d bytes; it must sit between %d and %d", len(frame), wire.MaxBatchBytes, ReadLimit)
	}
	cl.sendJSON(wire.In{Op: "putmany", Entries: entries})
	msg := cl.expectErr(wire.CodeToolarge)
	if !strings.Contains(msg, "frame") {
		t.Fatalf("the refusal does not name the frame: %q", msg)
	}
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

/* ---------------------------------------------------------------- *
 * S21: the fetch byte cap
 * ---------------------------------------------------------------- */

// A fetch whose bodies sum to more than maxFetchBytes is refused with toolarge
// and no bodies, and the session continues. The cap is lowered for the test so
// it does not need 64 MiB of chunk bodies to reach.
func TestS21AFetchOverTheByteCapIsRefusedWithNoBodies(t *testing.T) {
	r := newRig(t)
	r.srv.maxFetchBytes = 40
	e := r.seed("note.md", strings.Repeat("a", 16), strings.Repeat("b", 16), strings.Repeat("c", 16))
	cl := r.dial("a")
	if ready, _ := cl.hello(0); ready.MaxFetchBytes != 40 {
		t.Fatalf("advertised %d, enforcing 40", ready.MaxFetchBytes)
	}

	cl.sendJSON(wire.In{Op: "fetch", Chunks: e.Chunks})
	msg := cl.expectErr(wire.CodeToolarge)
	if !strings.Contains(msg, "smaller") {
		t.Fatalf("the refusal does not say what to do: %q", msg)
	}
	// Nothing followed the refusal: the next frame is the pong.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
	// Under the cap, in two asks, everything comes down.
	if got := cl.fetch(e.Chunks[0], e.Chunks[1]); len(got) != 2 {
		t.Fatalf("fetched %d bodies", len(got))
	}
	if got := cl.fetch(e.Chunks[2]); string(got[0]) != strings.Repeat("c", 16) {
		t.Fatalf("fetched %q", got[0])
	}
}

/* ---------------------------------------------------------------- *
 * S19: pre-auth bounds
 * ---------------------------------------------------------------- */

// A connection that says nothing is closed at the hello deadline, with a
// reason, rather than holding a goroutine and a buffer for ever.
func TestS19AConnectionThatNeverSaysHelloIsClosedAtTheDeadline(t *testing.T) {
	r := newRig(t)
	r.srv.helloTimeout = 200 * time.Millisecond
	cl := r.dial("silent")
	start := time.Now()
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeProtoState {
		t.Fatalf("the silent connection was told %v", f)
	}
	if !cl.closed() {
		t.Fatal("the silent connection was told off and left open")
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("closing took %s, the deadline was 200ms", took)
	}
	waitFor(t, "the session to be forgotten", func() bool { return r.srv.PreAuth() == 0 })
}

// Connections that have not said hello are capped as a total, so a flood of
// sockets that never authenticate cannot exhaust the server. A refused one is
// told busy; a slot opens as soon as one of them authenticates or goes away.
func TestS19PreAuthConnectionsAreCapped(t *testing.T) {
	r := newRig(t)
	r.srv.maxPreAuth = 2
	a := r.dial("a")
	b := r.dial("b")
	waitFor(t, "two pre-auth sessions", func() bool { return r.srv.PreAuth() == 2 })

	c := r.dial("c")
	f := rawFields(t, c.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeBusy {
		t.Fatalf("the third connection was told %v, want busy", f)
	}
	if !c.closed() {
		t.Fatal("the third connection was admitted past the cap")
	}

	// One authenticates: it leaves the count and a slot opens.
	a.hello(0)
	waitFor(t, "the count to drop", func() bool { return r.srv.PreAuth() == 1 })
	d := r.dial("d")
	d.hello(0)
	waitFor(t, "the count to hold", func() bool { return r.srv.PreAuth() == 1 })

	// One goes away without ever saying hello: it leaves the count too.
	b.conn.CloseNow()
	waitFor(t, "the closed connection to be forgotten", func() bool { return r.srv.PreAuth() == 0 })
	if got := r.srv.Peers(testVault); got != 2 {
		t.Fatalf("%d peers joined, want a and d", got)
	}
}

/* ---------------------------------------------------------------- *
 * S23: the queued fatal frame is delivered
 * ---------------------------------------------------------------- */

// S23 claimed an enqueue/drain window that could drop the final error frame.
// Against the current code no such window was found: enqueue reserves both
// counters before the frame is offered, drain waits on inflight, and inflight
// is released only after the write returns (S8, S10). This pins the property
// the claim was about, under the one concurrency the design allows: a session
// ending itself with a reason while a shutdown races to close it. Every
// session must be told something before the socket closes.
func TestS23AFatalFrameQueuedBeforeCloseIsAlwaysDelivered(t *testing.T) {
	for round := 0; round < 5; round++ {
		r := newRig(t)
		const n = 6
		peers := make([]*client, n)
		for i := range peers {
			peers[i] = r.dial("p")
			peers[i].hello(0)
		}
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			shutdownRig(t, r)
		}()
		// Each peer sends a malformed frame the moment shutdown starts, so
		// its own protostate fatal races the shutdown notice.
		for _, p := range peers {
			_ = p.conn.Write(p.ctx, websocket.MessageText, []byte("{not json"))
		}
		for _, p := range peers {
			f := rawFields(t, p.recvRaw())
			if f["res"] != "err" {
				t.Fatalf("a peer's first frame after the race was %v", f)
			}
		}
		wg.Wait()
		for _, p := range peers {
			p.conn.CloseNow()
		}
	}
}

/* ---------------------------------------------------------------- *
 * S27: a commit fault keeps the session
 * ---------------------------------------------------------------- */

// The database refusing a commit is the server's fault, not the entry's. The
// put is refused with internal, retryable, and the session continues, so the
// client retries the put rather than reconnecting and replaying its handshake.
func TestS27ACommitFaultRefusesThePutAndKeepsTheSession(t *testing.T) {
	r := newRig(t)
	var once sync.Once
	fault := errors.New("database is locked")
	r.srv.beforeAppend = func(store.Entry) error {
		var err error
		once.Do(func() { err = fault })
		return err
	}
	cl := r.dial("a")
	cl.hello(0)

	names, size := chunkNames([]string{"body"})
	cl.sendJSON(wire.In{Op: "put", ID: 3, Path: "note.md", Chunks: names, Mac: testMac,
		Meta: wire.PutMeta{Size: size, MTime: 1}})
	cl.recvInto("want", &wire.Want{})
	cl.sendBinary([]byte("body"))
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeInternal || f["id"] != float64(3) || f["retryable"] != true {
		t.Fatalf("the faulted put was answered %v", f)
	}
	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("%d versions committed through a faulted commit", st.Versions)
	}

	// The session is still there, and the retry lands.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
	if uid := cl.put("note.md", "body"); uid != 1 {
		t.Fatalf("the retry got uid %d", uid)
	}
	r.mustVerify()

	// In a batch it is one entry's result, and the others still commit.
	r2 := newRig(t)
	r2.srv.beforeAppend = func(e store.Entry) error {
		if e.Path == "faulty.md" {
			return fault
		}
		return nil
	}
	c2 := r2.dial("b")
	c2.hello(0)
	c2.sendJSON(wire.In{Op: "putmany", Entries: []wire.PutEntry{
		{Path: "ok.md", Mac: testMac, Meta: wire.PutMeta{Folder: true}},
		{Path: "faulty.md", Mac: testMac, Meta: wire.PutMeta{Folder: true}},
	}})
	var acks wire.Acks
	c2.recvInto("acks", &acks)
	if acks.Results[0].UID != 1 || acks.Results[1].Code != wire.CodeInternal {
		t.Fatalf("batch results %+v", acks.Results)
	}
	c2.sendJSON(wire.In{Op: "ping"})
	c2.recvInto("pong", &wire.Pong{})
}
