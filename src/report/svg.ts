/**
 * SVG timeline rendering.
 *
 * The chart is drawn from the simulator trace, so what you see is exactly what
 * the model produced: no illustrative hand-drawing. Slices are clipped to the
 * requested window and adjacent identical slices are merged, which keeps the
 * SVG small enough to embed in a self-contained report.
 */

import type { SimResult, TraceKind, TraceSlice } from '../sim/engine.js';
import { formatDuration, type Micros } from '../core/units.js';

export interface GanttOptions {
  readonly width?: number;
  readonly startUs?: Micros;
  readonly endUs?: Micros;
  readonly laneHeight?: number;
}

const COLORS: Record<string, string> = {
  cpu: '#4f8cff',
  'cs': '#f5a524',
  rpc: '#a78bfa',
  sleep: '#4b5563',
  irq: '#f87171',
  kernel: '#64748b',
  idle: '#1b1f27',
};

const LEGEND: readonly (readonly [string, string])[] = [
  ['cpu', 'CPU'],
  ['cs', 'critical section'],
  ['rpc', 'RPC'],
  ['irq', 'interrupt'],
  ['kernel', 'kernel'],
];

export function segmentColor(segment: string | undefined, kind: TraceKind): string {
  if (kind === 'irq') return COLORS['irq']!;
  if (kind === 'kernel') return COLORS['kernel']!;
  if (kind === 'idle') return COLORS['idle']!;
  if (!segment) return COLORS['cpu']!;
  const head = segment.split(':')[0] ?? 'cpu';
  return COLORS[head] ?? COLORS['cpu']!;
}

export function renderGantt(sim: SimResult, options: GanttOptions = {}): string {
  const width = options.width ?? 760;
  const laneHeight = options.laneHeight ?? 26;
  const start = options.startUs ?? 0;
  const end = Math.min(options.endUs ?? sim.horizonUs, sim.horizonUs);
  const span = Math.max(1, end - start);

  const laneOrder: string[] = [];
  for (const task of sim.tasks) laneOrder.push(task.name);
  for (const channel of sim.channels) {
    for (let i = 1; i <= channel.threadCount; i += 1) laneOrder.push('server:' + channel.name + '#' + i);
  }
  if (sim.irqUs > 0) laneOrder.push('irq');
  laneOrder.push('kernel');

  const labelWidth = 124;
  const top = 46;
  const bottom = 32;
  const plotWidth = width - labelWidth - 14;
  const height = top + laneOrder.length * laneHeight + bottom;
  const x = (t: number) => labelWidth + ((t - start) / span) * plotWidth;
  const children: string[] = [];

  children.push('<style>');
  children.push('.lane-label { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #d5dde6; }');
  children.push('.tick-label { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #8b949e; }');
  children.push('.legend { font: 11px system-ui, -apple-system, Segoe UI, sans-serif; fill: #9aa5b1; }');
  children.push('.slice:hover { stroke: #ffffff; stroke-width: 1; }');
  children.push('.grid { stroke: #21262d; stroke-width: 1; stroke-dasharray: 2 4; }');
  children.push('</style>');

  children.push(rect(0, 0, width, height, '#0d1117', 'frame'));

  let legendX = labelWidth;
  for (const [key, label] of LEGEND) {
    children.push(rect(legendX, 10, 10, 10, COLORS[key]!, 'swatch'));
    children.push(text(legendX + 15, 19, label, '#9aa5b1', 'legend', 'start'));
    legendX += 15 + label.length * 5.6 + 16;
  }

  const tickStep = niceStep(span / 6);
  for (let t = Math.ceil(start / tickStep) * tickStep; t <= end + 0.001; t += tickStep) {
    const gx = x(t);
    if (gx >= labelWidth) {
      children.push(line(gx, top - 8, gx, height - bottom, '#21262d', 'grid'));
      children.push(text(gx, top - 16, formatDuration(t), '#8b949e', 'tick-label', 'middle'));
    }
  }

  laneOrder.forEach((lane, index) => {
    const y = top + index * laneHeight;
    if (index % 2 === 0) children.push(rect(labelWidth, y, plotWidth, laneHeight, '#0b0f16', 'row'));
    children.push(text(labelWidth - 10, y + laneHeight / 2 + 4, truncate(laneLabel(lane), 15), '#d5dde6', 'lane-label', 'end'));
    for (const slice of collectLane(sim.traces, lane, start, end)) {
      const sx = x(slice.start);
      const sw = Math.max(0.8, x(slice.end) - sx);
      const color = segmentColor(slice.segment, slice.kind);
      const detail = lane + (slice.segment ? ' · ' + slice.segment : '') + ' · ' + formatDuration(slice.start) +
        ' → ' + formatDuration(slice.end) + ' (' + formatDuration(slice.end - slice.start) + ')';
      children.push(
        '<rect class="slice" x="' + round(sx) + '" y="' + round(y + 4) + '" width="' + round(sw) +
          '" height="' + (laneHeight - 8) + '" rx="2" fill="' + color + '" fill-opacity="0.9"><title>' +
          escapeXml(detail) + '</title></rect>',
      );
    }
  });

  children.push(
    text(labelWidth, height - 10, 'window ' + formatDuration(start) + ' → ' + formatDuration(end) + ' of ' +
      formatDuration(sim.horizonUs), '#8b949e', 'tick-label', 'start'),
  );

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height +
    '" width="100%" style="height:auto;display:block" role="img" aria-labelledby="ss-gantt-title ss-gantt-desc">' +
    '<title id="ss-gantt-title">Simulated scheduler timeline</title>' +
    '<desc id="ss-gantt-desc">Lane-by-lane schedule for the first ' + formatDuration(end - start) +
    ' of a ' + formatDuration(sim.horizonUs) + ' simulation. ' + laneOrder.length +
    ' lanes: ' + laneOrder.map((lane) => escapeXml(laneLabel(lane))).join(', ') + '. ' +
    'Bars show CPU, critical-section, server-call, interrupt, and kernel time. This is model output, not a hardware measurement.</desc>' +
    children.join('') + '</svg>'
  );
}

/** Server lanes are named 'server:<channel>#<n>'; drop the prefix for display. */
function laneLabel(lane: string): string {
  return lane.startsWith('server:') ? lane.slice('server:'.length) : lane;
}

function collectLane(traces: readonly TraceSlice[], lane: string, start: number, end: number): TraceSlice[] {
  const out: TraceSlice[] = [];
  for (const slice of traces) {
    if (slice.lane !== lane) continue;
    if (slice.end <= start || slice.start >= end) continue;
    const clipped: TraceSlice = { ...slice, start: Math.max(slice.start, start), end: Math.min(slice.end, end) };
    const last = out[out.length - 1];
    if (last && last.kind === clipped.kind && last.segment === clipped.segment && Math.abs(last.end - clipped.start) < 0.001) {
      out[out.length - 1] = { ...last, end: clipped.end };
    } else {
      out.push(clipped);
    }
  }
  return out;
}

function niceStep(raw: number): number {
  const exponents = [1, 2, 5, 10];
  let magnitude = 1;
  while (magnitude * 10 <= raw) magnitude *= 10;
  for (const factor of exponents) {
    if (magnitude * factor >= raw) return magnitude * factor;
  }
  return magnitude * 10;
}

function rect(x: number, y: number, w: number, h: number, fill: string, cls: string): string {
  return '<rect class="' + cls + '" x="' + round(x) + '" y="' + round(y) + '" width="' + round(w) + '" height="' + round(h) + '" fill="' + fill + '"/>';
}
function line(x1: number, y1: number, x2: number, y2: number, stroke: string, cls: string): string {
  return '<line class="' + cls + '" x1="' + round(x1) + '" y1="' + round(y1) + '" x2="' + round(x2) + '" y2="' + round(y2) + '" stroke="' + stroke + '"/>';
}
function text(x: number, y: number, content: string, fill: string, cls: string, anchor: string): string {
  return '<text class="' + cls + '" x="' + round(x) + '" y="' + round(y) + '" fill="' + fill + '" text-anchor="' + anchor + '">' + escapeXml(content) + '</text>';
}
function round(value: number): number { return Math.round(value * 10) / 10; }

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}
