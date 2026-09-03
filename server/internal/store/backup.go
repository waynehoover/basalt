package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// BackupReport says what a backup copied.
//
// Every number is here because a backup is the one operation whose failure is
// invisible until you need it. Rule 8: an implausible figure is what catches
// this class of fault, and a backup that reports only "done" has told you
// nothing you can check.
type BackupReport struct {
	Dir string

	Vaults int
	// Refs is chunk references walked, including repeats: a chunk shared by
	// twenty versions is twenty references to one body.
	Refs int64
	// Copied is bodies actually written, which is distinct by construction
	// because a body present after the first copy is skipped.
	Copied int64
	Bytes  int64

	// SourceBodies and DestBodies are file counts either side. The destination
	// is expected to be the smaller of the two: it holds what committed entries
	// reference, and the source may also hold bodies from a push that has not
	// committed yet or one that died. Rule 5 says a smaller result is a bug
	// until it is explained, so both numbers are reported and the difference is
	// the explanation.
	SourceBodies int
	DestBodies   int

	// Retained is destination bodies the newest snapshot does not reference.
	// A backup accumulates history on purpose: after the source purges old
	// versions, the next snapshot stops referencing their bodies, but those
	// bodies are the very history the backup exists to keep, so they are left
	// in place rather than swept. See Backup for why deleting them would be the
	// one thing a backup must never do (S14).
	Retained int

	// Verified is chunk references checked in the backup after writing it.
	Verified int
}

func (r BackupReport) String() string {
	return fmt.Sprintf(
		"%s: %d vaults, %d chunk references, %d bodies copied (%d bytes), "+
			"%d bodies at source and %d in the backup (%d retained history), %d references verified",
		r.Dir, r.Vaults, r.Refs, r.Copied, r.Bytes,
		r.SourceBodies, r.DestBodies, r.Retained, r.Verified)
}

// SnapshotInto writes a consistent copy of the database to path, which must not
// exist.
//
// SQLite's VACUUM INTO takes a read transaction, so the copy is a single point
// in time even with writers active, and it produces one clean file rather than a
// database plus a write-ahead log. Copying the files with cp instead is how you
// get a backup that opens fine and is missing the last few commits.
//
// There is no check here that path is absent, because SQLite refuses an existing
// target itself, with "output file already exists". A check in front of it would
// be a second opinion on a question already answered, and one more thing to keep
// in step.
//
// The path is a bound parameter, not interpolated. A path is exactly the kind of
// string that contains a quote one day.
func (s *Store) SnapshotInto(path string) error {
	_, err := s.db.Exec(`VACUUM INTO ?`, path)
	return err
}

// ChunkRefs calls fn for every chunk reference a committed entry holds, oldest
// vault first.
//
// It streams rather than returning a slice: a vault with a lot of history has
// millions of references, and the caller only ever needs one at a time. Repeats
// are not filtered, because filtering needs the whole set in memory and the
// caller's own presence check already makes a repeat cheap.
func (s *Store) ChunkRefs(fn func(vaultID, name string) error) error {
	rows, err := s.db.Query(
		// Ordered by vault only, which is the whole of the documented contract:
		// oldest vault first. Adding uid and ord to it asked for a sort the
		// covering index cannot provide, so this scanned the primary key and
		// looked up every row: 10 ms over 20k rows against under 1 ms. The
		// order of names within a vault was never promised and nothing reads
		// it: this is a set of names to copy.
		`SELECT vault_id, name FROM entry_chunks ORDER BY vault_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var vaultID, name string
		if err := rows.Scan(&vaultID, &name); err != nil {
			return err
		}
		if err := fn(vaultID, name); err != nil {
			return err
		}
	}
	return rows.Err()
}

// Backup writes everything this store holds into destDir, which becomes a data
// directory in its own right: restoring is copying it back, and checking it is
// running verify against it.
//
// The new snapshot is published over the previous one only at the very end,
// after every body it references has been copied and the whole thing verified
// (S7). The obvious order, renaming the snapshot into place first and copying
// bodies after, has two failures that arrive together: a missing source body or
// a full disk leaves the destination database claiming content it does not
// hold, and it has already overwritten the last good backup to do it. So the
// snapshot is staged under a temporary name, its bodies are copied into the
// shared chunk tree, it is verified against that tree, and only then is it
// renamed over the live database. A run that fails anywhere before that rename
// leaves the previous backup exactly as it was, still openable and still
// verifiable. The bodies copied before a failure are harmless: a body is named
// by its hash, so it is either already correct or referenced by no database.
//
// The order within a run is also database first, then bodies, and that is the
// opposite of the obvious one for a second reason. Copying bodies first would
// let an entry commit in between, and the snapshot taken afterwards would
// reference a body the copy never saw. Taken this way round, every body the
// snapshot references was already durable when the snapshot was taken, because
// an entry is only committed once its bodies are.
//
// Bodies are copied through Get and Put, so each one is hashed on the way out of
// the source and again on the way into the backup. Rule 3 asks for both ends,
// and it is worth being precise about what the second one adds: Put alone would
// already refuse a corrupt body, because it verifies what it is given. Reading
// through Get changes the *diagnosis*, not the outcome. Rot at the source is
// reported against the source, rather than surfacing as a mismatch at the
// destination and sending someone to check the wrong disk.
//
// Repeat backups into the same directory copy only what is missing, because a
// body is named by its hash and a body already there is already correct. They
// also never delete: a backup accumulates history on purpose. Once the source
// has purged old versions, the next snapshot stops referencing their bodies,
// but those bodies are the history the backup exists to hold, and the source
// no longer has them. Sweeping them here would destroy the one copy of exactly
// what a backup is for, so they are counted as Retained and left alone (S14).
//
// deep re-reads every body already in the backup as well as the ones just
// written. The bodies just written are always checksummed; deep is for finding
// bit rot in a backup that has been sitting on a disk for a year.
func (s *Store) Backup(destDir string, deep bool) (BackupReport, error) {
	rep := BackupReport{Dir: destDir}

	// Refuse a destination that would write into the store being backed up. The
	// data directory itself, the chunk tree, or anywhere under them: each would
	// half work, corrupting the source before the command failed (S15). Checked
	// before the destination is created (S26): a refused destination inside the
	// chunk tree used to be created on the way to being refused, leaving a
	// directory in the tree that nothing put there.
	if err := s.refuseOverlap(destDir); err != nil {
		return rep, err
	}
	if err := os.MkdirAll(destDir, 0o700); err != nil {
		return rep, err
	}

	dbPath := filepath.Join(destDir, dbFileName)
	chunkDir := filepath.Join(destDir, chunkDirName)
	// Staged, not published. The rename over dbPath is the last thing this
	// function does, so until it succeeds the previous backup is what dbPath
	// still names.
	stagedDB := filepath.Join(destDir, ".basalt.db.snapshot")
	if err := os.Remove(stagedDB); err != nil && !os.IsNotExist(err) {
		return rep, err
	}
	if err := s.SnapshotInto(stagedDB); err != nil {
		return rep, fmt.Errorf("snapshotting the database: %w", err)
	}
	// VACUUM INTO does not fsync its output, so the snapshot's bytes can still
	// be in the page cache. Flush it before anything relies on it being on disk.
	if err := syncFile(stagedDB); err != nil {
		return rep, fmt.Errorf("flushing the snapshot: %w", err)
	}

	// Open the staged snapshot against the shared chunk tree, so the bodies it
	// references are copied into the tree the published database will read.
	// Adding bodies here cannot harm the previous backup: it references a subset
	// of what the tree holds, and a content-addressed body is either already
	// present or new.
	dest, err := Open(stagedDB, chunkDir)
	if err != nil {
		return rep, fmt.Errorf("opening the staged snapshot: %w", err)
	}

	vaults, err := dest.Vaults()
	if err != nil {
		dest.Close()
		return rep, err
	}
	rep.Vaults = len(vaults)

	// The references come from the *snapshot*, not from the live store, so the
	// set of bodies copied is exactly the set the backup's own database claims.
	err = dest.ChunkRefs(func(vaultID, name string) error {
		rep.Refs++
		if s.duringBackup != nil {
			s.duringBackup()
		}
		if dest.chunks.Has(vaultID, name) {
			return nil
		}
		body, err := s.chunks.Get(vaultID, name)
		if err != nil {
			return fmt.Errorf("reading %s from vault %s: %w", name, vaultID, err)
		}
		if err := dest.chunks.Put(vaultID, name, body); err != nil {
			return fmt.Errorf("writing %s to the backup: %w", name, err)
		}
		rep.Copied++
		rep.Bytes += int64(len(body))
		return nil
	})
	if err != nil {
		dest.Close()
		return rep, err
	}

	if rep.SourceBodies, err = s.chunks.CountBodies(); err != nil {
		dest.Close()
		return rep, err
	}
	if rep.DestBodies, err = dest.chunks.CountBodies(); err != nil {
		dest.Close()
		return rep, err
	}
	// Bodies the new snapshot does not reference are retained history, not a
	// discrepancy: Refs counts references with repeats, so the distinct
	// referenced set is what the destination needs, and anything beyond it is
	// what earlier snapshots left behind. Never negative: every referenced body
	// is present, because the copy above just made sure of it.
	referenced, err := dest.distinctChunkCount()
	if err != nil {
		dest.Close()
		return rep, err
	}
	if rep.Retained = rep.DestBodies - referenced; rep.Retained < 0 {
		rep.Retained = 0
	}

	// Verify the staged snapshot against the bodies now in the tree, before it
	// is published. A backup reported as successful and then found unreadable is
	// the failure this whole function exists to prevent, and publishing an
	// unverified snapshot over the last good one would be that failure with the
	// safety net cut.
	faults, verified, err := dest.Verify(deep)
	dest.Close()
	if err != nil {
		return rep, err
	}
	rep.Verified = verified
	if len(faults) > 0 {
		return rep, fmt.Errorf("the backup is missing %d of %d chunk references, first: %s",
			len(faults), verified, faults[0])
	}

	// Everything the snapshot names is present and checked. Publish it: rename
	// over the previous database, then fsync the directory so the rename is
	// durable. This is the first and only moment the previous backup stops
	// being the one dbPath names.
	if err := os.Rename(stagedDB, dbPath); err != nil {
		return rep, err
	}
	if err := syncDir(destDir); err != nil {
		return rep, fmt.Errorf("flushing the backup directory: %w", err)
	}
	return rep, nil
}

// distinctChunkCount is how many distinct bodies this store's entries
// reference, across every vault. It is what a backup's chunk tree needs to
// hold; anything beyond it is retained history rather than a fault.
func (s *Store) distinctChunkCount() (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM (SELECT DISTINCT vault_id, name FROM entry_chunks)`).Scan(&n)
	return n, err
}

// syncFile flushes a file's contents to disk. Mirrors chunks.syncDir's job for
// a file: the write layer there fsyncs body and directory, and a backup's
// database deserves the same, because VACUUM INTO leaves it unsynced.
func syncFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

// syncDir flushes a directory entry, so a rename into it is durable. A mirror of
// the one in the chunks package, which cannot be reused because it is unexported
// and this is a different package.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// refuseOverlap refuses a backup destination that would write into the store
// being backed up (S15).
//
// A string comparison is not enough. `data`, `data/`, a relative path, or a
// symlink can all name the same place, and the destination need not equal the
// data directory to do harm: a destination inside the chunk tree, or one that
// contains it, pollutes the live store with a snapshot and copied bodies before
// the command fails. So both paths are resolved to their real, absolute form
// and checked for containment either way. A path can be resolved even when it
// does not exist yet, by resolving the deepest ancestor that does. An ordinary
// child of the data directory, such as data/backup, is fine and is allowed: it
// overlaps neither the database nor the chunk tree.
func (s *Store) refuseOverlap(destDir string) error {
	dest, err := resolvePath(destDir)
	if err != nil {
		return err
	}
	dataDir := filepath.Dir(s.dbPath)
	resolvedData, err := resolvePath(dataDir)
	if err != nil {
		return err
	}
	// The whole data directory, named exactly, gets its own message: it is the
	// mistake someone actually makes, and "is the data directory itself" says
	// more than "overlaps" would. A child of the data directory is not this and
	// is allowed below.
	if dest == resolvedData {
		return fmt.Errorf("backup destination %s is the data directory itself", destDir)
	}
	// The pieces a backup must not touch. A child of the data directory such as
	// data/backup overlaps none of these and is fine; the chunk tree, the
	// database and the two lock files are what a destination inside the data
	// directory could still collide with. The lock names are dirlock's; they
	// are spelled out rather than imported to keep this package free of that
	// dependency, and a test would catch them drifting.
	for _, live := range []struct{ path, what string }{
		{filepath.Join(dataDir, chunkDirName), "the live chunk tree"},
		{s.dbPath, "the live database"},
		{filepath.Join(dataDir, "server.lock"), "the server lock"},
		{filepath.Join(dataDir, "data.lock"), "the data lock"},
	} {
		resolved, err := resolvePath(live.path)
		if err != nil {
			return err
		}
		if overlaps(dest, resolved) {
			return fmt.Errorf("backup destination %s overlaps %s (%s)", destDir, live.what, resolved)
		}
	}
	return nil
}

// overlaps reports whether either path is the other or contains it.
func overlaps(a, b string) bool {
	return a == b || isUnder(a, b) || isUnder(b, a)
}

// isUnder reports whether child is inside parent, by path segments rather than
// by prefix, so /data-backup is not taken to be under /data.
func isUnder(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resolvePath returns path's real, absolute form, following symlinks. When the
// path itself does not exist yet, its deepest existing ancestor is resolved and
// the missing tail appended, so a not-yet-created destination is still compared
// as the place it will be.
func resolvePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	rest := ""
	for {
		resolved, err := filepath.EvalSymlinks(abs)
		if err == nil {
			return filepath.Join(resolved, rest), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			// Reached the root without finding anything that exists, which on a
			// normal filesystem cannot happen. Fall back to the lexical path.
			return filepath.Join(abs, rest), nil
		}
		rest = filepath.Join(filepath.Base(abs), rest)
		abs = parent
	}
}

// Names of the two things a data directory holds, so the backup writes a
// directory the server can be pointed straight at.
const (
	dbFileName   = "basalt.db"
	chunkDirName = "chunks"
)

// DataDir returns the paths a data directory is made of. One definition, so a
// backup cannot write a layout the server does not read.
func DataDir(dir string) (dbPath, chunkDir string) {
	return filepath.Join(dir, dbFileName), filepath.Join(dir, chunkDirName)
}
