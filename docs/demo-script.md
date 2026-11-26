# Demo plan and video script

Target length is 2 minutes 50 seconds. The hard limit for the submission is 3 minutes and the
video has to be public on YouTube.

## Before recording

1. `npm ci && npm test` once, so the terminal is warm and `dist/` exists.
2. `npm run demo` to regenerate `demo/motor-control.html`.
3. Open the report in a browser at 1280x800, zoomed so the Gantt chart fills the width.
4. Terminal at 18 pt, dark theme, prompt short (`~/qnx-scheduloscope $`), clear screen.
5. Close notifications. Record at 1080p30; the text must stay readable after compression.

## Shot list

| Time | Screen | Narration |
| --- | --- | --- |
| 0:00 | Title card: *Scheduloscope - timing bugs, found at design time* | "On a QNX system, the hardest bugs are not logic bugs. They are timing bugs: a control loop that misses its deadline once a minute, a safety thread blocked for 900 microseconds by a logger. They never show up on a developer machine." |
| 0:15 | Terminal: `cat examples/motor-control.yaml` scrolling | "This is the whole design in one file: five threads, their priorities and periods, a mutex, a service channel, one interrupt. It is the kind of file a QNX design review already wants." |
| 0:25 | `scheduloscope analyze examples/motor-control.yaml` | "One command runs response-time analysis with QNX terms: priority inheritance, interrupt threads, context switches. Five tasks, 68 percent CPU, worst slack 361 microseconds. Schedulable - and it tells me which term is closest to the edge." |
| 0:45 | `scheduloscope report ... --out demo/` then the HTML | "The same model becomes a report. The chart is the actual simulated schedule: every context switch, every critical section, every interrupt. Here is the one priority inversion in this design - 82 microseconds, mitigated, because the logger inherited the safety thread priority." |
| 1:10 | Open `examples/priority-inversion.yaml`, run `analyze` | "Now the interesting part. Same design, one line changed: the mutex protocol is none instead of inherit. The analysis now fails: control misses by 538 microseconds, and the largest term is blocking, 900 microseconds." |
| 1:30 | Run `simulate` on the broken model, show inversion lines | "The simulation shows the mechanism, not just the verdict. The logger holds the lock, a middle-priority thread preempts it, and the safety thread waits. That is the Mars Pathfinder bug, in QNX terms, caught in a design review instead of on a rover." |
| 1:55 | Terminal: `scheduloscope gen examples/motor-control.yaml --out harness/` then `ls harness` | "The third piece closes the loop. The same model generates a C harness for QNX 8.0: threads with the real scheduling policies, mutexes with the real protocols, a real channel with server threads, and ClockCycles timestamps." |
| 2:15 | Show `platform_qnx.c` briefly, then the Makefile | "It builds with the SDP: make qnx for x86_64, make qnx-arm for aarch64le, and there is an image.build to boot it under QEMU. Run it on the target and the report is measured numbers, not a model." |
| 2:35 | Browser: GitHub repo, README, CI badge, test output | "Everything is open source, Apache 2.0. Seventy tests, a CI job that compiles the generated C with warnings as errors, and a documented boundary: the QNX half is build-ready, and the repository says exactly which commands close that gap." |
| 2:50 | Title card with repo URL | "Scheduloscope. Find the timing bug before the hardware does." |

## Spoken script (for the voice-over)

> On a QNX system the hardest bugs are not logic bugs, they are timing bugs. A control loop that
> misses its deadline once a minute. A safety thread blocked for nine hundred microseconds by a
> logger. They never reproduce on a developer machine, and by the time a tracelog shows the
> pattern, the product is on a vehicle.
>
> Scheduloscope starts from one YAML file that describes the design the way a review already
> does: threads, priorities, periods, mutexes, channels, interrupts. One command runs
> response-time analysis with QNX terms built in: priority inheritance, interrupt service
> threads, context-switch costs. Five tasks, 68 percent utilisation, worst slack 361
> microseconds, schedulable.
>
> The same model becomes a report with the actual simulated schedule. Every context switch,
> every critical section, every interrupt. Here is the only inversion in the design: 82
> microseconds, and it is mitigated, because the logger inherited the safety thread priority.
>
> Now change one line: the mutex protocol becomes none instead of inherit. The analysis fails.
> Control misses by 538 microseconds and the largest term is blocking. The simulation shows the
> mechanism: the logger holds the lock, a middle-priority thread preempts it, and the safety
> thread waits. That is the Mars Pathfinder bug in QNX terms, caught in a design review instead
> of on a rover.
>
> The third piece closes the loop. The same model generates a C harness for QNX 8.0: real
> scheduling policies, real mutex protocols, a real channel with server threads, ClockCycles
> timestamps. Make qnx for x86_64, make qnx-arm for aarch64le, and an image.build to boot it
> under QEMU.
>
> Everything is Apache 2.0, seventy tests pass, CI compiles the generated C with warnings as
> errors, and the repository is explicit about the one thing it cannot do here: without an SDP
> license the QNX half is build-ready, not verified. The exact commands to finish it are in the
> README.
>
> Scheduloscope. Find the timing bug before the hardware does.

## Fallbacks

- If the terminal font is unreadable at 1080p, record at 1440p and scale down; do not shrink
  the terminal window.
- The HTML report is self-contained, so it can be opened from a fresh clone with no server.
- If the live demo fails, the repository has the generated `demo/motor-control.html` and the
  exact outputs in this document; the video can be cut from those without changing any claim.

## What the video must not claim

No QNX timing number is shown as a measurement. The host numbers from the POSIX backend are
labelled as a build test, never as latency evidence.

