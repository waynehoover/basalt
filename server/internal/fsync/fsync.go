// Package fsync is the directory flush this server's durability rests on.
//
// Rule 1: a write is acknowledged only once it is durable, and a body renamed
// into a directory is not durable until the directory entry naming it is. So
// the chunk store, `basaltd backup` and the token writer all fsync a directory
// after a rename, and all three carried their own unexported copy of the four
// lines that do it.
//
// It is a package of its own rather than an export from any of them. Exporting
// a durability primitive from the chunk store so the other two can call it
// would make a backup and a token file depend on the chunk store for something
// that has nothing to do with chunks, which is a worse trade than the
// duplication was. Nothing depends on this package but the callers, and it
// depends on nothing.
package fsync

import "os"

// Dir flushes a directory entry, so a rename into it survives a power cut.
//
// There is no fallback when it fails: an fsync error that was swallowed is
// precisely the "stored" that a crash turns into a lie, so every caller
// reports it and refuses the write it was about to acknowledge.
func Dir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
