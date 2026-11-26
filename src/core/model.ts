/**
 * The Scheduloscope system model.
 *
 * The model is a deliberately small, explicit description of a QNX OS 8.0
 * real-time design: threads, their scheduling policies and priorities, the
 * mutexes and message channels they share, and the interrupts that preempt
 * everything. Both the analytical engine and the simulator consume exactly this
 * structure, so a design cannot drift between "the spreadsheet analysis" and
 * "the simulation".
 */

import type { Micros } from './units.js';

export const SCHEMA_ID = 'scheduloscope/v1';

/** QNX supports 256 priority levels. */
export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 255;
/** procnto reserves the top two levels for ISTs. */
export const IST_CLOCK_PRIORITY = 254;
export const IST_IPI_PRIORITY = 255;
/** procnto -P defaults to 63; higher priorities need PROCMGR_AID_PRIORITY. */
export const DEFAULT_PRIVILEGED_CEILING = 63;

export type SchedulingPolicy = 'fifo' | 'rr' | 'sporadic';
export type MutexProtocol = 'none' | 'inherit' | 'protect';

export interface ClockModel {
  /** Tick period of the system clock (`ClockPeriod()`). Default 1 ms. */
  readonly periodUs: Micros;
  /** Round-robin timeslice in clock ticks. QNX uses 4 ticks. */
  readonly roundRobinTimesliceTicks: number;
}

export interface CpuModel {
  /** Single-core analysis in v1; SMP changes the whole blocking model. */
  readonly cores: 1;
  /** Measured kernel cost of a context switch, charged as kernel time. */
  readonly contextSwitchUs: Micros;
  /** Upper bound of unprivileged priorities (procnto -P). */
  readonly privilegedPriorityCeiling: number;
}

export interface InterruptModel {
  /** Clock interrupt service thread priority. */
  readonly clockIstPriority: number;
  /** Inter-processor interrupt IST priority. */
  readonly ipiIstPriority: number;
  /** Cost of entry/exit for one interrupt (charged per occurrence). */
  readonly entryOverheadUs: Micros;
  /** Optional device interrupt sources that preempt the scheduler. */
  readonly sources: readonly InterruptSource[];
}

export interface InterruptSource {
  readonly name: string;
  readonly periodUs: Micros;
  /** Time spent in the IST per activation, including entry overhead. */
  readonly serviceUs: Micros;
}

export interface ResourceModel {
  readonly name: string;
  readonly protocol: MutexProtocol;
  /** Priority ceiling, required for `protect`. */
  readonly ceiling?: number;
}

export interface ChannelModel {
  readonly name: string;
  /** Number of threads blocked in `MsgReceive()` on this channel. */
  readonly serverThreads: number;
  /** Base priority those server threads are created with. */
  readonly basePriority: number;
  /**
   * `_NTO_CHF_FIXED_PRIORITY`: the server does not inherit client
   * priorities. Useful for isolation, dangerous for latency.
   */
  readonly fixedPriority: boolean;
  /** Work the server performs per request. */
  readonly handler: readonly Segment[];
}

/** A task's activation pattern. */
export type Activation =
  | { readonly type: 'periodic'; readonly periodUs: Micros; readonly offsetUs: Micros }
  | { readonly type: 'sporadic'; readonly minInterarrivalUs: Micros; readonly offsetUs: Micros }
  | { readonly type: 'aperiodic'; readonly meanInterarrivalUs: Micros; readonly offsetUs: Micros };

/** One step of a task's per-job program. */
export type Segment =
  | { readonly kind: 'cpu'; readonly us: Micros }
  | { readonly kind: 'cs'; readonly resource: string; readonly workUs: Micros }
  | { readonly kind: 'rpc'; readonly channel: string; readonly timeoutUs?: Micros }
  | { readonly kind: 'sleep'; readonly us: Micros }
  | { readonly kind: 'yield' }
  | { readonly kind: 'setPriority'; readonly priority: number };

export interface SporadicModel {
  readonly lowPriority: number;
  readonly initBudgetUs: Micros;
  readonly replenishPeriodUs: Micros;
  readonly maxReplenishments: number;
}

export interface TaskModel {
  readonly name: string;
  readonly priority: number;
  readonly policy: SchedulingPolicy;
  readonly sporadic?: SporadicModel;
  readonly activation: Activation;
  /** Relative deadline. Defaults to the period (or min interarrival). */
  readonly deadlineUs: Micros;
  readonly segments: readonly Segment[];
  /** Free-form note shown in reports. */
  readonly notes?: string;
}

export interface SimulationModel {
  /** Wall-clock span to simulate; defaults to one hyperperiod, capped. */
  readonly durationUs?: Micros;
  /** Deterministic seed for jitter/aperiodic arrivals. */
  readonly seed: number;
  /** Maximum number of jobs simulated per task. */
  readonly maxJobsPerTask: number;
}

export interface SystemModel {
  readonly schema: typeof SCHEMA_ID;
  readonly name: string;
  readonly description?: string;
  readonly clock: ClockModel;
  readonly cpu: CpuModel;
  readonly interrupts: InterruptModel;
  readonly resources: readonly ResourceModel[];
  readonly channels: readonly ChannelModel[];
  readonly tasks: readonly TaskModel[];
  readonly simulation: SimulationModel;
}

/** Derived per-job costs used by both analysis and simulation. */
export interface TaskCosts {
  /** Pure CPU work performed by the task itself. */
  readonly ownCpuUs: Micros;
  /** CPU work performed on the task's behalf by servers, at its priority. */
  readonly delegatedCpuUs: Micros;
  /** Total execution demand charged to the task. */
  readonly executionUs: Micros;
  /** Critical sections the task executes, in program order. */
  readonly criticalSections: readonly { resource: string; workUs: Micros }[];
  /** Channels the task sends to. */
  readonly channels: readonly string[];
  /** True when the job suspends itself (sleep/RPC), invalidating classic RTA. */
  readonly selfSuspends: boolean;
  /** Number of context switches charged to the job (approximate). */
  readonly activations: number;
  /**
   * True when the job can block behind a channel whose server never inherits
   * priority (_NTO_CHF_FIXED_PRIORITY), so the wait is not bounded by PIP.
   */
  readonly fixedPriorityBlocking: boolean;
}

export function defaultModel(name: string): SystemModel {
  return {
    schema: SCHEMA_ID,
    name,
    clock: { periodUs: 1000, roundRobinTimesliceTicks: 4 },
    cpu: { cores: 1, contextSwitchUs: 2, privilegedPriorityCeiling: DEFAULT_PRIVILEGED_CEILING },
    interrupts: { clockIstPriority: IST_CLOCK_PRIORITY, ipiIstPriority: IST_IPI_PRIORITY, entryOverheadUs: 0, sources: [] },
    resources: [],
    channels: [],
    tasks: [],
    simulation: { seed: 1, maxJobsPerTask: 64 },
  };
}

/** Nominal period of a task, or the mean interarrival for aperiodic tasks. */
export function nominalPeriod(task: TaskModel): Micros {
  switch (task.activation.type) {
    case 'periodic':
      return task.activation.periodUs;
    case 'sporadic':
      return task.activation.minInterarrivalUs;
    case 'aperiodic':
      return task.activation.meanInterarrivalUs;
  }
}
