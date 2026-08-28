/**
 * The plugin, run.
 *
 * `main.ts` was written to be the one file no test could reach: it imports
 * `obsidian`, and the npm package is type declarations with no runtime. That is
 * a reason it is hard to test, not a reason it is fine untested, and the shell
 * is where a sync client's setup bugs live.
 *
 * So `stub.ts` supplies the runtime, `vitest.config.ts` aliases the module to it
 * for tests only, and everything below is the real plugin: real pairing, real
 * engine, real WebSocket, real Go server. `tsc` still checks `main.ts` against
 * the genuine declarations, and the shipped bundle still gets Obsidian's own
 * implementation.
 *
 * What this cannot tell you is whether Obsidian calls `onload` when this expects
 * or draws what this builds. That needs Obsidian.
 */

import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import { App, Plugin as StubPlugin, built, modals, notices, resetStub } from "./stub.ts";
import BasaltPlugin from "./main.ts";

beforeAll(async () => {
    await serverBinary();
}, 180_000);

afterAll(async () => {
    await cleanupBinary();
});

/**
 * A plugin wired to the stub.
 *
 * The casts are the seam and there is no way around them: `main.ts` is typed
 * against the real declarations, on purpose, and the stub is a different class
 * that happens to have the same shape. Doing it in one place keeps it honest.
 */
type Testable = BasaltPlugin & StubPlugin;

function makePlugin(app: App, manifest: { id: string; dir?: string } = { id: "basalt", dir: ".obsidian/plugins/basalt" }): Testable {
    return new BasaltPlugin(
        app as unknown as ObsidianApp,
        manifest as unknown as PluginManifest
    ) as unknown as Testable;
}

let server: TestServer;
const loaded: Testable[] = [];

beforeEach(() => {
    resetStub();
});

afterEach(async () => {
    while (loaded.length) loaded.pop()!.onunload();
    if (server) await server.cleanup();
});

async function fresh(): Promise<void> {
    server = new TestServer();
    await server.start();
}

/** Loads a plugin, and returns it and its app. */
async function load(
    saved: unknown = null,
    manifest?: { id: string; dir?: string },
    configDir?: string
): Promise<{ plugin: Testable; app: App }> {
    const app = new App();
    if (configDir !== undefined) app.vault.configDir = configDir;
    const plugin = makePlugin(app, manifest);
    plugin.savedData = saved;
    loaded.push(plugin);
    await plugin.onload();
    return { plugin, app };
}

/** Waits for something to become true, or explains what it was waiting for. */
async function until(what: string, cond: () => boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
}

const synced = (p: Testable) => until("a sync", () => p.currentState.kind === "synced");
const status = (p: Testable) => p.statusBarItems[0]?.text ?? "";

describe("loading", () => {
    it("comes up unpaired, and says so", async () => {
        const { plugin } = await load();
        expect(plugin.paired).toBe(false);
        expect(status(plugin)).toBe("Basalt: not paired");
    });

    it("registers the things a plugin registers", async () => {
        const { plugin, app } = await load();
        expect(plugin.commands.map((c) => c.id).sort()).toEqual(["show-status", "sync-now"]);
        expect(plugin.ribbonIcons.map((r) => r.title)).toEqual(["Basalt"]);
        expect(plugin.statusBarItems.length).toBe(1);
        // create, modify, delete, rename. Without these it only syncs on a timer.
        expect(app.vault.handlerCount()).toBe(4);
        expect(plugin.registeredEvents.length).toBe(4);
    });

    /**
     * Obsidian's own documentation: "If you do not wish to receive create events
     * on vault load, register your event handler inside
     * Workspace.onLayoutReady". Registering earlier means opening a vault fires
     * a create for every file in it.
     */
    it("waits for the layout before listening for file events", async () => {
        const app = new App();
        app.workspace.layoutReady = false;
        const plugin = makePlugin(app);
        loaded.push(plugin);
        await plugin.onload();

        expect(app.vault.handlerCount(), "listening before the layout was ready").toBe(0);
        app.workspace.finishLayout();
        expect(app.vault.handlerCount()).toBe(4);
    });

    /**
     * Rule 2, and the incident behind it: code that read a config, fell back to
     * an empty result on error and wrote that back disabled every plugin on a
     * device. Here the fallback would be worse: an unreadable config read as
     * "unpaired" means the next pairing generates a new root secret, and
     * everything already on the server stops being decryptable on this device.
     */
    it("refuses to start over from a config it cannot read", async () => {
        const { plugin } = await load({ url: "ws://x", token: "t", vaultId: "default", device: "d" });
        expect(plugin.paired).toBe(false);
        expect(plugin.currentState.kind).toBe("stopped");
        expect(notices.map((n) => n.message).join(" ")).toMatch(/secret/);
        // And it did not quietly overwrite the config it could not read.
        expect(plugin.savedData).toEqual({ url: "ws://x", token: "t", vaultId: "default", device: "d" });
    });

    it("refuses a stored secret of the wrong length", async () => {
        const { plugin } = await load({
            url: "ws://x",
            token: "t",
            vaultId: "default",
            device: "d",
            secret: "AAAA",
        });
        expect(plugin.currentState.kind).toBe("stopped");
        expect(notices.map((n) => n.message).join(" ")).toMatch(/root secret is 20/);
    });
});

describe("where its own state goes", () => {
    /**
     * The index must land inside Obsidian's config folder, which never syncs. An
     * index that synced would sync to itself, and every device would overwrite
     * every other device's idea of what had been synced.
     */
    it("keeps the index inside the config folder", async () => {
        await fresh();
        const { plugin, app } = await load();
        app.vault.adapter.seed("note.md", "x");
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        expect(app.vault.adapter.filePaths()).toContain(".obsidian/plugins/basalt/index.json");
        // Nothing of the plugin's leaked into the vault proper.
        const inVault = app.vault.adapter.filePaths().filter((p) => !p.startsWith(".obsidian/"));
        expect(inVault).toEqual(["note.md"]);
    }, 300_000);

    it("follows a vault that calls its config folder something else", async () => {
        await fresh();
        const { plugin, app } = await load(null, { id: "basalt", dir: ".my-config/plugins/basalt" }, ".my-config");
        app.vault.adapter.seed("note.md", "x");
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        expect(app.vault.adapter.filePaths()).toContain(".my-config/plugins/basalt/index.json");
        expect(app.vault.adapter.filePaths().filter((p) => !p.startsWith(".my-config/"))).toEqual(["note.md"]);
    }, 300_000);

    /**
     * `manifest.dir` is optional in Obsidian's API. Interpolating it without
     * looking produces "undefined/index.json" at the vault root, which the
     * never-sync list has no reason to skip, so the index would be uploaded and
     * then fought over by every device.
     */
    it("works out where it lives when Obsidian does not say", async () => {
        await fresh();
        const { plugin, app } = await load(null, { id: "basalt" });
        app.vault.adapter.seed("note.md", "x");
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        expect(app.vault.adapter.filePaths()).toContain(".obsidian/plugins/basalt/index.json");
        expect(app.vault.adapter.filePaths().some((p) => p.startsWith("undefined"))).toBe(false);
    }, 300_000);

    it("refuses to run from outside the config folder", async () => {
        // And says so. The loop that assembles the client runs detached, so
        // without somewhere for this to land the plugin would simply never
        // sync, with a status bar still saying "connecting".
        await fresh();
        const { plugin } = await load(null, { id: "basalt", dir: "somewhere/else" });
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await until("it to give up", () => plugin.currentState.kind === "stopped");
        expect(notices.map((n) => n.message).join(" ")).toMatch(/would sync/);
        expect(status(plugin)).toBe("Basalt: stopped");
    }, 300_000);
});

describe("pairing", () => {
    it("starts a vault, and syncs it", async () => {
        await fresh();
        const { plugin, app } = await load();
        app.vault.adapter.seed("note.md", "# Hello\n");

        const pairing = await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        expect(pairing).toMatch(/^basalt1_/);
        await synced(plugin);

        expect(plugin.paired).toBe(true);
        expect(plugin.deviceName).toBe("laptop");
        expect(status(plugin)).toBe("Basalt: 1 sent");
        // Saved in a form that survives the JSON round trip Obsidian does.
        expect(Object.keys(plugin.savedData as object).sort()).toEqual([
            "device",
            "secret",
            "token",
            "url",
            "vaultId",
        ]);
    }, 300_000);

    it("joins a vault another device started", async () => {
        await fresh();
        const first = await load();
        first.app.vault.adapter.seed("note.md", "# Hello\n");
        const pairing = await first.plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(first.plugin);

        const second = await load();
        await second.plugin.pair(pairing, "desktop");
        await synced(second.plugin);
        await until("the note to arrive", () => second.app.vault.adapter.text("note.md") !== undefined);

        expect(second.app.vault.adapter.text("note.md")).toBe("# Hello\n");
        expect(second.plugin.deviceName).toBe("desktop");
    }, 300_000);

    it("comes back paired after a restart", async () => {
        await fresh();
        const first = await load();
        first.app.vault.adapter.seed("note.md", "x");
        await first.plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(first.plugin);
        const saved = first.plugin.savedData;
        first.plugin.onunload();

        // Same data.json, a fresh plugin object. It must not ask to be paired.
        const again = await load(saved);
        expect(again.plugin.paired).toBe(true);
        await synced(again.plugin);
        expect(again.plugin.currentState.kind).toBe("synced");
    }, 300_000);

    /**
     * Re-pairing would replace the root secret. Everything already on the server
     * would stop being decryptable here, the vault would look empty, and the
     * local copies would then be uploaded under new keys. There is no coming
     * back from that.
     */
    it("refuses to pair a vault that is already paired", async () => {
        await fresh();
        const { plugin } = await load();
        const pairing = await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        await expect(plugin.pairFirst(server.wsUrl, server.token, "again")).rejects.toThrow(/already paired/);
        await expect(plugin.pair(pairing, "again")).rejects.toThrow(/already paired/);
    }, 300_000);

    it("refuses a pairing string that was mangled", async () => {
        const { plugin } = await load();
        await expect(plugin.pair("basalt1_notreally", "d")).rejects.toThrow();
        await expect(plugin.pair("hello", "d")).rejects.toThrow(/basalt1_/);
        expect(plugin.paired).toBe(false);
        expect(plugin.savedData).toBe(null);
    });

    it("needs a server to start a vault against", async () => {
        const { plugin } = await load();
        await expect(plugin.pairFirst("", "token", "d")).rejects.toThrow(/server address/);
        await expect(plugin.pairFirst("ws://host", "  ", "d")).rejects.toThrow(/token/);
        expect(plugin.paired).toBe(false);
    });

    it("reprints the pairing string for a third device", async () => {
        await fresh();
        const { plugin } = await load();
        const pairing = await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        expect(plugin.invite()).toBe(pairing);
    }, 300_000);

    it("has nothing to invite anybody with before it is paired", async () => {
        const { plugin } = await load();
        expect(plugin.invite()).toBeUndefined();
    });
});

describe("syncing while it runs", () => {
    it("syncs when Obsidian says a file changed", async () => {
        await fresh();
        const a = await load();
        await a.plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(a.plugin);

        const b = await load();
        await b.plugin.pair(a.plugin.invite()!, "desktop");
        await synced(b.plugin);

        // A note appears, and Obsidian says so. Nothing else prompts a sync
        // here: the 30 second backstop would not have fired yet.
        const before = a.plugin.currentState;
        a.app.vault.adapter.seed("fresh.md", "written just now");
        a.app.vault.fire("create");

        // The nudge coalesces for 400ms before it looks, so this waits for the
        // state to move rather than for a state it is already in.
        await until("A to act on the event", () => a.plugin.currentState !== before);

        // B has to be told. Its own backstop is 30 seconds away, so it is asked.
        for (let i = 0; i < 10 && b.app.vault.adapter.text("fresh.md") === undefined; i++) {
            await b.plugin.syncNow();
            await new Promise((r) => setTimeout(r, 100));
        }
        expect(b.app.vault.adapter.text("fresh.md")).toBe("written just now");
    }, 300_000);

    it("says what happened when asked to sync", async () => {
        await fresh();
        const { plugin, app } = await load();
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        app.vault.adapter.seed("another.md", "x");
        notices.length = 0;
        // Obsidian's Command.callback returns void, so the command can only
        // start the work. Waiting for the notice is waiting for the same thing
        // a person waits for.
        await plugin.runCommand("sync-now");
        await until("the command to report", () => notices.length > 0);
        expect(notices.map((n) => n.message).join(" ")).toMatch(/sent|up to date/);
    }, 300_000);

    it("says so rather than nothing when it is not paired", async () => {
        const { plugin } = await load();
        await plugin.runCommand("sync-now");
        await until("the command to report", () => notices.length > 0);
        expect(notices.map((n) => n.message).join(" ")).toMatch(/not paired/);
    });

    /**
     * A conflict is one of two outcomes that do not resolve themselves, and a
     * status bar nobody is looking at is not how somebody finds out about it.
     */
    it("tells the user when it kept both versions", async () => {
        await fresh();
        const a = await load();
        a.app.vault.adapter.seed("note.md", "# Note\n\nThe original sentence.\n");
        await a.plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(a.plugin);

        const b = await load();
        await b.plugin.pair(a.plugin.invite()!, "desktop");
        await synced(b.plugin);
        await until("the note to arrive", () => b.app.vault.adapter.text("note.md") !== undefined);

        a.app.vault.adapter.seed("note.md", "# Note\n\nA's completely different sentence.\n", 9_000_000_000_000);
        b.app.vault.adapter.seed("note.md", "# Note\n\nB's entirely other sentence.\n", 9_000_000_000_000);
        notices.length = 0;
        for (let i = 0; i < 5; i++) {
            await a.plugin.syncNow();
            await b.plugin.syncNow();
        }

        const said = notices.map((n) => n.message).join(" ");
        expect(said, `notices were: ${said}`).toMatch(/Conflicted copy/);
        const all = b.app.vault.adapter
            .filePaths()
            .filter((p) => !p.startsWith(".obsidian/"))
            .map((p) => b.app.vault.adapter.text(p))
            .join("\n");
        expect(all).toContain("A's completely different sentence");
        expect(all).toContain("B's entirely other sentence");
    }, 300_000);
});

describe("when things go wrong", () => {
    /**
     * A dead connection has to be forgotten, not just noticed.
     *
     * The loop clears the client when a connection ends. If it did not, "sync
     * now" would reach for a socket that is gone: the person would get an
     * exception rather than a sentence, and the plugin would look broken rather
     * than offline.
     */
    it("says it is offline rather than reaching for a dead connection", async () => {
        await fresh();
        const { plugin } = await load();
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        await server.cleanup();
        await until("it to notice", () => plugin.currentState.kind === "offline");

        notices.length = 0;
        await plugin.syncNow();
        expect(notices.map((n) => n.message).join(" ")).toMatch(/not connected/);
        expect(status(plugin)).toBe("Basalt: offline");
    }, 300_000);

    /**
     * A file the server will refuse for the same reason every time.
     *
     * The engine stops retrying it, which is right: retrying forever is noise
     * that hides everything else. But a file that will never sync and nobody
     * mentions is a note quietly left behind, so it is said out loud. This uses
     * a path past the server's limit, which is the cheapest permanent refusal
     * there is.
     */
    it("says out loud when a file can never sync", async () => {
        await fresh();
        const { plugin, app } = await load();
        app.vault.adapter.seed("fine.md", "this one is ok");
        app.vault.adapter.seed(`${"far/".repeat(1200)}too-deep.md`, "this one is not");

        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);
        notices.length = 0;
        await plugin.syncNow();

        const said = notices.map((n) => n.message).join(" ");
        expect(said, `notices were: ${said}`).toMatch(/cannot sync/);
        // And the refusal did not stop the file that was fine.
        expect(status(plugin)).toMatch(/stuck/);
    }, 300_000);
});

describe("unlinking", () => {
    it("forgets the pairing and keeps every note", async () => {
        await fresh();
        const { plugin, app } = await load();
        app.vault.adapter.seed("keep.md", "still here");
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        expect(app.vault.adapter.filePaths()).toContain(".obsidian/plugins/basalt/index.json");

        await plugin.unlink();
        expect(plugin.paired).toBe(false);
        expect(plugin.savedData).toBe(null);
        expect(status(plugin)).toBe("Basalt: not paired");
        expect(app.vault.adapter.text("keep.md")).toBe("still here");

        // The index goes too. It records what this device believes it has
        // already synced, and left behind it would be read as fact by the next
        // pairing, possibly against a different server entirely.
        expect(app.vault.adapter.filePaths()).not.toContain(".obsidian/plugins/basalt/index.json");
    }, 300_000);

    /**
     * Unlinking and pairing again has to be a genuinely fresh start.
     *
     * This is the failure the stale index would cause: a cursor and a set of
     * entries from the old pairing, read as the truth about a server that has
     * never seen this device, so notes that were never uploaded are treated as
     * already sent.
     */
    it("starts clean when paired again afterwards", async () => {
        await fresh();
        const { plugin, app } = await load();
        app.vault.adapter.seed("note.md", "the only note");
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);
        await plugin.unlink();

        // A different server, which has never heard of this device.
        const second = new TestServer();
        await second.start();
        try {
            await plugin.pairFirst(second.wsUrl, second.token, "laptop-again");
            await synced(plugin);
            await plugin.syncNow();

            // The note must have been uploaded to the new server, not assumed
            // to be there already.
            const elsewhere = await load();
            await elsewhere.plugin.pair(plugin.invite()!, "other");
            await synced(elsewhere.plugin);
            await until("the note to arrive", () => elsewhere.app.vault.adapter.text("note.md") !== undefined);
            expect(elsewhere.app.vault.adapter.text("note.md")).toBe("the only note");
        } finally {
            await second.cleanup();
        }
    }, 300_000);
});

describe("the modal, which is not a settings tab", () => {
    it("asks to be paired when it is not", async () => {
        const { plugin } = await load();
        plugin.ribbonIcons[0]!.callback();

        const names = built.map((s) => s.name);
        expect(names).toContain("Pairing string");
        expect(names).toContain("Device name");
        expect(names).toContain("Server");
        // No options anywhere in it. docs/philosophy.md refuses a settings
        // screen, and this is the thing that would quietly become one.
        expect(names.filter((n) => n.toLowerCase().includes("enable"))).toEqual([]);
    });

    it("pairs from what was typed into it", async () => {
        await fresh();
        const first = await load();
        const pairing = await first.plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(first.plugin);

        const second = await load();
        second.plugin.ribbonIcons[0]!.callback();

        built.find((s) => s.name === "Device name")!.texts[0]!.type("desktop");
        built.find((s) => s.name === "Pairing string")!.texts[0]!.type(pairing);
        await built.find((s) => s.buttons.some((b) => b.label === "Pair"))!.buttons[0]!.click();

        expect(second.plugin.paired).toBe(true);
        expect(second.plugin.deviceName).toBe("desktop");
        await synced(second.plugin);
    }, 300_000);

    /**
     * Not every place this runs has a clipboard: mobile webviews and anything
     * outside a secure context do not. A copy button that silently does nothing
     * is how somebody concludes the pairing string cannot be got at.
     */
    it("shows the pairing string when there is no clipboard to copy it to", async () => {
        await fresh();
        const { plugin } = await load();
        const pairing = await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        built.length = 0;
        notices.length = 0;
        plugin.ribbonIcons[0]!.callback();
        const copy = built.find((s) => s.name === "Add another device")!.buttons[0]!;
        await copy.click();

        // Node has no navigator.clipboard, which is the case being tested.
        expect(notices.map((n) => n.message).join(" ")).toMatch(/no clipboard/);
        // And the whole string is on screen instead, so it can still be copied
        // by hand. Truncating it would be the same as not showing it.
        expect(modals.at(-1)!.contentEl.allText()).toContain(pairing);
    }, 300_000);

    it("shows what is happening once it is paired", async () => {
        await fresh();
        const { plugin } = await load();
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        built.length = 0;
        plugin.ribbonIcons[0]!.callback();
        const names = built.map((s) => s.name);
        expect(names).toContain("Sync now");
        expect(names).toContain("Add another device");
        expect(names).toContain("Unlink this vault");
        expect(names).not.toContain("Pairing string");
    }, 300_000);

    it("says what went wrong rather than failing quietly", async () => {
        const { plugin } = await load();
        plugin.ribbonIcons[0]!.callback();
        built.find((s) => s.name === "Pairing string")!.texts[0]!.type("this is not a pairing string");
        notices.length = 0;
        await built.find((s) => s.buttons.some((b) => b.label === "Pair"))!.buttons[0]!.click();

        expect(notices.map((n) => n.message).join(" ")).toMatch(/basalt1_/);
        expect(plugin.paired).toBe(false);
    });
});
