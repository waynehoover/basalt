//go:build rehearsal

// The restore rehearsal, run as its own command and its own CI job.
//
// docs/server.md has carried the rehearsal as prose since the backup was
// written: copy the offsite backup somewhere fresh, verify it deeply, compare
// its newest uid, start a server on it, read a note back. improvements.md
// proposes an eleventh durability rule out of it, "a recovery path tested only
// in docs is a rumour", and the rumour is not that the steps are wrong. It is
// that nobody has run them since the last time the backup format, the schema or
// the startup checks moved.
//
// So this is the runbook, executed, against the built binary rather than
// against run() in this process: the operator's artifact is what has to work,
// and a rehearsal that exercises a function nobody ships is a rumour with a
// test next to it.
//
// Behind a build tag, and not part of `go test ./...`, for the reason the
// stress suite is its own command: a slow end-to-end check folded into six
// hundred unit tests is one a `-run` filter silently skips, and "the tests
// pass" was true once here while the suite that caught the shipped bug had been
// failing for weeks. Its own job so that "the restore rehearsal failed" is a
// sentence CI can say. scripts/check.sh runs it, and the guard in that script
// fails if CI ever runs a step the script does not.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// TestRestoreRehearsal walks the runbook end to end.
//
// The fixture is generated here rather than checked in, and that is a decision
// rather than convenience. A committed backup directory is a SQLite file and a
// tree of ciphertext bodies: unreviewable in a diff, and stale the moment the
// schema moves. What happens then is that somebody regenerates it from the
// build of the day, at which point it tests exactly what a generated one tests
// and has stopped being an old backup, silently. A fixture that quietly becomes
// something other than what its name says is the failure mode this whole
// project is arranged against, and it would be one more rumour.
//
// What a generated fixture deliberately does not cover is restoring a backup
// taken by an *older* build, which is a real recovery case. That is a schema
// question rather than a restore question, and it is covered where it belongs,
// in internal/store's migration tests, which build databases without the
// columns a later version added and open them. The line between the two is
// worth keeping: this test asks whether the backup the current build takes can
// be served back, and that one asks whether an old database can be opened.
func TestRestoreRehearsal(t *testing.T) {
	binary := buildBinary(t)

	// A vault with something in it worth losing: several paths, a file made of
	// more than one chunk, a superseded version, and a deletion. The bodies are
	// stand-ins for ciphertext, and the server never inspects them, which is
	// the whole reason a restore can be checked without a key.
	live, want := seedLiveVault(t)

	backup := filepath.Join(t.TempDir(), "offsite")
	runBinary(t, binary, "backup", "-data", live, "-to", backup)

	// Step 1: the disaster. The live directory is gone, and all that is left is
	// the copy. Renamed rather than deleted, so that a step below reaching for
	// it by accident fails loudly instead of quietly reading the original.
	if err := os.Rename(live, live+".gone"); err != nil {
		t.Fatalf("simulating the loss of the live directory: %v", err)
	}
	// `rsync -a` in the runbook: the thing being started must not be the
	// thing that was backed up.
	restore := filepath.Join(t.TempDir(), "restore")
	copyTree(t, backup, restore)

	// Step 2: check it against itself. Deep, because the shallow check only
	// asks whether the bodies are there and the question after a copy is
	// whether they are the bodies.
	out := runBinary(t, binary, "verify", "-deep", "-data", restore)
	if !strings.Contains(out, "0 faults") {
		t.Fatalf("the restored backup does not verify:\n%s", out)
	}
	// Not a vacuous pass. This guard used to look for "0 references", which the
	// line has never said, so a restore of an empty directory would have read
	// exactly like a restore of this one: the guard could not fail. Both counts
	// now, because a copy that carried the entries and lost the device rows
	// verifies deeply and leaves every device locked out (rule 8).
	if strings.Contains(out, "checked 0 chunk references") ||
		strings.Contains(out, "0 registry rows") {
		t.Fatalf("verify found nothing to check, so it proved nothing:\n%s", out)
	}

	// Step 3: what the restore holds, against what the backup claims it holds.
	// Two sources that a restore is entitled to expect to agree, and a backup
	// whose own metadata overstated it would be the worst kind of green.
	var stats statsJSON
	mustJSON(t, runBinary(t, binary, "stats", "-json", "-data", restore), &stats)
	if len(stats.Vaults) != 1 || stats.Vaults[0].Vault != rehearsalVault {
		t.Fatalf("the restore holds %+v", stats.Vaults)
	}
	if got := stats.Vaults[0].LatestUID; got != want.latestUID {
		t.Fatalf("the restore is at uid %d, the vault that was backed up was at %d", got, want.latestUID)
	}
	if got := stats.Vaults[0].Versions; got != int64(len(want.entries)) {
		t.Fatalf("the restore holds %d versions, %d were backed up", got, len(want.entries))
	}
	assertBackupMetaAgrees(t, restore, want)

	// Step 4: a server on it, on a port of its own, with no device pointed at
	// the live one. This is the step the prose could never really promise: the
	// startup checks run here, and a restored vault holding a file above the
	// default ceiling, or claimed by a build whose key schedule is gone, is
	// refused at exactly this point and nowhere earlier.
	addr := serveRestore(t, binary, restore)

	// Step 5: read it back. Every version the vault held, and every body behind
	// them, compared byte for byte with what went in. The server holds no key
	// and neither does this test: what a restore has to prove is that the same
	// uid still answers with the same bytes, and decrypting them would prove
	// nothing further about the copy.
	readEverythingBack(t, addr, want)
}

/* ---------------------------------------------------------------- *
 * The fixture
 * ---------------------------------------------------------------- */

const (
	rehearsalVault  = "default"
	rehearsalDevice = "rehearsal-device"
	// rehearsalKey is the credential the device below connects with. Only its
	// hash is stored, and it protects a vault that exists for the length of one
	// test, so it is a fixed string rather than something read from anywhere.
	rehearsalKey = "rehearsal-device-key-not-a-secret"
)

// seeded is what the rehearsal expects to find on the other side of the copy.
type seededVault struct {
	entries   []store.Entry
	bodies    map[string][]byte // chunk name -> the bytes that went in
	latestUID int64
}

// seedLiveVault builds a data directory with a vault in it, through the store
// rather than over the wire, and returns everything a reader should get back.
//
// Through the store because what is being rehearsed is the backup and the
// restore, not the push: seeding over the wire would put the client protocol
// in the path of a test about the copy, and a failure there would read as a
// restore failure.
func seedLiveVault(t *testing.T) (string, seededVault) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(store.DataDir(dir))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.EnsureVault(rehearsalVault, 1); err != nil {
		t.Fatalf("ensure vault: %v", err)
	}
	// Claimed, and with one device registered, because a restore nobody can
	// connect to is not a restore. The vault hash is what a registration is
	// checked against; the device's own hash is what it connects with.
	vaultHash := strings.Repeat("ab", 32)
	if ok, err := st.ClaimVault(rehearsalVault, vaultHash, testWrapped, 1); err != nil || !ok {
		t.Fatalf("claiming: ok=%v err=%v", ok, err)
	}
	if err := st.RegisterDevice(rehearsalVault, rehearsalDevice, "rehearsal",
		hashHex(rehearsalKey), vaultHash, store.MaxDevices, 1); err != nil {
		t.Fatalf("registering the rehearsal device: %v", err)
	}

	seeded := seededVault{bodies: map[string][]byte{}}
	put := func(path string, deleted bool, bodies ...string) {
		t.Helper()
		names := make([]string, 0, len(bodies))
		var size int64
		for _, b := range bodies {
			n := chunks.Name([]byte(b))
			if err := st.Chunks().Put(rehearsalVault, n, []byte(b)); err != nil {
				t.Fatalf("put chunk: %v", err)
			}
			names = append(names, n)
			seeded.bodies[n] = []byte(b)
			size += int64(len(b))
		}
		e := store.Entry{Path: path, Size: size, MTime: 10, Device: "seed",
			Chunks: names, Mac: testMac, Deleted: deleted}
		uid, err := st.AppendEntry(rehearsalVault, e)
		if err != nil {
			t.Fatalf("append %s: %v", path, err)
		}
		e.UID = uid
		seeded.entries = append(seeded.entries, e)
		seeded.latestUID = uid
	}

	put("daily/2026-09-04.md", false, "a note that must survive the copy")
	put("daily/2026-09-04.md", false, "the same note, edited, so there is history to lose")
	put("attachments/diagram.png", false, "chunk one ", "chunk two ", "chunk three")
	put("archive/old.md", false, "a note nothing has touched in a year")
	// A deletion, because rule 6 says a deleted file leaves a record and a
	// restore that dropped the record would report the vault as smaller and
	// call it success.
	put("archive/removed.md", true)

	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return dir, seeded
}

// assertBackupMetaAgrees checks the backup's own metadata against the vault it
// was taken from. A backup.json that claims more than the database holds is a
// backup that will be trusted for a purge it does not cover.
func assertBackupMetaAgrees(t *testing.T, dir string, want seededVault) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "backup.json"))
	if err != nil {
		t.Fatalf("the backup wrote no metadata: %v", err)
	}
	var meta struct {
		Vaults []struct {
			Vault     string `json:"vault"`
			LatestUID int64  `json:"latestUid"`
			Versions  int64  `json:"versions"`
		} `json:"vaults"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatalf("backup.json is not JSON: %v\n%s", err, raw)
	}
	for _, v := range meta.Vaults {
		if v.Vault != rehearsalVault {
			continue
		}
		if v.LatestUID != want.latestUID || v.Versions != int64(len(want.entries)) {
			t.Fatalf("backup.json claims uid %d over %d versions; the vault had uid %d over %d",
				v.LatestUID, v.Versions, want.latestUID, len(want.entries))
		}
		return
	}
	t.Fatalf("backup.json does not mention %q:\n%s", rehearsalVault, raw)
}

/* ---------------------------------------------------------------- *
 * Driving the built binary
 * ---------------------------------------------------------------- */

// hashHex is what the store keeps instead of a credential: the hex sha-256 of
// the key a device connects with.
func hashHex(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

func buildBinary(t *testing.T) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "basaltd")
	cmd := exec.Command("go", "build", "-o", out, "./cmd/basaltd")
	cmd.Dir = repoServerDir(t)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building basaltd: %v\n%s", err, b)
	}
	return out
}

// repoServerDir is the server module root, whatever directory the test binary
// was started in.
func repoServerDir(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// The test runs in server/cmd/basaltd.
	return filepath.Dir(filepath.Dir(wd))
}

func runBinary(t *testing.T, binary string, args ...string) string {
	t.Helper()
	cmd := exec.Command(binary, args...)
	b, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("basaltd %s: %v\n%s", strings.Join(args, " "), err, b)
	}
	return string(b)
}

func mustJSON(t *testing.T, s string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(s), v); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, s)
	}
}

// serveRestore starts the built binary on the restored directory and waits for
// it to answer, returning the address to connect to.
func serveRestore(t *testing.T, binary, dir string) string {
	t.Helper()
	addr := freePort(t)
	cmd := exec.Command(binary, "serve", "-data", dir, "-addr", addr, "-localhost")
	var log strings.Builder
	cmd.Stdout, cmd.Stderr = &log, &log
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting the rehearsal server: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { _, _ = cmd.Process.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
		}
		if t.Failed() {
			t.Logf("rehearsal server output:\n%s", log.String())
		}
	})

	// Its own health command rather than a dial loop, because that is the check
	// the container image and the runbook both use, and a rehearsal that used a
	// different one would be rehearsing something nobody runs.
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := http.Get("http://" + addr + "/health"); err == nil {
			return addr
		}
		if time.Now().After(deadline) {
			t.Fatalf("the restored server never answered on %s:\n%s", addr, log.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	return addr
}

/* ---------------------------------------------------------------- *
 * Reading it back over the wire
 * ---------------------------------------------------------------- */

// readEverythingBack connects as the registered device and checks that the
// restored server serves what the backup held: every version, in order, with
// the same paths and sizes, and every chunk body byte for byte.
//
// Rule 10, and the reason this does not stop at "the server started": a
// rehearsal that asserted only that a connection succeeded would pass over an
// empty vault, which is the exact shape of the failure it exists to catch.
func readEverythingBack(t *testing.T, addr string, want seededVault) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, "ws://"+addr, nil)
	if err != nil {
		t.Fatalf("dialling the restored server: %v", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 26)

	send := func(v any) {
		t.Helper()
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	read := func() (websocket.MessageType, []byte) {
		t.Helper()
		typ, b, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		return typ, b
	}

	send(wire.In{Op: "hello", ID: 1, Proto: wire.Proto, Crypto: wire.Crypto,
		Vault: rehearsalVault, Device: "rehearsal", DeviceID: rehearsalDevice,
		Token: rehearsalKey, Cursor: 0})

	var ready wire.Ready
	_, frame := read()
	if err := json.Unmarshal(frame, &ready); err != nil || ready.Res != "ready" {
		t.Fatalf("the restored server refused the device the backup carried: %s", frame)
	}
	if ready.Cursor != want.latestUID {
		t.Fatalf("the restored server offers cursor %d, the backup held up to %d",
			ready.Cursor, want.latestUID)
	}

	// The catch-up, which is what a device paired before the loss would get.
	var got []store.Entry
	cursor := int64(0)
	for {
		typ, data := read()
		if typ != websocket.MessageText {
			t.Fatalf("a body frame arrived during catch-up")
		}
		var probe struct {
			Op string `json:"op"`
		}
		_ = json.Unmarshal(data, &probe)
		switch probe.Op {
		case "batch":
			var b wire.Batch
			if err := json.Unmarshal(data, &b); err != nil {
				t.Fatalf("batch: %v\n%s", err, data)
			}
			if b.From != cursor+1 {
				t.Fatalf("the restored history has a gap: batch from %d after cursor %d", b.From, cursor)
			}
			got = append(got, b.Entries...)
			cursor = b.To
		case "caught-up":
			goto compare
		default:
			t.Fatalf("unexpected frame during catch-up: %s", data)
		}
	}

compare:
	if len(got) != len(want.entries) {
		t.Fatalf("the restored server served %d versions, the backup held %d", len(got), len(want.entries))
	}
	for i, w := range want.entries {
		g := got[i]
		if g.UID != w.UID || g.Path != w.Path || g.Size != w.Size || g.Deleted != w.Deleted {
			t.Fatalf("version %d came back as uid %d %q size %d deleted %v, was uid %d %q size %d deleted %v",
				i, g.UID, g.Path, g.Size, g.Deleted, w.UID, w.Path, w.Size, w.Deleted)
		}
		if len(g.Chunks) != len(w.Chunks) {
			t.Fatalf("uid %d names %d chunks, was %d", g.UID, len(g.Chunks), len(w.Chunks))
		}
		for j := range w.Chunks {
			if g.Chunks[j] != w.Chunks[j] {
				t.Fatalf("uid %d chunk %d is %s, was %s", g.UID, j, g.Chunks[j], w.Chunks[j])
			}
		}
	}

	// And the bodies. An entry naming a chunk the restore does not hold is the
	// failure a shallow verify would have missed and a device would have met as
	// a download that never finishes.
	var names []string
	for _, w := range want.entries {
		names = append(names, w.Chunks...)
	}
	if len(names) == 0 {
		t.Fatal("the fixture has no bodies, so fetching proves nothing")
	}
	send(wire.In{Op: "fetch", ID: 2, Chunks: names})
	var head wire.Bodies
	_, frame = read()
	if err := json.Unmarshal(frame, &head); err != nil || head.Res != "bodies" {
		t.Fatalf("the restored server would not serve its bodies: %s", frame)
	}
	for i, n := range names {
		typ, body := read()
		if typ != websocket.MessageBinary {
			t.Fatalf("body %d of %d is not a binary frame: %s", i, len(names), body)
		}
		if string(body) != string(want.bodies[n]) {
			t.Fatalf("chunk %s came back as %q, was %q", n, body, want.bodies[n])
		}
	}
	fmt.Fprintf(os.Stderr, "rehearsal: %d versions and %d bodies served back from the backup\n",
		len(got), len(names))
}
