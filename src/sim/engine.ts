/**
 * Deterministic discrete-event simulator of the QNX OS 8.0 scheduler.
 *
 * The simulator models a single CPU and the mechanisms that actually decide
 * latency on QNX:
 *
 *  - one ready queue per priority, FIFO within a priority, with the QNX rule
 *    that a preempted thread stays at the head of its queue;
 *  - FIFO, round-robin (timeslice = ticks x clock period) and sporadic
 *    scheduling with budget exhaustion and replenishment;
 *  - mutex priority inheritance (PTHREAD_PRIO_INHERIT), priority ceiling
 *    (PTHREAD_PRIO_PROTECT) and the "no inheritance" trap;
 *  - message-driven priority inheritance: the receiving server is boosted when
 *    the client sends and keeps that priority after replying, as documented in
 *    the QNX System Architecture guide;
 *  - channels created with _NTO_CHF_FIXED_PRIORITY, where the server never
 *    inherits;
 *  - interrupt service threads that preempt every thread, plus context-switch
 *    cost charged as kernel time.
 *
 * The simulator is deterministic: the same model and seed produce the same
 * trace, byte for byte. That is what makes reports reproducible and golden
 * tests possible.
 */

import type { Diagnostic } from '../core/diagnostics.js';
import { DiagnosticBag } from '../core/diagnostics.js';
import { derive, taskPeriodUs, type DerivedModel } from '../core/derive.js';
import type { ChannelModel, SchedulingPolicy, Segment, SystemModel, TaskModel } from '../core/model.js';
import type { Micros } from '../core/units.js';

export type TraceKind = 'run' | 'irq' | 'kernel' | 'idle';

export interface TraceSlice {
  readonly start: Micros;
  readonly end: Micros;
  /** Lane name: task name, "irq", "kernel", "idle" or "server:<channel>#<n>". */
  readonly lane: string;
  readonly kind: TraceKind;
  readonly segment?: string;
  readonly job?: number;
  readonly priority?: number;
}

export type SimEventType =
  | 'release'
  | 'complete'
  | 'block'
  | 'unblock'
  | 'preempt'
  | 'deadline-miss'
  | 'overrun'
  | 'sporadic-drop'
  | 'replenish'
  | 'priority-inherit'
  | 'reply';

export interface SimEvent {
  readonly t: Micros;
  readonly type: SimEventType;
  readonly thread: string;
  readonly detail?: string;
  readonly priority?: number;
}

export interface Inversion {
  readonly task: string;
  readonly blocker: string;
  readonly resource: string;
  readonly kind: 'mutex' | 'message';
  readonly start: Micros;
  readonly end: Micros;
  readonly durationUs: Micros;
  readonly mitigated: boolean;
  readonly detail: string;
}

export interface DeadlineMiss {
  readonly task: string;
  readonly job: number;
  readonly release: Micros;
  readonly completion: Micros;
  readonly deadline: Micros;
  readonly latenessUs: Micros;
  readonly blockedUs: Micros;
  readonly readyWaitUs: Micros;
  readonly cpuUs: Micros;
  readonly cause: 'blocking' | 'interference' | 'overrun';
}

export interface TaskSimStats {
  readonly name: string;
  readonly priority: number;
  readonly policy: SchedulingPolicy;
  readonly activations: number;
  readonly completed: number;
  readonly misses: number;
  readonly overruns: number;
  readonly maxResponseUs: Micros;
  readonly meanResponseUs: Micros;
  readonly minResponseUs: Micros;
  readonly jitterUs: Micros;
  readonly maxBlockedUs: Micros;
  readonly cpuUs: Micros;
  /** Activations that had not finished when the simulation window closed. */
  readonly unfinished: number;
}

export interface ChannelSimStats {
  readonly name: string;
  readonly requests: number;
  readonly maxServiceUs: Micros;
  readonly meanServiceUs: Micros;
  readonly threadCount: number;
}

export interface SimResult {
  readonly horizonUs: Micros;
  readonly traces: readonly TraceSlice[];
  readonly events: readonly SimEvent[];
  readonly tasks: readonly TaskSimStats[];
  readonly channels: readonly ChannelSimStats[];
  readonly inversions: readonly Inversion[];
  readonly deadlineMisses: readonly DeadlineMiss[];
  readonly diagnostics: readonly Diagnostic[];
  readonly kernelUs: Micros;
  readonly irqUs: Micros;
  readonly idleUs: Micros;
  readonly contextSwitches: number;
  readonly completedJobs: number;
  readonly seed: number;
}

export interface SimulateOptions {
  readonly durationUs?: Micros;
  readonly seed?: number;
}

export function simulate(model: SystemModel, options: SimulateOptions = {}): SimResult {
  return new Simulator(model, options).run();
}

type ThreadState = 'ready' | 'running' | 'blocked' | 'done';

type BlockReason =
  | { readonly type: 'activation' }
  | { readonly type: 'mutex'; readonly resource: string }
  | { readonly type: 'send'; readonly channel: string }
  | { readonly type: 'receive' }
  | { readonly type: 'sleep' }
  | { readonly type: 'free' };

interface JobState {
  readonly seq: number;
  readonly release: Micros;
  readonly deadlineRel: Micros;
  cpuUs: Micros;
  blockedUs: Micros;
  blockedAt: Micros;
}

interface InversionState {
  readonly resource: string;
  readonly kind: 'mutex' | 'message';
  readonly blockerId: number;
  readonly start: Micros;
  readonly detail: string;
}

interface SporadicState {
  readonly lowPriority: number;
  readonly initBudgetUs: Micros;
  readonly replenishPeriodUs: Micros;
  readonly maxReplenishments: number;
}

interface Thread {
  readonly id: number;
  readonly name: string;
  readonly lane: string;
  readonly kind: 'task' | 'server';
  readonly task?: TaskModel;
  readonly channel?: ChannelModel;
  basePriority: number;
  /** Priority inherited from servicing messages; sticky, per QNX semantics. */
  msgPriority: number;
  effectivePriority: number;
  readonly policy: SchedulingPolicy;
  readonly sporadic?: SporadicState;
  budgetRemaining: Micros;
  replenishAt: number;
  pendingReplenishments: number;
  dropped: boolean;
  state: ThreadState;
  block: BlockReason;
  readonly program: readonly Segment[];
  pc: number;
  remaining: Micros;
  /** Microseconds consumed in the current round-robin timeslice. */
  timesliceUsed: Micros;
  /** Set when a mutex was handed over directly at unlock time. */
  acquired: boolean;
  segmentLabel: string;
  job?: JobState;
  activation: number;
  nextRelease: number;
  nextJobSeq: number;
  pendingJob: { seq: number; release: Micros; deadlineRel: Micros } | null;
  live: boolean;
  inversion?: InversionState;
  request?: { clientId: number; seq: number; channel: string; startedAt: Micros };
}

interface MutexState {
  readonly resource: string;
  ownerId: number | null;
  waiters: number[];
  readonly protocol: 'none' | 'inherit' | 'protect';
  readonly ceiling?: number;
}

interface ChannelState {
  readonly model: ChannelModel;
  readonly serverIds: number[];
  readonly recvBlocked: number[];
  readonly pending: number[];
}

const EPSILON = 1e-9;
const MAX_STEPS = 4_000_000;
const ROUND_ROBIN_TICKS_DEFAULT = 4;

class Simulator {
  private readonly model: SystemModel;
  private readonly derived: DerivedModel;
  private readonly bag = new DiagnosticBag();
  private readonly threads = new Map<number, Thread>();
  private readonly taskThreads = new Map<string, Thread>();
  private readonly mutexes = new Map<string, MutexState>();
  private readonly channels = new Map<string, ChannelState>();
  private readonly ready = new Map<number, number[]>();
  private readonly traces: TraceSlice[] = [];
  private readonly events: SimEvent[] = [];
  private readonly inversions: Inversion[] = [];
  private readonly misses: DeadlineMiss[] = [];
  private readonly responses = new Map<string, number[]>();
  /** Total CPU microseconds consumed per task, charged when a job completes. */
  private readonly cpuByTask = new Map<string, Micros>();
  private readonly channelStats = new Map<string, { requests: number; totalService: number; maxService: number }>();
  private readonly releaseQueue: { time: number; threadId: number }[] = [];

  private now = 0;
  private readonly horizon: number;
  private readonly seed: number;
  private readonly timesliceUs: number;
  private rng: number;
  private nextThreadId = 1;
  private irqTimers: { lane: string; periodUs: number; serviceUs: number; next: number }[] = [];
  private runningId: number | null = null;
  private kernelUs = 0;
  private irqUs = 0;
  private idleUs = 0;
  private contextSwitches = 0;
  private completedJobs = 0;
  private overruns = 0;
  private spin = 0;

  constructor(model: SystemModel, options: SimulateOptions) {
    this.model = model;
    this.derived = derive(model);
    this.seed = options.seed ?? model.simulation.seed;
    this.rng = (this.seed >>> 0) || 1;
    this.horizon = options.durationUs ?? model.simulation.durationUs ?? defaultHorizon(model, this.derived);
    const ticks = model.clock.roundRobinTimesliceTicks || ROUND_ROBIN_TICKS_DEFAULT;
    this.timesliceUs = Math.max(1, ticks * model.clock.periodUs);
  }

  run(): SimResult {
    this.build();
    this.primeInterrupts();

    let steps = 0;
    while (this.now < this.horizon) {
      steps += 1;
      if (steps > MAX_STEPS) {
        this.bag.warn('W_SIM_LIMIT', 'Simulation stopped at the internal step limit; shorten the duration or simplify the model.');
        break;
      }
      this.processTimers();
      this.processReleases();
      const nextEvent = Math.min(this.nextTimerTime(), this.horizon);
      const next = this.pickRunnable();

      if (next === null) {
        const target = Math.min(nextEvent, this.horizon);
        if (!(target > this.now)) break;
        this.record(this.now, target, 'idle', 'idle');
        this.idleUs += target - this.now;
        this.now = target;
        continue;
      }

      if (this.runningId !== next) this.dispatch(next);
      const thread = this.threads.get(next);
      if (!thread) break;
      // Two things can cut a run short: an expiring round-robin timeslice and an
      // expiring sporadic budget. Stop exactly on the boundary so the policy
      // change happens before the thread runs on borrowed time.
      const budgetEnd =
        thread.policy === 'rr'
          ? this.now + Math.max(0, this.timesliceUs - thread.timesliceUsed)
          : thread.sporadic && !thread.dropped
            ? this.now + Math.max(0, thread.budgetRemaining)
            : Number.POSITIVE_INFINITY;
      const sliceEnd = Math.min(this.now + thread.remaining, nextEvent, this.horizon, budgetEnd);
      const slice = sliceEnd - this.now;

      if (slice <= EPSILON) {
        if (thread.remaining <= EPSILON) {
          this.completeSegment(thread);
          continue;
        }
        this.spin += 1;
        if (this.spin > 32) {
          // Defensive: never let a modelling corner case hang the tool.
          this.now = Math.min(this.horizon, this.now + 1);
          this.spin = 0;
        }
        continue;
      }
      this.spin = 0;
      this.execute(thread, slice);
      this.now = sliceEnd;
      if (thread.remaining <= EPSILON) this.completeSegment(thread);
    }

    this.trimTrace();
    return this.result();
  }

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */

  private build(): void {
    for (const resource of this.model.resources) {
      this.mutexes.set(resource.name, {
        resource: resource.name,
        ownerId: null,
        waiters: [],
        protocol: resource.protocol,
        ...(resource.ceiling !== undefined ? { ceiling: resource.ceiling } : {}),
      });
    }

    for (const channel of this.model.channels) {
      const state: ChannelState = { model: channel, serverIds: [], recvBlocked: [], pending: [] };
      this.channels.set(channel.name, state);
      this.channelStats.set(channel.name, { requests: 0, totalService: 0, maxService: 0 });
      for (let i = 0; i < channel.serverThreads; i += 1) {
        const thread = this.createThread({
          name: channel.name,
          lane: 'server:' + channel.name + '#' + String(i + 1),
          kind: 'server',
          channel,
          basePriority: channel.basePriority,
          policy: 'fifo',
          program: channel.handler,
        });
        state.serverIds.push(thread.id);
        state.recvBlocked.push(thread.id);
        thread.block = { type: 'receive' };
      }
    }

    for (const task of this.model.tasks) {
      const thread = this.createThread({
        name: task.name,
        lane: task.name,
        kind: 'task',
        task,
        basePriority: task.priority,
        policy: task.policy,
        program: task.segments,
        ...(task.sporadic !== undefined
          ? {
              sporadic: {
                lowPriority: task.sporadic.lowPriority,
                initBudgetUs: task.sporadic.initBudgetUs,
                replenishPeriodUs: task.sporadic.replenishPeriodUs,
                maxReplenishments: task.sporadic.maxReplenishments,
              },
            }
          : {}),
      });
      this.taskThreads.set(task.name, thread);
      this.responses.set(task.name, []);
      const offset = task.activation.offsetUs;
      this.releaseQueue.push({ time: offset, threadId: thread.id });
      thread.nextRelease = offset;
    }
    this.releaseQueue.sort((a, b) => a.time - b.time);
  }

  private createThread(spec: {
    name: string;
    lane: string;
    kind: 'task' | 'server';
    task?: TaskModel;
    channel?: ChannelModel;
    basePriority: number;
    policy: SchedulingPolicy;
    program: readonly Segment[];
    sporadic?: SporadicState;
  }): Thread {
    const id = this.nextThreadId;
    this.nextThreadId += 1;
    const thread: Thread = {
      id,
      name: spec.name,
      lane: spec.lane,
      kind: spec.kind,
      ...(spec.task ? { task: spec.task } : {}),
      ...(spec.channel ? { channel: spec.channel } : {}),
      basePriority: spec.basePriority,
      // Message-driven inheritance starts at zero: a task that drops to its
      // sporadic low priority must actually lose the CPU, and a server only
      // inherits while it is serving a client.
      msgPriority: 0,
      effectivePriority: spec.basePriority,
      policy: spec.policy,
      ...(spec.sporadic ? { sporadic: spec.sporadic } : {}),
      budgetRemaining: spec.sporadic ? spec.sporadic.initBudgetUs : Number.POSITIVE_INFINITY,
      replenishAt: Number.POSITIVE_INFINITY,
      pendingReplenishments: 0,
      dropped: false,
      state: 'blocked',
      block: spec.kind === 'server' ? { type: 'receive' } : { type: 'activation' },
      program: spec.program,
      pc: 0,
      remaining: 0,
      timesliceUsed: 0,
      acquired: false,
      segmentLabel: '',
      activation: 0,
      nextRelease: Number.POSITIVE_INFINITY,
      nextJobSeq: 1,
      pendingJob: null,
      live: true,
    };
    this.threads.set(id, thread);
    return thread;
  }

  private primeInterrupts(): void {
    const irq = this.model.interrupts;
    if (irq.entryOverheadUs > 0 && this.model.clock.periodUs > 0) {
      this.irqTimers.push({
        lane: 'clock',
        periodUs: this.model.clock.periodUs,
        serviceUs: irq.entryOverheadUs,
        next: this.model.clock.periodUs,
      });
    }
    for (const source of irq.sources) {
      this.irqTimers.push({ lane: source.name, periodUs: source.periodUs, serviceUs: source.serviceUs, next: source.periodUs });
    }
    this.irqTimers.sort((a, b) => a.next - b.next);
  }

  /* ------------------------------------------------------------------ */
  /* Timers and releases                                                 */
  /* ------------------------------------------------------------------ */

  private nextTimerTime(): number {
    let next = Number.POSITIVE_INFINITY;
    const head = this.releaseQueue[0];
    if (head) next = head.time;
    for (const thread of this.threads.values()) {
      if (thread.state === 'blocked' && thread.block.type === 'sleep') {
        next = Math.min(next, thread.nextRelease);
      }
      if (thread.replenishAt < next) next = thread.replenishAt;
    }
    for (const timer of this.irqTimers) {
      if (timer.next < next) next = timer.next;
    }
    return next;
  }

  private processTimers(): void {
    for (const timer of this.irqTimers) {
      while (timer.next <= this.now + EPSILON) {
        const end = this.now + timer.serviceUs;
        this.record(this.now, end, 'irq:' + timer.lane, 'irq');
        this.irqUs += timer.serviceUs;
        this.now = end;
        timer.next += timer.periodUs;
      }
    }
    for (const thread of this.threads.values()) {
      if (thread.state === 'blocked' && thread.block.type === 'sleep' && thread.nextRelease <= this.now + EPSILON) {
        thread.pc += 1;
        this.becomeReady(thread, false, 'wake');
        this.resume(thread);
      }
      if (thread.replenishAt <= this.now + EPSILON) this.replenish(thread);
    }
  }

  private processReleases(): void {
    for (;;) {
      const head = this.releaseQueue[0];
      if (!head || head.time > this.now + EPSILON) return;
      this.releaseQueue.shift();
      const thread = this.threads.get(head.threadId);
      if (!thread || !thread.live) continue;
      this.release(thread);
    }
  }

  private release(thread: Thread): void {
    if (thread.activation >= this.model.simulation.maxJobsPerTask) {
      thread.live = false;
      return;
    }
    thread.activation += 1;
    const task = thread.task;
    if (!task) return;
    const releaseTime = this.now;
    const deadlineRel = task.deadlineUs;
    const seq = thread.activation;

    if (thread.state === 'blocked' && thread.block.type === 'activation' && thread.pendingJob === null) {
      this.startJob(thread, seq, releaseTime, deadlineRel);
    } else if (thread.pendingJob === null) {
      thread.pendingJob = { seq, release: releaseTime, deadlineRel };
      this.overruns += 1;
      this.events.push({ t: this.now, type: 'overrun', thread: thread.name, detail: 'activation while the previous job is still active' });
    } else {
      this.overruns += 1;
      this.events.push({ t: this.now, type: 'overrun', thread: thread.name, detail: 'backlog full; activation dropped' });
    }

    const activation = task.activation;
    let period: number;
    switch (activation.type) {
      case 'periodic':
        period = activation.periodUs;
        break;
      case 'sporadic':
        period = activation.minInterarrivalUs;
        break;
      case 'aperiodic':
        period = this.aperiodicGap(activation.meanInterarrivalUs);
        break;
    }
    thread.nextRelease = releaseTime + period;
    this.releaseQueue.push({ time: thread.nextRelease, threadId: thread.id });
    this.releaseQueue.sort((a, b) => a.time - b.time);
  }

  private startJob(thread: Thread, seq: number, release: Micros, deadlineRel: Micros): void {
    thread.job = { seq, release, deadlineRel, cpuUs: 0, blockedUs: 0, blockedAt: release };
    thread.pc = 0;
    thread.remaining = 0;
    thread.pendingJob = null;
    this.events.push({ t: this.now, type: 'release', thread: thread.name, priority: thread.effectivePriority });
    this.resume(thread);
  }

  private aperiodicGap(meanUs: Micros): Micros {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    const unit = this.rng / 0xffffffff;
    return Math.max(1, Math.round(meanUs * (0.25 + 1.5 * unit)));
  }

  /* ------------------------------------------------------------------ */
  /* Ready queues                                                        */
  /* ------------------------------------------------------------------ */

  private pushReady(thread: Thread, front: boolean): void {
    const queue = this.ready.get(thread.effectivePriority) ?? [];
    if (queue.includes(thread.id)) return;
    if (front) queue.unshift(thread.id);
    else queue.push(thread.id);
    this.ready.set(thread.effectivePriority, queue);
  }

  private removeReady(thread: Thread): void {
    for (const [priority, queue] of this.ready) {
      const index = queue.indexOf(thread.id);
      if (index >= 0) {
        queue.splice(index, 1);
        this.ready.set(priority, queue);
        return;
      }
    }
  }

  private moveReadyToTail(thread: Thread): void {
    const queue = this.ready.get(thread.effectivePriority);
    if (!queue) return;
    const index = queue.indexOf(thread.id);
    if (index < 0) return;
    queue.splice(index, 1);
    queue.push(thread.id);
  }

  private pickRunnable(): number | null {
    let bestPriority = -Infinity;
    let best: number | null = null;
    for (const [priority, queue] of this.ready) {
      if (queue.length === 0) continue;
      if (priority > bestPriority) {
        bestPriority = priority;
        best = queue[0] ?? null;
      }
    }
    return best;
  }

  private dispatch(id: number): void {
    if (this.model.cpu.contextSwitchUs > 0) {
      const cost = this.model.cpu.contextSwitchUs;
      this.record(this.now, this.now + cost, 'kernel', 'kernel');
      this.kernelUs += cost;
      this.now += cost;
    }
    if (this.runningId !== null) {
      const previous = this.threads.get(this.runningId);
      const nextThread = this.threads.get(id);
      if (previous && nextThread && previous.effectivePriority < nextThread.effectivePriority) {
        this.events.push({ t: this.now, type: 'preempt', thread: previous.name, detail: 'by ' + nextThread.name });
      }
    }
    this.contextSwitches += 1;
    this.runningId = id;
  }

  private execute(thread: Thread, slice: Micros): void {
    const start = this.now;
    this.record(start, start + slice, thread.lane, 'run', thread.segmentLabel, thread.job?.seq, thread.effectivePriority);
    thread.remaining -= slice;
    if (thread.job) thread.job.cpuUs += slice;
    // Account at the end of the slice so the events this triggers (budget
    // exhausted, timeslice expired) carry the time they actually happened.
    this.now = start + slice;
    if (thread.sporadic && !thread.dropped) {
      thread.budgetRemaining -= slice;
      if (thread.budgetRemaining <= EPSILON) this.dropToLowPriority(thread);
    }
    if (thread.policy === 'rr') {
      thread.timesliceUsed += slice;
      if (thread.timesliceUsed >= this.timesliceUs - EPSILON) {
        thread.timesliceUsed = 0;
        this.moveReadyToTail(thread);
        this.events.push({ t: this.now, type: 'preempt', thread: thread.name, detail: 'round-robin timeslice expired' });
      }
    }
  }

  private record(start: Micros, end: Micros, lane: string, kind: TraceKind, segment?: string, job?: number, priority?: number): void {
    if (end - start <= EPSILON) return;
    const last = this.traces[this.traces.length - 1];
    if (
      last &&
      last.lane === lane &&
      last.kind === kind &&
      last.segment === segment &&
      last.job === job &&
      last.priority === priority &&
      Math.abs(last.end - start) < EPSILON
    ) {
      this.traces[this.traces.length - 1] = { ...last, end };
      return;
    }
    this.traces.push({
      start,
      end,
      lane,
      kind,
      ...(segment !== undefined ? { segment } : {}),
      ...(job !== undefined ? { job } : {}),
      ...(priority !== undefined ? { priority } : {}),
    });
  }

  private becomeReady(thread: Thread, front: boolean, reason: string): void {
    const wasBlocked = thread.state === 'blocked';
    if (wasBlocked && thread.job) {
      thread.job.blockedUs += Math.max(0, this.now - thread.job.blockedAt);
    }
    thread.state = 'ready';
    thread.block = { type: 'free' };
    this.pushReady(thread, front);
    if (wasBlocked) {
      this.events.push({ t: this.now, type: 'unblock', thread: thread.name, detail: reason });
    }
    this.recomputePriorities();
  }

  private blockCurrent(thread: Thread, reason: BlockReason, detail: string): void {
    thread.state = 'blocked';
    thread.block = reason;
    if (thread.job) thread.job.blockedAt = this.now;
    this.removeReady(thread);
    if (this.runningId === thread.id) this.runningId = null;
    this.events.push({ t: this.now, type: 'block', thread: thread.name, detail });
  }

  /* ------------------------------------------------------------------ */
  /* Priorities                                                          */
  /* ------------------------------------------------------------------ */

  private recomputePriorities(): void {
    for (let round = 0; round < 12; round += 1) {
      let changed = false;
      for (const thread of this.threads.values()) {
        if (thread.state === 'done') continue;
        const base = thread.sporadic && thread.dropped ? thread.sporadic.lowPriority : thread.basePriority;
        let priority = Math.max(base, thread.msgPriority);
        for (const mutex of this.mutexes.values()) {
          if (mutex.ownerId !== thread.id) continue;
          if (mutex.protocol === 'none') continue;
          for (const waiterId of mutex.waiters) {
            const waiter = this.threads.get(waiterId);
            if (waiter) priority = Math.max(priority, waiter.effectivePriority);
          }
        }
        if (priority !== thread.effectivePriority) {
          const raised = priority > thread.effectivePriority;
          const wasQueued = thread.state === 'ready';
          if (wasQueued) this.removeReady(thread);
          thread.effectivePriority = priority;
          if (wasQueued) this.pushReady(thread, raised);
          changed = true;
        }
      }
      if (!changed) return;
    }
    this.bag.warn('W_PRIORITY_FIXPOINT', 'Priority inheritance did not stabilise; the model may contain a mutex cycle.');
  }

  private dropToLowPriority(thread: Thread): void {
    if (!thread.sporadic || thread.dropped) return;
    thread.dropped = true;
    thread.budgetRemaining = 0;
    thread.pendingReplenishments = Math.min(thread.sporadic.maxReplenishments, thread.pendingReplenishments + 1);
    if (thread.replenishAt === Number.POSITIVE_INFINITY) {
      thread.replenishAt = this.now + thread.sporadic.replenishPeriodUs;
    }
    this.events.push({
      t: this.now,
      type: 'sporadic-drop',
      thread: thread.name,
      detail: 'budget exhausted; running at ' + String(thread.sporadic.lowPriority),
    });
    this.recomputePriorities();
  }

  private replenish(thread: Thread): void {
    if (!thread.sporadic) {
      thread.replenishAt = Number.POSITIVE_INFINITY;
      return;
    }
    thread.pendingReplenishments = Math.max(0, thread.pendingReplenishments - 1);
    thread.budgetRemaining = thread.sporadic.initBudgetUs;
    thread.dropped = false;
    thread.replenishAt =
      thread.pendingReplenishments > 0 ? this.now + thread.sporadic.replenishPeriodUs : Number.POSITIVE_INFINITY;
    this.events.push({ t: this.now, type: 'replenish', thread: thread.name, detail: 'execution budget replenished' });
    this.recomputePriorities();
  }

  /* ------------------------------------------------------------------ */
  /* Program execution                                                   */
  /* ------------------------------------------------------------------ */

  private resume(thread: Thread): void {
    for (;;) {
      const segment = thread.program[thread.pc];
      if (!segment) {
        this.completeProgram(thread);
        return;
      }
      switch (segment.kind) {
        case 'cpu':
          if (segment.us <= EPSILON) {
            thread.pc += 1;
            continue;
          }
          thread.remaining = segment.us;
          thread.segmentLabel = 'cpu';
          thread.state = 'ready';
          this.pushReady(thread, false);
          return;
        case 'cs': {
          thread.segmentLabel = 'cs:' + segment.resource;
          if (!thread.acquired && !this.acquire(thread, segment.resource)) return;
          thread.acquired = false;
          if (segment.workUs <= EPSILON) {
            this.releaseLock(thread, segment.resource);
            thread.pc += 1;
            continue;
          }
          thread.remaining = segment.workUs;
          thread.state = 'ready';
          this.pushReady(thread, false);
          return;
        }
        case 'rpc':
          thread.segmentLabel = 'rpc:' + segment.channel;
          this.send(thread, segment.channel);
          return;
        case 'sleep':
          thread.segmentLabel = 'sleep';
          thread.nextRelease = this.now + segment.us;
          this.blockCurrent(thread, { type: 'sleep' }, 'sleep ' + String(segment.us) + 'us');
          return;
        case 'yield':
          thread.pc += 1;
          thread.state = 'ready';
          this.pushReady(thread, false);
          this.moveReadyToTail(thread);
          return;
        case 'setPriority':
          thread.basePriority = segment.priority;
          thread.pc += 1;
          this.recomputePriorities();
          continue;
      }
    }
  }

  private completeSegment(thread: Thread): void {
    const segment = thread.program[thread.pc];
    if (segment?.kind === 'cs') this.releaseLock(thread, segment.resource);
    thread.pc += 1;
    this.resume(thread);
  }

  private completeProgram(thread: Thread): void {
    if (thread.kind === 'server') {
      this.reply(thread);
      return;
    }
    this.completeJob(thread);
  }

  private completeJob(thread: Thread): void {
    const job = thread.job;
    if (job) {
      const response = this.now - job.release;
      const blockedUs = job.blockedUs;
      const readyWaitUs = Math.max(0, response - job.cpuUs - blockedUs);
      this.completedJobs += 1;
      const list = this.responses.get(thread.name);
      if (list) list.push(response);
      this.cpuByTask.set(thread.name, (this.cpuByTask.get(thread.name) ?? 0) + job.cpuUs);
      this.events.push({ t: this.now, type: 'complete', thread: thread.name, detail: 'response ' + String(Math.round(response)) + 'us' });
      if (response > job.deadlineRel + EPSILON) {
        this.events.push({
          t: this.now,
          type: 'deadline-miss',
          thread: thread.name,
          detail: 'late by ' + String(Math.round(response - job.deadlineRel)) + 'us',
        });
        this.misses.push({
          task: thread.name,
          job: job.seq,
          release: job.release,
          completion: this.now,
          deadline: job.release + job.deadlineRel,
          latenessUs: response - job.deadlineRel,
          blockedUs,
          readyWaitUs,
          cpuUs: job.cpuUs,
          cause: blockedUs > readyWaitUs ? 'blocking' : 'interference',
        });
      }
      thread.job = undefined;
    }

    const pending = thread.pendingJob;
    if (pending) {
      thread.pendingJob = null;
      this.startJob(thread, pending.seq, pending.release, pending.deadlineRel);
      return;
    }
    this.blockCurrent(thread, { type: 'activation' }, 'waiting for next activation');
    thread.pc = 0;
    thread.remaining = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Mutexes                                                             */
  /* ------------------------------------------------------------------ */

  private acquire(thread: Thread, resource: string): boolean {
    const mutex = this.mutexes.get(resource);
    if (!mutex) return true;
    if (mutex.ownerId === null) {
      mutex.ownerId = thread.id;
      return true;
    }
    if (mutex.ownerId === thread.id) {
      this.bag.error('E_SELF_DEADLOCK', thread.name + ' locks "' + resource + '" while already holding it; QNX mutexes are not recursive by default.');
      return true;
    }
    const owner = this.threads.get(mutex.ownerId);
    if (owner && thread.effectivePriority > owner.effectivePriority) {
      thread.inversion = {
        resource,
        kind: 'mutex',
        blockerId: owner.id,
        start: this.now,
        detail:
          mutex.protocol === 'none'
            ? thread.name + ' (' + String(thread.effectivePriority) + ') waits for ' + owner.name + ' (' + String(owner.effectivePriority) + ') holding "' + resource + '" with inheritance disabled'
            : thread.name + ' (' + String(thread.effectivePriority) + ') waits for ' + owner.name + ' (' + String(owner.effectivePriority) + ') holding "' + resource + '"',
      };
    }
    mutex.waiters.push(thread.id);
    this.sortWaiters(mutex);
    this.blockCurrent(thread, { type: 'mutex', resource }, 'mutex ' + resource);
    this.recomputePriorities();
    return false;
  }

  private sortWaiters(mutex: MutexState): void {
    mutex.waiters.sort((a, b) => {
      const ta = this.threads.get(a);
      const tb = this.threads.get(b);
      return (tb?.effectivePriority ?? 0) - (ta?.effectivePriority ?? 0);
    });
  }

  private releaseLock(thread: Thread, resource: string): void {
    const mutex = this.mutexes.get(resource);
    if (!mutex || mutex.ownerId !== thread.id) return;
    mutex.ownerId = null;
    const nextId = mutex.waiters.shift();
    if (nextId !== undefined) {
      const waiter = this.threads.get(nextId);
      if (waiter) {
        mutex.ownerId = waiter.id;
        const segment = waiter.program[waiter.pc];
        if (segment?.kind === 'cs') {
          waiter.acquired = true;
          waiter.remaining = segment.workUs;
          waiter.segmentLabel = 'cs:' + resource;
        }
        this.finishInversion(waiter);
        this.becomeReady(waiter, true, 'acquired ' + resource);
      }
    }
    this.recomputePriorities();
  }

  private finishInversion(thread: Thread): void {
    const inversion = thread.inversion;
    if (!inversion) return;
    thread.inversion = undefined;
    const blocker = this.threads.get(inversion.blockerId);
    const duration = this.now - inversion.start;
    const mitigated =
      inversion.kind === 'mutex'
        ? (this.mutexes.get(inversion.resource)?.protocol ?? 'inherit') !== 'none'
        : !(this.channels.get(inversion.resource)?.model.fixedPriority ?? false);
    if (duration <= EPSILON && mitigated) return;
    this.inversions.push({
      task: thread.name,
      blocker: blocker?.name ?? 'unknown',
      resource: inversion.resource,
      kind: inversion.kind,
      start: inversion.start,
      end: this.now,
      durationUs: duration,
      mitigated,
      detail: inversion.detail,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Message passing                                                     */
  /* ------------------------------------------------------------------ */

  private send(thread: Thread, channelName: string): void {
    const channel = this.channels.get(channelName);
    if (!channel) {
      thread.pc += 1;
      this.resume(thread);
      return;
    }
    const stats = this.channelStats.get(channelName);
    if (stats) stats.requests += 1;
    const clientPriority = thread.effectivePriority;

    // A channel created with _NTO_CHF_FIXED_PRIORITY never boosts its server,
    // so a client that outranks the server inherits the server's latency.
    if (channel.model.fixedPriority) {
      const nextServer = this.threads.get(channel.recvBlocked[0] ?? channel.serverIds[0] ?? -1);
      const serverPriority = nextServer?.effectivePriority ?? channel.model.basePriority;
      if (clientPriority > serverPriority) {
        thread.inversion = {
          resource: channelName,
          kind: 'message',
          blockerId: nextServer?.id ?? -1,
          start: this.now,
          detail:
            thread.name + ' (' + String(clientPriority) + ') sends to "' + channelName +
            '", whose server runs at fixed priority ' + String(channel.model.basePriority),
        };
      }
    }

    const serverId = this.takeReceiver(channel);
    if (serverId !== null) {
      const server = this.threads.get(serverId);
      if (server) {
        this.blockCurrent(thread, { type: 'send', channel: channelName }, 'send ' + channelName);
        this.deliver(server, thread, channelName, clientPriority);
        return;
      }
    }

    channel.pending.push(thread.id);
    this.sortPending(channel);
    this.blockCurrent(thread, { type: 'send', channel: channelName }, 'send ' + channelName + ' (queued)');
  }

  private sortPending(channel: ChannelState): void {
    channel.pending.sort((a, b) => {
      const ta = this.threads.get(a);
      const tb = this.threads.get(b);
      return (tb?.effectivePriority ?? 0) - (ta?.effectivePriority ?? 0);
    });
  }

  private takeReceiver(channel: ChannelState): number | null {
    while (channel.recvBlocked.length > 0) {
      const id = channel.recvBlocked.shift();
      if (id === undefined) return null;
      const candidate = this.threads.get(id);
      if (candidate && candidate.state === 'blocked' && candidate.block.type === 'receive') return id;
    }
    return null;
  }

  private deliver(server: Thread, client: Thread, channelName: string, clientPriority: number): void {
    server.pc = 0;
    server.remaining = 0;
    server.request = { clientId: client.id, seq: client.job?.seq ?? 0, channel: channelName, startedAt: this.now };
    const state = this.channels.get(channelName);
    if (state && !state.model.fixedPriority) {
      if (clientPriority > server.msgPriority) {
        server.msgPriority = clientPriority;
        this.events.push({
          t: this.now,
          type: 'priority-inherit',
          thread: server.name,
          detail: 'boosted to ' + String(clientPriority) + ' by ' + client.name,
          priority: clientPriority,
        });
      }
    }
    this.becomeReady(server, true, 'receive from ' + client.name);
    this.resume(server);
  }

  private reply(server: Thread): void {
    const request = server.request;
    server.request = undefined;
    if (request) {
      const stats = this.channelStats.get(request.channel);
      if (stats) {
        const service = this.now - request.startedAt;
        stats.totalService += service;
        stats.maxService = Math.max(stats.maxService, service);
      }
      const client = this.threads.get(request.clientId);
      if (client) {
        this.finishInversion(client);
        client.pc += 1;
        this.events.push({ t: this.now, type: 'reply', thread: server.name, detail: 'reply to ' + client.name });
        this.becomeReady(client, true, 'reply from ' + server.name);
        this.resume(client);
      }
    }
    const channel = this.channels.get(server.channel?.name ?? '');
    if (!channel) {
      this.blockCurrent(server, { type: 'receive' }, 'receive');
      return;
    }
    const nextClientId = channel.pending.shift();
    if (nextClientId !== undefined) {
      const client = this.threads.get(nextClientId);
      if (client && client.state === 'blocked' && client.block.type === 'send') {
        this.deliver(server, client, channel.model.name, client.effectivePriority);
        return;
      }
    }
    server.pc = 0;
    this.blockCurrent(server, { type: 'receive' }, 'receive');
    channel.recvBlocked.push(server.id);
  }

  /* ------------------------------------------------------------------ */
  /* Results                                                             */
  /* ------------------------------------------------------------------ */

  private trimTrace(): void {
    const last = this.traces[this.traces.length - 1];
    if (last && last.end > this.horizon) {
      this.traces[this.traces.length - 1] = { ...last, end: this.horizon };
    }
  }

  private result(): SimResult {
    const taskStats: TaskSimStats[] = this.model.tasks.map((task) => {
      const responses = this.responses.get(task.name) ?? [];
      const missed = this.misses.filter((m) => m.task === task.name);
      const thread = this.taskThreads.get(task.name);
      const maxResponse = responses.length ? Math.max(...responses) : 0;
      const minResponse = responses.length ? Math.min(...responses) : 0;
      const mean = responses.length ? responses.reduce((sum, value) => sum + value, 0) / responses.length : 0;
      const cpuUs = this.cpuByTask.get(task.name) ?? 0;
      const activations = thread?.activation ?? 0;
      return {
        name: task.name,
        priority: task.priority,
        policy: task.policy,
        activations,
        completed: responses.length,
        unfinished: Math.max(0, activations - responses.length - missed.filter((m) => m.cause === 'overrun').length),
        misses: missed.length,
        overruns: this.events.filter((e) => e.type === 'overrun' && e.thread === task.name).length,
        maxResponseUs: maxResponse,
        meanResponseUs: mean,
        minResponseUs: minResponse,
        jitterUs: maxResponse - minResponse,
        maxBlockedUs: missed.length ? Math.max(...missed.map((m) => m.blockedUs)) : 0,
        cpuUs,
      };
    });

    const channelStats: ChannelSimStats[] = [...this.channels.values()].map((channel) => {
      const stats = this.channelStats.get(channel.model.name);
      const requests = stats?.requests ?? 0;
      return {
        name: channel.model.name,
        requests,
        maxServiceUs: stats?.maxService ?? 0,
        meanServiceUs: requests > 0 ? (stats?.totalService ?? 0) / requests : 0,
        threadCount: channel.serverIds.length,
      };
    });

    return {
      horizonUs: this.horizon,
      traces: this.traces,
      events: this.events,
      tasks: taskStats,
      channels: channelStats,
      inversions: this.inversions,
      deadlineMisses: this.misses,
      diagnostics: this.bag.all,
      kernelUs: this.kernelUs,
      irqUs: this.irqUs,
      idleUs: this.idleUs,
      contextSwitches: this.contextSwitches,
      completedJobs: this.completedJobs,
      seed: this.seed,
    };
  }
}

function defaultHorizon(model: SystemModel, derived: DerivedModel): Micros {
  const longest = Math.max(1, ...model.tasks.map((task) => taskPeriodUs(task)));
  return Math.max(derived.hyperperiodUs, longest * 4);
}
