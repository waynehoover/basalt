package main

import (
	"strings"
	"testing"
)

// S12: values that end up in the unit are escaped for systemd, and a control
// character in any of them is refused rather than written.

// A newline in any identity or path would carry its own directive into a file
// installed as root. It is refused before anything is printed.
func TestS12AControlCharacterInAnyFieldIsRefused(t *testing.T) {
	dir := seeded(t)
	inject := "notes\nExecStartPre=/bin/rm -rf /"
	for _, args := range [][]string{
		{"service", "-data", dir, "-vault", inject},
		{"service", "-data", dir, "-user", inject},
		{"service", "-data", dir, "-addr", "127.0.0.1:3003\nUser=root"},
		{"service", "-data", dir, "-binary", "/usr/bin/basaltd\nExecStartPre=/x"},
	} {
		out, err := basalt(t, args...)
		if err == nil {
			t.Fatalf("%v was accepted; the injected directive would land in the unit:\n%s", args, out)
		}
		if !strings.Contains(err.Error(), "control character") {
			t.Fatalf("%v: err = %v, want it to name the control character", args, err)
		}
		if strings.Contains(out, "ExecStartPre") || strings.Contains(out, "\nUser=root") {
			t.Fatalf("%v printed an injected directive before refusing:\n%s", args, out)
		}
	}
}

// A space, a percent, a quote and a backslash are legal in a path or a vault
// name, and are escaped for systemd rather than refused. The escaped forms are
// what systemd reads back as the original value.
func TestS12SpecialCharactersAreEscapedNotRejected(t *testing.T) {
	dir := seeded(t)

	// A space: the ExecStart argument and ReadWritePaths are double-quoted, so
	// the path is one argument and one path rather than two.
	spaced := "/srv/my notes/basalt"
	out := mustRun(t, "service", "-data", dir, "-vault", "with space")
	if !strings.Contains(out, `-vault "with space"`) {
		t.Fatalf("a vault name with a space was not quoted:\n%s", out)
	}
	out = mustRun(t, "service", "-data", dir, "-binary", spaced)
	if !strings.Contains(out, `ExecStart="/srv/my notes/basalt" serve`) {
		t.Fatalf("a binary path with a space was not quoted:\n%s", out)
	}

	// A percent: systemd expands %x specifiers, so a literal percent is %%.
	out = mustRun(t, "service", "-data", dir, "-vault", "100%real")
	if !strings.Contains(out, "-vault 100%%real") {
		t.Fatalf("a percent in a vault name was not doubled:\n%s", out)
	}

	// A double quote and a backslash: escaped inside the quoting.
	out = mustRun(t, "service", "-data", dir, "-vault", `a"b\c`)
	if !strings.Contains(out, `-vault "a\"b\\c"`) {
		t.Fatalf("a quote and backslash were not escaped:\n%s", out)
	}
}
