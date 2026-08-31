/**
 * The version history modal, against a real server.
 *
 * Sync's history is what somebody coming from it will expect, so this checks the
 * behaviours that matter rather than the markup: the list is newest first, the
 * pane shows the version you picked, the diff compares against what is on disk,
 * a restore never overwrites, and paging asks for what it does not already have.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { authToken, deriveKeys, type VaultKeys } from "../core/crypto.ts";
import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import { FakeAdapter, FakeVaultIndex, asVault } from "./fake.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";
import { App, notices } from "./stub.ts";
import { HistoryModal, PAGE, diffLines, type HistorySource } from "./history.ts";

const SECRET = new Uint8Array(20).fill(91);
let keys: VaultKeys;
let server: TestServer;
const clients: Client[] = [];

beforeAll(async () => {
  await serverBinary();
  keys = await deriveKeys(SECRET);
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

afterEach(async () => {
  while (clients.length) clients.pop()!.close();
  if (server) await server.cleanup();
  notices.length = 0;
});

/** One device, plus the source the modal talks to. */
async function device(): Promise<{ adapter: FakeAdapter; client: Client; source: HistorySource }> {
  server = new TestServer();
  await server.start();
  const adapter = new FakeAdapter();
  const client = new Client({
    vault: new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian"),
    store: new ObsidianIndexStore(adapter, ".obsidian/plugins/basalt/index.json"),
    keys,
    url: server.wsUrl,
    ...server.credentials(authToken(keys)),
    vaultId: "default",
    device: "laptop",
    timeoutMs: 20_000,
    coalesceWrites: false,
  });
  clients.push(client);
  await client.connect();

  const source: HistorySource = {
    history: (path, opts) => client.history(path, opts),
    contentAt: async (v) => new TextDecoder().decode(await client.contentAt(v)),
    restoreVersion: async (v) => (await client.restore(v)).path,
    currentText: async (path) => adapter.text(path),
  };
  return { adapter, client, source };
}

/** Writes a note and syncs, once per revision, so the server holds a history. */
async function revisions(
  adapter: FakeAdapter,
  client: Client,
  path: string,
  texts: string[],
): Promise<void> {
  let at = 0;
  for (const text of texts) {
    // mtime advanced explicitly. The fake adapter's clock does not move on
    // its own, and the engine rehashes on a changed stat, so without this a
    // same-length revision is correctly seen as no change at all.
    await adapter.write(path, text, { mtime: 2_000_000 + ++at * 60_000, ctime: 2_000_000 });
    await client.settle({ coalesceWrites: false });
  }
}

describe("version history", () => {
  it("lists every version of a note, newest first", async () => {
    const { adapter, client, source } = await device();
    await revisions(adapter, client, "note.md", ["one\n", "one\ntwo\n", "one\ntwo\nthree\n"]);

    const versions = await source.history("note.md", { limit: PAGE });
    expect(versions.length).toBe(3);
    // Newest first is what the sidebar renders in order, so it is the list
    // that has to be sorted, not the view.
    expect(versions[0]!.uid).toBeGreaterThan(versions[1]!.uid);
    expect(versions[1]!.uid).toBeGreaterThan(versions[2]!.uid);

    // And each one reads back as what was written at the time.
    expect(await source.contentAt(versions[0]!)).toBe("one\ntwo\nthree\n");
    expect(await source.contentAt(versions[2]!)).toBe("one\n");
  });

  it("restores an old version without overwriting the note that is there", async () => {
    const { adapter, client, source } = await device();
    await revisions(adapter, client, "note.md", ["first\n", "second\n"]);

    const versions = await source.history("note.md", { limit: PAGE });
    const oldest = versions[versions.length - 1]!;
    const at = await source.restoreVersion(oldest);

    // The point of the whole thing: the note you have open is untouched.
    expect(at).not.toBe("note.md");
    expect(adapter.text("note.md")).toBe("second\n");
    expect(adapter.text(at)).toBe("first\n");
  });

  it("shows the version you picked, and a diff against what is on disk", async () => {
    const { adapter, client, source } = await device();
    await revisions(adapter, client, "note.md", ["alpha\nbravo\n", "alpha\nbravo\ncharlie\n"]);

    const versions = await source.history("note.md", { limit: PAGE });
    const older = await source.contentAt(versions[1]!);
    const now = (await source.currentText("note.md"))!;
    const diff = diffLines(older, now);

    expect(diff).toContain("+ charlie");
    expect(diff).not.toContain("- alpha");
    // Identical inputs must say so rather than rendering an empty box that
    // reads as "failed to load".
    expect(diffLines(now, now)).toMatch(/No difference/);
  });

  it("pages backwards from the oldest version it already holds", async () => {
    const { adapter, client, source } = await device();
    const texts = Array.from({ length: PAGE + 5 }, (_, i) => `revision ${i}\n`.repeat(i + 1));
    await revisions(adapter, client, "note.md", texts);

    const first = await source.history("note.md", { limit: PAGE });
    expect(first.length).toBe(PAGE);
    const next = await source.history("note.md", {
      limit: PAGE,
      before: first[first.length - 1]!.uid,
    });

    expect(next.length).toBe(5);
    // No overlap, or the sidebar would show the same version twice and
    // "load more" would appear to do nothing.
    const seen = new Set(first.map((v) => v.uid));
    expect(next.every((v) => !seen.has(v.uid))).toBe(true);
  });

  it("says so rather than showing an empty list when there is no history", async () => {
    const { source } = await device();
    const modal = new HistoryModal(new App() as never, source, "never-existed.md");
    modal.open();
    await settle();

    expect(rendered(modal)).toMatch(/no history/i);
  });

  it("renders the versions and offers a restore for the one selected", async () => {
    const { adapter, client, source } = await device();
    await revisions(adapter, client, "note.md", ["one\n", "one\ntwo\n"]);

    const modal = new HistoryModal(new App() as never, source, "note.md");
    modal.open();
    await settle();

    // Opens on the newest version, so the pane is never dead space and the
    // common case takes no clicks. "Select a version to see it." as the
    // opening state is what this replaced.
    expect(rows(modal).length).toBe(2);
    expect(rendered(modal)).not.toMatch(/Select a version/);
    expect(rendered(modal)).toContain("one\ntwo\n");
    expect(rendered(modal)).toContain("Restore");

    rows(modal)[1]!.click();
    await settle();
    const text = rendered(modal);
    expect(text).toContain("Restore");
    expect(text).toContain("one\n");
  });
});

/** Lets the modal's queued reads finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 20));
}

function rendered(modal: HistoryModal): string {
  return (modal.contentEl as unknown as { allText(): string }).allText();
}

/** The clickable version rows, in the order they are drawn. */
function rows(modal: HistoryModal): { click(): void }[] {
  const found: { click(): void }[] = [];
  walk(modal.contentEl as unknown as FakeNode, (el) => {
    // The exact class token, not a substring: the header and details divs
    // inside each row are `modal-sidebar-list-item-header` and
    // `-details`, and a substring match counts every row three times.
    if (el.cls.split(" ").includes("modal-sidebar-list-item")) {
      found.push({ click: () => el.fire("click") });
    }
  });
  return found;
}

interface FakeNode {
  cls: string;
  tag: string;
  children: FakeNode[];
  fire(event: string): void;
  allText(): string;
}

function walk(node: FakeNode, visit: (n: FakeNode) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}

/**
 * styles.css colours additions and removals. It can only do that if the diff is
 * made of elements carrying those classes, and for a while it was not: the diff
 * went into the <pre> as one run of text, both rules matched nothing, and every
 * diff rendered in a single colour. Nothing failed, it just looked wrong, which
 * is why this asserts on the markup and not on the text.
 */
it("marks up added and removed lines so the stylesheet can colour them", async () => {
  const { adapter, client, source } = await device();
  await revisions(adapter, client, "note.md", ["one\ntwo\n", "one\nthree\n"]);

  const modal = new HistoryModal(new App() as never, source, "note.md");
  modal.open();
  await settle();

  // The oldest version, against what is on disk now.
  rows(modal)[1]!.click();
  await settle();
  const toggle = buttons(modal).find((b) => b.text.includes("Show changes"));
  expect(toggle, "no toggle to switch to the diff").toBeDefined();
  toggle!.click();
  await settle();

  const classes = classesIn(modal);
  expect(classes).toContain("basalt-removed");
  expect(classes).toContain("basalt-added");
});

/** Every class token present anywhere under the modal. */
function classesIn(modal: HistoryModal): Set<string> {
  const found = new Set<string>();
  walk(modal.contentEl as unknown as FakeNode, (el) => {
    for (const c of el.cls.split(" ")) if (c !== "") found.add(c);
  });
  return found;
}

/** The modal's buttons, as text plus a click. */
function buttons(modal: HistoryModal): { text: string; click(): void }[] {
  const found: { text: string; click(): void }[] = [];
  walk(modal.contentEl as unknown as FakeNode, (el) => {
    if (el.tag === "button") found.push({ text: el.allText(), click: () => el.fire("click") });
  });
  return found;
}

/**
 * The modal has to say which note it belongs to. It calls setTitle, but
 * mod-sidebar-layout collapses the modal header to nothing, so for a while the
 * title was set and never drawn: the window named no note at all.
 */
it("names the note whose history it is showing", async () => {
  const { adapter, client, source } = await device();
  await revisions(adapter, client, "Projects/note.md", ["one\n"]);

  const modal = new HistoryModal(new App() as never, source, "Projects/note.md");
  modal.open();
  await settle();

  // In the body, not just in titleEl, because titleEl is the part that does
  // not render.
  expect(rendered(modal)).toContain("Projects/note.md");
});
