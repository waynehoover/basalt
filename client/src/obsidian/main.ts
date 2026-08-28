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

import { Modal, Notice, Plugin, Setting, type TAbstractFile } from "obsidian";

import { Client, runForever, summarise, type ClientOptions } from "../core/client.ts";
import { deriveKeys, generateSecret } from "../core/crypto.ts";
import type { SyncReport } from "../core/engine.ts";
import {
    decodeConfig,
    encodeConfig,
    formatPairing,
    parsePairing,
    type DeviceConfig,
} from "../core/pairing.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";

/** What the status bar is saying, which is also what the modal shows. */
type State =
    | { kind: "unpaired" }
    | { kind: "connecting" }
    | { kind: "synced"; summary: string; at: number }
    | { kind: "offline"; why: string; retryAt: number }
    | { kind: "stopped"; why: string };

export default class BasaltPlugin extends Plugin {
    private config: DeviceConfig | undefined;
    private client: Client | undefined;
    private state: State = { kind: "unpaired" };
    private statusEl: HTMLElement | undefined;
    private running = false;
    private nudgeTimer: number | undefined;

    override async onload(): Promise<void> {
        this.statusEl = this.addStatusBarItem();
        this.addRibbonIcon("refresh-cw", "Basalt", () => new BasaltModal(this).open());

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

        // Obsidian's own events, rather than a watcher. They are what the
        // platform gives, they work on mobile, and they say when to look rather
        // than what changed: the scan is what decides, and it re-reads the vault
        // every time, so a missed event costs latency and never correctness.
        this.registerEvent(this.app.vault.on("create", () => this.nudge()));
        this.registerEvent(this.app.vault.on("modify", () => this.nudge()));
        this.registerEvent(this.app.vault.on("delete", () => this.nudge()));
        this.registerEvent(this.app.vault.on("rename", (_file: TAbstractFile, _oldPath: string) => this.nudge()));

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
        if (this.nudgeTimer !== undefined) window.clearTimeout(this.nudgeTimer);
        this.client?.close();
    }

    /* ------------------------------------------------------------ *
     * Running
     * ------------------------------------------------------------ */

    private start(): void {
        const config = this.config;
        if (!config || this.running) return;
        this.running = true;
        this.setState({ kind: "connecting" });

        void (async () => {
            await runForever(await this.clientOptions(config), {
                onClient: (client) => {
                    this.client = client;
                },
                onSynced: (report) => {
                    this.setState({ kind: "synced", summary: summarise(report), at: Date.now() });
                    this.announce(report);
                },
                onDisconnected: (cause, retryIn) => {
                    this.setState({ kind: "offline", why: cause.message, retryAt: Date.now() + retryIn });
                },
                onUnreachable: (cause, retryIn) => {
                    this.setState({ kind: "offline", why: cause.message, retryAt: Date.now() + retryIn });
                },
                onFatal: (cause) => {
                    // A refusal that would be repeated word for word forever: a
                    // bad token, or a cursor the server says is impossible.
                    // Retrying is a loop that never ends and never says why.
                    this.setState({ kind: "stopped", why: cause.message });
                    new Notice(`Basalt has stopped: ${cause.message}`, 0);
                },
                keepGoing: () => this.running,
            });
            this.running = false;
        })();
    }

    private async clientOptions(config: DeviceConfig): Promise<ClientOptions> {
        return {
            vault: new ObsidianVault(this.app.vault.adapter),
            // Inside the plugin's own folder, under `.obsidian`, which is in the
            // never-sync list. An index that synced would sync to itself.
            store: new ObsidianIndexStore(this.app.vault.adapter, `${this.manifest.dir}/index.json`),
            keys: await deriveKeys(config.secret),
            url: config.url,
            token: config.token,
            vaultId: config.vaultId,
            device: config.device,
        };
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
        if (this.nudgeTimer !== undefined) window.clearTimeout(this.nudgeTimer);
        this.nudgeTimer = window.setTimeout(() => {
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
        const report = await this.client.settle();
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
            token: token.trim(),
            vaultId: "default",
            device: device.trim() || "obsidian",
            secret: generateSecret(),
        };
        if (config.token === "") throw new Error("the server's token is needed");
        await this.saveData(encodeConfig(config));
        this.config = config;
        this.start();
        return formatPairing(config);
    }

    /** The string another device needs, or undefined when this one is unpaired. */
    invite(): string | undefined {
        return this.config ? formatPairing(this.config) : undefined;
    }

    /** Forgets the pairing. Every note stays where it is, on both ends. */
    async unlink(): Promise<void> {
        this.running = false;
        this.client?.close();
        this.client = undefined;
        this.config = undefined;
        await this.saveData(null);
        this.setState({ kind: "unpaired" });
    }

    /* ------------------------------------------------------------ *
     * Saying what is happening
     * ------------------------------------------------------------ */

    private setState(state: State): void {
        this.state = state;
        this.statusEl?.setText(`Basalt: ${shortStatus(state)}`);
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
function shortStatus(state: State): string {
    switch (state.kind) {
        case "unpaired":
            return "not paired";
        case "connecting":
            return "connecting";
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
        contentEl.createEl("h2", { text: "Basalt" });

        if (!this.plugin.paired) {
            this.renderPairing(contentEl);
            return;
        }

        const status = contentEl.createEl("p");
        this.unwatch = this.plugin.watchState((state) => {
            status.setText(longStatus(state));
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
            new Setting(contentEl)
                .setName("Add another device")
                .setDesc("Anyone who has this string has this vault. Treat it like the passphrase it contains.")
                .addButton((b) =>
                    b.setButtonText("Copy pairing string").onClick(async () => {
                        await navigator.clipboard.writeText(pairing);
                        new Notice("Copied. Paste it into Basalt on the other device.");
                    })
                );
        }

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

        let pairingString = "";
        let device = "";

        new Setting(contentEl).setName("Device name").addText((t) => {
            t.setPlaceholder("laptop");
            t.inputEl.addEventListener("input", () => (device = t.getValue()));
        });

        new Setting(contentEl)
            .setName("Pairing string")
            .setDesc("From Basalt on a device that already has this vault.")
            .addText((t) => {
                t.setPlaceholder("basalt1_...");
                t.inputEl.addEventListener("input", () => (pairingString = t.getValue()));
            });

        new Setting(contentEl).addButton((b) =>
            b
                .setButtonText("Pair")
                .setCta()
                .onClick(async () => {
                    try {
                        await this.plugin.pair(pairingString, device);
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

        let url = "";
        let token = "";
        new Setting(contentEl).setName("Server").addText((t) => {
            t.setPlaceholder("wss://laptop.tailnet.ts.net");
            t.inputEl.addEventListener("input", () => (url = t.getValue()));
        });
        new Setting(contentEl).setName("Token").addText((t) => {
            t.inputEl.addEventListener("input", () => (token = t.getValue()));
        });
        new Setting(contentEl).addButton((b) =>
            b.setButtonText("Start a new vault").onClick(async () => {
                try {
                    await this.plugin.pairFirst(url, token, device);
                    new Notice("Paired. Use the pairing string to add your other devices.");
                    this.render();
                } catch (err) {
                    new Notice(`Basalt: ${(err as Error).message}`, 10_000);
                }
            })
        );
    }
}

function longStatus(state: State): string {
    switch (state.kind) {
        case "unpaired":
            return "Not paired.";
        case "connecting":
            return "Connecting.";
        case "synced":
            return `${state.summary}, as of ${new Date(state.at).toLocaleTimeString()}.`;
        case "offline":
            return `Offline: ${state.why}. Trying again shortly.`;
        case "stopped":
            return `Stopped: ${state.why}. This will not fix itself by waiting.`;
    }
}

/**
 * Accepts what a person is likely to type.
 *
 * The same rule as the CLI, and the same reasoning: a bare host gets TLS,
 * because TLS is terminated in front of the server and the plain case is the one
 * worth being explicit about.
 */
function normaliseUrl(input: string): string {
    const text = input.trim().replace(/\/+$/, "");
    if (text === "") throw new Error("that is not a server address");
    if (text.startsWith("ws://") || text.startsWith("wss://")) return text;
    if (text.startsWith("http://")) return "ws://" + text.slice("http://".length);
    if (text.startsWith("https://")) return "wss://" + text.slice("https://".length);
    if (text.includes("://")) throw new Error(`a server address is ws:// or wss://, not ${text.split("://")[0]}://`);
    return "wss://" + text;
}
