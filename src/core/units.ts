/**
 * Time handling.
 *
 * All durations inside Scheduloscope are integers in microseconds. QNX's own
 * clock services work in nanoseconds, but a 1 us resolution keeps the model
 * exact (no floating point drift) and comfortably below the smallest
 * meaningful scheduling quantum on any current target.
 */

/** A duration in microseconds. */
export type Micros = number;

const UNIT_FACTORS: Readonly<Record<string, number>> = {
  ns: 0.001,
  us: 1,
  'µs': 1,
  ms: 1_000,
  s: 1_000_000,
};

const DURATION_RE = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(ns|us|µs|ms|s)?\s*$/;

/**
 * Parse a human duration such as `250us`, `1ms`, `0.5s` or a bare number
 * (microseconds). Returns undefined when the text is not a duration.
 */
export function parseDuration(text: string | number): Micros | undefined {
  if (typeof text === 'number') {
    return Number.isFinite(text) && text >= 0 ? text : undefined;
  }
  const m = DURATION_RE.exec(text);
  if (!m) return undefined;
  const value = Number(m[1]);
  const unit = m[2] ?? 'us';
  const factor = UNIT_FACTORS[unit];
  if (factor === undefined) return undefined;
  const micros = value * factor;
  // Reject sub-microsecond values that would silently round to zero.
  return Number.isFinite(micros) ? Math.round(micros * 1000) / 1000 : undefined;
}

/** Format microseconds using the most readable unit. */
export function formatDuration(micros: number): string {
  if (!Number.isFinite(micros)) return String(micros);
  const abs = Math.abs(micros);
  if (abs < 1) return `${(micros * 1000).toFixed(0)}ns`;
  if (abs < 1000) return `${trim(micros)}us`;
  if (abs < 1_000_000) return `${trim(micros / 1_000)}ms`;
  return `${trim(micros / 1_000_000)}s`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** Greatest common divisor for two integers. */
export function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Least common multiple for two integers, used for hyperperiods. */
export function lcm(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return Math.abs(Math.round(a / gcd(a, b)) * Math.round(b));
}
