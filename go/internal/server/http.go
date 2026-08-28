package server

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/coder/websocket"
)

// AllowedOrigins lists the browser origins permitted to open a session.
//
// A Go client sends no Origin header and is always allowed. A browser client
// always sends one, and the websocket library refuses a cross-origin handshake
// by default. Every test in this package used a Go client, so the whole suite
// passed while no Obsidian plugin could connect at all; the server said
//
//	request Origin "obsidian.md" is not authorized for Host "127.0.0.1:18500"
//
// and only loading the plugin into a real vault showed it.
//
// The desktop entry is verified: `location.origin` inside a running Obsidian is
// exactly "app://obsidian.md". The two mobile entries are Capacitor's documented
// defaults, iOS and Android in that order, and have not been checked against a
// device.
//
// Everything else is still refused. A page in somebody's browser could not
// authenticate anyway, because the token travels in `hello` rather than being
// attached automatically the way a cookie would be, but refusing at the
// handshake is cheaper than relying on that, and this project refuses by
// default. Patterns carry their scheme so that "app://obsidian.md" does not also
// admit "https://obsidian.md".
var AllowedOrigins = []string{
	"app://obsidian.md",
	"capacitor://localhost",
	"http://localhost",
}

// HTTPHandler is everything the server exposes: a health check and the
// websocket endpoint.
//
// It lives here rather than in main so that it can be tested. The origin list
// above is the reason that matters: it is the kind of thing that is invisible
// until somebody runs the real client, and it should not be invisible twice.
func HTTPHandler(srv *Server, log *slog.Logger) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
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
			OriginPatterns:  AllowedOrigins,
		})
		if err != nil {
			log.Warn("websocket accept", "remote", r.RemoteAddr, "err", err)
			return
		}
		srv.Handle(r.Context(), conn, r.RemoteAddr)
	})

	return mux
}
