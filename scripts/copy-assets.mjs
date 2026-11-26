import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const folder of ['src/codegen/templates', 'src/cli/templates']) {
  const to = resolve(root, 'dist', folder);
  mkdirSync(to, { recursive: true });
  cpSync(resolve(root, folder), to, { recursive: true });
}
