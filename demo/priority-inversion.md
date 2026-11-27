# motor-control-no-inheritance — scheduling report

> A deliberately broken four-task variant. Telemetry and the sensor channel are omitted, the logger runs periodically, and its 900us stateLock critical section disables priority inheritance. Control can be delayed by the logger while a middle-priority thread runs, which is unbounded priority inversion.

Generated 2026-11-27T01:07:21Z by Scheduloscope 1.0.2.

## Verdict

**unschedulable** · 4 tasks · utilization 67.7% · worst slack -538us · hyperperiod 30ms

Simulated 30ms: 51 jobs completed, 5 deadline misses, 4 priority inversions, 116 context switches.

## Task set

| Task | Policy | Priority | Period | Execution | Deadline | Shared with |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| safety | fifo | 70 | 2ms | 164us | 2ms | stateLock |
| control | fifo | 60 | 1ms | 374us | 1ms | sensorHub, stateLock |
| logger | fifo | 15 | 15ms | 1.204ms | 50ms | stateLock |
| planner | fifo | 40 | 5ms | 704us | 5ms | — |

## Response-time analysis

| Task | C | B | I | ISR | R | D | Slack | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| safety | 164us | 900us | 0ns | 76us | 1.14ms | 2ms | 860us | lower bound |
| control | 374us | 900us | 164us | 100us | 1.538ms | 1ms | -538us | missed |
| logger | 1.204ms | 0ns | 2.528ms | 200us | 3.932ms | 50ms | 46.068ms | met |
| planner | 704us | 0ns | 912us | 100us | 1.716ms | 5ms | 3.284ms | met |

_A "lower bound" result treats a mutex with inheritance disabled as a finite lower bound. It is not a deadline guarantee._

### Where the blocking comes from

- **safety** (900us)
  - logger holds "stateLock" with PTHREAD_PRIO_NONE; any thread above it can preempt it, so the wait is unbounded (lower bound 900us). — 900us
- **control** (900us)
  - logger holds "stateLock" with PTHREAD_PRIO_NONE; any thread above it can preempt it, so the wait is unbounded (lower bound 900us). — 900us

## Simulation

| Task | Activations | Completed | Unfinished | Max | Mean | Jitter | Misses |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| safety | 15 | 15 | 0 | 2.184ms | 375.467us | 2.022ms | 1 |
| control | 30 | 28 | 2 | 2.406ms | 690.5us | 2.03ms | 4 |
| logger | 2 | 2 | 0 | 3.534ms | 3.241ms | 586us | 0 |
| planner | 6 | 6 | 0 | 1.692ms | 1.512ms | 542us | 0 |

### Priority inversions

| Task | Blocked by | Resource | Duration | Mitigated |
| --- | --- | --- | ---: | --- |
| safety | logger | stateLock | 2.02ms | **no** |
| control | logger | stateLock | 1.746ms | **no** |
| safety | logger | stateLock | 1.022ms | **no** |
| control | logger | stateLock | 1.83ms | **no** |
### Deadline misses

| Task | Job | Released | Completed | Lateness | Dominant cause |
| --- | ---: | ---: | ---: | ---: | --- |
| safety | 1 | 0ns | 2.184ms | 184us | blocking |
| control | 1 | 0ns | 2.406ms | 1.406ms | blocking |
| control | 2 | 1.026ms | 2.804ms | 778us | interference |
| control | 16 | 15.026ms | 17.274ms | 1.248ms | blocking |
| control | 17 | 16.026ms | 17.672ms | 646us | interference |

## Diagnostics

- **error** `E_DEADLINE_MISS` control misses its deadline: worst-case response 1.538ms > 1ms.
  - Largest term is blocking (900us); need to recover 538us. Own execution is 374us.
- **info** `I_RATE_MONOTONIC` 1 task(s) have a shorter period at a lower priority than rate-monotonic order would give them.
  - Rate-monotonic priority assignment is optimal for fixed-priority preemptive scheduling with independent periodic tasks; try it if a task misses its deadline.

## Assumptions

- Single core: one thread runs at a time and priorities are a total order.
- Durations are microseconds of pure CPU time on the target; measure them on hardware before trusting a bound.
- QNX mutexes default to PTHREAD_PRIO_INHERIT; a mutex is only unbounded when the model says protocol: none.
- A server inherits the priority of the client it is serving and keeps it after MsgReply, as QNX documents.
- Interrupt service threads preempt every application thread; the clock IST runs at 254 and the IPI IST at 255.
- Clock period 1ms, round-robin timeslice 4 ticks, context switch 2us.
- Unbounded blocking: a shared mutex has priority inheritance disabled.

_Response-time bounds are analytical worst cases when the analysis proves them; a lower-bound result is a floor. The simulation is one deterministic schedule of the same model; a simulated latency above its bound is a modelling bug, not a nicer number._
