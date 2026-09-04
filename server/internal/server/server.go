// Package server speaks the Basalt protocol over a WebSocket.
//
// It owns session state and message dispatch. Durability lives in the store and
// the chunk layer below it; this package's whole contribution to "do not lose a
// note" is ordering: bodies before entries, entries before acks, and catch-up
// before live changes.
package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

const (
	// DefaultMaxPeers caps simultaneous devices on one vault.
	//
	// Deliberately small. Basalt targets one person's devices: fan-out is
	// O(peers) per commit and every connection holds a send queue and a read
	// buffer. Refusing past the limit is honest; degrading quietly is not.
	DefaultMaxPeers = 8

	// ReadLimit bounds one incoming frame once a session has authenticated, and
	// HelloReadLimit bounds the first frame, which has to be a hello.
	//
	// The rule is that every legal message is receivable (S22): a frame the
	// protocol allows must never die at the read limit, because a client whose
	// batch is dropped with no code retries the identical batch for ever. The
	// arithmetic, with every constant it depends on named:
	//
	//   - the largest legal text frame is a putmany at wire.MaxBatchBytes,
	//     16 MiB, enforced on the encoded frame after it is read (S18). A batch
	//     of 256 entries naming 65536 chunks each would be about 1.1 GB and is
	//     not legal, because it is over that cap; the client splits it;
	//   - a single put is one path of store.MaxPathLen plus
	//     store.MaxChunksPerEntry names at 67 bytes each, about 4.4 MB;
	//   - a fetch is at most store.MaxChunksPerEntry names, the same 4.4 MB;
	//   - a chunk body is at most store.ChunkMax, 1 MiB.
	//
	// 32 MiB is twice the largest of those, so a frame between the advertised
	// cap and the read limit is read in full and refused with `toolarge`, and
	// only a frame at twice the cap, which no client that read `ready` sends,
	// meets the bare disconnect. The cost is bounded at maxPeers * 32 MiB.
	//
	// Before hello nothing has been authenticated, so the limit is 64 KiB: a
	// hello is a vault and device of 64 bytes each, a token, a claim of 43 and
	// a wrapped key of at most 256, a few hundred bytes in all. An unauthenticated
	// connection therefore cannot make the server allocate more than that, and
	// MaxPreAuth bounds how many of them there can be (S19).
	ReadLimit      = 32 << 20
	HelloReadLimit = 64 << 10

	// MaxPreAuth caps connections that have not completed hello, across every
	// vault, and HelloTimeout is how long one may take to send it (S19). The
	// device limit bounds joined sessions per vault, but a connection that never
	// says hello joined nothing, so nothing bounded it: a port scanner opening
	// sockets held a goroutine and a buffer each for ever. Past the cap a new
	// connection is refused with `busy`; past the deadline a silent one is told
	// `protostate` and closed. Both are generous for anything that is a device.
	MaxPreAuth   = 32
	HelloTimeout = 10 * time.Second

	// DeviceLimitRetryAfter and ShutdownRetryAfter are the `retryAfterMs` hints
	// sent with `busy`. A device refused for the limit needs another device to
	// go away, which takes a while; one refused for a shutdown needs the
	// process to come back, which a restart does in seconds.
	DeviceLimitRetryAfter = 30 * time.Second
	ShutdownRetryAfter    = 5 * time.Second

	// DefaultInviteTTL is how long an invite lives when the issuing device does
	// not say, and MaxInviteTTL the most it may ask for. Ten minutes is long
	// enough to walk to the other device and short enough that an invite left
	// in a chat is dead before anyone reads it; an hour is the ceiling for the
	// same reason the client is not allowed to choose a day.
	DefaultInviteTTL = 10 * time.Minute
	MaxInviteTTL     = time.Hour

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

	// SendQueueBytes bounds what one peer may have waiting in memory.
	//
	// The depth above bounds frames, and a frame carrying a chunk body can be a
	// megabyte, so a peer that stopped reading held 256 of them: measured at
	// 272 MB of heap for one stalled reader, and 2.2 GB at the default peer
	// limit. Chunks average a few kilobytes, so this never bites on prose; a
	// vault of incompressible attachments produces chunks at the ceiling, which
	// is exactly the vault that would find it.
	//
	// Eight mebibytes mirrors the client's own bound on queued file bytes. A
	// frame larger than this is still sent, because refusing it would be a
	// deadlock rather than a limit.
	SendQueueBytes = 8 << 20

	// CatchupBufferMax bounds live changes held while a session drains its
	// backlog. A session that cannot finish catch-up before this many commits
	// land is dropped and recovers on reconnect, which costs it nothing: the
	// entries table plus the uid cursor is the durable queue.
	CatchupBufferMax = 4096

	// CatchupBufferBytes bounds the same buffer by size. The entry count alone
	// let a peer hold 4096 marshalled batches of any size, and a batch naming
	// tens of thousands of chunks is megabytes: the same hole SendQueueBytes
	// closes for the send queue, so it gets the same figure.
	CatchupBufferBytes = SendQueueBytes

	// BatchSize is entries per catch-up batch. Small enough that a client sees
	// progress and can assert continuity often, large enough that a big vault
	// is not thousands of frames.
	BatchSize = 200
)

// Credentials are what a device offers at hello.
//
// Token is what it is authenticating with. Claim is the auth key it wants the
// vault to be bound to from now on, sent only while pairing the first device,
// and ignored once a vault has been claimed. Wrapped travels with Claim: the
// vault's data key, wrapped under the root secret, stored beside the hash.
//
// Invite, in place of Token, redeems a single-use invite on a claimed vault;
// the grant then carries the sealed secret and the session ends after handing
// it over.
type Credentials struct {
	VaultID string
	Token   string
	Claim   string
	Wrapped string
	Invite  string
}

// Grant is what a successful authentication says about how it succeeded.
//
// Bootstrap is true when the token was the server's first-run token, which is
// the one credential that is not derived from the root secret. A session that
// authenticated that way may not rotate the vault: rotation retires the old
// root, and a caller that never proved it held the old one has no business
// choosing the new.
//
// Redeemed is true when the hello carried an invite that was just marked used;
// Sealed is then the root secret the issuing device sealed for the new one.
//
// AuthHash is the vault's stored hash that this credential matched, or the one
// a claim just bound the vault to. The session keeps it and rotation swaps
// against it, so a device can only replace the credential it proved it holds;
// see store.Rotate. It is empty on a redeemed grant, which is not a device.
type Grant struct {
	Bootstrap bool
	Redeemed  bool
	Sealed    string
	AuthHash  string
}

// Authenticator decides whether a token may use a vault.
//
// It returns an error so the reason can be logged, but the reason never reaches
// the wire: every failure is reported to the client as CodeAuth, because
// distinguishing "no such vault" from "wrong token" tells an attacker which
// half to keep guessing.
type Authenticator func(c Credentials) (Grant, error)

// Server is the protocol handler. One per process; sessions are per connection.
type Server struct {
	st   *store.Store
	hub  *Hub
	auth Authenticator
	log  *slog.Logger

	maxPeers int

	// version is what `ready.serverVersion` says and what the startup line
	// logs: the stamped release, or "dev". It is sent only after a hello has
	// authenticated; a refusal before that names the protocol range and nothing
	// about the build, see handleHello.
	version string

	// maxPreAuth and helloTimeout are MaxPreAuth and HelloTimeout unless a test
	// lowers them. preAuth counts connections between accept and a completed
	// hello, guarded by sessMu.
	maxPreAuth   int
	helloTimeout time.Duration
	preAuth      int

	// maxBatchBytes and maxFetchBytes are the wire constants unless a test
	// lowers them. One field each for advertising and enforcing, for the same
	// reason as perFileMax.
	maxBatchBytes int64
	maxFetchBytes int64

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

	// writeWait is WriteWait unless a test lowers it. It is what bounds the
	// detection of a peer that has gone while the server is sending to it,
	// which is a case the keepalive deliberately leaves alone (S1).
	writeWait time.Duration

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

	// beforeJoin runs inside a hello, after the vault's key material has been
	// read and before the session joins the fan-out, and is nil in every
	// non-test build. It exists for the same reason as the two above: the
	// window between authenticating and joining is a few microseconds wide, and
	// a rotation landing in it used to leave a session holding a retired
	// credential serving happily. A test that tried to hit it by timing would
	// be a test that passes when the machine is busy.
	beforeJoin func()

	// beforeRotate runs inside a rotate, just before the store is asked to swap
	// the credential, and is nil in every non-test build. It is how a test
	// parks one device's rotation inside the store call while another device's
	// rotation commits underneath it, which is the sequence that let a revoked
	// device take the vault back.
	beforeRotate func()

	// afterFlush runs once flushPending has released its lock, and is nil in
	// every non-test build. By then caught-up is already queued, so a broadcast
	// triggered here must land after it; a test uses that to prove caught-up is
	// enqueued under the lock rather than written afterwards.
	afterFlush func()

	// beforePing runs just before keepalive sends a ping, and is nil in every
	// non-test build. A test uses it to check what the queue held at that
	// moment, because the symptom of pinging behind queued data depends on how
	// much the kernel buffers, which differs by platform.
	beforePing func()

	// beforeEvict runs at the top of each eviction a rotation causes, and is
	// nil in every non-test build. A test uses it to see that the evictions
	// overlap, which is the whole of what parallelising them buys and is not
	// otherwise observable: how long an eviction takes depends on whether the
	// peer is reading, which a test cannot arrange honestly.
	beforeEvict func()

	// beforeAppend runs just before an entry is committed, and is nil in every
	// non-test build. An error from it stands in for the database failing the
	// commit, which no test can arrange honestly on a working disk, so that the
	// session's answer to that fault can be pinned (S27).
	beforeAppend func(e store.Entry) error

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

	// sessions is every connection Handle is running, joined to a vault or not,
	// and closing is set once Shutdown has begun. http.Server.Shutdown stops
	// the listener and waits for ordinary requests, but a hijacked WebSocket is
	// not its connection any more, so without this list a shutdown returned
	// while every session was still open and the store was closed under them.
	sessMu   sync.Mutex
	sessions map[*Session]struct{}
	closing  bool
}

// errShuttingDown is the reason a peer is given when the server is stopping.
// Reported as busy, which the client already treats as "not now, reconnect",
// because that is exactly what it means.
var errShuttingDown = errors.New("this server is shutting down, reconnect in a moment")

// errTooManyPreAuth is the reason a connection is refused when too many others
// have connected and not yet said hello (S19).
var errTooManyPreAuth = errors.New("too many connections are waiting to authenticate, try again in a moment")

// admit registers a session, unless the server is shutting down or too many
// sessions are still waiting to say hello. The reason is returned so the
// refusal can say which.
func (s *Server) admit(sess *Session) error {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	if s.closing {
		return errShuttingDown
	}
	if s.preAuth >= s.maxPreAuth {
		return errTooManyPreAuth
	}
	if s.sessions == nil {
		s.sessions = make(map[*Session]struct{})
	}
	s.sessions[sess] = struct{}{}
	sess.counted = true
	s.preAuth++
	return nil
}

// authenticated moves a session out of the pre-auth count. Called once, when
// its hello has been accepted; a session that never gets there is released by
// forget.
func (s *Server) authenticated(sess *Session) {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	if !sess.counted {
		return
	}
	sess.counted = false
	s.preAuth--
}

func (s *Server) forget(sess *Session) {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	if _, ok := s.sessions[sess]; !ok {
		return
	}
	delete(s.sessions, sess)
	if sess.counted {
		sess.counted = false
		s.preAuth--
	}
}

// Sessions is how many connections are being handled, joined or not.
func (s *Server) Sessions() int {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	return len(s.sessions)
}

// Shutdown stops admitting connections, tells every session to finish, and
// waits for them to go, bounded by ctx (S16).
//
// A session between requests is closed with a reason at once. One inside a
// request is left to finish it: a put that has stored its bodies gets its
// commit and its ack, because an ack means stored and a shutdown must not
// turn one into a lie in either direction. Whatever is still running when ctx
// expires is killed, which a client experiences as a dropped connection with
// nothing acknowledged, and retries. Call this before closing the store; a
// session that outlives the store would fail its commit and could not say why.
//
// It returns only once no session is left, deadline or no deadline. The error
// says how many were cut off; it does not mean any of them is still running.
func (s *Server) Shutdown(ctx context.Context) error {
	s.sessMu.Lock()
	s.closing = true
	peers := make([]*Session, 0, len(s.sessions))
	for sess := range s.sessions {
		peers = append(peers, sess)
	}
	s.sessMu.Unlock()

	// In parallel, because each idle peer is given a moment to read its reason
	// and eight of them in series would spend the whole budget on the first.
	var wg sync.WaitGroup
	for _, sess := range peers {
		wg.Add(1)
		go func(sess *Session) {
			defer wg.Done()
			sess.shutdown()
		}(sess)
	}
	wg.Wait()

	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for s.Sessions() > 0 {
		select {
		case <-tick.C:
			continue
		case <-ctx.Done():
		}
		// Out of time. What is left is mid-request; it is cut off, unacked, and
		// the client retries. The count is taken here, under the lock and at
		// the moment of the kill, so what is reported is what was actually
		// still running rather than a number from before the wait.
		s.sessMu.Lock()
		left := make([]*Session, 0, len(s.sessions))
		for sess := range s.sessions {
			left = append(left, sess)
		}
		s.sessMu.Unlock()
		for _, sess := range left {
			sess.kill(errors.New("shutdown deadline reached with a request in flight"))
		}
		// Then wait for every one of them to unwind, with no second deadline.
		// The kill has already closed the socket, so what remains is a request
		// finishing, usually a commit, and this is the one thing the caller
		// cannot be allowed to race: main closes the store as soon as this
		// returns, and a commit that meets a closed store fails with `internal`
		// on a put the client was told nothing about. Returning after a second
		// whether or not the sessions had gone is what made that possible.
		//
		// A session that never unwinds hangs the stop, which systemd ends with
		// SIGKILL; that leaves the database to recover from its journal, which
		// it is built to do, and is the safer of the two failures.
		for s.Sessions() > 0 {
			<-tick.C
		}
		return fmt.Errorf("shutdown: %d sessions cut off mid-request", len(left))
	}
	return nil
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
		version:   "dev",
		pingEvery: PingInterval, pongWait: PongWait, writeWait: WriteWait,
		maxPreAuth: MaxPreAuth, helloTimeout: HelloTimeout,
		maxBatchBytes: wire.MaxBatchBytes, maxFetchBytes: wire.MaxFetchBytes,
		now: time.Now, batchSize: BatchSize,
	}
}

// SetVersion names the release this server is, for `ready` and the log. Empty
// is left as "dev" rather than advertised as nothing.
func (s *Server) SetVersion(v string) {
	if v != "" {
		s.version = v
	}
}

// Version is what this server calls itself.
func (s *Server) Version() string { return s.version }

// clamp holds a limit inside the range the code below it can actually serve.
//
// Zero or negative means the flag was not set, and an unset flag is the shipped
// default rather than the floor: silently serving the smallest legal value
// because nobody asked for one would be a limit nobody chose. Everything else
// is pulled to the nearest end of the range, and the caller advertises what
// came back, because advertised has to equal enforced.
func clamp(n, lo, hi, def int64) int64 {
	if n <= 0 {
		n = def
	}
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// SetPerFileMax changes the largest file this server accepts and advertises.
func (s *Server) SetPerFileMax(max int64) {
	s.perFileMax = ClampPerFileMax(max)
}

// ClampPerFileMax is what a -max-file value actually becomes.
//
// Clamped to what the store can hold, because a limit above that would be
// advertised, attempted, and then refused by Validate: the client would have
// read and sealed the file to find out. There is no floor beyond one byte: a
// ceiling set low only refuses files, and refusing is the safe direction.
//
// Exported because `basaltd service` writes the flag into a unit and has to
// check it against the vault first, and two copies of this arithmetic would be
// two answers to "what will this unit actually run with".
func ClampPerFileMax(max int64) int64 {
	return clamp(max, 1, store.PerFileMax, store.DefaultPerFileMax)
}

// PerFileMax is what this server advertises and enforces.
func (s *Server) PerFileMax() int64 { return s.perFileMax }

// SetMaxBatchBytes changes the batch cap this server advertises and enforces
// (I25). Clamped to what makes sense: no lower than one chunk, or no batch
// could carry a body, and no higher than half the read limit, which is the
// default, so that a frame over the cap is still read in full and refused with
// a code rather than dying at the socket (S22). The flag exists to lower the
// cap, for a client test against the real binary; it cannot raise it.
func (s *Server) SetMaxBatchBytes(n int64) {
	s.maxBatchBytes = clamp(n, store.ChunkMax, ReadLimit/2, wire.MaxBatchBytes)
}

// MaxBatchBytes is what this server advertises and enforces.
func (s *Server) MaxBatchBytes() int64 { return s.maxBatchBytes }

// SetMaxFetchBytes changes the fetch cap this server advertises and enforces
// (I25). Bodies go out, not in, so the read limit does not bound them; the
// clamp is one chunk at the bottom and the largest file the store can hold at
// the top, so one fetch can always carry one file and never has to.
func (s *Server) SetMaxFetchBytes(n int64) {
	s.maxFetchBytes = clamp(n, store.ChunkMax, store.PerFileMax, wire.MaxFetchBytes)
}

// MaxFetchBytes is what this server advertises and enforces.
func (s *Server) MaxFetchBytes() int64 { return s.maxFetchBytes }

// Store is the persistence this server is serving. Exposed for the command line
// tools that verify and purge, which must go through the same code the sessions
// do rather than opening the database a second time.
func (s *Server) Store() *store.Store { return s.st }

// ready is the handshake reply, built from the same constants the store and
// the session enforce. Advertising a limit that is not enforced, or enforcing
// one that is not advertised, is how a client ends up retrying a put that can
// never succeed.
//
// wrapped is the vault's data key, which every claimed vault has, so a client
// always learns it here. The protocol range is sent whole even though it is one
// version wide, because that is what a client names when the next bump refuses
// it; see wire.Proto.
func (s *Server) ready(id, cursor int64, wrapped string) wire.Ready {
	return wire.Ready{
		Res:           "ready",
		ID:            id,
		Proto:         wire.Proto,
		MinProto:      wire.MinProto,
		ServerVersion: s.version,
		Cursor:        cursor,
		PerFileMax:    s.perFileMax,
		ChunkMax:      s.st.Chunks().Max(),
		MaxChunks:     store.MaxChunksPerEntry,
		MaxBatchBytes: s.maxBatchBytes,
		MaxFetchBytes: s.maxFetchBytes,
		Wrapped:       wrapped,
	}
}

/* ---------------------------------------------------------------- *
 * One secret
 * ---------------------------------------------------------------- */

// MinClaimLength is the shortest auth key a vault may be bound to.
//
// A derived key is 43 characters of base64url. Anything much shorter came from
// a client that is not deriving it, and binding a vault to a guessable
// credential is worse than refusing to bind it at all: the refusal is visible
// and the weak key is not.
const MinClaimLength = 32

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
//
// # Why the hash is a bare, unsalted SHA-256, and must stay one
//
// The auth key is 256 random bits derived by HKDF from a random root. There is
// nothing to guess, so there is nothing for a salt to defeat and nothing for a
// slow hash to slow down: bcrypt or argon2 here would burn a core on every
// hello for no security and block the accept loop while doing it. That
// reasoning holds only because the input is random and long. It must never be
// reused for anything a person chose, where a fast unsalted hash is exactly
// the wrong tool (I12).
func DerivedAuth(st *store.Store, allowedVault, bootstrap string, now func() int64) Authenticator {
	return func(c Credentials) (Grant, error) {
		// Exactly one vault is authorised. A typo in the vault name fails here
		// instead of quietly creating a second, empty vault that reports itself
		// as fully synced, which is what claiming does if it is allowed to
		// invent the vault it claims.
		if c.VaultID != allowedVault {
			return Grant{}, fmt.Errorf("this server serves %q, not %q", allowedVault, c.VaultID)
		}
		if bootstrap == "" {
			// Otherwise an empty token would match an empty bootstrap and the
			// first caller would claim the vault with nothing at all.
			return Grant{}, errors.New("this server has no bootstrap token, so no vault can be claimed")
		}

		hash, _, _, err := st.VaultKeys(c.VaultID)
		if err != nil {
			return Grant{}, fmt.Errorf("reading the vault's auth hash: %w", err)
		}

		if c.Invite != "" {
			// An invite is redeemed only on a claimed vault, because an
			// unclaimed one has no root to have sealed. Unknown, expired and
			// used are one answer: saying which would tell a guesser it had
			// found a real identifier. The mark-used is the same statement as
			// the read, so the invite is burned before anything is replied.
			if hash == "" {
				return Grant{}, errors.New("an unclaimed vault has no invites to redeem")
			}
			sealed, ok, err := st.RedeemInvite(c.VaultID, c.Invite, now())
			if err != nil {
				return Grant{}, fmt.Errorf("redeeming an invite: %w", err)
			}
			if !ok {
				return Grant{}, errors.New("invite is unknown, expired or already used")
			}
			return Grant{Redeemed: true, Sealed: sealed}, nil
		}

		if hash != "" {
			// Constant time, and over the hashes rather than the keys, so the
			// comparison is a fixed 32 bytes whatever was offered.
			offered := sha256.Sum256([]byte(c.Token))
			want, decodeErr := hex.DecodeString(hash)
			if decodeErr != nil {
				return Grant{}, fmt.Errorf("vault %q has an unreadable auth hash", c.VaultID)
			}
			if subtle.ConstantTimeCompare(offered[:], want) != 1 {
				return Grant{}, errors.New("auth key mismatch")
			}
			// The hash this credential matched travels with the grant, because
			// it is what a later rotation compare-and-swaps against.
			return Grant{AuthHash: hash}, nil
		}

		// Unclaimed. The bootstrap token is the only thing that opens it, and
		// only in exchange for the key that replaces it.
		if subtle.ConstantTimeCompare([]byte(c.Token), []byte(bootstrap)) != 1 {
			return Grant{}, errors.New("bootstrap token mismatch")
		}
		if len(c.Claim) < MinClaimLength {
			return Grant{}, fmt.Errorf(
				"this vault has not been claimed, and the key offered to claim it with is %d characters, which is too few",
				len(c.Claim))
		}
		// A vault is claimed with a data key. The session refuses a claim
		// without a usable one before it ever reaches an authenticator, and
		// this is the same rule at the layer that does the writing, so no
		// authenticator can bind a vault whose content keys would derive from
		// the root secret.
		if !store.ValidWrapped(c.Wrapped) {
			return Grant{}, fmt.Errorf(
				"a vault is claimed with a data key, and the wrapped key offered with this claim is %d bytes and not base64url",
				len(c.Wrapped))
		}
		claimed := sha256.Sum256([]byte(c.Claim))
		claimedHash := hex.EncodeToString(claimed[:])
		ok, err := st.ClaimVault(c.VaultID, claimedHash, c.Wrapped, now())
		if err != nil {
			return Grant{}, fmt.Errorf("claiming vault %q: %w", c.VaultID, err)
		}
		if !ok {
			// Another device claimed it between the read and the write. Its key
			// is the vault's key now, and this one is not it.
			return Grant{}, errors.New("the vault was claimed by another device a moment ago")
		}
		return Grant{Bootstrap: true, AuthHash: claimedHash}, nil
	}
}
