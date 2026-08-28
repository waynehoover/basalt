package server

import (
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/waynehoover/basalt/internal/store"
)

// One secret. The auth key is another branch of the same HKDF schedule that
// produces the content and path keys, so holding the root secret is what it
// means to have the vault. These are the rules that makes true.

const bootstrap = "BOOTSTRAP-TOKEN-FROM-FIRST-RUN"

func authRig(t *testing.T) (*store.Store, Authenticator) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "basalt.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	_ = slog.Default()
	clock := int64(1)
	return st, DerivedAuth(st, bootstrap, func() int64 { clock++; return clock })
}

func TestAnUnclaimedVaultIsOpenedOnlyByTheBootstrapToken(t *testing.T) {
	_, auth := authRig(t)

	if err := auth(Credentials{VaultID: "v", Token: "not-the-bootstrap", Claim: "key"}); err == nil {
		t.Fatal("an unclaimed vault accepted a token that was not the bootstrap")
	}
	if err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: "the-auth-key"}); err != nil {
		t.Fatalf("the bootstrap token did not open an unclaimed vault: %v", err)
	}
}

// The bootstrap is one-time. Leaving it working would mean the printed token
// stayed a credential for the life of the server, which is the second secret
// this exists to remove.
func TestTheBootstrapStopsWorkingOnceTheVaultIsClaimed(t *testing.T) {
	_, auth := authRig(t)
	if err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: "the-auth-key"}); err != nil {
		t.Fatalf("claim: %v", err)
	}

	if err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: "the-auth-key"}); err == nil {
		t.Fatal("the bootstrap token still opens the vault after it was claimed")
	}
	if err := auth(Credentials{VaultID: "v", Token: "the-auth-key"}); err != nil {
		t.Fatalf("the claimed key does not open the vault: %v", err)
	}
	if err := auth(Credentials{VaultID: "v", Token: "some-other-key"}); err == nil {
		t.Fatal("a key that never claimed anything opened the vault")
	}
}

// A second device cannot re-point a claimed vault at its own key, whatever it
// offers, or the first device would be locked out of its own notes.
func TestAClaimedVaultCannotBeReclaimed(t *testing.T) {
	_, auth := authRig(t)
	if err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: "first-key"}); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: "second-key"}); err == nil {
		t.Fatal("a second device re-claimed the vault with the bootstrap")
	}
	if err := auth(Credentials{VaultID: "v", Token: "second-key", Claim: "second-key"}); err == nil {
		t.Fatal("a second device claimed the vault by offering its own key as both")
	}
	if err := auth(Credentials{VaultID: "v", Token: "first-key"}); err != nil {
		t.Fatalf("the original device was locked out: %v", err)
	}
}

// Claiming needs a key to claim with. Accepting the bootstrap alone would leave
// the vault open to the bootstrap for ever, which is the state being left.
func TestClaimingNeedsAKey(t *testing.T) {
	_, auth := authRig(t)
	if err := auth(Credentials{VaultID: "v", Token: bootstrap}); err == nil {
		t.Fatal("the bootstrap opened an unclaimed vault with nothing to bind it to")
	}
}

// The server keeps a hash and never the key. A server that held the credential
// could write to the vault it exists only to keep, and a stolen disk already
// yields every byte of ciphertext without also handing over the ability to add
// to it.
func TestTheServerStoresAHashAndNotTheKey(t *testing.T) {
	st, auth := authRig(t)
	const key = "the-auth-key-a-device-derived"
	if err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: key}); err != nil {
		t.Fatalf("claim: %v", err)
	}

	stored, err := st.AuthHash("v")
	if err != nil {
		t.Fatalf("auth hash: %v", err)
	}
	if stored == key {
		t.Fatal("the server stored the key itself")
	}
	want := sha256.Sum256([]byte(key))
	if stored != hex.EncodeToString(want[:]) {
		t.Fatalf("stored %q, want the hash %q", stored, hex.EncodeToString(want[:]))
	}
}

// Vaults are claimed separately, so one being taken does not open another.
func TestClaimingOneVaultDoesNotClaimAnother(t *testing.T) {
	_, auth := authRig(t)
	if err := auth(Credentials{VaultID: "one", Token: bootstrap, Claim: "key-one"}); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := auth(Credentials{VaultID: "two", Token: "key-one"}); err == nil {
		t.Fatal("one vault's key opened another")
	}
	if err := auth(Credentials{VaultID: "two", Token: bootstrap, Claim: "key-two"}); err != nil {
		t.Fatalf("the second vault could not be claimed: %v", err)
	}
}
