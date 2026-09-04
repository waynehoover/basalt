package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/waynehoover/basalt-sync/server/internal/dirlock"
	"github.com/waynehoover/basalt-sync/server/internal/server"
	"github.com/waynehoover/basalt-sync/server/internal/store"
)

// cmdService prints a systemd unit for running this server.
//
// Printed rather than installed. Writing into /etc needs root, and a program
// that asks for root to do something a person could read first is a program
// that gets run with root for the rest of its life. This prints something you
// can look at, redirect, and put where you keep such things.
//
// The paths are this binary's and this data directory's, resolved, because a
// unit file with a placeholder in it is a unit file that fails on first start
// with a message about a path nobody typed.
func cmdService(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("service", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	addr := fs.String("addr", ":3003", "listen address the unit should use")
	vault := fs.String("vault", "default", "the one vault this server serves")
	runAs := fs.String("user", "", "user to run as (default: whoever is running this)")
	binary := fs.String("binary", "", "path to the basalt binary (default: this one)")
	// The ceiling goes in the unit, because a unit that cannot carry it is how
	// somebody who ran by hand with -max-file makes that permanent and silently
	// drops it. serve then refuses to start on a vault holding a larger file,
	// which is right, and the refusal arrives at three in the morning under
	// Restart=always instead of here. See the check below and
	// TestTheUnitCarriesTheFileCeiling.
	maxFile := fs.Int64("max-file", store.DefaultPerFileMax,
		"largest file to accept, in bytes; written into the unit, because a unit that drops it will not start on a vault holding a larger file")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// The unit this is about to print has to be one that starts. serve refuses
	// a ceiling below a live file the vault already holds, so a unit generated
	// without the flag that the vault needs is a unit that fails on first
	// start, five seconds later, and every five seconds after that. Checked
	// here, against the same store and the same rule, so the refusal reaches
	// whoever is typing rather than whoever reads journals (rule 7: say what
	// the vault holds, not what this command was told).
	//
	// Only when there is a data directory to read. `basaltd service` is
	// normally run before the first serve, on a directory that does not exist
	// yet, and refusing to print a unit because there is nothing to check
	// would be refusing the ordinary case. Shared, like verify: this reads and
	// can run beside a live server.
	dbPath, _ := store.DataDir(*dataDir)
	if _, err := os.Stat(dbPath); err == nil {
		lock, err := dirlock.Shared(*dataDir, dirlock.Data)
		if err != nil {
			return locked(err, *dataDir, "service", stopFirst)
		}
		defer lock.Release()
		st, err := openStore(*dataDir)
		if err != nil {
			return err
		}
		defer st.Close()
		if err := refuseCeilingBelowContent(st, *vault, server.ClampPerFileMax(*maxFile)); err != nil {
			return fmt.Errorf("this unit would not start:\n%w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		// Rule 2: a failed read is not an empty result. A data directory that
		// cannot be described is not one with nothing in it.
		return err
	}

	if runtime.GOOS != "linux" {
		fmt.Fprintf(out, "# Written for systemd. This machine is %s, so this is a template\n", runtime.GOOS)
		fmt.Fprintf(out, "# rather than something to install here.\n\n")
	}

	exe := *binary
	if exe == "" {
		found, err := os.Executable()
		if err != nil {
			return fmt.Errorf("working out where this binary is: %w", err)
		}
		if resolved, err := filepath.EvalSymlinks(found); err == nil {
			found = resolved
		}
		exe = found
	}
	who := *runAs
	if who == "" {
		u, err := user.Current()
		if err != nil {
			return fmt.Errorf("working out who is running this: %w", err)
		}
		who = u.Username
	}
	data, err := filepath.Abs(*dataDir)
	if err != nil {
		return err
	}
	// The home directory of the user the unit runs as, when the system can say.
	// It is what decides whether ProtectHome would break the service, and the
	// three well-known prefixes are only a fallback for a user it cannot find.
	home := ""
	if u, err := user.Lookup(who); err == nil {
		home = u.HomeDir
	}

	// Everything that ends up in the unit is checked for control characters
	// before it is written (S12). A newline in any of these would let the value
	// carry its own directive into a file someone installs as root: a data path
	// of "x\nExecStartPre=/bin/rm -rf /" is the whole attack, and it is silent
	// because the unit still starts. The values are also escaped for systemd
	// and for the shell where they land, but a control character has no safe
	// escaping in a line-oriented format, so it is refused rather than encoded.
	for _, f := range []struct{ what, val string }{
		{"binary path", exe}, {"data directory", data}, {"listen address", *addr},
		{"vault name", *vault}, {"user", who}, {"home directory", home},
	} {
		if i := strings.IndexFunc(f.val, isControl); i >= 0 {
			return fmt.Errorf("the %s contains a control character (byte %d at position %d), "+
				"which cannot go safely into a systemd unit", f.what, f.val[i], i)
		}
	}

	fmt.Fprint(out, unit(unitArgs{Binary: exe, Data: data, Addr: *addr, Vault: *vault, User: who,
		Home: home, MaxFile: server.ClampPerFileMax(*maxFile)}))
	// The examples are shell, not systemd, so their paths are shell-quoted. A
	// path with a space, pasted unquoted, would run `backup -data /my` against a
	// directory that is not the one meant.
	qExe, qData := shellQuote(exe), shellQuote(data)
	fmt.Fprintf(out, `
# To install, as root:
#
#   basaltd service > /etc/systemd/system/basalt.service
#   systemctl daemon-reload
#   systemctl enable --now basalt
#   systemctl status basalt
#   journalctl -u basalt -f
#
# The token it prints on its first run is in the log:
#
#   journalctl -u basalt | grep '#'
#
# Backups do not need the server stopped, so this is a cron or timer away:
#
#   %s backup -data %s -to /somewhere/else
#
# Purge does need it stopped, because it deletes chunk bodies, and it wants the
# vault's name again and the backup that holds what it is about to drop:
#
#   systemctl stop basalt && %s purge -data %s -confirm %s -backup /somewhere/else && systemctl start basalt
`, qExe, qData, qExe, qData, shellQuote(*vault))
	return nil
}

// isControl reports whether r is a C0 or C1 control character, the class that
// has no safe place in a line-oriented config or a shell command.
func isControl(r rune) bool {
	return r < 0x20 || (r >= 0x7f && r <= 0x9f)
}

// systemdArg quotes one ExecStart argument by systemd's documented rules.
//
// systemd substitutes environment variables and specifiers on the whole line
// before it splits on whitespace, so `$` and `%` are escaped as `$$` and `%%`
// whether or not the value is quoted. A value with whitespace, quotes or a
// backslash is then wrapped in double quotes, inside which `\` and `"` are the
// C-style escapes. Control characters are refused upstream, so they never
// reach here.
func systemdArg(s string) string {
	s = strings.ReplaceAll(s, "%", "%%")
	s = strings.ReplaceAll(s, "$", "$$")
	if s == "" || strings.ContainsAny(s, " \t'\"\\") {
		s = strings.ReplaceAll(s, `\`, `\\`)
		s = strings.ReplaceAll(s, `"`, `\"`)
		return `"` + s + `"`
	}
	return s
}

// shellQuote wraps a value in single quotes for a POSIX shell, so the examples
// survive a space or a special character. A single quote inside is closed,
// escaped, and reopened, the only way to put one inside single quotes.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

type unitArgs struct {
	Binary, Data, Addr, Vault, User string
	// Home is the run-as user's home directory, or "" when unknown.
	Home string
	// MaxFile is the file ceiling the unit will run with, in bytes.
	MaxFile int64
}

// unit is the systemd unit itself.
//
// The hardening is not decoration. This process holds every note you have, in
// ciphertext it cannot read, and it needs exactly one directory and one socket.
// Everything below says so to the kernel, so a defect in it has somewhere it
// cannot reach.
//
// No TLS here on purpose. docs/design.md keeps key material out of this
// binary, so put `tailscale serve` or a tunnel in front and leave this bound to
// localhost.
func unit(a unitArgs) string {
	return strings.Join([]string{
		"[Unit]",
		"Description=Basalt, self-hosted sync for Obsidian",
		"Documentation=https://github.com/waynehoover/basalt-sync",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"# Restart=always below comes back from anything, and this is where that",
		"# stops. serve refuses to start on a vault holding a file above",
		"# -max-file, and a refusal is not a crash: with no limit it reprints",
		"# every five seconds for ever while the unit never reaches failed and",
		"# nothing watching unit state says a word. Five failures inside five",
		"# minutes and systemd gives up, so `systemctl status basalt` says failed",
		"# and the reason is the last thing in the journal. Once it is fixed,",
		"# `systemctl reset-failed basalt` before starting again. A server that",
		"# crashes now and then is well inside this and still comes back.",
		"StartLimitIntervalSec=5min",
		"StartLimitBurst=5",
		"",
		"[Service]",
		"Type=simple",
		"User=" + a.User,
		// -max-file is spelled out rather than left to the default. The default
		// is a number in this binary, and a unit whose ceiling moves when the
		// binary is upgraded is a unit that stops starting on a vault holding a
		// file the old default allowed.
		fmt.Sprintf("ExecStart=%s serve -data %s -addr %s -vault %s -max-file %d",
			systemdArg(a.Binary), systemdArg(a.Data), systemdArg(a.Addr), systemdArg(a.Vault), a.MaxFile),
		"",
		"# SIGTERM is what serve already listens for, and it finishes what it is",
		"# doing: an ack means stored, and a shutdown must not turn one into a lie.",
		"KillSignal=SIGTERM",
		"TimeoutStopSec=30",
		"",
		"# Comes back from anything. A sync server that stays down after one bad",
		"# night is one you find out about from a device that has been quietly not",
		"# syncing.",
		"Restart=always",
		"RestartSec=5",
		"# ...but not for ever: see the start limit in [Unit] above.",
		"",
		"# One directory, one socket, nothing else.",
		"NoNewPrivileges=true",
		"PrivateTmp=true",
		"PrivateDevices=true",
		"ProtectSystem=strict",
	}, "\n") + protectHome(a.Data, a.Home) + strings.Join([]string{
		// ReadWritePaths is a space-separated list, so a path with a space in it
		// is quoted the same way an ExecStart argument is, or it would be read
		// as two paths.
		"ReadWritePaths=" + systemdArg(a.Data),
		"ProtectKernelTunables=true",
		"ProtectKernelModules=true",
		"ProtectControlGroups=true",
		"RestrictNamespaces=true",
		"RestrictRealtime=true",
		"RestrictSUIDSGID=true",
		"LockPersonality=true",
		"MemoryDenyWriteExecute=true",
		"SystemCallArchitectures=native",
		"SystemCallFilter=@system-service",
		"CapabilityBoundingSet=",
		"",
		"# Sockets and files. No raw sockets, no anything else.",
		"RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	}, "\n")
}

// protectHome emits ProtectHome only when it would not break the service.
//
// The default data directory is ~/.basalt, and ProtectHome=true makes home
// unreadable to the unit, so the hardening line that looks most obviously
// correct is the one that stops the server starting at all. It is emitted when
// the data lives somewhere else, and explained when it does not, because a
// directive quietly missing is worse than one that says why.
func protectHome(data, home string) string {
	if !underHome(data, home) {
		return "\nProtectHome=true\n"
	}
	return "\n# ProtectHome is left off: the data directory is inside a home\n" +
		"# directory, and turning it on would make that unreadable to this unit.\n" +
		"# Moving the data somewhere like /var/lib/basalt and adding\n" +
		"# ProtectHome=true is the stronger arrangement.\n"
}

// underHome says whether the data directory is inside the run-as user's home.
//
// `home` is the real answer when the system could supply one, and it is what
// makes this right on a machine whose homes are not under /home: a data
// directory at /srv/people/wayne/.basalt used to get ProtectHome=true and a
// unit that could not read its own data. The prefixes stay as a fallback for a
// user that does not exist yet on the machine generating the unit.
func underHome(path, home string) bool {
	if home != "" && home != "/" {
		home = strings.TrimSuffix(home, "/")
		if path == home || strings.HasPrefix(path, home+"/") {
			return true
		}
	}
	for _, prefix := range []string{"/home/", "/root/", "/Users/"} {
		if strings.HasPrefix(path, prefix) || path == strings.TrimSuffix(prefix, "/") {
			return true
		}
	}
	return false
}
