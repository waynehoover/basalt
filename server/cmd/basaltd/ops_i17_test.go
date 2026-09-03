package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/store"
)

/* ---------------------------------------------------------------- *
 * S20: an existing token is made private on load
 * ---------------------------------------------------------------- */

// A token file left world-readable by a hand copy or an older build is
// tightened to 0600 when the server loads it, not only when it writes one.
func TestS20AnExisting0644TokenIsTightenedOnLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, tokenFileName)
	if err := os.WriteFile(path, []byte("copied-in-by-hand\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	token, fresh, err := loadOrCreateToken(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if fresh || token != "copied-in-by-hand" {
		t.Fatalf("load returned %q fresh=%v, the existing token was not kept", token, fresh)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("the token is still mode %o after loading, want 600", perm)
	}
}

/* ---------------------------------------------------------------- *
 * S28: the sessions get their own shutdown deadline
 * ---------------------------------------------------------------- */

// A listener that uses up its whole deadline must not leave the sessions with
// an expired one, or every session is cut off at once with nothing said.
func TestS28SessionsGetAFreshDeadlineAfterASlowListener(t *testing.T) {
	const timeout = 200 * time.Millisecond
	slowListener := func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}
	var left time.Duration
	sessions := func(ctx context.Context) error {
		deadline, ok := ctx.Deadline()
		if !ok {
			return errors.New("no deadline")
		}
		left = time.Until(deadline)
		return nil
	}
	listenerErr, sessionsErr := gracefulStop(slowListener, sessions, timeout)
	if listenerErr == nil {
		t.Fatal("the slow listener should have hit its deadline")
	}
	if sessionsErr != nil {
		t.Fatalf("sessions: %v", sessionsErr)
	}
	if left < timeout/2 {
		t.Fatalf("the sessions were given %s of a %s budget after the listener used its own", left, timeout)
	}
}

/* ---------------------------------------------------------------- *
 * I11: the startup line
 * ---------------------------------------------------------------- */

// One line at startup with the version and, for the served vault, the latest
// uid and whether it is claimed. It is what an operator compares a device's
// "server cursor" against when nothing seems to arrive.
func TestI11StartupLogsVersionLatestUIDAndClaimed(t *testing.T) {
	dir := seeded(t)
	st, err := openExisting(dir, "inspect")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	if err := logStartup(log, st, "default", "1.2.3"); err != nil {
		t.Fatal(err)
	}
	line := buf.String()
	for _, want := range []string{`msg=starting`, `version=1.2.3`, `vault=default`, `latest=6`, `claimed=false`} {
		if !strings.Contains(line, want) {
			t.Fatalf("the startup line lacks %s:\n%s", want, line)
		}
	}
	if strings.Count(line, "\n") != 1 {
		t.Fatalf("wanted exactly one line, got:\n%s", line)
	}

	// Claimed, and a vault the server is not serving is called out.
	if _, err := st.ClaimVault("default", strings.Repeat("ab", 32), "", 1); err != nil {
		t.Fatal(err)
	}
	if err := st.EnsureVault("other", 1); err != nil {
		t.Fatal(err)
	}
	buf.Reset()
	if err := logStartup(log, st, "default", "1.2.3"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "claimed=true") {
		t.Fatalf("the claimed vault is not reported as claimed:\n%s", buf.String())
	}
	if !strings.Contains(buf.String(), "not served") || !strings.Contains(buf.String(), "vault=other") {
		t.Fatalf("a vault that is present but not served went unmentioned:\n%s", buf.String())
	}
	// And the serve command emits it: the summary must not contain anything
	// that looks like a token or a hash.
	if strings.Contains(buf.String(), strings.Repeat("ab", 32)) {
		t.Fatal("the startup line leaks the auth hash")
	}
}

/* ---------------------------------------------------------------- *
 * I17: stats -json
 * ---------------------------------------------------------------- */

func TestI17StatsJSONCarriesEveryNumberTheProseDoes(t *testing.T) {
	dir := seeded(t)
	out := mustRun(t, "stats", "-data", dir, "-json")
	var rep statsJSON
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("stats -json is not JSON: %v\n%s", err, out)
	}
	if len(rep.Vaults) != 1 || rep.Vaults[0].Vault != "default" {
		t.Fatalf("vaults: %+v", rep.Vaults)
	}
	v := rep.Vaults[0]
	// seeded: note.md x3, other.md, attachment.bin, and a deletion of gone.md.
	if v.Files != 3 || v.Deleted != 1 || v.Versions != 6 || v.LatestUID != 6 || v.History != 2 {
		t.Fatalf("counts: %+v", v)
	}
	if v.Recoverable != 0 || v.Purged != 1 {
		// gone.md was deleted with no earlier content version, so it is
		// deleted and not recoverable, which the prose reports as purged.
		t.Fatalf("recoverable/purged: %+v", v)
	}
	if v.Claimed {
		t.Fatal("an unclaimed vault reports claimed")
	}
	if rep.Bodies == 0 || rep.GraceMs != time.Hour.Milliseconds() || rep.Version == "" {
		t.Fatalf("report: bodies=%d graceMs=%d version=%q", rep.Bodies, rep.GraceMs, rep.Version)
	}
	// The prose and the JSON agree on the headline number.
	prose := mustRun(t, "stats", "-data", dir)
	if !strings.Contains(prose, "3 files") || !strings.Contains(prose, "newest uid 6") {
		t.Fatalf("prose disagrees:\n%s", prose)
	}
	// An empty store is an empty list, not an error and not prose.
	empty := mustRun(t, "stats", "-data", emptyDataDir(t), "-json")
	if err := json.Unmarshal([]byte(empty), &rep); err != nil || len(rep.Vaults) != 0 {
		t.Fatalf("empty store: %v\n%s", err, empty)
	}
}

/* ---------------------------------------------------------------- *
 * I18: purge wants the name again and a backup that covers the vault
 * ---------------------------------------------------------------- */

func TestI18PurgeRefusesWithoutConfirmationAndABackup(t *testing.T) {
	cases := []struct {
		why  string
		args []string
		want string
	}{
		{"no confirm", []string{"-no-backup-check"}, "-confirm"},
		{"confirm names another vault", []string{"-confirm", "defualt", "-no-backup-check"}, "does not match"},
		{"neither backup nor no-backup-check", []string{"-confirm", "default"}, "-backup"},
		{"both backup and no-backup-check", []string{"-confirm", "default", "-backup", "/nowhere", "-no-backup-check"}, "contradict"},
		{"a backup path with no backup in it", []string{"-confirm", "default", "-backup", filepath.Join(os.TempDir(), "no-such-basalt-backup")}, "no backup at"},
	}
	for _, c := range cases {
		t.Run(c.why, func(t *testing.T) {
			dir := seeded(t)
			before := countBodies(t, dir)
			out, err := basalt(t, append([]string{"purge", "-data", dir}, c.args...)...)
			if err == nil {
				t.Fatalf("purge ran:\n%s", out)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("the refusal does not say %q: %v", c.want, err)
			}
			if strings.Contains(out, "versions") {
				t.Fatalf("a refused purge printed a report:\n%s", out)
			}
			// Nothing was purged: every version is still there.
			st, err := openExisting(dir, "inspect")
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			if s, _ := st.Stats("default"); s.Versions != 6 {
				t.Fatalf("a refused purge removed versions: %d left", s.Versions)
			}
			if countBodies(t, dir) != before {
				t.Fatal("a refused purge removed bodies")
			}
		})
	}
}

// A backup older than the vault's newest entry is refused, because the purge
// would drop versions the backup does not have.
func TestI18PurgeRefusesABackupThatIsMissingHistory(t *testing.T) {
	dir := seeded(t)
	backup := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-data", dir, "-to", backup)

	// A new version lands after the backup.
	st, err := openExisting(dir, "append")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendEntry("default", store.Entry{Path: "late.md", Deleted: true, MTime: 30, Mac: testMac}); err != nil {
		t.Fatal(err)
	}
	st.Close()

	out, err := basalt(t, "purge", "-data", dir, "-confirm", "default", "-backup", backup)
	if err == nil {
		t.Fatalf("purge ran over a stale backup:\n%s", out)
	}
	if !strings.Contains(err.Error(), "up to uid 6") || !strings.Contains(err.Error(), "at uid 7") {
		t.Fatalf("the refusal does not give both uids: %v", err)
	}
	if !strings.Contains(err.Error(), "basaltd backup") {
		t.Fatalf("the refusal does not say how to fix it: %v", err)
	}
}

// With a backup that covers everything, purge runs and the success line names
// the backup it checked.
func TestI18PurgeRunsWithAFreshBackupAndNamesIt(t *testing.T) {
	dir := seeded(t)
	backup := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "backup", "-data", dir, "-to", backup)

	out := mustRun(t, "purge", "-data", dir, "-confirm", "default", "-backup", backup)
	if !strings.Contains(out, "The backup at "+backup+" holds them, up to uid 6") {
		t.Fatalf("the success line does not name the backup:\n%s", out)
	}
	if !strings.Contains(out, "(removed 2)") {
		t.Fatalf("purge did not run:\n%s", out)
	}
	// The history is in the backup, where the line said it was.
	if v := mustRun(t, "verify", "-deep", "-data", backup); !strings.Contains(v, "0 faults") {
		t.Fatalf("the backup does not verify:\n%s", v)
	}
	// With the check waived, the line says so instead.
	out = mustRun(t, "purge", "-data", seeded(t), "-confirm", "default", "-no-backup-check")
	if !strings.Contains(out, "No backup was checked (-no-backup-check)") {
		t.Fatalf("the waived check is not reported:\n%s", out)
	}
}
