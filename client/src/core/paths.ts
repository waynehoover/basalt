/**
 * Which paths never sync, decided once for both shells and both directions.
 *
 * Each vault had its own list and its own way of consulting it, and the two
 * directions disagreed inside each one. The headless client refused an
 * ignored name only as the first segment on the way in and skipped it at
 * every depth on the way out; the plugin listed from Obsidian's index, which
 * omits every dot-prefixed path, and refused only five names on the way in. In
 * both, a peer could name a path this device would write and then never list,
 * and a path written and never listed is reported deleted on the next pass.
 * The peer then deletes its copy, on the word of a device that never had it.
 *
 * So one rule, here, and it is deliberately broader than a list: any segment
 * starting with a dot is never synced. That is what Obsidian itself does, it
 * covers every name that was on the lists (`.obsidian`, `.basalt`, `.trash`,
 * `.git`, `.DS_Store`), and it is the same answer whichever shell is asking and
 * whichever way the path is travelling. A shell adds what only it knows: the
 * headless client's `node_modules`, and a config folder somebody renamed to
 * something without a dot.
 */

/**
 * Whether any segment of a vault-relative path is one that never syncs.
 *
 * `extra` is the shell's own additions. The path is expected with forward
 * slashes, which is how every path travels and how both vaults report them.
 */
export function isNeverSynced(relPath: string, extra: ReadonlySet<string>): boolean {
  for (const part of relPath.split("/")) {
    if (part.startsWith(".") && part !== "." && part !== "..") return true;
    if (extra.has(part)) return true;
  }
  return false;
}

/**
 * A path split at its extension, so a numbered or labelled variant of it keeps
 * the extension on the end where it belongs.
 *
 * Four callers name a file beside another one: the conflict copy, the restored
 * copy, `firstFreeName` and the trash. All four wrote this split out, twice
 * character for character, and the copies disagreed about one case: whether a
 * dot at the very start of a name is an extension.
 *
 * It is not, and that is the behaviour here. Reading `.gitignore` as an empty
 * stem and a `.gitignore` extension makes the variant of it ` 2.gitignore`,
 * which has no name left in it at all; reading it as a name with no extension
 * makes `.gitignore 2`, which is the file it came from with a number after it.
 * Nothing dot-prefixed reaches these callers today, because `isNeverSynced`
 * refuses every dot segment in both directions, so the choice costs nothing
 * now and is the one that stays right if that ever changes.
 *
 * A dot in a folder name is not an extension either: the split is on the last
 * dot after the last slash.
 */
export function splitName(path: string): { stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  // `slash + 1` rather than `slash` is the whole of the leading-dot rule: at
  // exactly `slash + 1` the dot is the first character of the name.
  if (dot <= slash + 1) return { stem: path, ext: "" };
  return { stem: path.slice(0, dot), ext: path.slice(dot) };
}

/**
 * `base`, or the first alternative spelling of it that nothing is using.
 *
 * The one answer to "where does this go, without displacing what is already
 * there". Three callers asked it separately: the conflict copy and the
 * restored copy through here, the vault's trash with a hand-rolled loop, and
 * the plugin's staging name with a different one. They agreed on the part that
 * matters and differed on everything else, which is how one of them ends up
 * with a fix the others do not have.
 *
 * `taken` is the existence question, and it belongs to the caller because only
 * the caller knows what "already there" means: an entry in the vault, a name
 * on disk, or a name that cannot be looked at, which is not free.
 *
 * `nth` spells the nth alternative, counting from one, and defaults to the
 * conflict copy's " 2", " 3". The trash numbers in brackets and the plugin's
 * staging name is random rather than numbered, and both of those are the same
 * search with a different pen.
 *
 * Exported and tested on its own because it is the part that can be wrong: the
 * interesting cases are what happens when a name is taken, when several are,
 * and what a name with no extension does.
 */
export async function firstFreeName(
  base: string,
  taken: (path: string) => Promise<boolean>,
  nth: (n: number) => string = numbered(base),
): Promise<string> {
  if (!(await taken(base))) return base;
  for (let n = 1; n < 1000; n++) {
    const candidate = nth(n);
    if (!(await taken(candidate))) return candidate;
  }
  // A thousand of these beside one note is not a state worth inventing a name
  // for, and inventing one silently is how the thousand-and-first overwrites
  // something.
  throw new Error(`cannot find an unused name beside ${base}`);
}

/** " 2", " 3", and so on, with the extension kept on the end. */
function numbered(base: string): (n: number) => string {
  const { stem, ext } = splitName(base);
  return (n) => `${stem} ${n + 1}${ext}`;
}

/**
 * A path as this project spells it: one name, one spelling, always NFC.
 *
 * Canonical equivalence is not a choice a person makes. `café.md` written on a
 * Mac and `café.md` written anywhere else are the same name by definition, and
 * the bytes differ. Both vaults report NFC and normalise what they are handed,
 * so NFC is the one keyspace there is; a path off the wire spelled otherwise
 * has to join it before it is used as an identity, or a device holds one file
 * and believes in two (C41).
 *
 * Here rather than in the engine because both shells need the same answer: the
 * engine folds what arrives, and the headless vault folds what the disk hands
 * it. Two copies of this rule is how they come to disagree.
 */
export function canonicalSpelling(path: string): string {
  return path.normalize("NFC");
}

/**
 * A path as a filesystem that folds case and normalisation would file it.
 *
 * Not the same question as string equality, and the difference loses notes.
 * `Note.md` and `note.md` are two paths on the server and one file on macOS or
 * Windows; so are one name in NFC and the same name in NFD. A pass that writes
 * one and deletes the other deletes what it just wrote.
 *
 * This is the fallback answer, used wherever the platform itself will not say.
 * A vault that can ask the filesystem answers through `canonical` or
 * `sameFile` instead, and should, because only the filesystem actually knows.
 * Folding here errs towards calling two paths one file, which keeps a note
 * rather than removing one, and that is the side to be wrong on.
 *
 * One function because the rule was written out at six sites, and two of them
 * deciding differently is two notes that turn into one.
 */
export function foldPath(path: string): string {
  return canonicalSpelling(path).toLowerCase();
}

/** Whether two paths would be one file wherever the platform will not say. */
export function foldsTogether(a: string, b: string): boolean {
  return foldPath(a) === foldPath(b);
}

/**
 * A name with every character a terminal cannot distinguish spelled out.
 *
 * The refusal that names two spellings of one name is the one refusal that
 * waits on a person, and it used to print them with `JSON.stringify`, which
 * escapes quotes and control characters and leaves everything else alone. So
 * `café.md` in NFC and `café.md` in NFD came out as two identical strings and
 * the message said "rename one of them" while showing the same name twice.
 * A person cannot act on that, and this is exactly the case where they have to
 * (paths.test.ts, "separates the two normal forms of one name";
 * cli/vault-spelling.test.ts, "spells both of them out").
 *
 * Printable ASCII is left as it is, because a name that is all ASCII reads
 * best as itself and cannot be in this trouble anyway. Everything else becomes
 * `\u{...}`, which is what makes one combining acute visibly different from
 * one precomposed é.
 */
export function spellOut(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    out += code >= 0x20 && code < 0x7f ? ch : `\\u{${code.toString(16)}}`;
  }
  return out;
}

/**
 * A refusal to write under a name this shell never syncs, with the code the
 * engine reads it by.
 *
 * The engine classifies a failure by its code and had none for this one, so
 * an inbound path under a folder this device ignores was filed for retry and
 * retried on every pass for ever, each time exiting 1 (C29). The code says
 * it is a fact about the path.
 *
 * Here rather than in each shell because the string is the interface: the
 * engine reads `neversync` and nothing else, so a shell that spelled it
 * differently would have its impossible write retried for ever while the
 * other shell gave up correctly.
 */
export function neverSync(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = "neversync";
  return err;
}

/**
 * A refusal to write under a name this device has been told to leave alone,
 * with the code the engine reads it by.
 *
 * Its own code because the two refusals mean opposite things to whoever reads
 * the exit status (R2). A path that cannot work here, such as one under a
 * dot-prefixed name this client would write and never list again, is a
 * failure. A path refused because somebody passed `--ignore` for it is the
 * configuration doing what it was asked, and counting it as a failure made
 * every later sync of that vault exit 1 for ever: a cron job alerting until
 * the end of time about a folder its owner chose not to sync.
 */
export function ignoredHereError(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = "ignored";
  return err;
}

/**
 * Whether the only thing keeping a path out of this vault is the shell's own
 * ignore list.
 *
 * The dot rule wins wherever it applies: a dot segment is refused by both
 * clients in both directions, and no ignore list makes that a choice. What is
 * left is a name somebody named, which is what `--ignore` is.
 */
export function ignoredHere(relPath: string, extra: ReadonlySet<string>): boolean {
  let byList = false;
  for (const part of relPath.split("/")) {
    if (part.startsWith(".") && part !== "." && part !== "..") return false;
    if (extra.has(part)) byList = true;
  }
  return byList;
}

/**
 * The config folder as a single name at the vault root, or a refusal.
 *
 * Obsidian's config folder is one folder at the root, and if it were ever
 * anything else then quietly ignoring the wrong thing is how a vault's
 * settings get uploaded: that folder holds the plugin's `data.json`, and
 * `data.json` holds this device's credential and the vault's data key. Not the
 * root, since protocol 4, but the data key opens every note either way.
 */
export function configFolderName(configDir: string): string {
  const name = configDir.replace(/^\/+|\/+$/g, "");
  if (name === "" || name.includes("/")) {
    throw new Error(
      `refusing to sync: the config folder ${JSON.stringify(configDir)} is not a plain name`,
    );
  }
  return name;
}
