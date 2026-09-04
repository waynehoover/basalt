package server

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

/* ---------------------------------------------------------------- *
 * Clock skew: what it can and cannot reach
 * ---------------------------------------------------------------- */

// History is ordered by arrival, and arrival is a uid, so no clock decides
// where a version appears in the list.
//
// This is the evidence behind declining a server-stamped arrival time. The
// concern was that a device with a wrong clock writes entries that sort oddly,
// and the proposed fix was a timestamp the server writes and the UI prefers.
// The ordering half of that concern is already false: `ORDER BY uid DESC` is
// arrival order by construction, so the worst a skewed device can do is put a
// wrong label beside a correctly placed version.
//
// The put here declares a modification time far in the future and lands last
// anyway. If a clock ever gets into this ordering, this test says so before
// anybody has to notice it in a history list.
func TestHistoryIsOrderedByArrivalAndNotByAnyClock(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	// Three versions of one path. The middle one is stamped a year ahead and
	// the last one a decade behind, which is every way a clock can be wrong.
	yearAhead := futureMillis(t, r, 365*24*time.Hour)
	first := cl.putAt("note.md", 1_700_000_000_000, "one")
	future := cl.putAt("note.md", yearAhead, "two")
	past := cl.putAt("note.md", 1_000, "three")

	cl.sendJSON(wire.In{Op: "history", Path: "note.md"})
	var got wire.History
	cl.recvInto("history", &got)
	if len(got.Entries) != 3 {
		t.Fatalf("history returned %d versions, want 3", len(got.Entries))
	}
	// Newest first, and newest means the one that arrived last, whatever any
	// of them claims about the time.
	want := []int64{past, future, first}
	for i, e := range got.Entries {
		if e.UID != want[i] {
			t.Fatalf("history is not in arrival order: uids %v, want %v",
				[]int64{got.Entries[0].UID, got.Entries[1].UID, got.Entries[2].UID}, want)
		}
	}

	// And the timestamps came back exactly as the device wrote them. They are
	// covered by the entry's authenticator, so a server that adjusted one would
	// be handing every reader an entry that fails its own check.
	if got.Entries[1].MTime != yearAhead {
		t.Fatalf("the server changed a client's mtime: %d", got.Entries[1].MTime)
	}
}

// A device writing timestamps from the future is reported, once, with the
// device named and the offset stated.
//
// This is what the server can honestly do about a wrong clock: say so. It
// cannot correct the timestamp, because the timestamp is inside an
// authenticator it holds no key for, and it must not offer a timestamp of its
// own for the UI to prefer, because a field the server writes and a person
// reads is the one thing docs/design.md says the server does not get.
func TestASkewedDeviceIsReportedOncePerSession(t *testing.T) {
	r, logs := newRigLogging(t)
	cl := r.dial("laptop")
	cl.hello(0)

	// Three days ahead: no plausible pair of NTP-synced clocks disagrees by
	// that, so it is a wrong clock rather than a wrong tolerance.
	ahead := futureMillis(t, r, 72*time.Hour)
	cl.putAt("one.md", ahead, "a")
	cl.putAt("two.md", ahead, "b")
	cl.putAt("three.md", ahead, "c")

	line := logs.String()
	if n := strings.Count(line, "timestamps from the future"); n != 1 {
		t.Fatalf("a skewed device was reported %d times over three puts, want exactly 1:\n%s", n, line)
	}
	if !strings.Contains(line, "device=laptop") {
		t.Fatalf("the warning does not name the device:\n%s", line)
	}
	// The offset, because "wrong clock" without a number is not something an
	// operator can check against anything.
	if !strings.Contains(line, "ahead=") {
		t.Fatalf("the warning does not say how far ahead:\n%s", line)
	}
	// And it says what is not affected, so nobody reads it as a data warning.
	if !strings.Contains(line, "ordered by arrival") {
		t.Fatalf("the warning does not say the ordering is unaffected:\n%s", line)
	}
}

// An ordinary vault is silent. Every note written before the vault was paired
// has a modification time in the past, and a vault of files from 2015 is not a
// fault: a check that fired on those would be a warning nobody could act on
// and everybody would learn to ignore.
func TestOrdinaryAndOldTimestampsAreNotReportedAsSkew(t *testing.T) {
	r, logs := newRigLogging(t)
	cl := r.dial("laptop")
	cl.hello(0)

	now := r.srv.now().UnixMilli()
	cl.putAt("today.md", now, "a")
	cl.putAt("ancient.md", 1_100_000_000_000, "b") // 2004
	cl.putAt("epoch.md", 1, "c")
	// Inside the tolerance, which is where a server whose own clock is a
	// little behind lands. Reporting this would name a working device.
	cl.putAt("nearly.md", now+int64((23*time.Hour)/time.Millisecond), "d")

	if strings.Contains(logs.String(), "timestamps from the future") {
		t.Fatalf("an ordinary vault was reported as skewed:\n%s", logs.String())
	}
}

// putAt is put with the modification time the caller chose, which is the whole
// variable these tests are about.
func (c *client) putAt(path string, mtime int64, bodies ...string) int64 {
	c.t.Helper()
	names, size := chunkNames(bodies)
	c.sendJSON(wire.In{
		Op: "put", Path: path, Chunks: names, Mac: testMac,
		Meta: wire.PutMeta{Size: size, MTime: mtime},
	})
	m := c.recv()
	switch m["res"] {
	case "have":
		return int64(m["uid"].(float64))
	case "want":
		for _, n := range toStrings(c.t, m["chunks"]) {
			c.sendBinary([]byte(bodyFor(c.t, bodies, n)))
		}
		var ack wire.Ack
		c.recvInto("ack", &ack)
		return ack.UID
	default:
		c.t.Fatalf("%s: put %s: unexpected reply %v", c.name, path, m)
		return 0
	}
}

func futureMillis(t *testing.T, r *rig, d time.Duration) int64 {
	t.Helper()
	return r.srv.now().Add(d).UnixMilli()
}

// newRigLogging is a rig whose log goes somewhere a test can read, because the
// behaviour under test here is a log line and nothing else. The buffer is
// written by the session goroutine and read by the test one, so it locks: -race
// is entitled to object, and a flaky race report on a log buffer is a day spent
// on the wrong thing.
func newRigLogging(t *testing.T) (*rig, *syncBuffer) {
	t.Helper()
	r := newRig(t)
	buf := &syncBuffer{}
	r.srv.log = slog.New(slog.NewTextHandler(buf, nil))
	return r, buf
}

// syncBuffer is a bytes.Buffer a test may read while the server may still be
// writing to it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
