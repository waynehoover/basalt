package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// The send queue, the keepalive that has to live alongside it, and the
// handover from catch-up to live delivery. Review findings S1, S2, S8 and S10.

// seedBodies puts n one-mebibyte bodies in the vault and returns their names,
// so a fetch can be made to carry several times the send budget.
func seedBodies(t *testing.T, r *rig, n int) []string {
	t.Helper()
	names := make([]string, n)
	for i := range names {
		b := bytes.Repeat([]byte{byte(i + 1)}, 1<<20)
		names[i] = chunks.Name(b)
		if err := r.st.Chunks().Put(testVault, names[i], b); err != nil {
			t.Fatalf("seed body: %v", err)
		}
	}
	return names
}

// readBodiesSlowly reads n binary frames, pausing after each, the way a client
// on a slow link would, and fails on anything else.
func readBodiesSlowly(t *testing.T, cl *client, names []string, pause time.Duration) {
	t.Helper()
	cl.expectBodies(len(names))
	for i, want := range names {
		typ, data, err := cl.read()
		if err != nil {
			t.Fatalf("cut off after %d of %d bodies: %v", i, len(names), err)
		}
		if typ != websocket.MessageBinary {
			t.Fatalf("body %d: got a text frame instead: %s", i, data)
		}
		if got := chunks.Name(data); got != want {
			t.Fatalf("body %d is %s, want %s", i, got, want)
		}
		time.Sleep(pause)
	}
}

// S1: a ping that reaches the client just ahead of a request must not count
// against it when serving that request keeps the session out of its read for
// longer than PongWait.
//
// The sequence is ordinary. The server pings an idle session; at the same
// moment the client asks for a large fetch; the client's pong follows its
// request onto the wire. The server reads the request first and spends the
// next second sending bodies, during which nothing reads the pong, so the ping
// times out. Skipping pings while the session is sending does not cover this,
// because the ping was sent while it was reading. What covers it is treating a
// timeout the session was not reading for as no verdict.
//
// The client's ping hook writes the fetch before the library answers the ping,
// which puts the request ahead of the pong exactly as described.
func TestS1APingAnsweredBehindARequestIsNotHeldAgainstTheClient(t *testing.T) {
	r := newRig(t)
	r.srv.pingEvery = 50 * time.Millisecond
	r.srv.pongWait = 400 * time.Millisecond
	// 32 MiB at 40 ms per body is over a second of sending, most of it blocked
	// on the byte budget, and all of it longer than the pong window.
	names := seedBodies(t, r, 32)

	var cl *client
	var armed atomic.Bool
	var fetched atomic.Bool
	cl = r.dialWith("slow-but-alive", &websocket.DialOptions{
		OnPingReceived: func(ctx context.Context, payload []byte) bool {
			// Runs on the goroutine that called Read, before the pong is
			// written. Armed only after the handshake so a ping during hello
			// does not start the fetch early.
			if armed.Load() && fetched.CompareAndSwap(false, true) {
				cl.sendJSON(wire.In{Op: "fetch", Chunks: names})
			}
			return true
		},
	})
	cl.hello(0)
	armed.Store(true)

	readBodiesSlowly(t, cl, names, 40*time.Millisecond)
	if !fetched.Load() {
		t.Fatal("no ping arrived before the bodies did, so the sequence under test never happened")
	}

	// Still there, and the keepalive is still running against a session that is
	// back in its read.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

// S1: no ping goes out behind frames the client has not read yet.
//
// A ping is a frame like any other and lands behind whatever is queued. When
// the queue holds the tail of a fetch, the client reaches the ping only after
// reading all of it, which on a slow link is longer than PongWait however
// promptly it then answers. Skipping pings while the session is sending misses
// this too: the session has finished sending and is back in its read, with
// eight mebibytes still queued behind it.
//
// Asserted at the decision rather than by waiting for the symptom, because the
// symptom depends on how much the kernel buffers, which differs by platform.
func TestS1NoPingIsSentWhileFramesAreStillQueued(t *testing.T) {
	r := newRig(t)
	r.srv.pingEvery = 20 * time.Millisecond
	r.srv.pongWait = 5 * time.Second // never the reason for a failure here
	names := seedBodies(t, r, 24)

	cl := r.dial("slow-link")
	cl.hello(0)
	peer := r.onlyPeer()

	var pings, pingsBehindData atomic.Int64
	r.srv.beforePing = func() {
		pings.Add(1)
		if peer.inflight.Load() > 0 {
			pingsBehindData.Add(1)
		}
	}

	cl.sendJSON(wire.In{Op: "fetch", Chunks: names})
	// 60 ms per body: the last eight are queued for half a second after the
	// session has enqueued them and returned to its read.
	readBodiesSlowly(t, cl, names, 60*time.Millisecond)

	// Idle again and answering, so pings resume once the queue is empty.
	waitFor(t, "a ping to be sent once the queue is empty", func() bool { return pings.Load() > 0 })
	if n := pingsBehindData.Load(); n != 0 {
		t.Fatalf("%d pings were sent with frames still queued ahead of them", n)
	}
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

// S1: leaving a sending session alone is only safe because something else
// bounds it. A peer that stops reading in the middle of a fetch is reaped by
// the write timing out, within writeWait of the socket filling.
func TestS1APeerThatStopsReadingMidFetchIsStillReaped(t *testing.T) {
	r := newRig(t)
	r.srv.pingEvery = time.Hour // so only the write path can end this
	r.srv.writeWait = 300 * time.Millisecond
	names := seedBodies(t, r, 24)

	cl := r.dial("gone")
	cl.hello(0)
	if got := r.srv.hub.peerCount(testVault); got != 1 {
		t.Fatalf("%d peers after connecting, want 1", got)
	}
	// Ask for 24 MiB and read none of it. The socket fills, the write blocks,
	// and writeWait later the session is gone.
	cl.sendJSON(wire.In{Op: "fetch", Chunks: names})

	waitFor(t, "the stalled peer to be reaped", func() bool {
		return r.srv.hub.peerCount(testVault) == 0
	})
}

// S2: the handover from catch-up to live delivery waits for room in the queue
// rather than dropping the peer.
//
// The queue is often full at that moment: the replay that just finished fills
// it as fast as the client drains it. Queueing the buffered changes and
// caught-up with a non-blocking send would drop every slow client at the end of
// every catch-up, and its reconnect would replay and hit the same wall.
// Waiting under the handover lock is not an option either, because deliver
// takes that lock, so the wait releases it and retries.
func TestS2AHandoverIntoAFullQueueWaitsForRoomInsteadOfDroppingThePeer(t *testing.T) {
	r := newRig(t)
	r.seed("a.md", "backlog one")
	r.seed("b.md", "backlog two")

	// Fill the byte budget from inside the handshake, on the session's own
	// goroutine, so the flush that follows finds no room. A late change is
	// committed too, so there is something in pending to flush.
	filler := bytes.Repeat([]byte{7}, 1<<20)
	var filled atomic.Int64
	var late store.Entry
	r.srv.afterReplay = func() {
		peer := r.onlyPeer()
		late = r.seed("late.md", "landed during the replay")
		r.srv.hub.broadcast(testVault, late, nil)
		for peer.enqueue(websocket.MessageBinary, filler) {
			filled.Add(1)
		}
	}

	cl := r.dial("slow")
	cl.sendJSON(helloMsg(testVault, testToken, "slow", 0))

	// Read everything: filler, batches and caught-up. The filler is skipped,
	// the batches are checked for continuity, and caught-up must name the late
	// change's uid.
	var cursor int64
	for {
		typ, data, err := cl.read()
		if err != nil {
			t.Fatalf("the peer was dropped during the handover (after %d filler frames): %v", filled.Load(), err)
		}
		if typ == websocket.MessageBinary {
			continue
		}
		var probe struct {
			Res    string `json:"res"`
			Op     string `json:"op"`
			From   int64  `json:"from"`
			To     int64  `json:"to"`
			Cursor int64  `json:"cursor"`
		}
		if err := json.Unmarshal(data, &probe); err != nil {
			t.Fatalf("decode %q: %v", data, err)
		}
		if probe.Res == "ready" {
			continue
		}
		switch probe.Op {
		case "batch":
			if probe.From != cursor+1 {
				t.Fatalf("gap: batch [%d,%d] after cursor %d", probe.From, probe.To, cursor)
			}
			cursor = probe.To
			continue
		case "caught-up":
			if probe.Cursor != cursor || cursor != late.UID {
				t.Fatalf("caught-up at %d, batches reached %d, the late change is %d",
					probe.Cursor, cursor, late.UID)
			}
		default:
			t.Fatalf("unexpected frame: %s", data)
		}
		break
	}
	if filled.Load() == 0 {
		t.Fatal("the queue was never filled, so this proved nothing")
	}

	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

// S8: fan-out frames are counted against the byte budget like every other
// frame, and the counter never goes below zero.
//
// trySend used to put a frame on the queue without adding its size, while the
// writer subtracted every frame it wrote. Three fan-out frames later the
// counter read minus a few hundred bytes, and from then on the byte bound was
// off: a fetch could queue until the frame limit, which is the quarter of a
// gigabyte SendQueueBytes exists to prevent.
func TestS8FanOutFramesAreCountedAndBounded(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	peer := r.onlyPeer()

	// Counted: after three fan-out frames have been read, the counter is back
	// at zero, not below it.
	pong, _ := json.Marshal(wire.Pong{Res: "pong"})
	for i := 0; i < 3; i++ {
		if !peer.trySend(websocket.MessageText, pong) {
			t.Fatalf("frame %d refused on an empty queue", i)
		}
	}
	for i := 0; i < 3; i++ {
		cl.recvInto("pong", nil)
	}
	waitFor(t, "the frames to be written", func() bool { return peer.inflight.Load() <= 0 })
	if q, f := peer.queued.Load(), peer.inflight.Load(); q != 0 || f != 0 {
		t.Fatalf("queued = %d bytes and inflight = %d frames after every frame was written, want 0 and 0", q, f)
	}

	// Bounded: the client stops reading, and mebibyte fan-out frames are
	// refused, and the peer dropped, long before the frame limit would have
	// let 256 of them through.
	big := bytes.Repeat([]byte{9}, 1<<20)
	accepted := 0
	for i := 0; i < 32; i++ {
		if !peer.trySend(websocket.MessageBinary, big) {
			break
		}
		accepted++
	}
	if accepted >= 32 {
		t.Fatalf("%d MiB of fan-out was queued for a peer that is not reading", accepted)
	}
	select {
	case <-peer.dead:
	case <-time.After(5 * time.Second):
		t.Fatal("the peer was not dropped when the byte budget ran out")
	}
	if q := peer.queued.Load(); q < 0 {
		t.Fatalf("queued = %d, below zero", q)
	}
}

// S8: the catch-up buffer is bounded in bytes as well as entries.
//
// Four thousand entries sounds like a bound until one of them names sixty
// thousand chunks. Three such batches are more than the whole send budget, and
// they must drop the peer rather than sit in memory waiting for a replay to
// finish.
func TestS8TheCatchUpBufferIsBoundedInBytesAsWellAsEntries(t *testing.T) {
	r := newRig(t)
	r.seed("seed.md", "backlog")

	entered := make(chan struct{})
	hold := make(chan struct{})
	var once sync.Once
	r.srv.afterReplay = func() {
		once.Do(func() { close(entered) })
		<-hold
	}
	defer func() {
		select {
		case <-hold:
		default:
			close(hold)
		}
	}()

	cl := r.dial("a")
	cl.sendJSON(helloMsg(testVault, testToken, "a", 0))
	<-entered
	peer := r.onlyPeer()

	names := make([]string, 60_000)
	for i := range names {
		names[i] = chunks.Name([]byte(fmt.Sprint(i)))
	}
	// Each marshals to about four megabytes; three exceed CatchupBufferBytes
	// and are nowhere near CatchupBufferMax.
	for i := 0; i < 3; i++ {
		peer.deliver(store.Entry{
			UID: int64(1000 + i), Path: "big.md", Size: 1, MTime: 1, Chunks: names, Mac: testMac,
		}, false)
	}
	select {
	case <-peer.dead:
	case <-time.After(5 * time.Second):
		t.Fatal("a session buffering more than the byte bound during catch-up was not dropped")
	}
	close(hold)
}

// S10: drain waits for the last frame to finish being written, not merely to
// leave the channel.
//
// Handle drains and then closes. The writer takes a frame off the channel and
// then spends as long as the write takes, up to WriteWait, and the old drain
// considered the job done twenty milliseconds after the channel emptied. A
// client that was slow to read the final frame had the socket closed under it
// halfway through, which for a fatal error frame means a bare disconnect and
// for a body means a truncated download.
func TestS10DrainWaitsForTheLastFrameToFinishWriting(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.conn.SetReadLimit(32 << 20)
	peer := r.onlyPeer()

	// A marker first, then a frame too large for any socket buffer, so the
	// write of the last frame cannot complete until the client reads it.
	marker := []byte{1}
	big := bytes.Repeat([]byte{2}, 16<<20)
	if err := peer.send(websocket.MessageBinary, marker); err != nil {
		t.Fatalf("send marker: %v", err)
	}
	if err := peer.send(websocket.MessageBinary, big); err != nil {
		t.Fatalf("send big: %v", err)
	}

	got := make(chan int, 1)
	go func() {
		if _, _, err := cl.conn.Read(cl.ctx); err != nil {
			got <- -1
			return
		}
		// Slow to get to the last frame.
		time.Sleep(300 * time.Millisecond)
		_, data, err := cl.conn.Read(cl.ctx)
		if err != nil {
			got <- -1
			return
		}
		got <- len(data)
	}()

	// What Handle does once run has returned.
	start := time.Now()
	peer.drain(5 * time.Second)
	waited := time.Since(start)
	peer.kill(nil)

	if n := <-got; n != len(big) {
		t.Fatalf("the client received %d bytes of the last frame; drain returned after %v "+
			"and the socket was closed mid-write", n, waited)
	}
}
