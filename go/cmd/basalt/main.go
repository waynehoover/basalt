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

	"github.com/coder/websocket"

	"github.com/waynehoover/basalt/internal/chunks"
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
		default:
			return fmt.Errorf("unknown command %q (try serve, verify, purge)", cmd)
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
	return store.Open(filepath.Join(dataDir, "basalt.db"), filepath.Join(dataDir, "chunks"))
}

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

	st, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	token, fresh, err := loadOrCreateToken(filepath.Join(*dataDir, "auth-token"))
	if err != nil {
		return err
	}

	// Exactly one vault is authorised. A typo in the vault name then fails
	// authentication instead of quietly creating a second, empty vault that
	// reports itself as fully synced.
	srv := server.New(st, server.StaticTokens(map[string]string{*vault: token}), log)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "basalt speaks websocket only", http.StatusUpgradeRequired)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			// Compression off: bodies are ciphertext and do not compress, so
			// the CPU would buy nothing.
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil {
			log.Warn("websocket accept", "remote", r.RemoteAddr, "err", err)
			return
		}
		srv.Handle(r.Context(), conn, r.RemoteAddr)
	})

	hs := &http.Server{
		Addr:              *addr,
		Handler:           mux,
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
	return nil
}
