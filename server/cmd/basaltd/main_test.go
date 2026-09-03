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
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/basalt-sync/server/internal/dirlock"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/server"
	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// A mac of the right shape, standing in for a real writer's. The server holds no
// key and checks only that an entry carries one, because an entry nothing can
// authenticate is refused by every reader for ever.
const testMac = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// A wrapped data key of the shape a client produces: 60 bytes in base64url.
// Every claim carries one, because every claimed vault has a data key.
const testWrapped = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

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
		e := store.Entry{Path: path, Size: int64(size), MTime: 10, Device: "seed", Chunks: names, Mac: testMac}
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
	if _, err := st.AppendEntry("default", store.Entry{Path: "gone.md", Deleted: true, MTime: 20, Mac: testMac}); err != nil {
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
	mustRun(t, "purge", "-data", source, "-confirm", "default", "-no-backup-check")
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

	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
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
	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")

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
	mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
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
	out := mustRun(t, "purge", "-data", dir, "-grace", "0", "-confirm", "default", "-no-backup-check")
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
	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
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

	out, err := basalt(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
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

// Stats only reads, but a purge is deleting the bodies it counts. It takes the
// shared lock like verify and backup, and used to take none.
func TestStatsRefusesWhileAPurgeHoldsTheDirectory(t *testing.T) {
	dir := seeded(t)
	lock, err := dirlock.Exclusive(dir, dirlock.Data, "purge")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()

	out, err := basalt(t, "stats", "-data", dir)
	if err == nil {
		t.Fatalf("stats ran while a purge held the data directory:\n%s", out)
	}
	if !strings.Contains(err.Error(), "purge") {
		t.Fatalf("the refusal does not say a purge is the reason: %v", err)
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
// A token that changed on restart would invalidate a pairing string somebody
// had already copied, and the failure would look like a typo.
func TestServeKeepsItsTokenAcrossRestarts(t *testing.T) {
	dir := t.TempDir()

	first, stop := serveCapturing(t, dir)
	stop()
	if !strings.Contains(first, "A new bootstrap token was generated") {
		t.Fatalf("the first run did not announce a new token:\n%s", first)
	}

	second, stop2 := serveCapturing(t, dir)
	stop2()
	if strings.Contains(second, "A new bootstrap token was generated") {
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
		{"purge", "-data", missing, "-confirm", "default", "-no-backup-check"},
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
	if !strings.Contains(out, "A new bootstrap token was generated") {
		t.Fatalf("a first run should have set one up:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(dir, "basalt.db")); err != nil {
		t.Fatalf("serve did not create the database: %v", err)
	}
}

/* ---------------------------------------------------------------- *
 * service
 * ---------------------------------------------------------------- */

// The unit is printed rather than installed. Writing into /etc needs root, and
// a program that asks for root to do something you could read first is one that
// gets run as root for the rest of its life.
func TestServicePrintsAUnitWithRealPathsInIt(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "service", "-data", dir, "-addr", "127.0.0.1:3010", "-vault", "notes", "-user", "basalt")

	for _, want := range []string{
		"[Unit]",
		"[Service]",
		"[Install]",
		"User=basalt",
		"-addr 127.0.0.1:3010",
		"-vault notes",
		"ReadWritePaths=" + dir,
		"WantedBy=multi-user.target",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("the unit has no %q in it:\n%s", want, out)
		}
	}
	// No placeholders. A unit with one in it fails on first start with a
	// message about a path nobody typed.
	for _, bad := range []string{"<", "PATH_TO", "CHANGEME", "%%"} {
		if strings.Contains(out, bad) {
			t.Fatalf("the unit still has %q in it:\n%s", bad, out)
		}
	}
	if !strings.Contains(out, "-data "+dir) {
		t.Fatalf("ExecStart does not name the data directory:\n%s", out)
	}
}

// This process holds every note somebody has and needs one directory and one
// socket. The unit says so to the kernel, so a defect in it has somewhere it
// cannot reach.
func TestTheUnitIsHardened(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "service", "-data", dir)

	for _, want := range []string{
		"NoNewPrivileges=true",
		"ProtectSystem=strict",
		"PrivateTmp=true",
		"CapabilityBoundingSet=",
		"RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
		"SystemCallFilter=@system-service",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("the unit is missing %q:\n%s", want, out)
		}
	}
}

/**
 * The hardening line that looks most obviously right is the one that would stop
 * the server starting. The default data directory is inside a home directory,
 * and ProtectHome=true makes that unreadable to the unit.
 */
func TestProtectHomeIsOnlySetWhenItWouldNotBreakTheService(t *testing.T) {
	inHome := mustRun(t, "service", "-data", "/home/somebody/.basalt")
	if strings.Contains(inHome, "\nProtectHome=true") {
		t.Fatalf("ProtectHome was set on a data directory inside a home:\n%s", inHome)
	}
	if !strings.Contains(inHome, "ProtectHome is left off") {
		t.Fatalf("nothing said why ProtectHome was missing:\n%s", inHome)
	}

	elsewhere := mustRun(t, "service", "-data", "/var/lib/basalt")
	if !strings.Contains(elsewhere, "\nProtectHome=true") {
		t.Fatalf("ProtectHome was left off where it would have been safe:\n%s", elsewhere)
	}
}

// The prefixes are a guess. The run-as user's real home is the answer, and a
// home somewhere unusual used to get ProtectHome=true and a unit that could
// not read its own data directory.
func TestProtectHomeKnowsWhereTheUsersHomeActuallyIs(t *testing.T) {
	if !underHome("/srv/people/wayne/.basalt", "/srv/people/wayne") {
		t.Fatal("a data directory inside an unusual home was not recognised as such")
	}
	if !underHome("/srv/people/wayne", "/srv/people/wayne/") {
		t.Fatal("the home directory itself, with a trailing slash on the home, was not recognised")
	}
	if underHome("/srv/people/wayne-data", "/srv/people/wayne") {
		t.Fatal("a sibling that merely shares a prefix was taken for the home")
	}
	if !underHome("/home/somebody/.basalt", "") {
		t.Fatal("the well-known prefixes stopped working when the home is unknown")
	}
	if underHome("/var/lib/basalt", "/") {
		t.Fatal("a home of / would mark every path as inside it")
	}
}

// Restarting must not be something a person has to notice. A sync server that
// stays down after one bad night is one you find out about from a device that
// has been quietly not syncing.
func TestTheUnitComesBackByItself(t *testing.T) {
	out := mustRun(t, "service", "-data", "/var/lib/basalt")
	if !strings.Contains(out, "Restart=always") {
		t.Fatalf("the unit does not restart:\n%s", out)
	}
	// And stops the way serve is written to be stopped, which is what makes an
	// ack mean stored across a restart.
	if !strings.Contains(out, "KillSignal=SIGTERM") {
		t.Fatalf("the unit does not stop with SIGTERM:\n%s", out)
	}
}

func TestServiceTellsYouHowToInstallIt(t *testing.T) {
	out := mustRun(t, "service", "-data", "/var/lib/basalt")
	for _, want := range []string{"systemctl daemon-reload", "systemctl enable --now basalt", "journalctl"} {
		if !strings.Contains(out, want) {
			t.Fatalf("the notes do not mention %q:\n%s", want, out)
		}
	}
	// Purge needs the server stopped and backup does not. Getting that wrong is
	// a purge that refuses, or worse, a habit of stopping sync to back up.
	if !strings.Contains(out, "systemctl stop basalt && ") {
		t.Fatalf("the notes do not say purge needs the server stopped:\n%s", out)
	}
	if strings.Contains(out, "systemctl stop basalt && ") && !strings.Contains(out, "Backups do not need the server stopped") {
		t.Fatalf("the notes do not say backup does not:\n%s", out)
	}
}

/* ---------------------------------------------------------------- *
 * stats and health
 * ---------------------------------------------------------------- */

// The numbers are separate rather than summed. "1.2 GB" says nothing about
// whether a purge would help; versions against files says exactly that.
//
// The seeded vault's deletion has no earlier version with content, so it is
// deleted and not recoverable, and stats has to say both. It said "1 deleted
// and still recoverable" for as long as this test existed, and this test
// asserted that string.
func TestStatsSaysWhatIsThereAndWhatAPurgeWouldDrop(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "stats", "-data", dir)

	for _, want := range []string{"files", "versions in all", "history",
		"1 deleted: 0 still recoverable, 1 purged and gone for good"} {
		if !strings.Contains(out, want) {
			t.Fatalf("stats does not mention %q:\n%s", want, out)
		}
	}

	// After a purge there is no history left, and it stops saying there is.
	mustRun(t, "purge", "-data", dir, "-confirm", "default", "-no-backup-check")
	after := mustRun(t, "stats", "-data", dir)
	if strings.Contains(after, "would drop") {
		t.Fatalf("stats still offers a purge with nothing left to drop:\n%s", after)
	}
}

// The other half: a deletion that can be restored from says so, and in the
// short form, because that is the ordinary case and it should stay one number.
func TestStatsKeepsTheShortLineWhenEveryDeletionIsRecoverable(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "basalt.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatalf("ensure vault: %v", err)
	}
	body := "something worth getting back"
	name := chunks.Name([]byte(body))
	if err := st.Chunks().Put("default", name, []byte(body)); err != nil {
		t.Fatalf("put chunk: %v", err)
	}
	if _, err := st.AppendEntry("default", store.Entry{
		Path: "gone.md", Size: int64(len(body)), MTime: 10, Chunks: []string{name}, Mac: testMac,
	}); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := st.AppendEntry("default", store.Entry{
		Path: "gone.md", Deleted: true, MTime: 20, Mac: testMac,
	}); err != nil {
		t.Fatalf("append deletion: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	out := mustRun(t, "stats", "-data", dir)
	if !strings.Contains(out, "1 deleted and still recoverable") {
		t.Fatalf("a recoverable deletion did not read as one:\n%s", out)
	}
	if strings.Contains(out, "gone for good") {
		t.Fatalf("a recoverable deletion was called gone:\n%s", out)
	}
}

func TestStatsRunsAgainstALiveServer(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()
	if out := mustRun(t, "stats", "-data", dir); !strings.Contains(out, "vault") {
		t.Fatalf("stats said:\n%s", out)
	}
}

func TestStatsRefusesADirectoryThatIsNotThere(t *testing.T) {
	if _, err := basalt(t, "stats", "-data", filepath.Join(t.TempDir(), "typo")); err == nil {
		t.Fatal("stats reported on a directory that does not exist")
	}
}

// The container image is a single static binary on an empty filesystem, so
// there is no curl in there to write a HEALTHCHECK with, and adding a shell to
// get one would undo the reason for the image being empty.
func TestHealthAsksARunningServer(t *testing.T) {
	dir := seeded(t)
	stop := serveInBackground(t, dir)
	defer stop()

	// The port is chosen by the operating system and never printed, so this
	// checks the shape of the answer rather than a live one: a server that is
	// not there must fail rather than pass.
	if _, err := basalt(t, "health", "-addr", "127.0.0.1:1", "-timeout", "2s"); err == nil {
		t.Fatal("health passed against a port with nothing on it")
	}
}

func TestHealthAgainstAServerOnAKnownPort(t *testing.T) {
	dir := seeded(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	port := freeTestPort(t)
	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"serve", "-data", dir, "-addr", fmt.Sprintf("127.0.0.1:%d", port)}, out)
	}()
	defer func() { cancel(); <-done }()

	deadline := time.Now().Add(15 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		if _, err := basalt(t, "health", "-addr", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			return
		} else {
			lastErr = err
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("health never passed against a running server: %v\n%s", lastErr, out.String())
}

// A bare port is what a bind address looks like, and asking about ":3003" must
// mean this machine rather than being a parse error inside a container.
func TestHealthUnderstandsABareBindAddress(t *testing.T) {
	_, err := basalt(t, "health", "-addr", ":1", "-timeout", "2s")
	if err == nil {
		t.Fatal("health passed against a port with nothing on it")
	}
	if strings.Contains(err.Error(), "not a host and port") {
		t.Fatalf("a bare bind address was not understood: %v", err)
	}
}

func freeTestPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// The builder image has to be new enough for the module.
//
// A mismatch is a build that fails only once somebody tries to make an image,
// which is later than it should be found, and the two versions live in
// different files with nothing tying them together. This is the tie.
func TestTheDockerfileBuildsWithAGoNewEnoughForTheModule(t *testing.T) {
	// Tests run in the package directory: the module root is two up and the
	// repository root, where the Dockerfile lives, is three.
	root := filepath.Join("..", "..", "..")
	dockerfile, err := os.ReadFile(filepath.Join(root, "Dockerfile"))
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	gomod, err := os.ReadFile(filepath.Join("..", "..", "go.mod"))
	if err != nil {
		t.Fatalf("read go.mod: %v", err)
	}

	wanted := majorMinor(findAfter(t, string(gomod), "go "))
	builder := majorMinor(findAfter(t, string(dockerfile), "ARG GO_VERSION="))
	if builder != wanted {
		t.Fatalf("go.mod needs Go %s and the Dockerfile builds with %s", wanted, builder)
	}
}

func findAfter(t *testing.T, text, prefix string) string {
	t.Helper()
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix))
		}
	}
	t.Fatalf("no line starting %q", prefix)
	return ""
}

func majorMinor(v string) string {
	parts := strings.Split(v, ".")
	if len(parts) < 2 {
		return v
	}
	return parts[0] + "." + parts[1]
}

// A bind address is not an address. Binding to every interface is the normal way
// to run this, because a phone cannot reach a server on loopback, but pasting
// "0.0.0.0:3003" into a device asks it to connect to nothing at all and the
// failure looks like a server that is down.
func TestTheSetupStringNamesSomethingADeviceCanDial(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:3003", ":3003", "[::]:3003"} {
		var out bytes.Buffer
		printSetup(&out, addr, "default", "TOKEN", true, false, true)
		got := out.String()

		for _, wildcard := range []string{"0.0.0.0:3003#", "[::]:3003#", " :3003#"} {
			if strings.Contains(got, wildcard) {
				t.Errorf("listening on %s printed %q as something to paste:\n%s", addr, wildcard, got)
			}
		}
		if !strings.Contains(got, "#TOKEN") {
			t.Errorf("listening on %s printed no pairing string at all:\n%s", addr, got)
		}
	}
}

// An explicit address is left exactly as given: it is already the answer.
func TestAnExplicitAddressIsPrintedAsGiven(t *testing.T) {
	var out bytes.Buffer
	printSetup(&out, "vault.example.ts.net:3003", "default", "TOKEN", false, false, true)
	if !strings.Contains(out.String(), "vault.example.ts.net:3003#TOKEN") {
		t.Errorf("an explicit address was rewritten:\n%s", out.String())
	}
}

// The bootstrap token claims an unclaimed vault and nothing else. Once a device
// has claimed one, printing it writes a dead credential to the log on every
// restart and offers it as a pairing string that fails when pasted.
func TestAClaimedVaultPrintsNoToken(t *testing.T) {
	var out bytes.Buffer
	printSetup(&out, "vault.example.ts.net:3003", "default", "SECRETTOKEN", false, false, false)
	got := out.String()

	if strings.Contains(got, "SECRETTOKEN") {
		t.Errorf("a claimed vault printed its spent bootstrap token:\n%s", got)
	}
	if !strings.Contains(got, "claimed") {
		t.Errorf("a claimed vault did not say so, so the missing token looks like a bug:\n%s", got)
	}
	// Whoever reads this is here to add a device, and the answer is on another
	// device rather than on this server.
	if !strings.Contains(got, "basalt invite") {
		t.Errorf("a claimed vault did not say how to add a device:\n%s", got)
	}
}

// -localhost exists so that trying this out on one machine needs no thought
// about schemes: a pairing string with none becomes wss://, and a loopback
// server has no TLS in front of it.
func TestLocalhostPrintsAStringThatCanBePastedAsIs(t *testing.T) {
	var out bytes.Buffer
	printSetup(&out, "127.0.0.1:3003", "default", "TOKEN", false, true, true)
	if !strings.Contains(out.String(), "ws://127.0.0.1:3003#TOKEN") {
		t.Errorf("-localhost printed a string that needs editing before use:\n%s", out.String())
	}
}

/* ---------------------------------------------------------------- *
 * I25: the caps are flags, and what the flag says is what ready says
 * ---------------------------------------------------------------- */

// -max-batch-bytes and -max-fetch-bytes reach ready, so a client test can lower
// the caps against the real binary. Out-of-range values are clamped and the
// clamped value is what is advertised, because advertised must equal enforced.
func TestI25TheCapFlagsReachReady(t *testing.T) {
	readyWith := func(t *testing.T, flags ...string) map[string]any {
		t.Helper()
		dir := t.TempDir()
		port := freeTestPort(t)
		addr := fmt.Sprintf("127.0.0.1:%d", port)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		out := &safeBuffer{}
		go func() { _ = run(ctx, append([]string{"serve", "-data", dir, "-addr", addr}, flags...), out) }()
		waitForServer(t, addr, out)

		wsCtx, wsCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer wsCancel()
		conn, _, err := websocket.Dial(wsCtx, "ws://"+addr, nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer conn.CloseNow()
		cl := &wsClient{t: t, conn: conn, ctx: wsCtx}
		cl.write(wire.In{Op: "hello", ID: 1, Proto: wire.Proto, Crypto: wire.Crypto, Vault: "default",
			Token: bootstrapToken(t, out.String()), Claim: strings.Repeat("k", 43),
			Wrapped: testWrapped, Device: "probe"})
		ready := cl.readJSON()
		if ready["res"] != "ready" {
			t.Fatalf("wanted ready, got %v", ready)
		}
		return ready
	}

	lowered := readyWith(t, "-max-batch-bytes", "2097152", "-max-fetch-bytes", "3145728")
	if lowered["maxBatchBytes"] != float64(2<<20) || lowered["maxFetchBytes"] != float64(3<<20) {
		t.Fatalf("lowered caps did not reach ready: batch %v fetch %v", lowered["maxBatchBytes"], lowered["maxFetchBytes"])
	}

	// Out of range both ways: clamped, and the clamp is what is advertised.
	clamped := readyWith(t, "-max-batch-bytes", "1", "-max-fetch-bytes", "999999999999")
	if clamped["maxBatchBytes"] != float64(store.ChunkMax) {
		t.Fatalf("a batch cap below one chunk was advertised as %v", clamped["maxBatchBytes"])
	}
	if clamped["maxFetchBytes"] != float64(store.PerFileMax) {
		t.Fatalf("a fetch cap above the file ceiling was advertised as %v", clamped["maxFetchBytes"])
	}
	raised := readyWith(t, "-max-batch-bytes", fmt.Sprint(server.ReadLimit))
	if raised["maxBatchBytes"] != float64(server.ReadLimit/2) {
		t.Fatalf("a batch cap at the read limit was advertised as %v, want half the read limit", raised["maxBatchBytes"])
	}
}

// A backup that has kept history the source purged holds more bodies than the
// source does, and the line about the difference has to survive that.
//
// It used to print source minus destination with the words "were not copied",
// which is a negative number of bodies as soon as retention is doing its job.
// The backup's numbers are the only evidence anyone has that a backup is
// sound, so one of them reading as nonsense costs more than the line is worth.
func TestBackupNeverPrintsANegativeBodyCount(t *testing.T) {
	source := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-data", source, "-to", dest)

	// The source drops its history and the bodies only the old versions
	// referenced; the backup keeps them.
	mustRun(t, "purge", "-data", source, "-grace", "0", "-confirm", "default", "-no-backup-check")

	out := mustRun(t, "backup", "-data", source, "-to", dest)
	if countBodies(t, dest) <= countBodies(t, source) {
		t.Fatalf("the backup does not hold more bodies than the purged source, so this proves nothing:\n%s", out)
	}
	if strings.Contains(out, "(-") {
		t.Fatalf("backup printed a negative body count:\n%s", out)
	}
	if !strings.Contains(out, "history it kept") {
		t.Fatalf("backup does not say why it holds more bodies than the source:\n%s", out)
	}
	if strings.Contains(out, "were not copied") {
		t.Fatalf("backup says bodies were not copied when it holds more than the source:\n%s", out)
	}
}
