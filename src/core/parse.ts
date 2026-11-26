/**
 * YAML model parser.
 *
 * Parsing never throws on user input: every problem becomes a diagnostic with a
 * path and, where possible, a hint. That lets `scheduloscope validate` report
 * all mistakes in one pass instead of one per run.
 */

import { parse as parseYaml, YAMLParseError } from 'yaml';
import { DiagnosticBag, type Diagnostic } from './diagnostics.js';
import {
  SCHEMA_ID,
  type Activation,
  type ChannelModel,
  type ClockModel,
  type CpuModel,
  type InterruptModel,
  type InterruptSource,
  type ResourceModel,
  type SchedulingPolicy,
  type Segment,
  type SimulationModel,
  type SporadicModel,
  type SystemModel,
  type TaskModel,
  type MutexProtocol,
} from './model.js';
import { checkKeys, describe, isMapping } from './text.js';
import { parseDuration } from './units.js';

export interface ParseResult {
  readonly model?: SystemModel;
  readonly diagnostics: readonly Diagnostic[];
}

interface ParseOptions {
  /** File name used in error messages. */
  readonly source?: string;
}

export function parseModel(source: string, options: ParseOptions = {}): ParseResult {
  const bag = new DiagnosticBag();
  let raw: unknown;
  try {
    raw = parseYaml(source, { prettyErrors: true });
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const pos = error.linePos?.[0];
      bag.error(
        'E_YAML',
        pos ? `YAML syntax error at line ${pos.line}, column ${pos.col}: ${error.message.split('\n')[0]}` : `YAML syntax error: ${error.message}`,
        undefined,
        'Scheduloscope models are plain YAML mappings; check indentation and quoting.',
      );
    } else {
      bag.error('E_YAML', `Could not read ${options.source ?? 'model'}: ${(error as Error).message}`);
    }
    return { diagnostics: bag.all };
  }

  if (!isMapping(raw)) {
    bag.error('E_TOP_LEVEL', `The model must be a YAML mapping, got ${describe(raw)}.`);
    return { diagnostics: bag.all };
  }

  checkKeys(raw, ['schema', 'name', 'description', 'clock', 'cpu', 'interrupts', 'resources', 'channels', 'tasks', 'simulation'], '(root)', bag);

  const schema = raw['schema'];
  if (schema !== undefined && schema !== SCHEMA_ID) {
    bag.error('E_SCHEMA', `Unsupported schema "${String(schema)}"; expected "${SCHEMA_ID}".`, 'schema');
  }

  const name = str(raw['name'], 'name', bag, { required: true });
  const description = str(raw['description'], 'description', bag);

  const clock = parseClock(raw['clock'], bag);
  const cpu = parseCpu(raw['cpu'], bag);
  const interrupts = parseInterrupts(raw['interrupts'], bag);
  const resources = parseResources(raw['resources'], bag);
  const channels = parseChannels(raw['channels'], bag);
  const tasks = parseTasks(raw['tasks'], bag);
  const simulation = parseSimulation(raw['simulation'], bag);

  if (bag.errorCount > 0) {
    return { diagnostics: bag.all };
  }

  const model: SystemModel = {
    schema: SCHEMA_ID,
    name: name ?? 'unnamed system',
    ...(description ? { description } : {}),
    clock: clock!,
    cpu: cpu!,
    interrupts: interrupts!,
    resources: resources!,
    channels: channels!,
    tasks: tasks!,
    simulation: simulation!,
  };
  return { model, diagnostics: bag.all };
}

/* -------------------------------------------------------------------------- */
/* Value readers                                                              */
/* -------------------------------------------------------------------------- */

interface StrOptions {
  readonly required?: boolean;
}

function str(value: unknown, path: string, bag: DiagnosticBag, options: StrOptions = {}): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) bag.error('E_REQUIRED', 'This field is required.', path);
    return undefined;
  }
  if (typeof value !== 'string') {
    bag.error('E_TYPE', `Expected a string, got ${describe(value)}.`, path);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (options.required) bag.error('E_REQUIRED', 'This field must not be empty.', path);
    return undefined;
  }
  return trimmed;
}

interface NumOptions {
  readonly integer?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly fallback?: number;
  readonly required?: boolean;
}

function num(value: unknown, path: string, bag: DiagnosticBag, options: NumOptions = {}): number | undefined {
  if (value === undefined || value === null) {
    if (options.required && options.fallback === undefined) bag.error('E_REQUIRED', 'This field is required.', path);
    return options.fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    bag.error('E_TYPE', `Expected a number, got ${describe(value)}.`, path);
    return options.fallback;
  }
  if (options.integer && !Number.isInteger(value)) {
    bag.error('E_TYPE', `Expected an integer, got ${value}.`, path);
    return options.fallback;
  }
  if (options.min !== undefined && value < options.min) {
    bag.error('E_RANGE', `Value ${value} is below the minimum ${options.min}.`, path);
    return options.fallback;
  }
  if (options.max !== undefined && value > options.max) {
    bag.error('E_RANGE', `Value ${value} is above the maximum ${options.max}.`, path);
    return options.fallback;
  }
  return value;
}

interface DurationOptions {
  readonly fallback?: number;
  readonly required?: boolean;
  readonly min?: number;
}

/** Accepts "250us", "1ms", "0.5s" or a bare microsecond number. */
function duration(value: unknown, path: string, bag: DiagnosticBag, options: DurationOptions = {}): number | undefined {
  if (value === undefined || value === null) {
    if (options.required && options.fallback === undefined) bag.error('E_REQUIRED', 'This duration is required.', path);
    return options.fallback;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    bag.error('E_TYPE', `Expected a duration such as "250us" or "1ms", got ${describe(value)}.`, path);
    return options.fallback;
  }
  const micros = parseDuration(value as string | number);
  if (micros === undefined) {
    bag.error('E_DURATION', `"${String(value)}" is not a duration. Use ns, us, ms or s, for example "250us".`, path);
    return options.fallback;
  }
  if (options.min !== undefined && micros < options.min) {
    bag.error('E_RANGE', `Duration must be at least ${options.min}us.`, path);
    return options.fallback;
  }
  return micros;
}

function bool(value: unknown, path: string, bag: DiagnosticBag, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    bag.error('E_TYPE', `Expected true or false, got ${describe(value)}.`, path);
    return fallback;
  }
  return value;
}

function list(value: unknown, path: string, bag: DiagnosticBag, fallback: unknown[] = []): unknown[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) {
    bag.error('E_TYPE', `Expected a list, got ${describe(value)}.`, path);
    return fallback;
  }
  return value;
}

function mapping(value: unknown, path: string, bag: DiagnosticBag): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isMapping(value)) {
    bag.error('E_TYPE', `Expected a mapping, got ${describe(value)}.`, path);
    return undefined;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

function parseClock(value: unknown, bag: DiagnosticBag): ClockModel | undefined {
  const map = mapping(value, 'clock', bag) ?? {};
  checkKeys(map, ['period', 'periodUs', 'roundRobinTimesliceTicks', 'ticks'], 'clock', bag);
  const periodUs = duration(map['period'] ?? map['periodUs'], 'clock.period', bag, { fallback: 1000, min: 1 });
  const ticks = num(map['roundRobinTimesliceTicks'] ?? map['ticks'], 'clock.roundRobinTimesliceTicks', bag, {
    integer: true,
    min: 1,
    max: 1000,
    fallback: 4,
  });
  if (periodUs === undefined || ticks === undefined) return undefined;
  return { periodUs, roundRobinTimesliceTicks: ticks };
}

function parseCpu(value: unknown, bag: DiagnosticBag): CpuModel | undefined {
  const map = mapping(value, 'cpu', bag) ?? {};
  checkKeys(map, ['cores', 'contextSwitch', 'contextSwitchUs', 'privilegedPriorityCeiling'], 'cpu', bag);
  const cores = num(map['cores'], 'cpu.cores', bag, { integer: true, min: 1, max: 1, fallback: 1 });
  const contextSwitchUs = duration(map['contextSwitch'] ?? map['contextSwitchUs'], 'cpu.contextSwitch', bag, {
    fallback: 2,
    min: 0,
  });
  const ceiling = num(map['privilegedPriorityCeiling'], 'cpu.privilegedPriorityCeiling', bag, {
    integer: true,
    min: 1,
    max: 253,
    fallback: 63,
  });
  if (cores === undefined || contextSwitchUs === undefined || ceiling === undefined) return undefined;
  if (map['cores'] !== undefined && cores === 1 && map['cores'] !== 1) {
    bag.error('E_SMP', 'Only single-core (cores: 1) models are supported in this version.', 'cpu.cores');
    return undefined;
  }
  return { cores: 1, contextSwitchUs, privilegedPriorityCeiling: ceiling };
}

function parseInterrupts(value: unknown, bag: DiagnosticBag): InterruptModel | undefined {
  const map = mapping(value, 'interrupts', bag) ?? {};
  checkKeys(map, ['clockIstPriority', 'ipiIstPriority', 'entryOverhead', 'entryOverheadUs', 'sources'], 'interrupts', bag);
  const clockIstPriority = num(map['clockIstPriority'], 'interrupts.clockIstPriority', bag, {
    integer: true,
    min: 1,
    max: 255,
    fallback: 254,
  });
  const ipiIstPriority = num(map['ipiIstPriority'], 'interrupts.ipiIstPriority', bag, {
    integer: true,
    min: 1,
    max: 255,
    fallback: 255,
  });
  const entryOverheadUs = duration(map['entryOverhead'] ?? map['entryOverheadUs'], 'interrupts.entryOverhead', bag, {
    fallback: 0,
    min: 0,
  });
  const sources: InterruptSource[] = [];
  list(map['sources'], 'interrupts.sources', bag).forEach((entry, index) => {
    const path = `interrupts.sources[${index}]`;
    const item = mapping(entry, path, bag);
    if (!item) return;
    checkKeys(item, ['name', 'period', 'periodUs', 'service', 'serviceUs'], path, bag);
    const name = str(item['name'], `${path}.name`, bag, { required: true });
    const periodUs = duration(item['period'] ?? item['periodUs'], `${path}.period`, bag, { required: true, min: 1 });
    const serviceUs = duration(item['service'] ?? item['serviceUs'], `${path}.service`, bag, { required: true, min: 1 });
    if (name && periodUs !== undefined && serviceUs !== undefined) sources.push({ name, periodUs, serviceUs });
  });
  if (clockIstPriority === undefined || ipiIstPriority === undefined || entryOverheadUs === undefined) return undefined;
  return { clockIstPriority, ipiIstPriority, entryOverheadUs, sources };
}

function parseResources(value: unknown, bag: DiagnosticBag): ResourceModel[] | undefined {
  const resources: ResourceModel[] = [];
  let ok = true;
  list(value, 'resources', bag).forEach((entry, index) => {
    const path = `resources[${index}]`;
    const item = mapping(entry, path, bag);
    if (!item) {
      ok = false;
      return;
    }
    checkKeys(item, ['name', 'protocol', 'ceiling'], path, bag);
    const name = str(item['name'], `${path}.name`, bag, { required: true });
    const protocolText = item['protocol'] === undefined ? 'inherit' : str(item['protocol'], `${path}.protocol`, bag);
    const protocols: readonly MutexProtocol[] = ['none', 'inherit', 'protect'];
    let protocol: MutexProtocol = 'inherit';
    if (protocolText !== undefined) {
      if (!(protocols as readonly string[]).includes(protocolText)) {
        bag.error('E_PROTOCOL', `Unknown mutex protocol "${protocolText}".`, `${path}.protocol`, 'Use one of: none, inherit, protect.');
        ok = false;
      } else {
        protocol = protocolText as MutexProtocol;
      }
    }
    const ceiling = num(item['ceiling'], `${path}.ceiling`, bag, { integer: true, min: 1, max: 255 });
    if (protocol === 'protect' && ceiling === undefined) {
      bag.error('E_CEILING', 'A protect mutex needs a priority ceiling.', `${path}.ceiling`);
      ok = false;
    }
    if (protocol !== 'protect' && ceiling !== undefined) {
      bag.warn('W_CEILING_IGNORED', 'The ceiling is ignored unless the protocol is "protect".', `${path}.ceiling`);
    }
    if (name) resources.push({ name, protocol, ...(ceiling !== undefined ? { ceiling } : {}) });
  });
  return ok ? resources : undefined;
}

function parseChannels(value: unknown, bag: DiagnosticBag): ChannelModel[] | undefined {
  const channels: ChannelModel[] = [];
  let ok = true;
  list(value, 'channels', bag).forEach((entry, index) => {
    const path = `channels[${index}]`;
    const item = mapping(entry, path, bag);
    if (!item) {
      ok = false;
      return;
    }
    checkKeys(item, ['name', 'serverThreads', 'basePriority', 'fixedPriority', 'handler'], path, bag);
    const name = str(item['name'], `${path}.name`, bag, { required: true });
    const serverThreads = num(item['serverThreads'], `${path}.serverThreads`, bag, {
      integer: true,
      min: 1,
      max: 64,
      fallback: 1,
    });
    const basePriority = num(item['basePriority'], `${path}.basePriority`, bag, {
      integer: true,
      min: 1,
      max: 255,
      fallback: 10,
    });
    const fixedPriority = bool(item['fixedPriority'], `${path}.fixedPriority`, bag, false);
    const handler = parseSegments(item['handler'], `${path}.handler`, bag);
    if (handler !== undefined && handler.length === 0) {
      bag.error('E_HANDLER', 'A channel handler must contain at least one segment.', `${path}.handler`);
      ok = false;
    }
    if (name && serverThreads !== undefined && basePriority !== undefined && handler) {
      channels.push({ name, serverThreads, basePriority, fixedPriority, handler });
    } else {
      ok = false;
    }
  });
  return ok ? channels : undefined;
}

const SEGMENT_KEYS = ['cpu', 'cs', 'rpc', 'sleep', 'yield', 'setPriority'] as const;

function parseSegments(value: unknown, path: string, bag: DiagnosticBag): Segment[] | undefined {
  if (value === undefined || value === null) {
    bag.error('E_REQUIRED', 'At least one segment is required.', path);
    return undefined;
  }
  if (!Array.isArray(value)) {
    bag.error('E_TYPE', `Expected a list of segments, got ${describe(value)}.`, path);
    return undefined;
  }
  const segments: Segment[] = [];
  let ok = true;
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isMapping(entry)) {
      bag.error('E_TYPE', `Expected a segment mapping, got ${describe(entry)}.`, itemPath);
      ok = false;
      return;
    }
    const keys = Object.keys(entry);
    const kinds = keys.filter((k) => (SEGMENT_KEYS as readonly string[]).includes(k));
    if (kinds.length === 0) {
      bag.error('E_SEGMENT', `Unknown segment; expected one of ${SEGMENT_KEYS.join(', ')}.`, itemPath, 'For example: { cpu: 120us }');
      ok = false;
      return;
    }
    if (kinds.length > 1) {
      bag.error('E_SEGMENT', `A segment must have exactly one kind, found ${kinds.join(', ')}.`, itemPath);
      ok = false;
      return;
    }
    const kind = kinds[0]!;
    const body = entry[kind];
    switch (kind) {
      case 'cpu': {
        const us = duration(body, `${itemPath}.cpu`, bag, { required: true, min: 0 });
        if (us !== undefined) segments.push({ kind: 'cpu', us });
        break;
      }
      case 'sleep': {
        const us = duration(body, `${itemPath}.sleep`, bag, { required: true, min: 1 });
        if (us !== undefined) segments.push({ kind: 'sleep', us });
        break;
      }
      case 'yield': {
        if (body !== true) {
          bag.error('E_SEGMENT', 'Use "{ yield: true }".', `${itemPath}.yield`);
          ok = false;
        } else {
          segments.push({ kind: 'yield' });
        }
        break;
      }
      case 'setPriority': {
        const priority = num(body, `${itemPath}.setPriority`, bag, { integer: true, min: 1, max: 255 });
        if (priority !== undefined) segments.push({ kind: 'setPriority', priority });
        break;
      }
      case 'cs': {
        const cs = mapping(body, `${itemPath}.cs`, bag);
        if (!cs) {
          ok = false;
          break;
        }
        checkKeys(cs, ['resource', 'work', 'workUs'], `${itemPath}.cs`, bag);
        const resource = str(cs['resource'], `${itemPath}.cs.resource`, bag, { required: true });
        const workUs = duration(cs['work'] ?? cs['workUs'], `${itemPath}.cs.work`, bag, { required: true, min: 0 });
        if (resource && workUs !== undefined) segments.push({ kind: 'cs', resource, workUs });
        break;
      }
      case 'rpc': {
        const rpc = mapping(body, `${itemPath}.rpc`, bag);
        if (!rpc) {
          ok = false;
          break;
        }
        checkKeys(rpc, ['channel', 'timeout', 'timeoutUs'], `${itemPath}.rpc`, bag);
        const channel = str(rpc['channel'], `${itemPath}.rpc.channel`, bag, { required: true });
        const timeoutUs = duration(rpc['timeout'] ?? rpc['timeoutUs'], `${itemPath}.rpc.timeout`, bag, { min: 1 });
        if (channel) segments.push({ kind: 'rpc', channel, ...(timeoutUs !== undefined ? { timeoutUs } : {}) });
        break;
      }
      default:
        break;
    }
  });
  return ok ? segments : undefined;
}

const POLICIES: readonly SchedulingPolicy[] = ['fifo', 'rr', 'sporadic'];

function parseTasks(value: unknown, bag: DiagnosticBag): TaskModel[] | undefined {
  const tasks: TaskModel[] = [];
  let ok = true;
  const entries = list(value, 'tasks', bag);
  if (entries.length === 0) {
    bag.error('E_NO_TASKS', 'A model needs at least one task.', 'tasks');
    return undefined;
  }
  entries.forEach((entry, index) => {
    const path = `tasks[${index}]`;
    const item = mapping(entry, path, bag);
    if (!item) {
      ok = false;
      return;
    }
    checkKeys(
      item,
      ['name', 'priority', 'policy', 'sporadic', 'period', 'periodUs', 'minInterarrival', 'minInterarrivalUs', 'meanInterarrival', 'meanInterarrivalUs', 'offset', 'offsetUs', 'deadline', 'deadlineUs', 'segments', 'notes'],
      path,
      bag,
    );
    const name = str(item['name'], `${path}.name`, bag, { required: true });
    const priority = num(item['priority'], `${path}.priority`, bag, { integer: true, min: 1, max: 255, required: true });
    const policyText = item['policy'] === undefined ? 'fifo' : str(item['policy'], `${path}.policy`, bag);
    let policy: SchedulingPolicy = 'fifo';
    if (policyText !== undefined) {
      if (!(POLICIES as readonly string[]).includes(policyText)) {
        bag.error('E_POLICY', `Unknown scheduling policy "${policyText}".`, `${path}.policy`, 'Use one of: fifo, rr, sporadic.');
        ok = false;
      } else {
        policy = policyText as SchedulingPolicy;
      }
    }

    const offsetUs = duration(item['offset'] ?? item['offsetUs'], `${path}.offset`, bag, { fallback: 0, min: 0 });
    const periodic = item['period'] ?? item['periodUs'];
    const sporadicArrival = item['minInterarrival'] ?? item['minInterarrivalUs'];
    const aperiodicArrival = item['meanInterarrival'] ?? item['meanInterarrivalUs'];

    let activation: Activation | undefined;
    const declaredArrivals = [periodic, sporadicArrival, aperiodicArrival].filter((v) => v !== undefined).length;
    if (declaredArrivals === 0) {
      bag.error('E_REQUIRED', 'A task needs an activation: period, minInterarrival, or meanInterarrival.', path);
      ok = false;
    } else if (declaredArrivals > 1) {
      bag.error('E_ACTIVATION', 'Declare exactly one activation kind.', path);
      ok = false;
    } else if (periodic !== undefined) {
      const periodUs = duration(periodic, `${path}.period`, bag, { required: true, min: 1 });
      if (periodUs !== undefined && offsetUs !== undefined) activation = { type: 'periodic', periodUs, offsetUs };
    } else if (sporadicArrival !== undefined) {
      const minInterarrivalUs = duration(sporadicArrival, `${path}.minInterarrival`, bag, { required: true, min: 1 });
      if (minInterarrivalUs !== undefined && offsetUs !== undefined) activation = { type: 'sporadic', minInterarrivalUs, offsetUs };
    } else if (aperiodicArrival !== undefined) {
      const meanInterarrivalUs = duration(aperiodicArrival, `${path}.meanInterarrival`, bag, { required: true, min: 1 });
      if (meanInterarrivalUs !== undefined && offsetUs !== undefined) activation = { type: 'aperiodic', meanInterarrivalUs, offsetUs };
    }

    const nominal = activation
      ? activation.type === 'periodic'
        ? activation.periodUs
        : activation.type === 'sporadic'
          ? activation.minInterarrivalUs
          : activation.meanInterarrivalUs
      : undefined;
    const deadlineUs = duration(item['deadline'] ?? item['deadlineUs'], `${path}.deadline`, bag, {
      fallback: nominal,
      min: 1,
    });

    let sporadic: SporadicModel | undefined;
    if (policy === 'sporadic') {
      const map = mapping(item['sporadic'], `${path}.sporadic`, bag);
      if (!map) {
        bag.error('E_REQUIRED', 'Sporadic scheduling requires a sporadic block.', `${path}.sporadic`, 'See docs/model-reference.md for the parameters.');
        ok = false;
      } else {
        checkKeys(map, ['lowPriority', 'budget', 'budgetUs', 'initBudgetUs', 'replenishPeriod', 'replenishPeriodUs', 'maxReplenishments'], `${path}.sporadic`, bag);
        // QNX SDP 8.x: sporadic low priority 1..252, because the normal priority must be 2..253.
        const lowPriority = num(map['lowPriority'], `${path}.sporadic.lowPriority`, bag, { integer: true, min: 1, max: 252, required: true });
        const initBudgetUs = duration(map['budget'] ?? map['budgetUs'] ?? map['initBudgetUs'], `${path}.sporadic.budget`, bag, { required: true, min: 1 });
        const replenishPeriodUs = duration(map['replenishPeriod'] ?? map['replenishPeriodUs'], `${path}.sporadic.replenishPeriod`, bag, { required: true, min: 1 });
        // SS_REPL_MAX is 65535 in QNX; the older 32 limit is not an OS constraint.
        const maxReplenishments = num(map['maxReplenishments'], `${path}.sporadic.maxReplenishments`, bag, { integer: true, min: 1, max: 65535, fallback: 3 });
        if (lowPriority !== undefined && initBudgetUs !== undefined && replenishPeriodUs !== undefined && maxReplenishments !== undefined) {
          sporadic = { lowPriority, initBudgetUs, replenishPeriodUs, maxReplenishments };
        }
      }
    } else if (item['sporadic'] !== undefined) {
      bag.warn('W_SPORADIC_UNUSED', 'A sporadic block only applies when policy is "sporadic".', `${path}.sporadic`);
    }

    const segments = parseSegments(item['segments'], `${path}.segments`, bag);
    const notes = str(item['notes'], `${path}.notes`, bag);

    if (name && priority !== undefined && activation && deadlineUs !== undefined && segments && (policy !== 'sporadic' || sporadic)) {
      tasks.push({
        name,
        priority,
        policy,
        ...(sporadic ? { sporadic } : {}),
        activation,
        deadlineUs,
        segments,
        ...(notes ? { notes } : {}),
      });
    } else {
      ok = false;
    }
  });
  return ok ? tasks : undefined;
}

function parseSimulation(value: unknown, bag: DiagnosticBag): SimulationModel | undefined {
  const map = mapping(value, 'simulation', bag) ?? {};
  checkKeys(map, ['duration', 'durationUs', 'seed', 'maxJobsPerTask'], 'simulation', bag);
  const durationUs = duration(map['duration'] ?? map['durationUs'], 'simulation.duration', bag, { min: 1 });
  const seed = num(map['seed'], 'simulation.seed', bag, { integer: true, fallback: 1 });
  const maxJobsPerTask = num(map['maxJobsPerTask'], 'simulation.maxJobsPerTask', bag, {
    integer: true,
    min: 1,
    max: 100_000,
    fallback: 64,
  });
  if (seed === undefined || maxJobsPerTask === undefined) return undefined;
  return { ...(durationUs !== undefined ? { durationUs } : {}), seed, maxJobsPerTask };
}
