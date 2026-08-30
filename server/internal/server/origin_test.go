package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The Obsidian plugin is a browser client, and browser clients send an Origin
// header. Every other test here uses a Go client, which does not, so the whole
// suite passed while no plugin could connect at all. This is that gap.
//
// Found by loading the plugin into a real vault, where the server said:
//
//	request Origin "obsidian.md" is not authorized for Host "127.0.0.1:18500"
func TestOriginsThatMustBeAllowed(t *testing.T) {
	// Desktop's is verified: `location.origin` inside a running Obsidian is
	// exactly this. The mobile ones are Capacitor's documented defaults and
	// have not been checked against a device.
	for _, origin := range []string{
		"app://obsidian.md",
		"capacitor://localhost",
		"http://localhost",
	} {
		t.Run(origin, func(t *testing.T) {
			if err := dialWithOrigin(t, origin); err != nil {
				t.Fatalf("a client from %s could not connect: %v", origin, err)
			}
		})
	}
}

// Origin checking stays on for everything else. A page in the user's browser
// could not authenticate anyway, because the token is sent in `hello` rather
// than carried automatically the way a cookie would be, but refusing early is
// cheaper than relying on that and this project refuses by default.
func TestOriginsThatMustBeRefused(t *testing.T) {
	for _, origin := range []string{
		"https://evil.example.com",
		"http://obsidian.md.evil.example.com",
		"app://something-else",
	} {
		t.Run(origin, func(t *testing.T) {
			if err := dialWithOrigin(t, origin); err == nil {
				t.Fatalf("a client from %s was allowed to connect", origin)
			}
		})
	}
}

// A client with no Origin at all is the headless one, and it is still allowed.
func TestNoOriginIsStillAllowed(t *testing.T) {
	if err := dialWithOrigin(t, ""); err != nil {
		t.Fatalf("a client sending no Origin could not connect: %v", err)
	}
}

func dialWithOrigin(t *testing.T, origin string) error {
	t.Helper()
	r := newRig(t)
	hs := httptest.NewServer(HTTPHandler(r.srv, testLogger()))
	t.Cleanup(hs.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	header := http.Header{}
	if origin != "" {
		header.Set("Origin", origin)
	}
	conn, _, err := websocket.Dial(ctx, "ws"+hs.URL[len("http"):], &websocket.DialOptions{
		HTTPHeader: header,
	})
	if err != nil {
		return err
	}
	conn.Close(websocket.StatusNormalClosure, "")
	return nil
}

func testLogger() *slog.Logger {
	var out io.Writer = io.Discard
	if os.Getenv("BASALT_TEST_LOG") != "" {
		out = os.Stderr
	}
	return slog.New(slog.NewTextHandler(out, nil))
}

// An origin the built-in list does not know can be allowed without a rebuild.
//
// Obsidian's mobile origins are in that list on the strength of Capacitor's
// documented defaults and have never been checked against a device. If they are
// wrong, a phone fails to connect and the only thing that knows the right
// answer is the phone. The log line names the origin and the flag.
func TestAnOriginCanBeAllowedFromTheCommandLine(t *testing.T) {
	const odd = "capacitor://something-else"
	if err := dialWithOrigin(t, odd); err == nil {
		t.Fatal("an origin nobody allowed was accepted")
	}

	r := newRig(t)
	hs := httptest.NewServer(HTTPHandler(r.srv, testLogger(), odd))
	t.Cleanup(hs.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	header := http.Header{}
	header.Set("Origin", odd)
	conn, _, err := websocket.Dial(ctx, "ws"+hs.URL[len("http"):], &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatalf("an allowed origin was still refused: %v", err)
	}
	conn.Close(websocket.StatusNormalClosure, "")

	// And allowing one does not allow everything else.
	hs2 := httptest.NewServer(HTTPHandler(r.srv, testLogger(), odd))
	t.Cleanup(hs2.Close)
	header2 := http.Header{}
	header2.Set("Origin", "https://evil.example.com")
	if _, _, err := websocket.Dial(ctx, "ws"+hs2.URL[len("http"):], &websocket.DialOptions{
		HTTPHeader: header2,
	}); err == nil {
		t.Fatal("allowing one origin allowed every other")
	}
}
