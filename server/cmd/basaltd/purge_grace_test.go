package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
)

/* ---------------------------------------------------------------- *
 * purge says what the grace window kept from it
 * ---------------------------------------------------------------- */

// The default grace window is right and it is also why an operator who stops
// the server, backs up, and purges gets nothing back: every body a purge would
// collect was written in the last hour, or the operator would not be purging.
// The report said "2 spared as too recent to collect" in the middle of a line
// and nothing else. Rule 8, trust the numbers: what was not done is a number
// too, in bodies and in bytes, and the line that carries it says how to get
// them.
//
// seeded holds three versions of note.md. A purge drops the first two, whose
// bodies "version one" and "version two" are 11 bytes each and were written a
// moment ago, so the window spares exactly 2 bodies and 22 bytes.
//
// The lead is asserted with the line, not without it. "spared 2 bodies (22 B)"
// is a substring of both leads, so deleting the whole `reclaimed nothing:`
// branch left the suite green: the one thing the branch exists to say was the
// one thing untested, while docs/server.md quoted it verbatim. Rule 9. See
// TestAPurgeThatReclaimedSomethingDoesNotSayItReclaimedNothing for the other
// lead.
func TestPurgeSaysWhatTheGraceWindowSparedAndHowToReclaimIt(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	for _, want := range []string{"reclaimed nothing: spared 2 bodies (22 B)", "-grace 0"} {
		if !strings.Contains(out, want) {
			t.Fatalf("purge does not say %q:\n%s", want, out)
		}
	}

	// The figure is not an estimate: a purge without the window reclaims
	// exactly the bodies and bytes the first one said it spared.
	before := countBodies(t, dir)
	again := mustRun(t, "purge", "-data", dir, "-grace", "0", "-confirm", "default", "-no-backup-check")
	if got := countBodies(t, dir); got != before-2 {
		t.Fatalf("-grace 0 removed %d bodies, the first purge said it spared 2\n%s", before-got, again)
	}
	if !strings.Contains(again, "2 deleted (22 B reclaimed)") {
		t.Fatalf("the second purge does not report what it reclaimed:\n%s", again)
	}
	// Nothing left to spare, so no advice to re-run.
	if strings.Contains(again, "-grace 0") {
		t.Fatalf("a purge that spared nothing still says to re-run with -grace 0:\n%s", again)
	}
}

// The other lead. A purge that took some bodies and spared others has not
// reclaimed nothing, and saying so would be a status describing the window
// rather than the vault (rule 7).
//
// One of the two orphans is backdated past the window, so the sweep takes it
// and spares the other: 1 deleted, 1 spared, and the line leads with "spared".
func TestAPurgeThatReclaimedSomethingDoesNotSayItReclaimedNothing(t *testing.T) {
	dir := seeded(t)
	backdateBody(t, dir, "version one", 2*chunks.DefaultGrace)

	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	if !strings.Contains(out, "1 deleted (11 B reclaimed), 1 spared") {
		t.Fatalf("purge did not take the one body older than the window:\n%s", out)
	}
	if strings.Contains(out, "reclaimed nothing") {
		t.Fatalf("a purge that reclaimed 11 B says it reclaimed nothing:\n%s", out)
	}
	if !strings.Contains(out, "spared 1 bodies (11 B)") {
		t.Fatalf("purge does not say what the window kept from it:\n%s", out)
	}
}

// backdateBody sets the modification time of one chunk body back by age,
// finding it by its content rather than by walking to the right shard, so the
// test says which body it means in the same words seeded() does.
func backdateBody(t *testing.T, dir, body string, age time.Duration) {
	t.Helper()
	name := chunks.Name([]byte(body))
	var found string
	err := filepath.WalkDir(filepath.Join(dir, "chunks"), func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if d.Name() == name {
			found = p
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk chunks: %v", err)
	}
	if found == "" {
		t.Fatalf("no body for %q in %s", body, dir)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(found, when, when); err != nil {
		t.Fatalf("backdate %s: %v", found, err)
	}
}
