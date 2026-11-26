# Verification

This page records what was actually executed, on what, with which command, and what was not.
Nothing here is projected or estimated: if a row says *not run*, the tool has never been built
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

Result: **89 tests, 86 passing, 0 failing, 3 skipped**, about 2 seconds. The three skips are the QNX preprocessing tests, which need `gcc`; they run in CI and pass there.

| File | Tests | Covers |
| --- | --- | --- |
| `tests/units.test.ts` | 6 | Duration parsing and formatting, gcd/lcm used for hyperperiods. |
| `tests/parse.test.ts` | 15 | Every YAML construct, aliases, unknown-key rejection, activation rules. |
| `tests/validate.test.ts` | 14 | QNX priority rules, PCP ceilings, duplicate names, ISR saturation, self-suspension, sporadic budget and replenishment limits. |
| `tests/rta.test.ts` | 9 | Hand-computed response times, inheritance vs no inheritance, interrupt terms, divergence. |
| `tests/sim.test.ts` | 10 | Determinism, priority order, round robin, sporadic budget, fixed-priority channels, PI and no-PI inversion, example model. |
| `tests/report.test.ts` | 6 | Summary numbers, Markdown and HTML structure, HTML escaping, diagnostics merging. |
| `tests/codegen.test.ts` | 16 | Generated C contents, real tabs in the Makefile, `-Wundef`, `_NTO_CHF_FIXED_PRIORITY`, the priority ability, the image build file, unsupported segments, interrupt reporting, response-time definition, teardown order, no report on an invalid run. |
| `tests/qnx-backend.test.ts` | 4 | Preprocesses the generated QNX source with stub headers: `PROCMGR_AID_PRIORITY` at priority 70, none at 60, no undefined `SS_` macro. |
| `tests/cli.test.ts` | 8 | Exit codes 0/1/2, `--json`, `gen`, `init --force`, missing file handling. |
| `tests/api.test.ts` | 1 | The whole pipeline through the public entry point. |

## Scale

`npm run bench` builds task sets with about 60% utilisation and distinct priorities, then times
the analysis and a 100 ms simulation on the machine running it (Windows 11, Node 24):

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
    {"name": "control", "activations": 1483, "completed": 1483, "min_us": 540, "mean_us": 727.3, "max_us": 7939, "max_activation_latency_us": 7439, "mean_activation_latency_us": 218.1, "misses": 14, "skipped": 14},
    {"name": "sensor", "activations": 1482, "completed": 1482, "min_us": 523, "mean_us": 729.5, "max_us": 7416, "max_activation_latency_us": 6916, "mean_activation_latency_us": 219.4, "misses": 3, "skipped": 14},
    {"name": "logger", "activations": 300, "completed": 300, "min_us": 437, "mean_us": 627.4, "max_us": 2986, "max_activation_latency_us": 2586, "mean_activation_latency_us": 226.6, "misses": 0, "skipped": 0}
  ]
}
```

The misses in that run are the point of the whole exercise. Inside the container the harness cannot
raise its threads to real-time priorities, so the report says `"scheduling": "best-effort"` and a
control job is descheduled by whatever else the host is doing: one takes 7.9 ms against a 1 ms
budget, and 7.4 ms of that is activation latency before it ran at all. The same code on QNX runs
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

The same code is checked on its failure paths by `npm run check:c` (27 checks), which CI runs on every push.
With `-DSS_FORCE_SCHED_FAILURE` a thread cannot be configured: the harness must exit 1 and write no
report, rather than measure a different system. With `-DSS_FORCE_CHANNEL_FAILURE` it must fail
during partial initialization and still tear down what it created; that path is also compiled with
`-fsanitize=address,undefined` and must report no leak or memory error. These are host checks of
the C, not QNX execution.

## QNX API review against the 8.0 documentation

The QNX half of the generator could not be compiled here, so every call it makes was checked by
hand against the QNX SDP 8.0 reference pages. This is a documentation review, not a build, and it
is recorded as such. Each row names the page it was checked against.

| API | What the generated code does | Verdict |
| --- | --- | --- |
| [`pthread_attr_setschedpolicy`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_attr_setschedpolicy.html) | `SCHED_FIFO`, `SCHED_RR`, `SCHED_SPORADIC` per task, with `PTHREAD_EXPLICIT_SCHED`. | Correct. The RR timeslice is left at the kernel default of four clock periods; the model assumes the same 4 ms. |
| [`sched_param`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/s/sched_param.html) | `sched_ss_init_budget`, `sched_ss_repl_period`, `sched_ss_low_priority`, `sched_ss_max_repl`. | Correct field names. `pthread_attr_setschedparam` returns `EINVAL` only when the period is *shorter* than the budget, so equality is legal; the validator was changed to accept it. |
| [`pthread_mutexattr_setprotocol`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_mutexattr_setprotocol.html) | `PTHREAD_PRIO_INHERIT` or `PTHREAD_PRIO_PROTECT` plus `pthread_mutexattr_setprioceiling`. | Correct, and the QNX default is `PTHREAD_PRIO_INHERIT`, which is why `protocol` defaults to `inherit` in the model. |
| [`ChannelCreate`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/channelcreate.html) / [`ConnectAttach`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/connectattach.html) | One channel per modelled server, side-channel connection, `_NTO_CHF_FIXED_PRIORITY` when the model asks for it. | Correct. `_NTO_CHF_FIXED_PRIORITY` turns off message-driven inheritance, which is what the model means by `fixedPriority: true`. |
| [`MsgSend`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgsend.html) / `MsgReceive` / `MsgReply` | Client sends, server thread receives and replies. | Corrected: `MsgSend` now passes a 64-byte reply buffer, because the server does reply and a client that passes `NULL, 0` cannot receive it. |
| [`ChannelDestroy`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/channeldestroy.html) | Both error paths and the shutdown path destroy the channel. | Corrected earlier from `ConnectDetach`, which detaches the connection, not the channel. |
| [`ClockCycles`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/clockcycles.html) | Start and end timestamps, normalised with `cycles_per_sec` from `SYSPAGE_ENTRY(qtime)`. | Correct; cycle counts are the right clock for sub-microsecond jobs. |
| [`procmgr_ability`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/procmgr_ability.html) | Asks for `PROCMGR_AID_PRIORITY` when the workload needs a priority above 63. | Corrected. The check read an undefined macro and was silently compiled out; it now reads `SS_MAX_PRIORITY` from the generated `workload_config.h`. Without the ability `pthread_attr_setschedparam` fails for the safety thread at 70, and the harness now stops with an explanation instead of running at a clamped priority. |
| [`mkifs`](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/m/mkifs.html) | `image.build.template`: `[virtual=x86_64,elf]`, `startup-x86_64`, `procnto-smp-instr -P 63`, a writable `/tmp`, and a copy section with the harness plus `libc.so` and `libgcc_s.so`. | Corrected the startup name (it is `startup-x86_64`, not `startup-x86-64`), matched the dynamic link the Makefile produces, and gave the harness a directory it can write the report to. Not built or booted here. |

The QNX source is also preprocessed in CI against stub headers with `-Wundef -Werror`
(`tests/qnx-backend.test.ts`). That catches exactly the defect above, an `SS_` macro a source
forgot to include, and checks that the ability request appears at priority 70 and not at 60. It
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
| `image.build.template` for a bootable QNX image | **not executed** | `mkifs` ships with the SDP. |
| Analysis and simulation of QNX semantics | executed on the host | They are models of the OS, not the OS itself. |

### Obtaining the SDP: what was tried

The 8.0 toolchain (`qcc`, `mkifs`, the target libraries) only ships inside the QNX Software
Development Platform, so every path below was checked before concluding the build could not run
here.

| Path | Attempt | Result |
| --- | --- | --- |
| QNX Everywhere landing page | `GET https://www.qnx.com/products/everywhere/` | 200. The page offers "free access to QNX SDP 8.0 for non-commercial use" and every download link leads to `https://www.qnx.com/account/login.html`. |
| Download portal | `GET https://www.qnx.com/download/group.html?programid=29178` | 200, QNX Software Center download group, gated behind a myQNX sign-in and a licence acceptance form. No anonymous artefact URL exists. |
| QNX Everywhere sign-up | `https://qnx.software/en/developers/get-started/qnx-everywhere` | 200. Requires an account, the non-commercial licence form and approval; none of that can be completed by a build script. |
| Container image | `docker pull qnx/qnx-sdp:8.0` | `pull access denied ... repository does not exist`. QNX publishes no public SDP image; the Docker Hub hits are third-party QEMU demos, not official distributions, and were not used. |
| QEMU | host check | No QEMU installed, and a QNX boot image has to be produced by `mkifs` from an installed SDP anyway, so QEMU does not remove the blocker. |

The licence is the blocker, not the platform: the SDP runs on Windows and Linux, and this
machine has the disk space and a working GCC in Docker. What it does not have is a myQNX account
with the QNX Everywhere licence accepted, and that is deliberately not something a script can
manufacture. The QNX half of the pipeline is therefore recorded as *build-ready*, and the review
above is the strongest statement that can honestly be made about it.

Closing the gap takes four commands on a machine with the SDP installed:

```bash
source ~/qnx800/qnxsdp-env.sh
cd harness && make qnx
scp scheduloscope-harness target:/tmp/ && ssh target /tmp/scheduloscope-harness -d 5000 -o /tmp/report.json
```
The QNX SDP 8.0 is distributed through the myQNX portal and the QNX Everywhere programme
requires a licensed account to download it. That account could not be obtained for this build,
so the QNX half of the pipeline is labelled *build-ready* rather than *verified*. The exact
commands to close the gap are in the generated `README.md`:

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
