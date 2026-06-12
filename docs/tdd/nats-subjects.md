# NATS Subjects Registry

Single canonical index of every NATS subject in Magpie. To find out
"what subjects exist", look here. Subjects live in two languages and three
runtimes — without one index you'd have to grep four directories.

This doc names subjects and binds them to owners. **Payload schemas,
gate semantics, JetStream stream configs, and header conventions live in
the owning docs**, not here:

- Order + market-data payload schemas → [broker-integration.md §4](broker-integration.md#4-wire-format)
- Risk-gate request/response semantics → [risk-gate-architecture.md](risk-gate-architecture.md)
- NATS bind, auth, and operational contract → [cross-cutting.md §1.8](cross-cutting.md#18-nats-bind--auth)
- `X-Correlation-Id` propagation contract → [observability.md](observability.md), [broker-integration.md §4.3](broker-integration.md#43-correlation)

---

## 1. Grammar variables

The subject tables below use `<placeholder>` for slots whose value is bound
at publish/subscribe time. Each placeholder has a fixed value space.

| Placeholder     | Value space                                                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<broker>`      | `schwab` \| `ibkr`                                                                                                                                       | Bundle suffix. Bound to the enabled brokers in `config/brokers.json`. New broker = new bundle = same subjects with a new suffix.                                                                                                                                                                                                                                   |
| `<symbol>`      | Canonical QF symbol token (NATS-safe). `EQ.SPY`, `OPT.SPY.2026-06-20.C.500`, `FUT.CLN6`. The on-the-wire form uses `.` separators, not `:` like logs do. | Per the canonical symbol grammar; QF symbols are tokenized to NATS form by `parseSymbol` + `toSubjectTokens` (`server/symbols/symbol.ts`).                                                                                                                                                                                                                         |
| `<strategy_id>` | kebab-case slug matching `^[a-z0-9][a-z0-9-]{0,63}$`, e.g. `cl-scalp`                                                                                    | Strategy lifecycle identifier — the `id` key in `data/strategies.json` (`server/strategy/lifecycle.ts`). NATS-safe by construction (the `ID_RE` guard rejects `.` and `*`).                                                                                                                                                                                        |
| `<action>`      | `start` \| `halt`                                                                                                                                        | The `LifecycleAction` token verbatim (`server/strategy/lifecycle.ts`). The full registry has nine actions, but only `start` (→ `running`) and `halt` (→ `halted`) change what runs in a live TradingNode, so only these two are published to bundles. See [strategy-deployment-topology.md §4.3](strategy-deployment-topology.md#43-lifecycle-event-subscription). |

---

## 2. Subject families

Four families. Per the system topology, every cross-runtime call flows over
NATS — see TRADING-SYSTEM-TDD.md and [broker-integration.md §1](broker-integration.md#1-runtime-topology).

### 2.1 Orders (OPL ↔ broker bridge)

Operator manual entry and framework-fired exits in OPL submit through these
subjects. Strategy submissions do **not** use these — they go through the
NT-side risk gate (§2.2), which is a different subject family.

| Subject                        | Direction   | Pattern   | Producer                                   | Consumer                                  | Payload                                                                                                                                                |
| ------------------------------ | ----------- | --------- | ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orders.submit.<broker>`       | TS → Python | req/reply | OPL (`server/order/adapters/nt-bridge.ts`) | Per-broker NT bundle (`broker_bridge.py`) | [broker-integration.md §4.1](broker-integration.md#41-order-types) (`OrderIntent`)                                                                     |
| `orders.cancel.<broker>`       | TS → Python | req/reply | OPL                                        | Per-broker NT bundle                      | [broker-integration.md §4.1](broker-integration.md#41-order-types)                                                                                     |
| `orders.status.<broker>`       | TS → Python | req/reply | OPL restart recovery                       | Per-broker NT bundle                      | [broker-integration.md §4.1](broker-integration.md#41-order-types) (`BrokerOrderStatus`)                                                               |
| `orders.positions.<broker>`    | TS → Python | req/reply | OPL restart recovery + `/api/positions`    | Per-broker NT bundle                      | [broker-integration.md §4.1](broker-integration.md#41-order-types) (`BrokerPosition[]`; each carries the raw Schwab row for QF-272's positions parser) |
| `orders.accounts.<broker>`     | TS → Python | req/reply | `/api/accounts` (QF-272)                   | Per-broker NT bundle                      | `AccountInfo[]` (account number / hash / type)                                                                                                         |
| `orders.exec_reports.<broker>` | Python → TS | pub/sub   | Per-broker NT bundle                       | OPL audit observer                        | [broker-integration.md §4.1](broker-integration.md#41-order-types) (`BrokerExecReport`)                                                                |

Schwab and IBKR bundles are symmetric — every broker bundle owns every
subject in this family. See [broker-integration.md §3.1](broker-integration.md#31-orders-opl--broker-bridge).

### 2.2 Risk gate (NT plugin ↔ QF gate evaluator)

| Subject                       | Direction   | Pattern   | Producer                                        | Consumer                       | Status                    | Payload                                                                            |
| ----------------------------- | ----------- | --------- | ----------------------------------------------- | ------------------------------ | ------------------------- | ---------------------------------------------------------------------------------- |
| `orders.gate.<broker>`        | Python → TS | req/reply | NT-side `RiskEngine` plugin (per-broker bundle) | QF gate evaluator (P&R engine) | Designed; not implemented | [risk-gate-architecture.md §3](risk-gate-architecture.md#3-the-nats-rpc-contract)  |
| `orders.gate.revoke.<broker>` | TS → Python | req/reply | QF revoke caller (P&R engine)                   | NT-side `RiskEngine` plugin    | Designed; not implemented | [risk-gate-architecture.md §3.5](risk-gate-architecture.md#35-envelope-revocation) |

`orders.gate.<broker>` is emitted by the QF risk-gate plugin on every strategy `submit_order` for
gate evaluation at full parent-intent impact. Closes-only fail-open on QF
unreachable. The TS-side handler is the unified gate evaluator described
in [portfolio-risk-engine.md](portfolio-risk-engine.md).

`orders.gate.revoke.<broker>` is the inverse direction: QF claws back a previously-approved envelope when conditions change (portfolio halt, drift hard trip, concentration breach by another strategy, operator-initiated). Plugin replies `revoked` or `envelope_unknown` (idempotency for QF restart-replay). See [risk-gate-architecture.md §3.5](risk-gate-architecture.md#35-envelope-revocation) for the full contract.

### 2.3 Market data (MD bridge ↔ TS MD service)

**RPC (request/reply):**

| Subject                                    | Direction   | Producer      | Consumer  | Payload                                                                  |
| ------------------------------------------ | ----------- | ------------- | --------- | ------------------------------------------------------------------------ |
| `marketdata.rpc.quote.<broker>`            | TS → Python | TS MD service | MD bridge | [broker-integration.md §4.2](broker-integration.md#42-market-data-types) |
| `marketdata.rpc.expirations.<broker>`      | TS → Python | TS MD service | MD bridge | [broker-integration.md §4.2](broker-integration.md#42-market-data-types) |
| `marketdata.rpc.chain.<broker>`            | TS → Python | TS MD service | MD bridge | [broker-integration.md §4.2](broker-integration.md#42-market-data-types) |
| `marketdata.rpc.historical_chain.<broker>` | TS → Python | TS MD service | MD bridge | [broker-integration.md §4.2](broker-integration.md#42-market-data-types) |
| `marketdata.rpc.candles.<broker>`          | TS → Python | TS MD service | MD bridge | [broker-integration.md §4.2](broker-integration.md#42-market-data-types) |

**Streaming (pub/sub):**

| Subject                               | Direction   | Producer  | Consumer                | Payload                                                                                 |
| ------------------------------------- | ----------- | --------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `marketdata.quotes.<broker>.<symbol>` | Python → TS | MD bridge | TS MD service, GUI feed | [broker-integration.md §4.2](broker-integration.md#42-market-data-types) (`Quote`)      |
| `marketdata.trades.<broker>.<symbol>` | Python → TS | MD bridge | TS MD service, GUI feed | [broker-integration.md §4.2](broker-integration.md#42-market-data-types) (`TradePrint`) |
| `marketdata.book.<broker>.<symbol>`   | Python → TS | MD bridge | TS MD service, GUI feed | [broker-integration.md §4.2](broker-integration.md#42-market-data-types) (`L2Book`)     |

**Liveness:**

| Subject                         | Direction   | Producer  | Consumer                       | Payload                                                                              |
| ------------------------------- | ----------- | --------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `marketdata.<broker>.heartbeat` | Python → TS | MD bridge | TS MD service (freshness gate) | [broker-integration.md §7.2](broker-integration.md#72-md-rpc-timeouts-default-in-62) |

Every 10s; includes last upstream success timestamp. Drives the
data-quality gate in `server/market-data/quality-gate.ts`.

> **Retired (QF-261 / QF-281 / QF-339).** The former `signals.<model_id>.<asset_class>.<symbol-tokens>`
> family (model workers → strategy runners / monitors, JetStream `signals.>`)
> is gone: `server/signals/`, `src/types/signal.ts`, and
> `research/magpie-signals` were all removed with the signals
> subsystem. No producer or consumer of a `signals.*` subject exists in the
> codebase, so the family — along with its `<model_id>` / `<asset_class>`
> grammar variables (§1) — is no longer part of the registry. Signal
> ingestion is now the M10 ingest CLI + `/api/signals/*` HTTP surface, which
> does not use NATS. This note is a tombstone; remove it once no reader
> expects the old family.

### 2.4 Strategy lifecycle (QF registry → prod bundle launchers)

QF's lifecycle registry (`server/strategy/lifecycle.ts`) is the source of
truth for which strategies are live. When an operator transitions a
strategy, the registry broadcasts the change so the per-broker prod bundle
launcher can hot-swap that one strategy in/out of its `TradingNode`
without restarting co-tenants — see
[strategy-deployment-topology.md §4.3](strategy-deployment-topology.md#43-lifecycle-event-subscription)
and [RUNBOOK §12.6](../RUNBOOK.md#126-strategy-rollback-and-hot-swap).

| Subject                            | Direction   | Pattern | Producer                                                          | Consumer                                                                                                                                            | Status                    | Payload                                                                                                                                                                                                                             |
| ---------------------------------- | ----------- | ------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle.<strategy_id>.<action>` | TS → Python | pub/sub | QF lifecycle registry (`server/strategy/lifecycle.ts` `onChange`) | Prod bundle launchers (all brokers; per [strategy-deployment-topology.md §4.2](strategy-deployment-topology.md#42-prod-bundle-launcher-per-broker)) | Designed; not implemented | `{ from, to, action, ts, actor, reason? }` — the serialized registry `TransitionEvent` (`server/strategy/lifecycle.ts`); `<strategy_id>` and `<action>` are already encoded in the subject, so they are not repeated in the payload |

Notes on the scheme:

- **`<action>` in the subject, not just the payload**, so a launcher can
  subscribe with an interest filter (e.g. `lifecycle.*.halt` for an audit
  side-car) without deserialising every transition. The bundle launcher
  itself binds the wildcard `lifecycle.>` and dispatches on the action
  token. Pause/resume and the registered/enabled/retired transitions never
  change a live co-tenant (§4.3 of the topology doc), so the registry simply
  doesn't publish them — keeping the subject's `<action>` space to the two
  verbs a launcher acts on.
- **Not per-broker.** Unlike `orders.*` / `marketdata.*`, the lifecycle
  subject carries no `<broker>` suffix. The registry doesn't know which
  broker a strategy is bound to — that's the strategy's
  `tool.magpie.broker` pyproject tag, resolved launcher-side. Every
  broker's launcher subscribes; each ignores `start`/`stop` for strategies
  not tagged to its broker. (`halt` is honored by whichever launcher hosts
  the strategy; a no-op everywhere else.)
- **Pub/sub, not req/reply.** The registry transition has already been
  persisted and is authoritative before the event fires; the launcher
  applies it best-effort and the next full-bundle restart re-reads the
  registry over the HTTP API as the reconciling source of truth. A launcher
  that misses an event self-heals on restart — the same fail-safe the §6
  state contract relies on.

---

## 3. Implementation references

Subject strings are no longer hand-built at each callsite. As of QF-335 the
literals live in one module per language — the single source of truth:

- **TS:** [`src/types/subjects.ts`](../../src/types/subjects.ts) — typed
  builders (`orders.submit(broker)`, `orders.gate.revoke(broker)`,
  `marketdata.quotes(broker, symbol)`, …).
- **Python:** [`research/magpie-subjects`](../../research/magpie-subjects)
  (`magpie_subjects`) — the mirror, consumed by the broker bridges, MD
  bridges, and risk-gate plugin.

Cross-language parity (both modules emit identical strings for identical
inputs) is enforced by
[`nats-subjects.fixtures.json`](nats-subjects.fixtures.json), asserted from
`src/types/subjects.test.ts` and `research/magpie-subjects/tests/test_subjects.py`.

The callsites that _consume_ those builders:

| Family      | TS                                                                                                                                              | Python                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders      | `server/order/adapters/nt-bridge.ts:68-72`                                                                                                      | `research/magpie-schwab-nt/src/magpie_schwab_nt/broker_bridge.py:91-97`, `research/magpie-ibkr-nt/src/magpie_ibkr_nt/broker_bridge.py:73-78` |
| Risk gate   | (not yet implemented; design in risk-gate-architecture.md)                                                                                      | (not yet implemented)                                                                                                                                                |
| Market data | `server/market-data/service.ts`, `server/market-data/quality-gate.ts`                                                                           | `research/magpie-md-bridge/src/magpie_md_bridge/schwab/bridge.py:79-89`                                                                                  |
| Lifecycle   | (not yet implemented; publish point is the `onChange` hook wired at `server/index.ts` into `StrategyStore`, see `server/strategy/lifecycle.ts`) | (consumer is the prod bundle launcher — `research/magpie-prod-bundle/`)                                                                                        |
