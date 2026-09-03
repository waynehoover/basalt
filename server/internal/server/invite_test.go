package server

import (
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// I23: single-use invites. docs/protocol.md, "Adding a device with a single-use
// invite". The server holds an unguessable identifier and a blob it cannot open,
// for a few minutes, and hands the blob over exactly once.

const (
	testInvite = "AAAAAAAAAAAAAAAAAAAAAA"
	testSealed = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
)

// redeem connects with an invite in place of a token and returns the raw reply.
func redeem(t *testing.T, r *rig, invite string) map[string]any {
	t.Helper()
	cl := r.dial("newcomer")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Invite: invite, Device: "newcomer"})
	f := rawFields(t, cl.recvRaw())
	if !cl.closed() {
		t.Fatalf("the session stayed open after %v; a redeem always closes", f)
	}
	return f
}

func TestI23AnInviteIsRedeemedExactlyOnce(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")

	a.sendJSON(wire.In{Op: "invite", ID: 21, Invite: testInvite, Sealed: testSealed, TTLMs: 60_000})
	m := a.recv()
	if m["res"] != "invited" || m["id"] != float64(21) {
		t.Fatalf("invite was answered %v", m)
	}
	want := r.srv.now().Add(time.Minute).UnixMilli()
	if got := int64(m["expiresAt"].(float64)); got < want-2000 || got > want+2000 {
		t.Fatalf("expiresAt %d, wanted about %d", got, want)
	}

	f := redeem(t, r, testInvite)
	if f["res"] != "redeemed" || f["sealed"] != testSealed || f["wrapped"] != testWrapped {
		t.Fatalf("redeem was answered %v", f)
	}
	if f["id"] == nil {
		t.Fatalf("redeemed carries no id: %v", f)
	}

	// Once. The second try, an unknown one, and a malformed one all get the
	// same answer, so a guesser learns nothing.
	answers := map[string]bool{}
	for _, inv := range []string{testInvite, "BBBBBBBBBBBBBBBBBBBBBB", "not base64!"} {
		f := redeem(t, r, inv)
		if f["res"] != "err" || f["code"] != wire.CodeAuth {
			t.Fatalf("redeeming %q was answered %v, want auth", inv, f)
		}
		answers[f["msg"].(string)] = true
	}
	if len(answers) != 1 {
		t.Fatalf("the refusals are distinguishable: %v", answers)
	}
	// The issuing session is untouched.
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})
}

func TestI23AnExpiredInviteIsRefused(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	base := time.Now()
	r.srv.now = func() time.Time { return base }
	a.sendJSON(wire.In{Op: "invite", Invite: testInvite, Sealed: testSealed, TTLMs: 1000})
	a.recvInto("invited", &wire.Invited{})

	r.srv.now = func() time.Time { return base.Add(2 * time.Second) }
	if f := redeem(t, r, testInvite); f["code"] != wire.CodeAuth {
		t.Fatalf("an expired invite was answered %v", f)
	}
}

func TestI23TheTTLDefaultsAndIsCapped(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	base := time.Now()
	r.srv.now = func() time.Time { return base }

	a.sendJSON(wire.In{Op: "invite", Invite: "AAAAAAAAAAAAAAAAAAAAAA", Sealed: testSealed})
	var inv wire.Invited
	a.recvInto("invited", &inv)
	if inv.ExpiresAt != base.Add(DefaultInviteTTL).UnixMilli() {
		t.Fatalf("no ttl gave expiry %d, want %d", inv.ExpiresAt, base.Add(DefaultInviteTTL).UnixMilli())
	}
	a.sendJSON(wire.In{Op: "invite", Invite: "BBBBBBBBBBBBBBBBBBBBBB", Sealed: testSealed, TTLMs: (5 * time.Hour).Milliseconds()})
	a.recvInto("invited", &inv)
	if inv.ExpiresAt != base.Add(MaxInviteTTL).UnixMilli() {
		t.Fatalf("a five hour ttl gave expiry %d, want the cap %d", inv.ExpiresAt, base.Add(MaxInviteTTL).UnixMilli())
	}
	a.sendJSON(wire.In{Op: "invite", Invite: "DDDDDDDDDDDDDDDDDDDDDD", Sealed: testSealed, TTLMs: -1})
	a.expectErr(wire.CodeBadEntry)
}

func TestI23InviteRefusals(t *testing.T) {
	t.Run("a bootstrap session may not issue invites", func(t *testing.T) {
		r := newRigDerived(t)
		cl := r.dial("first")
		cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
			Token: testToken, Claim: longKey, Wrapped: testWrapped, Device: "first"})
		cl.recvInto("ready", &wire.Ready{})
		cl.recvInto("caught-up", &wire.CaughtUp{})
		cl.sendJSON(wire.In{Op: "invite", Invite: testInvite, Sealed: testSealed})
		cl.expectErr(wire.CodeAuth)
		if n, _ := r.st.OutstandingInvites(testVault, 0); n != 0 {
			t.Fatalf("%d invites stored by a refused request", n)
		}
		cl.sendJSON(wire.In{Op: "ping"})
		cl.recvInto("pong", &wire.Pong{})
	})
	t.Run("malformed requests", func(t *testing.T) {
		r := newRigDerived(t)
		a := claimed(t, r, "a")
		a.sendJSON(wire.In{Op: "invite", Invite: "not base64!", Sealed: testSealed})
		a.expectErr(wire.CodeBadEntry)
		a.sendJSON(wire.In{Op: "invite", Invite: testInvite, Sealed: strings.Repeat("A", store.MaxSealedLen+1)})
		a.expectErr(wire.CodeBadEntry)
		a.sendJSON(wire.In{Op: "invite", Invite: testInvite})
		a.expectErr(wire.CodeBadEntry)
		a.sendJSON(wire.In{Op: "ping"})
		a.recvInto("pong", &wire.Pong{})
	})
	t.Run("a protocol 2 session has no invite", func(t *testing.T) {
		r := newRigDerived(t)
		claimedNoKey(t, r, "a").conn.CloseNow()
		cl := r.dialProto("old", 2)
		cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Token: longKey, Device: "old"})
		cl.recvInto("ready", &wire.Ready{})
		cl.recvInto("caught-up", &wire.CaughtUp{})
		cl.sendJSON(wire.In{Op: "invite", Invite: testInvite, Sealed: testSealed})
		cl.expectErr(wire.CodeProtoState)
		// And a protocol 2 hello carrying an invite is an ordinary auth failure.
		old := r.dialProto("old2", 2)
		old.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Invite: testInvite, Device: "old2"})
		old.expectErr(wire.CodeAuth)
	})
	t.Run("an unclaimed vault has nothing to redeem", func(t *testing.T) {
		r := newRigDerived(t)
		if f := redeem(t, r, testInvite); f["code"] != wire.CodeAuth {
			t.Fatalf("got %v", f)
		}
	})
}

// rotate retires the root every outstanding invite seals, so it deletes them.
func TestI23RotateDeletesOutstandingInvites(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	a.sendJSON(wire.In{Op: "invite", Invite: testInvite, Sealed: testSealed})
	a.recvInto("invited", &wire.Invited{})
	if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
		t.Fatalf("%d invites before the rotate", n)
	}
	a.sendJSON(wire.In{Op: "rotate", Auth: newKey, Wrapped: newWrapped})
	a.recvInto("rotated", &wire.Rotated{})
	if n, _ := r.st.InviteRows(testVault); n != 0 {
		t.Fatalf("%d invite rows survived the rotate", n)
	}
	if f := redeem(t, r, testInvite); f["code"] != wire.CodeAuth {
		t.Fatalf("an invite sealing the retired root was answered %v", f)
	}
}
