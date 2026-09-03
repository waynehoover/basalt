package server

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"testing"
)

// StaticTokens is the test suite's authenticator: a fixed vault-to-token map.
// The shipped server authenticates with DerivedAuth, and this used to sit
// beside it in the production build with nothing there calling it (S6).
//
// The comparison is
// constant time: a token check that returns early on the first wrong byte leaks
// the token one byte at a time to anyone who can measure it.
func StaticTokens(tokens map[string]string) Authenticator {
	// Copy, so a later mutation of the caller's map cannot change who has
	// access without anything in the log saying so.
	byVault := make(map[string]string, len(tokens))
	for v, t := range tokens {
		byVault[v] = t
	}
	return func(c Credentials) (Grant, error) {
		vaultID, token := c.VaultID, c.Token
		want, ok := byVault[vaultID]
		if !ok {
			// Still do a comparison, against a value that cannot match, so an
			// unknown vault and a wrong token take the same time.
			subtle.ConstantTimeCompare([]byte(token), []byte(token))
			return Grant{}, fmt.Errorf("no such vault %q", vaultID)
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(want)) != 1 {
			return Grant{}, errors.New("token mismatch")
		}
		return Grant{}, nil
	}
}

// The map is copied, so handing the same map to two servers, or mutating it
// afterwards, cannot change who has access without anything in the log saying
// so.
func TestStaticTokensCopiesTheMapItWasGiven(t *testing.T) {
	tokens := map[string]string{"v1": "secret"}
	auth := StaticTokens(tokens)

	if _, err := auth(Credentials{VaultID: "v1", Token: "secret"}); err != nil {
		t.Fatalf("correct token refused: %v", err)
	}
	tokens["v1"] = "changed"
	tokens["v2"] = "also-secret"

	if _, err := auth(Credentials{VaultID: "v1", Token: "secret"}); err != nil {
		t.Fatalf("the original token stopped working after the caller's map changed: %v", err)
	}
	if _, err := auth(Credentials{VaultID: "v1", Token: "changed"}); err == nil {
		t.Fatal("a token added to the caller's map after the fact was accepted")
	}
	if _, err := auth(Credentials{VaultID: "v2", Token: "also-secret"}); err == nil {
		t.Fatal("a vault added to the caller's map after the fact was accepted")
	}
}

func TestStaticTokensRefusesWrongTokenAndUnknownVault(t *testing.T) {
	auth := StaticTokens(map[string]string{"v1": "secret"})
	if _, err := auth(Credentials{VaultID: "v1", Token: "wrong"}); err == nil {
		t.Fatal("wrong token accepted")
	}
	if _, err := auth(Credentials{VaultID: "nope", Token: "secret"}); err == nil {
		t.Fatal("unknown vault accepted")
	}
	if _, err := auth(Credentials{VaultID: "v1", Token: ""}); err == nil {
		t.Fatal("empty token accepted")
	}
}
