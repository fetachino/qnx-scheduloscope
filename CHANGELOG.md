# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and
the project adheres to Semantic Versioning.

## [1.0.1] - 2026-11-26

A QNX 8.0 API review and an independent audit of the generated harness turned up places where the
code, not the documentation, was wrong. Everything below is a correction against the official 8.0
reference pages, listed one by one in `docs/verification.md`.

### Fixed

- The validator rejected `sporadic.budget == sporadic.replenishPeriod`. QNX returns `EINVAL` only
  when the replenishment period is *shorter* than the budget, so equality is legal and is now
  accepted.
- The `maxReplenishments` diagnostic claimed a 32-entry kernel limit. QNX defines `SS_REPL_MAX` as
  65535; values above 32 are now an informational note that says so.
- The generated QNX client called `MsgSend` with a `NULL` reply buffer while the server replies.
  It now passes a 64-byte reply buffer.
- The QNX backend tested `SS_MAX_PRIORITY` without including the header that defines it, so the
  `#if` silently evaluated to 0 and the priority-ability request was never compiled in. The value
  lives in a generated `workload_config.h` now, both the workload and the QNX backend include it,
  and the Makefile builds with `-Wundef` so this class of mistake fails the build.
- `ss_thread_start` ignored the return codes of `pthread_attr_setschedpolicy` and
  `pthread_attr_setschedparam`. On QNX a failure now stops the run with the thread, priority and
  error instead of measuring a different system. The POSIX backend keeps its fallback but marks the
  report `best-effort` and says why.
- `image.build.template` named `startup-x86-64` (the binary is `startup-x86_64`), assumed a static
  build that the Makefile does not produce, and had no writable `/tmp` for the report. The template
  now copies `libc.so` and `libgcc_s.so`, creates an in-image `/tmp`, and the Makefile documents
  the dynamic link.
- Response time was measured from the moment a thread woke, hiding activation latency. It is now
  measured from the nominal release, activation latency is reported separately, and the JSON says
  exactly how response time is defined.
- Interrupt sources were omitted from the harness without a word. `gen` now reports each source,
  the harness prints a warning, and the JSON carries `model_includes_interrupts` and
  `interrupts_reproduced`. The harness still does not run ISR/IST handlers; the documentation now
  says to compare against the ISR column, not the R column.
- The harness created channels and mutexes but never destroyed them, and a partial initialization
  returned without tearing anything down. It now wakes and joins server threads, destroys channels
  then mutexes, and writes no report when a thread could not be configured.
- `ConnectDetach` was used where a channel had to be destroyed (fixed in 1.0.0's last commit, noted
  here for completeness).

### Added

- `examples/motor-control-no-inherit.yaml`: the motor-control design with one functional edit, and
  the generated reports for both variants under `demo/`.
- `docs/demo-tour.md`: six steps from a clean clone with the exact output of each.
- The generated workload publishes `SS_MAX_PRIORITY`, and the QNX backend asks for
  `PROCMGR_AID_PRIORITY` when any thread needs a priority above 63, with a clear message when the
  process is not allowed to have it.
- Nine tests: the sporadic equality rule, the replenishment note, the ability request at 70 and its
  absence at 60 (checked by preprocessing the generated QNX source with stub headers), the image
  build file, the reply buffer, interrupt reporting, the response-time definition, teardown order
  and the invalid-measurement path. CI also compiles the POSIX harness and its failure paths and
  runs the teardown under sanitizers (89 tests in total).

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

