// Package chunks is a content-addressed store for encrypted chunk bodies.
//
// It is deliberately free of any dependency on the entry store, the wire
// protocol or SQLite: a chunk is bytes under a name, and everything this
// package does can be exercised with nothing but a temp directory. That
// boundary is the one worth keeping clean, because it is where "do not lose a
// note" turns into fsync ordering.
//
// The server never sees plaintext. Clients encrypt each chunk before naming it,
// so the bytes here are ciphertext and the name is a hash of ciphertext. That is
// what lets the server dedup without learning anything.
package chunks

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// NameLen is the length of a chunk name in characters.
//
// A chunk name is the lowercase hex SHA-256 of the *encrypted* chunk bytes.
// docs/protocol.md says chunk hashes are hashes of the encrypted chunk; it does
// not name the function, so this package names it, for two reasons.
//
// The first is verification. If the server cannot recompute the name from the
// body, it cannot tell a correct chunk from a corrupt one, and "stored" becomes
// a claim rather than a fact. Rule 4 of the philosophy doc is about exactly
// this: verify the outcome, not the exit code.
//
// The second is that a fixed-width hex name makes path traversal impossible by
// construction. An arbitrary client-supplied string used as a filename is a
// directory traversal waiting to happen, and defending against it by re-hashing
// the string would throw away verification to buy back the safety the fixed
// format already provides.
const NameLen = sha256.Size * 2

var (
	// ErrBadName is a name that is not a lowercase hex SHA-256.
	ErrBadName = errors.New("chunk name is not a hex sha-256")
	// ErrCorrupt is a body whose hash does not match the name it is stored
	// under. It is never a normal condition and never retried away: the chunk
	// on disk is not the chunk the client uploaded.
	ErrCorrupt = errors.New("chunk body does not match its name")
	// ErrTooLarge is a body above the store's configured chunk ceiling.
	ErrTooLarge = errors.New("chunk exceeds chunkMax")
	// ErrNotFound is a chunk this vault does not hold.
	ErrNotFound = errors.New("chunk not found")
)

// Name returns the chunk name for a body: what the client is required to have
// computed. Used by Put to verify, and by tests to build realistic inputs.
func Name(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// ValidName reports whether s is a well-formed chunk name.
//
// Case matters. Accepting both cases would give one chunk two names, two
// files on disk, and a dedup miss that looks like a bandwidth mystery rather
// than a bug. The wire format has one spelling.
func ValidName(s string) bool {
	if len(s) != NameLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') {
			continue
		}
		return false
	}
	return true
}

// Store holds chunk bodies under dir, namespaced per vault.
type Store struct {
	dir string
	max int64
}

// New opens (and creates) a chunk store rooted at dir.
//
// max is the chunkMax advertised in the handshake. It lives on the store rather
// than being checked by callers so that there is exactly one place a body's
// size is bounded, and no path into Put that forgets to bound it.
func New(dir string, max int64) (*Store, error) {
	if max <= 0 {
		return nil, fmt.Errorf("chunks: max must be positive, got %d", max)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir, max: max}, nil
}

// Max is the largest body this store accepts, for the handshake to advertise.
func (s *Store) Max() int64 { return s.max }

// vaultKey derives a fixed-width directory name from a vault id.
//
// Unlike chunk names, a vault id is an arbitrary client-supplied string, so it
// is hashed before it touches the filesystem. There is nothing to verify about
// a vault id, so hashing costs nothing here.
func vaultKey(vaultID string) string {
	sum := sha256.Sum256([]byte(vaultID))
	return hex.EncodeToString(sum[:])
}

// path locates a chunk.
//
// Chunks are namespaced by vault and deliberately NOT shared across vaults.
// Sharing by content would let one vault read another's file by claiming its
// chunk name, and overwrite that content by uploading different bytes under the
// same name. Cross-vault dedup is worth nothing anyway: each vault encrypts
// with its own key, so identical notes in two vaults have different ciphertext
// and therefore different names.
func (s *Store) path(vaultID, name string) string {
	// The two-character fan-out keeps directory sizes reasonable on filesystems
	// that degrade with very wide directories.
	return filepath.Join(s.dir, vaultKey(vaultID), name[:2], name)
}

// VaultDir is the root of one vault's chunk storage. Exported for the sweep and
// for tests that need to corrupt a body on purpose.
func (s *Store) VaultDir(vaultID string) string {
	return filepath.Join(s.dir, vaultKey(vaultID))
}

// Path is the on-disk location of a chunk, whether or not it exists.
func (s *Store) Path(vaultID, name string) (string, error) {
	if !ValidName(name) {
		return "", fmt.Errorf("%w: %q", ErrBadName, name)
	}
	return s.path(vaultID, name), nil
}

// Has reports whether this vault already holds the chunk.
//
// Presence is a file on disk and nothing else. There is deliberately no
// presence table: two records of the same fact drift, and a table that claims a
// chunk the disk has lost is how an entry becomes unserveable while everything
// reports healthy.
//
// An unreadable directory is not an absent chunk, but Has cannot say so in its
// signature; it reports false and the caller then asks for the body, which
// fails loudly. Rule 2 says absent and unreadable are different states, and the
// place that distinction has to survive is Put and Get, which return errors.
func (s *Store) Has(vaultID, name string) bool {
	_, ok := s.Size(vaultID, name)
	return ok
}

// Size is Has plus the stored size, from the same stat.
//
// The size matters because an entry declares a plaintext size and references
// chunks of ciphertext, and nothing else in the system relates the two. A
// caller checking presence is already paying for the stat, so it may as well
// learn what it is admitting.
func (s *Store) Size(vaultID, name string) (int64, bool) {
	if !ValidName(name) {
		return 0, false
	}
	st, err := os.Stat(s.path(vaultID, name))
	if err != nil || !st.Mode().IsRegular() {
		return 0, false
	}
	return st.Size(), true
}

// Missing returns the subset of names this vault does not hold, in the order
// given and without repeats. It is the answer to a `put`: the `want` list.
//
// Every name is validated. A malformed name is an error rather than a silent
// omission, because dropping it would produce a shorter want list, the client
// would upload nothing for it, and the entry would then reference a chunk that
// can never arrive. Rule 5: a result smaller than its input is a bug until
// proven otherwise, and here the proof is that the name was well-formed and the
// chunk was genuinely present.
func (s *Store) Missing(vaultID string, names []string) ([]string, error) {
	seen := make(map[string]struct{}, len(names))
	var out []string
	for _, n := range names {
		if !ValidName(n) {
			return nil, fmt.Errorf("%w: %q", ErrBadName, n)
		}
		if _, dup := seen[n]; dup {
			continue
		}
		seen[n] = struct{}{}
		if !s.Has(vaultID, n) {
			out = append(out, n)
		}
	}
	return out, nil
}

// Put stores a body under its own name, verifying that the two agree.
//
// The write is a temp file, an fsync, a rename, and an fsync of the directory.
// Every step earns its keep:
//
//   - Writing in place would let a crash leave a half-written body that Has
//     then reports as present, and no later push would ever replace it, because
//     the client is told the server already holds that chunk.
//   - Renaming without fsyncing the file means the rename can be durable while
//     the bytes are not.
//   - Renaming without fsyncing the *directory* means the bytes can be durable
//     while the name is not, which is the one server-side fault a client cannot
//     detect: it acked, so it will never send that chunk again.
//
// Put returns once the body is durable. Nothing above it may acknowledge a push
// before that; the entry commit that follows is what makes the ack truthful.
func (s *Store) Put(vaultID, name string, body []byte) error {
	if !ValidName(name) {
		return fmt.Errorf("%w: %q", ErrBadName, name)
	}
	if int64(len(body)) > s.max {
		return fmt.Errorf("%w: %d > %d", ErrTooLarge, len(body), s.max)
	}
	// The name-against-body check is place's, so that it happens on whichever
	// goroutine is about to do the write. Storing a body under a claimed name
	// would corrupt the vault invisibly, and storing it under the computed name
	// would leave the entry pointing at a chunk that does not exist.
	dir, err := s.place(vaultID, name, body)
	if err != nil || dir == "" {
		return err
	}
	return syncDir(dir)
}

// place does everything Put does except the directory fsync, and returns the
// directory that still needs one. An empty directory means the chunk was
// already there and nothing was written.
//
// Split out because a batch of chunks landing in the same directory needs that
// fsync once rather than once each, and because the file fsyncs in a batch can
// then run at the same time. Neither changes what has to be true before an ack:
// every body durable, every name durable. It changes only how many times the
// same directory is flushed to make that so.
func (s *Store) place(vaultID, name string, body []byte) (string, error) {
	// Re-hashed here rather than trusted from the caller, because in a batch the
	// caller and the writer are different goroutines: whoever handed this over
	// has moved on, and if the bytes ever came from a buffer that gets reused,
	// the wrong body would be filed under a correct name and served to a device
	// that could only report it as undecryptable.
	//
	// coder/websocket's Conn.Read allocates per message today (io.ReadAll), so
	// this is closing the class rather than a live fault. One SHA-256 over data
	// already in hand, on a server that has the cores.
	if got := Name(body); got != name {
		return "", fmt.Errorf("%w: claimed %s, computed %s", ErrCorrupt, name, got)
	}

	p := s.path(vaultID, name)
	// A chunk already present is already correct: the name is a hash of the
	// body and the body was verified on the way in. Re-writing it would be a
	// window in which the chunk is a temp file rather than itself.
	if s.Has(vaultID, name) {
		return "", nil
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, tmpPrefix+"*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name()) // no-op once the rename has succeeded
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return "", err
	}
	return dir, nil
}

// Writers is how many chunks a batch fsyncs at once.
//
// An fsync is almost entirely waiting, so doing them one at a time left the
// wire and most of the disk idle: a first sync of a seventeen megabyte vault
// spent twenty-nine of its thirty seconds here.
//
// Sixteen is past the knee on both platforms measured, and this is a server
// somebody runs for their own devices, so there is no other load to protect.
// BenchmarkWriterWidth has the figures and how they were taken.
const Writers = 16

// A Writer stores many bodies at once and reports them durable only when every
// one of them is.
//
// The guarantee is the same one Put makes and it is made at the same moment:
// nothing above this may acknowledge a push until Close returns nil. What the
// batch buys is that the waiting happens in parallel and that a directory is
// flushed once rather than once per chunk it received.
type Writer struct {
	store   *Store
	vaultID string

	work chan writeJob
	wg   sync.WaitGroup

	mu   sync.Mutex
	dirs map[string]struct{}
	err  error
}

type writeJob struct {
	name string
	body []byte
}

// NewWriter starts a batch. Close must be called, and its error is the batch's.
func (s *Store) NewWriter(vaultID string) *Writer {
	return s.newWriterWidth(vaultID, Writers)
}

func (s *Store) newWriterWidth(vaultID string, width int) *Writer {
	w := &Writer{
		store:   s,
		vaultID: vaultID,
		// Bounded, so a fast reader cannot queue the whole upload in memory
		// while the disk is still on the first few chunks.
		work: make(chan writeJob, width),
		dirs: map[string]struct{}{},
	}
	for i := 0; i < width; i++ {
		w.wg.Add(1)
		go w.run()
	}
	return w
}

func (w *Writer) run() {
	defer w.wg.Done()
	for job := range w.work {
		if w.failed() {
			// Something already went wrong and Close will report it. Draining
			// rather than returning, because the sender is still writing to
			// this channel and would block on a closed pool for ever.
			continue
		}
		dir, err := w.store.place(w.vaultID, job.name, job.body)
		w.mu.Lock()
		if err != nil && w.err == nil {
			w.err = err
		}
		if dir != "" {
			w.dirs[dir] = struct{}{}
		}
		w.mu.Unlock()
	}
}

func (w *Writer) failed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err != nil
}

// Add hands one body to the batch. It blocks while every writer is busy, which
// is the backpressure that keeps an upload from being buffered in memory.
//
// The error it returns is a failure from an *earlier* body, reported here so a
// caller reading frames off a socket can stop early. Add returning nil is not a
// promise about this body; only Close is.
func (w *Writer) Add(name string, body []byte) error {
	if !ValidName(name) {
		return fmt.Errorf("%w: %q", ErrBadName, name)
	}
	if int64(len(body)) > w.store.max {
		return fmt.Errorf("%w: %d > %d", ErrTooLarge, len(body), w.store.max)
	}
	if got := Name(body); got != name {
		return fmt.Errorf("%w: claimed %s, computed %s", ErrCorrupt, name, got)
	}
	w.mu.Lock()
	err := w.err
	w.mu.Unlock()
	if err != nil {
		return err
	}
	w.work <- writeJob{name: name, body: body}
	return nil
}

// Close waits for every body and flushes every directory they landed in.
//
// Until this returns nil, no chunk in the batch may be treated as stored. The
// bodies are durable when the workers finish; the *names* are durable only
// after these fsyncs, and a name that is not durable is the one server-side
// fault a client cannot detect, because it was told the chunk arrived.
func (w *Writer) Close() error {
	close(w.work)
	w.wg.Wait()
	if w.err != nil {
		return w.err
	}
	for dir := range w.dirs {
		if err := syncDir(dir); err != nil {
			return err
		}
	}
	return nil
}

// tmpPrefix marks in-progress writes so the sweep leaves them alone.
const tmpPrefix = ".tmp-"

// Get returns a chunk body, verified against its name.
//
// Verifying on every read costs one SHA-256 over data that was just read from
// disk, and it is the difference between a client receiving a chunk that will
// fail to decrypt for reasons it cannot diagnose and the server saying which
// chunk of which vault went bad. Bit rot and a truncated restore both land
// here.
func (s *Store) Get(vaultID, name string) ([]byte, error) {
	if !ValidName(name) {
		return nil, fmt.Errorf("%w: %q", ErrBadName, name)
	}
	body, err := os.ReadFile(s.path(vaultID, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, name)
	}
	if err != nil {
		return nil, err
	}
	if got := Name(body); got != name {
		return nil, fmt.Errorf("%w: stored as %s, hashes to %s", ErrCorrupt, name, got)
	}
	return body, nil
}

// Check verifies a stored chunk without returning it. Used by the store's
// deep verify, which walks every entry and must not hold whole files in memory.
func (s *Store) Check(vaultID, name string) error {
	_, err := s.Get(vaultID, name)
	return err
}

// DefaultGrace is how long a chunk is protected from the sweep after it is
// written, regardless of whether anything references it yet.
//
// This exists because of a real livelock, found by running a purge loop against
// concurrent pushes. A push uploads its bodies and only then commits the entry
// that references them, so between those two steps its bodies are unreferenced
// and a sweep will collect them. The entry commit then fails, the client
// re-uploads, and the next sweep takes them again: under any sustained purge
// activity, pushes never complete. Two thirds of the pushes in that test
// starved.
//
// An hour is far longer than any single push and short enough that debris from a
// crashed one is collected on the next purge rather than never. The cost of the
// window is disk; the cost of not having it is a vault that cannot be written
// to while it is being tidied.
const DefaultGrace = time.Hour

// Sweep deletes this vault's chunks that are neither in live nor recently
// written.
//
// live must be the complete set of chunk names referenced by committed entries,
// computed by the caller while holding whatever lock keeps new entries from
// being committed. That lock is load-bearing and this package cannot take it,
// which is why this is a documented precondition rather than something Sweep
// works out for itself.
//
// cutoff is the grace boundary: a chunk whose body was written at or after it is
// kept even when nothing references it, because an in-flight push may be about
// to. The caller passes time.Now().Add(-DefaultGrace). A zero cutoff disables
// the protection and is only correct where nothing can be in flight.
//
// Sweep never reports success it has not verified: a body it fails to remove is
// an error, not a silent omission from the count.
func (s *Store) Sweep(vaultID string, live map[string]struct{}, cutoff time.Time) (deleted, spared int, err error) {
	root := s.VaultDir(vaultID)
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return 0, 0, nil
	}
	err = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			// An unreadable directory is not an empty one. Aborting leaves the
			// chunks in place; continuing would report a clean sweep of a tree
			// it could not read.
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, tmpPrefix) {
			// An in-progress Put, or the debris of a crashed one. Leaving it
			// costs a little disk; deleting it can pull the file out from under
			// a live upload.
			return nil
		}
		if !ValidName(name) {
			// Not something this package wrote. Report it rather than deleting
			// it: an unexplained file in the blob tree is evidence.
			return fmt.Errorf("unexpected file in chunk store: %s", p)
		}
		if _, keep := live[name]; keep {
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			// The body was there a moment ago and now cannot be described.
			// Deleting on the strength of a failed stat is exactly rule 2.
			return statErr
		}
		if !info.ModTime().Before(cutoff) {
			spared++
			return nil
		}
		if rmErr := os.Remove(p); rmErr != nil {
			return rmErr
		}
		deleted++
		return nil
	})
	return deleted, spared, err
}

// CountBodies counts the chunk files this store holds, across every vault.
//
// It exists so a backup can report how many bodies are either side of it. A
// backup is expected to hold fewer, because it holds what committed entries
// reference and the source may also hold bodies from a push that has not
// committed; reporting both numbers is what turns that from a discrepancy into
// an explanation.
func (s *Store) CountBodies() (int, error) {
	n := 0
	err := filepath.WalkDir(s.dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), tmpPrefix) {
			return nil
		}
		n++
		return nil
	})
	if os.IsNotExist(err) {
		return 0, nil
	}
	return n, err
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
