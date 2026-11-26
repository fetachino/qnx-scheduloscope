/**
 * Public surface of Scheduloscope.
 *
 * The CLI is the primary interface, but every step is a pure function over the
 * model, so the same pipeline can be embedded in a build script or a test:
 *
 *   const { model } = parseModel(readFileSync('system.yaml', 'utf8'));
 *   if (!model) throw new Error('invalid model');
 *   const derived = derive(model);
 *   const rta = analyzeResponseTimes(model, derived);
 *   const sim = simulate(model);
 *   const bundle = { model, derived, rta, sim, generatedAt: new Date().toISOString() };
 *   writeFileSync('system.html', renderHtml(bundle));
 */

export { TOOL_VERSION } from './version.js';
export {
  SCHEMA_ID,
  IST_CLOCK_PRIORITY,
  IST_IPI_PRIORITY,
  PRIORITY_MAX,
  PRIORITY_MIN,
  defaultModel,
  nominalPeriod,
} from './core/model.js';
export type {
  Activation,
  ChannelModel,
  ClockModel,
  CpuModel,
  InterruptModel,
  InterruptSource,
  MutexProtocol,
  ResourceModel,
  SchedulingPolicy,
  Segment,
  SimulationModel,
  SporadicModel,
  SystemModel,
  TaskCosts,
  TaskModel,
} from './core/model.js';
export { formatDuration, parseDuration } from './core/units.js';
export type { Micros } from './core/units.js';
export { parseModel } from './core/parse.js';
export type { ParseResult } from './core/parse.js';
export { validateModel } from './core/validate.js';
export { derive, taskPeriodUs } from './core/derive.js';
export type { DerivedModel } from './core/derive.js';
export { analyzeResponseTimes } from './analysis/rta.js';
export type { RtaReport, TaskRta, Verdict } from './analysis/rta.js';
export { simulate } from './sim/engine.js';
export type { SimResult, SimulateOptions, TraceSlice, Inversion, DeadlineMiss } from './sim/engine.js';
export { renderHtml, renderMarkdown, summarize } from './report/report.js';
export type { ReportBundle, ReportSummary } from './report/report.js';
export { renderGantt } from './report/svg.js';
export { generateQnxHarness } from './codegen/qnx.js';
export type { GeneratedFile, GeneratedHarness } from './codegen/qnx.js';
