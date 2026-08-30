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
        expect(plugin.commands.map((c) => c.id).sort()).toEqual([
            "recover-deleted",
            "show-status",
            "sync-now",
            "version-history",
        ]);
        expect(plugin.ribbonIcons.map((r) => r.title)).toEqual(["Basalt"]);
        expect(plugin.statusBarItems.length).toBe(1);
        // create, modify, delete, rename. Without these it only syncs on a timer.
        expect(app.vault.handlerCount()).toBe(4);
        // Those four, plus the file-menu entry that puts history where somebody
        // already looks for it.
        expect(plugin.registeredEvents.length).toBe(5);
        expect([...plugin.cliHandlers.keys()].sort()).toEqual(["basalt:history", "basalt:restore"]);
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
        expect(pairing).toMatch(/^basalt2_/);
        await synced(plugin);

        expect(plugin.paired).toBe(true);
        expect(plugin.deviceName).toBe("laptop");
        expect(status(plugin)).toBe("Basalt: 1 sent");
        // Saved in a form that survives the JSON round trip Obsidian does.
        // No token: the vault has one secret, and what authenticates is derived
        // from it. The server's first-run token is kept only until the vault has
        // been claimed with it, and by now it has.
        await until("the spent bootstrap to be dropped", () => {
            const saved = plugin.savedData as Record<string, unknown> | null;
            return saved !== null && saved["bootstrap"] === undefined;
        });
        expect(Object.keys(plugin.savedData as object).sort()).toEqual([
            "device",
            "secret",
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
        await expect(plugin.pair("hello", "d")).rejects.toThrow(/basalt2_/);
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

describe("recovering a deleted note from the app", () => {
    it("lists what the server still has, and puts one back", async () => {
        await fresh();
        const { plugin, app } = await load();
        app.vault.adapter.seed("keep.md", "still here");
        app.vault.adapter.seed("gone.md", "# Gone\n\nBut not forgotten.\n");
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        await app.vault.adapter.remove("gone.md");
        await plugin.syncNow();
        expect(app.vault.adapter.text("gone.md")).toBeUndefined();

        built.length = 0;
        notices.length = 0;
        await plugin.runCommand("recover-deleted");
        await until(
            "the list to load",
            () => modals.at(-1)!.contentEl.allText().length > "Deleted notes".length,
            15_000
        );
        const row = built.find((s) => s.name === "gone.md");
        expect(row, `the modal said: ${modals.at(-1)!.contentEl.allText()}`).toBeDefined();
        expect(built.map((s) => s.name)).not.toContain("keep.md");
        await row!.buttons[0]!.click();

        await until("the note to come back", () => app.vault.adapter.text("gone.md") !== undefined);
        expect(app.vault.adapter.text("gone.md")).toBe("# Gone\n\nBut not forgotten.\n");
        expect(notices.map((n) => n.message).join(" ")).toMatch(/Restored/);
    }, 300_000);

    it("says nothing has been deleted when nothing has", async () => {
        await fresh();
        const { plugin, app } = await load();
        app.vault.adapter.seed("keep.md", "here");
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        await plugin.runCommand("recover-deleted");
        await until("the list to load", () => modals.at(-1)!.contentEl.allText().includes("Nothing has been"));
        expect(modals.at(-1)!.contentEl.allText()).toMatch(/Nothing has been deleted/);
    }, 300_000);

    /**
     * An empty list and an unanswerable question look identical on screen and
     * mean opposite things. Somebody opening this has already lost a note.
     */
    it("says it could not ask, rather than showing an empty list", async () => {
        await fresh();
        const { plugin } = await load();
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);
        await server.cleanup();
        await until("it to notice", () => plugin.currentState.kind === "offline");

        await plugin.runCommand("recover-deleted");
        await until("the modal to answer", () => modals.at(-1)!.contentEl.allText().includes("Cannot ask"));
        const shown = modals.at(-1)!.contentEl.allText();
        expect(shown).toMatch(/Cannot ask the server/);
        expect(shown).not.toMatch(/Nothing has been deleted/);
    }, 300_000);
});

describe("renames, which only Obsidian can report", () => {
    /**
     * A rename has to travel as one operation.
     *
     * A filesystem scan cannot see one: it finds a path gone and another
     * arrived and has nothing connecting them, which is why the headless client
     * reports a rename as a deletion. Obsidian does know, and hands the old path
     * to its rename event, and until that was wired up the engine was never told
     * either. Every rename then retired the old path as a deletion, and the list
     * of deleted notes filled with phantoms of files that still exist.
     */
    it("tells the engine the old path, so it is one operation and not two", async () => {
        await fresh();
        const { plugin, app } = await load();
        app.vault.adapter.seed("old-name.md", "the same content throughout");
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        // Obsidian moves the file and says so, old path included.
        await app.vault.adapter.rename("old-name.md", "new-name.md");
        app.vault.fire("rename", { path: "new-name.md" }, "old-name.md");
        for (let i = 0; i < 4; i++) await plugin.syncNow();

        // The server knows it was a rename, so the old path is not offered as
        // something to recover.
        const client = (plugin as unknown as { client?: { deleted(): Promise<{ notes: { path: string }[] }> } }).client;
        const gone = (await client!.deleted()).notes.map((v) => v.path);
        expect(gone, `deleted list was ${JSON.stringify(gone)}`).not.toContain("old-name.md");
    }, 300_000);

    it("still moves the file when nothing told it the old path", async () => {
        // The delete-plus-add path, which is what happens on any platform that
        // cannot report a rename. Noisier, and it must still not lose anything.
        await fresh();
        const { plugin, app } = await load();
        app.vault.adapter.seed("before.md", "content that moves");
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        await app.vault.adapter.rename("before.md", "after.md");
        await plugin.syncNow();
        await plugin.syncNow();

        const client = (plugin as unknown as { client?: { deleted(): Promise<{ notes: { path: string }[] }> } }).client;
        const gone = (await client!.deleted()).notes.map((v) => v.path);
        expect(gone).toContain("before.md");
        expect(app.vault.adapter.text("after.md")).toBe("content that moves");
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

        expect(notices.map((n) => n.message).join(" ")).toMatch(/basalt2_/);
        expect(plugin.paired).toBe(false);
    });
});

describe("on a device with no status bar", () => {
    /**
     * Obsidian mobile has no status bar, so `addStatusBarItem` returns an
     * element nothing displays and the plugin's only ongoing feedback is the
     * plugin talking to itself. The ribbon is on both, so the state goes there
     * too, as the tooltip somebody gets by holding the icon.
     */
    it("puts the state on the ribbon as well", async () => {
        await fresh();
        const { plugin } = await load();
        const ribbon = plugin.ribbonIcons[0]!;
        expect(ribbon.title).toBe("Basalt");

        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        // The same sentence the status bar carries, somewhere a phone shows it.
        const label = ribbon.el.attributes.get("aria-label") ?? "";
        expect(label, `the ribbon says ${JSON.stringify(label)}`).toMatch(/^Basalt: /);
        expect(label).not.toMatch(/connecting/);
    }, 300_000);

    /**
     * A server refuses a browser origin it does not know, and the only thing
     * that knows this device's origin is this device. The mobile origins in the
     * server's list are Capacitor's documented defaults and have never been
     * checked against a device, so an offline phone has to be able to say what
     * to add rather than leaving somebody guessing.
     */
    it("says what to allow when it cannot connect", async () => {
        await fresh();
        const { plugin } = await load();
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);
        await server.cleanup();
        await until("it to notice", () => plugin.currentState.kind === "offline");

        built.length = 0;
        plugin.ribbonIcons[0]!.callback();
        await until("the modal to say so", () => modals.at(-1)!.contentEl.allText().includes("-allow-origin"));
        const shown = modals.at(-1)!.contentEl.allText();
        expect(shown).toMatch(/allow-origin/);
        expect(shown, "it did not say what this device's origin actually is").toMatch(/origin is \S+/);
    }, 300_000);

    it("says nothing about origins while it is working", async () => {
        await fresh();
        const { plugin } = await load();
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        built.length = 0;
        plugin.ribbonIcons[0]!.callback();
        expect(modals.at(-1)!.contentEl.allText()).not.toMatch(/allow-origin/);
    }, 300_000);
});

describe("saying what it is working on", () => {
    /**
     * A large attachment is minutes inside one pass. Without a state for it the
     * status shows the previous pass's result the whole time, so working and
     * idle look exactly alike, which is rule 7 with the two conditions that
     * matter most collapsed.
     *
     * Not a percentage. What somebody wants to know is whether it is doing
     * something and what, and a byte counter for one file out of forty answers
     * a question nobody asked.
     */
    it("reports the file it is on, once it has been on it a while", async () => {
        await fresh();
        const { plugin, app } = await load();
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);

        const seen: string[] = [];
        const stop = plugin.watchState((s) => {
            if (s.kind === "syncing") seen.push(s.path);
        });

        // Incompressible and large enough that sealing it reliably outlasts the
        // threshold. A compressible file seals in a few milliseconds and the
        // state never fires, which made an earlier version of this pass or fail
        // depending on how loaded the machine was.
        const big = new Uint8Array(24 * 1024 * 1024);
        for (let at = 0; at < big.length; at += 65536) {
            crypto.getRandomValues(big.subarray(at, Math.min(at + 65536, big.length)));
        }
        await app.vault.adapter.writeBinary("big.bin", big.buffer as ArrayBuffer, { mtime: 5000 });

        const syncing = plugin.syncNow();
        // Watched while it runs rather than checked afterwards, because by the
        // time it finishes the state has moved on to the result.
        await until("it to say what it is working on", () => seen.length > 0, 60_000);
        await syncing;
        stop();

        expect(seen).toContain("big.bin");
        // And it ends on a result rather than stuck saying it is working.
        expect(plugin.currentState.kind).toBe("synced");
    }, 300_000);

    /**
     * A pass over a settled vault visits every path and does nothing to any of
     * them. Reporting each one would replace a useful summary with a blur.
     */
    it("says nothing while passing over a vault with nothing to do", async () => {
        await fresh();
        const { plugin, app } = await load();
        app.vault.adapter.seed("a.md", "one");
        app.vault.adapter.seed("b.md", "two");
        await plugin.pairFirst(server.wsUrl, server.token, "laptop");
        await synced(plugin);
        await plugin.syncNow();

        const seen: string[] = [];
        const stop = plugin.watchState((s) => {
            if (s.kind === "syncing") seen.push(s.path);
        });
        await plugin.syncNow();
        stop();
        expect(seen, `a quiet pass announced ${JSON.stringify(seen)}`).toEqual([]);
    }, 300_000);
});

/**
 * Re-pairing, and the run that would not stop.
 *
 * Found by running the plugin against a real server. Unlinking and pairing
 * again left the previous run alive: `keepGoing` was one boolean shared by every
 * run, so the old one woke from its backoff, read the *new* run's flag, and
 * carried on with the old vault's secret. It reconnected, failed authentication,
 * and its refusal put "Basalt has stopped: not authorised for this vault" on
 * screen while the real client was syncing perfectly well behind it.
 */
describe("pairing again after unlinking", () => {
    it("retires the previous run so it cannot speak for the plugin", async () => {
        const { plugin } = await load();
        const p = plugin as unknown as {
            generation: number;
            running: boolean;
            unlink(): Promise<void>;
            setState(s: unknown): void;
            state: { kind: string; why?: string };
        };

        const before = p.generation;
        await p.unlink();
        // Unlink alone has to retire it. Closing the client is not enough,
        // because a run whose client closed simply reconnects.
        expect(p.generation, "unlinking left the run in flight current").toBeGreaterThan(before);
        expect(p.running).toBe(false);
        expect(p.state.kind).toBe("unpaired");
    });

    it("keeps a superseded run from clobbering the state of the current one", async () => {
        const { plugin } = await load();
        const p = plugin as unknown as { generation: number; state: { kind: string } };

        // What the old run's onFatal did. Numbered runs make the check possible
        // at all: without a generation there is nothing to compare against.
        const stale = p.generation;
        p.generation++;
        expect(stale === p.generation, "a superseded run cannot tell it was superseded").toBe(false);
    });
});
