# Risk Gate Architecture — Component TDD

Parent: [TRADING-SYSTEM-TDD.md](../TRADING-SYSTEM-TDD.md). Companions: [broker-integration.md](broker-integration.md), [portfolio-risk-engine.md](portfolio-risk-engine.md), [strategy-deployment-topology.md](strategy-deployment-topology.md).

---

## 1. Purpose

Live trading happens inside NautilusTrader: strategies submit orders through NT's `OrderManagementSystem` to NT's broker adapter, bypassing QF's `OrderPlane` and `PortfolioEngine.canExecute()`. QF holds audit + reconciliation + per-strategy halt + exit-rule authority (per [order-execution.md §5](order-execution.md#5-position-exit-controls)), but without a risk gate has **no synchronous control over strategy order submission**. NT's built-in `RiskEngine` handles per-order checks (rate, qty, notional, account balance) but is per-strategy and can't see:

- Cross-strategy aggregates (total delta / vega / notional across all strategies on one account).
- Portfolio-level halts (drawdown, daily loss — QF computes from `audit_fills`, NT doesn't).
- Operator-controlled per-strategy disable from the GUI.
- Hot-reloadable rule config (`risk_limits.yaml`).
- Concentration limits across portfolios.

This doc specifies the **risk gate** — a custom NT `RiskEngine` subclass that runs as a plugin inside every TradingNode and consults QF synchronously over NATS-RPC before any strategy order reaches the `ExecutionEngine`. The gate gives QF enforcement authority over the strategy path while preserving the commitment that strategy code is unchanged across backtest / paper-live / prod.

## 2. The NT plugin

NT exposes `RiskEngineConfig.risk_module_path` as the supported extension point for organization-specific risk policy. The bundle launcher loads QF's gate as that runtime's `RiskEngine`:

```python
from nautilus_trader.live.config import LiveTradingNodeConfig
from nautilus_trader.risk.config import RiskEngineConfig

config = LiveTradingNodeConfig(
    trader_id="QF-PROD",
    strategies=[...],
    risk=RiskEngineConfig(
        risk_module_path="magpie_risk_gate.gate:QFRiskGate",
        config={
            "nats_url": "nats://qf-server:4222",
            "gate_subject_prefix": "orders.gate",
            "gate_timeout_ms": 50,
            "fail_open_mode": "closes_only",  # or "fail_closed"
            "audit_subject": "audit.intents",
        },
    ),
    exec_engine=...,
    data_engine=...,
)
```

The package lives in-tree at `research/magpie-risk-gate/` (uv workspace member alongside the broker bridges). `QFRiskGate` subclasses NT's `RiskEngine` and overrides `_check_order`. The strategy plugins, the QF bridge plugin, and the risk-gate plugin are all loaded into the same TradingNode by the bundle launcher — three different slots in `LiveTradingNodeConfig`, same loading machinery.

Strategies don't import or know about the gate. `Strategy.submit_order()` flows through NT's MessageBus → RiskEngine → ExecutionEngine pipeline exactly as it would with NT's default `RiskEngine`. The gate is transparent: the strategy sees either an approved submission proceed to broker or a structured rejection, both shaped identically to NT's built-in risk-rejection responses.

### 2.1 Per-intent evaluation (the parent-budget model)

The gate evaluates **once per parent intent at full impact**, not per wire-level order. If a strategy submits one intent that an `ExecAlgorithm` ([exec-algorithms.md](exec-algorithms.md)) slices into ten child orders, the gate sees the parent once and pre-approves the entire qty / notional / Greek envelope. Children submitted by the algo within that envelope do not re-trigger QF semantic checks.

Rationale: a partial-fill-then-blocked failure mode (gate approves child 1, market shifts, gate rejects child 2) is worse than a clean accept-or-reject at the parent level. Strategies and operators rely on intents either fully executing within their approved envelope or fully rejecting.

`_check_order` distinguishes by NT's `parent_order_id`:

| Order shape                                                      | Gate behavior                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Parent intent** (no `parent_order_id`)                         | Full QF semantic eval via NATS-RPC (cross-strategy, portfolio halts, concentration, halted state) **+** NT's mechanical floor (rate, notional, account balance). Writes `audit_intents` row source=qf-gated. |
| **Child order** (has `parent_order_id`, parent already approved) | NT mechanical floor only. No QF RPC. No new `audit_intents` row — the child's `audit_orders` row references the parent's `intent_id`.                                                                        |

The mechanical floor still applies per-child as a safety net against algo bugs (spammed cancel-replaces, runaway slicers). Only the semantic QF authority is amortized over the parent.

The parent intent's payload must encode the **worst-case** position delta for evaluation — i.e. the total qty the algo might submit, not the size of any single child. Strategy authors specifying multi-leg / sliced intents are responsible for the parent payload reflecting the full impact.

## 3. The NATS-RPC contract

### 3.1 Subjects

| Subject                       | Direction      | Pattern       | Payload                                                                                                                                       |
| ----------------------------- | -------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders.gate.<broker>`        | NT-plugin → QF | request/reply | request: `{intent, strategy_id, portfolio_id, current_position, account_balance, asof}`; reply: `{decision, reason, intent_id, envelope_id?}` |
| `orders.gate.revoke.<broker>` | QF → NT-plugin | request/reply | request: `{envelope_id, reason, asof}`; reply: `{status: "revoked" \| "envelope_unknown"}`. See §3.5 and §6.                                  |

Indexed in the system-wide registry at [nats-subjects.md §2.2](nats-subjects.md#22-risk-gate-nt-plugin--qf-gate-evaluator). `<broker>` is `schwab` or `ibkr`. One subject per broker so QF can shard handlers if needed. Wire format is JSON for human-debuggability (same convention as `broker-integration.md §3`); dataclass mirrors live on both sides.

### 3.2 Request payload

```typescript
interface GateRequest {
  // From NT's Order object — payload is preserved unchanged through the gate.
  intent: OrderIntent; // canonical-symbol, side, qty, price, tif, ...
  strategy_id: string;
  portfolio_id: string; // resolved from strategy → portfolio mapping
  // Current state from NT's cache, sent so QF doesn't have to ask back.
  current_position: { qty: number; avg_price: number } | null;
  account_balance: number;
  asof: string; // ISO-8601 from NT's clock
}
```

### 3.3 Response payload

```typescript
interface GateResponse {
  decision: "approve" | "reject";
  reason: RejectionReason | null;
  intent_id: string; // ULID, written to audit_intents
  envelope_id: string | null; // set when decision='approve'; null on reject. v1: equals intent_id.
}

type RejectionReason =
  | "limit_exceeded_per_strategy" // max qty / max notional / max delta on this strategy
  | "limit_exceeded_aggregate" // cross-strategy aggregate
  | "limit_exceeded_portfolio" // portfolio drawdown / daily loss halt
  | "strategy_halted" // operator-halted via lifecycle registry
  | "concentration" // concentration limit per underlying
  | "config_invalid" // gate config missing required limit definitions
  | "gate_unavailable_open_blocked" // fail-open mode, opening order blocked
  | "gate_unavailable_nt_rejected"; // fail-open mode, NT's local check rejected the close
```

`strategy_halted` is a distinct reason so the gate's structured-log emission is loud — a halted strategy that keeps submitting is operator-visible, not noise in the rejection counter.

`envelope_id` is the token the NT plugin uses to fast-path subsequent child orders inside the approved envelope (per [exec-algorithms.md](exec-algorithms.md)) and the token QF passes back to revoke the envelope when conditions change (§3.5). At v1 `envelope_id === intent_id` — they're the same ULID. The field is kept separate so a future "one envelope spans multiple parent intents" model doesn't require a wire change.

### 3.4 Timeout budget

Default `gate_timeout_ms = 50`. In-cluster NATS round-trips are typically 1-5ms; 50ms is ~10× headroom. Strategies that need tighter budgets (HFT) can override via per-strategy config when/if they exist. Timeout triggers the fail-open path (§4).

The gate evaluation itself in QF is bounded — limit checks are in-memory table lookups + arithmetic against the cross-strategy intent log (§5). No DB writes on the hot path; audit_intents writes go through the same write queue that handles audit-chain rows, async from the RPC reply.

### 3.5 Envelope revocation

When conditions change after an envelope is approved — operator halts a strategy, drift fires hard, a different strategy fills concentration on a shared underlying, portfolio enters daily-loss halt — QF needs to claw back the envelope so subsequent child orders an `ExecAlgorithm` would have submitted under it get rejected at the gate plugin instead of fast-pathed.

```typescript
interface RevokeRequest {
  envelope_id: string; // the ULID returned in GateResponse.envelope_id
  reason: RevokeReason; // structured; written to audit_intents.envelope_revoke_reason
  asof: string; // ISO-8601 from QF's clock
}

interface RevokeResponse {
  status: "revoked" | "envelope_unknown";
}

type RevokeReason =
  | "portfolio_halted"
  | "strategy_halted"
  | "drift_hard_trip"
  | "concentration_breach_other_strategy"
  | "operator_initiated";
```

**Granularity is per-envelope only.** "Revoke everything for strategy X" or "revoke everything in portfolio P" are implemented in QF's revoke caller by looping over the envelopes it tracks for that strategy/portfolio. The wire stays minimal.

**Effect on the NT plugin.** The plugin drops the envelope from its in-memory registry. Future child orders that would have been fast-pathed under it are re-evaluated via `orders.gate.<broker>` like any other parent intent (and will be rejected if the originating condition still holds). The plugin does **not** auto-cancel existing working orders at the broker — that's a separate concern; see "In-flight working orders" below.

**Idempotency.** If QF restarts after sending the revoke and re-sends on restart-replay, the plugin replies `envelope_unknown` for envelopes it has already dropped (or never had — e.g., NT bundle restart cleared its registry). QF treats `envelope_unknown` as success.

**Timeout + fail-handling.** Default `revoke_timeout_ms = 100` (more slack than the evaluation hot path; the revoke caller is not on the trading hot path). On timeout or NATS failure, QF retries with exponential backoff up to 3 attempts; persistent failure raises an `envelope_revoke_failed` alert ([alerts.md](alerts.md)) and leaves the envelope marked `revoke_pending` in QF state so a subsequent successful revoke can clean up the audit trail.

**In-flight working orders.** Revoke stops _future_ child orders only. Working orders already at the broker — submitted by an `ExecAlgorithm` after the envelope was approved but before revoke — must be cancelled separately via `orders.cancel.<broker>` (per [broker-integration.md §3.1](broker-integration.md#31-orders-opl--broker-bridge)). The boundary is intentional: gate revocation is a _future-orders_ primitive; broker-side cancellation is its own concern with its own failure modes. See [order-execution.md](order-execution.md) cancel handling.

## 4. Closes-only fail-open

When QF is unreachable (NATS timeout, connection failure, gate-service down), the plugin falls through to a strict closes-only policy. This is the safest non-blocking degraded mode: de-risking actions remain available; opening risk during a control outage does not.

```python
async def _check_order(self, order, position=None):
    try:
        decision = await self._qf_gate_rpc(order, timeout_ms=self.config.gate_timeout_ms)
        return self._apply_decision(decision)
    except (asyncio.TimeoutError, NATSConnectionError) as e:
        self.log.warning("gate_unavailable", error=str(e), order_id=order.client_order_id)
        if self.config.fail_open_mode == "fail_closed":
            return self._reject(RejectionReason.GATE_UNAVAILABLE_OPEN_BLOCKED)
        # fail_open_mode == "closes_only" (default)
        if self._is_strictly_closing(order):
            # Belt-and-suspenders: still apply NT's built-in local config.
            return super()._check_order(order, position)
        return self._reject(RejectionReason.GATE_UNAVAILABLE_OPEN_BLOCKED)
```

### 4.1 The closing classifier

`_is_strictly_closing(order)` examines the current position from NT's cache and classifies:

| Current position | Order side | Order qty | Classification                            |
| ---------------- | ---------- | --------- | ----------------------------------------- |
| Long N           | SELL       | qty ≤ N   | strictly closing                          |
| Short N          | BUY        | qty ≤ N   | strictly closing                          |
| Long N           | SELL       | qty > N   | mixed (close + flip short) — **rejected** |
| Short N          | BUY        | qty > N   | mixed (close + flip long) — **rejected**  |
| Flat             | any        | any       | opening — rejected                        |
| Long N           | BUY        | any       | adding to long — rejected                 |
| Short N          | SELL       | any       | adding to short — rejected                |

Strict rule: any opening component means reject. The strategy can resubmit two separate orders if it really wants a flip during an outage (unlikely scenario, kept correct).

### 4.2 NT local-config floor

When the gate is unreachable AND the order is a close, the plugin still calls `super()._check_order(order, position)` — NT's built-in `RiskEngine` per-order checks (max_order_submit_rate, max_notional_per_order, max_quantity_per_order, account balance) are applied as a floor. So the actual fail-open behavior is "closes that also pass NT's local config." Defense in depth during the outage.

### 4.3 Observability of degraded mode

When the gate enters fail-open:

- Every fail-open decision emits a `gate.fail_open.{allowed_close,blocked_open}` structured log.
- A Prometheus counter `qf_risk_gate_fail_open_total{strategy_id, decision}` increments.
- The alerts router fires a `gate_unavailable` alert at the first failure (rate-limited to one-per-5-min, channel: slack + GUI banner).
- An attribute on the per-strategy state in `server/strategy/lifecycle.ts` flips to `gate_degraded=true` until the next successful RPC, surfaced as a yellow indicator in the GUI Strategies screen.

The operator should treat sustained fail-open as a paging-grade event — the system is trading without cross-strategy risk authority.

## 5. Cross-strategy intent state

For aggregate checks ("total delta across all strategies on IBKR account X ≤ Y") the gate evaluator on the QF side needs a real-time view including **in-flight intents not yet fully filled**, not just settled positions.

The intent log tracks **parent intents**, not children. Once the gate approves a parent at its full-impact envelope, the parent counts against aggregate budgets at that full size until its children have filled or cancelled enough to reduce it. The algo's slicing happens within the budget already committed; the log doesn't need to see each child.

### 5.1 The intent log

QF maintains an in-memory `pending_intents` table keyed by `intent_id` (parent intents only):

```typescript
interface PendingIntent {
  intent_id: string;
  strategy_id: string;
  portfolio_id: string;
  broker: "schwab" | "ibkr";
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  estimated_notional: number;
  estimated_delta: number; // for options, computed from spot at gate time
  asof: string;
  status: "pending" | "filled" | "cancelled" | "rejected" | "envelope_revoked";
  envelope_id: string; // v1: equals intent_id; reserved for one-envelope-spans-multiple-intents
}
```

Entries are added on `approve` (the gate's reply commits the intent into the log before NT submits to broker). They're updated as fill events arrive from the audit observer:

- Partial fill → reduce remaining qty.
- Full fill → mark `status=filled`; the row stays for a short retention window (default 5 minutes) so late-arriving aggregate queries see consistent state, then drops.
- Cancellation → `status=cancelled`, dropped after the retention window.
- Reject by broker → `status=rejected`, audit row, dropped.
- Envelope revoked by QF (§3.5) → `status=envelope_revoked`, dropped after the retention window. Aggregate budgets reclaim the envelope's reserved capacity at this point.

Aggregates are computed by summing over `pending_intents WHERE status IN ('pending')` + the current settled position from the portfolio engine's view. The settled side and the in-flight side reconcile via audit-observer events.

### 5.3 Envelope lifecycle

An envelope is created when the gate approves a parent intent (§3.3). It ends in exactly one of four ways:

| Termination         | Trigger                                        | `pending_intents.status` |
| ------------------- | ---------------------------------------------- | ------------------------ |
| Filled              | Audit observer reports the parent fully filled | `filled`                 |
| Cancelled at broker | Audit observer reports the parent cancelled    | `cancelled`              |
| Rejected at broker  | Audit observer reports the parent rejected     | `rejected`               |
| Revoked by QF       | QF sends `orders.gate.revoke.<broker>` (§3.5)  | `envelope_revoked`       |

No timer-based auto-expiry. An envelope that the broker has neither filled nor cancelled stays live until QF revokes it (because something changed) or the broker eventually does. This is intentional — automatic expiry would either fire too aggressively (clipping legitimate slow algos) or too leniently (leaving stale envelopes live for hours), and the conditions that _should_ end an envelope are exactly the conditions that trigger an explicit QF revoke.

QF restart preserves envelope state (rehydrated from `audit_intents` per §5.2). NT-bundle restart does not — the plugin's in-memory envelope registry is dropped. On NT restart, QF's view temporarily disagrees with the plugin's, but the divergence self-heals: every child order that would have been fast-pathed under an envelope the plugin no longer knows about gets re-evaluated via `orders.gate.<broker>` as a new parent. If QF still considers the envelope live, the re-evaluation will likely approve and a new envelope_id is issued (the old one remains in `pending_intents` until its terminating event arrives).

### 5.2 What happens on QF restart

The intent log is rebuilt from `audit_intents` (gate decisions) and `audit_orders` + `audit_fills` (observer rows) on startup, before the gate accepts any RPCs. Rehydration parallels the existing order-plane rehydration. Until rehydration completes, the gate fails closed — strategies see `gate_unavailable_open_blocked` rejections, operator sees a "gate warming up" banner.

This is a deliberate inversion of fail-open. A cold-start gate has zero state; allowing closes against an unknown position book is dangerous. Fail-closed during warm-up forces the system to come up consistent.

## 6. Audit chain integration

The gate writes to `audit_intents` at decision time using these columns:

| Column                   | Values                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `source`                 | `qf-gated` (gate-evaluated strategy intent) — alongside the `qf` and `nt-native` values |
| `gate_decision`          | `approve` \| `reject`                                                                   |
| `gate_reason`            | `RejectionReason` or `null` on approval                                                 |
| `envelope_revoked_at`    | TIMESTAMP, set when QF revokes the envelope (§3.5); NULL otherwise                      |
| `envelope_revoke_reason` | `RevokeReason` string (§3.5); NULL when `envelope_revoked_at` is NULL                   |

`source='qf-gated'` distinguishes gate-evaluated strategy intents from operator-originated `source='qf'` rows. The two revoke columns mutate the same row in place when revocation happens — revocation is a parent-intent state change, not a separate event, so it doesn't get its own table. One gate-approved parent maps to one `audit_intents` row; every child order an algo submits under that parent references the parent's `intent_id` in its `audit_orders` row (alongside NT's own `parent_order_id` for wire-level fan-out):

```
audit_intents (intent_id=I1, source='qf-gated', gate_decision='approve',
               exec_algorithm_id='QFSlicer', total_qty=100, total_notional=$45k)
  ├─▶ audit_orders (broker_order_id=NT1, parent_order_id=null, intent_id=I1)
  ├─▶ audit_orders (broker_order_id=NT2, parent_order_id=NT1, intent_id=I1)
  │    └─▶ audit_fills (broker_order_id=NT2, ...)
  ├─▶ audit_orders (broker_order_id=NT3, parent_order_id=NT1, intent_id=I1)
  │    └─▶ audit_fills (broker_order_id=NT3, ...)
  └─▶ ...
```

Rejected intents stop at `audit_intents` (one row, no downstream). The Trade Inspector endpoint (`GET /api/trades/inspect`) gets a new mode: `?intent_id=...` returns the gate decision plus the full child-order fan-out via the `intent_id` foreign key (no `parent_order_id` walk required).

## 7. Implementation status

The core gate architecture is **implemented** across phases 1–3, with phase 4 (bundle launcher) live in production:

1. **Phase 1 — Gate plugin skeleton.** `research/magpie-risk-gate/` package; subclass of NT's RiskEngine; NATS-RPC client; closes-only fail-open + classifier; unit tests against a fake QF service. **Shipped.**
2. **Phase 2 — QF-side gate service.** `server/risk/gate-handler.ts` (NATS request/reply subscriber on `orders.gate.<broker>`) and `server/portfolio/evaluator.ts` (pure evaluation logic); both wired in `server/index.ts` (`createGateHandler(...)`) and fed by `evaluator.evaluate(gateRequest)`. **Shipped.**
3. **Phase 3 — Audit-chain extension.** `source='qf-gated'`, `gate_decision`, `gate_reason` columns; Trade Inspector intent-lookup mode. **Shipped.**
4. **Phase 4 — Bundle launcher wiring.** Prod bundle launcher loads gate alongside strategies and bridge; paper-live smoke test confirms gate works against an IBKR paper account. **Live in production.**
5. **Phase 5 — Observability + degraded-mode UX.** GUI Strategies-screen gate-degraded indicator; `gate_unavailable` alert; per-strategy gate-rejection counters. **Landed with QF-350/351.**

The NATS subjects (`orders.gate.<broker>`, `orders.gate.revoke.<broker>`) are active. Genuine future work (envelope revocation refinements §3.5, advanced parent-budget child fast-path optimizations) remain possible enhancements; the core two-tier evaluation + envelope lifecycle are shipped.

## 8. Backtest evaluation

The same evaluator runs over historical intents inside quant-optimizer's `BacktestEngine` for offline rule iteration. The architecture is described in [backtest-gate.md](backtest-gate.md) — a TS CLI subprocess spawned from QO, NDJSON over stdin/stdout, writing a phantom audit chain with `source='backtest-gated'` into the existing Minio backtest archive. The live path described in this doc is unchanged.

## 9. Out of scope

- **Manual approval / human-in-the-loop.** Out of scope by design. Paper-credentialed IBKR runs are the validation environment (see [strategy-deployment-topology.md §2](strategy-deployment-topology.md#2-the-two-live-deployment-modes)).
- **NT internals modification.** The gate uses NT's supported `RiskEngineConfig.risk_module_path` extension point. No NT source-code changes.

Other open architectural questions (HFT latency mode, OpenTelemetry across the RPC) are consolidated in [docs/OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md).

## 10. Observability

The detailed framework lives in [observability.md](observability.md); the degraded-mode logging is specced separately in §4.3. This section names the full event catalog the QF-side gate evaluator emits. All events follow the common JSON schema: `ts`, `level`, `service` (= `"gate-evaluator"`), `correlation_id`, `event`, plus the payload below.

The `correlation_id` arrives on the inbound `orders.gate.<broker>` RPC as the `X-Correlation-Id` NATS header (set by the NT-side gate plugin from the strategy-supplied ID); the evaluator binds it via `withCorrelationId` before evaluating, propagates it through its `audit_intents` write, and echoes it on the reply. A subscriber that receives a gate RPC **without** the header generates one and logs `system.correlation_id.missing` per [observability.md §4.2](observability.md#42-across-process-propagation).

| Event                          | Level   | Payload (key fields)                                                                                    | Emitted when                                                                                                                                      |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate.evaluated`               | `info`  | `intent_id`, `strategy_id`, `portfolio_id`, `broker`, `decision` (`approve` \| `reject`), `reason`      | Every parent-intent evaluation (§2.1). Reject events carry the `RejectionReason`; approve events the issued `envelope_id`.                        |
| `gate.request_malformed`       | `warn`  | `subject`, `reason`                                                                                     | Inbound RPC payload failed schema validation (`server/risk/gate-handler.ts`). Returns reject to NT.                                               |
| `gate.evaluator_error`         | `error` | `intent_id`, `subject`                                                                                  | The evaluator threw mid-decision. Carries the `error` field with stack; the RPC returns reject (fail-safe, not fail-open).                        |
| `gate.audit_write_failed`      | `error` | `intent_id`                                                                                             | The pre-decision `audit_intents` write failed (§6); audit-before-decision (§6.3) means the intent cannot proceed. Carries `error`.                |
| `gate.envelope.committed`      | `debug` | `intent_id`, `envelope_id`, `estimated_delta`, `estimated_notional`                                     | Parent approved; the `pending_intents` row is committed against aggregate budgets (§5.1) before NT submits.                                       |
| `gate.envelope.terminated`     | `info`  | `intent_id`, `envelope_id`, `termination` (`filled` \| `cancelled` \| `rejected` \| `envelope_revoked`) | An envelope reached a terminal state (§5.3); reserved aggregate capacity is reclaimed.                                                            |
| `gate.envelope.revoked`        | `warn`  | `intent_id`, `envelope_id`, `revoke_reason`                                                             | QF sent `orders.gate.revoke.<broker>` (§3.5); mutates `audit_intents.envelope_revoked_at` in place.                                               |
| `gate.fail_open.allowed_close` | `warn`  | `strategy_id`, `intent_id`                                                                              | QF unreachable; a **closing** intent was allowed under closes-only fail-open (§4). Companion Prometheus counter per §4.3.                         |
| `gate.fail_open.blocked_open`  | `warn`  | `strategy_id`, `intent_id`                                                                              | QF unreachable; an **opening** intent was blocked under closes-only fail-open (§4).                                                               |
| `gate.warming_up_blocked`      | `warn`  | `strategy_id`, `intent_id`                                                                              | Cold-start fail-closed (§5.2); rehydration from `audit_intents` not yet complete, so the intent is rejected with `gate_unavailable_open_blocked`. |

**Sampling.** Gate evaluations fire at strategy-submission frequency (not tick frequency), so every `gate.evaluated` emits at `info` without sampling. The high-frequency path is the algo's child-order fan-out, which is **not** re-evaluated by the gate (it runs under the already-committed envelope per §2.1) — so the gate's log volume tracks parent intents, not orders.

**Phasing.** This catalog lands with Phase 5 of §7 (Observability + degraded-mode UX); Phases 1–4 emit the subset already present in `server/risk/gate-handler.ts` (`gate.request_malformed`, `gate.evaluator_error`, `gate.audit_write_failed`).
