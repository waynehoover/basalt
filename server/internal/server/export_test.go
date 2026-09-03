package server

// Test-only counters. Both were exported from the production build with no
// caller outside the tests (S6); they live here so the shipped binary carries
// only what it uses, and the tests keep the shapes they assert on.

// PreAuth is how many connections are waiting to say hello.
func (s *Server) PreAuth() int {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	return s.preAuth
}

// Peers is the number of devices currently connected to a vault.
func (s *Server) Peers(vaultID string) int { return s.hub.peerCount(vaultID) }
