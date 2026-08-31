package server

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// The recovery ops are read-only, and that is the design rather than an
// omission. Restoring is a client putting an old version back through the
// ordinary put path, so the server keeps exactly one way to change a vault.
// These two ops are how a client finds out what there is to put back.

func TestHistoryReturnsEveryVersionNewestFirst(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	first := cl.put("note.md", "version one")
	second := cl.put("note.md", "version two")
	third := cl.put("note.md", "version three")
	cl.put("other.md", "not this one")

	var got wire.History
	cl.sendJSON(wire.In{Op: "history", Path: "note.md"})
	cl.recvInto("history", &got)

	if got.Path != "note.md" {
		t.Fatalf("history echoed path %q, want note.md", got.Path)
	}
	uids := []int64{}
	for _, e := range got.Entries {
		uids = append(uids, e.UID)
	}
	want := []int64{third, second, first}
	if len(uids) != len(want) {
		t.Fatalf("history has %v, want %v", uids, want)
	}
	for i := range want {
		if uids[i] != want[i] {
			t.Fatalf("history is %v, want %v (newest first)", uids, want)
		}
	}
	// And the chunk lists came with them, because that is what a restore needs
	// in order to ask for the content.
	if len(got.Entries[0].Chunks) == 0 {
		t.Fatal("history returned a version with no chunks, so nothing could be restored from it")
	}
}

// A deletion is a version like any other, and it has to be visible: a client
// showing history needs to say "and then it was deleted" rather than stopping
// at the last version that had content.
func TestHistoryIncludesTheDeletion(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.put("note.md", "here")
	cl.remove("note.md")

	var got wire.History
	cl.sendJSON(wire.In{Op: "history", Path: "note.md"})
	cl.recvInto("history", &got)

	if len(got.Entries) != 2 {
		t.Fatalf("history has %d versions, want 2", len(got.Entries))
	}
	if !got.Entries[0].Deleted {
		t.Fatal("the newest version should be the deletion")
	}
	if got.Entries[1].Deleted || len(got.Entries[1].Chunks) == 0 {
		t.Fatal("the version before it should be the one with content")
	}
}

// The server has never been able to read a path and this is not where it
// starts. An unknown path is simply a path with no versions.
func TestHistoryOfAPathTheServerDoesNotHave(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	raw := cl.historyRaw("never-existed.md")
	// Empty, and an empty *array*. A client iterating null would crash on
	// precisely the answer it is meant to handle.
	if raw != "[]" {
		t.Fatalf("entries came back as %s, want []", raw)
	}
}

func TestHistoryPaginatesBackwards(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	uids := []int64{}
	for _, body := range []string{"one", "two", "three", "four", "five"} {
		uids = append(uids, cl.put("note.md", body))
	}

	var page wire.History
	cl.sendJSON(wire.In{Op: "history", Path: "note.md", Limit: 2})
	cl.recvInto("history", &page)
	if len(page.Entries) != 2 || page.Entries[0].UID != uids[4] {
		t.Fatalf("first page is %v", uidsOf(page.Entries))
	}

	oldest := page.Entries[len(page.Entries)-1].UID
	cl.sendJSON(wire.In{Op: "history", Path: "note.md", Before: oldest, Limit: 2})
	cl.recvInto("history", &page)
	if len(page.Entries) != 2 || page.Entries[0].UID != uids[2] {
		t.Fatalf("second page is %v, want the two before %d", uidsOf(page.Entries), oldest)
	}
}

func TestHistoryRefusesAnEmptyPath(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.sendJSON(wire.In{Op: "history"})
	cl.expectErr(wire.CodeBadName)

	// Still usable, asserted by using it. A refusal a client can recover from
	// has to leave a session it can carry on with.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

func TestDeletedListsWhatIsRecoverable(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	cl.put("kept.md", "still here")
	cl.put("gone.md", "about to go")
	cl.put("also-gone.md", "likewise")
	for _, path := range []string{"gone.md", "also-gone.md"} {
		cl.remove(path)
	}

	var got wire.Deleted
	cl.sendJSON(wire.In{Op: "deleted"})
	cl.recvInto("deleted", &got)

	paths := map[string]bool{}
	for _, e := range got.Entries {
		paths[e.Path] = true
		if !e.Deleted {
			t.Fatalf("%s is in the deleted list and is not deleted", e.Path)
		}
	}
	if !paths["gone.md"] || !paths["also-gone.md"] {
		t.Fatalf("deleted list is %v, want both deletions", paths)
	}
	if paths["kept.md"] {
		t.Fatal("a file that still exists is in the deleted list")
	}
}

// The one that makes the list usable. A rename leaves a deletion behind at the
// old path, so without suppression a vault where files get reorganised shows
// mostly phantom deletions of notes that still exist under another name.
func TestDeletedDoesNotListTheOldSideOfARename(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	cl.put("old-name.md", "content")
	// A rename: the new path arrives carrying prev, and then the old path is
	// retired. Both halves, because it is the pair that the suppression has to
	// recognise.
	cl.rename("new-name.md", "old-name.md", "content")
	cl.remove("old-name.md")

	var got wire.Deleted
	cl.sendJSON(wire.In{Op: "deleted"})
	cl.recvInto("deleted", &got)

	for _, e := range got.Entries {
		if e.Path == "old-name.md" {
			t.Fatal("a rename showed up as a deleted file, which is how this list becomes noise")
		}
	}
}

func TestDeletedIsAnArrayWhenThereIsNothing(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.put("kept.md", "here")

	raw := cl.deletedRaw()
	if raw != "[]" {
		t.Fatalf("entries came back as %s, want []", raw)
	}
}

// Recovery is read-only. Neither op may leave a mark on the vault, because a
// tool somebody reaches for after losing a note is the last place a surprise
// write belongs.
func TestRecoveryOpsChangeNothing(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)
	cl.put("note.md", "content")

	before, err := r.st.LatestUID(testVault)
	if err != nil {
		t.Fatalf("latest uid: %v", err)
	}

	cl.sendJSON(wire.In{Op: "history", Path: "note.md"})
	cl.recvInto("history", &wire.History{})
	cl.sendJSON(wire.In{Op: "deleted"})
	cl.recvInto("deleted", &wire.Deleted{})

	after, err := r.st.LatestUID(testVault)
	if err != nil {
		t.Fatalf("latest uid: %v", err)
	}
	if before != after {
		t.Fatalf("the vault moved from uid %d to %d while only being read", before, after)
	}
}

/* helpers */

// historyRaw returns the entries field exactly as it came off the wire, so that
// null and [] can be told apart. Unmarshalling into a slice would erase the
// difference, which is the whole point of the check.
func (c *client) historyRaw(path string) string {
	c.t.Helper()
	c.sendJSON(wire.In{Op: "history", Path: path})
	return c.rawEntries("history")
}

func (c *client) deletedRaw() string {
	c.t.Helper()
	c.sendJSON(wire.In{Op: "deleted"})
	return c.rawEntries("deleted")
}

func (c *client) rawEntries(want string) string {
	c.t.Helper()
	frame := c.recvRaw()
	var envelope struct {
		Res     string          `json:"res"`
		Entries json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal([]byte(frame), &envelope); err != nil {
		c.t.Fatalf("%s: unmarshal %s: %v", c.name, frame, err)
	}
	if envelope.Res != want {
		c.t.Fatalf("%s: got %s, want %s", c.name, frame, want)
	}
	return string(envelope.Entries)
}

// remove puts a deletion, which is a put like any other.
func (c *client) remove(path string) int64 {
	c.t.Helper()
	c.sendJSON(wire.In{Op: "put", Path: path, Meta: wire.PutMeta{Deleted: true, MTime: 9}, Mac: testMac})
	// "have" rather than "ack": a deletion carries no chunks, so every body the
	// server needs is already present, vacuously.
	var have wire.Have
	c.recvInto("have", &have)
	return have.UID
}

// rename puts the new path carrying prev, which is the half that says a rename
// happened.
func (c *client) rename(to, from string, bodies ...string) int64 {
	c.t.Helper()
	names, size := chunkNames(bodies)
	c.sendJSON(wire.In{
		Op: "put", Path: to, Chunks: names, Mac: testMac,
		Meta: wire.PutMeta{Size: size, MTime: 6, Prev: from},
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
		c.t.Fatalf("%s: rename to %s: unexpected reply %v", c.name, to, m)
		return 0
	}
}

// A vault accumulates deletions for as long as it exists. An unbounded answer
// is one frame that grows without limit, and a silently truncated one is worse:
// somebody reads a short list, does not find their note, and concludes it is
// gone.
func TestDeletedIsBoundedAndSaysWhenItWasCut(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	for i := 0; i < 12; i++ {
		path := fmt.Sprintf("note-%02d.md", i)
		cl.put(path, fmt.Sprintf("body %d", i))
		cl.remove(path)
	}

	var page wire.Deleted
	cl.sendJSON(wire.In{Op: "deleted", Limit: 5})
	cl.recvInto("deleted", &page)

	if len(page.Entries) != 5 {
		t.Fatalf("asked for 5 deletions, got %d", len(page.Entries))
	}
	if !page.More {
		t.Fatal("the list was cut short and did not say so")
	}

	// And when it fits, it says so too, rather than always claiming more.
	cl.sendJSON(wire.In{Op: "deleted", Limit: 100})
	cl.recvInto("deleted", &page)
	if len(page.Entries) != 12 || page.More {
		t.Fatalf("got %d deletions with more=%v, want 12 and false", len(page.Entries), page.More)
	}
}

// Purge keeps only the newest version per path. For a deleted note that is the
// deletion record, so after a purge the note is still in the deleted list and
// there is nothing left to restore it from.
//
// Saying so is the point. A client that prints "all still recoverable" over
// this list without looking, which one did, tells somebody their note is safe
// when it is gone.
func TestDeletedSaysWhetherThereIsAnythingLeftToRestore(t *testing.T) {
	r := newRig(t)
	cl := r.dial("a")
	cl.hello(0)

	content := cl.put("note.md", "the only version")
	cl.remove("note.md")

	var before wire.Deleted
	cl.sendJSON(wire.In{Op: "deleted"})
	cl.recvInto("deleted", &before)
	if len(before.Entries) != 1 {
		t.Fatalf("expected one deletion, got %d", len(before.Entries))
	}
	if before.Entries[0].RestorableUID != content {
		t.Fatalf("restorable is %d, want the content version %d",
			before.Entries[0].RestorableUID, content)
	}

	// Now the history goes.
	if _, err := r.st.Purge(testVault, 0); err != nil {
		t.Fatalf("purge: %v", err)
	}

	var after wire.Deleted
	cl.sendJSON(wire.In{Op: "deleted"})
	cl.recvInto("deleted", &after)
	if len(after.Entries) != 1 {
		t.Fatalf("the deletion should still be listed, got %d", len(after.Entries))
	}
	if after.Entries[0].RestorableUID != 0 {
		t.Fatalf("restorable is %d after a purge, and nothing survives to restore from",
			after.Entries[0].RestorableUID)
	}
}
