package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// Graceful shutdown. TODO.md S16: http.Server.Shutdown stops the listener and
// waits for ordinary requests, but a hijacked WebSocket is not its connection
// any more, so the server used to return from shutdown with every session
// still open and then close the store under them. These pin what Shutdown does
// instead; the cmd package has the end-to-end SIGTERM test.

// closingBegun reports whether Shutdown has flipped the admission flag, which
// is the moment a test can rely on in-flight requests being treated as such.
func closingBegun(r *rig) bool {
	r.srv.sessMu.Lock()
	defer r.srv.sessMu.Unlock()
	return r.srv.closing
}

// An idle session is told why and closed; a connection arriving afterwards is
// refused with the same reason rather than admitted to a server about to go.
func TestS16ShutdownClosesIdleSessionsWithAReasonAndRefusesNewOnes(t *testing.T) {
	r := newRig(t)
	cl := r.dial("idle")
	cl.hello(0)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown with one idle session: %v", err)
	}
	if n := r.srv.Sessions(); n != 0 {
		t.Fatalf("%d sessions still registered after shutdown returned", n)
	}

	msg := cl.expectErr(wire.CodeBusy)
	if !strings.Contains(msg, "shutting down") {
		t.Fatalf("the reason does not say the server is stopping: %q", msg)
	}
	if !cl.closed() {
		t.Fatal("the idle session was told the server is stopping and then left open")
	}

	late := r.dial("late")
	late.sendJSON(helloMsg(testVault, testToken, "late", 0))
	late.expectErr(wire.CodeBusy)
	if !late.closed() {
		t.Fatal("a connection made during shutdown was admitted")
	}
}

// A put that has started is finished: its bodies are read, its entry is
// committed, and its ack goes out before the reason and the close. An ack means
// stored, and a shutdown must not turn a stored entry into an unacked one.
func TestS16ShutdownLetsAPutInFlightFinishAndAcksIt(t *testing.T) {
	r := newRig(t)
	cl := r.dial("uploading")
	cl.hello(0)

	bodies := []string{"first half", "second half"}
	names, size := chunkNames(bodies)
	cl.sendJSON(wire.In{
		Op: "put", Path: "note.md", Chunks: names, Mac: testMac,
		Meta: wire.PutMeta{Size: size, MTime: 5},
	})
	var want wire.Want
	cl.recvInto("want", &want)
	cl.sendBinary([]byte(bodies[0]))

	// Shutdown begins with one body still to come.
	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		done <- r.srv.Shutdown(ctx)
	}()
	waitFor(t, "shutdown to begin", func() bool { return closingBegun(r) })

	cl.sendBinary([]byte(bodies[1]))
	var ack wire.Ack
	cl.recvInto("ack", &ack)
	cl.expectErr(wire.CodeBusy)
	if !cl.closed() {
		t.Fatal("the session stayed open after its last request was acked during shutdown")
	}
	if err := <-done; err != nil {
		t.Fatalf("shutdown reported a problem after the upload it waited for finished: %v", err)
	}

	// The ack was truthful: the entry is in the store with its bodies.
	e, ok, err := r.st.EntryByUID(testVault, ack.UID)
	if err != nil || !ok {
		t.Fatalf("acked uid %d is not in the store: ok=%v err=%v", ack.UID, ok, err)
	}
	if e.Path != "note.md" || len(e.Chunks) != 2 {
		t.Fatalf("stored entry is %+v", e)
	}
	r.mustVerify()
}

// A put that never finishes is cut off at the deadline with nothing committed
// and nothing acked, which is a clean retry for the client. The shutdown says
// so rather than reporting a tidy stop.
func TestS16ShutdownDeadlineCutsOffAStalledUploadUnacked(t *testing.T) {
	r := newRig(t)
	cl := r.dial("stalled")
	cl.hello(0)

	names, size := chunkNames([]string{"arrives", "never arrives"})
	cl.sendJSON(wire.In{
		Op: "put", Path: "note.md", Chunks: names, Mac: testMac,
		Meta: wire.PutMeta{Size: size, MTime: 5},
	})
	cl.recvInto("want", &wire.Want{})
	cl.sendBinary([]byte("arrives"))

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	err := r.srv.Shutdown(ctx)
	if err == nil {
		t.Fatal("shutdown reported a clean stop with an upload still in flight")
	}
	if n := r.srv.Sessions(); n != 0 {
		t.Fatalf("%d sessions still registered after the deadline", n)
	}
	// No ack, no reason, a bare close: the client retries.
	if !cl.closed() {
		t.Fatal("the stalled session outlived the shutdown deadline")
	}
	if st := r.mustStats(); st.Versions != 0 {
		t.Fatalf("%d versions committed from an upload that never completed", st.Versions)
	}
}
