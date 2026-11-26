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
| C compiler | `gcc 13` inside the official `gcc:13` container image |
| Docker | 29.9.2 |
| QNX SDP | not installed, see *The QNX gap* |

## Automated tests

```bash
npm ci
npm test        # tsc -p tsconfig.json && node --test "dist/tests/*.test.js"
```

Result: **71 tests, 71 passing, 0 failing**, about 2 seconds.

| File | Tests | Covers |
| --- | --- | --- |
| `tests/units.test.ts` | 6 | Duration parsing and formatting, gcd/lcm used for hyperperiods. |
| `tests/parse.test.ts` | 13 | Every YAML construct, aliases, unknown-key rejection, activation rules. |
| `tests/validate.test.ts` | 11 | QNX priority rules, PCP ceilings, duplicate names, ISR saturation, self-suspension. |
| `tests/rta.test.ts` | 9 | Hand-computed response times, inheritance vs no inheritance, interrupt terms, divergence. |
| `tests/sim.test.ts` | 10 | Determinism, priority order, round robin, sporadic budget, fixed-priority channels, PI and no-PI inversion, example model. |
| `tests/report.test.ts` | 6 | Summary numbers, Markdown and HTML structure, HTML escaping, diagnostics merging. |
| `tests/codegen.test.ts` | 7 | Generated C contents, real tabs in the Makefile, `_NTO_CHF_FIXED_PRIORITY`, unsupported segments. |
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
| `scheduloscope analyze examples/priority-inversion.yaml` | exit 1 | exit 1, `control` misses by 538us, caveat about unbounded blocking |
| `scheduloscope simulate examples/motor-control.yaml` | exit 0 | exit 0, 88 context switches, 1 mitigated inversion |
| `scheduloscope report ... --out demo/` | two files | HTML with inline SVG, Markdown of the same tables |
| `scheduloscope gen ... --out harness/` | 8 files | `workload.h`, `harness.c`, `platform.h`, `platform_qnx.c`, `platform_posix.c`, `Makefile`, `README.md`, `image.build.template` |
| `scheduloscope check broken.yaml` | exit 1 | exit 1 with `E_NO_TASKS` on stderr |
| `scheduloscope analyze missing.yaml` | exit 2 | exit 2, `cannot find` |

## Generated C harness

The generated harness is compiled and executed on Linux in CI and locally with the same command:

```bash
npx scheduloscope gen examples/sporadic-sensor.yaml --out /tmp/harness -d 3000ms
docker run --rm -v "$PWD:/w" -w /w/harness gcc:13 sh -c "make && ./scheduloscope-harness -d 3000 -o report.json"
```

Observed: `cc -O2 -g -Wall -Wextra -std=c11 -D_GNU_SOURCE` with **no warnings**, a clean run, and
this report:

```json
{
  "system": "sporadic-sensor",
  "duration_us": 3000186,
  "platform": "posix",
  "tasks": [
    {"name": "control", "activations": 1497, "completed": 1497, "min_us": 500, "mean_us": 508.5, "max_us": 1563, "misses": 0, "skipped": 2},
    {"name": "sensor",  "activations": 1495, "completed": 1495, "min_us": 500, "mean_us": 504.6, "max_us": 1854, "misses": 0, "skipped": 3},
    {"name": "logger",  "activations": 300,  "completed": 300,  "min_us": 400, "mean_us": 415.8, "max_us": 3330, "misses": 0, "skipped": 0}
  ]
}
```

**These are host numbers, not QNX numbers.** Inside a container the harness cannot raise its
threads to real-time priorities and prints:

```text
[scheduloscope] cannot set real-time priorities (Operation not permitted); running with default policy
```

The run proves the generated code compiles, creates its threads, mutexes and channels, executes
the modelled segments and writes a well-formed report. It does not prove anything about QNX
latency, and the numbers above should not be read as a real-time measurement.

## The QNX gap

| Item | Status | Why |
| --- | --- | --- |
| QNX-specific C backend (`platform_qnx.c`) | **written, not executed** | Needs the QNX SDP 8.0 C library and headers. |
| `Makefile` targets `qnx` (x86_64) and `qnx-arm` (aarch64le) | **not executed** | Same. |
| `image.build` for a bootable QNX image | **not executed** | `mkifs` ships with the SDP. |
| Analysis and simulation of QNX semantics | executed on the host | They are models of the OS, not the OS itself. |

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

