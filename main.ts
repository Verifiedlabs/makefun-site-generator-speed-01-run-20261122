import { chmodSync, closeSync, openSync, readFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

process.umask(0o022);
setFlagsFromString(
  '--no-incremental-marking --no-turbofan --no-concurrent-recompilation --no-concurrent-marking --no-concurrent-sweeping --invocation-count-for-maglev=50',
);

const { run, createJsonWriter } = await import(new URL('./solve.js', import.meta.url).href);

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(INPUT_DIR + '/cases.json', 'utf8'));
const outFile = OUTPUT_DIR + '/answers.json';
const fd = openSync(outFile, 'w', 0o644);
try {
  const writer = createJsonWriter(fd);
  writer.writeByte(91); // '['
  for (let i = 0; i < cases.length; i++) {
    if (i > 0) writer.writeByte(44); // ','
    run(cases[i].input, writer);
  }
  writer.writeByte(93); // ']'
  writer.flush();
} finally {
  closeSync(fd);
}
chmodSync(outFile, 0o644);
