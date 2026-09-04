package store

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Step 1 of per-device credentials at the store: the devices table and the
// operations over it. Nothing here is wired into a session yet, and the vault's
// own auth_hash still authorises everything it did; what these pin is that the
// list a session will consult is correct on its own, because step 2 has nowhere
// safe to stand otherwise.

// Device auth hashes. Hex, 64 characters, the same shape as the vault's,
// because they are the same thing per device: a hash of a key the server never
// holds.
var (
	hashA = strings.Repeat("a", 64)
	hashB = strings.Repeat("b", 64)
	hashC = strings.Repeat("c", 64)
)

// claimedStore is a vault that has been claimed, which is the only kind a
// device may be registered to.
func claimedStore(t *testing.T) *harness {
	t.Helper()
	h := newTestStore(t)
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatalf("claim: %v", err)
	}
	return h
}

// ids returns the device ids of a vault's list, in the order it gave them.
func ids(t *testing.T, h *harness, vaultID string) []string {
	t.Helper()
	ds, err := h.Devices(vaultID)
	if err != nil {
		t.Fatalf("devices: %v", err)
	}
	out := make([]string, 0, len(ds))
	for _, d := range ds {
		out = append(out, d.ID)
	}
	return out
}

/* ---------------------------------------------------------------- *
 * Registering
 * ---------------------------------------------------------------- */

func TestRegisteringADeviceStoresItAndRefusesADuplicateID(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "device-one", "laptop", hashA, 1000); err != nil {
		t.Fatalf("register: %v", err)
	}

	d, hash, ok, err := h.DeviceByID("v1", "device-one")
	if err != nil || !ok {
		t.Fatalf("reading back the device just registered: ok=%v err=%v", ok, err)
	}
	if d.ID != "device-one" || d.Name != "laptop" || hash != hashA {
		t.Fatalf("the row came back as %+v with hash %q", d, hash)
	}
	if d.CreatedAt != 1000 {
		t.Fatalf("created_at = %d, want 1000", d.CreatedAt)
	}
	// Zero, not the epoch: a device that has never connected has to be
	// distinguishable from one that connected in 1970.
	if d.LastSeen != 0 {
		t.Fatalf("last_seen = %d on a device that has never connected, want 0", d.LastSeen)
	}

	// The same id again, with a different key, is refused and changes nothing.
	// This is the whole point of the primary key: whoever registered the id
	// owns it, and a second registration cannot quietly replace the credential
	// the first one is syncing under.
	err = h.RegisterDevice("v1", "device-one", "impostor", hashB, 2000)
	if !errors.Is(err, ErrDeviceExists) {
		t.Fatalf("err = %v, want ErrDeviceExists", err)
	}
	d, hash, _, _ = h.DeviceByID("v1", "device-one")
	if hash != hashA || d.Name != "laptop" {
		t.Fatalf("a refused registration overwrote the row: %+v hash %q", d, hash)
	}

	// Another vault may use the same id, because the identity is the pair.
	if err := h.EnsureVault("v2", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := h.ClaimVault("v2", hash2, wrapped2, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v2", "device-one", "laptop", hashB, 3000); err != nil {
		t.Fatalf("the same device id on another vault: %v", err)
	}
}

// Registration is what the vault's auth_hash still authorises once its meaning
// narrows, so a vault nothing has claimed has no credential that could have
// authorised this.
func TestRegisteringADeviceNeedsAClaimedVault(t *testing.T) {
	h := newTestStore(t) // ensured, not claimed
	if err := h.RegisterDevice("v1", "device-one", "laptop", hashA, 1000); !errors.Is(err, ErrUnknownVault) {
		t.Fatalf("err = %v, want ErrUnknownVault", err)
	}
	if err := h.RegisterDevice("nosuchvault", "device-one", "laptop", hashA, 1000); !errors.Is(err, ErrUnknownVault) {
		t.Fatalf("err = %v on a vault with no row, want ErrUnknownVault", err)
	}
	if n := len(ids(t, h, "v1")); n != 0 {
		t.Fatalf("%d devices on a vault the registration was refused for", n)
	}
}

// The name is a label, and it is bounded and control-character free exactly the
// way the `device` name on a hello is, because it is the same name: it defaults
// to what the client already sends and it lands in the same places. One rule,
// in store.CheckName, called from both.
func TestADeviceNameIsOptionalFreeTextBoundedLikeTheWireOne(t *testing.T) {
	h := claimedStore(t)

	// Optional.
	if err := h.RegisterDevice("v1", "device-one", "", hashA, 1000); err != nil {
		t.Fatalf("a device with no name: %v", err)
	}
	// Exactly at the limit, and one byte over it.
	if err := h.RegisterDevice("v1", "device-two", strings.Repeat("n", MaxDeviceLen), hashB, 1001); err != nil {
		t.Fatalf("a name of exactly %d bytes: %v", MaxDeviceLen, err)
	}
	err := h.RegisterDevice("v1", "device-three", strings.Repeat("n", MaxDeviceLen+1), hashC, 1002)
	if !errors.Is(err, ErrBadEntry) {
		t.Fatalf("err = %v for a name of %d bytes, want ErrBadEntry", err, MaxDeviceLen+1)
	}
	// A newline in a name is a forged log line, and this is the same refusal
	// the wire gives.
	if err := h.RegisterDevice("v1", "device-three", "laptop\ninjected", hashC, 1003); !errors.Is(err, ErrBadEntry) {
		t.Fatalf("err = %v for a name with a newline, want ErrBadEntry", err)
	}
	if want := CheckName("device", "laptop\ninjected", MaxDeviceLen); want == nil {
		t.Fatal("store.CheckName accepts a control character, so the wire does too")
	}
	// Never unique. Two laptops both called laptop is a person's problem and
	// not the server's to prevent, and the list stays usable because the id is
	// the identity.
	if err := h.RegisterDevice("v1", "device-four", "laptop", hashC, 1004); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "device-five", "laptop", hashC, 1005); err != nil {
		t.Fatalf("a second device with the same name: %v", err)
	}
	if got := ids(t, h, "v1"); len(got) != 4 {
		t.Fatalf("devices = %v, want the four that were accepted", got)
	}
}

func TestRegisteringADeviceRefusesAMalformedIDOrHash(t *testing.T) {
	h := claimedStore(t)
	for _, c := range []struct {
		why, id, hash string
	}{
		{"empty id", "", hashA},
		{"id that is not base64url", "device one", hashA},
		{"id over the bound", strings.Repeat("d", MaxDeviceIDLen+1), hashA},
		{"empty hash", "device-one", ""},
		{"hash that is not hex", "device-one", strings.Repeat("z", 64)},
		{"hash of the wrong length", "device-one", strings.Repeat("a", 63)},
	} {
		if err := h.RegisterDevice("v1", c.id, "laptop", c.hash, 1000); !errors.Is(err, ErrBadEntry) {
			t.Fatalf("%s: err = %v, want ErrBadEntry", c.why, err)
		}
	}
	if n := len(ids(t, h, "v1")); n != 0 {
		t.Fatalf("%d devices registered by refused calls", n)
	}
}

/* ---------------------------------------------------------------- *
 * Listing
 * ---------------------------------------------------------------- */

// Rule 7: a list a person reads has to be the same list twice. created_at is a
// millisecond, so registrations that share one need a tiebreak or the order is
// the query plan's opinion. What this can see is that the order is total and
// repeatable; it cannot see the tiebreak itself, because today's plan scans the
// primary key and sorts stably over it. See Devices.
func TestDevicesListsInAStableOrderAndNeverReturnsNil(t *testing.T) {
	h := claimedStore(t)

	// A vault with no devices, which is every protocol 3 vault, is an empty
	// list and not an error, and not nil either: nil marshals to JSON null and
	// a client that iterates it crashes on exactly the vault it has to handle.
	empty, err := h.Devices("v1")
	if err != nil {
		t.Fatalf("devices of a vault with none: %v", err)
	}
	if empty == nil {
		t.Fatal("a vault with no devices returned a nil slice, which is null on the wire")
	}
	if b, _ := json.Marshal(empty); string(b) != "[]" {
		t.Fatalf("a vault with no devices marshals to %s, want []", b)
	}

	// Registered newest first, and five of the six sharing one millisecond, so
	// that created_at alone cannot order them: without the tiebreak they come
	// back in whatever order the sorter happened to leave them, which here is
	// the order they were written in.
	for i, id := range []string{"zulu", "yankee", "xray", "whisky", "victor"} {
		if err := h.RegisterDevice("v1", id, "same millisecond", hashA, 1000); err != nil {
			t.Fatalf("register %s: %v", id, err)
		}
		_ = i
	}
	if err := h.RegisterDevice("v1", "alfa", "later", hashB, 2000); err != nil {
		t.Fatal(err)
	}
	want := []string{"victor", "whisky", "xray", "yankee", "zulu", "alfa"} // created_at, then id
	for i := 0; i < 5; i++ {
		got := ids(t, h, "v1")
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("call %d listed %v, want %v", i, got, want)
		}
	}
}

// The listing is what a list op sends to every device. A credential hash that
// lives in the listing type reaches all of them the first time somebody
// serialises it, so the type does not have the field: this fails the moment one
// is added.
func TestADeviceListingCarriesNoCredential(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "device-one", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	ds, err := h.Devices("v1")
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(ds)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), hashA) {
		t.Fatalf("the device listing carries the auth hash: %s", b)
	}
}

func TestDeviceByIDCarriesTheHashAndSaysWhenThereIsNoRow(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "device-one", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	// Not there is not an error: a revoked device connecting is the system
	// working, and the caller turns both into one refusal.
	d, hash, ok, err := h.DeviceByID("v1", "device-two")
	if err != nil {
		t.Fatalf("unknown device: %v", err)
	}
	if ok {
		t.Fatalf("an unregistered device came back as %+v", d)
	}
	if hash != "" {
		t.Fatalf("an unregistered device came back with hash %q", hash)
	}
	// Nor is a vault that does not exist.
	if _, _, ok, err := h.DeviceByID("nosuchvault", "device-one"); ok || err != nil {
		t.Fatalf("unknown vault: ok=%v err=%v", ok, err)
	}
	// And the id is scoped to its vault.
	if _, _, ok, _ := h.DeviceByID("v2", "device-one"); ok {
		t.Fatal("a device registered on v1 was found on v2")
	}
	if _, hash, ok, _ := h.DeviceByID("v1", "device-one"); !ok || hash != hashA {
		t.Fatalf("the registered device: ok=%v hash=%q", ok, hash)
	}
}

/* ---------------------------------------------------------------- *
 * Revoking
 * ---------------------------------------------------------------- */

func TestRevokingADeviceLeavesEveryOtherDeviceAlone(t *testing.T) {
	h := claimedStore(t)
	for i, id := range []string{"alfa", "bravo", "charlie"} {
		if err := h.RegisterDevice("v1", id, id, hashA, int64(1000+i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.SawDevice("v1", "charlie", 5000); err != nil {
		t.Fatal(err)
	}
	if err := h.RevokeDevice("v1", "bravo", false); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	if _, _, ok, _ := h.DeviceByID("v1", "bravo"); ok {
		t.Fatal("the revoked device still has a row, so it can still connect")
	}
	if got := ids(t, h, "v1"); strings.Join(got, ",") != "alfa,charlie" {
		t.Fatalf("after revoking bravo the list is %v", got)
	}
	// Nothing else moved: not the names, not created_at, not last_seen.
	d, hash, ok, err := h.DeviceByID("v1", "charlie")
	if err != nil || !ok {
		t.Fatalf("charlie: ok=%v err=%v", ok, err)
	}
	if d.Name != "charlie" || d.CreatedAt != 1002 || d.LastSeen != 5000 || hash != hashA {
		t.Fatalf("revoking bravo disturbed charlie: %+v hash %q", d, hash)
	}
	// And it is a delete, so revoking it again is unknown rather than a
	// second success.
	if err := h.RevokeDevice("v1", "bravo", false); !errors.Is(err, ErrUnknownDevice) {
		t.Fatalf("err = %v revoking an already revoked device, want ErrUnknownDevice", err)
	}
}

// The spec's claim that a delete loses nothing rests on the audit trail being
// somewhere else. It is: entries.device is a column on rows revocation never
// touches, so what a revoked device wrote is still attributed to it.
func TestRevokingADeviceDoesNotTouchTheHistoryItWrote(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "device-one", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	e := h.file(t, "note.md", "written by the device about to be revoked")
	if err := h.RegisterDevice("v1", "device-two", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}
	if err := h.RevokeDevice("v1", "device-one", false); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	got, ok, err := h.EntryByUID("v1", e.UID)
	if err != nil || !ok {
		t.Fatalf("the entry after revoking its writer: ok=%v err=%v", ok, err)
	}
	if got.Device != "d1" || len(got.Chunks) != 1 {
		t.Fatalf("revoking rewrote history: %+v", got)
	}
}

// Refused by default, because a vault with no devices is reachable only by the
// recovery key and that is not a state to arrive in by clicking a row. Allowed
// when the caller says so, because it is also a real thing to want.
func TestRevokingTheLastDeviceIsRefusedUnlessSaidSo(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}
	// Two devices: not the last one.
	if err := h.RevokeDevice("v1", "alfa", false); err != nil {
		t.Fatalf("revoking one of two: %v", err)
	}
	// One device: refused, and still there afterwards.
	err := h.RevokeDevice("v1", "bravo", false)
	if !errors.Is(err, ErrLastDevice) {
		t.Fatalf("err = %v revoking the last device, want ErrLastDevice", err)
	}
	if _, _, ok, _ := h.DeviceByID("v1", "bravo"); !ok {
		t.Fatal("the refusal deleted the row anyway")
	}
	// The message has to tell a person what to do about it, because the
	// refusal is the only place they learn there is a way through.
	if !strings.Contains(err.Error(), "recovery key") || !strings.Contains(err.Error(), "explicitly") {
		t.Fatalf("the refusal does not say what it costs or how to mean it: %v", err)
	}
	// Said explicitly: done.
	if err := h.RevokeDevice("v1", "bravo", true); err != nil {
		t.Fatalf("revoking the last device on purpose: %v", err)
	}
	if n := len(ids(t, h, "v1")); n != 0 {
		t.Fatalf("%d devices left after revoking the last one on purpose", n)
	}
}

// "There is no such device" and "that is the last one" are opposite
// instructions to whoever is holding the list: one is a wrong id, the other is
// a right id and a decision. A single error for both would have somebody
// confirming their way past a typo.
func TestRevokingAnUnknownDeviceIsNotTheSameAsTheLastOne(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RevokeDevice("v1", "typo", false); !errors.Is(err, ErrUnknownDevice) {
		t.Fatalf("err = %v, want ErrUnknownDevice", err)
	}
	// Even with the confirmation, an unknown id is unknown rather than a
	// quiet success.
	if err := h.RevokeDevice("v1", "typo", true); !errors.Is(err, ErrUnknownDevice) {
		t.Fatalf("err = %v with allowLast, want ErrUnknownDevice", err)
	}
	if err := h.RevokeDevice("nosuchvault", "alfa", true); !errors.Is(err, ErrUnknownDevice) {
		t.Fatalf("err = %v on an unknown vault, want ErrUnknownDevice", err)
	}
	if n := len(ids(t, h, "v1")); n != 1 {
		t.Fatalf("%d devices after three refused revokes, want 1", n)
	}
}

/* ---------------------------------------------------------------- *
 * last_seen
 * ---------------------------------------------------------------- */

func TestSawDeviceMovesLastSeenAndNothingElse(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "alfa", 4242); err != nil {
		t.Fatalf("saw: %v", err)
	}
	d, hash, ok, err := h.DeviceByID("v1", "alfa")
	if err != nil || !ok {
		t.Fatalf("alfa: ok=%v err=%v", ok, err)
	}
	if d.LastSeen != 4242 {
		t.Fatalf("last_seen = %d, want 4242", d.LastSeen)
	}
	if d.ID != "alfa" || d.Name != "laptop" || d.CreatedAt != 1000 || hash != hashA {
		t.Fatalf("SawDevice changed something else: %+v hash %q", d, hash)
	}
	// And nothing on any other device.
	other, otherHash, _, _ := h.DeviceByID("v1", "bravo")
	if other.LastSeen != 0 || other.Name != "phone" || other.CreatedAt != 1001 || otherHash != hashB {
		t.Fatalf("SawDevice on alfa moved bravo: %+v hash %q", other, otherHash)
	}
}

// Rule 8: the number is what gets believed. The clock is the server's, so an
// NTP step or two calls landing out of order is all it takes, and a last_seen
// that goes backwards reads as "that laptop has not been here since Tuesday"
// about a device that was here a minute ago.
func TestSawDeviceNeverMovesLastSeenBackwards(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "alfa", 9000); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "alfa", 5000); err != nil {
		t.Fatalf("a late call is not an error, it is just late: %v", err)
	}
	d, _, _, _ := h.DeviceByID("v1", "alfa")
	if d.LastSeen != 9000 {
		t.Fatalf("last_seen went back to %d, want it held at 9000", d.LastSeen)
	}
	if err := h.SawDevice("v1", "alfa", 9001); err != nil {
		t.Fatal(err)
	}
	if d, _, _, _ := h.DeviceByID("v1", "alfa"); d.LastSeen != 9001 {
		t.Fatalf("last_seen = %d after a later sighting, want 9001", d.LastSeen)
	}
}

// An upsert here would hand a revoked device its row back, which is the one
// thing revocation has to mean. It says so instead, so a session can tell it
// was revoked while connected and stop rather than retry.
func TestSawDeviceOnARevokedDeviceSaysSoAndDoesNotRecreateIt(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}
	if err := h.RevokeDevice("v1", "bravo", false); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "bravo", 7000); !errors.Is(err, ErrUnknownDevice) {
		t.Fatalf("err = %v, want ErrUnknownDevice", err)
	}
	if _, _, ok, _ := h.DeviceByID("v1", "bravo"); ok {
		t.Fatal("SawDevice put a revoked device's row back")
	}
	if got := ids(t, h, "v1"); strings.Join(got, ",") != "alfa" {
		t.Fatalf("devices = %v, want just alfa", got)
	}
}

/* ---------------------------------------------------------------- *
 * Races
 * ---------------------------------------------------------------- */

// Registration and revocation race with live sessions and with each other, and
// the store is opened by more than one process (`basaltd backup` and `basaltd
// purge` run against a live server's directory), so the guarantees have to be
// in the SQL rather than in this process's mutex.

func TestConcurrentRegistrationsOfOneIDProduceOneRow(t *testing.T) {
	h := claimedStore(t)
	const racers = 8
	errs := make([]error, racers)
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = h.RegisterDevice("v1", "contested", "laptop", hashA, int64(1000+i))
		}(i)
	}
	wg.Wait()

	won := 0
	for i, err := range errs {
		switch {
		case err == nil:
			won++
		case errors.Is(err, ErrDeviceExists):
		default:
			t.Fatalf("racer %d: %v, want nil or ErrDeviceExists", i, err)
		}
	}
	if won != 1 {
		t.Fatalf("%d of %d registrations of one id succeeded, want exactly 1", won, racers)
	}
	if got := ids(t, h, "v1"); len(got) != 1 {
		t.Fatalf("devices = %v, want one row", got)
	}
}

// The one that a read followed by a write gets wrong. Two devices revoking each
// other at the same moment both see two rows, both decide they are not the
// last, and both delete: the vault ends with no devices and neither caller was
// told it did that.
//
// Through two Store handles on one directory, because that is the shape the
// guarantee has to survive. writeMu makes a read-then-write atomic within one
// process, which is enough to make a single-handle version of this test pass
// against the broken implementation, and the store is opened by more than one
// process: `basaltd backup` and `basaltd purge` run against a live server's
// directory. The atomicity has to be in the SQL, so the test has to be able to
// see the SQL.
func TestConcurrentRevokesCannotEmptyTheVault(t *testing.T) {
	for attempt := 0; attempt < 20; attempt++ {
		dir := t.TempDir()
		one := openAt(t, dir)
		if err := one.EnsureVault("v1", 1000); err != nil {
			t.Fatal(err)
		}
		if _, err := one.ClaimVault("v1", hash1, wrapped1, 1000); err != nil {
			t.Fatal(err)
		}
		if err := one.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
			t.Fatal(err)
		}
		if err := one.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
			t.Fatal(err)
		}
		two := openAt(t, dir)

		errs := make([]error, 2)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i, r := range []struct {
			h  *harness
			id string
		}{{one, "alfa"}, {two, "bravo"}} {
			wg.Add(1)
			go func(i int, h *harness, id string) {
				defer wg.Done()
				<-start
				errs[i] = h.RevokeDevice("v1", id, false)
			}(i, r.h, r.id)
		}
		close(start)
		wg.Wait()

		survivors := ids(t, one, "v1")
		if len(survivors) != 1 {
			t.Fatalf("attempt %d: %v devices left after two simultaneous revokes, want exactly 1 "+
				"(errors: %v, %v)", attempt, survivors, errs[0], errs[1])
		}
		gone, refused := 0, 0
		for _, err := range errs {
			switch {
			case err == nil:
				gone++
			case errors.Is(err, ErrLastDevice):
				refused++
			default:
				t.Fatalf("attempt %d: %v, want nil or ErrLastDevice", attempt, err)
			}
		}
		if gone != 1 || refused != 1 {
			t.Fatalf("attempt %d: %d revoked and %d refused, want one of each", attempt, gone, refused)
		}
		if err := one.Close(); err != nil {
			t.Fatalf("close: %v", err)
		}
		if err := two.Close(); err != nil {
			t.Fatalf("close: %v", err)
		}
	}
}

// A device being revoked while its session is still calling SawDevice. Neither
// call may resurrect the row or corrupt the other, and -race says so about the
// store's own locking.
func TestRevokingRacesASessionsHeartbeatWithoutResurrectingIt(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			// Either it is still registered or it is not; both are answers.
			if err := h.SawDevice("v1", "bravo", int64(2000+i)); err != nil && !errors.Is(err, ErrUnknownDevice) {
				t.Errorf("saw: %v", err)
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		if err := h.RevokeDevice("v1", "bravo", false); err != nil {
			t.Errorf("revoke: %v", err)
		}
	}()
	wg.Wait()

	if _, _, ok, _ := h.DeviceByID("v1", "bravo"); ok {
		t.Fatal("a heartbeat racing a revoke put the row back")
	}
	if got := ids(t, h, "v1"); strings.Join(got, ",") != "alfa" {
		t.Fatalf("devices = %v, want just alfa", got)
	}
}

/* ---------------------------------------------------------------- *
 * Durability
 * ---------------------------------------------------------------- */

// Device rows are the answer to "every device is lost", so a backup without
// them is a backup that restores a vault nobody can connect to. They are rows
// in the database and VACUUM INTO copies the database, which is why this
// works; checked rather than assumed, the way the wrapped data key is.
func TestDeviceRowsSurviveBackupAndRestore(t *testing.T) {
	h := claimedStore(t)
	h.file(t, "note.md", "content")
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "alfa", 5000); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dest, false); err != nil {
		t.Fatalf("backup: %v", err)
	}
	restored := openAt(t, dest)

	got, err := restored.Devices("v1")
	if err != nil {
		t.Fatalf("devices of the restored store: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("the restored store has %d devices, want 2", len(got))
	}
	if got[0].ID != "alfa" || got[0].Name != "laptop" || got[0].LastSeen != 5000 {
		t.Fatalf("alfa came back as %+v", got[0])
	}
	// The credential too, or every restored device is refused at hello.
	if _, hash, ok, _ := restored.DeviceByID("v1", "bravo"); !ok || hash != hashB {
		t.Fatalf("bravo came back with ok=%v hash=%q", ok, hash)
	}
}

// Rotation retires the root and every invite sealed under it, and must leave
// the device rows alone: device credentials are independent of the root, which
// is what makes rotation stop being a weekend of re-pairing. Rotate already
// sweeps the invites table, and devices is the next table along, so this is
// here to fail if it ever grows a second DELETE.
func TestRotatingAVaultLeavesEveryDeviceRow(t *testing.T) {
	h := claimedStore(t)
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "bravo", "phone", hashB, 1001); err != nil {
		t.Fatal(err)
	}
	if err := h.SawDevice("v1", "alfa", 5000); err != nil {
		t.Fatal(err)
	}
	if err := h.Rotate("v1", hash1, hash2, wrapped2); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if got := ids(t, h, "v1"); strings.Join(got, ",") != "alfa,bravo" {
		t.Fatalf("devices after rotating: %v, want both still there", got)
	}
	d, hash, ok, err := h.DeviceByID("v1", "alfa")
	if err != nil || !ok {
		t.Fatalf("alfa after rotating: ok=%v err=%v", ok, err)
	}
	if hash != hashA || d.LastSeen != 5000 || d.CreatedAt != 1000 {
		t.Fatalf("rotating changed a device row: %+v hash %q", d, hash)
	}
}
