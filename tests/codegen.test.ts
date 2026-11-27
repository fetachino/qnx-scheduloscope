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

test('an aperiodic task without a deadline emits deadline 0 and is documented that way', () => {
  const source = TWO_TASKS + ['  - name: events', '    priority: 10', '    meanInterarrival: 15ms', '    segments:', '      - cpu: 100us', ''].join('\n');
  const harness = generate(source);
  const workload = harness.files.find((file) => file.path === 'workload.h')!.content;
  assert.match(workload, /\{ "events", 10, SS_POLICY_FIFO, 2, 0u, 15000u, 0u/);
  const readme = harness.files.find((file) => file.path === 'README.md')!.content;
  assert.match(readme, /deadline 0|no deadline/i);
  const explicit = generate(source.replace('    meanInterarrival: 15ms', '    meanInterarrival: 15ms\n    deadline: 50ms'));
  const explicitWorkload = explicit.files.find((file) => file.path === 'workload.h')!.content;
  assert.match(explicitWorkload, /\{ "events", 10, SS_POLICY_FIFO, 2, 0u, 15000u, 50000u/);
});

test('a PCP ceiling above the unprivileged limit is included in SS_MAX_PRIORITY', () => {
  const source = TWO_TASKS.replace('  - name: fast\n    priority: 60', '  - name: fast\n    priority: 20')
    + ['resources:', '  - name: lock', '    protocol: protect', '    ceiling: 70', ''].join('\n');
  const harness = generate(source);
  const config = harness.files.find((file) => file.path === 'workload_config.h')!.content;
  assert.match(config, /#define SS_MAX_PRIORITY 70/);
  const qnx = harness.files.find((file) => file.path === 'platform_qnx.c')!.content;
  assert.match(qnx, /pthread_mutex_getprioceiling/);
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
  // QNX SDP 8.0 target names, checked against the qcc reference.
  assert.match(makefile, /qcc -V gcc_ntox86_64/);
  assert.match(makefile, /qcc -V gcc_ntoaarch64le/);
  // -std=c11 hides POSIX/QNX declarations unless _QNX_SOURCE is defined.
  assert.match(makefile, /qcc -V gcc_ntox86_64[^\n]*-D_QNX_SOURCE/);
  assert.match(makefile, /qcc -V gcc_ntoaarch64le[^\n]*-D_QNX_SOURCE/);
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
  assert.match(qnx, /SS_MAX_PRIORITY > SS_PRIVILEGED_CEILING/);
  // QNX defaults a mutex to priority inheritance, so "none" needs an explicit set.
  assert.match(qnx, /pthread_mutexattr_setprotocol\(&attr, PTHREAD_PRIO_NONE\)/);
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
  assert.match(harnessC, /static int stop_servers\(void\)/);
  assert.match(harnessC, /goto shutdown;/);
});

test('the harness refuses to write a report when a thread cannot be configured', () => {
  const harness = generate();
  const harnessC = harness.files.find((file) => file.path === 'harness.c')!.content;
  assert.match(harnessC, /the measurement is invalid/);
  // The failure path jumps to shutdown, which skips the JSON writer.
  assert.match(harnessC, /rc = 1;\s*\n\s*goto shutdown;/);
});

test('the image build script installs the QNX 8.0.6 loader, libraries and a writable /tmp', () => {
  const harness = generate();
  const build = harness.files.find((file) => file.path === 'image.build.template')!.content;
  // QNX 8 documents startup-x86 for x86_64; startup-x86_64 is not an 8.0 name.
  assert.match(build, /startup-x86 -D8250\.\.115200 -zz/);
  assert.doesNotMatch(build, /startup-x86_64/);
  assert.doesNotMatch(build, /startup-x86-64/);
  // ipl-diskpc2-fsq6 boots the BIOS image format. The multiboot and ELF
  // variants retain a multiboot header and are rejected as "Unsupported
  // Multi-Boot"; the BIOS image uses the `.bootstrap` section.
  assert.match(build, /\[virtual=x86_64,bios\] \.bootstrap = \{/);
  assert.doesNotMatch(build, /\[virtual=x86_64,multiboot\]/);
  assert.match(build, /\[image=8m\]/);
  assert.match(build, /procnto-smp-instr -P 63/);
  // The IFS is mounted read-only, so /tmp must resolve to the kernel's shmem.
  assert.match(build, /\[type=link\] \/tmp=\/dev\/shmem/);
  assert.doesNotMatch(build, /\[type=dir perms=0777\] \/tmp/);
  // QNX 8 removed [data=copy]; the harness is a normal file with exec perms.
  assert.match(build, /\[uid=0 gid=0 perms=0755\] scheduloscope-harness=\.\/scheduloscope-harness/);
  assert.doesNotMatch(build, /\[data=copy\]/);
  // Exact versioned files installed by SDP 8.0.6, in both target library dirs.
  assert.match(build, /\$\{QNX_TARGET\}\/x86_64\/usr\/lib\/ldqnx-64\.so\.2/);
  assert.match(build, /\$\{QNX_TARGET\}\/x86_64\/lib\/libc\.so\.6/);
  assert.match(build, /\$\{QNX_TARGET\}\/x86_64\/lib\/libgcc_s\.so\.1/);
  assert.match(build, /\$\{QNX_TARGET\}\/x86_64\/lib\/libm\.so\.3/);
  assert.match(build, /\$\{QNX_TARGET\}\/x86_64\/usr\/lib\/libz\.so\.2/);
  assert.match(build, /\$\{QNX_TARGET\}\/x86_64\/lib\/libtracelog\.so\.1/);
  assert.match(build, /\$\{QNX_TARGET\}\/x86_64\/lib\/libsecpol\.so\.1/);
  assert.match(build, /\$\{QNX_TARGET\}\/x86_64\/lib\/libfsnotify\.so\.1/);
  // Secure services resolve libraries from /system/lib, not /proc/boot.
  assert.match(build, /^\/system\/lib\/libsecpol\.so\.1=\$\{QNX_TARGET\}\/x86_64\/lib\/libsecpol\.so\.1$/m);
  assert.match(build, /^\/system\/lib\/libfsnotify\.so\.1=\$\{QNX_TARGET\}\/x86_64\/lib\/libfsnotify\.so\.1$/m);
  assert.match(build, /LD_LIBRARY_PATH=\/proc\/boot:\/system\/lib:\/lib:\/usr\/lib/);
  // mkifs expands host variables as ${NAME}, not $NAME.
  assert.doesNotMatch(build, /^\$QNX_TARGET/m);
  // Commands named by the boot script are copied into the image too.
  assert.match(build, /^toybox$/m);
  assert.match(build, /^devc-ser8250=\$\{QNX_TARGET\}\/x86_64\/sbin\/devc-ser8250$/m);
  assert.match(build, /^pipe=\$\{QNX_TARGET\}\/x86_64\/sbin\/pipe$/m);
  assert.match(build, /^\[type=link\] cat=toybox$/m);
  assert.match(build, /devc-ser8250 &/);
  assert.match(build, /reopen \/dev\/ser1/);
  assert.match(build, /cat \/tmp\/report\.json/);
  assert.match(build, /^\[type=link\] \/usr\/lib\/ldqnx-64\.so\.2=\/proc\/boot\/ldqnx-64\.so\.2$/m);
  assert.doesNotMatch(build, /\/usr\/lib\/ldqnx-64\.so\.2=ldqnx-64\.so\.2/);
  assert.match(build, /-o \/tmp\/report\.json/);
});

test('the channel send path provides a reply buffer for MsgReply', () => {
  const harness = generate(TWO_TASKS.replace('segments:', 'segments:').replace('name: fast', 'name: fast'));
  const qnx = harness.files.find((file) => file.path === 'platform_qnx.c')!.content;
  assert.match(qnx, /char reply\[64\];/);
  assert.match(qnx, /MsgSend\(impl->coid, buf, len, reply, sizeof\(reply\)\)/);
});

test('receive IDs use the 64-bit QNX 8 rcvid_t width end to end', () => {
  const harness = generate();
  const platform = harness.files.find((file) => file.path === 'platform.h')!.content;
  const qnx = harness.files.find((file) => file.path === 'platform_qnx.c')!.content;
  const harnessC = harness.files.find((file) => file.path === 'harness.c')!.content;
  assert.match(platform, /typedef int64_t ss_client_id;/);
  assert.match(harnessC, /ss_client_id client = -1;/);
  assert.match(qnx, /rcvid_t rcvid = MsgReceive\(/);
  assert.match(qnx, /\*client = \(ss_client_id\)rcvid;/);
  assert.match(qnx, /MsgReply\(\(rcvid_t\)client,/);
});

test('thread handles use pthread_t rather than an assumed integer width', () => {
  const harness = generate();
  const platform = harness.files.find((file) => file.path === 'platform.h')!.content;
  const qnx = harness.files.find((file) => file.path === 'platform_qnx.c')!.content;
  assert.match(platform, /pthread_t handle;/);
  assert.doesNotMatch(platform, /unsigned long handle/);
  assert.doesNotMatch(qnx, /\(pthread_t\)/);
});

test('the harness uses an explicit stop message and a bounded startup barrier', () => {
  const harness = generate();
  const harnessC = harness.files.find((file) => file.path === 'harness.c')!.content;
  const platform = harness.files.find((file) => file.path === 'platform.h')!.content;
  assert.match(platform, /ss_channel_send_stop/);
  assert.match(platform, /ss_thread_join_timeout/);
  assert.match(platform, /ss_gate_wait_ready/);
  assert.match(harnessC, /ss_channel_send_stop\(&g_channels\[g_server_channel\[j\]\]\)/);
  assert.doesNotMatch(harnessC, /ss_channel_send\(&g_channels\[g_server_channel\[s\]\], message, 1\)/);
  assert.match(harnessC, /ss_gate_wait_ready/);
  assert.match(harnessC, /g_start_us = ss_now_us\(\);/);
  // struct _pulse.code is int8_t: a 16-bit sentinel would be truncated by MsgSendPulse.
  const stopCode = platform.match(/#define SS_STOP_PULSE_CODE (0x[0-9a-f]+)/i);
  assert.ok(stopCode, 'the stop pulse code is defined');
  const codeText = stopCode[1];
  assert.ok(codeText, 'the stop pulse code has a value');
  const code = Number.parseInt(codeText, 16);
  assert.ok(code >= 0 && code <= 0x7f, 'the stop pulse code must fit the positive 8-bit range');
  assert.match(platform, /#define SS_JOIN_TIMEOUT 1/);
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
  // Both thread entries, plus the server, injected-server and task start-failure paths.
  assert.equal((harnessC.match(/free\(arg\);/g) ?? []).length, 5);
});