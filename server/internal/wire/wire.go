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

import "github.com/waynehoover/basalt/server/internal/store"

// Proto is the protocol version this server implements. A mismatch is refused,
// not negotiated: interoperating with a version we have not seen is how a
// silent incompatibility gets shipped.
const Proto = 1

// Crypto names the client-side scheme. It is a string rather than an integer
// because an integer shared with other implementations means two projects
// eventually disagree about what version 2 was.
const Crypto = "basalt/hkdf-aes-gcm/1"

// Error codes. `code` is for the client to act on, `msg` is for a human to
// read; docs/protocol.md requires both, because an error a device cannot act on
// and a person cannot read is how a silent failure starts.
//
// The doc lists five of these. The rest were needed to name outcomes that would
// otherwise have had to share a code with something a client must handle
// differently, and are recorded in the doc alongside them.
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
	// CodeBusy is the vault's device limit. Honest refusal beats degrading.
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

	// put
	Path   string   `json:"path"`
	Meta   PutMeta  `json:"meta"`
	Chunks []string `json:"chunks"`

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
type Ready struct {
	Res        string `json:"res"` // "ready"
	Proto      int    `json:"proto"`
	Cursor     int64  `json:"cursor"`
	PerFileMax int64  `json:"perFileMax"`
	ChunkMax   int64  `json:"chunkMax"`
	MaxChunks  int    `json:"maxChunks"`
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
	Chunks []string `json:"chunks"`
}

// Have means every chunk was already held, so nothing was uploaded and the
// entry is committed. It carries the uid for the same reason Ack does.
type Have struct {
	Res string `json:"res"` // "have"
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
	UID int64  `json:"uid"`
}

// Chunks answers a get with where the content lives. The client then fetches
// only the chunks it does not already hold from some other version of the file.
type Chunks struct {
	Res    string   `json:"res"` // "chunks"
	UID    int64    `json:"uid"`
	Size   int64    `json:"size"`
	Chunks []string `json:"chunks"`
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
	Results []AckResult `json:"results"`
}

// AckResult is a uid, or the reason there is not one.
type AckResult struct {
	UID  int64  `json:"uid,omitempty"`
	Code string `json:"code,omitempty"`
	Msg  string `json:"msg,omitempty"`
}

// Err is every rejection.
type Err struct {
	Res  string `json:"res"` // "err"
	Code string `json:"code"`
	Msg  string `json:"msg"`
}

func Error(code, msg string) Err { return Err{Res: "err", Code: code, Msg: msg} }
