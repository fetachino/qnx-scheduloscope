/**
 * Derived per-job costs.
 *
 * A design declares work once (CPU segments, critical sections, RPCs). Both the
 * analytical engine and the simulator then consume the same derived numbers, so
 * the two can never disagree about what a job costs.
 */

import type { ChannelModel, Segment, SystemModel, TaskCosts, TaskModel } from './model.js';
import { lcm, type Micros } from './units.js';

export interface ChannelCost {
  readonly name: string;
  /** Total CPU spent inside the handler, including nested RPCs. */
  readonly serviceUs: Micros;
  /** Channels the handler calls, directly or transitively. */
  readonly nestedChannels: readonly string[];
  readonly hasCriticalSection: boolean;
}

export interface DerivedModel {
  readonly costs: ReadonlyMap<string, TaskCosts>;
  readonly channels: ReadonlyMap<string, ChannelCost>;
  /**
   * Hyperperiod for periodic tasks, or the longest period when the LCM would
   * exceed the analysis cap (keeps simulation time bounded).
   */
  readonly hyperperiodUs: Micros;
  readonly totalUtilization: number;
}

/** Hard cap so a pathological set of periods cannot hang the tool. */
const HYPERPERIOD_CAP_US = 60_000_000; // 60 s

export function derive(model: SystemModel): DerivedModel {
  const channelCosts = deriveChannels(model);
  const costs = new Map<string, TaskCosts>();
  for (const task of model.tasks) {
    costs.set(task.name, deriveTask(model, task, channelCosts));
  }
  return {
    costs,
    channels: channelCosts,
    hyperperiodUs: computeHyperperiod(model),
    totalUtilization: totalUtilization(model, costs),
  };
}

function deriveChannels(model: SystemModel): Map<string, ChannelCost> {
  const byName = new Map(model.channels.map((c) => [c.name, c]));
  const memo = new Map<string, ChannelCost>();
  const visiting = new Set<string>();

  const resolve = (channel: ChannelModel): ChannelCost => {
    const cached = memo.get(channel.name);
    if (cached) return cached;
    if (visiting.has(channel.name)) {
      // Cycles are reported by the validator; return the local cost so the
      // rest of the derivation still produces usable numbers.
      return { name: channel.name, serviceUs: 0, nestedChannels: [], hasCriticalSection: false };
    }
    visiting.add(channel.name);
    let serviceUs = 0;
    const nestedChannels: string[] = [];
    let hasCriticalSection = false;
    for (const segment of channel.handler) {
      if (segment.kind === 'cpu') serviceUs += segment.us;
      else if (segment.kind === 'cs') {
        serviceUs += segment.workUs;
        hasCriticalSection = true;
      } else if (segment.kind === 'rpc') {
        const nested = byName.get(segment.channel);
        if (nested) {
          nestedChannels.push(nested.name);
          serviceUs += resolve(nested).serviceUs;
        }
      }
    }
    visiting.delete(channel.name);
    const cost: ChannelCost = { name: channel.name, serviceUs, nestedChannels, hasCriticalSection };
    memo.set(channel.name, cost);
    return cost;
  };

  for (const channel of model.channels) resolve(channel);
  return memo;
}

function deriveTask(model: SystemModel, task: TaskModel, channels: ReadonlyMap<string, ChannelCost>): TaskCosts {
  const resources = new Map(model.resources.map((r) => [r.name, r]));
  const channelByName = new Map(model.channels.map((c) => [c.name, c]));
  let ownCpuUs = 0;
  let delegatedCpuUs = 0;
  let selfSuspends = false;
  let fixedPriorityBlocking = false;
  const criticalSections: { resource: string; workUs: Micros }[] = [];
  const usedChannels = new Set<string>();

  for (const segment of task.segments) {
    switch (segment.kind) {
      case 'cpu':
        ownCpuUs += segment.us;
        break;
      case 'cs': {
        ownCpuUs += segment.workUs;
        criticalSections.push({ resource: segment.resource, workUs: segment.workUs });
        // PCP can raise the holder to the resource ceiling; count that demand
        // against the holding task so utilisation stays honest.
        const resource = resources.get(segment.resource);
        if (resource?.protocol === 'protect' && resource.ceiling !== undefined && resource.ceiling > task.priority) {
          // Demand is still the holder's CPU; only the priority changes.
        }
        break;
      }
      case 'rpc': {
        usedChannels.add(segment.channel);
        const channel = channelByName.get(segment.channel);
        const cost = channel ? channels.get(channel.name) : undefined;
        if (cost) delegatedCpuUs += cost.serviceUs;
        if (channel?.fixedPriority && channel.basePriority < task.priority) fixedPriorityBlocking = true;
        break;
      }
      case 'sleep':
        selfSuspends = true;
        break;
      case 'yield':
      case 'setPriority':
        break;
    }
  }

  const activations = 2; // enter + leave the CPU at minimum
  const executionUs = ownCpuUs + delegatedCpuUs + activations * model.cpu.contextSwitchUs;
  return {
    ownCpuUs,
    delegatedCpuUs,
    executionUs,
    criticalSections,
    channels: [...usedChannels],
    selfSuspends,
    activations,
    fixedPriorityBlocking,
  } as TaskCosts & { fixedPriorityBlocking: boolean };
}

export function taskPeriodUs(task: TaskModel): Micros {
  switch (task.activation.type) {
    case 'periodic':
      return task.activation.periodUs;
    case 'sporadic':
      return task.activation.minInterarrivalUs;
    case 'aperiodic':
      return task.activation.meanInterarrivalUs;
  }
}

function computeHyperperiod(model: SystemModel): Micros {
  const periods = model.tasks
    .filter((t) => t.activation.type === 'periodic')
    .map((t) => Math.round(taskPeriodUs(t)));
  if (periods.length === 0) {
    return Math.max(1, ...model.tasks.map((t) => Math.round(taskPeriodUs(t))));
  }
  let value = periods[0] ?? 1;
  for (const period of periods.slice(1)) {
    value = lcm(value, period);
    if (value > HYPERPERIOD_CAP_US) {
      return Math.max(...periods);
    }
  }
  return Math.max(1, value);
}

function totalUtilization(model: SystemModel, costs: ReadonlyMap<string, TaskCosts>): number {
  let utilization = 0;
  for (const task of model.tasks) {
    if (task.activation.type === 'aperiodic') continue;
    const cost = costs.get(task.name);
    if (!cost) continue;
    utilization += cost.executionUs / taskPeriodUs(task);
  }
  return utilization;
}

/** Total CPU requested by one invocation of a channel's handler. */
export function segmentCpuUs(segments: readonly Segment[]): Micros {
  let total = 0;
  for (const segment of segments) {
    if (segment.kind === 'cpu') total += segment.us;
    else if (segment.kind === 'cs') total += segment.workUs;
  }
  return total;
}
