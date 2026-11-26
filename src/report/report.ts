/**
 * Report assembly.
 *
 * One bundle feeds three renderers (Markdown, HTML, and the CLI summary), so a
 * report can never disagree with another report about the same run. Every number
 * here is either derived from the model, solved by the response-time analysis,
 * or produced by the simulator trace.
 */

import type { DerivedModel } from '../core/derive.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { taskPeriodUs } from '../core/derive.js';
import type { SystemModel } from '../core/model.js';
import { formatDuration, type Micros } from '../core/units.js';
import type { RtaReport, TaskRta } from '../analysis/rta.js';
import type { SimResult } from '../sim/engine.js';
import { TOOL_VERSION } from '../version.js';
import { escapeXml, renderGantt } from './svg.js';

export interface ReportBundle {
  readonly model: SystemModel;
  readonly derived: DerivedModel;
  readonly rta: RtaReport;
  readonly sim?: SimResult;
  readonly generatedAt: string;
}

export interface ReportSummary {
  readonly verdict: string;
  readonly tasks: number;
  readonly utilization: number;
  readonly worstSlackUs: number;
  readonly misses: number;
  readonly inversions: number;
  readonly errors: number;
  readonly warnings: number;
}

export function summarize(bundle: ReportBundle): ReportSummary {
  const diagnostics = allDiagnostics(bundle);
  // Aperiodic tasks have no deadline to compare against, so their slack is not
  // a meaningful "worst" for the report header.
  const slack = bundle.rta.tasks.filter((task) => task.deadlineMet !== null).map((task) => task.slackUs);
  return {
    verdict: bundle.rta.verdict,
    tasks: bundle.model.tasks.length,
    utilization: bundle.derived.totalUtilization,
    worstSlackUs: slack.length ? Math.min(...slack) : 0,
    misses: bundle.sim?.deadlineMisses.length ?? 0,
    inversions: bundle.sim?.inversions.length ?? 0,
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
  };
}

export function allDiagnostics(bundle: ReportBundle): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  const add = (diagnostic: Diagnostic) => {
    const key = diagnostic.code + '|' + diagnostic.message + '|' + (diagnostic.path ?? '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(diagnostic);
  };
  for (const diagnostic of bundle.rta.diagnostics) add(diagnostic);
  for (const diagnostic of bundle.sim?.diagnostics ?? []) add(diagnostic);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

export function renderMarkdown(bundle: ReportBundle): string {
  const { model, derived, rta, sim } = bundle;
  const summary = summarize(bundle);
  const lines: string[] = [];
  lines.push('# ' + model.name + ' — scheduling report');
  lines.push('');
  if (model.description) {
    lines.push('> ' + model.description.replace(/\s+/g, ' ').trim());
    lines.push('');
  }
  lines.push('Generated ' + bundle.generatedAt + ' by Scheduloscope ' + TOOL_VERSION + '.');
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push('**' + rta.verdict + '** · ' + String(summary.tasks) + ' tasks · utilization ' + percent(summary.utilization) +
    ' · worst slack ' + formatDuration(summary.worstSlackUs) + ' · hyperperiod ' + formatDuration(derived.hyperperiodUs));
  if (sim) {
    lines.push('');
    lines.push('Simulated ' + formatDuration(sim.horizonUs) + ': ' + String(sim.completedJobs) + ' jobs completed, ' +
      String(sim.deadlineMisses.length) + ' deadline misses, ' + String(sim.inversions.length) + ' priority inversions, ' +
      String(sim.contextSwitches) + ' context switches.');
  }
  lines.push('');
  lines.push('## Task set');
  lines.push('');
  lines.push('| Task | Policy | Priority | Period | Execution | Deadline | Shared with |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const task of model.tasks) {
    const cost = derived.costs.get(task.name);
    lines.push('| ' + task.name + ' | ' + task.policy + ' | ' + String(task.priority) + ' | ' +
      formatDuration(taskPeriodUs(task)) + ' | ' + formatDuration(cost?.executionUs ?? 0) + ' | ' +
      deadlineText(task.deadlineUs) + ' | ' + (sharedWith(task) || '—') + ' |');
  }
  lines.push('');
  lines.push('## Response-time analysis');
  lines.push('');
  lines.push('| Task | C | B | I | ISR | R | D | Slack | Result |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const task of rta.tasks) {
    lines.push('| ' + task.name + ' | ' + formatDuration(task.executionUs) + ' | ' + formatDuration(task.blockingUs) + ' | ' +
      formatDuration(task.interferenceUs) + ' | ' + formatDuration(task.interruptUs) + ' | ' + formatDuration(task.responseUs) + ' | ' +
      deadlineText(task.deadlineUs) + ' | ' + slackText(task.slackUs, task.deadlineUs) + ' | ' + verdictCell(task) + ' |');
  }
  lines.push('');
  const blocking = rta.tasks.filter((task) => task.blocking.length > 0);
  if (blocking.length > 0) {
    lines.push('### Where the blocking comes from');
    lines.push('');
    for (const task of blocking) {
      lines.push('- **' + task.name + '** (' + formatDuration(task.blockingUs) + ')');
      for (const term of task.blocking) lines.push('  - ' + term.detail + ' — ' + formatDuration(term.us));
    }
    lines.push('');
  }
  if (sim) {
    lines.push('## Simulation');
    lines.push('');
    lines.push('| Task | Activations | Completed | Unfinished | Max | Mean | Jitter | Misses |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const task of sim.tasks) {
      lines.push('| ' + task.name + ' | ' + String(task.activations) + ' | ' + String(task.completed) + ' | ' +
        String(task.unfinished) + ' | ' + formatDuration(task.maxResponseUs) + ' | ' + formatDuration(task.meanResponseUs) + ' | ' +
        formatDuration(task.jitterUs) + ' | ' + String(task.misses) + ' |');
    }
    lines.push('');
    if (sim.inversions.length > 0) {
      lines.push('### Priority inversions');
      lines.push('');
      lines.push('| Task | Blocked by | Resource | Duration | Mitigated |');
      lines.push('| --- | --- | --- | ---: | --- |');
      for (const inversion of sim.inversions) {
        lines.push('| ' + inversion.task + ' | ' + inversion.blocker + ' | ' + inversion.resource + ' | ' +
          formatDuration(inversion.durationUs) + ' | ' + (inversion.mitigated ? 'yes' : '**no**') + ' |');
      }
    }
    if (sim.deadlineMisses.length > 0) {
      lines.push('### Deadline misses');
      lines.push('');
      lines.push('| Task | Job | Released | Completed | Lateness | Dominant cause |');
      lines.push('| --- | ---: | ---: | ---: | ---: | --- |');
      for (const miss of sim.deadlineMisses.slice(0, 20)) {
        lines.push('| ' + miss.task + ' | ' + String(miss.job) + ' | ' + formatDuration(miss.release) + ' | ' +
          formatDuration(miss.completion) + ' | ' + formatDuration(miss.latenessUs) + ' | ' + miss.cause + ' |');
      }
      if (sim.deadlineMisses.length > 20) {
        lines.push('');
        lines.push('_Showing the first 20 of ' + String(sim.deadlineMisses.length) + ' misses._');
      }
    }
    lines.push('');
  }
  const diagnostics = allDiagnostics(bundle);
  if (diagnostics.length > 0) {
    lines.push('## Diagnostics');
    lines.push('');
    for (const diagnostic of diagnostics) {
      lines.push('- **' + diagnostic.severity + '** `' + diagnostic.code + '` ' + diagnostic.message +
        (diagnostic.path ? ' _(' + diagnostic.path + ')_' : ''));
      if (diagnostic.hint) lines.push('  - ' + diagnostic.hint);
    }
    lines.push('');
  }
  lines.push('## Assumptions');
  lines.push('');
  for (const caveat of baseAssumptions(model)) lines.push('- ' + caveat);
  for (const caveat of rta.caveats) lines.push('- ' + caveat);
  lines.push('');
  lines.push('_Response-time bounds are analytical worst cases. The simulation is one deterministic schedule of the same model; a simulated latency above its bound is a modelling bug, not a nicer number._');
  lines.push('');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* HTML                                                                       */
/* -------------------------------------------------------------------------- */

export function renderHtml(bundle: ReportBundle): string {
  const { model, derived, rta, sim } = bundle;
  const summary = summarize(bundle);
  const diagnostics = allDiagnostics(bundle);
  const body: string[] = [];

  body.push('<header>');
  body.push('<p class="eyebrow">Scheduloscope ' + TOOL_VERSION + ' · QNX OS 8.0 scheduling report</p>');
  body.push('<h1>' + escapeXml(model.name) + '</h1>');
  if (model.description) body.push('<p class="lede">' + escapeXml(model.description.replace(/\s+/g, ' ').trim()) + '</p>');
  body.push('<div class="verdict ' + rta.verdict + '"><span class="pill">' + rta.verdict + '</span>' +
    '<span>' + String(summary.tasks) + ' tasks</span>' +
    '<span>' + percent(summary.utilization) + ' utilization</span>' +
    '<span>worst slack ' + formatDuration(summary.worstSlackUs) + '</span>' +
    '<span>hyperperiod ' + formatDuration(derived.hyperperiodUs) + '</span></div>');
  body.push('<p class="meta">Generated ' + escapeXml(bundle.generatedAt) + '.</p>');
  body.push('</header>');

  body.push('<section><h2>Task set</h2>' + table(
    ['Task', 'Policy', 'Priority', 'Period', 'Execution', 'Deadline', 'Shared with'],
    model.tasks.map((task) => {
      const cost = derived.costs.get(task.name);
      return [task.name, task.policy, String(task.priority), formatDuration(taskPeriodUs(task)),
        formatDuration(cost?.executionUs ?? 0), deadlineText(task.deadlineUs), sharedWith(task) || '—'];
    }),
    ['', '', 'num', 'num', 'num', 'num', ''],
  ) + '</section>');

  body.push('<section><h2>Response-time analysis</h2>');
  body.push('<p class="note">R = C + B + I + ISR, solved to the least fixed point. A task is schedulable when R ≤ D.</p>');
  body.push(table(
    ['Task', 'C', 'B', 'I', 'ISR', 'R', 'D', 'Slack', 'Result'],
    rta.tasks.map((task) => [task.name, formatDuration(task.executionUs), formatDuration(task.blockingUs),
      formatDuration(task.interferenceUs), formatDuration(task.interruptUs), formatDuration(task.responseUs),
      deadlineText(task.deadlineUs), slackText(task.slackUs, task.deadlineUs), verdictCell(task)]),
    ['', 'num', 'num', 'num', 'num', 'num', 'num', 'num', ''],
  ));
  const blocking = rta.tasks.filter((task) => task.blocking.length > 0);
  if (blocking.length > 0) {
    body.push('<h3>Blocking decomposition</h3><ul class="tight">');
    for (const task of blocking) {
      body.push('<li><strong>' + escapeXml(task.name) + '</strong> ' + formatDuration(task.blockingUs) + '<ul>');
      for (const term of task.blocking) body.push('<li>' + escapeXml(term.detail) + ' — ' + formatDuration(term.us) + '</li>');
      body.push('</ul></li>');
    }
    body.push('</ul>');
  }
  body.push('</section>');

  if (sim) {
    body.push('<section><h2>Simulated schedule</h2>');
    const windowUs = timelineWindow(bundle);
    body.push('<p class="note">Deterministic discrete-event simulation of the same model, seed ' + String(sim.seed) +
      '. Showing the first ' + formatDuration(windowUs) + ' of ' + formatDuration(sim.horizonUs) +
      '; hover a slice for its timing.</p>');
    body.push('<figure class="chart">' + renderGantt(sim, { endUs: windowUs }) + '</figure>');
    body.push(table(
      ['Task', 'Activations', 'Completed', 'Unfinished', 'Max', 'Mean', 'Jitter', 'Misses'],
      sim.tasks.map((task) => [task.name, String(task.activations), String(task.completed), String(task.unfinished),
        formatDuration(task.maxResponseUs), formatDuration(task.meanResponseUs), formatDuration(task.jitterUs), String(task.misses)]),
      ['', 'num', 'num', 'num', 'num', 'num', 'num', 'num'],
    ));
    body.push('<p class="note">Kernel time ' + formatDuration(sim.kernelUs) + ' · interrupt time ' + formatDuration(sim.irqUs) +
      ' · idle ' + formatDuration(sim.idleUs) + ' · ' + String(sim.contextSwitches) + ' context switches.</p>');
    if (sim.inversions.length > 0) {
      body.push('<h3>Priority inversions</h3>');
      body.push(table(['Task', 'Blocked by', 'Resource', 'Duration', 'Mitigated'],
        sim.inversions.map((inversion) => [inversion.task, inversion.blocker, inversion.resource,
          formatDuration(inversion.durationUs), inversion.mitigated ? 'yes' : 'no']),
        ['', '', '', 'num', '']));
    }
    if (sim.deadlineMisses.length > 0) {
      body.push('<h3>Deadline misses</h3>');
      body.push(table(['Task', 'Job', 'Released', 'Completed', 'Lateness', 'Dominant cause'],
        sim.deadlineMisses.slice(0, 25).map((miss) => [miss.task, String(miss.job), formatDuration(miss.release),
          formatDuration(miss.completion), formatDuration(miss.latenessUs), miss.cause]),
        ['', 'num', 'num', 'num', 'num', '']));
    }
    body.push('</section>');
  }

  if (diagnostics.length > 0) {
    body.push('<section><h2>Diagnostics</h2><ul class="diagnostics">');
    for (const diagnostic of diagnostics) {
      body.push('<li class="' + diagnostic.severity + '"><code>' + escapeXml(diagnostic.code) + '</code> ' +
        escapeXml(diagnostic.message) + (diagnostic.path ? ' <span class="path">' + escapeXml(diagnostic.path) + '</span>' : ''));
      if (diagnostic.hint) body.push('<div class="hint">' + escapeXml(diagnostic.hint) + '</div>');
      body.push('</li>');
    }
    body.push('</ul></section>');
  }

  body.push('<section><h2>Assumptions</h2><ul class="tight">');
  for (const caveat of baseAssumptions(model)) body.push('<li>' + escapeXml(caveat) + '</li>');
  for (const caveat of rta.caveats) body.push('<li>' + escapeXml(caveat) + '</li>');
  body.push('</ul>');
  body.push('<p class="note">Response-time bounds are analytical worst cases; the simulation is one deterministic schedule of the same model.</p>');
  body.push('</section>');

  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeXml(model.name) + ' — Scheduloscope</title>' + STYLE + '</head><body>' + body.join('') + '</body></html>\n';
}

const STYLE = [
  '<style>',
  ':root { color-scheme: dark; --bg: #0d1117; --panel: #12171f; --line: #232a35; --text: #e6edf3; --muted: #8b949e; --accent: #4f8cff; --good: #3fb950; --warn: #d29922; --bad: #f85149; }',
  '* { box-sizing: border-box; }',
  'body { margin: 0 auto; max-width: 1080px; padding: 40px 24px 80px; background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, Segoe UI, sans-serif; }',
  'h1 { font-size: 34px; margin: 4px 0 8px; letter-spacing: -0.02em; }',
  'h2 { font-size: 20px; margin: 0 0 12px; }',
  'h3 { font-size: 13px; margin: 22px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }',
  '.eyebrow { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; margin: 0; }',
  '.lede { color: #b9c2cc; max-width: 70ch; }',
  '.meta { color: var(--muted); font-size: 12px; }',
  'section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 22px; margin: 22px 0; }',
  '.verdict { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--line); background: #0f141b; }',
  '.pill { padding: 3px 10px; border-radius: 999px; font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }',
  '.schedulable .pill { background: rgba(63,185,80,0.15); color: var(--good); }',
  '.unschedulable .pill { background: rgba(248,81,73,0.15); color: var(--bad); }',
  '.inconclusive .pill { background: rgba(210,153,34,0.15); color: var(--warn); }',
  'table { width: 100%; border-collapse: collapse; font-size: 13.5px; }',
  'th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }',
  'th { color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; }',
  'td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }',
  'tr:last-child td { border-bottom: none; }',
  '.note { color: var(--muted); font-size: 12.5px; }',
  '.chart { margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }',
  'ul.tight { margin: 0; padding-left: 18px; }',
  'ul.tight > li { margin: 2px 0; }',
  'ul.diagnostics { list-style: none; margin: 0; padding: 0; }',
  'ul.diagnostics li { padding: 10px 0; border-bottom: 1px solid var(--line); }',
  'ul.diagnostics li:last-child { border-bottom: none; }',
  'code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b0f16; padding: 2px 6px; border-radius: 4px; }',
  'li.error code { color: var(--bad); }',
  'li.warning code { color: var(--warn); }',
  'li.info code { color: var(--accent); }',
  '.path { color: var(--muted); font: 12px ui-monospace, monospace; }',
  '.hint { color: var(--muted); font-size: 13px; margin-top: 4px; }',
  '.ok { color: var(--good); } .no { color: var(--bad); } .na { color: var(--muted); }',
  '</style>',
].join('');

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function table(headers: readonly string[], rows: readonly (readonly string[])[], classes: readonly string[]): string {
  const head = headers
    .map((header, index) => '<th' + (classes[index] === 'num' ? ' class="num"' : '') + '>' + escapeXml(header) + '</th>')
    .join('');
  const body = rows
    .map((cells) => '<tr>' + cells.map((cell, index) => {
      if (index === cells.length - 1 && (cell === 'met' || cell === 'missed' || cell === 'n/a')) {
        return '<td class="' + (cell === 'met' ? 'ok' : cell === 'missed' ? 'no' : 'na') + '">' + cell + '</td>';
      }
      return '<td' + (classes[index] === 'num' ? ' class="num"' : '') + '>' + escapeXml(cell) + '</td>';
    }).join('') + '</tr>')
    .join('');
  return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
}

function verdictCell(task: TaskRta): string {
  if (task.deadlineMet === null) return 'n/a';
  return task.deadlineMet ? 'met' : 'missed';
}

/** A zero relative deadline means the aperiodic task has none. */
function deadlineText(us: Micros): string {
  return us > 0 ? formatDuration(us) : 'none';
}

function slackText(us: Micros, deadline: Micros): string {
  return deadline > 0 ? formatDuration(us) : '—';
}

export function percent(value: number): string {
  return (value * 100).toFixed(1) + '%';
}

function sharedWith(task: { readonly segments: readonly SegmentLike[] }): string {
  const names = new Set<string>();
  for (const segment of task.segments) {
    if (segment.kind === 'cs' && segment.resource) names.add(segment.resource);
    else if (segment.kind === 'rpc' && segment.channel) names.add(segment.channel);
  }
  return [...names].join(', ');
}

interface SegmentLike {
  readonly kind: string;
  readonly resource?: string;
  readonly channel?: string;
}

/**
 * Show roughly six periods of the fastest task: an entire hyperperiod makes
 * a 1 ms control loop a few pixels wide and hides the thing worth looking at.
 */
function timelineWindow(bundle: ReportBundle): Micros {
  const sim = bundle.sim;
  if (!sim) return 0;
  const periods = bundle.model.tasks.map((task) => taskPeriodUs(task));
  const fastest = periods.length > 0 ? Math.min(...periods) : sim.horizonUs;
  return Math.min(sim.horizonUs, Math.max(fastest * 6, 2000));
}

function baseAssumptions(model: SystemModel): string[] {
  return [
    'Single core: one thread runs at a time and priorities are a total order.',
    'Durations are microseconds of pure CPU time on the target; measure them on hardware before trusting a bound.',
    'QNX mutexes default to PTHREAD_PRIO_INHERIT; a mutex is only unbounded when the model says protocol: none.',
    'A server inherits the priority of the client it is serving and keeps it after MsgReply, as QNX documents.',
    'Interrupt service threads preempt every application thread; the clock IST runs at 254 and the IPI IST at 255.',
    'Clock period ' + formatDuration(model.clock.periodUs) + ', round-robin timeslice ' + String(model.clock.roundRobinTimesliceTicks) +
      ' ticks, context switch ' + formatDuration(model.cpu.contextSwitchUs) + '.',
  ];
}
