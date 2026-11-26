/** Shared helpers for the test suite. */

import assert from 'node:assert/strict';
import type { Diagnostic } from '../src/core/diagnostics.js';
import type { SystemModel } from '../src/core/model.js';
import { parseModel } from '../src/core/parse.js';
import { validateModel } from '../src/core/validate.js';

/** Parse and assert that no error diagnostics were produced. */
export function parseStrict(source: string): SystemModel {
  const parsed = parseModel(source);
  const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(
    errors.map((d) => d.code + ' ' + d.message),
    [],
    'expected a clean parse',
  );
  assert.ok(parsed.model, 'parser produced no model');
  return parsed.model;
}

/** Parse, then validate and assert that validation found no errors. */
export function loadStrict(source: string): SystemModel {
  const model = parseStrict(source);
  const errors = validateModel(model).filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((d) => d.code + ' ' + d.message), [], 'expected a valid model');
  return model;
}

export function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

export function find(diagnostics: readonly Diagnostic[], code: string): Diagnostic | undefined {
  return diagnostics.find((d) => d.code === code);
}

export function requireCode(diagnostics: readonly Diagnostic[], code: string): Diagnostic {
  const hit = find(diagnostics, code);
  assert.ok(hit, 'expected diagnostic ' + code + ', got [' + codes(diagnostics).join(', ') + ']');
  return hit;
}

export const MINIMAL = `schema: scheduloscope/v1
name: minimal
tasks:
  - name: worker
    priority: 50
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 200us
`;

/** Two tasks of different priority, no shared state. */
export const TWO_TASKS = `schema: scheduloscope/v1
name: two-tasks
tasks:
  - name: fast
    priority: 60
    period: 1ms
    deadline: 1ms
    segments:
      - cpu: 100us
  - name: slow
    priority: 40
    period: 5ms
    deadline: 5ms
    segments:
      - cpu: 400us
`;
