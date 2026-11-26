# Verification

This page records what was actually executed, on what, with which command, and what was not.
Nothing on this page is projected or estimated: if a row says *not run*, the tool has never been built
with `qcc`, and the row says so.

## Environment used for the checks below

| Item | Version |
| --- | --- |
| OS | Windows 11 24H2 (x86_64) |
| Node | 24.19.0 |
| npm | 11.17.0 |
| TypeScript | 5.6.3, `strict`, `noUncheckedIndexedAccess` |
| C compiler | `gcc 13` inside the official `gcc:13` container image; Debian `gcc 12` for the preprocessing tests |
| Docker | 29.9.2 |
| QNX SDP | not installed, see *The QNX gap* |

## Automated tests

```bash
npm ci
npm test        # tsc -p tsconfig.json && node scripts/test.mjs
```

Result: **96 tests, 92 passing, 0 failing, 4 skipped**, about 3 seconds. The four skips are the QNX preprocessing tests, which need `gcc`; the same file passes in the Linux container described below (5/5).

| File | Tests | Covers |
| --- | --- | --- |
| `tests/units.test.ts` | 6 | Duration parsing and formatting, gcd/lcm used for hyperperiods. |
| `tests/parse.test.ts` | 16 | Every YAML construct, aliases, unknown-key rejection, activation rules. |
| `tests/validate.test.ts` | 14 | QNX priority rules, PCP ceilings, duplicate names, ISR saturation, self-suspension, sporadic budget and replenishment limits. |
| `tests/rta.test.ts` | 9 | Hand-computed response times, inheritance vs no inheritance, interrupt terms, divergence. |
| `tests/sim.test.ts` | 11 | Determinism, priority order, round robin, sporadic budget, fixed-priority channels, PI and no-PI inversion, example model. |
| `tests/report.test.ts` | 7 | Summary numbers, Markdown and HTML structure, HTML escaping, diagnostics merging, and an aperiodic task with no deadline rendered as `none`. |
| `tests/codegen.test.ts` | 19 | Generated C contents, real tabs in the Makefile, `-Wundef`, `_NTO_CHF_FIXED_PRIORITY`, the priority ability, PCP ceilings, the loader/link in the image build file, the start gate and stop protocol, unsupported segments, interrupt reporting, response-time definition, teardown order, no report on an invalid run. |
| `tests/qnx-backend.test.ts` | 5 | Preprocesses the generated QNX source with stub headers: `PROCMGR_AID_PRIORITY` at priority 70, at a PCP ceiling of 70, none at 60, no undefined `SS_` macro. |
| `tests/cli.test.ts` | 8 | Exit codes 0/1/2, `--json`, `gen`, `init --force`, missing file handling. |
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
`--cap-add=SYS_PTRACE` to the container. Without it, ASan can abort with repeated `AddressSanitizer:DEADLYSIGNAL`
even though the same binary passes natively, so that mode is not treated as a pass.

```bash
docker run --rm --cap-add=SYS_PTRACE -v "$PWD:/w" -w /w node:22-bookworm sh -c \
  "apt-get update -qq && apt-get install -y -qq gcc libc6-dev && node scripts/c-harness-check.mjs"
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

### Loader in `image.build.template`

QNX 8's ELF interpreter is `/usr/lib/ldqnx-64.so.2`. The loader is a separate shared object from
`libc.so` in QNX 8. The template copies the target loader to `/proc/boot/ldqnx-64.so.2` and creates
the interpreter path with:

```
[type=link] /usr/lib/ldqnx-64.so.2=/proc/boot/ldqnx-64.so.2
```

It also copies `libc.so` and `libgcc_s.so.1`. The official [shared libraries](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.building/topic/config/shared_libraries.html)
page gives the equivalent buildfile snippet `libc.so`, `libgcc_s.so.1`,
`/usr/lib/ldqnx-64.so.2=ldqnx-64.so.2`; the [system buildfile sample](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.building/topic/buildfiles/buildfile_structure.html)
uses `procmgr_symlink ../../proc/boot/ldqnx-64.so.2 /usr/lib/ldqnx-64.so.2` in its startup script.
The template was **not** run through `mkifs` in this verification pass: without the SDP its exact
output cannot be verified, so it remains labelled unbuilt. The filename and interpreter path are
the ones the QNX 8 documentation uses; the loader's `SONAME`/`DT_NEEDED` entries were not
inspected without the SDP.
On an SDP machine the remaining check is `readelf -d $QNX_TARGET/x86_64/lib/ldqnx-64.so.2`, then
`mkifs` and a boot that runs `scheduloscope-harness`.

## QNX API review against the 8.0 documentation

The QNX half of the generator was not compiled in this verification pass. Each call it makes was
reviewed against the QNX SDP 8.0 reference pages. This is a documentation review, not a build, and
it is recorded as such. Each row names the page it was checked against.

| API | What the generated code does | Verdict |
| --- | --- | --- |
| [`pthread_attr_setschedpolicy`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_attr_setschedpolicy.html) | `SCHED_FIFO`, `SCHED_RR`, `SCHED_SPORADIC` per task, with `PTHREAD_EXPLICIT_SCHED`. | Correct. The RR timeslice is left at the kernel default of four clock periods; the model assumes the same 4 ms. |
| [`sched_param`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/s/sched_param.html) | `sched_ss_init_budget`, `sched_ss_repl_period`, `sched_ss_low_priority`, `sched_ss_max_repl`. | Correct field names. `pthread_attr_setschedparam` returns `EINVAL` only when the period is *shorter* than the budget, so equality is legal; the validator was changed to accept it. |
| [`pthread_mutexattr_setprotocol`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_mutexattr_setprotocol.html) / [`pthread_mutexattr_setprioceiling`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_mutexattr_setprioceiling.html) | `PTHREAD_PRIO_INHERIT` or `PTHREAD_PRIO_PROTECT` plus `pthread_mutexattr_setprioceiling`. Every attribute call and `pthread_mutex_init` is checked, and a `protect` mutex's ceiling is read back with `pthread_mutex_getprioceiling` and compared; a failure or mismatch stops the run with the ability/PCP diagnostic instead of using a lower ceiling. | Correct, and the QNX default is `PTHREAD_PRIO_INHERIT`, which is why `protocol` defaults to `inherit` in the model. The workload's ability threshold includes `protect` ceilings, not only task priorities. |
| [`MsgSendPulse`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgsendpulse.html) / `pthread_timedjoin` | Shutdown sends a pulse with code `0x5353` at priority `-1` (inherit the sender), and joins server threads with `pthread_timedjoin`. The POSIX host uses `pthread_timedjoin_np` with an absolute `CLOCK_REALTIME` deadline. | Correct. The pulse is not a normal request: `MsgReceive` identifies it as `struct _pulse`, the server exits without running the handler or replying, and the join is bounded. |
| [`ChannelCreate`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/channelcreate.html) / [`ConnectAttach`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/connectattach.html) | One channel per modelled server, side-channel connection, `_NTO_CHF_FIXED_PRIORITY` when the model asks for it. | Correct. `_NTO_CHF_FIXED_PRIORITY` turns off message-driven inheritance, which is what the model means by `fixedPriority: true`. |
| [`MsgSend`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgsend.html) / `MsgReceive` / `MsgReply` | Client sends, server thread receives and replies. | Corrected: `MsgSend` now passes a 64-byte reply buffer, because the server does reply and a client that passes `NULL, 0` cannot receive it. |
| [`ChannelDestroy`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/channeldestroy.html) | Both error paths and the shutdown path destroy the channel. | Corrected earlier from `ConnectDetach`, which detaches the connection, not the channel. |
| [`ClockCycles`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/clockcycles.html) | Start and end timestamps, normalised with `cycles_per_sec` from `SYSPAGE_ENTRY(qtime)`. | Correct; cycle counts are the right clock for sub-microsecond jobs. |
| [`procmgr_ability`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/procmgr_ability.html) | Asks for `PROCMGR_AID_PRIORITY` when a task priority or a `protect` mutex ceiling exceeds the `SS_PRIVILEGED_CEILING` generated from the model (63 by default). | Corrected. The check read an undefined macro and was silently compiled out; it now reads `SS_MAX_PRIORITY` from the generated `workload_config.h`. Without the ability `pthread_attr_setschedparam` or `pthread_mutexattr_setprioceiling` fails, and the harness stops with an explanation. The message points to root or to granting `PROCMGR_AID_PRIORITY`, not to changing `procnto -P`. |
| [`mkifs`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/m/mkifs.html) | `image.build.template`: `[virtual=x86_64,elf]`, `startup-x86_64`, `procnto-smp-instr -P 63`, a writable `/tmp`, and a copy section with the harness, `ldqnx-64.so.2`, `libc.so` and `libgcc_s.so.1`; `[type=link] /usr/lib/ldqnx-64.so.2=/proc/boot/ldqnx-64.so.2` supplies the ELF interpreter path. | Corrected the startup name (it is `startup-x86_64`, not `startup-x86-64`), matched the QNX 8 dynamic loader and its `/usr/lib/ldqnx-64.so.2` symlink, matched the dynamic link the Makefile produces, and gave the harness a directory it can write the report to. Not built or booted in this verification pass. |

The QNX source is also preprocessed in CI against stub headers with `-Wundef -Werror`
(`tests/qnx-backend.test.ts`). That catches exactly the defect above, an `SS_` macro a source
forgot to include, and checks that the ability request appears at task priority 70, at a PCP ceiling of 70, and not at 60; a task at 20 with a ceiling of 70 is covered by the unit and codegen tests. It
does not type-check the QNX calls; that still needs `qcc`.

Two model-level facts came out of the same review. The QNX SDP 8.x priority range for application
threads is 1-253, with 254 and 255 taken by the clock and inter-processor interrupt threads, which
the validator already warns about. And `sched_ss_max_repl` must be in 1..`SS_REPL_MAX`, which QNX
defines as 65535, not the 32 an earlier draft of the validator claimed; the diagnostic is now an
informational note that says so.

## The QNX gap

| Item | Status | Why |
| --- | --- | --- |
| QNX-specific C backend (`platform_qnx.c`) | **written, not executed** | Needs the QNX SDP 8.0 C library and headers. |
| `Makefile` targets `qnx` (x86_64) and `qnx-arm` (aarch64le) | **not executed** | Same. |
| `image.build.template` for a bootable QNX image | **not executed** | `mkifs` ships with the SDP. The template is x86_64 only; `qnx-arm` builds an AArch64 executable but has no matching image template. |
| Analysis and simulation of QNX semantics | executed on the host | They are models of the OS, not the OS itself. |

### QNX SDK availability

The 8.0 toolchain (`qcc`, `mkifs`, the target libraries) ships only inside the QNX Software
Development Platform. The SDP was not available for this verification pass, so no QNX binary was
built, run, or booted.

| Path | Check | Result |
| --- | --- | --- |
| QNX Everywhere landing page | `GET https://www.qnx.com/products/everywhere/` | 200. The page offers "free access to QNX SDP 8.0 for non-commercial use" and every download link leads to `https://www.qnx.com/account/login.html`. |
| Download portal | `GET https://www.qnx.com/download/group.html?programid=29178` | 200, QNX Software Center download group, gated behind a myQNX sign-in and a licence acceptance form. No anonymous artefact URL exists. |
| QNX Everywhere sign-up | `https://qnx.software/en/developers/get-started/qnx-everywhere` | 200. Requires an account, the non-commercial licence form and approval; none of that can be completed by a build script. |
| Container image | `docker pull qnx/qnx-sdp:8.0` | `pull access denied ... repository does not exist`. QNX publishes no public SDP image; the Docker Hub hits are third-party QEMU demos, not official distributions, and were not used. |
| QEMU | host check | No QEMU installed, and a QNX boot image has to be produced by `mkifs` from an installed SDP anyway, so QEMU does not remove the blocker. |

The licence is the blocker, not the platform: the SDP runs on Windows and Linux. The QNX
Everywhere programme requires a QNX account, acceptance of the non-commercial licence, and
approval; those interactive steps were not completed for this verification pass. The QNX half of
the pipeline is therefore recorded as *build-ready*, and the review above is the strongest
statement that can be made without an SDP.

Closing the gap takes four commands on a host with the SDP installed:

```bash
source ~/qnx800/qnxsdp-env.sh
cd harness && make qnx
scp scheduloscope-harness target:/tmp/ && ssh target /tmp/scheduloscope-harness -d 5000 -o /tmp/report.json
```
The QNX SDP 8.0 is distributed through the myQNX portal, and the QNX Everywhere programme
requires an account with the licence accepted. Those steps were not completed for this
verification pass, so the QNX half of the pipeline is labelled *build-ready* rather than
*verified*. The exact commands to close the gap are in the generated `README.md`:

```bash
source ~/qnx800/qnxsdp-env.sh
make qnx && scp scheduloscope-harness target:/tmp/
ssh target /tmp/scheduloscope-harness -d 5000 -o /tmp/report.json
```

Once that runs, `platform` in the JSON becomes `qnx` and the response times become real
measurements. Until then, no QNX timing number appears anywhere in this repository.

## Reproducing all of it

```bash
git clone https://github.com/fetachino/qnx-scheduloscope.git
cd qnx-scheduloscope
npm ci
npm test
npm run demo      # writes demo/motor-control.html and .md
docker run --rm -v "$PWD:/w" gcc:13 sh -c "cd /w && npx scheduloscope gen examples/motor-control.yaml --out /w/h && cd /w/h && make && ./scheduloscope-harness -d 1000 -o report.json && cat report.json"
```