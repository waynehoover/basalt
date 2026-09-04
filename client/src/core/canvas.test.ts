import { describe, expect, it } from "vitest";

import { mergeText, mergeTextCharacters } from "./merge.ts";
import { regions } from "./merge-regions.ts";

/**
 * The corpus behind `stillValid`, and the failure that turned it from a
 * precaution into a check.
 *
 * `stillValid` is the predicate `engine.ts` passes to `mergeText` for a path
 * `looksLikeJson` recognises, which today means `.canvas` and `.json`. It is
 * `parsesAsJson`, and it is asked of the whole merged file after every other
 * check has passed. merge.ts said, honestly, that it came from reading a
 * neighbouring project's issues rather than from anything failing here, and
 * merge.test.ts said that no test isolated it "because nothing yet gets that
 * far". Both were wrong, and this file is why.
 *
 * The case is the most ordinary thing two people do to a canvas. A board with
 * two cards and no arrows. One device draws an arrow, the other device draws a
 * different arrow. `"edges":[]` is one line in the ancestor and three lines on
 * each device, so both sides changed the same line, the character merge runs
 * on that region, and it concatenates the two edge objects with no comma
 * between them. Nothing was lost, nothing collided, both directions agree,
 * every word is somebody's. The file is one character short of being JSON and
 * Obsidian will not open it. `stillValid` is the only check that sees this.
 *
 * Rule 9: with both `stillValid` calls in merge.ts disabled, two tests here
 * fail, "refuses the first arrow drawn on two devices at once" and "holds for
 * canvases written the way Obsidian writes them", the second of them with 193
 * merged canvases that are not JSON. Rule 10: the property asserted is not
 * that the two merges agree, it is that no `merged` outcome is a file the
 * application refuses to open.
 *
 * Rule 8, which is the one that decides whether any of this is worth keeping:
 * of 4,420 merge attempts over the generated corpus, 2,236 merge and 193 more
 * would merge but for this check. One canvas in thirteen that every other
 * check calls clean is a canvas that will not open.
 *
 * ## The format is Obsidian's, not a toy
 *
 * A canvas is a JSON object with `nodes` and `edges`, and how it is *written*
 * decides everything about how it merges, so `canvasText` below is Obsidian's
 * own serialiser rather than `JSON.stringify`. Transcribed from `$d`/`Zd` in
 * app.js of Obsidian 1.13.7, the shipped artifact: tab indent, and any object
 * or array all of whose members are primitives goes on one line. Every node
 * and every edge is therefore exactly one line, which is what gives a canvas
 * line structure for the region merge to work in. A minified canvas is one
 * line and has none; that case is measured below and it is not what Obsidian
 * writes.
 *
 * Obsidian reads a canvas back with a bare `JSON.parse` inside
 * `setViewData` and no `catch` anywhere above it, so "does not parse" is
 * literally "the view throws on open".
 */

/** Whether text is still JSON. The predicate `engine.ts` supplies for `.canvas` and `.json`. */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Obsidian's canvas serialiser, from `$d`/`Zd` in app.js 1.13.7.
 *
 * Written out rather than approximated because the corpus is worth nothing if
 * the bytes are not the bytes a vault holds. The rule that matters is the
 * all-primitives one: it is what puts each node on its own line.
 */
function canvasText(value: unknown): string {
  return canvasLines(value).join("\n");
}

function canvasLines(value: unknown): string[] {
  if (value === undefined) return ["null"];
  if (typeof value !== "object" || value === null) return [JSON.stringify(value)];
  const primitive = (v: unknown) => typeof v !== "object";
  const indent = (kid: string[], last: boolean, out: string[]) => {
    for (let j = 0; j < kid.length; j++) {
      out.push("\t" + kid[j] + (j === kid.length - 1 && !last ? "," : ""));
    }
  };
  if (Array.isArray(value)) {
    if (value.every(primitive)) return [JSON.stringify(value)];
    const out = ["["];
    value.forEach((item, i) => indent(canvasLines(item), i === value.length - 1, out));
    out.push("]");
    return out;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined);
  if (keys.every((k) => primitive(record[k]))) return [JSON.stringify(record)];
  const out = ["{"];
  keys.forEach((key, i) => {
    const kid = canvasLines(record[key]);
    kid[0] = JSON.stringify(key) + ":" + kid[0];
    indent(kid, i === keys.length - 1, out);
  });
  out.push("}");
  return out;
}

interface Node {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}
interface Edge {
  id: string;
  fromNode: string;
  fromSide: string;
  toNode: string;
  toSide: string;
  [key: string]: unknown;
}
interface Canvas {
  nodes: Node[];
  edges: Edge[];
  [key: string]: unknown;
}

/**
 * A board somebody would actually have: the four node types, a group, a
 * subpath, colours, an edge label, and a text node whose text contains a
 * newline (which `JSON.stringify` escapes, so the node is still one line).
 */
function board(): Canvas {
  return {
    nodes: [
      { id: "n1", type: "group", label: "Reading", x: -700, y: -420, width: 900, height: 640 },
      {
        id: "n2",
        type: "file",
        file: "Reading/Chunking.md",
        x: -660,
        y: -360,
        width: 400,
        height: 400,
      },
      {
        id: "n3",
        type: "file",
        file: "Reading/Merging.md",
        subpath: "#Conflicts",
        x: -220,
        y: -360,
        width: 400,
        height: 400,
      },
      {
        id: "n4",
        type: "text",
        text: "Rolling hash boundaries beat fixed blocks\nfor prose, and do nothing for photographs.",
        x: -660,
        y: 80,
        width: 420,
        height: 140,
        color: "6",
      },
      {
        id: "n5",
        type: "link",
        url: "https://github.com/vrtmrz/obsidian-livesync",
        x: -220,
        y: 80,
        width: 400,
        height: 120,
      },
      {
        id: "n6",
        type: "text",
        text: "Does dedup earn its keep?",
        x: 300,
        y: -360,
        width: 320,
        height: 100,
      },
      {
        id: "n7",
        type: "file",
        file: "Notes/Protocol.md",
        x: 300,
        y: -180,
        width: 400,
        height: 400,
        color: "1",
      },
    ],
    edges: [
      { id: "e1", fromNode: "n2", fromSide: "right", toNode: "n3", toSide: "left" },
      {
        id: "e2",
        fromNode: "n3",
        fromSide: "bottom",
        toNode: "n5",
        toSide: "top",
        label: "prior art",
      },
      { id: "e3", fromNode: "n4", fromSide: "right", toNode: "n6", toSide: "left", color: "6" },
      { id: "e4", fromNode: "n6", fromSide: "bottom", toNode: "n7", toSide: "top" },
    ],
  };
}

/** The board with one device's edits applied, written the way Obsidian writes it. */
function edited(change: (c: Canvas) => void): string {
  const c = board();
  change(c);
  return canvasText(c);
}

/** A node by id, for asserting that an edit survived rather than that two sides agree. */
function node(text: string, id: string): Node | undefined {
  return (JSON.parse(text) as Canvas).nodes.find((n) => n.id === id);
}

/** Both merges, because a structured file has to be safe in the fallback too. */
function bothMerges(base: string, mine: string, theirs: string, valid = parsesAsJson) {
  return {
    regions: mergeText(base, mine, theirs, valid),
    characters: mergeTextCharacters(base, mine, theirs, valid),
  };
}

const BASE = canvasText(board());

describe("the shape of a canvas as Obsidian writes one", () => {
  /**
   * Everything below depends on this, so it is asserted rather than assumed.
   * If a future Obsidian minifies its canvases, this test says so first and
   * the merge behaviour recorded in this file stops applying.
   */
  it("puts every node and every edge on a line of its own", () => {
    const lines = BASE.split("\n");
    expect(lines[0]).toBe("{");
    expect(lines[1]).toBe('\t"nodes":[');
    const nodeLines = lines.filter((l) => l.startsWith('\t\t{"id":"n'));
    const edgeLines = lines.filter((l) => l.startsWith('\t\t{"id":"e'));
    expect(nodeLines).toHaveLength(7);
    expect(edgeLines).toHaveLength(4);
    // The text node's newline is escaped by JSON.stringify, so a node whose
    // text is two paragraphs is still one line. That is what keeps the line
    // diff describing nodes rather than sentences.
    expect(nodeLines.some((l) => l.includes("\\nfor prose"))).toBe(true);
    expect(parsesAsJson(BASE)).toBe(true);
  });
});

describe("two devices editing one canvas", () => {
  it("merges two nodes moved on different devices", () => {
    const mine = edited((c) => {
      c.nodes[1]!.x = -900;
      c.nodes[1]!.y = -500;
    });
    const theirs = edited((c) => {
      c.nodes[5]!.x = 640;
    });
    for (const [which, out] of Object.entries(bothMerges(BASE, mine, theirs))) {
      if (out.kind !== "merged") throw new Error(`${which} refused a good merge: ${out.why}`);
      // Rule 10: not that the two devices agree, but that neither move was lost.
      expect(node(out.text, "n2")?.x, which).toBe(-900);
      expect(node(out.text, "n6")?.x, which).toBe(640);
    }
  });

  it("merges a node added on one device against a node retyped on the other", () => {
    const mine = edited((c) => {
      c.nodes.push({
        id: "n8",
        type: "text",
        text: "New idea",
        x: 800,
        y: 200,
        width: 300,
        height: 100,
      });
    });
    const theirs = edited((c) => {
      c.nodes[5]!.text = "Answered: dedup earns nothing on photographs.";
    });
    for (const [which, out] of Object.entries(bothMerges(BASE, mine, theirs))) {
      if (out.kind !== "merged") throw new Error(`${which} refused a good merge: ${out.why}`);
      expect(node(out.text, "n8"), which).toBeDefined();
      expect(node(out.text, "n6")?.text, which).toContain("Answered");
    }
  });

  it("merges two nodes deleted on different devices", () => {
    // Rule 5 says a result smaller than its input is a bug until shown
    // otherwise. Here it is shown twice over, by the two devices that did the
    // deleting, and the check that matters is that both deletions happened
    // rather than one of them being quietly undone.
    const drop = (c: Canvas, id: string) => {
      c.nodes = c.nodes.filter((n) => n.id !== id);
      c.edges = c.edges.filter((e) => e.fromNode !== id && e.toNode !== id);
    };
    const mine = edited((c) => drop(c, "n2"));
    const theirs = edited((c) => drop(c, "n7"));
    for (const [which, out] of Object.entries(bothMerges(BASE, mine, theirs))) {
      if (out.kind !== "merged") throw new Error(`${which} refused a good merge: ${out.why}`);
      const ids = (JSON.parse(out.text) as Canvas).nodes.map((n) => n.id);
      expect(ids, which).toEqual(["n1", "n3", "n4", "n5", "n6"]);
    }
  });

  it("refuses two devices that moved the same node", () => {
    // One line, changed by both, and the two changes are inside one JSON
    // object. There is no arrangement of them that is what either person
    // meant, so both copies are kept.
    const mine = edited((c) => {
      c.nodes[3]!.x = -1000;
    });
    const theirs = edited((c) => {
      c.nodes[3]!.x = 555;
    });
    for (const [which, out] of Object.entries(bothMerges(BASE, mine, theirs))) {
      expect(out.kind, which).toBe("conflict");
    }
  });

  it("refuses two devices that retyped the same text node", () => {
    const mine = edited((c) => {
      c.nodes[3]!.text = "Mine: rolling hash wins on prose.";
    });
    const theirs = edited((c) => {
      c.nodes[3]!.text = "Theirs: fixed blocks lose on prose.";
    });
    for (const [which, out] of Object.entries(bothMerges(BASE, mine, theirs))) {
      expect(out.kind, which).toBe("conflict");
    }
  });

  it("refuses two devices that each appended a node", () => {
    // The last node in the array is the line that gains a comma, so both
    // devices changed it. Refused by `fusedLine` before `stillValid` is
    // reached, and worth pinning here because appending is what two people
    // most often do at once and the answer is a conflict copy rather than a
    // canvas with one comma too few.
    const mine = edited((c) => {
      c.nodes.push({
        id: "n8",
        type: "text",
        text: "Mine",
        x: 800,
        y: 200,
        width: 300,
        height: 100,
      });
    });
    const theirs = edited((c) => {
      c.nodes.push({
        id: "n9",
        type: "text",
        text: "Theirs",
        x: 900,
        y: 400,
        width: 300,
        height: 100,
      });
    });
    for (const [which, out] of Object.entries(bothMerges(BASE, mine, theirs))) {
      expect(out.kind, which).toBe("conflict");
    }
  });

  /**
   * An edge whose node the other device deleted, which is valid JSON, opens
   * fine, and loses the edge anyway.
   *
   * Recorded rather than fixed, and the distinction is the point. Obsidian's
   * `importData` builds an edge only `if (o.has(fromNode) && o.has(toNode))`,
   * so on the next save the edge this device drew is gone with no message.
   * That is a silent loss, and it is not one the merge invented: one person
   * deleted the node and the other drew to it, and there is no third answer.
   * Refusing it would need `stillValid` to be given the ancestor and both
   * sides, so it could tell an edge the merge orphaned from one the ancestor
   * already had, and that is a change to the predicate's signature and to
   * `engine.ts`. Written down here so the next person meets it as a decision
   * rather than as a surprise.
   */
  it("merges a deleted node against an edge drawn to it, and orphans the edge", () => {
    const mine = edited((c) => {
      c.nodes = c.nodes.filter((n) => n.id !== "n5");
      c.edges = c.edges.filter((e) => e.fromNode !== "n5" && e.toNode !== "n5");
    });
    const theirs = edited((c) => {
      c.edges.push({ id: "e5", fromNode: "n5", fromSide: "right", toNode: "n6", toSide: "left" });
    });
    for (const [which, out] of Object.entries(bothMerges(BASE, mine, theirs))) {
      if (out.kind !== "merged") throw new Error(`${which} refused a good merge: ${out.why}`);
      const merged = JSON.parse(out.text) as Canvas;
      const ids = new Set(merged.nodes.map((n) => n.id));
      expect(ids.has("n5"), which).toBe(false);
      const orphans = merged.edges.filter((e) => !ids.has(e.fromNode) || !ids.has(e.toNode));
      expect(
        orphans.map((e) => e.id),
        which,
      ).toEqual(["e5"]);
    }
  });
});

/**
 * The case `stillValid` exists for, which until now had no test because
 * nobody had produced one.
 */
describe("the first arrow, drawn on two devices at once", () => {
  const empty = (): Canvas => ({
    nodes: [
      {
        id: "n1",
        type: "file",
        file: "Reading/Chunking.md",
        x: -660,
        y: -360,
        width: 400,
        height: 400,
      },
      {
        id: "n2",
        type: "text",
        text: "Rolling hash boundaries.",
        x: -220,
        y: -360,
        width: 420,
        height: 140,
      },
    ],
    edges: [],
  });
  const arrow = (id: string, from: string, to: string): string => {
    const c = empty();
    c.edges.push({ id, fromNode: from, fromSide: "right", toNode: to, toSide: "left" });
    return canvasText(c);
  };
  const base = canvasText(empty());
  const mine = arrow("e-mine", "n1", "n2");
  const theirs = arrow("e-theirs", "n2", "n1");

  it("would merge into a canvas Obsidian refuses to open", () => {
    // The unguarded merge, which is what every check other than `stillValid`
    // sees. Both edges are present, in a file that is one comma short of
    // being JSON. This is the assertion that fails if the merge ever stops
    // producing it, at which point the check below is measuring nothing.
    for (const [which, out] of Object.entries(bothMerges(base, mine, theirs, () => true))) {
      if (out.kind !== "merged")
        throw new Error(`${which} no longer reaches the check: ${out.why}`);
      expect(out.text, which).toContain("e-mine");
      expect(out.text, which).toContain("e-theirs");
      expect(parsesAsJson(out.text), which).toBe(false);
    }
  });

  it("refuses the first arrow drawn on two devices at once", () => {
    for (const [which, out] of Object.entries(bothMerges(base, mine, theirs))) {
      expect(out.kind, which).toBe("conflict");
      expect(out.kind === "conflict" && out.why, which).toMatch(
        /no longer a valid file of its kind/,
      );
    }
  });

  it("still merges when only one device drew an arrow", () => {
    // The check must not turn every canvas into a conflict copy. One side
    // moved a node, the other drew the first edge, and that is a merge.
    const moved = canvasText({
      ...empty(),
      nodes: [{ ...empty().nodes[0]!, x: 40 }, empty().nodes[1]!],
    });
    for (const [which, out] of Object.entries(bothMerges(base, moved, mine))) {
      if (out.kind !== "merged") throw new Error(`${which} refused a good merge: ${out.why}`);
      expect(node(out.text, "n1")?.x, which).toBe(40);
      expect(out.text, which).toContain("e-mine");
    }
  });
});

describe("a canvas that is all on one line", () => {
  /**
   * Not what Obsidian writes, and worth measuring anyway, because a canvas
   * produced by a script or a plugin can be minified and `.json` files
   * routinely are.
   *
   * A one-line file has no line structure: diff3 sees a single region that
   * both devices changed, so the region merge hands the whole file to the
   * character merge and the two are the same thing. Everything the region
   * merge bought on a note is unavailable here, and the visible cost is the
   * merge rate: the property test at the bottom measures it.
   */
  it("collapses to one region and merges exactly as the character merge does", () => {
    const mini = JSON.stringify(board());
    const mine = JSON.stringify({
      ...board(),
      nodes: board().nodes.map((n) => (n.id === "n2" ? { ...n, x: -900 } : n)),
    });
    const theirs = JSON.stringify({
      ...board(),
      nodes: board().nodes.map((n) => (n.id === "n6" ? { ...n, x: 640 } : n)),
    });

    const parts = regions(mini, mine, theirs);
    expect(parts?.map((p) => p.changed)).toEqual(["both"]);

    const out = bothMerges(mini, mine, theirs);
    expect(out.regions).toEqual(out.characters);
    if (out.regions.kind !== "merged") throw new Error(`refused: ${out.regions.why}`);
    expect(node(out.regions.text, "n2")?.x).toBe(-900);
    expect(node(out.regions.text, "n6")?.x).toBe(640);
  });

  it("refuses a canvas one device reformatted", () => {
    // A tool that rewrites the whole file makes every line a changed line, so
    // there is nothing left for the other device's edit to merge into. A
    // conflict copy is the right answer and this pins that it is the answer.
    const theirs = edited((c) => {
      c.nodes[5]!.x = 640;
    });
    for (const [which, out] of Object.entries(bothMerges(BASE, JSON.stringify(board()), theirs))) {
      expect(out.kind, which).toBe("conflict");
    }
  });
});

describe("json files that are not canvases", () => {
  const pretty = (value: unknown) => JSON.stringify(value, null, 2);
  const doc = {
    name: "vault-tools",
    version: "1.0.0",
    scripts: { build: "tsc", test: "vitest" },
    keywords: ["merge", "sync"],
  };

  it("merges edits to different keys", () => {
    const base = pretty(doc);
    const mine = pretty({ ...doc, name: "vault-kit" });
    const theirs = pretty({ ...doc, version: "1.1.0" });
    for (const [which, out] of Object.entries(bothMerges(base, mine, theirs))) {
      if (out.kind !== "merged") throw new Error(`${which} refused a good merge: ${out.why}`);
      const merged = JSON.parse(out.text) as typeof doc;
      expect(merged.name, which).toBe("vault-kit");
      expect(merged.version, which).toBe("1.1.0");
    }
  });

  it("refuses two keys added to the same object", () => {
    // The same shape as the first arrow: the last entry of an object gains a
    // comma on both devices. Refused before `stillValid`, by the checks that
    // already existed, and pinned so that a change to those checks does not
    // quietly start relying on the parse check for the common case.
    const base = pretty(doc);
    const mine = pretty({ ...doc, scripts: { ...doc.scripts, lint: "eslint" } });
    const theirs = pretty({ ...doc, scripts: { ...doc.scripts, fmt: "prettier" } });
    for (const [which, out] of Object.entries(bothMerges(base, mine, theirs))) {
      expect(out.kind, which).toBe("conflict");
    }
  });
});

/**
 * The property, over generated canvases: a `merged` outcome is never a file
 * the application refuses to open.
 *
 * Small boards on purpose, with empty `nodes` and `edges` arrays common,
 * because that is where the punctuation is fragile: an array with nothing in
 * it is one line, and an array with one thing in it is three.
 *
 * The second assertion is the one that keeps this honest. A property test that
 * only says "nothing broke" passes just as well when the check it is testing
 * has been deleted, which is rule 10 in its usual disguise. So the run also
 * counts the merges that would have been invalid without `stillValid` and
 * fails if there are none: the corpus has to keep reaching the check, or it is
 * not evidence for it.
 */
describe("no merge of two canvases is a canvas that will not open", () => {
  const WORDS = ["chunk", "merge", "hash", "vault", "note"];

  function generated(cases: number, serialise: (c: Canvas) => string) {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const int = (n: number) => Math.floor(rnd() * n);
    const pick = <T>(a: T[]): T => a[int(a.length)]!;

    const start = (): Canvas => {
      const nodes: Node[] = [];
      for (let i = 0, n = int(4); i < n; i++) {
        nodes.push({
          id: `n${i}`,
          type: "text",
          text: `${pick(WORDS)} ${pick(WORDS)}`,
          x: int(400),
          y: int(400),
          width: 300,
          height: 100,
        });
      }
      const edges: Edge[] = [];
      for (let i = 0, n = nodes.length > 1 ? int(3) : 0; i < n; i++) {
        edges.push({
          id: `e${i}`,
          fromNode: pick(nodes).id,
          fromSide: "right",
          toNode: pick(nodes).id,
          toSide: "left",
        });
      }
      return { nodes, edges };
    };

    const mutate = (from: Canvas, tag: string): Canvas => {
      const c = JSON.parse(JSON.stringify(from)) as Canvas;
      for (let k = 0, ops = 1 + int(2); k < ops; k++) {
        const op = pick(["add", "addEdge", "drop", "dropEdge", "move", "retext", "clear"]);
        if (op === "add") {
          c.nodes.splice(int(c.nodes.length + 1), 0, {
            id: `${tag}${k}`,
            type: "text",
            text: `${tag} ${pick(WORDS)}`,
            x: int(400),
            y: int(400),
            width: 300,
            height: 100,
          });
        } else if (op === "addEdge" && c.nodes.length > 0) {
          c.edges.splice(int(c.edges.length + 1), 0, {
            id: `${tag}e${k}`,
            fromNode: pick(c.nodes).id,
            fromSide: "right",
            toNode: pick(c.nodes).id,
            toSide: "left",
          });
        } else if (op === "drop" && c.nodes.length > 0) c.nodes.splice(int(c.nodes.length), 1);
        else if (op === "dropEdge" && c.edges.length > 0) c.edges.splice(int(c.edges.length), 1);
        else if (op === "move" && c.nodes.length > 0) {
          const n = pick(c.nodes);
          n.x = int(400);
          n.y = int(400);
        } else if (op === "retext" && c.nodes.length > 0)
          pick(c.nodes).text = `${tag} ${pick(WORDS)}`;
        else if (op === "clear") c.edges = [];
      }
      return c;
    };

    let checked = 0;
    let merged = 0;
    let reachedTheCheck = 0;
    const broken: string[] = [];
    for (let i = 0; i < cases; i++) {
      const from = start();
      const base = serialise(from);
      const mine = serialise(mutate(from, "MINE"));
      const theirs = serialise(mutate(from, "THEM"));
      if (base === mine || base === theirs || mine === theirs) continue;
      for (const [which, merge] of Object.entries({
        regions: mergeText,
        characters: mergeTextCharacters,
      })) {
        checked++;
        const guarded = merge(base, mine, theirs, parsesAsJson);
        if (guarded.kind === "conflict") {
          // Did `stillValid` do it, or did one of the older checks?
          const unguarded = merge(base, mine, theirs, () => true);
          if (unguarded.kind !== "conflict" && !parsesAsJson(unguarded.text)) reachedTheCheck++;
          continue;
        }
        merged++;
        if (!parsesAsJson(guarded.text)) {
          broken.push(
            `case ${i} (${which})\nbase:\n${base}\nmine:\n${mine}\ntheirs:\n${theirs}\ngot:\n${guarded.text}`,
          );
        }
      }
    }
    return { checked, merged, reachedTheCheck, broken };
  }

  it("holds for canvases written the way Obsidian writes them", () => {
    const r = generated(4000, canvasText);
    expect(
      r.broken.slice(0, 1).join("\n"),
      `${r.broken.length} merges produced a file that is not JSON`,
    ).toBe("");
    // Sanity on the corpus itself, rule 8: a run that merged nothing would
    // pass the property and mean nothing.
    expect(r.merged).toBeGreaterThan(r.checked / 10);
    // And the check has to be load-bearing here, or this file is not the
    // evidence it claims to be. Measured at 193 against 2,236 clean merges,
    // so the floor is set well under that rather than at it: this is asking
    // whether the corpus still reaches the check, not pinning a count that a
    // harmless change to the generator would break.
    expect(r.reachedTheCheck).toBeGreaterThan(20);
  });

  it("holds for minified canvases, which almost never merge at all", () => {
    const r = generated(4000, (c) => JSON.stringify(c));
    expect(
      r.broken.slice(0, 1).join("\n"),
      `${r.broken.length} merges produced a file that is not JSON`,
    ).toBe("");
    // Recorded, not required: with no line structure every edit lands in one
    // region and most pairs conflict. The number is here so that a change to
    // it is noticed rather than discovered.
    expect(r.merged).toBeGreaterThan(0);
    expect(r.merged).toBeLessThan(r.checked / 3);
  });
});
