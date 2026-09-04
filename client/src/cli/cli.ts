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
  Registrar,
  convertToDevice,
  credentialsFor,
  needsConversion,
  rebaseCursors,
  redeemInvite,
  refuseUnlessAhead,
  runForever,
  wrappedForClaim,
  type ClientOptions,
  type DeviceRow,
  type InviteRow,
} from "../core/client.ts";
import { REJOIN_ADVICE, type SyncReport } from "../core/engine.ts";
import {
  deviceCredential,
  formatPairing,
  isInvite,
  normaliseUrl,
  parseInvite,
  parsePairing,
  parseSetup,
  type Invite,
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
  basalt uninvite ID                        cancel an outstanding invite, from basalt devices
  basalt pair INVITE                        add this device to a vault, with an invite or its
                                            recovery key
  basalt sync                               sync once and exit
  basalt sync --watch                       sync, then keep syncing
  basalt status                             what this device thinks the state is
  basalt devices                            every device that may reach this vault
  basalt revoke ID                          stop one device connecting, from basalt devices
  basalt deleted                            notes the server still has and you do not
  basalt history PATH                       every version the server holds of one note
  basalt restore PATH                       put a note back, newest version first
  basalt rotate RECOVERY-KEY                give the vault a new secret, keeping its history
  basalt rebase --backup-taken              rejoin a server restored from an older backup
  basalt unlink                             forget the pairing, keep the notes
  basalt --version                          which release this is

Options
  --dir DIR        the vault (default: the current directory)
  --device NAME    what this device calls itself (default: its hostname and four random characters)
  --vault-id ID    which vault on the server (default: default)
  --json           machine-readable output
  --timeout MS     how long to wait on the server (default: 30000)
  --allow-last     revoke the last device, leaving the vault reachable only by its recovery key.
                   Needs --recovery-key: it is the one revocation a device cannot undo
  --recovery-key K run devices, revoke or uninvite with the vault's recovery key instead of this
                   device's credential, for the last device and for a vault with no device to ask
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
    refuseRecoveryKey(args);
    // Before anything else, and once per device in a vault's life: a config
    // that still holds the vault's root has not registered itself with the
    // server yet, and under protocol 4 there is nothing it can do until it
    // has. It takes and releases the lock on its own, so the commands below
    // that take the lock are not nesting one inside another.
    //
    // `status` is not on the list and asks for itself, inside its own
    // try: it is the command somebody runs when nothing else works, and a
    // conversion that cannot reach the server must not stop it printing what
    // this device knows locally.
    if (CONVERTS_FIRST.has(args.command)) await convertIfNeeded(args, io);
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
      case "devices":
        return await cmdDevices(args, io);
      case "revoke":
        return await cmdRevoke(args, io);
      case "rotate":
        return await cmdRotate(args, io);
      case "invite":
        return await cmdInvite(args, io);
      case "uninvite":
        return await cmdUninvite(args, io);
      case "recovery-key":
        throw new Error(NO_RECOVERY_KEY);
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
  revoke: 1,
  rotate: 1,
  uninvite: 1,
};

/**
 * The three commands `--recovery-key` means something to.
 *
 * Everything else needs this device's own credential and would ignore the
 * flag, and a flag that is quietly ignored is how somebody comes to believe
 * they ran a command as the recovery key when they did not. The same reasoning
 * as refuseExtras: a word that had no effect is worth an error.
 */
const TAKES_RECOVERY_KEY = new Set(["devices", "revoke", "uninvite"]);

function refuseRecoveryKey(args: Args): void {
  if (args.recoveryKey === undefined) return;
  if (TAKES_RECOVERY_KEY.has(args.command ?? "")) return;
  throw new Error(
    `${args.command} does not take --recovery-key, so the key would have been ignored. ` +
      `It is for ${[...TAKES_RECOVERY_KEY].join(", ")}; basalt rotate takes the key as its ` +
      `argument instead.`,
  );
}

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
 * Becoming a device
 * ---------------------------------------------------------------- */

/**
 * The commands that need a device credential, and so finish a conversion
 * before they run.
 *
 * Everything that talks to the server as this vault. `init` and `pair` are not
 * here because they make the config and convert it themselves; `unlink` is not
 * because forgetting a pairing must work when the server does not; `rotate`
 * carries the recovery key on the command line and does not need the device's
 * own credential at all, but it does need the data key, so it converts too.
 */
const CONVERTS_FIRST = new Set([
  "sync",
  "deleted",
  "history",
  "restore",
  "rebase",
  "devices",
  "revoke",
  "rotate",
  "invite",
  "uninvite",
]);

/**
 * Finishes a conversion that has not finished, under the vault's lock.
 *
 * A protocol 3 device holds the vault's root and no device row, and every
 * device converts itself once, silently. That is the alternative to telling
 * somebody to pair a laptop, a phone, a desktop and a NAS again, which is the
 * weekend this feature exists to abolish.
 *
 * Under the lock, because it writes the config three times and a second
 * basalt converting the same vault at the same moment would register two rows
 * and leave one of them holding a credential nothing on disk remembers.
 */
async function convertIfNeeded(args: Args, io: Console): Promise<void> {
  const config = await loadConfig(args.dir);
  // Not paired at all is the command's own business to report, and it says
  // so in words this could not improve on.
  if (!config || !needsConversion(config)) return;
  await locked(args, async () => {
    // Read again with the lock held. Another basalt may have converted this
    // vault between the check above and the lock, and converting a second
    // time would register a second row for one device.
    const held = await loadConfig(args.dir);
    if (!held || !needsConversion(held)) return 0;
    await convertToDevice(
      held,
      async (next) => {
        await saveConfig(args.dir, next);
        await mustReadBack(args.dir, next);
      },
      {
        timeoutMs: args.timeout,
        ...(args.verbose ? { log: (m: string) => io.err(`  ${m}`) } : {}),
      },
    );
    return 0;
  });
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
    // the vault with it. The claim travels on the registrar hello that then
    // registers this device's own row, so both are spent by the conversion
    // below and neither survives it.
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
  await mustReadBack(args.dir, config);

  // The recovery key, worked out before anything is sent and printed after.
  // This is the only moment it exists anywhere: the conversion below drops the
  // root from this device on purpose, so if this string is not written down
  // now there is no command that can print it again.
  const recoveryKey = formatPairing({ url: config.url, vaultId: config.vaultId, secret });

  // Claim the vault, register this device's row, and drop the root, all now,
  // rather than leaving any of it to whenever this device first syncs.
  //
  // init used to write a config and contact nothing, so it reported a paired
  // vault that the server had never heard of. A second device pairing and
  // syncing before this one ever did was refused with "not authorised for
  // this vault": true, unhelpful, and indistinguishable from a bad key.
  //
  // The config is kept if this throws. The claim may have committed with the
  // reply lost, and a config discarded in that case is a vault that nothing
  // will ever open again: the secret in it is the only copy on this machine,
  // and the next command finishes what this one started.
  try {
    await convert(config, args, io);
  } catch (err) {
    io.err("basalt: the vault was started but this device could not finish registering itself:");
    io.err(`  ${(err as Error).message}`);
    io.err("Write this recovery key down now, before anything else:");
    io.err(`  ${recoveryKey}`);
    io.err("Then run basalt sync here, which finishes the registration.");
    return 1;
  }

  if (args.json) {
    io.out(JSON.stringify({ ok: true, paired: args.dir, device: config.device, recoveryKey }));
  } else {
    io.out(`Started the vault. ${args.dir} is paired as "${config.device}".`);
    io.out("");
    io.out("This is the vault's recovery key. Write it down and keep it offline:");
    io.out("");
    io.out(`  ${recoveryKey}`);
    io.out("");
    io.out("It is shown once and this device does not keep it: what is on disk here is this");
    io.out("device's own credential, which can be revoked on its own. Adding a device does not");
    io.out("need it, basalt invite does that; the recovery key replaces the vault's secret and is");
    io.out("the only way back if every device is lost. Anyone who has it has the vault, and the");
    io.out("server has never seen it.");
  }
  return 0;
}

/** Converts a config in place, saving durably and reading back at each step. */
async function convert(
  config: Config,
  args: Args,
  io: Console,
  onRegistered?: () => void,
): Promise<Config> {
  return convertToDevice(
    config,
    async (next) => {
      await saveConfig(args.dir, next);
      await mustReadBack(args.dir, next);
    },
    {
      timeoutMs: args.timeout,
      ...(onRegistered !== undefined ? { onRegistered } : {}),
      ...(args.verbose ? { log: (m: string) => io.err(`  ${m}`) } : {}),
    },
  );
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
 * Adds this device to a vault, with an invite or with the vault's recovery key.
 *
 * An invite is the ordinary way and the recovery key is the last resort. Both
 * end in the same place: this device holds a row of its own, the credential
 * for it and the vault's data key, and no root. That is what makes revoking
 * this device on its own mean anything.
 *
 * The two differ in what is on the wire and so in when the config is written.
 *
 * An **invite** is spent by the redemption that registers this device, in one
 * server transaction, so there is nothing to write until it has answered: the
 * id and the key it registered are made in that call and come back with the
 * data key. A crash before the reply lands leaves this vault unpaired and one
 * row on the server that nobody holds the key to, which shows up in `basalt
 * devices` as a device that has never connected and goes with `basalt revoke`.
 * The alternative order strands this device instead; see `redeemInvite`.
 *
 * A **recovery key** buys a registrar session: it may register a device and
 * rewrap the vault's secret, and it may not sync. So that path is
 * register-then-connect, the config is written before the registration goes
 * out and read back, and a crash between the two leaves a device that
 * registers the same id with the same key again and carries on. See
 * `convertToDevice`.
 */
async function cmdPair(args: Args, io: Console): Promise<number> {
  const given = args.rest[0];
  if (!given) throw new Error("pair needs the invite or recovery key another device printed");
  await refuseIfPaired(args.dir);
  if (isInvite(given)) return await pairWithInvite(parseInvite(given), args, io);

  const pairing = parsePairing(given);
  const config: Config = {
    url: pairing.url,
    vaultId: pairing.vaultId,
    device: deviceNameFor(args),
    secret: pairing.secret,
  };
  await saveConfig(args.dir, config);
  await mustReadBack(args.dir, config);
  let converted: Config;
  let registered = false;
  try {
    converted = await convert(config, args, io, () => {
      registered = true;
    });
  } catch (err) {
    if (!registered) {
      // Nothing on the server knows about this device, so nothing here should
      // either: a recovery key that turns out to be wrong, or a server that is
      // not there, must leave the vault exactly as unpaired as it found it
      // (C39). Otherwise the next attempt is refused for being already paired.
      await removeState(args.dir).catch(() => undefined);
      throw err;
    }
    // The row is real and this device holds the only copy of its credential,
    // so the config stays and the next command finishes what this started.
    throw new Error(
      `${(err as Error).message}. This device is registered with the vault and ${args.dir} holds ` +
        `its credential; run basalt sync here to finish, or basalt unlink to start again.`,
    );
  }

  if (args.json) {
    io.out(
      JSON.stringify({
        ok: true,
        paired: args.dir,
        device: converted.device,
        deviceId: converted.deviceId,
        url: converted.url,
      }),
    );
  } else {
    io.out(`Paired ${args.dir} with ${converted.url} as "${converted.device}". Run basalt sync.`);
    io.out(
      `This device has its own credential now, and not the recovery key: ` +
        `basalt revoke ${converted.deviceId} on any device stops it connecting.`,
    );
  }
  return 0;
}

/**
 * Pairs with an invite: redeem, save, connect.
 *
 * The redemption is the registration, so what comes back is a finished device
 * and there is no conversion to run afterwards: this config never holds a root
 * and `needsConversion` is false for it from the first save.
 *
 * Saved and read back before the connection is made, because at the moment the
 * reply lands the only copy of the data key on this machine is in this
 * process, and the invite that carried it is already spent (rule 4). Then the
 * connection, because a pairing that says "paired" without having reached the
 * server is how a wrong address is found out later, from a sync that fails
 * (C39, I13).
 */
async function pairWithInvite(invite: Invite, args: Args, io: Console): Promise<number> {
  const device = deviceNameFor(args);
  const redeemed = await redeemInvite(invite, device, {
    timeoutMs: args.timeout,
    ...(args.verbose ? { log: (m: string) => io.err(`  ${m}`) } : {}),
  });
  const config: Config = {
    url: invite.url,
    vaultId: invite.vaultId,
    device,
    deviceId: redeemed.deviceId,
    deviceSecret: redeemed.deviceSecret,
    dataKey: redeemed.dataKey,
  };
  await saveConfig(args.dir, config);
  await mustReadBack(args.dir, config);
  // The row exists and this is the only copy of its credential, so a failure
  // from here leaves the config alone: the next command finishes what this
  // started rather than making somebody find another invite.
  const client = await open(config, args, io, { waitForBacklog: false });
  await client.close();

  if (args.json) {
    io.out(
      JSON.stringify({
        ok: true,
        paired: args.dir,
        device: config.device,
        deviceId: config.deviceId,
        url: config.url,
      }),
    );
  } else {
    io.out(`Paired ${args.dir} with ${config.url} as "${config.device}". Run basalt sync.`);
    io.out(
      `This device has its own credential, and not the vault's recovery key: ` +
        `basalt revoke ${config.deviceId} on any device stops it connecting.`,
    );
  }
  return 0;
}

/**
 * Prints a single-use invite for another device.
 *
 * The vault's data key goes to the server sealed under a key that stays in the
 * string, for ten minutes unless asked otherwise, and the string works once.
 * Nothing about the vault is shown: the string is where to ask, which vault,
 * and how to open what is handed back.
 *
 * This is how a device is added. The recovery key is not: it stays written
 * down for the day every device is gone, and no device holds one to print.
 */
async function cmdInvite(args: Args, io: Console): Promise<number> {
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { waitForBacklog: false });
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
 * Proves the config is on disk and decodes to itself before anything relies
 * on it. Not written, not renamed, but readable: what is in it is the only
 * copy this device has, at every step of a conversion.
 */
async function mustReadBack(dir: string, config: Config): Promise<void> {
  const back = await loadConfig(dir);
  if (!back || back.url !== config.url) {
    throw new Error(`${configPath(dir)} did not read back as what was just written`);
  }
  const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
    a === undefined ? b === undefined : b !== undefined && Buffer.compare(a, b) === 0;
  // Every key, by name, because each of the three is the only copy of itself
  // at some point in a conversion and a read-back that checked one of them
  // would pass over the write that lost another. `deviceId` too: a device
  // secret that landed under a different id is a credential for a row that is
  // not this device's.
  if (
    !same(back.secret, config.secret) ||
    !same(back.deviceSecret, config.deviceSecret) ||
    !same(back.dataKey, config.dataKey) ||
    back.deviceId !== config.deviceId
  ) {
    throw new Error(`${configPath(dir)} did not read back with the keys that were written`);
  }
}

/**
 * What `basalt recovery-key` says now, and why there is nothing to print.
 *
 * It used to print the vault's root secret out of this device's config. No
 * device holds one since protocol 4, which is the whole of why revoking one
 * means anything, so the command has nothing to read. Adding a device is
 * `basalt invite`, which is what it was for anyway.
 */
const NO_RECOVERY_KEY =
  "this device does not hold the vault's recovery key. It was shown once, when the vault was " +
  "started, and it is not on any device on purpose: a device that held it could re-derive " +
  "the vault's credential and register itself again, so revoking it would stop nothing. " +
  "To add a device, run basalt invite here. If the recovery key is lost, basalt rotate needs " +
  "the old one, so there is nothing this can print.";

/**
 * Opens a session holding the vault's recovery key rather than this device's
 * own credential.
 *
 * Two commands take one. Revoking the last device needs it, because that is
 * the one revocation nothing on a device can undo. Listing accepts it for the
 * vault that has no device left to ask: eight rows that never connected refuse
 * every registration, and the ids to revoke off them have to come from
 * somewhere.
 *
 * The key names its own server and vault, so this works in a directory that
 * was never paired. When there is a config here it has to agree, or a key
 * pasted from the wrong vault would act on that vault while the person read
 * this one's name off the screen.
 */
async function asRecoveryKey(given: string, args: Args): Promise<Registrar> {
  const key = parsePairing(given);
  const config = await loadConfig(args.dir);
  if (config && config.vaultId !== key.vaultId) {
    throw new Error(
      `that recovery key is for vault "${key.vaultId}" and this directory is paired with ` +
        `"${config.vaultId}", so it would act on a vault this device is not on`,
    );
  }
  return Registrar.open({
    url: key.url,
    vaultId: key.vaultId,
    device: config?.device ?? "recovery-key",
    secret: key.secret,
    timeoutMs: args.timeout,
  });
}

/**
 * Every device that may reach this vault.
 *
 * The only way to answer "what is still connected to my notes", which is the
 * question a device list exists for.
 *
 * A row that has never connected is flagged rather than left to be read out of
 * a blank column, because those are the reclaimable ones. A redemption saves
 * nothing on the new device until the server has answered, so a crash in that
 * window strands a row on the server instead of a device that thinks it is
 * paired: the right way round, and it means the rows that pile up against the
 * cap are exactly the ones nothing has ever connected under.
 */
async function cmdDevices(args: Args, io: Console): Promise<number> {
  const { devices, maxDevices, invites, thisDevice, close } = await openDeviceList(args, io);
  try {
    if (args.json) {
      io.out(
        JSON.stringify({
          ok: true,
          devices,
          maxDevices,
          invites,
          ...(thisDevice !== undefined ? { thisDevice } : {}),
        }),
      );
      return 0;
    }
    for (const d of devices) {
      const mine = d.id === thisDevice ? "  (this device)" : "";
      // The id first, because it is what `basalt revoke` takes and the name
      // is not: two laptops may both be called laptop, and a list that put
      // the name where the identity goes would invite revoking the wrong one.
      io.out(
        `${d.id.padEnd(24)}  ${d.name.padEnd(16)}  added ${when(d.createdAt)}  ` +
          `${d.lastSeen === 0 ? "never connected " : `last seen ${when(d.lastSeen)}`}${mine}`,
      );
    }
    io.out("");
    io.out(`${devices.length} of at most ${maxDevices} devices. basalt revoke ID stops one.`);
    const stale = devices.filter((d) => d.lastSeen === 0);
    if (stale.length > 0) {
      io.out(
        `${stale.length} of them ${stale.length === 1 ? "has" : "have"} never connected. A pairing ` +
          `that reached the server and then crashed leaves a row like that, and it holds one of ` +
          `the ${maxDevices} slots until somebody revokes it.`,
      );
    }
    io.out(
      "Revoking stops a device connecting. It does not un-read what that device already read:",
    );
    io.out("it still holds the vault's key for every note it had synced. A device that was stolen");
    io.out("rather than lost wants basalt rotate as well.");
    // The invites, beside the rows, because they are the same question. A row
    // is a device that was added and an outstanding invite is one about to be:
    // a string issued on a device somebody has just lost is the thing worth
    // seeing, and until this it was invisible until it was redeemed.
    io.out("");
    if (invites.length === 0) {
      io.out("No outstanding invites.");
    } else {
      for (const inv of invites) {
        io.out(`${inv.id.padEnd(24)}  invite, expires ${when(inv.expiresAt)}`);
      }
      io.out("");
      io.out(
        `${invites.length} outstanding ${invites.length === 1 ? "invite" : "invites"}. Each one ` +
          `registers one device and then stops working. basalt uninvite ID cancels one you did ` +
          `not mean to issue.`,
      );
    }
    return 0;
  } finally {
    await close();
  }
}

/**
 * Cancels an outstanding invite.
 *
 * The companion to seeing them. An invite is a standing authority to register
 * one device, and before it could be listed the only ways to retire one were
 * to wait out its hour or to rotate the vault, which retires the recovery key
 * with it. Neither is an answer to "I issued that on the laptop I have just
 * lost".
 */
async function cmdUninvite(args: Args, io: Console): Promise<number> {
  const invite = args.rest[0];
  if (!invite) throw new Error("uninvite needs an invite id, from basalt devices");
  const canceller = await openRevoker(args, io);
  try {
    await canceller.uninvite(invite);
  } catch (err) {
    if (err instanceof ProtocolError && err.code === "badentry") {
      // One refusal for unknown, expired and already redeemed, because saying
      // which would tell somebody guessing identifiers that they had found a
      // real one. What it can say is where to look.
      throw new Error(
        `this vault has no outstanding invite ${invite}: it may have expired, or been redeemed, ` +
          `in which case it is a device row now. basalt devices shows both.`,
      );
    }
    throw err;
  } finally {
    await canceller.close();
  }
  if (args.json) {
    io.out(JSON.stringify({ ok: true, cancelled: invite }));
    return 0;
  }
  io.out(`Cancelled ${invite}. That string no longer adds a device.`);
  io.out(
    "It does not touch a device already added with it. If it was redeemed before this, the " +
      "device it added is a row in basalt devices, and basalt revoke ID is what stops that.",
  );
  return 0;
}

/**
 * Whoever is doing the revoking: this device, or the recovery key.
 *
 * The same two ways in as the list, and the same reason for the second one.
 * Both objects answer `revoke` identically, because it is the same op on the
 * wire; what differs is only whether the server will honour `allowLast`.
 */
async function openRevoker(
  args: Args,
  io: Console,
): Promise<{
  revoke: (id: string, opts: { allowLast?: boolean }) => Promise<{ self: boolean }>;
  uninvite: (invite: string) => Promise<void>;
  close: () => Promise<void>;
}> {
  if (args.recoveryKey !== undefined) {
    const registrar = await asRecoveryKey(args.recoveryKey, args);
    return {
      revoke: (id, opts) => registrar.revoke(id, opts),
      uninvite: (invite) => registrar.uninvite(invite),
      close: async () => registrar.close(),
    };
  }
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { waitForBacklog: false });
  return {
    revoke: (id, opts) => client.revoke(id, opts),
    uninvite: (invite) => client.uninvite(invite),
    close: () => client.close(),
  };
}

/**
 * The device list, from whichever credential was offered.
 *
 * Two ways in, one shape out. `thisDevice` is absent over the recovery key,
 * because a registrar is not a device and there is no row for it to be: a
 * list that guessed one would put "(this device)" against somebody else.
 */
async function openDeviceList(
  args: Args,
  io: Console,
): Promise<{
  devices: DeviceRow[];
  maxDevices: number;
  invites: InviteRow[];
  thisDevice?: string;
  close: () => Promise<void>;
}> {
  if (args.recoveryKey !== undefined) {
    const registrar = await asRecoveryKey(args.recoveryKey, args);
    try {
      return {
        ...(await registrar.devices()),
        close: async () => registrar.close(),
      };
    } catch (err) {
      registrar.close();
      throw err;
    }
  }
  const config = await mustLoad(args.dir);
  const client = await open(config, args, io, { waitForBacklog: false });
  try {
    return {
      ...(await client.devices()),
      thisDevice: client.deviceId,
      close: () => client.close(),
    };
  } catch (err) {
    await client.close();
    throw err;
  }
}

/**
 * Stops one device connecting, and closes whatever it has open.
 *
 * Both, and the reply means both: a row removed while the revoked device holds
 * an authenticated connection is a revocation it does not notice.
 *
 * Any device may do this to any other, which is the whole point of having
 * revocation rather than rotation: a phone cuts off a stolen laptop without
 * anybody digging the recovery key out of a drawer. The exception is
 * `--allow-last`, which needs the recovery key, because emptying the vault is
 * the one revocation nothing on a device can undo.
 */
async function cmdRevoke(args: Args, io: Console): Promise<number> {
  const deviceId = args.rest[0];
  if (!deviceId) throw new Error("revoke needs a device id, from basalt devices");
  // Refused here as well as at the server, so somebody who typed it gets the
  // whole command back rather than a round trip and a refusal. The server's
  // is the one that enforces it; this one is the one that helps.
  if (args.allowLast && args.recoveryKey === undefined) {
    throw new Error(
      `--allow-last leaves a vault only its recovery key can reach, and it is the one revocation ` +
        `no device can undo, so it takes that key: basalt revoke ${deviceId} --allow-last ` +
        `--recovery-key basalt3_...`,
    );
  }
  const revoker = await openRevoker(args, io);
  let self: boolean;
  try {
    ({ self } = await revoker.revoke(deviceId, { allowLast: args.allowLast }));
  } catch (err) {
    if (err instanceof ProtocolError && err.code === "nodevice") {
      throw new Error(
        `this vault has no device with id ${deviceId}, so the list you were reading is stale. ` +
          `Run basalt devices again.`,
      );
    }
    if (err instanceof ProtocolError && err.code === "badentry" && !args.allowLast) {
      // The last device. Over the recovery key that is the confirmation being
      // asked for; from a device it is the credential as well, and saying so
      // is the difference between an instruction and a dead end.
      const said = err.message.replace(/; resend with allowLast.*$/, "");
      throw new Error(
        args.recoveryKey !== undefined
          ? `${said}. Say it out loud to do it anyway: basalt revoke ${deviceId} --allow-last ` +
              `--recovery-key basalt3_...`
          : `${said}. That is the recovery key's to do, not a device's: basalt revoke ${deviceId} ` +
              `--allow-last --recovery-key basalt3_...`,
      );
    }
    throw err;
  } finally {
    await revoker.close();
  }
  if (args.json) {
    io.out(JSON.stringify({ ok: true, revoked: deviceId, self }));
    return 0;
  }
  io.out(`Revoked ${deviceId}. Its sessions are closed and it cannot connect again.`);
  io.out(
    "It still holds the vault's key for every note it had already synced. Revoking cannot " +
      "un-read those; basalt rotate RECOVERY-KEY is the answer to a device that was stolen.",
  );
  if (self) {
    io.out("");
    io.out(
      `That was this device. It has stopped syncing; run basalt unlink here to forget the pairing, ` +
        `or basalt pair RECOVERY-KEY to add it again.`,
    );
  }
  return 0;
}

/**
 * Gives the vault a new root secret and keeps its history and its devices.
 *
 * It takes the old recovery key on the command line, because no device holds
 * one: rotating is the root's own power, along with registering a device, and
 * this is one of the two moments in a vault's life the root is used.
 *
 * **No device row is touched and every device keeps syncing across this**,
 * which is the expensive half of what per-device credentials removed. Under
 * protocol 3 the vault's hash was the credential every device held, so a
 * rotation evicted the lot and each one had to be paired again from the new
 * string, which for a laptop, a phone, a desktop and a NAS is a weekend and is
 * the reason a leaked string went unrotated.
 *
 * The data key is this device's own, which is the vault's: rotation replaces
 * the wrapping and never the key, so the copy a paired device holds is always
 * current, and there is nothing to fetch before rewrapping it.
 */
async function cmdRotate(args: Args, io: Console): Promise<number> {
  const given = args.rest[0];
  if (!given) {
    throw new Error(
      "rotate needs the vault's current recovery key, which no device holds: " +
        "basalt rotate basalt3_...",
    );
  }
  const old = parsePairing(given);
  const config = await mustLoad(args.dir);
  const { dataKey } = deviceCredential(config);
  if (old.vaultId !== config.vaultId) {
    throw new Error(
      `that recovery key is for vault "${old.vaultId}" and this one is paired with ` +
        `"${config.vaultId}", so it would rotate a vault this device is not on`,
    );
  }

  const secret = generateSecret();
  const recoveryKey = formatPairing({ url: config.url, vaultId: config.vaultId, secret });
  // Printed before the request goes out, and this is the whole of the
  // durability. Rotation used to stage its new secret in this device's config
  // and promote it afterwards, because the server commits, closes every other
  // registrar and only then replies, so a socket that drops in between leaves
  // a vault whose new root exists nowhere but in this process. There is no
  // longer anywhere on a device to stage a root: not holding one is the point.
  // So the durable copy is the one on the person's paper, and it goes there
  // first.
  if (!args.json) {
    io.err("The vault is about to get this recovery key. Write it down before pressing on:");
    io.err(`  ${recoveryKey}`);
  }

  const registrar = await Registrar.open({
    url: config.url,
    vaultId: config.vaultId,
    device: config.device,
    secret: old.secret,
    timeoutMs: args.timeout,
  });
  try {
    await registrar.rotate(secret, dataKey);
  } catch (err) {
    registrar.close();
    if (err instanceof ProtocolError && err.code === "rotated") {
      // Answered, and refused: somebody rotated first, so nothing committed
      // and the key printed above is not the vault's. Said plainly, because a
      // key that opens nothing written down in place of one that does is worse
      // than either.
      throw new Error(
        "the vault was rotated by somebody else first, so this rotation was refused and the key " +
          "above is not the vault's. Cross it out. The recovery key you used has been retired too.",
      );
    }
    // No reply, and nothing here can tell a rotation that committed from one
    // that did not. So ask: the new root opens a registrar session if and only
    // if the server took it.
    const committed = await didRotate(config, secret, args).catch(() => undefined);
    if (committed === true) {
      io.err(
        "basalt: the reply was lost, but the rotation did commit. The key above is the vault's.",
      );
      return finishRotate(recoveryKey, args, io);
    }
    if (committed === false) {
      throw new Error(
        `the rotation was not answered and did not commit: ${(err as Error).message}. ` +
          `The vault still has its old recovery key; cross out the one above.`,
      );
    }
    throw new Error(
      `the rotation was not answered and the server could not be reached to find out whether it ` +
        `committed: ${(err as Error).message}. Keep both keys and run basalt rotate again with ` +
        `whichever one the server accepts.`,
    );
  }
  registrar.close();
  return finishRotate(recoveryKey, args, io);
}

/** Whether a root secret opens this vault, which is whether a rotation to it committed. */
async function didRotate(config: Config, secret: Uint8Array, args: Args): Promise<boolean> {
  try {
    const probe = await Registrar.open({
      url: config.url,
      vaultId: config.vaultId,
      device: config.device,
      secret,
      timeoutMs: args.timeout,
    });
    probe.close();
    return true;
  } catch (err) {
    // Only `auth` says "this is not the vault's credential". Anything else is
    // the network or the server, and answering "it did not commit" to those
    // would have somebody cross out the key that opens their vault.
    if (err instanceof ProtocolError && err.code === "auth") return false;
    throw err;
  }
}

function finishRotate(recoveryKey: string, args: Args, io: Console): number {
  if (args.json) {
    io.out(JSON.stringify({ ok: true, rotated: args.dir, recoveryKey }));
    return 0;
  }
  io.out("Rotated. The old recovery key, and every outstanding invite, no longer open this vault.");
  io.out("");
  io.out("This is the new recovery key. Write it down in place of the old one:");
  io.out("");
  io.out(`  ${recoveryKey}`);
  io.out("");
  io.out("Every device keeps syncing: a rotation replaces the vault's secret and touches no");
  io.out("device row. It cannot un-read what a lost device already read, so revoke that device");
  io.out("too, with basalt devices and basalt revoke ID.");
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
    if (needsConversion(config)) {
      // Said rather than attempted. Converting writes the config three times
      // and so needs the vault's lock, and `status` deliberately holds no
      // lock: it is the command somebody runs while a watcher is running, and
      // one that refused then would refuse exactly when it is asked. So this
      // reports the state instead of guessing at the server, which is what it
      // would be doing: an unconverted device cannot reach one.
      throw new Unconverted(
        "this device has not registered itself with the vault yet. Run basalt sync here, " +
          "which finishes it.",
      );
    }
    // The handshake and nothing after it. What is printed below is the
    // server's own cursor out of `ready`, and waiting for the backlog first
    // meant a device weeks behind unsealed all of it before saying a word.
    const client = await open(config, args, io, { waitForBacklog: false });
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
    // against a server that has lost history. A device that has not converted
    // asked nothing, so it is neither reachable nor refused: rule 7, and
    // exactly the pair of states this field exists to keep apart.
    const answered = !(err instanceof ConnectionError) && !(err instanceof Unconverted);
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
  const client = await open(config, args, io);
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
  const client = await open(config, args, io);
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

/**
 * Forgets the pairing here, and says what is still on the server.
 *
 * Deliberately local, and deliberately not a revoke. Unlinking has to work
 * when the server does not, which is half of what somebody reaches for it for,
 * and a version of it that needed a connection would fail exactly then. The
 * cost is a row this device leaves behind, so the row's id is printed: that is
 * what `basalt revoke` takes, and a list somebody cannot act on is worse than
 * no list.
 */
async function cmdUnlink(args: Args, io: Console): Promise<number> {
  const config = await loadConfig(args.dir).catch(() => undefined);
  await removeState(args.dir);
  if (args.json) {
    io.out(
      JSON.stringify({
        ok: true,
        unlinked: args.dir,
        wasPaired: config !== undefined,
        ...(config?.deviceId !== undefined ? { deviceId: config.deviceId } : {}),
      }),
    );
    return 0;
  }
  io.out(`Forgot the pairing for ${args.dir}. Every note is where it was.`);
  io.out("Nothing was removed from the server.");
  if (config?.deviceId !== undefined) {
    io.out("");
    io.out(
      `This device is still in the vault's device list as ${config.deviceId}. Nothing here can ` +
        `remove it now, because the credential for it has just been forgotten: run ` +
        `basalt revoke ${config.deviceId} on a device that still syncs.`,
    );
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
 * Assembles the four objects and connects, which is the whole of what a shell
 * does.
 *
 * There is one credential now and no candidates to try. Protocol 3 kept a list
 * here, because a device might have been holding a spent bootstrap, a rotation
 * whose reply was lost, or the root, and the connection was where it found out
 * which. A converted device has exactly one credential and either it opens the
 * vault or it does not, and no other credential on this disk would.
 *
 * Nothing is written back either. What a connection used to prove, and this
 * file used to record, is settled by `convertToDevice` before any command
 * connects.
 */
async function open(
  config: Config,
  args: Args,
  io?: Console,
  opts: ConnectHow = {},
): Promise<Client> {
  const client = new Client(await clientOptions(config, args, io));
  try {
    await client.connect(opts);
  } catch (err) {
    await client.close();
    throw err;
  }
  return client;
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
  // Not "a file here and a folder elsewhere" any more: two spellings of one
  // name on a disk that keeps them apart is blocked for a different reason,
  // and the lines below say which reason applies to which name.
  say(r.blocked, "waiting on a name two things claim");

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
    // `why` where the entry has one. Two names on disk that are one path once
    // normalized are not a file here and a folder elsewhere, and printing that
    // sentence over them would send somebody looking for the wrong thing.
    const reasons = [
      ...new Set(
        r.inTheWay.map(
          (b) => b.why ?? `"${b.blockedBy}" is a file here and a folder on another device.`,
        ),
      ),
    ];
    for (const reason of reasons) io.out(`  ${reason}`);
    // Two lists, because the two refusals ask for different things. A name
    // that is a file here and a folder elsewhere is waiting on a rename on
    // whichever device meant the other thing; two spellings of one name are
    // both here, and the rename is here too.
    const waiting = r.inTheWay.filter((b) => b.why === undefined).map((b) => b.path);
    if (waiting.length > 0) {
      io.out(
        `  Waiting to be written: ${waiting.join(", ")}${r.blocked > r.inTheWay.length ? ", …" : ""}`,
      );
      io.out("  Rename one of them, on whichever device meant the other thing.");
    }
    if (r.inTheWay.some((b) => b.why !== undefined)) {
      io.out("  Rename one of them here. Nothing syncs under that name until you do.");
    }
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
  /**
   * Whether revoking the last device is meant, which the person says out loud.
   *
   * What it leaves is a vault only the recovery key can reach: a real thing to
   * want after a house fire, and not a thing to discover you did by typing an
   * id off a list.
   */
  allowLast: boolean;
  /**
   * The vault's recovery key, for the two device-list commands that can be run
   * with it instead of this device's own credential.
   *
   * Revoking the last device needs it, because that is the one revocation
   * nothing on a device can undo. Listing takes it for the vault with no
   * device left to ask: eight rows that never connected refuse every
   * registration, and the ids to revoke have to come from somewhere.
   */
  recoveryKey?: string;
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
    allowLast: false,
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
    "--recovery-key",
  ]);
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (onlyPositional) {
      if (args.command === undefined) args.command = arg;
      else args.rest.push(arg);
      continue;
    }
    // Everything after `--` is a word rather than an option. A device id is
    // base64url and base64url's alphabet includes `-`, so `basalt revoke
    // -Xy...` was refused with "no such option" and there was no way to say
    // what was meant. Ids made here no longer start with one; ids from
    // anywhere else still can.
    if (arg === "--") {
      onlyPositional = true;
      continue;
    }
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
      case "--ttl":
        args.ttlMs = parseDuration(value!);
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
      case "--backup-taken":
        args.backupTaken = true;
        break;
      case "--allow-last":
        args.allowLast = true;
        break;
      case "--recovery-key":
        args.recoveryKey = value!;
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

/** A device that has not registered itself yet, which has reached no server. */
class Unconverted extends Error {}

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
