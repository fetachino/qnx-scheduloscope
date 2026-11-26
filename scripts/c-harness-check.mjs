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
  const result = spawnSync(binary, ['-q', '-d', '250', '-o', output], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT',
    json: existsSync(join(dir, output)) ? JSON.parse(readFileSync(join(dir, output), 'utf8')) : null,
  };
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


/* ---- shutdown and startup regressions --------------------------------- */

function modelDir(source, name, durationUs = 300_000) {
  const parsed = parseModel(source);
  if (parsed.diagnostics.some((d) => d.severity === 'error')) {
    throw new Error(name + ' does not parse: ' + parsed.diagnostics.map((d) => d.code + ' ' + d.message).join('; '));
  }
  const validation = validateModel(parsed.model).filter((d) => d.severity === 'error');
  if (validation.length > 0) throw new Error(name + ' does not validate: ' + validation.map((d) => d.message).join('; '));
  const target = mkdtempSync(join(tmpdir(), 'sched-c-' + name + '-'));
  for (const file of generateQnxHarness(parsed.model, derive(parsed.model), { durationUs }).files) {
    writeFileSync(join(target, file.path), file.content);
  }
  return target;
}

function compileModel(target, name, macros = [], extra = []) {
  const binary = join(target, name);
  const result = spawnSync('gcc', [...BASE_FLAGS, ...macros.map((m) => '-D' + m), ...extra, '-o', binary, 'harness.c', 'platform_posix.c', '-lpthread', '-lrt'], { cwd: target, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('gcc failed for ' + name + ': ' + (result.stderr ?? ''));
  return binary;
}

function runModel(target, binary, output, ms, timeout = 15_000) {
  const result = spawnSync(binary, ['-q', '-d', String(ms), '-o', output], { cwd: target, encoding: 'utf8', timeout });
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT',
    json: existsSync(join(target, output)) ? JSON.parse(readFileSync(join(target, output), 'utf8')) : null,
  };
}

function chainSource(services) {
  const lines = [
    'schema: scheduloscope/v1',
    'name: rpc-chain-' + String(services),
    'cpu: { cores: 1, contextSwitchUs: 2 }',
    'channels:',
  ];
  for (let i = 0; i < services; i++) {
    lines.push('  - name: svc' + String(i));
    lines.push('    basePriority: ' + String(30 - i));
    lines.push('    handler:');
    if (i + 1 < services) lines.push('      - rpc: { channel: svc' + String(i + 1) + ' }');
    else lines.push('      - cpu: 50us');
  }
  lines.push('tasks:');
  lines.push('  - name: client');
  lines.push('    priority: 40');
  lines.push('    period: 5ms');
  lines.push('    deadline: 5ms');
  lines.push('    segments:');
  lines.push('      - rpc: { channel: svc0 }');
  return lines.join('\n');
}

for (const services of [2, 3]) {
  const target = modelDir(chainSource(services), 'chain' + String(services), 200_000);
  const binary = compileModel(target, 'chain');
  const result = runModel(target, binary, 'chain.json', 200);
  check(!result.timedOut && result.status === 0, services + '-service RPC chain stops without hanging');
  check(result.json !== null && result.json.tasks[0].completed > 0, services + '-service chain completed requests');
}

const partialServerTarget = modelDir(chainSource(2), 'partial-server', 200_000);
const partialServer = runModel(
  partialServerTarget,
  compileModel(partialServerTarget, 'partial-server', ['SS_FORCE_SERVER_FAILURE_INDEX=1']),
  'partial-server.json',
  200,
);
check(partialServer.status === 1 && !partialServer.timedOut, 'partial server startup exits 1 without hanging');
check(partialServer.json === null, 'partial server startup writes no report');
check(/injected server start failure/.test(partialServer.stderr), 'partial server startup names the failure');

const stopFailureTarget = modelDir(chainSource(2), 'stop-failure', 200_000);
const stopFailure = runModel(
  stopFailureTarget,
  compileModel(stopFailureTarget, 'stop-failure', ['SS_FORCE_STOP_FAILURE']),
  'stop-failure.json',
  200,
  10_000,
);
check(stopFailure.status === 1 && !stopFailure.timedOut, 'a failed stop request exits 1 within the join timeout');
check(stopFailure.json === null, 'a failed stop request writes no report');
check(/cannot send stop/.test(stopFailure.stderr) && /did not stop within/.test(stopFailure.stderr), 'a failed stop request reports both failures');

/* A measurement window longer than the fixed shutdown margin must not be
 * mistaken for a stuck task. */
const longSource = [
  'schema: scheduloscope/v1',
  'name: long-window',
  'tasks:',
  '  - name: worker',
  '    priority: 50',
  '    period: 10ms',
  '    deadline: 10ms',
  '    segments:',
  '      - cpu: 100us',
].join('\n');
const longTarget = modelDir(longSource, 'long-window', 2_500_000);
const longRun = runModel(longTarget, compileModel(longTarget, 'long-window'), 'long.json', 2_500, 15_000);
check(longRun.status === 0 && !longRun.timedOut, 'a window longer than the join margin still completes');
check(longRun.json !== null && longRun.json.tasks[0].completed > 0, 'the long-window run writes a report');

const joinSource = [
  'schema: scheduloscope/v1',
  'name: join-failure',
  'tasks:',
  '  - name: worker',
  '    priority: 50',
  '    period: 1ms',
  '    deadline: 1ms',
  '    segments:',
  '      - cpu: 100us',
].join('\n');
const joinFailureTarget = modelDir(joinSource, 'join-failure', 100_000);
const joinFailure = runModel(
  joinFailureTarget,
  compileModel(joinFailureTarget, 'join-failure', ['SS_FORCE_JOIN_FAILURE']),
  'join-failure.json',
  100,
);
check(joinFailure.status === 1 && !joinFailure.timedOut, 'a failed task join exits 1 without hanging');
check(joinFailure.json === null, 'a failed task join writes no report');
check(/cannot join task 0/.test(joinFailure.stderr), 'a failed task join is reported');

/* All task threads must exist before the first nominal release. The delayed
 * creation of task 1 used to let task 0 run early and skew its window. */
const startupSource = [
  'schema: scheduloscope/v1',
  'name: startup-gate',
  'cpu: { cores: 1, contextSwitchUs: 0 }',
  'tasks:',
  '  - name: first',
  '    priority: 50',
  '    period: 1ms',
  '    deadline: 1ms',
  '    segments:',
  '      - cpu: 10us',
  '  - name: second',
  '    priority: 40',
  '    period: 1ms',
  '    deadline: 1ms',
  '    segments:',
  '      - cpu: 10us',
].join('\n');
const startupTarget = modelDir(startupSource, 'startup', 300_000);
const startup = runModel(
  startupTarget,
  compileModel(startupTarget, 'startup', ['SS_TEST_TASK_CREATE_DELAY_US=200000', 'SS_TEST_TASK_CREATE_DELAY_INDEX=1']),
  'startup.json',
  300,
  15_000,
);
check(startup.status === 0 && startup.json !== null, 'the delayed startup run completes');
const first = startup.json.tasks[0];
const second = startup.json.tasks[1];
check(Math.abs(first.activations - second.activations) < 50, 'both tasks start together after the delay');
check(first.activations > 200 && second.activations > 200, 'no task lost most of its window while another was created');

const skippedSource = [
  'schema: scheduloscope/v1',
  'name: skipped-releases',
  'cpu: { cores: 1, contextSwitchUs: 0 }',
  'tasks:',
  '  - name: overrun',
  '    priority: 10',
  '    period: 1ms',
  '    deadline: 1ms',
  '    segments:',
  '      - cpu: 100us',
  '      - sleep: 5ms',
].join('\n');
const skippedTarget = modelDir(skippedSource, 'skipped', 30_000);
const skipped = runModel(skippedTarget, compileModel(skippedTarget, 'skipped'), 'skipped.json', 30);
check(skipped.status === 0 && skipped.json !== null, 'the skipping workload completes');
const skipper = skipped.json.tasks[0];
check(skipper.skipped > skipper.completed, 'each skipped nominal release is counted, not one per episode');
check(skipper.deadline_misses === skipper.misses + skipper.skipped, 'deadline_misses is late completions plus skipped releases');

const explicitDeadlineSource = [
  'schema: scheduloscope/v1',
  'name: aperiodic-deadline',
  'cpu: { cores: 1, contextSwitchUs: 0 }',
  'tasks:',
  '  - name: events',
  '    priority: 10',
  '    meanInterarrival: 10ms',
  '    deadline: 100us',
  '    segments:',
  '      - cpu: 500us',
].join('\n');
const explicitDeadlineTarget = modelDir(explicitDeadlineSource, 'explicit-deadline', 30_000);
const explicitDeadline = runModel(explicitDeadlineTarget, compileModel(explicitDeadlineTarget, 'explicit-deadline'), 'explicit.json', 30);
check(explicitDeadline.status === 0 && explicitDeadline.json !== null, 'an explicit aperiodic deadline runs');
check(explicitDeadline.json.tasks[0].misses > 0, 'an explicit aperiodic deadline is measured');

/* The normal stop path must also be clean under ASan/UBSan. */
const asanChainTarget = modelDir(chainSource(3), 'asan-chain', 100_000);
const asanChainBinary = compileModel(asanChainTarget, 'asan-chain', [], asanFlags);
const asanChain = runModel(asanChainTarget, asanChainBinary, 'asan-chain.json', 100);
check(asanChain.status === 0 && asanChain.json !== null, 'sanitized RPC chain stops cleanly (status ' + String(asanChain.status) + ', timeout ' + String(asanChain.timedOut) + '): ' + asanChain.stderr.slice(0, 2000));
check(!/ERROR: AddressSanitizer|runtime error:/.test(asanChain.stderr), 'sanitizers report no defect during RPC-chain shutdown');

process.stdout.write('c-harness: ' + checks + ' checks passed\n');
