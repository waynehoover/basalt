package server

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// The buffering logic on its own, with no connection involved.
//
// A Session needs only its send queue for this, which is the point: the ordering
// rule is not tangled up in the transport.
func newBareSession(t *testing.T, depth int) *Session {
	t.Helper()
	return &Session{
		out: make(chan outFrame, depth),
		// A real server, because every s.srv dereference in the session is
		// unguarded: an overflow in deliver calls kill, and kill logs.
		srv:  &Server{log: testLogger()},
		dead: make(chan struct{}),
	}
}

func drainBatchFrames(t *testing.T, s *Session) []wire.Batch {
	t.Helper()
	var out []wire.Batch
	for {
		select {
		case f := <-s.out:
			if f.typ != websocket.MessageText {
				t.Fatalf("expected a text frame, got binary")
			}
			var b wire.Batch
			if err := json.Unmarshal(f.data, &b); err != nil {
				t.Fatalf("decode %q: %v", f.data, err)
			}
			// flushPending queues caught-up on the same channel now. These
			// tests are about the batches around it, not caught-up itself,
			// which its own test covers.
			if b.Op == "caught-up" {
				continue
			}
			out = append(out, b)
		default:
			return out
		}
	}
}

// Two entries can commit in uid order and reach the hub in the opposite order,
// because AppendEntry releases the store's write lock before the fan-out runs.
// The flush has to put them back in order, or a client's continuity check fires
// on a healthy vault.
func TestBufferedLiveChangesAreReleasedInUIDOrder(t *testing.T) {
	s := newBareSession(t, 16)

	// Delivered out of order, which is exactly what the hub can produce.
	s.deliver(store.Entry{UID: 7, Path: "c.md"}, false)
	s.deliver(store.Entry{UID: 5, Path: "a.md"}, false)
	s.deliver(store.Entry{UID: 6, Path: "b.md"}, false)

	// Nothing may reach the wire before the backlog does.
	if got := drainBatchFrames(t, s); len(got) != 0 {
		t.Fatalf("%d frames written during catch-up: %v", len(got), got)
	}

	// The replay covered up to uid 5, so that one is already delivered.
	cursor := s.flushPending(5)
	if cursor != 7 {
		t.Fatalf("flush reached cursor %d, want 7", cursor)
	}

	got := drainBatchFrames(t, s)
	if len(got) != 2 {
		t.Fatalf("flushed %d batches, want 2: %v", len(got), got)
	}
	for i, wantUID := range []int64{6, 7} {
		if got[i].From != wantUID || got[i].To != wantUID {
			t.Fatalf("batch %d is [%d,%d], want [%d,%d]",
				i, got[i].From, got[i].To, wantUID, wantUID)
		}
	}
	if got[0].Entries[0].Path != "b.md" || got[1].Entries[0].Path != "c.md" {
		t.Fatalf("flushed the wrong entries: %v", got)
	}
}

// After the handover, changes go straight out. If they kept buffering, a live
// vault would go quiet after its first catch-up.
func TestLiveChangesGoDirectAfterTheHandover(t *testing.T) {
	s := newBareSession(t, 16)
	s.flushPending(0)

	s.deliver(store.Entry{UID: 1, Path: "a.md"}, false)
	got := drainBatchFrames(t, s)
	if len(got) != 1 || got[0].To != 1 {
		t.Fatalf("got %v, want one batch at uid 1", got)
	}
}

// The pushing device gets the range and not the payload. Both halves matter:
// without the range its cursor falls behind by one per push, and with the
// payload it is back to having to recognise its own write.
func TestTheOriginGetsTheRangeWithoutThePayload(t *testing.T) {
	s := newBareSession(t, 16)
	s.flushPending(0)

	s.deliver(store.Entry{UID: 4, Path: "mine.md", Size: 10}, true)
	got := drainBatchFrames(t, s)
	if len(got) != 1 {
		t.Fatalf("got %d batches, want 1", len(got))
	}
	if got[0].From != 4 || got[0].To != 4 {
		t.Fatalf("range is [%d,%d], want [4,4]", got[0].From, got[0].To)
	}
	if len(got[0].Entries) != 0 {
		t.Fatalf("the origin was sent its own entry: %v", got[0].Entries)
	}
	// Empty, not null. A client that iterates entries must not have to special
	// case the batches it receives most often.
	frame, err := json.Marshal(liveBatch(store.Entry{UID: 4}, true))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(frame), `"entries":[]`) {
		t.Fatalf("elided batch marshals as %s, want an empty array", frame)
	}
}

/* ---------------------------------------------------------------- *
 * Catch-up before live changes, end to end
 * ---------------------------------------------------------------- */

// A change committed while a session is mid-replay must arrive after the
// backlog, not in the middle of it.
//
// Arriving early would put a newer uid ahead of older catch-up frames in the
// same queue, and a client that advances its cursor to a batch's To would step
// past files it has not received. The commit is triggered from inside the
// replay so the timing is a fact rather than a hope.
func TestAChangeCommittedDuringCatchUpArrivesAfterTheBacklog(t *testing.T) {
	r := newRig(t)
	// One entry per batch, so there is a middle to interrupt.
	r.srv.batchSize = 1

	const seeded = 6
	for i := 0; i < seeded; i++ {
		r.seed(fmt.Sprintf("f%d.md", i), fmt.Sprintf("body %d", i))
	}

	var once sync.Once
	interrupted := make(chan store.Entry, 1)
	r.srv.afterReplayBatch = func(n int) {
		// After the second batch of six, so the interruption lands squarely in
		// the middle of the replay.
		if n != 2 {
			return
		}
		once.Do(func() {
			interrupted <- r.seed("live.md", "committed mid catch-up")
		})
	}

	cl := r.dial("a")
	ready, entries := cl.hello(0)
	live := <-interrupted

	if ready.Cursor != seeded {
		t.Fatalf("ready cursor = %d, want %d", ready.Cursor, seeded)
	}
	if live.UID != seeded+1 {
		t.Fatalf("the interrupting commit got uid %d, want %d", live.UID, seeded+1)
	}

	// hello asserts From == cursor+1 on every batch as it reads, so reaching
	// here at all means nothing arrived out of order. What is left to check is
	// that everything arrived, and that the late entry is last.
	if len(entries) != seeded+1 {
		t.Fatalf("received %d entries, want %d: %v", len(entries), seeded+1, uidsOf(entries))
	}
	for i, e := range entries {
		if e.UID != int64(i+1) {
			t.Fatalf("entry %d has uid %d; order is %v", i, e.UID, uidsOf(entries))
		}
	}
	if entries[len(entries)-1].Path != "live.md" {
		t.Fatalf("the mid-catch-up commit is not last: %v", uidsOf(entries))
	}
	// Exactly once. The entry is both picked up by the replay, which keeps
	// asking until the store has nothing newer, and buffered by the fan-out.
	// The flush skipping what the replay already covered is what stops the
	// client receiving it twice.
	seen := map[int64]int{}
	for _, e := range entries {
		seen[e.UID]++
		if seen[e.UID] > 1 {
			t.Fatalf("uid %d delivered %d times: %v", e.UID, seen[e.UID], uidsOf(entries))
		}
	}
}

// The window between the replay's last query and the release of buffered
// changes.
//
// An entry committed here is in neither: the replay has already asked the store
// for the last time, and the flush only has what the fan-out gave it. It
// reaches the client only because the session joined the fan-out before reading
// the backlog rather than after. Joining afterwards leaves exactly this gap, and
// it loses exactly one file.
func TestAChangeCommittedAfterTheLastQueryStillArrives(t *testing.T) {
	r := newRig(t)
	for i := 0; i < 3; i++ {
		r.seed(fmt.Sprintf("f%d.md", i), fmt.Sprintf("body %d", i))
	}

	var once sync.Once
	var late store.Entry
	r.srv.afterReplay = func() {
		once.Do(func() {
			// Committed and announced the way a concurrent push would be, so
			// the only route to the client is the fan-out.
			late = r.seed("late.md", "landed in the window")
			r.srv.hub.broadcast(testVault, late, nil)
		})
	}

	cl := r.dial("a")
	_, entries := cl.hello(0)

	if len(entries) != 4 {
		t.Fatalf("received %d entries, want 4: the one committed in the window was lost (%v)",
			len(entries), uidsOf(entries))
	}
	if entries[3].UID != late.UID || entries[3].Path != "late.md" {
		t.Fatalf("last entry is %+v, want the late one at uid %d", entries[3], late.UID)
	}
}

/* ---------------------------------------------------------------- *
 * Fan-out order under concurrent pushes
 * ---------------------------------------------------------------- */

// Live batches must leave the server in uid order even when several devices
// push at once.
//
// This is what commitMu buys. Without it, appending and announcing are two
// steps, so uid 6 can be announced before uid 5 and an observer's continuity
// check fires on a vault that is perfectly healthy. An assertion that cries
// wolf gets switched off, which is worse than never having had it.
func TestConcurrentPushesFanOutInUIDOrder(t *testing.T) {
	r := newRig(t)

	observer := r.dial("observer")
	observer.hello(0)

	const pushers, each = 7, 25
	clients := make([]*client, pushers)
	for i := range clients {
		clients[i] = r.dial(fmt.Sprintf("p%d", i))
		clients[i].hello(0)
	}

	var wg sync.WaitGroup
	for i, cl := range clients {
		wg.Add(1)
		go func(i int, cl *client) {
			defer wg.Done()
			for j := 0; j < each; j++ {
				cl.putAsync(fmt.Sprintf("p%d-%d.md", i, j), fmt.Sprintf("body %d-%d", i, j))
			}
		}(i, cl)
	}
	wg.Wait()

	// The observer pushed nothing, so it must receive every uid exactly once,
	// each as its own contiguous range.
	total := pushers * each
	cursor := int64(0)
	for cursor < int64(total) {
		b := observer.nextBatch()
		if b.From != cursor+1 {
			t.Fatalf("batch [%d,%d] does not continue cursor %d: the fan-out reordered",
				b.From, b.To, cursor)
		}
		if len(b.Entries) != 1 {
			t.Fatalf("live batch [%d,%d] carried %d entries, want 1",
				b.From, b.To, len(b.Entries))
		}
		if b.Entries[0].UID != b.To {
			t.Fatalf("batch [%d,%d] carries uid %d", b.From, b.To, b.Entries[0].UID)
		}
		cursor = b.To
	}
	if cursor != int64(total) {
		t.Fatalf("observer reached cursor %d, want %d", cursor, total)
	}
	r.mustVerify()
}

func uidsOf(entries []store.Entry) []int64 {
	out := make([]int64, len(entries))
	for i, e := range entries {
		out[i] = e.UID
	}
	return out
}

// The reorder commitMu rules out, forced rather than raced for.
//
// Concurrency alone will not produce it: AppendEntry ends in an fsync, so the
// goroutine holding the lower uid has only a log line and a channel send left
// while the next one still has a whole durable commit to do. The lower uid
// therefore wins in practice every time, and the invariant would appear to hold
// for a reason that has nothing to do with the lock.
//
// So the interleaving is forced. The commit that gets the lower uid waits for
// the higher one to be assigned before it announces. Under correct code that
// wait can never be satisfied, because the second commit cannot even reach the
// store while the first holds commitMu, and it times out harmlessly. Remove the
// lock and the wait succeeds, the announcements come out backwards, and an
// observer sees a gap on a vault that is perfectly healthy.
func TestCommitAndAnnounceCannotBeInterleaved(t *testing.T) {
	r := newRig(t)
	if err := r.st.EnsureVault(testVault, 1); err != nil {
		t.Fatalf("ensure vault: %v", err)
	}

	newSession := func() *Session {
		s := &Session{
			srv: r.srv, vaultID: testVault,
			out: make(chan outFrame, 32), dead: make(chan struct{}),
		}
		s.flushPending(0) // past catch-up, so deliveries go straight to the queue
		return s
	}

	observer := newSession()
	if _, ok := r.srv.hub.joinIfRoom(testVault, observer, 8); !ok {
		t.Fatal("observer could not join")
	}
	a, b := newSession(), newSession()

	secondAssigned := make(chan struct{})
	var once sync.Once
	r.srv.afterAppend = func(uid int64) {
		switch uid {
		case 1:
			// Give the second commit every chance to overtake this one.
			select {
			case <-secondAssigned:
			case <-time.After(500 * time.Millisecond):
			}
		case 2:
			once.Do(func() { close(secondAssigned) })
		}
	}

	var wg sync.WaitGroup
	for i, s := range []*Session{a, b} {
		wg.Add(1)
		go func(i int, s *Session) {
			defer wg.Done()
			if _, refusal := s.commit(store.Entry{
				Path: fmt.Sprintf("f%d.md", i), MTime: 1, Device: "d", Mac: testMac,
			}); refusal != nil {
				t.Errorf("commit refused: %s: %s", refusal.Code, refusal.Msg)
			}
		}(i, s)
	}
	wg.Wait()

	got := drainBatchFrames(t, observer)
	if len(got) != 2 {
		t.Fatalf("observer received %d batches, want 2", len(got))
	}
	cursor := int64(0)
	for _, b := range got {
		if b.From != cursor+1 {
			t.Fatalf("batch [%d,%d] does not continue cursor %d: the announcements were reordered",
				b.From, b.To, cursor)
		}
		cursor = b.To
	}
}

// caught-up must reach the wire before any live change that lands after the
// handover, or the client sees a batch whose range is below caught-up's cursor
// and treats it as fatal protostate (client/src/core/transport.ts).
//
// The window is between flushPending flipping catchupDone and caught-up being
// queued. flushPending now queues caught-up under the same lock, so this closes
// it. Forced with the afterFlush hook: it fires once flushPending has released
// its lock, by which point caught-up is already queued, and broadcasts a late
// entry. Before the fix caught-up was written by the caller after flushPending
// returned, so the broadcast slipped in ahead of it.
func TestCaughtUpIsQueuedBeforeAChangeThatLandsInTheHandoverWindow(t *testing.T) {
	r := newRig(t)
	r.seed("seed.md", "backlog")

	var once sync.Once
	var late store.Entry
	r.srv.afterFlush = func() {
		once.Do(func() {
			// Committed and announced the way a concurrent push would be, so the
			// only route to the client is the fan-out.
			late = r.seed("late.md", "landed in the handover window")
			r.srv.hub.broadcast(testVault, late, nil)
		})
	}

	cl := r.dial("a")
	cl.sendJSON(helloMsg(testVault, testToken, "a", 0))

	var ready wire.Ready
	cl.recvInto("ready", &ready)

	var cursor int64
	sawCaughtUp := false
	sawLate := false
	for !sawLate {
		data := cl.recvRaw()
		var probe struct {
			Op     string `json:"op"`
			From   int64  `json:"from"`
			To     int64  `json:"to"`
			Cursor int64  `json:"cursor"`
		}
		if err := json.Unmarshal([]byte(data), &probe); err != nil {
			t.Fatalf("decode %q: %v", data, err)
		}
		switch probe.Op {
		case "batch":
			if probe.From != cursor+1 {
				t.Fatalf("gap: batch [%d,%d] after cursor %d", probe.From, probe.To, cursor)
			}
			cursor = probe.To
			if sawCaughtUp {
				// The late change, correctly after caught-up.
				if probe.To != late.UID {
					t.Fatalf("post-caught-up batch is [%d,%d], want the late one at %d",
						probe.From, probe.To, late.UID)
				}
				sawLate = true
			}
		case "caught-up":
			if probe.Cursor != cursor {
				t.Fatalf("caught-up says cursor %d but batches reached %d: a live change overtook it",
					probe.Cursor, cursor)
			}
			sawCaughtUp = true
		default:
			t.Fatalf("unexpected frame: %s", data)
		}
	}
}
