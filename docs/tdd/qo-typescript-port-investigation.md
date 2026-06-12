# QO Python→TS Port Investigation (QF-305)

Should quant-optimizer (QO) be ported from Python to TypeScript so it can `import`
the gate evaluator natively and eliminate the `gate-evaluator-cli` subprocess shim?

This is a **research + recommendation** doc. It evaluates the three options named in
QF-305 against the actual QO dependency graph, scopes each at S/M/L/XL, and ends with
a recommendation plus a list of cheap incremental wins that capture most of the value
without a port.

**Verdict up front:** keep the shim (status quo / option (c) territory). None of the
porting options pays for itself at v1, and option (b) — a TS-native backtester —
is an XL multi-quarter rewrite of NautilusTrader and Optuna that QF-305 should
explicitly reject. The conditions that would flip this are listed in §7.

---

## 1. What the shim actually is

The v1 backtest-gate architecture ([backtest-gate.md](backtest-gate.md)) makes one
canonical TypeScript evaluator available to a Python backtest runner by spawning it as
a subprocess and talking NDJSON over stdio.

- **The evaluator core is small and pure.** [`server/portfolio/evaluator.ts`](../../server/portfolio/evaluator.ts)
  is a single `evaluate(intent, state, riskLimits, pendingOrders) → RiskCheckResult`
  function — ~110 lines, no I/O, no NATS, no DB. It is the one place gate rules live;
  both the live NATS-RPC handler and the CLI import it (the "drift = none" property of
  option (b) in [backtest-gate.md §2](backtest-gate.md#2-the-cross-language-constraint)).
- **The CLI is a thin wrapper.** [`bin/gate-evaluator-cli.ts`](../../bin/gate-evaluator-cli.ts)
  (~320 lines) reads NDJSON frames on stdin, maintains a replay `PortfolioState` via
  `init`/`evaluate`/`fill`/`snapshot`/`shutdown` frames
  ([backtest-gate.md §3.2](backtest-gate.md#32-wire-protocol--newline-delimited-json-ndjson)),
  and calls `evaluate()` per `evaluate` frame.
- **The QO-side caller is also thin.** `quant_optimizer/dispatch/gate_eval.py`
  (`GateEvaluator`) `Popen`s the binary, manages the handshake, and exposes
  `init()` / `evaluate()` / `fill()` / `snapshot()` / `shutdown()`. Decisions are
  written to a phantom audit chain by `dispatch/phantom_audit.py`.

So the shim's total surface is: one pure TS function + a ~320-line TS stdio loop +
a ~340-line Python subprocess client + a parquet writer. That is the thing QF-305
asks whether to delete by porting QO to TS.

### 1.1 What "import the evaluator natively" would require

For QO to `import` `evaluate()` instead of spawning it, QO must run on a JS runtime —
i.e. QO's orchestration (the WFO loop, the Optuna search, the worker pool) must itself
be TypeScript. The evaluator does not depend on anything QO has; QO depends on a Python
runtime for everything _around_ the evaluator. The port cost is therefore almost
entirely about QO's own dependencies, not about the evaluator.

---

## 2. The QO dependency graph (what a port has to move)

From `quant-optimizer/pyproject.toml` and the package internals:

| Dependency                            | Role in QO                                                                       | TS equivalent?                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `nautilus-trader==1.226`              | The `BacktestEngine` — event-driven matching, OMS, fill simulation, venue model. | **None.** No TS port exists. NT is Rust+Python (PyO3); the Rust core is not JS-callable. |
| `optuna>=3.5`                         | Bayesian search (TPE sampler), SQLite-backed study storage, pruning, early-stop. | **None.** No `optuna-js`. TPE-over-RDB would be hand-rolled.                             |
| `joblib>=1.3`                         | Process-parallel worker pool (`loky` backend) for the IS sweep.                  | `worker_threads` / `child_process` — different model, see §3 option (b).                 |
| `pandas` / `numpy`                    | Fold geometry, bar series, metric panels.                                        | Partial (`danfo.js`/`arquero`); not a drop-in.                                           |
| `pyarrow`                             | Phantom audit parquet writer + archive I/O.                                      | `apache-arrow` (JS) exists and is usable.                                                |
| `flask`, `pyyaml`, `pydantic`, `s3fs` | Dashboard, hosts config, payload validation, MinIO read.                         | Replaceable, but non-trivial in aggregate.                                               |

The two load-bearing rows are **NautilusTrader** and **Optuna**. Everything else is
ordinary porting toil; these two are the reason a full port is XL.

### 2.1 The NautilusTrader binding is the wall

NT is not a library QF imports — it is "its own multi-process system"
([TRADING-SYSTEM-TDD §NautilusTrader Integration](../TRADING-SYSTEM-TDD.md#nautilustrader-integration)).
The same NT `Strategy` subclass runs both live and in backtest
([TRADING-SYSTEM-TDD](../TRADING-SYSTEM-TDD.md)); strategies live in the sibling
`magpie-strategies` repo as Python NT classes. A TS-native backtester would have
to either:

- re-host those Python NT strategies (impossible without NT itself), or
- require every strategy to be rewritten in a TS backtester's own API — which forks the
  live/backtest "one strategy class" contract that the whole architecture is built on.

That second consequence is the real cost: porting QO's _backtester_ away from NT does
not just rewrite QO, it breaks the single-strategy-class invariant shared with the live
path. That invariant is non-negotiable per the system TDD, so option (b) is effectively
off the table regardless of engineering budget.

### 2.2 Optuna has no JS equivalent

QO's search is genuine Bayesian optimization, not a grid. `runner.py` /
`wfo.py` use `optuna.create_study(... sampler=TPESampler ...)`, `study.ask()` /
`study.tell()`, SQLite-backed shared studies for cross-worker coordination, pruning
(`TrialPruned`), `GridSampler` for the dispatch path, and a custom early-stop patience
check (`worker._study_stalled`) that reads `study.best_value` across the shared RDB.

There is no maintained `optuna-js`. A TS port either:

- **re-implements the TPE loop** (kernel-density Parzen estimators, startup-trial
  handling, pruning, RDB-backed multi-worker ask/tell coordination) — this alone is
  L-sized and a correctness minefield (search quality is hard to test); or
- **subprocesses Optuna** — i.e. trades the gate-evaluator shim for an Optuna shim,
  which is strictly worse (Optuna is on the hot path of every trial, the gate is not).

Either way the port does not remove a cross-language boundary; it relocates it to a
worse place.

---

## 3. The three options

### Option (a) — TS wrapper driving Python NT via subprocess / Pyodide / PyO3-equivalent

A TS QO orchestrator that drives NautilusTrader by embedding or subprocessing Python.

| Axis                  | Assessment                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NT binding            | NT stays Python. **Pyodide is a non-starter** — NT's Rust extensions don't run in the Pyodide/wasm CPython. A native-Python-embed (`node-calls-python`, or a long-lived Python sidecar) keeps the real CPython NT. |
| Optuna                | Stays Python (lives with NT in the sidecar) or gets a second bridge. Either way it stays Python.                                                                                                                   |
| Gate shim eliminated? | **No — inverted.** The gate evaluator is now in-process to the TS wrapper, but NT _and_ Optuna are now behind a new TS→Python bridge. You delete a thin, cold-path shim and add a thick, hot-path one.             |
| Dev/debug surface     | **Worse.** Still dual-language, but now the language boundary sits on the per-trial hot path (every `engine.run()` and every `study.ask`/`tell` crosses it) instead of only on per-intent gate calls.              |
| Migration cost        | **L.** Rewrite the WFO/sweep orchestration in TS, build and harden a TS↔Python NT/Optuna bridge with the same process-isolation discipline `wfo.py` already documents (NT Rust-logger singleton, per-fold spawn).  |
| Risk                  | **High.** Reproduces every NT process-lifecycle hazard already solved in `worker.py`/`wfo.py` (one engine per process, logger-singleton panic, loky executor shutdown between sweeps) across a brand-new bridge.   |

**Net:** option (a) moves the cross-language seam from the cheapest possible place (a
cold per-intent gate call) onto the hottest possible place (per-trial NT + Optuna), to
save a ~320-line wrapper. Negative value.

### Option (b) — TS-native backtester (replace NautilusTrader)

Write an event-driven backtest engine in TypeScript and retire NT from the backtest
path entirely.

| Axis                  | Assessment                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NT binding            | **Removed — and that's the problem.** NT is the live engine too. A TS backtester forks the "one NT `Strategy` class, live and backtest" contract; strategies would need a second TS implementation, or live/backtest diverge.                                                                       |
| Optuna                | Must also be ported (§2.2) — TPE, pruning, RDB-shared studies, early-stop. L on its own.                                                                                                                                                                                                            |
| Gate shim eliminated? | Yes — the evaluator imports natively. But this is the smallest line item in the whole effort.                                                                                                                                                                                                       |
| Dev/debug surface     | Single-language _eventually_, but you now own a backtest matching engine — fill modelling, OMS/netting, slippage, margin, corporate actions — that NT gives for free and has battle-tested.                                                                                                         |
| Migration cost        | **XL.** A correct event-driven backtester + an Optuna-equivalent search + re-homing every strategy. Multi-quarter, and it introduces backtest-vs-live fidelity risk that NT currently eliminates by construction.                                                                                   |
| Risk                  | **Severe.** Backtest fidelity is the foundation of the whole research→deploy gate ([TRADING-SYSTEM-TDD §Model & Strategy Promotion Pipeline](../TRADING-SYSTEM-TDD.md#model--strategy-promotion-pipeline)). A home-grown engine that disagrees with live silently poisons every promotion decision. |

**Net:** option (b) deletes a 320-line shim by rewriting the two hardest dependencies in
the system and breaking the live/backtest strategy-class invariant. This is the option
QF-305 exists to reject in writing.

### Option (c) — keep NT in Python; TS QO orchestrator drives it over a wire protocol

A TS orchestrator that owns the WFO/sweep control flow and drives NT (and Optuna) over a
defined wire protocol — conceptually the same shape as today's gate shim, but with the
language boundary on the _other_ side.

| Axis                  | Assessment                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NT binding            | NT stays Python behind the wire protocol. Same isolation rules as today (`worker.py` engine-reuse, `wfo.py` per-fold spawn) must be reproduced on the Python side of the protocol.                                     |
| Optuna                | Stays Python behind the same protocol, **or** the TS orchestrator owns search and only NT is remote — but then Optuna must be re-implemented in TS (§2.2). Keeping both Python is the only sane variant.               |
| Gate shim eliminated? | **Yes**, technically: with the orchestrator in TS, `evaluate()` is a native import and the gate NDJSON shim disappears. But it is replaced by a _thicker_ NT/Optuna wire protocol that runs on the per-trial hot path. |
| Dev/debug surface     | About the same dual-language footprint as today, with the boundary moved to a hotter, higher-volume protocol. More frames per second, more serialization, more to debug.                                               |
| Migration cost        | **M–L.** Rewrite WFO/sweep orchestration in TS + design/build/harden the NT-driver wire protocol. The orchestration logic in `wfo.py`/`runner.py`/`worker.py` is ~700 lines of carefully-won NT-lifecycle knowledge.   |
| Risk                  | **Medium.** Lower than (a)/(b) because NT and Optuna stay Python, but you still pay to relocate the seam and re-earn the NT-lifecycle lessons on a new protocol, for the benefit of deleting one cold-path shim.       |

**Net:** option (c) is the "least bad" port, and it still nets negative at v1: it trades
one cold, low-volume shim (per-intent gate calls) for a hot, high-volume one (per-trial
NT + Optuna driving), plus a full rewrite of QO's orchestration. The only thing it buys
is "gate evaluator is a native import," which §6 shows is the cheapest of all the costs
the shim imposes.

---

## 4. Side-by-side cost/risk summary

| Option                                  | NT binding                              | Optuna                   | Shim eliminated?                         | Dev/debug                             | Migration           | Risk   |
| --------------------------------------- | --------------------------------------- | ------------------------ | ---------------------------------------- | ------------------------------------- | ------------------- | ------ |
| **(a)** TS wrapper drives Py NT         | Stays Py; Pyodide impossible; sidecar   | Stays Py (or 2nd bridge) | No — seam moves onto hot path            | Worse (boundary on per-trial path)    | **L**               | High   |
| **(b)** TS-native backtester            | Removed — breaks live/backtest contract | Must port (L by itself)  | Yes — but smallest line item             | Own a matching engine + fidelity risk | **XL**              | Severe |
| **(c)** TS orchestrator, wire-driven NT | Stays Py behind protocol                | Stays Py behind protocol | Yes — replaced by thicker NT/Optuna shim | ~same footprint, hotter boundary      | **M–L**             | Medium |
| **status quo** (keep shim)              | Untouched                               | Untouched                | n/a — shim is the point                  | Cold per-intent boundary only         | **S** (incremental) | Low    |

S/M/L/XL anchored to: S = days, M = ~1–2 weeks, L = ~1–2 months, XL = multi-quarter.

---

## 5. Why the shim's cost is smaller than it looks

The ticket lists three costs of the shim. Re-examined against the code:

1. **Per-intent subprocess overhead.** Real, but bounded and on a _cold_ path. The CLI
   is spawned **once per backtest run** (`GateEvaluator.init` does the `Popen`; the
   process is long-lived across all intents), not once per intent. The per-intent cost
   is one NDJSON write + one read over an already-open pipe — microseconds-scale next to
   an NT `engine.run()` that simulates a whole fold. Gate evaluation is also a fraction
   of intents (only orders, only when a strategy trades), not every bar. See §6 for the
   one place this could bite (a tight synchronous request/reply per intent) and the cheap
   fix.
2. **Cross-language version-compat surface.** Real but already engineered down:
   `init_ok` carries `evaluator_schema_version` + `commit_hash`, a mismatch is
   fail-fast `init_error` ([backtest-gate.md §7](backtest-gate.md#7-versioning-and-reproducibility)),
   and the version is stamped into `gate-rules.json` for reproducibility. This is one
   integer and one hash on one cold handshake — not a sprawling API.
3. **Dual Python+TS debugging.** Real, but a port doesn't remove it — options (a) and
   (c) keep Python (NT + Optuna) and (b) replaces it with the harder problem of owning a
   backtest engine. The dual-language surface shrinks only in (b), and only by taking on
   far more risk elsewhere.

The shim concentrates the cross-language boundary at the **best possible point**: a pure
function, cold path, tiny schema, one handshake. Any port relocates that boundary to a
hotter, larger-schema, higher-risk point.

---

## 6. Cheap incremental improvements (capture most of the value, no port)

These keep the shim and shave its actual costs. Ordered by value/effort:

1. **Batch `evaluate` frames.** Today the protocol is strictly synchronous
   request/reply per intent (`gate_eval.py` writes one `evaluate` and blocks on one
   `_read_frame`). When a fold produces many intents at the same simulated tick, send an
   `evaluate_batch` frame (array of intents) and get a `decision_batch` back. Collapses
   N pipe round-trips into one. **S.** This is the single highest-leverage change and
   directly answers the "per-intent subprocess overhead" concern.
2. **Persist the CLI across folds / across a WFO run.** The CLI already holds replay
   state and is cheap to keep alive; confirm one `GateEvaluator` instance spans all folds
   of a run (reset state via a fresh `init` or a `snapshot` per fold rather than
   re-`Popen`ing). Amortizes process spawn over the whole run. **S.**
3. **Pin the CLI binary by commit in the archive.** Already partly done (`commit_hash`
   in `gate-rules.json`). Make it a hard reproducibility contract: archive records the
   exact CLI commit and `npm run build:cli` recovers it ([backtest-gate.md §7](backtest-gate.md#7-versioning-and-reproducibility)).
   Removes the "which evaluator version produced this chain?" ambiguity without any port. **S.**
4. **Shared fixture corpus for the NDJSON protocol.** Drive both `bin/gate-evaluator-cli.test.ts`
   (TS side) and `gate_eval.py`'s tests (Py side) from one fixture set of
   frame/response pairs, so a schema change that breaks one side fails the other's CI.
   Turns the version-compat surface into a tested contract. **S–M.**
5. **Surface CLI stderr in QO run logs.** The CLI routes logs to stderr as JSON
   frames ([backtest-gate.md §3.2](backtest-gate.md#32-wire-protocol--newline-delimited-json-ndjson));
   this is what makes dual-language debugging tractable. Ensure QO captures and surfaces
   CLI stderr in its run logs so a failed gate decision is debuggable from the QO side
   without attaching to the subprocess. **S.**

Items 1 and 2 capture essentially all of the latency value a port would offer, at S
effort, with zero new cross-language risk.

---

## 7. Recommendation

**Keep the shim. Do not port QO to TypeScript at v1.** Adopt the §6 incremental
improvements (batch frames + persist the CLI across a run first).

Rationale: the shim places the only unavoidable cross-language boundary at the cheapest
point in the system — a pure ~110-line function, cold path, one-integer schema, one
handshake. Every porting option relocates that boundary onto the per-trial NT + Optuna
hot path (a, c) or rewrites NautilusTrader and Optuna outright and forks the
live/backtest strategy-class invariant (b). The thing a port deletes (a native
`evaluate()` import) is the smallest cost the shim imposes; the things a port keeps or
worsens (NT lifecycle, Optuna search, dual-language debug) are the large ones.

This confirms the forward-looking note already in
[backtest-gate.md §2](backtest-gate.md#2-the-cross-language-constraint) ("the answer is
probably not at v1") and [§9](backtest-gate.md#9-out-of-scope-deferred).

### 7.1 Conditions that would flip the recommendation

Revisit a port (most plausibly option (c)) if **several** of these become true together:

- **NautilusTrader gains a first-class TS/JS binding** (or a credible TS-native engine
  reaches NT-grade fill/OMS fidelity). This removes the §2.1 wall — the single biggest
  blocker. Without this, no option is viable.
- **Optuna gains a maintained JS port** with TPE + RDB-shared studies + pruning, or QO's
  search collapses to a grid (`GridSampler`-only), making §2.2 a non-issue.
- **The live/backtest "one strategy class" contract is dropped** for an explicit
  reason — at which point a TS backtester (b) stops forking an invariant.
- **The gate becomes hot in backtest** — e.g. multi-strategy backtests with shared
  parent-budget gating ([backtest-gate.md §9](backtest-gate.md#9-out-of-scope-deferred))
  push gate evaluation to per-bar/per-strategy volume where pipe round-trips dominate,
  _and_ §6's batching has already been exhausted.
- **Profiling shows the shim is a real bottleneck** after §6 — i.e. the subprocess
  boundary, not NT, is on the critical path of a sweep. (Current code makes this
  unlikely: gate calls are per-intent and cold; NT's `engine.run()` dominates wallclock.)

If only one of these holds, the shim still wins. The flip needs the NT and Optuna walls
to fall _and_ a fidelity/contract reason to move.

---

## 8. Out of scope

- Implementing any of §6 — those are follow-up tickets; this doc only recommends them.
- The phantom-audit diff/reporting tooling ([backtest-gate.md §6](backtest-gate.md#6-rule-iteration-workflow)).
- Any change to the live gate path ([risk-gate-architecture.md §3](risk-gate-architecture.md#3-the-nats-rpc-contract));
  this investigation is backtest-side only.
