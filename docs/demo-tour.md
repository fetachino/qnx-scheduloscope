# Demo tour

Six steps, about four minutes, all from a fresh clone. Every number below is the output of the
command above it in the verification environment described in [verification.md](verification.md).

```bash
git clone https://github.com/fetachino/qnx-scheduloscope.git
cd qnx-scheduloscope && npm ci && npm run build
```

## 1. A schedulable configuration

```bash
npx scheduloscope analyze examples/motor-control.yaml
```

```text
motor-control  schedulable  ·  5 tasks  ·  68.8% utilization  ·  worst slack 361us  ·  hyperperiod 20ms

task       policy  pri        C      B        I    ISR        R     D     slack  result
---------  ------  ---  -------  -----  -------  -----  -------  ----  --------  ------
safety     fifo     70    124us  100us      0ns   26us    250us   2ms    1.75ms  met
control    fifo     60    364us  100us    124us   51us    639us   1ms     361us  met
...
```

Point at `B`: 100us is the longest critical section safety can be blocked by, and it is bounded
only because `stateLock` uses `PTHREAD_PRIO_INHERIT`. The `control` slack of 361us is the number
to watch in the next step.

## 2. Change one attribute

`examples/motor-control-no-inherit.yaml` is the same file with one functional edit:

```diff
-    protocol: inherit
+    protocol: none
```

```bash
npx scheduloscope analyze examples/motor-control-no-inherit.yaml
```

```text
motor-control-no-inherit  inconclusive  ·  5 tasks  ·  68.8% utilization  ·  worst slack 361us

caveats
  · Unbounded blocking: a shared mutex has priority inheritance disabled.
```

Identical utilisation, identical response times, and a different verdict. The numbers did not
move because they are a lower bound; the analysis simply refuses to call the design schedulable
when it cannot bound the blocking. That distinction between *a proof* and *a number* is the
point of the tool.

## 3. What the schedule actually does

```bash
npx scheduloscope simulate examples/motor-control.yaml
npx scheduloscope simulate examples/motor-control-no-inherit.yaml
```

| | `inherit` | `none` |
| --- | --- | --- |
| Inversions | 1, mitigated | 2, unbounded |
| Worst blocked time | 82us | 443us |
| Safety worst response | 206us | 567us |
| Safety jitter | 84us | 445us |
| Context switches in 20 ms | 88 | 89 |

```text
  unbounded safety blocked by logger on stateLock for 443us
  unbounded control blocked by logger on stateLock for 149us
```

## 4. A design that misses

`examples/priority-inversion.yaml` removes the inheritance and gives the logger a 900us section:

```bash
npx scheduloscope analyze examples/priority-inversion.yaml   # exits 1
```

```text
motor-control-no-inheritance  unschedulable  ·  4 tasks  ·  67.7% utilization  ·  worst slack -538us

control  fifo  60  374us  900us  164us  100us  1.538ms  1ms  -538us  MISS

  · control misses its deadline: worst-case response 1.538ms > 1ms.
    Largest term is blocking (900us); need to recover 538us. Own execution is 374us.
```

The exit code is 1, so this is usable as a pre-commit or CI gate.

## 5. The inversion in the chart

```bash
npx scheduloscope report examples/motor-control-no-inherit.yaml --out demo/
npx scheduloscope report examples/priority-inversion.yaml --out demo/
```

Open the HTML report. Under the chart, the inversion table lists each event: who was blocked, by
whom, on which mutex, and for how long. In the chart itself the blocked thread has **no bar** for
that interval - the safety lane is empty while the logger lane is amber (`cs`, the critical
section) and the planner lane is blue (`cpu`). An empty lane with work pending is the visual
signature of a priority inversion; the amber bar inside it is the critical section that caused it.

The generated reports are committed, so this step works without running anything:

- [motor-control](https://fetachino.github.io/qnx-scheduloscope/demo/motor-control.html)
- [motor-control-no-inherit](https://fetachino.github.io/qnx-scheduloscope/demo/motor-control-no-inherit.html)

## 6. Measuring it on the target

```bash
npx scheduloscope gen examples/motor-control.yaml --out harness/ -d 5000ms
cd harness && make qnx && scp scheduloscope-harness target:/tmp/
ssh target /tmp/scheduloscope-harness -d 5000 -o /tmp/report.json
```

The harness runs the same five threads at the same priorities with the same mutex protocols,
timestamps every job with `ClockCycles`, and reports `min_us`, `mean_us`, `max_us` and `misses`
per task. Compare `max_us` with the `R` column from step 1: if the target exceeds the analysis,
the model is missing interference; if it is well below, the estimates behind `C` are pessimistic.

On a host without QNX, `make` builds the POSIX backend instead, which is what CI does. It proves
the generated C compiles and runs; it does not produce QNX timings, and the JSON says
`"platform": "posix"` so nobody can mistake one for the other.

## The one-slide summary

| Step | Command | Result |
| --- | --- | --- |
| Baseline | `analyze motor-control.yaml` | schedulable, 361us slack |
| One attribute | `analyze motor-control-no-inherit.yaml` | inconclusive, unbounded blocking |
| Reality | `simulate ...` | 82us mitigated vs 443us unbounded |
| Failure | `analyze priority-inversion.yaml` | MISS by 538us, blocking 900us |
| Explanation | `report ...` | inversion table and Gantt gap |
| Measurement | `gen` + `make qnx` | measured worst case on the target |

