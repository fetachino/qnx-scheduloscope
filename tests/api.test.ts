import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeResponseTimes,
  derive,
  generateQnxHarness,
  parseModel,
  renderHtml,
  simulate,
  summarize,
  validateModel,
} from '../src/index.js';
import { MINIMAL } from './helpers.js';

test('the public entry point runs the whole pipeline', () => {
  const { model, diagnostics } = parseModel(MINIMAL);
  assert.ok(model, 'the minimal model must parse');
  assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0);
  assert.equal(validateModel(model).filter((d) => d.severity === 'error').length, 0);

  const derived = derive(model);
  const analysis = analyzeResponseTimes(model, derived);
  assert.equal(analysis.verdict, 'schedulable');

  const sim = simulate(model);
  assert.equal(sim.deadlineMisses.length, 0);

  const bundle = {
    model,
    derived,
    rta: analysis,
    sim,
    diagnostics,
    generatedAt: '2026-01-01T00:00:00Z',
  };
  assert.equal(summarize(bundle).verdict, 'schedulable');
  assert.match(renderHtml(bundle), /<svg/);

  const harness = generateQnxHarness(model, derived);
  assert.ok(harness.files.some((file) => file.path === 'platform_qnx.c'));
});

