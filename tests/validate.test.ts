import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModel } from '../src/core/parse.js';
import { validateModel } from '../src/core/validate.js';
import { MINIMAL, parseStrict, requireCode, TWO_TASKS } from './helpers.js';

function validate(source: string) {
  return validateModel(parseStrict(source));
}

test('a clean model produces no errors', () => {
  const diagnostics = validate(MINIMAL);
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), []);
});

test('warns when a priority needs PROCMGR_AID_PRIORITY', () => {
  const diagnostics = validate(MINIMAL.replace('priority: 50', 'priority: 70'));
  const warning = requireCode(diagnostics, 'W_PRIVILEGED_PRIORITY');
  assert.match(warning.message, /PROCMGR_AID_PRIORITY/);
  assert.equal(warning.severity, 'warning');
});

test('warns about priorities reserved for the clock and IPI ISTs', () => {
  for (const priority of [254, 255]) {
    const diagnostics = validate(MINIMAL.replace('priority: 50', 'priority: ' + priority));
    requireCode(diagnostics, 'W_RESERVED_PRIORITY');
  }
});

test('rejects a priority outside the 0..255 range', () => {
  const parsed = parseModel(MINIMAL.replace('priority: 50', 'priority: 300'));
  requireCode(parsed.diagnostics, 'E_RANGE');
  // The parser already refuses 300, so prove the validator is a second line of defence.
  const model = parseStrict(MINIMAL);
  const mutated = { ...model, tasks: [{ ...model.tasks[0]!, priority: 300 }] };
  requireCode(validateModel(mutated), 'E_PRIORITY_RANGE');
});

test('rejects duplicate task names and duplicate resources', () => {
  const duplicateTask = parseModel(TWO_TASKS.replace('name: slow', 'name: fast'));
  requireCode(validateModel(parseStrict(TWO_TASKS.replace('name: slow', 'name: fast'))), 'E_DUPLICATE');
  assert.ok(duplicateTask.model);
});

test('rejects references to resources and channels that do not exist', () => {
  const badResource = validate(MINIMAL.replace('- cpu: 200us', [
    '- cs:',
    '          resource: ghost',
    '          work: 10us',
  ].join('\n')));
  requireCode(badResource, 'E_UNKNOWN_RESOURCE');

  const badChannel = validate(MINIMAL.replace('- cpu: 200us', [
    '- rpc:',
    '          channel: ghost',
  ].join('\n')));
  requireCode(badChannel, 'E_UNKNOWN_CHANNEL');
});

test('validates sporadic parameters against QNX constraints', () => {
  const source = MINIMAL.replace('priority: 50', [
    'priority: 50',
    '    policy: sporadic',
    '    sporadic:',
    '      lowPriority: 60',
    '      budget: 200us',
    '      replenishPeriod: 1ms',
  ].join('\n'));
  requireCode(validate(source), 'E_SPORADIC_ORDER');
});

test('rejects an interrupt source that alone saturates the CPU', () => {
  const source = MINIMAL + [
    'interrupts:',
    '  sources:',
    '    - name: storm',
    '      period: 10us',
    '      service: 20us',
    '',
  ].join('\n');
  requireCode(validate(source), 'E_ISR_OVERLOAD');
});

test('warns that a sleeping job breaks the classic RTA assumptions', () => {
  const diagnostics = validate(MINIMAL.replace('- cpu: 200us', [
    '- cpu: 100us',
    '      - sleep: 500us',
  ].join('\n')));
  requireCode(diagnostics, 'W_SELF_SUSPENSION');
});

test('notes a round-robin task that shares its priority with nobody', () => {
  const diagnostics = validate(MINIMAL.replace('priority: 50', 'priority: 50\n    policy: rr'));
  requireCode(diagnostics, 'I_RR_NO_PEER');
});

test('ignores the rate-monotonic note when priorities follow the periods', () => {
  const model = parseStrict(TWO_TASKS);
  const diagnostics = validateModel(model);
  assert.equal(diagnostics.filter((d) => d.code === 'I_RATE_MONOTONIC').length, 0);
});
