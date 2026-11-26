/** Small helpers for turning unknown YAML values into typed values. */

import type { DiagnosticBag } from './diagnostics.js';
import { parseDuration } from './units.js';

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
    case 'boolean':
      return String(value);
    default:
      return 'a mapping';
  }
}

export function checkKeys(map: Record<string, unknown>, allowed: readonly string[], path: string, bag: DiagnosticBag): void {
  for (const key of Object.keys(map)) {
    if (allowed.includes(key)) continue;
    const suggestion = closest(key, allowed);
    bag.error(
      'E_UNKNOWN_KEY',
      `Unknown key "${key}" ${path ? `in ${path}` : 'at the top level'}.`,
      path ? `${path}.${key}` : key,
      suggestion ? `Did you mean "${suggestion}"?` : `Allowed keys: ${allowed.join(', ')}.`,
    );
  }
}

export function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const previous = new Array<number>(cols);
  const current = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) previous[j] = j;
  for (let i = 1; i < rows; i += 1) {
    current[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (previous[j] ?? 0) + 1;
      const ins = (current[j - 1] ?? 0) + 1;
      const sub = (previous[j - 1] ?? 0) + cost;
      current[j] = Math.min(del, ins, sub);
    }
    for (let j = 0; j < cols; j += 1) previous[j] = current[j] ?? 0;
  }
  return previous[cols - 1] ?? 0;
}
