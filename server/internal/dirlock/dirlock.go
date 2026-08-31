// Package dirlock is an advisory lock on a data directory.
//
// It exists because the maintenance commands and the server are separate
// processes over one data directory, and the store's own mutex is per process.
// Without this, `basaltd purge` run while the server is up would sweep chunk
// bodies with nothing holding off the server's commits, and an entry could be
// committed referencing a body that had just been deleted. That is the exact
// hazard the store's write mutex closes *within* a process, undone by having two.
//
// Locks are advisory and non-blocking. A command that cannot take its lock says
// so and exits, rather than waiting: a backup that silently blocks for an hour
// is a backup that did not run, and nothing would say so until it was needed.
package dirlock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// ErrHeld is returned when another process holds an incompatible lock. Match it
// with errors.Is; for the holder, match HeldError with errors.As.
var ErrHeld = errors.New("the data directory is locked")

// HeldError is a refusal, carrying whoever recorded themselves as the holder.
//
// Holder is empty when the lock is held *shared*, because shared holders record
// nothing: two of them would overwrite each other and the file would name
// neither. A caller that wants a name in that case can ask Holder about the
// server lock instead, and knowing the field is empty is how it knows to.
type HeldError struct {
	File   string
	Holder string
}

func (e *HeldError) Error() string {
	if e.Holder == "" {
		return ErrHeld.Error()
	}
	return ErrHeld.Error() + " by " + e.Holder
}

func (e *HeldError) Unwrap() error { return ErrHeld }

// Lock is a held flock on one file. Release, or let the process exit.
type Lock struct {
	f         *os.File
	path      string
	exclusive bool
}

// Exclusive takes an exclusive lock on the named file inside dir, and records
// who holds it.
//
// The holder's role and pid go into the file so that a refusal can say what is
// in the way rather than only that something is. Only an exclusive holder
// writes, because two shared holders would overwrite each other and the file
// would then name neither of them.
func Exclusive(dir, name, role string) (*Lock, error) {
	l, err := take(dir, name, syscall.LOCK_EX|syscall.LOCK_NB)
	if err != nil {
		return nil, err
	}
	if err := l.f.Truncate(0); err != nil {
		l.Release()
		return nil, err
	}
	if _, err := l.f.WriteAt([]byte(fmt.Sprintf("%s pid %d\n", role, os.Getpid())), 0); err != nil {
		l.Release()
		return nil, err
	}
	l.exclusive = true
	return l, nil
}

// Shared takes a shared lock, which any number of readers may hold at once and
// which excludes every exclusive holder.
func Shared(dir, name string) (*Lock, error) {
	return take(dir, name, syscall.LOCK_SH|syscall.LOCK_NB)
}

func take(dir, name string, how int) (*Lock, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, name)
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), how); err != nil {
		holder := readHolder(f)
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, &HeldError{File: name, Holder: holder}
		}
		return nil, err
	}
	return &Lock{f: f, path: path}, nil
}

// Holder reports who last took the named lock exclusively, without taking it.
//
// It exists because a *shared* holder records nothing, by design: two of them
// would overwrite each other and the file would name neither. So a refusal on
// the shared data lock cannot say who is in the way, and the useful answer is
// usually in the server lock next to it. Reading it unlocked is fine: it is for
// a message, and a message that is occasionally a moment out of date is better
// than no message.
func Holder(dir, name string) string {
	f, err := os.Open(filepath.Join(dir, name))
	if err != nil {
		return ""
	}
	defer f.Close()
	return readHolder(f)
}

// readHolder reads whatever the last exclusive holder wrote. Best effort: an
// unreadable or empty file means the holder took a shared lock and wrote
// nothing, which is not an error, only less to say.
func readHolder(f *os.File) string {
	buf := make([]byte, 128)
	n, _ := f.ReadAt(buf, 0)
	return strings.TrimSpace(string(buf[:n]))
}

func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	// Clear the holder record. Leaving it means the next process refused by this
	// lock reads the name of one that finished hours ago, and a refusal that
	// names the wrong process is worse than one that names none: it sends
	// someone to kill something that is not running.
	if l.exclusive {
		_ = l.f.Truncate(0)
	}
	// Unlock before closing. Closing releases it too, but doing it explicitly
	// means a failure to release is visible rather than swallowed by Close.
	err := syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	if cerr := l.f.Close(); err == nil {
		err = cerr
	}
	l.f = nil
	return err
}

// The two locks a data directory has, and why there are two.
//
// Server is exclusive to one server, and nothing else takes it. It stops a
// second server being started on the same directory, which would give each its
// own fan-out and its own commit ordering, so neither would see the other's live
// changes and a client could be handed uids out of order.
//
// Data is shared by everything that reads and exclusive to the one thing that
// deletes. The server and the read-only commands hold it shared, so a backup can
// run without stopping the server; purge needs it exclusively, so it refuses
// while a server is up. Splitting them is what lets a backup be both safe and
// non-disruptive, which a single exclusive lock could not do.
const (
	Server = "server.lock"
	Data   = "data.lock"
)
