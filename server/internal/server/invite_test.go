package server

import (
	"fmt"
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
//
// The hello names the device it is registering, because since protocol 4 that
// is what redeeming an invite does: the device that issued this invite holds
// no root and could not have registered a row for the newcomer, so the
// redemption is where the row comes from. The id and key belong to the name,
// so two redeems under two names are two devices and two under one name are
// the same device twice, which is the difference several tests below turn on.
func redeem(t *testing.T, r *rig, invite, name string) map[string]any {
	t.Helper()
	return redeemWith(t, r, invite, deviceID(name), deviceKey(name))
}

// redeemWith is redeem with the registration fields spelled out, for the tests
// that are about those fields rather than about the invite.
func redeemWith(t *testing.T, r *rig, invite, id, key string) map[string]any {
	t.Helper()
	cl := r.dial("newcomer")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault, Invite: invite,
		DeviceID: id, Auth: key, Device: "newcomer"})
	f := rawFields(t, cl.recvRaw())
	if !cl.closed() {
		t.Fatalf("the session stayed open after %v; a redeem always closes", f)
	}
	return f
}

// issue puts one invite on the vault from a device session.
func issue(t *testing.T, a *client, invite string) {
	t.Helper()
	a.sendJSON(wire.In{Op: "invite", Invite: invite, Sealed: testSealed})
	a.recvInto("invited", &wire.Invited{})
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

	f := redeem(t, r, testInvite, "newcomer")
	if f["res"] != "redeemed" || f["sealed"] != testSealed {
		t.Fatalf("redeem was answered %v", f)
	}
	if f["deviceId"] != deviceID("newcomer") {
		t.Fatalf("redeemed names device %v, not the one it registered", f["deviceId"])
	}
	// No wrapped data key, and there must not be one: the wrapping opens under
	// the root and a redeeming device holds none. What it opens is `sealed`,
	// under the invite key, which never reached the server.
	if _, there := f["wrapped"]; there {
		t.Fatalf("redeemed carries a wrapped data key the redeemer cannot open: %v", f)
	}
	if f["id"] == nil {
		t.Fatalf("redeemed carries no id: %v", f)
	}

	// Once. The second try, an unknown one, and a malformed one all get the
	// same answer, so a guesser learns nothing.
	answers := map[string]bool{}
	for _, inv := range []string{testInvite, "BBBBBBBBBBBBBBBBBBBBBB", "not base64!"} {
		f := redeem(t, r, inv, "latecomer")
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
	if f := redeem(t, r, testInvite, "newcomer"); f["code"] != wire.CodeAuth {
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
	t.Run("a session holding the vault credential may not issue invites", func(t *testing.T) {
		// An invite is issued by a device that already has the vault. A
		// bootstrap hello never proved it held the root it would be sealing,
		// and since protocol 4 it does not even produce a session that could:
		// the vault credential opens a registrar, and a registrar syncs
		// nothing and issues nothing.
		r := newRigDerived(t)
		cl := r.dial("first")
		cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
			Token: testToken, Claim: longKey, Wrapped: testWrapped, Device: "first"})
		cl.recvInto("registrar", &wire.Registrar{})
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
	t.Run("an unclaimed vault has nothing to redeem", func(t *testing.T) {
		r := newRigDerived(t)
		if f := redeem(t, r, testInvite, "newcomer"); f["code"] != wire.CodeAuth {
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
	// From a registrar session, which is the only kind that may rotate: the
	// invite the device issued seals the root, and the root is what is being
	// retired.
	reg := registrarWith(t, r, "recovery-key", longKey)
	reg.sendJSON(wire.In{Op: "rotate", Auth: newKey, Wrapped: newWrapped})
	reg.recvInto("rotated", &wire.Rotated{})
	if n, _ := r.st.InviteRows(testVault); n != 0 {
		t.Fatalf("%d invite rows survived the rotate", n)
	}
	if f := redeem(t, r, testInvite, "newcomer"); f["code"] != wire.CodeAuth {
		t.Fatalf("an invite sealing the retired root was answered %v", f)
	}
}

// The same invite identifier twice is refused as a bad request, and the session
// carries on.
//
// AddInvite was a bare insert, so the second one met the primary key and came
// back as `internal`. `internal` is retryable, and retrying an invite under the
// identifier it was issued under is exactly what a device does when the reply
// goes missing, so the pair of them made a loop that could not end. It is the
// request that is wrong, and `badentry` says so once.
func TestI23AnInviteIdentifierIsRefusedTheSecondTime(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")

	a.sendJSON(wire.In{Op: "invite", ID: 1, Invite: testInvite, Sealed: testSealed})
	a.recvInto("invited", &wire.Invited{})

	a.sendJSON(wire.In{Op: "invite", ID: 2, Invite: testInvite, Sealed: testSealed})
	f := rawFields(t, a.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeBadEntry {
		t.Fatalf("a repeated invite identifier was answered %v, want badentry", f)
	}
	if f["retryable"] != false {
		t.Fatalf("the refusal is retryable, so a client retrying the same identifier never stops: %v", f)
	}
	if f["id"] != float64(2) {
		t.Fatalf("the refusal answers request %v, not the one that was made", f["id"])
	}

	// One invite, and it is the one that was issued first: the refusal changed
	// nothing.
	if n, _ := r.st.InviteRows(testVault); n != 1 {
		t.Fatalf("%d invite rows, want 1", n)
	}
	if fr := redeem(t, r, testInvite, "newcomer"); fr["res"] != "redeemed" || fr["sealed"] != testSealed {
		t.Fatalf("the invite that was stored first is not the one redeemed: %v", fr)
	}
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})
}

// A hello carrying both a token and an invite is refused.
//
// The authenticator treats an invite as standing in for the token, and it
// triggers on the invite alone, so the session used to hand it only the token:
// authenticated as an ordinary device with the invite neither redeemed nor
// refused. The invite stayed live and the person holding the string was told
// nothing, which is the quiet half of a pairing that never happens.
func TestI23AHelloWithBothATokenAndAnInviteIsRefused(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	a.sendJSON(wire.In{Op: "invite", Invite: testInvite, Sealed: testSealed})
	a.recvInto("invited", &wire.Invited{})

	cl := r.dial("confused")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: longKey, Invite: testInvite, Device: "confused"})
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeBadEntry {
		t.Fatalf("a hello with both was answered %v, want badentry", f)
	}
	if msg, _ := f["msg"].(string); !strings.Contains(msg, "both") {
		t.Fatalf("the refusal does not say what was wrong with it: %q", msg)
	}
	if !cl.closed() {
		t.Fatal("the session survived a hello that was refused")
	}

	// And the invite is untouched: neither redeemed nor burned by the refusal.
	if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
		t.Fatalf("%d outstanding invites after the refusal, want the one that was issued", n)
	}
	if fr := redeem(t, r, testInvite, "newcomer"); fr["res"] != "redeemed" {
		t.Fatalf("the invite no longer redeems: %v", fr)
	}
}

/* ---------------------------------------------------------------- *
 * Redeeming an invite is how a device is registered
 * ---------------------------------------------------------------- */

// The whole of what an invite buys, end to end: a device that has the vault
// issues one, the newcomer redeems it, and what the newcomer holds afterwards
// is a row of its own and the vault's data key.
//
// This is the shape per-device credentials made necessary. Before protocol 4
// an invite handed over the root, and the newcomer registered itself; a device
// holds no root now, so if redeeming did not register the row nothing would,
// and adding a device would mean typing the recovery key into it. The recovery
// key is for the day every device is gone.
func TestARedeemedInviteRegistersTheDeviceThatRedeemedIt(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	issue(t, a, testInvite)

	f := redeem(t, r, testInvite, "phone")
	if f["res"] != "redeemed" || f["sealed"] != testSealed {
		t.Fatalf("redeem was answered %v", f)
	}

	// The row is there, named after the hello's device name, and it is the
	// only one the redemption added.
	ds, err := r.st.Devices(testVault)
	if err != nil {
		t.Fatal(err)
	}
	var row *store.Device
	for i := range ds {
		if ds[i].ID == deviceID("phone") {
			row = &ds[i]
		}
	}
	if row == nil {
		t.Fatalf("the redemption registered no device: %v", ds)
	}
	if row.Name != "newcomer" {
		t.Fatalf("the row is named %q, not the name the hello carried", row.Name)
	}
	if row.LastSeen != 0 {
		t.Fatalf("last_seen is %d before the device has ever connected", row.LastSeen)
	}
	if len(ds) != 2 {
		t.Fatalf("%d devices, want the one that invited and the one that redeemed: %v", len(ds), ds)
	}

	// And the key it registered is the key it connects with. The redeeming
	// connection proved nothing about holding it, so this hello is the proof.
	cl := r.dial("phone")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		DeviceID: deviceID("phone"), Token: deviceKey("phone"), Device: "phone"})
	cl.recvInto("ready", &wire.Ready{})
	cl.recvInto("caught-up", &wire.CaughtUp{})

	// A device added by an invite holds no root, which is the point of the
	// whole arrangement: it may sync and it may not mint another credential.
	cl.sendJSON(wire.In{Op: "register", DeviceID: deviceID("another"), Auth: deviceKey("another")})
	cl.expectErr(wire.CodeAuth)
	cl.sendJSON(wire.In{Op: "rotate", Auth: newKey, Wrapped: newWrapped})
	cl.expectErr(wire.CodeAuth)

	// The device that issued the invite is undisturbed by any of it.
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})
}

// An invite redeemed twice registers one device, not two.
//
// The single use is what makes an invite safe to be the authority to register:
// it is the same statement that reads the blob and marks it spent, so the
// second redeemer is refused before the row it wants is looked at.
func TestAnInviteRedeemedTwiceRegistersOneDevice(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	issue(t, a, testInvite)

	if f := redeem(t, r, testInvite, "phone"); f["res"] != "redeemed" {
		t.Fatalf("the first redeem was answered %v", f)
	}
	// A different device, so this is about the invite and not about the id.
	f := redeem(t, r, testInvite, "tablet")
	if f["res"] != "err" || f["code"] != wire.CodeAuth {
		t.Fatalf("a second redemption was answered %v, want auth", f)
	}
	ds, _ := r.st.Devices(testVault)
	for _, d := range ds {
		if d.ID == deviceID("tablet") {
			t.Fatalf("a spent invite registered a second device: %v", ds)
		}
	}
	if len(ds) != 2 {
		t.Fatalf("%d devices, want two: %v", len(ds), ds)
	}
}

// A redemption the server will not register does not spend the invite.
//
// This is the partial state that matters, and it has two halves. An invite
// spent with no row behind it is a string that stopped working and a device
// that was never added, and the only sign of it is somebody's phone failing to
// pair. A row written under an invite still marked live is a device registered
// twice over. store.RedeemInviteFor puts both writes in one transaction, so
// every refusal here rolls the spend back with it and the string in somebody's
// hand still works.
func TestARedeemThatCannotRegisterLeavesTheInviteUnspent(t *testing.T) {
	t.Run("an id the vault already holds", func(t *testing.T) {
		r := newRigDerived(t)
		a := claimed(t, r, "a")
		issue(t, a, testInvite)

		// "a" is already registered, so this redemption asks for a row that
		// exists. It is refused as the request's fault, and named, because the
		// caller fixes it by choosing an id of its own.
		f := redeemWith(t, r, testInvite, deviceID("a"), deviceKey("phone"))
		if f["res"] != "err" || f["code"] != wire.CodeBadEntry {
			t.Fatalf("redeeming onto an existing id was answered %v, want badentry", f)
		}
		// Nothing was overwritten: that row is still the device it was.
		_, hash, ok, err := r.st.DeviceByID(testVault, deviceID("a"))
		if err != nil || !ok || hash != hashOf(deviceKey("a")) {
			t.Fatalf("the existing row was changed: ok=%v hash=%q err=%v", ok, hash, err)
		}
		// And the invite still works, which is the whole point.
		if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
			t.Fatalf("%d outstanding invites after a refused redemption, want 1", n)
		}
		if f := redeem(t, r, testInvite, "phone"); f["res"] != "redeemed" {
			t.Fatalf("the invite no longer redeems: %v", f)
		}
	})

	t.Run("a vault already at its device cap", func(t *testing.T) {
		r := newRigDerived(t)
		a := claimed(t, r, "a")
		issue(t, a, testInvite)
		// Up to the cap. The rig seeds rows straight through the store, which
		// is what it does everywhere: this test is about what the redemption
		// does when it finds the vault full, not about how it filled.
		for i := len(mustDevices(t, r)); i < store.MaxDevices; i++ {
			r.device(fmt.Sprintf("filler-%d", i))
		}
		f := redeem(t, r, testInvite, "phone")
		if f["res"] != "err" || f["code"] != wire.CodeFull {
			// `full` and not `busy`: waiting never makes room, and `busy`
			// means come back later.
			t.Fatalf("redeeming onto a full vault was answered %v, want full", f)
		}
		if n := len(mustDevices(t, r)); n != store.MaxDevices {
			t.Fatalf("%d devices after a refused redemption, want the cap %d", n, store.MaxDevices)
		}
		if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
			t.Fatalf("%d outstanding invites after a refused redemption, want 1", n)
		}
		// Revoke one, and the same string still works. That is what makes the
		// refusal something a person can act on rather than a lost invite.
		a.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("filler-1")})
		a.recvInto("revoked", &wire.Revoked{})
		if f := redeem(t, r, testInvite, "phone"); f["res"] != "redeemed" {
			t.Fatalf("the invite no longer redeems after room was made: %v", f)
		}
	})
}

// mustDevices is the vault's device list or a failed test.
func mustDevices(t *testing.T, r *rig) []store.Device {
	t.Helper()
	ds, err := r.st.Devices(testVault)
	if err != nil {
		t.Fatalf("listing devices: %v", err)
	}
	return ds
}

// A redeeming hello has to say which device it is registering, and with what.
//
// Both refusals are about the frame rather than about the vault, so both are
// named: an `auth` here would make the shape of a request look like the answer
// to whether the invite exists. Neither spends the invite, because the shape is
// checked before the store is asked.
func TestARedeemingHelloMustNameTheDeviceItRegisters(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	issue(t, a, testInvite)

	for _, c := range []struct {
		what string
		in   wire.In
		code string
	}{
		{"no device id", wire.In{DeviceID: "", Auth: deviceKey("phone")}, wire.CodeBadName},
		{"a malformed device id", wire.In{DeviceID: "not base64!", Auth: deviceKey("phone")}, wire.CodeBadName},
		{"no auth key", wire.In{DeviceID: deviceID("phone")}, wire.CodeBadEntry},
		{"an auth key too short to be one", wire.In{DeviceID: deviceID("phone"), Auth: "short"}, wire.CodeBadEntry},
		{"a name with a newline in it", wire.In{DeviceID: deviceID("phone"), Auth: deviceKey("phone"), Name: "a\nb"}, wire.CodeBadName},
	} {
		cl := r.dial("newcomer")
		in := c.in
		in.Op, in.Crypto, in.Vault, in.Invite, in.Device = "hello", wire.Crypto, testVault, testInvite, "newcomer"
		cl.sendJSON(in)
		f := rawFields(t, cl.recvRaw())
		if f["res"] != "err" || f["code"] != c.code {
			t.Fatalf("a redeem with %s was answered %v, want %s", c.what, f, c.code)
		}
		if !cl.closed() {
			t.Fatalf("the session survived a hello that was refused: %s", c.what)
		}
	}
	// Every one of them left the invite alone, so the person holding the
	// string can fix their client and try again.
	if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
		t.Fatalf("%d outstanding invites after five refused redemptions, want 1", n)
	}
	if len(mustDevices(t, r)) != 1 {
		t.Fatal("a refused redemption registered a device")
	}
	if f := redeem(t, r, testInvite, "phone"); f["res"] != "redeemed" {
		t.Fatalf("the invite no longer redeems: %v", f)
	}
}

// A hello carrying both a claim and an invite is refused.
//
// A claim binds a vault nothing has claimed yet; an invite only exists on one
// that has. Sending both leaves the server choosing which the caller meant, and
// the one it did not choose would be silently discarded: the same defect, and
// the same refusal, as a token and an invite together.
func TestAHelloWithBothAClaimAndAnInviteIsRefused(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	issue(t, a, testInvite)

	cl := r.dial("confused")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Claim: longKey, Wrapped: testWrapped, Invite: testInvite,
		DeviceID: deviceID("phone"), Auth: deviceKey("phone"), Device: "confused"})
	f := rawFields(t, cl.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeBadEntry {
		t.Fatalf("a hello with both was answered %v, want badentry", f)
	}
	if !cl.closed() {
		t.Fatal("the session survived a hello that was refused")
	}
	if n, _ := r.st.OutstandingInvites(testVault, r.srv.now().UnixMilli()); n != 1 {
		t.Fatalf("%d outstanding invites after the refusal, want the one that was issued", n)
	}
}

// A device revoked a moment ago can be added again with an invite, and it is
// a different row: the id it had is not the id it comes back with.
//
// This is the loop the panel promises. Revoking says "add it again with an
// invite from a device that still has the vault", and if that were not true
// the only way back would be the recovery key.
func TestARevokedDeviceComesBackWithAnInvite(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")
	phone := deviceOn(t, r, "phone")

	a.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("phone")})
	a.recvInto("revoked", &wire.Revoked{})
	waitFor(t, "the revoked device to be closed", func() bool { return phone.closed() })

	issue(t, a, testInvite)
	if f := redeem(t, r, testInvite, "phone-again"); f["res"] != "redeemed" {
		t.Fatalf("a revoked device could not be added again: %v", f)
	}
	cl := r.dial("phone-again")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		DeviceID: deviceID("phone-again"), Token: deviceKey("phone-again"), Device: "phone"})
	cl.recvInto("ready", &wire.Ready{})
	cl.recvInto("caught-up", &wire.CaughtUp{})

	// The old id stays gone. Coming back is a new row, so the revocation is
	// not undone by it and the list says which is which.
	if _, _, ok, _ := r.st.DeviceByID(testVault, deviceID("phone")); ok {
		t.Fatal("the revoked row came back")
	}
}
