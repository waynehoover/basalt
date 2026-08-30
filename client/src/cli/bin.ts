/**
 * The process around the CLI.
 *
 * Everything worth testing is in `cli.ts`, which takes an argv and a pair of
 * output functions and returns an exit code. This is what connects that to a
 * terminal, and it is deliberately the only part of the headless client that no
 * test covers, because there is nothing here to get wrong.
 */

import { run } from "./cli.ts";

const code = await run(process.argv.slice(2), {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
});
process.exit(code);
