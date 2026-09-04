package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/store"
)

/* ---------------------------------------------------------------- *
 * Purge tells you when it is worth running
 * ---------------------------------------------------------------- */

// `stats` says whether a purge is worth the ceremony, in bytes.
//
// A history count was already here and it does not answer the question, since
// "431 versions" is four kilobytes or four gigabytes and the remedy is stop,
// back up, purge, start. Nothing said when it was worth doing, so it was
// learned from a `nospace` refusal on somebody's phone.
//
// Only the visibility half, deliberately: nothing here deletes, nothing runs
// on a timer, and purge stays a stopped-server ceremony.
func TestStatsSaysWhetherAPurgeIsWorthRunning(t *testing.T) {
	dir := aged(t)

	prose := mustRun(t, "stats", "-data", dir)
	if !strings.Contains(prose, "purge would reclaim") {
		t.Fatalf("stats does not say what a purge would reclaim:\n%s", prose)
	}
	// A byte figure, not only a count. This is the line the whole item is
	// about, and a version of it reading "purge would reclaim 4 bodies" would
	// leave the operator exactly where they started.
	if !strings.Contains(prose, " B\n") && !strings.Contains(prose, "iB ") && !strings.Contains(prose, "B in ") {
		t.Fatalf("the reclaim line carries no bytes:\n%s", prose)
	}
	if !strings.Contains(prose, "of those versions are history") {
		t.Fatalf("the history count went missing:\n%s", prose)
	}

	out := mustRun(t, "stats", "-data", dir, "-json")
	var rep statsJSON
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("stats -json is not JSON: %v\n%s", err, out)
	}
	if len(rep.Vaults) != 1 {
		t.Fatalf("vaults: %+v", rep.Vaults)
	}
	v := rep.Vaults[0]
	if !v.ReclaimComplete {
		t.Fatalf("the walk did not finish on a healthy store: %+v", v)
	}
	if v.ReclaimBytes <= 0 || v.ReclaimBodies <= 0 {
		t.Fatalf("json offers nothing to reclaim on a store built to have some: %+v", v)
	}
	if v.History != 2 {
		t.Fatalf("json history = %d, want 2", v.History)
	}
	// The prose and the JSON come from one call, so a figure in one is the
	// figure in the other. Checked by finding the JSON's byte count rendered
	// in the prose rather than by trusting that they were.
	if want := humanBytes(v.ReclaimBytes); !strings.Contains(prose, want) {
		t.Fatalf("prose does not carry the JSON's %s:\n%s", want, prose)
	}
}

// Zero is an answer and gets a line. An absent line is indistinguishable from
// a figure nobody printed, which is rule 7 in the smallest possible form: the
// operator who runs stats to decide whether to stop the server deserves to be
// told "no" out loud.
func TestStatsSaysSoWhenThereIsNothingToReclaim(t *testing.T) {
	dir := emptyDataDir(t)
	st, err := store.Open(filepath.Join(dir, "basalt.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendEntry("default", store.Entry{
		Path: "note.md", Size: 3, MTime: 10, Device: "seed", Mac: testMac,
		Chunks: []string{putBody(t, st, "one")},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	prose := mustRun(t, "stats", "-data", dir)
	if !strings.Contains(prose, "nothing for purge to reclaim") {
		t.Fatalf("a vault with no history says nothing about it:\n%s", prose)
	}
}

// The grace window keeps its own line. On a server stopped a moment ago every
// collectible body is inside it, so the reclaim figure is zero and the whole
// answer is in this line; summing the two would promise space the purge then
// reports as spared (rule 8).
func TestStatsKeepsTheGraceWindowOutOfTheReclaimFigure(t *testing.T) {
	dir := seeded(t) // bodies written a moment ago, so all of them are in the window

	prose := mustRun(t, "stats", "-data", dir)
	if !strings.Contains(prose, "purge would reclaim nothing yet") {
		t.Fatalf("nothing says the window is holding bodies back:\n%s", prose)
	}
	// And the bytes it is holding back are named, because "some bodies were
	// spared" is the count-without-bytes this whole item is against.
	if !strings.Contains(prose, "bodies is collectible but was written") {
		t.Fatalf("the spared bodies have no bytes beside them:\n%s", prose)
	}

	out := mustRun(t, "stats", "-data", dir, "-json")
	var rep statsJSON
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("stats -json: %v\n%s", err, out)
	}
	v := rep.Vaults[0]
	if v.ReclaimBytes != 0 || v.RecentBytes == 0 {
		t.Fatalf("the window is folded into the reclaim figure: %+v", v)
	}
}

// A walk that stopped prints no figure at all, only that it stopped. The purge
// report learned this from one stray file in the first shard producing a full
// report with every collectible orphan in the tree unexamined, and a preview
// that made the same mistake would say "nothing to reclaim" about a store that
// is mostly reclaimable.
func TestStatsPrintsNoReclaimFigureWhenTheWalkStopped(t *testing.T) {
	dir := aged(t)
	st, err := openExisting(dir, "inspect")
	if err != nil {
		t.Fatal(err)
	}
	stray := filepath.Join(st.Chunks().VaultDir("default"), "not-a-chunk")
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stray, []byte("evidence"), 0o600); err != nil {
		t.Fatal(err)
	}

	out, err := basalt(t, "stats", "-data", dir)
	if err == nil {
		t.Fatalf("an unexpected file in the chunk store did not stop stats:\n%s", out)
	}
	if strings.Contains(out, "purge would reclaim") || strings.Contains(out, "nothing for purge") {
		t.Fatalf("a stopped walk still printed a reclaim figure:\n%s", out)
	}
}

// The startup line carries it too, because a restart is when an operator is
// looking and a `stats` nobody runs tells nobody anything.
func TestTheStartupLineSaysWhatAPurgeWouldReclaim(t *testing.T) {
	dir := aged(t)
	st, err := openExisting(dir, "inspect")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	rec, err := st.Reclaimable("default", chunks.DefaultGrace)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Bytes == 0 {
		t.Fatal("the fixture has nothing to reclaim, so this proves nothing")
	}

	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	if err := logStartup(log, st, "default", "1.2.3"); err != nil {
		t.Fatal(err)
	}
	// slog quotes a value with a space in it, so the attribute and the figure
	// are asserted separately rather than by guessing at the rendering.
	line := buf.String()
	if !strings.Contains(line, "reclaimable=") || !strings.Contains(line, humanBytes(rec.Bytes)) {
		t.Fatalf("the startup line does not say what a purge would reclaim (%s):\n%s",
			humanBytes(rec.Bytes), line)
	}
	// Still one line. The point is that it is the line already being read,
	// not a second one to notice.
	if strings.Count(line, "\n") != 1 {
		t.Fatalf("wanted exactly one line, got:\n%s", line)
	}
}

// aged is `seeded` with the chunk bodies backdated past the grace window, so
// what a purge would collect is collectible rather than spared.
//
// Backdating rather than passing grace 0: the figure these surfaces print is
// the one a default purge would get, and a fixture that only ever answers at
// grace 0 would never exercise the split between the two.
func aged(t *testing.T) string {
	t.Helper()
	dir := seeded(t)
	old := time.Now().Add(-2 * chunks.DefaultGrace)
	root := filepath.Join(dir, "chunks")
	if err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		return os.Chtimes(p, old, old)
	}); err != nil {
		t.Fatalf("backdating the chunk tree: %v", err)
	}
	return dir
}

// putBody stores one body and returns its name, for the tests above that build
// a store directly rather than through `seeded`.
func putBody(t *testing.T, st *store.Store, body string) string {
	t.Helper()
	name := chunks.Name([]byte(body))
	if err := st.Chunks().Put("default", name, []byte(body)); err != nil {
		t.Fatalf("put chunk: %v", err)
	}
	return name
}
