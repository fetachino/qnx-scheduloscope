/** Structured diagnostics shared by parsing, analysis and simulation. */

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  readonly severity: Severity;
  /** Stable machine-readable code, e.g. `E_PRIORITY_RANGE`. */
  readonly code: string;
  readonly message: string;
  /** Dotted path inside the model file, e.g. `tasks[2].priority`. */
  readonly path?: string;
  /** Actionable suggestion for the user. */
  readonly hint?: string;
}

export class DiagnosticBag {
  private readonly items: Diagnostic[] = [];

  error(code: string, message: string, path?: string, hint?: string): void {
    this.items.push({ severity: 'error', code, message, ...(path ? { path } : {}), ...(hint ? { hint } : {}) });
  }

  warn(code: string, message: string, path?: string, hint?: string): void {
    this.items.push({ severity: 'warning', code, message, ...(path ? { path } : {}), ...(hint ? { hint } : {}) });
  }

  info(code: string, message: string, path?: string, hint?: string): void {
    this.items.push({ severity: 'info', code, message, ...(path ? { path } : {}), ...(hint ? { hint } : {}) });
  }

  add(diagnostic: Diagnostic): void {
    this.items.push(diagnostic);
  }

  get all(): readonly Diagnostic[] {
    return this.items;
  }

  get errorCount(): number {
    return this.items.filter((d) => d.severity === 'error').length;
  }

  get warningCount(): number {
    return this.items.filter((d) => d.severity === 'warning').length;
  }

  has(code: string): boolean {
    return this.items.some((d) => d.code === code);
  }
}
