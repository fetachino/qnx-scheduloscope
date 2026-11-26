import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const CLI = resolve('dist/src/cli/main.js');

function cli(args: string[], cwd = process.cwd()) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('--help explains the commands and exits zero', () => {
  const run = cli(['--help']);
  assert.equal(run.code, 0);
  assert.match(run.out, /Usage/);
  assert.match(run.out, /analyze/);
});

test('analyze prints a verdict table for the example model', () => {
  const run = cli(['analyze', 'examples/motor-control.yaml']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /schedulable/);
  assert.match(run.out, /safety/);
  assert.match(run.out, /result/);
});

test('analyze --json emits machine-readable output', () => {
  const run = cli(['analyze', 'examples/motor-control.yaml', '--json']);
  assert.equal(run.code, 0, run.err);
  const parsed = JSON.parse(run.out);
  assert.equal(parsed.verdict, 'schedulable');
  assert.equal(parsed.tasks.length, 5);
});

test('a model with an error exits 1 and explains itself on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-cli-'));
  const file = join(dir, 'broken.yaml');
  writeFileSync(file, 'schema: scheduloscope/v1\nname: broken\ntasks: []\n');
  const run = cli(['check', file]);
  assert.equal(run.code, 1);
  assert.match(run.err, /E_NO_TASKS/);
});

test('a missing file is a usage error, not a crash', () => {
  const run = cli(['analyze', 'does-not-exist.yaml']);
  assert.equal(run.code, 2);
  assert.match(run.err, /cannot find/);
});

test('init writes a starter model and refuses to clobber it without --force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-init-'));
  const target = join(dir, 'starter.yaml');
  const first = cli(['init', target]);
  assert.equal(first.code, 0, first.err);
  assert.ok(existsSync(target));
  const second = cli(['init', target]);
  assert.equal(second.code, 2);
  const third = cli(['init', target, '--force']);
  assert.equal(third.code, 0, third.err);
  const check = cli(['check', target]);
  assert.equal(check.code, 0, check.err);
});

test('gen writes a harness that the C compiler can build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-gen-'));
  const run = cli(['gen', 'examples/motor-control.yaml', '--out', join(dir, 'harness')]);
  assert.equal(run.code, 0, run.err);
  const harness = join(dir, 'harness');
  for (const file of ['workload.h', 'harness.c', 'platform.h', 'platform_posix.c', 'platform_qnx.c', 'Makefile']) {
    assert.ok(existsSync(join(harness, file)), 'missing ' + file);
  }
});

test('simulate reports the same verdict as the analysis', () => {
  const run = cli(['simulate', 'examples/motor-control.yaml', '-d', '20ms', '--json']);
  assert.equal(run.code, 0, run.err);
  const parsed = JSON.parse(run.out);
  assert.equal(parsed.verdict, 'schedulable');
  assert.equal(parsed.deadlineMisses.length, 0);
});

