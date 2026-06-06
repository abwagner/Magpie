# Magpie — Agent Guidelines

## What this project is

An options trading system evolving from an analysis tool into a full signal ingestion → strategy → risk → execution pipeline. See `docs/TRADING-SYSTEM-TDD.md` for system design and `docs/tdd/` for component TDDs.

## Language and tooling

- **TypeScript** for all code. **Do not write new `.js` or `.jsx`** — the
  remaining JS/JSX files are tracked migration debt; see
  [docs/MIGRATION-JSX-TS.md](docs/MIGRATION-JSX-TS.md). Convert any file you
  meaningfully touch instead of editing the `.jsx`/`.js` in place.
- React components live in `.tsx` and export a typed `Props` interface
  alongside the component.
- Strict mode is on (`"strict": true`, `"noUncheckedIndexedAccess": true` in
  [tsconfig.json](tsconfig.json)).
- **Pre-commit framework** ([.pre-commit-config.yaml](.pre-commit-config.yaml))
  enforces ESLint + Prettier + `tsc --noEmit` + hygiene checks on every
  commit. If you don't have it installed yet:
  `pip install pre-commit && pre-commit install` (or
  `uv tool install pre-commit && pre-commit install`).
- **ESM** modules (`import`/`export`). `"type": "module"` in package.json.
- **Vitest** for tests. Every `.ts` file gets a corresponding `.test.ts`.
- **No frameworks** for the HTTP server — keep the hand-rolled `node:http` pattern.

## Code style

- 2-space indentation, semicolons, double quotes.
- `camelCase` for functions/variables, `kebab-case` for files, `UPPER_SNAKE` for constants.
- Header comments with `// ── Section ────` dividers for major sections in a file.
- No JSDoc — use TypeScript types instead. Inline comments only where logic isn't self-evident.
- Keep functions small. If a function is over 40 lines, it should probably be split.

## TypeScript conventions

- Prefer `interface` over `type` for object shapes that will be implemented/extended.
- Use `type` for unions, intersections, and utility types.
- No `any`. Use `unknown` and narrow with type guards.
- Export types alongside the functions that produce/consume them.
- Shared types go in `src/types/` (e.g., `signal.ts`, `order.ts`, `portfolio.ts`).

## Error handling

- **Throw at boundaries** (API endpoints, NATS handlers, file I/O). Catch and handle at the top of the call stack.
- **Don't silently swallow errors.** The existing codebase has `catch {}` blocks — migrate these to at least log the error.
- **Use typed error classes** for domain errors (`ValidationError`, `RateLimitError`, `BrokerError`).
- **Structured logging** — all log output is JSON via the logger. Never `console.log` in production code (tests are fine).

## Testing

- Every module gets a test file. Pure functions get unit tests; integration tests for cross-component flows.
- Tests live next to what they test: `server/signals/__tests__/unit/schema.test.ts`.
- Use the NATS fake (`helpers/fake-nats.ts`) for unit tests. Real NATS (Docker) for integration tests.
- Fixtures in `__tests__/fixtures/`. No inline test data if it's reused across tests.
- Tests must pass before merge. No skipped tests in main branch.

## Dependencies

- Minimize new dependencies. Each addition must solve a problem that's > 100 lines to implement ourselves.
- Prefer Node built-ins and small focused packages.
- Approved additions for the trading system: `nats` (NATS client), `prom-client` (Prometheus), `ws` (WebSocket), `ulid` (ID generation).
- Document why a dependency was added in the commit message.
- No frameworks (Express, Fastify, etc.).

## File organization

- Server-side code: `server/<component>/` (e.g., `server/signals/`, `server/market-data/`, `server/order/`).
- Shared types: `src/types/`.
- Strategies: `src/lib/strategies/`.
- Analytics: `src/lib/analytics/`.
- Existing computation libs: `src/lib/` (bs.ts, sabr.ts, vol-surface.ts, etc.).
- Config files: `config/` (signals.json, market-data.json, portfolios.json, market-calendar.json).
- Data: `data/chains/`, `data/signals/`, `data/fills/`, `data/results/`.

## Key design docs

- System design: `docs/TRADING-SYSTEM-TDD.md`
- Component TDDs: `docs/tdd/*.md`
- Data sources: `docs/data/` (sources, universes, market-data, collection)
- Runbook: `docs/RUNBOOK.md`
- JSX → TS migration tracker: `docs/MIGRATION-JSX-TS.md`
- Pre-commit setup: `.pre-commit-config.yaml` + `eslint.config.js`
- Math background: `docs/tdd/greek-builder.md` Appendix A (Breeden-Litzenberger, SABR, vol surface, edge-to-Greeks, LP)
