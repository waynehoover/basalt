package server

import (
	"sync"

	"github.com/waynehoover/basalt-sync/server/internal/store"
)

// Hub fans committed entries out to every device on a vault.
//
// The origin session is included in the fan-out, and receives the range with an
// empty entry list. It needs the cursor advance, so skipping it would leave its
// cursor behind by one for every file it pushes; it does not need the payload,
// so sending it would ask it to recognise its own echo.
type Hub struct {
	mu      sync.RWMutex
	byVault map[string]map[*Session]struct{}
}

func NewHub() *Hub {
	return &Hub{byVault: make(map[string]map[*Session]struct{})}
}

// joinIfRoom admits the session unless the vault is at its device limit.
//
// The count and the admission are taken under one lock. Checking then joining
// as two steps lets two devices both observe "one slot left" and both take it,
// which is how a limit of 8 quietly becomes 9.
func (h *Hub) joinIfRoom(vaultID string, s *Session, max int) (int, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.byVault[vaultID]
	if len(m) >= max {
		return len(m), false
	}
	if m == nil {
		m = make(map[*Session]struct{})
		h.byVault[vaultID] = m
	}
	m[s] = struct{}{}
	return len(m), true
}

func (h *Hub) leave(vaultID string, s *Session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.byVault[vaultID]
	if m == nil {
		return
	}
	delete(m, s)
	if len(m) == 0 {
		delete(h.byVault, vaultID)
	}
}

// broadcast delivers one committed entry to every session on the vault.
//
// A failing peer is skipped rather than aborting the fan-out: one wedged device
// must not stop the others converging. Nothing is lost by the skip, because
// delivery here is not the durable channel. The entries table plus the uid
// cursor is, and a dropped peer receives everything it missed as catch-up when
// it reconnects.
func (h *Hub) broadcast(vaultID string, e store.Entry, origin *Session) {
	h.mu.RLock()
	peers := make([]*Session, 0, len(h.byVault[vaultID]))
	for s := range h.byVault[vaultID] {
		peers = append(peers, s)
	}
	h.mu.RUnlock()

	for _, s := range peers {
		s.deliver(e, s == origin)
	}
}

// sessionsOf returns every session on the vault belonging to one device,
// except origin, for a revoke to close.
//
// Deleting the row is not enough on its own. A revoked device holding an open
// connection has already authenticated, and nothing on a live session is
// re-checked, so it would go on receiving every note pushed to the vault for
// as long as it stayed up: a revocation the revoked device never notices.
//
// A device may have more than one session, so this is a list rather than a
// lookup, and origin is left out because the caller is about to answer it.
// Reading deviceID here is safe without any lock of its own: it is written
// before the session joins, and joining takes the same mutex this holds.
func (h *Hub) sessionsOf(vaultID, deviceID string, origin *Session) []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var out []*Session
	for s := range h.byVault[vaultID] {
		if s != origin && s.deviceID == deviceID {
			out = append(out, s)
		}
	}
	return out
}

func (h *Hub) peerCount(vaultID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.byVault[vaultID])
}
