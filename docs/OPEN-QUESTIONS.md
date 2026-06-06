# Open Architectural Questions

Consolidated unresolved architectural questions across the live design. Each entry carries the source doc it came from, what's at stake, and (where applicable) the trigger condition that would force a decision. The inline open-questions sections in component TDDs point here so each question lives in one place.

---

## Broker integration

_Source: [tdd/broker-integration.md](tdd/broker-integration.md)._

- **Bundle supervision.** Per-broker NT bundles run on the credential host; the operator playbook for restarting a bundle after a crash is `systemd --user` mirroring the NT unit. Revisit during operational hardening if crash rates warrant a dedicated supervisor process. Trigger: first sustained crash-loop incident, or scaling beyond 2 brokers.
- **NATS JetStream vs core NATS** for `orders.exec_reports.*` and `marketdata.*` streams. Core NATS is fine if bundles buffer locally during TS-server restarts; JetStream gives durability at operational cost. Default core NATS unless an incident surfaces a gap. Trigger: an incident where the TS server is down long enough that bundle-side buffering loses events.

## Deployment topology — live strategy bundles

_Source: [tdd/strategy-deployment-topology.md](tdd/strategy-deployment-topology.md)._

- **Compat-group split heuristic.** When does a dep conflict between two strategies justify a second prod bundle (and therefore a second NT TradingNode + broker connection) vs. holding the line on a shared lockfile? No rule yet; the first real conflict will set the precedent. Trigger: a strategy PR's CI fails the bundle `uv sync` step and the conflict isn't resolvable by version-floor changes.
- **Per-strategy resource limits — watchdog action.** If the strategy-watchdog detects a strategy exceeding its CPU / memory / handler-latency budget in the shared prod TradingNode, what's the action — disable in-place (`stop_strategy`), alert only, or auto-halt the portfolio? Should match the `risk_limits.yaml` halt model. Trigger: first observed watchdog breach in prod or paper-live.
- **Multi-account isolation within a broker.** If two strategies trade IBKR but against different sub-accounts, do they share one TradingNode (one IB-Gateway client_id, sub-account selected per-strategy via NT's `AccountId` routing) or each gets its own? Today the assumption is shared. The bundle's NT execution client's `getPositions()` also needs to filter by account in that case — today it returns the gateway-logged-in account's full position set, correct for single-account only. Trigger: operator adds a second IBKR sub-account to `config/brokers.json`.

## Risk gate

_Source: [tdd/risk-gate-architecture.md](tdd/risk-gate-architecture.md)._

- **HFT latency mode.** The current design assumes bar-driven strategies; the 50ms NATS-RPC budget is comfortable. A future tick-driven strategy needing sub-ms gating would push hot-path semantic checks into the in-process NT plugin (with QF pushing rule config periodically rather than evaluating per-order) — a "hybrid gate" mode. Not designed for here. Trigger: a strategy proposes sub-second decision loops and measures the gate as the bottleneck.
- **OpenTelemetry / Tempo across the gate RPC.** Correlation IDs cover the chain today; full OTel spans are deferred to the Phase-4 OTel revisit per [observability.md §8.1](tdd/observability.md). Trigger: Phase-4 begins, or a multi-hop debug needs span context the IDs don't carry.

## ExecAlgorithms

_Source: [tdd/exec-algorithms.md](tdd/exec-algorithms.md). Catalog itself is deferred until a second strategy needs shared pricing logic — these are design questions that need answers when the first algo ships._

- **Hot-swap semantics.** Replacing a running algo while it has working orders: drain (let the old algo finish its open positions), or hard-swap (cancel everything, fresh algo takes new intents)? Operational concern. Trigger: first algo deployed; first algo version bump.
- **Algo composition / chaining.** Can one algo invoke another (e.g. `QFSlicer` wrapping each child in `QFSmartPeg`)? NT supports `exec_algorithm_id` on child orders; the gate's "no per-child eval" decision keeps chained algos within the parent's approved budget. Untested in practice. Trigger: first algo authored that would benefit from delegating to another algo.
- **Per-broker algo restrictions.** Some brokers reject certain order modifications (cancel-replace rate, partial-cancel semantics) faster than others; an algo safe on Schwab might breach IBKR rate limits. Probably handled by per-broker config on the algo, not by separate algos. Trigger: first algo authored that does cancel-replace at any meaningful frequency.

## Strategy drift monitoring

_Source: [tdd/portfolio-risk-engine.md §3 — Strategy drift monitoring](tdd/portfolio-risk-engine.md)._

- **Multi-metric correlation.** Soft alerts on 4 metrics simultaneously is qualitatively worse than 1 metric at z > 3 — should there be a composite drift score? Defer until we have live data showing what false positives look like. Trigger: first quarter of live drift data accumulated.
- **Cold-start window.** Newly-deployed strategies have neither a long live history nor a representative recent QO run that matches their current parameter set. Banner-only for the first 20 days is the v1 stance; revisit when a strategy is paper-trade-promoted. Trigger: first strategy promoted from paper to live.
- **NT-native fills vs QF-mediated fills in the drift baseline.** The audit chain distinguishes via the `source` discriminator. Drift monitoring sums both — a strategy is the same strategy regardless of which path its fills entered through. Trigger: any anomaly where a single strategy's fills split heavily across sources (e.g. heavy manual-liquidation activity skewing the live metrics vs. backtest baseline).

## Cross-cutting infrastructure

_Source: top-level TDD cross-cutting standards table; current code state._

- **Central log destination.** Today every runtime emits structured JSON to stdout with a common schema and propagated `correlation_id`; aggregation is deferred. The OpenTelemetry / Tempo migration is the planned Phase-4 destination per [observability.md §8.1](tdd/observability.md). Trigger: Phase-4 begins, or operational debugging across multiple processes exceeds what stdout-tailing can answer.
