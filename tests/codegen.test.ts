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
  for (const expected of [
    'workload.h',
    'workload_config.h',
    'harness.c',
    'platform.h',
    'platform_posix.c',
    'platform_qnx.c',
    'Makefile',
    'README.md',
    'image.build.template',
  ]) {
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
  // -Wundef is what catches an undefined SS_* macro before it silently becomes 0.
  assert.match(makefile, /-Wundef/);
  assert.match(makefile, /workload_config\.h/);
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

test('an interrupt source the harness cannot reproduce is reported, not ignored', () => {
  const source = TWO_TASKS + ['interrupts:', '  sources:', '    - name: adc', '      period: 500us', '      service: 25us', ''].join('\n');
  const harness = generate(source);
  assert.ok(
    harness.unsupported.some((note) => note.includes('adc') && note.includes('ISR')),
    'expected the interrupt source to be named as unsupported',
  );
  const config = harness.files.find((file) => file.path === 'workload_config.h')!.content;
  assert.match(config, /#define SS_HAS_INTERRUPTS 1/);
});

test('honours an explicit measurement window', () => {
  const model = parseStrict(TWO_TASKS);
  const harness = generateQnxHarness(model, derive(model), { durationUs: 250_000 });
  const workload = harness.files.find((file) => file.path === 'workload.h')!.content;
  assert.match(workload, /#define SS_DURATION_US 250000/);
});


test('the generated config publishes the highest priority so the backend can ask for the ability', () => {
  const harness = generate();
  const config = harness.files.find((file) => file.path === 'workload_config.h')!.content;
  assert.match(config, /#define SS_MAX_PRIORITY 60/);
  const workload = harness.files.find((file) => file.path === 'workload.h')!.content;
  assert.match(workload, /#include "workload_config.h"/);
  assert.doesNotMatch(workload, /#define SS_MAX_PRIORITY/);
  const qnx = harness.files.find((file) => file.path === 'platform_qnx.c')!.content;
  assert.match(qnx, /#include "workload_config.h"/);
  assert.match(qnx, /procmgr_ability/);
  assert.match(qnx, /PROCMGR_AID_PRIORITY/);
  assert.match(qnx, /SS_MAX_PRIORITY > 63/);
});

test('a QNX thread that cannot get its policy or priority stops the measurement', () => {
  const harness = generate();
  const qnx = harness.files.find((file) => file.path === 'platform_qnx.c')!.content;
  // Both attribute calls are checked, and a failure returns instead of running
  // the thread at whatever policy the OS chose.
  assert.match(qnx, /int policy_rc = pthread_attr_setschedpolicy/);
  assert.match(qnx, /int param_rc = pthread_attr_setschedparam/);
  assert.match(qnx, /the workload would not run as modelled/);
  assert.match(qnx, /pthread_attr_destroy\(&attr\);\s*\n\s*free\(args\);\s*\n\s*return -1;/);
  assert.match(qnx, /int ss_scheduling_enforced\(void\) \{ return g_scheduling_enforced; \}/);
});

test('the harness measures response from the nominal release and reports activation latency', () => {
  const harness = generate();
  const harnessC = harness.files.find((file) => file.path === 'harness.c')!.content;
  assert.match(harnessC, /record\(index, next, activation, completion, task->deadline_us\)/);
  assert.match(harnessC, /uint64_t latency = activation - nominal/);
  assert.match(harnessC, /max_activation_latency_us/);
  assert.ok(harnessC.includes('scheduling'), 'report states the scheduling status');
  assert.ok(harnessC.includes('best-effort'), 'report can say the run was not enforced');
  assert.match(harnessC, /interrupts_reproduced/);
});

test('the harness tears down what it created, in reverse order', () => {
  const harness = generate();
  const harnessC = harness.files.find((file) => file.path === 'harness.c')!.content;
  const destroyChannel = harnessC.indexOf('ss_channel_destroy(&g_channels[i])');
  const destroyMutex = harnessC.indexOf('ss_mutex_destroy(&g_mutexes[i])');
  const shutdown = harnessC.indexOf('ss_shutdown();', harnessC.indexOf('shutdown:'));
  assert.ok(destroyChannel > 0 && destroyMutex > destroyChannel, 'channels before mutexes');
  assert.ok(shutdown > destroyMutex, 'platform shutdown last');
  assert.match(harnessC, /static void stop_servers\(void\)/);
  assert.match(harnessC, /goto shutdown;/);
});

test('the harness refuses to write a report when a thread cannot be configured', () => {
  const harness = generate();
  const harnessC = harness.files.find((file) => file.path === 'harness.c')!.content;
  assert.match(harnessC, /the measurement is invalid/);
  // The failure path jumps to shutdown, which skips the JSON writer.
  assert.match(harnessC, /rc = 1;\s*\n\s*goto shutdown;/);
});

test('the image build script installs the libraries the dynamic harness needs and an in-image /tmp', () => {
  const harness = generate();
  const build = harness.files.find((file) => file.path === 'image.build.template')!.content;
  assert.match(build, /startup-x86_64/);
  assert.match(build, /procnto-smp-instr -P 63/);
  assert.match(build, /\[type=dir perms=0777\] \/tmp/);
  assert.match(build, /libc\.so/);
  assert.match(build, /libgcc_s\.so/);
  assert.match(build, /-o \/tmp\/report\.json/);
  assert.doesNotMatch(build, /startup-x86-64/);
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
  // Both thread entries, plus the server and task start-failure paths.
  assert.equal((harnessC.match(/free\(arg\);/g) ?? []).length, 4);
});
