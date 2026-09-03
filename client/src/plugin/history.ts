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
 * docs/design.md: a sync you did not ask for should never rewrite the file
 * you have open, and restoring is a sync you asked for pointed at the past.
 */

import { diff_match_patch } from "diff-match-patch";
import { Modal, Notice, type App } from "obsidian";

import type { Version } from "../core/client.ts";

/** Where a restore landed, and whether it went any further. */
export interface Restored {
  readonly path: string;
  /** The upload afterwards succeeded. When false, `why` says what stopped it. */
  readonly sent: boolean;
  readonly why?: string;
  /**
   * Whether a later pass will send it. Absent means yes, which is every
   * ordinary failure. False is for a vault unlinked under the restore: the
   * note is on this device and there is no next pass to promise it to.
   */
  readonly willRetry?: boolean;
}

/**
 * One sentence for a restore: where it landed, and whether it went further.
 *
 * Lives here, next to the modal, because both restore surfaces say it and both
 * used to say it their own way. The modal's producer returned this sentence and
 * the modal then wrapped it in a second one, so a restore read "Restored to
 * Restored note.md. Sent to your other devices., because something is already
 * at note.md." One sentence, written once, from the structured outcome.
 */
export function describeRestore(version: Version, done: Restored): string {
  const where =
    done.path === version.path
      ? `Restored ${done.path}.`
      : `Restored to ${done.path}, because something is already at ${version.path}.`;
  if (done.sent) return `${where} Sent to your other devices.`;
  return done.willRetry === false
    ? `${where} It is on this device and nowhere else: ${done.why}`
    : `${where} It is on this device and will be sent when the next sync succeeds: ${done.why}`;
}

/** What the modal needs from the plugin, so this file needs no plugin type. */
export interface HistorySource {
  /** Versions of one path, newest first. `before` pages backwards by uid. */
  history(path: string, opts: { before?: number; limit?: number }): Promise<Version[]>;
  /** The text of one version, without writing anything. */
  contentAt(version: Version): Promise<string>;
  /**
   * Writes a version back, never over the top of something already there.
   *
   * The outcome, not a sentence about it: where it landed and whether the
   * upload afterwards succeeded are two facts, and a string that has already
   * been through `describeRestore` cannot be asked either question.
   */
  restoreVersion(version: Version): Promise<Restored>;
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
  /** Why the last page did not arrive, while that is the case. */
  private failed: string | undefined;
  /**
   * Which selection the pane is loading for.
   *
   * Reading a version is a round trip, and somebody pressing the down arrow
   * twice starts two. The one that finishes last used to win the pane, so
   * with A slow and B fast the list said B, the Restore button restored B,
   * and the text on screen was A. Every load takes a number and only the
   * newest number may draw.
   */
  private loading = 0;
  /** The page load in flight, so a second press of Load more joins it rather than asking again. */
  private paging: Promise<void> | undefined;
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
  private load(): Promise<void> {
    // One page at a time. Two presses of Load more used to send two requests
    // for the same `before`, and the second page arrived twice.
    if (this.paging) return this.paging;
    this.paging = this.loadPage().finally(() => {
      this.paging = undefined;
    });
    return this.paging;
  }

  private async loadPage(): Promise<void> {
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
      // Not exhausted: the server was not asked, it was unreachable. Setting
      // it here took the Load more button away, so an offline moment while
      // the modal opened left a window whose only recovery was closing it
      // and opening it again.
      new Notice(`Basalt: ${(err as Error).message}`, 10_000);
      this.failed = (err as Error).message;
      this.render();
      return;
    }
    this.failed = undefined;
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
    if (this.versions.length === 0 && this.failed !== undefined) {
      // "The server holds no history for this note" over an ask that never
      // reached the server is rule 7's mistake in miniature: it describes the
      // question rather than the vault. This says what happened, and the
      // button under it asks again.
      this.listEl.createEl("p", {
        cls: "basalt-history-empty",
        text: `The history could not be read: ${this.failed}`,
      });
    } else if (this.versions.length === 0) {
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
        text: this.failed === undefined ? "Load more" : "Try again",
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
    const mine = ++this.loading;
    this.chosen = version;
    this.text = "Loading…";
    this.render();
    let text: string;
    try {
      const older = await this.source.contentAt(version);
      if (this.showDiff) {
        const now = (await this.source.currentText(this.path)) ?? "";
        text = diffLines(older, now);
      } else {
        text = older;
      }
    } catch (err) {
      text = `Could not read this version: ${(err as Error).message}`;
    }
    // A newer selection has been made while this one was loading. Its text
    // belongs to a version the list no longer says is chosen, and drawing it
    // would label one version's text with another's name.
    if (mine !== this.loading) return;
    this.text = text;
    // Only the pane, so a slow read does not rebuild the list under the
    // pointer of somebody about to click the next version.
    this.renderPane();
  }

  private async restore(version: Version): Promise<void> {
    try {
      const done = await this.source.restoreVersion(version);
      // Longer on screen when the note is here but not yet on the other
      // devices, because that half-outcome is the one worth reading. The
      // recovery list says it the same way.
      new Notice(describeRestore(version, done), done.sent ? undefined : 10_000);
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
 *
 * A real diff, from the library the merge already uses in its line mode. The
 * first version of this was a set difference of the two line lists, which is
 * not a diff: a paragraph that appeared twice and now appears once, or two
 * paragraphs that swapped places, came out as "No difference from the note on
 * disk", and a person deciding whether to restore was told the versions were
 * the same when they were not.
 */
export function diffLines(older: string, current: string): string {
  const dmp = new diff_match_patch();
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(older, current);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  // Coalesces the runs the line encoding leaves behind, so an edited
  // paragraph reads as one removal and one addition rather than as a stutter
  // of single lines with unchanged ones wedged between them. Cosmetic, and
  // this is the one place in the project where cosmetic is the whole job:
  // somebody is reading it to decide whether to restore.
  dmp.diff_cleanupSemantic(diffs);

  const out: string[] = [];
  for (const [op, text] of diffs) {
    if (op === 0) continue;
    const mark = op === -1 ? "-" : "+";
    for (const line of splitLines(text)) out.push(`${mark} ${line}`);
  }
  return out.length ? out.join("\n") : "No difference from the note on disk.";
}

/** The lines of a run of text, without the empty tail a trailing newline leaves. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
