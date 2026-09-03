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
