import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, '_site');
const sources = [
  ['site/index.html', 'index.html'],
  ['assets/report.png', 'assets/report.png'],
  ['demo/motor-control.html', 'demo/motor-control.html'],
  ['demo/motor-control-no-inherit.html', 'demo/motor-control-no-inherit.html'],
];
const allowed = new Set(sources.map(([, target]) => target));

await rm(out, { recursive: true, force: true });
for (const [source, target] of sources) {
  const destination = join(out, target);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, source), destination);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(relative(out, full).split(sep).join('/'));
  }
  return files;
}

const files = (await walk(out)).sort();
const unexpected = files.filter((file) => !allowed.has(file));
if (unexpected.length > 0) {
  throw new Error(`Unexpected files in Pages artifact: ${unexpected.join(', ')}`);
}
const missing = [...allowed].filter((file) => !files.includes(file));
if (missing.length > 0) {
  throw new Error(`Missing files in Pages artifact: ${missing.join(', ')}`);
}
const privatePattern = /(?:^|\/)(?:hackathon|demo-script)(?:\.md)?$/i;
const privateFile = files.find((file) => privatePattern.test(file));
if (privateFile) throw new Error(`Private document in Pages artifact: ${privateFile}`);

const landing = await readFile(join(out, 'index.html'), 'utf8');
for (const token of ['docs/hackathon.md', 'docs/demo-script.md', 'hackathon.md', 'demo-script.md']) {
  if (landing.includes(token)) throw new Error(`Landing page links to private material: ${token}`);
}

console.log(`Pages artifact: ${files.length} approved files in ${out}`);
for (const file of files) console.log(`  ${file}`);
