/**
 * The config folder the headless client refuses to sync.
 *
 * The plugin asks Obsidian for it, because Obsidian knows. This cannot ask
 * anything, so it assumed `.obsidian` and had no way to be told otherwise: a
 * vault whose config folder had been renamed in the app had it synced by the
 * headless client and refused by the plugin, which is the same vault
 * disagreeing with itself about the one thing this project says it will not
 * sync.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseArgs } from "./cli.ts";
import { NodeVault, configFolderName } from "./vault.ts";

const made: string[] = [];

afterEach(async () => {
    for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A vault holding one note and two candidate config folders. */
async function vaultWith(dirs: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "basalt-configdir-"));
    made.push(root);
    await writeFile(join(root, "note.md"), "a note\n");
    for (const d of dirs) {
        await mkdir(join(root, d));
        await writeFile(join(root, d, "app.json"), "{}\n");
    }
    return root;
}

const paths = async (v: NodeVault): Promise<string[]> => (await v.list()).map((f) => f.path).sort();

describe("which config folder is left alone", () => {
    it("skips .obsidian when nobody says otherwise", async () => {
        const root = await vaultWith([".obsidian"]);
        expect(await paths(new NodeVault(root))).toEqual(["note.md"]);
    });

    it("skips the one it is told about, and syncs the one it is not", async () => {
        const root = await vaultWith([".obsidian-work"]);

        // The bug: with no way to be told, this folder was ordinary content.
        expect(await paths(new NodeVault(root))).toContain(".obsidian-work/app.json");

        const told = new NodeVault(root, { configDir: ".obsidian-work" });
        expect(await paths(told)).toEqual(["note.md"]);
    });

    it("leaves .obsidian to be synced when it is not the config folder", async () => {
        // Renaming the config folder makes the old name an ordinary one. Keeping
        // it hardcoded as well would be refusing to sync a folder the user may
        // now be using for notes.
        const root = await vaultWith([".obsidian", ".config-here"]);
        const held = await paths(new NodeVault(root, { configDir: ".config-here" }));
        expect(held).toContain(".obsidian/app.json");
        expect(held.some((p) => p.startsWith(".config-here"))).toBe(false);
    });

    it("also leaves alone whatever --ignore named", async () => {
        const root = await vaultWith([".obsidian", "scratch"]);
        const v = new NodeVault(root, { alsoIgnore: ["scratch"] });
        expect(await paths(v)).toEqual(["note.md"]);
    });
});

describe("what counts as a config folder name", () => {
    it("refuses anything that is not one folder at the root", () => {
        for (const bad of ["", "/", "a/b", "/leading/slash", "//"]) {
            expect(() => configFolderName(bad), `accepted ${JSON.stringify(bad)}`).toThrow(/not a plain name/);
        }
    });

    it("tolerates the slashes someone would type by hand", () => {
        expect(configFolderName("/.obsidian/")).toBe(".obsidian");
        expect(configFolderName("trailing/")).toBe("trailing");
    });
});

describe("the flags", () => {
    it("defaults the config folder and collects repeated ignores", () => {
        const args = parseArgs(["sync", "--ignore", "one", "--ignore", "two"]);
        expect(args.configDir).toBe(".obsidian");
        expect(args.ignore).toEqual(["one", "two"]);
    });

    it("takes a config folder, and refuses a bad one before opening anything", () => {
        expect(parseArgs(["sync", "--config-dir", ".obsidian-work"]).configDir).toBe(".obsidian-work");
        expect(() => parseArgs(["sync", "--config-dir", "a/b"])).toThrow(/not a plain name/);
    });

    it("refuses a flag that swallowed the next flag", () => {
        expect(() => parseArgs(["sync", "--config-dir", "--json"])).toThrow(/needs a value/);
        expect(() => parseArgs(["sync", "--ignore", "--json"])).toThrow(/needs a value/);
    });
});
