import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModel } from '../src/core/parse.js';
import { MINIMAL, parseStrict, requireCode, TWO_TASKS } from './helpers.js';

test('parses a minimal model into the internal shape', () => {
  const model = parseStrict(MINIMAL);
  assert.equal(model.name, 'minimal');
  assert.equal(model.schema, 'scheduloscope/v1');
  assert.equal(model.tasks.length, 1);
  const task = model.tasks[0]!;
  assert.equal(task.name, 'worker');
  assert.equal(task.priority, 50);
  assert.equal(task.policy, 'fifo', 'fifo is the QNX default policy');
  assert.deepEqual(task.activation, { type: 'periodic', periodUs: 1000, offsetUs: 0 });
  assert.equal(task.deadlineUs, 1000);
  assert.deepEqual(task.segments, [{ kind: 'cpu', us: 200 }]);
});

test('defaults match QNX rather than generic POSIX', () => {
  const model = parseStrict(MINIMAL);
  assert.equal(model.cpu.cores, 1);
  assert.equal(model.cpu.privilegedPriorityCeiling, 63, 'procnto -P default ceiling');
  assert.equal(model.clock.periodUs, 1000, 'default ClockPeriod');
  assert.equal(model.clock.roundRobinTimesliceTicks, 4);
  assert.equal(model.interrupts.clockIstPriority, 254);
  assert.equal(model.interrupts.ipiIstPriority, 255);
});

test('resource protocol defaults to PTHREAD_PRIO_INHERIT', () => {
  const model = parseStrict(MINIMAL + [
    'resources:',
    '  - name: lock',
    '',
  ].join('\n'));
  assert.equal(model.resources[0]!.protocol, 'inherit');
});

test('reports an unknown key with a suggestion', () => {
  const parsed = parseModel(MINIMAL.replace('priority: 50', 'priorty: 50'));
  const diagnostic = requireCode(parsed.diagnostics, 'E_UNKNOWN_KEY');
  assert.match(diagnostic.message, /priorty/);
  assert.match(diagnostic.hint ?? '', /priority/);
  assert.equal(parsed.model, undefined, 'a fatal parse error yields no model');
});

test('rejects a duration without a unit-aware number', () => {
  const parsed = parseModel(MINIMAL.replace('period: 1ms', 'period: soon'));
  const diagnostic = requireCode(parsed.diagnostics, 'E_DURATION');
  assert.match(diagnostic.message, /not a duration/);
});

test('requires at least one task', () => {
  const parsed = parseModel('schema: scheduloscope/v1\nname: empty\n');
  requireCode(parsed.diagnostics, 'E_NO_TASKS');
});

test('rejects multi-core models instead of pretending to analyze them', () => {
  const parsed = parseModel(MINIMAL.replace('name: minimal', 'name: minimal\ncpu:\n  cores: 2'));
  requireCode(parsed.diagnostics, 'E_SMP');
});

test('rejects an unknown schema id', () => {
  const parsed = parseModel(MINIMAL.replace('scheduloscope/v1', 'scheduloscope/v2'));
  requireCode(parsed.diagnostics, 'E_SCHEMA');
});

test('rejects unknown policies and unknown segments', () => {
  const badPolicy = parseModel(MINIMAL.replace('priority: 50', 'priority: 50\n    policy: edf'));
  requireCode(badPolicy.diagnostics, 'E_POLICY');
  const badSegment = parseModel(MINIMAL.replace('- cpu: 200us', '- spin: 200us'));
  requireCode(badSegment.diagnostics, 'E_SEGMENT');
});

test('a sporadic task must carry its replenishment parameters', () => {
  const parsed = parseModel(MINIMAL.replace('priority: 50', 'priority: 50\n    policy: sporadic'));
  requireCode(parsed.diagnostics, 'E_REQUIRED');
});

test('a protect mutex needs a ceiling', () => {
  const source = TWO_TASKS + ['resources:', '  - name: lock', '    protocol: protect', ''].join('\n');
  const parsed = parseModel(source);
  requireCode(parsed.diagnostics, 'E_CEILING');
});

test('a channel handler must not be empty', () => {
  const source = TWO_TASKS + ['channels:', '  - name: svc', '    basePriority: 30', '    handler: []', ''].join('\n');
  const parsed = parseModel(source);
  requireCode(parsed.diagnostics, 'E_HANDLER');
});

test('parses every segment kind', () => {
  const source = MINIMAL + ['resources:', '  - name: lock', 'channels:', '  - name: svc',
    '    basePriority: 30', '    handler:', '      - cpu: 100us', ''].join('\n');
  const model = parseStrict(source.replace('- cpu: 200us', [
    '- cpu: 100us',
    '      - cs:',
    '          resource: lock',
    '          work: 50us',
    '      - rpc:',
    '          channel: svc',
    '          timeout: 2ms',
    '      - sleep: 1ms',
    '      - yield: true',
    '      - setPriority: 55',
  ].join('\n')));
  assert.deepEqual(model.tasks[0]!.segments.map((s) => s.kind), ['cpu', 'cs', 'rpc', 'sleep', 'yield', 'setPriority']);
});
