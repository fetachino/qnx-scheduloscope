# Performance and reliability

This page records the Phase 5 checks: host-side scaling, repeated QNX boots, and the
failure paths that were exercised. It is deliberately separate from a schedulability claim.
Wall-clock numbers from a laptop and one-vCPU QEMU guests describe the tool and the test
environment, not a physical target.

## Host benchmark

`npm run bench` builds synthetic task sets at increasing sizes, then times `derive`,
`analyzeResponseTimes`, and a 100 ms simulation. The benchmark now covers 50 to 800 tasks
and can emit JSON with `node dist/bench/run.js --json`.

Environment: Windows 11, Intel Core i7-13700F, Node 24.19.0, npm 11.17.0. The package
supports Node 20 and CI covers Node 20 and 22; this table is one host, not a portable SLA.

| Tasks | Derive ms | Analysis ms | Simulate ms | Context switches | Verdict |
| ---: | ---: | ---: | ---: | ---: | --- |
| 50 | 1.1 | 5.0 | 15.1 | 460 | schedulable |
| 100 | 0.1 | 1.7 | 15.4 | 811 | schedulable |
| 200 | 0.2 | 4.4 | 26.0 | 1,325 | schedulable |
| 400 | 0.2 | 7.4 | 127.1 | 2,071 | schedulable |
| 800 | 0.3 | 26.5 | 229.0 | 3,059 | schedulable |

Values are the median of three runs; the first run includes JIT and cache warm-up noise.
Analysis stays under 30 ms at 800 tasks. Simulation is the scaling limit: 26 ms at 200
tasks, 127 ms at 400, and 229 ms at 800 for the same 100 ms window. That is expected: the
event queue and per-task bookkeeping grow with both task count and releases. It is a useful
design-time budget, not a reason to weaken the simulator.

Reproduce:

```sh
npm run build
node dist/bench/run.js
node dist/bench/run.js --json   # machine-readable rows
```

## QNX boot stress

The same standalone x86_64 QNX6 disk was booted four times with `scripts/qnx-stress.sh`:
three KVM runs and one TCG comparison. Each run used one vCPU, 512 MB, the same 30 s
workload, and the QNX 8.0.6-built harness. The script extracts the JSON report, validates
`platform: qnx` and `scheduling: enforced`, and writes a summary. The combined machine-readable
record is [`qnx-stress.json`](qnx-stress.json). QEMU is stopped after the
report is printed, so exit 124 from `timeout` is expected.

| Run | Accelerator | CPU | duration_us | Deadline misses | Max response us | Wall cap |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| KVM 1 | `-accel kvm` | `-cpu host` | 30,000,331 | 22,640 | 8,146 | 50 s |
| KVM 2 | `-accel kvm` | `-cpu host` | 29,999,500 | 20,993 | 8,147 | 50 s |
| KVM 3 | `-accel kvm` | `-cpu host` | 29,999,481 | 22,402 | 8,269 | 50 s |
| TCG 1 | `-accel tcg` | `-cpu max` | 30,006,620 | 29,350 | 17,802 | 55 s |

All four reports had five tasks and the expected platform/scheduling fields. The KVM runs
were stable across three boots: duration stayed within 0.9 ms and total deadline misses
ranged from 20,993 to 22,640. KVM reduced the worst response time by about half and the miss
count by about a quarter compared with TCG in this one comparison, which is consistent with removing emulation
overhead, but it does not make the workload schedulable.

Per-task worst response (us):

| Task | KVM range | TCG |
| --- | ---: | ---: |
| safety | 1,772-1,952 | 2,849 |
| control | 2,255-3,454 | 5,838 |
| planner | 3,144-3,448 | 8,666 |
| telemetry | 6,559-8,146 | 12,911 |
| logger | 7,757-8,269 | 17,802 |

Control is the overloaded task: it has a 1 ms deadline, a 30 s window, and thousands of
releases. The KVM and TCG misses are a property of this one-vCPU emulated workload. The
result is **runtime reliability** - the same disk boots, schedules, runs, and writes a
complete report repeatedly - not evidence that the design meets its deadlines on hardware.

Reproduce from the repository root on Linux/WSL with QEMU installed and the disk already
built:

```sh
scripts/qnx-stress.sh --accel kvm --cpu host --runs 3 --timeout 50 --out .tmp/qnx-stress/kvm
scripts/qnx-stress.sh --accel tcg --cpu max --runs 1 --timeout 55 --out .tmp/qnx-stress/tcg
```

The script requires Python 3, QEMU, and an existing `disk-test`; it does not build the SDP
image. See [verification.md](verification.md) for the build and boot commands.

## Reliability work in this pass

- `report` preflights both parent directories before writing either file. The CLI suite now
  locks that behaviour down: a blocked output path exits 1 without leaving a half-written
  HTML/Markdown pair.
- CLI tests now cover blocked report paths and unparseable simulation durations alongside the
  existing missing-file, invalid-model, init-clobber, and generation checks.
- The generated POSIX harness still exercises forced scheduling failure, partial channel
  startup, scheduling fallback, RPC chains, failed stop/join, and sanitizer teardown in
  `scripts/c-harness-check.mjs`. CI runs that path with `gcc` and sanitizers.
- Full host suite after this pass: **106 tests, 102 pass, 4 QNX-preprocessing skips** without
  a host `gcc`. The Linux CI job runs the 4 QNX preprocessing tests with the container
  toolchain.

## Boundaries

- No physical QNX board was available. Every timing number here is from QEMU.
- KVM is acceleration for an emulated guest, not native hardware. AArch64 is still TCG.
- ISR/IST handlers are not reproduced; the harness prints a warning and writes
  `"interrupts_reproduced": false`.
- The QSTI package still requires an authenticated QSC session; it was not bypassed.
- Benchmark results are wall-clock on this host and will vary. They are not a CI threshold.
