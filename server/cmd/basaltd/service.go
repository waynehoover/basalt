package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
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
	if err := fs.Parse(args); err != nil {
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

	fmt.Fprint(out, unit(unitArgs{Binary: exe, Data: data, Addr: *addr, Vault: *vault, User: who}))
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
# Purge does need it stopped, because it deletes chunk bodies:
#
#   systemctl stop basalt && %s purge -data %s && systemctl start basalt
`, exe, data, exe, data)
	return nil
}

type unitArgs struct {
	Binary, Data, Addr, Vault, User string
}

// unit is the systemd unit itself.
//
// The hardening is not decoration. This process holds every note you have, in
// ciphertext it cannot read, and it needs exactly one directory and one socket.
// Everything below says so to the kernel, so a defect in it has somewhere it
// cannot reach.
//
// No TLS here on purpose. docs/philosophy.md keeps key material out of this
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
		"[Service]",
		"Type=simple",
		"User=" + a.User,
		fmt.Sprintf("ExecStart=%s serve -data %s -addr %s -vault %s", a.Binary, a.Data, a.Addr, a.Vault),
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
		"",
		"# One directory, one socket, nothing else.",
		"NoNewPrivileges=true",
		"PrivateTmp=true",
		"PrivateDevices=true",
		"ProtectSystem=strict",
	}, "\n") + protectHome(a.Data) + strings.Join([]string{
		"ReadWritePaths=" + a.Data,
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
func protectHome(data string) string {
	if !underHome(data) {
		return "\nProtectHome=true\n"
	}
	return "\n# ProtectHome is left off: the data directory is inside a home\n" +
		"# directory, and turning it on would make that unreadable to this unit.\n" +
		"# Moving the data somewhere like /var/lib/basalt and adding\n" +
		"# ProtectHome=true is the stronger arrangement.\n"
}

func underHome(path string) bool {
	for _, prefix := range []string{"/home/", "/root/", "/Users/"} {
		if strings.HasPrefix(path, prefix) || path == strings.TrimSuffix(prefix, "/") {
			return true
		}
	}
	return false
}
