# Verification

This page records what was actually executed, on what, with which command, and what was not.
Nothing on this page is projected or estimated: if a row says *not run*, the tool has never been built
with `qcc`, and the row says so.

## Environment used for the checks below

| Item | Version |
| --- | --- |
| OS | Windows 11 Home 10.0.26300 (x86_64) |
| Node | 24.19.0 |
| npm | 11.17.0 |
| TypeScript | 5.6.3, `strict`, `noUncheckedIndexedAccess` |
| C compiler | `gcc 13` for the documented container example; Debian `gcc 12` (bookworm) for the 52-check harness and the QNX preprocessing tests |
| Docker | 29.9.2 |
| QNX SDP | 8.0.6 Stable (8.0 Build 141), installed at `D:/qnx800`; QNX GCC 12.2.0 |
| QEMU | 8.2.2 under WSL Ubuntu 24.04; QNX guest runs with `-accel tcg -cpu max` |

## Automated tests

```bash
npm ci
npm test        # tsc -p tsconfig.json && node scripts/test.mjs
```

Result: **102 tests, 98 passing, 0 failing, 4 skipped**, about 3 seconds. The four skips are the QNX preprocessing tests, which need `gcc`; the same file passes in the Linux container described below (5/5).

| File | Tests | Covers |
| --- | --- | --- |
| `tests/units.test.ts` | 6 | Duration parsing and formatting, gcd/lcm used for hyperperiods. |
| `tests/parse.test.ts` | 16 | Every YAML construct, aliases, unknown-key rejection, activation rules. |
| `tests/validate.test.ts` | 14 | QNX priority rules, PCP ceilings, duplicate names, ISR saturation, self-suspension, sporadic budget and replenishment limits. |
| `tests/rta.test.ts` | 9 | Hand-computed response times, inheritance vs no inheritance, interrupt terms, divergence. |
| `tests/sim.test.ts` | 11 | Determinism, priority order, round robin, sporadic budget, fixed-priority channels, PI and no-PI inversion, example model. |
| `tests/report.test.ts` | 10 | Summary numbers, Markdown and HTML structure, HTML escaping, diagnostics merging, accessible landmarks and table alternatives, the model boundary, term explanations, lower-bound blocking, and an aperiodic task with no deadline rendered as `none`. |
| `tests/codegen.test.ts` | 21 | Generated C contents, real tabs in the Makefile, `-Wundef`, `-D_QNX_SOURCE` on both QNX targets, `_NTO_CHF_FIXED_PRIORITY`, the priority ability, PCP ceilings, explicit `PTHREAD_PRIO_NONE`, `pthread_t` thread handles, 64-bit receive IDs, the BIOS image boot section and `/system/lib` loader/link set, the start gate and stop protocol, unsupported segments, interrupt reporting, response-time definition, teardown order, no report on an invalid run. |
| `tests/qnx-backend.test.ts` | 5 | Preprocesses the generated QNX source with stub headers: `PROCMGR_AID_PRIORITY` at priority 70, at a PCP ceiling of 70, none at 60, no undefined `SS_` macro. |
| `tests/cli.test.ts` | 9 | Exit codes 0/1/2, `--json`, `gen`, `init --force`, missing file handling, and lower-bound labels for unbounded blocking. |
| `tests/api.test.ts` | 1 | The whole pipeline through the public entry point. |

## Scale

`npm run bench` builds task sets with about 60% utilisation and distinct priorities, then times
the analysis and a 100 ms simulation on the benchmark host (Windows 11, Node 24):

| Tasks | Derive ms | Analysis ms | Simulate ms | Context switches | Verdict |
| --- | --- | --- | --- | --- | --- |
| 50 | 0.5 | 3.0 | 13.8 | 460 | schedulable |
| 100 | 0.1 | 1.6 | 13.1 | 811 | schedulable |
| 150 | 0.1 | 2.1 | 19.2 | 1091 | schedulable |
| 200 | 0.1 | 3.4 | 24.7 | 1325 | schedulable |

These are host times for the tool, not timings of the modelled system. Sets larger than 255
tasks are possible but must share priority levels; a tie is charged as interference and the
verdict turns *inconclusive* rather than claiming a bound it cannot prove.

## Determinism

Two `report` runs two seconds apart produce byte-identical HTML and Markdown apart from the
generation timestamp, and two `simulate --json` runs produce byte-identical JSON (verified by
hash). The seed only moves aperiodic arrivals; everything else is a pure function of the model.

## End-to-end CLI checks

| Command | Expected | Observed |
| --- | --- | --- |
| `scheduloscope analyze examples/motor-control.yaml` | exit 0, table | exit 0, 5 tasks, worst slack 361us |
| `scheduloscope analyze examples/motor-control-no-inherit.yaml` | exit 0, inconclusive | exit 0, same table, caveat about unbounded blocking |
| `scheduloscope analyze examples/priority-inversion.yaml` | exit 1 | exit 1, `control` misses by 538us, caveat about unbounded blocking |
| `scheduloscope simulate examples/motor-control.yaml` | exit 0 | exit 0, 88 context switches, 1 mitigated inversion |
| `scheduloscope report ... --out demo/` | two files | HTML with inline SVG, Markdown of the same tables |
| `scheduloscope gen ... --out harness/` | 9 files | `workload.h`, `workload_config.h`, `harness.c`, `platform.h`, `platform_qnx.c`, `platform_posix.c`, `Makefile`, `README.md`, `image.build.template` |
| `scheduloscope check broken.yaml` | exit 1 | exit 1 with `E_NO_TASKS` on stderr |
| `scheduloscope analyze missing.yaml` | exit 2 | exit 2, `cannot find` |

## Generated C harness

The generated harness is compiled and executed on Linux in CI and locally with the same command:

```bash
npx scheduloscope gen examples/sporadic-sensor.yaml --out /tmp/harness -d 3000ms
docker run --rm -v "$PWD:/w" -w /w/harness gcc:13 sh -c "make && ./scheduloscope-harness -d 3000 -o report.json"
```

Observed: the compiler runs with `-Wall -Wextra -Wundef -Werror` and **no warnings**, the program
runs clean, and it writes this report:

```json
{
  "system": "sporadic-sensor",
  "duration_us": 2998875,
  "platform": "posix",
  "scheduling": "best-effort",
  "response_time": "completion minus nominal release; includes activation latency, execution and blocking",
  "model_includes_interrupts": true,
  "interrupts_reproduced": false,
  "tasks": [
    {"name": "control", "activations": 1476, "completed": 1476, "min_us": 530, "mean_us": 699.0, "max_us": 14076, "max_activation_latency_us": 13575, "mean_activation_latency_us": 193.7, "misses": 12, "skipped": 24, "deadline_misses": 36},
    {"name": "sensor", "activations": 1474, "completed": 1474, "min_us": 549, "mean_us": 705.3, "max_us": 13953, "max_activation_latency_us": 8643, "mean_activation_latency_us": 187.2, "misses": 5, "skipped": 26, "deadline_misses": 31},
    {"name": "logger", "activations": 300, "completed": 300, "min_us": 461, "mean_us": 613.0, "max_us": 5432, "max_activation_latency_us": 5032, "mean_activation_latency_us": 210.7, "misses": 0, "skipped": 0, "deadline_misses": 0}
  ]
}
```

The misses in that run are the point of the whole exercise. Inside the container the harness cannot
raise its threads to real-time priorities, so the report says `"scheduling": "best-effort"` and a
control job is descheduled by whatever else the host is doing: one takes 14.1 ms against a 1 ms
budget, and 13.6 ms of that is activation latency before it ran at all. The same code on QNX runs
at priority 60 with `SCHED_FIFO`, where that interference is bounded by the priorities. A host run
measures the C, not the system, which is exactly why the JSON carries `"platform": "posix"` and
`"scheduling": "best-effort"`.

**These are host numbers, not QNX numbers.** Inside a container the harness cannot raise its
threads to real-time priorities and prints:

```text
[scheduloscope] cannot set real-time priorities (Operation not permitted); running with default policy
[scheduloscope] the host did not grant the modelled scheduling policy and priorities; the report is marked best-effort and is not a measurement of the modelled system
```

The run proves the generated code compiles, creates its threads, mutexes and channels, executes
the modelled segments, joins its server threads, destroys what it created and writes a well-formed
report. It does not prove anything about QNX latency, and the numbers above should not be read as
a real-time measurement.

`npm run check:c` now runs **52 checks** against the generated C on Linux. Besides the normal run it
covers two- and three-service RPC chains, where stopping a frontend whose stop message would have
run a handler that calls the already-stopped backend used to deadlock; partial server startup; an
injected stop-send failure; an injected join failure; a measurement window longer than the join
margin; the startup gate (task 1 created 200 ms late must not steal task 0's window); per-release
skipped counting; and an explicit aperiodic deadline. Every child process has an explicit timeout, so a reintroduced hang fails the check
instead of stalling CI.

With `-DSS_FORCE_SCHED_FAILURE` a thread cannot be configured: the harness must exit 1 and write no
report, rather than measure a different system. With `-DSS_FORCE_CHANNEL_FAILURE` it must fail
during partial initialization and still tear down what it created. The partial-initialization path
and a normal three-service RPC-chain teardown are compiled with
`-fsanitize=address,undefined`; both runs report no leak, memory error or undefined behaviour.
These are host checks of the C, not QNX execution. Under Docker's default capability set,
LeakSanitizer needs `CAP_SYS_PTRACE` to inspect the finished process; add
`--cap-add=SYS_PTRACE` to the container. On Docker Desktop, ASan can also abort with repeated
`AddressSanitizer:DEADLYSIGNAL` when the host exposes high mmap ASLR entropy; the reproducible run
below sets `vm.mmap_rnd_bits=28` in a privileged container. Without either workaround, repeated
`DEADLYSIGNAL` is not a pass.

```bash
docker run --rm --cap-add=SYS_PTRACE -v "$PWD:/w" -w /w node:22-bookworm sh -c \
  "apt-get update -qq && apt-get install -y -qq gcc libc6-dev && node scripts/c-harness-check.mjs"

# Docker Desktop only, if the command above loops on AddressSanitizer:DEADLYSIGNAL:
docker run --rm --privileged -v "$PWD:/w" -w /w node:22-bookworm sh -c \
  "apt-get update -qq && apt-get install -y -qq gcc libc6-dev && \
   sysctl -w vm.mmap_rnd_bits=28 >/dev/null && node scripts/c-harness-check.mjs"
```

### Shutdown and startup protocol

A server is blocked in receive, so a flag cannot wake it. The harness sends an explicit stop
pulse/message whose code is outside the request protocol; `ss_channel_recv` returns `1` for it and
the server exits before dispatching a handler or replying. This is what removes the deterministic
chain deadlock: stopping the frontend first can no longer leave it waiting for a backend that has
already been stopped, and a frontend that is inside a backend call finishes that call before it sees
the stop.

Task threads arrive at a gate after they exist and before timing starts. `main` waits for every
arrival, sets `g_start_us`, then releases all of them together. A gate timeout or any thread start
failure releases the gate, writes no report and tears down only what was fully created. Normal task
joins are bounded by the measurement window plus 2 s; shutdown joins use 2 s. A failed stop send or a
task/server join failure leaves channels, mutexes and the gate alive and says so, because a thread
may still be using them. `ss_shutdown()` is always the last call.

### Loader and standalone boot image

QNX 8's ELF interpreter is `/usr/lib/ldqnx-64.so.2`. The loader is a separate shared object from
`libc.so` in QNX 8. The template uses the documented x86_64 startup name `startup-x86` (the 8.0
[`startup-x86`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/s/startup-x86.html)
page lists x86_64 as its target), places the target loader, `libc.so`, `libgcc_s.so.1`, `libm.so`,
`libz.so`, `libtracelog.so.1`, `libsecpol.so.1` and `libfsnotify.so.1` under the default `mkifs`
prefix `proc/boot`, and installs real copies of the same dependency chain under `/system/lib`.

The BIOS boot section is:

```
[image=8m]
[virtual=x86_64,bios] .bootstrap = {
    startup-x86 -D8250..115200 -zz
    PATH=/proc/boot:/system/bin:/bin:/usr/bin:/sbin LD_LIBRARY_PATH=/proc/boot:/system/lib:/lib:/usr/lib
    procnto-smp-instr -P 63
}
```

`bios` is required. `[virtual=x86_64,multiboot]` and `[virtual=x86_64,elf]` retain a multiboot
header (at file offset 204 and 312 respectively in these builds), and `ipl-diskpc2-fsq6` rejects
them as `Unsupported Multi-Boot`. The BIOS image starts with a 0xF30-byte preboot header followed
by the QNX startup header. `[image=8m]` is the base address, not a size limit: it leaves room for
the 4.7 MB image while keeping the image below the loader's constraints. A 4 MB base worked for a
smaller library set, but the full `/system/lib` chain does not fit there.

The `/proc/boot` copies alone are enough for the harness, but QNX 8 privileged services
(`devc-ser8250` and `pipe`) resolve their dependency chain from the trusted `/system/lib` path.
Without the real `/system/lib/libsecpol.so.1` and `/system/lib/libfsnotify.so.1` files they print
`ldd:FATAL: Could not load library libsecpol.so.1`, the serial manager does not start, and
`/dev/ser1` is missing. A `/system/lib` symlink to `/proc/boot` is not followed by the secure
loader; the template therefore uses real files.

`.script` starts the serial driver as `devc-ser8250 &`: `devc-ser8250` is a daemon, so without
`&` the boot script would wait in the driver and never reach the harness. `pipe` daemonizes by
default and therefore needs no `&` (the [pipe utility](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/p/pipe.html)
documents `-d` as the option that *disables* daemonizing).

The standalone IFS was built with QNX SDP 8.0.6 and booted as its own partition, not through
`mkqnximage`:

```sh
mkifs -v image.build.template image.ifs          # 4,739,140 bytes, exit 0
mkqnx6fsimg boot.build boot.part                 # 11,362,304-byte boot partition
diskimage -c disk.layout -o disk-test \
  -b D:/qnx800/target/qnx/x86_64/boot/sys/ipl-diskpc1-nomsg -p -z
```

The partition buildfiles used were:

```
# boot.build
[search=D:/qnx800/target/qnx/x86_64]
[num_sectors=22192]
[+dupignore]
/.boot/qnx_sdp.ifs=./image.ifs
[+optional]

# disk.layout
[sector_size=512 cylinders=306873 sectors_per_track=1 heads=1 start_at_cylinder=1]
[partition=1 boot=true type=177 num_sectors=22192] "boot.part"
```

The disk booted in QEMU 8.2.2 with:

```sh
qemu-system-x86_64 -accel tcg -cpu max -m 512M -smp 1 -nographic \
  -boot c -drive file=disk-test,format=raw,if=ide -no-reboot
```

The loader printed `QNX v1.2d Boot Loader:`, then one dot as it loaded the IFS, then the QNX startup
banner. The serial manager opened `/dev/ser1`, the harness ran its 30 s window, and the boot script
printed the complete JSON report. This closes the standalone boot-packaging gap. KVM is not usable
for this image in the same environment: `-enable-kvm -cpu host` prints the loader dots and then
stalls before the QNX banner, so the recorded run uses TCG. That is an emulator/CPU-model limit,
not a claim about a physical board.

`/tmp` cannot be a plain directory in the IFS: `mount_ifs` mounts the image read-only by default
(see [`mount_ifs`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/m/mount_ifs.html)).
The template therefore uses `[type=link] /tmp=/dev/shmem`; QNX provides `/dev/shmem` with `procnto`
and it supports simple files, which is all the single JSON report needs. The [mkifs notes](https://qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/m/mkifs.html)
recommend `devb-ram` or `devf-ram` for a production `/tmp`, so this is explicitly a demonstration
choice, not a production storage design.

## QNX API review against the 8.0 documentation

The QNX half of the generator was compiled and run in this verification pass. Each call was also
reviewed against the QNX SDP 8.0 reference pages; each row names the page it was checked against.

| API | What the generated code does | Verdict |
| --- | --- | --- |
| [`pthread_attr_setschedpolicy`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_attr_setschedpolicy.html) | `SCHED_FIFO`, `SCHED_RR`, `SCHED_SPORADIC` per task, with `PTHREAD_EXPLICIT_SCHED`. | Correct. The RR timeslice is left at the kernel default of four clock periods; the model assumes the same 4 ms. |
| [`sched_param`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/s/sched_param.html) | `sched_ss_init_budget`, `sched_ss_repl_period`, `sched_ss_low_priority`, `sched_ss_max_repl`. | Correct field names. `pthread_attr_setschedparam` returns `EINVAL` only when the period is *shorter* than the budget, so equality is legal; the validator was changed to accept it. |
| [`pthread_mutexattr_setprotocol`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_mutexattr_setprotocol.html) / [`pthread_mutexattr_setprioceiling`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_mutexattr_setprioceiling.html) | `PTHREAD_PRIO_INHERIT` or `PTHREAD_PRIO_PROTECT` plus `pthread_mutexattr_setprioceiling`. Every attribute call and `pthread_mutex_init` is checked, and a `protect` mutex's ceiling is read back with `pthread_mutex_getprioceiling` and compared; a failure or mismatch stops the run with the ability/PCP diagnostic instead of using a lower ceiling. | Correct. The QNX default is `PTHREAD_PRIO_INHERIT`, which is why `protocol` defaults to `inherit` in the model; a `none` resource now sets `PTHREAD_PRIO_NONE` explicitly instead of inheriting that default. The workload's ability threshold includes `protect` ceilings, not only task priorities. |
| [`MsgSendPulse`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgsendpulse.html) / [`pthread_timedjoin`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_timedjoin.html) | Shutdown sends a pulse with code `0x53` at priority `-1` (inherit the sender), and joins server threads with `pthread_timedjoin`. The POSIX host uses `pthread_timedjoin_np` with an absolute `CLOCK_REALTIME` deadline. | Corrected in Phase 3: `struct _pulse.code` is `int8_t` and `MsgSendPulse` takes an 8-bit code, so the old 16-bit sentinel `0x5353` was truncated and could never match. `0x53` is in the documented positive user range and is not a service request. The pulse is not a normal request: `MsgReceive` identifies it as `struct _pulse`, the server exits without running the handler or replying, and the join is bounded. |
| [`pthread_create`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_create.html) / [`pthread_join`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_join.html) / [`pthread_timedjoin`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_timedjoin.html) | Each worker and server thread is stored in `ss_thread.handle` and joined by value. | Corrected in Phase 3: the handle is the exact `pthread_t`, not `unsigned long` plus casts. That removes an assumption about the SDK's integer width and any truncation on a target where `pthread_t` is not an `unsigned long`. |
| [`ChannelCreate`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/channelcreate.html) / [`ConnectAttach`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/connectattach.html) | One channel per modelled server, side-channel connection, `_NTO_CHF_FIXED_PRIORITY` when the model asks for it. | Correct. `_NTO_CHF_FIXED_PRIORITY` turns off message-driven inheritance, which is what the model means by `fixedPriority: true`. |
| [`MsgSend`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgsend.html) / [`MsgReceive`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgreceive.html) / [`MsgReply`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgreply.html) | Client sends, server thread receives and replies. | Corrected: `MsgSend` passes a 64-byte reply buffer, because the server does reply and a client that passes `NULL, 0` cannot receive it. Receive IDs are now `ss_client_id` (`int64_t`) end to end: the [QNX 8 migration notes](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.qnxsdp.migration/topic/kernel.html) say `rcvid_t` changed from 32-bit `int` to 64-bit signed, so the old `int` parameter would truncate a receive ID before `MsgReply`. |
| [`ChannelDestroy`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/channeldestroy.html) | Both error paths and the shutdown path destroy the channel. | Corrected earlier from `ConnectDetach`, which detaches the connection, not the channel. |
| [`ClockCycles`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/clockcycles.html) | Start and end timestamps, normalised with `cycles_per_sec` from `SYSPAGE_ENTRY(qtime)`. | Correct; cycle counts are the right clock for sub-microsecond jobs. |
| [`procmgr_ability`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/procmgr_ability.html) | Asks for `PROCMGR_AID_PRIORITY` when a task priority or a `protect` mutex ceiling exceeds the `SS_PRIVILEGED_CEILING` generated from the model (63 by default). | Corrected. The check read an undefined macro and was silently compiled out; it now reads `SS_MAX_PRIORITY` from the generated `workload_config.h`. Without the ability `pthread_attr_setschedparam` or `pthread_mutexattr_setprioceiling` fails, and the harness stops with an explanation. The message points to root or to granting `PROCMGR_AID_PRIORITY`, not to changing `procnto -P`. |
| [`mkifs`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/m/mkifs.html) | `image.build.template`: `[image=8m]`, `[virtual=x86_64,bios] .bootstrap`, `startup-x86`, `procnto-smp-instr -P 63`, `[type=link] /tmp=/dev/shmem`, the harness and its dependency chain at the default `/proc/boot` prefix, real copies at `/system/lib`, and `/usr/lib/ldqnx-64.so.2=/proc/boot/ldqnx-64.so.2` for the ELF interpreter path. The `.script` starts `devc-ser8250 &` (a daemon would otherwise block the script) and installs `devc-ser8250`, `pipe` and `cat`. | Corrected and validated in Phase 3B. `multiboot` and `elf` images carry a multiboot header that `ipl-diskpc2-fsq6` rejects; the BIOS image boots. `/system/lib` needs real files, not a symlink, or secure services cannot load `libsecpol.so.1` and the serial port never appears. Built with QNX SDP 8.0.6 (`mkifs` exit 0), packaged as a standalone QNX6 boot partition, and booted under QEMU TCG; the harness produced the JSON report in the native section below. |

Both QNX Makefile targets pass `-std=c11 -D_QNX_SOURCE`. The [qcc manual](https://qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/q/qcc.html) says `-std=` restricts the libraries to that ISO standard and hides POSIX/QNX declarations unless `_QNX_SOURCE` is defined. Without it, calls such as `pthread_timedjoin`, `pthread_setname_np` and `ChannelCreate` would be implicitly declared. This is the QNX counterpart to the host's `-D_GNU_SOURCE`, and the codegen test asserts both target lines carry it.

The QNX source is also preprocessed in CI against stub headers with `-Wundef -Werror`
(`tests/qnx-backend.test.ts`). That catches exactly the defect above, an `SS_` macro a source
forgot to include, and checks that the ability request appears at task priority 70, at a PCP ceiling of 70, and not at 60; a task at 20 with a ceiling of 70 is covered by the unit and codegen tests. It
does not type-check the QNX calls; `qcc` does that in the native build above.

Two model-level facts came out of the same review. The QNX SDP 8.x priority range for application
threads is 1-253, with 254 and 255 taken by the clock and inter-processor interrupt threads, which
the validator already warns about. And `sched_ss_max_repl` must be in 1..`SS_REPL_MAX`, which QNX
defines as 65535, not the 32 an earlier draft of the validator claimed; the diagnostic is now an
informational note that says so.

## Native QNX validation (Phase 3B)

QNX SDP 8.0.6 was installed with QNX Software Center under the QNX Everywhere non-commercial
licence. Credentials and licence values are not reproduced here. The x86_64 harness was compiled,
packaged into a standalone QNX6 boot partition, booted in QEMU, and run without a separate target
installation.

| Item | Native result |
| --- | --- |
| QNX SDP | 8.0.6 Stable (8.0 Build 141), installed at `D:/qnx800` |
| QNX compiler | GCC 12.2.0 for `gcc_ntox86_64` and `gcc_ntoaarch64le` |
| Host | Windows 11 Home 10.0.26300; WSL Ubuntu 24.04 for QEMU |
| QEMU | 8.2.2 under WSL, `-accel tcg -cpu max`, one vCPU |
| x86_64 binary | `scheduloscope-harness`, 71,760 bytes, ELF64 PIE, AMD x86-64 |
| AArch64 binary | `scheduloscope-harness-arm`, 72,720 bytes, ELF64 PIE, AArch64 |
| Native runtime | QNX 8.0.0 guest, one processor, JSON `"platform": "qnx"` |
| Standalone image | 4,739,140-byte BIOS IFS; 11,362,304-byte boot partition; 11,362,816-byte disk |

### Toolchain and ELF evidence

`qcc -V` reported:

```text
cc: targets available in D:/qnx800/host/win64/x86_64/etc/qcc:
    12.2.0,gcc_ntoaarch64le
    12.2.0,gcc_ntoaarch64le_cxx
    12.2.0,gcc_ntoaarch64le_gpp
    12.2.0,gcc_ntox86_64 (default)
    12.2.0,gcc_ntox86_64_cxx
    12.2.0,gcc_ntox86_64_gpp
```

Both targets compiled through the generated `Makefile` (`make qnx` and `make qnx-arm`) with exit 0.
The x86_64 ELF records:

```text
[Requesting program interpreter: /usr/lib/ldqnx-64.so.2]
(NEEDED) Shared library: [libc.so.6]
(NEEDED) Shared library: [libgcc_s.so.1]
```

The AArch64 ELF header reports `Class: ELF64`, `Type: DYN (Position-Independent Executable file)`
and `Machine: AArch64`.

### Native runtime

The generated harness was built and the template packaged as its own disk:

```sh
node dist/src/cli/main.js gen examples/motor-control.yaml -d 30s -o harness
cd harness
make qnx
mkifs -v image.build.template image.ifs
mkqnx6fsimg boot.build boot.part
diskimage -c disk.layout -o disk-test \
  -b D:/qnx800/target/qnx/x86_64/boot/sys/ipl-diskpc1-nomsg -p -z
```

QEMU 8.2.2 booted that disk with one vCPU under TCG:

```sh
qemu-system-x86_64 -accel tcg -cpu max -m 512M -smp 1 -nographic \
  -boot c -drive file=disk-test,format=raw,if=ide -no-reboot
```

The captured run (also saved as [`docs/qnx-native-boot.txt`](qnx-native-boot.txt)) shows the
complete native path:

```text
QNX v1.2d Boot Loader: .
non UEFI or UEFI+CSM boot
ACPI table not found (0x4746434d)
System behaves poorly without PCID support.
...
window 30.005 s, system motor-control
{
  "system": "motor-control",
  "duration_us": 30005375,
  "platform": "qnx",
  "scheduling": "enforced",
  ...
}
```

The observed rows were:

| Task | Activations | Completed | Min us | Mean us | Max us | Deadline misses + skipped |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| safety | 14993 | 14993 | 309 | 1042.5 | 3693 | 14 |
| control | 15172 | 15172 | 397 | 1447.1 | 6016 | 29513 |
| planner | 5999 | 5999 | 1028 | 2287.4 | 8819 | 2 |
| telemetry | 1500 | 1500 | 3566 | 5368.5 | 12898 | 0 |
| logger | 1694 | 1694 | 735 | 2985.1 | 13817 | 0 |

This proves the QNX backend executes and reports on QNX from the generated image itself. It is
**not** a schedulability claim: the guest has one vCPU, the workload busy-spins, and the observed
misses are a property of this QEMU run, not a board result. Interrupt sources are still not
reproduced (`"interrupts_reproduced": false`).

KVM was not usable for this guest in the same environment. `-enable-kvm -cpu max` and
`-enable-kvm -cpu host` both printed the QNX loader dots and then stalled before the QNX banner;
TCG booted the same disk. The KVM result is recorded as an emulator limitation, not evidence about
the image. The package build, partition layout and boot output are in the loader section above.

### QSTI/QEMU package

`com.qnx.qnx800.quickstart.qemu` was not installed. The QSC CLI request returned
`401 Unauthorized`, and the GUI package install needs an authenticated session. The QSTI bundle was
not needed for the x86_64 boot above because the Ubuntu QEMU 8.2.2 boots the SDP-generated
standalone disk.

The QEMU target startup was attempted separately. QSC lists `com.qnx.qnx800.target.qemuvirt`
(`0.2.1.00087T202507241124L`) and `com.qnx.qnx800.target.driver.virtio.startup`
(`0.1.0.00021T202411230047L`), but both installs failed at the package download with the same
`401 Unauthorized: Request requires authorization` error, including their `libyuv`, `virtio.devb`
and `virtio.devc` dependencies. No partial package was installed and the AArch64 `boot/sys`
directory is unchanged. No credentials or licence values are recorded here.

### AArch64 runtime gap

The AArch64 compiler and harness binary are present, but the installed SDP has no AArch64
`startup-qemu-virt` or equivalent BSP startup:

```text
target/qnx/aarch64le/boot/sys: binary.boot, binary64k.boot, elf.boot, elf64k.boot, kdumper,
libmod_contextid.a, libmod_gicv2.a, libmod_gicv3.a, procnto-smp-instr, raw.boot, raw64k.boot,
srec.boot, srec64k.boot, uefi.boot
```

Only `startup-apic` and `startup-x86` are installed for x86_64. An AArch64 `mkqnximage` attempt
failed at `output/build/ifs.build:23 Host file 'startup-qemu-virt' not available`. The QSTI
QEMU package that may supply the matching startup is behind the authenticated QSC session above.
AArch64 remains compile-only; no AArch64 QNX runtime is claimed.

### Remaining gaps

- **QSTI authentication:** the QEMU package download still requires an authenticated QSC session;
  it was not bypassed and no account data was entered.
- **AArch64 runtime:** no matching AArch64 startup/BSP is installed, so only compilation is
  validated.
- **Hardware-level timing:** no physical QNX board was available. All timing numbers come from a
  one-vCPU QEMU guest, most recently under TCG.
- **ISR/IST interference:** the harness measures threads, not interrupt handlers;
  `"interrupts_reproduced": false` is intentional.
- **KVM:** the current QNX guest hangs under KVM in this environment, so TCG is the recorded
  runtime path. This is not presented as a hardware result either way.

The earlier blockers that are now closed: QNX SDP installation, x86_64 native execution, and
standalone BIOS IFS boot packaging. The image is not merely built; it is the disk that produced
the JSON table above.


## Reproducing all of it

```bash
git clone https://github.com/fetachino/qnx-scheduloscope.git
cd qnx-scheduloscope
npm ci
npm test
npm run demo      # writes demo/motor-control.html and .md
docker run --rm -v "$PWD:/w" gcc:13 sh -c "cd /w && npx scheduloscope gen examples/motor-control.yaml --out /w/h && cd /w/h && make && ./scheduloscope-harness -d 1000 -o report.json && cat report.json"
```

Standalone QNX boot image (QNX SDP shell, then QEMU from WSL):

```sh
npx scheduloscope gen examples/motor-control.yaml -d 30s --out harness
cd harness
source ~/qnx800/qnxsdp-env.sh
make qnx
mkifs -v image.build.template image.ifs

cat > boot.build <<'EOF'
[search=${QNX_TARGET}/x86_64]
[num_sectors=22192]
[+dupignore]
/.boot/qnx_sdp.ifs=./image.ifs
[+optional]
EOF

cat > disk.layout <<'EOF'
[sector_size=512 cylinders=306873 sectors_per_track=1 heads=1 start_at_cylinder=1]
[partition=1 boot=true type=177 num_sectors=22192] "boot.part"
EOF

mkqnx6fsimg boot.build boot.part
diskimage -c disk.layout -o disk-test \
  -b "${QNX_TARGET}/x86_64/boot/sys/ipl-diskpc1-nomsg" -p -z
```

Then, from WSL:

```sh
qemu-system-x86_64 -accel tcg -cpu max -m 512M -smp 1 -nographic \
  -boot c -drive file=disk-test,format=raw,if=ide -no-reboot
```