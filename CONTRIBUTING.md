# Contributing

Thanks for looking. This is a small, deliberately strict codebase; the rules below keep the
analysis and the simulator honest.

## Setup

```bash
npm ci
npm run build
npm test
```

Node 20.11 or newer. There is no native dependency: the only runtime package is `yaml`.

## Ground rules

1. **A test for every behaviour.** Analysis and simulation changes need a case with numbers that
   can be checked by hand, not just a case that happens to pass.
2. **Never invent a timing result.** If something is measured, the platform is recorded next to
   the number. Host results are not QNX results.
3. **Strict TypeScript.** No `any`, no non-null assertions in new code unless the invariant is
   obvious in the surrounding lines, no `@ts-ignore`.
4. **The three consumers stay in sync.** If a field is added to the model, the parser, the
   validator, the analysis, the simulator, the report and the C generator all need to know about
   it, or the field needs a documented reason not to.
5. **Comments explain why.** The code says what it does; a comment is for the QNX detail a
   reader would not guess.

## Adding a model feature

- `src/core/model.ts`: the field and its type.
- `src/core/parse.ts`: the YAML key, its aliases, and a validation error for a bad value.
- `src/core/derive.ts` and/or `src/sim/engine.ts`: the behaviour.
- `src/report/report.ts`, `src/report/svg.ts`: how it shows up.
- `src/codegen/qnx.ts` and the templates: what the target harness does with it, and an entry in
  `unsupported` if the harness cannot reproduce it.
- `docs/model-reference.md`: the table row.
- A test in `tests/`, plus a line in `CHANGELOG.md`.

## Commits

Short imperative subject, a body that says what changed and why, one logical change per commit.

## Reporting a bug

Include the model (or a reduced version), the command, and the output of `scheduloscope version`.

