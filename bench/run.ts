/**
 * Synthetic scale benchmark.
 *
 * Builds task sets of increasing size, then times the analysis and the
 * simulator. The numbers are wall-clock on the machine that runs it, so they
 * describe the tool, never the modelled system.
 */
import { performance } from 'node:perf_hooks';
import { analyzeResponseTimes } from '../src/analysis/rta.js';
import { derive } from '../src/core/derive.js';
import { defaultModel, type SystemModel, type TaskModel } from '../src/core/model.js';
import { simulate } from '../src/sim/engine.js';

interface Row {
  tasks: number;
  deriveMs: number;
  analysisMs: number;
  simulateMs: number;
  verdict: string;
  switches: number;
}

function buildModel(count: number): SystemModel {
  const base = defaultModel('bench-' + String(count));
  const tasks: TaskModel[] = [];
  for (let i = 0; i < count; i += 1) {
    const periodUs = 10_000 + i * 100;
    // Keep the total utilisation near 60% and the priorities inside the QNX
    // range, so every size is a valid design and the times are comparable.
    const costUs = Math.max(1, Math.round((periodUs * 600) / (1000 * count)));
    tasks.push({
      name: 'task' + String(i).padStart(3, '0'),
      priority: 200 - i,
      policy: 'fifo',
      activation: { type: 'periodic', periodUs, offsetUs: 0 },
      deadlineUs: periodUs,
      segments: [{ kind: 'cpu', us: costUs }],
    });
  }
  return { ...base, tasks };
}

function measure(count: number): Row {
  const model = buildModel(count);

  const t0 = performance.now();
  const derived = derive(model);
  const t1 = performance.now();
  const analysis = analyzeResponseTimes(model, derived);
  const t2 = performance.now();
  const sim = simulate(model, { durationUs: 100_000, seed: 7 });
  const t3 = performance.now();

  return {
    tasks: count,
    deriveMs: t1 - t0,
    analysisMs: t2 - t1,
    simulateMs: t3 - t2,
    verdict: analysis.verdict,
    switches: sim.contextSwitches,
  };
}

// Distinct priorities, so every task has a well-defined place in the queue; a
// tie would be charged as interference and make the verdict inconclusive.
const sizes = [50, 100, 150, 200];
const rows: Row[] = [];
for (const size of sizes) rows.push(measure(size));

const header = ['tasks', 'derive ms', 'analysis ms', 'simulate ms', 'switches', 'verdict'];
const table = rows.map((row) => [
  String(row.tasks),
  row.deriveMs.toFixed(1),
  row.analysisMs.toFixed(1),
  row.simulateMs.toFixed(1),
  String(row.switches),
  row.verdict,
]);
const widths = header.map((title, index) =>
  Math.max(title.length, ...table.map((cells) => cells[index]!.length)),
);
const line = (cells: string[]): string =>
  cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ');

console.log(line(header));
console.log(widths.map((width) => '-'.repeat(width)).join('  '));
for (const cells of table) console.log(line(cells));
console.log('');
console.log('window 100ms, about 60% utilisation, periods 10ms..' + String(10_000 + (sizes[sizes.length - 1]! - 1) * 100) + 'us');

