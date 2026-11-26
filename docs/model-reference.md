# Model reference

A model is one YAML document with `schema: scheduloscope/v1`. Every duration accepts a unit
suffix (`250us`, `1ms`, `0.5s`, `20ns`) or a bare integer meaning microseconds. The parser
rejects unknown keys instead of ignoring them, so a typo is an error rather than a silently
different system.

```yaml
schema: scheduloscope/v1
name: motor-control            # required, shown in every report
description: free text         # optional, shown at the top of the HTML report
```

## `cpu`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cores` | `1` | `1` | Single-core analysis. SMP is out of scope for v1. |
| `contextSwitchUs` | duration | `2us` | Kernel dispatch cost. Charged to every job (two switches per dispatch) and counted in the simulation. |
| `privilegedPriorityCeiling` | 1..255 | `63` | The `-P` value `procnto` was started with. Priorities above it need `PROCMGR_AID_PRIORITY`; the validator warns when a design uses them. |

## `clock`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `periodUs` | duration | `1000us` | `ClockPeriod()`: the tick that drives timers and round-robin accounting. |
| `roundRobinTimesliceTicks` | integer | `4` | Timeslice of a `SCHED_RR` thread in ticks, so 4 ticks is 4 ms at the default tick. |

## `interrupts`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `clockIstPriority` | integer | `254` | Priority of the clock interrupt service thread. |
| `ipiIstPriority` | integer | `255` | Priority of the inter-processor interrupt IST. |
| `entryOverheadUs` | duration | `0` | Cost of one interrupt entry and exit, charged per activation. |
| `sources` | list | `[]` | Device interrupts that preempt application threads. |

Each source has `name`, `period` and `service`. `service` already includes the entry overhead;
the analysis adds `entryOverheadUs` again per activation because the IST also pays the return.

## `resources`

Mutexes, in the QNX sense: the same object is referenced by `cs` segments in several tasks.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | required | Referenced by `cs.resource`. |
| `protocol` | `none`, `inherit`, `protect` | `inherit` | `PTHREAD_PRIO_NONE`, `PTHREAD_PRIO_INHERIT` (the QNX default for `pthread_mutex_init`) or `PTHREAD_PRIO_PROTECT`. |
| `ceiling` | 1..255 | - | Required for `protect`, forbidden otherwise. Must be at least the highest priority of every task that locks the mutex. |

`inherit` bounds the blocking of a high-priority task by the longest critical section of a
lower-priority task. `protect` additionally prevents that task from being preempted inside the
section, but a task can be blocked by *any* lower-priority task that raises the ceiling. `none`
removes the bound entirely; the analysis then reports a caveat instead of a promise.

## `channels`

A message channel with one or more server threads blocked in `MsgReceive()`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | required | Referenced by `rpc.channel`. |
| `serverThreads` | 1..8 | `1` | How many threads receive on the channel. |
| `basePriority` | 1..255 | required | Priority the server threads are created with. |
| `fixedPriority` | boolean | `false` | `_NTO_CHF_FIXED_PRIORITY`: the server never inherits client priorities. |
| `handler` | list of segments | required | Work the server performs per request. Only `cpu`, `cs` and `sleep` make sense here. |

With `fixedPriority: false` the server inherits the priority of the client it is serving from
`MsgSend()` until it calls `MsgReply()`, and keeps that priority afterwards (QNX priority is
sticky). The simulator reproduces both halves; the analyzer charges the handler to the client as
delegated execution.

## `tasks`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | required | Unique. |
| `priority` | 1..255 | required | 0 is the idle thread and is rejected. |
| `policy` | `fifo`, `rr`, `sporadic` | `fifo` | `SCHED_FIFO`, `SCHED_RR`, `SCHED_SPORADIC`. |
| `period` | duration | - | Periodic activation. |
| `minInterarrival` | duration | - | Sporadic activation with a minimum separation. |
| `meanInterarrival` | duration | - | Aperiodic activation with a mean separation (simulation only, no deadline bound is claimed). |
| `offset` | duration | `0` | First release relative to t=0. |
| `deadline` | duration | period | Relative deadline. |
| `sporadic` | block | - | Required when `policy: sporadic`. |
| `segments` | list | required | The per-job program, executed in order. |
| `notes` | string | - | Shown in reports. |

Exactly one of `period`, `minInterarrival`, `meanInterarrival` must be present.

### `sporadic`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `lowPriority` | 1..252 | required | `sched_ss_low_priority`: where the thread runs once the budget is exhausted. Must be lower than the task priority. |
| `budget` | duration | required | `sched_ss_init_budget`: CPU time per replenishment period. |
| `replenishPeriod` | duration | required | `sched_ss_repl_period`. |
| `maxReplenishments` | 1..65535 | `3` | `sched_ss_max_repl`: how many budget replenishments may be pending. `SS_REPL_MAX` is 65535 in QNX. |

### Segments

A segment is one step of the job. The order matters: it is what makes blocking and message
inheritance visible in the simulation.

| Segment | YAML | Meaning |
| --- | --- | --- |
| CPU | `- cpu: 150us` | Pure computation at the task priority. |
| Critical section | `- cs: {resource: stateLock, work: 40us}` | Lock, work, unlock. |
| Message | `- rpc: {channel: sensorHub, timeout: 2ms}` | `MsgSend()` to the channel, wait for the reply. The timeout is optional. |
| Sleep | `- sleep: 3ms` | Block on a timer. Self-suspension invalidates the classic RTA bound and the analyzer says so. |
| Yield | `- yield: true` | `SchedYield()`. Modelled in the analysis, not reproducible in the generated harness. |
| Priority change | `- setPriority: 55` | `pthread_setschedparam()` mid-job. Modelled in the analysis, not reproducible in the generated harness. |

Short form: `- cpu: 150us` is a scalar; `cs`, `rpc`, `sleep` and `setPriority` take mappings as
shown. A block must be written as

```yaml
      - cs:
          resource: stateLock
          work: 40us
```

## `simulation`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `duration` | duration | one hyperperiod, at least 4x the longest period | Wall-clock window to simulate. |
| `seed` | integer | `1` | Seeds aperiodic arrivals and jitter. The rest of the schedule is deterministic. |
| `maxJobsPerTask` | integer | `64` | Cap on simulated jobs per task, so a tiny period cannot run away. |

## Validation diagnostics

Codes are stable and can be grepped in CI: `E_` errors block analysis, `W_` warnings do not.

| Code | Meaning |
| --- | --- |
| `E_NO_TASKS` | The model has no tasks. |
| `E_TYPE`, `E_RANGE`, `E_DURATION` | A value has the wrong type, is out of range, or is not a duration. |
| `E_ACTIVATION` | More than one activation kind on a task. |
| `E_PRIORITY_RANGE` | Priority outside 1..255. |
| `E_UNKNOWN_RESOURCE`, `E_UNKNOWN_CHANNEL` | A segment references something that does not exist. |
| `E_PCP_CEILING` | A `protect` mutex has no ceiling, or the ceiling is below a user. |
| `E_DUPLICATE` | Two tasks, resources or channels share a name. |
| `W_PRIVILEGED_PRIORITY` | The design needs `PROCMGR_AID_PRIORITY`. |
| `W_IST_PRIORITY` | A task uses 254 or 255, which belong to the clock and IPI IST. |
| `W_UNBOUNDED_BLOCKING` | A shared mutex has `protocol: none`. |
| `W_RATE_MONOTONIC` | Priorities are not rate-monotonic and a task misses. |
| `W_SELF_SUSPENSION` | A job sleeps or waits on a message, so the RTA bound is not exact. |

