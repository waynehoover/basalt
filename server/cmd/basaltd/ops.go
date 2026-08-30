package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
)

// cmdHealth asks a running server whether it is answering.
//
// It exists for the container image, which is a single static binary and a
// scratch filesystem: there is no curl in there to write a HEALTHCHECK with,
// and adding a shell to get one would undo the reason for the scratch image.
func cmdHealth(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("health", flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:3003", "address of the server to ask")
	timeout := fs.Duration("timeout", 5*time.Second, "how long to wait")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// A bare port, or a bind address with no host, means this machine.
	target := *addr
	if strings.HasPrefix(target, ":") {
		target = "127.0.0.1" + target
	}
	if _, _, err := net.SplitHostPort(target); err != nil {
		return fmt.Errorf("%q is not a host and port: %w", *addr, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+target+"/health", nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("no answer from %s: %w", target, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", target, res.Status)
	}
	fmt.Fprintf(out, "ok\n")
	return nil
}

// cmdStats says what a vault is made of.
//
// Read-only, and it takes the shared lock, so it runs against a live server.
// Rule 5 in a different clothes: the numbers are separate rather than summed,
// because "1.2 GB" tells you nothing about whether a purge would help and
// versions against files tells you exactly that.
func cmdStats(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("stats", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := requireDataDir(*dataDir, "report on"); err != nil {
		return err
	}

	st, err := openExisting(*dataDir, "report on")
	if err != nil {
		return err
	}
	defer st.Close()

	vaults, err := st.Vaults()
	if err != nil {
		return err
	}
	if len(vaults) == 0 {
		fmt.Fprintln(out, "no vaults yet")
		return nil
	}

	bodies, err := st.Chunks().CountBodies()
	if err != nil {
		return err
	}

	for _, v := range vaults {
		s, err := st.Stats(v)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "vault %q\n", v)
		fmt.Fprintf(out, "  %d files, %d folders, %s of notes as the devices see them\n",
			s.Files, s.Folders, human(s.Bytes))
		fmt.Fprintf(out, "  %d deleted and still recoverable\n", s.Deleted)
		fmt.Fprintf(out, "  %d versions in all, %d chunks referenced\n", s.Versions, s.ChunkRefs)
		// The one number that says whether a purge is worth running: history is
		// every version beyond the newest of each path.
		if history := s.Versions - (s.Files + s.Folders + s.Deleted); history > 0 {
			fmt.Fprintf(out, "  %d of those versions are history, which purge would drop\n", history)
		}
		fmt.Fprintf(out, "  newest uid %d\n", s.LatestUID)
	}
	fmt.Fprintf(out, "%d chunk bodies on disk\n", bodies)
	fmt.Fprintf(out, "purge spares bodies newer than %s unless -grace says otherwise\n", chunks.DefaultGrace)
	return nil
}

func human(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1f KiB", float64(n)/1024)
	case n < 1024*1024*1024:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1024*1024))
	default:
		return fmt.Sprintf("%.2f GiB", float64(n)/(1024*1024*1024))
	}
}
