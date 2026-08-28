// Command basalt is the whole server: one static binary, one vault.
//
// TLS is terminated in front of this by `tailscale serve` or a tunnel, so no key
// material lives here and there is no certificate to configure.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/waynehoover/basalt/internal/chunks"
	"github.com/waynehoover/basalt/internal/dirlock"
	"github.com/waynehoover/basalt/internal/server"
	"github.com/waynehoover/basalt/internal/store"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "basalt:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	// Subcommands come before flag parsing so `basalt verify -deep` reads the
	// way it looks.
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, rest := args[0], args[1:]
		switch cmd {
		case "verify":
			return cmdVerify(rest)
		case "purge":
			return cmdPurge(rest)
		case "serve":
			return cmdServe(rest)
		case "backup":
			return cmdBackup(rest)
		default:
			return fmt.Errorf("unknown command %q (try serve, backup, verify, purge)", cmd)
		}
	}
	return cmdServe(args)
}

// dataFlags are shared by every subcommand, because every one of them opens the
// same store and opening a second copy of it is how two processes disagree
// about what is stored.
func dataFlags(fs *flag.FlagSet) *string {
	return fs.String("data", defaultDataDir(), "directory holding the database, chunks and auth token")
}

// tokenFileName is the device auth token. It is not the encryption key: the
// vault passphrase is generated on the first device and this server never sees
// it.
const tokenFileName = "auth-token"

func defaultDataDir() string {
	if d := os.Getenv("BASALT_DATA"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "basalt-data"
	}
	return filepath.Join(home, ".basalt")
}

func openStore(dataDir string) (*store.Store, error) {
	// One definition of what a data directory looks like, shared with the
	// backup, so a backup cannot write a layout the server does not read.
	dbPath, chunkDir := store.DataDir(dataDir)
	return store.Open(dbPath, chunkDir)
}

// locked turns a lock refusal into something a person can act on.
//
// A shared holder records nothing in its own lock file, so a refusal on the data
// lock has nothing to name. The server lock next to it does have a name, and
// that is nearly always the answer, so it is read for the message.
func locked(err error, dataDir, action, hint string) error {
	if !errors.Is(err, dirlock.ErrHeld) {
		return err
	}
	// Only look elsewhere when the refusal itself has no name, which means the
	// lock was held shared. Appending one regardless would print it twice.
	who := ""
	var held *dirlock.HeldError
	if errors.As(err, &held) && held.Holder == "" {
		if holder := dirlock.Holder(dataDir, dirlock.Server); holder != "" {
			who = fmt.Sprintf(" (%s)", holder)
		}
	}
	return fmt.Errorf("%s cannot run: %w%s\n%s", action, err, who, hint)
}

const stopFirst = "Stop the running basalt process and try again."

/* ---------------------------------------------------------------- *
 * serve
 * ---------------------------------------------------------------- */

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	addr := fs.String("addr", ":3003", "listen address")
	vault := fs.String("vault", "default", "the one vault this server serves")
	verbose := fs.Bool("v", false, "verbose logging")
	if err := fs.Parse(args); err != nil {
		return err
	}

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	// One server per data directory. Two would each have their own fan-out and
	// their own commit ordering, so neither would see the other's live changes
	// and a client could be handed uids out of order.
	serverLock, err := dirlock.Exclusive(*dataDir, dirlock.Server, "serve")
	if err != nil {
		return locked(err, *dataDir, "serve",
			"A server is already running on this data directory. Two would each keep their own\n"+
				"list of connected devices, so neither would relay the other's changes.")
	}
	defer serverLock.Release()

	// Shared, so a backup or a verify can run without stopping the server.
	// Purge needs this exclusively, which is what keeps it from sweeping chunk
	// bodies out from under a commit in this process.
	dataLock, err := dirlock.Shared(*dataDir, dirlock.Data)
	if err != nil {
		return locked(err, *dataDir, "serve", stopFirst)
	}
	defer dataLock.Release()

	st, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	token, fresh, err := loadOrCreateToken(filepath.Join(*dataDir, tokenFileName))
	if err != nil {
		return err
	}

	// Exactly one vault is authorised. A typo in the vault name then fails
	// authentication instead of quietly creating a second, empty vault that
	// reports itself as fully synced.
	srv := server.New(st, server.StaticTokens(map[string]string{*vault: token}), log)

	hs := &http.Server{
		Addr: *addr,
		// Built in internal/server so that it can be tested. What is in there
		// and not here is the list of browser origins allowed to connect, which
		// nothing caught until the plugin was loaded into a real vault.
		Handler:           server.HTTPHandler(srv, log),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: these are long-lived websockets.
	}

	printSetup(*addr, *vault, token, fresh)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errc := make(chan error, 1)
	go func() {
		err := hs.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		errc <- err
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
		// Give in-flight writes a moment to finish. A put that has stored its
		// bodies but not yet committed its entry has not been acked, so the
		// client retries; nothing is lost either way.
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return hs.Shutdown(shutCtx)
	}
}

func printSetup(addr, vault, token string, fresh bool) {
	host := addr
	if strings.HasPrefix(addr, ":") {
		host = "<this-host>" + addr
	}
	if fresh {
		fmt.Println("A new auth token was generated for this server.")
	}
	fmt.Printf("basalt listening on %s, serving vault %q\n", addr, vault)
	fmt.Printf("  %s#%s\n", host, token)
	fmt.Println()
	fmt.Println("That token authenticates a device. It is not the encryption key:")
	fmt.Println("the vault passphrase is generated on your first device and this")
	fmt.Println("server never sees it, so it cannot read anything it stores.")
}

// loadOrCreateToken reads the auth token, creating one on first run.
//
// A read that fails for any reason other than "not there" is fatal. Falling
// back to a fresh token on an unreadable file would silently lock out every
// device that already has the old one, which is rule 2: absent and unreadable
// are different states.
func loadOrCreateToken(path string) (string, bool, error) {
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		token := strings.TrimSpace(string(b))
		if token == "" {
			return "", false, fmt.Errorf("%s is empty; delete it to generate a new token", path)
		}
		return token, false, nil
	case errors.Is(err, os.ErrNotExist):
		// fall through and create
	default:
		return "", false, fmt.Errorf("reading %s: %w", path, err)
	}

	token, err := newToken()
	if err != nil {
		return "", false, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", false, err
	}
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		return "", false, err
	}
	// Read it back. Writing a credential and assuming it landed is how a
	// restart discovers the token it printed was never stored.
	back, err := os.ReadFile(path)
	if err != nil {
		return "", false, fmt.Errorf("verifying %s: %w", path, err)
	}
	if strings.TrimSpace(string(back)) != token {
		return "", false, fmt.Errorf("%s does not contain the token just written", path)
	}
	return token, true, nil
}

// newToken is 160 bits in Crockford-ish base32: no padding, and the alphabet
// avoids characters that are misread when someone types one off a screen.
func newToken() (string, error) {
	var raw [20]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	enc := base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)
	s := enc.EncodeToString(raw[:])
	return s[:8] + "-" + s[8:], nil
}

/* ---------------------------------------------------------------- *
 * verify
 * ---------------------------------------------------------------- */

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	deep := fs.Bool("deep", false, "read every chunk and check it against its name")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// Read-only, so shared: this runs happily against a live server.
	lock, err := dirlock.Shared(*dataDir, dirlock.Data)
	if err != nil {
		return locked(err, *dataDir, "verify", stopFirst)
	}
	defer lock.Release()

	st, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	faults, checked, err := st.Verify(*deep)
	if err != nil {
		return err
	}
	// Both numbers, always. Zero faults out of zero checks is not a healthy
	// vault, and reporting only the faults makes those two look identical.
	fmt.Printf("checked %d chunk references, %d faults\n", checked, len(faults))
	for _, f := range faults {
		fmt.Println(" ", f)
	}
	if len(faults) > 0 {
		return fmt.Errorf("%d entries cannot be served", len(faults))
	}
	return nil
}

/* ---------------------------------------------------------------- *
 * purge
 * ---------------------------------------------------------------- */

func cmdPurge(args []string) error {
	fs := flag.NewFlagSet("purge", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	vault := fs.String("vault", "default", "vault to purge")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// Exclusive: purge is the only thing that deletes chunk bodies, and the
	// store's mutex only serialises that against commits in the *same* process.
	// Taking this exclusively is what stops it racing a running server.
	lock, err := dirlock.Exclusive(*dataDir, dirlock.Data, "purge")
	if err != nil {
		return locked(err, *dataDir, "purge",
			"Purge deletes chunk bodies, so it needs the data directory to itself.\n"+stopFirst)
	}
	defer lock.Release()

	st, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	rep, err := st.Purge(*vault, chunks.DefaultGrace)
	if err != nil {
		return err
	}
	fmt.Printf("versions %d -> %d (removed %d)\n",
		rep.VersionsBefore, rep.VersionsAfter, rep.VersionsRemoved)
	fmt.Printf("chunks %d live, %d deleted, %d spared as too recent to collect\n",
		rep.ChunksLive, rep.ChunksDeleted, rep.ChunksSpared)

	// Purging is the one operation that deletes data, so it verifies what it
	// left behind rather than reporting success on the strength of no error.
	faults, checked, err := st.Verify(false)
	if err != nil {
		return err
	}
	if len(faults) > 0 {
		for _, f := range faults {
			fmt.Println(" ", f)
		}
		return fmt.Errorf("purge left %d unserveable entries out of %d references", len(faults), checked)
	}
	fmt.Printf("verified %d chunk references, all present\n", checked)
	if rep.VersionsRemoved > 0 {
		// Purge is the one command that destroys something no device holds a
		// copy of: old versions, and the deletion records that make a deleted
		// note recoverable. Saying so after the fact is the least it can do.
		fmt.Printf("\n%d versions are gone for good. Only a backup taken before now has them.\n",
			rep.VersionsRemoved)
	}
	return nil
}

/* ---------------------------------------------------------------- *
 * backup
 * ---------------------------------------------------------------- */

func cmdBackup(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	to := fs.String("to", "", "directory to back up into (required)")
	deep := fs.Bool("deep", false,
		"re-read every body already in the backup, to catch bit rot in an old one")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *to == "" {
		return errors.New("backup needs -to <directory>")
	}

	// Shared: a backup only reads, so it does not need the server stopped. It
	// does need purge held off, which the shared lock does.
	lock, err := dirlock.Shared(*dataDir, dirlock.Data)
	if err != nil {
		return locked(err, *dataDir, "backup",
			"A purge is running, and it deletes the bodies a backup is trying to read.")
	}
	defer lock.Release()

	st, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	rep, err := st.Backup(*to, *deep)
	if err != nil {
		// The numbers so far are still worth printing: they say how far it got.
		fmt.Println(rep)
		return err
	}

	// The token goes with it. Without it a restored server generates a new one
	// and every paired device stops working, which turns a restore from a copy
	// into an afternoon. It is a credential for ciphertext the backup already
	// contains in full, so keeping the two together risks nothing that was not
	// already at stake.
	tokenCopied, err := copyToken(*dataDir, *to)
	if err != nil {
		return fmt.Errorf("copying the auth token into the backup: %w", err)
	}

	fmt.Printf("backed up to %s\n", rep.Dir)
	fmt.Printf("  %d vaults, %d chunk references, %d bodies copied (%s)\n",
		rep.Vaults, rep.Refs, rep.Copied, humanBytes(rep.Bytes))
	fmt.Printf("  %d bodies at source, %d in the backup\n", rep.SourceBodies, rep.DestBodies)
	fmt.Printf("  verified %d chunk references in the backup, all present\n", rep.Verified)
	if rep.SourceBodies != rep.DestBodies {
		// Expected, and explained rather than left as a discrepancy: the backup
		// holds what committed entries reference, and the source may also hold
		// bodies from a push that never committed.
		fmt.Printf("  (%d source bodies are referenced by no entry and were not copied)\n",
			rep.SourceBodies-rep.DestBodies)
	}

	if tokenCopied {
		fmt.Println("  the device auth token is in the backup, so a restore needs no re-pairing")
	}

	// The copy is ciphertext. Saying so every time is the point: a backup
	// without the passphrase restores nothing, and that is the one part of this
	// no command can check.
	fmt.Println()
	fmt.Println("This backup is ciphertext. Restoring it needs your vault passphrase,")
	fmt.Println("which this server has never seen. Keep that written down somewhere")
	fmt.Println("else, or the backup is a pile of bytes nobody can read.")
	fmt.Printf("\nTo restore: point the server at it, or copy it back.\n")
	fmt.Printf("  basalt verify -deep -data %s\n", rep.Dir)
	return nil
}

// copyToken puts the auth token in the backup, reading it back rather than
// trusting the write. Rule 4: verify the outcome, not the exit code.
//
// A missing token is not an error. A data directory that has never been served
// does not have one yet, and refusing to back up over that would be refusing to
// back up the notes.
func copyToken(dataDir, destDir string) (bool, error) {
	want, err := os.ReadFile(filepath.Join(dataDir, tokenFileName))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	dst := filepath.Join(destDir, tokenFileName)
	if err := os.WriteFile(dst, want, 0o600); err != nil {
		return false, err
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		return false, err
	}
	if string(got) != string(want) {
		return false, fmt.Errorf("%s does not match the token it was copied from", dst)
	}
	return true, nil
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	units := []string{"KiB", "MiB", "GiB", "TiB"}
	v := float64(n)
	for _, u := range units {
		v /= unit
		if v < unit {
			return fmt.Sprintf("%.1f %s", v, u)
		}
	}
	return fmt.Sprintf("%.1f PiB", v)
}
