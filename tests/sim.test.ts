import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulate } from '../src/sim/engine.js';
import { derive } from '../src/core/derive.js';
import { parseStrict, TWO_TASKS } from './helpers.js';

function run(source: string, durationUs = 20_000, seed = 1) {
  const model = parseStrict(source);
  return simulate(model, { durationUs, seed });
}

test('the same seed produces byte-identical results', () => {
  const a = run(TWO_TASKS, 20_000, 7);
  const b = run(TWO_TASKS, 20_000, 7);
  assert.deepEqual(a, b);
});

test('a different seed changes the aperiodic arrival pattern, not the periodic one', () => {
  const source = TWO_TASKS + ['  - name: events', '    priority: 10', '    meanInterarrival: 3ms',
    '    segments:', '      - cpu: 100us', ''].join('\n');
  const a = run(source, 20_000, 1);
  const b = run(source, 20_000, 2);
  assert.notDeepEqual(a.traces, b.traces);
  const fastA = a.tasks.find((t) => t.name === 'fast')!;
  const fastB = b.tasks.find((t) => t.name === 'fast')!;
  assert.equal(fastA.activations, fastB.activations, 'periodic releases do not depend on the seed');
});

test('the highest-priority ready thread runs first', () => {
  const sim = run(TWO_TASKS, 5_000);
  const first = sim.traces.find((slice) => slice.kind === 'run');
  assert.ok(first);
  assert.equal(first.lane, 'fast');
});

test('a one-millisecond control loop is never late on an idle CPU', () => {
  const sim = run(TWO_TASKS, 50_000);
  assert.equal(sim.deadlineMisses.length, 0);
  const fast = sim.tasks.find((t) => t.name === 'fast')!;
  assert.equal(fast.activations, 50);
  assert.equal(fast.completed, 50);
  assert.ok(fast.maxResponseUs <= 1000);
});

test('priority inheritance bounds the inversion a low-priority lock can cause', () => {
  const template = (protocol: string) => `schema: scheduloscope/v1
name: ${protocol}
cpu:
  contextSwitchUs: 0
resources:
  - name: m
    protocol: ${protocol}
tasks:
  - name: h
    priority: 60
    period: 5ms
    deadline: 5ms
    segments:
      - cpu: 200us
      - cs:
          resource: m
          work: 100us
  - name: mid
    priority: 40
    period: 2ms
    deadline: 2ms
    segments:
      - cpu: 800us
  - name: l
    priority: 20
    period: 10ms
    deadline: 10ms
    segments:
      - cs:
          resource: m
          work: 1ms
`;
  const inherited = run(template('inherit'), 20_000);
  const plain = run(template('none'), 20_000);

  const inheritedInversion = inherited.inversions.find((i) => i.task === 'h');
  assert.ok(inheritedInversion, 'expected an inversion record even when it is bounded');
  assert.equal(inheritedInversion.mitigated, true);

  const plainInversion = plain.inversions.find((i) => i.task === 'h');
  assert.ok(plainInversion);
  assert.equal(plainInversion.mitigated, false);
  assert.ok(
    plainInversion.durationUs > inheritedInversion.durationUs,
    'without inheritance the wait must be longer: ' + plainInversion.durationUs + ' vs ' + inheritedInversion.durationUs,
  );
});

test('a fixed-priority channel lets a high-priority client wait behind the server', () => {
  const sim = run(`schema: scheduloscope/v1
name: fixed
cpu:
  contextSwitchUs: 0
channels:
  - name: svc
    basePriority: 20
    fixedPriority: true
    handler:
      - cpu: 300us
tasks:
  - name: client
    priority: 60
    period: 10ms
    deadline: 10ms
    segments:
      - rpc:
          channel: svc
`);
  const inversion = sim.inversions.find((i) => i.kind === 'message');
  assert.ok(inversion, 'expected a message inversion');
  assert.equal(inversion.mitigated, false);
  assert.ok(inversion.durationUs >= 300);
});

test('a sporadic server is capped by its budget', () => {
  const sim = run(`schema: scheduloscope/v1
name: sporadic
tasks:
  - name: poller
    priority: 40
    policy: sporadic
    period: 2ms
    deadline: 2ms
    sporadic:
      lowPriority: 10
      budget: 200us
      replenishPeriod: 1ms
    segments:
      - cpu: 1ms
  - name: background
    priority: 20
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 900us
`);
  const poller = sim.tasks.find((t) => t.name === 'poller')!;
  // 200us of budget per 1ms caps the poller near 20% of the CPU even though it
  // asks for 1ms of work every 2ms and the background task is always ready.
  assert.ok(poller.cpuUs <= 0.35 * sim.horizonUs, 'budget must cap the CPU time, got ' + poller.cpuUs);
  assert.ok(poller.cpuUs > 0, 'the poller must still make progress');
  const drops = sim.events.filter((event) => event.type === 'sporadic-drop' && event.thread === 'poller').length;
  assert.ok(drops >= 5, 'expected repeated budget exhaustion, saw ' + drops);
  assert.ok(poller.meanResponseUs > 1000, 'replenishment must stretch the job, got ' + poller.meanResponseUs);
});

test('an overrunning task produces deadline misses instead of silently stretching', () => {
  const sim = run(`schema: scheduloscope/v1
name: overrun
tasks:
  - name: heavy
    priority: 50
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 1500us
`);
  assert.ok(sim.deadlineMisses.length > 0);
  assert.ok(sim.deadlineMisses.every((m) => m.task === 'heavy'));
});

test('round-robin peers share the CPU in timeslice-sized pieces', () => {
  const source = `schema: scheduloscope/v1
name: rr
cpu:
  contextSwitchUs: 0
clock:
  roundRobinTimesliceTicks: 4
tasks:
  - name: p
    priority: 30
    policy: rr
    period: 8ms
    deadline: 8ms
    segments:
      - cpu: 2ms
  - name: q
    priority: 30
    policy: rr
    period: 8ms
    deadline: 8ms
    segments:
      - cpu: 2ms
`;
  const sim = run(source, 16_000);
  const p = sim.tasks.find((t) => t.name === 'p')!;
  const q = sim.tasks.find((t) => t.name === 'q')!;
  assert.ok(p.cpuUs > 0 && q.cpuUs > 0, 'both peers must run');
  assert.ok(Math.abs(p.cpuUs - q.cpuUs) <= 4_000, 'peers should get comparable CPU time');
  assert.ok(sim.contextSwitches > 2, 'the timeslice must rotate');
});

test('the example model is schedulable and never misses in simulation', () => {
  const model = parseStrict(readExample());
  const sim = simulate(model, { durationUs: model.simulation?.durationUs ?? 20_000 });
  assert.equal(sim.deadlineMisses.length, 0);
  assert.ok(sim.completedJobs > 0);
  assert.ok(sim.idleUs > 0);
});

function readExample(): string {
  // Resolved relative to the compiled test, so keep the repository root walk simple.
  const url = new URL('../../examples/motor-control.yaml', import.meta.url);
  return readFileSync(url, 'utf8');
}

import { readFileSync } from 'node:fs';
