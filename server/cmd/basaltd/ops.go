package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/dirlock"
	"github.com/waynehoover/basalt-sync/server/internal/store"
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
//
// -json prints the same numbers as one object, for a script that alerts on
// them (I17). Same fields, same source, so the two cannot disagree.
func cmdStats(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("stats", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	asJSON := fs.Bool("json", false, "print one JSON object instead of prose")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := requireDataDir(*dataDir, "report on"); err != nil {
		return err
	}

	// Shared, like verify and backup: it only reads, so a live server is fine,
	// and a purge is not, because counting bodies while they are being swept
	// reports a number that was never true.
	lock, err := dirlock.Shared(*dataDir, dirlock.Data)
	if err != nil {
		return locked(err, *dataDir, "stats", "A purge is running. Its numbers will be right when it finishes.")
	}
	defer lock.Release()

	st, err := openExisting(*dataDir, "report on")
	if err != nil {
		return err
	}
	defer st.Close()

	vaults, err := st.Vaults()
	if err != nil {
		return err
	}
	bodies, err := st.Chunks().CountBodies()
	if err != nil {
		return err
	}
	if *asJSON {
		return writeStatsJSON(out, st, vaults, bodies)
	}
	if len(vaults) == 0 {
		fmt.Fprintln(out, "no vaults yet")
		return nil
	}

	for _, v := range vaults {
		s, err := st.Stats(v)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "vault %q\n", v)
		fmt.Fprintf(out, "  %d files, %d folders, %s of notes as the devices see them\n",
			s.Files, s.Folders, humanBytes(s.Bytes))
		// Deleted and recoverable are two facts, and conflating them told
		// people a purged note was safe. Only spelled out when they differ, so
		// the ordinary line stays one number.
		if lost := s.Deleted - s.Recoverable; lost > 0 {
			fmt.Fprintf(out, "  %d deleted: %d still recoverable, %d purged and gone for good\n",
				s.Deleted, s.Recoverable, lost)
		} else {
			fmt.Fprintf(out, "  %d deleted and still recoverable\n", s.Deleted)
		}
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

// statsJSON is what `stats -json` prints. Field names are the prose line's
// nouns, and every count the prose shows is here under its own name, purged
// separate from recoverable, history separate from versions, for the same
// reason the prose keeps them apart.
type statsJSON struct {
	Version string       `json:"version"`
	Vaults  []vaultStats `json:"vaults"`
	// Bodies is chunk files on disk across every vault, and GraceMs the window
	// a default purge spares.
	Bodies  int   `json:"bodies"`
	GraceMs int64 `json:"graceMs"`
}

type vaultStats struct {
	Vault       string `json:"vault"`
	Claimed     bool   `json:"claimed"`
	Files       int64  `json:"files"`
	Folders     int64  `json:"folders"`
	Bytes       int64  `json:"bytes"`
	Deleted     int64  `json:"deleted"`
	Recoverable int64  `json:"recoverable"`
	Purged      int64  `json:"purged"`
	Versions    int64  `json:"versions"`
	History     int64  `json:"history"`
	ChunkRefs   int64  `json:"chunkRefs"`
	LatestUID   int64  `json:"latestUid"`
	AllocatedTo int64  `json:"allocatedTo"`
	// Invites is single-use invites that could still be redeemed.
	Invites int `json:"invites"`
}

func writeStatsJSON(out io.Writer, st *store.Store, vaults []string, bodies int) error {
	rep := statsJSON{
		Version: resolveVersion(version, moduleVersion()),
		Vaults:  []vaultStats{},
		Bodies:  bodies,
		GraceMs: chunks.DefaultGrace.Milliseconds(),
	}
	now := time.Now().UnixMilli()
	for _, v := range vaults {
		s, err := st.Stats(v)
		if err != nil {
			return err
		}
		hash, err := st.AuthHash(v)
		if err != nil {
			return err
		}
		invites, err := st.OutstandingInvites(v, now)
		if err != nil {
			return err
		}
		history := s.Versions - (s.Files + s.Folders + s.Deleted)
		if history < 0 {
			history = 0
		}
		rep.Vaults = append(rep.Vaults, vaultStats{
			Vault: v, Claimed: hash != "",
			Files: s.Files, Folders: s.Folders, Bytes: s.Bytes,
			Deleted: s.Deleted, Recoverable: s.Recoverable, Purged: s.Deleted - s.Recoverable,
			Versions: s.Versions, History: history, ChunkRefs: s.ChunkRefs,
			LatestUID: s.LatestUID, AllocatedTo: s.AllocatedTo, Invites: invites,
		})
	}
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	return enc.Encode(rep)
}
