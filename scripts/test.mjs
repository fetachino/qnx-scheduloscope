/**
 * Run the compiled test suite.
 *
 * `node --test` only learned to expand glob patterns in Node 21, and the
 * package still supports Node 20, so the file list is built here instead.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../dist/tests/', import.meta.url));
let entries;
try {
  entries = readdirSync(directory);
} catch {
  console.error('dist/tests is missing; run npm run build first');
  process.exit(1);
}

const files = entries
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(directory, name));

if (files.length === 0) {
  console.error('no compiled tests found in ' + directory);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
