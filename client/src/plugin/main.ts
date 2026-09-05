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

import {
  HistoryModal,
  describeRestore,
  when,
  type HistorySource,
  type Restored,
} from "./history.ts";

import {
  Client,
  Registrar,
  adviseAfterRegistering,
  attentionLines,
  needsAttention,
  rebaseCursors,
  redeemInvite,
  refuseUnlessAhead,
  registerAsDevice,
  whatTheDiskHolds,
  runForever,
  summarise,
  credentialsFor,
  type ClientOptions,
  type DeletedList,
  type DeviceRow,
  type InviteRow,
  type Version,
} from "../core/client.ts";
import { generateSecret } from "../core/crypto.ts";
import { REJOIN_ADVICE, type SyncReport } from "../core/engine.ts";
import {
  decodeConfig,
  deviceCredential,
  encodeConfig,
  formatPairing,
  isInvite,
  parseInvite,
  parseSetup,
  parsePairing,
  type DeviceConfig,
  type Invite,
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
  /**
   * Stopped, and whether there is a recovery to offer for it.
   *
   * `rejoin` is set for the one refusal that has a button behind it: the
   * server is behind this device, which is what a restore from an older
   * backup looks like. The panel showed the reason and nothing else, and the
   * reason pointed at docs/server.md, which is not somewhere a phone goes at
   * the moment its notes have stopped syncing. See `recoveryFor`.
   */
  | { kind: "stopped"; why: string; recovery?: "rejoin" };

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
   * not read, and pairing writes new credentials over the old ones, after
   * which the device row this vault already has is stranded and, if the string
   * belonged to another vault, nothing on the server can be decrypted here.
   */
  private unreadable: string | undefined;
  /** Whether this pairing has ever completed a handshake since the plugin loaded. */
  private everConnected = false;
  /** The pairing in progress, so a second press cannot start another. */
  private pairing: Promise<unknown> | undefined;
  /** What the notices have already said, so they say it once. */
  private announced = { attention: "" };
  /** What `onunload` started and could not wait for, for anything that can. */
  closing: Promise<void> | undefined;
  /**
   * Every settle save in flight, so `unlink` cannot be overtaken by one.
   *
   * All of them, not the newest. Two reconnects inside one unlink window
   * start two saves, and holding only the second left the first free to land
   * its pairing on top of the null that unlink had just written (R10).
   */
  private readonly settling = new Set<Promise<void>>();

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
    this.announced = { attention: "" };
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
   * Checks there is something to connect with, then runs the loop.
   *
   * There is one credential and no list of candidates to try. Protocol 3 kept
   * one here, because a device might have been holding a spent bootstrap, a
   * rotation whose reply was lost, or the vault's root, and the connection was
   * where it found out which. A paired device holds one credential for one row
   * and either it opens the vault or nothing on this phone does.
   *
   * So the check in front of the loop is not a step that can be resumed, it is
   * a refusal. A config that holds no credential is one a pairing left behind
   * unfinished, and there is nothing this can do about it that a person cannot
   * see: it stops with `deviceCredential`'s words, which name what is missing
   * and, if the vault's root is still here, print the recovery key so the vault
   * can be paired again rather than lost. Retrying it forever instead would sit
   * there saying "connecting" about a connection nothing was going to make.
   */
  private async runLoop(config: DeviceConfig, mine: number): Promise<void> {
    const current = () => mine === this.generation;
    try {
      deviceCredential(config);
    } catch (err) {
      if (current()) this.stop(err as Error);
      return;
    }
    const refusal = await this.runOnce(config, mine);
    if (!current() || refusal === undefined) return;
    this.stop(refusal);
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
        // Nothing to write back. A connection used to settle which of several
        // credentials had opened the vault, whether the first-run token was
        // spent and what the vault's wrapped data key was; all three are
        // settled by the registration that made this device, before it ever
        // connects, and a connection now proves only what it says it proves.
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
    const recovery = recoveryFor(cause);
    this.setState({
      kind: "stopped",
      why: cause.message,
      ...(recovery !== undefined ? { recovery } : {}),
    });
    new Notice(
      recovery !== undefined
        ? `Basalt has stopped: ${cause.message}. ${REJOIN_ADVICE}`
        : this.everConnected
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

  private async clientOptions(config: DeviceConfig, mine: number): Promise<ClientOptions> {
    const current = () => mine === this.generation;
    const configDir = this.app.vault.configDir;
    const log = (message: string, ...rest: unknown[]) => console.info("Basalt:", message, ...rest);
    return {
      vault: new ObsidianVault(this.app.vault, configDir, log),
      store: this.indexStore(),
      // Which key authenticates and what the vault is bound to, worked out in
      // core so that both shells cannot answer it differently.
      ...(await credentialsFor(config)),
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
          // The same pair the exit code is built from and the same pair the
          // needs-attention list holds, through the one helper, so the glyph,
          // the sentence and the notice cannot start counting different things.
          refused: needsAttention(report),
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
    // Numbered like every other run. A pass takes as long as it takes, and
    // unlinking during one used to leave its result speaking for a vault
    // that is no longer paired: a summary notice over an unpaired panel, or
    // `failed` painted over `unpaired` when the closed client rejected.
    const mine = this.generation;
    // The write debounce is off for this one. It exists so that somebody
    // typing does not cause a push per keystroke, and the person who just
    // chose "sync now" has said otherwise. Reporting "up to date" while
    // their last paragraph sits unsent is the status rule 7 forbids.
    let report: SyncReport;
    try {
      report = await client.settle({ coalesceWrites: false });
    } catch (err) {
      if (mine !== this.generation) return;
      // Both callers discarded this promise, so a pass that threw was a
      // person pressing a button and nothing happening.
      this.passFailed((err as Error).message);
      new Notice(`Basalt: sync failed: ${(err as Error).message}`, 10_000);
      return;
    }
    if (mine !== this.generation) return;
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
    // One notice where there were two, for the reason on the report's
    // `needsAttention`: "written off" and "blocked by a name" are two of our
    // categories and one of a person's, and it was the two notices that made
    // somebody learn the difference before they could act. What differs is the
    // reason, and the reason is now what the notice carries.
    //
    // Keyed on which files and which reasons, not how many (N2). One file
    // fixed in the same pass as another starts failing leaves the count where
    // it was, and the new failure went unannounced for as long as the numbers
    // matched: the glyph said something was wrong and nothing ever said what.
    //
    // `?? []` because the type promises the list and a hand-built report may
    // not keep it: announcing must never throw over the notice it owes.
    const attention = report.needsAttention ?? [];
    const count = needsAttention(report);
    const key =
      count === 0 ? "" : `${count}:${attention.map((a) => `${a.path} ${a.why}`).join("\n")}`;
    if (key !== this.announced.attention) {
      this.announced.attention = key;
      if (count > 0) {
        // Named, because a count is not something anybody can act on. The
        // list is bounded, so `attentionLines` says when it is not the whole
        // of it. A report that named nothing still says the count.
        const detail = attentionLines(report).join(" ");
        new Notice(
          `Basalt cannot sync ${count} file(s).${detail === "" ? "" : ` ${detail}`}`,
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
          `and pairing over them would replace the credential they hold. Fix or move that file, then reload the plugin.`,
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
   * Adds this vault to one that already exists, with an invite or with the
   * vault's recovery key.
   *
   * An invite is the ordinary way and the recovery key is the last resort.
   * Both end with this device holding a row of its own, the credential for it
   * and the vault's data key, and no root, which is what makes revoking this
   * phone on its own mean anything.
   *
   * An **invite** is spent by the very exchange that registers this device, so
   * there is nothing to save until the server has answered and everything to
   * save the moment it has. A failure before the reply leaves this vault
   * unpaired and one row on the server that nobody holds the key to, which is
   * visible in the device list as a device that has never connected; the other
   * ordering strands this phone instead. See `redeemInvite`.
   *
   * A **recovery key** buys a registrar session, which may register a device
   * and may not sync, so that path is register-then-save and nothing is
   * written until the row exists. The key was pasted in a moment ago, so there
   * is nothing on this phone yet worth keeping and a key the vault does not
   * know should leave it exactly as unpaired as it was found. The registration
   * is *awaited*, so the server has answered before this reports a paired
   * vault: a wrong address or a wrong key used to be saved and announced as
   * paired, and the first sign of it was a status bar saying stopped, later
   * (C39, I13). See `registerAsDevice`.
   */
  async pair(pairingString: string, device: string): Promise<void> {
    await this.onePairing(async () => {
      const name = deviceName(device);
      if (isInvite(pairingString))
        return await this.pairWithInvite(parseInvite(pairingString), name);
      const pairing = parsePairing(pairingString);
      const mine = this.generation;
      let registered = false;
      let paired: DeviceConfig;
      try {
        paired = await registerAsDevice(
          {
            url: pairing.url,
            vaultId: pairing.vaultId,
            device: name,
            secret: pairing.secret,
          },
          (next) => this.saveDuringRun(mine, next),
          {
            onRegistered: () => {
              registered = true;
            },
            log: (message, ...rest) => console.info("Basalt:", message, ...rest),
          },
        );
      } catch (err) {
        if (!registered) throw err;
        // Registered, and then what the disk says rather than which step threw
        // (rule 4), through the counsellor the CLI's `init` and `pair` use.
        // The `.catch(() => undefined)` this read it with is what that
        // replaces: it made an unreadable data.json look like an absent one,
        // so a save that succeeded with a read-back that then failed was told
        // to revoke a row it was itself holding the key to.
        const remains = await whatTheDiskHolds(() => this.readConfig());
        if (remains.kind === "credential") {
          // The row is real and this phone holds the only copy of its
          // credential, so what was written stays and the panel says as much
          // rather than looking unpaired.
          this.config = remains.config;
          this.start();
        }
        throw new Error(
          `${(err as Error).message}. ` +
            adviseAfterRegistering({
              remains,
              registered,
              surface: "panel",
              where: this.dataPath,
            }),
        );
      }
      this.config = paired;
      this.start();
    });
  }

  /**
   * The invite half of pairing: redeem, save, start.
   *
   * The redemption is the registration, so what comes back is a finished
   * device: this config never holds a root, at any point.
   *
   * Saved and read back before the run starts, because at the moment the reply
   * lands the only copy of the data key on this phone is in memory and the
   * invite that carried it is already spent (rule 4).
   */
  private async pairWithInvite(invite: Invite, name: string): Promise<void> {
    const redeemed = await redeemInvite(invite, name, {
      log: (message, ...rest) => console.info("Basalt:", message, ...rest),
    });
    const config: DeviceConfig = {
      url: invite.url,
      vaultId: invite.vaultId,
      device: name,
      deviceId: redeemed.deviceId,
      deviceSecret: redeemed.deviceSecret,
      dataKey: redeemed.dataKey,
    };
    await this.saveVerified(config);
    this.config = config;
    this.start();
  }

  /**
   * Starts a new vault from the one line the server printed: `host:3003#TOKEN`.
   *
   * It used to be two fields, and the server printed one line, so the line
   * had to be split by hand and nothing said so. Every device now pastes one
   * thing; only the thing differs.
   *
   * The root is saved before anything is sent, because here the handshake is
   * the claim: the server binds the vault to this device's key the moment it
   * says hello, and a root secret that had claimed a server without being
   * written down first is a vault nobody can ever open. That save is the only
   * reason a config here ever holds a root, and the registration below
   * replaces it with this device's own credential.
   *
   * The claim and the registration are awaited rather than left to `start`,
   * so what comes back is a phone that has joined the vault or an error
   * saying it has not. If the claim went through and the registration did not,
   * the root is still on disk and every screen from here on prints the
   * recovery key out of it: the vault is recoverable by pairing again with
   * that key, which is what the words say.
   *
   * The recovery key is returned for the panel to show once, and this is the
   * only moment it exists anywhere: a paired device does not keep the root, on
   * purpose, and nothing here can print it again.
   */
  async pairFirst(setup: string, device: string): Promise<string> {
    return this.onePairing(async () => {
      const { url, token } = parseSetup(setup);
      const secret = generateSecret();
      const name = deviceName(device);
      const starting: DeviceConfig = { url, vaultId: "default", device: name, secret };
      await this.saveVerified(starting);
      this.config = starting;
      const recoveryKey = formatPairing({ url, vaultId: "default", secret });

      const mine = this.generation;
      let registered = false;
      try {
        this.config = await registerAsDevice(
          { url, vaultId: "default", device: name, secret, bootstrap: token },
          (next) => this.saveDuringRun(mine, next),
          {
            onRegistered: () => {
              registered = true;
            },
            log: (message, ...rest) => console.info("Basalt:", message, ...rest),
          },
        );
      } catch (err) {
        // The config stays, whatever it now holds. If it is still the root,
        // the claim may have committed with its reply lost and throwing it
        // away is a vault nothing will ever open again; `start` stops on it
        // and puts the recovery key on the panel, which is somewhere it can be
        // read from rather than a notice that goes. If the registration got as
        // far as saving a credential, that is what is on disk and `start`
        // connects with it. Read back rather than assumed (rule 4).
        const remains = await whatTheDiskHolds(() => this.readConfig());
        this.config = "config" in remains ? remains.config : starting;
        this.start();
        // The recovery key only when the root is still what is held: a
        // credential that landed has replaced it, and there is then nothing on
        // the panel to write down. The row this may have left is named by the
        // same counsellor the pairing form above uses, because a phone sent
        // straight back to pairing registers a second row and spends another
        // of the vault's eight slots.
        const writeItDown =
          remains.kind === "credential"
            ? ""
            : "Write the recovery key shown in the Basalt panel down now. ";
        throw new Error(
          `the vault was started but this device could not register itself with it: ` +
            `${(err as Error).message}. ${writeItDown}` +
            adviseAfterRegistering({
              remains,
              registered,
              surface: "panel",
              where: this.dataPath,
            }),
        );
      }
      this.start();
      return recoveryKey;
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
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is nothing to restore from.`);
    const mine = this.generation;
    const done = await client.restore(version);
    try {
      // Sent now rather than at the next pass, so the other devices get it
      // without anybody having to know that they would not have.
      await client.settle({ coalesceWrites: false });
    } catch (err) {
      // "It will be sent when the next sync succeeds" is only true while
      // there is a next sync. Unlinked mid-restore there is not one, and the
      // note is on this device and nowhere else, which is what it says.
      if (mine !== this.generation) {
        return {
          path: done.path,
          sent: false,
          willRetry: false,
          why: "this vault is no longer paired",
        };
      }
      return { path: done.path, sent: false, why: (err as Error).message };
    }
    // No staleness check on this side on purpose: the upload happened, so
    // "sent to your other devices" is true whatever became of the pairing
    // afterwards, and saying otherwise would be the same lie reversed.
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
      // The outcome, not a sentence: the modal says it with the same
      // describeRestore every other restore surface uses.
      restoreVersion: (version) => this.restoreAndSend(version),
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
   * Every device that may reach this vault, the cap on how many there may be,
   * and every invite that could still add one.
   *
   * Needs a connection, and says so rather than showing an empty list. "There
   * are no other devices" and "I could not ask" are different answers, and
   * this is the list somebody reads before deciding which one to cut off.
   *
   * The invites are part of the same answer. A row is a device that was added
   * and an outstanding invite is one about to be, and until they were listed a
   * string issued on a device somebody had just lost stayed invisible until
   * somebody redeemed it, for up to an hour.
   */
  async devices(): Promise<{
    devices: DeviceRow[];
    maxDevices: number;
    invites: InviteRow[];
    thisDevice: string;
  }> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is no way to ask what is paired.`);
    return { ...(await client.devices()), thisDevice: client.deviceId };
  }

  /**
   * A single-use invite for another device, from the live connection.
   *
   * Needs a connection, because the server has to store it, and says so rather
   * than handing over a string that would be refused.
   *
   * This is how a device is added. The recovery key is not: it is written down
   * and offline, no device holds one, and what an invite hands over is the
   * vault's data key, which is what a device holds anyway. The redemption
   * registers the new device's own row, so what appears in the list below is a
   * device that can be revoked on its own.
   */
  async createInvite(ttlMs?: number): Promise<{ invite: string; expiresAt: number }> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is no way to register an invite.`);
    return client.invite(ttlMs);
  }

  /**
   * Cancels an outstanding invite, so the string stops working before it
   * expires.
   *
   * The companion to being able to see one. Otherwise the only ways to retire
   * an invite issued on a device that has just been lost are to wait out its
   * hour or to replace the vault's secret, which retires the recovery key with
   * it.
   */
  async uninvite(invite: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is no way to cancel an invite.`);
    return client.uninvite(invite);
  }

  /**
   * Stops one device connecting, and closes whatever it has open.
   *
   * Both, and the reply means both. What it does not do is un-read what that
   * device already read: it still holds the vault's key for every note it had
   * synced, so a device that was stolen rather than lost wants a new vault
   * secret as well. Every surface that offers this has to say so, and the
   * panel does.
   *
   * No `allowLast`, and it is not an omission. Emptying the vault takes the
   * recovery key, no device holds one, and a plugin that offered the flag
   * would be offering a request the server can only refuse. The panel says so
   * where the button would have been.
   */
  async revoke(deviceId: string): Promise<{ self: boolean }> {
    const client = this.client;
    if (!client) throw new Error(`${this.whyNoClient()} There is no way to revoke a device.`);
    const { self } = await client.revoke(deviceId);
    if (self) {
      // Revoking this device is what unlinking is, from the server's side.
      // The connection is already closing behind the reply, so the run is
      // retired here rather than left to discover it by being refused.
      await this.quiet();
      this.setState({
        kind: "stopped",
        why:
          "this device was revoked and may no longer sync this vault. Unlink it to forget the " +
          "pairing, or pair again with the vault's recovery key.",
      });
    }
    return { self };
  }

  /** This device's own row id, so the panel can tell it out of the list. */
  get deviceId(): string | undefined {
    return this.config?.deviceId;
  }

  /* ------------------------------------------------------------ *
   * Rejoining a restored server, and retiring a leaked secret
   * ------------------------------------------------------------ */

  /**
   * Where this device and the server each are, asked of the server directly.
   *
   * `cursors()` below reads a live connection, and the device that needs these
   * two numbers is the one the server has refused: it has no live connection
   * and never will until this is dealt with. So this makes its own, carrying no
   * index, which is the only kind the server will talk to. Nothing is written.
   */
  async rejoinCursors(): Promise<{ local: number; server: number }> {
    const config = this.config;
    if (!config) throw new Error("this vault is not paired yet.");
    return rebaseCursors(await this.clientOptions(config, this.generation));
  }

  /**
   * Rejoins a server that has lost history this device already applied.
   *
   * The same operation as `basalt rebase --backup-taken`, and it exists here
   * because the documented alternative for a plugin device was to unlink and
   * pair again. Re-pairing throws away the index too, but it also throws away
   * the merge base: every note comes back as an ancestor-less new version, and
   * the next edit made on two devices at once cannot merge, so a restore was
   * followed by a conflict-copy storm on precisely the devices least able to
   * clean one up. A rebase keeps the pairing, so the ancestors the server
   * agrees with survive.
   *
   * Nothing is deleted, here or on the server: what both sides hold identically
   * is agreed again, what only this device holds goes up as new versions, and
   * where the two disagree both are kept.
   *
   * In this order, and each step waited for. First the two cursors, from a
   * connection that writes nothing, so a rebase that is not the answer is
   * refused before anything has been touched. Then quiet: the run is retired
   * and its clients closed, because the pass in flight ends by saving the index
   * this is about to remove and two engines on one index is the state the
   * single-flight rule exists to prevent. Then the index, both copies, proven
   * gone. Only then the server.
   *
   * Whatever happens after the index goes, the loop is started again: from that
   * moment this device has no record of what it had synced, and the only way it
   * gets one back is by reaching the server.
   */
  async rebase(): Promise<SyncReport> {
    const config = this.config;
    if (!config) throw new Error("this vault is not paired yet.");
    if (this.pairing) throw new Error("a pairing is already in progress");
    refuseUnlessAhead(await this.rejoinCursors());

    await this.quiet();
    const mine = this.generation;
    this.setState({ kind: "connecting" });

    try {
      // Inside the try, so that a removal that fails halfway still leaves the
      // loop running. It leaves this device where it was, refused by the
      // server, which is a state the panel offers this same row for; leaving
      // it stopped and not running would be a device that has to be reloaded
      // before it will even try again.
      await this.indexStore().remove();
      const client = new Client(await this.clientOptions(config, mine));
      try {
        await client.connect();
        // The write debounce is off, as it is for every pass a person asked
        // for by name: reporting "up to date" over an unsent paragraph is the
        // status rule 7 forbids.
        return await client.settle({ coalesceWrites: false });
      } finally {
        await client.close();
      }
    } finally {
      if (mine === this.generation) this.start();
    }
  }

  /**
   * Gives the vault a new root secret, keeping its history and its devices.
   *
   * The answer to a recovery key that has been somewhere it should not have
   * been. It takes that key as an argument, because no device holds one:
   * rotating is the root's own power and a device that held the root could
   * register itself again after being revoked, which is the whole thing
   * per-device credentials removed.
   *
   * **Every device keeps syncing across this, including this one.** A rotation
   * replaces the vault's secret and its wrapping of the data key, and touches
   * no device row. Under protocol 3 the vault's hash was the credential every
   * device held, so a rotation evicted the lot and each one had to be paired
   * again from the new string, which on a phone means typing it.
   *
   * The data key is this device's own, which is the vault's: a rotation
   * replaces the wrapping and never the key, so the copy a paired device holds
   * is always current and there is nothing to fetch before rewrapping it.
   *
   * The new recovery key is returned before the request goes out, and the
   * panel shows it before pressing on, because there is nowhere on a device to
   * stage a root any more: not holding one is the point. The server commits,
   * closes every other registrar and only then replies, so if that reply is
   * lost the only durable copy of the new key is the one somebody wrote down.
   * `settled` says whether the server was heard from.
   */
  async rotate(recoveryKey: string): Promise<{ recoveryKey: string; settled: boolean }> {
    const config = this.config;
    if (!config) throw new Error("this vault is not paired yet.");
    if (this.pairing) throw new Error("a pairing is already in progress");
    const { dataKey } = deviceCredential(config);
    const old = parsePairing(recoveryKey);
    if (old.vaultId !== config.vaultId) {
      throw new Error(
        `that recovery key is for vault "${old.vaultId}" and this one is paired with ` +
          `"${config.vaultId}", so it would replace the secret of a vault this device is not on`,
      );
    }

    const secret = generateSecret();
    const fresh = formatPairing({ url: config.url, vaultId: config.vaultId, secret });
    const registrar = await Registrar.open({
      url: config.url,
      vaultId: config.vaultId,
      device: config.device,
      secret: old.secret,
    });
    try {
      await registrar.rotate(secret, dataKey);
    } catch (err) {
      registrar.close();
      if (err instanceof ProtocolError && err.code === "rotated") {
        // Answered, and refused: somebody rotated first, so nothing committed
        // and this key is not the vault's. Putting a key that opens nothing in
        // front of somebody to write down is worse than saying so.
        throw new Error(
          "the vault's secret was replaced by somebody else first, so this was refused and no " +
            "new key was made. The recovery key you used has been retired too.",
        );
      }
      // No reply, and nothing here can tell a rotation that committed from one
      // that did not. So ask: the new root opens a registrar session if and
      // only if the server took it.
      const committed = await this.didRotate(config, secret).catch(() => undefined);
      if (committed === false) {
        throw new Error(
          `the vault's secret was not replaced: ${(err as Error).message}. ` +
            `It still has the recovery key you used.`,
        );
      }
      // Committed, or unknown. Either way the new key may be the vault's, and
      // it is returned so it can be written down; `settled` says which.
      return { recoveryKey: fresh, settled: committed === true };
    }
    registrar.close();
    return { recoveryKey: fresh, settled: true };
  }

  /** Whether a root secret opens this vault, which is whether a rotation to it committed. */
  private async didRotate(config: DeviceConfig, secret: Uint8Array): Promise<boolean> {
    try {
      const probe = await Registrar.open({
        url: config.url,
        vaultId: config.vaultId,
        device: config.device,
        secret,
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

  /**
   * Stops everything this plugin has running, and waits for it.
   *
   * What `unlink` does before it touches a file, and what `rebase` and `rotate`
   * need for the same reason: a run that is merely disconnected reconnects, a
   * pass in flight is still writing the index, and a settle save already past
   * its generation check is still going to write `data.json`. The bumped
   * generation is what stops another starting.
   */
  private async quiet(): Promise<void> {
    this.generation++;
    this.running = false;
    this.clearTimers();
    const { live, client } = this.retireClients();
    await live?.close();
    await client?.close();
    await Promise.all([...this.settling]);
  }

  /**
   * A config write made while something long-running is in flight, which
   * `unlink` can wait for and a retired run cannot make.
   *
   * R10, in the shape protocol 4 gives it. The write that used to be in flight
   * past a generation check was the settle that dropped a spent bootstrap; now
   * it is the save that records this device's own credential, made in the
   * middle of a registration that has already reached the server. The hazard
   * is the same: unlinking writes `null` over the pairing, and a save that
   * lands after it puts the pairing back, so memory says unpaired, the file
   * says paired, and the next start syncs a vault the person removed.
   *
   * Two halves, because either alone leaves a window. The write is registered
   * where `unlink` waits for it, and it refuses outright once its run has been
   * retired, which is what stops one that had not started yet.
   */
  private saveDuringRun(mine: number, config: DeviceConfig): Promise<void> {
    if (mine !== this.generation) {
      // Not an error to report: this run has been replaced or unlinked, and
      // what it belongs to should stop rather than finish writing.
      return Promise.reject(new Error("this vault is no longer paired"));
    }
    const saving = this.saveVerified(config);
    this.settling.add(saving);
    void saving.catch(() => undefined).finally(() => this.settling.delete(saving));
    return saving;
  }

  /**
   * Writes the pairing and reads it back before believing it.
   *
   * Rule 4: verify the outcome, not the exit code. The one write that cannot
   * afford to be taken on trust is the root a vault being started is saved
   * with, because the claim that binds the server to it goes out on the
   * strength of it. `decodeConfig` refuses a half-written config, so a torn
   * write is caught here rather than on the next start.
   */
  private async saveVerified(config: DeviceConfig): Promise<void> {
    const record = encodeConfig(config);
    await this.saveData(record);
    let back: DeviceConfig | undefined;
    try {
      back = await this.readConfig();
    } catch (err) {
      throw new Error(`${this.dataPath} could not be read back: ${(err as Error).message}`);
    }
    if (back === undefined || JSON.stringify(encodeConfig(back)) !== JSON.stringify(record)) {
      throw new Error(`${this.dataPath} did not read back as it was written`);
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
   * What this device is talking to, as far as it knows.
   *
   * Two halves with two lifetimes, which is why they come back together. The
   * address is the pairing's and is known whether or not anything is
   * connected; the protocol and the build are the server's own account of
   * itself, arrive in `ready`, and are gone again the moment the connection
   * is. Nothing here is asked for specially: it is what the client already
   * holds.
   */
  connection(): Connection | undefined {
    const url = this.config?.url;
    if (url === undefined) return undefined;
    const limits = this.client?.serverLimits;
    return {
      url,
      ...(limits !== undefined
        ? { server: { proto: limits.proto, version: limits.serverVersion } }
        : {}),
    };
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
    // Retires every run in flight, closes their clients, and waits for every
    // settle save that is already past its generation check, because each of
    // those is a write to the same file this is about to empty. See `quiet`.
    await this.quiet();

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

function offersRejoin(state: State): boolean {
  return state.kind === "stopped" && state.recovery === "rejoin";
}

function recoveryFor(cause: Error): "rejoin" | undefined {
  return cause instanceof ProtocolError && cause.code === "cursor" ? "rejoin" : undefined;
}

/**
 * The name this device goes by, from what was typed or from the suggestion.
 *
 * Two devices left blank used to both be "obsidian", and their conflict
 * copies were told apart only by the number `firstFreeName` appended. The
 * copies were never lost, but a name that says which device wrote it is the
 * point of having one in the filename, so a blank gets a suggestion. Shown in
 * the panel, editable nowhere afterwards, because there is no settings screen.
 */
function deviceName(typed: string): string {
  const name = typed.trim();
  return name === "" ? suggestedDeviceName() : name;
}

/**
 * A name to offer for this device: what kind of machine it is, and a short
 * random tail.
 *
 * The pairing form has always had a name field and never had anything in it,
 * so the honest thing to do with an empty field was leave it empty, and an
 * empty one became `obsidian-3f2a`. A device list read from inside Obsidian,
 * every row of which says Obsidian, identifies nothing. The CLI has had the
 * better answer since it existed, the hostname and a tail (`deviceNameFor` in
 * cli/cli.ts), and this is as near as a plugin gets: a phone has no hostname
 * and the mobile bundle has no `os` module, but `Platform` says what kind of
 * machine this is.
 *
 * The tail is the CLI's own two random bytes, and it is there whatever the
 * platform word is, because two Macs are both "mac" and the name is what tells
 * two conflict copies apart and what somebody reads in the device list before
 * revoking a row. Typing a name replaces the whole suggestion, tail included,
 * exactly as `--device` does.
 */
function suggestedDeviceName(): string {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const tail = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${platformWord()}-${tail}`;
}

/**
 * One word for the machine, out of `Platform`.
 *
 * The mobile flags come first, and that ordering is the whole of what is
 * subtle here: `obsidian.d.ts` says `isMacOS` is true on "a device that
 * pretends to be one (like iPhones and iPads)", so an iPad checked in the
 * other order would call itself a Mac. The last word is a fallback that a
 * real Obsidian never reaches, since every host it runs on claims one of the
 * five above.
 */
function platformWord(): string {
  if (Platform.isAndroidApp) return "android";
  if (Platform.isIosApp) return Platform.isTablet ? "ipad" : "iphone";
  if (Platform.isMacOS) return "mac";
  if (Platform.isWin) return "windows";
  if (Platform.isLinux) return "linux";
  return "obsidian";
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
    // What it is talking to, under what it is doing. The panel said "up to
    // date, cursor 66" and nothing at all about the other end, which is the
    // first thing wanted when it is not working: whether this device is
    // pointed where it should be, whether the hop is protected, and which
    // build is answering.
    const connection = contentEl.createEl("p", { cls: "basalt-advice" });
    const advice = contentEl.createEl("p", { cls: "basalt-advice" });
    // Which rows this pass drew, so that a panel left open when the state
    // changes under it grows the recovery it now needs. Everything else here
    // is text a listener can update; a row is not, and a panel that was open
    // when the server was restored would otherwise say "stopped" beside no way
    // out until it was closed and opened again.
    const drewRejoin = offersRejoin(this.plugin.currentState);
    this.unwatch = this.plugin.watchState((state) => {
      if (offersRejoin(state) !== drewRejoin) {
        this.render();
        return;
      }
      status.setText(longStatus(state));
      // Both cursors, so "behind and nothing arriving" is something a person
      // can see (I11).
      const at = this.plugin.cursors();
      cursors.setText(
        at === undefined ? "" : `Local cursor ${at.local}, server cursor ${at.server}.`,
      );
      const to = this.plugin.connection();
      connection.setText(to === undefined ? "" : describeConnection(to));
      advice.setText(originAdvice(state));
    });

    new Setting(contentEl)
      .setName("Sync now")
      .setDesc("Basalt syncs on its own. This is for when you want to be sure.")
      .addButton((b) =>
        b.setButtonText("Sync").onClick(async () => {
          await this.plugin.syncNow();
        }),
      );

    // Only while it is the answer to something. The panel is the whole
    // interface and every row in it is a row somebody has to read past; a
    // recovery for a state this vault is not in is noise, and a destructive
    // button on the path people take every day is a bug waiting to be
    // pressed. design.md: a thing that matters only when something specific
    // happens appears in that moment.
    if (drewRejoin) this.renderRejoin(contentEl);

    if (this.freshRecoveryKey !== undefined)
      this.renderRecoveryKey(contentEl, this.freshRecoveryKey);

    // Adding a device, and then the list of them. In that order because they
    // are one subject: the invite is how a row appears here, and the list is
    // the answer to "what is still connected to my notes", which is the
    // question somebody opens this panel with after losing a phone.
    this.renderInvite(contentEl);
    this.renderDevices(contentEl);

    new Setting(contentEl)
      .setName("Recover a deleted note")
      .setDesc("The server keeps every version of everything, including what you have deleted.")
      .addButton((b) =>
        b.setButtonText("Browse deleted").onClick(() => {
          this.close();
          new RecoverModal(this.plugin).open();
        }),
      );

    // Said, not shown, because there is nothing to show. This device holds a
    // credential for one row and not the vault's root, which is what makes
    // the row above able to cut a device off. The key was displayed once, when
    // the vault was started, and no device can print it again.
    //
    // And it says what it is for, because that is the sentence that keeps the
    // recovery key written down and offline: adding a device is the invite
    // above, and this is the day every device is gone.
    new Setting(contentEl)
      .setName("Recovery key")
      .setDesc(
        "The vault's root secret, shown once when the vault was started. It is for writing down " +
          "in case every device is lost, not for adding one: use an invite for that. It is not " +
          "on this device and cannot be shown again, because a device that held it could " +
          "register itself again after being revoked, so revoking would stop nothing.",
      );

    // Beside the recovery key, because it is the same secret and the same
    // warning, and behind two presses, because it is the one action here that
    // disconnects every other device.
    this.renderRotate(contentEl);

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
   * Every device that may reach this vault, and one button each to cut one off.
   *
   * Loaded on a press rather than on open. It is a request to the server, and
   * a panel that made one every time it was drawn would make one every time
   * somebody looked at the sync status.
   *
   * The honesty paragraph is not decoration and it is not optional. Revoking
   * stops a device connecting and does not un-read what it already read: the
   * revoked device still holds the vault's key for every note it had synced.
   * A panel that let somebody believe otherwise would have them skip the
   * rotation, which is the one thing that actually helps after a theft, and
   * this feature would be worse than not having it.
   */
  private renderDevices(contentEl: HTMLElement): void {
    // Declared here and created below the setting that fills them, for the
    // same reason renderInvite does it: created first, the rows rendered
    // above the "Devices" row and the list appeared to belong to whatever
    // sat above it. Found by taking a screenshot of the panel, twice now,
    // which is a better reviewer of layout than a test.
    let list!: HTMLElement;
    let said!: HTMLElement;
    const show = async () => {
      list.empty();
      said.setText("");
      let answer: {
        devices: DeviceRow[];
        maxDevices: number;
        invites: InviteRow[];
        thisDevice: string;
      };
      try {
        answer = await this.plugin.devices();
      } catch (err) {
        said.setText((err as Error).message);
        return;
      }
      // The last row is the vault's last device, and it is always this one:
      // reading the list at all means this device connected. Emptying the
      // vault is the recovery key's to do, so there is no button for it here.
      // A button that could only ever be refused is worse than none.
      const last = answer.devices.length === 1;
      for (const device of answer.devices) {
        const mine = device.id === answer.thisDevice;
        // Flagged rather than left as a blank, because a row nothing has ever
        // connected under is the reclaimable one: a pairing that reached the
        // server and then crashed leaves exactly that, and it holds a slot.
        const seen =
          device.lastSeen === 0 ? "never connected" : `last seen ${when(device.lastSeen)}`;
        const row = new Setting(list)
          .setName(`${device.name || "unnamed"}${mine ? " (this device)" : ""}`)
          // The id as well as the name, because the name is not an identity:
          // two laptops may both be called laptop, and the id is what says
          // which one this row would cut off.
          .setDesc(`${device.id} · added ${when(device.createdAt)} · ${seen}`);
        if (last) continue;
        let confirmed = false;
        row.addButton((b) =>
          b
            .setButtonText(mine ? "Unlink from the server" : "Revoke")
            .setWarning()
            .onClick(async () => {
              if (!confirmed) {
                confirmed = true;
                b.setButtonText("Yes, revoke");
                said.setText(
                  mine
                    ? "This device will stop syncing at once. Press again to revoke it."
                    : `"${device.name || device.id}" will stop syncing at once and cannot connect ` +
                        `again until it is added with an invite from a device that still has the ` +
                        `vault. Press again.`,
                );
                return;
              }
              try {
                await this.plugin.revoke(device.id);
                new Notice(
                  "Revoked. It cannot connect again. It still holds the vault's key for every " +
                    "note it had already synced, so replace the vault's secret too if it was stolen.",
                  10_000,
                );
                this.render();
              } catch (err) {
                said.setText((err as Error).message);
              }
            }),
        );
      }
      // The invites under the rows, because they are the same question: a row
      // is a device that was added and an outstanding invite is one about to
      // be. Identifier and expiry only. The string itself is not here and
      // cannot be: the server never had the invite key, so nothing on this
      // screen redeems anything, and what the identifier is for is saying
      // which invite to cancel.
      for (const invite of answer.invites) {
        const row = new Setting(list)
          .setName("Outstanding invite")
          .setDesc(`${invite.id} · adds one device · expires ${when(invite.expiresAt)}`);
        row.addButton((b) =>
          b
            .setButtonText("Cancel")
            .setWarning()
            .onClick(async () => {
              try {
                await this.plugin.uninvite(invite.id);
                new Notice(
                  "Cancelled. That string no longer adds a device. If somebody redeemed it " +
                    "already, the device it added is a row above, and Revoke is what stops that.",
                  10_000,
                );
                this.render();
              } catch (err) {
                said.setText((err as Error).message);
              }
            }),
        );
      }

      const never = answer.devices.filter((d) => d.lastSeen === 0).length;
      said.setText(
        `${answer.devices.length} of at most ${answer.maxDevices} devices. Revoking stops a ` +
          `device connecting. It does not un-read what that device already read: it still holds ` +
          `the vault's key for every note it had synced. A device that was stolen rather than ` +
          `lost wants the vault's secret replaced as well, below.` +
          (never > 0
            ? ` ${never} of these ${never === 1 ? "has" : "have"} never connected: a pairing that ` +
              `reached the server and then crashed leaves a row like that, and it holds a slot ` +
              `until it is revoked.`
            : "") +
          (answer.invites.length > 0
            ? ` ${answer.invites.length} outstanding ${answer.invites.length === 1 ? "invite" : "invites"}: ` +
              `each one adds one device and then stops working. Cancel one you did not mean to ` +
              `issue, or that was issued on a device you have lost.`
            : "") +
          (last
            ? ` This is the vault's last device, and taking its row off the server would leave a ` +
              `vault only the recovery key opens, which is the one revocation no device can undo. ` +
              `So there is no button for it here: it takes the recovery key, with basalt revoke ID ` +
              `--allow-last --recovery-key on a machine that has the command line client. To stop ` +
              `syncing here and leave the row where it is, use Unlink this vault below.`
            : ""),
      );
    };

    new Setting(contentEl)
      .setName("Devices")
      .setDesc(
        `This device is "${this.plugin.deviceName}". Add another with an invite, above; each one ` +
          `gets a credential of its own, which is what a row here can be revoked without touching. ` +
          `Invites that have not been redeemed yet are listed here too.`,
      )
      .addButton((b) => b.setButtonText("Show devices").onClick(show));

    list = contentEl.createEl("div");
    said = contentEl.createEl("p", { cls: "basalt-advice" });
  }

  /**
   * Where an invite goes: on screen, always, because the string is the whole
   * of what the other device needs and a phone may have no clipboard to put it
   * in.
   *
   * The two paragraphs are created after the setting that fills them, so they
   * land under it. Created first, they rendered above the "Add another device"
   * row and the invite appeared to belong to whatever setting sat above it.
   */
  private renderInvite(contentEl: HTMLElement): void {
    let currentInvite = "";
    new Setting(contentEl)
      .setName("Add another device")
      .setDesc(
        `This device is "${this.plugin.deviceName}". An invite works once, for ten minutes, and ` +
          "carries no root secret: it hands the new device the vault's key and registers a " +
          "credential of its own for it, which is what lets you revoke that device later. The " +
          "recovery key is not needed for this and should stay written down.",
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

    const shown = contentEl.createEl("p", { cls: "basalt-pairing" });
    const expiry = contentEl.createEl("p", { cls: "basalt-advice" });
  }

  /**
   * The way back from a server that has lost history this device applied.
   *
   * Two presses, and the first one is not destructive: it asks the server where
   * it is and puts both numbers on screen, which is also how somebody finds out
   * that this is not their problem. The confirmation is what `--backup-taken`
   * is on the command line, and it is worth more here: a flag has to be typed
   * and a button is one tap from a thumb.
   */
  private renderRejoin(contentEl: HTMLElement): void {
    const said = contentEl.createEl("p", { cls: "basalt-advice" });
    let confirmed = false;
    new Setting(contentEl)
      .setName("Rejoin this server")
      .setDesc(
        "The server has lost history this device already has, which is what restoring it from an " +
          "older backup looks like. Rejoining forgets what this device believed it had synced and " +
          "starts again from the server's version, sending what only this device holds as new " +
          "versions. Nothing is deleted, here or on the server. Back the server up first.",
      )
      .addButton((b) =>
        b
          .setButtonText("Rejoin")
          .setWarning()
          .onClick(async () => {
            try {
              if (!confirmed) {
                const at = await this.plugin.rejoinCursors();
                refuseUnlessAhead(at);
                confirmed = true;
                b.setButtonText("Yes, rejoin");
                said.setText(
                  `This device is at version ${at.local} and the server is at ${at.server}. ` +
                    `Take a backup of the server first (basaltd backup). Press again to rejoin.`,
                );
                return;
              }
              said.setText("Rejoining. This sends everything only this device holds.");
              const report = await this.plugin.rebase();
              said.setText(
                `Rejoined the server: ${summarise(report)}. Nothing was deleted, and where the ` +
                  `two sides disagreed both versions were kept.`,
              );
              new Notice(`Basalt rejoined the server: ${summarise(report)}`, 10_000);
              this.render();
            } catch (err) {
              said.setText("");
              new Notice(`Basalt: ${(err as Error).message}`, 10_000);
            }
          }),
      );
  }

  /**
   * Replacing the vault's root secret.
   *
   * The answer to a recovery key that has been somewhere it should not have
   * been, and the second half of the answer to a device that was stolen: the
   * first half is revoking it above, which stops it connecting, and this is
   * what stops the key it was holding opening the vault again.
   *
   * It asks for the current recovery key, because no device holds one. That is
   * the whole point of the change: a device that could rotate could also
   * register itself again after being revoked. So this is a field rather than
   * a button, and somebody who has not got the key cannot do it from here,
   * which is correct and is said in the description rather than discovered.
   *
   * Two presses, because it retires the old key the moment it commits, and the
   * new key goes on screen before the second press: the server commits, closes
   * every other registrar and only then replies, so a reply lost in between
   * leaves a vault whose new root exists only on paper.
   */
  private renderRotate(contentEl: HTMLElement): void {
    const said = contentEl.createEl("p", { cls: "basalt-advice" });
    let keyField: TextComponent | undefined;
    new Setting(contentEl)
      .setName("Replace the vault's secret")
      .setDesc(
        "For a recovery key that has been somewhere it should not have been, or a device that " +
          "was stolen rather than lost. Paste the vault's current recovery key: no device holds " +
          "one, which is what makes revoking a device above mean anything. The vault gets a new " +
          "root secret and keeps all of its history, and every device including this one keeps " +
          "syncing: no device row is touched. It cannot un-read what was already read, so revoke " +
          "the lost device as well.",
      )
      .addText((t) => {
        t.setPlaceholder("basalt3_...");
        keyField = t;
      });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Replace the secret")
        .setWarning()
        .onClick(async () => {
          const given = keyField?.getValue() ?? "";
          if (given.trim() === "") {
            said.setText("Paste the vault's current recovery key first.");
            return;
          }
          try {
            const { recoveryKey, settled } = await this.plugin.rotate(given);
            // Shown in the panel rather than in a notice, and not dismissed
            // by anything but saying it has been written down: at this
            // moment it is the only thing that opens the vault.
            this.freshRecoveryKey = recoveryKey;
            new Notice(
              settled
                ? "The vault has a new secret. Write down the new recovery key shown in the panel. " +
                    "Every device keeps syncing."
                : "The vault may already have the new secret: the server never answered. Write down " +
                    "the new recovery key shown in the panel, keep the old one until you know, and " +
                    "try each of them here.",
              0,
            );
            this.render();
          } catch (err) {
            said.setText("");
            new Notice(`Basalt: ${(err as Error).message}`, 10_000);
          }
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
        `credential they hold, so nothing here will do that. Fix or move the file, then reload the plugin.`,
    });
  }

  private renderPairing(contentEl: HTMLElement): void {
    contentEl.createEl("p", {
      text:
        "This vault is not paired yet. If another device already has the vault, create an invite " +
        "there and paste it here. The vault's recovery key works too, and is what to use when no " +
        "device is left to make an invite.",
    });

    // The fields are read when a button is pressed rather than tracked
    // through input events. One less thing between what was typed and what
    // is used, and it is what makes this reachable from a test.
    let deviceField: TextComponent | undefined;
    let pairingField: TextComponent | undefined;
    const device = () => deviceField?.getValue() ?? "";

    // A suggestion in the field, not a placeholder behind it. A placeholder is
    // not a value, so the honest thing to do with the field was leave it
    // alone, and every device ended up named after the app rather than after
    // itself. What is offered is what will be used, and it can be typed over.
    new Setting(contentEl)
      .setName("Device name")
      .setDesc(
        "How this device shows in the device list, in version history and in conflict copy " +
          "names. Type over it with whatever you call this machine.",
      )
      .addText((t) => {
        t.setPlaceholder("laptop");
        t.setValue(suggestedDeviceName());
        deviceField = t;
      });

    new Setting(contentEl)
      .setName("Invite or recovery key")
      .setDesc(
        "An invite from Basalt on a device that already has this vault, or the vault's recovery " +
          "key. Either way this device ends up with a credential of its own, and keeps neither " +
          "the invite nor the key.",
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
        "This is the vault's recovery key. It is shown here once and no device keeps it: what is " +
        "stored here is this device's own credential, which can be revoked on its own. Adding a " +
        "device does not need it, an invite does that; this replaces the vault's secret and is " +
        "the only way back if every device is lost. Anyone who has it has the vault. Keep it " +
        "offline.",
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
 * What to tell somebody whose handshake never completes, and nothing otherwise.
 *
 * The server refuses a browser origin it does not know, and the only thing
 * that knows this device's origin is this device. The desktop one is in the
 * built-in list; the mobile ones are Capacitor's documented defaults and have
 * never been checked against a device, so a phone that has never got through
 * should be able to say what to add rather than leaving somebody to guess. A
 * connection that was up and went is not that: the origin was fine, the
 * network is not.
 */
function originAdvice(state: State): string {
  if (state.kind !== "offline" || !state.refused) return "";
  const from = origin();
  return (
    `If it never connects, this device's origin is ${from}. ` +
    `A server that does not know it refuses the connection, and logs the same thing. ` +
    `Restart it with -allow-origin ${from}`
  );
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

/**
 * What this device syncs with: the address, the protocol and the build.
 *
 * @see BasaltPlugin.connection
 */
export interface Connection {
  /** Where this device pairs to, from the saved config. */
  readonly url: string;
  /** What the server said at hello. Absent until there has been one. */
  readonly server?: { readonly proto: number; readonly version: string } | undefined;
}

/**
 * One line for what the panel is talking to.
 *
 * Four facts and no more, because each is one somebody is missing when sync is
 * not working and none of them costs a request: the address this device
 * actually holds, whether that hop has TLS in front of it, the protocol the
 * two ends settled on, and the build on the other end. The last two come from
 * `ready` and are absent until there has been one, and the line says so rather
 * than leaving a gap: a build that is missing because nothing is connected
 * reads exactly like a server that did not say, and they are different states
 * (rule 2, at the width of a sentence).
 *
 * The scheme is the whole of what is known about the hop, and it is a complete
 * test because `normaliseUrl` stores one of exactly two. `wss://` means
 * something in front of the server terminated TLS, which is the arrangement
 * server.md describes, and `ws://` means nothing did. The second is not a
 * warning that the vault is exposed, because it is not: the notes are sealed
 * on this device either way. What it does cost is named exactly, because the
 * only wrong thing to say here is the vague thing.
 */
export function describeConnection(at: Connection): string {
  const hop = at.url.startsWith("wss://")
    ? "which has TLS in front"
    : "which has no TLS in front: notes stay sealed, and a network in between can see this " +
      "device's credential, and the size and timing of every note";
  return at.server === undefined
    ? `Not connected to ${at.url}, ${hop}. Its protocol and build are said at hello, so neither is known yet.`
    : `Connected to ${at.url}, ${hop}. Protocol ${at.server.proto}, basaltd ${at.server.version}.`;
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
      return state.recovery === "rejoin"
        ? `Stopped: ${state.why} ${REJOIN_ADVICE}`
        : `Stopped: ${state.why}. This will not fix itself by waiting.`;
  }
}
