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
// oldest it still answers. A version outside that range is refused at hello
// naming both numbers, not negotiated: interoperating with a version we have
// not seen is how a silent incompatibility gets shipped, and the one it would
// ship here is a device that connects and syncs under a credential nobody can
// revoke.
//
// Both are 4, so the range is one version wide and nothing older is carried.
// The range stays in the handshake because the next version needs somewhere to
// say so.
const (
	Proto    = 4
	MinProto = 4
)

// MaxRequestID bounds a client-chosen request id: an integer from 1 to 2^32-1.
// Zero is not a legal id, which is what makes a request that carries none
// detectable rather than indistinguishable from one that carries id 0.
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
	// CodeNoDevice names a device this vault does not have: a revoke for an id
	// that is already gone. Its own code, beside nouid and nochunk, because
	// the protocol says what is missing rather than making a caller read the
	// sentence: a list read a moment ago is stale and wants refreshing, which
	// is a different act from every other refusal a revoke can get.
	CodeNoDevice = "nodevice"
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
	// CodeFull is a registration refused because the vault already holds as
	// many devices as it may.
	//
	// Not `busy`, although both are limits. `busy` means come back later and
	// carries a hint saying how much later, and this never becomes true by
	// waiting: somebody has to revoke a device. A client that treated it as
	// `busy` would retry a registration that can only ever be refused, which
	// is the hot loop `retryable` exists to prevent. The session continues,
	// because nothing was written and a registrar with a second device to
	// register may still register it.
	CodeFull = "full"
	// CodeRotated is a rotate that lost the race: the vault's credential is no
	// longer the one this session authenticated under, because another device
	// rotated first.
	//
	// Distinct from `auth` because it answers a request rather than the
	// connection, and distinct from `internal` because nothing went wrong: the
	// vault has a new owner and this device is not it. Retrying the same rotate
	// cannot succeed, so it is not retryable, and the session ends, because the
	// credential it is holding no longer opens the vault.
	CodeRotated = "rotated"
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
	// refusing it. Every request that expects a reply carries one; a request
	// that does not ends the session. Before ids, a reply was matched to the
	// one request in flight by position, and three separate client defects
	// came from that; see docs/protocol.md.
	ID int64 `json:"id,omitempty"`

	// hello
	Proto  int    `json:"proto"`
	Vault  string `json:"vault"`
	Token  string `json:"token"`
	Device string `json:"device"`
	Crypto string `json:"crypto"`
	Cursor int64  `json:"cursor"`
	// DeviceID names the row in the vault's device list that this connection
	// claims to be, and Token is then that device's auth key rather than the
	// vault's. Present is what makes a hello a device connecting: absent, the
	// credential is the vault's, and the session that results may register a
	// device and nothing else.
	//
	// It is deliberately not the same field as Device. Device is a label a
	// person reads beside a version and two laptops may share it; this is the
	// identity, and the difference is the whole of what makes revoking one
	// device rather than "everything called laptop" possible.
	DeviceID string `json:"deviceId,omitempty"`
	// Claim is the auth key this device wants the vault bound to, sent only
	// while pairing the first device to an unclaimed vault. Ignored once a
	// vault has been claimed, so a device sending it every time costs nothing
	// and a device that never sends it can still be the first.
	Claim string `json:"claim,omitempty"`
	// Wrapped is the vault's data key, wrapped under a key derived from the
	// root secret, sent beside Claim and stored with the auth hash. Opaque
	// here: the server holds neither key. A claim without a valid one is
	// refused, so every claimed vault has a data key and no session can be
	// steered onto a schedule that derives content keys from the root. On a
	// rotate it is the same data key wrapped under the new root.
	Wrapped string `json:"wrapped,omitempty"`

	// rotate: the new auth key, whose hash replaces the stored one.
	//
	// register, and a hello redeeming an invite: the new device's auth key,
	// whose hash becomes its row's. The key and not the hash, for the same
	// reason `claim` is the key: the server stores only the digest either way,
	// and a hash is a credential nobody can judge, so a device offering the
	// hash of "password" would be registered with a straight face.
	// MinClaimLength is the floor for both.
	//
	// It is Auth and not Token on a redeeming hello, deliberately. Token is
	// what a frame authenticates with, and on that frame the invite is; this
	// is a credential being written down for next time. Sharing the field
	// would also make "a token and an invite together" unsayable, and that
	// refusal exists because a hello that carried both used to authenticate on
	// the token and leave the invite neither redeemed nor refused.
	Auth string `json:"auth,omitempty"`

	// register, and a hello redeeming an invite: Name is the label for the new
	// device's row, defaulting to the session's own `device` name when it is
	// empty, and bounded exactly as that name is. It is never an identifier:
	// two devices may share one.
	Name string `json:"name,omitempty"`

	// revoke: AllowLast is the caller saying out loud that it means to leave
	// the vault with no devices at all, reachable only by the recovery key.
	// Refused without it, because that is a thing to want after a house fire
	// and not a thing to discover you did by clicking the wrong row.
	AllowLast bool `json:"allowLast,omitempty"`

	// invite: Invite is the random identifier and Sealed the vault's data key
	// sealed under the invite key, which never reaches the server. TTLMs is
	// how long the invite lives; zero is the default.
	//
	// At hello, Invite in place of a token redeems one, and the hello carrying
	// it also carries DeviceID, Auth and optionally Name, because redeeming an
	// invite is what registers the redeeming device: an invite is single use,
	// server tracked and expiring, which is the authority to register exactly
	// one device, and the device that issued it holds no root and so could not
	// have registered a row on the newcomer's behalf.
	//
	// A hello carrying both a token and an invite is refused: "in place of" is
	// the rule, and a server that picked one for you would be redeeming or
	// discarding an invite the client did not decide about.
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
//
// The device is the session's and is passed in, exactly as it is for one entry
// of a batch. Reading it off the message would let a device write under another
// device's name, and a device name is what a person reads next to a version to
// work out where it came from. Taking it as an argument makes that unwritable
// rather than something the caller has to remember to overwrite.
func (in In) Entry(device string) store.Entry {
	return store.Entry{
		Path:    in.Path,
		Size:    in.Meta.Size,
		CTime:   in.Meta.CTime,
		MTime:   in.Meta.MTime,
		Folder:  in.Meta.Folder,
		Deleted: in.Meta.Deleted,
		Device:  device,
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
// Proto is the version this session speaks and MinProto the oldest this server
// answers. Both are wire.Proto today, and they are sent anyway so a puzzled
// client can name both ends in its error, and so the next protocol bump has
// something to negotiate with.
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
	// Wrapped is the vault's wrapped data key. Every claimed vault has one,
	// because a claim without one is refused, so this is always present on a
	// session the server let through; docs/protocol.md, "The data key". It is
	// omitted only for a vault nothing has claimed, which no device can reach
	// past the handshake.
	Wrapped string `json:"wrapped,omitempty"`
}

// Registrar answers a hello that offered the vault's credential rather than a
// device's. It is the other outcome of a handshake, and it says so in one word
// rather than leaving a client to work out what it got.
//
// A registrar session may register a device and rewrap the data key, which are
// the two powers the root secret has, and may do nothing else: no entries, no
// history, no chunk, no device list, no catch-up and no place in the vault's
// fan-out. So no `ready`, because `ready` promises the ceilings for a put and
// a backlog behind it, and a reply that promised a catch-up nobody would send
// is how a client comes to wait for a frame that is not coming.
//
// MaxDevices is here for the same reason every ceiling is in `ready`: a client
// that knows the cap before it registers can say "revoke one first" instead of
// discovering the cap by being refused.
type Registrar struct {
	Res           string `json:"res"` // "registrar"
	ID            int64  `json:"id,omitempty"`
	Proto         int    `json:"proto"`
	MinProto      int    `json:"minProto"`
	ServerVersion string `json:"serverVersion"`
	MaxDevices    int    `json:"maxDevices"`
}

// Registered answers a register: the device now has a row and may connect with
// its own credential.
//
// Wrapped is the vault's wrapped data key, which is what the registering
// session came for. It holds the root, so it can unwrap it and hand the new
// device the data key itself; the new device never holds the root and so never
// needs the wrapping again.
type Registered struct {
	Res      string `json:"res"` // "registered"
	ID       int64  `json:"id,omitempty"`
	DeviceID string `json:"deviceId"`
	Wrapped  string `json:"wrapped,omitempty"`
}

// DeviceList answers a devices request with every device that may reach this
// vault, and every invite that could still add one.
//
// Neither slice is ever null, for the same reason Batch.Entries is not: a
// client that iterates one would crash on exactly the vault it is meant to
// handle. Neither carries a credential either: store.Device has no field that
// could, and store.Invite carries the identifier and the expiry and never the
// sealed blob; see the comments there.
//
// Invites ride on the device list rather than having an op of their own,
// because they are one subject. "What can reach my notes" is answered by the
// rows plus the strings that have not been redeemed yet, and a client that had
// to ask twice would be a client that could show half the answer.
type DeviceList struct {
	Res        string         `json:"res"` // "devices"
	ID         int64          `json:"id,omitempty"`
	Devices    []store.Device `json:"devices"`
	MaxDevices int            `json:"maxDevices"`
	Invites    []store.Invite `json:"invites"`
}

// Revoked answers a revoke: the row is gone and every session that device had
// open has been closed, in that order, so the reply means both.
type Revoked struct {
	Res      string `json:"res"` // "revoked"
	ID       int64  `json:"id,omitempty"`
	DeviceID string `json:"deviceId"`
	// Self is true when the device revoked was this session's own, in which
	// case this reply is the last frame on the connection. A client that
	// unlinked itself is owed the difference between "you are gone" and a
	// server that hung up for its own reasons.
	Self bool `json:"self,omitempty"`
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

// Bodies answers a fetch and says exactly how many binary frames follow, in
// the order asked. A fetch is answered by this or by an Err, never by bodies
// and then an error: a client that received three frames and then a refusal
// could not tell which three, and stale bodies from a refused fetch used to be
// consumed as the answer to the next one.
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

// Redeemed answers a hello that carried an invite: the vault's data key, as
// the issuing device sealed it under the invite key, and the id of the device
// row this redemption registered.
//
// The session closes after this. It is not a device session: the row exists
// now, but nothing on this connection has proved that anyone holds the key it
// was registered with, and the redeemer has to write the key and the data key
// down before it can use either. It connects again as a device, and that hello
// is the proof.
//
// DeviceID echoes what was asked for so the redeemer can check the row it is
// about to store a credential for is the one it named. There is no wrapped
// data key here and there must not be: the wrapping opens under the root, the
// redeeming device does not hold one, and a field a client is told to ignore
// is a field a client eventually uses.
type Redeemed struct {
	Res      string `json:"res"` // "redeemed"
	ID       int64  `json:"id,omitempty"`
	Sealed   string `json:"sealed"`
	DeviceID string `json:"deviceId"`
}

// Uninvited answers an uninvite: that invite is gone and the string somebody is
// holding no longer redeems. It names the invite so a client can tell which of
// several it cancelled, the way Revoked names the device.
type Uninvited struct {
	Res    string `json:"res"` // "uninvited"
	ID     int64  `json:"id,omitempty"`
	Invite string `json:"invite"`
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
// ID is present when the error answers a request, and absent on the errors the
// server sends unasked, the shutdown and rotation notices, which a client reads
// as the reason the connection is about to close.
//
// Retryable is always sent, from the table in Retryable below, so a client has
// nothing to interpret: back off and reconnect on true, stop on false. It is a
// plain bool with no omitempty precisely so that an error without it cannot be
// built; an error a client has to guess about is how a watching device ends up
// either giving up or hot-looping. RetryAfterMs is a hint that travels with
// `busy`.
type Err struct {
	Res          string `json:"res"` // "err"
	ID           int64  `json:"id,omitempty"`
	Code         string `json:"code"`
	Msg          string `json:"msg"`
	Retryable    bool   `json:"retryable"`
	RetryAfterMs int64  `json:"retryAfterMs,omitempty"`
}

// Error is a rejection: the code, the message for the human, and the retryable
// verdict the code implies. The id and any retryAfterMs hint are filled in by
// whoever is about to send it, which is the only place that knows whether a
// request is being answered.
func Error(code, msg string) Err {
	return Err{Res: "err", Code: code, Msg: msg, Retryable: Retryable(code)}
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
