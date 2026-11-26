import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateQnxHarness } from '../src/codegen/qnx.js';
import { derive } from '../src/core/derive.js';
import type { SystemModel } from '../src/core/model.js';
import { loadStrict, TWO_TASKS } from './helpers.js';

/*
 * The QNX backend cannot be compiled without the SDP, but its preprocessing
 * can be: -Wundef turns a generated macro the source forgot to include into a
 * hard error instead of a silent 0. The stub headers under tests/qnx-stubs
 * only satisfy the includes; this checks macros and call sites, not C types.
 */
const STUBS = join(process.cwd(), 'tests', 'qnx-stubs');
const HAS_GCC = spawnSync('gcc', ['--version'], { stdio: 'ignore' }).status === 0;

function harnessFor(model: SystemModel) {
  return generateQnxHarness(model, derive(model), { durationUs: 200_000 });
}

function preprocess(model: SystemModel, file: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sched-qnx-'));
  for (const generated of harnessFor(model).files) {
    writeFileSync(join(dir, generated.path), generated.content);
  }
  const result = spawnSync(
    'gcc',
    ['-E', '-P', '-Wundef', '-Werror', '-I', STUBS, '-I', dir, join(dir, file)],
    { encoding: 'utf8' },
  );
  assert.equal(result.error, undefined, 'gcc could not be started: ' + String(result.error));
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

test('a priority above the unprivileged ceiling asks for PROCMGR_AID_PRIORITY', { skip: !HAS_GCC }, () => {
  const motor = loadStrict(readFileSync('examples/motor-control.yaml', 'utf8'));
  assert.equal(Math.max(...motor.tasks.map((task) => task.priority)), 70);
  const run = preprocess(motor, 'platform_qnx.c');
  assert.equal(run.status, 0, run.output.slice(0, 4000));
  // Macros are expanded by -E, so look for the call site, not the flag names.
  assert.match(run.output, /procmgr_ability\(0,/);
});

test('a workload that stays under the ceiling does not request the priority ability', { skip: !HAS_GCC }, () => {
  const run = preprocess(loadStrict(TWO_TASKS), 'platform_qnx.c');
  assert.equal(run.status, 0, run.output.slice(0, 4000));
  assert.doesNotMatch(run.output, /procmgr_ability\(0,/);
});

test('the generated headers and sources preprocess without an undefined SS_ macro', { skip: !HAS_GCC }, () => {
  const motor = loadStrict(readFileSync('examples/motor-control.yaml', 'utf8'));
  for (const file of ['harness.c', 'platform_posix.c']) {
    const run = preprocess(motor, file);
    assert.equal(run.status, 0, file + ' failed to preprocess: ' + run.output.slice(0, 4000));
  }
});

test('the generated config is the only place the backend learns SS_MAX_PRIORITY', () => {
  const files = harnessFor(loadStrict(TWO_TASKS)).files;
  const config = files.find((file) => file.path === 'workload_config.h')!.content;
  assert.match(config, /#define SS_MAX_PRIORITY 60/);
  assert.match(config, /#define SS_HAS_INTERRUPTS 0/);
  const qnx = files.find((file) => file.path === 'platform_qnx.c')!.content;
  assert.match(qnx, /#include "workload_config.h"/);
  assert.doesNotMatch(qnx, /#define SS_MAX_PRIORITY/);
});
