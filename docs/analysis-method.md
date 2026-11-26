# Analysis method

The analyzer answers one question per task: **can this job finish before its deadline, in the
worst case?** It uses the classical fixed-priority response-time analysis for periodic tasks
(Joseph and Pandya, extended by Audsley for blocking), instantiated with QNX terms.

## The equation

```text
R = C + B + I + S

I = sum over higher-priority tasks j of  ceil(R / Tj) * Cj
```

`R` appears on both sides, so the equation is solved by fixed-point iteration: start with
`R0 = C + B + S` and iterate until `R` stops changing. If `R` exceeds the deadline the task is
unschedulable; if the iteration does not converge, the task set offers more CPU than exists.

| Term | What it contains |
| --- | --- |
| `C` | The task own CPU time, plus the server work it delegates through `rpc` segments, plus the context-switch cost of its dispatches. |
| `B` | The longest time a lower-priority task can keep this task from running, through a mutex. Depends on the mutex protocol. |
| `I` | Interference from every higher-priority task, including the number of times each one can be released inside the response time. |
| `S` | Interference from interrupt service threads: `ceil(R / period) * (service + entry overhead)`. |

## Blocking, per protocol

| Protocol | `B` for task i |
| --- | --- |
| `PTHREAD_PRIO_INHERIT` | The longest critical section, on a resource shared with i, of any task with a lower priority than i. |
| `PTHREAD_PRIO_PROTECT` | The longest critical section of any lower-priority task holding a mutex whose ceiling is at least i's priority. A task can be blocked by threads it never shares a mutex with, which is the price of the ceiling. |
| `PTHREAD_PRIO_NONE` | No finite bound. The analysis still reports the longest section as a lower bound, but marks the result as a caveat: a middle-priority task can stretch the wait arbitrarily. |

The implementation takes the maximum over resources, which assumes a task acquires at most one
mutex it can block on per job. Nested critical sections across different mutexes can produce a
larger chain; the model reports that as a caveat rather than pretending to bound it.

## Verdict rules

| Verdict | Condition |
| --- | --- |
| `schedulable` | Every task has `R <= D` and no caveat invalidates a bound. |
| `unschedulable` | At least one task has `R > D`, or the iteration diverges. |
| `inconclusive` | Every task meets its deadline under the computed terms, but a caveat (unbounded blocking, self-suspension, aperiodic arrivals) means the term is not a proof. |

Slack is `D - R`, so the reported worst slack is the tightest margin in the design. Negative
slack is reported as a miss, with the largest contributing term named, because "it misses by
538 us and blocking is 900 us of it" is the sentence that leads to a fix.

## Worked example

Three tasks with a measured 100 us, 500 us and 1600 us of execution, periods 1 ms, 2 ms and
4 ms, priorities in rate-monotonic order, no blocking and no interrupts (`tests/rta.test.ts`
pins these numbers):

```text
R(low)  = 1600                                     = 1600us
R(mid)  = 500 + ceil(500/1000)  * 100              = 600us
R(high) = 100 + ceil(100/2000)  * 500 + ceil(100/4000) * 1600 = 600us
```

Add a 300 us critical section shared with a lower-priority task and the high-priority response
time becomes 410 us with `inherit`, and unbounded with `none`.

## Why not just simulate

A simulation proves that one schedule works. It cannot prove that no schedule fails, because
the failing release pattern may be the one the simulator did not pick. The analysis proves the
bound, and the simulation shows the mechanism. Running both on the same derived model is the
point of the tool: the analysis gives the guarantee, the Gantt chart gives the explanation.

The two are cross-checked in the test suite (`tests/sim.test.ts`): for models where the analysis
says schedulable, the simulation must not miss a deadline, and where the analysis says the
response time is R, the simulated worst case must not exceed it.

## Limits

- Self-suspending jobs (a `sleep` or an `rpc` segment in the middle of a job) break the classic
  bound: the equation assumes a job never releases the CPU voluntarily. Scheduloscope detects
  the pattern and downgrades the verdict instead of reporting a number it cannot defend.
- Aperiodic tasks have no deadline by default (`deadlineUs = 0`, produced by omitting the field;
  an explicit zero is rejected) and are simulated for CPU load without a bound or a miss count. If
  the model gives one an explicit positive deadline, the simulator and
  harness measure completions against it as an observed target, but RTA still makes no arrival-rate
  or future-deadline guarantee.
- The analysis is single-core, like the rest of v1.
