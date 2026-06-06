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

| Placeholder     | Value space                                                                                                                                              | Notes                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `<broker>`      | `schwab` \| `ibkr`                                                                                                                                       | Bundle suffix. Bound to the enabled brokers in `config/brokers.json`. New broker = new bundle = same subjects with a new suffix.            |
| `<symbol>`      | Canonical QF symbol token (NATS-safe). `EQ.SPY`, `OPT.SPY.2026-06-20.C.500`, `FUT.CLN6`. The on-the-wire form uses `.` separators, not `:` like logs do. | Per the canonical symbol grammar; QF symbols are tokenized to NATS form by `parseSymbol` + `toSubjectTokens` (`server/signals/publish.ts`). |
| `<model_id>`    | kebab-case slug, e.g. `vol-forecast-spy-1d`                                                                                                              | Strategy/model identifier. Registered in `config/signals.json`; also persisted in the strategy/model DB tables.                             |
| `<asset_class>` | `EQ` \| `OPT` \| `FUT`                                                                                                                                   | Falls out of the symbol tokenization above — appears as the first token after `<model_id>` in `signals.*` subjects.                         |

---

## 2. Subject families

Four families. Per the system topology, every cross-runtime call flows over
NATS — see TRADING-SYSTEM-TDD.md and [broker-integration.md §1](broker-integration.md#1-runtime-topology).

### 2.1 Orders (OPL ↔ broker bridge)

Operator manual entry and framework-fired exits in OPL submit through these
subjects. Strategy submissions do **not** use these — they go through the
NT-side risk gate (§2.2), which is a different subject family.

| Subject                        | Direction   | Pattern   | Producer                                   | Consumer                                  | Payload                                                                                  |
| ------------------------------ | ----------- | --------- | ------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `orders.submit.<broker>`       | TS → Python | req/reply | OPL (`server/order/adapters/nt-bridge.ts`) | Per-broker NT bundle (`broker_bridge.py`) | [broker-integration.md §4.1](broker-integration.md#41-order-types) (`OrderIntent`)       |
| `orders.cancel.<broker>`       | TS → Python | req/reply | OPL                                        | Per-broker NT bundle                      | [broker-integration.md §4.1](broker-integration.md#41-order-types)                       |
| `orders.status.<broker>`       | TS → Python | req/reply | OPL restart recovery                       | Per-broker NT bundle                      | [broker-integration.md §4.1](broker-integration.md#41-order-types) (`BrokerOrderStatus`) |
| `orders.positions.<broker>`    | TS → Python | req/reply | OPL restart recovery                       | Per-broker NT bundle                      | [broker-integration.md §4.1](broker-integration.md#41-order-types) (`BrokerPosition[]`)  |
| `orders.exec_reports.<broker>` | Python → TS | pub/sub   | Per-broker NT bundle                       | OPL audit observer                        | [broker-integration.md §4.1](broker-integration.md#41-order-types) (`BrokerExecReport`)  |

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

### 2.4 Signals (model workers ↔ strategy runners / monitors)

| Subject                                            | Direction       | Pattern                     | Producer                                                                                        | Consumer                                                                                                                                                   | Payload                                                                  |
| -------------------------------------------------- | --------------- | --------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `signals.<model_id>.<asset_class>.<symbol-tokens>` | Python/TS → bus | pub/sub (JetStream durable) | Signal workers (`research/quantfoundry-signals`); TS-side publisher `server/signals/publish.ts` | Strategy runners (`server/strategy/`), working-order monitor (`server/execution/working-order-monitor.ts`), drift detector, exit monitor, WebSocket bridge | Signal schema in `research/quantfoundry-signals` + `src/types/signal.ts` |

Subject is built by `buildSubject(signal)` in `server/signals/publish.ts:49`
as `${SUBJECT_PREFIX}.${signal.model_id}.${tokens.join(".")}`. The token
sequence after `<model_id>` is the asset-class-prefixed symbol path —
e.g. `signals.vol-forecast-spy-1d.EQ.SPY` or
`signals.iv-skew-1d.OPT.SPY.2026-06-20.C.500`.

The JetStream stream is bound to `signals.>` (declared in
`server/signals/publish.ts:35` and the test helper). Per-consumer filters
narrow to `signals.<model_id>.>` (working-order monitor) or stay at
`signals.>` (drift detector, exit monitor, WS bridge).

---

## 3. Implementation references

Where these subjects are literally constructed in code:

| Family              | TS                                                                                                                                                                                           | Python                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders              | `server/order/adapters/nt-bridge.ts:68-72`                                                                                                                                                   | `research/quantfoundry-schwab-nt/src/quantfoundry_schwab_nt/broker_bridge.py:91-97`, `research/quantfoundry-ibkr-nt/src/quantfoundry_ibkr_nt/broker_bridge.py:73-78` |
| Risk gate           | (not yet implemented; design in risk-gate-architecture.md)                                                                                                                                   | (not yet implemented)                                                                                                                                                |
| Market data         | `server/market-data/service.ts`, `server/market-data/quality-gate.ts`                                                                                                                        | `research/quantfoundry-md-bridge/src/quantfoundry_md_bridge/schwab/bridge.py:79-89`                                                                                  |
| Signals (publish)   | `server/signals/publish.ts:49-52`                                                                                                                                                            | `research/quantfoundry-signals/src/quantfoundry_signals/publisher.py` (HTTP→ingress→NATS)                                                                            |
| Signals (subscribe) | `server/signals/ws-bridge.ts:78`, `server/signals/drift-detector.ts:114`, `server/signals/exit-monitor.ts:198`, `server/strategy/runner.ts`, `server/execution/working-order-monitor.ts:150` | n/a                                                                                                                                                                  |
