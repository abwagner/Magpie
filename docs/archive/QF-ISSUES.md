> **Archived 2026-04-28.** Open issues from this tracker now live in [Linear → Magpie → M1 · Bugs & small improvements](<internal tracker>). The closed entries below (QF-5, QF-6, QF-8) are preserved here for historical reference with their commit SHAs. Do not add new entries — file them in Linear instead.
>
> Note: the file moved from `docs/` to `docs/archive/`, so any relative links in the body below now resolve from one level deeper. Broken links are intentional — the file is read-only history.

---

# Magpie — Build Issues Log

Running list of bugs / regressions / dissatisfactions found while operating the new shell. One section per issue. The plan is to **collect first, fix later** — premature triage during use eats focus. Pick a sprint's worth, work them down, repeat.

Severity: **P0** = blocks a workflow. **P1** = annoying / wrong / lying. **P2** = nice to have / cleanup.

Status: **open** / **investigating** / **fixed** (with commit).

---

## QF-1 · Greek Builder duplicated inside Option Chain panel

- **Severity:** P1
- **Status:** open
- **Reported:** 2026-04-27 session

The Build workspace has a standalone [GreekBuilderPanel](../src/panels/GreekBuilderPanel.tsx) **and** [ChainPanel](../src/panels/ChainPanel.tsx) (which wraps `ChainPicker.tsx`). The wrapped ChainPicker already has the full Greek Builder UI baked in — `GreekModes`, `GreekBounds`, the worker call to `solveGreekBuilder`, the same LP solver path. Two builders, same logic, different surfaces.

The standalone panel was added during Phase 2b before noticing the existing one. It now hardcodes SPY ([line 86](../src/panels/GreekBuilderPanel.tsx#L86)), which is more limited than ChainPicker's symbol-driven version.

**Decision needed:** delete the standalone GreekBuilderPanel and reclaim the Build workspace cell, or keep both with a clear role split (e.g. standalone = quick presets only; ChainPicker version = full control). Likely former — the standalone is genuinely redundant.

**Fix sketch:** drop `greeks` from the Build workspace cells in [src/workspaces/index.ts](../src/workspaces/index.ts), give the freed cell to `pos2` or expand `payoff`. Remove `GreekBuilderPanel.tsx` + its registry entry. Optional: update Order Ticket flow so ChainPicker's existing Greek Builder can hand a draft to the new `<OrderTicket>` drawer (today it stages legs back into ChainPicker's own state).

---

## QF-2 · MarketData credit counter disagrees with the dashboard

- **Severity:** P1 (visibility, not blocking)
- **Status:** investigating

Server logs show `credits=4993/100000` (i.e. 95,007 reportedly used in this session) while the MarketData dashboard reads 0/100k used. Either the local counter is misreading headers or the dashboard has a different scope (lifetime vs daily, or excludes 404s).

**Source:** [src/lib/marketdata-api.js:52](../src/lib/marketdata-api.js#L52) logs `${remaining}/${limit}` from the `x-api-ratelimit-*` response headers. The header parsing itself looks right — the question is what those headers mean for our specific account tier.

**Diagnostic step:** dump the full response headers from one MD call (any of the 404 ones the orchestrator already makes) and compare against MD's documented headers. Worth checking whether 404s consume credits at all — if they do, the orchestrator's CL-futures probe-list (QF-3) is burning budget on dead symbols.

---

## QF-3 · Orchestrator probes non-existent CL futures contracts

- **Severity:** P1
- **Status:** open

[server/orchestrator/api.ts](../server/orchestrator/api.ts) freshness checker iterates a list of CL crude-oil futures contracts (`CLN26`, `CLM`, `CLM26`, `CLM2`, `CLN26`) and gets 404s on most of them — at least one of those (`CLM`) isn't a valid futures symbol format and a couple are stale (`CLM26` already expired or doesn't exist for our broker).

If 404s consume credits (per QF-2), this is burning credits on dead probes every poll cycle.

**Fix sketch:** prune the probe list. Either auto-discover live contract months from the broker once and cache, or hardcode a tighter list keyed on today's date (front month + next two only).

---

## QF-4 · Greek Builder hardcodes SPY

- **Severity:** P2
- **Status:** open (already in v2 plan §9)

[GreekBuilderPanel.tsx:86](../src/panels/GreekBuilderPanel.tsx#L86) hardcodes `symbol = "SPY"`. CL options (and any other futures-options or equity-options underlying) have full Greeks and would benefit from the LP solver. ChainPicker's built-in Greek Builder doesn't have this limitation.

If we keep the standalone panel (per QF-1's decision), unblock multi-symbol input. If we delete the standalone, this issue closes via QF-1.

---

## QF-5 · Greek Builder error → stuck-building

- **Severity:** P0
- **Status:** **fixed** in [9530878](https://github.com/your/repo/commit/9530878)

First Stage click errored, second click stuck on "Solving…" forever. Root cause: dead worker reuse across calls + no timeout. Fix: spawn fresh worker per solve, 30s timeout, terminate-on-error.

---

## QF-6 · DataCatalogTab orphaned in the new shell

- **Severity:** P1
- **Status:** **fixed** in [d8a82be](https://github.com/your/repo/commit/d8a82be)

The legacy DataCatalogTab survived Phase 5b but the new SettingsShell never wired it into the section router. Mounted at Settings → Data → Data catalog.

---

## QF-8 · Exit monitor crashes with `publishDurable on null`

- **Severity:** P1 (log noise per signal sweep)
- **Status:** **fixed** (this commit)
- **Reported:** "I keep seeing this error in the logs"

```
ERROR server.exit-monitor sweep exit emission failed
  directiveId=vol-buyer-spy:1.0.0:EQ:SPY:...
  error="TypeError: Cannot read properties of null (reading 'publishDurable')"
```

Root cause: [server/index.js:242](../server/index.js#L242) gated the exit monitor on `if (natsConn)` but the closure at line 253 used `natsPublisher`. NATS connection succeeds (assigning `natsConn`), but if `ensureStream` or `createPublisher` throws on init, `natsPublisher` stays null. Exit monitor still starts; closure bombs at first sweep.

Two other call sites already had it right — ingress at [line 200](../server/index.js#L200) gates on `natsPublisher`, rollup at [line 380](../server/index.js#L380) has a `if (!natsPublisher) return` runtime guard.

Fix: gate the exit monitor on `natsPublisher`, and add the same runtime guard inside the closure for defense-in-depth.

---

## QF-9 · IBKR connection retry spam

- **Severity:** P1 (log noise on every poll cycle)
- **Status:** open
- **Reported:** "if we know there's no IBKR working, we shouldn't keep calling it"

When IB Gateway isn't running on `127.0.0.1:4002`, the IBKR adapter logs `code=502: connect ECONNREFUSED 127.0.0.1:4002` followed by `connect failed: IBKR connection timeout` every poll. The connection failure is per-call, not circuit-broken — once we know it's down we should back off, not retry on every probe.

**Direction confirmed by user:** "It's a live config, but IB Gateway is generally not on because it's annoying to launch." So IBKR stays in the source list — the fix is an adapter-level circuit breaker, not config removal. When the gateway eventually does come up, the breaker should auto-recover (no manual reset).

**Fix sketch (circuit breaker in `server/market-data/adapters/ibkr.ts`):**

1. Track `consecutiveFailures: number`, `cooldownUntil: number` (epoch ms).
2. Before each call: if `Date.now() < cooldownUntil`, return null immediately — adapter reports unavailable, fallback chain skips to the next source. No log line.
3. On a connection failure: increment counter; if `consecutiveFailures >= 3`, set `cooldownUntil = now + 60_000`. Log a single "circuit opened" message at warn level instead of the per-call ECONNREFUSED.
4. On success: reset both counters (auto-recovery when IB Gateway comes back online).
5. While in cooldown, the existing `getSourceStatus()` reports IBKR as unavailable (which the snapshot already does), so the Settings → Brokers screen flips its badge accordingly.

~30 lines. Optional refinement: half-open probe — once cooldown expires, allow one call through to test recovery before fully closing the breaker.

---

## QF-10 · Futures positions / chains not available via current APIs

- **Severity:** P1 (visibility gap on a real workflow)
- **Status:** open
- **Reported:** "the CL issue is a known problem, where CL/futures in general not supported by the API"

The active broker + market-data adapters (Schwab brokerage positions, MarketData.app chain/quote) don't surface futures contracts:

- **Schwab brokerage positions** has a `FUTURE` assetType branch ([`server/order/adapters/schwab.ts:260`](../server/order/adapters/schwab.ts#L260)), but the user's account doesn't have futures privileges, so the branch never fires — futures positions held at a different broker don't appear here.
- **MarketData.app chain/quote** returns 404 for futures roots (`CLN26`, `CLM26`, etc.) — see QF-3. Even if positions came in, we couldn't price or get Greeks for them through the current data plane.

Result: the operator's actual CL positions are invisible to the system. The Greek Builder, P&L sparkline, risk headroom, recon — all run without a complete picture.

The futures-shape work in commit `5638511` (BrokerFuturesPosition, `futures[]` array, FuturesTable) is structurally correct but inert as long as upstream adapters don't deliver futures data.

**Three paths forward:**

1. **IBKR adapter for positions.** IB's API supports futures positions, market data, and order routing. The user has an IBKR config but only runs IB Gateway intermittently (QF-9). Wiring `fetchIbkrPositions` to mirror `fetchSchwabPositions`'s shape would unblock futures visibility whenever the gateway is running. Pair with QF-9 (circuit-breaker) so the spam doesn't return when gateway is off.
2. **Manual external-positions config.** A `config/external_positions.yaml` the operator maintains by hand. The Broker Positions panel renders these alongside Schwab data, tagged "manual". Easiest to ship; least dynamic.
3. **A futures-specific broker adapter** (TastyTrade / NinjaTrader). New adapter; ~2 weeks of work; depends on the user actually using one as their futures venue.

**Recommended:** path 1 (IBKR). Most aligned with existing infra, biggest payoff, and the user already runs IB Gateway sometimes.

---

## QF-7 · gui.md TDD claimed DataCatalog was wired when it wasn't

- **Severity:** P2
- **Status:** open

[docs/tdd/gui.md](tdd/gui.md) (the TDD refresh in `abb9cdb`) claimed "DataCatalog (mounted under Settings → Data → Market data)" but the code didn't match. Caught during use. The doc is now correct after QF-6 — but the underlying lesson is the doc was written from intent rather than verified against code.

**Fix sketch:** brief audit pass on gui.md cross-checking every "mounted at X" / "wired by Y" claim against the actual code. Probably 30 minutes.

---

## How to add an entry

```
## QF-N · Short title

- **Severity:** P0 / P1 / P2
- **Status:** open / investigating / fixed in [shortsha](url)
- **Reported:** session date or "during X session"

Two-paragraph description. What you saw, what you expected, hypothesis for cause, file pointers if known.

**Fix sketch:** one paragraph. Optional.
```

Add at the bottom; renumber only if a duplicate sneaks in. Closed issues stay in the file as a history. When the file gets too long, archive resolved ones to a `QF-ISSUES-CLOSED.md`.
