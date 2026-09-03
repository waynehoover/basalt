package server

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// Graceful shutdown, review finding S16: http.Server.Shutdown stops the listener and
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

// A commit still running at the deadline holds the shutdown until it is done.
//
// Shutdown used to kill what was left and then wait one second, returning an
// error whether or not the sessions had gone. main closes the store on the
// next line, so a commit that outlived that second met a closed database: the
// put failed with `internal` on a request the client had been told nothing
// about, and the reason was a race rather than anything the client did. The
// wait is now for the sessions themselves.
func TestS16ShutdownWaitsForACommitThatOutlivesTheDeadline(t *testing.T) {
	r := newRig(t)
	cl := r.dial("committing")
	cl.hello(0)

	// The commit is held open from inside, standing in for a database that is
	// simply slow: the session is mid-request, past its bodies, and cannot be
	// hurried.
	committing := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	r.srv.beforeAppend = func(store.Entry) error {
		once.Do(func() { close(committing) })
		<-release
		return nil
	}

	bodies := []string{"a body worth committing"}
	names, size := chunkNames(bodies)
	cl.sendJSON(wire.In{
		Op: "put", Path: "note.md", Chunks: names, Mac: testMac,
		Meta: wire.PutMeta{Size: size, MTime: 5},
	})
	cl.recvInto("want", &wire.Want{})
	cl.sendBinary([]byte(bodies[0]))
	<-committing

	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		done <- r.srv.Shutdown(ctx)
	}()

	// Well past the deadline and past the second the old grace allowed. The
	// session is killed by now; what must not have happened is Shutdown
	// returning, because the store closes as soon as it does.
	select {
	case err := <-done:
		t.Fatalf("shutdown returned (%v) with a commit still running, and main closes the store next", err)
	case <-time.After(1500 * time.Millisecond):
	}
	if n := r.srv.Sessions(); n != 1 {
		t.Fatalf("%d sessions registered while one is still committing, want 1", n)
	}

	close(release)
	err := <-done
	if err == nil {
		t.Fatal("shutdown reported a clean stop after cutting off a request")
	}
	if !strings.Contains(err.Error(), "1 sessions") {
		t.Fatalf("shutdown reported %v, which does not say how many were cut off", err)
	}
	if n := r.srv.Sessions(); n != 0 {
		t.Fatalf("%d sessions still registered after shutdown returned", n)
	}
	r.mustVerify()
}
