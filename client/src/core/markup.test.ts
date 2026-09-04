import { describe, expect, it } from "vitest";

import { mergeText, mergeTextCharacters } from "./merge.ts";

/**
 * Whether `.svg`, `.xml` and `.csv` want the validity gate `.canvas` and
 * `.json` have, answered with a corpus rather than with taste.
 *
 * `stillValid` is the predicate `engine.ts` passes to `mergeText` for a path
 * `looksLikeJson` recognises. canvas.test.ts turned it from a precaution into
 * a measured check: 193 of 2,429 clean canvas merges are files Obsidian will
 * not open, one in thirteen, and no other check sees any of them. The obvious
 * next question was whether the same is true of the other structured formats
 * in `TEXT_EXTENSIONS`, which merge as text with nothing looking at the
 * result. A malformed SVG is as unopenable as a malformed canvas, so the
 * suspicion was reasonable.
 *
 * It is wrong, and the reason is structural rather than lucky.
 *
 * ## What the canvas failure actually is
 *
 * It is not "JSON is fragile". It is one character: the comma between two
 * siblings. `"edges":[]` is one line in the ancestor and three on each device,
 * both sides changed that line, and the character merge concatenates the two
 * edge objects with nothing between them. Every other check passes, because
 * nothing was lost and nothing collided. The file is one comma short of
 * parsing.
 *
 * **XML has no separator between siblings.** Two devices that each add an
 * element at one point produce `<rect/><rect/>`, which is exactly as
 * well-formed as either alone. There is no comma to lose. The failure class
 * that `stillValid` exists for does not arise, and the corpus below is here to
 * say so with a number instead of an argument.
 *
 * ## The numbers, measured by the property below
 *
 * The same document tree, the same mutations, four writers. Written as
 * Obsidian-canvas-shaped JSON, 299 of 17,415 clean merges do not parse, one in
 * 58. Written as SVG, in each of the three ways a tool writes one: 0 of
 * 18,229, 0 of 19,333 and 0 of 15,698. Fifty-three thousand merges, none of
 * them malformed.
 *
 * That control is the point of the file. A property test reporting that
 * nothing broke passes just as well when the corpus never reached the failure,
 * which is rule 10 in its usual disguise, so the run asserts that the JSON side
 * *does* break. The corpus reaches the failure class; XML is not in it.
 *
 * Twelve hand-built adversarial pairs are below as well, covering every
 * operation that could plausibly unbalance a tag: deleting a group somebody
 * else drew into, grouping, ungrouping, overlapping groupings, expanding a
 * self-closing element, mixed content, comments, CDATA. Five conflict and
 * seven merge. None is malformed.
 *
 * ## The verdict, and what it costs
 *
 * No gate for `.svg` or `.xml`. It would be a hand-rolled scanner in the most
 * durability-critical module, shipped to a phone, firing on nothing measured,
 * and a scanner that is wrong about some valid SVG would turn good merges into
 * conflict copies for ever. The alternative in the same breath, refusing to
 * merge these types at all, is worse and is measured too: 18,229 of the 34,546
 * attempts below merge cleanly, so it would turn 53% of them into conflict
 * copies in order to catch none.
 *
 * `.csv` is measured separately at the bottom, gets its own answer, and the
 * answer is also no, for a different reason. It does break, 600 merges in
 * 16,793, but what breaks is the row shape, and in all 600 every row of the
 * result is a row one of the two devices wrote, character for character. A
 * ragged table is a file every reader still opens with every edit in it. That
 * is not the canvas failure, which is total.
 *
 * If a future format does start producing malformed merges here, this file is
 * where it will show up first, because the property fails rather than the
 * count drifting.
 */

/**
 * The measuring instrument: is this text well-formed markup.
 *
 * Deliberately *not* production code. Declining the gate is the finding, so
 * this exists to make the finding checkable and lives with the test that uses
 * it. It is a scanner rather than a parser: tags balanced, one root, comments
 * and CDATA and processing instructions and DOCTYPE skipped, attribute values
 * quote-aware. It does not check entities, namespaces or the DTD, and it does
 * not need to: what is being measured is whether a merge unbalances the tags.
 *
 * Its own cases are asserted below before anything is measured with it, since
 * a corpus is worth nothing if the instrument is wrong.
 */
export function wellFormedMarkup(text: string): boolean {
  const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    i = lt + 1;
    if (text.startsWith("!--", i)) {
      const end = text.indexOf("-->", i + 3);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    if (text.startsWith("![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 8);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    if (text.startsWith("?", i)) {
      const end = text.indexOf("?>", i + 1);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (text.startsWith("!", i)) {
      // DOCTYPE, whose internal subset is bracketed and may hold a `>`.
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= text.length) return false;
      i = j + 1;
      continue;
    }
    const closing = text[i] === "/";
    if (closing) i++;
    NAME.lastIndex = i;
    const named = NAME.exec(text);
    if (named === null) return false;
    const name = named[0];
    i = NAME.lastIndex;
    let selfClosing = false;
    let closed = false;
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'") {
        const end = text.indexOf(c, i + 1);
        if (end < 0) return false;
        i = end + 1;
        continue;
      }
      if (c === "<") return false; // a `<` inside a tag is never well formed
      if (c === "/") {
        selfClosing = true;
        i++;
        continue;
      }
      if (c === ">") {
        i++;
        closed = true;
        break;
      }
      if (selfClosing) return false; // a `/` anywhere but before the `>`
      i++;
    }
    if (!closed) return false;
    if (closing) {
      if (selfClosing) return false;
      if (stack.pop() !== name) return false;
      if (stack.length === 0) roots++;
    } else if (!selfClosing) {
      stack.push(name);
    } else if (stack.length === 0) roots++;
  }
  return stack.length === 0 && roots === 1;
}

/** Whether text is still JSON. The predicate `engine.ts` supplies for `.canvas` and `.json`. */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

describe("the instrument itself", () => {
  it("answers the cases a corpus depends on", () => {
    const cases: [string, boolean][] = [
      ["<a/>", true],
      ["<a></a>", true],
      ["<a><b/></a>", true],
      ["<a><b></a>", false],
      ["<a/><b/>", false], // two roots
      ["<a>", false],
      ["</a>", false],
      ['<?xml version="1.0"?><a/>', true],
      ["<!-- hi --><a/>", true],
      ["<a><![CDATA[<not a tag>]]></a>", true],
      ['<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd"><svg/>', true],
      ['<!DOCTYPE a [ <!ENTITY x "y"> ]><a/>', true],
      ['<a b="1>2"/>', true], // a `>` inside an attribute value
      ["<a b='x\"y'/>", true],
      ["<svg><g/><g/></svg>", true],
      ["<svg><g><rect/></svg>", false],
      ["<a>text &amp; more</a>", true],
    ];
    for (const [text, want] of cases) {
      expect(wellFormedMarkup(text), JSON.stringify(text)).toBe(want);
    }
  });

  /**
   * A real one, so the instrument is not only tested against things it was
   * written next to. Transcribed from `docs/assets/logo.svg`, which is also
   * where the "one element per line" claim below comes from: every SVG this
   * repository ships is written that way, and so is every SVG an exporter
   * produces that is not minified.
   */
  it("accepts a real SVG, and rejects it with one tag removed", () => {
    const real = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 248 179" width="248" height="179" role="img" aria-label="Basalt">',
      '  <polygon points="109.0,50.0 94.0,63.0 64.0,63.0 49.0,50.0 64.0,37.0 94.0,37.0" fill="#8FA3B8"/>',
      '  <polygon points="49.0,50.0 64.0,63.0 64.0,149.0 49.0,136.0" fill="#4B5C70"/>',
      '  <polygon points="64.0,63.0 94.0,63.0 94.0,149.0 64.0,149.0" fill="#3A4857"/>',
      "</svg>",
    ].join("\n");
    expect(wellFormedMarkup(real)).toBe(true);
    expect(wellFormedMarkup(real.replace("</svg>", ""))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// One document tree, two writers.
// ---------------------------------------------------------------------------

interface Leaf {
  kind: string;
  id: string;
  attrs: Record<string, string | number>;
  text?: string;
}
interface Group {
  kind: "g";
  id: string;
  attrs: Record<string, string | number>;
  kids: Node[];
}
type Node = Leaf | Group;
const isGroup = (n: Node): n is Group => (n as Group).kids !== undefined;

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 470">';
const attrsOf = (n: Node) =>
  Object.entries(n.attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");

/** One element per line, which is how every SVG in this repository is written. */
function svgText(roots: Node[]): string {
  const out = [HEAD];
  const emit = (n: Node, pad: string) => {
    if (isGroup(n)) {
      if (n.kids.length === 0) {
        out.push(`${pad}<g id="${n.id}"${attrsOf(n)}></g>`);
        return;
      }
      out.push(`${pad}<g id="${n.id}"${attrsOf(n)}>`);
      for (const kid of n.kids) emit(kid, pad + "  ");
      out.push(`${pad}</g>`);
    } else if (n.text !== undefined) {
      out.push(`${pad}<${n.kind} id="${n.id}"${attrsOf(n)}>${n.text}</${n.kind}>`);
    } else {
      out.push(`${pad}<${n.kind} id="${n.id}"${attrsOf(n)}/>`);
    }
  };
  for (const root of roots) emit(root, "  ");
  out.push("</svg>");
  return out.join("\n") + "\n";
}

/**
 * Inkscape 1.x: one attribute per line, with the tag closed on the last of
 * them.
 *
 * Included because it is the only common shape where the line structure runs
 * through the *inside* of a tag, which is the one place a line-wise merge
 * could plausibly lose a `>` or a `/`. It is also what the most widely used
 * SVG editor writes, so a vault holding hand-drawn diagrams holds this.
 */
function inkscapeText(roots: Node[]): string {
  const out = [HEAD];
  const emit = (n: Node, pad: string) => {
    const entries: [string, string | number][] = [["id", n.id], ...Object.entries(n.attrs)];
    if (isGroup(n)) {
      out.push(`${pad}<g`);
      entries.forEach(([k, v], i) =>
        out.push(`${pad}   ${k}="${v}"${i === entries.length - 1 ? ">" : ""}`),
      );
      for (const kid of n.kids) emit(kid, pad + "  ");
      out.push(`${pad}</g>`);
      return;
    }
    out.push(`${pad}<${n.kind}`);
    entries.forEach(([k, v], i) => {
      const last = i === entries.length - 1;
      const tail = !last ? "" : n.text !== undefined ? `>${n.text}</${n.kind}>` : " />";
      out.push(`${pad}   ${k}="${v}"${tail}`);
    });
  };
  for (const root of roots) emit(root, "  ");
  out.push("</svg>");
  return out.join("\n") + "\n";
}

/** No line structure at all, which is what a script or a build step produces. */
const minifiedSvg = (roots: Node[]) => svgText(roots).replace(/\n\s*/g, "");

/**
 * The control: the same tree as JSON, written the way Obsidian writes a canvas.
 *
 * The rule is the one canvas.test.ts transcribed from `$d`/`Zd` in app.js of
 * the shipped Obsidian: an object or array all of whose members are primitives
 * goes on one line, everything else is indented. That is what gives a canvas
 * its line structure, and reproducing it here is what makes the comparison
 * against the SVG writers an apples-to-apples one. Same tree, same edits, one
 * format with a separator between siblings and one without.
 */
function jsonText(roots: Node[]): string {
  const lines = (value: unknown): string[] => {
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
      value.forEach((item, i) => indent(lines(item), i === value.length - 1, out));
      out.push("]");
      return out;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined);
    if (keys.every((k) => primitive(record[k]))) return [JSON.stringify(record)];
    const out = ["{"];
    keys.forEach((key, i) => {
      const kid = lines(record[key]);
      kid[0] = JSON.stringify(key) + ":" + kid[0];
      indent(kid, i === keys.length - 1, out);
    });
    out.push("}");
    return out;
  };
  return lines({ children: roots }).join("\n") + "\n";
}

describe("the shape of an SVG as a drawing tool writes one", () => {
  /**
   * Everything below depends on this, the way canvas.test.ts depends on its
   * own. If the writers here stop putting one element on one line, the merge
   * behaviour recorded in this file stops applying and this says so first.
   */
  it("puts every element on a line of its own, and is well formed", () => {
    const doc: Node[] = [
      {
        kind: "g",
        id: "layer",
        attrs: {},
        kids: [
          { kind: "rect", id: "r1", attrs: { x: 1, y: 2 } },
          { kind: "text", id: "t1", attrs: { x: 3, y: 4 }, text: "hello" },
        ],
      },
    ];
    const lines = svgText(doc).trimEnd().split("\n");
    expect(lines[0]).toBe(HEAD);
    expect(lines.filter((l) => l.trim().startsWith("<rect"))).toHaveLength(1);
    expect(lines.filter((l) => l.trim().startsWith("<text"))).toHaveLength(1);
    expect(wellFormedMarkup(svgText(doc))).toBe(true);
    expect(wellFormedMarkup(inkscapeText(doc))).toBe(true);
    expect(wellFormedMarkup(minifiedSvg(doc))).toBe(true);
    // And the control writes the same tree as line-structured JSON.
    expect(parsesAsJson(jsonText(doc))).toBe(true);
    expect(jsonText(doc).split("\n").length).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// The adversarial pairs.
// ---------------------------------------------------------------------------

/**
 * Every operation that could plausibly unbalance a tag, built by hand rather
 * than waited for.
 *
 * The generated corpus below is the evidence; this is the part somebody can
 * read. Each case is a thing two people do to one drawing, and the assertion
 * is rule 10's: not that the two devices agree, but that no `merged` outcome
 * is markup a reader would refuse.
 */
describe("two devices editing one drawing", () => {
  const doc = (...lines: string[]) => [HEAD, ...lines, "</svg>"].join("\n") + "\n";

  /** Both merges, because a structured file has to be safe in the fallback too. */
  const outcomes = (base: string, mine: string, theirs: string) =>
    Object.entries({
      regions: mergeText(base, mine, theirs),
      characters: mergeTextCharacters(base, mine, theirs),
    });

  const neverMalformed = (base: string, mine: string, theirs: string) => {
    for (const [which, out] of outcomes(base, mine, theirs)) {
      if (out.kind === "conflict") continue;
      expect(wellFormedMarkup(out.text), `${which} produced:\n${out.text}`).toBe(true);
    }
  };

  it("refuses a group one device deleted and the other drew into", () => {
    // The nastiest shape available: one side removes the `</g>` entirely while
    // the other adds a line that needs it. Both sides changed the same stretch
    // of the ancestor, so the region merge never reaches the character merge.
    const base = doc('  <g id="a">', '    <rect id="r1"/>', "  </g>", '  <rect id="r2"/>');
    const mine = doc('  <rect id="r2"/>');
    const theirs = doc(
      '  <g id="a">',
      '    <rect id="r1"/>',
      '    <rect id="new"/>',
      "  </g>",
      '  <rect id="r2"/>',
    );
    for (const [which, out] of outcomes(base, mine, theirs))
      expect(out.kind, which).toBe("conflict");
  });

  it("refuses two devices that grouped overlapping runs of shapes", () => {
    const base = doc(
      '  <rect id="r1"/>',
      '  <rect id="r2"/>',
      '  <rect id="r3"/>',
      '  <rect id="r4"/>',
    );
    const mine = doc(
      '  <g id="M">',
      '    <rect id="r1"/>',
      '    <rect id="r2"/>',
      "  </g>",
      '  <rect id="r3"/>',
      '  <rect id="r4"/>',
    );
    const theirs = doc(
      '  <rect id="r1"/>',
      '  <g id="T">',
      '    <rect id="r2"/>',
      '    <rect id="r3"/>',
      "  </g>",
      '  <rect id="r4"/>',
    );
    for (const [which, out] of outcomes(base, mine, theirs))
      expect(out.kind, which).toBe("conflict");
  });

  it("refuses ungrouping against an addition inside the group", () => {
    const base = doc('  <g id="G">', '    <rect id="r1"/>', '    <rect id="r2"/>', "  </g>");
    const mine = doc('  <rect id="r1"/>', '  <rect id="r2"/>');
    const theirs = doc(
      '  <g id="G">',
      '    <rect id="r1"/>',
      '    <rect id="new"/>',
      '    <rect id="r2"/>',
      "  </g>",
    );
    for (const [which, out] of outcomes(base, mine, theirs))
      expect(out.kind, which).toBe("conflict");
  });

  /**
   * The canvas case, transposed, and it is the whole finding in one test.
   *
   * canvas.test.ts's case is a board with two cards and no arrows, where each
   * device draws the first arrow: `"edges":[]` is one line in the ancestor and
   * three on each side, both changed it, and the merge concatenates the two
   * edge objects with no comma between them. Here it is an empty group that
   * each device puts its first shape into, which is the same edit to the same
   * tree.
   *
   * Both are asserted, side by side, because the contrast is the evidence. The
   * JSON writing does not parse. The SVG writing is exactly as well formed as
   * either side alone, because siblings in XML need no separator. There is
   * nothing for a gate to catch.
   */
  it("merges the edit that breaks a canvas, and the markup is still well formed", () => {
    const base = doc('  <g id="a"></g>');
    const mine = doc('  <g id="a">', '    <rect id="m"/>', "  </g>");
    const theirs = doc('  <g id="a">', '    <rect id="t"/>', "  </g>");
    // Neither merge may produce malformed markup, and the region merge, which
    // is the path a file with line structure actually takes, has to reach the
    // result at all or this case is measuring nothing. The character fallback
    // refuses this one on the two-directions check, which is a safe answer and
    // not the one under test.
    for (const [which, out] of outcomes(base, mine, theirs)) {
      if (out.kind === "conflict") continue;
      expect(wellFormedMarkup(out.text), `${which} produced:\n${out.text}`).toBe(true);
    }
    const merged = mergeText(base, mine, theirs);
    if (merged.kind !== "merged") throw new Error(`the region merge refused it: ${merged.why}`);
    expect(merged.text).toContain('id="m"');
    expect(merged.text).toContain('id="t"');

    // The same empty container, the same two first children, written as
    // Obsidian writes a canvas. One comma, and the file will not open.
    const tree = (first?: string): Node[] => [
      {
        kind: "g",
        id: "a",
        attrs: {},
        kids: first === undefined ? [] : [{ kind: "rect", id: first, attrs: {} }],
      },
    ];
    const control = mergeText(
      jsonText(tree()),
      jsonText(tree("m")),
      jsonText(tree("t")),
      () => true,
    );
    if (control.kind !== "merged") throw new Error(`the control no longer merges: ${control.why}`);
    expect(control.text, "the control lost an edit").toContain('"id":"m"');
    expect(control.text, "the control lost an edit").toContain('"id":"t"');
    expect(parsesAsJson(control.text), "the JSON control stopped breaking").toBe(false);
  });

  it("merges an element expanded on one device against a sibling edited on the other", () => {
    const base = doc('  <g id="a"/>', '  <rect id="r1" x="1"/>');
    const mine = doc(
      '  <g id="a">',
      '    <rect id="inside"/>',
      "  </g>",
      '  <rect id="r1" x="1"/>',
    );
    const theirs = doc('  <g id="a"/>', '  <rect id="r1" x="99"/>');
    neverMalformed(base, mine, theirs);
  });

  it("merges edits to a text element with children", () => {
    const base = doc(
      '  <text x="1" y="2">',
      "    <tspan>one</tspan>",
      "    <tspan>two</tspan>",
      "  </text>",
    );
    const mine = doc(
      '  <text x="1" y="2">',
      "    <tspan>ONE</tspan>",
      "    <tspan>two</tspan>",
      "  </text>",
    );
    const theirs = doc(
      '  <text x="1" y="2">',
      "    <tspan>one</tspan>",
      "    <tspan>TWO</tspan>",
      "  </text>",
    );
    neverMalformed(base, mine, theirs);
  });

  it("merges a comment removed on one device against an element added there", () => {
    const base = doc("  <!-- layer one -->", '  <rect id="r1"/>');
    const mine = doc('  <rect id="r1"/>');
    const theirs = doc("  <!-- layer one -->", '  <rect id="new"/>', '  <rect id="r1"/>');
    neverMalformed(base, mine, theirs);
  });

  it("merges edits to a CDATA style block", () => {
    const base = doc(
      "  <style>",
      "    <![CDATA[",
      "    .a { fill: red; }",
      "    ]]>",
      "  </style>",
      '  <rect id="r1"/>',
    );
    const mine = doc(
      "  <style>",
      "    <![CDATA[",
      "    .a { fill: blue; }",
      "    ]]>",
      "  </style>",
      '  <rect id="r1"/>',
    );
    const theirs = doc(
      "  <style>",
      "    <![CDATA[",
      "    .a { fill: red; }",
      "    .b { fill: green; }",
      "    ]]>",
      "  </style>",
      '  <rect id="r1"/>',
    );
    neverMalformed(base, mine, theirs);
  });

  it("merges the root tag rewritten on one device against a child added on the other", () => {
    const base = doc('  <rect id="r1"/>');
    const mine =
      [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
        '  <rect id="r1"/>',
        "</svg>",
      ].join("\n") + "\n";
    const theirs = doc('  <rect id="r1"/>', '  <rect id="new"/>');
    neverMalformed(base, mine, theirs);
  });
});

// ---------------------------------------------------------------------------
// The property, with its control.
// ---------------------------------------------------------------------------

/**
 * The measurement the decision rests on.
 *
 * One generator, one set of mutations, four writers. Three write SVG and one
 * writes canvas-shaped JSON. The JSON side has to break, or the corpus is not
 * reaching the failure class and the SVG side's zero means nothing: that
 * assertion is the whole reason the control is here, and it is rule 8, trust
 * the numbers rather than the passes.
 */
describe("no merge of two drawings is markup a reader will refuse", () => {
  const WORDS = ["chunk", "merge", "hash", "vault", "note"];

  function generated(cases: number, write: (roots: Node[]) => string, seed0: number) {
    let seed = seed0;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const int = (n: number) => Math.floor(rnd() * n);
    const pick = <T>(a: T[]): T => a[int(a.length)]!;

    const leaf = (id: string): Leaf => {
      const kind = pick(["rect", "circle", "path", "text", "text"]);
      if (kind === "text")
        return {
          kind: "text",
          id,
          attrs: { x: int(900), y: int(400) },
          text: `${pick(WORDS)} ${pick(WORDS)}`,
        };
      if (kind === "path")
        return {
          kind: "path",
          id,
          attrs: { d: `M${int(900)},${int(400)} L${int(900)},${int(400)}`, stroke: "#B8C4D2" },
        };
      if (kind === "circle")
        return { kind: "circle", id, attrs: { cx: int(900), cy: int(400), r: 8 } };
      return {
        kind: "rect",
        id,
        attrs: { x: int(900), y: int(400), width: 120, height: 40, fill: "#F4F6F9" },
      };
    };

    // Small documents with empty groups common, for the same reason
    // canvas.test.ts keeps its boards small: an empty container is one line and
    // a filled one is three, and that is where the punctuation is fragile.
    const start = (): Node[] => {
      const roots: Node[] = [];
      for (let i = 0, n = 1 + int(2); i < n; i++) {
        const kids: Node[] = [];
        for (let k = 0, m = int(4); k < m; k++) kids.push(leaf(`s${i}_${k}`));
        roots.push({ kind: "g", id: `layer${i}`, attrs: {}, kids });
      }
      return roots;
    };

    const groupsIn = (roots: Node[]): Group[] => {
      const out: Group[] = [];
      const walk = (ns: Node[]) => {
        for (const n of ns)
          if (isGroup(n)) {
            out.push(n);
            walk(n.kids);
          }
      };
      walk(roots);
      return out;
    };

    const mutate = (from: Node[], tag: string): Node[] => {
      const roots = JSON.parse(JSON.stringify(from)) as Node[];
      for (let k = 0, n = 1 + int(2); k < n; k++) {
        const all = groupsIn(roots);
        if (all.length === 0) break;
        const g = pick(all);
        const op = pick([
          "add",
          "drop",
          "move",
          "retext",
          "recolour",
          "clear",
          "addLayer",
          "dropLayer",
          "attr",
          "group",
          "ungroup",
        ]);
        if (op === "add") g.kids.splice(int(g.kids.length + 1), 0, leaf(`${tag}${k}`));
        else if (op === "drop" && g.kids.length > 0) g.kids.splice(int(g.kids.length), 1);
        else if (op === "move" && g.kids.length > 0) {
          const s = pick(g.kids);
          if ("x" in s.attrs) s.attrs.x = int(900);
          else if ("cx" in s.attrs) s.attrs.cx = int(900);
          else s.attrs.d = `M${int(900)},0 L0,0`;
        } else if (op === "retext") {
          const texts = g.kids.filter((s) => !isGroup(s) && s.text !== undefined);
          if (texts.length > 0) (pick(texts) as Leaf).text = `${tag} ${pick(WORDS)}`;
        } else if (op === "recolour" && g.kids.length > 0)
          pick(g.kids).attrs.fill = tag === "MINE" ? "#4B5C70" : "#8FA3B8";
        else if (op === "clear") g.kids = [];
        else if (op === "addLayer")
          roots.splice(int(roots.length + 1), 0, {
            kind: "g",
            id: `${tag}L${k}`,
            attrs: {},
            kids: [leaf(`${tag}L${k}s`)],
          });
        else if (op === "dropLayer" && roots.length > 1) roots.splice(int(roots.length), 1);
        else if (op === "attr" && g.kids.length > 0)
          pick(g.kids).attrs[`data-${tag}`] = pick(WORDS);
        // "Group these": the everyday drawing operation that changes nesting
        // depth, and the one most likely to move a closing tag.
        else if (op === "group" && g.kids.length > 1) {
          const at = int(g.kids.length - 1);
          const taken = g.kids.splice(at, 1 + int(g.kids.length - at));
          g.kids.splice(at, 0, { kind: "g", id: `${tag}G${k}`, attrs: {}, kids: taken });
        } else if (op === "ungroup") {
          const inner = g.kids.filter(isGroup);
          if (inner.length > 0) {
            const target = pick(inner);
            const at = g.kids.indexOf(target);
            g.kids.splice(at, 1, ...target.kids);
          }
        }
      }
      return roots;
    };

    let checked = 0;
    let merged = 0;
    const broken: string[] = [];
    for (let i = 0; i < cases; i++) {
      const from = start();
      const base = write(from);
      const mine = write(mutate(from, "MINE"));
      const theirs = write(mutate(from, "THEM"));
      if (base === mine || base === theirs || mine === theirs) continue;
      for (const [which, merge] of Object.entries({
        regions: mergeText,
        characters: mergeTextCharacters,
      })) {
        checked++;
        // Unguarded on purpose: the question is what the merge produces with
        // nothing checking it, which is exactly the situation `.svg` is in.
        const out = merge(base, mine, theirs, () => true);
        if (out.kind === "conflict") continue;
        merged++;
        const good = write === jsonText ? parsesAsJson(out.text) : wellFormedMarkup(out.text);
        if (!good) {
          broken.push(
            `case ${i} (${which})\nbase:\n${base}mine:\n${mine}theirs:\n${theirs}got:\n${out.text}`,
          );
        }
      }
    }
    return { checked, merged, broken };
  }

  /** Eight seeds, because one generator run is one sample and this is a claim about none. */
  const over = (write: (roots: Node[]) => string) => {
    let checked = 0;
    let merged = 0;
    const broken: string[] = [];
    for (const seed of [7, 11, 13, 17, 19, 23, 29, 31]) {
      const r = generated(4000, write, seed);
      checked += r.checked;
      merged += r.merged;
      broken.push(...r.broken);
    }
    return { checked, merged, broken };
  };

  /**
   * The control, and it runs first because everything else is read against it.
   *
   * Measured at 299 of 17,415 clean merges, one in 58, the same failure
   * canvas.test.ts measures at one in thirteen over its own corpus. Asserted
   * as a floor well under the measured figure rather than at it, because this
   * is asking whether the corpus still reaches the failure, not pinning a
   * count that a harmless change to the generator would break.
   */
  it("breaks, when the same tree is written as a canvas", () => {
    const r = over(jsonText);
    expect(r.merged, "the control merged nothing").toBeGreaterThan(r.checked / 10);
    expect(
      r.broken.length,
      "the corpus no longer reaches the failure the canvas gate exists for, so the zeroes below mean nothing",
    ).toBeGreaterThan(100);
  });

  it.each([
    ["one element per line", svgText],
    ["one attribute per line, as Inkscape writes", inkscapeText],
    ["minified", minifiedSvg],
  ])("holds for SVG written %s", (_name, write) => {
    const r = over(write);
    expect(r.merged, "the corpus merged nothing").toBeGreaterThan(r.checked / 10);
    expect(
      r.broken.slice(0, 1).join("\n"),
      `${r.broken.length} of ${r.merged} merges produced markup that is not well formed`,
    ).toBe("");
  });
});

// ---------------------------------------------------------------------------
// CSV, which is a different question with a different answer.
// ---------------------------------------------------------------------------

/**
 * `.csv` does have a separator between siblings, so unlike XML it can be
 * broken by a merge. It still does not want a gate, and the reason is what
 * "broken" means.
 *
 * A canvas that does not parse is a canvas Obsidian refuses to open: every
 * node in it is inaccessible because of one comma. A CSV whose rows do not all
 * have the same field count is a file every reader still opens, and the
 * corpus below says exactly how much is wrong with it: 600 of 16,793 clean
 * merges are ragged, and in every one of those 600, every row of the result is
 * a row one of the two devices wrote, character for character. Nothing is
 * invented and nothing is lost. The shape is nearly always the same: one
 * device added a column and the other appended a row, so the new row has no
 * cell for the new column. There is no third answer to that, and a conflict
 * copy would keep two files where the merged one is the better record.
 *
 * That "no row is invented" figure is the one that decides it, and it is
 * asserted rather than described, because it is the whole difference between
 * this and the canvas case. Obsidian has no CSV view either, so "a valid file
 * of its kind" has no application to appeal to the way `.canvas` does.
 *
 * Pinned rather than fixed, so the next person meets it as a decision.
 */
describe("csv, where a merge can break the row shape and that is not the same thing", () => {
  /** Every record has the header's field count, and quotes are balanced. */
  function sameShape(text: string): boolean {
    const rows: number[] = [];
    let fields = 1;
    let inQuote = false;
    let sawAny = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuote) {
        if (c === '"') {
          if (text[i + 1] === '"') i++;
          else inQuote = false;
        }
        continue;
      }
      if (c === '"') {
        inQuote = true;
        sawAny = true;
      } else if (c === ",") {
        fields++;
        sawAny = true;
      } else if (c === "\n") {
        if (sawAny || fields > 1) rows.push(fields);
        fields = 1;
        sawAny = false;
      } else sawAny = true;
    }
    if (sawAny || fields > 1) rows.push(fields);
    if (inQuote) return false;
    return rows.length === 0 || rows.every((r) => r === rows[0]);
  }

  it("knows a ragged table from a square one", () => {
    expect(sameShape("a,b\n1,2\n3,4\n")).toBe(true);
    expect(sameShape("a,b\n1,2\n3\n")).toBe(false);
    expect(sameShape('a,b\n"x,y",2\n')).toBe(true);
    expect(sameShape('a,b\n"unclosed,2\n')).toBe(false);
  });

  /**
   * The case behind the 600, written out because a percentage is not something
   * anybody can look at. Both edits survive. Nothing is lost. The table is
   * ragged, and refusing it would keep two files instead of one better one.
   */
  it("merges a column added on one device against a row added on the other, and the table is ragged", () => {
    const base = "name,note,count\nalpha,one,1\nbeta,two,2\n";
    const mine = "name,note,count\nalpha,one,1\nbeta,two,2\ngamma,three,3\n";
    const theirs = "name,note,count,owner\nalpha,one,1,me\nbeta,two,2,you\n";
    const out = mergeText(base, mine, theirs);
    if (out.kind !== "merged") throw new Error(`refused: ${out.why}`);
    expect(out.text).toContain("gamma,three,3");
    expect(out.text).toContain("alpha,one,1,me");
    // Ragged, and every edit is still here. That is the whole argument: the
    // header and both original rows carry the new column, the appended row
    // does not, and no row was lost to make that true.
    expect(sameShape(out.text)).toBe(false);
    expect(out.text.split("\n").filter((l) => l !== "")).toEqual([
      "name,note,count,owner",
      "alpha,one,1,me",
      "beta,two,2,you",
      "gamma,three,3",
    ]);
  });

  /**
   * The corpus behind the two figures in the header, and the second of them is
   * the load-bearing one.
   *
   * `ragged` says a gate would have something to fire on, which is why this is
   * not the same "nothing happens" answer the SVG side gets. `invented` says
   * what firing would buy, which is nothing: every row of every ragged result
   * is a row one of the two devices wrote, so the file is missing trailing
   * cells and is not missing anybody's work. A conflict copy trades a readable
   * table with every edit in it for two tables, each with half.
   */
  it("goes ragged, and never invents or drops a row while doing it", () => {
    const WORDS = ["chunk", "merge", "hash", "vault", "note"];
    let checked = 0;
    let merged = 0;
    let ragged = 0;
    const invented: string[] = [];

    for (const seed0 of [7, 11, 13, 17, 19, 23, 29, 31]) {
      let seed = seed0;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const int = (n: number) => Math.floor(rnd() * n);
      const pick = <T>(a: T[]): T => a[int(a.length)]!;
      const cell = () => `${pick(WORDS)}${int(100)}`;
      const row = () => [cell(), cell(), String(int(1000))];
      const start = () => {
        const rows = [["name", "note", "count"]];
        for (let i = 0, n = 2 + int(6); i < n; i++) rows.push(row());
        return rows;
      };
      const write = (rows: string[][]) => rows.map((r) => r.join(",")).join("\n") + "\n";
      const mutate = (from: string[][], tag: string) => {
        const rows = from.map((r) => [...r]);
        for (let k = 0, n = 1 + int(2); k < n; k++) {
          const op = pick(["add", "drop", "edit", "sort", "addColumn"]);
          if (op === "add") rows.splice(1 + int(rows.length), 0, row());
          else if (op === "drop" && rows.length > 2) rows.splice(1 + int(rows.length - 1), 1);
          else if (op === "edit" && rows.length > 1) {
            const r = rows[1 + int(rows.length - 1)]!;
            r[int(r.length)] = cell();
          } else if (op === "sort") {
            const body = rows.slice(1).sort((a, b) => a[0]!.localeCompare(b[0]!));
            rows.length = 1;
            rows.push(...body);
          } else if (op === "addColumn") {
            rows[0]!.push(`${tag}col`);
            for (let i = 1; i < rows.length; i++) rows[i]!.push(cell());
          }
        }
        return rows;
      };

      for (let i = 0; i < 4000; i++) {
        const from = start();
        const base = write(from);
        const mine = write(mutate(from, "MINE"));
        const theirs = write(mutate(from, "THEM"));
        if (base === mine || base === theirs || mine === theirs) continue;
        const written = new Set(
          [...base.split("\n"), ...mine.split("\n"), ...theirs.split("\n")].filter((l) => l !== ""),
        );
        for (const [which, merge] of Object.entries({
          regions: mergeText,
          characters: mergeTextCharacters,
        })) {
          checked++;
          const out = merge(base, mine, theirs, () => true);
          if (out.kind === "conflict") continue;
          merged++;
          if (sameShape(out.text)) continue;
          ragged++;
          const strangers = out.text
            .split("\n")
            .filter((l) => l !== "" && !written.has(l))
            .slice(0, 2);
          if (strangers.length > 0) {
            invented.push(
              `case ${i} seed ${seed0} (${which}), rows nobody wrote: ${JSON.stringify(strangers)}` +
                `\nbase:\n${base}mine:\n${mine}theirs:\n${theirs}got:\n${out.text}`,
            );
          }
        }
      }
    }

    expect(merged, "the corpus merged nothing").toBeGreaterThan(checked / 10);
    // Measured at 600 of 16,793. A floor, not the count: this asks whether the
    // corpus still reaches raggedness at all, since the assertion below is
    // worth nothing over a corpus that never goes ragged.
    expect(ragged, "the corpus no longer produces a ragged table").toBeGreaterThan(100);
    // Measured at zero, and the reason the answer is no gate.
    expect(invented.slice(0, 1).join("\n"), `${invented.length} of ${ragged} invented a row`).toBe(
      "",
    );
  });
});
