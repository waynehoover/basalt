package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/* ---------------------------------------------------------------- *
 * backup records what it covers
 * ---------------------------------------------------------------- */

// backupMeta is the shape a script reads, spelled out here rather than
// imported so this test says what the file promises and not what the code
// happens to write.
type backupMeta struct {
	Format   int    `json:"format"`
	TakenAt  string `json:"takenAt"`
	Database struct {
		Bytes      int64  `json:"bytes"`
		ModifiedAt string `json:"modifiedAt"`
	} `json:"database"`
	Vaults []struct {
		Vault       string `json:"vault"`
		OldestUID   int64  `json:"oldestUid"`
		LatestUID   int64  `json:"latestUid"`
		AllocatedTo int64  `json:"allocatedTo"`
		Versions    int64  `json:"versions"`
		Purges      int64  `json:"purges"`
	} `json:"vaults"`
}

func readBackupMeta(t *testing.T, dir string) backupMeta {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "backup.json"))
	if err != nil {
		t.Fatalf("the backup has no backup.json: %v", err)
	}
	var m backupMeta
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("backup.json is not JSON: %v\n%s", err, b)
	}
	return m
}

// docs/server.md says to start a fresh backup directory after a purge, keep
// the old one, and delete it whole when its history is no longer wanted. A
// directory full of hashes says nothing about which uids it holds or which
// side of a purge it was taken on, so deciding what is safe to drop meant
// opening SQLite. Every backup now writes backup.json beside the database:
// the uid range each vault covers, when, and the purge generation the source
// was at, so "which backup covers this uid" is a jq query.
func TestBackupRecordsTheUIDRangeAndPurgeGenerationItCovers(t *testing.T) {
	source := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")

	out := mustRun(t, "backup", "-data", source, "-to", dest)
	if !strings.Contains(out, "backup.json") {
		t.Fatalf("backup does not mention the coverage file it wrote:\n%s", out)
	}
	m := readBackupMeta(t, dest)
	if m.Format != 2 {
		t.Fatalf("format = %d, want 2", m.Format)
	}
	// The file names the database it summarises, so a script can tell a
	// current summary from one left behind by a build that republished the
	// database without rewriting this.
	info, err := os.Stat(filepath.Join(dest, "basalt.db"))
	if err != nil {
		t.Fatalf("stat the published database: %v", err)
	}
	if m.Database.Bytes != info.Size() {
		t.Fatalf("backup.json stamps %d bytes, basalt.db beside it is %d", m.Database.Bytes, info.Size())
	}
	taken, err := time.Parse(time.RFC3339, m.TakenAt)
	if err != nil {
		t.Fatalf("takenAt %q is not RFC 3339: %v", m.TakenAt, err)
	}
	if since := time.Since(taken); since < 0 || since > time.Minute {
		t.Fatalf("takenAt %s is not now", m.TakenAt)
	}
	if len(m.Vaults) != 1 || m.Vaults[0].Vault != "default" {
		t.Fatalf("vaults: %+v", m.Vaults)
	}
	// seeded: six entries, uids 1 to 6, never purged.
	v := m.Vaults[0]
	if v.OldestUID != 1 || v.LatestUID != 6 || v.AllocatedTo != 6 || v.Versions != 6 || v.Purges != 0 {
		t.Fatalf("coverage before the purge: %+v", v)
	}

	// A purge drops note.md's first two versions, uids 1 and 2. The next
	// backup into the same directory covers what the snapshot now holds, and
	// says it was taken after a purge, which is what tells a retention script
	// that the previous directory is the one with the history in it.
	mustRun(t, "purge", "-data", source, "-confirm", "default", "-backup", dest)
	mustRun(t, "backup", "-data", source, "-to", dest)
	v = readBackupMeta(t, dest).Vaults[0]
	if v.OldestUID != 3 || v.LatestUID != 6 || v.AllocatedTo != 6 || v.Versions != 4 || v.Purges != 1 {
		t.Fatalf("coverage after the purge: %+v", v)
	}

	// The live store says the same generation, so a script can compare the
	// two without opening either database.
	var stats map[string]any
	if err := json.Unmarshal([]byte(mustRun(t, "stats", "-data", source, "-json")), &stats); err != nil {
		t.Fatalf("stats -json: %v", err)
	}
	vaults, _ := stats["vaults"].([]any)
	if len(vaults) != 1 {
		t.Fatalf("stats vaults: %v", stats["vaults"])
	}
	if got := vaults[0].(map[string]any)["purges"]; got != float64(1) {
		t.Fatalf("stats -json purges = %v, want 1", got)
	}
}

// A purge that drops nothing is not a generation. The number counts the times
// history left the store, because that is the event a backup taken before it
// is the only remaining copy of.
func TestAPurgeThatDropsNothingDoesNotMoveTheGeneration(t *testing.T) {
	source := seeded(t)
	dest := filepath.Join(t.TempDir(), "backup")
	mustRun(t, "purge", "-data", source, "-confirm", "default", "-no-backup-check")
	mustRun(t, "purge", "-data", source, "-confirm", "default", "-no-backup-check")
	mustRun(t, "backup", "-data", source, "-to", dest)
	if v := readBackupMeta(t, dest).Vaults[0]; v.Purges != 1 {
		t.Fatalf("two purges, one of which dropped nothing, count as %d generations, want 1", v.Purges)
	}
}
