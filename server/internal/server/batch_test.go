package server

import (
	"encoding/json"
	"testing"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// Latency multiplies round trips. Two hundred paths were two hundred requests,
// and on a link with four hundred milliseconds in it that is eighty seconds
// spent asking permission to send things the server was always going to want.

func (c *client) putMany(entries []wire.PutEntry, bodies map[string]string) wire.Acks {
	c.t.Helper()
	c.sendJSON(wire.In{Op: "putmany", Entries: entries})

	frame := c.recvRaw()
	var head struct {
		Res string `json:"res"`
	}
	if err := json.Unmarshal([]byte(frame), &head); err != nil {
		c.t.Fatalf("%s: %v", c.name, err)
	}

	var acks wire.Acks
	switch head.Res {
	case "want":
		var want wire.Want
		if err := json.Unmarshal([]byte(frame), &want); err != nil {
			c.t.Fatalf("%s: %v", c.name, err)
		}
		for _, name := range want.Chunks {
			body, ok := bodies[name]
			if !ok {
				c.t.Fatalf("%s: server wanted %s, which this batch does not contain", c.name, name)
			}
			c.sendBinary([]byte(body))
		}
		c.recvInto("acks", &acks)
	case "acks":
		if err := json.Unmarshal([]byte(frame), &acks); err != nil {
			c.t.Fatalf("%s: %v", c.name, err)
		}
	default:
		c.t.Fatalf("%s: unexpected reply to putmany: %s", c.name, frame)
	}
	return acks
}

// entryFor builds one entry and the bodies it needs.
func entryFor(path string, bodies ...string) (wire.PutEntry, map[string]string) {
	names := make([]string, 0, len(bodies))
	byName := map[string]string{}
	size := 0
	for _, b := range bodies {
		n := chunks.Name([]byte(b))
		names = append(names, n)
		byName[n] = b
		size += len(b)
	}
	return wire.PutEntry{
		Path:   path,
		Meta:   wire.PutMeta{Size: int64(size), MTime: 5},
		Chunks: names,
		Mac:    testMac,
	}, byName
}

func TestABatchCommitsEveryEntryInOneExchange(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	var entries []wire.PutEntry
	bodies := map[string]string{}
	for _, name := range []string{"one.md", "two.md", "three.md", "notes/four.md"} {
		e, b := entryFor(name, "the content of "+name)
		entries = append(entries, e)
		for k, v := range b {
			bodies[k] = v
		}
	}

	acks := cl.putMany(entries, bodies)
	if len(acks.Results) != len(entries) {
		t.Fatalf("%d entries went and %d results came back", len(entries), len(acks.Results))
	}
	for i, res := range acks.Results {
		if res.UID == 0 || res.Code != "" {
			t.Fatalf("entry %d was refused: %+v", i, res)
		}
	}
	// Uids in the order the entries were sent, which is what lets a client
	// match a result to what it asked for.
	for i := 1; i < len(acks.Results); i++ {
		if acks.Results[i].UID <= acks.Results[i-1].UID {
			t.Fatalf("uids came back out of order: %+v", acks.Results)
		}
	}
	if got := r.mustStats().Files; got != int64(len(entries)) {
		t.Fatalf("the vault holds %d files, want %d", got, len(entries))
	}
}

// The point of the whole thing: one want list for the batch, not one each.
func TestABatchAsksForEveryMissingChunkAtOnce(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	var entries []wire.PutEntry
	bodies := map[string]string{}
	for i := 0; i < 10; i++ {
		e, b := entryFor(string(rune('a'+i))+".md", "body number "+string(rune('0'+i)))
		entries = append(entries, e)
		for k, v := range b {
			bodies[k] = v
		}
	}

	cl.sendJSON(wire.In{Op: "putmany", Entries: entries})
	m := cl.recv()
	if m["res"] != "want" {
		t.Fatalf("expected one want for the batch, got %v", m)
	}
	if got := len(toStrings(t, m["chunks"])); got != 10 {
		t.Fatalf("the want list names %d chunks, want 10", got)
	}
	for _, name := range toStrings(t, m["chunks"]) {
		cl.sendBinary([]byte(bodies[name]))
	}
	var acks wire.Acks
	cl.recvInto("acks", &acks)
	if len(acks.Results) != 10 {
		t.Fatalf("%d results, want 10", len(acks.Results))
	}
}

// Two files with the same content ask for it once, which is what deduplication
// is worth on a first sync.
func TestABatchAsksOnceForAChunkTwoEntriesShare(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	a, bodies := entryFor("a.md", "identical content")
	b, _ := entryFor("b.md", "identical content")

	cl.sendJSON(wire.In{Op: "putmany", Entries: []wire.PutEntry{a, b}})
	m := cl.recv()
	if got := len(toStrings(t, m["chunks"])); got != 1 {
		t.Fatalf("the want list names %d chunks for two identical files, want 1", got)
	}
	for _, name := range toStrings(t, m["chunks"]) {
		cl.sendBinary([]byte(bodies[name]))
	}
	var acks wire.Acks
	cl.recvInto("acks", &acks)
	if len(acks.Results) != 2 || acks.Results[0].UID == 0 || acks.Results[1].UID == 0 {
		t.Fatalf("both entries should have committed: %+v", acks.Results)
	}
}

// One unacceptable file among good ones must not refuse the others, and the
// client has to be told which one it was. The alternative is a batch that fails
// as a unit and a client that bisects it to find out why.
func TestOneBadEntryDoesNotRefuseTheRest(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	good, bodies := entryFor("good.md", "fine")
	bad := wire.PutEntry{Path: "", Mac: testMac, Meta: wire.PutMeta{Size: 1}}
	alsoGood, more := entryFor("also-good.md", "also fine")
	for k, v := range more {
		bodies[k] = v
	}

	acks := cl.putMany([]wire.PutEntry{good, bad, alsoGood}, bodies)
	if len(acks.Results) != 3 {
		t.Fatalf("%d results, want 3", len(acks.Results))
	}
	if acks.Results[0].UID == 0 || acks.Results[2].UID == 0 {
		t.Fatalf("a good entry was refused alongside a bad one: %+v", acks.Results)
	}
	if acks.Results[1].Code != wire.CodeBadName {
		t.Fatalf("the bad entry was refused as %q, want %q", acks.Results[1].Code, wire.CodeBadName)
	}
	if cl.closed() {
		t.Fatal("one unacceptable entry closed the session")
	}
}

// A batch whose chunks the server already holds skips the want entirely.
func TestABatchOfChunksAlreadyHeldSkipsTheUpload(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	e, bodies := entryFor("note.md", "already here")
	cl.putMany([]wire.PutEntry{e}, bodies)

	again, _ := entryFor("copy.md", "already here")
	cl.sendJSON(wire.In{Op: "putmany", Entries: []wire.PutEntry{again}})
	var acks wire.Acks
	cl.recvInto("acks", &acks)
	if len(acks.Results) != 1 || acks.Results[0].UID == 0 {
		t.Fatalf("expected an immediate ack: %+v", acks.Results)
	}
}

func TestABatchIsBounded(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	cl.sendJSON(wire.In{Op: "putmany", Entries: nil})
	cl.expectErr(wire.CodeBadEntry)

	huge := make([]wire.PutEntry, wire.MaxBatchEntries+1)
	for i := range huge {
		huge[i] = wire.PutEntry{Path: "x.md", Mac: testMac, Meta: wire.PutMeta{MTime: 1}}
	}
	cl.sendJSON(wire.In{Op: "putmany", Entries: huge})
	cl.expectErr(wire.CodeToolarge)

	// And it is still usable, because neither refusal is fatal.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

// A commit refusal is an entry's refusal, not the batch's.
//
// checkEntry runs before the bodies arrive, so it cannot know how much
// ciphertext an entry will end up referencing. The budget is therefore enforced
// again at commit, and a batch spends one allowance across every entry in it, so
// an entry that overruns its own share is caught only there.
//
// This used to end the session. The entries that had already committed were
// never acked, the client retried all of them, and the server grew a second
// version of every note in the batch.
func TestACommitRefusalDoesNotTakeTheBatchWithIt(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	// Three honest entries and one that declares a byte while naming a chunk
	// the batch is paying for. Its own budget cannot cover that chunk, but the
	// batch's summed allowance can, so the bodies all arrive.
	big := make([]byte, 4096)
	for i := range big {
		big[i] = byte(i)
	}
	bigName := chunks.Name(big)
	bodies := map[string]string{bigName: string(big)}

	entries := []wire.PutEntry{
		{Path: "honest.md", Meta: wire.PutMeta{Size: 4096, MTime: 1}, Chunks: []string{bigName}, Mac: testMac},
		{Path: "liar.md", Meta: wire.PutMeta{Size: 1, MTime: 2}, Chunks: []string{bigName}, Mac: testMac},
	}
	for _, name := range []string{"after-one.md", "after-two.md"} {
		e, b := entryFor(name, "content of "+name)
		entries = append(entries, e)
		for k, v := range b {
			bodies[k] = v
		}
	}

	acks := cl.putMany(entries, bodies)
	if len(acks.Results) != 4 {
		t.Fatalf("%d results, want 4", len(acks.Results))
	}
	if acks.Results[1].Code != wire.CodeToolarge {
		t.Fatalf("the overrunning entry came back as %+v, want %s", acks.Results[1], wire.CodeToolarge)
	}
	// The three honest ones, including the two that were queued behind the
	// refusal, all committed and all said so.
	for _, i := range []int{0, 2, 3} {
		if acks.Results[i].UID == 0 {
			t.Fatalf("entry %d was lost to another entry's refusal: %+v", i, acks.Results[i])
		}
	}
	// A pong is the proof the session survived, and a stronger one than not
	// seeing a hang-up.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
	if got := r.mustStats().Files; got != 3 {
		t.Fatalf("the vault holds %d files, want 3", got)
	}
}
