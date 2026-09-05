/**
 * The panel walk: run it, check it captured something real, write it down.
 *
 * `panel-shots.ts` explains at length why what CI can have is an outline and
 * not a picture. This is the gate around it, and the gate is deliberately
 * narrow. The artifact itself is not diffed against a golden copy, because the
 * point of it is to be looked at rather than to be another thing to keep in
 * step; what would be intolerable is the artifact quietly becoming empty, or
 * the walk stopping two states short, and nobody finding out until they went
 * looking for a picture that was not there. So: every state was reached, and
 * each one holds the words and the shape it exists to have.
 *
 * The ordering assertion is the one that earns its place twice over. `de4d519`
 * put the device rows above the row that offers them, and its own commit
 * message says a screenshot found it and a test could not. This checks it
 * against the same text a reviewer reads, so the artifact and the gate are
 * looking at the same thing.
 *
 * Writing the files from a test rather than from a script is not laziness. The
 * plugin cannot be imported outside vitest at all: `main.ts` imports `obsidian`,
 * the npm package has no runtime, and `vitest.config.ts` is the only place the
 * alias to `stub.ts` exists. A standalone runner would need a second copy of
 * that alias, and a second copy is a thing that drifts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import { resetStub } from "./stub.ts";
import { asHtml, asText, walkPanelStates, type Shot } from "./panel-shots.ts";

/** Where the artifact lands. CI uploads this directory; `.gitignore` has it. */
const OUT = new URL("../../panel-shots/", import.meta.url).pathname;

let server: TestServer;
let shots: Shot[];
const unload: (() => void)[] = [];

/**
 * One walk for the whole file, rather than one per assertion.
 *
 * Every test below reads the same captures, and the artifact is written from
 * them, so walking again for each one would pair four devices nine more times
 * to produce nine copies of the same strings. It would also mean the file
 * uploaded came from a different walk than the one the assertions passed
 * against, which for an artifact whose whole job is to be believed is the
 * wrong way round.
 */
beforeAll(async () => {
  await serverBinary();
  resetStub();
  server = new TestServer();
  await server.start();
  const walked = await walkPanelStates(server);
  shots = walked.shots;
  for (const plugin of walked.loaded) unload.push(() => plugin.onunload());
}, 300_000);

afterAll(async () => {
  while (unload.length) unload.pop()!();
  if (server) await server.cleanup();
  await cleanupBinary();
});

/** Every state the walk is expected to reach, in the order it reaches them. */
const EXPECTED = [
  "unpaired",
  "config-unreadable",
  "paired",
  "fresh-recovery-key",
  "stopped-offering-rejoin",
  "devices-listed-last-device",
  "invite-created",
  "devices-listed",
  "devices-revoke-confirming",
  "recover-nothing-deleted",
  "history-newest-version",
  "history-diff",
  "status-bar-unpaired",
  "status-bar-connecting",
  "status-bar-syncing",
  "status-bar-synced",
  "status-bar-synced-needing-attention",
  "status-bar-failed",
  "status-bar-offline",
  "status-bar-offline-origin-refused",
  "status-bar-stopped",
];

describe("the panel walk", () => {
  const of = (name: string): string => {
    const shot = shots.find((s) => s.name === name);
    if (!shot) throw new Error(`the walk did not reach ${name}`);
    return shot.body;
  };

  /**
   * The same capture with its line breaks taken out.
   *
   * The outline wraps long strings to a readable width, so a sentence in the
   * panel is several lines here and a search for it finds nothing. Asserting
   * against the wrapped text would be asserting about the wrap column.
   */
  const prose = (name: string): string => of(name).replace(/\s+/g, " ");

  it("reaches every state it says it does, and captures something in each", async () => {
    expect(shots.map((s) => s.name)).toEqual(EXPECTED);
    for (const shot of shots) {
      // A capture that came back with the modal's own wrapper and nothing
      // inside it is the failure this whole file exists to notice: the
      // artifact would still be there, still open in a browser, and empty.
      expect(shot.body.split("\n").length, `${shot.name} captured almost nothing`).toBeGreaterThan(
        3,
      );
      expect(shot.why, `${shot.name} says nothing about what puts the panel there`).not.toBe("");
    }
  });

  it("shows the pairing form to a device with nothing, and not to one with a broken config", () => {
    // Two ways in, and only the first offers to overwrite anything.
    expect(of("unpaired")).toContain("Start a new vault");
    expect(of("unpaired")).toContain("Setup string");

    // Rule 2: unreadable is not absent. A pairing form here would offer to
    // write over a credential that may be the only copy, so there is none.
    expect(of("config-unreadable")).toMatch(/stopped/);
    expect(of("config-unreadable")).not.toContain("Start a new vault");
  });

  it("draws the paired panel's rows, in the order somebody reads them", () => {
    const body = of("paired");
    const rows = [
      "Sync now",
      "Add another device",
      "Devices",
      "Recover a deleted note",
      "Recovery key",
      "Unlink this vault",
    ];
    const at = rows.map((row) => body.indexOf(`name    ${row}`));
    for (const [i, row] of rows.entries()) {
      expect(at[i], `the paired panel has no "${row}" row`).toBeGreaterThan(-1);
    }
    // Adding a device and then the list of them, because they are one
    // subject, and the destructive rows last.
    expect(at, `the rows are out of order:\n${body}`).toEqual([...at].sort((x, y) => x - y));
  });

  /**
   * de4d519, pinned against the text a reviewer looks at.
   *
   * The device rows are built into a container the panel creates *after* the
   * row that offers them, precisely so they land underneath it. Created first,
   * they rendered above it and the list appeared to belong to whatever setting
   * sat above. That is a child-order bug, so it is visible here, and it is the
   * one bug class this artifact can catch on its own.
   */
  it("puts the device rows below the row that offers them", () => {
    const body = of("devices-listed");
    const offer = body.indexOf("name    Devices");
    const first = body.indexOf("· added ");
    expect(offer, "there is no Devices row at all").toBeGreaterThan(-1);
    expect(first, "no device rows were drawn").toBeGreaterThan(-1);
    expect(first, `the rows came out above the row that offers them:\n${body}`).toBeGreaterThan(
      offer,
    );
    // The outstanding invite is under the rows for the same reason: a row is
    // a device that was added and an invite is one about to be.
    expect(body.indexOf("Outstanding invite")).toBeGreaterThan(first);
    // And the summary under all of it says the thing the feature would be
    // worse than useless without: revoking stops a device connecting and
    // does not un-read what it already read.
    expect(prose("devices-listed"), "the list does not say what revoking does not do").toMatch(
      /does not un-read what that device already read/,
    );
  });

  it("keeps the one-device vault's row buttonless, and says whose job that is", () => {
    const body = of("devices-listed-last-device");
    expect(body).toContain("· added ");
    // No revoke here: the last row is the one revocation no device can undo.
    expect(body).not.toContain("button  [Revoke]");
    expect(prose("devices-listed-last-device")).toContain("--allow-last --recovery-key");
  });

  it("says out loud, mid-revocation, that revoking does not un-read anything", () => {
    const body = of("devices-revoke-confirming");
    // The first press only relabels and explains. Nothing has happened yet,
    // which is what makes a destructive button in a panel safe to draw.
    expect(body).toContain("button  [Yes, revoke]");
    expect(prose("devices-revoke-confirming")).toMatch(
      /cannot connect again until it is added with an invite/,
    );
  });

  it("puts the invite and the recovery key on screen where they can be read", () => {
    // Both are strings somebody has to copy off a screen that may have no
    // clipboard behind it, so both have to be rendered and not only offered.
    expect(of("invite-created")).toContain("basalt3i_");
    expect(of("fresh-recovery-key")).toContain("basalt3_");
    expect(of("fresh-recovery-key")).toContain("I have written it down");
  });

  it("grows the way out when the server has gone backwards", () => {
    // The rejoin row is drawn rather than updated, so a panel left open when
    // this happens has to redraw itself to offer it.
    expect(of("stopped-offering-rejoin")).toMatch(/[Rr]ejoin/);
  });

  /**
   * dae9dcb, pinned the same way, for the three of its four defects that were
   * facts about this tree rather than about geometry.
   */
  it("opens the history on the newest version, says which note, and marks up the diff", () => {
    const body = of("history-newest-version");
    // `setTitle` is invisible under mod-sidebar-layout, which collapses the
    // modal header to nothing, so the path is drawn above the list instead.
    // Without it the modal never says which note you are looking at.
    expect(body).toContain("basalt-history-heading");
    expect(body).toContain("Daily/2026-09-04.md");
    // Not an empty pane. The newest version is what somebody opening history
    // is nearly always after, and it is what the pane starts on.
    expect(body, `the pane opened on nothing:\n${body}`).toContain("A second line.");
    // Two versions in the list, because one was written over the other, and a
    // Restore button in the pane, which is the only thing in this modal that
    // changes anything.
    expect([...body.matchAll(/modal-sidebar-list-item-header/g)].length).toBeGreaterThanOrEqual(2);
    expect(body).toContain("Restore");

    // And the diff is marked up rather than dumped. styles.css has had rules
    // for added and removed lines since it was written, and for a while the
    // whole diff went into the `<pre>` as one run of text: both rules matched
    // nothing and every diff rendered in one colour. One element per line is
    // what those rules need, so the count of them is what says they can work.
    const diff = of("history-diff");
    expect(diff).toContain("<pre.basalt-history-diff>");
    for (const cls of ["basalt-added", "basalt-removed"]) {
      expect(diff, `nothing in the diff carries ${cls}:\n${diff}`).toContain(`<span.${cls}>`);
    }
  });

  it("gives every status-bar state a glyph and a tooltip of its own", () => {
    const glyphs = new Map<string, string>();
    for (const shot of shots.filter((s) => s.name.startsWith("status-bar-"))) {
      const icon = /@data-icon {2}(.+)/.exec(shot.body)?.[1];
      const label = /@aria-label {2}(.+)/.exec(shot.body)?.[1];
      expect(icon, `${shot.name} drew no glyph`).toBeTruthy();
      expect(label, `${shot.name} has no tooltip`).toBeTruthy();
      glyphs.set(shot.name, `${icon}`);
    }
    // Rule 7: a status that cannot tell two conditions apart is not a status.
    // Offline and stopped are the pair that matters, because one comes back on
    // its own and the other needs a person.
    expect(glyphs.get("status-bar-offline")).not.toBe(glyphs.get("status-bar-stopped"));
    expect(glyphs.get("status-bar-synced")).not.toBe(
      glyphs.get("status-bar-synced-needing-attention"),
    );
  });

  /**
   * The artifact, written where CI collects it.
   *
   * Its own test rather than an `afterAll`, so that "the panel states were not
   * written" is a line in the report instead of an unexplained empty upload.
   */
  it("writes the states somewhere a person can look at them", async () => {
    await mkdir(OUT, { recursive: true });
    await writeFile(join(OUT, "panel-states.txt"), asText(shots));
    await writeFile(join(OUT, "panel-states.html"), asHtml(shots));

    const text = await readFile(join(OUT, "panel-states.txt"), "utf8");
    // Rule 4: verify the outcome, not the exit code. A capture step that
    // wrote a header and no states would be a green job and an empty
    // artifact, which is the failure that hides for months.
    for (const shot of shots) expect(text, `${shot.name} is not in the file`).toContain(shot.name);
    expect(text).toMatch(/[Nn]ot a screenshot/);
    expect(text.length, "the file is too small to hold what was walked").toBeGreaterThan(5_000);

    const html = await readFile(join(OUT, "panel-states.html"), "utf8");
    expect(html).toContain("<pre>");
    for (const shot of shots) expect(html).toContain(`id="${shot.name}"`);
  });
});
