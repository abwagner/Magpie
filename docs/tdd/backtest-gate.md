# Backtest Gate Mode

How the QF gate evaluator runs inside quant-optimizer's `BacktestEngine` over historical data so operators can A/B gate-rule changes before deploying.

This is a **design** doc — no code in the repo yet implements this. It exists so the implementation tickets that follow have a single architectural ground truth.

---

## 1. The problem

Today, a gate-rule change (new concentration limit, tighter notional cap, different halt criteria) ships to live without any way to ask "what would this rule have done against the last 3 months of strategy intents?". The gate evaluator runs in QF only at submission time; it has no offline replay surface.

We want: operators can change `config/risk-limits.json` (or the equivalent), re-run a historical backtest, and read a phantom audit chain that says — for every historical intent — what the new rules would have decided. Diff phantom-vs-original (or phantom-A vs phantom-B) to see what changed.

## 2. The cross-language constraint

The gate evaluator lives in TypeScript ([`server/portfolio/engine.ts`](../../server/portfolio/engine.ts)).

QO is Python (NautilusTrader's `BacktestEngine` is a Python construct, Optuna search is Python, QO's worker pool is `multiprocessing`). It cannot `import` a TS module.

The naive "shared package consumed by both repos" pattern doesn't apply. Realistic ways to make one canonical evaluator available to a Python backtest runner:

| Option                                                   | One implementation?      | Live deps needed? | Drift risk |
| -------------------------------------------------------- | ------------------------ | ----------------- | ---------- |
| (a) Dry-gate NATS subject; QF runs during backtest       | Yes                      | QF + NATS         | None       |
| (b) Subprocess-spawned TS evaluator CLI                  | Yes                      | None              | None       |
| (c) Port evaluator to Python; QF server shells out to it | Yes (canonical = Python) | Python from QF    | None       |
| (d) Dual evaluators (TS + Python) with shared fixtures   | No                       | None              | Bounded    |

We pick **(b) subprocess-spawned TS CLI**. (a) requires QF + NATS up during every backtest, which breaks the "QO writes archives one-way → QF" pattern in place today (the `QO_ARCHIVE_URL` / `WfoSpec.archive_to_url` plumbing has QO pushing into Minio at run completion, with no live QF dependency during the backtest). (c) inverts the canonical language for the live path on the strength of the backtest use case alone. (d) accepts drift.

The cost of (b) is subprocess overhead per intent. A follow-up investigation ticket (QF-305) asks whether porting QO Python → TS to remove the shim is justified; the answer is "probably not at v1".

---

## 3. The CLI binary

### 3.1 Location and packaging

```
Magpie/
  bin/
    gate-evaluator-cli.ts       ← entrypoint
  server/portfolio/
    evaluator.ts                ← pure evaluation function, shared by live + CLI
    engine.ts                   ← live wrapper (NATS-RPC + canExecute + state mgmt)
```

The pure evaluation function (no I/O, no NATS, no DB) is extracted from `engine.ts` to `evaluator.ts`. Both the live gate-RPC handler and the CLI binary import `evaluator.ts`. **There is one evaluation function and it ships in two wrappers.** This is the "drift = none" property of option (b).

The CLI is built with the existing `tsc` + `node` toolchain. Published shape for QO to consume:

```
$ which gate-evaluator-cli
/usr/local/bin/gate-evaluator-cli    # via npm/global or a release tarball
```

Or, for local-dev (QO runs from a clone next to QF):

```
$ gate-evaluator-cli --version
gate-evaluator-cli 1.4.2 (commit a6da596, evaluator schema v3)
```

The `evaluator schema v3` line is the contract version (see §6).

### 3.2 Wire protocol — newline-delimited JSON (NDJSON)

stdin: one JSON object per line, request from QO.
stdout: one JSON object per line, reply from CLI.
stderr: structured log frames (one JSON per line, same logger contract as the rest of QF — see [observability.md](observability.md)).

Frame types:

| Frame      | Direction | Purpose                                                                                                                                    |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`     | QO → CLI  | First frame. Sends rule config, portfolio config, replay window start/end. CLI replies `init_ok` or `init_error`.                          |
| `init_ok`  | CLI → QO  | CLI is ready. Carries the evaluator schema version + commit hash for the run-record.                                                       |
| `evaluate` | QO → CLI  | Per-intent. Carries an `OrderIntent` (live-shape, see [order-execution.md §1](order-execution.md#1-orderintent-schema)).                   |
| `decision` | CLI → QO  | Per-intent reply. Mirrors the live gate response: `{decision: "approve"\|"reject", reason, envelope_id?}`.                                 |
| `fill`     | QO → CLI  | When a backtest fill lands. CLI applies it to internal replay state. No reply.                                                             |
| `snapshot` | QO → CLI  | Optional. Lets QO push an explicit state snapshot if it can't (or doesn't want to) drive state via `fill` frames. Replaces internal state. |
| `shutdown` | QO → CLI  | Last frame. CLI flushes, exits 0.                                                                                                          |

`evaluate` and `decision` are correlated by an `intent_id` field carried in both. NDJSON frames cross stdin/stdout in roughly the order QO emits — out-of-order replies are not expected since the CLI is single-threaded over its input stream.

---

## 4. Replay state model

The CLI maintains internal portfolio state that mirrors what `server/portfolio/engine.ts` builds in live. The mechanism:

### 4.1 Fill-driven mutation (default)

QO emits `fill` frames as each backtest fill lands during the replay loop. The CLI processes them in the same path the live engine uses to update portfolio state (single per-instrument positions projector — see [portfolio-risk-engine.md §1](portfolio-risk-engine.md#1-portfolio-state)). When the next `evaluate` frame arrives, the gate sees up-to-date positions, balances, and concentration metrics — exactly as it would live.

This is the chosen default. It's the most faithful — same code path as live for state mutation, same correctness properties, same edge cases (partial fills, multi-leg positions, etc.).

### 4.2 Snapshot-passing (fallback)

If QO already maintains its own portfolio state and finds it inconvenient to re-emit fills, it can push a `snapshot` frame before each `evaluate`. The CLI swaps its internal state for the snapshot and evaluates against it.

This bypasses the live state-mutation code path, so it's lower fidelity (any bug in the snapshot's construction silently propagates into wrong gate decisions). Use it only when fill-driven mutation isn't workable.

Mixing `snapshot` and `fill` in the same run is permitted — later snapshots override prior state; subsequent fills mutate from there.

---

## 5. Phantom audit chain output

### 5.1 Schema parity with live

QO records each `decision` frame as a row in a phantom `audit_intents` table with the **identical schema** as the live table (see [cross-cutting.md §5](cross-cutting.md#5-audit-chain-ddl)). One field differs:

| Column   | Live value                        | Backtest value   |
| -------- | --------------------------------- | ---------------- |
| `source` | `qf` \| `qf-gated` \| `nt-native` | `backtest-gated` |

`source='backtest-gated'` is a new discriminator value — added to the enum in cross-cutting §5 once this lands. Every other column is filled identically to a live row.

Schema parity is the load-bearing property here: any tool that reads `audit_intents` (compliance queries, drift diagnostics, dashboards) can read phantom rows with no special-case logic.

### 5.2 Storage location

Phantom audit rows are written to the **same backtest archive** that QO already produces — Minio at the URL bound to `QO_ARCHIVE_URL` / `WfoSpec.archive_to_url`. The archive layout grows one table:

```
<archive_root>/
  <run_id>/
    fills.parquet                      ← existing
    metrics.parquet                    ← existing
    audit_intents.parquet              ← new — phantom audit chain
    gate-rules.json                    ← new — exact rule config used (§6)
```

The Minio archive is the canonical artifact. Phantom rows do **not** land in the live QF DuckDB — keeping the live audit chain clean of synthetic data is non-negotiable.

### 5.3 No phantom `audit_orders` / `audit_fills` (v1)

Live writes three audit tables. Backtest writes one — `audit_intents` only. The reason: `audit_orders` and `audit_fills` describe what the broker did, which in a backtest is the simulated fill produced by QO's existing engine. That's already captured in `fills.parquet`; replicating it under the `audit_*` shape would just duplicate. If a future tool needs uniform shape across all three tables, add the projection layer then.

---

## 6. Rule iteration workflow

Operator wants to test a tightened concentration cap.

1. Copy `config/risk-limits.json` to `config/risk-limits.proposed.json`; edit the cap.
2. Run two backtests, identical except for the rules file:
   ```
   QO_GATE_RULES=config/risk-limits.json         qo run wfo-spec.json   # baseline
   QO_GATE_RULES=config/risk-limits.proposed.json qo run wfo-spec.json   # proposal
   ```
3. Each run lands its own Minio archive including `audit_intents.parquet` and `gate-rules.json`.
4. Diff: a small reporting script joins the two phantom audit chains on `intent_id` and reports decision deltas (approve→reject, reject→approve, reason changes).
5. Promote `risk-limits.proposed.json` to `risk-limits.json` if the delta is acceptable.

The diff tooling is out of scope for this doc — covered separately when implementation tickets file.

---

## 7. Versioning and reproducibility

Each backtest run records both:

- The **evaluator schema version** (from `init_ok` — bumped whenever the evaluator's input/output JSON shape changes)
- The **CLI commit hash** (from `init_ok` — bumped on every CLI build)

Both land in `gate-rules.json` next to the rules themselves. To reproduce a phantom audit chain six months from now, an operator needs: the archive, the rules file, and a CLI binary at the same commit. The CLI is small and self-contained — checking out the QF commit and `npm run build:cli` is the recovery path.

Mismatched evaluator schema between QO's emitted frames and the CLI version causes `init_error` — fail-fast, no silent corruption.

---

## 8. Live-side touch points

The pure-evaluator extraction (`server/portfolio/evaluator.ts`) refactors `engine.ts` but does not change live behavior. The two live consumers of the evaluator continue to work unchanged:

- **NATS-RPC gate handler** (per [risk-gate-architecture.md §3](risk-gate-architecture.md#3-the-nats-rpc-contract)) — receives `orders.gate.<broker>` requests, calls the evaluator, replies. Adds an evaluator-schema check at startup so a live evaluator running against stale data shapes fails loudly.
- **`canExecute()` for OPL** ([portfolio-risk-engine.md §2 `canExecute` interface](portfolio-risk-engine.md#canexecute-interface)) — same evaluator, same code path, different transport.

---

## 9. Out of scope (deferred)

- **Cross-strategy parent-budget evaluation in backtest.** Live gate evaluates against portfolio-wide state including other strategies' open positions. Backtest at v1 runs one strategy at a time. Multi-strategy backtest with shared gate is a future enhancement when QO grows multi-strategy support.
- **NT bundle's own internal `RiskEngine` slot.** NT's `BacktestEngine` has its own RiskEngine plugin point — this doc is about QF's gate, which is a different layer. The NT bundle's RiskEngine is the mechanical floor; QF's gate is the semantic ceiling. Backtest can wire either, both, or neither; live wires the QF gate as an NT-side plugin per [risk-gate-architecture.md §2](risk-gate-architecture.md#2-the-nt-plugin).
- **Investigation: porting QO Python → TS to eliminate the CLI shim.** Tracked in QF-305. If that lands and we go TS-native, this doc's §3 collapses to a direct import.
- **Envelope revocation.** The live gate supports envelope revocation over `orders.gate.revoke.<broker>` (per [risk-gate-architecture.md §3.5](risk-gate-architecture.md#35-envelope-revocation)) — QF claws back an approved envelope when conditions change post-approval (halt, drift trip, concentration breach by another strategy). The backtest CLI does **not** implement the revoke side at v1. Reasoning: backtest evaluation is one-shot per intent against a snapshot of replay state; there's no async "world changed after approval" event stream for QF to react to. If the backtest were to fire revocations from inside the replay loop they'd be deterministic and indistinguishable from the initial gate decision, so the simpler model is to just have the initial decision reflect whatever state was in effect at intent time. Revisit when a use case forces the issue (e.g., multi-strategy backtests where Strategy B's fills retroactively invalidate Strategy A's envelopes within the same simulated tick).

---

## 10. Implementation phasing

Future implementation tickets (not in scope of this doc):

1. Extract `server/portfolio/evaluator.ts` as the pure function; refactor `engine.ts` to consume it. No behavior change live.
2. Add `bin/gate-evaluator-cli.ts` + the NDJSON protocol + tests against fixture frames.
3. Add `backtest-gated` to the `source` enum in cross-cutting §5; migrate live DuckDB if needed.
4. QO-side subprocess wrapper + per-intent dispatch + phantom audit writer + archive layout extension. Lives in `quant-optimizer/quant_optimizer/dispatch/`.
5. Diff reporting tool — script (Python in QO is fine) that joins two phantom chains.
