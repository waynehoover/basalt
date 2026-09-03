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
  return path.normalize("NFC").toLowerCase();
}

/** Whether two paths would be one file wherever the platform will not say. */
export function foldsTogether(a: string, b: string): boolean {
  return foldPath(a) === foldPath(b);
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
 * The config folder as a single name at the vault root, or a refusal.
 *
 * Obsidian's config folder is one folder at the root, and if it were ever
 * anything else then quietly ignoring the wrong thing is how a vault's
 * settings get uploaded: that folder holds the plugin's `data.json`, and
 * `data.json` holds the root secret.
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
