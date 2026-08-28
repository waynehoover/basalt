package server

import "testing"

// The map is copied, so handing the same map to two servers, or mutating it
// afterwards, cannot change who has access without anything in the log saying
// so.
func TestStaticTokensCopiesTheMapItWasGiven(t *testing.T) {
	tokens := map[string]string{"v1": "secret"}
	auth := StaticTokens(tokens)

	if err := auth(Credentials{VaultID: "v1", Token: "secret"}); err != nil {
		t.Fatalf("correct token refused: %v", err)
	}
	tokens["v1"] = "changed"
	tokens["v2"] = "also-secret"

	if err := auth(Credentials{VaultID: "v1", Token: "secret"}); err != nil {
		t.Fatalf("the original token stopped working after the caller's map changed: %v", err)
	}
	if err := auth(Credentials{VaultID: "v1", Token: "changed"}); err == nil {
		t.Fatal("a token added to the caller's map after the fact was accepted")
	}
	if err := auth(Credentials{VaultID: "v2", Token: "also-secret"}); err == nil {
		t.Fatal("a vault added to the caller's map after the fact was accepted")
	}
}

func TestStaticTokensRefusesWrongTokenAndUnknownVault(t *testing.T) {
	auth := StaticTokens(map[string]string{"v1": "secret"})
	if err := auth(Credentials{VaultID: "v1", Token: "wrong"}); err == nil {
		t.Fatal("wrong token accepted")
	}
	if err := auth(Credentials{VaultID: "nope", Token: "secret"}); err == nil {
		t.Fatal("unknown vault accepted")
	}
	if err := auth(Credentials{VaultID: "v1", Token: ""}); err == nil {
		t.Fatal("empty token accepted")
	}
}
