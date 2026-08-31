package store

import (
	"fmt"
	"os"
	"path/filepath"
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

	// Verified is chunk references checked in the backup after writing it.
	Verified int
}

func (r BackupReport) String() string {
	return fmt.Sprintf(
		"%s: %d vaults, %d chunk references, %d bodies copied (%d bytes), "+
			"%d bodies at source and %d in the backup, %d references verified",
		r.Dir, r.Vaults, r.Refs, r.Copied, r.Bytes,
		r.SourceBodies, r.DestBodies, r.Verified)
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
// The order is database first, then bodies, and it is the opposite of the
// obvious one. Copying bodies first would let an entry commit in between, and
// the snapshot taken afterwards would reference a body the copy never saw:
// a backup with a dangling reference, which is the one fault that looks fine
// until you restore it. Taken the other way round, every body the snapshot
// references was already durable when the snapshot was taken, because an entry
// is only committed once its bodies are. Bodies written after the snapshot are
// simply not copied.
//
// Bodies are copied through Get and Put, so each one is hashed on the way out of
// the source and again on the way into the backup. Rule 3 asks for both ends,
// and it is worth being precise about what the second one adds: Put alone would
// already refuse a corrupt body, because it verifies what it is given. Reading
// through Get changes the *diagnosis*, not the outcome. Rot at the source is
// reported against the source, rather than surfacing as a mismatch at the
// destination and sending someone to check the wrong disk.
//
// Nothing here deletes anything, so the rule's third step never arises.
//
// Repeat backups into the same directory copy only what is missing, because a
// body is named by its hash and a body already there is already correct.
//
// deep re-reads every body already in the backup as well as the ones just
// written. The bodies just written are always checksummed; deep is for finding
// bit rot in a backup that has been sitting on a disk for a year.
func (s *Store) Backup(destDir string, deep bool) (BackupReport, error) {
	rep := BackupReport{Dir: destDir}

	if err := os.MkdirAll(destDir, 0o700); err != nil {
		return rep, err
	}
	// Refuse to back up into the directory being backed up. It would half work,
	// which is the worst outcome available.
	if same, err := sameDir(filepath.Dir(s.dbPath), destDir); err != nil {
		return rep, err
	} else if same {
		return rep, fmt.Errorf("backup destination %s is the data directory itself", destDir)
	}

	// Snapshot to a temporary name and rename over any previous one, so an
	// interrupted backup leaves the last good database in place rather than a
	// half-written one.
	dbPath := filepath.Join(destDir, dbFileName)
	tmpDB := filepath.Join(destDir, ".basalt.db.snapshot")
	if err := os.Remove(tmpDB); err != nil && !os.IsNotExist(err) {
		return rep, err
	}
	if err := s.SnapshotInto(tmpDB); err != nil {
		return rep, fmt.Errorf("snapshotting the database: %w", err)
	}
	if err := os.Rename(tmpDB, dbPath); err != nil {
		return rep, err
	}

	dest, err := Open(dbPath, filepath.Join(destDir, chunkDirName))
	if err != nil {
		return rep, fmt.Errorf("opening the backup: %w", err)
	}
	defer dest.Close()

	vaults, err := dest.Vaults()
	if err != nil {
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
		return rep, err
	}

	if rep.SourceBodies, err = s.chunks.CountBodies(); err != nil {
		return rep, err
	}
	if rep.DestBodies, err = dest.chunks.CountBodies(); err != nil {
		return rep, err
	}

	// Verify the backup, not the intention to have made one. A backup reported
	// as successful and then found to be unreadable is the failure this whole
	// function exists to prevent, so it is checked here rather than left for
	// the day it is needed.
	faults, verified, err := dest.Verify(deep)
	if err != nil {
		return rep, err
	}
	rep.Verified = verified
	if len(faults) > 0 {
		return rep, fmt.Errorf("the backup is missing %d of %d chunk references, first: %s",
			len(faults), verified, faults[0])
	}
	return rep, nil
}

// sameDir reports whether two paths name the same directory, following symlinks
// and resolving relative paths, because "is the destination the source" cannot
// be answered by comparing strings.
func sameDir(a, b string) (bool, error) {
	ra, err := filepath.EvalSymlinks(a)
	if err != nil {
		return false, err
	}
	rb, err := filepath.EvalSymlinks(b)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	absA, err := filepath.Abs(ra)
	if err != nil {
		return false, err
	}
	absB, err := filepath.Abs(rb)
	if err != nil {
		return false, err
	}
	return absA == absB, nil
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
