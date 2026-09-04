/**
 * The canvas bug wearing a different extension, and the check that sees it.
 *
 * An Excalidraw drawing is `name.excalidraw.md`. Its extension is `md`, so
 * `looksLikeText` merges it as prose and `looksLikeJson` does not recognise it,
 * which means the one check that catches a structurally broken merge was never
 * asked about it. The body of the file is a JSON scene inside a fenced block.
 *
 * It is the same failure as the canvas, measured on the same shape. Excalidraw
 * writes the scene with `JSON.stringify(scene, null, "\t")`, so a drawing that
 * already has shapes puts every property of every element on its own line and
 * merges well: 0 of 14,270 clean merges break it. An *empty* drawing writes
 * `"elements": []` on one line, exactly as a canvas writes `"edges":[]`, and
 * when two devices each add their first shape both sides turn that one line
 * into many. The character merge runs on that region and joins the two element
 * objects with no comma between them. 744 of 4,882 clean merges, better than
 * one in seven, and every other check reports success: nothing was lost,
 * nothing collided, every word is somebody's.
 *
 * An empty drawing that two devices both draw on is not a corner. It is
 * creating a drawing, having it sync, and sketching on the other device.
 *
 * ## What a broken one does, from the shipped plugin rather than from reading
 *
 * `ExcalidrawData.loadData` calls `JSON_parse` on the extracted scene, which is
 * `JSON.parse` with one entity substitution and no catch, then refuses with
 * "Invalid Excalidraw scene: elements array is missing" if `elements` is not an
 * array. The drawing does not open. The plugin's own comment above that parse
 * says it is deliberately ordered so that "a malformed synchronized Drawing
 * section must not leave a valid open canvas backed by an unloaded or partially
 * cleared ExcalidrawData", so the plugin has already been bitten by a sync
 * corrupting this file and hardened against the worse outcome. It throws rather
 * than silently saving an empty drawing over the work, which is the one mercy
 * here. The file is still unopenable, which is the canvas failure exactly.
 *
 * ## Why this abstains and the canvas check does not
 *
 * `parsesAsJson` needs no escape hatch: `.canvas` is JSON, `JSON.parse` is a
 * real parser, and a canvas that does not parse really is broken. Here the
 * scene has to be *found* first, and finding it is a regex. A file named
 * `.excalidraw.md` that holds no drawing section, or holds a
 * ```compressed-json``` one this cannot read, must not have every merge turned
 * into a conflict copy for ever because the check could not see inside it.
 *
 * So `sceneOpens` is three-valued and the gate only has an opinion when the
 * ancestor and both devices all held a drawing it could read. The question it
 * answers is "did the merge break this", and a file that arrived broken was not
 * broken by the merge. A compressed drawing is one base64 line, so both devices
 * always change the same line and it conflicts of its own accord; abstaining
 * costs it nothing.
 *
 * The corpus, the control and the numbers above are in `excalidraw.test.ts`.
 */

/**
 * Excalidraw's own scene regex, from `DRAWING_REG` in
 * `src/shared/excalidrawMarkdownParsing.ts` of the plugin.
 *
 * Transcribed rather than approximated, for the reason canvas.test.ts
 * transcribes Obsidian's canvas serialiser: a check on a format is worth
 * nothing if it does not find the bytes the application finds. Not global,
 * because this wants the first drawing section and the plugin's `matchAll`
 * takes the first match too.
 */
const DRAWING = /\n##? Drawing\n[^`]*```json\n([\s\S]*?)```\n/;

/**
 * Whether the drawing in this file still opens: true, false, or no opinion.
 *
 * `undefined` means there is no `## Drawing` section holding plain JSON, so
 * this has nothing to say about the file. See the header on why that is a
 * third answer rather than a `false`.
 *
 * The trailing-brace trim is the plugin's, and its comment there explains it:
 * it is a workaround for files a sync merged where one side was an older
 * format without the fenced block. Kept because the goal is to judge the file
 * the way the plugin will.
 */
export function sceneOpens(text: string): boolean | undefined {
  const found = DRAWING.exec(text);
  if (found === null) return undefined;
  const scene = found[1]!;
  const trimmed = scene.substring(0, scene.lastIndexOf("}") + 1);
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    // The entity substitution is the plugin's `JSON_parse`. Without it a scene
    // holding `&#91;` parses differently here than it does there.
    parsed = JSON.parse(trimmed.replaceAll("&#91;", "["));
  } catch {
    return false;
  }
  // The plugin's own second condition, and the one that matters: a scene it
  // can parse but whose `elements` is not an array is refused with "Invalid
  // Excalidraw scene: elements array is missing".
  return Array.isArray((parsed as { elements?: unknown } | null)?.elements);
}

/** Whether a path is an Excalidraw drawing, which is a `.md` and is not prose. */
export function looksLikeExcalidraw(path: string): boolean {
  return path.toLowerCase().endsWith(".excalidraw.md");
}

/**
 * The `stillValid` predicate for a drawing, or nothing if this file is not one
 * this can judge.
 *
 * Given the ancestor and both sides, because the question is whether the merge
 * broke the drawing and that cannot be asked of a drawing that was already
 * broken. All three have to open, or there is no gate: see the header.
 */
export function drawingGate(
  base: string,
  mine: string,
  theirs: string,
): ((text: string) => boolean) | undefined {
  if (sceneOpens(base) !== true) return undefined;
  if (sceneOpens(mine) !== true) return undefined;
  if (sceneOpens(theirs) !== true) return undefined;
  return (text) => sceneOpens(text) === true;
}
