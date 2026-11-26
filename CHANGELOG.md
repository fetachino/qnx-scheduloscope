# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and
the project adheres to Semantic Versioning.

## [1.0.1] - 2026-11-26

A QNX 8.0 API review turned up several places where the code, not the documentation, was wrong.
Everything below is a correction against the official 8.0 reference pages, listed one by one in
`docs/verification.md`.

### Fixed

- The validator rejected `sporadic.budget == sporadic.replenishPeriod`. QNX returns `EINVAL` only
  when the replenishment period is *shorter* than the budget, so equality is legal and is now
  accepted.
- The `maxReplenishments` diagnostic claimed a 32-entry kernel limit. QNX defines `SS_REPL_MAX` as
  65535; values above 32 are now an informational note that says so.
- The generated QNX client called `MsgSend` with a `NULL` reply buffer while the server replies.
  It now passes a 64-byte reply buffer.
- `image.build.template` named `startup-x86-64`; the binary is `startup-x86_64`. The template also
  documents that a dynamically linked harness needs `libc.so`, so `qcc -static` is the simple path.
- `ConnectDetach` was used where a channel had to be destroyed (fixed in 1.0.0's last commit, noted
  here for completeness).

### Added

- `examples/motor-control-no-inherit.yaml`: the motor-control design with one functional edit, and
  the generated reports for both variants under `demo/`.
- `docs/demo-tour.md`: six steps from a clean clone with the exact output of each.
- The generated workload publishes `SS_MAX_PRIORITY`, and the QNX backend asks for
  `PROCMGR_AID_PRIORITY` when any thread needs a priority above 63, with a clear message when the
  process is not allowed to have it.
- Six tests covering the sporadic equality rule, the replenishment note, the ability request, the
  image build file and the reply buffer (80 in total).
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
- 71 automated tests, GitHub Actions CI across Windows and Linux, and a job that compiles and
  runs the generated harness with `gcc -Werror`.

### Notes

- Single-core only; SMP and the adaptive partition scheduler are out of scope for 1.0.0.
- The QNX backend is build-ready but was not executed on QNX during this release; see
  `docs/verification.md`.

