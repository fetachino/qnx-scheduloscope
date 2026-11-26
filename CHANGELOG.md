# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and
the project adheres to Semantic Versioning.

## [1.0.0] - 2026-11-26

First release, built for the QNX Everywhere Hackathon.

### Added

- YAML model for a QNX 8.0 system: threads, policies, priorities, mutexes, channels, interrupt
  sources, clock and CPU parameters.
- Parser with unknown-key rejection, duration units and 20 stable diagnostic codes.
- Validator for QNX priority rules, `procnto -P` ceilings, IST priorities, PCP ceilings, ISR
  saturation, duplicate names and self-suspension.
- Response-time analysis with priority inheritance, priority-ceiling and unbounded blocking terms,
  interrupt interference, context-switch costs and a divergence check.
- Deterministic discrete-event simulator with `SCHED_FIFO`, `SCHED_RR`, `SCHED_SPORADIC`,
  priority inheritance, direct hand-off on unlock, message-driven inheritance with sticky
  priority, `_NTO_CHF_FIXED_PRIORITY` channels and interrupt threads.
- Markdown report and a self-contained HTML report with an inline SVG Gantt chart and a
  priority-inversion table.
- QNX 8.0 harness generator: `workload.h`, `harness.c`, `platform_qnx.c`, `platform_posix.c`,
  `Makefile` for `nto/x86_64` and `nto/aarch64le`, and an `image.build` template.
- CLI with `check`, `analyze`, `simulate`, `report`, `gen`, `init`, `version` and stable exit
  codes, plus `--json` output.
- 70 automated tests, GitHub Actions CI across Windows and Linux, and a job that compiles and
  runs the generated harness with `gcc -Werror`.

### Notes

- Single-core only; SMP and the adaptive partition scheduler are out of scope for 1.0.0.
- The QNX backend is build-ready but was not executed on QNX during this release; see
  `docs/verification.md`.

