// The commands, run.
//
// This package had no tests. Everything under internal/ is exercised heavily and
// the four things a person actually types were not, including the two that can
// destroy data. `backup` promises that restoring is copying the directory back,
// and nothing had ever copied one back.
//
// These call run() rather than a subprocess, so a failure points at a line.

package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/basalt/internal/dirlock"

	"github.com/waynehoover/basalt/internal/chunks"
	"github.com/waynehoover/basalt/internal/store"
)

// seeded builds a data directory with some history in it, the way a server
// would have, and returns its path.
func seeded(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "basalt.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatalf("ensure vault: %v", err)
	}

	put := func(path string, bodies ...string) store.Entry {
		t.Helper()
		names := make([]string, 0, len(bodies))
		size := 0
		for _, b := range bodies {
			n := chunks.Name([]byte(b))
			if err := st.Chunks().Put("default", n, []byte(b)); err != nil {
				t.Fatalf("put chunk: %v", err)
			}
			names = append(names, n)
			size += len(b)
		}
		e := store.Entry{Path: path, Size: int64(size), MTime: 10, Device: "seed", Chunks: names}
		uid, err := st.AppendEntry("default", e)
		if err != nil {
			t.Fatalf("append %s: %v", path, err)
		}
		e.UID = uid
		return e
	}

	put("note.md", "version one")
	put("note.md", "version two")
	put("note.md", "version three")
	put("other.md", "only version")
	put("attachment.bin", "part one ", "part two ", "part three")
	if _, err := st.AppendEntry("default", store.Entry{Path: "gone.md", Deleted: true, MTime: 20}); err != nil {
		t.Fatalf("append deletion: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return dir
}

// basalt runs a command and returns what it printed.
func basalt(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(context.Background(), args, &out)
	return out.String(), err
}

func mustRun(t *testing.T, args ...string) string {
	t.Helper()
	out, err := basalt(t, args...)
	if err != nil {
		t.Fatalf("basalt %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return out
}

/* ---------------------------------------------------------------- *
 * verify
 * ---------------------------------------------------------------- */

func TestVerifyIsQuietOnAGoodDirectory(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "verify", "-data", dir, "-deep")
	if !strings.Contains(out, "0 faults") {
		t.Fatalf("verify said:\n%s", out)
	}
}

// The whole point of naming chunks by their hash: a body that has rotted can be
// found rather than served.
func TestVerifyDeepFindsARottedBody(t *testing.T) {
	dir := seeded(t)
	corruptOneBody(t, dir)

	// The shallow pass only asks whether the file is there, and it is.
	shallow := mustRun(t, "verify", "-data", dir)
	if !strings.Contains(shallow, "0 faults") {
		t.Fatalf("a shallow verify should not have read the bytes:\n%s", shallow)
	}

	out, err := basalt(t, "verify", "-data", dir, "-deep")
	if err == nil {
		t.Fatalf("a deep verify passed over a corrupt body:\n%s", out)
	}
	if !strings.Contains(out, "corrupt") {
		t.Fatalf("deep verify said:\n%s", out)
	}
}

func TestVerifyFindsAMissingBody(t *testing.T) {
	dir := seeded(t)
	removeOneBody(t, dir)
	out, err := basalt(t, "verify", "-data", dir)
	if err == nil {
		t.Fatalf("verify passed over a missing body:\n%s", out)
	}
	if !strings.Contains(out, "missing") {
		t.Fatalf("verify said:\n%s", out)
	}
}

/* helpers that damage a directory in the two ways it can be damaged */

func bodyPaths(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(filepath.Join(dir, "chunks"), func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			out = append(out, p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk chunks: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("no chunk bodies to damage")
	}
	return out
}

func corruptOneBody(t *testing.T, dir string) {
	t.Helper()
	p := bodyPaths(t, dir)[0]
	body, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	body[0] ^= 0xff
	if err := os.WriteFile(p, body, 0o600); err != nil {
		t.Fatalf("write body: %v", err)
	}
}

func removeOneBody(t *testing.T, dir string) {
	t.Helper()
	if err := os.Remove(bodyPaths(t, dir)[0]); err != nil {
		t.Fatalf("remove body: %v", err)
	}
}

func countBodies(t *testing.T, dir string) int {
	t.Helper()
	return len(bodyPaths(t, dir))
}

func fmtInt(n int) string { return fmt.Sprintf("%d", n) }

/* ---------------------------------------------------------------- *
 * backup
 * ---------------------------------------------------------------- */

// The promise the whole design rests on: a backup is a data directory, so
// restoring is copying it back. Nothing had ever copied one back.
func TestABackupIsADataDirectoryYouCanRestoreByCopying(t *testing.T) {
	source := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	out := mustRun(t, "backup", "-data", source, "-to", dest)
	if !strings.Contains(out, "backed up to") {
		t.Fatalf("backup said:\n%s", out)
	}

	// Restoring, in full: a copy of the directory, opened as itself.
	restored := filepath.Join(t.TempDir(), "restored")
	copyTree(t, dest, restored)

	before := readEverything(t, source)
	after := readEverything(t, restored)
	if len(before) == 0 {
		t.Fatal("the source had nothing in it, so this proves nothing")
	}
	if len(before) != len(after) {
		t.Fatalf("source holds %d versions, the restored copy holds %d", len(before), len(after))
	}
	for path, content := range before {
		if after[path] != content {
			t.Fatalf("%s reads as %q in the restored copy and %q in the source", path, after[path], content)
		}
	}

	// And it stands up to the tool whose job is saying so.
	if v := mustRun(t, "verify", "-data", restored, "-deep"); !strings.Contains(v, "0 faults") {
		t.Fatalf("the restored copy does not verify:\n%s", v)
	}
}

// Incremental, because chunk names are content hashes. A second backup into the
// same directory should copy nothing.
func TestASecondBackupCopiesNothingNew(t *testing.T) {
	source := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")

	first := mustRun(t, "backup", "-data", source, "-to", dest)
	if strings.Contains(first, "0 bodies copied") {
		t.Fatalf("the first backup copied nothing:\n%s", first)
	}
	second := mustRun(t, "backup", "-data", source, "-to", dest)
	if !strings.Contains(second, "0 bodies copied") {
		t.Fatalf("a repeat backup copied bodies it already had:\n%s", second)
	}
	if v := mustRun(t, "verify", "-data", dest, "-deep"); !strings.Contains(v, "0 faults") {
		t.Fatalf("the backup does not verify after a second run:\n%s", v)
	}
}

// A backup taken from a damaged source must not report success. It is the one
// moment somebody is relying on the answer.
func TestBackupRefusesWhenTheSourceIsMissingABody(t *testing.T) {
	source := seeded(t)
	removeOneBody(t, source)
	dest := filepath.Join(t.TempDir(), "backup")

	out, err := basalt(t, "backup", "-data", source, "-to", dest)
	if err == nil {
		t.Fatalf("backup reported success from a source with a body missing:\n%s", out)
	}
}

func TestBackupNeedsSomewhereToPutIt(t *testing.T) {
	source := seeded(t)
	if _, err := basalt(t, "backup", "-data", source); err == nil {
		t.Fatal("backup with no -to should refuse")
	}
}

// A backup captures history, so it is the thing that survives a purge.
func TestABackupTakenBeforeAPurgeStillHasTheHistory(t *testing.T) {
	source := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-data", source, "-to", dest)

	beforeVersions := len(readEverything(t, dest))
	mustRun(t, "purge", "-data", source)
	afterVersions := len(readEverything(t, source))

	if afterVersions >= beforeVersions {
		t.Fatalf("purge removed nothing: %d versions before, %d after", beforeVersions, afterVersions)
	}
	// The backup is untouched, which is the whole reason to take one.
	if len(readEverything(t, dest)) != beforeVersions {
		t.Fatal("purging the source changed the backup")
	}
	if v := mustRun(t, "verify", "-data", dest, "-deep"); !strings.Contains(v, "0 faults") {
		t.Fatalf("the backup stopped verifying when the source was purged:\n%s", v)
	}
}

/* ---------------------------------------------------------------- *
 * reading a data directory back, without going through a server
 * ---------------------------------------------------------------- */

// readEverything returns every version in a directory, keyed by uid and path,
// with its reassembled ciphertext. It is deliberately not "the newest version
// of each path": a backup that kept only the newest would pass a check that
// asked only about the newest.
func readEverything(t *testing.T, dir string) map[string]string {
	t.Helper()
	st, err := store.Open(filepath.Join(dir, "basalt.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open %s: %v", dir, err)
	}
	defer st.Close()

	vaults, err := st.Vaults()
	if err != nil {
		t.Fatalf("vaults: %v", err)
	}
	out := map[string]string{}
	for _, v := range vaults {
		cursor := int64(0)
		for {
			batch, ok, err := st.NextBatch(v, cursor, 500)
			if err != nil {
				t.Fatalf("batch: %v", err)
			}
			if !ok {
				break
			}
			for _, e := range batch.Entries {
				var body strings.Builder
				for _, name := range e.Chunks {
					b, err := st.Chunks().Get(v, name)
					if err != nil {
						t.Fatalf("get %s for %s: %v", name, e.Path, err)
					}
					body.Write(b)
				}
				out[v+"/"+fmtInt(int(e.UID))+"/"+e.Path] = body.String()
			}
			cursor = batch.To
		}
	}
	return out
}

func copyTree(t *testing.T, from, to string) {
	t.Helper()
	err := filepath.Walk(from, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(from, p)
		if err != nil {
			return err
		}
		target := filepath.Join(to, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		body, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, body, 0o600)
	})
	if err != nil {
		t.Fatalf("copy %s to %s: %v", from, to, err)
	}
}

/* ---------------------------------------------------------------- *
 * purge
 * ---------------------------------------------------------------- */

// Purge is the only thing here that destroys data on purpose, so what survives
// matters more than what goes.
func TestPurgeKeepsTheNewestOfEachPathAndNothingElse(t *testing.T) {
	dir := seeded(t)
	before := newestByPath(t, dir)
	if len(before) == 0 {
		t.Fatal("nothing to purge")
	}

	out := mustRun(t, "purge", "-data", dir)
	if !strings.Contains(out, "versions") || !strings.Contains(out, "removed") {
		t.Fatalf("purge did not print its arithmetic:\n%s", out)
	}

	after := newestByPath(t, dir)
	if len(after) != len(before) {
		t.Fatalf("purge left %d paths, want %d", len(after), len(before))
	}
	for path, content := range before {
		if after[path] != content {
			t.Fatalf("the newest %s reads as %q after the purge and %q before", path, after[path], content)
		}
	}
	// And the bodies the survivors need are still there.
	if v := mustRun(t, "verify", "-data", dir, "-deep"); !strings.Contains(v, "0 faults") {
		t.Fatalf("the vault does not verify after a purge:\n%s", v)
	}
}

// Rule 5: an operation that makes a list smaller reports its arithmetic, so an
// implausible figure is visible rather than inferred from a success message.
func TestPurgeArithmeticAddsUp(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "purge", "-data", dir)

	var before, after, removed int
	if _, err := fmt.Sscanf(out, "versions %d -> %d (removed %d)", &before, &after, &removed); err != nil {
		t.Fatalf("could not read the arithmetic from:\n%s", out)
	}
	if before-removed != after {
		t.Fatalf("%d - %d != %d", before, removed, after)
	}
	if removed == 0 {
		t.Fatalf("a vault with three versions of one note purged nothing:\n%s", out)
	}
}

// Twice in a row is a no-op, which is what "keeps only the newest" means.
func TestPurgingTwiceRemovesNothingTheSecondTime(t *testing.T) {
	dir := seeded(t)
	mustRun(t, "purge", "-data", dir)
	out := mustRun(t, "purge", "-data", dir)
	if !strings.Contains(out, "(removed 0)") {
		t.Fatalf("a second purge removed something:\n%s", out)
	}
}

// Bodies no entry references any more are the space a purge is for.
func TestPurgeCollectsBodiesNothingReferences(t *testing.T) {
	dir := seeded(t)
	before := countBodies(t, dir)
	// Grace spares anything recent, and everything here was just written, so a
	// purge with the default window collects nothing. That is correct, and it
	// is also why this passes zero.
	out := mustRun(t, "purge", "-data", dir, "-grace", "0")
	after := countBodies(t, dir)
	if after >= before {
		t.Fatalf("purge collected nothing: %d bodies before, %d after\n%s", before, after, out)
	}
	if v := mustRun(t, "verify", "-data", dir, "-deep"); !strings.Contains(v, "0 faults") {
		t.Fatalf("purge collected a body something still needed:\n%s", v)
	}
}

// The grace window exists because a body can be uploaded moments before the
// entry that references it is committed. Collecting it in between starves the
// push, which is a livelock this project has already had once.
func TestPurgeSparesBodiesTooRecentToCollect(t *testing.T) {
	dir := seeded(t)
	before := countBodies(t, dir)
	out := mustRun(t, "purge", "-data", dir)
	if countBodies(t, dir) != before {
		t.Fatalf("purge collected a body written moments ago:\n%s", out)
	}
	if !strings.Contains(out, "spared") {
		t.Fatalf("purge did not say what it spared:\n%s", out)
	}
}

func newestByPath(t *testing.T, dir string) map[string]string {
	t.Helper()
	everything := readEverything(t, dir)
	newest := map[string]int{}
	out := map[string]string{}
	for key, content := range everything {
		parts := strings.SplitN(key, "/", 3)
		uid := 0
		fmt.Sscanf(parts[1], "%d", &uid)
		path := parts[0] + "/" + parts[2]
		if uid >= newest[path] {
			newest[path] = uid
			out[path] = content
		}
	}
	return out
}

/* ---------------------------------------------------------------- *
 * serve, and the locks that keep maintenance off a running server
 * ---------------------------------------------------------------- */

// A server holds the data directory, and purge deletes chunk bodies. The two
// together would let a sweep delete a body a live push had just written, which
// is what the lock is for.
func TestPurgeRefusesWhileAServerIsRunning(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()

	out, err := basalt(t, "purge", "-data", dir)
	if err == nil {
		t.Fatalf("purge ran against a live server:\n%s", out)
	}
	// And says what to do about it, rather than only that it failed.
	if !strings.Contains(err.Error(), "purge") && !strings.Contains(err.Error(), "running") {
		t.Fatalf("the refusal does not explain itself: %v", err)
	}
}

// Backup only reads, so it is allowed alongside a server. Refusing would mean
// the only safe time to back up is while sync is off.
func TestBackupRunsWhileAServerIsRunning(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()

	dest := filepath.Join(t.TempDir(), "backup")
	out := mustRun(t, "backup", "-data", dir, "-to", dest)
	if !strings.Contains(out, "backed up to") {
		t.Fatalf("backup said:\n%s", out)
	}
}

// Verify only reads too.
func TestVerifyRunsWhileAServerIsRunning(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()
	if out := mustRun(t, "verify", "-data", dir); !strings.Contains(out, "0 faults") {
		t.Fatalf("verify said:\n%s", out)
	}
}

// Two servers on one directory would each believe they were the only writer.
func TestASecondServerRefusesTheSameDirectory(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()

	_, err := basalt(t, "serve", "-data", dir, "-addr", "127.0.0.1:0")
	if err == nil {
		t.Fatal("a second server took a directory that was already served")
	}
}

// First run generates a token and says so, and the same directory keeps it.
// A token that changed on restart would lock out every paired device.
func TestServeKeepsItsTokenAcrossRestarts(t *testing.T) {
	dir := t.TempDir()

	first, stop := serveCapturing(t, dir)
	stop()
	if !strings.Contains(first, "A new auth token was generated") {
		t.Fatalf("the first run did not announce a new token:\n%s", first)
	}

	second, stop2 := serveCapturing(t, dir)
	stop2()
	if strings.Contains(second, "A new auth token was generated") {
		t.Fatalf("a restart generated a new token, locking out every paired device:\n%s", second)
	}
	if tokenLine(t, first) != tokenLine(t, second) {
		t.Fatalf("the token changed across a restart:\n%s\n%s", first, second)
	}
}

func tokenLine(t *testing.T, out string) string {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "#") {
			return strings.TrimSpace(line)
		}
	}
	t.Fatalf("no token line in:\n%s", out)
	return ""
}

/* helpers for running a server inside a test */

// safeBuffer is written by the serving goroutine and read by the test.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// serveInBackground starts a server and returns a function that stops it.
//
// It waits for the server lock to be taken rather than for a port to answer,
// because the lock is what the tests around it are about and because the port
// is chosen by the operating system and never printed.
func serveInBackground(t *testing.T, dir string) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"serve", "-data", dir, "-addr", "127.0.0.1:0"}, out)
	}()

	deadline := time.Now().Add(15 * time.Second)
	for dirlock.Holder(dir, dirlock.Server) == "" {
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("the server never took its lock:\n%s", out.String())
		}
		select {
		case err := <-done:
			cancel()
			t.Fatalf("the server stopped before it started: %v\n%s", err, out.String())
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}

	stopped := false
	return func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("the server ended with: %v", err)
			}
		case <-time.After(15 * time.Second):
			t.Error("the server did not stop when it was told to")
		}
	}
}

// serveCapturing starts a server, waits for it, and hands back what it printed.
func serveCapturing(t *testing.T, dir string) (string, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"serve", "-data", dir, "-addr", "127.0.0.1:0"}, out)
	}()

	deadline := time.Now().Add(15 * time.Second)
	for !strings.Contains(out.String(), "listening on") {
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("the server never said it was listening:\n%s", out.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	text := out.String()
	stopped := false
	return text, func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		<-done
	}
}

/* ---------------------------------------------------------------- *
 * a mistyped -data
 * ---------------------------------------------------------------- */

// Only `serve` has any business creating a data directory. For the others a
// path that is not there means somebody mistyped it, and creating an empty one
// turns the typo into a success message.
//
// Backup is the dangerous one. A person who rotates their backups on the
// strength of "backed up to ..." has now thrown away the copy that had their
// notes in it.
func TestCommandsRefuseADataDirectoryThatIsNotThere(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "typo")

	for _, args := range [][]string{
		{"backup", "-data", missing, "-to", filepath.Join(t.TempDir(), "backup")},
		{"verify", "-data", missing},
		{"verify", "-data", missing, "-deep"},
		{"purge", "-data", missing},
	} {
		out, err := basalt(t, args...)
		if err == nil {
			t.Fatalf("basalt %s succeeded against a directory that does not exist:\n%s",
				strings.Join(args, " "), out)
		}
		if !strings.Contains(err.Error(), "no basalt data directory") {
			t.Fatalf("basalt %s refused unhelpfully: %v", strings.Join(args, " "), err)
		}
	}

	// And nothing was created by asking.
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("a refused command created %s anyway", missing)
	}
}

// Serve does create one, because on a first run there is nothing there yet and
// that is the whole point.
func TestServeCreatesADataDirectoryOnItsFirstRun(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh")
	out, stop := serveCapturing(t, dir)
	stop()
	if !strings.Contains(out, "A new auth token was generated") {
		t.Fatalf("a first run should have set one up:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(dir, "basalt.db")); err != nil {
		t.Fatalf("serve did not create the database: %v", err)
	}
}
