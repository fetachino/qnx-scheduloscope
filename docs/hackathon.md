# Hackathon notes

Submission notes for the **QNX Everywhere Hackathon** (QNX Global Hackathon on Devpost).
Deadline: 15 December 2026, 14:00 EST. Judging: 15-29 January 2027.

## Category

**Developer Tooling & Host Tools.** The rules explicitly allow a host-side tool that targets QNX;
the tool has to do something real for QNX developers rather than mention the platform. This one
models QNX-specific scheduling behaviour and emits a QNX 8.0 build target.

It is also a reasonable entry for **Best use of QNX-specific Technologies**, because the analysis
is built around constructs that only exist in QNX: the 256-level priority space with the
`procnto -P` ceiling, priority inheritance as the default mutex protocol, priority-protect
ceilings, message-driven priority inheritance that stays sticky after `MsgReply()`, and
`SCHED_SPORADIC` budgets.

## Compliance checklist

| Requirement | Status | Evidence |
| --- | --- | --- |
| New project, built during the submission period | yes | Initial commit is the first version of the source tree. |
| Open source | yes | Apache-2.0, `LICENSE`. |
| Public repository | yes | https://github.com/fetachino/qnx-scheduloscope |
| Targets QNX 8.0 specifically | yes | `platform_qnx.c` uses `pthread_attr_setschedpolicy`, `SCHED_SPORADIC`, `ChannelCreate`, `_NTO_CHF_FIXED_PRIORITY`, `ClockCycles`; `Makefile` targets `nto/x86_64` and `nto/aarch64le` with `qcc`; `image.build` for `mkifs`. |
| Reproducible build | yes | `npm ci && npm test`, documented in the README. |
| Automated tests | yes | 71 tests, `docs/verification.md`. |
| Documented results | yes | `docs/verification.md` separates host-verified, build-verified and not-run. |
| Demo video under 3 minutes, public | **to record** | Script and shot list in `docs/demo-script.md`. |
| Devpost submission | **not submitted** | Needs an explicit go-ahead; nothing here submits on its own. |
| Runs on real QNX hardware in the video | optional, **blocked** | The SDP 8.0 download needs a myQNX account, see `docs/verification.md`. |

## What a judge can do in sixty seconds

```bash
git clone https://github.com/fetachino/qnx-scheduloscope.git
cd qnx-scheduloscope && npm ci && npm test
npx scheduloscope analyze examples/priority-inversion.yaml
```

The third command prints a missed deadline, the term responsible for it, and the caveat that
explains why no bound exists. No QNX installation, no account, no container.

## How it maps to the judging criteria

| Criterion | What this project offers |
| --- | --- |
| Technological implementation | A parser and validator with 20 typed diagnostics, a response-time solver with QNX blocking and interrupt terms, a deterministic discrete-event simulator with priority inheritance, priority ceilings, round robin, sporadic budgets, message passing and sticky priorities, an SVG Gantt renderer, and a C code generator with two backends. 71 tests, strict TypeScript. |
| Design | One model feeds analysis, simulation and code generation, so the three cannot disagree. The CLI has stable exit codes and `--json`, the report is a single self-contained HTML file, and the generated harness compiles with `-Wall -Wextra` without warnings. |
| Potential impact | Timing bugs are the expensive class of bug in embedded systems, and the design decisions that cause them are made before any hardware exists. The tool is useful on day one of a QNX project and does not require the target. |
| Innovation and creativity | Host tools usually stop at a table of numbers. This one shows the mechanism in a schedule, then hands you the C to measure the same model on the target, which turns a design review into a closed loop. The QNX-specific parts - sticky message priority, PCP ceilings, sporadic budgets, IST priorities - are the ones generic RTA tools get wrong. |

## Honest boundaries

- No QNX binary was produced or executed here. The SDP requires a myQNX account and a licence
  acceptance that could not be completed in this environment. Every QNX claim is labelled
  *build-ready*, and `docs/verification.md` lists the commands that would turn it into a
  measurement.
- SMP, the adaptive partition scheduler and cache effects are out of scope for v1.
- The simulator is one deterministic schedule per seed, not a statistical envelope; the
  analysis, not the simulation, is what proves the bound.

## After the hackathon

1. Build the harness on a QNX 8.0 target or the QSTI QEMU image and paste the real report into
   `docs/verification.md`.
2. SMP: per-core priority queues and the blocking model that follows from it.
3. Import measured durations from the harness report back into the model, so the next analysis
   starts from numbers instead of estimates.
4. A `--watch` mode that re-runs the analysis on save, for use beside an editor.

