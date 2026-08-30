// Package server speaks the Basalt protocol over a WebSocket.
//
// It owns session state and message dispatch. Durability lives in the store and
// the chunk layer below it; this package's whole contribution to "do not lose a
// note" is ordering: bodies before entries, entries before acks, and catch-up
// before live changes.
package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/waynehoover/basalt/server/internal/store"
	"github.com/waynehoover/basalt/server/internal/wire"
)

const (
	// DefaultMaxPeers caps simultaneous devices on one vault.
	//
	// Deliberately small. Basalt targets one person's devices: fan-out is
	// O(peers) per commit and every connection holds a send queue and a read
	// buffer. Refusing past the limit is honest; degrading quietly is not.
	DefaultMaxPeers = 8

	// ReadLimit bounds one incoming frame.
	//
	// The binding case is not a chunk body, which is capped at store.ChunkMax.
	// It is the JSON of a put: store.MaxChunksPerEntry names at 67 bytes each is
	// about 4.4 MB for the largest legal file. Eight is comfortably above that
	// and still bounds a hostile peer at maxPeers * 8 MB.
	ReadLimit = 8 << 20

	// WriteWait bounds one frame write, so a peer that stops reading is
	// detected rather than pinning a goroutine forever.
	WriteWait = 30 * time.Second

	// PingInterval is how often the server checks that a quiet connection is
	// still there, by sending a WebSocket ping and waiting for the pong.
	//
	// Liveness used to be "said something in the last five minutes", which
	// confuses a dead connection with a settled one. A vault that has finished
	// syncing has nothing to say, so its connection was closed every five
	// minutes for ever, each time reconnecting and replaying the handshake to
	// discover it was already up to date. Nothing was lost and nothing said why.
	//
	// A ping asks the question directly, and asks it of the connection rather
	// than of the client's manners: it works for a client that never sends an
	// application message, and it notices a connection that died silently, which
	// a laptop closing its lid does, within a minute rather than five.
	PingInterval = 45 * time.Second

	// PongWait is how long a ping may go unanswered before the connection is
	// treated as gone.
	PongWait = 15 * time.Second

	// SendQueueDepth is buffered frames per peer before it is dropped as too
	// slow. Sized for a burst of fan-out, not for a catch-up: catch-up runs on
	// the session's own goroutine and blocks rather than buffering.
	SendQueueDepth = 256

	// CatchupBufferMax bounds live changes held while a session drains its
	// backlog. A session that cannot finish catch-up before this many commits
	// land is dropped and recovers on reconnect, which costs it nothing: the
	// entries table plus the uid cursor is the durable queue.
	CatchupBufferMax = 4096

	// BatchSize is entries per catch-up batch. Small enough that a client sees
	// progress and can assert continuity often, large enough that a big vault
	// is not thousands of frames.
	BatchSize = 200
)

// Authenticator decides whether a token may use a vault.
//
// It returns an error so the reason can be logged, but the reason never reaches
// the wire: every failure is reported to the client as CodeAuth, because
// distinguishing "no such vault" from "wrong token" tells an attacker which
// half to keep guessing.
// Credentials are what a device offers at hello.
//
// Token is what it is authenticating with. Claim is the auth key it wants the
// vault to be bound to from now on, sent only while pairing the first device,
// and ignored once a vault has been claimed.
type Credentials struct {
	VaultID string
	Token   string
	Claim   string
}

type Authenticator func(c Credentials) error

// StaticTokens authenticates against a fixed vault-to-token map.
//
// This is the whole of authentication until pairing exists. The comparison is
// constant time: a token check that returns early on the first wrong byte leaks
// the token one byte at a time to anyone who can measure it.
func StaticTokens(tokens map[string]string) Authenticator {
	// Copy, so a later mutation of the caller's map cannot change who has
	// access without anything in the log saying so.
	byVault := make(map[string]string, len(tokens))
	for v, t := range tokens {
		byVault[v] = t
	}
	return func(c Credentials) error {
		vaultID, token := c.VaultID, c.Token
		want, ok := byVault[vaultID]
		if !ok {
			// Still do a comparison, against a value that cannot match, so an
			// unknown vault and a wrong token take the same time.
			subtle.ConstantTimeCompare([]byte(token), []byte(token))
			return fmt.Errorf("no such vault %q", vaultID)
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(want)) != 1 {
			return errors.New("token mismatch")
		}
		return nil
	}
}

// Server is the protocol handler. One per process; sessions are per connection.
type Server struct {
	st   *store.Store
	hub  *Hub
	auth Authenticator
	log  *slog.Logger

	maxPeers int

	// perFileMax is advertised in `ready` and enforced on every put. One field
	// for both, because advertising a limit that is not enforced, or enforcing
	// one that is not advertised, is how a client ends up retrying a put that
	// can never succeed.
	perFileMax int64

	// now is injectable so tests do not have to sleep to reach a timeout.
	now func() time.Time

	// pingEvery and pongWait are the constants unless a test lowers them, which
	// is the only way to reach the keepalive without a test that sleeps for
	// minutes.
	pingEvery time.Duration
	pongWait  time.Duration

	// batchSize is BatchSize unless a test lowers it. Lowering it is how the
	// catch-up path can be made to span many frames without seeding a vault
	// large enough to do it honestly.
	batchSize int

	// afterReplayBatch and afterReplay run at known points inside the handshake,
	// and are nil in every non-test build.
	//
	// They exist because the orders that matter most in this package are
	// "backlog first, live changes after" and "join the fan-out before reading
	// the backlog, not after", and both are about a window a few microseconds
	// wide. A test that tried to hit either by timing would be a test that
	// passes when the machine is busy.
	//
	// afterReplayBatch runs once per catch-up batch, so a test can interrupt the
	// middle of a replay. afterReplay runs after the last batch and before the
	// buffered live changes are released, which is the window in which an entry
	// is in neither the backlog nor the flush unless the session joined the
	// fan-out first.
	afterReplayBatch func(n int)
	afterReplay      func()

	// afterAppend runs between assigning a uid and announcing it, and is nil in
	// every non-test build.
	//
	// It exists because the window commitMu closes cannot otherwise be observed:
	// AppendEntry ends in an fsync, so the goroutine that gets the lower uid has
	// only a log line and a channel send left to do while the next one still has
	// a whole durable commit ahead of it. The reorder is real and the lock is
	// what rules it out, but no amount of concurrency reliably produces it, and
	// an invariant that holds only because a disk is slow is not one to rely on.
	afterAppend func(uid int64)

	// commitMu makes appending an entry and announcing it one step.
	//
	// Without it two devices can commit uid 5 and uid 6 and reach the hub in
	// the opposite order, because AppendEntry releases the store's write lock
	// before the fan-out runs. A peer would then receive [6,6] before [5,5] and
	// its continuity check would fire on a vault that is perfectly healthy,
	// which is worse than not checking: an assertion that cries wolf gets
	// switched off. Live batches leave here in uid order, so a gap a client
	// sees is always real.
	//
	// The cost is that commits to *any* vault serialise. That is already true
	// one layer down, where the store holds a single write mutex for the same
	// ordering reason, so this adds a fan-out of a few non-blocking channel
	// sends to a section that was serial anyway.
	commitMu sync.Mutex
}

func New(st *store.Store, auth Authenticator, log *slog.Logger) *Server {
	return NewWithLimit(st, auth, log, DefaultMaxPeers)
}

func NewWithLimit(st *store.Store, auth Authenticator, log *slog.Logger, maxPeers int) *Server {
	if maxPeers <= 0 {
		maxPeers = DefaultMaxPeers
	}
	if log == nil {
		log = slog.Default()
	}
	return &Server{
		st: st, hub: NewHub(), auth: auth, log: log,
		maxPeers: maxPeers, perFileMax: store.DefaultPerFileMax,
		pingEvery: PingInterval, pongWait: PongWait,
		now: time.Now, batchSize: BatchSize,
	}
}

// SetPerFileMax changes the largest file this server accepts and advertises.
//
// Clamped to what the store can hold, because a limit above that would be
// advertised, attempted, and then refused by Validate: the client would have
// read and sealed the file to find out.
func (s *Server) SetPerFileMax(max int64) {
	if max <= 0 {
		max = store.DefaultPerFileMax
	}
	if max > store.PerFileMax {
		max = store.PerFileMax
	}
	s.perFileMax = max
}

// PerFileMax is what this server advertises and enforces.
func (s *Server) PerFileMax() int64 { return s.perFileMax }

// Store is the persistence this server is serving. Exposed for the command line
// tools that verify and purge, which must go through the same code the sessions
// do rather than opening the database a second time.
func (s *Server) Store() *store.Store { return s.st }

// Peers is the number of devices currently connected to a vault.
func (s *Server) Peers(vaultID string) int { return s.hub.peerCount(vaultID) }

// ready is the handshake reply, built from the same constants the store
// enforces. Advertising a limit the store does not enforce, or enforcing one it
// does not advertise, is how a client ends up retrying a put that can never
// succeed.
func (s *Server) ready(cursor int64) wire.Ready {
	return wire.Ready{
		Res:        "ready",
		Proto:      wire.Proto,
		Cursor:     cursor,
		PerFileMax: s.perFileMax,
		ChunkMax:   s.st.Chunks().Max(),
		MaxChunks:  store.MaxChunksPerEntry,
	}
}

/* ---------------------------------------------------------------- *
 * One secret
 * ---------------------------------------------------------------- */

// DerivedAuth authenticates against a key the client derives from the vault's
// root secret, with a one-time bootstrap token for the very first device.
//
// The point is that there is one secret rather than two. Before this, a vault
// had a root secret that the devices shared and a server token that had nothing
// to do with it, and a pairing string had to carry both. The auth key is now
// another branch of the same HKDF schedule that produces the content and path
// keys, so holding the root secret is what it means to have the vault.
//
// The server stores only sha256 of that key. It never needs the key itself: it
// checks an offered one, and a server that held the credential could write to
// the vault it exists only to keep. A stolen disk already yields every byte of
// ciphertext; it should not also yield the ability to add to it.
//
// The bootstrap token is how a vault gets claimed in the first place. The
// server prints one on first run, the first device authenticates with it and
// sends the auth key it wants the vault bound to, and from then on the
// bootstrap opens nothing. Trust on first connection would be simpler and would
// mean whoever reached the port first owned the vault.
// MinClaimLength is the shortest auth key a vault may be bound to.
//
// A derived key is 43 characters of base64url. Anything much shorter came from
// a client that is not deriving it, and binding a vault to a guessable
// credential is worse than refusing to bind it at all: the refusal is visible
// and the weak key is not.
const MinClaimLength = 32

func DerivedAuth(st *store.Store, allowedVault, bootstrap string, now func() int64) Authenticator {
	return func(c Credentials) error {
		// Exactly one vault is authorised. A typo in the vault name fails here
		// instead of quietly creating a second, empty vault that reports itself
		// as fully synced, which is what claiming does if it is allowed to
		// invent the vault it claims.
		if c.VaultID != allowedVault {
			return fmt.Errorf("this server serves %q, not %q", allowedVault, c.VaultID)
		}
		if bootstrap == "" {
			// Otherwise an empty token would match an empty bootstrap and the
			// first caller would claim the vault with nothing at all.
			return errors.New("this server has no bootstrap token, so no vault can be claimed")
		}

		hash, err := st.AuthHash(c.VaultID)
		if err != nil {
			return fmt.Errorf("reading the vault's auth hash: %w", err)
		}

		if hash != "" {
			// Constant time, and over the hashes rather than the keys, so the
			// comparison is a fixed 32 bytes whatever was offered.
			offered := sha256.Sum256([]byte(c.Token))
			want, decodeErr := hex.DecodeString(hash)
			if decodeErr != nil {
				return fmt.Errorf("vault %q has an unreadable auth hash", c.VaultID)
			}
			if subtle.ConstantTimeCompare(offered[:], want) != 1 {
				return errors.New("auth key mismatch")
			}
			return nil
		}

		// Unclaimed. The bootstrap token is the only thing that opens it, and
		// only in exchange for the key that replaces it.
		if subtle.ConstantTimeCompare([]byte(c.Token), []byte(bootstrap)) != 1 {
			return errors.New("bootstrap token mismatch")
		}
		if len(c.Claim) < MinClaimLength {
			return fmt.Errorf(
				"this vault has not been claimed, and the key offered to claim it with is %d characters, which is too few",
				len(c.Claim))
		}
		claimed := sha256.Sum256([]byte(c.Claim))
		ok, err := st.ClaimVault(c.VaultID, hex.EncodeToString(claimed[:]), now())
		if err != nil {
			return fmt.Errorf("claiming vault %q: %w", c.VaultID, err)
		}
		if !ok {
			// Another device claimed it between the read and the write. Its key
			// is the vault's key now, and this one is not it.
			return errors.New("the vault was claimed by another device a moment ago")
		}
		return nil
	}
}
