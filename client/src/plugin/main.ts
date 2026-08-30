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
 * On purpose, and docs/philosophy.md says why: every option multiplies a state
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

import { Modal, Notice, Plugin, Setting, setIcon, type TAbstractFile, type TextComponent } from "obsidian";

import { HistoryModal, when, type HistorySource } from "./history.ts";

import {
    Client,
    runForever,
    summarise,
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
    normaliseUrl,
    parsePairing,
    type DeviceConfig,
} from "../core/pairing.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";

/** What the status bar is saying, which is also what the modal shows. */
type State =
    | { kind: "unpaired" }
    | { kind: "connecting" }
    | { kind: "synced"; summary: string; at: number }
    /**
     * Working, and on what.
     *
     * Sending a large attachment is minutes inside one pass, and without this
     * the status shown is the previous pass's result, so working and idle look
     * exactly alike. The path rather than a percentage: what somebody wants to
     * know is whether it is doing something and what.
     */
    | { kind: "syncing"; path: string; since: number }
    | { kind: "offline"; why: string; retryAt: number }
    | { kind: "stopped"; why: string };

export default class BasaltPlugin extends Plugin {
    private config: DeviceConfig | undefined;
    private client: Client | undefined;
    private state: State = { kind: "unpaired" };
    private statusEl: HTMLElement | undefined;
    private ribbonEl: HTMLElement | undefined;
    private running = false;

    /**
     * Which run is the current one. Bumped by every start and by unlink, so a
     * run that has been superseded can tell, and says nothing when it has.
     */
    private generation = 0;
    private nudgeTimer: ReturnType<typeof setTimeout> | undefined;

    override async onload(): Promise<void> {
        // Obsidian mobile has no status bar. addStatusBarItem returns an
        // element nothing displays there, so on a phone this is the plugin
        // talking to itself. The ribbon is on both, so the state goes there too:
        // its tooltip is the same sentence, and it is the thing somebody taps
        // when they want to know.
        this.statusEl = this.addStatusBarItem();
        this.ribbonEl = this.addRibbonIcon("refresh-cw", "Basalt Sync", () => new BasaltModal(this).open());

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
                        .onClick(() => this.openHistory(file.path))
                );
            })
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
                async (flags) => this.cliHistory(String(flags["path"] ?? ""))
            );
            this.registerCliHandler(
                "basalt:restore",
                "Restore a Basalt version",
                {
                    path: { value: "<path>", description: "Vault path" },
                    uid: { value: "<n>", description: "Version uid", required: true },
                },
                async (flags) => this.cliRestore(String(flags["path"] ?? ""), Number(flags["uid"]))
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
            this.registerEvent(
                this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
                    this.client?.engine.noteRename(oldPath, file.path);
                    this.nudge();
                })
            );
        });

        try {
            this.config = await this.readConfig();
        } catch (err) {
            // Rule 2: an unreadable config is not an unpaired vault. Starting
            // over would generate a new root secret and make everything already
            // on the server undecryptable here.
            this.setState({ kind: "stopped", why: (err as Error).message });
            new Notice(`Basalt: ${(err as Error).message}`, 10_000);
            return;
        }

        if (this.config) this.start();
        else this.setState({ kind: "unpaired" });
    }

    override onunload(): void {
        this.running = false;
        if (this.nudgeTimer !== undefined) clearTimeout(this.nudgeTimer);
        if (this.workingTimer !== undefined) clearTimeout(this.workingTimer);
        this.client?.close();
    }

    /* ------------------------------------------------------------ *
     * Running
     * ------------------------------------------------------------ */

    private start(): void {
        const config = this.config;
        if (!config || this.running) return;
        this.running = true;
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
                if (mine === this.generation) {
                    this.setState({ kind: "stopped", why: (err as Error).message });
                    new Notice(`Basalt has stopped: ${(err as Error).message}`, 0);
                }
            }
            if (mine === this.generation) this.running = false;
        })();
    }

    private async runLoop(config: DeviceConfig, mine: number): Promise<void> {
        const current = () => mine === this.generation;
        await runForever(await this.clientOptions(config), {
            onClient: (client) => {
                if (!current()) return;
                this.client = client;
                // A connection means a bootstrap, if there was one, has been
                // spent. Keeping it is keeping a second secret that no longer
                // opens anything.
                if (client && this.config?.bootstrap) void this.forgetBootstrap();
            },
            onSynced: (report) => {
                if (!current()) return;
                this.setState({ kind: "synced", summary: summarise(report), at: Date.now() });
                this.announce(report);
            },
            onDisconnected: (cause, retryIn) => {
                if (!current()) return;
                this.setState({ kind: "offline", why: cause.message, retryAt: Date.now() + retryIn });
            },
            onUnreachable: (cause, retryIn) => {
                if (!current()) return;
                this.setState({ kind: "offline", why: cause.message, retryAt: Date.now() + retryIn });
            },
            onFatal: (cause) => {
                if (!current()) return;
                // A refusal that would be repeated word for word forever: a
                // bad token, or a cursor the server says is impossible.
                // Retrying is a loop that never ends and never says why.
                this.setState({ kind: "stopped", why: cause.message });
                new Notice(`Basalt has stopped: ${cause.message}`, 0);
            },
            keepGoing: () => this.running && current(),
        });
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
        if (path === undefined) {
            if (this.workingTimer !== undefined) clearTimeout(this.workingTimer);
            this.workingTimer = undefined;
            return;
        }
        if (this.workingTimer !== undefined) clearTimeout(this.workingTimer);
        this.workingTimer = setTimeout(() => {
            this.workingTimer = undefined;
            this.setState({ kind: "syncing", path, since: Date.now() });
        }, 400);
    }

    private workingTimer: ReturnType<typeof setTimeout> | undefined;

    /** Drops the spent first-run token from the saved settings. */
    private async forgetBootstrap(): Promise<void> {
        if (!this.config?.bootstrap) return;
        const { bootstrap: _spent, ...rest } = this.config;
        this.config = rest;
        await this.saveData(encodeConfig(rest));
    }

    private async clientOptions(config: DeviceConfig): Promise<ClientOptions> {
        const configDir = this.app.vault.configDir;
        const keys = await deriveKeys(config.secret);
        const derived = authToken(keys);
        return {
            vault: new ObsidianVault(this.app.vault, configDir),
            store: new ObsidianIndexStore(this.app.vault.adapter, this.indexPath(configDir)),
            keys,
            url: config.url,
            // The bootstrap while there is one, and what the root secret
            // derives once the vault has been claimed. `claim` goes every time
            // and a server that already knows its answer ignores it, so a
            // device never has to work out whether it is the first.
            token: config.bootstrap ?? derived,
            claim: derived,
            vaultId: config.vaultId,
            device: config.device,
            onProgress: (path) => this.working(path),
            // The engine's running commentary, which had nowhere to go.
            //
            // These are the lines that say why something did not sync: a file
            // written off for good, a path that is a file here and a folder
            // there, a retry and its reason, a platform that cannot stream. With
            // no log they went nowhere, so a vault with one file missing looked
            // exactly like a vault with none missing, and the only way to find
            // out was to attach a debugger.
            log: (message, ...rest) => console.info("Basalt:", message, ...rest),
        };
    }

    /**
     * Where the index goes: inside this plugin's own folder.
     *
     * That folder is under Obsidian's config directory, which never syncs, and
     * an index that synced would sync to itself and be overwritten by every
     * other device in turn.
     *
     * `manifest.dir` is optional in the API. Interpolating it without looking
     * produces the literal path "undefined/index.json" at the vault root, which
     * is a perfectly ordinary folder as far as the never-sync list is concerned.
     * So it is checked, and a path outside the config directory stops the plugin
     * rather than being used.
     */
    private indexPath(configDir: string): string {
        const dir = this.manifest.dir ?? `${configDir}/plugins/${this.manifest.id}`;
        if (dir !== configDir && !dir.startsWith(`${configDir}/`)) {
            throw new Error(
                `refusing to run: this plugin is installed at ${dir}, which is outside ${configDir}, ` +
                    `so its index would sync to every other device`
            );
        }
        return `${dir}/index.json`;
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
        // Plain setTimeout rather than window's. Obsidian runs in a renderer
        // where both exist, and the plain one also exists everywhere this can be
        // tested, which is the difference between a tested nudge and an
        // untested one.
        this.nudgeTimer = setTimeout(() => {
            this.nudgeTimer = undefined;
            void this.client?.sync().then((report) => {
                if (report) {
                    this.setState({ kind: "synced", summary: summarise(report), at: Date.now() });
                    this.announce(report);
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
        if (!this.client) {
            new Notice("Basalt: not connected. It will sync as soon as it reconnects.");
            return;
        }
        // The write debounce is off for this one. It exists so that somebody
        // typing does not cause a push per keystroke, and the person who just
        // chose "sync now" has said otherwise. Reporting "up to date" while
        // their last paragraph sits unsent is the status rule 7 forbids.
        const report = await this.client.settle({ coalesceWrites: false });
        this.setState({ kind: "synced", summary: summarise(report), at: Date.now() });
        new Notice(`Basalt: ${summarise(report)}`);
        this.announce(report);
    }

    /**
     * Tells the user about the things that need a person.
     *
     * A conflict and a permanently skipped file are the two outcomes that do not
     * resolve themselves, and a status bar nobody is looking at is not how you
     * find out about either.
     */
    private announce(report: SyncReport): void {
        if (report.conflicted > 0) {
            const n = report.conflicted;
            new Notice(
                `Basalt kept both versions of ${n} ${n === 1 ? "file" : "files"}. ` +
                    `Look for "Conflicted copy" in the name.`,
                10_000
            );
        }
        if (report.skipped > 0) {
            new Notice(`Basalt cannot sync ${report.skipped} file(s) and has stopped trying.`, 10_000);
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

    /** Pairs this vault, and starts. Refuses to overwrite an existing pairing. */
    async pair(pairingString: string, device: string): Promise<void> {
        if (this.config) {
            // Re-pairing would replace the root secret, and everything already
            // on the server would stop being decryptable here.
            throw new Error("this vault is already paired");
        }
        const pairing = parsePairing(pairingString);
        const config: DeviceConfig = { ...pairing, device: device.trim() || "obsidian" };
        await this.saveData(encodeConfig(config));
        this.config = config;
        this.start();
    }

    /** Pairs as the very first device, making the vault's root secret here. */
    async pairFirst(url: string, token: string, device: string): Promise<string> {
        if (this.config) throw new Error("this vault is already paired");
        const config: DeviceConfig = {
            url: normaliseUrl(url),
            vaultId: "default",
            device: device.trim() || "obsidian",
            secret: generateSecret(),
            bootstrap: token.trim(),
        };
        if (config.bootstrap === "") throw new Error("the server's token is needed");
        await this.saveData(encodeConfig(config));
        this.config = config;
        this.start();
        return formatPairing(config);
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
    async deletedNotes(): Promise<DeletedList> {
        if (!this.client) throw new Error("not connected, so there is no way to ask what the server has");
        return this.client.deleted();
    }

    /**
     * Puts a note back, never over the top of something already there.
     *
     * What the deleted list hands over is the *deletion*, which is a version
     * like any other and has no content in it. What has to be restored is the
     * version before it, so that is looked up here rather than assumed.
     */
    async recover(deletion: Version): Promise<string> {
        if (!this.client) throw new Error("not connected, so there is nothing to restore from");
        const version = await this.client.newestContentVersion(deletion.path);
        if (!version) {
            throw new Error(`the server holds no version of ${deletion.path} with any content in it`);
        }
        const done = await this.client.restore(version);
        // Sent now rather than at the next pass, so the other devices get it
        // without anybody having to know that they would not have.
        await this.client.settle({ coalesceWrites: false });
        return done.path;
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
            new Notice("Basalt: not connected, so there is no history to show.", 8_000);
            return;
        }
        new HistoryModal(this.app, this.historySource(), path).open();
    }

    /** What HistoryModal needs, which is four calls and no plugin internals. */
    historySource(): HistorySource {
        return {
            history: async (path, opts) => {
                if (!this.client) throw new Error("not connected");
                return this.client.history(path, opts);
            },
            contentAt: async (version) => {
                if (!this.client) throw new Error("not connected");
                return new TextDecoder().decode(await this.client.contentAt(version));
            },
            restoreVersion: async (version) => {
                if (!this.client) throw new Error("not connected");
                const done = await this.client.restore(version);
                // Sent now rather than at the next pass, so the other devices
                // get it without anybody having to know that they would not.
                await this.client.settle({ coalesceWrites: false });
                return done.path;
            },
            currentText: async (path) => {
                if (!(await this.app.vault.adapter.exists(path))) return undefined;
                return this.app.vault.adapter.read(path);
            },
        };
    }

    private async cliHistory(path: string): Promise<string> {
        if (!this.client) return "Basalt is not connected.";
        const versions = await this.client.history(path, { limit: 50 });
        if (versions.length === 0) return `No history found for ${path}.`;
        return versions
            .map((v) => `${v.uid}\t${new Date(v.mtime).toISOString()}\t${v.size} B\t${v.device}`)
            .join("\n");
    }

    private async cliRestore(path: string, uid: number): Promise<string> {
        if (!this.client) return "Basalt is not connected.";
        const version = (await this.client.history(path, { limit: 200 })).find((v) => v.uid === uid);
        if (!version) return `No version ${uid} of ${path}.`;
        const at = await this.historySource().restoreVersion(version);
        return at === path ? `Restored ${at}.` : `Restored to ${at}, because ${path} is occupied.`;
    }

    /** The string another device needs, or undefined when this one is unpaired. */
    invite(): string | undefined {
        return this.config ? formatPairing(this.config) : undefined;
    }

    /**
     * Forgets the pairing. Every note stays where it is, on both ends.
     *
     * The index goes with it, and that is not tidiness. It records what this
     * device believes it has already synced. Left behind, the next pairing
     * starts from it: a cursor into a server that may be a different server, and
     * entries claiming files are up to date when nothing has been checked. The
     * device would skip uploading notes it had never sent.
     */
    async unlink(): Promise<void> {
        // Retires every run in flight. Closing the client is not enough: a run
        // whose client is closed simply reconnects, which is the whole point of
        // it.
        this.generation++;
        this.running = false;
        this.client?.close();
        this.client = undefined;
        this.config = undefined;
        await this.saveData(null);

        const index = this.indexPath(this.app.vault.configDir);
        if (await this.app.vault.adapter.exists(index)) {
            await this.app.vault.adapter.remove(index);
        }
        this.setState({ kind: "unpaired" });
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

    get deviceName(): string {
        return this.config?.device ?? "";
    }
}

/** One line, because a status bar is one line. */
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

function iconFor(state: State): string {
    switch (state.kind) {
        case "unpaired":
            return "link";
        case "connecting":
        case "syncing":
            return "refresh-cw";
        // Not refresh-cw again. Settled and working would then differ only by
        // whether the glyph happens to be spinning, which is exactly the
        // distinction a glance cannot make.
        case "synced":
            return "check";
        case "offline":
            return "cloud-off";
        case "stopped":
            return "alert-triangle";
    }
}

function toneFor(state: State): string {
    switch (state.kind) {
        case "stopped":
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
            return "";
    }
}

function shortStatus(state: State): string {
    switch (state.kind) {
        case "unpaired":
            return "not paired";
        case "connecting":
            return "connecting";
        case "syncing":
            return `syncing ${basename(state.path)}`;
        case "synced":
            return state.summary;
        case "offline":
            return "offline";
        case "stopped":
            return "stopped";
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
        this.contentEl.empty();
    }

    private render(): void {
        const { contentEl } = this;
        this.unwatch?.();
        contentEl.empty();
        contentEl.createEl("h2", { text: "Basalt Sync" });

        if (!this.plugin.paired) {
            this.renderPairing(contentEl);
            return;
        }

        const status = contentEl.createEl("p");
        const advice = contentEl.createEl("p", { cls: "basalt-advice" });
        this.unwatch = this.plugin.watchState((state) => {
            status.setText(longStatus(state));
            // The server refuses a browser origin it does not know, and the
            // only thing that knows this device's origin is this device. The
            // desktop one is in the built-in list; the mobile ones are
            // Capacitor's documented defaults and have never been checked
            // against a device, so an offline phone should be able to say what
            // to add rather than leaving somebody to guess.
            advice.setText(
                state.kind === "offline"
                    ? `If it never connects, this device's origin is ${origin()}. ` +
                          `A server that does not know it refuses the connection, and logs the same thing. ` +
                          `Restart it with -allow-origin ${origin()}`
                    : ""
            );
        });

        new Setting(contentEl)
            .setName("Sync now")
            .setDesc("Basalt syncs on its own. This is for when you want to be sure.")
            .addButton((b) =>
                b.setButtonText("Sync").onClick(async () => {
                    await this.plugin.syncNow();
                })
            );

        const pairing = this.plugin.invite();
        if (pairing) {
            // Where the string goes when there is no clipboard to put it in.
            const shown = contentEl.createEl("p", { cls: "basalt-pairing" });

            new Setting(contentEl)
                .setName("Add another device")
                .setDesc("Anyone who has this string has this vault. Treat it like the passphrase it contains.")
                .addButton((b) =>
                    b.setButtonText("Copy pairing string").onClick(async () => {
                        // Not every place this runs has a clipboard: mobile
                        // webviews and pages outside a secure context do not.
                        // A button that silently does nothing is worse than one
                        // that shows you the thing to copy by hand.
                        const clipboard = (
                            globalThis as {
                                navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
                            }
                        ).navigator?.clipboard;
                        try {
                            if (!clipboard) throw new Error("no clipboard here");
                            await clipboard.writeText(pairing);
                            new Notice("Copied. Paste it into Basalt on the other device.");
                        } catch {
                            shown.setText(pairing);
                            new Notice("This device has no clipboard. The string is shown above, to copy by hand.");
                        }
                    })
                );
        }

        new Setting(contentEl)
            .setName("Recover a deleted note")
            .setDesc("The server keeps every version of everything, including what you have deleted.")
            .addButton((b) =>
                b.setButtonText("Browse deleted").onClick(() => {
                    this.close();
                    new RecoverModal(this.plugin).open();
                })
            );

        new Setting(contentEl)
            .setName("Unlink this vault")
            .setDesc("Stops syncing. Every note stays where it is, here and on the server.")
            .addButton((b) =>
                b
                    .setButtonText("Unlink")
                    .setWarning()
                    .onClick(async () => {
                        await this.plugin.unlink();
                        this.render();
                    })
            );
    }

    private renderPairing(contentEl: HTMLElement): void {
        contentEl.createEl("p", {
            text: "This vault is not paired yet. If another device already has the vault, paste the string it gave you.",
        });

        // The fields are read when a button is pressed rather than tracked
        // through input events. One less thing between what was typed and what
        // is used, and it is what makes this reachable from a test.
        let deviceField: TextComponent | undefined;
        let pairingField: TextComponent | undefined;
        const device = () => deviceField?.getValue() ?? "";

        new Setting(contentEl).setName("Device name").addText((t) => {
            t.setPlaceholder("laptop");
            deviceField = t;
        });

        new Setting(contentEl)
            .setName("Pairing string")
            .setDesc("From Basalt on a device that already has this vault.")
            .addText((t) => {
                t.setPlaceholder("basalt2_...");
                pairingField = t;
            });

        new Setting(contentEl).addButton((b) =>
            b
                .setButtonText("Pair")
                .setCta()
                .onClick(async () => {
                    try {
                        await this.plugin.pair(pairingField?.getValue() ?? "", device());
                        new Notice("Paired. Basalt is syncing.");
                        this.render();
                    } catch (err) {
                        new Notice(`Basalt: ${(err as Error).message}`, 10_000);
                    }
                })
        );

        contentEl.createEl("h3", { text: "Or start a new vault" });
        contentEl.createEl("p", {
            text: "Only for the first device. The server prints its token the first time it runs.",
        });

        let urlField: TextComponent | undefined;
        let tokenField: TextComponent | undefined;
        new Setting(contentEl).setName("Server").addText((t) => {
            t.setPlaceholder("wss://laptop.tailnet.ts.net");
            urlField = t;
        });
        new Setting(contentEl).setName("Token").addText((t) => {
            tokenField = t;
        });
        new Setting(contentEl).addButton((b) =>
            b.setButtonText("Start a new vault").onClick(async () => {
                try {
                    await this.plugin.pairFirst(urlField?.getValue() ?? "", tokenField?.getValue() ?? "", device());
                    new Notice("Paired. Use the pairing string to add your other devices.");
                    this.render();
                } catch (err) {
                    new Notice(`Basalt: ${(err as Error).message}`, 10_000);
                }
            })
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
            deleted = await this.plugin.deletedNotes();
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

        const n = deleted.notes.length;
        contentEl.createEl("p", {
            text: `${n} ${n === 1 ? "note is" : "notes are"} recoverable. Restoring puts one back and sends it to your other devices.`,
        });
        if (deleted.more) {
            // Never a short list that looks complete.
            contentEl.createEl("p", {
                text: "There are older deletions than these. basalt deleted --limit N on the command line shows more.",
            });
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
                    .setDesc(`Deleted ${deletedAt}. Its history has been purged, so there is nothing to restore.`);
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
                                const at = await this.plugin.recover(version);
                                new Notice(
                                    at === version.path
                                        ? `Restored ${at}.`
                                        : `Restored to ${at}, because something is already at ${version.path}.`
                                );
                                await this.render();
                            } catch (err) {
                                new Notice(`Basalt: ${(err as Error).message}`, 10_000);
                            }
                        })
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
/** The last part of a path, because a status bar is one line. */
function basename(path: string): string {
    const at = path.lastIndexOf("/");
    return at === -1 ? path : path.slice(at + 1);
}

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
            return `${state.summary}, as of ${clock(state.at)}.`;
        case "offline":
            return `Offline: ${state.why}. Trying again shortly.`;
        case "stopped":
            return `Stopped: ${state.why}. This will not fix itself by waiting.`;
    }
}

