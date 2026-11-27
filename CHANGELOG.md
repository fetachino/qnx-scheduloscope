# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and
the project adheres to Semantic Versioning.

## [Unreleased]

Phase 4 interface and demo polish. The landing page now guides a first-time reader through three
reports, names the model/hardware boundary, and links each claim to a runnable example. Generated
reports gained a verdict explanation, task cards, an RTA walkthrough, a timeline table alternative,
inversion and miss tables, a glossary, accessible landmarks and a mobile section nav. The
priority-inversion demo now describes its actual four-task workload. Unbounded blocking is labelled
as a lower bound rather than a deadline pass in both HTML and CLI output. Host suite is 103 tests
(99 passing, 4 QNX-preprocessing skips without `gcc`). No scheduler semantics changed. The report's
QNX boundary text now points to the Phase 3B native QEMU evidence instead of claiming no QNX SDP was
available. A 2:43 narrated demo is published with the site; it labels the QNX run as QEMU TCG
evidence and repeats the AArch64, QSTI and hardware-timing gaps.

Phase 3B installed QNX SDP 8.0.6 and validated the native path: `qcc` 12.2.0 built the harness for
x86_64 and AArch64; the x86_64 binary ran on a one-vCPU QNX 8.0 QEMU guest and wrote a JSON report
with `"platform": "qnx"`. The generated `image.build.template` now builds a standalone BIOS IFS
(`[image=8m]`, `[virtual=x86_64,bios] .bootstrap`) with the full trusted `/system/lib` dependency
chain; `mkqnx6fsimg` and `diskimage` turned it into its own QNX6 boot partition, and that disk was
booted under QEMU TCG and produced the report. The QSTI QEMU package stayed unavailable because its
download requires an authenticated QSC session; AArch64 remains compile-only for lack of a matching
startup/BSP, and no hardware board was available. The native run is not a hardware latency claim;
see `docs/verification.md`.

Phase 3 source and build-configuration validation against the QNX SDP 8.0 reference. No SDP was
installed, so this entry records corrections and tests only; it does not claim a native build,
image, boot or QNX timing.

### Fixed

- QNX 8 `rcvid_t` is 64-bit signed, not `int`. Receive IDs now travel as `ss_client_id`
  (`int64_t`) through both backends, so `MsgReply` cannot receive a truncated ID.
- Thread handles are stored as `pthread_t`, not `unsigned long` plus casts; this removes an
  assumed integer width from the QNX and POSIX backends.
- Both QNX Makefile targets define `_QNX_SOURCE` with `-std=c11`; without it qcc hides the POSIX
  and QNX declarations the harness uses.
- A mutex whose model protocol is `none` now sets `PTHREAD_PRIO_NONE` explicitly instead of
  inheriting QNX's default `PTHREAD_PRIO_INHERIT`.
- The stop pulse is `0x53`. `struct _pulse.code` is 8-bit, so the 1.0.2 sentinel `0x5353` was
  truncated and could never match.
- `image.build.template` now uses `[image=8m]`, `[virtual=x86_64,bios] .bootstrap`,
  `startup-x86`, `${QNX_TARGET}` paths, bare `mkifs` entries, `[type=link] /tmp=/dev/shmem`, the
  loader plus the versioned `libc`, `libgcc_s`, `libm`, `libz`, `libtracelog`, `libsecpol` and
  `libfsnotify` files, and the official `/usr/lib/ldqnx-64.so.2=ldqnx-64.so.2` interpreter link.
  Real copies under `/system/lib` let privileged services such as `devc-ser8250` load
  `libsecpol.so.1`, so `/dev/ser1` opens. The BIOS image replaced the multiboot image, whose header
  the QNX partition loader rejects as `Unsupported Multi-Boot`. The boot script starts
  `devc-ser8250 &` and installs `pipe` and `cat`.

### Changed

- Host test suite is 103 tests (99 passing, 4 QNX-preprocessing skips without `gcc`); the
  preprocessing tests pass 5/5 in the Linux container and `npm run check:c` passes 52 checks.

## [1.0.2] - 2026-11-26

A second critical-defect pass on the generated harness, the analysis semantics and the QNX image
template. No QNX SDP was available, so QNX claims remain source/preprocessing review, not execution.

### Fixed

- The RPC-chain shutdown deadlock. Servers used a normal request as a wake-up, which could run a
  handler that called another server after that server had stopped. Shutdown now sends a distinct
  pulse/message (`0x5353`), `ss_channel_recv` reports it separately, and the server exits without
  dispatching a handler or replying. Stop sends and joins are checked and bounded; if either fails,
  channels, mutexes and the gate are deliberately not destroyed while a thread might still use them.
- A start barrier: every task thread is created and arrives before timing starts, and one common
  release sets `g_start_us`. A failure releases the gate and aborts without a report.
- `image.build.template` now installs the QNX 8 loader `ldqnx-64.so.2` in `/proc/boot`, adds the
  `/usr/lib/ldqnx-64.so.2` symlink the ELF interpreter needs, and copies `libgcc_s.so.1` (the old
  template copied `libgcc_s.so`).
- An aperiodic task with no explicit deadline now generates `deadlineUs = 0`; the harness and the
  simulator do not count a miss against 0. An explicit positive aperiodic deadline is preserved and measured, but an
  explicit zero is rejected instead of silently meaning none; response-time analysis still makes no
  arrival-rate guarantee. Reports show `none` instead of
  `0us`, and do not include a deadline-less task in the headline worst slack.
- PCP ceilings now participate in the `PROCMGR_AID_PRIORITY` threshold. The QNX backend checks
  `pthread_mutexattr_init`, `setprotocol`, `setprioceiling` and `pthread_mutex_init`, and fails
  with an accurate ability/PCP diagnostic instead of running with a silently lower ceiling.
- Skipped nominal releases are counted individually (`skipped`), not once per starvation episode.
  The console and JSON expose started/completed/skipped/late, and `deadline_misses` is
  `misses + skipped`; both are documented.
- A normal task join is bounded by the measurement window plus a margin, so a long `-d` run is not
  mistaken for a stuck thread. Shutdown still uses the short margin.
- The QNX ability comment no longer claims the priority is clamped; the run aborts. The hint no
  longer suggests changing `procnto -P`, which would not grant `PROCMGR_AID_PRIORITY`. POSIX channel mutex/condition-variable
  initialization is checked and unwinds partial initialization; mutex attributes are destroyed on
  every path; server/task join results are checked before any destruction.
- `qnx-arm` is documented as an AArch64 executable build only: the image template is x86_64 and has
  no matching AArch64 startup/driver lines.

### Added

- Regression coverage for the two- and three-service RPC chains, partial server startup, forced
  stop-send failure, forced join failure, the delayed-start barrier, individual skipped releases, an
  explicit aperiodic deadline, long measurement windows, and sanitized RPC-chain teardown.
- `npm run check:c` now runs 52 checks with explicit child-process timeouts; `npm test` is 96 tests
  (92 passing, 4 QNX preprocessing tests skipped without `gcc`; 5/5 pass in the Linux container).

## [1.0.1] - 2026-11-26

A QNX 8.0 API review and a follow-up review of the generated harness found places where the
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
