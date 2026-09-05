package store

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

// I5 and I23 at the store: the wrapped data key and the invites table, and that
// both travel in a backup because they are rows in the database.

const (
	wrapped1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	wrapped2 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	sealed1  = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
	hash1    = "0000000000000000000000000000000000000000000000000000000000000001"
	hash2    = "0000000000000000000000000000000000000000000000000000000000000002"
	hash3    = "0000000000000000000000000000000000000000000000000000000000000003"
	// A device's auth hash, the same shape as a vault's because it is the same
	// thing per device: a digest of a key the server never holds.
	devHash1 = "00000000000000000000000000000000000000000000000000000000000000a1"
	devHash2 = "00000000000000000000000000000000000000000000000000000000000000a2"
	wrapped3 = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCD"
)

func TestI5ClaimStoresHashAndWrappedTogether(t *testing.T) {
	h := newTestStore(t)
	ok, err := h.ClaimVault("v1", hash1, wrapped1, 1)
	if err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	if got, _ := h.Wrapped("v1"); got != wrapped1 {
		t.Fatalf("wrapped = %q", got)
	}
	if got, _ := h.AuthHash("v1"); got != hash1 {
		t.Fatalf("hash = %q", got)
	}
	// A second claim changes neither.
	if ok, _ := h.ClaimVault("v1", hash2, wrapped2, 2); ok {
		t.Fatal("a claimed vault was claimed again")
	}
	if got, _ := h.Wrapped("v1"); got != wrapped1 {
		t.Fatalf("a refused claim changed wrapped to %q", got)
	}
	// A malformed blob is refused before anything is written.
	if _, err := h.ClaimVault("v2", hash1, "not base64!", 1); !errors.Is(err, ErrBadEntry) {
		t.Fatalf("err = %v, want ErrBadEntry", err)
	}
	if got, _ := h.AuthHash("v2"); got != "" {
		t.Fatal("a refused claim bound the vault anyway")
	}
	// A vault with no wrapped key reads as empty, not as an error.
	if got, err := h.Wrapped("never-claimed"); err != nil || got != "" {
		t.Fatalf("wrapped of an unknown vault = %q, %v", got, err)
	}
}

func TestI5RotateSwapsBothOrNeither(t *testing.T) {
	h := newTestStore(t)
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.Rotate("v1", hash1, hash2, wrapped2); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	gotHash, _ := h.AuthHash("v1")
	gotWrapped, _ := h.Wrapped("v1")
	if gotHash != hash2 || gotWrapped != wrapped2 {
		t.Fatalf("after rotate hash=%q wrapped=%q", gotHash, gotWrapped)
	}

	// Unclaimed: refused.
	if err := h.Rotate("v3", hash1, hash2, wrapped2); !errors.Is(err, ErrUnknownVault) {
		t.Fatalf("err = %v, want ErrUnknownVault", err)
	}
	// Malformed: refused.
	if err := h.Rotate("v1", hash2, hash1, "nope!"); !errors.Is(err, ErrBadEntry) {
		t.Fatalf("err = %v, want ErrBadEntry", err)
	}
}

// The wrapped key is a row in the database, so a backup carries it and a
// restore hands it to every device. Checked rather than assumed, because a
// backup without it is one every device would find unopenable.
func TestI5TheWrappedKeySurvivesBackupAndRestore(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dest, false); err != nil {
		t.Fatalf("backup: %v", err)
	}
	restored := openAt(t, dest)
	if got, err := restored.Wrapped("v1"); err != nil || got != wrapped1 {
		t.Fatalf("the restored store has wrapped %q, %v", got, err)
	}
	if got, _ := restored.AuthHash("v1"); got != hash1 {
		t.Fatalf("the restored store has hash %q", got)
	}
}

func TestI23InvitesAreSingleUseAndExpire(t *testing.T) {
	h := newTestStore(t)
	// Unclaimed: nothing to invite to.
	if err := h.AddInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", sealed1, 2000, 1000); !errors.Is(err, ErrUnknownVault) {
		t.Fatalf("err = %v, want ErrUnknownVault", err)
	}
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.AddInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", sealed1, 2000, 1000); err != nil {
		t.Fatalf("add: %v", err)
	}
	// Expiry in the past is refused at insert.
	if err := h.AddInvite("v1", "BBBBBBBBBBBBBBBBBBBBBB", sealed1, 500, 1000); !errors.Is(err, ErrBadEntry) {
		t.Fatalf("err = %v, want ErrBadEntry", err)
	}
	// Redeem once, which registers the device that redeemed it.
	sealed, err := h.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "dev-one", "one", devHash1, 0, 1500)
	if err != nil || sealed != sealed1 {
		t.Fatalf("redeem: %q %v", sealed, err)
	}
	if ds, err := h.Devices("v1"); err != nil || len(ds) != 1 || ds[0].ID != "dev-one" {
		t.Fatalf("the redemption registered %v, %v", ds, err)
	}
	if _, err := h.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "dev-two", "two", devHash2, 0, 1500); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("an invite was redeemed twice: %v", err)
	}
	// Expired: refused, and unknown and malformed look the same.
	if err := h.AddInvite("v1", "CCCCCCCCCCCCCCCCCCCCCC", sealed1, 2000, 1000); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		what, invite string
		now          int64
	}{
		{"expired", "CCCCCCCCCCCCCCCCCCCCCC", 2001},
		{"unknown", "DDDDDDDDDDDDDDDDDDDDDD", 1500},
		{"malformed", "not base64!", 1500},
	} {
		if _, err := h.RedeemInviteFor("v1", c.invite, "dev-two", "two", devHash2, 0, c.now); !errors.Is(err, ErrNoInvite) {
			t.Fatalf("an %s invite was answered %v, want ErrNoInvite", c.what, err)
		}
	}
	// Another vault's invite does not open this one.
	if _, err := h.ClaimVault("v2", hash2, wrapped2, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.AddInvite("v2", "EEEEEEEEEEEEEEEEEEEEEE", sealed1, 5000, 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := h.RedeemInviteFor("v1", "EEEEEEEEEEEEEEEEEEEEEE", "dev-two", "two", devHash2, 0, 1500); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("an invite was redeemed against the wrong vault: %v", err)
	}
	// Not one of the refusals wrote a row, and none of them spent the invite
	// on v2 either: a redemption is both halves or neither.
	if ds, _ := h.Devices("v1"); len(ds) != 1 {
		t.Fatalf("a refused redemption registered a device: %v", ds)
	}
	if n, _ := h.OutstandingInvites("v2", 1500); n != 1 {
		t.Fatalf("%d outstanding invites on v2, want the one that was issued", n)
	}
}

// Invites lists what could still be redeemed, in a stable order, and carries
// nothing that would let a reader redeem one.
//
// The listing type has an identifier and an expiry and no sealed blob, which
// is the property and not an accident of what this test asks for: an invite is
// a standing authority to register a device, and a list type with the blob in
// it hands the blob to everything that ever serialises it.
func TestInvitesListsWhatCanStillBeRedeemed(t *testing.T) {
	h := newTestStore(t)
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatal(err)
	}
	if got, err := h.Invites("v1", 1000); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("a vault with no invites answered %#v, %v; never nil", got, err)
	}
	// Issued out of expiry order, so the ordering is the function's rather
	// than the insertion's.
	for _, c := range []struct {
		id      string
		expires int64
	}{
		{"CCCCCCCCCCCCCCCCCCCCCC", 9000},
		{"AAAAAAAAAAAAAAAAAAAAAA", 3000},
		{"BBBBBBBBBBBBBBBBBBBBBB", 6000},
	} {
		if err := h.AddInvite("v1", c.id, sealed1, c.expires, 1000); err != nil {
			t.Fatal(err)
		}
	}
	got, err := h.Invites("v1", 1000)
	if err != nil {
		t.Fatal(err)
	}
	want := []Invite{
		{ID: "AAAAAAAAAAAAAAAAAAAAAA", ExpiresAt: 3000},
		{ID: "BBBBBBBBBBBBBBBBBBBBBB", ExpiresAt: 6000},
		{ID: "CCCCCCCCCCCCCCCCCCCCCC", ExpiresAt: 9000},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Invites = %+v, want %+v, soonest to expire first", got, want)
	}

	// Spent and expired are not outstanding: a list that showed either would
	// be showing strings that no longer work.
	if _, err := h.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "dev-one", "one", devHash1, 0, 1500); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	got, _ = h.Invites("v1", 6500)
	if len(got) != 1 || got[0].ID != "CCCCCCCCCCCCCCCCCCCCCC" {
		t.Fatalf("after a redemption and an expiry: %+v", got)
	}
	// Another vault's invites are not this one's.
	if _, err := h.ClaimVault("v2", hash2, wrapped2, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.AddInvite("v2", "DDDDDDDDDDDDDDDDDDDDDD", sealed1, 9000, 1000); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.Invites("v1", 1000); len(got) != 2 {
		t.Fatalf("v1 shows %+v, which includes another vault's", got)
	}
}

// Cancelling an invite retires the string somebody is holding, before it
// expires and without rotating the vault, which would retire the recovery key
// with it.
//
// Unknown, expired, already redeemed and malformed are one error, the same
// ErrNoInvite a redemption gets and for the same reason: saying which would
// tell somebody guessing identifiers that they had found a real one.
func TestCancellingAnInviteRetiresTheString(t *testing.T) {
	h := newTestStore(t)
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.AddInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", sealed1, 9000, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.CancelInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", 1500); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if got, _ := h.Invites("v1", 1500); len(got) != 0 {
		t.Fatalf("a cancelled invite is still outstanding: %+v", got)
	}
	// The row is gone, not marked: cancelled and spent are different facts.
	if n, _ := h.InviteRows("v1"); n != 0 {
		t.Fatalf("%d invite rows after a cancel, want the row gone", n)
	}
	// And it no longer redeems, which is the whole point.
	if _, err := h.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "dev-one", "one", devHash1, 0, 1500); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("a cancelled invite redeemed: %v", err)
	}
	if ds, _ := h.Devices("v1"); len(ds) != 0 {
		t.Fatalf("a cancelled invite registered a device: %v", ds)
	}

	// The four that are one refusal.
	if err := h.AddInvite("v1", "BBBBBBBBBBBBBBBBBBBBBB", sealed1, 2000, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.AddInvite("v1", "CCCCCCCCCCCCCCCCCCCCCC", sealed1, 9000, 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := h.RedeemInviteFor("v1", "CCCCCCCCCCCCCCCCCCCCCC", "dev-two", "two", devHash2, 0, 1500); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	for _, c := range []struct {
		what, invite string
		now          int64
	}{
		{"cancelled twice", "AAAAAAAAAAAAAAAAAAAAAA", 1500},
		{"expired", "BBBBBBBBBBBBBBBBBBBBBB", 2001},
		{"already redeemed", "CCCCCCCCCCCCCCCCCCCCCC", 1500},
		{"unknown", "DDDDDDDDDDDDDDDDDDDDDD", 1500},
		{"malformed", "not base64!", 1500},
	} {
		if err := h.CancelInvite("v1", c.invite, c.now); !errors.Is(err, ErrNoInvite) {
			t.Fatalf("cancelling an %s invite answered %v, want ErrNoInvite", c.what, err)
		}
	}
	// A cancel names its own vault: another vault's invite is not this one's
	// to retire.
	if _, err := h.ClaimVault("v2", hash2, wrapped2, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.AddInvite("v2", "EEEEEEEEEEEEEEEEEEEEEE", sealed1, 9000, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.CancelInvite("v1", "EEEEEEEEEEEEEEEEEEEEEE", 1500); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("a vault cancelled another vault's invite: %v", err)
	}
	if n, _ := h.OutstandingInvites("v2", 1500); n != 1 {
		t.Fatalf("%d outstanding invites on v2, want the one that was issued", n)
	}
}

// Expired rows are swept lazily, whenever an invite is added to the vault.
func TestI23ExpiredInvitesAreSweptAtInsert(t *testing.T) {
	h := newTestStore(t)
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatal(err)
	}
	for i, id := range []string{"AAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCCCCCCCC"} {
		if err := h.AddInvite("v1", id, sealed1, int64(2000+i), 1000); err != nil {
			t.Fatal(err)
		}
	}
	if n, _ := h.InviteRows("v1"); n != 3 {
		t.Fatalf("%d rows, want 3", n)
	}
	// Time passes; the next insert sweeps the three expired ones.
	if err := h.AddInvite("v1", "DDDDDDDDDDDDDDDDDDDDDD", sealed1, 9000, 5000); err != nil {
		t.Fatal(err)
	}
	if n, _ := h.InviteRows("v1"); n != 1 {
		t.Fatalf("%d rows after the sweep, want 1", n)
	}
	if n, _ := h.OutstandingInvites("v1", 5000); n != 1 {
		t.Fatalf("%d outstanding, want 1", n)
	}
}

// The invites table travels in the backup, because it is in the database. An
// invite issued before a backup is redeemable from the restored store.
func TestI23InvitesTravelInTheBackup(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "note.md", "content")
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.AddInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", sealed1, 9000, 1000); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "backup")
	if _, err := h.Backup(dest, false); err != nil {
		t.Fatalf("backup: %v", err)
	}
	restored := openAt(t, dest)
	sealed, err := restored.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "dev-one", "one", devHash1, 0, 2000)
	if err != nil || sealed != sealed1 {
		t.Fatalf("redeem from the restored store: %q %v", sealed, err)
	}
	// And the device row it wrote is in the restored store too, because the
	// two halves are one transaction wherever the database is.
	if ds, _ := restored.Devices("v1"); len(ds) != 1 || ds[0].ID != "dev-one" {
		t.Fatalf("the restored store has devices %v", ds)
	}
}

// Rotation is a compare-and-swap against the hash the caller authenticated
// under, so two devices connected under one root cannot both rotate.
//
// The old condition was `auth_hash != ”`, which any claimed vault meets. Both
// callers here would have succeeded under it, and the vault would have ended up
// with whichever hash was written last, which is how a device that was being
// revoked came to own the vault.
func TestRotateIsACompareAndSwapAgainstTheCallersHash(t *testing.T) {
	h := newTestStore(t)
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatal(err)
	}

	// Both devices hold hash1 and both rotate. Started together, so which one
	// reaches the write lock first is the operating system's choice.
	type attempt struct {
		hash, wrapped string
		err           error
	}
	results := make(chan attempt, 2)
	start := make(chan struct{})
	for _, a := range []attempt{{hash2, wrapped2, nil}, {hash3, wrapped3, nil}} {
		go func(a attempt) {
			<-start
			a.err = h.Rotate("v1", hash1, a.hash, a.wrapped)
			results <- a
		}(a)
	}
	close(start)

	var winners, losers int
	var won attempt
	for range 2 {
		a := <-results
		switch {
		case a.err == nil:
			winners++
			won = a
		case errors.Is(a.err, ErrRotated):
			losers++
		default:
			t.Fatalf("rotating to %s failed with %v, want nil or ErrRotated", a.hash, a.err)
		}
	}
	if winners != 1 || losers != 1 {
		t.Fatalf("%d rotations succeeded and %d were refused, want one of each", winners, losers)
	}

	// And the row is the winner's, both columns, with the generation moved once.
	gotHash, _ := h.AuthHash("v1")
	gotWrapped, _ := h.Wrapped("v1")
	if gotHash != won.hash || gotWrapped != won.wrapped {
		t.Fatalf("the vault holds hash=%q wrapped=%q, and %q won", gotHash, gotWrapped, won.hash)
	}
	if n, err := h.Rotations("v1"); err != nil || n != 1 {
		t.Fatalf("rotations = %d, %v, want 1", n, err)
	}

	// The loser retrying with the same stale hash is refused again, for ever:
	// it is not the vault's credential any more.
	if err := h.Rotate("v1", hash1, hash2, wrapped2); !errors.Is(err, ErrRotated) {
		t.Fatalf("err = %v, want ErrRotated", err)
	}
}

// The generation moves with the credential and only with it, so a session can
// tell a vault that was rotated under it from one that was not.
func TestRotationsCountsRotationsAndNothingElse(t *testing.T) {
	h := newTestStore(t)
	if n, err := h.Rotations("never-claimed"); err != nil || n != 0 {
		t.Fatalf("an unknown vault has generation %d, %v", n, err)
	}
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatal(err)
	}
	if n, _ := h.Rotations("v1"); n != 0 {
		t.Fatalf("claiming moved the generation to %d", n)
	}
	if err := h.Rotate("v1", hash1, hash2, wrapped2); err != nil {
		t.Fatal(err)
	}
	if err := h.Rotate("v1", hash2, hash3, wrapped3); err != nil {
		t.Fatal(err)
	}
	if n, _ := h.Rotations("v1"); n != 2 {
		t.Fatalf("after two rotations the generation is %d", n)
	}
	// A refused rotation does not move it.
	if err := h.Rotate("v1", hash1, hash2, wrapped2); !errors.Is(err, ErrRotated) {
		t.Fatalf("err = %v, want ErrRotated", err)
	}
	if n, _ := h.Rotations("v1"); n != 2 {
		t.Fatalf("a refused rotation moved the generation to %d", n)
	}
	// VaultKeys reads all three from one row.
	hash, wrapped, gen, err := h.VaultKeys("v1")
	if err != nil || hash != hash3 || wrapped != wrapped3 || gen != 2 {
		t.Fatalf("VaultKeys = %q %q %d, %v", hash, wrapped, gen, err)
	}
}

// The base64url shape check, which is what stands between a client bug and a
// wrapped key, a sealed secret or an invite identifier nothing can decode.
//
// It used to allow "=" anywhere in the last two positions, so "ab=c" passed:
// padding is the end of a base64 string, not a character that may appear near
// it. Nothing here is ever decoded by the server, so this cost nothing today;
// it is a shape check, and one that admits a shape no encoder produces is not
// doing its job.
func TestValidBase64URLTakesPaddingOnlyAtTheEnd(t *testing.T) {
	good := []string{"abc", "ab-_", "abc=", "ab==", "abcd", "a==", "ab="}
	for _, s := range good {
		if !validBase64URL(s, 80) {
			t.Errorf("%q was refused and is base64url", s)
		}
	}
	bad := []string{"", "ab=c", "a=bc", "a=b", "===a", "ab=_", "ab c", "ab+c", "ab/c", "ab==x"}
	for _, s := range bad {
		if validBase64URL(s, 80) {
			t.Errorf("%q was accepted and is not base64url", s)
		}
	}
	if validBase64URL("aaaa", 3) {
		t.Error("a string over the maximum was accepted")
	}
	// And through the three callers, which differ only in their ceiling.
	if ValidWrapped("ab=c") || ValidSealed("ab=c") || ValidInvite("ab=c") {
		t.Error("padding in the middle passed one of the named checks")
	}
}

/* ---------------------------------------------------------------- *
 * Spending an invite and registering a device are one commit
 * ---------------------------------------------------------------- */

// A crash between spending the invite and writing the row spends neither.
//
// This is the partial state RedeemInviteFor exists to make unreachable, and
// it has two bad halves. An invite spent with no row behind it is a string
// that stopped working and a device that was never added, and the only sign of
// it is somebody's phone failing to pair with an invite they watched being
// made. A row under an invite still marked live is a device registered twice
// over by a string that was supposed to work once.
//
// Injected rather than timed: the window is a few microseconds wide and a test
// that tried to hit it by racing would be a test that passes when the machine
// is busy. An error returned from inside the transaction is what a process
// dying there leaves behind, because SQLite rolls an uncommitted transaction
// back either way.
func TestACrashBetweenSpendingAnInviteAndRegisteringSpendsNeither(t *testing.T) {
	h := newTestStore(t)
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.AddInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", sealed1, 9000, 1000); err != nil {
		t.Fatal(err)
	}

	boom := errors.New("the power went off here")
	betweenSpendAndRegister = func() error { return boom }
	_, err := h.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "dev-one", "one", devHash1, 0, 1500)
	betweenSpendAndRegister = nil
	if !errors.Is(err, boom) {
		t.Fatalf("the redemption returned %v, want the injected failure", err)
	}

	// Neither half happened.
	if ds, _ := h.Devices("v1"); len(ds) != 0 {
		t.Fatalf("a device was registered under an invite that was not spent: %v", ds)
	}
	if n, _ := h.OutstandingInvites("v1", 1500); n != 1 {
		t.Fatalf("%d outstanding invites, want the one that was issued: the invite was spent "+
			"with nothing to show for it", n)
	}
	// And the same string still works, which is what makes the crash cost
	// nothing but a retry.
	sealed, err := h.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "dev-one", "one", devHash1, 0, 1500)
	if err != nil || sealed != sealed1 {
		t.Fatalf("the invite did not survive the crash: %q %v", sealed, err)
	}
	if ids := ids(t, h, "v1"); len(ids) != 1 || ids[0] != "dev-one" {
		t.Fatalf("devices after the retry: %v", ids)
	}
}

// A redeem racing a revoke never leaves the vault with no devices, and never
// leaves one half of a redemption behind.
//
// The two orderings are both legal and both fine, which is the point: if the
// revoke commits first it is refused for being the last device and the redeem
// then adds one, and if the redeem commits first there are two and the revoke
// takes one away. What must never happen is an empty vault, reachable only by
// a recovery key nobody was told they now need, or an invite spent with no
// device to show for it.
//
// Two handles, because the guarantee has to be in the SQL rather than in
// writeMu: `basaltd backup` and `basaltd purge` run against a live server's
// directory, so the store is opened by more than one process.
func TestARedeemRacingARevokeLeavesTheVaultConsistent(t *testing.T) {
	for attempt := 0; attempt < 20; attempt++ {
		dir := t.TempDir()
		one := openAt(t, dir)
		if _, err := one.ClaimVault("v1", hash1, wrapped1, 1000); err != nil {
			t.Fatal(err)
		}
		if err := one.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
			t.Fatal(err)
		}
		if err := one.AddInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", sealed1, 9000, 1000); err != nil {
			t.Fatal(err)
		}
		two := openAt(t, dir)

		var redeemErr, revokeErr error
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, redeemErr = one.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "bravo", "phone", hashB, 0, 2000)
		}()
		go func() {
			defer wg.Done()
			<-start
			revokeErr = two.RevokeDevice("v1", "alfa", "", false)
		}()
		close(start)
		wg.Wait()

		left := ids(t, one, "v1")
		if len(left) == 0 {
			t.Fatalf("attempt %d: the vault has no devices at all, reachable only by its recovery "+
				"key (redeem: %v, revoke: %v)", attempt, redeemErr, revokeErr)
		}
		// The redemption is both halves or neither, whichever way it landed.
		registered := false
		for _, id := range left {
			registered = registered || id == "bravo"
		}
		outstanding, _ := one.OutstandingInvites("v1", 2000)
		switch {
		case redeemErr == nil && (!registered || outstanding != 0):
			t.Fatalf("attempt %d: a redemption reported success with devices %v and %d invites left",
				attempt, left, outstanding)
		case redeemErr != nil && (registered || outstanding != 1):
			t.Fatalf("attempt %d: a refused redemption left devices %v and %d invites (%v)",
				attempt, left, outstanding, redeemErr)
		}
		if revokeErr != nil && !errors.Is(revokeErr, ErrLastDevice) {
			t.Fatalf("attempt %d: the revoke failed with %v", attempt, revokeErr)
		}
	}
}

// A redeem racing a rotation cannot outlive it.
//
// Rotation is the answer to a leaked recovery key, and it deliberately leaves
// device rows alone, so anything that can register a device after one is
// permanent access to a vault somebody thought they had taken back. For the
// registrar path the guard is the vault hash inside the insert. For an invite
// it is one table over: rotation deletes every invite on the vault in the same
// transaction that swaps the credential, so an invite issued before a rotation
// cannot be redeemed after one, and the two are never both true.
func TestARedeemRacingARotationCannotWin(t *testing.T) {
	for attempt := 0; attempt < 20; attempt++ {
		dir := t.TempDir()
		one := openAt(t, dir)
		if _, err := one.ClaimVault("v1", hash1, wrapped1, 1000); err != nil {
			t.Fatal(err)
		}
		if err := one.AddInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", sealed1, 9000, 1000); err != nil {
			t.Fatal(err)
		}
		two := openAt(t, dir)

		var redeemErr, rotateErr error
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, redeemErr = one.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "bravo", "phone", hashB, 0, 2000)
		}()
		go func() {
			defer wg.Done()
			<-start
			rotateErr = two.Rotate("v1", hash1, hash2, wrapped2)
		}()
		close(start)
		wg.Wait()
		if rotateErr != nil {
			t.Fatalf("attempt %d: the rotation failed with %v", attempt, rotateErr)
		}

		// Whichever way it landed, the invite is gone and the device exists
		// only if the redemption said so.
		if n, _ := one.InviteRows("v1"); n != 0 {
			t.Fatalf("attempt %d: %d invite rows survived the rotation", attempt, n)
		}
		_, _, registered, err := one.DeviceByID("v1", "bravo")
		if err != nil {
			t.Fatal(err)
		}
		if registered != (redeemErr == nil) {
			t.Fatalf("attempt %d: the row exists=%v and the redemption returned %v", attempt, registered, redeemErr)
		}
		if redeemErr != nil && !errors.Is(redeemErr, ErrNoInvite) {
			t.Fatalf("attempt %d: the redemption was refused with %v, want ErrNoInvite", attempt, redeemErr)
		}
		// And after the rotation the string is dead for good.
		if _, err := one.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "charlie", "tablet", hashC, 0, 2001); !errors.Is(err, ErrNoInvite) {
			t.Fatalf("attempt %d: an invite issued before the rotation still redeems: %v", attempt, err)
		}
	}
}

// An invite is not a way past the device cap.
//
// The cap is what stops a vault's list of devices becoming a list nobody
// reads, and a second way to register that did not check it would be the cap
// applying to whichever path somebody happened to use.
func TestAnInviteCannotExceedTheDeviceCap(t *testing.T) {
	h := newTestStore(t)
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1000); err != nil {
		t.Fatal(err)
	}
	const cap = 3
	for i := 0; i < cap; i++ {
		id := fmt.Sprintf("seated-%d", i)
		if err := h.Store.RegisterDevice("v1", id, id, hashA, hash1, cap, int64(1000+i)); err != nil {
			t.Fatalf("seeding: %v", err)
		}
	}
	if err := h.AddInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", sealed1, 9000, 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := h.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "bravo", "phone", hashB, cap, 2000); !errors.Is(err, ErrDeviceLimit) {
		t.Fatalf("a redemption onto a full vault returned %v, want ErrDeviceLimit", err)
	}
	if n := len(ids(t, h, "v1")); n != cap {
		t.Fatalf("%d devices, want the cap %d", n, cap)
	}
	// Refused, and so not spent: revoking something makes room and the same
	// string works.
	if err := h.RevokeDevice("v1", "seated-0", "", false); err != nil {
		t.Fatal(err)
	}
	if _, err := h.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "bravo", "phone", hashB, cap, 2001); err != nil {
		t.Fatalf("the invite did not survive being refused for the cap: %v", err)
	}
}

// An unclaimed vault has no invites, so a redemption against one is the same
// refusal an unknown invite gets.
func TestAnUnclaimedVaultHasNothingToRedeem(t *testing.T) {
	h := newTestStore(t)
	if _, err := h.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "bravo", "phone", hashB, 0, 1000); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("redeeming against an unclaimed vault returned %v, want ErrNoInvite", err)
	}
}

// A redemption that names a device the vault already holds is refused and
// changes nothing, including the invite.
//
// Refused rather than treated as the registration having happened, which is
// what `register` does for a repeated id with the same key. The two are
// different callers: a conversion retries a registration it may already have
// made, and a redeemer chooses a fresh id every time, so an id already there
// is somebody else's device and the answer is to pick another and redeem
// again. Which the invite, still unspent, allows.
func TestARedemptionOntoAnExistingIdChangesNothing(t *testing.T) {
	h := newTestStore(t)
	if _, err := h.ClaimVault("v1", hash1, wrapped1, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "alfa", "laptop", hashA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.AddInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", sealed1, 9000, 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := h.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "alfa", "impostor", hashB, 0, 2000); !errors.Is(err, ErrDeviceExists) {
		t.Fatalf("a redemption onto an existing id returned %v, want ErrDeviceExists", err)
	}
	_, hash, ok, err := h.DeviceByID("v1", "alfa")
	if err != nil || !ok || hash != hashA {
		t.Fatalf("the existing row was changed: ok=%v hash=%q err=%v", ok, hash, err)
	}
	if ds, _ := h.Devices("v1"); len(ds) != 1 || ds[0].Name != "laptop" {
		t.Fatalf("the existing row was overwritten: %v", ds)
	}
	if n, _ := h.OutstandingInvites("v1", 2000); n != 1 {
		t.Fatalf("%d outstanding invites after a refused redemption, want 1", n)
	}
}

// Eight devices redeeming one invite at the same moment, which is the claim
// the whole design of an invite rests on.
//
// Single use is proven sequentially by TestI23InvitesAreSingleUseAndExpire and
// at the wire by TestI23AnInviteIsRedeemedExactlyOnce, and both redeem one
// after the other: what they see is a second attempt meeting used = 1. The
// property neither can see is the one the comment on spendInviteTx claims,
// that the read and the mark are one statement, so eight callers cannot all
// find a live invite and all spend it. An invite is the authority to register
// exactly one device, and two of them getting through is a device the vault's
// owner never admitted.
//
// Through eight Store handles on one directory rather than one, for the reason
// TestConcurrentRevokesCannotEmptyTheVault gives: writeMu makes a read then a
// write atomic within one process, so a single-handle version of this passes
// against an implementation that reads the invite and then marks it. The store
// is opened by more than one process in earnest anyway, since `basaltd backup`
// and `basaltd purge` run against a live server's directory.
//
// Checked to fail rather than assumed to: with spendInviteTx's UPDATE ...
// RETURNING split into a SELECT and an UPDATE, the racers no longer agree and
// this reports it on the first attempt.
func TestConcurrentRedemptionsOfOneInviteRegisterExactlyOneDevice(t *testing.T) {
	const racers = 8
	for attempt := 0; attempt < 20; attempt++ {
		dir := t.TempDir()
		one := openAt(t, dir)
		if _, err := one.ClaimVault("v1", hash1, wrapped1, 1000); err != nil {
			t.Fatal(err)
		}
		if err := one.AddInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", sealed1, 9000, 1000); err != nil {
			t.Fatal(err)
		}
		hands := make([]*harness, racers)
		for i := range hands {
			hands[i] = openAt(t, dir)
		}

		sealed := make([]string, racers)
		errs := make([]error, racers)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i := 0; i < racers; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				id := fmt.Sprintf("racer-%d", i)
				<-start
				sealed[i], errs[i] = hands[i].RedeemInviteFor(
					"v1", "AAAAAAAAAAAAAAAAAAAAAA", id, id, fmt.Sprintf("%064x", i), 0, 2000)
			}(i)
		}
		close(start)
		wg.Wait()

		won, winner := 0, -1
		for i, err := range errs {
			switch {
			case err == nil:
				won++
				winner = i
			case errors.Is(err, ErrNoInvite):
			default:
				t.Fatalf("attempt %d: racer %d got %v, want nil or ErrNoInvite", attempt, i, err)
			}
		}
		if won != 1 {
			t.Fatalf("attempt %d: %d of %d racers redeemed one invite, want exactly 1 (%v)",
				attempt, won, racers, errs)
		}
		if sealed[winner] != sealed1 {
			t.Fatalf("attempt %d: the winner was handed %q", attempt, sealed[winner])
		}
		// One row, and it is the winner's. A redemption is both halves or
		// neither, so a loser must not have left a device behind either.
		got := ids(t, one, "v1")
		if len(got) != 1 || got[0] != fmt.Sprintf("racer-%d", winner) {
			t.Fatalf("attempt %d: devices %v after racer %d won", attempt, got, winner)
		}
		if _, hash, ok, err := one.DeviceByID("v1", got[0]); err != nil || !ok ||
			hash != fmt.Sprintf("%064x", winner) {
			t.Fatalf("attempt %d: the row holds hash %q, not the winner's", attempt, hash)
		}
		// Spent, and spent once: nothing may redeem it afterwards either.
		if n, err := one.OutstandingInvites("v1", 2000); err != nil || n != 0 {
			t.Fatalf("attempt %d: %d invites still outstanding (%v)", attempt, n, err)
		}
		if _, err := one.RedeemInviteFor("v1", "AAAAAAAAAAAAAAAAAAAAAA", "latecomer", "late",
			devHash1, 0, 2001); !errors.Is(err, ErrNoInvite) {
			t.Fatalf("attempt %d: the invite redeemed again afterwards: %v", attempt, err)
		}

		one.Close()
		for _, h := range hands {
			h.Close()
		}
	}
}
