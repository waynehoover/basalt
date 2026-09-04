package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/basalt-sync/server/internal/chunks"
	"github.com/waynehoover/basalt-sync/server/internal/store"
	"github.com/waynehoover/basalt-sync/server/internal/wire"
)

// Session is one connected device.
type Session struct {
	srv  *Server
	conn *websocket.Conn
	ctx  context.Context

	// All writes funnel through one goroutine draining out, which keeps frame
	// order without a mutex and stops a stalled peer from blocking whoever is
	// broadcasting to it.
	out chan outFrame
	// queued is the bytes and inflight the frames that have been enqueued and
	// not yet written, counted on every path into out (S8: trySend used to skip
	// the count, so the writer's decrements drove it negative and the byte bound
	// switched itself off). Both are reserved before the frame goes on the
	// channel and released after the write returns, so a zero means every frame
	// has reached the socket. drained wakes a waiter when the writer has taken
	// some away.
	queued    atomic.Int64
	inflight  atomic.Int64
	drained   chan struct{}
	dead      chan struct{}
	closeOnce sync.Once

	// reading is true only while the session goroutine is parked in conn.Read.
	// coder/websocket processes an incoming pong only inside a Reader call, and
	// this goroutine is the only reader, so a ping sent while it is busy sending
	// a fetch would go unanswered however alive the client is. keepalive uses it
	// twice: it pings only when this is set, and it treats a ping that went
	// unanswered while this was clear as no verdict. See keepalive.
	reading atomic.Bool

	vaultID string
	device  string
	remote  string
	joined  bool

	// deviceID is the row in the vault's device list this session
	// authenticated as, and is empty on a registrar session, which is not a
	// device. It is written before the session joins the fan-out and read
	// afterwards by whoever is revoking that device, so the hub's lock is what
	// publishes it; see Hub.sessionsOf.
	deviceID string

	// registrar is true when this session authenticated with the *vault's*
	// credential rather than a device's. Such a session may register a device
	// and rewrap the data key, which are the two powers the root secret has,
	// and may do nothing else: it holds no place in the fan-out, receives no
	// entries and reads none.
	//
	// It is a property of how the session was opened, decided once in
	// handleHello and read by dispatch, rather than a check each handler
	// remembers to make. That is the narrowing enforced: the vault's auth hash
	// stopped being a sync credential in protocol 4, and a vault whose devices
	// could all be bypassed by the credential they replace would be a device
	// list with no revocation that looks like it works.
	registrar bool

	// wrapped is the vault's wrapped data key as this session last saw it. A
	// registrar hands it to each device it registers, which is what lets a
	// device hold the data key without ever holding the root; a rotate on this
	// session replaces it, so a register after a rotate hands out the new
	// wrapping rather than the retired one.
	wrapped string

	// reqID is the id of the request being served, echoed on its reply and on
	// any error refusing it, and zero between requests so that an error sent
	// then, the shutdown notice, is recognisably unsolicited. Only the session
	// goroutine touches it.
	reqID int64

	// bootstrap is true when this session authenticated with the server's
	// first-run token rather than a derived key. Such a session may not rotate
	// the vault; see Grant.
	bootstrap bool

	// authHash is the vault's stored auth hash that this session's credential
	// matched, on a registrar session, and empty on a device's, which
	// authenticated against its own row and never against the vault.
	//
	// It is what both of a registrar's powers compare-and-swap against: a
	// rotation may only replace the credential it proved it holds, and a
	// registration only lands while that credential is still the vault's. Only
	// the session goroutine touches it.
	authHash string

	// counted is true while this session is in the server's pre-auth count,
	// guarded by Server.sessMu (S19).
	counted bool

	// Guards the catch-up handover. Live changes buffer in pending until the
	// backlog is on the wire; see handleHello for why the order matters.
	// pendingBytes is their marshalled size, because 4096 entries naming 65536
	// chunks each is a quarter of a gigabyte, not a buffer.
	mu           sync.Mutex
	catchupDone  bool
	pending      []pendingChange
	pendingBytes int64

	// Shutdown state, guarded by stateMu. busy is set while the session is
	// inside a request, which is when a shutdown must wait for it: the store
	// may be about to commit and the client is owed the ack. closing is set by
	// Server.Shutdown and read by run between requests, so a session that was
	// busy ends itself, with a reason, as soon as its request completes.
	stateMu sync.Mutex
	busy    bool
	closing bool
}

type outFrame struct {
	typ  websocket.MessageType
	data []byte
}

// pendingChange is a live batch held back during catch-up, already marshalled.
// Marshalling at delivery rather than at flush is what lets the buffer be
// bounded by the bytes it actually holds.
type pendingChange struct {
	uid   int64
	frame []byte
}

// Handle runs one connection to completion. The caller has already accepted the
// WebSocket.
func (s *Server) Handle(ctx context.Context, conn *websocket.Conn, remote string) {
	// Small until hello has been accepted, then raised to what an authenticated
	// peer may send; see ReadLimit.
	conn.SetReadLimit(HelloReadLimit)
	sess := &Session{
		srv: s, conn: conn, ctx: ctx, remote: remote,
		out:     make(chan outFrame, SendQueueDepth),
		drained: make(chan struct{}, 1),
		dead:    make(chan struct{}),
	}
	go sess.writeLoop()

	// Admission is the first thing a shutdown stops, and the pre-auth cap is
	// applied here too. A connection accepted between the listener closing and
	// the sessions being told, or one arriving while too many others have not
	// yet said hello, is refused with a reason rather than admitted. The
	// refusal carries no id, because it answers no request; a client reads an
	// error before `ready` as the reason the connection is closing, and `busy`
	// is the code.
	if err := s.admit(sess); err != nil {
		s.log.Info("session refused", "remote", remote, "why", err)
		_ = sess.fatalWith(wire.CodeBusy, err, ShutdownRetryAfter)
		sess.drain(2 * time.Second)
		sess.kill(nil)
		return
	}
	defer s.forget(sess)
	go sess.keepalive()

	err := sess.run()
	if err != nil {
		s.log.Info("session ended", "remote", remote, "vault", sess.vaultID, "err", err)
	}
	// run may have queued an explanatory error frame. Closing immediately drops
	// it, and the client then sees a bare disconnect instead of a reason, which
	// is the difference between a bug someone can fix and one they cannot.
	sess.drain(2 * time.Second)
	sess.kill(nil)
	if sess.joined {
		s.hub.leave(sess.vaultID, sess)
	}
}

func (s *Session) writeLoop() {
	for {
		select {
		case <-s.dead:
			return
		case f := <-s.out:
			ctx, cancel := context.WithTimeout(s.ctx, s.srv.writeWait)
			err := s.conn.Write(ctx, f.typ, f.data)
			cancel()
			// Released only now, after the write returned, so a zero on either
			// counter means the frame has reached the socket rather than merely
			// left the channel. drain relies on that (S10).
			s.queued.Add(-int64(len(f.data)))
			s.inflight.Add(-1)
			// Non-blocking, and one pending wake is enough: a waiter rechecks
			// the counter rather than trusting the signal.
			select {
			case s.drained <- struct{}{}:
			default:
			}
			if err != nil {
				s.kill(err)
				return
			}
		}
	}
}

// kill closes the session once. CloseNow unblocks the read loop so the session
// goroutine notices and unwinds.
func (s *Session) kill(cause error) {
	s.closeOnce.Do(func() {
		if cause != nil {
			s.srv.log.Info("closing session", "remote", s.remote, "vault", s.vaultID, "cause", cause)
		}
		close(s.dead)
		_ = s.conn.CloseNow()
	})
}

// drain waits, bounded, for every queued frame to finish being written, so a
// final error message is not lost to an immediate close.
//
// It waits on inflight, not on the channel being empty. The writer takes a
// frame off the channel and then spends up to WriteWait writing it, and a drain
// that returned once the channel was empty let Handle close the socket in the
// middle of the very frame it was trying to preserve (S10).
func (s *Session) drain(timeout time.Duration) {
	deadline := time.After(timeout)
	for s.inflight.Load() > 0 {
		select {
		case <-s.drained:
		case <-s.dead:
			return
		case <-deadline:
			return
		}
	}
}

// enqueue puts a frame on the queue if there is room for it, and says whether
// it did. It never blocks and never closes anything; the caller decides what
// "no room" means, which is different for a catch-up, a fan-out and a flush.
//
// Room is bytes as well as frames. handleFetch reads a body and sends it, over
// and over, as fast as the queue accepts them, and bounded only by frame count
// that let one peer hold a quarter of a gigabyte of chunk bodies in memory. A
// frame bigger than the whole budget is still accepted when nothing is queued
// ahead of it, or a single large chunk would wait for room that can never
// appear.
//
// The bytes are reserved before the frame is offered and given back if it is
// refused, so the counter is never below what the writer will subtract.
func (s *Session) enqueue(typ websocket.MessageType, data []byte) bool {
	n := int64(len(data))
	if after := s.queued.Add(n); after > SendQueueBytes && after != n {
		s.queued.Add(-n)
		return false
	}
	s.inflight.Add(1)
	select {
	case s.out <- outFrame{typ, data}:
		return true
	default:
		s.queued.Add(-n)
		s.inflight.Add(-1)
		return false
	}
}

// send blocks until the frame is queued.
//
// Only ever called from the session's own goroutine, where blocking is correct
// backpressure: a catch-up can be far larger than the queue, and dropping
// frames there would leave the client with gaps it has been told to expect.
// Waiting here is safe because the peer that is not reading is the one that
// waits.
func (s *Session) send(typ websocket.MessageType, data []byte) error {
	for !s.enqueue(typ, data) {
		select {
		case <-s.drained:
		case <-s.dead:
			return errors.New("session closed")
		case <-s.ctx.Done():
			return s.ctx.Err()
		}
	}
	return nil
}

// trySend never blocks. Used for fan-out from *other* sessions' goroutines,
// where waiting on a stalled peer would stall the pusher.
//
// Overflow drops the peer rather than the frame. Safe, because delivery here is
// not the durable channel: the entries table plus the uid cursor is, so a
// dropped peer receives everything it missed as catch-up on reconnect. Dropping
// the frame instead would leave a live peer permanently short one file.
func (s *Session) trySend(typ websocket.MessageType, data []byte) bool {
	select {
	case <-s.dead:
		return false
	default:
	}
	if !s.enqueue(typ, data) {
		s.kill(errors.New("send queue overflow, peer too slow"))
		return false
	}
	return true
}

func (s *Session) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.send(websocket.MessageText, b)
}

func (s *Session) writeBinary(b []byte) error {
	return s.send(websocket.MessageBinary, b)
}

// errFrame builds an error for this session: the id of the request being
// refused, or none for an unsolicited error, and the retryable verdict, which
// wire.Error fills in from the code. retryAfter is sent only when positive,
// which in practice means `busy`.
//
// Every error leaves here in one shape, including the ones sent before hello,
// so there is no moment in a connection's life when a client has to work out
// which fields an error will have.
func (s *Session) errFrame(id int64, code, msg string, retryAfter time.Duration) wire.Err {
	e := wire.Error(code, msg)
	e.ID = id
	if ms := retryAfter.Milliseconds(); ms > 0 {
		e.RetryAfterMs = ms
	}
	return e
}

// reject reports a refusal the session survives. docs/protocol.md: a rejected
// put returns an error and the session continues, because a protocol with no
// clean way to refuse a push has to close the connection to say no, and then
// every bad file costs a reconnect.
func (s *Session) reject(code string, cause error) error {
	s.srv.log.Warn("rejected", "vault", s.vaultID, "code", code, "err", cause)
	return s.writeJSON(s.errFrame(s.reqID, code, cause.Error(), 0))
}

// refuse writes an error frame the caller already built, shaped for the
// session. The session continues, exactly as it does after reject.
func (s *Session) refuse(e *wire.Err) error {
	return s.writeJSON(s.errFrame(s.reqID, e.Code, e.Msg, 0))
}

// fatal reports a refusal that ends the session, writing the reason first. The
// id is the request's when one is being served, so a client can tell "your put
// was refused and the connection is closing" from "the connection is closing".
func (s *Session) fatal(code string, cause error) error {
	return s.fatalWith(code, cause, 0)
}

// fatalWith is fatal with a retryAfter hint, for the two `busy` refusals.
func (s *Session) fatalWith(code string, cause error, retryAfter time.Duration) error {
	_ = s.writeJSON(s.errFrame(s.reqID, code, cause.Error(), retryAfter))
	return cause
}

// takeID records the request id a message carries, or refuses one that has
// none or one out of range. Pings carry none, because they are answered by
// position and nothing else ever is.
//
// A missing id ends the session rather than refusing the one request: the
// client could not match the refusal to anything, and would read an error with
// no id as the connection closing anyway.
func (s *Session) takeID(m wire.In) error {
	s.reqID = 0
	if m.Op == "ping" {
		return nil
	}
	if m.ID < 1 || m.ID > wire.MaxRequestID {
		return s.fatal(wire.CodeProtoState, fmt.Errorf(
			"%s request carries id %d; every request carries an id from 1 to %d", m.Op, m.ID, wire.MaxRequestID))
	}
	s.reqID = m.ID
	return nil
}

// readMsg waits for the next frame, for as long as the connection lives.
//
// No deadline of its own. A read that timed out could not tell a connection that
// had died from one whose vault was simply settled, and closed both. What bounds
// this now is keepalive: a connection that stops answering pings is closed, and
// closing it is what ends this read.
//
// A client that answers pings and sends nothing else holds a session open. That
// is a slow-loris in a system built for one person's own devices behind a
// tunnel, and MaxPeers already bounds how many of them there can be.
func (s *Session) readMsg() (websocket.MessageType, []byte, error) {
	// A pong is processed only inside this Read, so keepalive may ping only
	// while it is running. The flag is cleared on the way out because the
	// goroutine's next move may be a long send, during which a ping would never
	// be seen.
	s.reading.Store(true)
	defer s.reading.Store(false)
	return s.conn.Read(s.ctx)
}

// keepalive asks a quiet connection whether it is still there.
//
// Runs for the life of the session. A ping that is not answered inside PongWait
// means the far end is gone however healthy the socket looks, which is what a
// laptop closing its lid produces: a connection that will never answer and never
// error either.
func (s *Session) keepalive() {
	ticker := time.NewTicker(s.srv.pingEvery)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.dead:
			return
		case <-ticker.C:
			// Only when the session is parked in a read with nothing queued
			// behind it (S1). A ping sent while the session is mid-send would be
			// answered by the client and never processed here, because only a
			// Read processes a pong. A ping sent with frames still queued goes
			// out behind them and reaches the client only once it has read
			// everything ahead of it, which on a slow link is longer than
			// PongWait however alive the client is. In both cases a peer that
			// has really gone is caught by the write timing out instead, so
			// skipping the tick costs nothing.
			if !s.reading.Load() || s.inflight.Load() > 0 {
				continue
			}
			if s.srv.beforePing != nil {
				s.srv.beforePing()
			}
			ctx, cancel := context.WithTimeout(s.ctx, s.srv.pongWait)
			err := s.conn.Ping(ctx)
			cancel()
			if err == nil {
				continue
			}
			if !s.reading.Load() {
				// The session left its read while the ping was in flight: a
				// request arrived just behind the ping and is being served,
				// and the pong is sitting unprocessed behind it. That is not a
				// verdict on the connection. The next tick asks again once the
				// session is back in a read.
				continue
			}
			// Closing the connection ends the read this session is parked on,
			// which ends the session. Logged at debug: a device going away is
			// ordinary.
			s.srv.log.Debug("connection stopped answering",
				"remote", s.remote, "vault", s.vaultID, "err", err)
			s.kill(nil)
			return
		}
	}
}

/* ---------------------------------------------------------------- *
 * Shutdown
 * ---------------------------------------------------------------- */

// enter marks the session busy with a request, or reports that the server is
// shutting down and the request must not start. Called between reading a
// message and acting on it, so a shutdown that arrives while a request is in
// flight waits for it, and one that arrives before it starts refuses it.
func (s *Session) enter() bool {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if s.closing {
		return false
	}
	s.busy = true
	return true
}

// leave marks the request finished and reports whether a shutdown is waiting.
func (s *Session) leave() (closing bool) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	s.busy = false
	return s.closing
}

// shutdown tells the session the server is stopping.
//
// An idle session is told why and closed here. A busy one is left to finish
// the request it is in: the store may be mid-commit and the client is owed an
// ack that means what it says, so the session ends itself, with the same
// reason, once run sees the flag. Server.Shutdown bounds how long that may
// take and kills whatever is left at the deadline.
//
// The read cannot simply be cancelled to interrupt an idle session: cancelling
// the context of a coder/websocket Read closes the connection, which is the
// bare disconnect a reason frame exists to avoid.
func (s *Session) shutdown() {
	s.stateMu.Lock()
	s.closing = true
	idle := !s.busy
	s.stateMu.Unlock()
	if !idle {
		return
	}
	// A refusal frame from a goroutine other than the session's, with no id
	// because no request asked for it. trySend rather than send, because this
	// must not wait on a peer that has stopped reading, and a peer whose queue
	// is full at shutdown is dropped as one.
	if b, err := json.Marshal(s.errFrame(0, wire.CodeBusy, errShuttingDown.Error(), ShutdownRetryAfter)); err == nil {
		s.trySend(websocket.MessageText, b)
	}
	s.drain(time.Second)
	s.kill(nil)
}

// evict closes this session from another goroutine because the credential it
// is holding stopped opening what it opened: a rotation retired a registrar's
// root, or a revoke deleted a device's row.
//
// The notice is unsolicited `auth` in both cases, with a message that says
// which. `auth` is the code a client already stops on, and the two causes want
// the same thing from it: stop, and do not reconnect with what you have.
func (s *Session) evict(msg string, cause error) {
	if s.srv.beforeEvict != nil {
		s.srv.beforeEvict()
	}
	if b, err := json.Marshal(s.errFrame(0, wire.CodeAuth, msg, 0)); err == nil {
		s.trySend(websocket.MessageText, b)
	}
	s.drain(time.Second)
	s.kill(cause)
}

/* ---------------------------------------------------------------- *
 * Lifecycle
 * ---------------------------------------------------------------- */

func (s *Session) run() error {
	// A connection has HelloTimeout to say hello (S19). The timer, not a read
	// deadline: cancelling a coder/websocket Read closes the connection with
	// nothing said, and a reason frame is the difference between a client
	// that can be fixed and one that cannot. Stopped as soon as a frame has
	// arrived, so a slow authentication is never mistaken for a silent peer.
	deadline := time.AfterFunc(s.srv.helloTimeout, func() {
		if b, err := json.Marshal(s.errFrame(0, wire.CodeProtoState,
			fmt.Sprintf("no hello within %s of connecting", s.srv.helloTimeout), 0)); err == nil {
			s.trySend(websocket.MessageText, b)
		}
		s.drain(time.Second)
		s.kill(errors.New("no hello before the deadline"))
	})
	typ, data, err := s.readMsg()
	deadline.Stop()
	if err != nil {
		return err
	}
	if typ != websocket.MessageText {
		return s.fatal(wire.CodeProtoState,
			fmt.Errorf("first frame must be text hello, got %v", typ))
	}
	var m wire.In
	if err := json.Unmarshal(data, &m); err != nil {
		return s.fatal(wire.CodeProtoState, fmt.Errorf("hello parse: %w", err))
	}
	if m.Op != "hello" {
		return s.fatal(wire.CodeProtoState, fmt.Errorf("first op must be hello, got %q", m.Op))
	}
	if !s.enter() {
		return s.fatalWith(wire.CodeBusy, errShuttingDown, ShutdownRetryAfter)
	}
	err = s.handleHello(m)
	s.reqID = 0
	if closing := s.leave(); err == nil && closing {
		err = s.fatalWith(wire.CodeBusy, errShuttingDown, ShutdownRetryAfter)
	}
	if err != nil {
		return err
	}

	for {
		typ, data, err := s.readMsg()
		if err != nil {
			return err
		}
		if typ == websocket.MessageBinary {
			// Bodies are only ever read inside handlePut, where the server
			// knows exactly how many to expect. A binary frame anywhere else
			// means the two ends disagree about protocol state, and continuing
			// would mean guessing what it was.
			return s.fatal(wire.CodeProtoState,
				fmt.Errorf("unexpected binary frame (%d bytes)", len(data)))
		}
		var m wire.In
		if err := json.Unmarshal(data, &m); err != nil {
			return s.fatal(wire.CodeProtoState, fmt.Errorf("parse: %w", err))
		}
		if err := s.takeID(m); err != nil {
			return err
		}
		// The shutdown check sits around the request, not around the read.
		// A request already in flight is finished, so a put that has stored
		// its bodies gets its commit and its ack; one that arrives after the
		// shutdown began is refused before it starts anything (S16).
		if !s.enter() {
			return s.fatalWith(wire.CodeBusy, errShuttingDown, ShutdownRetryAfter)
		}
		err = s.dispatch(m, len(data))
		// Cleared before the shutdown notice below, so that notice carries no
		// id: it answers no request.
		s.reqID = 0
		if closing := s.leave(); err == nil && closing {
			err = s.fatalWith(wire.CodeBusy, errShuttingDown, ShutdownRetryAfter)
		}
		if err != nil {
			return err
		}
	}
}

// deviceOps is every op a session must hold a device credential to send. It
// exists so that a registrar asking for one is told which credential it needs,
// while a genuinely unknown op is still an unknown op: a client waiting on a
// reply that will never come looks the same either way, and the two are fixed
// differently.
var deviceOps = map[string]bool{
	"put": true, "putmany": true, "get": true, "fetch": true,
	"history": true, "deleted": true, "invite": true,
	"devices": true, "revoke": true,
}

// dispatch routes one request. frameLen is the encoded size of the frame it
// arrived in, which is what maxBatchBytes bounds.
//
// What a session may do is decided here, once, from the credential that opened
// it, rather than by each handler remembering to ask. Per-handler checks are
// how the next op added becomes the one that forgot, and the op that forgot
// here would be the vault credential syncing again.
func (s *Session) dispatch(m wire.In, frameLen int) error {
	if m.Op == "hello" {
		return s.fatal(wire.CodeProtoState, errors.New("hello sent twice"))
	}
	if s.registrar {
		switch m.Op {
		case "register":
			return s.handleRegister(m)
		case "rotate":
			return s.handleRotate(m)
		case "ping":
			// Allowed, and the one exception to "nothing else". A pong reads
			// nothing, writes nothing and says nothing about the vault; it is
			// how a connection behind NAT stays open, and a registrar that
			// could not answer for itself would be a registration that fails
			// on the slow walk to the other device.
			return s.writeJSON(wire.Pong{Res: "pong"})
		}
		if deviceOps[m.Op] {
			return s.reject(wire.CodeAuth, fmt.Errorf(
				"this session authenticated with the vault's credential, which may register a device "+
					"and rotate the vault's secret and may not sync; %q needs a device's own credential", m.Op))
		}
		return s.reject(wire.CodeProtoState, fmt.Errorf("unknown op %q", m.Op))
	}

	switch m.Op {
	case "ping":
		return s.writeJSON(wire.Pong{Res: "pong"})
	case "put":
		return s.handlePut(m)
	case "putmany":
		return s.handlePutMany(m, frameLen)
	case "get":
		return s.handleGet(m)
	case "fetch":
		return s.handleFetch(m)
	case "history":
		return s.handleHistory(m)
	case "deleted":
		return s.handleDeleted(m)
	case "invite":
		return s.handleInvite(m)
	case "devices":
		return s.handleDevices(m)
	case "revoke":
		return s.handleRevoke(m)
	case "register":
		// A device may not mint a credential. That is the whole point of a
		// device not holding the root: a stolen laptop can read what it
		// already had and cannot add a ninth device to the vault behind you.
		//
		// A device session also has no vault credential to register under, so
		// handleRegister would refuse it a second time if this were removed.
		// This refusal exists to be the one that says what to do instead.
		return s.reject(wire.CodeAuth, errors.New(
			"a device may not register another device, because it does not hold the vault's credential; "+
				"add a device with an invite, or with the recovery key"))
	case "rotate":
		// Rotation retires the root secret and rewraps the data key, and a
		// device holds neither. Letting one through would also mean a stolen
		// device could write a credential nobody holds into the vault and
		// leave the recovery key opening nothing.
		return s.reject(wire.CodeAuth, errors.New(
			"rotating the vault's secret needs the vault's credential, which a device does not hold; "+
				"connect with the recovery key"))
	}
	// Named, not ignored. A client blocked waiting on a reply it will never
	// get looks exactly like a hung server.
	return s.reject(wire.CodeProtoState, fmt.Errorf("unknown op %q", m.Op))
}

func (s *Session) handleHello(m wire.In) error {
	// Version before credentials: refusing on proto is not a security answer
	// and a client on the wrong version deserves to be told so plainly. The
	// range is one version wide today and the check is written as a range on
	// purpose; see wire.Proto.
	//
	// Both numbers and nothing else. Nothing has authenticated yet, so this
	// refusal is what anyone on the internet gets for one JSON frame, and it
	// used to name the release: "this server (version 0.3.2) speaks 3 to 3".
	// Behind Caddy that is the port on the open internet handing a prober the
	// string a targeted exploit starts from. The version is in `ready`, after
	// auth, for the device that has proved it may ask; see docs/design.md, "What
	// a stranger on the port learns", and
	// TestAProtoRefusalDoesNotNameTheServerVersion.
	if m.Proto < wire.MinProto || m.Proto > wire.Proto {
		return s.fatal(wire.CodeProto, fmt.Errorf(
			"protocol %d not supported, this server speaks %d to %d",
			m.Proto, wire.MinProto, wire.Proto))
	}
	if err := s.takeID(m); err != nil {
		return err
	}
	if m.Crypto != wire.Crypto {
		// The same rule as the proto refusal above, for the same reason.
		return s.fatal(wire.CodeProto,
			fmt.Errorf("crypto %q not supported, this server speaks %q",
				m.Crypto, wire.Crypto))
	}
	if m.Vault == "" {
		return s.fatal(wire.CodeAuth, errors.New("missing vault"))
	}
	// Both names are bounded and checked for control characters before either
	// is logged or handed to the authenticator (S24, I6). They land in log
	// lines and, for the device, on every entry it writes, and a newline in a
	// log line is a forged log line.
	if err := checkName("vault", m.Vault, store.MaxVaultLen); err != nil {
		return s.fatal(wire.CodeBadName, err)
	}
	if err := checkName("device", m.Device, store.MaxDeviceLen); err != nil {
		return s.fatal(wire.CodeBadName, err)
	}
	if m.Cursor < 0 {
		return s.fatal(wire.CodeProtoState, fmt.Errorf("negative cursor %d", m.Cursor))
	}
	// A vault is claimed with a data key, always. The check is on the request's
	// own fields, so it happens before authentication and leaks nothing about
	// the vault: a device that offers a claim and no usable wrapped key is
	// refused whether or not the vault was there to be claimed.
	//
	// This is what makes the downgrade attack unexpressible. While a vault
	// could exist either with a data key or without one, a server could choose
	// which key schedule a client used by leaving `wrapped` out of `ready`,
	// and the client had no way to tell that from a vault that genuinely had
	// none. Every claimed vault having one removes the choice rather than
	// defending against it.
	if m.Claim != "" && !store.ValidWrapped(m.Wrapped) {
		return s.fatal(wire.CodeBadEntry, fmt.Errorf(
			"a vault is claimed with a data key, and the wrapped key offered with this claim is %d bytes; "+
				"it must be base64url of at most %d", len(m.Wrapped), store.MaxWrappedLen))
	}
	// An invite stands in for the token, so a hello carrying both is refused
	// rather than resolved. The authenticator triggers on the invite alone, so
	// a both-present hello used to get token authentication with the invite
	// silently ignored: neither redeemed nor refused, and the device that was
	// handed that invite would wait for a pairing that had already been used
	// up by nothing. One credential per hello, and the refusal says which two
	// were sent.
	if m.Token != "" && m.Invite != "" {
		return s.fatal(wire.CodeBadEntry, errors.New(
			"this hello carries both a token and an invite, and an invite stands in for a token; send one"))
	}

	// The fork protocol 4 is about, and the whole of how the narrowing is
	// enforced rather than remembered.
	//
	// A hello carrying a deviceId is a device connecting, and its token is
	// that device's own auth key, checked against that device's row. A hello
	// carrying none offers the vault's credential, which since protocol 4 may
	// register a device and rewrap the data key and may not sync.
	//
	// There is exactly one place a syncing session is built, helloAsDevice,
	// and the only way into it is a device row whose hash matched. The
	// pluggable Authenticator, which answers "does this token open this
	// vault", is not consulted on that branch at all, so no authenticator and
	// no later handler can hand the vault's credential the sync rights it lost.
	// TestTheVaultCredentialCannotSync.
	if m.DeviceID != "" {
		// Shape first, and as `badname` rather than `auth`, because it is a
		// fact about the request rather than about the vault: refusing a
		// malformed id as an authentication failure would make the shape of an
		// id look like the answer to whether that device exists.
		if !store.ValidDeviceID(m.DeviceID) {
			return s.fatal(wire.CodeBadName, fmt.Errorf(
				"device id is %d bytes and must be base64url of at most %d",
				len(m.DeviceID), store.MaxDeviceIDLen))
		}
		// A device connecting is not a vault being claimed and is not an
		// invite being redeemed, and a server that picked one for the client
		// would be choosing which credential it meant. The same rule, and the
		// same code, as the token-and-invite refusal above.
		if m.Claim != "" || m.Invite != "" {
			return s.fatal(wire.CodeBadEntry, errors.New(
				"this hello carries a deviceId, which is a registered device connecting, "+
					"as well as a claim or an invite, which are how a vault is bound and how a device is added; send one"))
		}
		return s.helloAsDevice(m)
	}
	return s.helloAsRegistrar(m)
}

// helloAsDevice finishes a hello that named a device: the sync path, and the
// only one there is.
//
// No Authenticator on this branch. It answers whether a token opens a *vault*,
// which since protocol 4 is a different question from whether a connection is
// a device of that vault, and asking it here is exactly how the vault's
// credential would find its way back to syncing.
func (s *Session) helloAsDevice(m wire.In) error {
	_, stored, ok, err := s.srv.st.DeviceByID(m.Vault, m.DeviceID)
	if err != nil {
		return s.fatal(wire.CodeInternal, err)
	}
	// A device with no row and a device whose key is wrong are one refusal,
	// saying neither which, exactly as a wrong vault and a wrong token are.
	// Telling them apart would tell a caller which half to keep guessing, and
	// after a revoke it would also confirm that this id was a device here
	// yesterday.
	//
	// Constant time and over the digests, so the comparison is a fixed 32
	// bytes whatever was offered. A device with no row is compared against a
	// digest that cannot match rather than skipped, so an unregistered id and
	// a wrong key take the same time as each other.
	offered := sha256.Sum256([]byte(m.Token))
	want, decodeErr := hex.DecodeString(stored)
	if !ok || decodeErr != nil || len(want) != len(offered) {
		want = make([]byte, len(offered))
	}
	if subtle.ConstantTimeCompare(offered[:], want) != 1 || !ok {
		s.srv.log.Warn("device auth failed", "remote", s.remote, "vault", m.Vault,
			"deviceId", m.DeviceID, "registered", ok)
		return s.fatal(wire.CodeAuth, errors.New("not authorised for this vault"))
	}

	// The vault's key material. A device that has converted holds the data key
	// itself and ignores the wrapping, but the blob is what a device still
	// carrying the root uses, and it is what says the vault is serveable at
	// all: a vault with a hash and no wrapped key was written by a build whose
	// key schedule no longer exists, and serving it would hand a device a
	// vault it can neither read nor safely add to.
	hash, wrapped, _, err := s.srv.st.VaultKeys(m.Vault)
	if err != nil {
		return s.fatal(wire.CodeInternal, err)
	}
	if hash != "" && wrapped == "" {
		return s.fatal(wire.CodeProto, fmt.Errorf(
			"vault %q was claimed by an older build and has no data key, which this server (version %s) "+
				"cannot serve: start a fresh data directory and pair the first device again", m.Vault, s.srv.version))
	}
	// No rotation check on this path, and that is the point of the feature. A
	// rotation replaces the root and rewraps the same data key; it touches no
	// device row, so every device goes on syncing across one. Under protocol 3
	// the vault's hash *was* the device's credential, so a rotation had to
	// evict everybody; a device refused here for somebody else's rotation
	// would be the weekend of re-pairing this exists to abolish.
	// TestRotationLeavesEveryDeviceRowAndEverySessionAlone.

	s.vaultID = m.Vault
	s.device = m.Device
	s.deviceID = m.DeviceID
	s.wrapped = wrapped
	// Authenticated: out of the pre-auth count, and allowed the full read
	// limit from here on. Taking sessMu here is also what publishes the fields
	// just written to any goroutine that later takes it.
	s.srv.authenticated(s)
	s.conn.SetReadLimit(ReadLimit)

	if err := s.srv.st.EnsureVault(m.Vault, s.srv.now().UnixMilli()); err != nil {
		return s.fatal(wire.CodeInternal, err)
	}
	latest, err := s.srv.st.LatestUID(m.Vault)
	if err != nil {
		return s.fatal(wire.CodeInternal, err)
	}
	// A client ahead of the server is refused, loudly.
	//
	// It means the server lost history the client has already applied: restored
	// from an old backup, or pointed at a different vault. Left alone, the
	// server reissues uids the client already used for other content, and the
	// two diverge with both sides reporting success. Refusing costs a manual
	// intervention; not refusing costs the vault.
	if m.Cursor > latest {
		return s.fatal(wire.CodeCursor, fmt.Errorf(
			"client cursor %d is ahead of this server's %d: the server is missing history "+
				"the client has already applied, so it would reissue those uids for other files",
			m.Cursor, latest))
	}

	// Join before the backlog is read, not after.
	//
	// Everything committed from this moment reaches us as a broadcast, and
	// deliver buffers those until the replay below is on the wire. There is
	// therefore no interval in which an entry is neither in the backlog query
	// nor in the fan-out, which is the window a check-then-join ordering leaves
	// open and which loses exactly one file when it is hit.
	if s.srv.beforeJoin != nil {
		s.srv.beforeJoin()
	}
	peers, admitted := s.srv.hub.joinIfRoom(m.Vault, s, s.srv.maxPeers)
	if !admitted {
		return s.fatalWith(wire.CodeBusy, fmt.Errorf(
			"vault has %d devices connected, limit is %d", peers, s.srv.maxPeers), DeviceLimitRetryAfter)
	}
	s.joined = true

	// Still registered, and stamped as seen, in one statement.
	//
	// After the join and not before, which is what makes a revoke racing a
	// connect come out right whichever order they land in. A revoke deletes
	// the row and only then collects the sessions to close. If the delete
	// lands before this update, SawDevice moves no rows, because it is an
	// UPDATE and never an upsert, and this session is refused. If it lands
	// after, this session was already in the hub when the revoke looked, so
	// the revoke closes it. There is no interleaving that leaves a revoked
	// device connected. TestARevokeRacingAConnectAlwaysWins.
	if err := s.srv.st.SawDevice(m.Vault, m.DeviceID, s.srv.now().UnixMilli()); err != nil {
		if errors.Is(err, store.ErrUnknownDevice) {
			s.srv.log.Warn("device revoked mid-handshake", "remote", s.remote,
				"vault", m.Vault, "deviceId", m.DeviceID)
			return s.fatal(wire.CodeAuth, errors.New("not authorised for this vault"))
		}
		return s.fatal(wire.CodeInternal, err)
	}

	// Limits first, so a client knows every ceiling before its first put rather
	// than discovering one by being rejected.
	if err := s.writeJSON(s.srv.ready(s.reqID, latest, wrapped)); err != nil {
		return err
	}
	s.srv.log.Info("session ready", "remote", s.remote, "vault", m.Vault,
		"device", m.Device, "deviceId", m.DeviceID, "cursor", m.Cursor, "latest", latest, "peers", peers)

	cursor, sent, err := s.replay(m.Vault, m.Cursor)
	if err != nil {
		return err
	}
	if s.srv.afterReplay != nil {
		s.srv.afterReplay()
	}
	// Release anything committed while the replay was running, in uid order and
	// skipping what the replay already covered. flushPending also queues the
	// caught-up frame, under the same lock, so a broadcast cannot slip in ahead
	// of it; see flushPending.
	cursor = s.flushPending(cursor)

	if sent > 0 {
		s.srv.log.Info("catch-up sent", "vault", m.Vault, "entries", sent, "cursor", cursor)
	}
	return nil
}

// helloAsRegistrar finishes a hello that offered the vault's credential.
//
// What comes back is a session that may register a device and rotate the
// vault's secret, and nothing else. It joins no vault's fan-out, so it is sent
// no entry and occupies no device slot, and it is given no `ready`, because
// `ready` promises the ceilings for a put and a backlog behind it and this
// session will never get either.
func (s *Session) helloAsRegistrar(m wire.In) error {
	creds := Credentials{VaultID: m.Vault, Token: m.Token, Claim: m.Claim, Wrapped: m.Wrapped, Invite: m.Invite}
	grant, err := s.srv.auth(creds)
	if err != nil {
		// Logged in full, reported as one word. Telling a caller whether the
		// vault or the token was wrong tells them which half to keep guessing.
		s.srv.log.Warn("auth failed", "remote", s.remote, "vault", m.Vault, "err", err)
		return s.fatal(wire.CodeAuth, errors.New("not authorised for this vault"))
	}
	// The vault's key material, one read for both columns, used by both paths
	// below. After auth and never before it: a first device's claim writes both
	// columns while it authenticates, so reading any earlier would send that
	// device an empty wrapped in ready.
	//
	// A vault with a hash and no wrapped key cannot be produced by this build,
	// because a claim without one is refused above. A data directory written by
	// an older build can hold one, and there is no key schedule left to serve
	// it under: every content key derives from the data key now. Serving it
	// would mean handing a device a vault it can neither read nor safely add
	// to, so the session is refused with something an operator can act on.
	hash, wrapped, _, err := s.srv.st.VaultKeys(m.Vault)
	if err != nil {
		return s.fatal(wire.CodeInternal, err)
	}
	// The vault must still be the one that was just authenticated against. A
	// rotation committed between the authenticator's read and this one would
	// otherwise hand this device the new blob, which the root it holds cannot
	// unwrap, under a credential the vault no longer knows.
	if grant.AuthHash != "" && hash != grant.AuthHash {
		return s.fatal(wire.CodeAuth, errors.New(
			"the vault's secret was rotated while this session was authenticating; pair again with the new string"))
	}
	if hash != "" && wrapped == "" {
		return s.fatal(wire.CodeProto, fmt.Errorf(
			"vault %q was claimed by an older build and has no data key, which this server (version %s) "+
				"cannot serve: start a fresh data directory and pair the first device again", m.Vault, s.srv.version))
	}

	if grant.Redeemed {
		// The invite is already marked used. Hand over the sealed secret and
		// the wrapped key, then close: this connection proved nothing about
		// holding the root and is not a device yet. It connects again with
		// the derived key like any other.
		s.srv.log.Info("invite redeemed", "remote", s.remote, "vault", m.Vault, "device", m.Device)
		if err := s.writeJSON(wire.Redeemed{Res: "redeemed", ID: s.reqID, Sealed: grant.Sealed, Wrapped: wrapped}); err != nil {
			return err
		}
		return errRedeemed
	}
	s.bootstrap = grant.Bootstrap
	s.authHash = grant.AuthHash
	s.wrapped = wrapped

	s.vaultID = m.Vault
	s.device = m.Device
	s.registrar = true
	// Authenticated: out of the pre-auth count, and allowed the full read
	// limit from here on. Taking sessMu here is also what publishes the fields
	// just written, registrar and vaultID among them, to the goroutine of
	// whoever later rotates this vault; see Server.registrarsOn.
	s.srv.authenticated(s)
	s.conn.SetReadLimit(ReadLimit)

	if err := s.srv.st.EnsureVault(m.Vault, s.srv.now().UnixMilli()); err != nil {
		return s.fatal(wire.CodeInternal, err)
	}
	// No join, no cursor check and no catch-up: there is nothing this session
	// may be sent. It is not counted against the vault's connected-device
	// limit either, because it is not a device and holding a slot open would
	// mean adding a device could cost you one.
	s.srv.log.Info("registrar ready", "remote", s.remote, "vault", m.Vault,
		"device", m.Device, "bootstrap", grant.Bootstrap)
	return s.writeJSON(wire.Registrar{
		Res: "registrar", ID: s.reqID,
		Proto: wire.Proto, MinProto: wire.MinProto,
		ServerVersion: s.srv.version, MaxDevices: store.MaxDevices,
	})
}

// errRedeemed ends a session that connected only to redeem an invite. It is not
// a fault, so no error frame follows the reply; Handle drains and closes.
var errRedeemed = errors.New("invite redeemed, closing")

// errRevokedSelf ends a session that revoked its own device, which is what
// unlinking is. Like errRedeemed it is not a fault: the reply saying so has
// already gone, and Handle drains and closes behind it.
var errRevokedSelf = errors.New("this device revoked itself, closing")

// checkName bounds a vault or device name and refuses control characters in it.
//
// The rule itself moved to store.CheckName when device names became rows in the
// devices table as well as fields on a hello: a name written by a path that
// does not come through here has to be bounded the same way, and two copies of
// a validation is how the two layers come to disagree about what a name is.
// This stays as the name this file has always called it, so the refusals a
// client sees are the same strings they were.
func checkName(what, name string, max int) error { return store.CheckName(what, name, max) }

// replay sends the backlog as batches and returns the cursor it reached.
func (s *Session) replay(vaultID string, cursor int64) (int64, int, error) {
	sent := 0
	for {
		b, ok, err := s.srv.st.NextBatch(vaultID, cursor, s.srv.batchSize)
		if err != nil {
			return cursor, sent, s.fatal(wire.CodeInternal, err)
		}
		if !ok {
			return cursor, sent, nil
		}
		if b.From != cursor+1 {
			// The store computes From as cursor+1, so this can only fire if
			// that ever stops being true. It is checked because the whole
			// point of From is that a client can trust it.
			return cursor, sent, s.fatal(wire.CodeInternal, fmt.Errorf(
				"batch from %d does not continue cursor %d", b.From, cursor))
		}
		entries := b.Entries
		if entries == nil {
			entries = []store.Entry{}
		}
		if err := s.writeJSON(wire.Batch{
			Op: "batch", From: b.From, To: b.To, Entries: entries,
		}); err != nil {
			return cursor, sent, err
		}
		cursor = b.To
		sent += len(b.Entries)
		if s.srv.afterReplayBatch != nil {
			s.srv.afterReplayBatch(sent)
		}
	}
}

/* ---------------------------------------------------------------- *
 * Live delivery
 * ---------------------------------------------------------------- */

// deliver is the non-blocking path used by the hub.
//
// While this session is still replaying its backlog the change is buffered
// rather than written. Writing it immediately would let a newer uid overtake an
// older catch-up frame in the same queue, and a client that advances its cursor
// to a batch's To would then step past files it has not received.
func (s *Session) deliver(e store.Entry, elide bool) {
	b, err := json.Marshal(liveBatch(e, elide))
	if err != nil {
		return
	}

	s.mu.Lock()
	if !s.catchupDone {
		// Bounded in bytes as well as entries (S8). The entry bound alone let
		// a peer hold 4096 marshalled batches of any size, and a batch naming
		// tens of thousands of chunks is megabytes.
		if len(s.pending) >= CatchupBufferMax || s.pendingBytes+int64(len(b)) > CatchupBufferBytes {
			s.mu.Unlock()
			s.kill(errors.New("catch-up buffer overflow, peer too slow"))
			return
		}
		s.pending = append(s.pending, pendingChange{uid: e.UID, frame: b})
		s.pendingBytes += int64(len(b))
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	s.trySend(websocket.MessageText, b)
}

// liveBatch wraps one committed entry as a single-uid covered range, so live
// changes and catch-up are the same message and the client has one code path.
func liveBatch(e store.Entry, elide bool) wire.Batch {
	// Empty, never nil. A nil slice marshals to JSON null, and a client that
	// iterates entries would then crash on precisely the batches it is meant to
	// handle silently: its own echoes, which are the common case.
	b := wire.Batch{Op: "batch", From: e.UID, To: e.UID, Entries: []store.Entry{}}
	if !elide {
		b.Entries = []store.Entry{e}
	}
	return b
}

// flushPending releases buffered live changes, queues caught-up, and switches
// to direct delivery. Returns the highest uid written.
//
// The sort matters. Two entries can commit in uid order and reach the hub in
// the opposite order, because AppendEntry releases the store's write lock
// before the broadcast runs. The flush, the caught-up frame, and the flag flip
// all happen under one lock so a change arriving mid-flush cannot slip in ahead
// of any of them.
//
// caught-up is queued here, before catchupDone is set, rather than by the
// caller afterwards (S2). Set the flag first and a broadcast from another
// session reaches s.out through deliver before caught-up does, carrying a uid
// above the cursor caught-up will announce. The real client
// (client/src/core/transport.ts) treats a batch after caught-up whose range is
// below caught-up's cursor as fatal protostate, so that reordering drops a
// healthy device.
//
// When the queue has no room, the lock is released and the session waits for
// the writer, then tries again. The queue is often nearly full here, because
// the replay that just finished fills it as fast as the client drains it, and
// the alternative of dropping the peer for that would turn every catch-up over
// a slow link into a reconnect loop. Waiting *inside* the lock is not an
// option either: deliver takes it, so one slow peer would stall every other
// session's fan-out. Changes that land while the lock is released go into
// pending and are picked up on the next pass, still in uid order.
func (s *Session) flushPending(cursor int64) int64 {
	for {
		done, next := s.flushPendingOnce(cursor)
		cursor = next
		if done {
			break
		}
		select {
		case <-s.drained:
		case <-s.dead:
			return cursor
		case <-s.ctx.Done():
			return cursor
		}
	}
	if s.srv.afterFlush != nil {
		s.srv.afterFlush()
	}
	return cursor
}

// flushPendingOnce queues as much of pending as the queue has room for, then
// caught-up. It reports done once caught-up is queued and the handover is
// complete; otherwise what did not fit stays in pending for the next pass.
func (s *Session) flushPendingOnce(cursor int64) (bool, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	sort.Slice(s.pending, func(i, j int) bool {
		return s.pending[i].uid < s.pending[j].uid
	})
	for len(s.pending) > 0 {
		p := s.pending[0]
		if p.uid <= cursor {
			// The replay already covered it.
			s.pending = s.pending[1:]
			s.pendingBytes -= int64(len(p.frame))
			continue
		}
		if !s.enqueue(websocket.MessageText, p.frame) {
			return false, cursor
		}
		s.pending = s.pending[1:]
		s.pendingBytes -= int64(len(p.frame))
		cursor = p.uid
	}
	// Same queue, same lock, so nothing can be enqueued between the last
	// buffered change and caught-up.
	b, err := json.Marshal(wire.CaughtUp{Op: "caught-up", Cursor: cursor})
	if err != nil || !s.enqueue(websocket.MessageText, b) {
		return false, cursor
	}
	s.pending = nil
	s.pendingBytes = 0
	s.catchupDone = true
	return true, cursor
}

/* ---------------------------------------------------------------- *
 * put
 * ---------------------------------------------------------------- */

// checkEntry runs every refusal a single put makes, without writing one.
//
// Split out of handlePut so a batch can decide per entry and carry on. The
// order matters and is the order handlePut used: the two named refusals first,
// because docs/protocol.md gives badname and toolarge their own codes and a
// client acts on them differently, then Validate, which is the enforcer.
func (s *Session) checkEntry(e store.Entry) *wire.Err {
	if e.Path == "" || len(e.Path) > store.MaxPathLen {
		err := wire.Error(wire.CodeBadName,
			fmt.Sprintf("path is %d bytes, must be 1 to %d", len(e.Path), store.MaxPathLen))
		return &err
	}
	if e.Size > s.srv.perFileMax {
		err := wire.Error(wire.CodeToolarge,
			fmt.Sprintf("file is %d bytes, limit is %d", e.Size, s.srv.perFileMax))
		return &err
	}
	if len(e.Chunks) > store.MaxChunksPerEntry {
		err := wire.Error(wire.CodeToolarge,
			fmt.Sprintf("%d chunks, limit is %d", len(e.Chunks), store.MaxChunksPerEntry))
		return &err
	}
	if err := e.Validate(); err != nil {
		refusal := wire.Error(wire.CodeBadEntry, err.Error())
		return &refusal
	}
	return nil
}

// handlePutMany is handlePut for several entries and one round trip.
//
// The shape is the same: work out what is missing, ask for it once, read the
// bodies, commit. What changes is that the want list is the union across every
// entry and the answer is one result per entry, so a batch of two hundred
// paths costs one exchange rather than two hundred.
//
// Nothing is committed until every body has arrived, and each entry is then
// committed on its own, so an ack still means what it has always meant: this
// entry and its bodies are durable.
func (s *Session) handlePutMany(m wire.In, frameLen int) error {
	if len(m.Entries) == 0 {
		return s.reject(wire.CodeBadEntry, errors.New("a batched put with no entries in it"))
	}
	if len(m.Entries) > wire.MaxBatchEntries {
		return s.reject(wire.CodeToolarge,
			fmt.Errorf("%d entries in one put, limit is %d", len(m.Entries), wire.MaxBatchEntries))
	}
	// The two bounds maxBatchBytes names (S18). The frame, so that a batch
	// naming enough chunks to matter is refused with a code rather than dying
	// at the read limit; and the summed budget over every entry, so that one
	// exchange can never be allowed to upload more than the cap however many
	// files it carries. The budget is summed over every entry rather than
	// over what the server lacks, because that is the figure a client can
	// compute for itself before sending.
	if int64(frameLen) > s.srv.maxBatchBytes {
		return s.reject(wire.CodeToolarge, fmt.Errorf(
			"the putmany frame is %d bytes, limit is %d; split the batch", frameLen, s.srv.maxBatchBytes))
	}
	var budgets int64
	for _, in := range m.Entries {
		budgets += store.CiphertextBudget(in.Meta.Size, len(in.Chunks))
	}
	if budgets > s.srv.maxBatchBytes {
		return s.reject(wire.CodeToolarge, fmt.Errorf(
			"the entries in this batch could upload %d bytes between them, limit is %d; "+
				"split the batch, and send a file over the limit on its own with put",
			budgets, s.srv.maxBatchBytes))
	}

	type prepared struct {
		entry   store.Entry
		refusal *wire.Err
	}
	items := make([]prepared, len(m.Entries))

	// The union, in the order the entries name them, without repeats: two files
	// sharing a chunk ask for it once, which is the whole of what dedup buys on
	// a first sync.
	var want []string
	asked := map[string]struct{}{}
	var allowance int64

	for i, in := range m.Entries {
		e := in.Entry(s.device)
		missing, spend, refusal := s.prepare(e)
		if refusal != nil {
			// One entry's refusal is one entry's result in the acks, and the
			// rest of the batch still commits, so it is carried rather than
			// written. Unlike handlePut, nothing is logged here.
			items[i] = prepared{entry: e, refusal: refusal}
			continue
		}

		items[i] = prepared{entry: e}
		for _, name := range missing {
			if _, seen := asked[name]; seen {
				continue
			}
			asked[name] = struct{}{}
			want = append(want, name)
		}
		allowance += spend
	}

	if len(want) > 0 {
		if err := s.writeJSON(wire.Want{Res: "want", ID: s.reqID, Chunks: want}); err != nil {
			return err
		}
		if err := s.readBodies(want, allowance); err != nil {
			return err
		}
	}

	results := make([]wire.AckResult, len(items))
	for i, item := range items {
		if item.refusal != nil {
			results[i] = wire.AckResult{Code: item.refusal.Code, Msg: item.refusal.Msg}
			continue
		}
		uid, refusal := s.commit(item.entry)
		if refusal != nil {
			results[i] = wire.AckResult{Code: refusal.Code, Msg: refusal.Msg}
			continue
		}
		results[i] = wire.AckResult{UID: uid}
	}
	return s.writeJSON(wire.Acks{Res: "acks", ID: s.reqID, Results: results})
}

// prepare runs every refusal a put makes before a single body is read, and
// returns the chunks the server lacks along with what this entry is still
// allowed to upload.
//
// The same refusals, in the same order, for a single put and for one entry of a
// batch. One list, so the two puts cannot drift apart on what they refuse (S6).
//
// The refusal is returned rather than written, because the two callers report
// differently and deliberately: handlePut sends an error frame and logs it,
// while one entry of a batch is only a result in the acks and the rest of the
// batch still commits.
func (s *Session) prepare(e store.Entry) (missing []string, allowance int64, refusal *wire.Err) {
	if r := s.checkEntry(e); r != nil {
		return nil, 0, r
	}

	missing, sizes, err := s.srv.st.Chunks().Missing(s.vaultID, e.Chunks)
	if err != nil {
		// The only failure Missing has is a malformed name, which Validate
		// should already have caught. Reported rather than assumed away.
		r := wire.Error(wire.CodeBadChunk, err.Error())
		return nil, 0, &r
	}

	// What this entry may reference in total, and what it already accounts for.
	//
	// The store re-checks this at commit and is the authority; the point of
	// doing it here too is that the commit happens *after* the upload, so
	// relying on it alone would let a client write the disk full and only then
	// be told no. Refusing before the want list goes out costs nothing.
	budget := store.CiphertextBudget(e.Size, len(e.Chunks))
	held := heldBytes(e.Chunks, missing, sizes)
	if held > budget {
		r := wire.Error(wire.CodeToolarge, fmt.Sprintf(
			"the chunks named already hold %d bytes for a declared size of %d, budget %d",
			held, e.Size, budget))
		return nil, 0, &r
	}
	return missing, budget - held, nil
}

func (s *Session) handlePut(m wire.In) error {
	// The session's device, never the message's, and the same call the batched
	// put makes. wire.In.Entry has no way to reach the message's device now, so
	// a put under another device's name is unexpressible rather than commented.
	e := m.Entry(s.device)

	missing, allowance, refusal := s.prepare(e)
	if refusal != nil {
		// reject rather than refuse: a single put's refusal is logged, where one
		// entry of a batch is only a line in the acks.
		return s.reject(refusal.Code, errors.New(refusal.Msg))
	}

	if len(missing) == 0 {
		uid, refusal := s.commit(e)
		if refusal != nil {
			return s.refuse(refusal)
		}
		return s.writeJSON(wire.Have{Res: "have", ID: s.reqID, UID: uid})
	}

	if err := s.writeJSON(wire.Want{Res: "want", ID: s.reqID, Chunks: missing}); err != nil {
		return err
	}
	if err := s.readBodies(missing, allowance); err != nil {
		return err
	}

	uid, refusal := s.commit(e)
	if refusal != nil {
		return s.refuse(refusal)
	}
	// Only now is the ack truthful: every body is durable and so is the entry.
	return s.writeJSON(wire.Ack{Res: "ack", ID: s.reqID, UID: uid})
}

// heldBytes totals what the named chunks already occupy, from the sizes Missing
// gathered rather than by stat'ing them again.
//
// Once per reference, not once per distinct chunk: an entry naming the same
// chunk twice is charged for it twice, which is what the budget means and what
// TestTheBudgetCountsRepeatedChunksOncePerReference is about.
//
// A name that is neither missing nor sized was present when Missing looked and
// is not now. The sweep can do that; the commit will refuse and the client
// retries, so it is counted as nothing here rather than treated as a fault.
func heldBytes(all, missing []string, sizes map[string]int64) int64 {
	absent := make(map[string]struct{}, len(missing))
	for _, n := range missing {
		absent[n] = struct{}{}
	}
	var held int64
	for _, n := range all {
		if _, gone := absent[n]; gone {
			continue
		}
		held += sizes[n]
	}
	return held
}

// readBodies reads one binary frame per wanted chunk and stores each, refusing
// once the uploads pass what the entry's declared size can account for.
//
// Frames are matched to names by hashing the body, not by position. That is
// only possible because a chunk name *is* the hash of its body, and it is
// strictly better than trusting order: a client that reorders, repeats or skips
// a frame is caught here rather than storing one body under another's name.
//
// Every failure in here ends the session. Mid-stream there is no way to tell
// the client "skip that one and carry on" without both ends agreeing how many
// frames remain, and guessing is how two ends desync silently.
func (s *Session) readBodies(want []string, allowance int64) error {
	outstanding := make(map[string]struct{}, len(want))
	for _, n := range want {
		outstanding[n] = struct{}{}
	}

	// The bodies go to disk through one batch writer rather than one at a time.
	// An fsync is almost all waiting, and doing them in series left the wire and
	// most of the disk idle for the length of a first sync. Nothing is treated
	// as stored until Close returns, which is before the entry is committed and
	// so before anything is acknowledged.
	w := s.srv.st.Chunks().NewWriter(s.vaultID)
	closed := false
	defer func() {
		if !closed {
			// The caller is abandoning this exchange. The chunks that did land
			// are harmless: a chunk no entry references is what the sweep
			// collects, and one that is referenced later is one fewer to send.
			_ = w.Close()
		}
	}()

	var uploaded int64
	for len(outstanding) > 0 {
		typ, body, err := s.readMsg()
		if err != nil {
			// Includes the client hanging up mid-upload. Nothing is committed:
			// the entry is appended only after this returns cleanly.
			return err
		}
		if typ != websocket.MessageBinary {
			return s.fatal(wire.CodeProtoState, fmt.Errorf(
				"expected a chunk body, got a text frame with %d chunks still wanted",
				len(outstanding)))
		}

		name := chunks.Name(body)
		if _, wanted := outstanding[name]; !wanted {
			// Either a body nobody asked for, or one sent twice. Both mean the
			// remaining frame count is no longer agreed.
			return s.fatal(wire.CodeBadChunk, fmt.Errorf(
				"received a %d byte body hashing to %s, which was not among the %d chunks still wanted",
				len(body), name, len(outstanding)))
		}
		// Checked before the write, not after. The point of the bound is that
		// the bytes never reach the disk.
		uploaded += int64(len(body))
		if uploaded > allowance {
			return s.fatal(wire.CodeToolarge, fmt.Errorf(
				"uploads reached %d bytes with %d chunks still wanted, and this entry's "+
					"declared size allows %d",
				uploaded, len(outstanding), allowance))
		}
		if err := w.Add(name, body); err != nil {
			return s.fatal(putErrorCode(err), err)
		}
		delete(outstanding, name)
	}

	closed = true
	if err := w.Close(); err != nil {
		return s.fatal(putErrorCode(err), err)
	}
	return nil
}

// commitCode names the entry-level refusals AppendEntry can return. An empty
// string means the fault is not attributable to the entry, and a session that
// cannot commit for reasons of its own has nothing useful left to say.
func commitCode(err error) string {
	switch {
	case errors.Is(err, store.ErrBadEntry):
		return wire.CodeBadEntry
	case errors.Is(err, store.ErrOverBudget):
		return wire.CodeToolarge
	case errors.Is(err, store.ErrChunkMissing):
		// A body was swept between the upload and the commit. The client is
		// told which entry and re-uploads; see chunks.DefaultGrace for why this
		// is rare.
		return wire.CodeNoChunk
	}
	return ""
}

// putErrorCode classifies a failure to store a body.
//
// It is a function rather than an inline switch so the classification can be
// tested directly: a full disk is not something a test can arrange, and before
// this it arrived as an unexplained internal fault while `nospace` sat in the
// protocol's code list and was never sent by anything.
func putErrorCode(err error) string {
	switch {
	case errors.Is(err, chunks.ErrTooLarge):
		return wire.CodeToolarge
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, syscall.EDQUOT):
		return wire.CodeNoSpace
	default:
		return wire.CodeInternal
	}
}

// commit appends an entry and returns the uid it was given.
//
// A refusal the entry itself caused comes back as a *wire.Err with nothing
// written to the socket, because the caller decides what that means. For a
// single put it is an error frame and the session continues; for a batch it is
// one entry's result and the other entries still commit. Killing the session
// instead would leave a batch half committed and every entry in it unacked,
// which is the failure batching exists to avoid.
//
// A fault that is the server's rather than the entry's, the database refusing
// the commit, comes back as an `internal` refusal and the session continues
// (S27). Nothing was committed, the bodies on disk are harmless, and the client
// retries the put; the error table says `internal` ends a session only during
// the handshake and catch-up, where there is nothing to continue with. Ending
// it here used to cost a reconnect and a replayed handshake for a fault the
// next put might not even see.
func (s *Session) commit(e store.Entry) (int64, *wire.Err) {
	s.srv.commitMu.Lock()
	defer s.srv.commitMu.Unlock()

	var uid int64
	var err error
	if s.srv.beforeAppend != nil {
		err = s.srv.beforeAppend(e)
	}
	if err == nil {
		uid, err = s.srv.st.AppendEntry(s.vaultID, e)
	}
	if err != nil {
		if code := commitCode(err); code != "" {
			s.srv.log.Warn("refused at commit",
				"vault", s.vaultID, "path", len(e.Path), "code", code, "err", err)
			refusal := wire.Error(code, err.Error())
			return 0, &refusal
		}
		s.srv.log.Error("commit failed", "vault", s.vaultID, "err", err)
		refusal := wire.Error(wire.CodeInternal, "the entry could not be committed: "+err.Error())
		return 0, &refusal
	}
	e.UID = uid
	if s.srv.afterAppend != nil {
		s.srv.afterAppend(uid)
	}
	s.srv.log.Info("committed", "vault", s.vaultID, "uid", uid,
		"size", e.Size, "chunks", len(e.Chunks),
		"folder", e.Folder, "deleted", e.Deleted)

	s.srv.hub.broadcast(s.vaultID, e, s)
	return uid, nil
}

/* ---------------------------------------------------------------- *
 * get and fetch
 * ---------------------------------------------------------------- */

// handleHistory answers with every version of one path, newest first.
//
// The path arrives sealed and is used sealed. The server has never been able to
// read a path and this is not the place to start: it is a key in a table here,
// nothing more, and an unknown one simply has no versions.
//
// An empty list is not an error. The server cannot tell a path that never
// existed from one whose history was purged, because both are absent, and
// inventing a distinction it cannot support would be a lie in a recovery tool.
func (s *Session) handleHistory(m wire.In) error {
	if m.Path == "" {
		return s.reject(wire.CodeBadName, errors.New("history needs a path"))
	}
	if m.Before < 0 {
		return s.reject(wire.CodeProtoState, fmt.Errorf("negative before %d", m.Before))
	}

	entries, err := s.srv.st.HistoryForPath(s.vaultID, m.Path, m.Before, m.Limit)
	if err != nil {
		s.srv.log.Error("history", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("could not read history"))
	}
	return s.writeJSON(wire.History{Res: "history", ID: s.reqID, Path: m.Path, Entries: nonNil(entries)})
}

// handleDeleted answers with every path whose newest version is a deletion.
//
// This is the list somebody reads when they have lost a note and do not know
// what it was called, so the ordering is newest first and renames are
// suppressed. See wire.Deleted for why suppression is not optional.
func (s *Session) handleDeleted(m wire.In) error {
	entries, more, err := s.srv.st.Deleted(s.vaultID, true, m.Limit)
	if err != nil {
		s.srv.log.Error("deleted", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("could not list deletions"))
	}
	return s.writeJSON(wire.Deleted{Res: "deleted", ID: s.reqID, Entries: nonNil(entries), More: more})
}

// nonNil keeps an empty result an empty array rather than JSON null.
//
// The same reasoning as Batch's entries, and the same bug: a client iterating
// null crashes on exactly the answers it exists to handle, and "no deleted
// notes" is the answer it will see most often.
func nonNil[T any](entries []T) []T {
	if entries == nil {
		return []T{}
	}
	return entries
}

func (s *Session) handleGet(m wire.In) error {
	if m.UID <= 0 {
		return s.reject(wire.CodeNoUID, fmt.Errorf("uid %d is not a uid", m.UID))
	}
	e, ok, err := s.srv.st.EntryByUID(s.vaultID, m.UID)
	if err != nil {
		return s.reject(wire.CodeInternal, err)
	}
	if !ok {
		return s.reject(wire.CodeNoUID, fmt.Errorf("no entry %d in this vault", m.UID))
	}
	if !e.HasBody() {
		// The entry exists and has nothing to download. Distinct from an
		// unknown uid, and distinct from an empty chunk list, which is a real
		// zero-byte file.
		return s.reject(wire.CodeNoContent,
			fmt.Errorf("entry %d is a %s", m.UID, kindOf(e)))
	}
	return s.writeJSON(wire.Chunks{
		Res: "chunks", ID: s.reqID, UID: e.UID, Size: e.Size, Chunks: e.Chunks,
	})
}

func kindOf(e store.Entry) string {
	if e.Folder {
		return "folder"
	}
	return "deletion"
}

// handleFetch streams the requested chunk bodies as binary frames, in the order
// requested.
//
// Every chunk is checked to be present, and then read and checked against its
// own name, before any frame is sent. Discovering the third of five is missing
// halfway through leaves the client unable to tell which bodies it received;
// refusing the whole fetch up front leaves it able to ask again for a smaller
// set.
//
// Reading every body twice is what that costs, once to verify and once to send.
// Measured warm, a full 64 MiB fetch of 16 KiB chunks spends about 78 ms on the
// extra pass and one of 1 MiB chunks about 28 ms; a note is a handful of chunks
// and spends tens of microseconds. The pages are in cache for the second read,
// so what is doubled is the hashing rather than the disk. That buys a header
// whose count is the number of bodies that follow, which is the only thing a
// client can pre-allocate against.
func (s *Session) handleFetch(m wire.In) error {
	if len(m.Chunks) == 0 {
		return s.reject(wire.CodeBadChunk, errors.New("fetch names no chunks"))
	}
	if len(m.Chunks) > store.MaxChunksPerEntry {
		return s.reject(wire.CodeToolarge,
			fmt.Errorf("%d chunks, limit is %d", len(m.Chunks), store.MaxChunksPerEntry))
	}
	// Presence and size from one stat per chunk. The sum is bounded by
	// maxFetchBytes (S21): a fetch naming every chunk of a large vault would
	// otherwise be one request that the server answers for as long as the
	// client cares to read, and the client was told the cap at hello.
	var total int64
	for _, n := range m.Chunks {
		if !chunks.ValidName(n) {
			return s.reject(wire.CodeBadChunk, fmt.Errorf("%q is not a chunk name", n))
		}
		size, ok := s.srv.st.Chunks().Size(s.vaultID, n)
		if !ok {
			return s.reject(wire.CodeNoChunk, fmt.Errorf("this vault does not hold %s", n))
		}
		total += size
	}
	if total > s.srv.maxFetchBytes {
		return s.reject(wire.CodeToolarge, fmt.Errorf(
			"the %d chunks asked for hold %d bytes, limit for one fetch is %d; ask in smaller sets",
			len(m.Chunks), total, s.srv.maxFetchBytes))
	}
	// Then every body is read and checked against its name, before the header
	// promises how many are coming. A chunk that rotted on disk passes the stat
	// above, so without this the failure was found mid-stream, after some
	// bodies had gone out under a count that could no longer be met. Checking
	// here turns that into a refusal the session survives and the client can
	// act on: it asks again for a smaller set, or for the ones it still needs
	// once a device has resent the bad one. After the size cap, so a fetch that
	// is refused for being too large is refused without reading anything.
	for i, n := range m.Chunks {
		if err := s.srv.st.Chunks().Check(s.vaultID, n); err != nil {
			s.quarantineIfCorrupt(n, err)
			return s.reject(wire.CodeNoChunk,
				fmt.Errorf("chunk %d of %d (%s): %w", i+1, len(m.Chunks), n, err))
		}
	}

	// The client is told how many frames follow before the first one, so the
	// answer to a fetch is either this header and exactly that many bodies or
	// an error, never bodies and then an error.
	if err := s.writeJSON(wire.Bodies{Res: "bodies", ID: s.reqID, Count: len(m.Chunks)}); err != nil {
		return err
	}

	for i, n := range m.Chunks {
		// Get verifies the body against its name, so a chunk that rotted on
		// disk is reported here rather than shipped to a device that would fail
		// to decrypt it for reasons it cannot diagnose.
		body, err := s.srv.st.Chunks().Get(s.vaultID, n)
		if err != nil {
			s.quarantineIfCorrupt(n, err)
			// It verified a moment ago and cannot be read now, so the disk went
			// bad between the two passes. Frames are already on the wire under
			// a count this fetch can no longer meet, so the session ends: the
			// close is what tells the client the count was not kept.
			return s.fatal(wire.CodeNoChunk,
				fmt.Errorf("chunk %d of %d (%s): %w", i+1, len(m.Chunks), n, err))
		}
		if err := s.writeBinary(body); err != nil {
			return err
		}
	}
	return nil
}

// quarantineIfCorrupt sets aside a body that failed its own hash.
//
// A body that is not the body its name says is not a body. Left in place it
// would keep satisfying the presence check, so every client would keep being
// told the server already holds it and none would ever send it again. Moved
// aside, the next put asks for it and a device that still has the note heals
// the vault. Anything else, a permission or an IO error, is left alone: it is
// the disk's problem and the body may be perfectly good.
func (s *Session) quarantineIfCorrupt(name string, err error) {
	if !errors.Is(err, chunks.ErrCorrupt) {
		return
	}
	s.srv.log.Error("quarantining a corrupt chunk", "vault", s.vaultID, "chunk", name, "err", err)
	if qerr := s.srv.st.Chunks().Quarantine(s.vaultID, name); qerr != nil {
		s.srv.log.Error("could not quarantine it", "vault", s.vaultID, "chunk", name, "err", qerr)
	}
}

/* ---------------------------------------------------------------- *
 * rotate
 * ---------------------------------------------------------------- */

// handleRotate replaces the vault's auth hash and wrapped data key together and
// closes every other session on the vault, so a leaked pairing string is retired
// without the server's history going with it. docs/protocol.md, "The data key,
// and rotating a leaked secret".
//
// The swap is conditional on the hash this session authenticated under, so two
// devices connected under one root that both rotate cannot both succeed. The
// loser is refused with `rotated` and its session ends: the credential it is
// holding is not the vault's any more, and the alternative is what used to
// happen, which is that the second rotation overwrote the first and the device
// the first was revoking owned the vault.
//
// Registrar sessions only, which dispatch enforces: rotation retires the root
// secret and rewraps the data key, and since protocol 4 a device holds
// neither. It touches no device row, so every device keeps syncing across one,
// which is the expensive half of what per-device credentials removed.
//
// Refused with `auth` on a session that authenticated with the bootstrap
// token, which proved nothing about holding the old root, and with `badentry`
// on a malformed request. Either refusal leaves the session usable, because
// neither changed anything. Every claimed vault has a data key, so there is no
// such thing here as a vault with nothing to re-wrap.
func (s *Session) handleRotate(m wire.In) error {
	if s.bootstrap {
		return s.reject(wire.CodeAuth, errors.New(
			"this session authenticated with the bootstrap token, and only a session holding the vault's secret may rotate it"))
	}
	if len(m.Auth) < MinClaimLength {
		return s.reject(wire.CodeBadEntry, fmt.Errorf(
			"the new auth key is %d characters, which is too few", len(m.Auth)))
	}
	if !store.ValidWrapped(m.Wrapped) {
		return s.reject(wire.CodeBadEntry, fmt.Errorf(
			"the wrapped data key is %d bytes and must be base64url of at most %d", len(m.Wrapped), store.MaxWrappedLen))
	}
	if s.authHash == "" {
		// No authenticator this build ships leaves it empty for a session that
		// got this far, and a swap with nothing to compare against is the hole
		// this whole path exists to close, so it is refused rather than guessed.
		return s.reject(wire.CodeAuth, errors.New(
			"this session has no credential to rotate away from"))
	}
	hash := sha256.Sum256([]byte(m.Auth))
	next := hex.EncodeToString(hash[:])
	if s.srv.beforeRotate != nil {
		s.srv.beforeRotate()
	}
	if err := s.srv.st.Rotate(s.vaultID, s.authHash, next, m.Wrapped); err != nil {
		if errors.Is(err, store.ErrRotated) {
			s.srv.log.Warn("rotate lost the race", "vault", s.vaultID, "device", s.device)
			return s.fatal(wire.CodeRotated, errors.New(
				"the vault was rotated by another device, so this rotation was refused; "+
					"reconnect with the new string and try again"))
		}
		if errors.Is(err, store.ErrBadEntry) {
			return s.reject(wire.CodeBadEntry, err)
		}
		s.srv.log.Error("rotate failed", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the vault's secret could not be replaced: "+err.Error()))
	}
	// This session's credential is the new one now, so a second rotate from it
	// swaps against the hash it just wrote rather than the one it arrived with,
	// and a register after it hands out the new wrapping rather than the
	// retired one.
	s.authHash = next
	s.wrapped = m.Wrapped
	// Committed. Every device row is untouched and every device goes on
	// syncing, which is what per-device credentials bought: rotation replaces
	// the root and rewraps the same data key, and no device holds either.
	// Under protocol 3 this evicted the whole vault and told every device to
	// pair again, because the vault's hash *was* their credential.
	//
	// What is still closed is any *other* registrar session on this vault.
	// Those are holding the root that was just retired, and the one thing a
	// retired root must not do is register a device, which would be permanent
	// access surviving the rotation that was meant to end it. The conditional
	// insert in store.RegisterDevice is what actually guarantees that; closing
	// them is so the holder is told rather than left to discover it.
	//
	// In parallel, because each peer is given up to a second to read its
	// notice before it is closed, and in series seven other devices spent
	// seven seconds of that before this one was told anything. Shutdown fans
	// its notices out the same way, for the same reason.
	others := s.srv.registrarsOn(s.vaultID, s)
	var wg sync.WaitGroup
	for _, peer := range others {
		wg.Add(1)
		go func(peer *Session) {
			defer wg.Done()
			peer.evict("the vault's secret was rotated by another device; "+
				"the recovery key you are holding no longer opens it", errors.New("vault secret rotated"))
		}(peer)
	}
	wg.Wait()
	s.srv.log.Info("vault secret rotated", "vault", s.vaultID, "device", s.device, "evicted", len(others))
	return s.writeJSON(wire.Rotated{Res: "rotated", ID: s.reqID})
}

/* ---------------------------------------------------------------- *
 * The device list
 * ---------------------------------------------------------------- */

// handleRegister adds a device to the vault's list. Registrar sessions only,
// which is enforced in dispatch: this is the one power vaults.auth_hash kept
// when protocol 4 took the sync half away.
//
// The auth key and not its hash, matching `claim`. Either way the server keeps
// only the digest, so nothing is revealed by sending the key that the digest
// would have hidden; what the key buys is that MinClaimLength can be enforced,
// and a credential nobody can judge is one a client bug binds a device to for
// ever. See docs/design.md on why the digest is a bare unsalted SHA-256.
//
// Registering the same device twice, with the same key, succeeds. That is the
// half-finished registration: the row committed and the reply was lost, and
// the caller is a conversion that has to be able to run again after a crash.
// Answering ErrDeviceExists there would leave a device retrying for ever, so
// the row is read back and a row that is already exactly what was asked for is
// the registration having happened (rule 4: the outcome is verified, not the
// call). A different key under an id the vault already holds is refused, and
// nothing is overwritten: that is somebody else's device.
func (s *Session) handleRegister(m wire.In) error {
	if !store.ValidDeviceID(m.DeviceID) {
		return s.reject(wire.CodeBadName, fmt.Errorf(
			"device id is %d bytes and must be base64url of at most %d",
			len(m.DeviceID), store.MaxDeviceIDLen))
	}
	if len(m.Auth) < MinClaimLength {
		return s.reject(wire.CodeBadEntry, fmt.Errorf(
			"the device's auth key is %d characters, which is too few", len(m.Auth)))
	}
	// The name defaults to the one this hello already carries, which is what
	// the client sends as --device today, so a device that says nothing about
	// its name still arrives in the list as something a person recognises.
	name := m.Name
	if name == "" {
		name = s.device
	}
	if err := checkName("device", name, store.MaxDeviceLen); err != nil {
		return s.reject(wire.CodeBadName, err)
	}
	if s.authHash == "" {
		// No authenticator this build ships leaves it empty for a session that
		// got this far. A registration authorised by no credential at all is
		// the hole this whole path exists to close, so it is refused rather
		// than guessed, exactly as rotate does.
		return s.reject(wire.CodeAuth, errors.New(
			"this session has no vault credential to register a device under"))
	}
	sum := sha256.Sum256([]byte(m.Auth))
	deviceHash := hex.EncodeToString(sum[:])
	if s.srv.beforeRegister != nil {
		s.srv.beforeRegister()
	}
	err := s.srv.st.RegisterDevice(s.vaultID, m.DeviceID, name, deviceHash,
		s.authHash, store.MaxDevices, s.srv.now().UnixMilli())
	switch {
	case err == nil:
	case errors.Is(err, store.ErrDeviceExists):
		_, existing, ok, readErr := s.srv.st.DeviceByID(s.vaultID, m.DeviceID)
		if readErr != nil {
			return s.reject(wire.CodeInternal, readErr)
		}
		if !ok || subtle.ConstantTimeCompare([]byte(existing), []byte(deviceHash)) != 1 {
			return s.reject(wire.CodeBadEntry, fmt.Errorf(
				"this vault already has a different device registered under id %q", m.DeviceID))
		}
		s.srv.log.Info("device already registered", "vault", s.vaultID, "deviceId", m.DeviceID)
	case errors.Is(err, store.ErrDeviceLimit):
		return s.reject(wire.CodeFull, err)
	case errors.Is(err, store.ErrRotated):
		// The vault was rotated between this session's hello and this
		// registration. Fatal, for the same reason a losing rotate is: the
		// credential this session is holding no longer opens the vault, and
		// retrying the same request cannot succeed.
		return s.fatal(wire.CodeRotated, errors.New(
			"the vault was rotated by another device, so this registration was refused; "+
				"reconnect with the new recovery key and try again"))
	case errors.Is(err, store.ErrUnknownVault), errors.Is(err, store.ErrBadEntry):
		return s.reject(wire.CodeBadEntry, err)
	default:
		s.srv.log.Error("register failed", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the device could not be registered: "+err.Error()))
	}
	s.srv.log.Info("device registered", "vault", s.vaultID, "deviceId", m.DeviceID, "name", name)
	return s.writeJSON(wire.Registered{
		Res: "registered", ID: s.reqID, DeviceID: m.DeviceID, Wrapped: s.wrapped,
	})
}

// handleDevices answers with every device that may reach this vault: the only
// way to answer "what is still connected to my notes". Device sessions only,
// because the list is the vault's content in the sense that matters and a
// registrar reads nothing.
func (s *Session) handleDevices(m wire.In) error {
	ds, err := s.srv.st.Devices(s.vaultID)
	if err != nil {
		s.srv.log.Error("listing devices failed", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the device list could not be read: "+err.Error()))
	}
	return s.writeJSON(wire.DeviceList{
		Res: "devices", ID: s.reqID, Devices: ds, MaxDevices: store.MaxDevices,
	})
}

// handleRevoke deletes a device's row and closes every session that device has
// open, in that order, so the reply means both. A device may revoke another and
// may revoke itself, which is what unlinking is.
//
// Deleting the row alone would be a revocation the revoked device does not
// notice until it happens to reconnect: it holds an authenticated connection,
// and nothing on it is re-checked, so it would go on reading every note pushed
// to the vault for as long as it stayed up. "Revoked" has to mean "and it
// stopped", or the panel is telling somebody their stolen laptop is off the
// vault while it is still receiving.
//
// The order is the guarantee, not luck. The delete lands first, so a connect
// racing this either does its SawDevice after the delete and is refused, or was
// already in the hub when the list below is taken and is closed here. See
// helloAsDevice for the other half.
func (s *Session) handleRevoke(m wire.In) error {
	if !store.ValidDeviceID(m.DeviceID) {
		return s.reject(wire.CodeBadName, fmt.Errorf(
			"device id is %d bytes and must be base64url of at most %d",
			len(m.DeviceID), store.MaxDeviceIDLen))
	}
	if err := s.srv.st.RevokeDevice(s.vaultID, m.DeviceID, m.AllowLast); err != nil {
		switch {
		case errors.Is(err, store.ErrUnknownDevice):
			return s.reject(wire.CodeNoDevice, err)
		case errors.Is(err, store.ErrLastDevice):
			// badentry, the same code and the same shape as a hello carrying
			// two credentials: a well-formed frame the server will not act on,
			// which the caller fixes by sending a different one. The message
			// says which field.
			return s.reject(wire.CodeBadEntry, fmt.Errorf(
				"%s; resend with allowLast to do it anyway", err))
		}
		s.srv.log.Error("revoke failed", "vault", s.vaultID, "deviceId", m.DeviceID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the device could not be revoked: "+err.Error()))
	}

	// Every session that device has open except this one. This one is left
	// out because it is about to be told what happened, and evicting it here
	// would close the socket before the reply reached it.
	victims := s.srv.hub.sessionsOf(s.vaultID, m.DeviceID, s)
	var wg sync.WaitGroup
	for _, peer := range victims {
		wg.Add(1)
		go func(peer *Session) {
			defer wg.Done()
			peer.evict("this device was revoked and may no longer sync this vault; "+
				"add it again with an invite from a device that still has the vault",
				errors.New("device revoked"))
		}(peer)
	}
	wg.Wait()

	self := m.DeviceID == s.deviceID
	s.srv.log.Info("device revoked", "vault", s.vaultID, "deviceId", m.DeviceID,
		"by", s.device, "closed", len(victims), "self", self)
	if err := s.writeJSON(wire.Revoked{
		Res: "revoked", ID: s.reqID, DeviceID: m.DeviceID, Self: self,
	}); err != nil {
		return err
	}
	if self {
		// A device that revoked itself is revoked, and a revoked device does
		// not stay connected. The reply has already gone; Handle drains and
		// closes behind this.
		return errRevokedSelf
	}
	return nil
}

/* ---------------------------------------------------------------- *
 * invite
 * ---------------------------------------------------------------- */

// handleInvite stores a single-use invite: an unguessable identifier and the
// root secret sealed under a key the server never sees, with an expiry. The
// server learns nothing it could use; it holds a blob it cannot open under a
// name it cannot guess, for a few minutes. docs/protocol.md, "Adding a device
// with a single-use invite".
//
// Device sessions only, which dispatch enforces. An invite is issued by a
// device that already has the vault, and that is also what retired the
// explicit bootstrap check this used to carry: a bootstrap session is a
// registrar, and a registrar never reaches this function, so the check could
// only ever have been dead code pretending to be a guard.
//
// Refused with `badentry` on a malformed request. The ttl defaults to
// DefaultInviteTTL and is capped at MaxInviteTTL rather than refused above it,
// because the reply says when the invite actually expires and a client asking
// for longer has nothing to do differently.
func (s *Session) handleInvite(m wire.In) error {
	if !store.ValidInvite(m.Invite) {
		return s.reject(wire.CodeBadEntry, fmt.Errorf(
			"the invite identifier is %d bytes and must be base64url of at most %d", len(m.Invite), store.MaxInviteLen))
	}
	if !store.ValidSealed(m.Sealed) {
		return s.reject(wire.CodeBadEntry, fmt.Errorf(
			"the sealed secret is %d bytes and must be base64url of at most %d", len(m.Sealed), store.MaxSealedLen))
	}
	if m.TTLMs < 0 {
		return s.reject(wire.CodeBadEntry, fmt.Errorf("ttlMs is %d, and an invite cannot expire before it is issued", m.TTLMs))
	}
	ttl := time.Duration(m.TTLMs) * time.Millisecond
	if ttl == 0 {
		ttl = DefaultInviteTTL
	}
	if ttl > MaxInviteTTL {
		ttl = MaxInviteTTL
	}
	now := s.srv.now()
	expiresAt := now.Add(ttl).UnixMilli()
	if err := s.srv.st.AddInvite(s.vaultID, m.Invite, m.Sealed, expiresAt, now.UnixMilli()); err != nil {
		if errors.Is(err, store.ErrBadEntry) || errors.Is(err, store.ErrUnknownVault) {
			return s.reject(wire.CodeBadEntry, err)
		}
		s.srv.log.Error("invite failed", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("the invite could not be stored: "+err.Error()))
	}
	s.srv.log.Info("invite issued", "vault", s.vaultID, "device", s.device, "expiresAt", expiresAt)
	return s.writeJSON(wire.Invited{Res: "invited", ID: s.reqID, ExpiresAt: expiresAt})
}
