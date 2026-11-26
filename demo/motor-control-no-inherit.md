# motor-control-no-inherit — scheduling report

> The motor-control design with PTHREAD_PRIO_NONE on stateLock: no priority inheritance, so a low-priority holder can be preempted while a safety thread waits. Used to show what the analysis refuses to bound and what the schedule actually does.

Generated 2026-11-26T21:27:53Z by Scheduloscope 1.0.1.

## Verdict

**inconclusive** · 5 tasks · utilization 68.8% · worst slack 361us · hyperperiod 20ms

Simulated 20ms: 37 jobs completed, 0 deadline misses, 2 priority inversions, 89 context switches.

## Task set

| Task | Policy | Priority | Period | Execution | Deadline | Shared with |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| safety | fifo | 70 | 2ms | 124us | 2ms | stateLock |
| control | fifo | 60 | 1ms | 364us | 1ms | sensorHub, stateLock |
| planner | fifo | 40 | 5ms | 684us | 5ms | i2cBus |
| telemetry | rr | 20 | 20ms | 2.504ms | 20ms | — |
| logger | fifo | 15 | 15ms | 404us | 50ms | stateLock |

## Response-time analysis

| Task | C | B | I | ISR | R | D | Slack | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| safety | 124us | 100us | 0ns | 26us | 250us | 2ms | 1.75ms | met |
| control | 364us | 100us | 124us | 51us | 639us | 1ms | 361us | met |
| planner | 684us | 0ns | 852us | 102us | 1.638ms | 5ms | 3.362ms | met |
| telemetry | 2.504ms | 0ns | 4.776ms | 408us | 7.688ms | 20ms | 12.312ms | met |
| logger | 404us | 0ns | 7.768ms | 459us | 8.631ms | 50ms | 41.369ms | n/a |

### Where the blocking comes from

- **safety** (100us)
  - logger holds "stateLock" with PTHREAD_PRIO_NONE; any thread above it can preempt it, so the wait is unbounded (lower bound 100us). — 100us
- **control** (100us)
  - logger holds "stateLock" with PTHREAD_PRIO_NONE; any thread above it can preempt it, so the wait is unbounded (lower bound 100us). — 100us

## Simulation

| Task | Activations | Completed | Unfinished | Max | Mean | Jitter | Misses |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| safety | 10 | 10 | 0 | 567us | 166.5us | 445us | 0 |
| control | 20 | 20 | 0 | 599us | 442.55us | 233us | 0 |
| planner | 4 | 4 | 0 | 1.614ms | 1.614ms | 0ns | 0 |
| telemetry | 1 | 1 | 0 | 7.678ms | 7.678ms | 0ns | 0 |
| logger | 2 | 2 | 0 | 8.551ms | 4.535ms | 8.032ms | 0 |

### Priority inversions

| Task | Blocked by | Resource | Duration | Mitigated |
| --- | --- | --- | ---: | --- |
| safety | logger | stateLock | 443us | **no** |
| control | logger | stateLock | 149us | **no** |

## Diagnostics

- **info** `I_RATE_MONOTONIC` 2 task(s) have a shorter period at a lower priority than rate-monotonic order would give them.
  - Rate-monotonic priority assignment is optimal for fixed-priority preemptive scheduling with independent periodic tasks; try it if a task misses its deadline.

## Assumptions

- Single core: one thread runs at a time and priorities are a total order.
- Durations are microseconds of pure CPU time on the target; measure them on hardware before trusting a bound.
- QNX mutexes default to PTHREAD_PRIO_INHERIT; a mutex is only unbounded when the model says protocol: none.
- A server inherits the priority of the client it is serving and keeps it after MsgReply, as QNX documents.
- Interrupt service threads preempt every application thread; the clock IST runs at 254 and the IPI IST at 255.
- Clock period 1ms, round-robin timeslice 4 ticks, context switch 2us.
- Unbounded blocking: a shared mutex has priority inheritance disabled.
- Aperiodic task: no deadline guarantee is computed.

_Response-time bounds are analytical worst cases. The simulation is one deterministic schedule of the same model; a simulated latency above its bound is a modelling bug, not a nicer number._
