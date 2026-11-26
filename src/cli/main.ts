#!/usr/bin/env node
/**
 * Scheduloscope command line.
 *
 * Six verbs over one model file: check it, analyze it, simulate it, turn it
 * into a report, turn it into a QNX harness, or start a new one. Every verb
 * prints something a human can act on and exits non-zero when the design is
 * wrong, so the same command works in a terminal and in CI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeResponseTimes } from '../analysis/rta.js';
import { generateQnxHarness } from '../codegen/qnx.js';
import { derive } from '../core/derive.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { parseModel } from '../core/parse.js';
import { formatDuration, parseDuration } from '../core/units.js';
import { validateModel } from '../core/validate.js';
import { allDiagnostics, percent, renderHtml, renderMarkdown, summarize, type ReportBundle } from '../report/report.js';
import { simulate } from '../sim/engine.js';
import { TOOL_VERSION } from '../version.js';

const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

function paint(code: number, text: string): string {
  return useColor ? ESC + '[' + String(code) + 'm' + text + ESC + '[0m' : text;
}

const dim = (text: string) => paint(90, text);
const bold = (text: string) => paint(1, text);
const red = (text: string) => paint(31, text);
const green = (text: string) => paint(32, text);
const yellow = (text: string) => paint(33, text);
const cyan = (text: string) => paint(36, text);

const HELP = readFileSync(new URL('./templates/help.txt', import.meta.url), 'utf8').replace('{{VERSION}}', TOOL_VERSION);

class UsageError extends Error {}

/** The file was found and read, but its contents are not a valid model. */
class ModelError extends Error {}

interface LoadedModel {
  readonly path: string;
  readonly bundle: ReportBundle;
}

async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        html: { type: 'string' },
        md: { type: 'string' },
        duration: { type: 'string', short: 'd' },
        seed: { type: 'string', short: 's' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        force: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    process.stderr.write(red('error') + ' ' + (error as Error).message + '\n');
    return 2;
  }

  const values = parsed.values;
  const positionals = parsed.positionals;
  if (values.help === true) {
    process.stdout.write(HELP);
    return 0;
  }

  const known = new Set(['check', 'analyze', 'simulate', 'report', 'gen', 'init', 'version', 'help']);
  let command = positionals[0] ?? 'analyze';
  let file: string | undefined = positionals[1];
  if (!known.has(command)) {
    file = positionals[0];
    command = 'analyze';
  }
  if (command === 'version' || command === 'help') {
    process.stdout.write(command === 'version' ? TOOL_VERSION + '\n' : HELP);
    return 0;
  }

  try {
    if (command === 'init') return initCommand(file, values.out, values.force === true);
    if (!file) throw new UsageError('no model file given (try --help)');
    const loaded = loadModel(file);
    switch (command) {
      case 'check':
        return commandCheck(loaded, values.json === true);
      case 'analyze':
        return commandAnalyze(loaded, values.json === true, values.quiet === true);
      case 'simulate':
        return commandSimulate(loaded, values);
      case 'report':
        return commandReport(loaded, values);
      case 'gen':
        return commandGenerate(loaded, values);
      default:
        throw new UsageError('unknown command ' + command);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(red('error') + ' ' + error.message + '\n');
      return 2;
    }
    process.stderr.write(red('error') + ' ' + (error as Error).message + '\n');
    return 1;
  }
}
/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

function loadModel(file: string): LoadedModel {
  const path = resolve(file);
  if (!existsSync(path)) throw new UsageError('cannot find ' + file);
  const source = readFileSync(path, 'utf8');
  const parsedModel = parseModel(source, { source: file });
  const diagnostics: Diagnostic[] = [...parsedModel.diagnostics];
  const model = parsedModel.model;
  if (!model) {
    for (const diagnostic of diagnostics) printDiagnostic(diagnostic);
    throw new ModelError('the model could not be parsed, so nothing was analyzed');
  }
  diagnostics.push(...validateModel(model));
  const derived = derive(model);
  const rta = analyzeResponseTimes(model, derived);
  const bundle: ReportBundle = {
    model,
    derived,
    rta,
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  return { path, bundle };
}

function printDiagnostic(diagnostic: Diagnostic): void {
  const label =
    diagnostic.severity === 'error' ? red('error  ') : diagnostic.severity === 'warning' ? yellow('warning') : cyan('note   ');
  const where = diagnostic.path ? dim(' (' + diagnostic.path + ')') : '';
  process.stderr.write(label + ' ' + diagnostic.code + ' ' + diagnostic.message + where + '\n');
  if (diagnostic.hint) process.stderr.write('        ' + dim(diagnostic.hint) + '\n');
}

function printDiagnostics(bundle: ReportBundle): void {
  for (const diagnostic of allDiagnostics(bundle)) printDiagnostic(diagnostic);
}

function errorCount(bundle: ReportBundle): number {
  return allDiagnostics(bundle).filter((diagnostic) => diagnostic.severity === 'error').length;
}

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

function columns(headers: readonly string[], rows: readonly (readonly string[])[], right: readonly boolean[]): string[] {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)));
  const render = (cells: readonly string[]) =>
    cells.map((cell, index) => (right[index] ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!))).join('  ');
  return [dim(render(headers)), dim(widths.map((width) => '-'.repeat(width)).join('  ')), ...rows.map(render)];
}

function verdictLine(bundle: ReportBundle): string {
  const summary = summarize(bundle);
  const badge =
    bundle.rta.verdict === 'schedulable'
      ? green('schedulable')
      : bundle.rta.verdict === 'unschedulable'
        ? red('unschedulable')
        : yellow('inconclusive');
  return (
    bold(bundle.model.name) + '  ' + badge + dim('  ·  ') + String(summary.tasks) + ' tasks' + dim('  ·  ') +
    percent(summary.utilization) + ' utilization' + dim('  ·  ') + 'worst slack ' + formatDuration(summary.worstSlackUs) +
    dim('  ·  ') + 'hyperperiod ' + formatDuration(bundle.derived.hyperperiodUs)
  );
}

function rtaTable(bundle: ReportBundle): string[] {
  const rows = bundle.rta.tasks.map((task) => [
    task.name,
    task.policy,
    String(task.priority),
    formatDuration(task.executionUs),
    formatDuration(task.blockingUs),
    formatDuration(task.interferenceUs),
    formatDuration(task.interruptUs),
    formatDuration(task.responseUs),
    formatDuration(task.deadlineUs),
    formatDuration(task.slackUs),
    task.deadlineMet === null ? 'n/a' : task.deadlineMet ? green('met') : red('MISS'),
  ]);
  return columns(
    ['task', 'policy', 'pri', 'C', 'B', 'I', 'ISR', 'R', 'D', 'slack', 'result'],
    rows,
    [false, false, true, true, true, true, true, true, true, true, false],
  );
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

function commandCheck(loaded: LoadedModel, json: boolean): number {
  const diagnostics = allDiagnostics(loaded.bundle);
  if (json) {
    process.stdout.write(JSON.stringify({ model: loaded.path, diagnostics }, null, 2) + '\n');
  } else {
    process.stdout.write(verdictLine(loaded.bundle) + '\n');
    if (diagnostics.length === 0) process.stdout.write(dim('no diagnostics') + '\n');
  }
  printDiagnostics(loaded.bundle);
  return errorCount(loaded.bundle) > 0 ? 1 : 0;
}

function commandAnalyze(loaded: LoadedModel, json: boolean, quiet: boolean): number {
  const { bundle } = loaded;
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          model: bundle.model.name,
          verdict: bundle.rta.verdict,
          utilization: bundle.derived.totalUtilization,
          hyperperiodUs: bundle.derived.hyperperiodUs,
          tasks: bundle.rta.tasks,
          diagnostics: allDiagnostics(bundle),
        },
        null,
        2,
      ) + '\n',
    );
  } else if (!quiet) {
    process.stdout.write(verdictLine(bundle) + '\n\n');
    process.stdout.write(rtaTable(bundle).join('\n') + '\n');
    if (bundle.rta.caveats.length > 0) {
      process.stdout.write('\n' + dim('caveats') + '\n');
      for (const caveat of bundle.rta.caveats) process.stdout.write('  ' + dim('·') + ' ' + caveat + '\n');
    }
  }
  printDiagnostics(bundle);
  if (errorCount(bundle) > 0) return 1;
  return bundle.rta.verdict === 'unschedulable' ? 1 : 0;
}

function commandSimulate(loaded: LoadedModel, values: Record<string, unknown>): number {
  const { bundle } = loaded;
  const durationText = values['duration'];
  const durationUs = typeof durationText === 'string' ? parseDuration(durationText) : bundle.derived.hyperperiodUs;
  if (durationUs === undefined) throw new UsageError('cannot parse --duration ' + String(durationText));
  const seedText = values['seed'];
  const seed = typeof seedText === 'string' ? Number(seedText) : undefined;
  if (seed !== undefined && !Number.isFinite(seed)) throw new UsageError('--seed must be a number');

  const sim = simulate(bundle.model, { durationUs, ...(seed === undefined ? {} : { seed }) });
  const withSim: ReportBundle = { ...bundle, sim };

  if (values['json'] === true) {
    process.stdout.write(
      JSON.stringify(
        {
          model: bundle.model.name,
          horizonUs: sim.horizonUs,
          seed: sim.seed,
          verdict: bundle.rta.verdict,
          tasks: sim.tasks,
          deadlineMisses: sim.deadlineMisses,
          inversions: sim.inversions,
          contextSwitches: sim.contextSwitches,
          diagnostics: allDiagnostics(withSim),
        },
        null,
        2,
      ) + '\n',
    );
  } else if (values['quiet'] !== true) {
    process.stdout.write(verdictLine(bundle) + '\n\n');
    const rows = sim.tasks.map((task) => [
      task.name,
      String(task.activations),
      String(task.completed),
      String(task.unfinished),
      formatDuration(task.maxResponseUs),
      formatDuration(task.meanResponseUs),
      formatDuration(task.jitterUs),
      task.misses > 0 ? red(String(task.misses)) : '0',
    ]);
    process.stdout.write(
      columns(
        ['task', 'activations', 'completed', 'unfinished', 'max', 'mean', 'jitter', 'misses'],
        rows,
        [false, true, true, true, true, true, true, true],
      ).join('\n') + '\n',
    );
    process.stdout.write(
      '\n' +
        dim(
          'simulated ' + formatDuration(sim.horizonUs) + '  ·  seed ' + String(sim.seed) + '  ·  ' +
            String(sim.contextSwitches) + ' context switches  ·  ' + String(sim.inversions.length) +
            (sim.inversions.length === 1 ? ' inversion  ·  ' : ' inversions  ·  ') + String(sim.deadlineMisses.length) +
            (sim.deadlineMisses.length === 1 ? ' miss' : ' misses'),
        ) + '\n',
    );
    for (const inversion of sim.inversions.slice(0, 5)) {
      process.stdout.write(
        '  ' + (inversion.mitigated ? green('mitigated') : red('unbounded')) + ' ' + inversion.task + ' blocked by ' +
          inversion.blocker + ' on ' + inversion.resource + ' for ' + formatDuration(inversion.durationUs) + '\n',
      );
    }
  }
  printDiagnostics(withSim);
  return errorCount(withSim) > 0 || sim.deadlineMisses.length > 0 ? 1 : 0;
}
function commandReport(loaded: LoadedModel, values: Record<string, unknown>): number {
  const { bundle } = loaded;
  const outDir = typeof values['out'] === 'string' ? values['out'] : 'demo';
  const slug = slugify(bundle.model.name);
  const htmlPath = resolve(typeof values['html'] === 'string' ? values['html'] : join(outDir, slug + '.html'));
  const mdPath = resolve(typeof values['md'] === 'string' ? values['md'] : join(outDir, slug + '.md'));

  const durationText = values['duration'];
  const durationUs = typeof durationText === 'string' ? parseDuration(durationText) : bundle.derived.hyperperiodUs;
  if (durationUs === undefined) throw new UsageError('cannot parse --duration ' + String(durationText));
  const sim = simulate(bundle.model, { durationUs });
  const full: ReportBundle = { ...bundle, sim };

  mkdirSync(dirname(htmlPath), { recursive: true });
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(htmlPath, renderHtml(full));
  writeFileSync(mdPath, renderMarkdown(full));

  if (values['json'] === true) {
    process.stdout.write(JSON.stringify({ html: htmlPath, markdown: mdPath }) + '\n');
  } else {
    process.stdout.write(verdictLine(full) + '\n');
    process.stdout.write('  ' + green('wrote') + ' ' + relative(process.cwd(), htmlPath) + '\n');
    process.stdout.write('  ' + green('wrote') + ' ' + relative(process.cwd(), mdPath) + '\n');
  }
  printDiagnostics(full);
  return errorCount(full) > 0 ? 1 : 0;
}

function commandGenerate(loaded: LoadedModel, values: Record<string, unknown>): number {
  const { bundle } = loaded;
  const outDir = resolve(typeof values['out'] === 'string' ? values['out'] : 'qnx-harness');
  const durationText = values['duration'];
  const durationUs = typeof durationText === 'string' ? parseDuration(durationText) : undefined;
  if (typeof durationText === 'string' && durationUs === undefined) {
    throw new UsageError('cannot parse --duration ' + durationText);
  }
  const harness = generateQnxHarness(bundle.model, bundle.derived, durationUs === undefined ? {} : { durationUs });
  for (const file of harness.files) {
    const target = join(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  if (values['json'] === true) {
    process.stdout.write(JSON.stringify({ out: outDir, files: harness.files.map((file) => file.path) }) + '\n');
  } else {
    process.stdout.write(bold('generated') + ' QNX 8.0 harness for ' + bundle.model.name + '\n');
    process.stdout.write('  ' + dim(outDir) + '\n');
    for (const file of harness.files) process.stdout.write('    ' + file.path + '\n');
    process.stdout.write(
      '\n' + dim('measurement window ') + formatDuration(harness.durationUs) +
        dim('  ·  build with: make qnx (x86_64) or make qnx-arm') + '\n',
    );
  }
  for (const note of harness.unsupported) process.stderr.write(yellow('warning') + ' ' + note + '\n');
  return 0;
}

function initCommand(file: string | undefined, out: string | undefined, force: boolean): number {
  const target = resolve(out ?? file ?? 'scheduloscope.yaml');
  if (existsSync(target) && !force) throw new UsageError(target + ' already exists (pass --force to overwrite)');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(new URL('./templates/starter.yaml', import.meta.url), 'utf8'));
  process.stdout.write(bold('wrote') + ' ' + relative(process.cwd(), target) + '\n');
  process.stdout.write(dim('next: scheduloscope analyze ' + relative(process.cwd(), target)) + '\n');
  return 0;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(red('error') + ' ' + (error as Error).message + '\n');
    process.exitCode = 1;
  });
