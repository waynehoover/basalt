package store

import (
	"errors"
	"path/filepath"
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
	// Redeem once.
	sealed, ok, err := h.RedeemInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", 1500)
	if err != nil || !ok || sealed != sealed1 {
		t.Fatalf("redeem: %q %v %v", sealed, ok, err)
	}
	if _, ok, _ := h.RedeemInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", 1500); ok {
		t.Fatal("an invite was redeemed twice")
	}
	// Expired: refused, and unknown looks the same.
	if err := h.AddInvite("v1", "CCCCCCCCCCCCCCCCCCCCCC", sealed1, 2000, 1000); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := h.RedeemInvite("v1", "CCCCCCCCCCCCCCCCCCCCCC", 2001); ok {
		t.Fatal("an expired invite was redeemed")
	}
	if _, ok, _ := h.RedeemInvite("v1", "DDDDDDDDDDDDDDDDDDDDDD", 1500); ok {
		t.Fatal("an unknown invite was redeemed")
	}
	// Another vault's invite does not open this one.
	if _, err := h.ClaimVault("v2", hash2, wrapped2, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.AddInvite("v2", "EEEEEEEEEEEEEEEEEEEEEE", sealed1, 5000, 1000); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := h.RedeemInvite("v1", "EEEEEEEEEEEEEEEEEEEEEE", 1500); ok {
		t.Fatal("an invite was redeemed against the wrong vault")
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
	sealed, ok, err := restored.RedeemInvite("v1", "AAAAAAAAAAAAAAAAAAAAAA", 2000)
	if err != nil || !ok || sealed != sealed1 {
		t.Fatalf("redeem from the restored store: %q %v %v", sealed, ok, err)
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
