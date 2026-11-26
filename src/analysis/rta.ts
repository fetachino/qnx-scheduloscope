/**
 * Response-time analysis.
 *
 * Implements classic fixed-priority preemptive response-time analysis (Joseph
 * and Pandya) with the QNX-specific pieces that make a real QNX design
 * different from a textbook one:
 *
 *  - blocking from PTHREAD_PRIO_INHERIT and PTHREAD_PRIO_PROTECT mutexes,
 *  - blocking from channels that disable message-driven priority inheritance
 *    (_NTO_CHF_FIXED_PRIORITY),
 *  - interference from interrupt service threads, which outrank every thread,
 *  - equal-priority interference for round-robin peers (conservative).
 *
 * Every assumption that could make the bound optimistic is surfaced as a caveat
 * instead of being silently ignored.
 */

import type { Diagnostic } from '../core/diagnostics.js';
import { DiagnosticBag } from '../core/diagnostics.js';
import { derive, taskPeriodUs, type DerivedModel } from '../core/derive.js';
import type { SystemModel, TaskModel } from '../core/model.js';
import { formatDuration, type Micros } from '../core/units.js';

export type BlockingKind = 'mutex' | 'message' | 'unbounded';

export interface BlockingTerm {
  readonly kind: BlockingKind;
  /** Task, resource or channel that causes the block. */
  readonly source: string;
  readonly us: Micros;
  readonly detail: string;
}

export interface TaskRta {
  readonly name: string;
  readonly priority: number;
  readonly policy: string;
  readonly periodUs: Micros;
  readonly deadlineUs: Micros;
  readonly executionUs: Micros;
  readonly ownCpuUs: Micros;
  readonly delegatedCpuUs: Micros;
  readonly blockingUs: Micros;
  readonly blocking: readonly BlockingTerm[];
  readonly interruptUs: Micros;
  readonly interferenceUs: Micros;
  readonly responseUs: Micros;
  readonly slackUs: number;
  readonly deadlineMet: boolean | null;
  readonly converged: boolean;
  readonly iterations: number;
  readonly utilization: number;
  readonly caveats: readonly string[];
}

export type Verdict = 'schedulable' | 'unschedulable' | 'inconclusive';

export interface RtaReport {
  readonly tasks: readonly TaskRta[];
  readonly verdict: Verdict;
  readonly utilization: number;
  readonly hyperperiodUs: Micros;
  readonly caveats: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly analyzedAt: string;
}

interface CoreTask {
  readonly name: string;
  readonly priority: number;
  readonly executionUs: Micros;
  readonly periodUs: Micros;
  readonly deadlineUs: Micros;
  readonly kind: 'periodic' | 'sporadic' | 'aperiodic';
}

export interface CoreResult {
  readonly responseUs: Micros;
  readonly converged: boolean;
  readonly iterations: number;
  readonly interferenceUs: Micros;
}

const MAX_ITERATIONS = 10_000;

/**
 * Solve `R = C + overhead + sum(ceil(R/T_j) * C_j)` for the highest-priority
 * task in `hp`. Returns a diverged result instead of looping forever.
 */
export function solveResponseTime(task: CoreTask, hp: readonly CoreTask[], overheadUs: Micros, interruptFn?: (r: Micros) => Micros): CoreResult {
  // Above 100% offered load no finite fixed point exists, so stop at the first
  // iteration instead of climbing for ten thousand rounds.
  const offeredLoad = hp.reduce((sum, other) => sum + (other.periodUs > 0 ? other.executionUs / other.periodUs : 0), 0);
  const diverges = offeredLoad >= 1;
  let response = task.executionUs + overheadUs + (interruptFn ? interruptFn(task.executionUs + overheadUs) : 0);
  let interference = 0;
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    interference = 0;
    for (const other of hp) {
      const jobs = Math.ceil(response / other.periodUs);
      interference += Math.max(0, jobs) * other.executionUs;
    }
    const interrupts = interruptFn ? interruptFn(response) : 0;
    const next = task.executionUs + overheadUs + interference + interrupts;
    if (next === response) {
      return { responseUs: response, converged: true, iterations: iteration, interferenceUs: interference };
    }
    if (diverges) {
      return { responseUs: next, converged: false, iterations: iteration, interferenceUs: interference };
    }
    if (iteration === MAX_ITERATIONS) {
      return { responseUs: next, converged: false, iterations: iteration, interferenceUs: interference };
    }
    // Monotonic ascent; guard against pathological oscillation from rounding.
    response = Math.max(next, response + 1);
  }
  return { responseUs: response, converged: false, iterations: MAX_ITERATIONS, interferenceUs: interference };
}

export function analyzeResponseTimes(model: SystemModel, derived: DerivedModel = derive(model)): RtaReport {
  const bag = new DiagnosticBag();
  const byPriority = new Map<number, TaskModel[]>();
  for (const task of model.tasks) {
    const list = byPriority.get(task.priority) ?? [];
    list.push(task);
    byPriority.set(task.priority, list);
  }

  const coreTasks: CoreTask[] = model.tasks.map((task) => ({
    name: task.name,
    priority: task.priority,
    executionUs: derived.costs.get(task.name)?.executionUs ?? 0,
    periodUs: taskPeriodUs(task),
    deadlineUs: task.deadlineUs,
    kind: task.activation.type,
  }));

  const interruptFn = makeInterruptFunction(model);

  const results: TaskRta[] = [];
  for (const task of model.tasks) {
    const cost = derived.costs.get(task.name);
    const core = coreTasks.find((c) => c.name === task.name);
    if (!cost || !core) continue;
    const caveats: string[] = [];

    const hp = coreTasks.filter((other) => other.priority > task.priority && other.kind !== 'aperiodic');
    const peers = (byPriority.get(task.priority) ?? []).filter((peer) => peer.name !== task.name);
    if (peers.length > 0) {
      // Equal-priority threads cannot preempt each other, but under FIFO one can
      // hold the CPU for a whole job; charging one peer job is conservative.
      const worstPeer = Math.max(...peers.map((peer) => derived.costs.get(peer.name)?.executionUs ?? 0));
      hp.push({
        name: peers[0]!.name,
        priority: task.priority,
        executionUs: worstPeer,
        periodUs: Math.max(1, taskPeriodUs(peers[0]!)),
        deadlineUs: peers[0]!.deadlineUs,
        kind: peers[0]!.activation.type,
      });
      caveats.push('Equal-priority peer charged as interference (conservative for FIFO/RR).');
    }

    const blockingTerms = computeBlocking(model, derived, task, core, coreTasks, interruptFn);
    const blockingUs = blockingTerms.reduce((sum, term) => sum + term.us, 0);

    const solved = solveResponseTime(core, hp, blockingUs, interruptFn);
    const responseUs = solved.responseUs;

    if (cost.selfSuspends) caveats.push('Job self-suspends inside its execution window; the bound is optimistic.');
    if (cost.fixedPriorityBlocking) caveats.push('Uses a channel with _NTO_CHF_FIXED_PRIORITY; blocking is bounded only by the server response time.');
    if (task.activation.type === 'aperiodic') caveats.push('Aperiodic task: no deadline guarantee is computed.');
    if (blockingTerms.some((term) => term.kind === 'unbounded')) caveats.push('Unbounded blocking: a shared mutex has priority inheritance disabled.');

    const deadlineMet = task.activation.type === 'aperiodic' ? null : solved.converged && responseUs <= task.deadlineUs;

    if (deadlineMet === false) {
      if (!solved.converged) {
        bag.error(
          'E_UNSCHEDULABLE',
          `${task.name} (priority ${task.priority}) has no finite response time: higher-priority load leaves less than ${task.name}'s own execution time available.`,
          undefined,
          'Reduce higher-priority execution time, lengthen periods, or re-prioritise.',
        );
      } else {
        bag.error(
          'E_DEADLINE_MISS',
          `${task.name} misses its deadline: worst-case response ${formatDuration(responseUs)} > ${formatDuration(task.deadlineUs)}.`,
          undefined,
          describeDominated(responseUs, task.deadlineUs, cost.executionUs, blockingUs, solved.interferenceUs),
        );
      }
    }

    results.push({
      name: task.name,
      priority: task.priority,
      policy: task.policy,
      periodUs: core.periodUs,
      deadlineUs: task.deadlineUs,
      executionUs: cost.executionUs,
      ownCpuUs: cost.ownCpuUs,
      delegatedCpuUs: cost.delegatedCpuUs,
      blockingUs,
      blocking: blockingTerms,
      interruptUs: interruptFn(responseUs),
      interferenceUs: solved.interferenceUs,
      responseUs,
      slackUs: task.deadlineUs - responseUs,
      deadlineMet,
      converged: solved.converged,
      iterations: solved.iterations,
      utilization: task.activation.type === 'aperiodic' ? 0 : cost.executionUs / core.periodUs,
      caveats,
    });
  }

  checkPriorityAssignment(model, results, bag);

  const analyzed = results.filter((r) => r.deadlineMet !== null);
  let verdict: Verdict;
  if (analyzed.length === 0) verdict = 'inconclusive';
  else if (analyzed.every((r) => r.deadlineMet === true)) verdict = 'schedulable';
  else verdict = 'unschedulable';
  if (verdict === 'schedulable' && analyzed.some((r) => r.caveats.length > 0)) verdict = 'inconclusive';

  const caveats = [...new Set(results.flatMap((r) => r.caveats))];
  if (verdict === 'inconclusive' && !caveats.length) {
    caveats.push('Some tasks could not be analysed.');
  }
  if (model.cpu.cores !== 1) caveats.push('Multi-core effects are outside this model.');
  if (!model.interrupts.sources.length && model.clock.periodUs > 0) {
    caveats.push('No device interrupt sources modelled; only kernel tick overhead is charged.');
  }

  return {
    tasks: results,
    verdict,
    utilization: derived.totalUtilization,
    hyperperiodUs: derived.hyperperiodUs,
    caveats,
    diagnostics: bag.all,
    analyzedAt: new Date().toISOString(),
  };
}

function describeDominated(responseUs: Micros, deadlineUs: Micros, ownUs: Micros, blockingUs: Micros, interferenceUs: Micros): string {
  const parts = [
    { label: 'own execution', value: ownUs },
    { label: 'blocking', value: blockingUs },
    { label: 'higher-priority interference', value: interferenceUs },
  ].sort((a, b) => b.value - a.value);
  const worst = parts[0]!;
  return `Largest term is ${worst.label} (${formatDuration(worst.value)}); need to recover ${formatDuration(responseUs - deadlineUs)}. Own execution is ${formatDuration(ownUs)}.`;
}

function makeInterruptFunction(model: SystemModel): (responseUs: Micros) => Micros {
  const sources = model.interrupts.sources;
  const tickUs = model.interrupts.entryOverheadUs;
  const clockPeriod = model.clock.periodUs;
  return (responseUs: Micros) => {
    let total = 0;
    for (const source of sources) {
      total += Math.max(1, Math.ceil(responseUs / source.periodUs)) * source.serviceUs;
    }
    if (tickUs > 0 && clockPeriod > 0) {
      total += Math.max(1, Math.ceil(responseUs / clockPeriod)) * tickUs;
    }
    return total;
  };
}

function computeBlocking(
  model: SystemModel,
  derived: DerivedModel,
  task: TaskModel,
  core: CoreTask,
  coreTasks: readonly CoreTask[],
  interruptFn: (r: Micros) => Micros,
): BlockingTerm[] {
  const terms: BlockingTerm[] = [];
  const resources = new Map(model.resources.map((r) => [r.name, r]));
  const channels = new Map(model.channels.map((c) => [c.name, c]));
  const cost = derived.costs.get(task.name);

  const myResources = new Set((cost?.criticalSections ?? []).map((cs) => cs.resource));
  const myChannels = new Set((cost?.channels ?? []));

  const lower = model.tasks.filter((other) => other.priority < task.priority);

  for (const resource of model.resources) {
    if (resource.protocol === 'protect') {
      const ceiling = resource.ceiling ?? 0;
      if (ceiling < task.priority) continue;
    } else if (!myResources.has(resource.name)) {
      continue;
    }

    // Longest critical section any lower-priority thread can hold on a resource
    // that can block this task.
    let longest: { task: string; workUs: Micros } | undefined;
    for (const other of lower) {
      const otherCost = derived.costs.get(other.name);
      if (!otherCost) continue;
      for (const section of otherCost.criticalSections) {
        if (section.resource !== resource.name) continue;
        if (section.workUs > (longest?.workUs ?? -1)) longest = { task: other.name, workUs: section.workUs };
      }
    }
    if (!longest) continue;

    if (resource.protocol === 'none') {
      terms.push({
        kind: 'unbounded',
        source: resource.name,
        us: longest.workUs,
        detail: `${longest.task} holds "${resource.name}" with PTHREAD_PRIO_NONE; any thread above it can preempt it, so the wait is unbounded (lower bound ${formatDuration(longest.workUs)}).`,
      });
    } else {
      terms.push({
        kind: 'mutex',
        source: resource.name,
        us: longest.workUs,
        detail: `${longest.task} can hold "${resource.name}" for ${formatDuration(longest.workUs)} under ${resource.protocol === 'protect' ? 'PTHREAD_PRIO_PROTECT' : 'PTHREAD_PRIO_INHERIT'}.`,
      });
    }
  }

  for (const channelName of myChannels) {
    const channel = channels.get(channelName);
    if (!channel || !channel.fixedPriority || channel.basePriority >= task.priority) continue;
    // The server runs at its own (lower) priority, so the client waits for the
    // server's whole response time, including preemption by anyone above it.
    const serviceUs = derived.channels.get(channelName)?.serviceUs ?? 0;
    const serverTask: CoreTask = {
      name: `${channel.name} server`,
      priority: channel.basePriority,
      executionUs: serviceUs,
      periodUs: 1,
      deadlineUs: 1,
      kind: 'periodic',
    };
    const hp = coreTasks.filter((other) => other.priority > channel.basePriority && other.kind !== 'aperiodic');
    const solved = solveResponseTime(serverTask, hp, 0, interruptFn);
    const queued = Math.max(0, channel.serverThreads - 1);
    const us = solved.responseUs * (1 + queued);
    terms.push({
      kind: 'message',
      source: channel.name,
      us,
      detail: `"${channel.name}" disables message-driven inheritance, so the client waits for a server at priority ${channel.basePriority}: ${formatDuration(solved.responseUs)} per request${queued > 0 ? ` (${queued + 1} requests worst case)` : ''}.`,
    });
  }

  if (terms.length === 0) {
    void core;
  }
  return terms;
}

function checkPriorityAssignment(model: SystemModel, results: readonly TaskRta[], bag: DiagnosticBag): void {
  const periodic = model.tasks.filter((t) => t.activation.type === 'periodic');
  if (periodic.length < 2) return;
  const sorted = [...results].sort((a, b) => b.priority - a.priority);
  let violations = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (current.periodUs < previous.periodUs) violations += 1;
  }
  if (violations > 0) {
    bag.info(
      'I_RATE_MONOTONIC',
      `${violations} task(s) have a shorter period at a lower priority than rate-monotonic order would give them.`,
      undefined,
      'Rate-monotonic priority assignment is optimal for fixed-priority preemptive scheduling with independent periodic tasks; try it if a task misses its deadline.',
    );
  }
}
