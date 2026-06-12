# Bundle-Launcher Liveness + Cross-Broker Market-Data Fallback — Design TDD

Parent: [TRADING-SYSTEM-TDD.md](../TRADING-SYSTEM-TDD.md). Companions: [Broker & Market-Data Integration](broker-integration.md), [Alerts](alerts.md), [Strategy Deployment Topology](strategy-deployment-topology.md), [Data Plane](../data/data-plane.md).

> **Status.** Design — **ratified 2026-06-07, not yet implemented.** This document proposes a **scoped reversal** of the current "no cross-broker fallback" architectural commitment and a concrete config + mechanics for it, plus a per-bridge liveness surface. Ratified decisions (QF-341): §1 matrix **accepted as proposed**; §2 priority order **`["ibkr", "schwab"]`** (IBKR primary, Schwab fallback); the §5 `bridge.fallback_active.*` degraded-state alert is **in scope for v1** (operator opted in). Ready for implementation per §6. QF-341.

---

## 0. What changes, and why

Today the system forbids cross-broker market-data fallback. The relevant load-bearing text in [broker-integration.md](broker-integration.md):

- **Overview** — _"**No cross-broker fallback.** Each broker bundle is independent; if it's unavailable, that broker's positions can't be traded or re-Greek'd until it recovers. The TS-side service layer surfaces this as `BridgeUnavailableError`, not a silent failover."_
- **§5.2** — _"It is not a stack of swappable adapters with fallback — each broker bundle's NT MD client is the single source for that broker's data, and there is no cross-broker fallback."_ … _"A request to a broker whose bundle is unavailable … rejects with `BridgeUnavailableError` rather than silently routing to another broker."_
- **§7.2** — _"No cross-broker fallback: a Schwab MD timeout doesn't route to IBKR."_
- **§7.3** (the heartbeat-stale and bundle-down rows) — _"RPC calls reject with `BridgeUnavailableError`; … No cross-broker fallback."_

The blanket prohibition is correct for **orders** — an order is bound to a specific broker account, and "submit to a different broker because yours is down" is never the right behavior. It is **too broad for read-only market data**: an SPY chain or an AAPL quote is the same instrument regardless of which bundle sourced it. When the Schwab bundle is down, the Portfolio & Risk engine still wants to re-Greek SPY positions, and the GUI still wants to display a live quote — and the IBKR bundle can answer both.

**The proposed reversal is scoped to the read-only `marketdata.rpc.*` plane only.** Orders, the gate, exec reports, and positions remain strictly broker-bound. The reversal is **opt-in and explicit**: fallback only happens when the operator has ratified a priority order in `config/brokers.json`; absent that config, behavior is identical to today (`BridgeUnavailableError`, no failover).

The "bundle-launcher liveness" half of the ticket is the detection substrate the fallback policy depends on: we cannot route around a down bridge unless we know, promptly and reliably, that it is down. §3.1 specifies the liveness signal; §4 specifies how it surfaces to the operator.

> **Distinction from the old adapter-stack.** A pre-rewrite `MarketDataService` (`server/market-data/service.ts`) already does in-process `tryInOrder` fallback across vendor adapters (Schwab REST / Databento / MarketData.app). That is **vendor** fallback inside a single data-source tier and is unrelated to this proposal. This document is about **broker-bundle** fallback on the post-rewrite NATS-consumer surface described in [broker-integration.md §5.2](broker-integration.md#52-market-data-service--nats-consumer), where every method takes an explicit `broker` parameter.

---

## 1. Decision matrix — fallback per RPC method

**Decision rule.** A method is fallback-eligible iff (a) it is **read-only** and (b) its result is a property of the **canonical QF symbol**, not of a broker account. Order-plane methods fail both tests and are never eligible.

The table below is the **proposed default**, presented for the operator to ratify or override. "Fallback" means: when the primary broker's bridge is unavailable (§3.1), re-dispatch the same logical request to the next broker in the ratified priority order (§2).

| Method                            | Fallback | Rationale                                                                                                                                                                                                                                                                                               |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marketdata.rpc.quote`            | **YES**  | Read-only top-of-book on a canonical symbol. NBBO differs slightly per venue but is fungible for Greeks recompute and GUI display; consumers already tag `_meta.source` so provenance is visible.                                                                                                       |
| `marketdata.rpc.chain`            | **YES**  | Read-only option chain for `(underlier, expiration)`. Same instruments at both brokers; strike/expiry universe is an exchange property, not a broker one.                                                                                                                                               |
| `marketdata.rpc.expirations`      | **YES**  | Read-only expiration list for an underlier. Exchange-listed; broker-independent.                                                                                                                                                                                                                        |
| `marketdata.rpc.candles`          | **YES**  | Read-only OHLCV bars. Historical/aggregated; broker-independent. (Minor vendor bar-alignment differences; acceptable for display + warm-up.)                                                                                                                                                            |
| `marketdata.rpc.historical_chain` | **NO\*** | Already not served from live broker MD — historical chain reads go to MinIO/Parquet via the offline collection pipeline ([broker-integration.md §5.2](broker-integration.md#52-market-data-service--nats-consumer)). Brokers respond `not_supported`. Fallback is moot: there is no second live source. |
| `orders.submit` / `.cancel`       | **NO**   | Account-bound mutation. Submitting to a different broker is semantically wrong and dangerous. Stays `BridgeUnavailableError` / `submission_failed` per [broker-integration.md §7.1](broker-integration.md#71-order-rpc-timeouts).                                                                       |
| `orders.status` / `.positions`    | **NO**   | Reads broker-account state. Broker B has no knowledge of broker A's orders or positions. Not fungible.                                                                                                                                                                                                  |
| `orders.gate` / `.exec_reports`   | **NO**   | Per-bundle risk-gate interception and per-bundle fills. Inherently bound to the originating TradingNode.                                                                                                                                                                                                |

\* `historical_chain` is listed for completeness; its "NO" is not a fallback prohibition so much as "there is nothing to fall back to on the live plane." The offline Parquet path is the existing recovery.

**Streaming subjects** (`marketdata.quotes/trades/book.<broker>.<symbol>`) are **out of scope for fallback** in v1. A subscription is a long-lived, stateful per-broker fan-out (see the fan-out registries in `server/market-data/adapters/nt-bridge-md.ts`); transparently re-homing live subscriptions to another broker mid-stream is materially more complex than re-dispatching a one-shot RPC and is deferred (§7). Today's behavior stands: subscriptions stay registered and resume when the broker's heartbeats return ([broker-integration.md §7.3](broker-integration.md#73-common-failures)).

> **Ratified:** YES for all four read-only `rpc.*` methods, NO for everything else. An operator who later wants chain fallback but not quote fallback (e.g. distrusts cross-venue NBBO for pre-submit checks) can override per method via the schema in §2.2.

---

## 2. Broker-priority config schema

### 2.1 Where it lives

The priority scheme extends **`config/brokers.json`**, read by the canonical loader `server/order/brokers-config.ts`. That loader is the existing reader and the file already gates broker enablement; a new optional `marketdata` block keeps fallback policy next to the broker definitions it references. The loader's "unknown top-level keys are logged and skipped" forward-compat rule ([brokers-config.ts](../../server/order/brokers-config.ts)) means an older server tolerates the new block, and a newer server tolerates its absence (= no fallback).

### 2.2 Proposed shape

A new top-level `marketdata` object with a **global default priority order** plus optional **per-method overrides**:

```jsonc
{
  // ... existing per-broker order blocks (schwab.accounts[], ibkr...) ...

  "marketdata": {
    // Master switch. When false (or the whole `marketdata` block absent),
    // behavior is identical to today: no cross-broker fallback, the MD
    // service rejects with BridgeUnavailableError. Default: false.
    "fallback_enabled": true,

    // Global fallback order. The first entry is the primary; subsequent
    // entries are tried in order when the one ahead is unavailable (§3).
    // Brokers not listed here are never used as a fallback target.
    // Every id MUST name a broker that is enabled elsewhere in this file.
    "priority": ["ibkr", "schwab"],

    // Optional per-method overrides. A method present here uses its own
    // order/enabled; a method absent here inherits the global `priority`
    // and `fallback_enabled`. Lets an operator ratify the §1 matrix at
    // per-method granularity (e.g. disable quote fallback only).
    "methods": {
      "quote": { "fallback_enabled": true, "priority": ["ibkr", "schwab"] },
      "chain": { "fallback_enabled": true },
      "expirations": { "fallback_enabled": true },
      "candles": { "fallback_enabled": false }, // candles served primary-only
    },

    // Liveness threshold reused by the fallback selector (§3.1). Mirrors
    // config/data-plane.json bridge_heartbeat_timeout_ms; if both are set
    // and disagree, brokers.json wins for fallback decisions and the
    // loader logs a warning. Default: 30000.
    "heartbeat_stale_ms": 30000,
  },
}
```

### 2.3 Validation rules (enforced by the loader)

The loader extends its existing strict-parse posture (reject-unknown-field, fail-closed-on-malformed). Proposed rules:

1. `marketdata` is optional. Absent → `{ fallback_enabled: false }` (today's behavior). The master switch defaults `false` so enabling fallback is always an explicit operator act.
2. `priority` must be a non-empty array of unique, slug-safe broker ids. Every id must reference a broker that is **enabled** elsewhere in the file — a priority entry naming a disabled or unknown broker is a hard `BrokersConfigError` at load (refuse to start rather than silently route nowhere).
3. `methods` keys are restricted to the four fallback-eligible methods (`quote`, `chain`, `expirations`, `candles`). `historical_chain`, `orders.*`, and any unknown method key are rejected — listing a never-eligible method is an operator error, not a silent skip.
4. A per-method `priority`, when present, must satisfy the same constraints as the global one (rule 2).
5. `fallback_enabled: true` with a single-element `priority` is **valid but logged at warn** — it documents intent but can never actually fall back.
6. `heartbeat_stale_ms` must be a positive number (reuses the existing `parsePositiveNumber` guard).

> **Ratified:** a single global `["ibkr", "schwab"]` (IBKR primary, Schwab fallback), no per-method overrides. (The original draft recommended the inverse, `["schwab", "ibkr"]`; the operator chose IBKR-primary.)

---

## 3. Fallback mechanics

### 3.1 Detecting "broker A is down"

The fallback selector treats a broker as **unavailable** when **either** signal trips:

1. **Heartbeat staleness.** No `marketdata.<broker>.heartbeat` received within `heartbeat_stale_ms` (default 30s). This is exactly the existing liveness check already implemented in `server/market-data/adapters/nt-bridge-md.ts::available()` — it returns `false` when `Date.now() - lastHeartbeatMs > heartbeatStaleMs`, and also when no heartbeat has ever been seen (first-boot grace). The fallback selector reuses `adapter.available()` as the single source of truth; no new liveness primitive is introduced.
2. **`available()` probe / RPC error frame.** Even within the heartbeat window, a method may fail (RPC timeout, or an `upstream_unavailable` / `internal` error frame per [broker-integration.md §4.2](broker-integration.md#42-market-data-types)). A failed call on the primary is treated as "primary cannot serve this request right now" and the selector advances to the next broker for **that request**.

These are complementary: heartbeat staleness is the **fast, cheap pre-check** (skip a doomed RPC and its full timeout); the per-request error is the **catch-all** for the window where the bridge is heartbeating but a specific upstream call fails.

### 3.2 Selecting broker B

For a method `m` and a request, the selector:

1. Resolves the effective order: `methods[m].priority ?? marketdata.priority`, and the effective switch `methods[m].fallback_enabled ?? marketdata.fallback_enabled`.
2. If `fallback_enabled` is false → behave exactly as today: dispatch only to the explicitly-requested broker; on failure, reject with `BridgeUnavailableError`. **No iteration.**
3. If `fallback_enabled` is true → walk the order starting at the **requested** broker's position (with ratified order `["ibkr","schwab"]`: a caller asking for "Schwab's quote" starts at Schwab, then has no further fallback; a caller asking for "IBKR's quote" starts at IBKR then tries Schwab). For each candidate in turn: if `available()` is false, skip without an RPC; otherwise dispatch; on success return immediately, tagging `_meta.source` / `sources_tried` so the served-from broker is visible to the consumer and the GUI.
4. If every candidate is exhausted → reject with `BridgeUnavailableError` (§3.4).

The explicit-`broker`-parameter contract from [broker-integration.md §5.2](broker-integration.md#52-market-data-service--nats-consumer) is preserved: callers still ask for a specific broker. Fallback is a service-layer behavior layered **on top of** that request, not a replacement for the parameter — the requested broker is simply the **preferred** broker, and the ratified order defines the failover tail.

### 3.3 Symbol-equivalence assumptions

Fallback rests on one assumption made explicit here: **the canonical QF symbol is broker-agnostic.** `EQ:AAPL`, `OPT:SPY:2026-06-20:C:500`, `FUT:CLN6` denote the same instrument to every bundle, and each bundle's MD client maps the canonical symbol to its broker-native identifier internally ([broker-integration.md §3](broker-integration.md#3-nats-subject-grammar) already commits to canonical symbols on every subject). Therefore re-dispatching the identical request payload to broker B requires **no translation** at the service layer.

Accepted residual differences (documented, not corrected):

- **Quote venue/NBBO drift** — top-of-book may differ marginally between Schwab and IBKR. Acceptable for Greeks recompute (Portfolio & Risk gate allows `max_quote_age_ms: 120000`) and GUI display. For the OPL pre-submit check (tighter `30000`), a fallback quote is still a real quote; `_meta.source` lets OPL see it came from the non-routing broker if that ever matters for a future policy.
- **Candle bar alignment** — minor session/aggregation differences between vendors. Acceptable for warm-up and display.
- **Symbol coverage gaps** — if broker B simply does not list an instrument broker A does, B returns `not_supported` / empty; the selector treats that like any other failure and continues down the order (or exhausts → `BridgeUnavailableError`).

### 3.4 Failure semantics if all brokers are down

**Unchanged from today.** When every candidate in the effective order is unavailable, the MD service rejects with `BridgeUnavailableError` — the same error, same shape, same consumer handling as [broker-integration.md §7.3](broker-integration.md#73-common-failures). Fallback never converts a total outage into a silent success; it only widens the set of sources tried before that error. Consumers (OPL pre-submit, Greeks recompute, GUI panel) keep their existing per-call error handling; no consumer needs to change to tolerate fallback.

---

## 4. Liveness reporting — Settings → Bridges

The detection substrate (§3.1) is per-bridge heartbeat health. That signal already has a server surface and a screen; this section specs the operator-facing view and the small additions fallback needs.

### 4.1 Existing surface (QF-296)

`GET /api/marketdata/bridges` (`server/market-data/health.ts::getBridgeStatuses`) already returns per-broker bridge state, typed as `BridgeStatus` in [src/types/marketdata-health.ts](../../src/types/marketdata-health.ts):

```ts
interface BridgeStatus {
  broker: string;
  alive: boolean;
  last_heartbeat_age_ms: number | null; // null today: stub until lastHeartbeatMs is exposed
  rpc_count_5m: number;
  rpc_error_rate_5m: number;
  rpc_latency_p50_ms: number | null;
  rpc_latency_p99_ms: number | null;
}
```

It is rendered today by [MarketDataHealthScreen](../../src/screens/MarketDataHealthScreen.tsx) under **Settings → Data → Market data health** ([gui.md Settings table](gui.md#settings)). The `alive` field is computed from `adapter.available()`, which is the same heartbeat check the fallback selector uses (§3.1) — so the operator view and the routing decision share one definition of "alive." No divergence by construction.

### 4.2 Proposed additions for fallback

To make the bridges screen answer "who is serving me right now, and is fallback active," extend `BridgeStatus` and the screen:

```ts
interface BridgeStatus {
  // ... existing fields ...

  // Where this broker sits in the ratified MD priority order, or null if
  // not listed in config/brokers.json marketdata.priority. Lets the UI
  // render "primary" / "fallback #1" badges.
  priority_rank: number | null;

  // True when this broker is currently being used as a fallback target
  // because a higher-priority broker is unavailable (derived from recent
  // sources_tried, last 5m). Drives a "serving as fallback" indicator.
  serving_as_fallback: boolean;
}
```

And surface the policy itself so the operator can see what they ratified without opening the JSON:

- A **policy header** on the screen reading the `marketdata` block: `fallback_enabled`, the global `priority` order, and any per-method overrides — read-only (edited in `config/brokers.json`, consistent with the read-only `BrokersScreen` adapter cards).
- Per-bridge rows already show `alive` + `last_heartbeat_age_ms` (the QF-296 `last_heartbeat_age_ms: null` stub should be replaced with the real age as part of this work — it is the load-bearing number for "how stale, exactly").

> **Note.** The exact `last_heartbeat_age_ms` value requires exposing the private `lastHeartbeatMs` closure in `nt-bridge-md.ts` (today the QF-296 endpoint returns `null` per its documented stub). That is a small, well-scoped follow-up folded into the implementation sequence (§6).

The screen stays **poll-based** (re-fetch periodically), consistent with the existing health surfaces; no streaming push is added for v1.

---

## 5. Alerting

Sustained bridge-down is already a first-class alert concern. The **Market Data service** is a registered producer in [alerts.md §7](alerts.md#7-producer-callsites):

| Trigger                       | Event type                    | Companion                   |
| ----------------------------- | ----------------------------- | --------------------------- |
| Bridge heartbeat lapsed > 30s | `bridge.unavailable.<broker>` | `bridge.recovered.<broker>` |

These map to the observability events `md.bridge.unavailable` / `md.bridge.recovered` ([broker-integration.md §10.1](broker-integration.md#101-ts-side-md-service--order-adapters)). The fallback work adds **no new alert types** — it reuses `bridge.unavailable.<broker>` as the signal that a broker has gone down (and, with fallback enabled, that traffic is now being served by a fallback target). The default `quote_unavailable.*` banner rules ([alerts.md §9](alerts.md#9-currently-shipped-rules)) continue to fire from OPL only when **all** candidates are exhausted (i.e. a real `BridgeUnavailableError`), so enabling fallback should **reduce** quote-unavailable banner noise, not add to it.

> **Dependency: QF-336.** The `bridge.unavailable.*` producer callsite is mid-migration to the alert router under QF-336. This design depends on QF-336 landing the `router.record({ type: "bridge.unavailable.<broker>", ... })` callsite in the MD service. Until it does, bridge-down is visible via the Settings → Bridges screen (§4) and the `md.bridge.unavailable` log event, but does not fan out to Slack/internal channels. The fallback work should **not** re-implement the producer callsite — it consumes QF-336's, and is sequenced after it (§6).

**Ratified in scope for v1:** a distinct `bridge.fallback_active.<broker>` info-level event fired once when fallback first engages for a method, with a `bridge.fallback_cleared.<broker>` companion. This makes "we are currently degraded onto Schwab" an explicit, alertable transition rather than something the operator must infer from the bridges screen. Wired in §6 step 7 (after QF-336's router callsite).

---

## 6. Implementation sequencing (after ratification)

Ordered steps. Steps 1–2 are config/contract only; nothing routes differently until step 4 flips behavior, and only when the operator has set `fallback_enabled: true`.

1. **Config schema + loader (QF-341a).** Extend `config/brokers.json` with the optional `marketdata` block (§2.2) and `server/order/brokers-config.ts` with the parser + validation rules (§2.3). Default `fallback_enabled: false` — pure no-op until configured. Unit tests for every validation rule. _No behavior change._
2. **Liveness exactness (QF-341b).** Replace the QF-296 `last_heartbeat_age_ms: null` stub with the real age by exposing `lastHeartbeatMs` from `nt-bridge-md.ts` (§4.2). Small, independently shippable; improves the existing bridges screen on its own.
3. **Doc ratification gate.** Operator ratifies §1 matrix + §2 priority order. The ratified values are committed to `config/brokers.json` (the audit trail of what was decided). _This is the gate the rest depends on._
4. **Fallback selector (QF-341c).** Implement the per-method selector (§3.2) in the post-rewrite MD service layer: read effective order, reuse `available()` for the pre-check, re-dispatch on failure, tag `_meta.source` / `sources_tried`, exhaust → `BridgeUnavailableError`. This is the behavioral change. Guarded entirely behind `fallback_enabled`.
5. **Amend broker-integration.md (QF-341d).** Update the load-bearing prohibition text quoted in §0 (Overview, §5.2, §7.2, §7.3) from "no cross-broker fallback" to "no cross-broker fallback **for orders**; opt-in, config-gated fallback for read-only `marketdata.rpc.*` per [marketdata-fallback.md](marketdata-fallback.md)." Add the §7.4 cross-link stub (already drafted in this PR).
6. **Bridges screen additions (QF-341e).** Add `priority_rank` + `serving_as_fallback` to `BridgeStatus` and the policy header to `MarketDataHealthScreen` (§4.2).
7. **Alert wiring (depends on QF-336).** Confirm `bridge.unavailable.<broker>` fires through the router (QF-336 landed). Add the ratified `bridge.fallback_active.*` / `bridge.fallback_cleared.*` events (§5).

Steps 1, 2, and 6 are independently useful and can ship before the ratification gate; steps 4 and 5 are the gated core; step 7 is downstream of QF-336.

---

## 7. Out of scope (deferred)

- **Auto-recovery / supervisor process.** Restarting a dead bundle, watchdog-respawning the launcher, or any automated process-lifecycle management is explicitly out of scope. Today bundles are operator-launched ([strategy-deployment-topology.md §4.2](strategy-deployment-topology.md)); a supervisor that detects a crashed bundle and relaunches it is a separate ticket. This design only **routes around** a down bridge; it does not try to **fix** it.
- **Streaming-subscription fallback.** Re-homing live `marketdata.quotes/trades/book.*` subscriptions to another broker mid-stream (§1). Stateful and materially harder than one-shot RPC fallback; deferred.
<!-- bridge.fallback_active.* alert: ratified IN SCOPE for v1 (§5); no longer deferred. -->
- **Per-symbol or per-instrument-class priority.** The schema (§2.2) is per-method, not per-symbol. "Use IBKR for futures, Schwab for equities" would need a richer key; not in v1.
- **Quote reconciliation / cross-venue arbitration.** No attempt to reconcile or prefer one broker's NBBO over another's beyond the priority order. The served broker's quote is used as-is, tagged with provenance.
- **Order-plane fallback of any kind.** Permanently out of scope by design (§1) — not deferred, prohibited.

---

## 8. Decisions requiring operator ratification (summary)

_All three ratified 2026-06-07 (QF-341):_

1. **§1 — Per-method fallback matrix.** ✅ **Ratified as proposed:** YES for `quote`, `chain`, `expirations`, `candles`; NO for `historical_chain` (moot) and all `orders.*`.
2. **§2 — Broker priority order.** ✅ **Ratified:** global `["ibkr", "schwab"]` (IBKR primary, Schwab fallback), no per-method overrides.
3. **§5 — Degraded-state alert.** ✅ **Ratified in scope for v1:** add the `bridge.fallback_active.*` / `bridge.fallback_cleared.*` events.

Everything else in this document follows mechanically from these three choices and the existing liveness/alert/config substrate.
