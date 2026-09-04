import { describe, expect, it } from "vitest";

import { drawingGate, looksLikeExcalidraw, sceneOpens } from "./excalidraw.ts";
import { mergeText, mergeTextCharacters } from "./merge.ts";

/**
 * The corpus behind the Excalidraw gate, and the measurement that says it is
 * the canvas failure rather than a resemblance to it.
 *
 * canvas.test.ts found that `stillValid` is load-bearing: a board with two
 * cards and no arrows, each device draws one, `"edges":[]` goes from one line
 * to three on both sides, and the character merge joins the two edge objects
 * with no comma. 193 of 2,429 clean merges, one in thirteen, and nothing else
 * sees any of them.
 *
 * An Excalidraw drawing is `name.excalidraw.md`. The extension is `md`, so
 * `looksLikeText` merges it as prose and `looksLikeJson` never hears about it,
 * while its body is a JSON scene in a fenced block. The question was whether
 * the same edit does the same thing. It does, harder.
 *
 * ## The numbers
 *
 * Excalidraw writes the scene with `JSON.stringify(scene, null, "\t")`, which
 * is why the answer depends entirely on whether the drawing is empty:
 *
 *   - A drawing that already has shapes: **0 broken of 14,270 clean merges.**
 *     Every property of every element is on its own line, so an element is
 *     twenty-odd lines of line structure and two devices adding shapes are
 *     never editing one line.
 *   - An empty or nearly empty drawing: **744 broken of 4,882 clean merges**,
 *     better than one in seven, which is worse than the canvas figure. There,
 *     `"elements": []` is one line, both devices turn it into many, and the
 *     result is a scene missing one comma.
 *
 * An empty drawing that two devices both draw on is not a corner case. It is
 * making a drawing, letting it sync, and sketching on the other device too.
 *
 * ## What a broken one does, checked against the shipped plugin
 *
 * Not inferred. `ExcalidrawData.loadData` in the plugin calls `JSON_parse` on
 * the extracted scene, which is `JSON.parse` plus one entity substitution and
 * no catch, and then refuses with "Invalid Excalidraw scene: elements array is
 * missing" unless `elements` is an array. The drawing will not open. The
 * comment the plugin puts above that parse says the ordering is deliberate so
 * that "a malformed synchronized Drawing section must not leave a valid open
 * canvas backed by an unloaded or partially cleared ExcalidrawData", which is
 * somebody who has already had a sync corrupt this file. It throws rather than
 * saving an empty drawing over the work. Unopenable is still the canvas
 * failure exactly.
 *
 * ## Rule 9
 *
 * Take the `looksLikeExcalidraw` branch out of `engine.ts` and "refuses the
 * first two shapes drawn on an empty drawing" fails, along with the property
 * below reporting 744 merged drawings that will not open. Rule 10: what is
 * asserted is not that the two devices agree, it is that no `merged` outcome is
 * a drawing the plugin refuses to open.
 *
 * ## What this does not claim
 *
 * A drawing's text lives twice, once in the `## Text Elements` section and once
 * in the scene, and a merge can move one without the other. That is a fidelity
 * question, not an openability one: the file still opens and the plugin
 * reconciles from the markdown section, which is the half a person edits.
 * Recorded rather than gated, since the gate here is about the file opening at
 * all.
 */

// ---------------------------------------------------------------------------
// The fixture: a drawing written the way the plugin writes one.
// ---------------------------------------------------------------------------

interface Element {
  id: string;
  type: string;
  [key: string]: unknown;
}

/**
 * A real Excalidraw rectangle, with the properties the plugin actually writes.
 *
 * Written out in full rather than trimmed to the interesting ones, because the
 * number of lines an element occupies is the whole variable here: it is what
 * decides whether two devices adding shapes touch one line or twenty.
 */
function rectangle(id: string, x: number, y: number, stroke = "#1e1e1e"): Element {
  return {
    id,
    type: "rectangle",
    x,
    y,
    width: 180,
    height: 90,
    angle: 0,
    strokeColor: stroke,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: "a0",
    roundness: { type: 3 },
    seed: 123456,
    version: 12,
    versionNonce: 987654,
    isDeleted: false,
    boundElements: null,
    updated: 1700000000000,
    link: null,
    locked: false,
  };
}

function textElement(id: string, x: number, y: number, text: string): Element {
  return {
    ...rectangle(id, x, y),
    type: "text",
    text,
    fontSize: 20,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    originalText: text,
    autoResize: true,
    lineHeight: 1.25,
  };
}

/**
 * The whole file, as `generateMDBase` and `getMarkdownDrawingSection` produce
 * it: frontmatter, the banner, the text elements a person can edit, then the
 * scene under `## Drawing` in a ```json fence, tab-indented.
 *
 * The tab indentation is not decoration. It is `JSON.stringify(scene, null,
 * "\t")` in the plugin, and it is what puts every property on its own line.
 */
function drawingFile(elements: Element[]): string {
  const scene = {
    type: "excalidraw",
    version: 2,
    source: "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.14.0",
    elements,
    appState: {
      gridSize: 20,
      gridStep: 5,
      gridModeEnabled: false,
      viewBackgroundColor: "#ffffff",
    },
    files: {},
  };
  const texts = elements.filter((e) => e.type === "text").map((e) => `${e.text} ^${e.id}`);
  return [
    "---",
    "",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw]",
    "",
    "---",
    "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==",
    "",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    ...texts,
    "",
    "%%",
    "## Drawing",
    "```json",
    JSON.stringify(scene, null, "\t"),
    "```",
    "%%",
    "",
  ].join("\n");
}

describe("the shape of a drawing as the plugin writes one", () => {
  /**
   * Everything below rests on the fixture being the real thing, so it is
   * asserted rather than assumed, as canvas.test.ts asserts its serialiser.
   * If the plugin ever stops writing tab-indented JSON under a `## Drawing`
   * fence, this says so first and the rest of the file stops applying.
   */
  it("puts the scene under a json fence, and every property on its own line", () => {
    const file = drawingFile([rectangle("a", 10, 20)]);
    expect(file).toContain("\n## Drawing\n```json\n");
    expect(file).toContain('\t\t\t"strokeColor": "#1e1e1e"');
    expect(sceneOpens(file)).toBe(true);
    // An empty drawing writes the one line the whole failure hangs on.
    expect(drawingFile([])).toContain('"elements": []');
  });

  it("is recognised by its name, and prose is not", () => {
    expect(looksLikeExcalidraw("Drawings/Plan.excalidraw.md")).toBe(true);
    expect(looksLikeExcalidraw("Drawings/Plan.Excalidraw.MD")).toBe(true);
    expect(looksLikeExcalidraw("Notes/Daily.md")).toBe(false);
    expect(looksLikeExcalidraw("Drawings/Plan.excalidraw")).toBe(false);
  });
});

describe("what the gate can and cannot judge", () => {
  it("says a drawing opens, and says a broken one does not", () => {
    const good = drawingFile([rectangle("a", 1, 2)]);
    expect(sceneOpens(good)).toBe(true);
    // One comma removed between two elements: the merge's own handiwork.
    const two = drawingFile([rectangle("a", 1, 2), rectangle("b", 3, 4)]);
    expect(sceneOpens(two.replace("\t\t},\n", "\t\t}\n"))).toBe(false);
  });

  it("refuses a scene that parses but has no elements array", () => {
    // The plugin's own second condition, and a real shape: a merge that keeps
    // valid JSON while losing the key is refused with "elements array is
    // missing" rather than opened empty.
    const file = drawingFile([rectangle("a", 1, 2)]).replace('"elements"', '"elemnts"');
    expect(sceneOpens(file)).toBe(false);
  });

  /**
   * The abstention, which is what keeps this from being worse than the problem.
   *
   * A `.excalidraw.md` holding no readable drawing must not have every merge
   * turned into a conflict copy for ever because the check could not see
   * inside it.
   */
  it("has no opinion about a file whose drawing it cannot read", () => {
    expect(sceneOpens("# Just a note\n\nNo drawing here.\n")).toBeUndefined();
    // Compression on: the scene is one base64 line this cannot decompress.
    const compressed = drawingFile([rectangle("a", 1, 2)])
      .replace("```json", "```compressed-json")
      .replace(/\{[\s\S]*\}/, "N4IgLgngDgpiBcIYnpaAaEBjA9gOwgFsBTAJQEsBzFAQwCd10AzEAX0aA");
    expect(sceneOpens(compressed)).toBeUndefined();
  });

  it("stands aside when a side was already broken, because the merge did not break it", () => {
    const good = drawingFile([rectangle("a", 1, 2)]);
    const other = drawingFile([rectangle("b", 3, 4)]);
    const plain = "# Not a drawing\n";
    expect(drawingGate(good, good, other)).toBeTypeOf("function");
    expect(drawingGate(plain, good, other)).toBeUndefined();
    expect(drawingGate(good, plain, other)).toBeUndefined();
    expect(drawingGate(good, good, plain)).toBeUndefined();
  });
});

describe("two devices drawing on one empty drawing", () => {
  const empty = drawingFile([]);
  const mine = drawingFile([rectangle("MINE", 68, 182, "#e03131")]);
  const theirs = drawingFile([textElement("THEM", 400, 300, "second thought")]);

  const both = (base: string, a: string, b: string, gate = drawingGate(base, a, b)) => ({
    regions: mergeText(base, a, b, gate),
    characters: mergeTextCharacters(base, a, b, gate),
  });

  /**
   * The unguarded merge, which is what a `.excalidraw.md` got before this.
   *
   * Both shapes are present, in a scene one comma short of parsing. This is
   * the assertion that fails first if the merge ever stops producing it, at
   * which point the gate below is measuring nothing.
   */
  it("would merge into a drawing the plugin refuses to open", () => {
    for (const [which, out] of Object.entries(both(empty, mine, theirs, () => true))) {
      if (out.kind !== "merged")
        throw new Error(`${which} no longer reaches the check: ${out.why}`);
      expect(out.text, which).toContain('"MINE"');
      expect(out.text, which).toContain('"THEM"');
      expect(sceneOpens(out.text), which).toBe(false);
    }
  });

  it("refuses the first two shapes drawn on an empty drawing", () => {
    for (const [which, out] of Object.entries(both(empty, mine, theirs))) {
      expect(out.kind, which).toBe("conflict");
      expect(out.kind === "conflict" && out.why, which).toMatch(
        /no longer a valid file of its kind/,
      );
    }
  });

  it("still merges when only one device drew", () => {
    // The gate must not turn every drawing into a conflict copy. One device
    // draws, the other only retitles, and that is a merge.
    const retitled = empty.replace("tags: [excalidraw]", "tags: [excalidraw, plan]");
    for (const [which, out] of Object.entries(both(empty, retitled, mine))) {
      if (out.kind !== "merged") throw new Error(`${which} refused a good merge: ${out.why}`);
      expect(out.text, which).toContain('"MINE"');
      expect(out.text, which).toContain("plan");
      expect(sceneOpens(out.text), which).toBe(true);
    }
  });

  it("merges two shapes added to a drawing that already had one", () => {
    // The other half of the finding, and the reason the gate is not a refusal
    // to merge drawings at all. With one shape already there, every property is
    // on its own line and the two additions do not touch.
    const base = drawingFile([rectangle("start", 0, 0)]);
    const a = drawingFile([rectangle("start", 0, 0), rectangle("MINE", 68, 182)]);
    const b = drawingFile([rectangle("start", 0, 0), textElement("THEM", 400, 300, "note")]);
    const out = mergeText(base, a, b, drawingGate(base, a, b));
    if (out.kind !== "merged") throw new Error(`refused a good merge: ${out.why}`);
    expect(out.text).toContain('"MINE"');
    expect(out.text).toContain('"THEM"');
    expect(sceneOpens(out.text)).toBe(true);
  });
});

/**
 * The property, over generated drawings: a `merged` outcome is never a drawing
 * the plugin refuses to open.
 *
 * Run twice, over drawings that already have shapes and over empty or nearly
 * empty ones, because the two give completely different answers and reporting
 * one figure would hide that. The second run also asserts that the corpus keeps
 * reaching the check, which is rule 8: a property test over a corpus that never
 * breaks passes just as well with the gate deleted.
 */
describe("no merge of two drawings is a drawing that will not open", () => {
  const WORDS = ["chunk", "merge", "hash", "vault", "note"];

  function generated(cases: number, seed0: number, startEmpty: boolean) {
    let seed = seed0;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const int = (n: number) => Math.floor(rnd() * n);
    const pick = <T>(a: T[]): T => a[int(a.length)]!;

    const make = (id: string): Element =>
      rnd() < 0.5
        ? rectangle(id, int(900), int(600), pick(["#1e1e1e", "#e03131", "#1971c2"]))
        : textElement(id, int(900), int(600), `${pick(WORDS)} ${pick(WORDS)}`);

    const start = (): Element[] => {
      const elements: Element[] = [];
      for (let i = 0, n = startEmpty ? int(2) : 1 + int(4); i < n; i++)
        elements.push(make(`s${i}`));
      return elements;
    };

    const mutate = (from: Element[], tag: string): Element[] => {
      const elements = JSON.parse(JSON.stringify(from)) as Element[];
      for (let k = 0, n = 1 + int(2); k < n; k++) {
        const op = pick(["add", "drop", "move", "recolour", "retext", "resize"]);
        if (op === "add") elements.splice(int(elements.length + 1), 0, make(`${tag}${k}`));
        else if (op === "drop" && elements.length > 0) elements.splice(int(elements.length), 1);
        else if (op === "move" && elements.length > 0) {
          const e = pick(elements);
          e.x = int(900);
          e.y = int(600);
          e.version = (e.version as number) + 1;
        } else if (op === "recolour" && elements.length > 0)
          pick(elements).strokeColor = tag === "MINE" ? "#e03131" : "#1971c2";
        else if (op === "retext") {
          const texts = elements.filter((e) => e.type === "text");
          if (texts.length > 0) {
            const e = pick(texts);
            e.text = `${tag} ${pick(WORDS)}`;
            e.originalText = e.text;
          }
        } else if (op === "resize" && elements.length > 0) pick(elements).width = 100 + int(300);
      }
      return elements;
    };

    let checked = 0;
    let merged = 0;
    let reachedTheGate = 0;
    const broken: string[] = [];
    for (let i = 0; i < cases; i++) {
      const from = start();
      const base = drawingFile(from);
      const mine = drawingFile(mutate(from, "MINE"));
      const theirs = drawingFile(mutate(from, "THEM"));
      if (base === mine || base === theirs || mine === theirs) continue;
      const gate = drawingGate(base, mine, theirs);
      // The corpus is worth nothing if the fixture is not a drawing.
      if (gate === undefined) throw new Error(`the fixture stopped being readable, case ${i}`);
      for (const [which, merge] of Object.entries({
        regions: mergeText,
        characters: mergeTextCharacters,
      })) {
        checked++;
        const guarded = merge(base, mine, theirs, gate);
        if (guarded.kind === "conflict") {
          // Was it the gate, or one of the checks that were already there?
          const unguarded = merge(base, mine, theirs, () => true);
          if (unguarded.kind !== "conflict" && sceneOpens(unguarded.text) !== true)
            reachedTheGate++;
          continue;
        }
        merged++;
        if (sceneOpens(guarded.text) !== true) {
          broken.push(
            `case ${i} (${which}) produced a drawing that will not open:\n${guarded.text}`,
          );
        }
      }
    }
    return { checked, merged, reachedTheGate, broken };
  }

  const over = (startEmpty: boolean) => {
    let checked = 0;
    let merged = 0;
    let reachedTheGate = 0;
    const broken: string[] = [];
    for (const seed of [7, 11, 13, 17, 19, 23, 29, 31]) {
      const r = generated(2000, seed, startEmpty);
      checked += r.checked;
      merged += r.merged;
      reachedTheGate += r.reachedTheGate;
      broken.push(...r.broken);
    }
    return { checked, merged, reachedTheGate, broken };
  };

  it("holds for drawings that already have shapes, where nothing was wrong", () => {
    const r = over(false);
    expect(
      r.broken.slice(0, 1).join("\n"),
      `${r.broken.length} merges produced a drawing that will not open`,
    ).toBe("");
    expect(r.merged, "the corpus merged nothing").toBeGreaterThan(r.checked / 10);
    // Recorded rather than required: measured at 0 of 14,270, because every
    // property of every element is on its own line. This is the half of the
    // finding that says the answer is a gate and not a refusal to merge.
    expect(r.reachedTheGate).toBe(0);
  });

  it("holds for empty drawings two devices both drew on, where it was not", () => {
    const r = over(true);
    expect(
      r.broken.slice(0, 1).join("\n"),
      `${r.broken.length} merges produced a drawing that will not open`,
    ).toBe("");
    expect(r.merged, "the corpus merged nothing").toBeGreaterThan(r.checked / 10);
    // The gate has to be load-bearing here or this file is not the evidence it
    // claims to be. Measured at 744 against 4,882 clean merges, so the floor is
    // set well under that rather than at it: this asks whether the corpus still
    // reaches the gate, not whether a harmless change to the generator moved a
    // count.
    expect(
      r.reachedTheGate,
      "the corpus no longer reaches the gate, so the zero above means nothing",
    ).toBeGreaterThan(100);
  });
});
