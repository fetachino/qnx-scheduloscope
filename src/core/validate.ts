/**
 * Semantic validation.
 *
 * Structural parsing answers "is this valid YAML in the right shape?". This pass
 * answers the harder question: "does this system make sense on QNX?". The rules
 * below encode QNX OS 8.0 specifics such as the privileged priority boundary,
 * the reserved IST priorities, message-driven priority inheritance, and the
 * PTHREAD_PRIO_PROTECT ceiling contract.
 */

import type { Diagnostic } from './diagnostics.js';
import { DiagnosticBag } from './diagnostics.js';
import { derive, taskPeriodUs } from './derive.js';
import { PRIORITY_MAX, PRIORITY_MIN, type Segment, type SystemModel } from './model.js';

export function validateModel(model: SystemModel): readonly Diagnostic[] {
  const bag = new DiagnosticBag();
  checkUniqueNames(model, bag);
  checkReferences(model, bag);
  checkPriorities(model, bag);
  checkSchedulingPolicies(model, bag);
  checkSelfSuspension(model, bag);
  checkChannels(model, bag);
  checkChannelCycles(model, bag);
  checkMutexProtocols(model, bag);
  checkInterruptLoad(model, bag);
  checkUtilization(model, bag);
  checkHyperperiod(model, bag);
  return bag.all;
}

function checkUniqueNames(model: SystemModel, bag: DiagnosticBag): void {
  const seen = new Map<string, string>();
  const add = (name: string, kind: string, path: string) => {
    const previous = seen.get(name);
    if (previous) bag.error('E_DUPLICATE', `Duplicate name "${name}"; already used by ${previous}.`, path);
    else seen.set(name, kind);
  };
  model.tasks.forEach((task, i) => add(task.name, 'a task', `tasks[${i}].name`));
  model.resources.forEach((resource, i) => add(resource.name, 'a resource', `resources[${i}].name`));
  model.channels.forEach((channel, i) => add(channel.name, 'a channel', `channels[${i}].name`));
  model.interrupts.sources.forEach((source, i) => add(source.name, 'an interrupt source', `interrupts.sources[${i}].name`));
}

function checkReferences(model: SystemModel, bag: DiagnosticBag): void {
  const resources = new Set(model.resources.map((r) => r.name));
  const channels = new Set(model.channels.map((c) => c.name));
  const checkSegments = (segments: readonly Segment[], base: string) => {
    segments.forEach((segment, i) => {
      if (segment.kind === 'cs') {
        if (!resources.has(segment.resource)) {
          bag.error('E_UNKNOWN_RESOURCE', `Unknown resource "${segment.resource}".`, `${base}[${i}].cs.resource`, 'Declare it under resources.');
        }
      } else if (segment.kind === 'rpc') {
        if (!channels.has(segment.channel)) {
          bag.error('E_UNKNOWN_CHANNEL', `Unknown channel "${segment.channel}".`, `${base}[${i}].rpc.channel`, 'Declare it under channels.');
        }
      }
    });
  };
  model.tasks.forEach((task, i) => checkSegments(task.segments, `tasks[${i}].segments`));
  model.channels.forEach((channel, i) => checkSegments(channel.handler, `channels[${i}].handler`));
}

function checkPriorities(model: SystemModel, bag: DiagnosticBag): void {
  const ceiling = model.cpu.privilegedPriorityCeiling;
  model.tasks.forEach((task, i) => {
    const path = `tasks[${i}].priority`;
    if (task.priority < PRIORITY_MIN || task.priority > PRIORITY_MAX) {
      bag.error('E_PRIORITY_RANGE', `Priority must be between ${PRIORITY_MIN} and ${PRIORITY_MAX}.`, path);
      return;
    }
    if (task.priority >= 254) {
      bag.warn(
        'W_RESERVED_PRIORITY',
        `Priority ${task.priority} is reserved: 254 is the clock IST and 255 the IPI IST.`,
        path,
        'Application threads should stay at or below 253.',
      );
    } else if (task.priority > ceiling) {
      bag.warn(
        'W_PRIVILEGED_PRIORITY',
        `Priority ${task.priority} is above the unprivileged ceiling (${ceiling}); the process needs PROCMGR_AID_PRIORITY.`,
        path,
        'Either lower the priority or grant the ability explicitly with procmgr_ability().',
      );
    }
    if (task.activation.type !== 'aperiodic' && task.deadlineUs > taskPeriodUs(task)) {
      bag.warn(
        'W_DEADLINE_GT_PERIOD',
        `Deadline (${task.deadlineUs}us) exceeds the activation period; overlapping jobs are possible.`,
        `tasks[${i}].deadline`,
        'Models assume at most one active job per task; raise the period or shorten the deadline.',
      );
    }
  });

  model.channels.forEach((channel, i) => {
    if (channel.basePriority >= 254) {
      bag.warn('W_RESERVED_PRIORITY', `Channel server priority ${channel.basePriority} is reserved for ISTs.`, `channels[${i}].basePriority`);
    } else if (channel.basePriority > ceiling) {
      bag.warn('W_PRIVILEGED_PRIORITY', `Server priority ${channel.basePriority} is above the unprivileged ceiling (${ceiling}).`, `channels[${i}].basePriority`);
    }
  });
}

function checkSchedulingPolicies(model: SystemModel, bag: DiagnosticBag): void {
  const byPriority = new Map<number, string[]>();
  for (const task of model.tasks) {
    const list = byPriority.get(task.priority) ?? [];
    list.push(task.name);
    byPriority.set(task.priority, list);
  }
  model.tasks.forEach((task, i) => {
    if (task.policy !== 'sporadic') return;
    const s = task.sporadic;
    if (!s) return; // already reported by the parser
    const path = `tasks[${i}].sporadic`;
    if (s.lowPriority >= task.priority) {
      bag.error('E_SPORADIC_ORDER', `The low priority (${s.lowPriority}) must be lower than the normal priority (${task.priority}).`, `${path}.lowPriority`);
    }
    if (s.initBudgetUs > s.replenishPeriodUs) {
      bag.error(
        'E_SPORADIC_BUDGET',
        `The initial budget (${s.initBudgetUs}us) cannot be larger than the replenishment period (${s.replenishPeriodUs}us); QNX returns EINVAL for that.`,
        `${path}.budget`,
      );
    }
    if (s.maxReplenishments > 32) {
      bag.info(
        'I_SPORADIC_REPL',
        `${s.maxReplenishments} pending replenishments is legal (the kernel allows up to SS_REPL_MAX, 65535) but larger than any design this tool has seen.`,
        `${path}.maxReplenishments`,
      );
    }
    bag.info(
      'I_SPORADIC_BUDGET',
      `Sporadic budget caps this thread at ${((100 * s.initBudgetUs) / s.replenishPeriodUs).toFixed(1)}% of one CPU while others run above its low priority.`,
      path,
    );
  });

  for (const [priority, names] of byPriority) {
    if (names.length > 1) {
      bag.info('I_SHARED_PRIORITY', `${names.join(', ')} share priority ${priority}; their policy (fifo/rr) decides how they interleave.`, undefined);
    }
  }

  model.tasks.forEach((task, i) => {
    if (task.policy !== 'rr') return;
    const peers = byPriority.get(task.priority) ?? [];
    if (peers.length < 2) {
      bag.info(
        'I_RR_NO_PEER',
        `${task.name} uses round-robin but shares its priority with no other thread, so the timeslice never matters.`,
        `tasks[${i}].policy`,
        'Round-robin only arbitrates between equal-priority threads.',
      );
    }
  });
}

function checkSelfSuspension(model: SystemModel, bag: DiagnosticBag): void {
  model.tasks.forEach((task, i) => {
    if (!task.segments.some((s) => s.kind === 'sleep')) return;
    bag.warn(
      'W_SELF_SUSPENSION',
      `${task.name} sleeps inside its job. Classic response-time analysis assumes no self-suspension, so the bound below is optimistic for this task.`,
      `tasks[${i}].segments`,
      'Model the wait as a separate task, or subtract it from the schedulable budget by hand.',
    );
  });
}

function checkChannels(model: SystemModel, bag: DiagnosticBag): void {
  model.channels.forEach((channel, i) => {
    const users = model.tasks.filter((task) => task.segments.some((s) => s.kind === 'rpc' && s.channel === channel.name));
    if (users.length === 0) {
      bag.info('I_UNUSED_CHANNEL', `Channel "${channel.name}" has no clients.`, `channels[${i}]`);
    }
    if (channel.fixedPriority) {
      const blocked = users.filter((task) => task.priority > channel.basePriority);
      if (blocked.length > 0) {
        bag.warn(
          'W_FIXED_PRIORITY_INVERSION',
          `Channel "${channel.name}" uses _NTO_CHF_FIXED_PRIORITY, so ${blocked.map((t) => t.name).join(', ')} will wait while the server runs at priority ${channel.basePriority} and can be preempted by everything above it.`,
          `channels[${i}].fixedPriority`,
          'Drop fixedPriority (the default) to get message-driven priority inheritance.',
        );
      }
      if (channel.serverThreads > 1) {
        bag.info(
          'I_FIXED_PRIORITY_THREADS',
          `Channel "${channel.name}" has ${channel.serverThreads} server threads at a fixed priority; requests are served in arrival order among equals.`,
          `channels[${i}].serverThreads`,
        );
      }
    }
    if (channel.serverThreads > 1 && channel.handler.some((s) => s.kind === 'cs')) {
      bag.info(
        'I_MULTI_THREAD_HANDLER',
        `Channel "${channel.name}" has ${channel.serverThreads} server threads that contend on mutexes inside the handler, so handler time is not serialised.`,
        `channels[${i}].serverThreads`,
      );
    }
  });
}

function checkChannelCycles(model: SystemModel, bag: DiagnosticBag): void {
  const byName = new Map(model.channels.map((c) => [c.name, c]));
  const edges = new Map<string, string[]>();
  for (const channel of model.channels) {
    edges.set(
      channel.name,
      channel.handler.filter((s) => s.kind === 'rpc').map((s) => (s as { channel: string }).channel),
    );
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const seenCycles = new Set<string>();
  const walk = (name: string): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      const start = stack.indexOf(name);
      const cycle = [...stack.slice(start), name];
      const key = [...cycle].sort().join('>');
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        const channel = byName.get(name);
        const singleThreaded = cycle.every((c) => (byName.get(c)?.serverThreads ?? 1) === 1);
        const message = `RPC cycle: ${cycle.join(' -> ')}.`;
        if (singleThreaded) {
          bag.error('E_RPC_DEADLOCK', message, 'channels', 'Every server on this cycle has one thread, so the chain deadlocks under load.');
        } else {
          bag.warn('W_RPC_CYCLE', message, 'channels', 'Multiple server threads avoid immediate deadlock but can still starve.');
        }
      }
      return;
    }
    state.set(name, 'visiting');
    stack.push(name);
    for (const next of edges.get(name) ?? []) walk(next);
    stack.pop();
    state.set(name, 'done');
  };
  for (const channel of model.channels) walk(channel.name);
}

function checkMutexProtocols(model: SystemModel, bag: DiagnosticBag): void {
  const byName = new Map(model.resources.map((r) => [r.name, r]));

  model.tasks.forEach((task, i) => {
    task.segments.forEach((segment, j) => {
      if (segment.kind !== 'cs') return;
      const resource = byName.get(segment.resource);
      if (!resource) return;
      if (resource.protocol === 'protect' && resource.ceiling !== undefined && task.priority > resource.ceiling) {
        bag.error(
          'E_CEILING_VIOLATION',
          `${task.name} (priority ${task.priority}) locks "${resource.name}" whose ceiling is ${resource.ceiling}; QNX fails the lock in this case.`,
          `tasks[${i}].segments[${j}].cs.resource`,
          'Raise the ceiling to at least the highest locker priority.',
        );
      }
    });
  });

  for (const resource of model.resources) {
    const lockers = model.tasks
      .map((task) => ({ task, sections: task.segments.filter((s) => s.kind === 'cs' && (s as { resource: string }).resource === resource.name) }))
      .filter((entry) => entry.sections.length > 0);
    if (lockers.length === 0) {
      bag.info('I_UNUSED_RESOURCE', `Resource "${resource.name}" is never locked.`);
      continue;
    }
    const priorities = new Set(lockers.map((entry) => entry.task.priority));
    if (resource.protocol === 'none' && priorities.size > 1) {
      bag.warn(
        'W_NO_INHERITANCE',
        `"${resource.name}" has protocol "none" but is shared by threads at different priorities; a blocked high-priority thread cannot bound its wait.`,
        `resources`,
        'Remove the explicit "protocol: none" to keep the QNX default of PTHREAD_PRIO_INHERIT.',
      );
    }
    if (resource.protocol === 'none' && lockers.length === 1) {
      bag.info('I_NONE_UNCONTESTED', `"${resource.name}" uses protocol "none" and has a single locker, so inversion cannot occur.`, undefined);
    }
  }
}

function checkInterruptLoad(model: SystemModel, bag: DiagnosticBag): void {
  for (const source of model.interrupts.sources) {
    const load = source.serviceUs / source.periodUs;
    if (load >= 1) {
      bag.error('E_ISR_OVERLOAD', `Interrupt source "${source.name}" demands ${(load * 100).toFixed(0)}% of the CPU by itself.`, `interrupts.sources`);
    } else if (load > 0.25) {
      bag.warn(
        'W_ISR_LOAD',
        `Interrupt source "${source.name}" consumes ${(load * 100).toFixed(1)}% of the CPU in the IST, which preempts every thread.`,
        `interrupts.sources`,
      );
    }
  }
}

function checkUtilization(model: SystemModel, bag: DiagnosticBag): void {
  const derived = derive(model);
  if (derived.totalUtilization > 1) {
    bag.error(
      'E_OVERLOADED',
      `Total CPU utilisation is ${(derived.totalUtilization * 100).toFixed(1)}%; no priority assignment can make this set schedulable.`,
      'tasks',
      'Reduce execution time or increase periods.',
    );
  } else if (derived.totalUtilization > 0.9) {
    bag.warn(
      'W_HIGH_UTILIZATION',
      `CPU utilisation is ${(derived.totalUtilization * 100).toFixed(1)}%; response times will be sensitive to any extra work.`,
      'tasks',
    );
  }
}

function checkHyperperiod(model: SystemModel, bag: DiagnosticBag): void {
  const derived = derive(model);
  const periods = model.tasks.filter((t) => t.activation.type === 'periodic').map(taskPeriodUs);
  if (periods.length < 2) return;
  const product = periods.reduce((acc, p) => acc * p, 1);
  if (derived.hyperperiodUs < product / 1000) {
    bag.info(
      'I_HYPERPERIOD_CAPPED',
      `The exact hyperperiod is very large; simulation is capped at ${(derived.hyperperiodUs / 1000).toFixed(1)}ms.`,
      'tasks',
    );
  }
}
