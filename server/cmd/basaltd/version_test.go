package main

import "testing"

// A binary that cannot say what it is is the thing the version stamp exists to
// prevent, and `go install ...@v0.1.3` reaches no ldflags: it called itself
// "dev" until the build info was consulted as well.
func TestResolveVersion(t *testing.T) {
	for _, c := range []struct {
		why, stamped, module, want string
	}{
		{"the stamp wins when there is one", "0.1.4", "v0.1.3", "0.1.4"},
		{"the stamp wins even with no build info", "0.1.4", "", "0.1.4"},
		{"go install falls back to the module version", "dev", "v0.1.3", "0.1.3"},
		{"and prints it without the v, as a stamped build does", "dev", "v1.2.3", "1.2.3"},
		{"a working tree build stays dev", "dev", "(devel)", "dev"},
		{"and so does a build with no info at all", "dev", "", "dev"},
	} {
		if got := resolveVersion(c.stamped, c.module); got != c.want {
			t.Errorf("%s: resolveVersion(%q, %q) = %q, want %q", c.why, c.stamped, c.module, got, c.want)
		}
	}
}
