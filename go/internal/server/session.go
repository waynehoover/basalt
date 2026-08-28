package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/basalt/internal/chunks"
	"github.com/waynehoover/basalt/internal/store"
	"github.com/waynehoover/basalt/internal/wire"
)

// Session is one connected device.
type Session struct {
	srv  *Server
	conn *websocket.Conn
	ctx  context.Context

	// All writes funnel through one goroutine draining out, which keeps frame
	// order without a mutex and stops a stalled peer from blocking whoever is
	// broadcasting to it.
	out       chan outFrame
	dead      chan struct{}
	closeOnce sync.Once

	vaultID string
	device  string
	remote  string
	joined  bool

	// Guards the catch-up handover. Live changes buffer in pending until the
	// backlog is on the wire; see handleHello for why the order matters.
	mu          sync.Mutex
	catchupDone bool
	pending     []pendingChange
}

type outFrame struct {
	typ  websocket.MessageType
	data []byte
}

type pendingChange struct {
	entry store.Entry
	// elide is set when this session is the one that pushed the entry: it gets
	// the range so its cursor advances, without the payload it would otherwise
	// have to recognise as its own.
	elide bool
}

// Handle runs one connection to completion. The caller has already accepted the
// WebSocket.
func (s *Server) Handle(ctx context.Context, conn *websocket.Conn, remote string) {
	conn.SetReadLimit(ReadLimit)
	sess := &Session{
		srv: s, conn: conn, ctx: ctx, remote: remote,
		out:  make(chan outFrame, SendQueueDepth),
		dead: make(chan struct{}),
	}
	go sess.writeLoop()

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
			ctx, cancel := context.WithTimeout(s.ctx, WriteWait)
			err := s.conn.Write(ctx, f.typ, f.data)
			cancel()
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

// drain waits, bounded, for queued frames to reach the wire, so a final error
// message is not lost to an immediate close.
func (s *Session) drain(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if len(s.out) == 0 {
			// One more tick: the writer may still be mid-write on the last
			// frame it took off the channel.
			time.Sleep(20 * time.Millisecond)
			return
		}
		select {
		case <-s.dead:
			return
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// send blocks until the frame is queued.
//
// Only ever called from the session's own goroutine, where blocking is correct
// backpressure: a catch-up can be far larger than the queue, and dropping
// frames there would leave the client with gaps it has been told to expect.
func (s *Session) send(typ websocket.MessageType, data []byte) error {
	select {
	case s.out <- outFrame{typ, data}:
		return nil
	case <-s.dead:
		return errors.New("session closed")
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
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
	case s.out <- outFrame{typ, data}:
		return true
	case <-s.dead:
		return false
	default:
		s.kill(errors.New("send queue overflow, peer too slow"))
		return false
	}
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

// reject reports a refusal the session survives. docs/protocol.md: a rejected
// put returns an error and the session continues, because a protocol with no
// clean way to refuse a push has to close the connection to say no, and then
// every bad file costs a reconnect.
func (s *Session) reject(code string, cause error) error {
	s.srv.log.Warn("rejected", "vault", s.vaultID, "code", code, "err", cause)
	return s.writeJSON(wire.Error(code, cause.Error()))
}

// fatal reports a refusal that ends the session, writing the reason first.
func (s *Session) fatal(code string, cause error) error {
	_ = s.writeJSON(wire.Error(code, cause.Error()))
	return cause
}

func (s *Session) readMsg() (websocket.MessageType, []byte, error) {
	ctx, cancel := context.WithTimeout(s.ctx, IdleTimeout)
	defer cancel()
	return s.conn.Read(ctx)
}

/* ---------------------------------------------------------------- *
 * Lifecycle
 * ---------------------------------------------------------------- */

func (s *Session) run() error {
	typ, data, err := s.readMsg()
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
	if err := s.handleHello(m); err != nil {
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
		if err := s.dispatch(m); err != nil {
			return err
		}
	}
}

func (s *Session) dispatch(m wire.In) error {
	switch m.Op {
	case "ping":
		return s.writeJSON(wire.Pong{Res: "pong"})
	case "put":
		return s.handlePut(m)
	case "get":
		return s.handleGet(m)
	case "fetch":
		return s.handleFetch(m)
	case "history":
		return s.handleHistory(m)
	case "deleted":
		return s.handleDeleted(m)
	case "hello":
		return s.fatal(wire.CodeProtoState, errors.New("hello sent twice"))
	default:
		// Named, not ignored. A client blocked waiting on a reply it will never
		// get looks exactly like a hung server.
		return s.reject(wire.CodeProtoState, fmt.Errorf("unknown op %q", m.Op))
	}
}

func (s *Session) handleHello(m wire.In) error {
	// Version before credentials: refusing on proto is not a security answer
	// and a client on the wrong version deserves to be told so plainly.
	if m.Proto != wire.Proto {
		return s.fatal(wire.CodeProto,
			fmt.Errorf("protocol %d not supported, this server speaks %d", m.Proto, wire.Proto))
	}
	if m.Crypto != wire.Crypto {
		return s.fatal(wire.CodeProto,
			fmt.Errorf("crypto %q not supported, this server speaks %q", m.Crypto, wire.Crypto))
	}
	if m.Vault == "" {
		return s.fatal(wire.CodeAuth, errors.New("missing vault"))
	}
	if m.Cursor < 0 {
		return s.fatal(wire.CodeProtoState, fmt.Errorf("negative cursor %d", m.Cursor))
	}
	if err := s.srv.auth(m.Vault, m.Token); err != nil {
		// Logged in full, reported as one word. Telling a caller whether the
		// vault or the token was wrong tells them which half to keep guessing.
		s.srv.log.Warn("auth failed", "remote", s.remote, "vault", m.Vault, "err", err)
		return s.fatal(wire.CodeAuth, errors.New("not authorised for this vault"))
	}

	s.vaultID = m.Vault
	s.device = m.Device

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
	peers, admitted := s.srv.hub.joinIfRoom(m.Vault, s, s.srv.maxPeers)
	if !admitted {
		return s.fatal(wire.CodeBusy, fmt.Errorf(
			"vault has %d devices connected, limit is %d", peers, s.srv.maxPeers))
	}
	s.joined = true

	// Limits first, so a client knows every ceiling before its first put rather
	// than discovering one by being rejected.
	if err := s.writeJSON(s.srv.ready(latest)); err != nil {
		return err
	}
	s.srv.log.Info("session ready", "remote", s.remote, "vault", m.Vault,
		"device", m.Device, "cursor", m.Cursor, "latest", latest, "peers", peers)

	cursor, sent, err := s.replay(m.Vault, m.Cursor)
	if err != nil {
		return err
	}
	if s.srv.afterReplay != nil {
		s.srv.afterReplay()
	}
	// Release anything committed while the replay was running, in uid order and
	// skipping what the replay already covered.
	cursor = s.flushPending(cursor)

	if sent > 0 {
		s.srv.log.Info("catch-up sent", "vault", m.Vault, "entries", sent, "cursor", cursor)
	}
	return s.writeJSON(wire.CaughtUp{Op: "caught-up", Cursor: cursor})
}

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
	s.mu.Lock()
	if !s.catchupDone {
		if len(s.pending) >= CatchupBufferMax {
			s.mu.Unlock()
			s.kill(errors.New("catch-up buffer overflow, peer too slow"))
			return
		}
		s.pending = append(s.pending, pendingChange{entry: e, elide: elide})
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	b, err := json.Marshal(liveBatch(e, elide))
	if err != nil {
		return
	}
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

// flushPending releases buffered live changes and switches to direct delivery.
//
// The sort matters. Two entries can commit in uid order and reach the hub in
// the opposite order, because AppendEntry releases the store's write lock
// before the broadcast runs. The flush and the flag flip happen under one lock
// so a change arriving mid-flush cannot slip in ahead of the frames being
// released. Returns the highest uid written.
func (s *Session) flushPending(cursor int64) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()

	sort.Slice(s.pending, func(i, j int) bool {
		return s.pending[i].entry.UID < s.pending[j].entry.UID
	})
	for _, p := range s.pending {
		if p.entry.UID <= cursor {
			continue // the replay already covered it
		}
		b, err := json.Marshal(liveBatch(p.entry, p.elide))
		if err != nil {
			continue
		}
		if !s.trySend(websocket.MessageText, b) {
			break
		}
		cursor = p.entry.UID
	}
	s.pending = nil
	s.catchupDone = true
	return cursor
}

/* ---------------------------------------------------------------- *
 * put
 * ---------------------------------------------------------------- */

func (s *Session) handlePut(m wire.In) error {
	e := m.Entry()
	if e.Device == "" {
		e.Device = s.device
	}

	// Two checks ahead of Validate, only to name the outcome: docs/protocol.md
	// gives badname and toolarge their own codes because a client acts on them
	// differently from a generic structural fault. Validate is still the
	// enforcer and runs immediately after; if the two ever disagree, Validate
	// wins and the client gets badentry.
	if e.Path == "" || len(e.Path) > store.MaxPathLen {
		return s.reject(wire.CodeBadName,
			fmt.Errorf("path is %d bytes, must be 1 to %d", len(e.Path), store.MaxPathLen))
	}
	if e.Size > store.PerFileMax {
		return s.reject(wire.CodeToolarge,
			fmt.Errorf("file is %d bytes, limit is %d", e.Size, store.PerFileMax))
	}
	if len(e.Chunks) > store.MaxChunksPerEntry {
		return s.reject(wire.CodeToolarge,
			fmt.Errorf("%d chunks, limit is %d", len(e.Chunks), store.MaxChunksPerEntry))
	}
	if err := e.Validate(); err != nil {
		return s.reject(wire.CodeBadEntry, err)
	}

	missing, err := s.srv.st.Chunks().Missing(s.vaultID, e.Chunks)
	if err != nil {
		// The only failure Missing has is a malformed name, which Validate
		// should already have caught. Reported rather than assumed away.
		return s.reject(wire.CodeBadChunk, err)
	}

	// What this entry may reference in total, and what it already accounts for.
	//
	// The store re-checks this at commit and is the authority; the point of
	// doing it here too is that the commit happens *after* the upload, so
	// relying on it alone would let a client write the disk full and only then
	// be told no. Refusing before the want list goes out costs nothing.
	budget := store.CiphertextBudget(e.Size, len(e.Chunks))
	held, err := s.heldBytes(e.Chunks, missing)
	if err != nil {
		return s.reject(wire.CodeInternal, err)
	}
	if held > budget {
		return s.reject(wire.CodeToolarge, fmt.Errorf(
			"the chunks named already hold %d bytes for a declared size of %d, budget %d",
			held, e.Size, budget))
	}

	if len(missing) == 0 {
		uid, err := s.commit(e)
		if err != nil {
			return err
		}
		return s.writeJSON(wire.Have{Res: "have", UID: uid})
	}

	if err := s.writeJSON(wire.Want{Res: "want", Chunks: missing}); err != nil {
		return err
	}
	if err := s.readBodies(missing, budget-held); err != nil {
		return err
	}

	uid, err := s.commit(e)
	if err != nil {
		return err
	}
	// Only now is the ack truthful: every body is durable and so is the entry.
	return s.writeJSON(wire.Ack{Res: "ack", UID: uid})
}

// heldBytes totals what this entry's already-present chunks occupy, counting a
// repeated chunk once per reference because the declared size counts its
// plaintext once per reference too.
func (s *Session) heldBytes(all, missing []string) (int64, error) {
	absent := make(map[string]struct{}, len(missing))
	for _, n := range missing {
		absent[n] = struct{}{}
	}
	var held int64
	for _, n := range all {
		if _, gone := absent[n]; gone {
			continue
		}
		size, ok := s.srv.st.Chunks().Size(s.vaultID, n)
		if !ok {
			// Present a moment ago, when Missing looked. The sweep can do this;
			// the commit will refuse and the client retries.
			continue
		}
		held += size
	}
	return held, nil
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
		if err := s.srv.st.Chunks().Put(s.vaultID, name, body); err != nil {
			return s.fatal(putErrorCode(err), err)
		}
		delete(outstanding, name)
	}
	return nil
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

// commit appends the entry and fans it out, as one step.
//
// A failure here is reported without an ack, which is the whole contract: the
// client's put has not returned, so it retries, and nothing claims to be stored
// that is not.
//
// The fan-out happens before the caller writes its ack, so the pushing device
// sees its own (empty) range before the reply. That is not a problem to design
// around: a peer can commit at any moment, so a client waiting on any reply has
// to tolerate a batch arriving first no matter what order this code uses. What
// it does buy is that the announcement cannot be reordered by a concurrent
// commit, because commitMu spans both halves.
func (s *Session) commit(e store.Entry) (int64, error) {
	s.srv.commitMu.Lock()
	defer s.srv.commitMu.Unlock()

	uid, err := s.srv.st.AppendEntry(s.vaultID, e)
	if err != nil {
		code := wire.CodeInternal
		switch {
		case errors.Is(err, store.ErrBadEntry):
			code = wire.CodeBadEntry
		case errors.Is(err, store.ErrChunkMissing):
			// A body was swept between the upload and the commit. Loud, and the
			// client re-uploads; see chunks.DefaultGrace for why this is rare.
			code = wire.CodeNoChunk
		case errors.Is(err, store.ErrOverBudget):
			code = wire.CodeToolarge
		}
		return 0, s.fatal(code, err)
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
	return s.writeJSON(wire.History{Res: "history", Path: m.Path, Entries: nonNil(entries)})
}

// handleDeleted answers with every path whose newest version is a deletion.
//
// This is the list somebody reads when they have lost a note and do not know
// what it was called, so the ordering is newest first and renames are
// suppressed. See wire.Deleted for why suppression is not optional.
func (s *Session) handleDeleted(m wire.In) error {
	entries, err := s.srv.st.Deleted(s.vaultID, true)
	if err != nil {
		s.srv.log.Error("deleted", "vault", s.vaultID, "err", err)
		return s.reject(wire.CodeInternal, errors.New("could not list deletions"))
	}
	return s.writeJSON(wire.Deleted{Res: "deleted", Entries: nonNil(entries)})
}

// nonNil keeps an empty result an empty array rather than JSON null.
//
// The same reasoning as Batch's entries, and the same bug: a client iterating
// null crashes on exactly the answers it exists to handle, and "no deleted
// notes" is the answer it will see most often.
func nonNil(entries []store.Entry) []store.Entry {
	if entries == nil {
		return []store.Entry{}
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
		Res: "chunks", UID: e.UID, Size: e.Size, Chunks: e.Chunks,
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
// Every chunk is checked to be present before any frame is sent. Discovering
// the third of five is missing halfway through leaves the client unable to tell
// which bodies it received; refusing the whole fetch up front leaves it able to
// ask again for a smaller set.
func (s *Session) handleFetch(m wire.In) error {
	if len(m.Chunks) == 0 {
		return s.reject(wire.CodeBadChunk, errors.New("fetch names no chunks"))
	}
	if len(m.Chunks) > store.MaxChunksPerEntry {
		return s.reject(wire.CodeToolarge,
			fmt.Errorf("%d chunks, limit is %d", len(m.Chunks), store.MaxChunksPerEntry))
	}
	for _, n := range m.Chunks {
		if !chunks.ValidName(n) {
			return s.reject(wire.CodeBadChunk, fmt.Errorf("%q is not a chunk name", n))
		}
		if !s.srv.st.Chunks().Has(s.vaultID, n) {
			return s.reject(wire.CodeNoChunk, fmt.Errorf("this vault does not hold %s", n))
		}
	}

	for i, n := range m.Chunks {
		// Get verifies the body against its name, so a chunk that rotted on
		// disk is reported here rather than shipped to a device that would fail
		// to decrypt it for reasons it cannot diagnose.
		body, err := s.srv.st.Chunks().Get(s.vaultID, n)
		if err != nil {
			// Present a moment ago, unreadable now. Frames may already be on
			// the wire, so there is no clean way to continue.
			return s.fatal(wire.CodeNoChunk,
				fmt.Errorf("chunk %d of %d (%s): %w", i+1, len(m.Chunks), n, err))
		}
		if err := s.writeBinary(body); err != nil {
			return err
		}
	}
	return nil
}
