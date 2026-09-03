// Package wire is the Basalt protocol's message shapes and nothing else.
//
// It holds no state, opens no connection and knows no policy, so the whole
// vocabulary can be exercised without a server. That separation is deliberate:
// the cleanest boundary in Obsidian's engine is the one between orchestration
// and a transport that knows no policy, and this is the equivalent seam on the
// server side.
//
// Every reply names its outcome. docs/protocol.md's first design rule exists
// because in Obsidian's protocol `{res:"ok"}` on a push means "discard the
// upload", making the most natural success reply the destructive one. There is
// no `ok` here.
package wire

import "github.com/waynehoover/basalt-sync/server/internal/store"

// Proto is the newest protocol version this server implements, and MinProto the
// oldest it still answers. A version outside that range is refused, not
// negotiated: interoperating with a version we have not seen is how a silent
// incompatibility gets shipped.
//
// Protocol 2 added the per-entry authenticator. A client older than that sends
// entries nothing can verify, and one newer refuses them, which is a refusal
// rather than a negotiation for the usual reason.
//
// Protocol 3 added request ids, the `bodies` header on a fetch, `retryable` on
// every error, the batch and fetch caps in `ready`, and the wrapped data key
// with `rotate`. The server answers a session in the version the client asked
// for, so a protocol 2 device keeps working for one release while the others
// are upgraded. docs/protocol.md, "Protocol 2 sessions".
const (
	Proto    = 3
	MinProto = 2
)

// MaxRequestID bounds a client-chosen request id: an integer from 1 to 2^32-1.
// Zero is "no id", which is what a protocol 2 request carries, so the two are
// never confused.
const MaxRequestID = 1<<32 - 1

// Crypto names the client-side scheme. It is a string rather than an integer
// because an integer shared with other implementations means two projects
// eventually disagree about what version 2 was.
const Crypto = "basalt/hkdf-aes-gcm/1"

// Error codes. `code` is for the client to act on, `msg` is for a human to
// read; docs/protocol.md requires both, because an error a device cannot act on
// and a person cannot read is how a silent failure starts.
//
// Every code here has a row in the doc's error table, which also says whether
// the session continues after it. The two lists are kept in step by hand, so a
// new code goes in both.
const (
	CodeProto = "proto" // unsupported proto or crypto; the session closes
	CodeAuth  = "auth"  // bad token or vault; the session closes

	// CodeBadEntry is a structurally invalid put: a folder carrying chunks, a
	// size with no chunk list, a prev equal to path. Rejected before any body
	// is read, and the session continues.
	CodeBadEntry = "badentry"
	// CodeBadName is a path the server cannot store: empty, or over the length
	// bound. The plaintext-name check is the client's, since the server holds
	// no key; see docs/protocol.md.
	CodeBadName = "badname"
	// CodeBadChunk is an uploaded body that does not hash to the name it was
	// asked for, or a chunk name that is not a hex SHA-256.
	CodeBadChunk = "badchunk"
	// CodeToolarge is a file or chunk above the advertised ceiling.
	CodeToolarge = "toolarge"
	// CodeNoSpace is a write refused for want of disk.
	CodeNoSpace = "nospace"
	// CodeNoUID is a get for a uid this vault does not have.
	CodeNoUID = "nouid"
	// CodeNoContent is a get for an entry that has no body: a folder, or a
	// deletion. Distinct from CodeNoUID because the entry exists, and distinct
	// from an empty chunk list because a zero-byte file is a real file.
	CodeNoContent = "nocontent"
	// CodeNoChunk is a fetch for a chunk the server does not hold. Loud, so a
	// client is never left waiting for a body that is not coming.
	CodeNoChunk = "nochunk"
	// CodeProtoState is a message that does not belong in the current state:
	// a put before hello, a stray binary frame. The session closes.
	CodeProtoState = "protostate"
	// CodeInternal is a server-side fault. The put is not committed.
	CodeInternal = "internal"
	// CodeBusy is the vault's device limit, or a server that is shutting down.
	// Honest refusal beats degrading. It is the one refusal a client should
	// simply wait out, which is what `retryable` and `retryAfterMs` say.
	CodeBusy = "busy"
	// CodeCursor is a client whose cursor is ahead of the server's.
	//
	// It means the server has lost history the client has already applied:
	// restored from an old backup, or pointed at the wrong vault. Left alone,
	// the server reissues those uids for different content and the two diverge
	// with both sides reporting success. It is refused instead, because a
	// refusal is reversible and silent divergence is not.
	CodeCursor = "cursor"
)

/* ---------------------------------------------------------------- *
 * Client to server
 * ---------------------------------------------------------------- */

// In is the union of every client frame.
//
// Clients send flat JSON discriminated by `op`, so one struct with a switch
// beats per-op types plus a two-pass unmarshal. The cost is that a field only
// meaningful to one op is visible to all of them, which is why each handler
// validates what it uses rather than trusting the zero value.
type In struct {
	Op string `json:"op"`

	// ID is the client's request id, echoed on the reply and on any error
	// refusing it. Zero on a protocol 2 request, which carries none. Before
	// ids, a reply was matched to the one request in flight by position, and
	// three separate client defects came from that; see docs/protocol.md.
	ID int64 `json:"id,omitempty"`

	// hello
	Proto  int    `json:"proto"`
	Vault  string `json:"vault"`
	Token  string `json:"token"`
	Device string `json:"device"`
	Crypto string `json:"crypto"`
	Cursor int64  `json:"cursor"`
	// Claim is the auth key this device wants the vault bound to, sent only
	// while pairing the first device to an unclaimed vault. Ignored once a
	// vault has been claimed, so a device sending it every time costs nothing
	// and a device that never sends it can still be the first.
	Claim string `json:"claim,omitempty"`
	// Wrapped is the vault's data key, wrapped under a key derived from the
	// root secret, sent beside Claim by a protocol 3 device and stored with the
	// auth hash. Opaque here: the server holds neither key. On a rotate it is
	// the same data key wrapped under the new root.
	Wrapped string `json:"wrapped,omitempty"`

	// rotate: the new auth key, whose hash replaces the stored one.
	Auth string `json:"auth,omitempty"`

	// invite: Invite is the random identifier and Sealed the root secret sealed
	// under the invite key, which never reaches the server. TTLMs is how long
	// the invite lives; zero is the default. At hello, Invite in place of a
	// token redeems one.
	Invite string `json:"invite,omitempty"`
	Sealed string `json:"sealed,omitempty"`
	TTLMs  int64  `json:"ttlMs,omitempty"`

	// put
	Path   string   `json:"path"`
	Meta   PutMeta  `json:"meta"`
	Chunks []string `json:"chunks"`
	// Mac authenticates the entry and Parent names what it was written on top
	// of. Both are opaque to the server, which holds no key to check them.
	Mac    string `json:"mac"`
	Parent string `json:"parent"`

	// get
	UID int64 `json:"uid"`

	// history
	//
	// Before paginates: the oldest uid already held, to ask for the page before
	// it. Zero starts at the newest. Limit is advisory and the server bounds it.
	Before int64 `json:"before"`
	Limit  int   `json:"limit"`

	// putmany
	Entries []PutEntry `json:"entries"`
}

// PutEntry is one file inside a batched put.
//
// The same three fields a single put carries. A batch exists because latency
// multiplies round trips: two hundred paths were two hundred requests, and on a
// link with four hundred milliseconds in it that is eighty seconds of waiting
// for permission to send things the server was always going to want.
type PutEntry struct {
	Path   string   `json:"path"`
	Meta   PutMeta  `json:"meta"`
	Chunks []string `json:"chunks"`
	Mac    string   `json:"mac"`
	Parent string   `json:"parent"`
}

// Entry converts one batched put into the store's record.
func (p PutEntry) Entry(device string) store.Entry {
	return store.Entry{
		Path:    p.Path,
		Size:    p.Meta.Size,
		CTime:   p.Meta.CTime,
		MTime:   p.Meta.MTime,
		Folder:  p.Meta.Folder,
		Deleted: p.Meta.Deleted,
		Device:  device,
		Prev:    p.Meta.Prev,
		Chunks:  p.Chunks,
		Mac:     p.Mac,
		Parent:  p.Parent,
	}
}

// MaxBatchEntries bounds one batched put.
//
// A cap rather than a stream, because the server holds every entry of a batch
// in memory while it waits for the bodies, and because a want list has to be
// computed from all of them before any of it can be answered. Two hundred and
// fifty six is enough that a first sync is a handful of round trips and small
// enough that a batch is never a reason to run out of anything.
const MaxBatchEntries = 256

// MaxBatchBytes bounds one batched put two ways: the encoded `putmany` frame
// may not exceed it, and neither may the summed ciphertext budget of the
// entries in it (S18). Both are advertised in `ready` so a client can split a
// batch before sending rather than discover the bound by being refused.
//
// The frame bound is what makes "every legal message is receivable" true: the
// read limit is set above it (server.ReadLimit), so a frame over this cap is
// read in full and refused with `toolarge`, never dropped with a bare
// disconnect that the client answers by retrying the identical batch for ever
// (S22). The budget bound is what stops one authenticated batch streaming
// gigabytes of bodies: 256 entries at the 64 MiB file limit was 16 GiB of
// allowed upload in one exchange. A file whose budget alone exceeds this goes
// through a single `put`, which is bounded by perFileMax instead.
//
// 16 MiB is thousands of notes at the sizes people write them and small enough
// that a batch is never why a server ran out of memory holding it.
const MaxBatchBytes = 16 << 20

// MaxFetchBytes bounds the summed stored size of the bodies one `fetch` may ask
// for (S21). The server knows every size from the same stat that answers
// presence; a client bounds itself with CiphertextBudget over the files it is
// fetching, which is never smaller. Over it is `toolarge` with no bodies.
//
// 64 MiB matches the default file limit, so one fetch can always carry one
// file, and a first download of a text vault is still a handful of round trips.
const MaxFetchBytes = 64 << 20

// PutMeta is the metadata of one version. It is nested rather than flat so that
// the fields a client assembles from the filesystem travel together and are
// obviously the same set in both directions.
type PutMeta struct {
	Size    int64 `json:"size"`
	CTime   int64 `json:"ctime"`
	MTime   int64 `json:"mtime"`
	Folder  bool  `json:"folder"`
	Deleted bool  `json:"deleted"`
	// Prev is the previous path on a rename, so a rename is one operation
	// rather than a delete plus an add.
	Prev string `json:"prev,omitempty"`
}

// Entry converts a put into the store's record. The uid is assigned on commit
// and is deliberately not settable by a client.
func (in In) Entry() store.Entry {
	return store.Entry{
		Path:    in.Path,
		Size:    in.Meta.Size,
		CTime:   in.Meta.CTime,
		MTime:   in.Meta.MTime,
		Folder:  in.Meta.Folder,
		Deleted: in.Meta.Deleted,
		Device:  in.Device,
		Prev:    in.Meta.Prev,
		Chunks:  in.Chunks,
		Mac:     in.Mac,
		Parent:  in.Parent,
	}
}

/* ---------------------------------------------------------------- *
 * Server to client
 * ---------------------------------------------------------------- */

// Ready answers hello and carries the limits a client needs before its first
// put. It is sent before any catch-up, so a client never has to guess a ceiling
// or discover one by being rejected.
//
// Cursor is what the *server* holds. A client compares it with its own and
// knows immediately how far behind it is. docs/protocol.md's fourth design rule
// is that no persisted boolean decides whether a vault uploads: the client
// announces what it has, the server answers with what it has, and neither
// remembers a verdict from last time.
//
// Proto is the version this session speaks, which is the one the client asked
// for. MinProto and ServerVersion are there so a refused or puzzled client can
// name both ends in its error. The two caps and Wrapped are new in protocol 3;
// a protocol 2 client ignores the caps and is never sent Wrapped.
type Ready struct {
	Res           string `json:"res"` // "ready"
	ID            int64  `json:"id,omitempty"`
	Proto         int    `json:"proto"`
	MinProto      int    `json:"minProto"`
	ServerVersion string `json:"serverVersion"`
	Cursor        int64  `json:"cursor"`
	PerFileMax    int64  `json:"perFileMax"`
	ChunkMax      int64  `json:"chunkMax"`
	MaxChunks     int    `json:"maxChunks"`
	MaxBatchBytes int64  `json:"maxBatchBytes"`
	MaxFetchBytes int64  `json:"maxFetchBytes"`
	// Wrapped is the vault's wrapped data key when it has one. Absent for a
	// vault claimed under protocol 2, which is how a client learns which key
	// schedule applies; docs/protocol.md, "The data key".
	Wrapped string `json:"wrapped,omitempty"`
}

// Batch delivers entries, and is the only message that ever does.
//
// Catch-up and live changes share one shape on purpose. A client that has one
// code path for "apply these entries, then set the cursor to To" cannot have a
// bug in the live path that the catch-up path does not have, and the continuity
// check is the same assertion in both cases.
//
// From and To are a covered range, not the first and last uid present: every
// entry that exists with From <= uid <= To is in Entries. Purged history leaves
// holes in the sequence, and a client that read From/To as "the uids here"
// would see every hole as a lost file. The check is From == cursor+1.
//
// Entries is empty for a range that contains only the receiving device's own
// write. That is how a device is spared having to recognise its own echo: it
// gets the cursor advance without the payload, so there is nothing to compare
// and no chance of concluding its own file came from somewhere else. Obsidian's
// pusher has to match five fields byte-identically or it downloads its own file
// back over itself.
type Batch struct {
	Op      string        `json:"op"` // "batch"
	From    int64         `json:"from"`
	To      int64         `json:"to"`
	Entries []store.Entry `json:"entries"`
}

// CaughtUp ends the backlog. Cursor is the last uid delivered, so a client that
// has been asserting continuity all the way through can stop here and trust it.
type CaughtUp struct {
	Op     string `json:"op"` // "caught-up"
	Cursor int64  `json:"cursor"`
}

// Want lists the chunks the server lacks, in the order it wants them. It is
// never longer than the put's own chunk list and never contains a repeat.
type Want struct {
	Res    string   `json:"res"` // "want"
	ID     int64    `json:"id,omitempty"`
	Chunks []string `json:"chunks"`
}

// Have means every chunk was already held, so nothing was uploaded and the
// entry is committed. It carries the uid for the same reason Ack does.
type Have struct {
	Res string `json:"res"` // "have"
	ID  int64  `json:"id,omitempty"`
	UID int64  `json:"uid"`
}

// Ack means the upload is durable and the entry is committed, in that order.
//
// It is withheld until both are true. An ack sent earlier would mean "stored"
// was a claim a crash could expose, which is the first of the ten durability
// rules and the one the rest exist to protect.
//
// The uid is also how a device knows which write was its own, without comparing
// any content.
type Ack struct {
	Res string `json:"res"` // "ack"
	ID  int64  `json:"id,omitempty"`
	UID int64  `json:"uid"`
}

// Chunks answers a get with where the content lives. The client then fetches
// only the chunks it does not already hold from some other version of the file.
type Chunks struct {
	Res    string   `json:"res"` // "chunks"
	ID     int64    `json:"id,omitempty"`
	UID    int64    `json:"uid"`
	Size   int64    `json:"size"`
	Chunks []string `json:"chunks"`
}

// Bodies answers a protocol 3 fetch and says exactly how many binary frames
// follow, in the order asked. A fetch is answered by this or by an Err, never
// by bodies and then an error: a client that received three frames and then a
// refusal could not tell which three, and stale bodies from a refused fetch
// used to be consumed as the answer to the next one. A protocol 2 session
// gets the bodies with no header, as it always did.
type Bodies struct {
	Res   string `json:"res"` // "bodies"
	ID    int64  `json:"id,omitempty"`
	Count int    `json:"count"`
}

// Invited answers an invite with the moment it stops working, in milliseconds
// of the server's clock, which is the only thing the server knows about it
// that the issuing device did not already.
type Invited struct {
	Res       string `json:"res"` // "invited"
	ID        int64  `json:"id,omitempty"`
	ExpiresAt int64  `json:"expiresAt"`
}

// Redeemed answers a hello that carried an invite: the sealed root secret the
// issuing device stored, and the vault's wrapped data key when it has one, so
// the new device can derive everything and connect again as a device. The
// session closes after this; the invite was marked used before it was sent.
type Redeemed struct {
	Res     string `json:"res"` // "redeemed"
	ID      int64  `json:"id,omitempty"`
	Sealed  string `json:"sealed"`
	Wrapped string `json:"wrapped,omitempty"`
}

// Rotated answers a rotate: the vault's auth hash and wrapped data key were
// replaced together, and every other session on the vault has been closed.
type Rotated struct {
	Res string `json:"res"` // "rotated"
	ID  int64  `json:"id,omitempty"`
}

// History answers a history request with every version of one path, newest
// first.
//
// Read-only, like Deleted below, and that is the whole of the recovery
// protocol. Restoring is not a server operation: a client asks for the history,
// fetches the version it wants with the ordinary `get`, writes it into the
// vault, and the ordinary sync uploads it as a new version. That leaves the
// server with no new way to mutate a vault, and the client had to download the
// content regardless, so the extra op would have bought nothing.
//
// Entries is never null. A client that iterates it would crash on exactly the
// answers it is meant to handle, which is the same reasoning as Batch.
type History struct {
	Res string `json:"res"` // "history"
	ID  int64  `json:"id,omitempty"`
	// Path echoes the request, so a client with several in flight can tell
	// which answer it is holding. Still sealed; the server has never seen the
	// plaintext and cannot start now.
	Path    string        `json:"path"`
	Entries []store.Entry `json:"entries"`
}

// Deleted answers a deleted request with every path whose newest version is a
// deletion.
//
// Renames are suppressed, and not optionally. A rename leaves a deletion behind
// at the old path, so without suppression most of this list is phantom
// deletions of files that still exist under another name, and a recovery list
// that is mostly noise is one nobody reads.
type Deleted struct {
	Res string `json:"res"` // "deleted"
	ID  int64  `json:"id,omitempty"`
	// Each entry carries `restorable`: the uid of the newest version with
	// content in it, or zero. Purge keeps only the newest version per path, and
	// for a deleted note that is the deletion record, so a note can be listed
	// here with nothing left to restore it from. A client that says "all still
	// recoverable" over this list without looking is telling somebody their
	// note is safe when it is not.
	Entries []store.Deletion `json:"entries"`
	// More says the list was cut short. A vault accumulates deletions for as
	// long as it exists, so the answer is bounded; saying nothing about it
	// would hand somebody a short list that looks complete, and the note they
	// are looking for is exactly the one that might be missing from it.
	More bool `json:"more"`
}

// Pong answers a ping. A client behind NAT needs something to send.
type Pong struct {
	Res string `json:"res"` // "pong"
}

// Acks answers a batched put, one result per entry, in the order they were sent.
//
// Per entry rather than one verdict for the batch. A single unacceptable file
// among two hundred good ones must not refuse the other hundred and
// ninety-nine, and a client needs to know which one it was: the alternative is
// a batch that fails as a unit and a client that has to bisect it to find out
// why.
type Acks struct {
	Res     string      `json:"res"` // "acks"
	ID      int64       `json:"id,omitempty"`
	Results []AckResult `json:"results"`
}

// AckResult is a uid, or the reason there is not one.
type AckResult struct {
	UID  int64  `json:"uid,omitempty"`
	Code string `json:"code,omitempty"`
	Msg  string `json:"msg,omitempty"`
}

// Err is every rejection.
//
// ID is present when the error answers a request, and absent on the one
// unsolicited error the server sends, the shutdown or rotation notice, which a
// client reads as the reason the connection is about to close.
//
// Retryable is a pointer so that a protocol 2 session, which never had the
// field, is sent exactly the shape it always was. In a protocol 3 session it
// is always set, from the table in Retryable below, so a client has nothing to
// interpret: back off and reconnect on true, stop on false. RetryAfterMs is a
// hint that travels with `busy`.
type Err struct {
	Res          string `json:"res"` // "err"
	ID           int64  `json:"id,omitempty"`
	Code         string `json:"code"`
	Msg          string `json:"msg"`
	Retryable    *bool  `json:"retryable,omitempty"`
	RetryAfterMs int64  `json:"retryAfterMs,omitempty"`
}

// Error is a protocol 2 shaped rejection: code and message and nothing else.
func Error(code, msg string) Err { return Err{Res: "err", Code: code, Msg: msg} }

// ForProto3 fills in what a protocol 3 client expects: the id of the request
// being refused, or zero for an unsolicited error, and the retryable verdict
// for the code. retryAfterMs is sent only when positive.
func (e Err) ForProto3(id, retryAfterMs int64) Err {
	r := Retryable(e.Code)
	e.ID = id
	e.Retryable = &r
	if retryAfterMs > 0 {
		e.RetryAfterMs = retryAfterMs
	}
	return e
}

// Retryable says whether reconnecting later can succeed where retrying the same
// request cannot. It is the "retryable" column of the error table in
// docs/protocol.md, and the two are kept in step by hand.
//
// Only three codes are transient. `busy` is a device limit or a shutdown, both
// of which pass. `nospace` is a full disk, which an operator clears. `internal`
// is a server fault the put did not survive, and the server is the thing that
// can be fixed. Everything else names a fact about the request or the
// credentials that a retry does not change, and a watching client that
// reconnected on it would loop for ever.
func Retryable(code string) bool {
	switch code {
	case CodeBusy, CodeNoSpace, CodeInternal:
		return true
	}
	return false
}
