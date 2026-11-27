// The entrypoint the harness runs: `node /bot/main.ts` (Node 22+).
//
// It reads the whole case list from cases.json, answers each case on its
// own with run() from solve.js (no state is shared between cases), and
// writes the answers, in the cases' order, to answers.json.
//
// Inside a container the input and output live at /input and /output; on a
// dev machine MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR point at them
// instead, so the same program runs unchanged in both places.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Keep V8's incremental marking off while solve.js runs, as the house
// baseline does: the diff's big transient arrays are cheaper to collect in
// one sweep than to mark a little at a time. This must be set before
// solve.js is imported.
setFlagsFromString('--no-incremental-marking');

/** solve.js, loaded by its URL; a .js module carries no types, so the contract is written out here. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

/** Where the cases come from and where the answers go. */
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The cases, each an {id, input} pair, in the order they must be answered. */
const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

/** One answer per case, in the cases' order. */
const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) answers[i] = run(cases[i]!.input);

writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
