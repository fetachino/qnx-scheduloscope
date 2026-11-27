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
import type { Segment, SystemModel, TaskModel } from '../core/model.js';
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
  if (rta.tasks.some(hasUnboundedBlocking)) {
    lines.push('_A "lower bound" result treats a mutex with inheritance disabled as a finite lower bound. It is not a deadline guarantee._');
    lines.push('');
  }
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
  lines.push('_Response-time bounds are analytical worst cases when the analysis proves them; a lower-bound result is a floor. The simulation is one deterministic schedule of the same model; a simulated latency above its bound is a modelling bug, not a nicer number._');
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
  const rtaByName = new Map(rta.tasks.map((task) => [task.name, task]));
  const deadlineTasks = rta.tasks.filter((task) => task.deadlineMet !== null);
  const worstSlack = deadlineTasks.length > 0 ? Math.min(...deadlineTasks.map((task) => task.slackUs)) : null;
  const infoCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'info').length;
  const mitigated = sim ? sim.inversions.filter((inversion) => inversion.mitigated).length : 0;
  const unbounded = sim ? sim.inversions.length - mitigated : 0;
  const body: string[] = [];

  body.push('<a class="skip-link" href="#main">Skip to report content</a>');
  body.push('<header class="site-head"><div class="head-inner">' +
    '<a class="brand" href="https://fetachino.github.io/qnx-scheduloscope/" aria-label="Scheduloscope project home">Schedulo<span>scope</span></a>' +
    '<span class="model-tag">Model report</span>' +
    '<nav class="report-nav" aria-label="Report sections">' +
    '<a href="#overview">Overview</a><a href="#tasks">Tasks</a><a href="#analysis">Analysis</a>' +
    (sim ? '<a href="#timeline">Timeline</a>' : '') +
    '<a href="#diagnostics">Diagnostics</a><a href="#terms">Key terms</a></nav>' +
    '</div></header>');

  body.push('<main id="main" class="page">');
  body.push('<header id="overview" class="report-hero">');
  body.push('<div class="hero-copy">');
  body.push('<p class="eyebrow">Scheduloscope ' + TOOL_VERSION + ' · QNX OS 8.0 scheduling model report</p>');
  body.push('<h1>' + escapeXml(model.name) + '</h1>');
  if (model.description) body.push('<p class="lede">' + escapeXml(model.description.replace(/\s+/g, ' ').trim()) + '</p>');
  body.push('<p class="hero-meta"><span>Generated ' + escapeXml(bundle.generatedAt) + '</span><span>Model output, not a target measurement</span></p>');
  body.push('</div>');
  body.push('<aside class="status-panel status-' + rta.verdict + '" aria-label="Scheduling verdict">' +
    '<div class="status-line">' + verdictBadge(rta.verdict) + '<span class="status-kicker">Analytical verdict</span></div>' +
    '<p class="status-copy">' + escapeXml(verdictExplanation(bundle)) + '</p>' +
    '<p class="status-footnote">' + (rta.verdict === 'schedulable' ? 'A proof for this model under the assumptions below.' :
      rta.verdict === 'unschedulable' ? 'Reduce the blocking or execution demand, then re-run the analysis.' :
      'Treat a result marked lower bound, and its slack, as a floor rather than a guarantee.') + '</p>' +
    '</aside>');
  body.push('</header>');

  body.push('<section class="boundary callout" aria-labelledby="boundary-title">' +
    '<div class="callout-mark" aria-hidden="true">i</div><div>' +
    '<h2 id="boundary-title">This is a model, not a QNX measurement</h2>' +
    '<p>Response-time bounds come from fixed-priority analysis; the timeline is one deterministic simulation of the same model. No number in this report is a target measurement. A separate generated QNX harness was compiled and booted in QEMU during Phase 3B; its evidence and the remaining hardware gap are in docs/verification.md.</p>' +
    '</div></section>');

  body.push('<section class="metric-section" aria-labelledby="metrics-title">');
  body.push('<div class="section-head compact"><div><p class="kicker">At a glance</p><h2 id="metrics-title">The numbers behind the verdict</h2></div>' +
    '<p class="section-note">Analytical figures and simulated observations are kept separate.</p></div>');
  body.push('<div class="metric-groups">');
  body.push('<div><p class="metric-group-label">Analysis</p><div class="metric-grid">' +
    metricCard('Tasks', String(summary.tasks), 'threads in the model') +
    metricCard('Utilization', percent(summary.utilization), 'modeled CPU demand, excluding aperiodic arrivals', summary.utilization > 1 ? 'bad' : '') +
    metricCard(rta.verdict === 'inconclusive' ? 'Smallest reported slack' : 'Worst analytical slack', worstSlack === null ? '—' : formatDuration(worstSlack), worstSlack === null ? 'no task in this model has a deadline' : rta.verdict === 'inconclusive' ? 'smallest reported D − R; some bounds are not guarantees' : 'smallest D − R among tasks with deadlines', worstSlack !== null && worstSlack < 0 ? 'bad' : '') +
    metricCard('Hyperperiod', formatDuration(derived.hyperperiodUs), 'least common multiple of the periodic periods') +
    '</div></div>');
  if (sim) {
    body.push('<div><p class="metric-group-label">Simulation · one deterministic schedule</p><div class="metric-grid">' +
      metricCard('Simulated window', formatDuration(sim.horizonUs), 'the horizon in this run') +
      metricCard('Completed jobs', String(sim.completedJobs), 'jobs that finished in the window') +
      metricCard('Deadline misses', String(sim.deadlineMisses.length), 'observed in this schedule; not a bound', sim.deadlineMisses.length > 0 ? 'bad' : 'good') +
      metricCard('Priority inversions', String(sim.inversions.length), mitigated + ' mitigated · ' + unbounded + ' unbounded', unbounded > 0 ? 'bad' : '') +
      '</div></div>');
  }
  body.push('</div></section>');

  body.push('<section class="guide" aria-labelledby="guide-title">' +
    '<div class="guide-intro"><p class="kicker">Reading guide</p><h2 id="guide-title">Follow the evidence, not just the verdict</h2>' +
    '<p>Start here if this is your first Scheduloscope report.</p></div>' +
    '<ol class="guide-steps">' +
    '<li><span class="step-num" aria-hidden="true">1</span><div><strong>Read the verdict</strong><p>It says whether the model proves every deadline. The caveats below still matter.</p></div></li>' +
    '<li><span class="step-num" aria-hidden="true">2</span><div><strong>Check the bound</strong><p>R is the analytical response bound. Compare R with D; slack is the room left over. A lower-bound result is a floor.</p></div></li>' +
    '<li><span class="step-num" aria-hidden="true">3</span><div><strong>Inspect the schedule</strong><p>The timeline shows one possible run, including blocking and preemption that a table cannot.</p></div></li>' +
    '</ol>' +
    '<p class="guide-link"><a href="#terms">Read the key terms</a></p>' +
    '</section>');

  body.push('<section id="tasks" class="report-section" aria-labelledby="tasks-title">');
  body.push('<div class="section-head"><div><p class="kicker">1 · Workload</p><h2 id="tasks-title">Task set</h2></div>' +
    '<p class="section-note">A task is one thread with a priority, an activation pattern, and a program of CPU, critical-section, or server work. Higher QNX priority numbers run first.</p></div>');
  body.push('<div class="task-grid">');
  for (const task of model.tasks) {
    const taskRta = rtaByName.get(task.name);
    body.push(taskCard(task, taskRta));
  }
  body.push('</div>');
  body.push('<details class="disclosure table-disclosure"><summary>Compare the task set as a table</summary>');
  body.push(table(
    ['Task', 'Policy', 'Priority', 'Period', 'Execution', 'Deadline', 'Shared with'],
    model.tasks.map((task) => {
      const cost = derived.costs.get(task.name);
      return [task.name, task.policy, String(task.priority), formatDuration(taskPeriodUs(task)),
        formatDuration(cost?.executionUs ?? 0), deadlineText(task.deadlineUs), sharedWith(task) || '—'];
    }),
    ['', '', 'num', 'num', 'num', 'num', ''],
    'Task set table',
  ));
  body.push('</details>');
  body.push('</section>');

  body.push('<section id="analysis" class="report-section" aria-labelledby="analysis-title">');
  body.push('<div class="section-head"><div><p class="kicker">2 · Analysis</p><h2 id="analysis-title">Response-time analysis</h2></div>' +
    '<p class="section-note">Response is solved to a least fixed point for the single-core fixed-priority model. A task is proven schedulable when R ≤ D; a lower-bound result is a floor, not a proof.</p></div>');
  body.push('<div class="formula-card"><code>R = C + B + I + ISR</code><p>C is execution, B is blocking, I is interference from higher-priority work, and ISR is interrupt service. The table is the authoritative result.</p></div>');
  body.push(table(
    ['Task', 'C', 'B', 'I', 'ISR', 'R', 'D', 'Slack', 'Result'],
    rta.tasks.map((task) => [task.name, formatDuration(task.executionUs), formatDuration(task.blockingUs),
      formatDuration(task.interferenceUs), formatDuration(task.interruptUs), formatDuration(task.responseUs),
      deadlineText(task.deadlineUs), slackText(task.slackUs, task.deadlineUs), verdictCell(task)]),
    ['', 'num', 'num', 'num', 'num', 'num', 'num', 'num', ''],
    'Response-time analysis table',
  ));
  body.push('<dl class="inline-terms">' +
    '<div><dt>C</dt><dd>execution demand per job</dd></div>' +
    '<div><dt>B</dt><dd>blocking from shared resources or channels</dd></div>' +
    '<div><dt>I</dt><dd>interference from higher-priority jobs</dd></div>' +
    '<div><dt>ISR</dt><dd>interrupt service time</dd></div>' +
    '<div><dt>R / D</dt><dd>response bound / relative deadline</dd></div>' +
    '<div><dt>n/a</dt><dd>no deadline guarantee (aperiodic task)</dd></div>' +
    '</dl>');
  if (rta.tasks.some(hasUnboundedBlocking)) {
    body.push('<p class="section-note">A <strong>lower bound</strong> result uses a finite lower bound for a mutex with inheritance disabled. It is not a deadline guarantee; see the blocking decomposition.</p>');
  }
  body.push(responseBars(rta.tasks));
  const blocking = rta.tasks.filter((task) => task.blocking.length > 0);
  if (blocking.length > 0) {
    body.push('<details class="disclosure"><summary>Blocking decomposition</summary><ul class="blocking-list">');
    for (const task of blocking) {
      body.push('<li><strong>' + escapeXml(task.name) + '</strong> · ' + formatDuration(task.blockingUs) + '<ul>');
      for (const term of task.blocking) body.push('<li>' + escapeXml(term.detail) + ' — ' + formatDuration(term.us) + '</li>');
      body.push('</ul></li>');
    }
    body.push('</ul></details>');
  }
  body.push('</section>');

  if (sim) {
    const windowUs = timelineWindow(bundle);
    body.push('<section id="timeline" class="report-section" aria-labelledby="timeline-title">');
    body.push('<div class="section-head"><div><p class="kicker">3 · Schedule</p><h2 id="timeline-title">Simulated schedule</h2></div>' +
      '<p class="section-note">One deterministic discrete-event run of the same model, seed ' + String(sim.seed) + '. It shows what can happen; it is not a measured QNX trace.</p></div>');
    body.push('<figure class="chart-figure">');
    body.push('<div class="chart-top"><div><h3>First ' + formatDuration(windowUs) + ' of ' + formatDuration(sim.horizonUs) + '</h3>' +
      '<p class="chart-meta">Lane by lane; hover a slice for its timing, or open the table alternative below.</p></div></div>');
    body.push('<p class="chart-scroll-hint">Narrow screen: scroll the chart sideways to see the full window and legend.</p>');
    body.push('<div class="chart-scroll" tabindex="0" role="region" aria-label="Simulated scheduler timeline. Scroll horizontally to see the full window.">' +
      renderGantt(sim, { endUs: windowUs }) + '</div>');
    body.push('<figcaption><strong>How to read it:</strong> a filled bar is a slice of runtime in that lane. A gap in a pending task lane means it was not running: it was preempted, queued, or blocked. The critical-section lane shows the holder. The chart is an enlarged first window, not the whole simulation.</figcaption>');
    body.push('</figure>');
    body.push(renderTimelineTable(sim, windowUs));
    body.push('<div class="chart-boundary"><strong>Not a hardware trace.</strong> These slices come from the simulator. QNX timing requires the generated harness to run on a target.</div>');
    body.push('<h3 class="subhead">Per-task simulated behavior</h3>');
    body.push('<p class="section-note">Max, mean, and jitter are observations from this one run. Use the RTA table for the worst-case bound.</p>');
    body.push(table(
      ['Task', 'Activations', 'Completed', 'Unfinished', 'Max', 'Mean', 'Jitter', 'Misses'],
      sim.tasks.map((task) => [task.name, String(task.activations), String(task.completed), String(task.unfinished),
        formatDuration(task.maxResponseUs), formatDuration(task.meanResponseUs), formatDuration(task.jitterUs), String(task.misses)]),
      ['', 'num', 'num', 'num', 'num', 'num', 'num', 'num'],
      'Simulated per-task behavior table',
    ));
    body.push('<p class="section-note">Kernel time ' + formatDuration(sim.kernelUs) + ' · interrupt time ' + formatDuration(sim.irqUs) +
      ' · idle ' + formatDuration(sim.idleUs) + ' · ' + String(sim.contextSwitches) + ' context switches.</p>');
    body.push('<h3 class="subhead">Priority inversions</h3>');
    if (sim.inversions.length === 0) {
      body.push('<p class="empty-state">No priority inversions were observed in this simulated window.</p>');
    } else {
      body.push('<ul class="event-list">');
      for (const inversion of sim.inversions) {
        body.push('<li class="event-item"><div class="event-title">' +
          '<span class="status-badge ' + (inversion.mitigated ? 'status-good' : 'status-bad') + '">' +
          (inversion.mitigated ? 'Mitigated' : 'Unbounded') + '</span>' +
          '<strong>' + escapeXml(inversion.task) + '</strong> waited for <strong>' + escapeXml(inversion.blocker) + '</strong></div>' +
          '<p class="event-meta"><code>' + escapeXml(inversion.resource) + '</code> · ' + formatDuration(inversion.durationUs) + '</p>' +
          '<p class="event-detail">' + escapeXml(inversion.detail) + '</p></li>');
      }
      body.push('</ul>');
    }
    body.push('<h3 class="subhead">Deadline misses</h3>');
    if (sim.deadlineMisses.length === 0) {
      body.push('<p class="empty-state">No deadline misses were observed in this simulated window.</p>');
    } else {
      body.push(table(
        ['Task', 'Job', 'Released', 'Completed', 'Lateness', 'Dominant cause'],
        sim.deadlineMisses.slice(0, 25).map((miss) => [miss.task, String(miss.job), formatDuration(miss.release),
          formatDuration(miss.completion), formatDuration(miss.latenessUs), causeLabel(miss.cause)]),
        ['', 'num', 'num', 'num', 'num', ''],
        'Deadline misses table',
      ));
      if (sim.deadlineMisses.length > 25) {
        body.push('<p class="section-note">Showing the first 25 of ' + String(sim.deadlineMisses.length) + ' misses.</p>');
      }
    }
    body.push('</section>');
  }

  body.push('<section id="diagnostics" class="report-section" aria-labelledby="diagnostics-title">');
  body.push('<div class="section-head"><div><p class="kicker">4 · Issues</p><h2 id="diagnostics-title">Diagnostics</h2></div>' +
    '<p class="section-note">Errors can invalidate a bound; warnings mark assumptions or choices worth reviewing; info is context, not a failure.</p></div>');
  body.push('<div class="diagnostic-counts"><span class="count-chip count-error">' + String(summary.errors) + ' error' + (summary.errors === 1 ? '' : 's') + '</span>' +
    '<span class="count-chip count-warning">' + String(summary.warnings) + ' warning' + (summary.warnings === 1 ? '' : 's') + '</span>' +
    '<span class="count-chip count-info">' + String(infoCount) + ' info</span></div>');
  if (diagnostics.length === 0) {
    body.push('<p class="empty-state">No diagnostics were emitted for this run. That means no known model or scheduling issue was detected, not that the model is correct.</p>');
  } else {
    body.push('<ul class="diagnostics">');
    for (const diagnostic of diagnostics) {
      body.push('<li class="diagnostic ' + diagnostic.severity + '"><span class="sev">' + diagnosticSeverityLabel(diagnostic.severity) + '</span>' +
        '<div class="diagnostic-body"><code>' + escapeXml(diagnostic.code) + '</code> ' + escapeXml(diagnostic.message) +
        (diagnostic.path ? ' <span class="path">' + escapeXml(diagnostic.path) + '</span>' : '') +
        (diagnostic.hint ? '<div class="hint">' + escapeXml(diagnostic.hint) + '</div>' : '') + '</div></li>');
    }
    body.push('</ul>');
  }
  body.push('</section>');

  body.push('<section id="terms" class="report-section" aria-labelledby="terms-title">');
  body.push('<div class="section-head"><div><p class="kicker">Reference</p><h2 id="terms-title">Key terms</h2></div>' +
    '<p class="section-note">Short definitions for the concepts used above. The glossary is explanatory; the tables and timeline carry the actual results.</p></div>');
  body.push('<dl class="terms">');
  for (const [term, definition] of TERMS) body.push('<div class="term"><dt>' + escapeXml(term) + '</dt><dd>' + escapeXml(definition) + '</dd></div>');
  body.push('</dl>');
  body.push('</section>');

  body.push('<section id="assumptions" class="report-section" aria-labelledby="assumptions-title">');
  body.push('<div class="section-head"><div><p class="kicker">Scope</p><h2 id="assumptions-title">Assumptions and limits</h2></div>' +
    '<p class="section-note">The analysis is only as strong as these conditions. They are part of the result.</p></div>');
  body.push('<ul class="assumptions">');
  for (const caveat of [...new Set([...baseAssumptions(model), ...rta.caveats])]) body.push('<li>' + escapeXml(caveat) + '</li>');
  body.push('</ul>');
  body.push('<p class="limit-callout"><strong>QNX boundary:</strong> this report is model output, not a target measurement. The QNX backend was compiled and run natively during Phase 3B; see docs/verification.md for the evidence and limits. No number here is a hardware timing claim.</p>');
  body.push('<p class="section-note">Response-time bounds are analytical worst cases when the analysis proves them; a lower-bound result is a floor. The simulation is one deterministic schedule of the same model. A simulated latency above its bound is a modelling bug, not a nicer number.</p>');
  body.push('</section>');

  body.push('</main>');
  body.push('<footer class="site-foot"><div class="foot-inner"><p>Generated by Scheduloscope ' + TOOL_VERSION + ' · Apache-2.0 · <a href="https://fetachino.github.io/qnx-scheduloscope/">Project site</a> · <a href="https://github.com/fetachino/qnx-scheduloscope">Source</a></p>' +
    '<p>Model report · ' + escapeXml(bundle.generatedAt) + '</p></div></footer>');

  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230d1117'/%3E%3Ccircle cx='32' cy='32' r='17' fill='none' stroke='%236ea8fe' stroke-width='5'/%3E%3Cpath d='M32 20v12l9 6' fill='none' stroke='%2356d364' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E\">" +
    '<meta name="description" content="' + escapeXml(model.name) + ' — model-based QNX OS 8.0 scheduling report from Scheduloscope.">' +
    '<meta name="color-scheme" content="dark">' +
    '<title>' + escapeXml(model.name) + ' — Scheduloscope</title>' + STYLE + '</head><body>' + body.join('') + '</body></html>\n';
}

/* -------------------------------------------------------------------------- */
/* HTML presentation helpers                                                  */
/* -------------------------------------------------------------------------- */

function verdictBadge(verdict: string): string {
  const label = verdict === 'schedulable' ? 'Schedulable' : verdict === 'unschedulable' ? 'Unschedulable' : 'Inconclusive';
  return '<span class="status-badge status-' + verdict + '"><span class="status-dot" aria-hidden="true"></span>' + label + '</span>';
}

function verdictExplanation(bundle: ReportBundle): string {
  const missed = bundle.rta.tasks.filter((task) => task.deadlineMet === false).length;
  if (bundle.rta.verdict === 'schedulable') {
    return 'Every deadline-bearing task with a finite response bound meets its deadline.';
  }
  if (bundle.rta.verdict === 'unschedulable') {
    const taskText = missed === 1 ? 'one task' : String(missed) + ' tasks';
    return 'The analysis found ' + taskText + ' that cannot meet its deadline.';
  }
  return 'The analysis could not establish a worst-case bound for the whole task set. Review the diagnostics and caveats before treating any number here as a guarantee.';
}

function metricCard(label: string, value: string, hint: string, tone = ''): string {
  return '<article class="metric' + (tone ? ' metric-' + tone : '') + '"><p class="metric-label">' + escapeXml(label) +
    '</p><p class="metric-value">' + escapeXml(value) + '</p><p class="metric-hint">' + escapeXml(hint) + '</p></article>';
}

export function hasUnboundedBlocking(task: TaskRta): boolean {
  return task.blocking.some((term) => term.kind === 'unbounded');
}

function taskStatus(task: TaskRta | undefined): string {
  if (!task) return '<span class="status-badge status-neutral">Not analyzed</span>';
  if (task.deadlineMet === null) return '<span class="status-badge status-neutral">No deadline bound</span>';
  if (!task.converged) return '<span class="status-badge status-bad">No finite bound</span>';
  if (task.deadlineMet === false) return '<span class="status-badge status-bad">Deadline missed</span>';
  if (hasUnboundedBlocking(task)) return '<span class="status-badge status-inconclusive">Lower bound only</span>';
  return '<span class="status-badge status-good">Deadline met</span>';
}

function taskCard(task: TaskModel, taskRta: TaskRta | undefined): string {
  const deadline = taskRta?.deadlineUs ?? task.deadlineUs;
  const activation = activationText(task);
  const shared = sharedWith(task);
  const parts: string[] = [];
  parts.push('<article class="task-card"><div class="task-head"><div><h3>' + escapeXml(task.name) + '</h3>' +
    '<p class="task-sub">' + escapeXml(policyLabel(task.policy)) + ' · priority ' + String(task.priority) + '</p></div>' +
    taskStatus(taskRta) + '</div>');
  parts.push('<dl class="task-facts">' +
    '<div><dt>Activation</dt><dd>' + escapeXml(activation) + '</dd></div>' +
    '<div><dt>Period / interval</dt><dd>' + formatDuration(taskPeriodUs(task)) + '</dd></div>' +
    '<div><dt>Relative deadline</dt><dd>' + deadlineText(deadline) + '</dd></div>' +
    '<div><dt>Execution C</dt><dd>' + formatDuration(taskRta?.executionUs ?? 0) + '</dd></div>' +
    '<div><dt>Response R</dt><dd>' + (taskRta ? formatDuration(taskRta.responseUs) : '—') + '</dd></div>' +
    '<div><dt>Slack</dt><dd>' + (taskRta && deadline > 0 ? slackText(taskRta.slackUs, deadline) : '—') + '</dd></div>' +
    '</dl>');
  if (taskRta?.deadlineMet === null) {
    parts.push('<p class="task-note">Aperiodic arrivals have no deadline guarantee. The deadline value is shown for context only.</p>');
  } else if (taskRta && taskRta.deadlineMet === false) {
    parts.push('<p class="task-note task-note-bad">R exceeds D by ' + formatDuration(Math.abs(taskRta.slackUs)) + '. See the analysis and diagnostics.</p>');
  } else if (taskRta && hasUnboundedBlocking(taskRta)) {
    parts.push('<p class="task-note task-note-warn">Priority inheritance is off for a shared resource. B is a lower bound, so R can grow beyond the value shown.</p>');
  }
  parts.push('<p class="task-line"><span class="line-label">Shares</span> ' + (shared ? escapeXml(shared) : 'no shared resources or channels') + '</p>');
  if (task.notes) parts.push('<p class="task-note">' + escapeXml(task.notes) + '</p>');
  parts.push('<p class="line-label">Program order</p><ol class="segment-list">');
  if (task.segments.length === 0) parts.push('<li><span class="segment-detail">No segments declared.</span></li>');
  for (const segment of task.segments) {
    const described = describeSegment(segment);
    parts.push('<li><span class="segment-kind">' + escapeXml(described.kind) + '</span><span class="segment-detail">' + escapeXml(described.detail) + '</span></li>');
  }
  parts.push('</ol></article>');
  return parts.join('');
}

function activationText(task: TaskModel): string {
  switch (task.activation.type) {
    case 'periodic': return 'Periodic';
    case 'sporadic': return 'Sporadic';
    case 'aperiodic': return 'Aperiodic';
  }
}

function policyLabel(policy: string): string {
  if (policy === 'fifo') return 'FIFO';
  if (policy === 'rr') return 'Round robin';
  if (policy === 'sporadic') return 'Sporadic';
  return policy;
}

function describeSegment(segment: Segment): { kind: string; detail: string } {
  switch (segment.kind) {
    case 'cpu': return { kind: 'CPU', detail: formatDuration(segment.us) };
    case 'cs': return { kind: 'Critical section', detail: segment.resource + ' · ' + formatDuration(segment.workUs) };
    case 'rpc': return { kind: 'Server request', detail: segment.channel + (segment.timeoutUs !== undefined ? ' · timeout ' + formatDuration(segment.timeoutUs) : '') };
    case 'sleep': return { kind: 'Sleep', detail: formatDuration(segment.us) };
    case 'yield': return { kind: 'Yield', detail: 'give up the CPU' };
    case 'setPriority': return { kind: 'Raise priority', detail: 'to ' + String(segment.priority) };
  }
}

function responseBars(tasks: readonly TaskRta[]): string {
  const withDeadline = tasks.filter((task) => task.deadlineMet !== null && task.deadlineUs > 0);
  if (withDeadline.length === 0) return '';
  const parts: string[] = ['<div class="bar-panel"><div class="bar-head"><h3>Response bound vs deadline</h3>' +
    '<p>Bar length is R / D. The table remains the authoritative result.</p></div>'];
  for (const task of withDeadline) {
    const ratio = task.deadlineUs > 0 ? task.responseUs / task.deadlineUs : 0;
    const width = Math.min(100, Math.max(0, ratio * 100));
    const over = ratio > 1 || !task.deadlineMet;
    const limited = !over && hasUnboundedBlocking(task);
    const label = task.deadlineMet === false ? 'missed' : limited ? 'lower bound' : 'met';
    parts.push('<div class="bar-row"><span class="bar-name">' + escapeXml(task.name) + '</span>' +
      '<div class="bar-track" aria-hidden="true"><span class="bar-fill' + (over ? ' over' : limited ? ' limited' : '') + '" style="width:' + width.toFixed(1) + '%"></span></div>' +
      '<span class="bar-value">' + formatDuration(task.responseUs) + ' / ' + formatDuration(task.deadlineUs) +
      ' · ' + label + '</span></div>');
  }
  const omitted = tasks.filter((task) => task.deadlineUs === 0);
  if (omitted.length > 0) {
    parts.push('<p class="bar-note">Not plotted: ' + omitted.map((task) => escapeXml(task.name)).join(', ') +
      (omitted.length === 1 ? ' has' : ' have') + ' no deadline bound, so there is no R / D ratio to compare.</p>');
  }
  parts.push('</div>');
  return parts.join('');
}

function renderTimelineTable(sim: NonNullable<ReportBundle['sim']>, windowUs: number): string {
  const visible = sim.traces.filter((slice) => slice.end > 0 && slice.start < windowUs);
  if (visible.length === 0) return '';
  const shown = visible.slice(0, 80);
  const rows = shown.map((slice) => [laneDisplay(slice.lane), traceSegment(slice), formatDuration(slice.start),
    formatDuration(Math.min(slice.end, windowUs)), formatDuration(Math.min(slice.end, windowUs) - slice.start)]);
  return '<details class="disclosure trace-disclosure"><summary>Inspect timeline slices as a table</summary>' +
    '<p class="section-note">Showing ' + String(shown.length) + ' of ' + String(visible.length) +
    ' slices in the displayed window. Times are clipped to the window.</p>' +
    table(['Lane', 'Slice', 'Start', 'End', 'Duration'], rows, ['', '', 'num', 'num', 'num'], 'Timeline slices table') +
    '</details>';
}

function laneDisplay(lane: string): string {
  return lane.startsWith('server:') ? lane.slice('server:'.length) : lane;
}

function traceSegment(slice: { readonly kind: string; readonly segment?: string }): string {
  if (slice.segment) return slice.segment;
  if (slice.kind === 'irq') return 'interrupt';
  if (slice.kind === 'kernel') return 'kernel';
  if (slice.kind === 'idle') return 'idle';
  return slice.kind;
}

function causeLabel(cause: string): string {
  if (cause === 'blocking') return 'Blocked by a shared resource';
  if (cause === 'interference') return 'Preempted by higher-priority work';
  if (cause === 'overrun') return 'Execution overrun';
  return cause;
}

function diagnosticSeverityLabel(severity: string): string {
  if (severity === 'error') return 'Error';
  if (severity === 'warning') return 'Warning';
  return 'Info';
}

const TERMS: readonly (readonly [string, string])[] = [
  ['Task priority', 'QNX uses 0 for idle and 1–255 for threads; a higher number runs first. On a default procnto -P 63, priorities above 63 need PROCMGR_AID_PRIORITY.'],
  ['Execution time (C)', 'CPU demand charged to one job, including modeled context-switch cost and service work performed on its behalf by channel servers.'],
  ['Period and deadline', 'A periodic task is released every period; its relative deadline is measured from that release. Sporadic tasks use a minimum interarrival; aperiodic tasks use a mean and have no deadline guarantee.'],
  ['Response time (R)', 'For this report, the analytical worst-case time from release to completion when the analysis can prove it; with unbounded blocking, R is a lower bound. The simulated Max column is one observed value from one deterministic schedule, not a general bound.'],
  ['Worst-case response-time analysis', 'A fixed-point calculation that sums execution, blocking, higher-priority interference, and interrupt service. It is a proof under the stated assumptions when no blocking term is unbounded; it is not a measurement.'],
  ['Priority inversion', 'A higher-priority task waits for a lower-priority task holding a shared resource. It is bounded by inheritance or a priority ceiling; without either, it can be unbounded.'],
  ['Priority inheritance', 'PTHREAD_PRIO_INHERIT lets the holder of a mutex run at the priority of the highest-priority task blocked on it until it releases the mutex. QNX uses inheritance by default.'],
  ['Priority ceiling protocol', 'PTHREAD_PRIO_PROTECT raises the holder to the resource ceiling while it holds the mutex. The ceiling must cover every task that can use the resource.'],
  ['Missed deadline', 'The response time exceeds the relative deadline. A zero or missing deadline on an aperiodic task means no deadline guarantee is computed.'],
  ['Slack', 'D − R for a task with a deadline. For a proven bound, positive slack is headroom; for a lower-bound result it is only a floor. Negative slack is the amount by which the bound misses.'],
  ['Hyperperiod', 'The least common multiple of the periodic task periods: the repeating cycle for a synchronous periodic set.'],
  ['ISR / IST', 'Interrupt service routines and interrupt service threads preempt application threads. Their entry and service time appear in the ISR term.'],
];

const STYLE = [
  '<style>',
  ':root { color-scheme: dark; --bg: #0d1117; --panel: #12171f; --panel-2: #0f141b; --panel-3: #161d27; --line: #26303c; --line-strong: #344152; --text: #e6edf3; --muted: #9aa7b4; --muted-2: #7d8a98; --accent: #6ea8fe; --accent-soft: rgba(110,168,254,0.14); --good: #56d364; --good-soft: rgba(86,211,100,0.13); --warn: #e3b341; --warn-soft: rgba(227,179,65,0.13); --bad: #ff7b72; --bad-soft: rgba(255,123,114,0.13); --info: #79c0ff; --info-soft: rgba(121,192,255,0.12); --radius: 12px; --radius-sm: 8px; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
  '*, *::before, *::after { box-sizing: border-box; }',
  'html { scroll-behavior: smooth; }',
  'body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.65 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; -webkit-font-smoothing: antialiased; }',
  'a { color: var(--accent); text-decoration-color: rgba(110,168,254,0.45); text-underline-offset: 3px; }',
  'a:hover { color: #a8ccff; }',
  ':focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }',
  '.skip-link { position: absolute; left: 16px; top: -60px; z-index: 20; padding: 10px 14px; background: var(--text); color: var(--bg); border-radius: 6px; font-weight: 600; text-decoration: none; }',
  '.skip-link:focus { top: 12px; }',
  '.site-head { position: sticky; top: 0; z-index: 10; background: rgba(13,17,23,0.94); border-bottom: 1px solid var(--line); backdrop-filter: blur(10px); }',
  '.head-inner { max-width: 1160px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }',
  '.brand { color: var(--text); font-weight: 700; letter-spacing: -0.02em; text-decoration: none; font-size: 17px; }',
  '.brand span { color: var(--accent); }',
  '.model-tag { color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; }',
  '.report-nav { margin-left: auto; display: flex; gap: 2px; overflow-x: auto; max-width: 100%; }',
  '.report-nav a { color: var(--muted); text-decoration: none; padding: 7px 9px; border-radius: 6px; font-size: 13px; white-space: nowrap; }',
  '.report-nav a:hover { color: var(--text); background: var(--panel-3); }',
  '.page { max-width: 1160px; margin: 0 auto; padding: 44px 24px 80px; }',
  '.report-hero { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.65fr); gap: 36px; align-items: start; margin-bottom: 28px; }',
  '.eyebrow, .kicker { color: var(--muted); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 10px; }',
  'h1 { font-size: clamp(34px, 5vw, 52px); line-height: 1.04; letter-spacing: -0.035em; margin: 0 0 14px; text-wrap: balance; }',
  '.lede { color: #c2ccd6; font-size: 17px; line-height: 1.55; max-width: 64ch; margin: 0 0 18px; }',
  '.hero-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--muted-2); font-size: 12px; margin: 0; }',
  '.hero-meta span + span::before { content: "·"; color: var(--line-strong); }',
  '.status-panel { border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: var(--radius); padding: 22px; background: linear-gradient(180deg, rgba(110,168,254,0.07), rgba(18,23,31,0.9)); }',
  '.status-panel.status-schedulable { border-top-color: var(--good); }',
  '.status-panel.status-unschedulable { border-top-color: var(--bad); }',
  '.status-panel.status-inconclusive { border-top-color: var(--warn); }',
  '.status-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }',
  '.status-kicker { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }',
  '.status-badge { display: inline-flex; align-items: center; gap: 7px; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 650; line-height: 1.3; white-space: nowrap; }',
  '.status-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }',
  '.status-schedulable, .status-good { color: var(--good); background: var(--good-soft); }',
  '.status-unschedulable, .status-bad { color: var(--bad); background: var(--bad-soft); }',
  '.status-inconclusive { color: var(--warn); background: var(--warn-soft); }',
  '.status-neutral { color: var(--muted); background: rgba(154,167,180,0.1); }',
  '.status-copy { margin: 0; color: #d7e0e8; font-size: 15px; }',
  '.status-footnote { margin: 12px 0 0; color: var(--muted); font-size: 12px; }',
  '.callout { display: flex; gap: 14px; align-items: flex-start; border: 1px solid var(--line); border-left: 3px solid var(--warn); background: var(--panel-2); border-radius: var(--radius-sm); padding: 16px 18px; }',
  '.callout-mark { width: 24px; height: 24px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--warn); font: 600 13px/1 var(--mono); }',
  '.callout h2 { font-size: 14px; margin: 0 0 4px; }',
  '.callout p { margin: 0; color: var(--muted); font-size: 13px; max-width: 90ch; }',
  '.metric-section, .guide, .report-section { margin-top: 34px; }',
  'section[id] { scroll-margin-top: 88px; }',
  '.section-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 28px; margin-bottom: 16px; }',
  '.section-head.compact { margin-bottom: 12px; }',
  '.section-head h2 { font-size: 24px; line-height: 1.2; letter-spacing: -0.02em; margin: 0; }',
  '.section-note { color: var(--muted); font-size: 13px; max-width: 58ch; margin: 0; }',
  '.metric-groups { display: grid; gap: 18px; }',
  '.metric-group-label { color: var(--muted); font: 600 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 8px; }',
  '.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }',
  '.metric { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 15px 16px; min-width: 0; }',
  '.metric-label { color: var(--muted); font-size: 12px; margin: 0 0 5px; }',
  '.metric-value { font-size: 23px; line-height: 1.15; font-weight: 650; letter-spacing: -0.02em; margin: 0 0 5px; font-variant-numeric: tabular-nums; }',
  '.metric-hint { color: var(--muted-2); font-size: 11.5px; line-height: 1.4; margin: 0; }',
  '.metric-good .metric-value { color: var(--good); } .metric-warn .metric-value { color: var(--warn); } .metric-bad .metric-value { color: var(--bad); }',
  '.guide { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: 28px; padding: 22px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); }',
  '.guide h2 { font-size: 21px; margin: 0 0 6px; letter-spacing: -0.02em; }',
  '.guide-intro > p:last-child { color: var(--muted); font-size: 13px; margin: 0; }',
  '.guide-steps { list-style: none; display: grid; gap: 12px; margin: 0; padding: 0; }',
  '.guide-steps li { display: flex; gap: 11px; align-items: flex-start; }',
  '.step-num { flex: 0 0 24px; height: 24px; display: grid; place-items: center; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--accent); font: 600 11px/1 var(--mono); margin-top: 2px; }',
  '.guide-steps strong { display: block; font-size: 13px; }',
  '.guide-steps p { margin: 1px 0 0; color: var(--muted); font-size: 12px; }',
  '.guide-link { grid-column: 1 / -1; margin: 0; font-size: 13px; }',
  '.task-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }',
  '.task-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; min-width: 0; }',
  '.task-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }',
  '.task-head h3 { font-size: 17px; margin: 0 0 2px; letter-spacing: -0.01em; text-transform: none; }',
  '.task-sub { color: var(--muted); font: 11px/1.4 var(--mono); margin: 0; text-transform: uppercase; letter-spacing: 0.04em; }',
  '.task-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 14px; margin: 14px 0; }',
  '.task-facts dt { color: var(--muted-2); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }',
  '.task-facts dd { margin: 0; font: 13px/1.4 var(--mono); color: var(--text); overflow-wrap: anywhere; }',
  '.task-line { display: flex; gap: 8px; align-items: baseline; margin: 8px 0; font-size: 12.5px; color: #c5d0da; }',
  '.line-label { color: var(--muted-2); font: 600 10.5px/1.4 var(--mono); text-transform: uppercase; letter-spacing: 0.05em; flex: 0 0 auto; }',
  '.task-note { color: var(--muted); font-size: 12px; margin: 8px 0; }',
  '.task-note-bad { color: #ffb4ae; }',
  '.task-note-warn { color: #ffd28a; }',
  '.segment-list { list-style: none; margin: 6px 0 0; padding: 0; border-top: 1px solid var(--line); }',
  '.segment-list li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px solid rgba(38,48,60,0.65); font-size: 12px; }',
  '.segment-list li:last-child { border-bottom: 0; }',
  '.segment-kind { color: var(--muted); }',
  '.segment-detail { color: #cbd6e1; font-family: var(--mono); text-align: right; overflow-wrap: anywhere; }',
  '.disclosure { margin-top: 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel-2); }',
  '.disclosure > summary { cursor: pointer; padding: 12px 15px; color: #cbd6e1; font-size: 13px; font-weight: 600; }',
  '.disclosure > summary:hover { color: var(--text); }',
  '.disclosure[open] > summary { border-bottom: 1px solid var(--line); }',
  '.disclosure > :not(summary) { margin-left: 15px; margin-right: 15px; }',
  '.disclosure > .table-wrap { margin: 14px 15px; }',
  '.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); margin-top: 14px; }',
  '.table-wrap:focus-visible { outline-offset: 2px; }',
  'table { width: 100%; min-width: 660px; border-collapse: collapse; font-size: 13px; }',
  'th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }',
  'th { color: var(--muted); font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; background: var(--panel-2); }',
  'td { color: #d6e0e9; }',
  'td:first-child, th:first-child { color: var(--text); }',
  'td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }',
  'tbody tr:last-child td { border-bottom: 0; }',
  'tbody tr:hover { background: rgba(110,168,254,0.04); }',
  'code { font: 12px/1.5 var(--mono); background: #0b0f16; border: 1px solid rgba(52,65,82,0.6); padding: 2px 6px; border-radius: 4px; }',
  '.formula-card { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: var(--radius-sm); background: var(--panel-2); padding: 14px 16px; margin: 0 0 4px; }',
  '.formula-card code { color: var(--accent); font-size: 14px; }',
  '.formula-card p { color: var(--muted); margin: 5px 0 0; font-size: 12px; }',
  '.inline-terms { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px 20px; margin: 10px 0 0; font-size: 11.5px; }',
  '.inline-terms div { display: flex; gap: 5px; align-items: baseline; min-width: 0; }',
  '.inline-terms dt { color: var(--accent); font-family: var(--mono); font-weight: 600; }',
  '.inline-terms dd { color: var(--muted); margin: 0; }',
  '@media (max-width: 720px) { .inline-terms { grid-template-columns: repeat(2, minmax(0, 1fr)); } }',
  '@media (max-width: 480px) { .inline-terms { grid-template-columns: 1fr; } }',
  '.bar-panel { border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel); padding: 15px 16px; margin-top: 14px; }',
  '.bar-head { display: flex; justify-content: space-between; align-items: baseline; gap: 18px; margin-bottom: 11px; }',
  '.bar-head h3 { margin: 0; }',
  '.bar-head p { margin: 0; color: var(--muted); font-size: 11.5px; }',
  '.bar-row { display: grid; grid-template-columns: 112px minmax(0, 1fr) 190px; gap: 12px; align-items: center; padding: 5px 0; }',
  '.bar-name { color: #d6e0e9; font: 12px var(--mono); overflow: hidden; text-overflow: ellipsis; }',
  '.bar-track { height: 7px; background: #0b0f16; border-radius: 999px; overflow: hidden; border: 1px solid var(--line); }',
  '.bar-fill { display: block; height: 100%; background: var(--accent); border-radius: inherit; }',
  '.bar-fill.over { background: var(--bad); }',
  '.bar-fill.limited { background: var(--warn); }',
  '.bar-value { color: var(--muted); font: 11px var(--mono); text-align: right; white-space: nowrap; }',
  '.bar-note { margin: 8px 0 0 112px; color: var(--muted-2); font-size: 11px; }',
  '.chart-figure { margin: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); overflow: hidden; }',
  '.chart-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; padding: 16px 18px 12px; }',
  '.chart-top h3 { margin: 0 0 2px; font-size: 15px; }',
  '.chart-meta { margin: 0; color: var(--muted); font-size: 11.5px; }',
  '.chart-scroll-hint { display: none; margin: 0; padding: 0 16px 11px; color: var(--muted-2); font-size: 11px; }',
  '.chart-scroll { overflow-x: auto; border-top: 1px solid var(--line); background: #0b0f14; }',
  '.chart-scroll:focus-visible { outline-offset: -2px; }',
  '.chart-scroll svg { display: block; width: 100%; min-width: 720px; height: auto; }',
  '.chart-figure figcaption { padding: 11px 18px 14px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }',
  '.chart-figure figcaption strong { color: #cbd6e1; }',
  '.chart-boundary { margin-top: 10px; padding: 10px 13px; border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: var(--radius-sm); color: var(--muted); font-size: 12px; background: var(--panel-2); }',
  '.chart-boundary strong { color: var(--warn); }',
  '.subhead { font-size: 16px; margin: 28px 0 4px; letter-spacing: -0.01em; }',
  '.event-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }',
  '.event-item { border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: var(--radius-sm); background: var(--panel); padding: 12px 14px; }',
  '.event-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }',
  '.event-title strong { color: var(--text); font-family: var(--mono); font-weight: 600; }',
  '.event-meta { margin: 6px 0 0; color: var(--muted); font-size: 11.5px; }',
  '.event-detail { margin: 4px 0 0; color: #c5d0da; font-size: 12.5px; }',
  '.diagnostic-counts { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }',
  '.count-chip { border: 1px solid var(--line); border-radius: 999px; padding: 3px 9px; font: 11px var(--mono); }',
  '.count-error { color: var(--bad); background: var(--bad-soft); }',
  '.count-warning { color: var(--warn); background: var(--warn-soft); }',
  '.count-info { color: var(--info); background: var(--info-soft); }',
  '.diagnostics { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; }',
  '.diagnostic { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 12px; padding: 13px 15px; border-bottom: 1px solid var(--line); background: var(--panel); }',
  '.diagnostic:last-child { border-bottom: 0; }',
  '.diagnostic.error { border-left: 3px solid var(--bad); }',
  '.diagnostic.warning { border-left: 3px solid var(--warn); }',
  '.diagnostic.info { border-left: 3px solid var(--info); }',
  '.sev { font: 600 10.5px/1.8 var(--mono); text-transform: uppercase; letter-spacing: 0.05em; }',
  '.error .sev { color: var(--bad); } .warning .sev { color: var(--warn); } .info .sev { color: var(--info); }',
  '.diagnostic-body { color: #d6e0e9; font-size: 13px; overflow-wrap: anywhere; }',
  '.path { display: block; color: var(--muted-2); font: 11.5px/1.5 var(--mono); margin-top: 3px; }',
  '.hint { color: var(--muted); font-size: 12.5px; margin-top: 5px; }',
  '.empty-state { margin: 12px 0 0; padding: 16px; border: 1px dashed var(--line-strong); border-radius: var(--radius-sm); color: var(--muted); font-size: 13px; background: var(--panel-2); }',
  '.terms { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 28px; margin: 0; border-top: 1px solid var(--line); }',
  '.term { padding: 12px 0; border-bottom: 1px solid var(--line); }',
  '.term dt { color: var(--text); font-size: 13px; font-weight: 650; margin-bottom: 3px; }',
  '.term dd { margin: 0; color: var(--muted); font-size: 12.5px; line-height: 1.55; }',
  '.blocking-list { margin: 12px 15px; padding-left: 18px; color: var(--muted); font-size: 12.5px; }',
  '.blocking-list > li { margin: 8px 0; }',
  '.blocking-list ul { margin: 4px 0 0; padding-left: 18px; }',
  '.assumptions { margin: 0; padding-left: 20px; color: var(--muted); font-size: 13px; }',
  '.assumptions li { margin: 6px 0; }',
  '.limit-callout { margin: 18px 0 0; padding: 13px 15px; border: 1px solid var(--line); border-left: 3px solid var(--bad); border-radius: var(--radius-sm); background: var(--panel-2); color: var(--muted); font-size: 12.5px; }',
  '.limit-callout strong { color: #ffb4ae; }',
  '.site-foot { border-top: 1px solid var(--line); background: var(--panel-2); }',
  '.foot-inner { max-width: 1160px; margin: 0 auto; padding: 18px 24px 30px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; color: var(--muted-2); font-size: 11.5px; }',
  '.foot-inner p { margin: 0; }',
  '.foot-inner a { color: var(--muted); }',
  '.ok { color: var(--good); } .no { color: var(--bad); } .na { color: var(--muted); }',
  '@media (max-width: 960px) { .report-hero { grid-template-columns: 1fr; gap: 22px; } .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .guide { grid-template-columns: 1fr; gap: 18px; } .section-head { align-items: flex-start; flex-direction: column; gap: 8px; } }',
  '@media (max-width: 720px) { .head-inner { padding: 10px 16px; gap: 8px; } .model-tag { order: 2; margin-left: auto; } .report-nav { order: 3; flex-basis: 100%; margin-left: 0; flex-wrap: wrap; overflow-x: visible; } .page { padding: 30px 16px 60px; } .task-grid, .terms { grid-template-columns: 1fr; } .task-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } .chart-top { flex-direction: column; gap: 8px; } .chart-scroll-hint { display: block; } section[id] { scroll-margin-top: 104px; } .bar-row { grid-template-columns: 96px minmax(0, 1fr); } .bar-value { grid-column: 2; text-align: left; } .bar-note { margin-left: 0; } .foot-inner { padding: 16px; } .metric-value { font-size: 21px; } .status-panel { padding: 18px; } .diagnostic { grid-template-columns: 64px minmax(0, 1fr); padding: 12px; } }',
  '@media (max-width: 480px) { section[id] { scroll-margin-top: 134px; } .report-nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px; } .report-nav a { text-align: center; } .metric-grid { grid-template-columns: 1fr; } .task-facts { grid-template-columns: 1fr 1fr; } .hero-meta span + span::before { display: none; } .hero-meta { flex-direction: column; gap: 2px; } .callout { padding: 14px; } .chart-top { padding: 14px 14px 10px; } .chart-figure figcaption { padding: 10px 14px 13px; } .bar-row { grid-template-columns: 82px minmax(0, 1fr); } }',
  '@media print { .site-head, .report-nav, .skip-link, .guide-link { display: none; } body { background: #fff; color: #111; } .page { max-width: none; padding: 0; } .status-panel, .task-card, .metric, .table-wrap, .chart-figure, .guide, .callout, .event-item, .diagnostic, .empty-state, .limit-callout { break-inside: avoid; } a { color: #0645ad; } }',
  '</style>',
].join('');

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function table(headers: readonly string[], rows: readonly (readonly string[])[], classes: readonly string[], label = 'Report data'): string {
  const head = headers
    .map((header, index) => '<th scope="col"' + (classes[index] === 'num' ? ' class="num"' : '') + '>' + escapeXml(header) + '</th>')
    .join('');
  const body = rows
    .map((cells) => '<tr>' + cells.map((cell, index) => {
      if (index === cells.length - 1 && (cell === 'met' || cell === 'missed' || cell === 'n/a')) {
        return '<td class="' + (cell === 'met' ? 'ok' : cell === 'missed' ? 'no' : 'na') + '">' + escapeXml(cell) + '</td>';
      }
      return '<td' + (classes[index] === 'num' ? ' class="num"' : '') + '>' + escapeXml(cell) + '</td>';
    }).join('') + '</tr>')
    .join('');
  return '<div class="table-wrap" tabindex="0" role="region" aria-label="' + escapeXml(label) + '">' +
    '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

function verdictCell(task: TaskRta): string {
  if (task.deadlineMet === null) return 'n/a';
  if (task.deadlineMet === false) return 'missed';
  return hasUnboundedBlocking(task) ? 'lower bound' : 'met';
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
