// Fails when any tracked text file contains an em dash (U+2014). Used as a lint step.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const binary = /\.(png|wasm|onnx|ico|jpg|jpeg|gif)$/i;
const offenders = files.filter((file) => !binary.test(file) && readFileSync(file, 'utf8').includes('\u2014'));
if (offenders.length > 0) {
  console.error(`em dash found in:\n  ${offenders.join('\n  ')}`);
  process.exit(1);
}
console.log(`no em dashes in ${files.length} files`);
