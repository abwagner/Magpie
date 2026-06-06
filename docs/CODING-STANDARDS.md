# Coding Standards

Detailed guidelines for implementing the trading system. The short version is in `CLAUDE.md` at the repo root.

As of the Phase 0 polyglot migration ([polyglot-migration-tdd.md](polyglot-migration-tdd.md)), this document covers **three** languages: TypeScript for the operator-facing edge, Python for the research / strategy half, and Rust for execution and math hot paths. Each language section below names its canonical toolchain, layout, and conventions; cross-cutting concerns (testing philosophy, error-handling principles, structured logging) are covered language-agnostically at the bottom with per-language deltas where they matter.

---

## TypeScript Conventions

- `"strict": true` — no implicit `any`, strict null checks.
- Prefer `interface` over `type` for object shapes that will be implemented/extended.
- Use `type` for unions, intersections, and utility types.
- No `any`. Use `unknown` and narrow with type guards.
- Export types alongside the functions that produce/consume them.
- Shared types go in `src/types/` (e.g., `symbol.ts`, `order.ts`, `portfolio.ts`).
- ESM requires explicit `.js` extensions in imports (even for `.ts` source files — the extension refers to compiled output). This matches the existing codebase convention.

For the migration strategy, tsconfig, and implementation phasing, see [Cross-Cutting TDD §6](tdd/cross-cutting.md).

---

## Shared types

Core domain types live in `src/types/`. These are the canonical definitions referenced by all components.

### Expected type files

| File                       | Types                                                                      | Notes                                    |
| -------------------------- | -------------------------------------------------------------------------- | ---------------------------------------- |
| `src/types/symbol.ts`      | `CanonicalSymbol`, `SymbolClass`, `ParsedSymbol`                           | Canonical symbol format                  |
| `src/types/order.ts`       | `OrderIntent`, `Order`, `OrderStatus`, `Fill`                              | Order lifecycle from Order Execution TDD |
| `src/types/portfolio.ts`   | `PortfolioState`, `Position`, `RiskLimits`, `RiskCheckResult`, `Violation` | Portfolio & Risk Engine                  |
| `src/types/market-data.ts` | `Contract`, `Quote`, `SourceMeta`, `MarketDataService`                     | Data Plane (live broker MD interface)    |
| `src/types/strategy.ts`    | `Strategy`, `StrategyAction`, `StrategyCtx`, `LegacyStrategy`              | Strategy interface + ctx                 |
| `src/types/config.ts`      | `MarketDataConfig`, `PortfolioConfig`, `CalendarConfig`                    | Config file schemas                      |

Interfaces are the primary tool for defining shapes. Use `type` for unions and utilities:

```ts
// Interface for shapes that are implemented:
interface Order {
  order_id: string;
  broker: string;
  // ...
}

// Type for unions:
type OrderStatus =
  | "proposed"
  | "risk_check"
  | "approved"
  | "submitted"
  | "filled"
  | "partial_fill"
  | "rejected"
  | "cancelled"
  | "submission_failed";

// Type for utility:
type OrdersByBroker = Map<string, Order>;
```

---

## ESLint + Prettier Configuration

### `.prettierrc`

```json
{
  "semi": true,
  "singleQuote": false,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 120,
  "arrowParens": "always"
}
```

Double quotes to match the existing codebase. `printWidth: 120` because the existing code already goes beyond 80.

### `.eslintrc.cjs`

```js
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "prettier", // disables ESLint rules that conflict with Prettier
  ],
  parserOptions: {
    project: "./tsconfig.json",
  },
  rules: {
    // Match existing codebase style:
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-non-null-assertion": "warn",

    // Practical for financial code:
    "no-loss-of-precision": "error",
    "no-floating-decimal": "error",

    // Allow single-letter math vars in computation libs:
    // (enforced by review, not lint — short var names are idiomatic for BS, SABR, etc.)
  },
};
```

### Dev dependencies to add

```bash
npm install -D typescript @typescript-eslint/parser @typescript-eslint/eslint-plugin \
  eslint eslint-config-prettier prettier
```

### npm scripts to add

```json
{
  "lint": "eslint 'server/**/*.ts' 'src/**/*.ts'",
  "lint:fix": "eslint --fix 'server/**/*.ts' 'src/**/*.ts'",
  "format": "prettier --write 'server/**/*.ts' 'src/**/*.ts'",
  "typecheck": "tsc --noEmit",
  "check": "npm run typecheck && npm run lint && npm run test"
}
```

`npm run check` is the full verification suite: types + lint + tests. Should pass before every commit.

---

## Rust Conventions

Rust is used for the math hot path (Greeks / vol-surface / Black-Scholes / Black-76 / BL extraction via PyO3 + WASM) and the LP optimizer. Crates live in a cargo workspace at `core/`. Execution lives in the per-broker NT bundles (Python, per [broker-integration.md](tdd/broker-integration.md)) — there is no Rust execution sidecar in the current architecture; the placeholder `core/qf-execution/` crate is deferred indefinitely.

### Toolchain

| Tool              | Purpose                                  | Notes                                                                                                                                                       |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rustc` + `cargo` | Compiler + build/dep manager             | Version pinned in `rust-toolchain.toml` (committed). CI verifies match.                                                                                     |
| `rustfmt`         | **Canonical formatter** — non-negotiable | `cargo fmt --all -- --check` in CI; pre-commit reformats staged files. Default config (no `rustfmt.toml` unless we hit a specific need).                    |
| `clippy`          | **Canonical linter** — non-negotiable    | `cargo clippy --workspace --all-targets -- -D warnings` in CI. Warnings are errors.                                                                         |
| `cargo-deny`      | License + advisory + ban-list            | Per [polyglot-migration-tdd.md §6.7](polyglot-migration-tdd.md#67-per-language-tooling-specifics). Allowed licenses: MIT, Apache-2.0, BSD-\*, ISC, MPL-2.0. |
| `cargo-audit`     | RUSTSEC advisory scan                    | Runs in CI alongside `osv-scanner` (cross-ecosystem).                                                                                                       |

### Project layout

```
core/
  Cargo.toml              # workspace manifest
  Cargo.lock              # **committed**, even for library-only crates
  rust-toolchain.toml     # pinned toolchain
  .cargo/config.toml      # registry → private cargo mirror (panamax)
  deny.toml               # cargo-deny config
  qf-quant/               # math hot path: Greeks, vol surface, BL (Phase 1)
    Cargo.toml
    src/
      lib.rs
      bs.rs                # mirrors src/lib/bs.ts
      sabr.rs
      ...
    tests/
  qf-logging/              # tracing subscriber emitting common JSON (Phase 0)
  qf-execution/            # placeholder; deferred indefinitely. Execution lives in per-broker NT bundles (Python).
  qf-optimizer/            # good_lp + HiGHS LP optimizer (Phase 5)
```

Workspace conventions:

- One crate per coherent responsibility; tight cohesion within a crate, low coupling between crates.
- `[lib] crate-type = ["cdylib", "rlib"]` on any crate that's also a PyO3 extension module (`qf-quant`, eventually `qf-optimizer`'s WASM build).
- All deps in `Cargo.toml` use exact `=` pins (e.g. `pyo3 = "=0.22.3"`, not `^0.22`). `Cargo.lock` is the source of truth for what shipped.
- New external deps go through the admission workflow ([polyglot-migration-tdd.md §6.3](polyglot-migration-tdd.md#63-admission-workflow)).

### Style

- `snake_case` for functions, methods, variables, module names. `UpperCamelCase` for types, traits, enum variants. `SCREAMING_SNAKE_CASE` for constants.
- Files match the primary type / module they expose: `vol_surface.rs` exports `VolSurface`.
- Prefer `&str` over `String` in argument position; return `String` (or `Cow<'_, str>`) when ownership is required.
- Newtypes around primitive trading types: `struct Delta(f64)`, `struct Strike(f64)`, etc. — match the fixed-point discipline we want from the math libs ([polyglot-migration-tdd.md §3](polyglot-migration-tdd.md#3-quantlib)).
- No `unsafe` outside FFI boundaries; any `unsafe` block carries a `// SAFETY: …` comment explaining the invariant.
- Re-exports go at the crate root (`pub use crate::module::Type;`) so consumers see a flat surface.

### Error handling

- Use `Result<T, E>` everywhere a failure is possible; never panic on recoverable conditions.
- One error type per crate, defined with [`thiserror`](https://docs.rs/thiserror) — derives `Error`, `Debug`, `Display`. Concrete variants named after the failure mode (`SymbolParseFailed`, `BrokerRejected { reason }`), not after the call site.
- At public crate boundaries (PyO3 entry points, NATS subscribers, HTTP handlers) errors are converted to the relevant boundary's contract: PyO3 → `PyErr`, NATS → emit a `*.error` event on a sibling subject, HTTP → JSON response with typed `error` field.
- `panic!` is reserved for invariant violations that mean the process must die — never for user input.
- `Result::unwrap()` and `Result::expect()` are forbidden outside tests and `main()`-level startup wiring.

### Testing

- Unit tests live in `#[cfg(test)] mod tests { … }` blocks at the bottom of the file under test (Rust convention).
- Integration tests in `tests/` (sibling to `src/`). Cross-crate end-to-end tests sit in a top-level `qf-integration/` crate so they share fixtures.
- Property-based testing with `proptest` for any pure-math function whose contract is "for all inputs in range R, property P holds." Required for `bs.rs`, `sabr.rs` invariants (positivity, monotonicity).
- Equivalence harness: the Phase 1 acceptance test pipes the TS reference output through the Rust impl and asserts agreement to 1e-9 ([polyglot-migration-tdd.md Phase 1](polyglot-migration-tdd.md#phase-1--math-libraries-to-rust-3-weeks)).
- `cargo test --workspace` runs all tests; `cargo test --release --workspace` runs the benchmark-adjacent ones (some assertions are tighter under release).

### Logging

Use the `qf-logging` crate ([core/qf-logging/](../core/qf-logging/)) which installs a `tracing-subscriber` `Layer` that emits the common JSON schema from [tdd/observability.md §3](tdd/observability.md#3-common-json-log-schema). Every PyO3 entry point and NATS handler is wrapped with `#[instrument(skip_all)]`, recording `correlation_id` as a span field. Propagation rules in [tdd/observability.md §4.3](tdd/observability.md#43-in-process-propagation).

```rust
use qf_logging::with_correlation_id;
use tracing::{debug, info};

#[pyfunction]
fn delta(correlation_id: &str, /* … */) -> PyResult<f64> {
    with_correlation_id(correlation_id, || {
        debug!(event = "bs.delta_computed", spot, iv);
        // …
    })
}
```

---

## Python Conventions

Python is used for the research half — NautilusTrader strategies, backtest orchestrator, walk-forward driver, and any analytics/training scripts. The Python project root is `research/`.

### Toolchain

| Tool                 | Purpose                              | Notes                                                                                                                                                                                              |
| -------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uv`                 | **Canonical** package + venv manager | Installed via `pipx install uv` or `pip install uv`. `uv sync --frozen` for reproducible installs.                                                                                                 |
| `pyproject.toml`     | Project manifest (PEP 621)           | Dependency groups for `dev` / `test` / `prod`. No `setup.py`, no `requirements.txt`.                                                                                                               |
| `uv.lock`            | Lockfile                             | Committed. Hash-pinned. `uv sync --frozen --check` in CI to detect drift.                                                                                                                          |
| `ruff`               | **Canonical** linter + formatter     | One tool covers what black + isort + flake8 + pyupgrade + a dozen plugins used to. Default config in [pyproject.toml](../research/pyproject.toml); CI runs `ruff check` and `ruff format --check`. |
| `mypy`               | Static type checker                  | Strict mode (`strict = true` in `[tool.mypy]`). Required on `research/quantfoundry_*`; advisory on scripts.                                                                                        |
| `pytest`             | **Canonical** test runner            | Plus `pytest-asyncio` for NATS handlers, `pytest-cov` for coverage. No `unittest`.                                                                                                                 |
| `quantfoundry-quant` | Rust math libs via PyO3              | Built with `maturin`; imported as a normal Python module post-install.                                                                                                                             |

### Project layout

```
research/
  pyproject.toml           # workspace root
  uv.lock                  # **committed**
  [tool.uv.workspace]
    members = ["quantfoundry-*"]
  quantfoundry-logging/    # qf_logging package (Phase 0)
  quantfoundry-orchestrator/  # BacktestNode wrapper, walk-forward driver
  quantfoundry-research/   # shared helpers across strategies/orchestrator
strategies/                # gitignored symlink → ../quantfoundry-strategies
                           # (created by scripts/setup-strategies-symlink.sh;
                           # strategies live in their own repo, not in QF —
                           # see docs/RUNBOOK.md "Operator setup")
```

Workspace conventions:

- One package per top-level dir under `research/`; each has its own `pyproject.toml` with `quantfoundry-research` (and friends) declared as a path dep or workspace member.
- Package names are kebab-case at the distribution level (`quantfoundry-logging`), snake_case at the import level (`quantfoundry_logging`).
- Strategy packages live in the sibling `quantfoundry-strategies` repo, not in QF. New strategies start there, one top-level dir per strategy, each a standalone uv project.
- Every QF-hosted package adds an entry to the workspace `members` list. No nested workspaces.

### Style

- `snake_case` for functions, methods, modules, variables. `UpperCamelCase` for classes. `SCREAMING_SNAKE_CASE` for module-level constants.
- File names match the primary class they export: `vol_surface.py` → `class VolSurface`.
- Type hints **required** on every public function and method (`mypy strict` enforces). `Any` is forbidden outside the boundary of external libraries that don't ship stubs.
- Prefer `dataclasses` (or `pydantic.BaseModel` when validation is needed) over loose dicts for any wire-shape or domain type. Frozen dataclasses for immutable values.
- Prefer composition + protocols over inheritance. `typing.Protocol` for structural typing across the framework / strategy boundary.
- Line length follows ruff default (88); long imports use parenthesised multi-line form.
- No `__all__` lists — explicit re-exports via the package's `__init__.py` are fine for small surfaces; for larger ones, let the import path be the contract.

### Error handling

- Define one base exception per package, all other exceptions inherit from it: `class OrchestratorError(Exception): pass` → `class RateLimited(OrchestratorError): …`.
- Domain exceptions carry typed attributes (`retry_after_seconds: float`), not just strings.
- Catch at boundaries (NATS handler entry, HTTP handler, top of a worker loop); let exceptions propagate within a layer.
- `try` blocks should wrap one logical operation; nested `try` is a smell.
- Never `except Exception: pass`. If you legitimately need to swallow, log at debug-level and explain in a comment.
- Async: every coroutine is awaited; bare-task patterns use `asyncio.create_task()` only with a stored reference plus an `add_done_callback` that logs failures.

### Testing

- Tests live in `tests/` at each package root, mirroring the package structure: `quantfoundry-logging/tests/test_qf_logging.py`.
- `pytest` discovers via `test_*.py` files and `test_*` functions; no class-based test scaffolding unless a fixture genuinely needs `self`.
- Use `pytest.fixture` for shared setup; `pytest-asyncio` `@pytest.mark.asyncio` for coroutines.
- NATS interactions use a fake (`tests/fakes/fake_nats.py`); integration tests against a real NATS run under `pytest -m integration` (opt-in, gated by env var).
- Property-based tests with `hypothesis` for pure-math helpers in `quantfoundry-research` (same discipline as the Rust side).
- Coverage target: 80% line coverage on `quantfoundry_*` packages; orchestrator-only glue is exempt.

### Logging

Use the `quantfoundry_logging` package which configures `structlog` to emit the common JSON schema from [tdd/observability.md §3](tdd/observability.md#3-common-json-log-schema). The package owns a single `ContextVar` for `correlation_id`; readers / writers go through `with_correlation_id` / `current_correlation_id`. Never instantiate a new `ContextVar` in user code.

```python
from quantfoundry_logging import logger, with_correlation_id

with with_correlation_id(correlation_id):
    logger.info("strategy.evaluated", payload={"strategy": "soxx-rotation", "intents": 3})
```

Propagation rules — including the PyO3 boundary contract (every Rust entry point takes `correlation_id: str` as its first non-input argument) — are in [tdd/observability.md §4](tdd/observability.md#4-correlation-id-propagation).

---

## Testing Standards

### File placement

```
server/order/plane.ts
server/order/__tests__/
  unit/
    plane.test.ts         ← unit test for plane.ts
  integration/
    sidecar.test.ts       ← integration test requiring NATS
  fixtures/
    orders.ts             ← shared test fixtures
  helpers/
    fake-nats.ts          ← NATS fake for unit tests
```

### Test structure

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { parseSymbol } from "../symbol.js";
import { VALID_EQUITY_SYMBOL, INVALID_MISSING_ROOT } from "./fixtures/symbols.js";

describe("parseSymbol", () => {
  describe("valid symbols", () => {
    it("accepts a valid equity symbol", () => {
      const result = parseSymbol(VALID_EQUITY_SYMBOL);
      expect(result.valid).toBe(true);
    });
  });

  describe("invalid symbols", () => {
    it("rejects missing root", () => {
      const result = parseSymbol(INVALID_MISSING_ROOT);
      expect(result.valid).toBe(false);
      expect(result.error?.field).toBe("root");
    });
  });
});
```

### What to test

| Code type                                                                                | Test approach                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Pure functions (schema validation, symbol parsing, Greek computation, analytics metrics) | Unit test every input class: valid, boundary, invalid. Use `toBeCloseTo` for floating-point.      |
| State machines (order lifecycle, portfolio state)                                        | Test every transition: valid transitions succeed, invalid transitions throw.                      |
| Config loading                                                                           | Test valid config, missing required fields, invalid values, reload behavior.                      |
| Rate limiter / token bucket                                                              | Test consume/refill math, multi-model batches, config reload clamp.                               |
| NATS interactions (sidecar, rollup, consumer)                                            | Unit test with fake-nats. Integration test with real NATS in Docker.                              |
| Market data adapters                                                                     | Unit test with mocked HTTP responses. Integration test (opt-in, gated by env var) with real APIs. |
| DuckDB queries (catalog, audit, analytics)                                               | Test with in-memory DuckDB instance.                                                              |
| WebSocket bridge                                                                         | Integration test with real `ws` client.                                                           |
| React components                                                                         | Existing `@testing-library` setup. Test new tabs when implemented.                                |

### What NOT to test

- Glue code that only wires dependencies together (e.g., the dependency injection in `server/index.ts`).
- Config file schemas beyond the validation function (the validation function IS the test for the schema).
- Third-party library behavior (DuckDB queries work, NATS publishes work — trust the library).

---

## Error Handling

### Pattern

```ts
// Domain errors — thrown at validation boundaries
export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export class RateLimitError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly retryAfterMs: number,
  ) {
    super(`Rate limited: ${modelId}`);
    this.name = "RateLimitError";
  }
}

// At the API boundary — catch and convert to HTTP response
function handleRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    // ... route handling
  } catch (err) {
    if (err instanceof ValidationError) {
      respond(res, 400, { error: "validation_failed", field: err.field, message: err.message });
    } else if (err instanceof RateLimitError) {
      respond(res, 429, {
        error: "rate_limited",
        model_id: err.modelId,
        retry_after_ms: err.retryAfterMs,
      });
    } else {
      logger.error({ err }, "unhandled error");
      respond(res, 500, { error: "internal" });
    }
  }
}
```

### Rules

1. **Never `catch {}`** (empty catch). Always at least log the error.
2. **Throw early, catch late.** Validation functions throw; API handlers catch and respond.
3. **Use typed errors** for domain-specific failures. Catch by `instanceof`, not by message string.
4. **Async errors** — always `await` promises or attach `.catch()`. Unhandled rejections crash the process (Node default, don't override).

---

## Logging

All log output is structured JSON conforming to the cross-runtime schema in [tdd/observability.md §3](tdd/observability.md#3-common-json-log-schema). Never `console.log` (TS), `print` (Python), or `println!` (Rust) in production code. The three runtime helper packages — `server/logging` (TS), `quantfoundry_logging` (Python), `qf-logging` (Rust crate) — all emit the same schema; a golden parity test verifies byte-level agreement modulo `ts`.

**TypeScript helper** (the existing one, extended for `correlation_id` propagation):

```ts
import { withCorrelationId, logger } from "server/logging";

await withCorrelationId(req.headers["x-correlation-id"] ?? newUlid(), async () => {
  logger.info("order.received", { order_id, broker });
});
```

Required fields and propagation rules in [tdd/observability.md §3-§4](tdd/observability.md#3-common-json-log-schema). The previous "set `component` at logger creation" convention is now subsumed by the schema's `service` field — same idea, different field name to match the cross-runtime contract.

For Rust and Python equivalents see the per-language conventions above.

---

## Writes go through dispatch

Any code path that writes to the canonical data lake (`s3://quantfoundry-data` or its `file://` fallback) MUST go through the M10-1 write-dispatch API at `POST /api/write-jobs`. The QF server is the only process that holds S3 write credentials post-M10-6; clients (CLI scripts, cron container, ad-hoc tools) submit jobs via the dispatcher. See [docs/dispatch-architecture.md](dispatch-architecture.md) for the architecture, [docs/RUNBOOK.md §5](RUNBOOK.md#5-historical-data-collection) for the operator workflow.

The narrow exception is:

- `Storage.storeChain` hot-path callers inside `server/index.js` — they run in the server process and write directly via the storage primitive `writeChainParquet`. Going through the dispatcher would serialize concurrent quote refreshes behind a single in-flight job.

If you're adding a new writer surface and it doesn't fall into that exception, register it as a new kind in `server/writeJobs/handlers/`.

---

## Commit Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- One logical change per commit. Don't mix feature code with formatting changes.
- Tests and implementation in the same commit (not separate "add tests" commits).
- Reference the TDD topic when implementing a specified component: `feat: implement order plane validation (Order Plane TDD topic 1)`.

---

## Implementation Order

Recommended order for building the system (dependencies flow top to bottom):

```
Phase 0: Tooling setup
  TypeScript, ESLint, Prettier, tsconfig
  Migrate existing test infrastructure to TS

Phase 1: Pure functions (zero dependencies, fully testable)
  src/types/*.ts (shared type definitions)
  server/symbols/symbol.ts (canonical symbol parser/formatter)
  server/symbols/convert.ts (OCC ↔ canonical conversion)
  server/calendar/index.ts (market calendar)

Phase 2: Infrastructure
  server/db/init.ts (DuckDB table creation)
  server/logger.ts (structured JSON logger)
  server/risk/evaluator.ts (risk evaluator types)

Phase 3: Market Data (evolve existing code)
  server/market-data/cache.ts
  server/market-data/adapters/marketdata.ts (refactor existing)
  server/market-data/sources.ts
  server/market-data/quality-gate.ts
  server/market-data/service.ts

Phase 4: Strategy + Portfolio + Orders
  server/portfolio/engine.ts
  server/portfolio/reconciliation.ts
  server/portfolio/replay.ts
  server/order/fill-log.ts
  server/order/adapters/paper.ts
  server/order/plane.ts

Phase 5: Write jobs + analytics
  server/writeJobs/handlers/ (job handler interface)
  server/analytics/api.ts
  server/analytics/scheduler.ts

Phase 6: GUI
  New React components (OrdersTab, RiskDashboardTab, TradeInspectorTab)
  server/ws-state.ts

Phase 7: Broker adapters (requires broker accounts)
  server/market-data/adapters/ibkr.ts
  server/market-data/adapters/schwab.ts
  server/order/adapters/ibkr.ts
  server/order/adapters/schwab.ts
```
