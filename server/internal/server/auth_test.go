package server

import (
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/basalt-sync/server/internal/store"
)

// One secret. The auth key is another branch of the same HKDF schedule that
// produces the content and path keys, so holding the root secret is what it
// means to have the vault. These are the rules that makes true.

const bootstrap = "BOOTSTRAP-TOKEN-FROM-FIRST-RUN"

// As long as a real derived key, which is 43 characters of base64url.
const longKey = "a-derived-auth-key-of-a-realistic-length-01"

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
	return st, DerivedAuth(st, "v", bootstrap, func() int64 { clock++; return clock })
}

func TestAnUnclaimedVaultIsOpenedOnlyByTheBootstrapToken(t *testing.T) {
	_, auth := authRig(t)

	if _, err := auth(Credentials{VaultID: "v", Token: "not-the-bootstrap", Claim: longKey, Wrapped: testWrapped}); err == nil {
		t.Fatal("an unclaimed vault accepted a token that was not the bootstrap")
	}
	if _, err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: longKey, Wrapped: testWrapped}); err != nil {
		t.Fatalf("the bootstrap token did not open an unclaimed vault: %v", err)
	}
}

// The bootstrap is one-time. Leaving it working would mean the printed token
// stayed a credential for the life of the server, which is the second secret
// this exists to remove.
func TestTheBootstrapStopsWorkingOnceTheVaultIsClaimed(t *testing.T) {
	_, auth := authRig(t)
	if _, err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: longKey, Wrapped: testWrapped}); err != nil {
		t.Fatalf("claim: %v", err)
	}

	if _, err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: longKey, Wrapped: testWrapped}); err == nil {
		t.Fatal("the bootstrap token still opens the vault after it was claimed")
	}
	if _, err := auth(Credentials{VaultID: "v", Token: longKey}); err != nil {
		t.Fatalf("the claimed key does not open the vault: %v", err)
	}
	if _, err := auth(Credentials{VaultID: "v", Token: longKey + "-other"}); err == nil {
		t.Fatal("a key that never claimed anything opened the vault")
	}
}

// A second device cannot re-point a claimed vault at its own key, whatever it
// offers, or the first device would be locked out of its own notes.
func TestAClaimedVaultCannotBeReclaimed(t *testing.T) {
	_, auth := authRig(t)
	if _, err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: longKey, Wrapped: testWrapped}); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if _, err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: longKey + "-two", Wrapped: testWrapped}); err == nil {
		t.Fatal("a second device re-claimed the vault with the bootstrap")
	}
	if _, err := auth(Credentials{VaultID: "v", Token: longKey + "-two", Claim: longKey + "-two", Wrapped: testWrapped}); err == nil {
		t.Fatal("a second device claimed the vault by offering its own key as both")
	}
	if _, err := auth(Credentials{VaultID: "v", Token: longKey}); err != nil {
		t.Fatalf("the original device was locked out: %v", err)
	}
}

// Claiming needs a key to claim with. Accepting the bootstrap alone would leave
// the vault open to the bootstrap for ever, which is the state being left.
func TestClaimingNeedsAKey(t *testing.T) {
	_, auth := authRig(t)
	if _, err := auth(Credentials{VaultID: "v", Token: bootstrap}); err == nil {
		t.Fatal("the bootstrap opened an unclaimed vault with nothing to bind it to")
	}
}

// The server keeps a hash and never the key. A server that held the credential
// could write to the vault it exists only to keep, and a stolen disk already
// yields every byte of ciphertext without also handing over the ability to add
// to it.
func TestTheServerStoresAHashAndNotTheKey(t *testing.T) {
	st, auth := authRig(t)
	const key = longKey
	if _, err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: key, Wrapped: testWrapped}); err != nil {
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
// A server serves one vault. A typo in the name must fail here rather than
// quietly creating a second, empty one that reports itself as fully synced,
// which is what claiming does if it is allowed to invent what it claims.
func TestOnlyTheServedVaultCanBeClaimed(t *testing.T) {
	st, auth := authRig(t)
	if _, err := auth(Credentials{VaultID: "typo", Token: bootstrap, Claim: longKey, Wrapped: testWrapped}); err == nil {
		t.Fatal("a vault this server does not serve was claimed")
	}
	vaults, err := st.Vaults()
	if err != nil {
		t.Fatalf("vaults: %v", err)
	}
	for _, v := range vaults {
		if v == "typo" {
			t.Fatal("a refused claim created the vault anyway")
		}
	}
}

// A key short enough to guess is worse than no key: the refusal is visible and
// the weak credential is not.
func TestAVaultWillNotBeBoundToAGuessableKey(t *testing.T) {
	_, auth := authRig(t)
	for _, claim := range []string{"", "x", "short", strings.Repeat("a", MinClaimLength-1)} {
		if _, err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: claim, Wrapped: testWrapped}); err == nil {
			t.Fatalf("the vault was bound to a %d character key", len(claim))
		}
	}
	if _, err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: longKey, Wrapped: testWrapped}); err != nil {
		t.Fatalf("a proper key was refused: %v", err)
	}
}

// A vault is claimed with a data key, and the authenticator is the layer that
// writes the row, so it refuses a claim without one even though the session
// already did. While a vault could be claimed without a data key, a server
// could choose which key schedule a client used by leaving `wrapped` out of
// `ready`. There is no longer a vault for it to choose between.
func TestAVaultIsNotClaimedWithoutADataKey(t *testing.T) {
	st, auth := authRig(t)
	for _, w := range []string{"", "not base64url!", strings.Repeat("A", store.MaxWrappedLen+1)} {
		if _, err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: longKey, Wrapped: w}); err == nil {
			t.Fatalf("a vault was claimed with a %d byte wrapped key", len(w))
		}
		if hash, _ := st.AuthHash("v"); hash != "" {
			t.Fatal("a refused claim bound the vault anyway")
		}
	}
	if _, err := auth(Credentials{VaultID: "v", Token: bootstrap, Claim: longKey, Wrapped: testWrapped}); err != nil {
		t.Fatalf("a claim carrying a data key was refused: %v", err)
	}
	if w, _ := st.Wrapped("v"); w != testWrapped {
		t.Fatalf("the claimed vault stored wrapped %q", w)
	}
}

// A server with no bootstrap token has nothing to check an unclaimed vault
// against, and an empty token would match an empty bootstrap exactly.
func TestAServerWithNoBootstrapClaimsNothing(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "basalt.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	auth := DerivedAuth(st, "v", "", func() int64 { return 1 })

	if _, err := auth(Credentials{VaultID: "v", Token: "", Claim: longKey, Wrapped: testWrapped}); err == nil {
		t.Fatal("an empty token claimed a vault from a server with no bootstrap")
	}
}
