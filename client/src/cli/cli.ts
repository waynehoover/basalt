/**
 * The headless client.
 *
 * The same engine the plugin runs, with the filesystem in place of Obsidian's
 * Vault API. Nothing in here decides anything about syncing; it reads arguments,
 * assembles the same four objects the plugin assembles, and prints what came
 * back. If this file ever grows a sync decision, it is in the wrong file.
 *
 * ## Shape
 *
 * `run` takes an argv and an output pair and returns an exit code, so a test can
 * drive the whole CLI against a real server and real directories without a
 * subprocess. `bin.ts` is the four lines that connect it to a process.
 *
 * ## What it prints
 *
 * Rule 7 of docs/design.md: a status that cannot distinguish the cases it
 * collapses is not a status. So a sync never reports a total. It reports what
 * was uploaded, downloaded, merged, conflicted and skipped, separately, and it
 * exits non-zero when anything was skipped for good, because a file that will
 * never sync is not a successful run.
 */

import { hostname } from "node:os";
import { resolve } from "node:path";

import { deriveRootKeys, generateSecret, randomBytes } from "../core/crypto.ts";
import {
  Client,
  credentialCandidates,
  credentialsFor,
  rebaseCursors,
  redeemInvite,
  refuseUnlessAhead,
  runForever,
  settledConfig,
  wrappedForClaim,
  type ClientOptions,
} from "../core/client.ts";
import { REJOIN_ADVICE, type SyncReport } from "../core/engine.ts";
import {
  formatPairing,
  isInvite,
  normaliseUrl,
  parseInvite,
  parsePairing,
  parseSetup,
  type Pairing,
} from "../core/pairing.ts";

export { normaliseUrl };
import { DEFAULT_CONFIG_DIR, JsonIndexStore, NodeVault, configFolderName } from "./vault.ts";
import {
  configPath,
  indexPath,
  loadConfig,
  orphanedIndex,
  removeIndex,
  removeState,
  saveConfig,
  type Config,
} from "./config.ts";
import { lockVault } from "./lock.ts";
import { ConnectionError, ProtocolError } from "../core/transport.ts";
import { validateStoredState } from "../core/stored-state.ts";

/**
 * The client's release, written in by the build.
 *
 * esbuild defines it from package.json when it makes `dist/basalt.mjs`, so the
 * one file somebody installs says which release it is and the version matrix
 * in docs/server.md has a number to name. Under the test runner nothing
 * defines it and the fallback says so rather than inventing a number.
 */
declare const __BASALT_VERSION__: string | undefined;
export const VERSION: string =
  typeof __BASALT_VERSION__ === "string" ? __BASALT_VERSION__ : "development";

/** Where output goes, so a test can read it. */
export interface Console {
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = `basalt: self-hosted sync for Obsidian

  basalt init HOST:PORT#TOKEN               start a new vault, with the line the server printed
  basalt invite                             print a single-use invite for another device
  basalt pair INVITE                        join a vault with an invite, or with its recovery key
  basalt sync                               sync once and exit
  basalt sync --watch                       sync, then keep syncing
  basalt status                             what this device thinks the state is
  basalt deleted                            notes the server still has and you do not
  basalt history PATH                       every version the server holds of one note
  basalt restore PATH                       put a note back, newest version first
  basalt recovery-key                       reprint the recovery key, which is the vault itself
  basalt rotate                             give the vault a new secret, keeping its history
  basalt rebase --backup-taken              rejoin a server restored from an older backup
  basalt unlink                             forget the pairing, keep the notes
  basalt --version                          which release this is

Options
  --dir DIR        the vault (default: the current directory)
  --device NAME    what this device calls itself (default: its hostname and four random characters)
  --vault-id ID    which vault on the server (default: default)
  --json           machine-readable output
  --timeout MS     how long to wait on the server (default: 30000)
  --ttl DURATION   how long an invite lasts, like 10m or 1h (default: 10m, at most 1h)
  --uid N          restore one exact version, from basalt history
  --to PATH        restore somewhere other than where it came from
  --limit N        how many versions history or deleted shows (default: 20, or all deletions)
  --config-dir DIR Obsidian's config folder, if it is not .obsidian
  --ignore NAME    a folder or file name never to sync, at any depth, repeatable; local to this
                   device. A path another device syncs and this one ignores is reported as
                   ignored rather than failed, and does not affect the exit code
`;

export async function run(argv: readonly string[], io: Console): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(String((err as Error).message));
    return 2;
  }

  if (args.version) {
    io.out(args.json ? JSON.stringify({ ok: true, version: VERSION }) : VERSION);
    return 0;
  }
  if (args.help || args.command === undefined) {
    io.out(USAGE);
    return args.command === undefined && !args.help ? 2 : 0;
  }

  try {
    refuseExtras(args);
    // Anything that changes the vault, its config or its index takes the
    // vault's lock for as long as it runs. Reading commands do not: they
    // load the index once and talk to the server, and holding a lock for
    // them would make `status` refuse while a watcher is running, which is
    // exactly when somebody asks.
    switch (args.command) {
      case "init":
        return await locked(args, () => cmdInit(args, io));
      case "pair":
        return await locked(args, () => cmdPair(args, io));
      case "invite":
        return await cmdInvite(args, io);
      case "recovery-key":
        return await cmdRecoveryKey(args, io);
      case "rotate":
        return await locked(args, () => cmdRotate(args, io));
      case "rebase":
        return await locked(args, () => cmdRebase(args, io));
      case "sync":
        return await locked(args, () => cmdSync(args, io));
      case "status":
        return await cmdStatus(args, io);
      case "deleted":
        return await cmdDeleted(args, io);
      case "history":
        return await cmdHistory(args, io);
      case "restore":
        return await locked(args, () => cmdRestore(args, io));
      case "unlink":
        return await locked(args, () => cmdUnlink(args, io));
      default:
        io.err(`no such command: ${args.command}`);
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    // Every failure arrives here as a sentence rather than a stack. A stack
    // is for a bug in this program; the common failures are a server that is
    // not running and a string that was pasted wrong, and those deserve to
    // be readable.
    const message = withRecovery(err);
    if (args.json) io.out(JSON.stringify({ ok: false, error: message }));
    else io.err(`basalt: ${message}`);
    return 1;
  }
}

/**
 * A failure as a sentence, with the way out of it when there is a known one.
 *
 * The server's `cursor` refusal is exact about what is wrong and says nothing
 * about what to do, and it cannot: the recovery is a client command the server
 * has never heard of. The engine's own copy of the refusal names it, and this
 * puts the same words behind the server's, so a restored backup reads the same
 * whichever end noticed. Error strings are the whole UI of a device that has
 * stopped.
 */
function withRecovery(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ProtocolError && err.code === "cursor" && !message.includes(REJOIN_ADVICE)) {
    return `${message}. ${REJOIN_ADVICE}`;
  }
  return message;
}

/**
 * How many positional arguments each command takes. Everything else takes none.
 *
 * `basalt sync ~/vault` used to be accepted and the path silently ignored, so
 * it synced the current directory and said it had synced: a wrong vault
 * reported as a right one, which is rule 7. The vault is chosen with `--dir`,
 * and the mistake is common enough that the refusal says so.
 */
const POSITIONALS: Record<string, number> = {
  init: 1,
  pair: 1,
  history: 1,
  restore: 1,
};

function refuseExtras(args: Args): void {
  const takes = POSITIONALS[args.command ?? ""] ?? 0;
  if (args.rest.length <= takes) return;
  const extra = args.rest.slice(takes);
  const what = extra.map((e) => JSON.stringify(e)).join(", ");
  throw new Error(
    takes === 0
      ? `${args.command} takes no arguments, so ${what} was not used. The vault is chosen with --dir.`
      : `${args.command} takes one argument, so ${what} was not used.`,
  );
}

/* ---------------------------------------------------------------- *
 * Commands
 * ---------------------------------------------------------------- */

/** Runs a command that changes the vault under the vault's lock. */
async function locked(args: Args, command: () => Promise<number>): Promise<number> {
  const release = await lockVault(args.dir, `basalt ${args.command ?? ""}`.trim());
  try {
    return await command();
  } finally {
    // Best effort. A lock that cannot be removed names a process that has
    // exited, and the next holder recognises that and takes it over; an
    // error here would only hide the command's own outcome.
    await release().catch(() => {});
  }
}

async function cmdInit(args: Args, io: Console): Promise<number> {
  // One argument, the line the server printed, is the normal way. The two
  // flags are kept for anyone who split it by hand when that was the only way.
  let server = args.server;
  let token = args.token;
  if (args.rest[0] !== undefined) {
    if (server !== undefined || token !== undefined)
      throw new Error("init takes the server's line or --server and --token, not both");
    ({ url: server, token } = parseSetup(args.rest[0]));
  }
  if (!server || !token)
    throw new Error(
      "init needs the line the server printed on its first run, like host:3003#TOKEN",
    );
  await refuseIfPaired(args.dir);

  const secret = generateSecret();
  const config: Config = {
    url: normaliseUrl(server),
    vaultId: args.vaultId,
    device: deviceNameFor(args),
    secret,
    // The server's first-run token, kept only until this device has claimed
    // the vault with it. What authenticates afterwards is derived from the
    // secret above, so there is nothing else to hold on to.
    bootstrap: token,
    // The vault's data key, made here and once. It is written down before the
    // claim goes out for the same reason the root is: a claim that commits
    // with its reply lost must be retried with the key it already offered,
    // not with a second candidate.
    claimWrapped: await wrappedForClaim(await deriveRootKeys(secret)),
  };
  await saveConfig(args.dir, config);
  // Read back before the claim. The claim binds the server to the key this
  // secret derives, for good, so the secret has to be provably on disk
  // first: not written, not renamed, but readable and decoding to itself.
  const back = await loadConfig(args.dir);
  if (!back || Buffer.compare(back.secret, config.secret) !== 0 || back.url !== config.url) {
    throw new Error(`${configPath(args.dir)} did not read back as what was just written`);
  }

  // Claim the vault now, rather than leaving it to whenever this device first
  // syncs.
  //
  // init used to write a config and contact nothing, so it reported a paired
  // vault that the server had never heard of. A second device pairing with
  // the string printed below and syncing before this one ever did was refused
  // with "not authorised for this vault": true, unhelpful, and indis-
  // tinguishable from a bad key. `open` sends the bootstrap token, which is
  // what claims it, and spends the token on success.
  //
  // The config is kept if this throws. The claim may have committed with the
  // reply lost, and a config discarded in that case is a vault that nothing
  // will ever open again: the secret in it is the only copy.
  const claimed = await open(config, args, io);
  await claimed.close();

  // Shown once, here, and called what it is. Adding a device is `basalt
  // invite`, which never shows this; what this is for is the day every
  // device is lost, and the way to have it then is to have written it down.
  const recoveryKey = formatPairing(config);
  if (args.json) {
    io.out(JSON.stringify({ ok: true, paired: args.dir, device: config.device, recoveryKey }));
  } else {
    io.out(`Started the vault. ${args.dir} is paired as "${config.device}".`);
    io.out("");
    io.out("This is the vault's recovery key. Write it down and keep it offline:");
    io.out("");
    io.out(`  ${recoveryKey}`);
    io.out("");
    io.out("It is the only way back into the vault if every device is lost, and anyone");
    io.out("who has it has the vault. The server has never seen it and cannot reissue it.");
    io.out("To add another device, run basalt invite here; the key is not needed for that.");
  }
  return 0;
}

/**
 * This device's name: what was typed, or the hostname with a short random
 * tail.
 *
 * Two fresh laptops are both called `macbook`, and the device name is what
 * tells two conflict copies apart. The copies were never lost, since
 * `firstFreeName` numbers them, but a name that says which device wrote it is
 * the point of having one in the filename. The tail is chosen at pairing and
 * kept in the config, so it never changes under a running vault.
 */
function deviceNameFor(args: Args): string {
  if (args.deviceGiven) return args.device;
  const tail = [...randomBytes(2)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${args.device}-${tail}`;
}

/**
 * Refuses to pair a vault that is paired, or that still holds an index.
 *
 * Re-pairing over a paired vault would replace the root secret, and every
 * note already on the server would become undecryptable here. An index with
 * no config beside it is an unlink that did not finish, and pairing over it
 * would load an index describing another secret's sync.
 */
async function refuseIfPaired(dir: string): Promise<void> {
  if (await loadConfig(dir)) {
    throw new Error(`${dir} is already paired. Use unlink first if that is really what you want.`);
  }
  if (await orphanedIndex(dir)) {
    throw new Error(
      `${dir} is not paired but still holds an index at ${indexPath(dir)}, ` +
        `left by an unlink that did not finish. Run basalt unlink to clear it, then pair again.`,
    );
  }
}

/**
 * Joins a vault, with an invite or with its recovery key.
 *
 * The server is reached before "paired" is printed, either way (C39, I13).
 * A pairing string with a wrong address, or a secret the server does not
 * know, used to be saved and announced as paired, and the first sign of it
 * was the first sync failing later. Now the handshake is the test.
 *
 * The two paths differ in when the config is written. An invite is spent
 * the moment the server answers, so what it handed over goes to disk first,
 * durably, and only then does this device connect as a device: a crash
 * between the two would otherwise burn the invite and keep nothing. A
 * recovery key is not consumed by looking, so the connection is tried first
 * and a string that fails it leaves nothing behind.
 */
async function cmdPair(args: Args, io: Console): Promise<number> {
  const given = args.rest[0];
  if (!given) throw new Error("pair needs the invite or recovery key another device printed");
  await refuseIfPaired(args.dir);
  const device = deviceNameFor(args);

  let config: Config;
  if (isInvite(given)) {
    const invite = parseInvite(given);
    const redeemed = await redeemInvite(invite, device, { timeoutMs: args.timeout });
    config = { url: invite.url, vaultId: invite.vaultId, device, secret: redeemed.secret };
    await saveConfig(args.dir, config);
    await mustReadBack(args.dir, config);
    const client = await open(config, args, io);
    await client.close();
  } else {
    const pairing: Pairing = parsePairing(given);
    config = { ...pairing, device };
    const probe = await open(config, args, io, false);
    await probe.close();
    await saveConfig(args.dir, config);
    await mustReadBack(args.dir, config);
  }

  if (args.json)
    io.out(JSON.stringify({ ok: true, paired: args.dir, device: config.device, url: config.url }));
  else io.out(`Paired ${args.dir} with ${config.url} as "${config.device}". Run basalt sync.`);
  return 0;
}

/**
 * Proves the config is on disk and decodes to itself before anything relies
 * on it. Not written, not renamed, but readable: the secret in it is the only
 * copy this device has.
 */
async function mustReadBack(dir: string, config: Config): Promise<void> {
  const back = await loadConfig(dir);
  if (!back || Buffer.compare(back.secret, config.secret) !== 0 || back.url !== config.url) {
    throw new Error(`${configPath(dir)} did not read back as what was just written`);
  }
  // A rotation stages its new secret here and then sends the request. If this
  // is not on disk, nothing is: the whole point of writing first is that the
  // secret exists somewhere other than in this process before the server could
  // possibly have committed it.
  if (config.pending) {
    if (!back.pending || Buffer.compare(back.pending.secret, config.pending.secret) !== 0) {
      throw new Error(`${configPath(dir)} did not read back with the rotation's new secret`);
    }
  }
}

/**
 * Prints a single-use invite for another device.
 *
 * The root secret goes to the server sealed under a key that stays in the
 * string, for ten minutes unless asked otherwise, and the string works once.
 * Nothing about the vault is shown: the string is where to ask, which vault,
 * and how to open what is handed back.
 */
async function cmdInvite(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, false);
  let issued: { invite: string; expiresAt: number };
  try {
    issued = await client.invite(args.ttlMs);
  } finally {
    await client.close();
  }
  if (args.json) {
    io.out(JSON.stringify({ ok: true, invite: issued.invite, expiresAt: issued.expiresAt }));
    return 0;
  }
  io.out(issued.invite);
  io.out("");
  io.out(`Paste it into basalt pair, or into the Basalt panel, on the new device.`);
  io.out(`It works once and expires at ${when(issued.expiresAt)}.`);
  return 0;
}

/**
 * Reprints the recovery key, which is the whole vault.
 *
 * Behind one line of warning rather than a prompt, because this is what
 * somebody runs to write the key down again, and a prompt would be typed
 * through. Adding a device is not what this is for and the line says so.
 */
async function cmdRecoveryKey(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  const recoveryKey = formatPairing(config);
  // A rotation that was sent and never answered leaves two keys that could be
  // the vault's, and this command cannot tell which without connecting. Both
  // are printed rather than one guessed at: printing only the old one, when the
  // rotation did commit, is a recovery key that opens nothing, written down by
  // somebody who now believes they have one.
  const pendingKey = config.pending
    ? formatPairing({ ...config, secret: config.pending.secret })
    : undefined;
  if (args.json) {
    io.out(
      JSON.stringify({
        ok: true,
        recoveryKey,
        ...(pendingKey !== undefined ? { pendingRecoveryKey: pendingKey } : {}),
      }),
    );
    return 0;
  }
  io.err(
    "This is the vault's recovery key. Anyone who has it has the vault, past and future. " +
      "To add a device, use basalt invite instead.",
  );
  io.out(recoveryKey);
  if (pendingKey !== undefined) {
    io.err(
      "A rotation from this device was never answered, so the vault may already have a new " +
        "secret. Keep both keys until basalt sync here has settled which it is.",
    );
    io.out(pendingKey);
  }
  return 0;
}

/**
 * Gives the vault a new root secret and keeps its history.
 *
 * Every vault can do this, because every vault's content is sealed under a
 * data key that the root only wraps. The new secret is saved before the new
 * recovery key is printed, and printed regardless if the save fails, because
 * at that point it is the only thing that opens the vault.
 */
async function cmdRotate(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io);
  const secret = generateSecret();
  const recoveryKey = formatPairing({ ...config, secret });
  // The data key re-wrapped under the new root, which is what the server will
  // hold and therefore what this device must pin from now on. Captured on the
  // way past, because the same value has to reach the staged config and the
  // promoted one.
  let rewrapped: string | undefined;
  try {
    // Written down before it is sent, and both secrets are in the file while
    // the request is in flight. The server commits, closes every other
    // session, and only then answers, so a connection that drops in between
    // leaves a vault whose new root this process is the only holder of. With
    // the pending secret on disk the next run tries it first and falls back to
    // the old one, and either way the vault opens.
    await client.rotate(secret, async (wrapped) => {
      rewrapped = wrapped;
      const staged: Config = { ...config, pending: { secret, wrapped } };
      await saveConfig(args.dir, staged);
      await mustReadBack(args.dir, staged);
    });
  } catch (err) {
    if (err instanceof ProtocolError && err.code === "rotated") {
      // Answered, and refused: another device rotated first, so nothing here
      // committed and the staged secret is not the vault's. This device's own
      // secret went with the same rotation, so there is nothing to retry until
      // it has the new string.
      await saveConfig(args.dir, config).catch(() => undefined);
      await client.close();
      io.err(
        "basalt: the vault was rotated by another device, so this rotation was refused. " +
          "Reconnect and try again: this device's secret was retired by that rotation too, " +
          "so pair it again with the new recovery key or an invite from the device that rotated.",
      );
      return 1;
    }
    // The reply never came, and there is no way from here to tell a rotation
    // that committed from one that did not. Both are survivable and neither is
    // survivable quietly: this key is the vault if it committed.
    io.err(`basalt: the rotation was not answered: ${(err as Error).message}`);
    io.err("It may have committed. Write this recovery key down now, in place of the old one:");
    io.err(`  ${recoveryKey}`);
    io.err("Then run basalt sync here, which tries the new secret first and settles which it is.");
    return 1;
  } finally {
    await client.close();
  }
  const next: Config = { ...config, secret, ...(rewrapped ? { wrapped: rewrapped } : {}) };
  delete (next as { bootstrap?: string }).bootstrap;
  delete (next as { claimWrapped?: string }).claimWrapped;
  delete (next as { pending?: unknown }).pending;
  try {
    await saveConfig(args.dir, next);
    await mustReadBack(args.dir, next);
  } catch (err) {
    // The server has the new secret and this file does not. Said as loudly
    // as the CLI can say anything, with the key, because the key is now
    // the only way in.
    io.err(
      `basalt: the vault was rotated but the new secret could not be saved: ${(err as Error).message}`,
    );
    io.err("Write this recovery key down now and pair this vault again with it:");
    io.err(`  ${recoveryKey}`);
    return 1;
  }
  if (args.json) {
    io.out(JSON.stringify({ ok: true, rotated: args.dir, recoveryKey }));
    return 0;
  }
  io.out("Rotated. The old recovery key and every old invite no longer open this vault.");
  io.out("");
  io.out("This is the new recovery key. Write it down in place of the old one:");
  io.out("");
  io.out(`  ${recoveryKey}`);
  io.out("");
  io.out(
    "Every other device has been disconnected. Add each one again with basalt invite from here.",
  );
  return 0;
}

/**
 * Rejoins a server that has lost history this device applied.
 *
 * A device ahead of the server is refused with `cursor`, and rightly: the
 * server is a restored backup or the wrong vault, and continuing would reissue
 * uids for different content. The one safe thing to do is to forget what this
 * device believed it had synced and start again from the server's cursor:
 * everything both sides hold identically is agreed, what only this device
 * holds goes up as new versions, and where the two disagree both are kept.
 * Nothing is deleted anywhere.
 *
 * Refused without `--backup-taken`, because the index this removes is the
 * only record of what this device had synced, and the server's own history
 * is what the person is about to add to.
 */
async function cmdRebase(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  // Both numbers from core, so the panel and this cannot disagree about where
  // the two ends are or about when a rebase is allowed.
  const at = await rebaseCursors(await clientOptions(config, args, io));
  const { local, server: serverCursor } = at;
  const say = (line: string) => {
    if (!args.json) io.out(line);
  };
  say(`local cursor   ${local}`);
  say(`server cursor  ${serverCursor}`);

  refuseUnlessAhead(at);
  if (!args.backupTaken) {
    throw new Error(
      `the server is at ${serverCursor} and this device has applied ${local}: the server has lost history. ` +
        `Take a backup of the server (basaltd backup) and of this vault, then run basalt rebase --backup-taken`,
    );
  }

  await removeIndex(args.dir);
  const client = await open(config, args, io);
  try {
    const report = await client.settle({ coalesceWrites: false });
    if (args.json) {
      io.out(JSON.stringify({ ok: true, localCursor: local, serverCursor, replayed: report }));
      return 0;
    }
    io.out("");
    io.out("Rebased onto the server's history:");
    report_(report, args, io, client.serverCursor);
    io.out(`Nothing was deleted. Where the two sides disagreed, both versions were kept.`);
    return exitCodeFor(report);
  } finally {
    await client.close();
  }
}

async function cmdSync(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  if (args.watch) return await watchForever(config, args, io);

  const client = await open(config, args, io);
  try {
    const report = await client.settle();
    report_(report, args, io, client.serverCursor);
    return exitCodeFor(report);
  } finally {
    await client.close();
  }
}

/**
 * What a one-shot sync exits with.
 *
 * A file that can never sync is not a successful run, whatever else worked,
 * and neither is one still failing when the pass gave up, nor one waiting on
 * a name that is a file here and a folder elsewhere (C33). Exiting zero over
 * any of those is how a broken vault stays broken quietly in somebody's cron,
 * and it is how a sync that lost its connection half way through once
 * reported that it had finished.
 *
 * `ignored` is deliberately not in that list (R2). A path another device
 * syncs and `--ignore` keeps out of this one is the configuration doing what
 * it was asked, and it never stops being true: counting it made one ignored
 * folder exit every future sync 1, which is a cron job alerting for ever
 * about a decision its owner made on purpose. It is printed on every run
 * instead.
 */
export function exitCodeFor(report: SyncReport): number {
  return report.skipped > 0 || report.retrying > 0 || report.blocked > 0 ? 1 : 0;
}

/**
 * Syncs, then keeps syncing.
 *
 * The reconnecting is `runForever` in core, because the plugin needs exactly the
 * same loop for exactly the same reasons. What is left here is what a shell
 * should own: deciding what to print.
 */
async function watchForever(config: Config, args: Args, io: Console): Promise<number> {
  let fatal: Error | undefined;
  await runForever(await clientOptions(config, args, io), {
    onSynced: (report, serverCursor) => {
      report_(report, args, io, serverCursor);
      if (!args.json) io.err("Watching for changes. Ctrl-C to stop.");
    },
    onDisconnected: (cause, retryIn) => {
      io.err(`Disconnected: ${cause.message}. Trying again in ${seconds(retryIn)}.`);
    },
    onUnreachable: (cause, retryIn) => {
      io.err(`Cannot reach the server: ${cause.message}. Trying again in ${seconds(retryIn)}.`);
    },
    onFatal: (cause) => {
      fatal = cause;
    },
  });
  if (fatal) {
    io.err(`basalt: ${withRecovery(fatal)}`);
    io.err("That will not fix itself by trying again.");
    return 1;
  }
  return 0;
}

async function cmdStatus(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  // Checked the way the engine checks it, so a status never reports numbers
  // read out of a file the next sync would refuse.
  const stored = validateStoredState(await new JsonIndexStore(indexPath(args.dir)).load());

  const local = {
    vault: args.dir,
    device: config.device,
    server: config.url,
    vaultId: config.vaultId,
    cursor: stored?.cursor ?? 0,
    tracked: stored ? Object.keys(stored.entries).length : 0,
    pending: stored?.pending.length ?? 0,
    // Local to this device, and printed so a divergence is visible: the
    // plugin ignores nothing beyond the dot rule and the config folder, and
    // a folder ignored here is one the phone uploads.
    ignore: [...args.ignore],
  };

  // Reachability is reported, never assumed. "up to date" from a client that
  // could not reach the server is the kind of status rule 7 is about.
  //
  // `refused` is the other half of that rule, and it used to be collapsed into
  // the same field (N3). A server that answers and will not have this device,
  // because it was restored from an older backup or because the credential is
  // no longer the vault's, is not a server that is down, and a cron job
  // keying on `reachable` read the two as one outage. Mirrors the plugin's
  // `offline.refused`.
  let server: {
    reachable: boolean;
    refused: boolean;
    cursor?: number;
    behind?: number;
    error?: string;
  };
  try {
    // The handshake and nothing after it. What is printed below is the
    // server's own cursor out of `ready`, and waiting for the backlog first
    // meant a device weeks behind unsealed all of it before saying a word.
    const client = await open(config, args, io, false, { waitForBacklog: false });
    // Signed, not clamped. Clamping at zero made a server behind its own
    // clients, which is a restored backup or the wrong vault, read exactly
    // like being up to date.
    server = {
      reachable: true,
      refused: false,
      cursor: client.serverCursor,
      behind: client.serverCursor - local.cursor,
    };
    await client.close();
  } catch (err) {
    // Only the transport failing means the server was not reached. Everything
    // else got an answer out of it: an `auth` refusal, or the cursor check
    // against a server that has lost history.
    const answered = !(err instanceof ConnectionError);
    server = { reachable: answered, refused: answered, error: (err as Error).message };
  }

  if (args.json) {
    io.out(JSON.stringify({ ok: true, ...local, server }));
    return server.reachable && !server.refused ? 0 : 1;
  }

  io.out(`vault    ${local.vault}`);
  io.out(`device   ${local.device}`);
  io.out(`server   ${local.server} (vault "${local.vaultId}")`);
  io.out(`tracked  ${local.tracked} files`);
  io.out(
    `ignore   ${local.ignore.length === 0 ? "nothing beyond the dot rule and the config folder" : local.ignore.join(", ")} (this device only)`,
  );
  // Both cursors, on their own lines, so "behind and nothing arriving" is
  // something a person can see rather than something the design says cannot
  // be detected (I11).
  io.out(`local cursor   ${local.cursor}`);
  if (server.cursor !== undefined) io.out(`server cursor  ${server.cursor}`);
  if (local.pending > 0) io.out(`pending  ${local.pending} files with work outstanding`);
  if (server.refused) {
    io.out(`state    the server is up and refused this device: ${server.error}`);
    return 1;
  }
  if (server.reachable) {
    // The cursor says what this device has seen, not what it has applied. A
    // path that is a file here and a folder elsewhere is applied by nobody and
    // never will be, and the cursor moves past it regardless, so the two facts
    // were printed on the same screen and only one of them was read. Rule 7:
    // "everything is here" cannot look like "everything except that".
    io.out(
      server.behind !== 0
        ? `state    ${server.behind} changes behind`
        : local.pending > 0
          ? `state    caught up with the server, with ${local.pending} still not applied here`
          : "state    up to date with the server",
    );
    return 0;
  }
  io.out(`state    cannot reach the server: ${server.error}`);
  return 1;
}

/* ---------------------------------------------------------------- *
 * Recovery
 * ---------------------------------------------------------------- */

/**
 * Notes the server still holds and this vault does not.
 *
 * The whole point of keeping every version is that this list exists. Until it
 * did, a deleted note was safe and unreachable, which is only half a promise.
 */
async function cmdDeleted(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, false);
  try {
    // Only a limit somebody typed. The default of 20 is history's, and
    // passing it here silently cut the deleted list to twenty while the
    // "older deletions" hint below stayed quiet, because the server had not
    // been asked for more.
    const gone = await client.deleted(args.limitGiven ? args.limit : undefined);
    if (args.json) {
      io.out(JSON.stringify({ ok: true, deleted: gone.notes, more: gone.more }));
      return 0;
    }
    if (gone.notes.length === 0) {
      io.out("Nothing has been deleted from this vault.");
      return 0;
    }
    let lost = 0;
    for (const v of gone.notes) {
      // Said per note rather than assumed for all of them. A purge keeps
      // only the newest version per path, which for a deleted note is the
      // deletion, so its content can be gone while it is still listed.
      const state = v.restorable === 0 ? "  (content purged)" : "";
      if (v.restorable === 0) lost++;
      io.out(`${when(v.mtime)}  ${v.device.padEnd(12)}  ${v.path}${state}`);
    }
    io.out("");
    const recoverable = gone.notes.length - lost;
    if (lost === 0) {
      io.out(`${recoverable} deleted, all still recoverable. basalt restore PATH brings one back.`);
    } else {
      io.out(
        `${gone.notes.length} deleted. ${recoverable} can be restored; ` +
          `${lost} had their history purged and cannot be.`,
      );
    }
    // Never a short list that looks complete. Somebody reading one and not
    // finding their note concludes it is gone.
    if (gone.more) io.out("There are older deletions than these. --limit N shows more.");
    return 0;
  } finally {
    await client.close();
  }
}

/**
 * The most versions the server will list in one answer.
 *
 * Its number, mirrored here so a larger request is capped and said to be,
 * rather than quietly answered with a different page size.
 */
const HISTORY_LIMIT_MAX = 500;

/** Every version of one note, newest first. */
async function cmdHistory(args: Args, io: Console): Promise<number> {
  const path = args.rest[0];
  if (!path) throw new Error("history needs the path of a note");
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, false);
  try {
    // Capped here rather than left to the server, which answers a limit over
    // its maximum with its *default* page of a hundred and no indication.
    // Somebody asking for six hundred versions and shown a hundred reads
    // the list as complete, in the one tool where a short list that looks
    // complete costs a note.
    const limit = Math.min(args.limit, HISTORY_LIMIT_MAX);
    const versions = await client.history(path, { limit });
    if (args.json) {
      io.out(JSON.stringify({ ok: true, path, versions, limit }));
      return 0;
    }
    if (versions.length === 0) {
      // The server cannot tell a path it never had from one whose history
      // was purged, so neither can this. Saying which would be a guess in
      // the one tool where a guess is least welcome.
      io.out(`The server holds no versions of ${path}.`);
      return 0;
    }
    for (const v of versions) {
      const what = v.deleted ? "deleted" : v.folder ? "folder" : `${bytes(v.size)}`;
      io.out(`${String(v.uid).padStart(7)}  ${when(v.mtime)}  ${v.device.padEnd(12)}  ${what}`);
    }
    io.out("");
    if (args.limit > limit) {
      io.out(
        `Showing the newest ${limit}: the server lists at most ${HISTORY_LIMIT_MAX} versions at a time, ` +
          `so --limit ${args.limit} was capped there.`,
      );
    }
    io.out("basalt restore PATH --uid N brings one of these back.");
    return 0;
  } finally {
    await client.close();
  }
}

/**
 * Puts a note back.
 *
 * Never overwrites. If something already occupies the path, the restored copy
 * lands beside it and both are reported: a recovery tool that can destroy the
 * thing you still have is worse than none.
 */
async function cmdRestore(args: Args, io: Console): Promise<number> {
  const path = args.rest[0];
  if (!path) throw new Error("restore needs the path of a note");
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io);
  try {
    let version;
    if (args.uid !== undefined) {
      version = await client.findVersion(path, (v) => v.uid === args.uid);
      if (!version) throw new Error(`the server has no version ${args.uid} of ${path}`);
      // Whether that version can be restored is Client.restore's to say,
      // and it says it. A second check here would be a duplicate that no
      // test could pin: remove either one and the other still refuses.
    } else {
      version = await client.newestContentVersion(path);
      if (!version)
        throw new Error(`the server holds no version of ${path} with any content in it`);
    }

    const done = await client.restore(version, args.to);
    // Sent straight away rather than left for the next sync. Somebody who
    // has just recovered a note should not have to know that it is only on
    // this device until something else happens.
    const report = await client.settle({ coalesceWrites: false });

    if (args.json) {
      // `restored` is already a counter on the report, so the path is `path`.
      io.out(
        JSON.stringify({
          ok: true,
          path: done.path,
          uid: version.uid,
          bytes: done.bytes,
          sync: report,
        }),
      );
      return exitCodeFor(report);
    }
    io.out(
      `Restored version ${version.uid} of ${path} (${bytes(done.bytes)}, from ${when(version.mtime)}).`,
    );
    if (done.path !== (args.to ?? path)) {
      io.out(`Written to ${done.path}, because something is already at ${args.to ?? path}.`);
    }
    if (report.uploaded > 0) io.out("Sent to the server, so your other devices will pick it up.");
    // The restore itself succeeded, and the sync after it is a sync: a file
    // that can never sync, or one still failing when the pass gave up, is
    // the same unsuccessful run here as it is under `sync` and `rebase`. The
    // note is on this device either way, and the line above says so.
    return exitCodeFor(report);
  } finally {
    await client.close();
  }
}

async function cmdUnlink(args: Args, io: Console): Promise<number> {
  const config = await loadConfig(args.dir).catch(() => undefined);
  await removeState(args.dir);
  if (args.json)
    io.out(JSON.stringify({ ok: true, unlinked: args.dir, wasPaired: config !== undefined }));
  else {
    io.out(`Forgot the pairing for ${args.dir}. Every note is where it was.`);
    io.out("Nothing was removed from the server.");
  }
  return 0;
}

/* ---------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------- */

/**
 * How much of a connection a command needs.
 *
 * A command that only reads a number off the handshake passes
 * `waitForBacklog: false` and closes; see `Client.connect`. Anything that
 * syncs takes the default and waits.
 */
interface ConnectHow {
  readonly waitForBacklog?: boolean;
}

/**
 * Assembles the four objects, which is the whole of what a shell does.
 *
 * `forget` is whether a spent bootstrap may be removed from the config here.
 * Only a command holding the vault's lock may write the config, so a reading
 * command connects with whatever works and leaves the file alone.
 */
async function open(
  config: Config,
  args: Args,
  io?: Console,
  forget = true,
  opts: ConnectHow = {},
): Promise<Client> {
  const connected = await connectWith(config, args, io, opts);
  const settled = settledConfig(config, connected.config, connected.client.wrapped);
  if (settled === undefined) return connected.client;

  // Something the connection proved that the file does not say yet: a
  // bootstrap that is spent, a rotation that is resolved, or the vault's
  // wrapped data key seen for the first time. Kept out of step, the bootstrap
  // is a second secret in a file for no reason and one the next run would
  // offer first, and the unpinned blob is a wrapping this device would go on
  // believing whatever the server said.
  if (!forget) return connected.client;
  try {
    await saveConfig(args.dir, settled);
  } catch (err) {
    // Nothing is lost by this: every one of those facts is re-derivable on the
    // next connection, and the recovery in `candidates` is what does it. What
    // must not happen is leaving a connection running behind an error, or
    // reporting success while the file still says otherwise.
    await connected.client.close();
    throw new Error(
      `the vault is claimed but ${configPath(args.dir)} could not be brought up to date: ${(err as Error).message}`,
    );
  }
  return connected.client;
}

/**
 * Connects, recovering the one case a spent bootstrap can be proven spent.
 *
 * `init` writes the config with the bootstrap, claims the vault, and then
 * writes the config again without it. If the second write fails, or the
 * claim commits and its reply is lost, the next run offers the bootstrap
 * first and is refused, for ever. The refusal is `auth`, which is also what
 * a wrong token and a vault claimed by another device produce, so it does
 * not on its own say what happened.
 *
 * What does say is the key derived from this config's root secret. The
 * server compares it against the hash it bound the vault to, so that key
 * being accepted proves the vault was claimed with this secret, by this
 * device or a device holding the same pairing. That is the narrow case in
 * which the bootstrap can be dropped, and the only one in which it is tried.
 */
async function connectWith(
  config: Config,
  args: Args,
  io?: Console,
  how: ConnectHow = {},
): Promise<{ client: Client; config: Config }> {
  let first: Error | undefined;
  for (const candidate of credentialCandidates(config)) {
    const client = new Client(await clientOptions(candidate, args, io));
    try {
      await client.connect(how);
      return { client, config: candidate };
    } catch (err) {
      await client.close();
      first ??= err as Error;
      // Only an `auth` refusal says "this credential is not the vault's", and
      // only that is worth trying another one against. Anything else is the
      // server, the network or this vault's own state, and every candidate
      // would meet it identically.
      if (!(err instanceof ProtocolError) || err.code !== "auth") throw err;
    }
  }
  // Nothing opened it, so nothing is proven and the first refusal stands: it is
  // the one that describes the credential this device believes in.
  throw first ?? new Error("this vault has no credential to connect with");
}

async function clientOptions(config: Config, args: Args, io?: Console): Promise<ClientOptions> {
  const vault = new NodeVault(args.dir, { configDir: args.configDir, alsoIgnore: args.ignore });
  // Once, here, before anything canonicalises a path. Until the probe has run
  // `canonical` folds case, which is the safe default and the wrong answer on
  // Linux: two files that differ only in case are one file as far as the alias
  // check is concerned, both are refused, and every sync exits 1 over a pair
  // the disk is perfectly happy with. The probe existed and nothing called it.
  await vault.probeCase();
  return {
    vault,
    store: new JsonIndexStore(indexPath(args.dir)),
    // Which key authenticates and what the vault is bound to, worked out in
    // core so that both shells cannot answer it differently.
    ...(await credentialsFor(config)),
    timeoutMs: args.timeout,
    // A one-shot sync does not defer a file to a next pass it will never
    // run. A watching one does, because there is one.
    coalesceWrites: args.watch,
    // Only while watching. A one-shot sync prints its report at the end and
    // a line per path on the way would bury it; a client that stays running
    // has nothing else to say between passes.
    ...(args.watch && io
      ? {
          onProgress: (path?: string) => {
            if (path !== undefined) io.err(`  ... ${path}`);
          },
        }
      : {}),
    ...(args.verbose && io
      ? {
          log: (m: string, ...rest: unknown[]) =>
            io.err(`  ${m} ${rest.map(brief).join(" ")}`.trimEnd()),
        }
      : {}),
  };
}

function report_(r: SyncReport, args: Args, io: Console, serverCursor: number): void {
  if (args.json) {
    io.out(JSON.stringify({ ok: true, ...r, serverCursor }));
    return;
  }

  const lines: string[] = [];
  const say = (n: number, what: string) => {
    if (n > 0) lines.push(`${String(n).padStart(5)}  ${what}`);
  };
  say(r.uploaded, "uploaded");
  say(r.downloaded, "downloaded");
  say(r.merged, "merged");
  say(r.conflicted, "kept both versions");
  say(r.deletedLocally, "deleted here");
  say(r.deletedRemotely, "deleted on the server");
  say(r.restored, "brought back, having been edited elsewhere");
  say(r.foldersCreated, "folders created");
  say(r.waiting, "waiting for a write to settle");
  say(r.retrying, "failed, will try again");
  say(r.skipped, "cannot sync and will not be retried");
  say(r.ignored, "ignored here, and synced by another device");
  say(r.blocked, "waiting on a name that is a file here and a folder elsewhere");

  if (lines.length === 0) {
    io.out("Nothing to do. Everything here matches the server.");
  } else {
    for (const line of lines) io.out(line);
  }

  // Named, because this is the one refusal that never clears itself. It waits
  // for somebody to rename one of the two things that disagree, and a count on
  // its own does not tell them which two.
  if (r.inTheWay.length > 0) {
    io.out("");
    const blockers = [...new Set(r.inTheWay.map((b) => b.blockedBy))];
    for (const blocker of blockers) {
      io.out(`  "${blocker}" is a file here and a folder on another device.`);
    }
    const waiting = r.inTheWay.map((b) => b.path);
    io.out(
      `  Waiting to be written: ${waiting.join(", ")}${r.blocked > waiting.length ? ", …" : ""}`,
    );
    io.out("  Rename one of them, on whichever device meant the other thing.");
  }
  if (r.chunksSent > 0)
    io.out(`${String(r.chunksSent).padStart(5)}  chunks sent, ${bytes(r.bytesSent)}`);
  if (r.conflicted > 0)
    io.err('Look for files with "Conflicted copy" in the name. Both versions are kept.');
}

/* ---------------------------------------------------------------- *
 * Arguments
 * ---------------------------------------------------------------- */

interface Args {
  command?: string;
  rest: string[];
  dir: string;
  device: string;
  /** Whether --device was typed, since the default gets a random tail at pairing. */
  deviceGiven: boolean;
  vaultId: string;
  server?: string;
  token?: string;
  json: boolean;
  watch: boolean;
  uid?: number;
  to?: string;
  limit: number;
  /** Whether --limit was typed, since the default only suits history. */
  limitGiven: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  timeout: number;
  /** How long an invite lasts, in milliseconds; undefined is the server's default. */
  ttlMs?: number;
  /** Whether rebase may remove the index, which the person confirms by typing it. */
  backupTaken: boolean;
  configDir: string;
  ignore: string[];
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    rest: [],
    dir: process.cwd(),
    device: hostname().split(".")[0] || "device",
    deviceGiven: false,
    vaultId: "default",
    json: false,
    watch: false,
    limit: 20,
    limitGiven: false,
    verbose: false,
    help: false,
    version: false,
    backupTaken: false,
    timeout: 30_000,
    configDir: DEFAULT_CONFIG_DIR,
    ignore: [],
  };

  const takes = new Set([
    "--dir",
    "--device",
    "--vault-id",
    "--server",
    "--token",
    "--timeout",
    "--uid",
    "--to",
    "--limit",
    "--config-dir",
    "--ignore",
    "--ttl",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    if (takes.has(arg)) {
      value = argv[++i];
      // A flag that swallowed the next flag is the classic way to end up
      // pointed at the wrong directory without noticing.
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    }
    switch (arg) {
      case "--dir":
        args.dir = resolve(value!);
        break;
      case "--device":
        args.device = value!;
        args.deviceGiven = true;
        break;
      case "--vault-id":
        args.vaultId = value!;
        break;
      case "--server":
        args.server = value!;
        break;
      case "--token":
        args.token = value!;
        break;
      case "--timeout": {
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms <= 0)
          throw new Error(`--timeout wants a number of milliseconds, not ${value}`);
        args.timeout = ms;
        break;
      }
      case "--uid": {
        const uid = Number(value);
        if (!Number.isInteger(uid) || uid <= 0)
          throw new Error(`--uid wants a version number, not ${value}`);
        args.uid = uid;
        break;
      }
      case "--to":
        args.to = value!;
        break;
      // Checked here rather than at the vault, so a name that cannot be
      // one is refused before anything is opened.
      case "--config-dir":
        args.configDir = configFolderName(value!);
        break;
      // Repeatable. One name per flag rather than a separated list,
      // because a filename may contain a comma and a vault is the wrong
      // place to find out which separator was assumed.
      //
      // Checked, because it is matched against one path segment at a time:
      // an empty name or one with a slash in it matches nothing anywhere,
      // and . and .. are never a segment of a canonical path, so all four
      // were accepted in silence, which is the worst answer available for a
      // flag whose whole job is to keep a folder out.
      case "--ignore":
        if (value === "" || value === "." || value === ".." || value!.includes("/")) {
          throw new Error(
            `--ignore wants one folder or file name, not ${JSON.stringify(value)}: ` +
              `it is matched against each part of a path on its own, so a name with a slash in it matches nothing, and . and .. are never a part`,
          );
        }
        args.ignore.push(value!);
        break;
      case "--limit": {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit <= 0)
          throw new Error(`--limit wants a count, not ${value}`);
        args.limit = limit;
        args.limitGiven = true;
        break;
      }
      case "--ttl":
        args.ttlMs = parseDuration(value!);
        break;
      case "--backup-taken":
        args.backupTaken = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--version":
      case "-V":
        args.version = true;
        break;
      case "--watch":
        args.watch = true;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`no such option: ${arg}`);
        if (args.command === undefined) args.command = arg;
        else args.rest.push(arg);
    }
  }
  return args;
}

/* ---------------------------------------------------------------- *
 * Small things
 * ---------------------------------------------------------------- */

async function mustLoad(dir: string): Promise<Config> {
  const config = await loadConfig(dir);
  if (!config) throw new Error(`${dir} is not paired. Run basalt init or basalt pair first.`);
  return config;
}

/**
 * A duration as a person types one: `10m`, `1h`, `90s`, or plain seconds.
 *
 * Bounded above by what the server allows, so the answer is one it will give
 * rather than one it will quietly cap.
 */
export function parseDuration(text: string): number {
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(text.trim());
  if (!m) throw new Error(`--ttl wants a duration like 10m, 90s or 1h, not ${text}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const ms = n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
  if (ms <= 0) throw new Error("--ttl must be more than nothing");
  if (ms > 3_600_000)
    throw new Error("--ttl can be at most 1h, which is the most the server allows");
  return ms;
}

/** A timestamp somebody can read, which is the point of a recovery listing. */
function when(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "unknown         ";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function brief(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
