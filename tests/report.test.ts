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

test('html points to the native QNX evidence without claiming a target measurement', () => {
  const html = renderHtml(bundle());
  assert.match(html, /compiled with QNX SDP 8\.0\.6 and booted in QEMU/);
  assert.match(html, /x86_64 KVM; AArch64 TCG/);
  assert.match(html, /No number in this report is a target measurement/);
  assert.doesNotMatch(html, /No QNX SDP was available/);
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

test('html exposes accessible landmarks, navigation and a table alternative', () => {
  const html = renderHtml(bundle());
  assert.match(html, /class="skip-link" href="#main"/);
  assert.match(html, /<main id="main"/);
  for (const id of ['overview', 'tasks', 'analysis', 'timeline', 'diagnostics', 'terms', 'assumptions']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing report section #' + id);
  }
  assert.match(html, /<nav class="report-nav" aria-label="Report sections">/);
  assert.match(html, /<dl class="terms">/);
  assert.match(html, /<th scope="col"/);
  assert.match(html, /role="img" aria-labelledby="ss-gantt-title ss-gantt-desc"/);
  assert.match(html, /<title id="ss-gantt-title">Simulated scheduler timeline<\/title>/);
  assert.match(html, /<desc id="ss-gantt-desc">/);
  assert.match(html, /Inspect timeline slices as a table/);
  assert.doesNotMatch(html, /<script\b/, 'the report should not need JavaScript');
});

test('html marks an unbounded blocking term as a lower bound, not a pass', () => {
  const source = [
    'schema: scheduloscope/v1',
    'name: unbounded-lock',
    'resources:',
    '  - name: lock',
    '    protocol: none',
    'tasks:',
    '  - name: high',
    '    priority: 60',
    '    period: 1ms',
    '    deadline: 1ms',
    '    segments:',
    '      - cpu: 100us',
    '      - cs: { resource: lock, work: 50us }',
    '  - name: low',
    '    priority: 10',
    '    period: 10ms',
    '    deadline: 10ms',
    '    segments:',
    '      - cpu: 100us',
    '      - cs: { resource: lock, work: 100us }',
    '',
  ].join('\n');
  const html = renderHtml(bundle(source));
  assert.match(html, /Lower bound only/);
  assert.match(html, /B is a lower bound, so R can grow beyond the value shown/);
  assert.match(html, /A <strong>lower bound<\/strong> result uses a finite lower bound/);
  assert.match(html, /<td>lower bound<\/td>/);
});

test('html states the model boundary and explains the analysis terms', () => {
  const html = renderHtml(bundle());
  assert.match(html, /This is a model, not a QNX measurement/);
  assert.match(html, /<link rel="icon"/);
  assert.match(html, /R = C \+ B \+ I \+ ISR/);
  assert.match(html, /Worst-case response-time analysis/);
  assert.match(html, /Priority inheritance/);
  assert.match(html, />n\/a</);
});
