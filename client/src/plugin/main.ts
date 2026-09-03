/**
 * The plugin, which is a shell and nothing else.
 *
 * It assembles the same four objects the headless client assembles, hands them
 * to the same `Client` in core, and spends the rest of its life drawing a status
 * bar. Every sync decision is a layer down, in code that two engines and a real
 * Go server exercise in tests. If a decision ever appears in this file, it is in
 * the wrong file, because this is the one file that cannot be tested.
 *
 * ## There is no settings tab
 *
 * On purpose, and docs/design.md says why: every option multiplies a state
 * space nobody tested. There is one modal, it exists to pair a vault and to say
 * what is happening, and it has no options in it. Pairing is not a setting; it
 * happens once and then never again.
 *
 * ## What is not verified
 *
 * This file, and `vault.ts` beside it. Both need Obsidian running. Every
 * signature used here was read out of `obsidian.d.ts` rather than remembered,
 * which is as close as it gets until it runs in a vault.
 */

import {
  Modal,
  Notice,
  Platform,
  Plugin,
  Setting,
  setIcon,
  type TAbstractFile,
  type TextComponent,
} from "obsidian";

import { HistoryModal, when, type HistorySource } from "./history.ts";

import {
  Client,
  redeemInvite,
  runForever,
  summarise,
  wrappedForClaim,
  type ClientOptions,
  type DeletedList,
  type Version,
} from "../core/client.ts";
import { authToken, deriveKeys, generateSecret } from "../core/crypto.ts";
import type { SyncReport } from "../core/engine.ts";
import {
  decodeConfig,
  encodeConfig,
  formatPairing,
  isInvite,
  parseInvite,
  parseSetup,
  parsePairing,
  type DeviceConfig,
} from "../core/pairing.ts";
import { ProtocolError } from "../core/transport.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";

/** What the status bar is saying, which is also what the modal shows. */
type State =
  | { kind: "unpaired" }
  | { kind: "connecting" }
  /**
   * Settled, with what the last pass found.
   *
   * `refused` is how many files the vault holds that will not sync until a
   * person does something: written off for good, or blocked by a name that
   * is a file here and a folder elsewhere. A vault with one such file used to
   * show the same glyph as a clean one, which is rule 7 with the two
   * conditions that matter most collapsed.
   */
  | { kind: "synced"; summary: string; at: number; refused: number }
  /**
   * Working, and on what.
   *
   * Sending a large attachment is minutes inside one pass, and without this
   * the status shown is the previous pass's result, so working and idle look
   * exactly alike. The path rather than a percentage: what somebody wants to
   * know is whether it is doing something and what.
   */
  | { kind: "syncing"; path: string; since: number }
  /**
   * The last pass did not finish, and this is why.
   *
   * Not `synced`, whose glyph says the vault is as the server has it, and
   * not `stopped`, which says waiting will not help. The next pass may well
   * succeed; this one did not, and saying so is the honest state.
   */
  | { kind: "failed"; why: string; at: number }
  /**
   * `refused` is whether the failure was a handshake that never completed
   * with a server this plugin has never reached, which is when the origin
   * advice in the panel applies. A connection that was up and went is
   * ordinary network loss and the origin is known to be fine.
   */
  | { kind: "offline"; why: string; retryAt: number; refused: boolean }
  | { kind: "stopped"; why: string };

/** Where a restore landed, and whether it went any further. */
export interface Restored {
  readonly path: string;
  /** The upload afterwards succeeded. When false, `why` says what stopped it. */
  readonly sent: boolean;
  readonly why?: string;
}

export default class BasaltPlugin extends Plugin {
  private config: DeviceConfig | undefined;
  /** The connected client, or undefined between connections. */
  private client: Client | undefined;
  /**
   * The client of the current run from the moment it exists, connected or
   * not. `client` is set only once the handshake has succeeded, and a vault
   * unlinked during a slow handshake had no handle on the connection being
   * made with its old secret. This is that handle.
   */
  private live: Client | undefined;
  private state: State = { kind: "unpaired" };
  private statusEl: HTMLElement | undefined;
  private ribbonEl: HTMLElement | undefined;
  private running = false;

  /**
   * Which run is the current one. Bumped by every start, by unlink and by
   * unload, so a run that has been superseded can tell, and says nothing
   * when it has.
   */
  private generation = 0;
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  private workingTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Why the saved settings could not be read, while that is the case.
   *
   * Rule 2: an unreadable config is not an unpaired vault. The panel used to
   * branch on `paired` alone and offer the pairing form over a file it could
   * not read, and pairing writes a new root secret over the old one, after
   * which nothing already on the server can be decrypted here.
   */
  private unreadable: string | undefined;
  /** Whether this pairing has ever completed a handshake since the plugin loaded. */
  private everConnected = false;
  /** The pairing in progress, so a second press cannot start another. */
  private pairing: Promise<unknown> | undefined;
  /** What the notices have already said, so they say it once. */
  private announced = { skipped: 0, inTheWay: "" };
  /** What `onunload` started and could not wait for, for anything that can. */
  closing: Promise<void> | undefined;

  override async onload(): Promise<void> {
    // Obsidian mobile has no status bar, and the declaration says so:
    // addStatusBarItem is "not available on mobile". The ribbon is on both,
    // so the state goes there too: its tooltip is the same sentence, and it
    // is the thing somebody taps when they want to know.
    if (!Platform.isMobileApp) this.statusEl = this.addStatusBarItem();
    this.ribbonEl = this.addRibbonIcon("refresh-cw", "Basalt Sync", () =>
      new BasaltModal(this).open(),
    );

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: "show-status",
      name: "Show status",
      callback: () => new BasaltModal(this).open(),
    });
    this.addCommand({
      id: "recover-deleted",
      name: "Recover a deleted note",
      callback: () => new RecoverModal(this).open(),
    });
    this.addCommand({
      id: "version-history",
      name: "Show version history",
      // Checking rather than callback, so the command does not appear in
      // the palette while nothing is open for it to act on.
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.openHistory(file.path);
        return true;
      },
    });

    // Where somebody already looks for this: Obsidian Sync puts version
    // history on the file menu, so this goes in the same place.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!("extension" in file)) return;
        menu.addItem((item) =>
          item
            .setTitle("Basalt: version history")
            .setIcon("history")
            .onClick(() => this.openHistory(file.path)),
        );
      }),
    );

    // The same two operations without the UI, registered the way Obsidian
    // registers its own `sync:history` and `history:restore`.
    //
    // Guarded because this arrived in Obsidian 1.12.2 and the rest of what
    // this plugin needs is older. Calling a method that is not there throws
    // inside onload, which stops registration where it stands: everything
    // after it never happens and the plugin half exists, with nothing saying
    // why. Seen exactly that on a phone running a stale build.
    //
    // A block rather than an early return, because returning would skip the
    // vault event registration below and leave an older Obsidian syncing
    // only on the timer. The first version of this guard did exactly that.
    if (typeof this.registerCliHandler === "function") {
      this.registerCliHandler(
        "basalt:history",
        "List Basalt version history for a note",
        { path: { value: "<path>", description: "Vault path" } },
        async (flags) => this.cliHistory(String(flags["path"] ?? "")),
      );
      this.registerCliHandler(
        "basalt:restore",
        "Restore a Basalt version",
        {
          path: { value: "<path>", description: "Vault path" },
          uid: { value: "<n>", description: "Version uid", required: true },
        },
        async (flags) => this.cliRestore(String(flags["path"] ?? ""), Number(flags["uid"])),
      );
    }

    // Obsidian's own events, rather than a watcher. They are what the
    // platform gives, they work on mobile, and they say when to look rather
    // than what changed: the scan is what decides, and it re-reads the vault
    // every time, so a missed event costs latency and never correctness.
    //
    // Registered inside onLayoutReady because Obsidian's own docs say to:
    // "If you do not wish to receive create events on vault load, register
    // your event handler inside Workspace.onLayoutReady". Otherwise opening
    // a vault fires a create for every file in it. The coalescing below
    // would collapse them into one sync, so this is about not doing
    // thousands of pointless things rather than about correctness. The
    // callback runs immediately if the layout is already up.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", () => this.nudge()));
      this.registerEvent(this.app.vault.on("modify", () => this.nudge()));
      this.registerEvent(this.app.vault.on("delete", () => this.nudge()));
      // The old path is the whole point of this event. A rename that
      // arrives as a delete plus an add still moves the file, but it
      // retires the old path as a deletion, and the list of deleted notes
      // is then mostly phantoms of files that still exist under another
      // name. The engine turns the pair into one operation, and until
      // this line existed nothing ever told it one had happened.
      //
      // Through the client rather than straight to the engine, so it
      // waits for the pass in flight rather than moving an entry that
      // pass has in hand.
      this.registerEvent(
        this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
          void this.client?.noteRename(oldPath, file.path);
          this.nudge();
        }),
      );
    });

    try {
      this.config = await this.readConfig();
    } catch (err) {
      // Rule 2: an unreadable config is not an unpaired vault. Starting
      // over would generate a new root secret and make everything already
      // on the server undecryptable here.
      this.unreadable = (err as Error).message;
      this.setState({ kind: "stopped", why: this.unreadable });
      new Notice(`Basalt: ${this.unreadable}`, 10_000);
      return;
    }

    if (this.config) this.start();
    else this.setState({ kind: "unpaired" });
  }

  /**
   * Obsidian's unload is synchronous, so the close cannot be awaited here.
   *
   * It is started, and held in `closing` for anything that can wait. What
   * the generation bump guarantees is that the run being closed writes no
   * state and shows no notice from here on. The pass it may be finishing
   * still writes the index, and that is the one write that must complete:
   * an index behind its notes is safe, an index cut off mid-write is not.
   */
  override onunload(): void {
    this.running = false;
    this.generation++;
    this.clearTimers();
    const { live, client } = this.retireClients();
    this.closing = Promise.all([live?.close(), client?.close()])
      .then(() => undefined)
      .catch(() => undefined);
  }

  /* ------------------------------------------------------------ *
   * Running
   * ------------------------------------------------------------ */

  private start(): void {
    const config = this.config;
    if (!config || this.running) return;
    this.running = true;
    this.everConnected = false;
    this.announced = { skipped: 0, inTheWay: "" };
    // Every run is numbered, and only the newest one may speak. A single
    // boolean was not enough: unlinking cleared it, pairing again set it,
    // and the *previous* run woke from its backoff, read the new run's
    // flag, and carried on with the old vault's secret. It reconnected,
    // failed authentication, and its refusal put "Basalt has stopped: not
    // authorised for this vault" on screen while the real client was
    // syncing perfectly well behind it.
    const mine = ++this.generation;
    this.setState({ kind: "connecting" });

    void (async () => {
      // Anything thrown while assembling the client lands here, and this
      // is the only place it can be seen. Without the catch below it
      // becomes an unhandled rejection and the plugin simply never syncs,
      // with a status bar still saying "connecting".
      try {
        await this.runLoop(config, mine);
      } catch (err) {
        if (mine === this.generation) this.stop(err as Error);
      }
      if (mine === this.generation) this.running = false;
    })();
  }

  /**
   * Runs the loop, and once more with the derived key when that is the one
   * thing that can prove a spent bootstrap was ours.
   *
   * The first device claims the vault with the server's bootstrap token and
   * then drops the token from its settings. If the claim commits and its
   * reply is lost, or the drop fails to save, the next start offers the
   * token first and is refused, and the refusal is `auth`, which is also
   * what a wrong token or another device's vault produce. What does say
   * which is the key derived from this device's root secret: the server
   * accepting it proves the vault was claimed with this secret. That is the
   * one case in which the bootstrap is set aside and tried without, and the
   * original refusal is what gets reported if that fails too. The CLI's
   * `connectWith` makes the same call.
   */
  private async runLoop(config: DeviceConfig, mine: number): Promise<void> {
    const current = () => mine === this.generation;
    let attempt = config;
    let first: Error | undefined;
    for (;;) {
      const refusal = await this.runOnce(attempt, mine);
      if (!current() || refusal === undefined) return;
      if (attempt.bootstrap !== undefined && isAuth(refusal)) {
        first = refusal;
        const { bootstrap: _spent, ...withoutBootstrap } = attempt;
        attempt = withoutBootstrap;
        continue;
      }
      this.stop(first !== undefined && isAuth(refusal) ? first : refusal);
      return;
    }
  }

  /** One `runForever`, resolving with the refusal that ended it, if one did. */
  private async runOnce(config: DeviceConfig, mine: number): Promise<Error | undefined> {
    const current = () => mine === this.generation;
    let fatal: Error | undefined;
    await runForever(await this.clientOptions(config, mine), {
      onConnecting: (client) => {
        if (current()) this.live = client;
        else void client.close();
      },
      onClient: (client) => {
        if (!current()) return;
        this.client = client;
        if (!client) return;
        this.everConnected = true;
        // A connection means a bootstrap, if there was one, has been
        // spent. Keeping it is keeping a second secret that no longer
        // opens anything, and one the next start would offer first.
        if (this.config?.bootstrap) void this.forgetBootstrap();
      },
      onDisconnected: (cause, retryIn) => {
        if (!current()) return;
        this.working(undefined);
        this.setState({
          kind: "offline",
          why: cause.message,
          retryAt: Date.now() + retryIn,
          refused: false,
        });
      },
      onUnreachable: (cause, retryIn) => {
        if (!current()) return;
        this.working(undefined);
        this.setState({
          kind: "offline",
          why: cause.message,
          retryAt: Date.now() + retryIn,
          refused: !this.everConnected,
        });
      },
      onFatal: (cause) => {
        fatal = cause;
      },
      keepGoing: () => this.running && current(),
    });
    if (current()) this.live = undefined;
    return fatal;
  }

  /**
   * A refusal that would be repeated word for word forever: a bad token, or
   * a cursor the server says is impossible. Retrying is a loop that never
   * ends and never says why.
   *
   * On a pairing that has never connected, the likeliest cause is the
   * pairing itself, and the one thing that fixes that is offered by name.
   */
  private stop(cause: Error): void {
    this.working(undefined);
    this.setState({ kind: "stopped", why: cause.message });
    new Notice(
      this.everConnected
        ? `Basalt has stopped: ${cause.message}`
        : `Basalt could not join this vault: ${cause.message}. ` +
            `If the pairing string or setup string was wrong, unlink this vault from the Basalt panel and pair again.`,
      0,
    );
  }

  /**
   * Shows what is being worked on, without drowning the last real result.
   *
   * A pass over a settled vault visits every path and does nothing to any of
   * them, so reporting each one would replace a useful summary with a blur.
   * The state only moves once a path has been held for long enough to be
   * worth mentioning, which in a quiet vault is never.
   */
  private working(path: string | undefined): void {
    if (this.workingTimer !== undefined) clearTimeout(this.workingTimer);
    this.workingTimer = undefined;
    if (path === undefined) return;
    this.workingTimer = setTimeout(() => {
      this.workingTimer = undefined;
      this.setState({ kind: "syncing", path, since: Date.now() });
    }, 400);
  }

  private clearTimers(): void {
    if (this.nudgeTimer !== undefined) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = undefined;
    this.working(undefined);
  }

  /**
   * Drops the spent first-run token from the saved settings.
   *
   * Disk first, then memory. The first version did it the other way round
   * and did not wait for the save, so a save that failed left a file that
   * still had the token and a plugin that thought it had gone: after a
   * restart the spent token was offered first and refused, for ever. Now a
   * failed save leaves both agreeing that the token is still there, says
   * so, and the next connection tries again.
   */
  private async forgetBootstrap(): Promise<void> {
    const config = this.config;
    if (!config?.bootstrap) return;
    const { bootstrap: _spent, ...rest } = config;
    try {
      await this.saveData(encodeConfig(rest));
    } catch (err) {
      new Notice(
        `Basalt: the vault is claimed, but its first-run token could not be removed from ` +
          `${this.dataPath}: ${(err as Error).message}. It will be tried again on the next connection.`,
        10_000,
      );
      return;
    }
    // Only if nothing has replaced or removed the config meanwhile.
    if (this.config === config) this.config = rest;
  }

  private async clientOptions(config: DeviceConfig, mine: number): Promise<ClientOptions> {
    const current = () => mine === this.generation;
    const configDir = this.app.vault.configDir;
    const keys = await deriveKeys(config.secret);
    const derived = authToken(keys);
    const log = (message: string, ...rest: unknown[]) => console.info("Basalt:", message, ...rest);
    return {
      vault: new ObsidianVault(this.app.vault, configDir, log),
      store: this.indexStore(),
      keys,
      secret: config.secret,
      url: config.url,
      // The bootstrap while there is one, and what the root secret
      // derives once the vault has been claimed. `claim` goes every time
      // and a server that already knows its answer ignores it, so a
      // device never has to work out whether it is the first.
      token: config.bootstrap ?? derived,
      claim: derived,
      // A data key to claim with, while this device still holds the
      // bootstrap and so may be the first. The key the vault ends up with
      // comes back in `ready`; see the CLI's clientOptions for the same.
      ...(config.bootstrap !== undefined ? { wrapped: await wrappedForClaim(keys) } : {}),
      vaultId: config.vaultId,
      device: config.device,
      onProgress: (path) => {
        if (current()) this.working(path);
      },
      // Every pass, from one place, whatever started it. The ticker and an
      // arriving batch start passes this shell never sees begin, and a
      // status set only by the passes it asked for stuck on "Working on X"
      // after any of the others.
      onPass: (report) => {
        if (!current()) return;
        this.working(undefined);
        this.setState({
          kind: "synced",
          summary: summarise(report),
          at: Date.now(),
          refused: report.skipped + report.blocked,
        });
        this.announce(report);
      },
      // The engine's running commentary, which had nowhere to go.
      //
      // These are the lines that say why something did not sync: a file
      // written off for good, a path that is a file here and a folder
      // there, a retry and its reason, a platform that cannot stream. With
      // no log they went nowhere, so a vault with one file missing looked
      // exactly like a vault with none missing, and the only way to find
      // out was to attach a debugger.
      log,
    };
  }

  /**
   * This plugin's own folder, under Obsidian's config directory.
   *
   * `manifest.dir` is optional in the API. Interpolating it without looking
   * produces the literal path "undefined/index.json" at the vault root, which
   * is a perfectly ordinary folder as far as the never-sync list is concerned.
   * So it is checked, and a folder outside the config directory stops the
   * plugin rather than being used.
   */
  private pluginDir(): string {
    const configDir = this.app.vault.configDir;
    const dir = this.manifest.dir ?? `${configDir}/plugins/${this.manifest.id}`;
    if (dir !== configDir && !dir.startsWith(`${configDir}/`)) {
      throw new Error(
        `refusing to run: this plugin is installed at ${dir}, which is outside ${configDir}, ` +
          `so its index would sync to every other device`,
      );
    }
    return dir;
  }

  /**
   * Where the index goes: inside this plugin's own folder.
   *
   * That folder is under Obsidian's config directory, which never syncs, and
   * an index that synced would sync to itself and be overwritten by every
   * other device in turn.
   */
  private indexStore(): ObsidianIndexStore {
    return new ObsidianIndexStore(this.app.vault.adapter, `${this.pluginDir()}/index.json`);
  }

  /** Where Obsidian keeps this plugin's settings, for a message that names it. */
  get dataPath(): string {
    try {
      return `${this.pluginDir()}/data.json`;
    } catch {
      return `${this.manifest.dir ?? "this plugin's folder"}/data.json`;
    }
  }

  /**
   * Asks the live client to look, soon.
   *
   * Coalesced, because saving one file produces several events and copying a
   * folder in produces one per file. Without this the engine would start a
   * pass per event and spend the copy re-scanning.
   */
  private nudge(): void {
    if (!this.client) return;
    if (this.nudgeTimer !== undefined) clearTimeout(this.nudgeTimer);
    const mine = this.generation;
    // Plain setTimeout rather than window's. Obsidian runs in a renderer
    // where both exist, and the plain one also exists everywhere this can be
    // tested, which is the difference between a tested nudge and an
    // untested one.
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      if (mine !== this.generation) return;
      void this.client?.sync().then((report) => {
        // The state is set by onPass when the pass finished. When it did
        // not, nothing else would clear "Working on X".
        if (report === undefined && mine === this.generation) {
          this.passFailed("the last pass did not finish; the developer console has the reason");
        }
      });
    }, 400);
  }

  /** Syncs on demand, and says so, because a command with no feedback is a guess. */
  async syncNow(): Promise<void> {
    if (!this.config) {
      new Notice("Basalt: this vault is not paired yet.");
      new BasaltModal(this).open();
      return;
    }
    const client = this.client;
    if (!client) {
      new Notice(`Basalt: ${this.whyNoClient()}`);
      return;
    }
    // The write debounce is off for this one. It exists so that somebody
    // typing does not cause a push per keystroke, and the person who just
    // chose "sync now" has said otherwise. Reporting "up to date" while
    // their last paragraph sits unsent is the status rule 7 forbids.
    let report: SyncReport;
    try {
      report = await client.settle({ coalesceWrites: false });
    } catch (err) {
      // Both callers discarded this promise, so a pass that threw was a
      // person pressing a button and nothing happening.
      this.passFailed((err as Error).message);
      new Notice(`Basalt: sync failed: ${(err as Error).message}`, 10_000);
      return;
    }
    // The state was set by onPass, once per pass. This is the feedback the
    // command owes.
    new Notice(`Basalt: ${summarise(report)}`);
  }

  private passFailed(why: string): void {
    this.working(undefined);
    this.setState({ kind: "failed", why, at: Date.now() });
  }

  /**
   * Why there is no connection to use, in the words that fit the state.
   *
   * "It will sync as soon as it reconnects" was shown while stopped, which is
   * the one state in which it will not.
   */
  private whyNoClient(): string {
    switch (this.state.kind) {
      case "stopped":
        return `Basalt has stopped: ${this.state.why}. It will not reconnect until that is fixed.`;
      case "connecting":
        return "still connecting to the server.";
      case "unpaired":
        return "this vault is not paired yet.";
      default:
        return "not connected. It will sync as soon as it reconnects.";
    }
  }

  /**
   * Tells the user about the things that need a person.
   *
   * A conflict is an event and is announced each time it happens. A file
   * written off, or one blocked by a name that is a file here and a folder
   * there, is a state: it is true on every pass until somebody acts, and a
   * notice on every pass for it taught people to dismiss notices, which is
   * how the one that matters gets dismissed too. Those are announced when
   * the count or the names change and not otherwise.
   */
  private announce(report: SyncReport): void {
    if (report.conflicted > 0) {
      const n = report.conflicted;
      new Notice(
        `Basalt kept both versions of ${n} ${n === 1 ? "file" : "files"}. ` +
          `Look for "Conflicted copy" in the name.`,
        10_000,
      );
    }
    if (report.skipped !== this.announced.skipped) {
      this.announced.skipped = report.skipped;
      if (report.skipped > 0) {
        new Notice(`Basalt cannot sync ${report.skipped} file(s) and has stopped trying.`, 10_000);
      }
    }
    // Named, and left up longer, because this is the one refusal that waits on
    // a person. Nothing clears it until one of the two names changes, and a
    // notice saying only that something is in the way cannot be acted on.
    const names = [...new Set(report.inTheWay.map((b) => b.blockedBy))].sort();
    const key = report.inTheWay.length === 0 ? "" : `${report.blocked}:${names.join("\n")}`;
    if (key !== this.announced.inTheWay) {
      this.announced.inTheWay = key;
      if (key !== "") {
        new Notice(
          `Basalt cannot write ${report.blocked} file(s): ` +
            `${names.map((n) => `"${n}"`).join(", ")} ` +
            `${names.length === 1 ? "is a file" : "are files"} here and ` +
            `${names.length === 1 ? "a folder" : "folders"} on another device. ` +
            `Rename one, on whichever device meant the other thing.`,
          20_000,
        );
      }
    }
  }

  /* ------------------------------------------------------------ *
   * Pairing
   * ------------------------------------------------------------ */

  private async readConfig(): Promise<DeviceConfig | undefined> {
    const raw: unknown = await this.loadData();
    if (raw === null || raw === undefined) return undefined;
    return decodeConfig(raw, "the Basalt plugin's saved settings");
  }

  /**
   * Whether a pairing may be made now, and if not, why not.
   *
   * Re-pairing would replace the root secret, and everything already on the
   * server would stop being decryptable here. That holds for a config that
   * is there and for one that is there but unreadable, and it holds while a
   * pairing is still being made: two presses of the button used to make two
   * secrets, the second winning on disk while the first was the one running.
   */
  private refuseUnlessPairable(): void {
    if (this.unreadable !== undefined) {
      throw new Error(
        `the saved settings at ${this.dataPath} could not be read (${this.unreadable}), ` +
          `and pairing over them would replace the root secret they hold. Fix or move that file, then reload the plugin.`,
      );
    }
    if (this.config) throw new Error("this vault is already paired");
    if (this.pairing) throw new Error("a pairing is already in progress");
  }

  /** Runs one pairing at a time. */
  private async onePairing<T>(work: () => Promise<T>): Promise<T> {
    this.refuseUnlessPairable();
    const run = work();
    this.pairing = run;
    try {
      return await run;
    } finally {
      this.pairing = undefined;
    }
  }

  /**
   * Pairs this vault with one another device already has, and starts.
   *
   * Two kinds of string, and they are saved at different moments. A
   * recovery key is not consumed by looking, so the server is reached before
   * anything is saved: a string with a wrong address or a secret the server
   * does not know used to be saved and announced as paired, and the first
   * sign of it was a status bar saying offline or stopped, later. An invite
   * is spent the moment the server answers it, so what it hands over goes to
   * disk first and the run that follows is what reaches the server as a
   * device; a failure between the two would otherwise burn the invite and
   * keep nothing. Starting a vault saves first too, and `pairFirst` says why.
   */
  async pair(pairingString: string, device: string): Promise<void> {
    await this.onePairing(async () => {
      const name = deviceName(device);
      if (isInvite(pairingString)) {
        const invite = parseInvite(pairingString);
        const redeemed = await redeemInvite(invite, name);
        const config: DeviceConfig = {
          url: invite.url,
          vaultId: invite.vaultId,
          device: name,
          secret: redeemed.secret,
        };
        await this.saveData(encodeConfig(config));
        this.config = config;
        this.start();
        return;
      }
      const pairing = parsePairing(pairingString);
      const config: DeviceConfig = { ...pairing, device: name };
      const probe = new Client(await this.clientOptions(config, this.generation));
      try {
        await probe.connect();
      } finally {
        await probe.close();
      }
      await this.saveData(encodeConfig(config));
      this.config = config;
      this.start();
    });
  }

  /**
   * Starts a new vault from the one line the server printed: `host:3003#TOKEN`.
   *
   * It used to be two fields, and the server printed one line, so the line
   * had to be split by hand and nothing said so. Every device now pastes one
   * thing; only the thing differs.
   *
   * Saved before connecting, unlike `pair`, because here the handshake is
   * the claim: the server binds the vault to this device's key the moment
   * it says hello, and a root secret that had claimed a server without
   * being written down first is a vault nobody can ever open. So the secret
   * is on disk before the server hears of it, and a refusal on that first
   * connection is reported with the way out.
   */
  async pairFirst(setup: string, device: string): Promise<string> {
    return this.onePairing(async () => {
      const { url, token } = parseSetup(setup);
      const config: DeviceConfig = {
        url,
        vaultId: "default",
        device: deviceName(device),
        secret: generateSecret(),
        bootstrap: token,
      };
      await this.saveData(encodeConfig(config));
      this.config = config;
      this.start();
      return formatPairing(config);
    });
  }

  /* ------------------------------------------------------------ *
   * Recovery
   * ------------------------------------------------------------ */

  /**
   * Notes the server still holds and this vault does not.
   *
   * Needs a connection, and says so rather than showing an empty list. "There
   * is nothing to recover" and "I could not ask" are different answers, and
   * confusing them in a recovery tool is the worst place to do it.
   */
  async deletedNotes(limit?: number): Promise<DeletedList> {
    if (!this.client)
      throw new Error(`${this.whyNoClient()} There is no way to ask what the server has.`);
    return this.client.deleted(limit);
  }

  /**
   * Puts a note back, never over the top of something already there.
   *
   * What the deleted list hands over is the *deletion*, which is a version
   * like any other and has no content in it. What has to be restored is the
   * version before it, so that is looked up here rather than assumed.
   */
  async recover(deletion: Version): Promise<Restored> {
    if (!this.client) throw new Error(`${this.whyNoClient()} There is nothing to restore from.`);
    const version = await this.client.newestContentVersion(deletion.path);
    if (!version) {
      throw new Error(`the server holds no version of ${deletion.path} with any content in it`);
    }
    return this.restoreAndSend(version);
  }

  /**
   * Restores a version, then sends it, and keeps the two outcomes apart.
   *
   * The restore is local and durable the moment it returns. The send is a
   * sync, and a sync can fail for every ordinary reason. Reporting the pair
   * as one failure told somebody their restore had failed when the note was
   * on their disk, and a second attempt found the name occupied and made a
   * second copy beside the first.
   */
  private async restoreAndSend(version: Version): Promise<Restored> {
    if (!this.client) throw new Error(`${this.whyNoClient()} There is nothing to restore from.`);
    const done = await this.client.restore(version);
    try {
      // Sent now rather than at the next pass, so the other devices get it
      // without anybody having to know that they would not have.
      await this.client.settle({ coalesceWrites: false });
    } catch (err) {
      return { path: done.path, sent: false, why: (err as Error).message };
    }
    return { path: done.path, sent: true };
  }

  /**
   * Opens the history of one note.
   *
   * Refuses rather than opening an empty modal when there is no connection.
   * "Nothing to show" and "I could not ask" are different answers, and a
   * recovery tool is the worst place to confuse them.
   */
  openHistory(path: string): void {
    if (!this.client) {
      new Notice(`Basalt: ${this.whyNoClient()} There is no history to show.`, 8_000);
      return;
    }
    new HistoryModal(this.app, this.historySource(), path).open();
  }

  /** What HistoryModal needs, which is four calls and no plugin internals. */
  historySource(): HistorySource {
    return {
      history: async (path, opts) => {
        if (!this.client) throw new Error(this.whyNoClient());
        return this.client.history(path, opts);
      },
      contentAt: async (version) => {
        if (!this.client) throw new Error(this.whyNoClient());
        return new TextDecoder().decode(await this.client.contentAt(version));
      },
      restoreVersion: async (version) =>
        describeRestore(version, await this.restoreAndSend(version)),
      currentText: async (path) => {
        // The note can go between the look and the read: somebody deleting
        // it while its history is loading. That is a diff against nothing,
        // not a version that could not be read.
        try {
          return await this.app.vault.adapter.read(path);
        } catch {
          if (await this.app.vault.adapter.exists(path)) throw new Error(`cannot read ${path}`);
          return undefined;
        }
      },
    };
  }

  /**
   * The command-line pair. Everything is answered in the channel, because a
   * handler that throws answers with a stack trace, and "not connected" is
   * not an exceptional condition for a sync client.
   */
  private async cliHistory(path: string): Promise<string> {
    if (!path) return "Which note? basalt:history needs a path.";
    if (!this.client) return `Basalt is ${this.whyNoClient()}`;
    try {
      const versions = await this.client.history(path, { limit: 50 });
      if (versions.length === 0) return `No history found for ${path}.`;
      return versions
        .map((v) => `${v.uid}\t${new Date(v.mtime).toISOString()}\t${v.size} B\t${v.device}`)
        .join("\n");
    } catch (err) {
      return `Basalt could not ask: ${(err as Error).message}`;
    }
  }

  private async cliRestore(path: string, uid: number): Promise<string> {
    if (!path) return "Which note? basalt:restore needs a path.";
    if (!Number.isInteger(uid) || uid <= 0) return "Which version? basalt:restore needs a uid.";
    if (!this.client) return `Basalt is ${this.whyNoClient()}`;
    try {
      // Paged as far back as it has to go. One page of two hundred used to
      // be all that was looked at, and a version older than that was one
      // basalt:history would list and this would then say did not exist.
      const version = await this.client.findVersion(path, (v) => v.uid === uid);
      if (!version) return `No version ${uid} of ${path}.`;
      return describeRestore(version, await this.restoreAndSend(version));
    } catch (err) {
      return `Basalt could not restore: ${(err as Error).message}`;
    }
  }

  /**
   * The vault's recovery key, or undefined when this device is unpaired.
   *
   * The whole vault, past and future, in one string. Shown once when a vault
   * is started and otherwise only behind a warning; adding a device is
   * `createInvite`, which never shows it.
   */
  recoveryKey(): string | undefined {
    return this.config ? formatPairing(this.config) : undefined;
  }

  /**
   * A single-use invite for another device, from the live connection.
   *
   * Needs a connection, because the server has to store it, and says so
   * rather than handing over a string that would be refused.
   */
  async createInvite(ttlMs?: number): Promise<{ invite: string; expiresAt: number }> {
    const config = this.config;
    if (!config) throw new Error("this vault is not paired yet.");
    if (!this.client)
      throw new Error(`${this.whyNoClient()} There is no way to register an invite.`);
    // Its own connection, with the derived key. The live one may still be
    // the session that claimed the vault with the server's first-run token,
    // and the server refuses an invite from that session: it proved it held
    // the token, not the root it would be sealing. The vault is claimed by
    // now, so the derived key opens it whether or not the spent token has
    // been dropped from the saved settings yet.
    const { bootstrap: _spent, ...derived } = config;
    const probe = new Client(await this.clientOptions(derived, this.generation));
    try {
      await probe.connect();
      return await probe.invite(ttlMs);
    } finally {
      await probe.close();
    }
  }

  /**
   * Where this device and the server each are, for a panel that shows both.
   *
   * The two numbers are what makes "behind and nothing arriving" visible.
   * docs/design.md says the protocol cannot detect a server withholding
   * versions; a person looking at these two lines can.
   */
  cursors(): { local: number; server: number } | undefined {
    if (!this.client) return undefined;
    return { local: this.client.engine.status().cursor, server: this.client.serverCursor };
  }

  /**
   * Forgets the pairing. Every note stays where it is, on both ends.
   *
   * The index goes with it, and that is not tidiness. It records what this
   * device believes it has already synced. Left behind, the next pairing
   * starts from it: a cursor into a server that may be a different server, and
   * entries claiming files are up to date when nothing has been checked. The
   * device would skip uploading notes it had never sent.
   *
   * In this order, and each step waited for. First quiet: the run is
   * retired and its client closed, which waits for the pass in flight,
   * because that pass ends by saving the index this is about to remove.
   * Then the index, both copies, proven gone. Then the pairing on disk, and
   * only then the pairing in memory, so that at every step what the file
   * says and what this object says agree. A step that fails leaves the
   * vault paired and stopped, says so, and can be tried again.
   */
  async unlink(): Promise<void> {
    // Retires every run in flight. Closing the client is not enough: a run
    // whose client is closed simply reconnects, which is the whole point of
    // it.
    this.generation++;
    this.running = false;
    this.clearTimers();
    const { live, client } = this.retireClients();
    await live?.close();
    await client?.close();

    try {
      await this.indexStore().remove();
    } catch (err) {
      throw this.unlinkFailed(`the index could not be removed: ${(err as Error).message}`);
    }
    try {
      await this.saveData(null);
    } catch (err) {
      throw this.unlinkFailed(
        `the pairing could not be removed from ${this.dataPath}: ${(err as Error).message}`,
      );
    }
    this.config = undefined;
    this.setState({ kind: "unpaired" });
  }

  /** Takes the clients off the plugin, so nothing reaches for them again. */
  private retireClients(): { live: Client | undefined; client: Client | undefined } {
    const taken = { live: this.live, client: this.client };
    this.live = undefined;
    this.client = undefined;
    return taken;
  }

  private unlinkFailed(why: string): Error {
    // Still paired, on disk and here, and no longer running: stopped is
    // the honest state, and the panel still offers Unlink to try again.
    this.setState({ kind: "stopped", why: `unlink did not finish, ${why}. Try again` });
    return new Error(`unlink did not finish: ${why}`);
  }

  /* ------------------------------------------------------------ *
   * Saying what is happening
   * ------------------------------------------------------------ */

  private setState(state: State): void {
    this.state = state;
    if (this.statusEl) paintStatus(this.statusEl, state);
    // Where a phone can see it. `aria-label` is what Obsidian renders as a
    // ribbon tooltip, and it is also what a screen reader reads out.
    this.ribbonEl?.setAttribute("aria-label", `Basalt: ${longStatus(state)}`);
    for (const listener of this.listeners) listener(state);
  }

  private readonly listeners = new Set<(state: State) => void>();

  /** Lets the modal follow along while it is open. */
  watchState(listener: (state: State) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  get currentState(): State {
    return this.state;
  }

  get paired(): boolean {
    return this.config !== undefined;
  }

  /** Why the saved settings cannot be used, while that is so. */
  get configProblem(): string | undefined {
    return this.unreadable;
  }

  get deviceName(): string {
    return this.config?.device ?? "";
  }
}

/** Whether a refusal is the server saying this token opens nothing. */
function isAuth(err: Error): boolean {
  return err instanceof ProtocolError && err.code === "auth";
}

/**
 * The name this device goes by, from what was typed or from nothing.
 *
 * Two devices left blank used to both be "obsidian", and their conflict
 * copies were told apart only by the number `firstFreeName` appended. The
 * copies were never lost, but a name that says which device wrote it is the
 * point of having one in the filename, so a blank gets a short random tail.
 * Shown in the panel, editable nowhere, because there is no settings screen.
 */
function deviceName(typed: string): string {
  const name = typed.trim();
  if (name !== "") return name;
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return `obsidian-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** One sentence for a restore: where it landed, and whether it went further. */
function describeRestore(version: Version, done: Restored): string {
  const where =
    done.path === version.path
      ? `Restored ${done.path}.`
      : `Restored to ${done.path}, because something is already at ${version.path}.`;
  return done.sent
    ? `${where} Sent to your other devices.`
    : `${where} It is on this device and will be sent when the next sync succeeds: ${done.why}`;
}

/**
 * The first line of the recovery list: what can come back and what cannot.
 *
 * Counted apart. Every row used to be called recoverable, including the ones
 * drawn a few lines down as purged, and a list that says "all recoverable"
 * over a note whose content is gone tells somebody their note is safe when it
 * is not. The truncation wording is for the same reason: a short list that
 * looks complete is one somebody reads and concludes their note is gone.
 */
export function describeDeleted(list: DeletedList): string {
  const purged = list.notes.filter((n) => n.restorable === 0).length;
  const restorable = list.notes.length - purged;
  const parts: string[] = [];
  if (restorable > 0) {
    parts.push(
      `${restorable} ${restorable === 1 ? "note is" : "notes are"} recoverable. ` +
        `Restoring puts one back and sends it to your other devices.`,
    );
  }
  if (purged > 0) {
    parts.push(
      `${purged} ${purged === 1 ? "note is" : "notes are"} listed but cannot be restored: ` +
        `${purged === 1 ? "its" : "their"} history has been purged.`,
    );
  }
  if (list.more) {
    parts.push(
      `The server has older deletions than the ${list.notes.length} shown here; ` +
        `Show older lists more of them.`,
    );
  }
  return parts.join(" ");
}

/**
 * An icon and a tooltip, which is what Obsidian's own status items are.
 *
 * Text in the status bar was a whole sentence competing with the word count for
 * a strip that is one line tall, and it read as noise next to the icons either
 * side of it. The state is a glyph now and the sentence is the tooltip, which is
 * where somebody looks when the glyph is not enough.
 */
function paintStatus(el: HTMLElement, state: State): void {
  el.empty();
  el.removeClass("basalt-attention", "basalt-working");
  const icon = el.createSpan({ cls: "basalt-status-icon" });
  setIcon(icon, iconFor(state));
  // Only when there is one. The settled state has no tone, and addClass with
  // an empty string throws: "The token provided must not be empty", which
  // arrives as a sync error about a DOMTokenList and says nothing about the
  // status bar it came from.
  const tone = toneFor(state);
  if (tone !== "") el.addClass(tone);
  // Both, because Obsidian styles aria-label as its own tooltip and a plain
  // title is what shows if it ever stops.
  el.setAttribute("aria-label", `Basalt Sync: ${longStatus(state)}`);
  el.setAttribute("title", `Basalt Sync: ${longStatus(state)}`);
}

/**
 * Which glyph. Settled and working are different glyphs and not the same
 * one spinning or not, because a spin is not something a glance can see.
 * Settled with files that need a person is not the plain check either.
 */
function iconFor(state: State): string {
  switch (state.kind) {
    case "unpaired":
      return "link";
    case "connecting":
    case "syncing":
      return "refresh-cw";
    case "synced":
      return state.refused > 0 ? "alert-circle" : "check";
    case "offline":
      return "cloud-off";
    case "failed":
    case "stopped":
      return "alert-triangle";
  }
}

function toneFor(state: State): string {
  switch (state.kind) {
    case "stopped":
    case "failed":
      return "basalt-attention";
    // No tone. These used --text-faint, which measures 2.57:1 against the
    // status bar in dark and 2.12:1 in light, under the 3:1 that a UI icon
    // needs to be made out. Offline in particular is the state that means
    // notes are not reaching the server, and it was the least legible thing
    // on the screen. Untinted, they inherit the status bar's own colour and
    // sit at the same weight as every item beside them; the glyph is what
    // tells them apart.
    case "offline":
    case "unpaired":
      return "";
    case "connecting":
    case "syncing":
      return "basalt-working";
    case "synced":
      return state.refused > 0 ? "basalt-attention" : "";
  }
}

/**
 * The whole interface: what is happening, and pairing when there is none.
 *
 * Deliberately not a settings tab. There are no options here, and there is not
 * going to be a place to put any.
 */
class BasaltModal extends Modal {
  private unwatch: (() => void) | undefined;

  constructor(private readonly plugin: BasaltPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.unwatch?.();
    this.freshRecoveryKey = undefined;
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    this.unwatch?.();
    contentEl.empty();
    contentEl.createEl("h2", { text: "Basalt Sync" });

    const problem = this.plugin.configProblem;
    if (problem !== undefined) {
      this.renderUnreadable(contentEl, problem);
      return;
    }
    if (!this.plugin.paired) {
      this.renderPairing(contentEl);
      return;
    }

    const status = contentEl.createEl("p");
    const cursors = contentEl.createEl("p", { cls: "basalt-advice" });
    const advice = contentEl.createEl("p", { cls: "basalt-advice" });
    this.unwatch = this.plugin.watchState((state) => {
      status.setText(longStatus(state));
      // Both cursors, so "behind and nothing arriving" is something a person
      // can see (I11).
      const at = this.plugin.cursors();
      cursors.setText(
        at === undefined ? "" : `Local cursor ${at.local}, server cursor ${at.server}.`,
      );
      // The server refuses a browser origin it does not know, and the
      // only thing that knows this device's origin is this device. The
      // desktop one is in the built-in list; the mobile ones are
      // Capacitor's documented defaults and have never been checked
      // against a device, so a phone that has never got through should
      // be able to say what to add rather than leaving somebody to guess.
      // A connection that was up and went is not that: the origin was
      // fine, the network is not.
      advice.setText(
        state.kind === "offline" && state.refused
          ? `If it never connects, this device's origin is ${origin()}. ` +
              `A server that does not know it refuses the connection, and logs the same thing. ` +
              `Restart it with -allow-origin ${origin()}`
          : "",
      );
    });

    new Setting(contentEl)
      .setName("Sync now")
      .setDesc("Basalt syncs on its own. This is for when you want to be sure.")
      .addButton((b) =>
        b.setButtonText("Sync").onClick(async () => {
          await this.plugin.syncNow();
        }),
      );

    if (this.freshRecoveryKey !== undefined)
      this.renderRecoveryKey(contentEl, this.freshRecoveryKey);

    // Where an invite goes: on screen, always, because the string is the
    // whole of what the other device needs and a phone may have no
    // clipboard to put it in.
    const shown = contentEl.createEl("p", { cls: "basalt-pairing" });
    const expiry = contentEl.createEl("p", { cls: "basalt-advice" });
    let currentInvite = "";
    new Setting(contentEl)
      .setName("Add another device")
      .setDesc(
        `This device is "${this.plugin.deviceName}". An invite works once, for ten minutes, ` +
          "and carries no secret of its own: the other device fetches the vault's key with it.",
      )
      .addButton((b) =>
        b.setButtonText("Create invite").onClick(async () => {
          try {
            const issued = await this.plugin.createInvite();
            currentInvite = issued.invite;
            shown.setText(issued.invite);
            expiry.setText(
              `Paste it into Basalt on the new device. It works once and expires at ${when(issued.expiresAt)}.`,
            );
            await copyToClipboard(
              issued.invite,
              "Copied. Paste it into Basalt on the other device.",
            );
          } catch (err) {
            new Notice(`Basalt: ${(err as Error).message}`, 10_000);
          }
        }),
      )
      .addButton((b) =>
        b.setButtonText("Copy").onClick(async () => {
          if (currentInvite === "") {
            new Notice("Create an invite first.");
            return;
          }
          await copyToClipboard(currentInvite, "Copied. Paste it into Basalt on the other device.");
        }),
      );

    new Setting(contentEl)
      .setName("Recover a deleted note")
      .setDesc("The server keeps every version of everything, including what you have deleted.")
      .addButton((b) =>
        b.setButtonText("Browse deleted").onClick(() => {
          this.close();
          new RecoverModal(this.plugin).open();
        }),
      );

    // Behind a button and a warning, and not on the path anybody takes to
    // add a device. This is the whole vault; what it is for is the day every
    // device is lost, and the way to have it then is to have written it
    // down.
    const keyShown = contentEl.createEl("p", { cls: "basalt-pairing" });
    new Setting(contentEl)
      .setName("Recovery key")
      .setDesc(
        "The vault's root secret. Anyone who has it has the vault, past and future. " +
          "It is for writing down in case every device is lost, not for adding one: use an invite for that.",
      )
      .addButton((b) =>
        b
          .setButtonText("Show recovery key")
          .setWarning()
          .onClick(() => {
            keyShown.setText(this.plugin.recoveryKey() ?? "");
          }),
      );

    new Setting(contentEl)
      .setName("Unlink this vault")
      .setDesc("Stops syncing. Every note stays where it is, here and on the server.")
      .addButton((b) =>
        b
          .setButtonText("Unlink")
          .setWarning()
          .onClick(async () => {
            try {
              await this.plugin.unlink();
            } catch (err) {
              new Notice(`Basalt: ${(err as Error).message}`, 10_000);
            }
            this.render();
          }),
      );
  }

  /**
   * A config that is there and cannot be read gets no pairing form.
   *
   * Pairing writes a new root secret over the old one, and everything on the
   * server would then be undecryptable from here. The only safe offers are
   * the reason and the path.
   */
  private renderUnreadable(contentEl: HTMLElement, problem: string): void {
    contentEl.createEl("p", { text: `Basalt has stopped: ${problem}` });
    contentEl.createEl("p", {
      text:
        `The saved settings are in ${this.plugin.dataPath}. Pairing again would replace the ` +
        `root secret they hold, so nothing here will do that. Fix or move the file, then reload the plugin.`,
    });
  }

  private renderPairing(contentEl: HTMLElement): void {
    contentEl.createEl("p", {
      text:
        "This vault is not paired yet. If another device already has the vault, create an invite there " +
        "and paste it here. The vault's recovery key works too.",
    });

    // The fields are read when a button is pressed rather than tracked
    // through input events. One less thing between what was typed and what
    // is used, and it is what makes this reachable from a test.
    let deviceField: TextComponent | undefined;
    let pairingField: TextComponent | undefined;
    const device = () => deviceField?.getValue() ?? "";

    new Setting(contentEl)
      .setName("Device name")
      .setDesc("Appears in version history and conflict copy names. Left blank, one is made up.")
      .addText((t) => {
        t.setPlaceholder("laptop");
        deviceField = t;
      });

    new Setting(contentEl)
      .setName("Invite or recovery key")
      .setDesc(
        "An invite from Basalt on a device that already has this vault, or the vault's recovery key.",
      )
      .addText((t) => {
        t.setPlaceholder("basalt3i_...");
        pairingField = t;
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Pair")
        .setCta()
        .onClick(async () => {
          try {
            await this.plugin.pair(pairingField?.getValue() ?? "", device());
            // Reached the server, so this is true. It is syncing only
            // once the loop says so, and the panel follows the loop.
            new Notice("Paired. Basalt is connecting.");
            this.render();
          } catch (err) {
            new Notice(`Basalt: ${(err as Error).message}`, 10_000);
          }
        }),
    );

    contentEl.createEl("h3", { text: "Or start a new vault" });
    contentEl.createEl("p", {
      text: "Only for the first device. Paste the line the server printed when it first started.",
    });

    let setupField: TextComponent | undefined;
    new Setting(contentEl)
      .setName("Setup string")
      .setDesc("Looks like homelab:3003#TOKEN. Behind TLS, use that hostname in front of the #.")
      .addText((t) => {
        t.setPlaceholder("homelab:3003#K7M2PQR4-...");
        setupField = t;
      });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Start a new vault").onClick(async () => {
        try {
          const key = await this.plugin.pairFirst(setupField?.getValue() ?? "", device());
          // Shown once, in this panel, until it is closed. Not a notice,
          // which goes away on its own, and not stored anywhere it could
          // be shown again by accident.
          this.freshRecoveryKey = key;
          new Notice(
            "Vault started. Basalt is connecting. Write down the recovery key shown in this panel.",
          );
          this.render();
        } catch (err) {
          new Notice(`Basalt: ${(err as Error).message}`, 10_000);
        }
      }),
    );
  }

  /** The recovery key of a vault this panel just started, shown once. */
  private freshRecoveryKey: string | undefined;

  private renderRecoveryKey(contentEl: HTMLElement, key: string): void {
    contentEl.createEl("h3", { text: "Write this down" });
    contentEl.createEl("p", {
      text:
        "This is the vault's recovery key. It is the only way back into the vault if every device is lost, " +
        "and anyone who has it has the vault. Keep it offline. It is shown here once; " +
        "adding a device does not need it.",
    });
    contentEl.createEl("p", { cls: "basalt-pairing", text: key });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("I have written it down").onClick(() => {
        this.freshRecoveryKey = undefined;
        this.render();
      }),
    );
  }
}

/**
 * Copies to the clipboard where there is one, and says so either way.
 *
 * Not every place this runs has a clipboard: mobile webviews and pages
 * outside a secure context do not. A button that silently does nothing is
 * worse than one that says the string is on screen to copy by hand, which it
 * always is.
 */
async function copyToClipboard(text: string, said: string): Promise<void> {
  const clipboard = (
    globalThis as { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } }
  ).navigator?.clipboard;
  try {
    if (!clipboard) throw new Error("no clipboard here");
    await clipboard.writeText(text);
    new Notice(said);
  } catch {
    new Notice("This device has no clipboard. The string is shown in the panel, to copy by hand.");
  }
}

/**
 * What the server still has and this vault does not.
 *
 * The only interface to the safety net. Deliberately a list of notes and a
 * button each, with no options: recovery is something somebody reaches for once
 * in a bad afternoon, and it should not be a thing to learn.
 */
class RecoverModal extends Modal {
  /** How many to ask for; undefined is the server's default. */
  private limit: number | undefined;

  constructor(private readonly plugin: BasaltPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    void this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Deleted notes" });

    let deleted: DeletedList;
    try {
      deleted = await this.plugin.deletedNotes(this.limit);
    } catch (err) {
      // Not an empty list. "There is nothing to recover" and "I could not
      // ask" are different answers and this is the worst place to confuse
      // them.
      contentEl.createEl("p", { text: `Cannot ask the server: ${(err as Error).message}` });
      return;
    }

    if (deleted.notes.length === 0) {
      contentEl.createEl("p", { text: "Nothing has been deleted from this vault." });
      return;
    }

    contentEl.createEl("p", { text: describeDeleted(deleted) });
    if (deleted.more) {
      // Never a short list that looks complete, and never a pointer at a
      // command line this plugin's users may not have.
      new Setting(contentEl)
        .setName("Show older")
        .setDesc("The server has more deletions than are listed here.")
        .addButton((b) =>
          b.setButtonText("Show older").onClick(async () => {
            this.limit = deleted.notes.length * 2;
            await this.render();
          }),
        );
    }

    for (const version of deleted.notes) {
      const deletedAt = when(version.mtime);
      if (version.restorable === 0) {
        // Listed, and honestly. A purge keeps only the newest version
        // per path, which for a deleted note is the deletion itself, so
        // this one is a record of something with nothing left behind
        // it. Offering a button that could only fail would be worse.
        new Setting(contentEl)
          .setName(version.path)
          .setDesc(
            `Deleted ${deletedAt}. Its history has been purged, so there is nothing to restore.`,
          );
        continue;
      }
      new Setting(contentEl)
        .setName(version.path)
        .setDesc(`Deleted ${deletedAt}, last written on ${version.device}`)
        .addButton((b) =>
          b
            .setButtonText("Restore")
            .setCta()
            .onClick(async () => {
              try {
                const done = await this.plugin.recover(version);
                new Notice(describeRestore(version, done), done.sent ? undefined : 10_000);
                await this.render();
              } catch (err) {
                new Notice(`Basalt: ${(err as Error).message}`, 10_000);
              }
            }),
        );
    }
  }
}

/**
 * This device's browser origin, which is what a server checks a plugin against.
 *
 * `app://obsidian.md` on desktop, and something Capacitor chooses on a phone.
 * Read rather than assumed, because the assumption is the thing that might be
 * wrong.
 */
function origin(): string {
  const l = (globalThis as { location?: { origin?: string } }).location;
  return l?.origin ?? "unknown";
}

/**
 * The time of day, without seconds. A status line is read at a glance and
 * "1:00:37 PM" is not read any differently from "1:00 PM"; the history modal
 * has always printed it this way.
 */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function longStatus(state: State): string {
  switch (state.kind) {
    case "unpaired":
      return "Not paired.";
    case "connecting":
      return "Connecting.";
    case "syncing":
      return `Working on ${state.path}.`;
    case "synced":
      return state.refused > 0
        ? `${state.summary}, as of ${clock(state.at)}. ${state.refused} ${state.refused === 1 ? "file needs" : "files need"} attention.`
        : `${state.summary}, as of ${clock(state.at)}.`;
    case "failed":
      return `Last sync failed at ${clock(state.at)}: ${state.why}. It will try again.`;
    case "offline":
      return `Offline: ${state.why}. Trying again shortly.`;
    case "stopped":
      return `Stopped: ${state.why}. This will not fix itself by waiting.`;
  }
}
