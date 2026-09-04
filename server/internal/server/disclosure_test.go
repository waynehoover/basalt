package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

/* ---------------------------------------------------------------- *
 * What a stranger on the port learns: nothing about the build
 * ---------------------------------------------------------------- */

// sentinelVersion is what these tests set the server's version to. It is not a
// plausible release, on purpose: any occurrence of it anywhere in a pre-auth
// response is the version having escaped, and nothing else could produce this
// string by accident.
const sentinelVersion = "0.0.0-sentinel-Zq7Whk"

// Behind Caddy the port is on the internet, and every refusal below needs no
// credential at all. The proto refusal used to say "this server (version
// 0.3.2) speaks 3 to 3", which handed any prober the one string a targeted
// exploit starts from. The version moved behind authentication, where `ready`
// already carries it.
//
// This asserts the property, not three strings (rule 10). The three-string
// version of this test passed with the version added back to the pre-auth
// `auth` refusal, to `missing vault`, or to the 426 body, because it only ever
// looked at the two refusals it happened to name. So: stamp a sentinel, walk
// every pre-auth surface there is, and assert the sentinel is in none of them,
// headers included. docs/design.md, "What a stranger on the port learns".
//
// A surface added to the server and not to these tables is the hole this
// cannot close. The tables are written to be read against handleHello and
// HTTPHandler side by side.
func TestNoPreAuthSurfaceNamesTheServerVersion(t *testing.T) {
	t.Run("http", func(t *testing.T) {
		r := newRig(t)
		r.srv.SetVersion(sentinelVersion)
		hs := httptest.NewServer(HTTPHandler(r.srv, testLogger()))
		t.Cleanup(hs.Close)

		// Every verb on /health, and the 426 catch-all on paths a prober
		// actually tries, including the ones a scanner sends.
		for _, tc := range []struct{ what, method, path string }{
			{"health GET", "GET", "/health"},
			{"health HEAD", "HEAD", "/health"},
			{"health POST", "POST", "/health"},
			{"health PUT", "PUT", "/health"},
			{"health DELETE", "DELETE", "/health"},
			{"health OPTIONS", "OPTIONS", "/health"},
			{"root", "GET", "/"},
			{"root POST", "POST", "/"},
			{"unknown path", "GET", "/version"},
			{"unknown path", "GET", "/.well-known/anything"},
			{"unknown path", "POST", "/api/v1/whatever"},
			{"query string", "GET", "/?version=1"},
		} {
			req, err := http.NewRequest(tc.method, hs.URL+tc.path, nil)
			if err != nil {
				t.Fatalf("%s: %v", tc.what, err)
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("%s %s: %v", tc.method, tc.path, err)
			}
			body, err := io.ReadAll(res.Body)
			res.Body.Close()
			if err != nil {
				t.Fatalf("%s %s: reading: %v", tc.method, tc.path, err)
			}
			assertNoVersion(t, tc.what+" "+tc.method+" "+tc.path+" body", string(body))
			// Headers too. A Server or X-Powered-By added by a future
			// middleware is the same disclosure through a different door, and
			// nothing in the body assertions would have seen it.
			var headers strings.Builder
			headers.WriteString(res.Status)
			for k, vs := range res.Header {
				for _, v := range vs {
					headers.WriteString("\n" + k + ": " + v)
				}
			}
			assertNoVersion(t, tc.what+" "+tc.method+" "+tc.path+" headers", headers.String())
			if h := res.Header.Get("Server"); h != "" {
				t.Errorf("%s %s sends a Server header: %q", tc.method, tc.path, h)
			}
			if h := res.Header.Get("X-Powered-By"); h != "" {
				t.Errorf("%s %s sends an X-Powered-By header: %q", tc.method, tc.path, h)
			}
		}
	})

	// Every refusal handleHello can send before s.srv.auth has said yes, plus
	// the two the connection can get without a hello at all. Each is the whole
	// frame as it came off the wire, not the message field, because a version
	// could as easily arrive in a field a struct would not decode.
	t.Run("websocket", func(t *testing.T) {
		for _, tc := range []struct {
			what string
			code string
			// send writes whatever produces the refusal. A raw send is used
			// where the refusal comes before the id is taken.
			send func(*rig, *client)
		}{
			{"proto too old", wire.CodeProto, func(r *rig, c *client) {
				c.sendRaw(wire.In{Op: "hello", ID: 1, Proto: wire.MinProto - 1, Crypto: wire.Crypto,
					Vault: testVault, Device: "prober"})
			}},
			{"proto too new", wire.CodeProto, func(r *rig, c *client) {
				c.sendRaw(wire.In{Op: "hello", ID: 1, Proto: wire.Proto + 1, Crypto: wire.Crypto,
					Vault: testVault, Device: "prober"})
			}},
			{"crypto", wire.CodeProto, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Crypto: "basalt/something-else/1",
					Vault: testVault, Device: "prober"})
			}},
			{"missing vault", wire.CodeAuth, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: "", Device: "prober"})
			}},
			{"bad token", wire.CodeAuth, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto,
					Vault: testVault, Device: "prober", Token: "not the token"})
			}},
			{"unknown vault", wire.CodeAuth, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto,
					Vault: "no-such-vault", Device: "prober", Token: testToken})
			}},
			{"bad vault name", wire.CodeBadName, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto,
					Vault: strings.Repeat("v", store.MaxVaultLen+1), Device: "prober"})
			}},
			{"bad device name", wire.CodeBadName, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto,
					Vault: testVault, Device: "a\nb"})
			}},
			{"negative cursor", wire.CodeProtoState, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto,
					Vault: testVault, Device: "prober", Cursor: -1})
			}},
			{"claim without a data key", wire.CodeBadEntry, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
					Device: "prober", Token: testToken, Claim: "something", Wrapped: ""})
			}},
			{"token and invite together", wire.CodeBadEntry, func(r *rig, c *client) {
				c.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
					Device: "prober", Token: testToken, Invite: "an-invite"})
			}},
			{"first op is not hello", wire.CodeProtoState, func(r *rig, c *client) {
				c.sendRaw(wire.In{Op: "get", ID: 1})
			}},
			{"hello is not JSON", wire.CodeProtoState, func(r *rig, c *client) {
				if err := c.conn.Write(c.ctx, websocket.MessageText, []byte(`{"op":`)); err != nil {
					c.t.Fatalf("write: %v", err)
				}
			}},
			{"first frame is binary", wire.CodeProtoState, func(r *rig, c *client) {
				c.sendBinary([]byte("not a hello"))
			}},
			{"no hello at all", wire.CodeProtoState, func(r *rig, c *client) {
				// The deadline fires on its own; nothing is sent.
			}},
		} {
			t.Run(tc.what, func(t *testing.T) {
				r := newRig(t)
				r.srv.SetVersion(sentinelVersion)
				r.srv.helloTimeout = 200 * time.Millisecond
				cl := r.dial("prober")
				tc.send(r, cl)
				frame := cl.recvFrame()
				var got struct {
					Res  string `json:"res"`
					Code string `json:"code"`
				}
				if err := json.Unmarshal(frame, &got); err != nil {
					t.Fatalf("%s: the refusal is not JSON: %v\n%s", tc.what, err, frame)
				}
				if got.Res != "err" || got.Code != tc.code {
					t.Fatalf("%s: got res %q code %q, want an err with code %q\n%s",
						tc.what, got.Res, got.Code, tc.code, frame)
				}
				assertNoVersion(t, tc.what, string(frame))
			})
		}
	})
}

// assertNoVersion fails when the sentinel, or anything that looks like it,
// appears in a pre-auth response.
func assertNoVersion(t *testing.T, what, got string) {
	t.Helper()
	if strings.Contains(got, sentinelVersion) {
		t.Fatalf("%s names the server version:\n%s", what, got)
	}
	// The sentinel with its decoration stripped, in case something prints only
	// a part of it. Nothing legitimate contains this either.
	if strings.Contains(got, "sentinel") {
		t.Fatalf("%s carries part of the server version:\n%s", what, got)
	}
}

// The version is still there for a device that has proved it holds the vault.
// Withholding it everywhere would take the one line an operator reads to know
// which end to upgrade.
func TestReadyStillCarriesTheVersionAfterAuthentication(t *testing.T) {
	r := newRig(t)
	r.srv.SetVersion(sentinelVersion)
	ready, _ := r.dial("a").hello(0)
	if ready.ServerVersion != sentinelVersion {
		t.Fatalf("serverVersion after auth = %q, want %q", ready.ServerVersion, sentinelVersion)
	}
}

// The two refusals still have to say the numbers an old client needs, or the
// disclosure rule above would be satisfied by saying nothing useful at all.
func TestTheProtoAndCryptoRefusalsStillNameWhatThisServerSpeaks(t *testing.T) {
	r := newRig(t)
	r.srv.SetVersion(sentinelVersion)

	cl := r.dial("prober")
	cl.sendRaw(wire.In{Op: "hello", ID: 1, Proto: wire.MinProto - 1, Crypto: wire.Crypto,
		Vault: testVault, Device: "prober"})
	msg := cl.expectErr(wire.CodeProto)
	for _, want := range []string{"protocol 3", "4 to 4"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("the proto refusal does not name %q: %q", want, msg)
		}
	}

	cl = r.dial("prober")
	cl.sendJSON(wire.In{Op: "hello", Crypto: "basalt/something-else/1",
		Vault: testVault, Device: "prober"})
	if msg := cl.expectErr(wire.CodeProto); !strings.Contains(msg, wire.Crypto) {
		t.Fatalf("the crypto refusal does not name the suite this server speaks: %q", msg)
	}
}

// /health answers "ok" and nothing else. Pinned separately from the version
// property because the body being exactly two bytes is its own promise: a
// health endpoint that grows a JSON summary is a health endpoint that will one
// day grow a version into it.
func TestHealthSaysOkAndNothingElse(t *testing.T) {
	r := newRig(t)
	r.srv.SetVersion(sentinelVersion)
	hs := httptest.NewServer(HTTPHandler(r.srv, testLogger()))
	t.Cleanup(hs.Close)

	res, err := http.Get(hs.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("reading /health: %v", err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("/health answered %s", res.Status)
	}
	if string(body) != "ok\n" {
		t.Fatalf("/health body = %q, want exactly \"ok\\n\"", body)
	}
}
