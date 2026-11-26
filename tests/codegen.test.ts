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


test('the workload publishes the highest priority so the backend can ask for the ability', () => {
  const harness = generate();
  const workload = harness.files.find((file) => file.path === 'workload.h')!.content;
  assert.match(workload, /#define SS_MAX_PRIORITY 60/);
  const qnx = harness.files.find((file) => file.path === 'platform_qnx.c')!.content;
  assert.match(qnx, /procmgr_ability/);
  assert.match(qnx, /PROCMGR_AID_PRIORITY/);
  assert.match(qnx, /SS_MAX_PRIORITY > 63/);
});

test('the image build file names the x86_64 startup and warns about static linking', () => {
  const harness = generate();
  const build = harness.files.find((file) => file.path === 'image.build.template')!.content;
  assert.match(build, /startup-x86_64/);
  assert.match(build, /qcc -static/);
  assert.match(build, /procnto-smp-instr/);
});

test('the channel send path provides a reply buffer for MsgReply', () => {
  const harness = generate(TWO_TASKS.replace('segments:', 'segments:').replace('name: fast', 'name: fast'));
  const qnx = harness.files.find((file) => file.path === 'platform_qnx.c')!.content;
  assert.match(qnx, /char reply\[64\];/);
  assert.match(qnx, /MsgSend\(impl->coid, buf, len, reply, sizeof\(reply\)\)/);
});

test('the QNX backend releases channels, mutexes and thread arguments', () => {
  const harness = generate();
  const qnx = harness.files.find((file) => file.path === 'platform_qnx.c')!.content;
  // The connect failure path must not leak the channel, and destroy must undo both objects.
  assert.match(qnx, /ConnectAttach\(0, 0, impl->chid, _NTO_SIDE_CHANNEL, 0\)/);
  assert.match(qnx, /ChannelDestroy\(impl->chid\);\s*\n\s*free\(impl\);/);
  assert.match(qnx, /ConnectDetach\(impl->coid\);\s*\n\s*ChannelDestroy\(impl->chid\);\s*\n\s*free\(impl\);/);
  assert.match(qnx, /free\(args\);/);
  const harnessC = harness.files.find((file) => file.path === 'harness.c')!.content;
  // The trampoline owns its copy of the start arguments, so it frees them exactly once.
  assert.equal((harnessC.match(/free\(arg\);/g) ?? []).length, 2);
});
