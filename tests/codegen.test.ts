import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateQnxHarness } from '../src/codegen/qnx.js';
import { derive } from '../src/core/derive.js';
import { parseStrict, TWO_TASKS } from './helpers.js';

function generate(source = TWO_TASKS) {
  const model = parseStrict(source);
  return generateQnxHarness(model, derive(model));
}

test('emits a complete harness: workload, two platforms, build files and notes', () => {
  const harness = generate();
  const paths = harness.files.map((file) => file.path);
  for (const expected of ['workload.h', 'harness.c', 'platform.h', 'platform_posix.c', 'platform_qnx.c', 'Makefile', 'README.md']) {
    assert.ok(paths.includes(expected), 'missing ' + expected);
  }
  assert.equal(harness.unsupported.length, 0);
});

test('the workload mirrors the model task by task', () => {
  const harness = generate();
  const workload = harness.files.find((file) => file.path === 'workload.h')!.content;
  assert.match(workload, /#define SS_TASK_COUNT 2/);
  assert.match(workload, /\{ "fast", 60, SS_POLICY_FIFO, 0, 1000u/);
  assert.match(workload, /\{ "slow", 40, SS_POLICY_FIFO, 0, 5000u/);
  assert.match(workload, /#define SS_SYSTEM_NAME "two-tasks"/);
});

test('the QNX backend uses the scheduling APIs the model asks for', () => {
  const harness = generate();
  const qnx = harness.files.find((file) => file.path === 'platform_qnx.c')!.content;
  assert.match(qnx, /pthread_attr_setschedpolicy/);
  assert.match(qnx, /SCHED_FIFO/);
  assert.match(qnx, /ClockCycles/);
  assert.match(qnx, /ChannelCreate/);
  assert.match(qnx, /_NTO_CHF_FIXED_PRIORITY/);
  assert.match(qnx, /pthread_mutexattr_setprotocol/);
});

test('the POSIX backend compiles the same harness on a normal host', () => {
  const harness = generate();
  const posix = harness.files.find((file) => file.path === 'platform_posix.c')!.content;
  assert.match(posix, /pthread_create/);
  assert.match(posix, /PTHREAD_PRIO_INHERIT/);
  assert.doesNotMatch(posix, /ChannelCreate|ClockCycles/);
});

test('the Makefile uses real tabs, otherwise make refuses to run it', () => {
  const harness = generate();
  const makefile = harness.files.find((file) => file.path === 'Makefile')!.content;
  const recipeLines = makefile.split('\n').filter((line) => line.startsWith('\t'));
  assert.ok(recipeLines.length >= 5, 'expected tab-indented recipes');
  assert.doesNotMatch(makefile, /^ {4}/m, 'spaces would break make');
  assert.match(makefile, /qnx:/);
  assert.match(makefile, /qnx-arm:/);
});

test('reports segments the on-target harness cannot reproduce', () => {
  const source = TWO_TASKS.replace('      - cpu: 100us', [
    '      - cpu: 100us',
    '      - yield: true',
    '      - setPriority: 55',
  ].join('\n'));
  const harness = generate(source);
  assert.equal(harness.unsupported.length, 2);
  assert.ok(harness.unsupported.some((note) => note.includes('yield')));
});

test('honours an explicit measurement window', () => {
  const model = parseStrict(TWO_TASKS);
  const harness = generateQnxHarness(model, derive(model), { durationUs: 250_000 });
  const workload = harness.files.find((file) => file.path === 'workload.h')!.content;
  assert.match(workload, /#define SS_DURATION_US 250000/);
});

