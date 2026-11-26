import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeResponseTimes } from '../src/analysis/rta.js';
import { derive } from '../src/core/derive.js';
import { parseStrict, TWO_TASKS } from './helpers.js';
import { allDiagnostics, percent, renderHtml, renderMarkdown, summarize, type ReportBundle } from '../src/report/report.js';
import { simulate } from '../src/sim/engine.js';

function bundle(source = TWO_TASKS): ReportBundle {
  const model = parseStrict(source);
  const derived = derive(model);
  const rta = analyzeResponseTimes(model, derived);
  const sim = simulate(model, { durationUs: 20_000 });
  return { model, derived, rta, sim, generatedAt: '2026-01-01T00:00:00Z' };
}

test('summarize reports the numbers a reader cares about', () => {
  const summary = summarize(bundle());
  assert.equal(summary.tasks, 2);
  assert.equal(summary.verdict, 'schedulable');
  assert.equal(summary.misses, 0);
  assert.ok(summary.utilization > 0.15 && summary.utilization < 0.25);
  assert.equal(summary.worstSlackUs, 1000 - 104, 'the fastest task has the least slack');
});

test('markdown contains the analysis, the timeline note and no unfilled placeholders', () => {
  const markdown = renderMarkdown(bundle());
  assert.match(markdown, /two-tasks/);
  assert.match(markdown, /Response-time analysis/);
  assert.match(markdown, /\| fast \|/);
  assert.doesNotMatch(markdown, /undefined|NaN|\{\{/);
});

test('html is self-contained and embeds the generated SVG', () => {
  const html = renderHtml(bundle());
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<svg /);
  assert.match(html, /<title>two-tasks — Scheduloscope<\/title>/);
  assert.doesNotMatch(html, /undefined|NaN/);
  assert.doesNotMatch(html, /src="http/, 'no external assets: the report must open offline');
});

test('html escapes model-provided text instead of injecting it', () => {
  const source = TWO_TASKS.replace('name: fast', 'name: <script>alert(1)</script>');
  const html = renderHtml(bundle(source));
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('diagnostics from every stage are merged without duplicates', () => {
  const merged = allDiagnostics(bundle());
  const keys = merged.map((d) => d.code + d.message + (d.path ?? ''));
  assert.equal(new Set(keys).size, keys.length);
});

test('an aperiodic task with no deadline is shown as none, not 0us', () => {
  const source = TWO_TASKS + ['  - name: events', '    priority: 10', '    meanInterarrival: 15ms', '    segments:', '      - cpu: 100us', ''].join('\n');
  const markdown = renderMarkdown(bundle(source));
  assert.match(markdown, /\| events \| fifo \| 10 \| 15ms \| [0-9.]+us \| none \|/);
  assert.doesNotMatch(markdown, /\| events \|[^\n]*\| 0us \|/);
  const html = renderHtml(bundle(source));
  assert.match(html, />none</);
});

test('percent renders a stable two-decimal figure', () => {
  assert.equal(percent(0.2), '20.0%');
  assert.equal(percent(0.12345), '12.3%');
});
