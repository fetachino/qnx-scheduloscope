import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeResponseTimes, solveResponseTime } from '../src/analysis/rta.js';
import { derive } from '../src/core/derive.js';
import { parseStrict } from './helpers.js';

const HEADER = 'schema: scheduloscope/v1\ninterrupts:\n  entryOverheadUs: 0\n  sources: []\ncpu:\n  contextSwitchUs: 0\n';

function analyze(body: string) {
  const model = parseStrict(HEADER + body);
  return analyzeResponseTimes(model, derive(model));
}

test('solves the textbook recurrence by hand', () => {
  const report = analyze(`name: rm
tasks:
  - name: a
    priority: 60
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 100us
  - name: b
    priority: 40
    period: 5ms
    deadline: 5ms
    segments:
      - cpu: 400us
  - name: c
    priority: 20
    period: 10ms
    deadline: 10ms
    segments:
      - cpu: 1ms
`);
  assert.equal(report.verdict, 'schedulable');
  const [a, b, c] = report.tasks;
  assert.equal(a!.responseUs, 100, 'highest priority waits for nobody');
  assert.equal(b!.responseUs, 500, '400 + ceil(500/1000) * 100');
  assert.equal(c!.responseUs, 1600, '1000 + 2 * 100 + 400 (one 5ms job inside 1.6ms)');
  assert.equal(c!.interferenceUs, 600);
  assert.equal(c!.slackUs, 10_000 - 1600);
});

test('counts a second job of a short-period task when the window grows past it', () => {
  const report = analyze(`name: two-jobs
tasks:
  - name: a
    priority: 60
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 400us
  - name: b
    priority: 40
    period: 10ms
    deadline: 10ms
    segments:
      - cpu: 400us
`);
  // R = 400 + ceil(R / 1000) * 400; the fixed point is 800, one a-job.
  assert.equal(report.tasks[1]!.responseUs, 800);
});

test('charges priority-inheritance blocking from a lower-priority critical section', () => {
  const report = analyze(`name: blocking
resources:
  - name: m
tasks:
  - name: h
    priority: 60
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 100us
      - cs:
          resource: m
          work: 10us
  - name: l
    priority: 20
    period: 10ms
    deadline: 10ms
    segments:
      - cs:
          resource: m
          work: 300us
`);
  const h = report.tasks[0]!;
  assert.equal(h.blockingUs, 300, 'inheritance bounds the wait by the longest lower-priority section');
  assert.equal(h.responseUs, 410, 'own 110us plus 300us of blocking');
  assert.equal(h.blocking[0]!.kind, 'mutex');
  assert.match(h.blocking[0]!.detail, /PTHREAD_PRIO_INHERIT/);
});

test('a priority-ceiling mutex blocks every task at or below the ceiling', () => {
  const report = analyze(`name: pcp
resources:
  - name: m
    protocol: protect
    ceiling: 60
tasks:
  - name: h
    priority: 60
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 100us
  - name: l
    priority: 20
    period: 10ms
    deadline: 10ms
    segments:
      - cs:
          resource: m
          work: 300us
`);
  assert.equal(report.tasks[0]!.blockingUs, 300, 'h never locks m, but the ceiling covers its priority');
});

test('a mutex with inheritance disabled is reported as unbounded blocking', () => {
  const report = analyze(`name: none
resources:
  - name: m
    protocol: none
tasks:
  - name: h
    priority: 60
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 100us
      - cs:
          resource: m
          work: 10us
  - name: l
    priority: 20
    period: 10ms
    deadline: 10ms
    segments:
      - cs:
          resource: m
          work: 300us
`);
  assert.equal(report.tasks[0]!.blocking[0]!.kind, 'unbounded');
  assert.equal(report.verdict, 'inconclusive', 'a known-invalid bound must not be called schedulable');
  assert.ok(report.caveats.some((c) => c.includes('Unbounded blocking')));
});

test('reports a deadline miss with the dominant term', () => {
  const report = analyze(`name: miss
tasks:
  - name: a
    priority: 60
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 700us
  - name: b
    priority: 40
    period: 2ms
    deadline: 1ms
    segments:
      - cpu: 400us
`);
  assert.equal(report.verdict, 'unschedulable');
  const b = report.tasks[1]!;
  assert.equal(b.deadlineMet, false);
  assert.ok(b.responseUs > b.deadlineUs);
  const diagnostic = report.diagnostics.find((d) => d.code === 'E_DEADLINE_MISS');
  assert.ok(diagnostic, 'expected E_DEADLINE_MISS');
  assert.match(diagnostic.hint ?? '', /Largest term is/);
});

test('refuses to invent a bound when higher-priority load exceeds 100%', () => {
  const report = analyze(`name: overload
tasks:
  - name: a
    priority: 60
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 600us
  - name: b
    priority: 55
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 600us
  - name: c
    priority: 40
    period: 5ms
    deadline: 5ms
    segments:
      - cpu: 100us
`);
  const c = report.tasks[2]!;
  assert.equal(c.converged, false);
  assert.equal(c.deadlineMet, false);
  assert.ok(report.diagnostics.some((d) => d.code === 'E_UNSCHEDULABLE'));
});

test('solveResponseTime converges and reports its iteration count', () => {
  const task = { name: 'x', priority: 10, executionUs: 400, periodUs: 10_000, deadlineUs: 10_000, kind: 'periodic' as const };
  const hp = [{ name: 'y', priority: 20, executionUs: 100, periodUs: 1_000, deadlineUs: 1_000, kind: 'periodic' as const }];
  const solved = solveResponseTime(task, hp, 0);
  assert.equal(solved.responseUs, 500);
  assert.equal(solved.converged, true);
  assert.ok(solved.iterations >= 2);
});

test('an aperiodic task gets no deadline verdict', () => {
  const report = analyze(`name: aperiodic
tasks:
  - name: evt
    priority: 30
    meanInterarrival: 20ms
    segments:
      - cpu: 100us
`);
  assert.equal(report.tasks[0]!.deadlineMet, null);
  assert.equal(report.verdict, 'inconclusive');
});
