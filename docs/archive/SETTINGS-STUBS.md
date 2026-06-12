> **Archived 2026-04-28.** Each placeholder section below is now its own ticket in [Linear → Magpie → M5 · Settings UI — placeholder backends](<internal tracker>). The doc remains here as a useful overview of the placeholder landscape; pickup priority and effort estimates are tracked at the ticket level.
>
> Note: the file moved from `docs/` to `docs/archive/`, so relative paths below now resolve from one level deeper.

---

# Settings — placeholder sub-screens

The Settings workspace ([SettingsShell](../src/screens/SettingsShell.tsx)) navigates 15 sections grouped into 5 categories. Four are wired today; the other 11 render a "soon" placeholder. This doc enumerates the placeholders and the backend each would need before it can ship.

The "soon" tag in the nav is purely cosmetic — the Settings IA is intentionally complete in the UI so an operator reading the design recognises the full structure even when individual sections haven't shipped.

Wired sections (for reference): Risk → Limits, Data → Brokers, Models → Signals, Activity → Audit.

Backend work for each placeholder section is tracked in [internal planning notes §12](../../.claude/plans/magpie-v2.md). Pick whichever the operator actually wants to use first; none blocks v1.

---

## Risk

### Risk → Policies

**What it would do:** named risk-policy presets (e.g. "Standard", "Tight overnight", "Earnings week") that bundle a full RiskLimits set + an `execution_mode` + a kill-switch sensitivity. The operator picks a policy from a dropdown; values write to `config/risk_limits.yaml` and `config/portfolios.json`.

**Backend prerequisites:**

- New `config/risk_policies.yaml` with named policy entries.
- `GET / POST / DELETE /api/risk/policies` — CRUD over the policies file.
- `POST /api/risk/policies/:id/apply` — copy the policy values into `config/risk_limits.yaml` for the selected portfolio. Atomic.
- Validation: a policy can't reference an unknown portfolio at apply time.

**Effort:** ~3–5 days (server + screen).

**Files (new):** `server/risk/policies.ts`, `src/screens/RiskPoliciesScreen.tsx`.

---

### Risk → Emergency

**What it would do:** dedicated panel for emergency operations beyond the header kill switch. Includes:

- Cancel-all-pending — separate from a full halt.
- Per-portfolio halt with reason text.
- Halt history (when, who, why) sourced from the system-halt audit trail.
- "Drain mode" — reject new intents but let pending fills complete.

**Backend prerequisites:**

- Per-portfolio halt endpoints (today only system-wide kill exists): `POST /api/portfolio/:id/halt` and `/reset`.
- New `audit_system_halts` table or extend existing audit chain to capture halts with operator-supplied reason.
- Drain mode flag on the order plane.

**Effort:** ~1 week. Per-portfolio halt is non-trivial because today's `OrderPlane.killSwitch` is process-wide.

**Files (new):** `server/order/drain.ts`, `src/screens/EmergencyScreen.tsx`. Modified: `server/order/plane.ts`.

---

## Data

### Data → Market data

**What it would do:** per-source quality dashboard. Lag, freshness, fallback events, rate-limit status, last error. Mirrors the existing `getDataSummary` endpoint at a higher cadence.

**Backend prerequisites:**

- The market-data service already has `getSourceStatus()` — the snapshot's `system.sources_available` is derived from it.
- Need a richer `GET /api/data/sources/health` endpoint exposing per-source latency p50/p99, rate-limit headroom, last fallback timestamp, last error.

**Effort:** ~3 days. The existing market-data adapter pipeline already records most of this; just expose it.

**Files (new):** `server/market-data/health.ts`, `src/screens/MarketDataScreen.tsx`. Reuses existing market-data adapters.

---

### Data → Fundamentals

**What it would do:** placeholder for fundamentals data sources (earnings calendars, dividends, splits, fundamentals snapshots). The system today doesn't ingest fundamentals.

**Backend prerequisites:** **major** — no fundamentals pipeline exists. Pre-requisite is a fundamentals-source adapter, a parquet store namespace, and probably a new entry in `config/market-data.json`.

**Effort:** unbounded (full new data plane). **Recommend deferring indefinitely** unless a strategy actually needs fundamentals.

---

## Models

### Models → Strategies

**What it would do:** strategy-level config knobs (cooldown timers, signal-staleness thresholds, semi-auto whitelists per strategy). Today these live in `config/portfolios.json` under each strategy entry.

**Backend prerequisites:** the Strategy lifecycle registry from Phase 2d covers state, but not config. Need:

- `GET /api/strategies/:id/config` reading the relevant slice of `portfolios.json`.
- `PUT /api/strategies/:id/config` updating it (atomic write to `portfolios.json`).
- Hot-reload from the strategy runner when config changes.

**Effort:** ~3–5 days. The hot-reload path is the tricky part — the runner currently caches config at boot.

**Files (new):** `src/screens/StrategiesConfigScreen.tsx`. Modified: `server/strategy/runner.js`, `server/index.js`.

---

### Models → Quality thresholds

**What it would do:** the Signals workspace's Quality chart shows per-model metrics. This screen sets the **thresholds** that flip a model's status badge from healthy → degraded → failed.

**Backend prerequisites:**

- New `config/quality_thresholds.yaml` (similar shape to `risk_limits.yaml`).
- `GET / PUT /api/models/:id/quality_thresholds`.
- The signal-store quality evaluator that emits `model_quality` rows already runs daily; this just decides how to interpret the rows.

**Effort:** ~3 days. The classification logic is a pure function of `model_quality` rows + thresholds, so it can run server-side in one place.

**Files (new):** `server/risk/quality_thresholds.ts`, `src/screens/QualityThresholdsScreen.tsx`. The classification can either live in `signal-orchestrator` or in `analytics`.

---

## System

### System → Accounts

**What it would do:** list of trading accounts (one per portfolio_id today; could be one-portfolio-many-accounts later). Add / disable / re-link a Schwab or IBKR account. Show last-sync time and reconciliation status.

**Backend prerequisites:** depends on **§4 (multi-account switcher)** in the v2 plan. Once portfolios are dynamic, this screen wraps the underlying CRUD.

**Effort:** ~1 week, gated on the multi-account work.

**Files (new):** `src/screens/AccountsScreen.tsx`. Modified: `server/index.js`, `config/portfolios.json` shape.

---

### System → Environments

**What it would do:** show the fully-resolved `app_env` / `trading_mode` / per-portfolio `execution_mode` lattice for the running server, plus the path to each config file. Today this info is in the Risk Dashboard chip + the Settings header crumb but not unified.

**Backend prerequisites:** none — everything is already in the snapshot. This is purely a presentation layer.

**Effort:** ~2 days. **Lowest-effort win** of the whole list; might be worth doing today.

**Files (new):** `src/screens/EnvironmentsScreen.tsx`.

---

### System → Secrets

**What it would do:** read-only audit of which secrets are present (Schwab refresh token, IBKR connection, MarketData token, NATS password). Never displays the secrets — just "set / not set / expires in X" status, paths to the relevant `.env` keys, and a "Re-auth" button per source where applicable.

**Backend prerequisites:**

- The Schwab token expiry is already in the snapshot (`system.schwab_token`). Good.
- New `GET /api/secrets/status` returning a `Record<string, { set: boolean; expires_at?: string; instructions?: string }>` for the other secrets.
- Each adapter knows whether its required env var is set — that check already happens at boot.

**Effort:** ~3 days. Care with audit-log of who viewed the screen (the values aren't displayed but knowing-the-shape is information).

**Files (new):** `server/auth/secrets-status.ts`, `src/screens/SecretsScreen.tsx`. Modified: every adapter to expose a `requiresEnv()` array.

---

## Activity

### Activity → Alerts

**What it would do:** alert-routing config (which `{type, level, ...}` tuples go to which channel — Slack, email, Discord, internal log only). Mute rules. Recent alerts stream.

**Backend prerequisites:** **major** — no alert routing today. The system emits structured logs and `alert` WS messages but doesn't fan them out.

- New `config/alerts.yaml` with rule entries.
- New `server/alerts/router.ts` consuming the existing `pushAlert` events and dispatching per rule.
- Channel adapters (start with one — Slack webhook is easiest).

**Effort:** ~1–2 weeks for a useful baseline.

**Files (new):** `server/alerts/router.ts`, `server/alerts/channels/slack.ts`, `src/screens/AlertsScreen.tsx`.

---

### Activity → Exports

**What it would do:** export workflows — daily P&L snapshot to CSV, audit chain dump for a date range, trade journal export, model quality CSV.

**Backend prerequisites:**

- New `GET /api/exports/:kind?from=&to=&format=` returning a streamed CSV / Parquet / JSON.
- Most of the data already exists in DuckDB — this is a SQL-and-stream layer.

**Effort:** ~3–5 days. The hardest part is choosing what to expose without leaking schema details.

**Files (new):** `server/exports/api.ts`, `src/screens/ExportsScreen.tsx`.

---

## Pickup priority

If picking up, in roughly increasing effort:

1. **System → Environments** (~2 days, no backend) — easy first win.
2. **Risk → Policies** (~5 days) — useful operationally.
3. **Models → Quality thresholds** (~3 days) — completes the Signals workspace story.
4. **Data → Market data** (~3 days) — surfaces what already exists.
5. **System → Secrets** (~3 days) — operationally useful, careful with information disclosure.
6. **Activity → Exports** (~5 days) — common operator ask.
7. **Models → Strategies config** (~5 days) — needs hot-reload care.
8. **Risk → Emergency** (~1 week) — needs per-portfolio halt support.
9. **Activity → Alerts** (~1–2 weeks) — biggest scope, biggest payoff.
10. **System → Accounts** — gated on v2 plan §4 (multi-account switcher).
11. **Data → Fundamentals** — recommend deferring indefinitely.

Each of these is independent and shippable solo. They'd land as one commit per section per the existing pattern (Phase X in commit messages).
