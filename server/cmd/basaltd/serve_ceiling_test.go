package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/store"
)

/* ---------------------------------------------------------------- *
 * -max-file below a file the vault already holds
 * ---------------------------------------------------------------- */

// dirWithLargeFiles is a data directory whose vault holds three shapes of a
// file over a small ceiling, only one of which a device pairing today would
// ever ask for:
//
//   - uid 1: big.bin, 30 bytes, live. This is the one that matters.
//   - uid 2 then 3: old.md, 40 bytes then 5. History over the ceiling, newest
//     version under it.
//   - uid 4 then 5: gone.bin, 50 bytes then deleted.
func dirWithLargeFiles(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "basalt.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatalf("ensure vault: %v", err)
	}
	put := func(path string, body string) {
		t.Helper()
		n := chunks.Name([]byte(body))
		if err := st.Chunks().Put("default", n, []byte(body)); err != nil {
			t.Fatalf("put chunk: %v", err)
		}
		e := store.Entry{Path: path, Size: int64(len(body)), MTime: 10, Device: "seed", Chunks: []string{n}, Mac: testMac}
		if _, err := st.AppendEntry("default", e); err != nil {
			t.Fatalf("append %s: %v", path, err)
		}
	}
	put("big.bin", strings.Repeat("b", 30))
	put("old.md", strings.Repeat("o", 40))
	put("old.md", strings.Repeat("o", 5))
	put("gone.bin", strings.Repeat("g", 50))
	if _, err := st.AppendEntry("default", store.Entry{Path: "gone.bin", Deleted: true, MTime: 20, Mac: testMac}); err != nil {
		t.Fatalf("append deletion: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return dir
}

// serveOutcome starts a server with extra flags and reports whether it got as
// far as listening. A refusal returns before the listener opens, so a server
// that prints "listening on" has accepted the flags; it is then stopped.
func serveOutcome(t *testing.T, dir string, args ...string) (started bool, out string, err error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	buf := &safeBuffer{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, append([]string{"serve", "-data", dir, "-addr", "127.0.0.1:0"}, args...), buf)
	}()
	deadline := time.Now().Add(15 * time.Second)
	for {
		select {
		case err := <-done:
			return false, buf.String(), err
		default:
		}
		if strings.Contains(buf.String(), "listening on") {
			cancel()
			select {
			case err := <-done:
				return true, buf.String(), err
			case <-time.After(15 * time.Second):
				t.Fatal("the server did not stop when it was told to")
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("serve neither refused nor listened:\n%s", buf.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// docs/server.md said it plainly: lowering -max-file below a file already in
// the vault leaves that file unreachable to a new device. The client refuses
// to download a version over the ceiling the server advertised, records it as
// a failure, and carries on, so a phone paired after the flag changed reports
// the vault synced with one attachment missing and nothing on the server said
// a word. Documented is not fixed. The server holds the sizes, so it can see
// the mismatch before it opens the port, and it refuses to start rather than
// warn: a warning is read by whoever reads journals, a refusal by whoever
// typed the flag. Nothing is lost by refusing; the fix is the flag.
func TestServeRefusesACeilingBelowAFileTheVaultHolds(t *testing.T) {
	dir := dirWithLargeFiles(t)

	started, out, err := serveOutcome(t, dir, "-max-file", "20")
	if started {
		t.Fatalf("serve started with -max-file 20 over a 30 byte file:\n%s", out)
	}
	if err == nil {
		t.Fatalf("serve returned no error:\n%s", out)
	}
	// It names the file it cannot serve, by the two things the server knows
	// about it, and says what to do.
	for _, want := range []string{"uid 1", "30 bytes", "-max-file"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the refusal does not say %q:\n%v", want, err)
		}
	}
	// History over the ceiling and a deleted file over it are not files a
	// device would ask for, and naming them would send someone hunting for
	// files that are not there.
	for _, wrong := range []string{"uid 2", "uid 4", "40 bytes", "50 bytes"} {
		if strings.Contains(err.Error(), wrong) {
			t.Fatalf("the refusal names %q, which no device would download:\n%v", wrong, err)
		}
	}
}

// At the ceiling is fine: the check is about content a device could not fetch,
// and a 30 byte file under a 30 byte ceiling can be.
func TestServeStartsWhenTheCeilingCoversEveryLiveFile(t *testing.T) {
	dir := dirWithLargeFiles(t)
	started, out, err := serveOutcome(t, dir, "-max-file", "30")
	if !started {
		t.Fatalf("serve refused a ceiling that covers every live file: %v\n%s", err, out)
	}
	if err != nil {
		t.Fatalf("serve ended with: %v", err)
	}
}

/* ---------------------------------------------------------------- *
 * The way out of a ceiling below the content
 * ---------------------------------------------------------------- */

// The refusal above is right, and for a while it was also a dead end.
//
// The sequence that produces it with nobody touching a flag: upload a file
// above the ceiling, back up, delete it on a device so its newest version is a
// deletion and it stops counting, lower the flag, serve starts. Then restore
// that backup the documented way. The file is live again, the ceiling is below
// it, and the server will not start.
//
// The message's second remedy was "delete or shrink the file on a device
// first", which is impossible from exactly there: a device deletes by pushing
// an entry, and there is no server to push to. purge cannot help either, since
// it keeps MAX(uid) per path by construction. So the only remedy offered as a
// standalone fix must be one a stopped server has, which is the flag, and the
// order that gets the ceiling back down is spelled out rather than implied.
func TestTheRefusalOffersOnlyRemediesAStoppedServerHas(t *testing.T) {
	dir := dirWithLargeFiles(t)
	_, _, err := serveOutcome(t, dir, "-max-file", "20")
	if err == nil {
		t.Fatal("serve did not refuse")
	}
	msg := err.Error()

	// The flag, with the number, is the remedy that works from here.
	if !strings.Contains(msg, "Start with -max-file 30 or more") {
		t.Fatalf("the refusal does not offer the one remedy a stopped server has:\n%s", msg)
	}
	// It says where the flag goes when the server is not started by hand,
	// which is the state anyone hitting this at three in the morning is in.
	for _, want := range []string{"basaltd service -max-file 30", "Docker"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("the refusal does not say %q:\n%s", want, msg)
		}
	}
	// It says the impossible thing is impossible, rather than offering it.
	if !strings.Contains(msg, "Deleting on a device is not a way out from here") {
		t.Fatalf("the refusal still leaves deleting on a device looking like a fix:\n%s", msg)
	}
	// And it says this can arrive without anyone having typed a flag, because
	// the first thing anyone does is go looking for the flag they changed.
	if !strings.Contains(msg, "restoring a backup") {
		t.Fatalf("the refusal does not say a restore can produce this:\n%s", msg)
	}
}

// `basaltd service` is the documented way to turn "run it by hand with
// -max-file" into something permanent, and the unit it printed had no
// -max-file in it at all. So the flag was dropped silently, the unit refused to
// start, and Restart=always with RestartSec=5 and no start limit reprinted the
// refusal every five seconds for ever without the unit ever reaching failed.
func TestTheUnitCarriesTheFileCeiling(t *testing.T) {
	dir := t.TempDir()
	out := mustRun(t, "service", "-data", dir, "-max-file", "104857600")
	if !strings.Contains(out, "-max-file 104857600") {
		t.Fatalf("the unit drops the ceiling it was given:\n%s", out)
	}
	// Spelled out even at the default, so an upgrade that moves the default
	// cannot move a running server's ceiling underneath it.
	plain := mustRun(t, "service", "-data", dir)
	if !strings.Contains(plain, fmtInt64Flag(store.DefaultPerFileMax)) {
		t.Fatalf("the unit leaves the ceiling to whatever the binary defaults to:\n%s", plain)
	}
	// And the loop ends. Five refusals inside five minutes and systemd stops,
	// so `systemctl status` says failed instead of the journal filling up.
	for _, want := range []string{"StartLimitIntervalSec=5min", "StartLimitBurst=5"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("the unit has no start limit, so a refusal loops for ever:\n%s", plain)
		}
	}
}

func fmtInt64Flag(n int64) string { return "-max-file " + fmt.Sprintf("%d", n) }

// The check serve makes, made where the unit is written. Generating a unit
// whose ceiling is below a file the vault already holds produces a unit that
// cannot start, and finding that out from the journal is finding it out later
// than necessary.
func TestServiceRefusesToWriteAUnitThatWouldNotStart(t *testing.T) {
	dir := dirWithLargeFiles(t)
	out, err := basalt(t, "service", "-data", dir, "-max-file", "20")
	if err == nil {
		t.Fatalf("service printed a unit that could never start:\n%s", out)
	}
	for _, want := range []string{"would not start", "uid 1", "30 bytes"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the refusal does not say %q:\n%v", want, err)
		}
	}
	if strings.Contains(out, "ExecStart=") {
		t.Fatalf("service printed the unit before refusing:\n%s", out)
	}
	// A ceiling that covers the vault prints as usual.
	if got := mustRun(t, "service", "-data", dir, "-max-file", "30"); !strings.Contains(got, "-max-file 30") {
		t.Fatalf("service refused a ceiling that covers every live file:\n%s", got)
	}
}

// The ordinary case is a data directory that does not exist yet: `basaltd
// service` is run before the first serve. There is nothing to check and
// nothing to refuse.
func TestServiceStillPrintsForADirectoryThatIsNotThereYet(t *testing.T) {
	out := mustRun(t, "service", "-data", filepath.Join(t.TempDir(), "not-yet"))
	if !strings.Contains(out, "ExecStart=") {
		t.Fatalf("service printed no unit for a fresh directory:\n%s", out)
	}
}
