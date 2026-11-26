/**
 * Compiles and runs the generated POSIX harness, including its failure paths.
 *
 * The QNX backend cannot be built without the SDP, but the harness logic and
 * the platform contract are the same on a Linux host. This script is run in CI
 * on a machine with gcc; it skips (rather than fails) where gcc is absent.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateQnxHarness } from '../dist/src/codegen/qnx.js';
import { derive } from '../dist/src/core/derive.js';
import { parseModel } from '../dist/src/core/parse.js';
import { validateModel } from '../dist/src/core/validate.js';

const BASE_FLAGS = ['-O1', '-g', '-Wall', '-Wextra', '-Wundef', '-Werror', '-std=c11', '-D_GNU_SOURCE'];
const gccAvailable = spawnSync('gcc', ['--version'], { stdio: 'ignore' }).status === 0;

if (!gccAvailable) {
  process.stdout.write('c-harness: SKIP (gcc not found)\n');
  process.exit(0);
}

const source = readFileSync('examples/motor-control.yaml', 'utf8');
const parsed = parseModel(source);
if (parsed.diagnostics.some((d) => d.severity === 'error')) {
  throw new Error('example model does not parse');
}
const model = parsed.model;
const errors = validateModel(model).filter((d) => d.severity === 'error');
if (errors.length > 0) {
  throw new Error('example model does not validate');
}
const generated = generateQnxHarness(model, derive(model), { durationUs: 250_000 });
const dir = mkdtempSync(join(tmpdir(), 'sched-c-'));
for (const file of generated.files) writeFileSync(join(dir, file.path), file.content);

function compile(name, macros = [], extra = []) {
  const binary = join(dir, name);
  const args = [...BASE_FLAGS, ...macros.map((m) => '-D' + m), ...extra, '-o', binary, 'harness.c', 'platform_posix.c', '-lpthread', '-lrt'];
  const result = spawnSync('gcc', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('gcc failed for ' + name + ': ' + (result.stderr ?? ''));
  return binary;
}

function run(binary, output) {
  const result = spawnSync(binary, ['-q', '-d', '250', '-o', output], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr ?? '', json: existsSync(join(dir, output)) ? JSON.parse(readFileSync(join(dir, output), 'utf8')) : null };
}

let checks = 0;
function check(condition, message) {
  checks++;
  if (!condition) throw new Error(message);
  process.stdout.write('ok ' + checks + ' - ' + message + '\n');
}

/* The normal path: a valid report and response times that include activation latency. */
const normal = run(compile('normal'), 'normal.json');
check(normal.status === 0, 'normal run exits 0');
check(normal.json !== null, 'normal run writes a report');
check(normal.json.platform === 'posix', 'report names the POSIX platform');
check(normal.json.tasks.length === model.tasks.length, 'report covers every task');
check(['enforced', 'best-effort'].includes(normal.json.scheduling), 'report states whether scheduling was enforced');
check(typeof normal.json.interrupts_reproduced === 'boolean', 'report states whether interrupts were reproduced');
for (const task of normal.json.tasks) {
  check(task.max_us >= task.max_activation_latency_us, 'response includes activation latency for ' + task.name);
}

/* A thread that cannot be configured must stop the run and leave no report behind. */
const failed = run(compile('sched-failure', ['SS_FORCE_SCHED_FAILURE']), 'failed.json');
check(failed.status === 1, 'forced scheduling failure exits 1');
check(failed.json === null, 'forced scheduling failure writes no report');
check(/injected scheduling failure/.test(failed.stderr), 'forced scheduling failure explains itself');

/* Partial initialization must be torn down, not leaked. */
const partial = run(compile('channel-failure', ['SS_FORCE_CHANNEL_FAILURE']), 'partial.json');
check(partial.status === 1, 'forced channel failure exits 1');
check(partial.json === null, 'forced channel failure writes no report');
check(/cannot create channel/.test(partial.stderr), 'partial initialization reports the failing channel');

/* The documented host fallback is reported, never silently assumed. */
const fallback = run(compile('fallback', ['SS_FORCE_SCHED_FALLBACK']), 'fallback.json');
check(fallback.status === 0, 'fallback run still completes');
check(fallback.json.scheduling === 'best-effort', 'fallback report is marked best-effort');

/* A workload with no channels or mutexes must still compile cleanly: the */
/* teardown counters only exist when their feature does. */
const sparseSource = readFileSync('examples/sporadic-sensor.yaml', 'utf8');
const sparseParsed = parseModel(sparseSource);
if (sparseParsed.diagnostics.some((d) => d.severity === 'error')) throw new Error('sporadic example does not parse');
const sparseDir = mkdtempSync(join(tmpdir(), 'sched-c-sparse-'));
for (const file of generateQnxHarness(sparseParsed.model, derive(sparseParsed.model), { durationUs: 150_000 }).files) {
  writeFileSync(join(sparseDir, file.path), file.content);
}
const sparseBinary = join(sparseDir, 'harness');
const sparseCompile = spawnSync('gcc', [...BASE_FLAGS, '-o', sparseBinary, 'harness.c', 'platform_posix.c', '-lpthread', '-lrt'], { cwd: sparseDir, encoding: 'utf8' });
check(sparseCompile.status === 0, 'a workload with no channels or mutexes compiles with -Werror: ' + (sparseCompile.stderr ?? '').slice(0, 2000));
const sparseRun = spawnSync(sparseBinary, ['-q', '-d', '150', '-o', 'sparse.json'], { cwd: sparseDir, encoding: 'utf8' });
check(sparseRun.status === 0, 'the unused-feature workload runs');

/* An aperiodic model has no deadline, so it must never be counted as a miss. */
const aperiodicSource = [
  'schema: scheduloscope/v1',
  'name: aperiodic-smoke',
  'clock: { periodUs: 1ms }',
  'cpu: { cores: 1, contextSwitchUs: 2 }',
  'tasks:',
  '  - name: worker',
  '    priority: 10',
  '    policy: fifo',
  '    meanInterarrivalUs: 2ms',
  '    segments:',
  '      - cpu: 100us',
].join('\n');
const aperiodicParsed = parseModel(aperiodicSource);
if (aperiodicParsed.diagnostics.some((d) => d.severity === 'error')) throw new Error('aperiodic model does not parse');
const aperiodicDir = mkdtempSync(join(tmpdir(), 'sched-c-aperiodic-'));
for (const file of generateQnxHarness(aperiodicParsed.model, derive(aperiodicParsed.model), { durationUs: 300_000 }).files) {
  writeFileSync(join(aperiodicDir, file.path), file.content);
}
const aperiodicBinary = join(aperiodicDir, 'harness');
const aperiodicCompile = spawnSync('gcc', [...BASE_FLAGS, '-o', aperiodicBinary, 'harness.c', 'platform_posix.c', '-lpthread', '-lrt'], { cwd: aperiodicDir, encoding: 'utf8' });
check(aperiodicCompile.status === 0, 'an aperiodic workload compiles with -Werror: ' + (aperiodicCompile.stderr ?? '').slice(0, 2000));
const aperiodicRun = spawnSync(aperiodicBinary, ['-q', '-d', '300', '-o', 'aperiodic.json'], { cwd: aperiodicDir, encoding: 'utf8' });
check(aperiodicRun.status === 0, 'the aperiodic workload runs');
const aperiodicReport = JSON.parse(readFileSync(join(aperiodicDir, 'aperiodic.json'), 'utf8'));
const aperiodicWorker = aperiodicReport.tasks[0];
check(aperiodicWorker.activations > 0, 'the aperiodic task ran at least once');
check(aperiodicWorker.misses === 0, 'an aperiodic task has no deadline and no misses');

/* Leak and undefined-behaviour check on the teardown path, when the host supports it. */
const asanFlags = ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'];
const asanBinary = join(dir, 'asan-channel-failure');
const asanCompile = spawnSync('gcc', [...BASE_FLAGS, '-DSS_FORCE_CHANNEL_FAILURE', ...asanFlags, '-o', asanBinary, 'harness.c', 'platform_posix.c', '-lpthread', '-lrt'], { cwd: dir, encoding: 'utf8' });
if (asanCompile.status !== 0) {
  process.stdout.write('c-harness: sanitizer check skipped (gcc cannot link them): ' + (asanCompile.stderr ?? '').slice(0, 500) + '\n');
} else {
  const sanitized = run(asanBinary, 'asan.json');
  check(sanitized.status === 1, 'sanitized partial-initialization run exits 1 (status ' + String(sanitized.status) + '): ' + sanitized.stderr.slice(0, 800));
  check(!/ERROR: AddressSanitizer|runtime error:/.test(sanitized.stderr), 'sanitizers report no defect during teardown');
}

process.stdout.write('c-harness: ' + checks + ' checks passed\n');
