package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// Protocol 3, server side. docs/protocol.md is the contract; every test here
// reads a shape off the wire rather than trusting a struct, because the point
// of most of them is which fields are and are not present.

// A wrapped data key of the shape a client produces: 60 bytes in base64url.
const testWrapped = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

// rawFields decodes a frame into a map so a test can ask which keys it has.
func rawFields(t *testing.T, frame string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(frame), &m); err != nil {
		t.Fatalf("parse %q: %v", frame, err)
	}
	return m
}

/* ---------------------------------------------------------------- *
 * I1: request ids
 * ---------------------------------------------------------------- */

// Every reply echoes the id of the request it answers, and so does an error
// refusing that request. The harness checks this on every frame it reads; this
// test sends chosen ids so the echo is visible rather than merely consistent.
func TestI1RepliesAndRefusalsEchoTheRequestId(t *testing.T) {
	r := newRig(t)
	e := r.seed("note.md", "body")
	cl := r.dial("a")
	cl.hello(0)

	cl.sendJSON(wire.In{Op: "get", ID: 4242, UID: e.UID})
	if m := cl.recv(); m["res"] != "chunks" || m["id"] != float64(4242) {
		t.Fatalf("get with id 4242 was answered %v", m)
	}
	cl.sendJSON(wire.In{Op: "get", ID: 77, UID: 999})
	m := cl.recv()
	if m["res"] != "err" || m["code"] != wire.CodeNoUID || m["id"] != float64(77) {
		t.Fatalf("a refused get did not carry its id: %v", m)
	}
	if m["retryable"] != false {
		t.Fatalf("nouid is not retryable, got %v", m["retryable"])
	}
	cl.sendJSON(wire.In{Op: "history", ID: 9, Path: "note.md"})
	if m := cl.recv(); m["res"] != "history" || m["id"] != float64(9) {
		t.Fatalf("history was answered %v", m)
	}
	cl.sendJSON(wire.In{Op: "deleted", ID: 10})
	if m := cl.recv(); m["res"] != "deleted" || m["id"] != float64(10) {
		t.Fatalf("deleted was answered %v", m)
	}
	// A put is answered twice, want then ack, and both carry the id.
	names, size := chunkNames([]string{"fresh"})
	cl.sendJSON(wire.In{Op: "put", ID: 11, Path: "b.md", Chunks: names, Mac: testMac,
		Meta: wire.PutMeta{Size: size, MTime: 1}})
	if m := cl.recv(); m["res"] != "want" || m["id"] != float64(11) {
		t.Fatalf("want was %v", m)
	}
	cl.sendBinary([]byte("fresh"))
	if m := cl.recv(); m["res"] != "ack" || m["id"] != float64(11) {
		t.Fatalf("ack was %v", m)
	}
}

// The server never sends an id it was not given: batches, caught-up and pongs
// are unsolicited and carry none.
func TestI1UnsolicitedFramesCarryNoId(t *testing.T) {
	r := newRig(t)
	r.seed("a.md", "one")
	cl := r.dial("a")
	cl.sendJSON(helloMsg(testVault, testToken, "a", 0))
	// ready, one batch, caught-up: read raw so absent and present are visible.
	for _, want := range []string{"ready", "batch", "caught-up"} {
		f := rawFields(t, cl.recvRaw())
		name := f["res"]
		if name == nil {
			name = f["op"]
		}
		if name != want {
			t.Fatalf("wanted %s, got %v", want, f)
		}
		_, hasID := f["id"]
		if want == "ready" && !hasID {
			t.Fatalf("ready carries no id: %v", f)
		}
		if want != "ready" && hasID {
			t.Fatalf("%s carries an id it was never given: %v", want, f)
		}
	}
	// A live change from another device: also unsolicited.
	other := r.dial("b")
	other.hello(1)
	other.put("b.md", "two")
	if f := rawFields(t, cl.recvRaw()); f["op"] != "batch" || f["id"] != nil {
		t.Fatalf("a live batch was %v", f)
	}
	cl.sendJSON(wire.In{Op: "ping"})
	if f := rawFields(t, cl.recvRaw()); f["res"] != "pong" || f["id"] != nil {
		t.Fatalf("pong was %v", f)
	}
}

// A protocol 3 request with no id, or one out of range, cannot be answered in a
// way the client could match, so the session ends with a reason.
func TestI1AProto3RequestWithoutAnIdEndsTheSession(t *testing.T) {
	for _, tc := range []struct {
		why string
		id  int64
	}{
		{"no id", 0},
		{"above 2^32-1", wire.MaxRequestID + 1},
		{"negative", -1},
	} {
		t.Run(tc.why, func(t *testing.T) {
			r := newRig(t)
			cl := r.dial("a")
			cl.hello(0)
			cl.sendRaw(wire.In{Op: "deleted", ID: tc.id})
			msg := cl.expectErr(wire.CodeProtoState)
			if !strings.Contains(msg, "id") {
				t.Fatalf("the refusal does not mention the id: %q", msg)
			}
			if !cl.closed() {
				t.Fatal("the session survived a request it could not answer")
			}
		})
	}
}

// A protocol 3 fetch is answered by a `bodies` header saying exactly how many
// frames follow, or by an error and no frames, never bodies then an error.
func TestI1FetchIsAnsweredByABodiesHeaderOrAnError(t *testing.T) {
	r := newRig(t)
	e := r.seed("note.md", "one", "two", "three")
	cl := r.dial("a")
	cl.hello(0)

	cl.sendJSON(wire.In{Op: "fetch", ID: 5, Chunks: e.Chunks})
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "bodies" || f["id"] != float64(5) || f["count"] != float64(3) {
		t.Fatalf("fetch was answered %v, want bodies id 5 count 3", f)
	}
	for i, want := range []string{"one", "two", "three"} {
		if got := cl.recvBinary(); string(got) != want {
			t.Fatalf("body %d is %q", i, got)
		}
	}
	// Exactly three: the next frame is the pong, not a stray body.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})

	// One missing chunk refuses the whole fetch with the id and sends nothing.
	absent := chunks.Name([]byte("never uploaded"))
	cl.sendJSON(wire.In{Op: "fetch", ID: 6, Chunks: []string{e.Chunks[0], absent}})
	f = rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeNoChunk || f["id"] != float64(6) {
		t.Fatalf("a fetch of a missing chunk was answered %v", f)
	}
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

/* ---------------------------------------------------------------- *
 * I2: retryable
 * ---------------------------------------------------------------- */

// Every protocol 3 error says whether reconnecting later can help, per the
// table in docs/protocol.md, and `busy` says how long to wait.
func TestI2ErrorsCarryRetryablePerTheTable(t *testing.T) {
	t.Run("busy at the device limit is retryable with a hint", func(t *testing.T) {
		r := newRigWithPeers(t, 1)
		r.dial("a").hello(0)
		late := r.dial("b")
		late.sendJSON(helloMsg(testVault, testToken, "b", 0))
		f := rawFields(t, late.recvRaw())
		if f["code"] != wire.CodeBusy || f["retryable"] != true {
			t.Fatalf("device limit refusal: %v", f)
		}
		if ms, _ := f["retryAfterMs"].(float64); ms <= 0 {
			t.Fatalf("busy carries no retryAfterMs: %v", f)
		}
		if f["id"] == nil {
			t.Fatalf("the hello's refusal carries no id: %v", f)
		}
	})
	t.Run("auth, cursor and proto are not", func(t *testing.T) {
		r := newRig(t)
		r.seed("a.md", "one")
		for _, tc := range []struct {
			code string
			msg  wire.In
		}{
			{wire.CodeAuth, helloMsg(testVault, "guess", "a", 0)},
			{wire.CodeCursor, helloMsg(testVault, testToken, "a", 99)},
			{wire.CodeProto, wire.In{Op: "hello", Proto: wire.Proto + 1, Crypto: wire.Crypto,
				Vault: testVault, Token: testToken}},
		} {
			cl := r.dial("x")
			cl.sendJSON(tc.msg)
			f := rawFields(t, cl.recvRaw())
			if f["code"] != tc.code {
				t.Fatalf("wanted %s, got %v", tc.code, f)
			}
			if f["retryable"] != false {
				t.Fatalf("%s must not be retryable: %v", tc.code, f)
			}
			if _, has := f["retryAfterMs"]; has {
				t.Fatalf("%s carries a retryAfterMs: %v", tc.code, f)
			}
		}
	})
	t.Run("request refusals are not", func(t *testing.T) {
		r := newRig(t)
		cl := r.dial("a")
		cl.hello(0)
		for _, tc := range []struct {
			code string
			msg  wire.In
		}{
			{wire.CodeProtoState, wire.In{Op: "reticulate"}},
			{wire.CodeNoUID, wire.In{Op: "get", UID: 999}},
			{wire.CodeBadChunk, wire.In{Op: "fetch", Chunks: []string{"nope"}}},
			{wire.CodeBadName, wire.In{Op: "put", Mac: testMac}},
			{wire.CodeBadEntry, wire.In{Op: "putmany"}},
			{wire.CodeToolarge, wire.In{Op: "put", Path: "x", Mac: testMac,
				Meta: wire.PutMeta{Size: store.PerFileMax + 1}}},
		} {
			cl.sendJSON(tc.msg)
			f := rawFields(t, cl.recvRaw())
			if f["code"] != tc.code || f["retryable"] != false {
				t.Fatalf("wanted %s not retryable, got %v", tc.code, f)
			}
		}
	})
}

// The shutdown notice is the one error a client did not ask for: no id,
// retryable, and a hint for how soon to come back.
func TestI2TheShutdownNoticeIsRetryableWithAHint(t *testing.T) {
	r := newRig(t)
	cl := r.dial("idle")
	cl.hello(0)
	shutdownRig(t, r)
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeBusy {
		t.Fatalf("shutdown notice was %v", f)
	}
	if f["id"] != nil {
		t.Fatalf("an unsolicited error carries an id: %v", f)
	}
	if f["retryable"] != true {
		t.Fatalf("the shutdown notice is not retryable: %v", f)
	}
	if ms, _ := f["retryAfterMs"].(float64); ms <= 0 {
		t.Fatalf("the shutdown notice has no retryAfterMs: %v", f)
	}
}

/* ---------------------------------------------------------------- *
 * I3: caps in ready
 * ---------------------------------------------------------------- */

// ready carries every ceiling the session enforces, the protocol range the
// server speaks, and what it calls itself.
func TestI3ReadyAdvertisesTheCapsAndTheVersion(t *testing.T) {
	r := newRig(t)
	r.srv.SetVersion("9.8.7")
	ready, _ := r.dial("a").hello(0)
	if ready.MaxBatchBytes != wire.MaxBatchBytes || ready.MaxFetchBytes != wire.MaxFetchBytes {
		t.Fatalf("caps advertised %d and %d, enforced %d and %d",
			ready.MaxBatchBytes, ready.MaxFetchBytes, wire.MaxBatchBytes, wire.MaxFetchBytes)
	}
	if ready.MinProto != wire.MinProto || ready.Proto != wire.Proto {
		t.Fatalf("proto range advertised %d to %d, server speaks %d to %d",
			ready.MinProto, ready.Proto, wire.MinProto, wire.Proto)
	}
	if ready.ServerVersion != "9.8.7" {
		t.Fatalf("serverVersion = %q", ready.ServerVersion)
	}
	// And a lowered cap is what is advertised, so the two cannot drift.
	r2 := newRig(t)
	r2.srv.maxFetchBytes = 1234
	if ready, _ := r2.dial("a").hello(0); ready.MaxFetchBytes != 1234 {
		t.Fatalf("advertised %d, enforcing 1234", ready.MaxFetchBytes)
	}
}

/* ---------------------------------------------------------------- *
 * I5: the data key
 * ---------------------------------------------------------------- */

// The first device stores the wrapped data key with its claim, and every
// device that opens the vault afterwards is handed it in ready.
func TestI5ClaimStoresTheWrappedKeyAndReadyReturnsIt(t *testing.T) {
	r := newRigDerived(t)
	first := r.dial("first")
	first.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: testToken, Claim: longKey, Wrapped: testWrapped, Device: "first"})
	var ready wire.Ready
	first.recvInto("ready", &ready)
	if ready.Wrapped != testWrapped {
		t.Fatalf("the claiming device was handed wrapped %q", ready.Wrapped)
	}

	second := r.dial("second")
	second.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: longKey, Device: "second"})
	second.recvInto("ready", &ready)
	if ready.Wrapped != testWrapped {
		t.Fatalf("a later device was handed wrapped %q", ready.Wrapped)
	}
	stored, err := r.st.Wrapped(testVault)
	if err != nil || stored != testWrapped {
		t.Fatalf("stored wrapped = %q, %v", stored, err)
	}
}

// A vault claimed without a wrapped key, as a protocol 2 device does, has no
// `wrapped` in ready at all: absent, not empty, because that is how a client
// decides which key schedule applies.
func TestI5AVaultWithNoDataKeyHasNoWrappedInReady(t *testing.T) {
	r := newRigDerived(t)
	cl := r.dial("first")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: testToken, Claim: longKey, Device: "first"})
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "ready" {
		t.Fatalf("got %v", f)
	}
	if _, has := f["wrapped"]; has {
		t.Fatalf("ready carries a wrapped for a vault that has none: %v", f)
	}
}

// A malformed wrapped key is refused at claim, and the vault stays unclaimed,
// so the mistake lands on the one device that made it.
func TestI5AMalformedWrappedKeyIsRefusedAtClaim(t *testing.T) {
	r := newRigDerived(t)
	for _, bad := range []string{"not base64url!", strings.Repeat("A", store.MaxWrappedLen+1)} {
		cl := r.dial("first")
		cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
			Token: testToken, Claim: longKey, Wrapped: bad, Device: "first"})
		cl.expectErr(wire.CodeAuth)
	}
	if hash, _ := r.st.AuthHash(testVault); hash != "" {
		t.Fatal("the vault was claimed despite the refused key")
	}
}

// claimed sets up a vault with a data key and returns a client authenticated
// with the derived key, the way every device after the first connects.
func claimed(t *testing.T, r *rig, name string) *client {
	t.Helper()
	first := r.dial("claimer")
	first.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: testToken, Claim: longKey, Wrapped: testWrapped, Device: "claimer"})
	first.recvInto("ready", &wire.Ready{})
	first.recvInto("caught-up", &wire.CaughtUp{})
	first.conn.CloseNow()
	waitFor(t, "the claimer to leave", func() bool { return r.srv.Peers(testVault) == 0 })
	return derived(t, r, name, longKey)
}

// claimedNoKey is claimed for a vault with no data key, as a protocol 2 device
// claims one. It is the vault a protocol 2 client is still allowed on.
func claimedNoKey(t *testing.T, r *rig, name string) *client {
	t.Helper()
	first := r.dial("claimer")
	first.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: testToken, Claim: longKey, Device: "claimer"})
	first.recvInto("ready", &wire.Ready{})
	first.recvInto("caught-up", &wire.CaughtUp{})
	first.conn.CloseNow()
	waitFor(t, "the claimer to leave", func() bool { return r.srv.Peers(testVault) == 0 })
	return derived(t, r, name, longKey)
}

func derived(t *testing.T, r *rig, name, key string) *client {
	t.Helper()
	cl := r.dial(name)
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: key, Device: name})
	cl.recvInto("ready", &wire.Ready{})
	cl.recvInto("caught-up", &wire.CaughtUp{})
	return cl
}

const newKey = "a-freshly-derived-auth-key-after-rotation-1"
const newWrapped = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

// rotate swaps hash and blob together, closes every other session on the
// vault with an unsolicited auth error, and from then on only the new key
// opens the vault, with the new blob in ready. History is untouched.
func TestI5RotateReplacesTheSecretAndClosesOtherSessions(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	b := derived(t, r, "b", longKey)
	before := a.put("note.md", "kept across the rotation")

	a.sendJSON(wire.In{Op: "rotate", ID: 31, Auth: newKey, Wrapped: newWrapped})
	// b's echo of a's put arrives as a batch before anything else.
	b.nextBatch()
	f := rawFields(t, b.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeAuth || f["id"] != nil || f["retryable"] != false {
		t.Fatalf("the other session was told %v, want an unsolicited auth error", f)
	}
	if !b.closed() {
		t.Fatal("the other session stayed open under a retired credential")
	}
	if m := a.recv(); m["res"] != "rotated" || m["id"] != float64(31) {
		t.Fatalf("rotate was answered %v", m)
	}
	// The rotating session goes on working.
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})

	old := r.dial("old-string")
	old.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: longKey, Device: "old"})
	old.expectErr(wire.CodeAuth)

	fresh := r.dial("new-string")
	fresh.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: newKey, Device: "new"})
	var ready wire.Ready
	fresh.recvInto("ready", &ready)
	if ready.Wrapped != newWrapped {
		t.Fatalf("after rotation ready carries wrapped %q", ready.Wrapped)
	}
	if ready.Cursor != before {
		t.Fatalf("history was lost: cursor %d, the note was uid %d", ready.Cursor, before)
	}
}

// The refusals, each of which leaves the session usable because nothing was
// changed.
func TestI5RotateRefusals(t *testing.T) {
	t.Run("a session that authenticated with the bootstrap may not rotate", func(t *testing.T) {
		r := newRigDerived(t)
		cl := r.dial("first")
		cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
			Token: testToken, Claim: longKey, Wrapped: testWrapped, Device: "first"})
		cl.recvInto("ready", &wire.Ready{})
		cl.recvInto("caught-up", &wire.CaughtUp{})
		cl.sendJSON(wire.In{Op: "rotate", Auth: newKey, Wrapped: newWrapped})
		cl.expectErr(wire.CodeAuth)
		cl.sendJSON(wire.In{Op: "ping"})
		cl.recvInto("pong", &wire.Pong{})
		if w, _ := r.st.Wrapped(testVault); w != testWrapped {
			t.Fatalf("the refused rotate changed the stored key to %q", w)
		}
	})
	t.Run("a vault with no data key cannot be rotated in place", func(t *testing.T) {
		r := newRigDerived(t)
		first := r.dial("first")
		first.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
			Token: testToken, Claim: longKey, Device: "first"})
		first.recvInto("ready", &wire.Ready{})
		first.recvInto("caught-up", &wire.CaughtUp{})
		first.conn.CloseNow()
		waitFor(t, "the claimer to leave", func() bool { return r.srv.Peers(testVault) == 0 })
		cl := derived(t, r, "a", longKey)
		cl.sendJSON(wire.In{Op: "rotate", Auth: newKey, Wrapped: newWrapped})
		msg := cl.expectErr(wire.CodeBadEntry)
		if !strings.Contains(msg, "no data key") {
			t.Fatalf("the refusal does not say why: %q", msg)
		}
		if hash, _ := r.st.AuthHash(testVault); hash == "" {
			t.Fatal("the vault lost its hash")
		}
		cl.sendJSON(wire.In{Op: "ping"})
		cl.recvInto("pong", &wire.Pong{})
	})
	t.Run("a malformed request", func(t *testing.T) {
		r := newRigDerived(t)
		cl := claimed(t, r, "a")
		cl.sendJSON(wire.In{Op: "rotate", Auth: "short", Wrapped: newWrapped})
		cl.expectErr(wire.CodeBadEntry)
		cl.sendJSON(wire.In{Op: "rotate", Auth: newKey, Wrapped: "not base64url!"})
		cl.expectErr(wire.CodeBadEntry)
		cl.sendJSON(wire.In{Op: "rotate", Auth: newKey})
		cl.expectErr(wire.CodeBadEntry)
		if w, _ := r.st.Wrapped(testVault); w != testWrapped {
			t.Fatalf("a refused rotate changed the stored key to %q", w)
		}
		cl.sendJSON(wire.In{Op: "ping"})
		cl.recvInto("pong", &wire.Pong{})
	})
	t.Run("a protocol 2 session has no rotate", func(t *testing.T) {
		r := newRigDerived(t)
		claimedNoKey(t, r, "a").conn.CloseNow()
		cl := r.dialProto("old", 2)
		cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: longKey, Device: "old"})
		cl.recvInto("ready", &wire.Ready{})
		cl.recvInto("caught-up", &wire.CaughtUp{})
		cl.sendJSON(wire.In{Op: "rotate", Auth: newKey, Wrapped: newWrapped})
		cl.expectErr(wire.CodeProtoState)
		if w, _ := r.st.Wrapped(testVault); w != "" {
			t.Fatalf("a protocol 2 rotate stored a key: %q", w)
		}
	})
}

/* ---------------------------------------------------------------- *
 * I6, S24: field bounds
 * ---------------------------------------------------------------- */

// vault and device are bounded at 64 bytes and may not contain control
// characters, because both land in logs and file paths. Either fault is badname
// and ends the session at hello.
func TestS24VaultAndDeviceAreBoundedAndFreeOfControlCharacters(t *testing.T) {
	for _, tc := range []struct {
		why    string
		vault  string
		device string
	}{
		{"vault over 64", strings.Repeat("v", store.MaxVaultLen+1), "a"},
		{"vault with a newline", "v1\nlooks like another log line", "a"},
		{"device with a NUL", testVault, "phone\x00"},
		{"device with DEL", testVault, "phone\x7f"},
	} {
		t.Run(tc.why, func(t *testing.T) {
			r := newRig(t)
			cl := r.dial("a")
			cl.sendJSON(helloMsg(tc.vault, testToken, tc.device, 0))
			cl.expectErr(wire.CodeBadName)
			if !cl.closed() {
				t.Fatal("the session survived a name it must not log")
			}
		})
	}
	// Exactly at the bound is fine, in both fields.
	r := newRigWith(t, DefaultMaxPeers, func(*store.Store) Authenticator {
		return StaticTokens(map[string]string{strings.Repeat("v", store.MaxVaultLen): testToken})
	})
	cl := r.dial("a")
	cl.sendJSON(helloMsg(strings.Repeat("v", store.MaxVaultLen), testToken, strings.Repeat("d", store.MaxDeviceLen), 0))
	cl.recvInto("ready", &wire.Ready{})
}

/* ---------------------------------------------------------------- *
 * I9: the upgrade window
 * ---------------------------------------------------------------- */

// A protocol 2 client against this server gets exactly the protocol 2 session
// it always had, end to end: no ids, no bodies header, no retryable, no
// wrapped, no rotate. ready still carries the new ceilings, which it ignores.
// The harness fails the test on any id or retryable it sees in this mode.
func TestI9AProto2ClientGetsAProto2SessionEndToEnd(t *testing.T) {
	r := newRigDerived(t)
	claimedNoKey(t, r, "setup").conn.CloseNow()
	waitFor(t, "the setup client to leave", func() bool { return r.srv.Peers(testVault) == 0 })

	cl := r.dialProto("old-phone", 2)
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: longKey, Device: "old-phone"})
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "ready" || f["proto"] != float64(2) {
		t.Fatalf("ready was %v", f)
	}
	for _, absent := range []string{"id", "wrapped"} {
		if _, has := f[absent]; has {
			t.Fatalf("a protocol 2 ready carries %s: %v", absent, f)
		}
	}
	for _, present := range []string{"maxBatchBytes", "maxFetchBytes", "minProto", "serverVersion"} {
		if _, has := f[present]; !has {
			t.Fatalf("a protocol 2 ready lacks %s: %v", present, f)
		}
	}
	cl.recvInto("caught-up", &wire.CaughtUp{})

	uid := cl.put("note.md", "head", "tail")
	cl.sendJSON(wire.In{Op: "get", UID: uid})
	var got wire.Chunks
	cl.recvInto("chunks", &got)
	// No header: the first frame after a fetch is a body.
	bodies := cl.fetch(got.Chunks...)
	if string(bodies[0]) != "head" || string(bodies[1]) != "tail" {
		t.Fatalf("fetched %q", bodies)
	}
	cl.sendJSON(wire.In{Op: "history", Path: "note.md"})
	cl.recvInto("history", &wire.History{})
	cl.sendJSON(wire.In{Op: "deleted"})
	cl.recvInto("deleted", &wire.Deleted{})
	cl.sendJSON(wire.In{Op: "get", UID: 999})
	f = rawFields(t, cl.recvRaw())
	if f["code"] != wire.CodeNoUID {
		t.Fatalf("got %v", f)
	}
	if _, has := f["retryable"]; has {
		t.Fatalf("a protocol 2 error carries retryable: %v", f)
	}
	// An id sent by a protocol 2 client is not echoed: the shape is fixed.
	cl.sendRaw(wire.In{Op: "deleted", ID: 5})
	if f := rawFields(t, cl.recvRaw()); f["res"] != "deleted" || f["id"] != nil {
		t.Fatalf("a protocol 2 reply echoed an id: %v", f)
	}
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

// A protocol 3 client against the same server, in the same test, so the two
// shapes are visibly two answers from one server.
func TestI9AProto3ClientGetsIdsAgainstTheSameServer(t *testing.T) {
	r := newRigDerived(t)
	claimedNoKey(t, r, "setup").conn.CloseNow()
	waitFor(t, "the setup client to leave", func() bool { return r.srv.Peers(testVault) == 0 })

	old := r.dialProto("old", 2)
	old.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: longKey, Device: "old"})
	old.recvInto("ready", &wire.Ready{})
	old.recvInto("caught-up", &wire.CaughtUp{})

	cur := derived(t, r, "new", longKey)
	// Both push; both see the other's change; the harness checks ids on every
	// reply for the new one and their absence for the old one.
	a := old.put("a.md", "from the old client")
	b := cur.put("b.md", "from the new client")
	if got := cur.nextBatch(); got.From != a || len(got.Entries) != 1 {
		t.Fatalf("the new client saw %+v for the old client's write", got)
	}
	// The old client sees its own write as an empty range first, then the
	// new client's with the payload.
	if echo := old.nextBatch(); echo.To != a || len(echo.Entries) != 0 {
		t.Fatalf("the old client's echo was %+v", echo)
	}
	if got := old.nextBatch(); got.To != b || len(got.Entries) != 1 {
		t.Fatalf("the old client saw %+v for the new client's write", got)
	}
}

// A vault claimed under protocol 3 has a data key, and a protocol 2 client on
// it would seal under the root-derived schedule that nothing else on the vault
// can read. It is refused with proto, naming what the vault needs and the
// server's version, after auth and before ready. Protocol 2 stays accepted on
// a vault with no data key, and protocol 3 proceeds on this one.
func TestI9AProto2HelloOnAProto3VaultIsRefused(t *testing.T) {
	r := newRigDerived(t)
	r.srv.SetVersion("4.5.6")
	claimed(t, r, "setup").conn.CloseNow()
	waitFor(t, "the setup client to leave", func() bool { return r.srv.Peers(testVault) == 0 })

	old := r.dialProto("old-phone", 2)
	old.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: longKey, Device: "old-phone"})
	msg := old.expectErr(wire.CodeProto)
	if !strings.Contains(msg, "protocol 3") || !strings.Contains(msg, "4.5.6") {
		t.Fatalf("the refusal names neither the protocol the vault needs nor the server version: %q", msg)
	}
	if !old.closed() {
		t.Fatal("the protocol 2 session was refused and left open")
	}
	// Wrong key first, so the refusal cannot be used to probe the vault: a bad
	// credential is auth, not proto.
	probe := r.dialProto("probe", 2)
	probe.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: "guess", Device: "probe"})
	probe.expectErr(wire.CodeAuth)

	cur := derived(t, r, "new-phone", longKey)
	cur.sendJSON(wire.In{Op: "ping"})
	cur.recvInto("pong", &wire.Pong{})
}
