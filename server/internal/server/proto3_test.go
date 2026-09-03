package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// The protocol, server side. docs/protocol.md is the contract; every test here
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

// A request with no id, or one out of range, cannot be answered in a
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

// A fetch is answered by a `bodies` header saying exactly how many
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

// A body that rotted on disk is found before the header, not halfway through
// the stream.
//
// Presence was checked with a stat, which a rotted body passes, and each body
// was verified as it was read. So the third of five going bad meant a header
// promising five, two bodies, and then a fatal refusal: a client that had
// pre-allocated five is left waiting for frames that are not coming, and the
// count in the header was a promise the server had already broken. Every body
// is read and checked before the header now, so this is a refusal the session
// survives and the client can act on.
func TestI1AFetchWithARottedBodyIsRefusedBeforeTheHeader(t *testing.T) {
	r := newRig(t)
	e := r.seed("note.md", "one", "two", "three")
	cl := r.dial("a")
	cl.hello(0)

	// The middle body rots. It still stats, so nothing short of reading it
	// notices.
	p, err := r.st.Chunks().Path(testVault, e.Chunks[1])
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if err := os.WriteFile(p, []byte("bytes this name does not describe"), 0o600); err != nil {
		t.Fatalf("rot the body: %v", err)
	}

	cl.sendJSON(wire.In{Op: "fetch", ID: 9, Chunks: e.Chunks})
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeNoChunk || f["id"] != float64(9) {
		t.Fatalf("a fetch over a rotted body was answered %v, want an error and no bodies", f)
	}

	// The session survives it, so the client can ask for what it can still have.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})

	// And the bad body is set aside, so the next put asks for it again.
	if r.st.Chunks().Has(testVault, e.Chunks[1]) {
		t.Fatal("the rotted body is still present under its name, so no device will ever be asked for it")
	}
	got := cl.fetch(e.Chunks[0], e.Chunks[2])
	if string(got[0]) != "one" || string(got[1]) != "three" {
		t.Fatalf("the chunks that are still good fetched as %q and %q", got[0], got[1])
	}
}

/* ---------------------------------------------------------------- *
 * I2: retryable
 * ---------------------------------------------------------------- */

// Every error says whether reconnecting later can help, per the
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

// A claim with no wrapped key is refused, and the vault stays unclaimed. This
// is the rule the removal of the second key schedule rests on: a vault that
// might or might not have a data key let a server pick which schedule a client
// used, by leaving `wrapped` out of `ready`, with nothing on the client able
// to tell that from a vault that genuinely had none.
func TestI5AClaimWithoutADataKeyIsRefused(t *testing.T) {
	r := newRigDerived(t)
	cl := r.dial("first")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: testToken, Claim: longKey, Device: "first"})
	msg := cl.expectErr(wire.CodeBadEntry)
	if !strings.Contains(msg, "data key") {
		t.Fatalf("the refusal does not say why: %q", msg)
	}
	if !cl.closed() {
		t.Fatal("a hello refused at the claim left the session open")
	}
	if hash, _ := r.st.AuthHash(testVault); hash != "" {
		t.Fatal("the vault was claimed without a data key")
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
		cl.expectErr(wire.CodeBadEntry)
		if !cl.closed() {
			t.Fatalf("a hello offering %q left the session open", bad)
		}
	}
	if hash, _ := r.st.AuthHash(testVault); hash != "" {
		t.Fatal("the vault was claimed despite the refused key")
	}
}

// Every claimed vault has a data key, so ready always carries it: to the device
// that claimed the vault, to every device after it, and after a rotation. A
// client never has to decide which key schedule it is on, because there is one.
//
// The vault is driven through its whole life here, starting with the attempt
// that used to produce a keyless vault, because that attempt succeeding is the
// only way a later ready could arrive without a wrapped key.
func TestI5ReadyAlwaysCarriesWrappedForAClaimedVault(t *testing.T) {
	r := newRigDerived(t)
	keyless := r.dial("keyless")
	keyless.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: testToken, Claim: longKey, Device: "keyless"})
	if f := rawFields(t, keyless.recvRaw()); f["res"] != "err" {
		t.Fatalf("a claim with no data key was answered %v", f)
	}

	first := r.dial("first")
	first.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: testToken, Claim: longKey, Wrapped: testWrapped, Device: "first"})
	if f := rawFields(t, first.recvRaw()); f["res"] != "ready" || f["wrapped"] != testWrapped {
		t.Fatalf("the claiming device's ready was %v", f)
	}
	first.recvInto("caught-up", &wire.CaughtUp{})

	// A second device, which sends its claim on every hello and is ignored.
	second := r.dial("second")
	second.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: longKey, Claim: longKey, Wrapped: testWrapped, Device: "second"})
	if f := rawFields(t, second.recvRaw()); f["res"] != "ready" || f["wrapped"] != testWrapped {
		t.Fatalf("a later device's ready was %v", f)
	}
	second.recvInto("caught-up", &wire.CaughtUp{})

	second.sendJSON(wire.In{Op: "rotate", Auth: newKey, Wrapped: newWrapped})
	second.recvInto("rotated", &wire.Rotated{})
	after := r.dial("after")
	after.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: newKey, Device: "after"})
	if f := rawFields(t, after.recvRaw()); f["res"] != "ready" || f["wrapped"] != newWrapped {
		t.Fatalf("ready after a rotation was %v", f)
	}
}

// A vault claimed with no data key cannot be produced by this build, but a data
// directory an older one wrote can hold the row. There is no key schedule left
// to serve it under, so the session is refused at hello with something an
// operator can act on, rather than falling into a schedule that no longer
// exists. The row is built straight through the store, which is the only thing
// that can still make one.
func TestI5AVaultClaimedWithNoDataKeyIsRefusedAtHello(t *testing.T) {
	r := newRigDerived(t)
	r.srv.SetVersion("4.5.6")
	hash := sha256.Sum256([]byte(longKey))
	ok, err := r.st.ClaimVault(testVault, hex.EncodeToString(hash[:]), "", 1)
	if err != nil || !ok {
		t.Fatalf("seeding a vault with no data key: ok=%v err=%v", ok, err)
	}
	cl := r.dial("a")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: longKey, Device: "a"})
	msg := cl.expectErr(wire.CodeProto)
	if !strings.Contains(msg, "data key") || !strings.Contains(msg, "fresh data directory") {
		t.Fatalf("the refusal does not tell the operator what to do: %q", msg)
	}
	if !cl.closed() {
		t.Fatal("the session was refused and left open")
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

// The peers a rotation retires are evicted at the same time, not one after
// another.
//
// Each eviction gives its peer up to a second to read the notice before the
// connection is closed, and they ran in series, before the rotating device was
// told anything. Seven other devices meant about seven seconds of silence on a
// request that had already committed. The device limit is eight, so that is a
// real vault, not a contrived one.
func TestI5RotateEvictsEveryPeerAtOnce(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	peers := []*client{
		derived(t, r, "b", longKey),
		derived(t, r, "c", longKey),
		derived(t, r, "d", longKey),
	}

	// Each eviction reports in and waits for the others. In series the first
	// one waits for peers that have not started, so nothing but the timeout
	// gets past this.
	arrived := make(chan struct{}, len(peers))
	together := make(chan struct{})
	var once sync.Once
	r.srv.beforeEvict = func() {
		arrived <- struct{}{}
		if len(arrived) == len(peers) {
			once.Do(func() { close(together) })
		}
		select {
		case <-together:
		case <-time.After(3 * time.Second):
		}
	}

	start := time.Now()
	a.sendJSON(wire.In{Op: "rotate", ID: 41, Auth: newKey, Wrapped: newWrapped})
	if m := a.recv(); m["res"] != "rotated" || m["id"] != float64(41) {
		t.Fatalf("rotate was answered %v", m)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("the rotate took %s: the evictions did not overlap", took.Round(time.Millisecond))
	}
	if n := len(arrived); n != len(peers) {
		t.Fatalf("%d of %d peers were evicted", n, len(peers))
	}
	for _, p := range peers {
		if !p.closed() {
			t.Fatal("a peer stayed open under a retired credential")
		}
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
 * I9: version negotiation
 * ---------------------------------------------------------------- */

// Protocol 3 is the only protocol. A client asking for 2 is refused at hello
// with both numbers and the server's version in the message, which is the
// whole of what the negotiation machinery is kept for: when protocol 4 lands,
// this is how an old client learns which end to upgrade.
func TestI9AProto2HelloIsRefusedNamingBothNumbers(t *testing.T) {
	r := newRig(t)
	r.srv.SetVersion("4.5.6")
	cl := r.dial("old-phone")
	cl.sendRaw(wire.In{Op: "hello", ID: 1, Proto: 2, Crypto: wire.Crypto,
		Vault: testVault, Token: testToken, Device: "old-phone"})
	msg := cl.expectErr(wire.CodeProto)
	for _, want := range []string{"protocol 2", "4.5.6", "3 to 3"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("the refusal does not name %q: %q", want, msg)
		}
	}
	if !cl.closed() {
		t.Fatal("a client on an unsupported protocol was refused and left open")
	}
}

// Two devices against one server: each sees the other's write with its payload
// and its own as an empty range, and the harness checks the id on every reply
// either of them gets.
func TestI9TwoClientsAgainstTheSameServer(t *testing.T) {
	r := newRigDerived(t)
	claimed(t, r, "setup").conn.CloseNow()
	waitFor(t, "the setup client to leave", func() bool { return r.srv.Peers(testVault) == 0 })

	one := derived(t, r, "one", longKey)
	two := derived(t, r, "two", longKey)
	a := one.put("a.md", "from one")
	b := two.put("b.md", "from two")
	if got := two.nextBatch(); got.From != a || len(got.Entries) != 1 {
		t.Fatalf("two saw %+v for one's write", got)
	}
	// one sees its own write as an empty range first, then two's with the
	// payload: a device never has to recognise its own echo.
	if echo := one.nextBatch(); echo.To != a || len(echo.Entries) != 0 {
		t.Fatalf("one's echo of its own write was %+v", echo)
	}
	if got := one.nextBatch(); got.To != b || len(got.Entries) != 1 {
		t.Fatalf("one saw %+v for two's write", got)
	}
}

/* ---------------------------------------------------------------- *
 * Rotation is a compare-and-swap, and it has a generation
 * ---------------------------------------------------------------- */

// hashOf is the hex sha256 the server stores for an auth key.
func hashOf(key string) string {
	h := sha256.Sum256([]byte(key))
	return hex.EncodeToString(h[:])
}

const thirdKey = "a-third-derived-auth-key-after-rotation-12"
const thirdWrapped = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"

// A rotate from a session whose credential is no longer the vault's is refused
// with `rotated`, and changes nothing.
//
// The rotation here is done straight through the store, which is the same thing
// another device's rotate does to this session's view of the world without the
// eviction that would close the socket first. Before the compare-and-swap this
// session's rotate simply overwrote what the other device had just written, and
// the retired credential owned the vault.
func TestRotateIsRefusedWhenAnotherDeviceRotatedFirst(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")

	if err := r.st.Rotate(testVault, hashOf(longKey), hashOf(newKey), newWrapped); err != nil {
		t.Fatalf("the other device's rotation: %v", err)
	}

	a.sendJSON(wire.In{Op: "rotate", ID: 7, Auth: thirdKey, Wrapped: thirdWrapped})
	m := a.recv()
	if m["res"] != "err" || m["code"] != wire.CodeRotated || m["id"] != float64(7) {
		t.Fatalf("the losing rotate was answered %v, want a rotated error carrying its id", m)
	}
	msg, _ := m["msg"].(string)
	if !strings.Contains(msg, "rotated by another device") || !strings.Contains(msg, "reconnect") {
		t.Fatalf("the refusal does not say what happened or what to do: %q", msg)
	}
	if m["retryable"] != false {
		t.Fatalf("rotated is not retryable, got %v", m["retryable"])
	}
	if hash, _ := r.st.AuthHash(testVault); hash != hashOf(newKey) {
		t.Fatal("the refused rotate replaced the credential of the device that won")
	}
	if w, _ := r.st.Wrapped(testVault); w != newWrapped {
		t.Fatalf("the refused rotate replaced the wrapped key with %q", w)
	}
	if !a.closed() {
		t.Fatal("a session holding a credential the vault no longer knows was left open")
	}
}

// Two sessions on one vault both rotate, with the first parked inside the store
// call while the second commits underneath it. Exactly one wins.
//
// This is the sequence the review described: the winner evicts the loser, but
// closing a socket does not cancel the handler or the database call already in
// flight, so the loser's write still lands. It landed unconditionally before,
// and the vault ended up belonging to whichever call finished last.
func TestTwoConcurrentRotationsAndOnlyOneWins(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	b := derived(t, r, "b", longKey)

	// a's rotate stops here until b's has committed and evicted it.
	// A one-shot gate rather than a sync.Once: Once serialises its callers, so
	// b's rotate would have waited on a's rather than racing it.
	parked := make(chan struct{})
	release := make(chan struct{})
	first := make(chan struct{}, 1)
	first <- struct{}{}
	r.srv.beforeRotate = func() {
		select {
		case <-first:
			close(parked)
			<-release
		default:
		}
	}
	a.sendJSON(wire.In{Op: "rotate", Auth: newKey, Wrapped: newWrapped})
	<-parked

	// b rotates while a is parked. b's own beforeRotate is the same hook and
	// has already fired once, so it runs straight through.
	b.sendJSON(wire.In{Op: "rotate", Auth: thirdKey, Wrapped: thirdWrapped})
	b.recvInto("rotated", &wire.Rotated{})
	close(release)

	// a is evicted, so its refusal has nowhere to go; what has to hold is the
	// row. Both columns are b's, and the generation moved exactly once.
	// The evicted session leaves the hub only after its handler has unwound,
	// so one peer left means a's rotate has already had its turn at the store.
	// The second condition is what keeps this from being a ten second timeout
	// when the swap is not conditional: a's write lands, and the assertions
	// below get to say so.
	waitFor(t, "the losing rotation to finish", func() bool {
		hash, _ := r.st.AuthHash(testVault)
		return r.srv.Peers(testVault) == 1 || hash != hashOf(thirdKey)
	})
	if hash, _ := r.st.AuthHash(testVault); hash != hashOf(thirdKey) {
		t.Fatal("the evicted device's rotation overwrote the one that won")
	}
	if w, _ := r.st.Wrapped(testVault); w != thirdWrapped {
		t.Fatalf("the vault's wrapped key is %q, not the winner's", w)
	}
	if n, _ := r.st.Rotations(testVault); n != 1 {
		t.Fatalf("the generation moved %d times for one rotation", n)
	}
	// And the old string opens nothing, which is the point of rotating at all.
	old := r.dial("old")
	old.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: longKey, Device: "old"})
	old.expectErr(wire.CodeAuth)
}

// A hello that passes auth under the old root and pauses before joining is
// refused, not served.
//
// The eviction a rotation performs is a snapshot of the hub, and this session
// is in no snapshot: it joins afterwards. Without the generation it was handed
// the old wrapping and went on reading and writing valid entries under a
// credential the vault no longer knew, because the data key had not changed.
func TestAStaleHelloThatJoinsAfterARotationIsRefused(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	_ = a

	var once sync.Once
	r.srv.beforeJoin = func() {
		once.Do(func() {
			if err := r.st.Rotate(testVault, hashOf(longKey), hashOf(newKey), newWrapped); err != nil {
				t.Errorf("rotating between auth and join: %v", err)
			}
		})
	}

	stale := r.dial("stale")
	stale.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: longKey, Device: "stale"})
	msg := stale.expectErr(wire.CodeAuth)
	if !strings.Contains(msg, "rotated") {
		t.Fatalf("the refusal does not say why: %q", msg)
	}
	if !stale.closed() {
		t.Fatal("a session that joined after the rotation was left open")
	}
	if r.srv.Peers(testVault) > 1 {
		t.Fatalf("%d peers, so the refused session is still in the fan-out", r.srv.Peers(testVault))
	}
}
