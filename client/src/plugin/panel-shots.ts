/**
 * The panel, in every state it has, written down so somebody can look at it.
 *
 * Two layout bugs have been found here by taking a screenshot and none by a
 * test: `de4d519` put the device rows above the row that offers them and
 * `dae9dcb` found four things in the history modal the same way. `main.ts:1907`
 * says it out loud, that a screenshot is a better reviewer of layout than a
 * test is. What that leaves is a review step that only happens when somebody
 * remembers to do it by hand, on a machine with Obsidian on it.
 *
 * ## Why this is not a screenshot, and cannot be
 *
 * Say it plainly rather than substitute quietly. A picture of this panel needs
 * Obsidian, and CI cannot have Obsidian:
 *
 * - The application is proprietary and is not redistributable, so no runner
 *   installs it. The local recipe is Electron's `capturePage` inside a running
 *   copy, on a machine somebody logged into.
 * - Every pixel of the panel's appearance comes from Obsidian's own theme.
 *   `styles.css` in this repository styles the history modal and the status
 *   bar glyph and nothing else, and the two classes the panel does apply,
 *   `basalt-advice` and `basalt-pairing`, are not in it at all. The modal
 *   chrome, the `.setting-item` name/description/control layout and the
 *   button variants are all theirs.
 * - So a headless browser would need that stylesheet to draw anything true,
 *   and approximating it would produce a picture of a panel that does not
 *   exist. Rule: verify against the artifact, never infer. A rendering that
 *   looks like a screenshot and is not one is worse than no screenshot,
 *   because the next layout bug would be reviewed against a fiction.
 *
 * What CI can have is everything except the pixels: which elements the panel
 * builds, in what order, nested how, carrying what words. Some of what those
 * screenshots found lives in that half, and it is worth being exact about how
 * much, because overstating this would be the same sin as faking the picture.
 * `de4d519` was entirely in it: a container in the wrong place in a child
 * list. Of `dae9dcb`'s four, three were: the pane opened empty, the diff went
 * into the `<pre>` as one run of text with no spans for the colour rules to
 * match, and the modal never said which note it was. The fourth was not: the
 * pane rendered 314px wide inside 1080px of modal, which is geometry and has
 * no representation here at all.
 *
 * So four of five, and the fifth is the shape of everything this misses: a row
 * too narrow for its text, a button under Obsidian's floating close control, a
 * colour nobody can read. Those still need a person and a screenshot, and
 * `docs/assets/screenshots` is still where they go.
 *
 * The output is deliberately not a gate. It is uploaded so that it is always
 * there to look at, the way the todo entry asked, and so that a reviewer can
 * diff two runs by eye without anybody having to keep a golden file honest.
 * `panel-shots.test.ts` is the gate, and it checks the narrow thing a gate can
 * check: that the walk really reached every state and captured something real
 * in each.
 *
 * Everything here runs against the stub in `stub.ts` and a real `basaltd`, so
 * the panel being captured is the panel the plugin builds, not a description
 * of it.
 */

import { App, type FakeEl, Plugin as StubPlugin, Setting, built, modals } from "./stub.ts";
import type { App as ObsidianApp, PluginManifest } from "obsidian";
import BasaltPlugin from "./main.ts";
import type { TestServer } from "../core/test-server.ts";
import { INVITE_PREFIX } from "../core/pairing.ts";

/** One panel state, captured. */
export interface Shot {
  /** A short name, used for the file and the heading. */
  readonly name: string;
  /** What puts the panel here, in one sentence. */
  readonly why: string;
  /** The outline of what was on screen. */
  readonly body: string;
}

/**
 * The `Setting` a row element belongs to.
 *
 * The stub records settings in a flat `built` array and puts an empty
 * `div.setting-item` in the tree, so the row's name, description and controls
 * are not in the tree at all. Walking the tree and looking each element up
 * here is what puts them back in the order they were drawn in, which is the
 * only order worth reading: `built` alone cannot say whether a row came before
 * or after the paragraph beneath it, and that is the bug `de4d519` was.
 */
function rowIndex(): Map<FakeEl, Setting> {
  const out = new Map<FakeEl, Setting>();
  for (const s of built) out.set(s.settingEl, s);
  return out;
}

/**
 * A string as lines that fit, rather than a string cut short.
 *
 * Truncating was the first attempt and it was wrong in a way worth recording:
 * the panel's longest strings are its most important ones. The device list's
 * summary is where "revoking does not un-read what that device already read"
 * lives, and the last-device row is where the `--allow-last` instruction
 * lives, and both sit well past the ninetieth character. A dump that cut them
 * off held every row of the panel and none of its warnings.
 */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  // Split on the string's own line breaks before wrapping each piece, rather
  // than flattening the lot. A `<p>` has none and does not care; the history
  // pane's `<pre>` is nothing but line structure, and that is the half of it
  // dae9dcb's monochrome diff was about.
  for (const source of text.split("\n")) {
    const flat = source.replace(/[ \t]+/g, " ").trim();
    if (flat === "") continue;
    let line = "";
    for (const word of flat.split(" ")) {
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** The width an outline wraps to: wide enough to read, narrow enough to diff. */
const WIDTH = 92;

/**
 * An element and everything under it, indented by depth.
 *
 * Tags and classes as well as text, because a class is how the panel asks the
 * theme for something and an element with the wrong one is invisible in a
 * text-only dump. Attributes too: the status glyph is a `data-icon` and
 * nothing else on the element says which picture it is.
 */
export function outlineOf(root: FakeEl, rows = rowIndex(), depth = 0): string {
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  const say = (label: string, value: string): void => {
    const indent = `${pad}  `;
    const gap = " ".repeat(label.length);
    for (const [i, line] of wrap(value, WIDTH - indent.length - label.length).entries()) {
      lines.push(`${indent}${i === 0 ? label : gap}${line}`);
    }
  };

  const cls = root.cls ? `.${root.cls.trim().split(/\s+/).join(".")}` : "";
  lines.push(`${pad}<${root.tag}${cls}>`);
  for (const [name, value] of root.attributes) say(`@${name}  `, value);
  if (root.text) say("text    ", root.text);

  const row = rows.get(root);
  if (row) {
    // The parts of a row the stub keeps off the tree. Named the way Obsidian
    // names them, so somebody reading this beside a screenshot can match them
    // up: the name and description are the left of a setting item and the
    // controls are the right.
    if (row.name) say("name    ", row.name);
    if (row.desc) say("desc    ", row.desc);
    for (const t of row.texts) {
      const value = t.getValue() ? ` value: ${t.getValue()}` : "";
      say("input   ", `placeholder: ${t.placeholder}${value}`);
    }
    for (const b of row.buttons) {
      const marks = [b.cta ? "cta" : "", b.warning ? "warning" : ""].filter(Boolean).join(" ");
      say("button  ", `[${b.label}]${marks ? ` (${marks})` : ""}`);
    }
  }

  for (const child of root.children) lines.push(outlineOf(child, rows, depth + 1));
  return lines.join("\n");
}

/**
 * The panel that is open, as an outline.
 *
 * Reads the newest modal rather than being handed one, because that is how the
 * plugin opens it: the ribbon callback constructs a `BasaltModal` and nothing
 * returns it. A capture that took a modal as an argument would be capturing a
 * modal this file built, which is a different panel.
 */
export function shotOfOpenPanel(name: string, why: string): Shot {
  const modal = modals.at(-1);
  if (!modal) throw new Error(`no panel is open to capture for "${name}"`);
  const rows = rowIndex();
  const parts = [outlineOf(modal.modalEl, rows)];
  if (modal.titleEl.text) parts.push(outlineOf(modal.titleEl, rows));
  parts.push(outlineOf(modal.contentEl, rows));
  return { name, why, body: parts.join("\n") };
}

/** The status bar item, which is the panel's other half and a glyph. */
export function shotOfStatusBar(plugin: StubPlugin, name: string, why: string): Shot {
  const item = plugin.statusBarItems[0];
  if (!item) throw new Error(`this plugin has no status bar item, for "${name}"`);
  return { name, why, body: outlineOf(item) };
}

/** Waits for something to become true, or says what it was waiting for. */
async function until(what: string, cond: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The plugin, wired to the stub, exactly as `main.test.ts` wires it. */
type Testable = BasaltPlugin & StubPlugin;

async function load(saved: unknown = null): Promise<Testable> {
  const plugin = new BasaltPlugin(
    new App() as unknown as ObsidianApp,
    { id: "basalt", dir: ".obsidian/plugins/basalt" } as unknown as PluginManifest,
  ) as unknown as Testable;
  plugin.savedData = saved;
  await plugin.onload();
  return plugin;
}

/** Opens the panel the way a person does, through the ribbon icon. */
function openPanel(plugin: Testable): void {
  const ribbon = plugin.ribbonIcons[0];
  if (!ribbon) throw new Error("the plugin drew no ribbon icon");
  built.length = 0;
  modals.length = 0;
  ribbon.callback();
}

/**
 * Presses a button on a row, found by the words beside it.
 *
 * By name rather than by index, because an index is a claim about layout and
 * layout is the thing under review here: a walk that pressed `built[4]` would
 * quietly capture a different state the day a row moved.
 */
async function pressRow(row: string, label: string): Promise<void> {
  const setting = built.find((s) => s.name === row);
  const button = setting?.buttons.find((b) => b.label === label);
  if (!button) throw new Error(`the panel has no "${label}" button on a "${row}" row`);
  await button.click();
}

/**
 * Clicks a plain button by its words.
 *
 * The history modal builds real `<button>` elements rather than `Setting`
 * rows, so `pressRow` cannot reach them and the tree has to be walked.
 */
function press(root: FakeEl, text: string): void {
  const button = descendants(root).find((el) => el.tag === "button" && el.text === text);
  if (!button) throw new Error(`nothing here is a button saying "${text}"`);
  button.fire("click");
}

/** Every element under one, itself included, in the order they were built. */
function descendants(root: FakeEl): FakeEl[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

/** The elements carrying a class, in document order. */
function matching(root: FakeEl, cls: string): FakeEl[] {
  return descendants(root).filter((el) => el.cls.split(/\s+/).includes(cls));
}

/** Whether anything under here carries a class, for waiting on a redraw. */
function hasClass(root: FakeEl, cls: string): boolean {
  return matching(root, cls).length > 0;
}

/** Closes whatever is open, so the next state starts from nothing. */
function closePanel(): void {
  modals.at(-1)?.close();
}

/**
 * The nine states the status glyph has, set directly.
 *
 * Driven through the private setter rather than produced for real, which is
 * what `main.test.ts` does for the same table and for the same reason: three
 * of them need a server to break in a particular way, and the thing being
 * captured is what the panel draws for a state, not how the state is reached.
 */
const STATUSES: { name: string; state: unknown }[] = [
  { name: "unpaired", state: { kind: "unpaired" } },
  { name: "connecting", state: { kind: "connecting" } },
  { name: "syncing", state: { kind: "syncing", path: "Daily/2026-09-04.md", since: Date.now() } },
  {
    name: "synced",
    state: { kind: "synced", summary: "4 sent, 2 received", at: Date.now(), refused: 0 },
  },
  {
    name: "synced-needing-attention",
    state: { kind: "synced", summary: "1 file needs attention", at: Date.now(), refused: 1 },
  },
  {
    name: "failed",
    state: { kind: "failed", why: "the server refused the entry", at: Date.now() },
  },
  {
    name: "offline",
    state: { kind: "offline", why: "connection refused", retryAt: Date.now() + 30_000, refused: 0 },
  },
  {
    name: "offline-origin-refused",
    state: {
      kind: "offline",
      why: "the server refused this origin",
      retryAt: Date.now() + 30_000,
      refused: 1,
    },
  },
  {
    name: "stopped",
    state: { kind: "stopped", why: "this device is no longer registered" },
  },
];

const setState = (plugin: Testable, state: unknown): void =>
  (plugin as unknown as { setState(s: unknown): void }).setState(state);

/**
 * Every panel state, walked and captured.
 *
 * Against a real `basaltd`, because the paired states are the ones with rows
 * in them and a paired panel is one that talked to a server. The caller owns
 * the server and the returned plugins: `onunload` on each, in reverse, and
 * then the server.
 */
export async function walkPanelStates(
  server: TestServer,
): Promise<{ shots: Shot[]; loaded: Testable[] }> {
  const shots: Shot[] = [];
  const loaded: Testable[] = [];

  // Not paired. The first thing anybody sees, and the only state that can
  // start a vault.
  const nobody = await load();
  loaded.push(nobody);
  openPanel(nobody);
  shots.push(shotOfOpenPanel("unpaired", "A fresh install, before anything is paired."));
  closePanel();

  // A config that cannot be read. Deliberately shows no pairing form: pairing
  // here would overwrite a credential that might be the only copy (rule 2).
  const broken = await load({ url: "ws://x", vaultId: "default", device: "d", secret: "AAAA" });
  loaded.push(broken);
  openPanel(broken);
  shots.push(
    shotOfOpenPanel(
      "config-unreadable",
      "Saved settings that will not parse. Rule 2: unreadable is not absent, so this offers no pairing form.",
    ),
  );
  closePanel();

  // Paired, connected, idle. Everything below hangs off this one.
  const laptop = await load();
  loaded.push(laptop);
  const recoveryKey = await laptop.pairFirst(server.setup, "laptop");
  await until("the first sync", () => laptop.currentState.kind === "synced");

  openPanel(laptop);
  shots.push(shotOfOpenPanel("paired", "Paired and up to date: the panel as it usually looks."));
  closePanel();

  // The recovery key, shown once and never again. Its own capture because it
  // is the one screen somebody has to act on before closing the panel.
  //
  // The field is set rather than the vault started again, because the setup
  // token this server printed has been spent by the pairing above and a second
  // server would be a second vault. It is the same `render()` either way: the
  // panel decides on the field and nothing else.
  openPanel(laptop);
  (modals.at(-1) as unknown as { freshRecoveryKey?: string }).freshRecoveryKey = recoveryKey;
  (modals.at(-1) as unknown as { render(): void }).render();
  shots.push(
    shotOfOpenPanel(
      "fresh-recovery-key",
      "Just after starting a vault. The key is shown here once and no device keeps it.",
    ),
  );
  closePanel();

  // The rejoin row, which is drawn rather than updated: a panel left open when
  // the server is restored under it has to grow the recovery it now needs.
  setState(laptop, {
    kind: "stopped",
    why: "the server is behind this device",
    recovery: "rejoin",
  });
  openPanel(laptop);
  shots.push(
    shotOfOpenPanel(
      "stopped-offering-rejoin",
      "The server came back older than this device. The extra row is the only way out, and it asks twice.",
    ),
  );
  closePanel();
  setState(laptop, { kind: "synced", summary: "up to date", at: Date.now(), refused: 0 });

  // The device list on a vault with one device, which is not loaded until
  // somebody asks for it and has no button on its only row.
  openPanel(laptop);
  await pressRow("Devices", "Show devices");
  await until("the device rows", () => built.some((s) => s.desc.includes("added ")));
  shots.push(
    shotOfOpenPanel(
      "devices-listed-last-device",
      "One device. Its row has no button: taking the last row off the server is the one revocation no device can undo, so it takes the recovery key.",
    ),
  );
  closePanel();

  // An invite. The string is on screen because not every device here has a
  // clipboard to put it in.
  openPanel(laptop);
  await pressRow("Add another device", "Create invite");
  await until("the invite string", () =>
    modals.at(-1)!.contentEl.allText().includes(INVITE_PREFIX),
  );
  shots.push(
    shotOfOpenPanel(
      "invite-created",
      "After pressing Create invite. The string is shown rather than only copied, because a phone may have no clipboard.",
    ),
  );
  const issued = modals
    .at(-1)!
    .contentEl.allText()
    .split(/\s+/)
    .find((word) => word.startsWith(INVITE_PREFIX));
  if (!issued) throw new Error("the panel showed no invite to redeem");
  closePanel();

  // A second device, so the rows have a Revoke button at all: the only row on
  // a one-device vault deliberately has none, because emptying the vault is
  // the recovery key's to do.
  const phone = await load();
  loaded.push(phone);
  await phone.pair(issued, "phone");
  await until("the phone's first sync", () => phone.currentState.kind === "synced");

  // And one more invite, left outstanding, because an invite nobody has
  // redeemed used to be the one authority on a vault that nothing could see.
  await laptop.createInvite();

  openPanel(laptop);
  await pressRow("Devices", "Show devices");
  await until("two device rows", () => built.filter((s) => s.desc.includes("added ")).length >= 2);
  shots.push(
    shotOfOpenPanel(
      "devices-listed",
      "Two devices and an outstanding invite. The rows must come below the row that offers them: they did not, and a screenshot is what found it (de4d519).",
    ),
  );

  // The second press is the one that acts. Captured mid-confirmation, because
  // that is the moment somebody is deciding.
  const revoke = built.flatMap((s) => s.buttons).find((b) => b.label === "Revoke");
  if (!revoke) throw new Error("no revocable device row was drawn");
  await revoke.click();
  shots.push(
    shotOfOpenPanel(
      "devices-revoke-confirming",
      "One press in. Revoking does not un-read what that device already read, and the panel has to say so.",
    ),
  );
  closePanel();

  // What the server still has and this vault does not: the whole of the
  // recovery interface, which is a list and a button each.
  built.length = 0;
  modals.length = 0;
  await laptop.runCommand("recover-deleted");
  // For a paragraph, not for any text: the heading is written before the
  // request goes out, so waiting for "something" captures the panel a
  // moment before it has anything to say.
  await until("the recover modal to answer", () =>
    (modals.at(-1)?.contentEl.children ?? []).some((c) => c.tag === "p"),
  );
  shots.push(
    shotOfOpenPanel(
      "recover-nothing-deleted",
      "The recovery list on a vault that has lost nothing. The only interface to the safety net.",
    ),
  );
  closePanel();

  // The version history of a note, which is the other modal and the one that
  // carries this repository's only real stylesheet. Three of the four defects
  // `dae9dcb` found by taking a screenshot were facts about this tree: an
  // empty pane, a diff with no spans in it, and a modal that never said which
  // note it was.
  await laptop.app.vault.adapter.write("Daily/2026-09-04.md", "# Today\n\nA first line.\n");
  await laptop.syncNow();
  // The second version replaces a line as well as adding one, so the diff
  // below has both an addition and a removal in it. styles.css has a rule for
  // each and for a while neither matched anything, so a fixture that only ever
  // added would leave half of that untested.
  await laptop.app.vault.adapter.write(
    "Daily/2026-09-04.md",
    "# Today\n\nA replaced line.\nA second line.\n",
  );
  await laptop.syncNow();

  built.length = 0;
  modals.length = 0;
  laptop.openHistory("Daily/2026-09-04.md");
  // Waited on the note's text, which the pane fetches over a round trip, and
  // not on anything the assertions check for. A walk that waited for the
  // heading would turn a missing heading into a timeout in a hook rather than
  // a failed assertion, and a hook that throws reports every test in the file
  // as skipped, which says nothing about what broke.
  await until("the pane to hold the newest version", () =>
    (modals.at(-1)?.contentEl.allText() ?? "").includes("A second line."),
  );
  shots.push(
    shotOfOpenPanel(
      "history-newest-version",
      'Two versions of one note. It opens on the newest, because a pane saying only "Select a version" answers no question.',
    ),
  );

  // And an older version as a diff, which is the view that rendered in one
  // colour for as long as the pane put the whole thing in the `<pre>` as a
  // single run of text with nothing for the colour rules to match.
  //
  // The older one deliberately: the newest version is the note on disk, so
  // its diff is empty and an empty diff has nothing to colour either way.
  matching(modals.at(-1)!.contentEl, "modal-sidebar-list-item")[1]?.fire("click");
  await until("the older version", () => hasClass(modals.at(-1)!.contentEl, "basalt-history-text"));
  press(modals.at(-1)!.contentEl, "Show changes");
  await until(
    "the diff",
    () =>
      hasClass(modals.at(-1)!.contentEl, "basalt-history-diff") &&
      !(modals.at(-1)?.contentEl.allText() ?? "").includes("Loading"),
  );
  shots.push(
    shotOfOpenPanel(
      "history-diff",
      "The same version against the note on disk. One element per line, because two colours need two kinds of element.",
    ),
  );
  closePanel();

  // And the status bar, once per state. Nine glyphs and nine tooltips, on a
  // strip of screen the width of a word.
  for (const { name, state } of STATUSES) {
    setState(laptop, state);
    shots.push(
      shotOfStatusBar(
        laptop,
        `status-bar-${name}`,
        `The status bar item while the state is ${name}.`,
      ),
    );
  }

  return { shots, loaded };
}

const HEADER = [
  "The Basalt panel, in every state it has.",
  "",
  "Not a screenshot, and it cannot be one: a picture of this panel needs Obsidian,",
  "which is proprietary and is not on a CI runner, and every pixel of its",
  "appearance comes from Obsidian's own theme rather than from this repository.",
  "A rendering that approximated that theme would be a picture of a panel that",
  "does not exist, so this is the honest half instead: which elements the panel",
  "builds, in what order, nested how, carrying what words.",
  "",
  "Both layout bugs found here so far lived in that half. What it still cannot",
  "see is anything only a theme makes true, which is what the screenshots in",
  "docs/assets/screenshots are for.",
  "",
  "The invite and recovery key below are real and are worthless: they belong to a",
  "vault that a test server created at the start of this run and deleted at the",
  "end of it. They are shown because whether a secret reaches the screen at all",
  "is one of the things worth looking at here.",
  "",
].join("\n");

/** Every shot, as one file somebody can read or diff. */
export function asText(shots: Shot[]): string {
  const parts = [HEADER];
  for (const shot of shots) {
    parts.push(["=".repeat(78), shot.name, "-".repeat(78), shot.why, "", shot.body, ""].join("\n"));
  }
  return parts.join("\n");
}

const escape = (text: string): string =>
  text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);

/**
 * The same thing as a page, because the point is that somebody looks at it.
 *
 * A downloaded artifact of one file that opens in a browser with every state
 * under its own heading is a review somebody will actually do. Plain type on
 * plain paper: the moment this styled itself to resemble Obsidian it would be
 * making the claim the header above spends a paragraph refusing.
 */
export function asHtml(shots: Shot[]): string {
  const nav = shots
    .map((s) => `<li><a href="#${escape(s.name)}">${escape(s.name)}</a></li>`)
    .join("\n");
  const body = shots
    .map(
      (s) =>
        `<section id="${escape(s.name)}">\n<h2>${escape(s.name)}</h2>\n` +
        `<p class="why">${escape(s.why)}</p>\n<pre>${escape(s.body)}</pre>\n</section>`,
    )
    .join("\n");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    "<title>Basalt panel states</title>",
    "<style>",
    "body{font:14px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#222}",
    "pre{background:#f6f6f6;padding:1rem;overflow-x:auto;font:12px/1.45 ui-monospace,monospace}",
    ".why{color:#555;font-style:italic}",
    "h2{margin-top:2.5rem;font-family:ui-monospace,monospace}",
    "header p{white-space:pre-wrap}",
    "@media(prefers-color-scheme:dark){body{background:#181818;color:#ddd}pre{background:#222}.why{color:#aaa}}",
    "</style></head><body>",
    "<h1>Basalt panel states</h1>",
    `<header><p>${escape(HEADER)}</p></header>`,
    `<nav><ol>\n${nav}\n</ol></nav>`,
    body,
    "</body></html>",
  ].join("\n");
}
