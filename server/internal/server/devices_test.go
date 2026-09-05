package server

import (
	"strings"
	"sync"
	"testing"

	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// Protocol 4: a device connects as itself, the vault's credential registers
// devices and does nothing else, and revoking one device means something.
//
// docs/protocol.md, "Authentication" and "The device list". The property under
// most of this is the one per-device-credentials-spec.md opens with: a device
// list that can be bypassed by the credential it replaced is worse than no
// list, because it looks like it works.

/* ---------------------------------------------------------------- *
 * The narrowing
 * ---------------------------------------------------------------- */

// The vault's own credential cannot sync. Not "is not expected to": every op
// that touches the vault is refused, there is no `ready` and no catch-up, and
// the session is in no fan-out, so nothing reaches it either.
//
// A credential every device connects with makes a device list a list of rows
// nothing consults, which is why the narrowing comes before the list.
func TestTheVaultCredentialCannotSync(t *testing.T) {
	r := newRigDerived(t)
	device := claimed(t, r, "a")
	uid := device.put("secret.md", "not for a registrar")

	reg := registrarWith(t, r, "recovery-key", longKey)
	for _, op := range []wire.In{
		{Op: "put", Path: "x.md", Mac: testMac, Meta: wire.PutMeta{MTime: 1}},
		{Op: "putmany", Entries: []wire.PutEntry{{Path: "x.md", Mac: testMac}}},
		{Op: "get", UID: uid},
		{Op: "fetch", Chunks: []string{strings.Repeat("a", 64)}},
		{Op: "history", Path: "secret.md"},
		{Op: "deleted"},
		{Op: "invite", Invite: testInvite, Sealed: testSealed},
	} {
		reg.sendJSON(op)
		msg := reg.expectErr(wire.CodeAuth)
		if !strings.Contains(msg, op.Op) {
			t.Fatalf("the refusal of %q does not name it: %q", op.Op, msg)
		}
		if !strings.Contains(msg, "device") {
			t.Fatalf("the refusal of %q does not say what credential it needs: %q", op.Op, msg)
		}
	}
	// `devices` and `revoke` are not on that list, and that is a decision
	// rather than an omission: the access list is the recovery key's to
	// administer, and the note is what it may not touch. See
	// TestTheRecoveryKeyAdministersTheDeviceListAndReadsNoNote.
	//
	// Nothing was written, nothing was revoked, and the session is still
	// usable for the things it may do.
	if ds, err := r.st.Devices(testVault); err != nil || len(ds) != 1 {
		t.Fatalf("devices after the refusals: %+v %v", ds, err)
	}
	if st := r.mustStats(); st.Versions != 1 {
		t.Fatalf("%d versions after a registrar tried to write", st.Versions)
	}

	// And it is in no fan-out: a write by the device reaches nobody here.
	device.put("another.md", "still not for a registrar")
	reg.sendJSON(wire.In{Op: "ping"})
	reg.recvInto("pong", &wire.Pong{})
	if got := reg.drainBatches(); len(got) != 0 {
		t.Fatalf("a registrar was sent %d batches of the vault's entries", len(got))
	}
}

// The vault's credential offered *as* a device credential opens nothing
// either, which is the same rule from the other side: there is no id under
// which the vault's own key is a device's.
func TestTheVaultCredentialIsNotADeviceCredential(t *testing.T) {
	r := newRigDerived(t)
	claimed(t, r, "a")
	cl := r.dial("impostor")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: longKey, DeviceID: deviceID("a"), Device: "impostor"})
	cl.expectErr(wire.CodeAuth)
	if !cl.closed() {
		t.Fatal("the vault's key was offered as a device's and the session stayed open")
	}
}

// A device that is not registered and a device whose key is wrong get the same
// refusal, saying neither which. Telling them apart would tell a caller which
// half to keep guessing, and after a revoke it would confirm that this id was
// a device here yesterday.
func TestAnUnknownDeviceAndAWrongKeyAreOneRefusal(t *testing.T) {
	r := newRigDerived(t)
	claimed(t, r, "a")

	wrongKey := r.dial("wrong-key")
	wrongKey.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: deviceKey("somebody-else"), DeviceID: deviceID("a"), Device: "a"})
	one := wrongKey.expectErr(wire.CodeAuth)

	noRow := r.dial("no-row")
	noRow.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: deviceKey("ghost"), DeviceID: deviceID("ghost"), Device: "ghost"})
	two := noRow.expectErr(wire.CodeAuth)

	if one != two {
		t.Fatalf("the two failures are distinguishable:\n  %q\n  %q", one, two)
	}
}

/* ---------------------------------------------------------------- *
 * Registering over the wire
 * ---------------------------------------------------------------- */

// The recovery key registers a device, which is what it is written down for:
// the day every device is gone. Spec test 7.
func TestTheRecoveryKeyRegistersADeviceWhenEveryDeviceIsGone(t *testing.T) {
	r := newRigDerived(t)
	first := claimed(t, r, "a")
	// Every device is lost.
	first.conn.CloseNow()
	if err := r.st.RevokeDevice(testVault, deviceID("a"), "", true); err != nil {
		t.Fatalf("losing every device: %v", err)
	}

	reg := registrarWith(t, r, "recovery-key", longKey)
	reg.sendJSON(wire.In{Op: "register", ID: 5, DeviceID: deviceID("replacement"),
		Auth: deviceKey("replacement"), Name: "the new laptop"})
	var done wire.Registered
	reg.recvInto("registered", &done)
	if done.DeviceID != deviceID("replacement") || done.Wrapped != testWrapped {
		t.Fatalf("registered was %+v", done)
	}
	// The device it registered is a device.
	cl := r.dial("replacement")
	cl.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: deviceKey("replacement"), DeviceID: deviceID("replacement"), Device: "replacement"})
	cl.recvInto("ready", &wire.Ready{})
	cl.recvInto("caught-up", &wire.CaughtUp{})
	ds, err := r.st.Devices(testVault)
	if err != nil || len(ds) != 1 || ds[0].Name != "the new laptop" {
		t.Fatalf("devices after the recovery: %+v %v", ds, err)
	}
}

// What the recovery key may do besides register and rotate: read the access
// list and take a row off it. What it may not do is read a note.
//
// The line is where it is because of two things a narrower one broke. Emptying
// the vault is the recovery key's alone, and a refusal naming a credential the
// server would then refuse as well is a dead end rather than an instruction.
// And a vault whose every row is a pairing that crashed refuses every
// registration with `full`, so a recovery key that could not prune the list
// would leave no way back in at all. Both are in the dispatch comment.
func TestTheRecoveryKeyAdministersTheDeviceListAndReadsNoNote(t *testing.T) {
	r := newRigDerived(t)
	device := claimed(t, r, "a")
	uid := device.put("secret.md", "not for a registrar")
	device.conn.CloseNow()
	waitFor(t, "the device to leave", func() bool { return r.srv.Peers(testVault) == 0 })

	reg := registrarWith(t, r, "recovery-key", longKey)
	reg.sendJSON(wire.In{Op: "register", DeviceID: deviceID("b"), Auth: deviceKey("b"), Name: "phone"})
	reg.recvInto("registered", &wire.Registered{})

	// It reads the list.
	reg.sendJSON(wire.In{Op: "devices", ID: 11})
	var list wire.DeviceList
	reg.recvInto("devices", &list)
	if len(list.Devices) != 2 || list.MaxDevices != store.MaxDevices {
		t.Fatalf("the recovery key was answered %+v", list)
	}

	// And takes one off it, which the device it names finds out by being
	// closed and then refused.
	reg.sendJSON(wire.In{Op: "revoke", ID: 12, DeviceID: deviceID("b")})
	var done wire.Revoked
	reg.recvInto("revoked", &done)
	if done.DeviceID != deviceID("b") || done.Self {
		t.Fatalf("revoked was %+v; a registrar is not a device, so it cannot be self", done)
	}
	if _, _, ok, _ := r.st.DeviceByID(testVault, deviceID("b")); ok {
		t.Fatal("the row survived a revoke from the recovery key")
	}

	// What it still may not do is read what those devices wrote. Note by note,
	// because "may administer the list" must not have quietly become "may
	// read the vault".
	for _, op := range []wire.In{
		{Op: "get", UID: uid},
		{Op: "history", Path: "secret.md"},
		{Op: "deleted"},
		{Op: "put", Path: "x.md", Mac: testMac, Meta: wire.PutMeta{MTime: 1}},
	} {
		reg.sendJSON(op)
		if msg := reg.expectErr(wire.CodeAuth); !strings.Contains(msg, op.Op) {
			t.Fatalf("the refusal of %q does not name it: %q", op.Op, msg)
		}
	}
	if st := r.mustStats(); st.Versions != 1 {
		t.Fatalf("%d versions after a registrar tried to write", st.Versions)
	}
}

// A device may not register another device. That is what a device not holding
// the root buys: a stolen laptop can read what it already had and cannot add a
// device of its own to the vault behind you.
func TestADeviceMayNotRegisterAnotherDevice(t *testing.T) {
	r := newRigDerived(t)
	cl := claimed(t, r, "a")
	cl.sendJSON(wire.In{Op: "register", DeviceID: deviceID("smuggled"), Auth: deviceKey("smuggled")})
	msg := cl.expectErr(wire.CodeAuth)
	if !strings.Contains(msg, "invite") || !strings.Contains(msg, "recovery key") {
		t.Fatalf("the refusal does not say how a device is added: %q", msg)
	}
	if _, _, ok, _ := r.st.DeviceByID(testVault, deviceID("smuggled")); ok {
		t.Fatal("a device registered another device")
	}
	// The session survives, because nothing was changed.
	cl.sendJSON(wire.In{Op: "ping"})
	cl.recvInto("pong", &wire.Pong{})
}

// Registering the same device, with the same key, twice is the registration
// having happened.
//
// That is what a half-finished registration leaves behind: the row committed
// and the reply was lost, and the caller is a conversion that has to be able to
// run again after a crash. Answering "already exists" there leaves a device
// retrying for ever. A *different* key under an id the vault already holds is
// somebody else's device and is refused, changing nothing.
func TestRegisteringTheSameDeviceTwiceIsIdempotent(t *testing.T) {
	r := newRigDerived(t)
	claimed(t, r, "a").conn.CloseNow()
	reg := registrarWith(t, r, "recovery-key", longKey)

	reg.sendJSON(wire.In{Op: "register", DeviceID: "twice", Auth: deviceKey("twice"), Name: "laptop"})
	reg.recvInto("registered", &wire.Registered{})
	reg.sendJSON(wire.In{Op: "register", DeviceID: "twice", Auth: deviceKey("twice"), Name: "laptop"})
	var again wire.Registered
	reg.recvInto("registered", &again)
	if again.DeviceID != "twice" || again.Wrapped != testWrapped {
		t.Fatalf("the repeated registration was answered %+v", again)
	}

	reg.sendJSON(wire.In{Op: "register", DeviceID: "twice", Auth: deviceKey("somebody-else"), Name: "impostor"})
	msg := reg.expectErr(wire.CodeBadEntry)
	if !strings.Contains(msg, "twice") {
		t.Fatalf("the refusal does not name the id: %q", msg)
	}
	_, hash, ok, err := r.st.DeviceByID(testVault, "twice")
	if err != nil || !ok || hash != hashOf(deviceKey("twice")) {
		t.Fatalf("the row after the refused registration: ok=%v hash=%q err=%v", ok, hash, err)
	}
	ds, _ := r.st.Devices(testVault)
	if len(ds) != 2 {
		t.Fatalf("%d devices, want the claimed one and the one registered twice: %+v", len(ds), ds)
	}
	if ds[1].Name != "laptop" {
		t.Fatalf("the refused registration renamed the row to %q", ds[1].Name)
	}
}

// The refusals a malformed registration gets, each of which leaves the session
// usable because nothing was written.
func TestRegisterRefusals(t *testing.T) {
	r := newRigDerived(t)
	claimed(t, r, "a").conn.CloseNow()
	reg := registrarWith(t, r, "recovery-key", longKey)

	for _, tc := range []struct {
		why  string
		msg  wire.In
		code string
	}{
		{"no device id", wire.In{Op: "register", Auth: deviceKey("x")}, wire.CodeBadName},
		{"a device id that is not base64url", wire.In{Op: "register", DeviceID: "no spaces", Auth: deviceKey("x")}, wire.CodeBadName},
		{"a device id over the bound", wire.In{Op: "register",
			DeviceID: strings.Repeat("i", store.MaxDeviceIDLen+1), Auth: deviceKey("x")}, wire.CodeBadName},
		{"no auth key", wire.In{Op: "register", DeviceID: "d1"}, wire.CodeBadEntry},
		{"a guessable auth key", wire.In{Op: "register", DeviceID: "d1", Auth: "hunter2"}, wire.CodeBadEntry},
		{"a name with a newline", wire.In{Op: "register", DeviceID: "d1",
			Auth: deviceKey("x"), Name: "laptop\ninjected"}, wire.CodeBadName},
		{"a name over the bound", wire.In{Op: "register", DeviceID: "d1",
			Auth: deviceKey("x"), Name: strings.Repeat("n", store.MaxDeviceLen+1)}, wire.CodeBadName},
	} {
		t.Run(tc.why, func(t *testing.T) {
			reg.sendJSON(tc.msg)
			reg.expectErr(tc.code)
			if _, _, ok, _ := r.st.DeviceByID(testVault, tc.msg.DeviceID); ok {
				t.Fatalf("a refused registration wrote a row for %q", tc.msg.DeviceID)
			}
			reg.sendJSON(wire.In{Op: "ping"})
			reg.recvInto("pong", &wire.Pong{})
		})
	}
}

// An authenticator that grants a session without saying which vault credential
// it matched cannot register anything. Refused rather than guessed, exactly as
// rotate is: a registration authorised by no credential at all is the hole
// this whole path exists to close.
func TestARegistrarWithNoVaultCredentialRegistersNothing(t *testing.T) {
	r := newRig(t) // StaticTokens: a token map, and no vault hash in its grant
	cl := r.dial("a")
	cl.registrar()
	cl.sendJSON(wire.In{Op: "register", DeviceID: "d1", Auth: deviceKey("d1")})
	msg := cl.expectErr(wire.CodeAuth)
	if !strings.Contains(msg, "credential") {
		t.Fatalf("the refusal does not say what is missing: %q", msg)
	}
	if ds, _ := r.st.Devices(testVault); len(ds) != 0 {
		t.Fatalf("%d devices registered by a session with no vault credential", len(ds))
	}
}

/* ---------------------------------------------------------------- *
 * The cap
 * ---------------------------------------------------------------- */

// The ninth registration is refused, with a code of its own and a message that
// says what to do. Not `busy`: `busy` means come back later and this never
// becomes true by waiting, so a client treating it as `busy` would retry a
// registration that can only ever be refused.
func TestTheNinthRegistrationIsRefusedWithFull(t *testing.T) {
	r := newRigDerived(t)
	claimed(t, r, "a").conn.CloseNow()
	reg := registrarWith(t, r, "recovery-key", longKey)

	// One device already exists, from the claim.
	for i := 1; i < store.MaxDevices; i++ {
		id := deviceID(string(rune('b' + i)))
		reg.sendJSON(wire.In{Op: "register", DeviceID: id, Auth: deviceKey(id)})
		reg.recvInto("registered", &wire.Registered{})
	}
	reg.sendJSON(wire.In{Op: "register", ID: 99, DeviceID: "one-too-many", Auth: deviceKey("z")})
	m := reg.recv()
	if m["res"] != "err" || m["code"] != wire.CodeFull || m["id"] != float64(99) {
		t.Fatalf("the ninth registration was answered %v, want full", m)
	}
	if m["retryable"] != false {
		t.Fatalf("full is retryable, so a client would loop on a cap only a person can clear: %v", m)
	}
	msg, _ := m["msg"].(string)
	if !strings.Contains(msg, "revoke") {
		t.Fatalf("the refusal does not say what to do about it: %q", msg)
	}
	// Seven of these were registered and never connected, which is exactly
	// what a pairing that crashed leaves, so the refusal names them rather
	// than leaving somebody to pick one of their working devices.
	if !strings.Contains(msg, "7 of them have never connected") {
		t.Fatalf("the refusal does not point at the reclaimable rows: %q", msg)
	}
	if ds, _ := r.st.Devices(testVault); len(ds) != store.MaxDevices {
		t.Fatalf("%d devices after the refusal, want %d", len(ds), store.MaxDevices)
	}
	// The session survives: a registrar with a second device to add may still
	// add it once somebody makes room.
	reg.sendJSON(wire.In{Op: "ping"})
	reg.recvInto("pong", &wire.Pong{})
}

// The cap a vault may register and the cap on devices connected at once are
// the same number, and a test says so rather than two constants happening to
// agree.
//
// If the registry allowed more than the fan-out does, the extra device would
// register, connect, and be refused with `busy` for ever with nothing saying
// why: a limit nobody chose, discovered as a connection that will not open.
func TestTheRegistryCapAndTheConnectionCapAgree(t *testing.T) {
	if store.MaxDevices != DefaultMaxPeers {
		t.Fatalf("a vault may register %d devices and connect %d at once; "+
			"the difference is a device that registers and can never connect",
			store.MaxDevices, DefaultMaxPeers)
	}
}

/* ---------------------------------------------------------------- *
 * Listing
 * ---------------------------------------------------------------- */

// The list names every device with what a person reads it by, carries no
// credential, and is never null. Two devices may share a name, because the id
// is the identity: two laptops both called laptop is a person's problem to fix
// and not the server's to prevent.
func TestTheDeviceListIsUsableAndCarriesNoCredential(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	b := r.dial("b")
	b.hello(0)
	// A second device under the same name, registered straight into the store
	// so that the two really do collide.
	if err := r.st.RegisterDevice(testVault, "twin", "a", hashOf(deviceKey("twin")),
		hashOf(testToken), store.MaxDevices, 5); err != nil {
		t.Fatalf("registering a second device called a: %v", err)
	}

	a.sendJSON(wire.In{Op: "devices", ID: 40})
	var got wire.DeviceList
	a.recvInto("devices", &got)
	if got.ID != 40 || got.MaxDevices != store.MaxDevices {
		t.Fatalf("the listing was %+v", got)
	}
	if len(got.Devices) != 3 {
		t.Fatalf("%d devices listed, want three: %+v", len(got.Devices), got.Devices)
	}
	names := map[string]int{}
	for _, d := range got.Devices {
		if d.ID == "" {
			t.Fatalf("a listed device has no id: %+v", d)
		}
		names[d.Name]++
	}
	if names["a"] != 2 {
		t.Fatalf("the two devices called a came back as %v", names)
	}

	// Nothing in the frame is a credential. The listing type has no field for
	// one, and this is what catches the day somebody adds it.
	raw := a.recvRawFor(t, wire.In{Op: "devices"})
	for _, secret := range []string{hashOf(deviceKey("a")), deviceKey("a"), hashOf(testToken), testToken} {
		if strings.Contains(raw, secret) {
			t.Fatalf("the device list carries a credential: %s", raw)
		}
	}

	// A vault with no devices lists as [] and not null, so a client that
	// iterates the result does not crash on exactly the vault it is for.
	if err := r.st.RevokeDevice(testVault, deviceID("a"), "", false); err != nil {
		t.Fatal(err)
	}
	if err := r.st.RevokeDevice(testVault, "twin", "", false); err != nil {
		t.Fatal(err)
	}
	if err := r.st.RevokeDevice(testVault, deviceID("b"), "", true); err != nil {
		t.Fatal(err)
	}
	empty := b.recvRawFor(t, wire.In{Op: "devices"})
	if !strings.Contains(empty, `"devices":[]`) {
		t.Fatalf("a vault with no devices listed as %s", empty)
	}
}

// recvRawFor sends one request and returns its reply exactly as it came off
// the wire, since decoding into a struct is what hides the difference between
// [] and null, and hides a field nobody meant to add.
func (c *client) recvRawFor(t *testing.T, m wire.In) string {
	t.Helper()
	c.sendJSON(m)
	return c.recvRaw()
}

/* ---------------------------------------------------------------- *
 * Revoking
 * ---------------------------------------------------------------- */

// A revoked device cannot connect, and the refusal is the ordinary one: a
// revoked device connecting is the system working, not a fault.
func TestARevokedDeviceCannotConnect(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	b := r.dial("b")
	b.hello(0)

	b.sendJSON(wire.In{Op: "revoke", ID: 12, DeviceID: deviceID("a")})
	var done wire.Revoked
	b.recvInto("revoked", &done)
	if done.ID != 12 || done.DeviceID != deviceID("a") || done.Self {
		t.Fatalf("revoke was answered %+v", done)
	}

	again := r.dial("a-again")
	again.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: deviceKey("a"), DeviceID: deviceID("a"), Device: "a"})
	again.expectErr(wire.CodeAuth)
	if !again.closed() {
		t.Fatal("a revoked device connected")
	}
}

// Revoking closes the live session the revoked device is holding, and says why
// in words a person can act on.
//
// Deleting the row alone would be a revocation the revoked device never
// notices: it holds an authenticated connection and nothing on a live session
// is re-checked, so a stolen laptop would go on receiving every note pushed to
// the vault for as long as it stayed up, while the panel said it was gone.
func TestRevokingClosesTheRevokedDevicesLiveSession(t *testing.T) {
	r := newRig(t)
	victim := r.dial("a")
	victim.hello(0)
	other := r.dial("b")
	other.hello(0)
	waitFor(t, "both devices to join", func() bool { return r.srv.Peers(testVault) == 2 })

	other.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("a")})
	other.recvInto("revoked", &wire.Revoked{})

	f := rawFields(t, victim.recvRaw())
	if f["res"] != "err" || f["code"] != wire.CodeAuth || f["id"] != nil {
		t.Fatalf("the revoked device was told %v, want an unsolicited auth error", f)
	}
	msg, _ := f["msg"].(string)
	if !strings.Contains(msg, "revoked") || !strings.Contains(msg, "invite") {
		t.Fatalf("the notice does not say what happened or what to do: %q", msg)
	}
	if !victim.closed() {
		t.Fatal("a revoked device kept its connection and went on receiving")
	}
	waitFor(t, "the revoked session to leave", func() bool { return r.srv.Peers(testVault) == 1 })
}

// Revoking one device disturbs no other device's session or sync. Spec test 2:
// the whole point of the feature is that the answer to a stolen laptop is not
// re-pairing the phone, the desktop and the NAS.
func TestRevokingOneDeviceDisturbsNoOther(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	b := r.dial("b")
	b.hello(0)
	c := r.dial("c")
	c.hello(0)
	waitFor(t, "three devices to join", func() bool { return r.srv.Peers(testVault) == 3 })

	a.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("c")})
	a.recvInto("revoked", &wire.Revoked{})
	waitFor(t, "the revoked session to leave", func() bool { return r.srv.Peers(testVault) == 2 })

	// a and b are still syncing to each other, mid-session.
	uid := a.put("after-the-revoke.md", "still here")
	if got := b.nextBatch(); got.To != uid || len(got.Entries) != 1 {
		t.Fatalf("the untouched device saw %+v", got)
	}
	// And b's own row is untouched, so it reconnects.
	again := r.dial("b-again")
	again.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: deviceKey("b"), DeviceID: deviceID("b"), Device: "b"})
	again.recvInto("ready", &wire.Ready{})
}

// A device may revoke itself, which is what unlinking becomes, and the session
// ends: a revoked device does not stay connected, including when it is the one
// that asked.
func TestADeviceMayRevokeItselfAndTheSessionEnds(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	b := r.dial("b")
	b.hello(0)

	a.sendJSON(wire.In{Op: "revoke", ID: 3, DeviceID: deviceID("a")})
	var done wire.Revoked
	a.recvInto("revoked", &done)
	if !done.Self {
		t.Fatalf("a device unlinking itself was not told so: %+v", done)
	}
	if !a.closed() {
		t.Fatal("a device revoked itself and stayed connected")
	}
	if _, _, ok, _ := r.st.DeviceByID(testVault, deviceID("a")); ok {
		t.Fatal("the row survived the device revoking itself")
	}
	// The other device is untouched.
	b.sendJSON(wire.In{Op: "ping"})
	b.recvInto("pong", &wire.Pong{})
}

// A device may not empty the vault, with or without saying the word, and the
// recovery key may.
//
// Ordinary revocation stays a device's: a phone cutting off a stolen laptop
// without anybody digging out the recovery key is why revocation exists at
// all. Emptying the vault is the exception, because it is the one revocation
// nothing on a device can undo: what it leaves is a vault only the recovery
// key opens. A compromised device could otherwise delete every row and the
// last one with it, and its owner would be left holding devices that cannot
// reach their own notes.
//
// It costs nothing in the case it is aimed at, which is the argument for
// gating it: a device stolen when it was the only one wants a rotation too,
// and rotating already needs the recovery key.
func TestADeviceMayNotEmptyTheVault(t *testing.T) {
	r := newRigDerived(t)
	a := claimed(t, r, "a")

	// Without the word: told what it would cost, and told whose job it is.
	a.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("a")})
	msg := a.expectErr(wire.CodeBadEntry)
	if !strings.Contains(msg, "last device") || !strings.Contains(msg, "recovery key") {
		t.Fatalf("the refusal does not say what it would cost or who can: %q", msg)
	}

	// With it: refused as a credential, not as a frame, and the message says
	// which credential and what to do with it. A refusal that only said no
	// would send somebody rotating and re-pairing everything instead.
	a.sendJSON(wire.In{Op: "revoke", ID: 7, DeviceID: deviceID("a"), AllowLast: true})
	m := a.recv()
	if m["res"] != "err" || m["code"] != wire.CodeAuth || m["id"] != float64(7) {
		t.Fatalf("a device saying allowLast was answered %v, want auth", m)
	}
	said, _ := m["msg"].(string)
	if !strings.Contains(said, "recovery key") || !strings.Contains(said, "revoke any other device") {
		t.Fatalf("the refusal does not say what to do instead: %q", said)
	}
	if _, _, ok, _ := r.st.DeviceByID(testVault, deviceID("a")); !ok {
		t.Fatal("the refused revoke deleted the row anyway")
	}
	// Both refusals leave the session usable, because neither changed
	// anything, and this device is still syncing.
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})
	a.put("still-here.md", "the refusal did not cost the connection")

	// The recovery key does it, and still has to say the word: the second
	// confirmation is what keeps it from being a mis-click, and it is now
	// asked of the credential that can undo it.
	reg := registrarWith(t, r, "recovery-key", longKey)
	reg.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("a")})
	if msg := reg.expectErr(wire.CodeBadEntry); !strings.Contains(msg, "allowLast") {
		t.Fatalf("the recovery key was not told how to mean it: %q", msg)
	}
	reg.sendJSON(wire.In{Op: "revoke", DeviceID: deviceID("a"), AllowLast: true})
	reg.recvInto("revoked", &wire.Revoked{})
	if ds, _ := r.st.Devices(testVault); len(ds) != 0 {
		t.Fatalf("%d devices after the recovery key emptied the vault", len(ds))
	}
	// And the device it emptied is closed, the same as any other revocation.
	waitFor(t, "the emptied device to leave", func() bool { return r.srv.Peers(testVault) == 0 })
}

// A revoke under a root the vault no longer knows is refused, so a rotation
// ends what a leaked recovery key can do to the device list.
//
// The same guard registration has, one table over, and it matters more here
// than it looks: a rotation deliberately leaves every device row alone, so a
// retired root that could still delete rows would answer a rotation by locking
// every real device out of the vault.
func TestARevokeRacingARotationCannotWin(t *testing.T) {
	r := newRigDerived(t)
	claimed(t, r, "a").conn.CloseNow()
	waitFor(t, "the setup sessions to leave", func() bool { return r.srv.Registrars(testVault) == 0 })
	leaked := registrarWith(t, r, "the-leaked-key", longKey)

	if err := r.st.Rotate(testVault, hashOf(longKey), hashOf(newKey), newWrapped); err != nil {
		t.Fatalf("the rotation: %v", err)
	}

	leaked.sendJSON(wire.In{Op: "revoke", ID: 9, DeviceID: deviceID("a"), AllowLast: true})
	m := leaked.recv()
	if m["res"] != "err" || m["code"] != wire.CodeRotated || m["id"] != float64(9) {
		t.Fatalf("a revoke under the retired root was answered %v, want rotated", m)
	}
	if m["retryable"] != false {
		t.Fatalf("the refusal is retryable, so the leaked key would keep trying: %v", m)
	}
	if _, _, ok, _ := r.st.DeviceByID(testVault, deviceID("a")); !ok {
		t.Fatal("the retired root revoked a device, which the rotation cannot take back")
	}
	if !leaked.closed() {
		t.Fatal("a session holding a credential the vault no longer knows was left open")
	}
}

// A revoke naming a device that is not there is its own code: the list the
// caller was reading is stale and wants refreshing, which is a different act
// from every other refusal a revoke can get.
func TestRevokingADeviceThatIsNotThere(t *testing.T) {
	r := newRig(t)
	a := r.dial("a")
	a.hello(0)
	a.sendJSON(wire.In{Op: "revoke", ID: 8, DeviceID: "never-registered"})
	m := a.recv()
	if m["res"] != "err" || m["code"] != wire.CodeNoDevice || m["id"] != float64(8) {
		t.Fatalf("revoking an unknown device was answered %v", m)
	}
	if m["retryable"] != false {
		t.Fatalf("nodevice is retryable, so a client would keep asking: %v", m)
	}
	a.sendJSON(wire.In{Op: "revoke", DeviceID: "not base64url!"})
	a.expectErr(wire.CodeBadName)
	a.sendJSON(wire.In{Op: "ping"})
	a.recvInto("pong", &wire.Pong{})
}

// A revoke racing a connect comes out right whichever order they land in.
//
// The revoke deletes the row and only then collects the sessions to close, and
// a connecting device joins the fan-out and only then stamps itself as seen.
// So either the delete is first, and the stamp finds no row, or the join is
// first, and the revoke finds the session. Here the revoke lands in the
// narrower of the two windows: after the credential has been checked and
// before the session is in anybody's list.
func TestARevokeRacingAConnectAlwaysWins(t *testing.T) {
	r := newRig(t)
	keeper := r.dial("keeper")
	keeper.hello(0)
	r.device("racer") // registered, so the hello below gets past the credential check

	var once sync.Once
	r.srv.beforeJoin = func() {
		once.Do(func() {
			if err := r.st.RevokeDevice(testVault, deviceID("racer"), "", false); err != nil {
				t.Errorf("revoking between the credential check and the join: %v", err)
			}
		})
	}

	racer := r.dial("racer")
	racer.sendJSON(wire.In{Op: "hello", Crypto: wire.Crypto, Vault: testVault,
		Token: deviceKey("racer"), DeviceID: deviceID("racer"), Device: "racer"})
	racer.expectErr(wire.CodeAuth)
	if !racer.closed() {
		t.Fatal("a device revoked during its own handshake was served anyway")
	}
	waitFor(t, "the refused session to leave the fan-out",
		func() bool { return r.srv.Peers(testVault) == 1 })
}

/* ---------------------------------------------------------------- *
 * last_seen
 * ---------------------------------------------------------------- */

// last_seen moves on connect and not otherwise. It is the only thing that
// answers "is that laptop still syncing", so a number that moved because
// somebody listed the devices would be a number that always looks fine.
func TestLastSeenMovesOnConnectAndNotOtherwise(t *testing.T) {
	r := newRig(t)
	base := r.srv.now()
	r.device("a")
	if _, _, ok, _ := r.st.DeviceByID(testVault, deviceID("a")); !ok {
		t.Fatal("the device was not registered")
	}
	if d, _, _, _ := r.st.DeviceByID(testVault, deviceID("a")); d.LastSeen != 0 {
		t.Fatalf("a device that has never connected has last_seen %d", d.LastSeen)
	}

	cl := r.dial("a")
	cl.hello(0)
	d, _, _, _ := r.st.DeviceByID(testVault, deviceID("a"))
	if d.LastSeen < base.UnixMilli() {
		t.Fatalf("last_seen is %d after connecting, want at least %d", d.LastSeen, base.UnixMilli())
	}
	seen := d.LastSeen

	// Working on the connection does not move it: only a connect does.
	cl.put("note.md", "a body")
	cl.sendJSON(wire.In{Op: "devices"})
	cl.recvInto("devices", &wire.DeviceList{})
	if after, _, _, _ := r.st.DeviceByID(testVault, deviceID("a")); after.LastSeen != seen {
		t.Fatalf("last_seen moved from %d to %d without a connect", seen, after.LastSeen)
	}
}
