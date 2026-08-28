# Trade-offs

Every decision here costs something. This is what, and against what.

`docs/vs-obsidian-sync.md` compares behaviour with Obsidian Sync. This one is
about design, and about the two other self-hosted projects worth comparing with:
[Sync Engine](https://github.com/hesprs/sync-engine) and
[Fast Note Sync](https://github.com/haierkeys/obsidian-fast-note-sync). Both are
good, both are further along in ways named below, and reading them found real
defects here.

---

## Chunks and deduplication, against streaming encryption

**Basalt** splits a file with a rolling hash, seals each chunk, and names it by
the hash of its ciphertext. Sealing is deterministic, so the same content always
produces the same ciphertext and the server recognises a chunk it already holds
without holding a key. An edit to a 2 MiB note costs about 500 bytes.

**Sync Engine** encrypts as a stream, with a per-file random salt and the chunk
index as the nonce. Conventional and conservative. It never holds a whole file,
and it cannot deduplicate: the same content in two files encrypts differently by
design.

| | Basalt | Streaming, per-file salt |
|---|---|---|
| Edit to a large note | one chunk | the file |
| Same content twice | stored once | stored twice |
| Memory for a large file | the file plus one chunk | one chunk |
| Nonce reuse risk | 96-bit synthetic, birthday bound at 2^48 chunks | none, the nonce is a counter |
| What the server learns | that two chunks are identical | nothing |

The cost of our side is real. Deduplication *requires* that identical plaintext
produce identical ciphertext, so the server can tell that two chunks match. That
is not a leak being tolerated, it is the mechanism, and a design that refuses it
cannot dedupe. Ours also has to know every chunk name before it can send
anything, so it cannot stream a file it has not finished reading.

## Refusing a merge, against merging better

Both projects three-way merge text. Neither overwrites silently.

**Sync Engine** uses a real diff3 built on the O(NP) algorithm, and splits a
document into regions first: a fenced code block or a maths block merges
line-wise, prose merges token-wise.

**Basalt** applies diff-match-patch patches and then makes four checks the
library does not: do the changed regions overlap, does merging both ways round
agree, did every hunk apply, did every insertion survive. Those checks exist
because the matcher is fuzzy and will place a hunk somewhere that merely looks
right.

Theirs is the more principled tool. Ours is character-granular, which is finer
than lines, and that is sometimes better: two devices changing different
arguments of `compute(1, 2)` merge to `compute(10, 20)` here, where a line-wise
merge conflicts.

And sometimes worse, measured rather than supposed. One device re-indents a
Python block, another appends a line to it, and this merges both:

```
if x:
        do()
        more()
    extra()
```

Nothing was lost, nothing overlapped, both directions agree, and the code no
longer runs. Their region splitter would not do that. Refusing every concurrent
edit inside a code fence would fix it and would also refuse the three cases
above that merge correctly, which is the worse trade, so it stands as a known
limit rather than a fixed one.

## One backend, against many

They support WebDAV, S3, Google Drive and a module system. Basalt supports one
purpose-built server and refuses the rest.

Theirs works with storage somebody already has. Ours needs a binary running
somewhere, and in exchange the server is not a dumb store: it holds every
version, it can be asked what was deleted, it verifies itself, and it can answer
"do you already have this chunk", which is what makes deduplication possible at
all. None of that fits behind a filesystem interface.

That is also the answer to whether Basalt should be a module for their engine.
It could not be. A module is a storage backend, and everything above lives on
the other side of that line.

## One secret, against a passphrase

Basalt has one root secret, 160 random bits, from which the content, path and
auth keys are all derived. There is no password, so there is nothing to stretch
and nothing to guess. Losing the pairing string loses the vault.

Sync Engine derives from a password with argon2id, 32 MiB and three passes,
which is the right way to accept a password. It can be remembered; it can also
be weak.

Basalt had a PBKDF2 path written and reachable from nothing. It was removed
rather than wired up, because a second and weaker way into a vault is not
something to add one commit after making the vault have exactly one secret.

## Refusing, against resolving

Where two devices disagree about what a path is, or a file cannot be placed,
Basalt reports it and touches nothing. A file here and a folder of the same name
there is named and left for a person; a note whose parent is a file elsewhere is
reported every pass until somebody renames one of them.

The cost is that somebody has to act. The alternative is renaming a file to make
room for a folder, and only they know which they meant.

## Scope refused on purpose

No peer to peer, no teams, no plugin or settings sync, no filters, no settings
screen, no web UI. Each one is defensible and each one doubles something.
`docs/philosophy.md` has the reasoning; the short version is that this is for one
person's devices on a private network and being sure matters more than being
general.

---

## Where the others are ahead

Said plainly, because a comparison that only runs one way is an advertisement.

- **Mobile.** Both run on phones. Basalt has never been installed on one.
- **Field testing.** 351 and 2890 stars against a plugin that has run in a real
  vault once, for minutes.
- **Backends.** They work with storage you already pay for.
- **Merging.** Their region-aware diff3 handles the code-block case above.
- **Reach.** They are installable from Obsidian's community list.

## What reading them changed here

- The headless client called `rm` where the Obsidian adapter trashed, which is
  their issue 232 word for word, and it was destroying files.
- Their benchmark vault shape, borrowed: many small notes, some medium, a few
  large, folders several deep. Half the large ones incompressible here, because
  prose is what hid a chunk-size defect for months.
- Correctness reported next to speed, which is their idea and a good one.
- A parse check on merged JSON, for canvas files. It turned out every shape that
  would break one is already refused by an existing check, which is worth
  knowing and is why the check is documented as unreached.
