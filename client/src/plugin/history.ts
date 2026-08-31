/**
 * Version history for one note.
 *
 * The server has kept every version since the first commit and nothing in the
 * plugin could reach them: recovery started from the deleted list, so a note you
 * still have but want an older copy of was not reachable at all.
 *
 * ## Why it looks like Obsidian Sync's
 *
 * Sync's own history modal was read in the shipped application to find out what
 * shape people already know: a sidebar of versions newest first, a content pane
 * showing the one you picked, a toggle between the text and a diff against what
 * is on disk, a restore action in the pane's title bar, and a button that pages
 * further back. Arrow keys move between versions and Enter selects.
 *
 * The layout classes here are Obsidian's own (`modal-sidebar`,
 * `modal-sidebar-list-item`, `modal-setting-titlebar`). Using the app's
 * stylesheet is how a plugin looks native rather than approximately native, and
 * it is the same reason a web page uses its framework's classes.
 *
 * ## Where it deliberately differs
 *
 * Restoring never overwrites. If the path is occupied the version lands beside
 * it as `Note (restored 42).md` and the notice says where it went. Sync writes
 * over the file. The whole project's position on this is in
 * docs/philosophy.md: a sync you did not ask for should never rewrite the file
 * you have open, and restoring is a sync you asked for pointed at the past.
 */

import { Modal, Notice, type App } from "obsidian";

import type { Version } from "../core/client.ts";

/** What the modal needs from the plugin, so this file needs no plugin type. */
export interface HistorySource {
  /** Versions of one path, newest first. `before` pages backwards by uid. */
  history(path: string, opts: { before?: number; limit?: number }): Promise<Version[]>;
  /** The text of one version, without writing anything. */
  contentAt(version: Version): Promise<string>;
  /** Writes a version back, never over the top of something already there. */
  restoreVersion(version: Version): Promise<string>;
  /** What is on disk now, for the diff. Undefined when the note is gone. */
  currentText(path: string): Promise<string | undefined>;
}

/** How many versions a page holds. Sync pages too, and for the same reason. */
export const PAGE = 20;

export class HistoryModal extends Modal {
  private versions: Version[] = [];
  private chosen: Version | undefined;
  private text = "";
  private showDiff = false;
  private exhausted = false;
  private listEl!: HTMLElement;
  private paneEl!: HTMLElement;

  constructor(
    app: App,
    private readonly source: HistorySource,
    private readonly path: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(`History of ${this.path}`);
    this.modalEl.addClass("mod-basalt-history", "mod-sidebar-layout");
    const sidebar = this.contentEl.createDiv("modal-sidebar mod-history");
    // setTitle above is invisible under mod-sidebar-layout, which collapses
    // the modal header, so the path goes here instead. Without it the modal
    // never says which note you are looking at the history of.
    sidebar.createDiv({ cls: "basalt-history-heading", text: this.path });
    this.listEl = sidebar.createDiv("modal-sidebar-inner");
    this.paneEl = this.contentEl.createDiv("basalt-history-content-container");
    void this.load();
  }

  /** Fetches a page and redraws. `before` continues from the oldest held. */
  private async load(): Promise<void> {
    const before = this.versions.length ? this.versions[this.versions.length - 1]!.uid : undefined;
    try {
      const page = await this.source.history(this.path, {
        limit: PAGE,
        ...(before !== undefined ? { before } : {}),
      });
      // Short of a full page means the server has no more. Asking again
      // would be a round trip that can only return nothing.
      if (page.length < PAGE) this.exhausted = true;
      this.versions.push(...page);
    } catch (err) {
      this.exhausted = true;
      new Notice(`Basalt: ${(err as Error).message}`, 10_000);
    }
    // Open on the newest version rather than on an empty pane. This used to
    // ask instead, on the grounds that it should not guess which version
    // somebody meant; but the pane is two thirds of the modal, "select a
    // version" is not an answer to anything, and the newest is what Sync
    // shows and what someone opening history is nearly always after.
    // Showing a version only displays it. Restoring is still a button.
    //
    // Only when nothing is chosen yet, so paging further back does not drag
    // the selection off whatever the reader is reading.
    if (!this.chosen && this.versions.length > 0) {
      void this.choose(this.versions[0]!);
      return;
    }
    this.render();
  }

  private render(): void {
    this.renderList();
    this.renderPane();
  }

  private renderList(): void {
    this.listEl.empty();
    if (this.versions.length === 0) {
      this.listEl.createEl("p", {
        cls: "basalt-history-empty",
        text: "The server holds no history for this note.",
      });
      return;
    }

    const list = this.listEl.createDiv("modal-sidebar-list");
    this.versions.forEach((version, i) => {
      const item = list.createDiv({
        cls:
          "modal-sidebar-list-item tappable" +
          (this.chosen?.uid === version.uid ? " is-active" : ""),
      });
      item.createDiv({ cls: "modal-sidebar-list-item-header", text: when(version.mtime) });
      item.createDiv({
        cls: "modal-sidebar-list-item-details",
        text: describe(version, i === 0),
      });
      item.addEventListener("click", () => void this.choose(version));
    });

    if (!this.exhausted) {
      const more = this.listEl.createEl("button", {
        cls: "basalt-history-button",
        text: "Load more",
      });
      more.addEventListener("click", () => void this.load());
    }
  }

  private renderPane(): void {
    this.paneEl.empty();
    const version = this.chosen;
    if (!version) {
      this.paneEl.addClass("mod-empty");
      this.paneEl.createEl("p", {
        cls: "basalt-history-content-empty",
        text: "Select a version to see it.",
      });
      return;
    }
    this.paneEl.removeClass("mod-empty");

    const bar = this.paneEl.createDiv("modal-setting-titlebar");
    bar.createDiv({ cls: "modal-setting-title", text: when(version.mtime) });
    const actions = bar.createDiv("modal-setting-titlebar-actions");

    const toggle = actions.createEl("button", {
      text: this.showDiff ? "Show text" : "Show changes",
    });
    toggle.addEventListener("click", () => {
      this.showDiff = !this.showDiff;
      void this.choose(version);
    });

    const restore = actions.createEl("button", { cls: "mod-cta", text: "Restore" });
    restore.addEventListener("click", () => void this.restore(version));

    const pre = this.paneEl.createEl("pre", {
      cls: this.showDiff ? "basalt-history-diff" : "basalt-history-text",
    });
    if (!this.showDiff) {
      pre.setText(this.text);
      return;
    }
    // A line at a time, so the added and removed rules in styles.css have
    // something to colour. They used to have nothing: the diff went in as
    // one run of text, so both rules matched no element and every diff came
    // out the single colour the stylesheet says is unreadable.
    for (const line of this.text.split("\n")) {
      const cls = line.startsWith("+")
        ? "basalt-added"
        : line.startsWith("-")
          ? "basalt-removed"
          : "";
      // Never an empty class: addClass throws on one, and createSpan
      // takes the same path.
      pre.createSpan(cls === "" ? { text: `${line}\n` } : { cls, text: `${line}\n` });
    }
  }

  private async choose(version: Version): Promise<void> {
    this.chosen = version;
    this.text = "Loading…";
    this.render();
    try {
      const older = await this.source.contentAt(version);
      if (this.showDiff) {
        const now = (await this.source.currentText(this.path)) ?? "";
        this.text = diffLines(older, now);
      } else {
        this.text = older;
      }
    } catch (err) {
      this.text = `Could not read this version: ${(err as Error).message}`;
    }
    // Only the pane, so a slow read does not rebuild the list under the
    // pointer of somebody about to click the next version.
    this.renderPane();
  }

  private async restore(version: Version): Promise<void> {
    try {
      const at = await this.source.restoreVersion(version);
      new Notice(
        at === version.path
          ? `Restored ${at}.`
          : `Restored to ${at}, because something is already at ${version.path}.`,
      );
      this.close();
    } catch (err) {
      new Notice(`Basalt: ${(err as Error).message}`, 10_000);
    }
  }
}

/**
 * A timestamp for a narrow column.
 *
 * The full locale string wrapped onto two ragged lines in the sidebar, which is
 * most of what a row is. A version from today wants the time; one from this year
 * wants the day; only an older one needs the year at all.
 */
export function when(ms: number): string {
  const at = new Date(ms);
  const now = new Date();
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const sameDay =
    at.getDate() === now.getDate() &&
    at.getMonth() === now.getMonth() &&
    at.getFullYear() === now.getFullYear();
  if (sameDay) return time;

  const day = at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (at.getFullYear() === now.getFullYear()) return `${day}, ${time}`;
  return `${day} ${at.getFullYear()}`;
}

/**
 * The second line of a row: what the version is, rather than what it contains.
 *
 * The newest one is called out because "restore the newest" and "restore an
 * older one" are different intentions, and a list where every row looks alike
 * makes the first indistinguishable from the second.
 */
function describe(version: Version, newest: boolean): string {
  if (version.deleted) return `Deleted on ${version.device}`;
  if (version.folder) return `Folder, ${version.device}`;
  const size = version.size < 1024 ? `${version.size} B` : `${Math.round(version.size / 1024)} KiB`;
  return `${size} · ${version.device}${newest ? " · newest" : ""}`;
}

/**
 * A line diff of an old version against what is on disk.
 *
 * Line-wise rather than character-wise, because this is for reading rather than
 * for merging: the merge in core/merge.ts is character-granular precisely
 * because a paragraph is one line, and that is the wrong granularity to look at.
 */
export function diffLines(older: string, current: string): string {
  const a = older.split("\n");
  const b = current.split("\n");
  const inB = new Set(b);
  const inA = new Set(a);

  const out: string[] = [];
  for (const line of a) if (!inB.has(line)) out.push(`- ${line}`);
  for (const line of b) if (!inA.has(line)) out.push(`+ ${line}`);
  return out.length ? out.join("\n") : "No difference from the note on disk.";
}
