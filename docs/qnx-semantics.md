# QNX OS 8.0 semantics the tool reproduces

Scheduloscope is only useful if it is wrong in the same ways QNX is wrong. This page lists the
behaviour the model encodes, why it matters for a deadline, and where the boundary of the
approximation is. References are to the QNX OS 8.0 System Architecture and Programmer's Guide;
the names in backticks are the API or constant you would find in the C library.

## The priority space

QNX has 256 priorities, 0..255, and a higher number wins. Priority 0 is reserved for the idle
thread. `procnto` is started with `-P` (63 by default), and threads above that ceiling need the
`PROCMGR_AID_PRIORITY` ability, which an unprivileged process does not have. The kernel keeps
254 for the clock interrupt service thread and 255 for the inter-processor interrupt IST.

Two consequences the validator enforces:

- A design that assigns priority 70 to a normal process silently fails to take effect unless the
  process is privileged. Scheduloscope warns (`W_PRIVILEGED_PRIORITY`) instead of pretending the
  number is real.
- A task at 254 or 255 is competing with the kernel. It is legal and sometimes correct for an IST,
  but it is a code smell for application code (`W_RESERVED_PRIORITY`).

## Scheduling policies

| Policy | QNX behaviour | What the simulator does |
| --- | --- | --- |
| `SCHED_FIFO` | Runs until it blocks, yields or is preempted by a higher priority. Threads at the same priority run in the order they became ready. | Same, with an explicit ready queue per priority level. |
| `SCHED_RR` | As FIFO but with a timeslice of `ticks x ClockPeriod()` (4 ticks, 1 ms tick, so 4 ms by default). When the slice expires the thread goes to the tail of its priority queue. | Counts tick time, rotates the thread at the head of its priority level. |
| `SCHED_SPORADIC` | Starts at the task priority with `sched_ss_init_budget`. When the budget is gone the thread drops to `sched_ss_low_priority` until `sched_ss_repl_period` replenishes it, up to `sched_ss_max_repl` pending replenishments. | Both the drop and the replenishment are events in the trace, so a burst is visible in the Gantt chart. |

A sporadic thread is not suspended when the budget runs out; it becomes a low-priority thread.
That difference matters: a system with spare capacity still lets it run, which the simulation
shows and a naive "skip the job" model would hide.

## Mutexes

`pthread_mutex_init` in QNX defaults to `PTHREAD_PRIO_INHERIT`, not `PTHREAD_PRIO_NONE` as
POSIX allows, so the safe behaviour is the one you get if you do nothing. The model keeps that
default.

| Protocol | Effect on a blocked high-priority thread |
| --- | --- |
| `PTHREAD_PRIO_NONE` | Unbounded: any middle-priority thread can preempt the owner while the high-priority thread waits. |
| `PTHREAD_PRIO_INHERIT` | The owner inherits the waiter priority and cannot be preempted by anything below it, so the wait is bounded by the critical section. |
| `PTHREAD_PRIO_PROTECT` | The owner runs at the ceiling of the mutex for the whole section, even with no waiter. Bounds blocking, at the cost of pessimism. |

Two details the simulator implements because they change measured latency: on unlock, QNX hands
the mutex directly to the highest-priority waiter rather than letting it race for the lock, and a
thread that blocks sits at the head of its priority queue when it wakes.

`protect` has a second rule: a thread must not lock two mutexes whose ceilings interact, and the
ceiling must be at least the priority of every thread that locks it. The validator checks the
second half (`E_CEILING_VIOLATION`).

## Message passing and inheritance

QNX is a message-passing microkernel. A client calls `MsgSend()` and blocks; the server, blocked
in `MsgReceive()`, receives the message and runs the server-side work at a priority inherited
from the client. When the server calls `MsgReply()`, the client becomes ready and the server
returns to its own priority, but the inherited priority is **sticky**: the server keeps the
highest client priority it has served until it explicitly changes it. That is why a busy server
can slowly climb in priority and starve a design that looked balanced on paper.

The model has three knobs for this and reproduces all three:

- `serverThreads`: several receivers on one channel, each able to serve one client at a time.
- The `handler` program: the work done between receive and reply, charged to the client.
- `fixedPriority: true`: `_NTO_CHF_FIXED_PRIORITY` on the channel. The server never inherits, so a
  low-priority server can delay a high-priority client without any bound. The analyzer raises a
  caveat and the simulator records the wait as a fixed-priority inversion.

Message priority also flows the other way: `MsgSend()` from a high-priority client can raise a
server above unrelated middle-priority threads, which is the mechanism that makes a well designed
QNX system schedulable at all.

## Interrupts

Hardware interrupts are handled by the kernel and then by an interrupt service thread at a
priority you choose. The clock IST runs at 254 and the inter-processor interrupt at 255, above
any application thread. In the model, an interrupt source contributes two things:

- Interference: `ceil(R / T) x service` in the response-time equation, because an IST preempts
  the task at any point in its execution.
- Entry cost: `entryOverheadUs` per activation, charged again on the way back to the task.

An interrupt that alone consumes more CPU than its period allows is caught by the validator
(`E_ISR_OVERLOAD`), because no priority assignment can fix it.

## Time

`ClockPeriod()` is the tick that drives `nanosleep`, timers and the round-robin accounting; the
programmer's guide describes it as 1 ms by default. Time in the model is integer microseconds
end to end, so there is no floating-point drift between the analysis and the simulation, and
durations shorter than a tick are still representable (they are what `ClockCycles()` measures).

## What the simulator guarantees

The simulator is a deterministic discrete-event model. Given the same model and seed it produces
byte-identical traces, and its event ordering is:

1. Advance to the next release, timeout, unlock, budget event or message arrival.
2. Deliver interrupts and kernel work due at that instant.
3. Choose the highest-priority ready thread; among equals, the one that became ready first.
4. Run it until it blocks, completes, is preempted, or its timeslice or sporadic budget expires.

Kernel time and context switches are charged explicitly, so the chart shows the cost of the
design and not only its CPU demand.

## What is not modelled

- Symmetric multiprocessing, thread affinity and the adaptive partition scheduler. v1 is
  single-core, which is the common shape of a hard real-time QNX design and the only case where
  the response-time bound is simple.
- Priority inheritance chains longer than a mutex cycle: the engine iterates the inheritance
  fixpoint up to twelve rounds and reports `W_PRIORITY_FIXPOINT` if it does not settle.
- The exact cost of a `MsgSend()` crossing an address space, cache effects, and memory bandwidth.
  Those are measured, not modelled; `gen` exists for exactly that reason.

