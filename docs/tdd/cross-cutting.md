# Cross-Cutting Concerns — Reference TDD

Parent: [TRADING-SYSTEM-TDD.md](../TRADING-SYSTEM-TDD.md)

---

Short reference for cross-cutting concerns not fully covered by the component TDDs. The observability framework has its own dedicated TDD at [tdd/observability.md](observability.md) — see §8 below. The existing system-health-vs-business-observability split documented in the [top-level TDD](../TRADING-SYSTEM-TDD.md#observability) remains as specified there.

---

### 1. Auth & secrets

Authentication is **enforced on every HTTP endpoint and WebSocket**. There is no "cluster trust" exception — every caller (human operator, scheduler container, ad-hoc CLI script, future watchdog) presents a bearer token; missing or invalid tokens → `401`, insufficient scope → `403`. The same token model covers reading the GUI, submitting an order, kicking off a backfill, and editing risk limits — there are no separate "management" vs "write-job" categories.

#### 1.1 Token model

- **Bearer tokens** — 256 bits of entropy (32 random bytes, hex-encoded). Plaintext returned **only once** at issuance.
- **Storage** — SHA-256 hash at rest in a single JSON file at `data/secrets/tokens.json` (path override via `TOKEN_STORE_PATH`). Atomic writes via tmp + rename.
- **Lookups** — constant-time via `timingSafeEqual` on the hash.
- **Per-token metadata** — `token_id` (stable identifier, separate from the secret), `actor` (recorded on every action the token performs), `scopes` (array; `["*"]` is wildcard), `issued_at`, `revoked` (kept post-revocation for audit-trail integrity).

#### 1.2 Scope catalog

A single flat catalog. Each endpoint requires one or more scopes; a token's `scopes` list must intersect the requirement.

| Scope                         | What it permits                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| _(any valid token)_           | `GET /api/whoami` — returns the calling token's `{token_id, actor, scopes}`. No scope required. |
| `read:portfolio`              | `GET /api/portfolio/*`, snapshot subscriptions on `/ws/state`                                   |
| `read:audit`                  | `GET /api/trades/inspect`, audit log screen                                                     |
| `read:risk-limits`            | `GET /api/risk/limits`                                                                          |
| `read:strategy`               | `GET /api/strategies`, drift / gate-decision sub-routes                                         |
| `read:catalog`                | `GET /api/catalog`, qo-run drill-down                                                           |
| `read:freshness`              | `GET /api/catalog/freshness`, bridge-status views                                               |
| `read:alerts`                 | `GET /api/alerts/recent`, rules editor read                                                     |
| `submit:order`                | `POST /api/orders` (operator manual entry through OPL)                                          |
| `cancel:order`                | `POST /api/orders/:id/cancel`                                                                   |
| `liquidate:position`          | `POST /api/positions/:id/liquidate`, `POST /api/positions/liquidate` (multi-select)             |
| `transition:strategy`         | `POST /api/strategies/:id/transition`                                                           |
| `notes:strategy`              | `PUT /api/strategies/:id/notes`. **Portfolio-scoped** via path-param match (see below).         |
| `write:risk-limits`           | `PUT /api/risk/limits/:portfolio`. **Portfolio-scoped** via path-param match (see below).       |
| `write:alerts`                | `PUT /api/alerts/rules`, `POST /api/alerts/test`                                                |
| `write:strategy-config`       | `POST /api/strategies`, `PUT /api/strategies/:id/config`                                        |
| `submit:write-job`            | `POST /api/write-jobs` (any kind)                                                               |
| `issue:token`, `revoke:token` | Token administration                                                                            |
| `*`                           | Wildcard — admin / cron-server convenience                                                      |

**Portfolio-scoped scopes.** A few scopes (`notes:strategy`, `write:risk-limits`) write to per-portfolio resources. A token can be issued with the scope **bound to a specific portfolio** via the `--portfolio <id>` flag at issuance — the token's stored scope entry is then `notes:strategy:<portfolio_id>` (catalog name + portfolio suffix). The auth middleware checks both forms: `notes:strategy` (unscoped) or `notes:strategy:<portfolio_id>` (scoped) grants access; `notes:strategy:portfolio_a` does **not** grant access to portfolio_b's resources. Unscoped issuance grants cross-portfolio access — useful for the operator's primary token; scoped issuance is the way to delegate access for one portfolio (e.g., a per-strategy CI run that should not be able to touch other portfolios).

The scope set on a token defines what it can do; there is no built-in tier (`viewer` / `operator` / `admin`). Composition is the operator's choice at issuance time. Typical bundles:

- **Operator** — full read set plus `submit:order`, `cancel:order`, `liquidate:position`, `transition:strategy`, `notes:strategy`, `write:risk-limits`, `write:alerts`, `submit:write-job`.
- **Read-only watchdog** — `read:portfolio` + whatever else it needs to scrape.
- **Scheduler container** — `submit:write-job` only.

Per-kind sub-scoping of `submit:write-job` (e.g. `submit:write-job:fmp-backfill`) is a future option if any holder needs restricted job-kind access; today the single scope is the only granularity.

#### 1.3 WebSocket auth — one-shot ticket exchange

The browser WebSocket API can't set custom headers on the upgrade, so the bearer token cannot ride in an `Authorization` header. Putting the plaintext token in the URL query is unsafe — URLs land in reverse-proxy access logs, browser history, devtools Network tab, and `Referer` headers. A token with `submit:order` / `liquidate:position` would be extractable from any of those.

QF uses a **one-shot upgrade ticket** instead. The client authenticates once via HTTP, exchanges its bearer for a short-lived single-use ticket, and presents only the ticket on the WebSocket URL:

1. **Mint a ticket.** Client POSTs to `/api/ws/ticket` with the normal `Authorization: Bearer <token>` header. Server validates the token and mints a fresh ticket: 256 bits of entropy, hex-encoded, scoped to the same `(token_id, scopes, actor)`. Stored in-memory only (no DB write) with a 30-second TTL and a `consumed: false` flag.

   ```http
   POST /api/ws/ticket HTTP/1.1
   Authorization: Bearer <plaintext-token>

   HTTP/1.1 200 OK
   Content-Type: application/json

   { "ticket": "<plaintext-ticket>", "expires_at": "2026-05-27T18:30:30Z" }
   ```

2. **Open the WebSocket.** Client opens `ws://host/ws/state?ticket=<plaintext-ticket>`. On upgrade the server looks up the ticket, atomically marks it `consumed: true`, and attaches the original token's `(token_id, scopes, actor)` to the connection. Only events the connection's scope set covers are pushed (a `read:portfolio`-only token receives portfolio snapshots but not strategy drift events).
3. **Reject the ticket on second use.** A ticket that's already `consumed` (or expired, or unknown) is rejected with close code `4400`. Honest clients only ever present a ticket once.

Tickets are not logged in plaintext; only the resolved `token_id` and `actor` appear in request logs. The bearer token itself never lands in any URL, access log, or browser history surface — it only ever travels in an `Authorization` header on a single HTTP request.

**Token leak surface, before and after:**

| Surface                          | Bearer in URL (old) | Ticket in URL (new)                                    |
| -------------------------------- | ------------------- | ------------------------------------------------------ |
| Reverse-proxy access log         | Plaintext bearer    | Single-use ticket (already-consumed by retrieval time) |
| Browser history                  | Plaintext bearer    | Single-use ticket                                      |
| Browser devtools Network tab     | Plaintext bearer    | Single-use ticket                                      |
| Referer header on outbound links | Plaintext bearer    | Single-use ticket                                      |

A ticket pulled from any of those sources is already consumed by the time anyone reads it; replay produces a `4400` close on the WebSocket and no privilege escalation.

#### 1.4 Failure modes

| Reason                       | HTTP / WS                             |
| ---------------------------- | ------------------------------------- |
| `missing_bearer_token`       | `401` (HTTP) / close code `4401` (WS) |
| `invalid_or_revoked_token`   | `401` / close `4401`                  |
| `scope_missing`              | `403` / close `4403`                  |
| `invalid_or_consumed_ticket` | n/a / close `4400` (WS upgrade only)  |
| `expired_ticket`             | n/a / close `4400`                    |

#### 1.5 Issuance and rotation

```bash
# Issue an operator token
npm run issue-token -- \
  --actor operator:awagner \
  --scopes "read:portfolio,read:audit,read:risk-limits,read:strategy,read:catalog,read:freshness,read:alerts,submit:order,cancel:order,liquidate:position,transition:strategy,notes:strategy,write:risk-limits,write:alerts,submit:write-job"

# Issue a scheduler-container token
npm run issue-token -- --actor scheduler-container --scopes "submit:write-job"

# Issue an admin / cron-server token
npm run issue-token -- --actor cron-server --scopes "*"
```

Plaintext is printed once — capture it into your secrets manager immediately, named per actor. Revoke via `token_id` if the secret leaks; the entry is kept (`revoked: true`) for audit-trail integrity.

**Token expiry policy.** Tokens have **no expiration** at v1. Leak handling is `revoke:token` + reissue, not auto-rotation. Rationale: the deployment is single-operator + a small number of automated actors (scheduler container, future CI), each with a long-lived role; mandatory rotation adds operational burden disproportionate to the threat in this trust environment. The policy is revisited when (a) more than 5 active tokens exist, (b) any token is held by a third party, or (c) the deployment expands to multi-operator. Until any of those trigger, the operator-side practice is: keep tokens in a secrets manager, revoke + reissue on a known compromise or on suspicion, and audit `tokens.json` once per quarter for actors that should no longer be issued.

**Manual rotation cadence (recommended, not enforced).** Operator's primary token: rotate once per year or on any secrets-manager re-keying. Scheduler-container token: rotate on container image refreshes that touch the auth surface. Wildcard `*` tokens: rotate quarterly. The `revoked: true` rows in `tokens.json` stay forever for audit-trail integrity — pruning is **not** part of rotation. (If `tokens.json` ever grows large enough to matter, a separate archive process drops rows older than N years; not needed at v1.)

#### 1.6 Friction primitives stay alongside scopes

Auth answers _is this caller allowed to do this?_; the GUI's `LIQUIDATE` and `FIRE` typed-confirmation primitives ([gui.md §2](gui.md) and [§3](gui.md)) answer _is this caller intentionally doing it right now?_ Both gates apply — a token with `liquidate:position` scope still has to type `LIQUIDATE` in the modal before the button enables. Defense in depth; one layer guards against unauthorized actors, the other against authorized actors fat-fingering.

#### 1.7 Secrets management across runtimes

Broker creds, NATS creds, MinIO/S3 keys, the token-store hash file, and any future credentials live in a single secrets backend: environment variables locally, a secrets manager on the server. **The TS server is the only direct reader of the backend.** Per-broker NT bundles (per [broker-integration.md](broker-integration.md)) read their own scoped broker credentials from their own env; QF does not provision broker creds to NT runtimes.

| Secret                                                        | Where stored               | Accessed by                                                                 |
| ------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| `MD_TOKEN` (MarketData.app collection)                        | `.env`                     | Collection scripts (see [collection.md](../data/collection.md))             |
| `SCHWAB_APP_KEY`, `SCHWAB_APP_SECRET`, `SCHWAB_REFRESH_TOKEN` | `.env` on Schwab NT bundle | Schwab bundle's `SchwabAuth` helper                                         |
| IBKR credentials                                              | IB Gateway config          | IBKR NT bundle                                                              |
| Bearer-token hashes                                           | `data/secrets/tokens.json` | TS server auth middleware                                                   |
| NATS — no auth at v1 (see below)                              | n/a                        | TS server + every NT bundle (localhost connection)                          |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY`                              | `.env` on TS server        | TS server (only direct MinIO writer; per [write-jobs.md §1](write-jobs.md)) |

Secrets are never committed to the repo, never logged, never included in API responses or metrics labels. `.env` is in `.gitignore`.

**Secrets provider abstraction (QF-349).** The TS server and Python broker bridges (Schwab NT, IBKR NT) consume secrets through a unified `SecretsProvider` interface:

- **TypeScript:** `server/secrets/index.ts` exports `createSecretsProvider() => SecretsProvider`, with methods `resolve(key) => Promise<string>` and `resolveSync(key) => string`. Singleton via `getSecretsProvider()`.
- **Python:** `research/magpie-secrets/src/magpie_secrets/provider.py` exports the same interface as `create_secrets_provider()` and `get_secrets_provider()`. Both are synchronous in Python (no Promise equivalent). Imported by broker bridges and risk-gate plugin.

**Backend chain:** 1Password CLI → environment variables. The provider checks `OP_<key>` env var for a 1Password path (`op://<vault>/<item>/<field>`); if set, runs `op read <path>` via subprocess. On failure (CLI not installed, path invalid, timeout), falls back to `process.env[key]` or `os.environ[key]`. **Fallback ensures nothing breaks if 1Password is unavailable**—important for public open-source release that uses plain `.env` files.

**Caching:** TTL-based in-memory cache (default 5 minutes) to avoid repeated CLI invocations. Call `provider.clear()` to invalidate all entries. Useful for local dev where env vars change between test runs.

**Migration path:** Existing code that reads `process.env["SCHWAB_APP_KEY"]` is left as-is during the transition. At call sites that already exist (e.g., Schwab NT's `getAccessToken()`), wrap the env read in a provider call for reference implementation. Future expansion: update all broker/market-data adapters to use the provider. See [research/magpie-schwab-nt docs](../../research/magpie-schwab-nt) for the first migrated callsite.

**Typed errors:** Both backends export `SecretResolutionError(key: str, reason: str)` with `.key` and `.reason` attributes, allowing callers to distinguish missing secrets from other exceptions.

**Out of scope:** Secret rotation automation (QF-349 deferred). The provider assumes secrets are managed externally (1Password on the server, `.env` for local dev or CI). Rotating a secret requires updating the source (1Password or `.env`) and restarting the process (or calling `provider.clear()` in Python for selective invalidation).

#### 1.8 NATS auth + binding

NATS is **bound to 127.0.0.1 only** on the deployment host (`your-server`). The TS server, the per-broker NT bundles, and the audit observer all connect over localhost. There is no NATS-level authentication: any process on the host with `NATS_URL=nats://localhost:4222` can publish or subscribe on any subject.

This is **adequate for the current trust model** (single-operator deployment, all QF processes on one host) and **inadequate the moment NATS is exposed off-localhost**. The subjects involved (`orders.gate.<broker>`, `orders.submit.<broker>`, `orders.exec_reports.<broker>`) carry money-moving authority — a LAN-routable NATS would let any LAN device publish forged gate-approve replies or fill events. Two threats to consider:

- **Co-tenant processes on the host.** Any process running as the same user can read / publish on the bus. Treat the host as a trust boundary; co-tenant containers must be QF components (or the operator's own admin sessions), not third-party software.
- **Off-localhost expansion.** If a future change moves NATS off-localhost (multi-host deploy, remote bundle on a different machine, AWS migration), the deploy is **not safe to ship without NKey-based auth + subject-level ACLs**. Sketch of the target posture:
  - Each service gets a distinct NKey identity (one per: TS server, Schwab bundle, IBKR bundle, audit observer, scheduler container).
  - Subject ACLs grant publish / subscribe permissions per identity (TS server can publish `orders.submit.*` and `orders.gate.*` reply; bundles can publish `orders.exec_reports.*` and subscribe to `orders.submit.<their broker>`; etc.).
  - NKey seeds live in the per-service secrets surface (a secrets manager / `.env`) alongside the existing broker credentials.

The migration is a Phase-N follow-up — file a ticket when off-localhost NATS becomes a real planned change.

**Operator-visible posture today:**

```bash
# NATS listen-address in docker-compose.yml ships at 127.0.0.1:4222
docker compose ps nats   # should show 127.0.0.1:4222->4222/tcp, not 0.0.0.0:4222

# Connect string used by every QF process:
NATS_URL=nats://localhost:4222   # no auth fields
```

If `docker compose ps` shows NATS bound to `0.0.0.0:4222`, that's a misconfiguration — the deployment is exposing the unauthenticated message bus to the LAN. Fix the compose service's `ports:` mapping to `127.0.0.1:4222:4222` before continuing.

### 2. Time & Market Calendar

**Canonical clock:** `Date.now()` on the server (UTC). Every timestamp in the system is UTC. No local timezones in data or wire formats. The server's clock is assumed accurate (NTP-synchronized via `chrony` — see "Multi-host wall-clock sync" below).

**Event-time vs ingest-time:** Every record carries both:

- `asof` / `event_time` — when the event happened (adapter-asserted for upstream events, market timestamp for quotes).
- `ingest_ts` / `fetched_at` — when the system received it.

Backtests replay in event-time; live operations use wall-clock time. The distinction is maintained everywhere so backtests are deterministic.

**Market calendar:**

The calendar answers: "is the market open right now?", "when is the next open/close?", "what is the next session close for a strategy submitting at 15:50 ET?"

**v1 implementation:** A static JSON file covering US equity and major futures exchanges:

```
config/market-calendar.json
```

```jsonc
{
  "exchanges": {
    "US_EQUITY": {
      "regular_hours": { "open": "09:30", "close": "16:00", "tz": "America/New_York" },
      "half_days": ["2026-11-27", "2026-12-24"],
      "holidays": ["2026-01-01", "2026-01-19", "2026-02-16" /* ... */],
      "half_day_close": "13:00",
    },
    "CME": {
      "regular_hours": { "open": "17:00", "close": "16:00", "tz": "America/Chicago" },
      "note": "nearly 23h session, Sun-Fri",
      "holidays": [
        /* CME-specific */
      ],
    },
  },
}
```

**Interface:**

```ts
// server/calendar/index.ts
export interface Calendar {
  isMarketOpen(exchange: string, timestamp: Date): boolean;
  nextOpen(exchange: string, timestamp: Date): Date;
  nextClose(exchange: string, timestamp: Date): Date;
  isTradingDay(exchange: string, date: Date): boolean;
  tradingDaysBetween(exchange: string, from: Date, to: Date): string[];
}

export function createCalendar(config: CalendarConfig): Calendar { ... }
```

Strategy code and the Portfolio Engine consume this interface to resolve session-relative timestamps (e.g. `next_open`, `next_close`) into concrete UTC instants.

**Maintenance:** The calendar file is updated manually once per year when exchange holiday schedules are published. This is a 10-minute task. Automated calendar sources (e.g., exchange APIs) are a follow-on.

**Trading-day boundaries.** A "day" in this system means an _exchange trading session_, not a calendar day. NYSE's 2026-05-01 ends at 20:00 UTC; CME has its own boundaries; Eurex / TSE / HKEX each different again. The `server/calendar/` module is the single source of truth for which UTC instants belong to which exchange-day. Other QF runtimes (per-broker NT bundles, future Python services) consume this calendar via the server's data API rather than re-implementing it. Cross-exchange portfolios (e.g. SPY + ES) reconcile at the latest of the relevant session closes for the day.

**Display timezone (paper / live UI only).** Per-user GUI setting; defaults to the browser's detected timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Persisted in the existing user-prefs store. The UI converts UTC ↔ display tz at the rendering boundary; **nothing in the data layer knows about the user's tz**. Backtest result views may default to the _exchange_'s local time for time-series displays (strategies are exchange-anchored), with a toggle to user-tz.

**Multi-host wall-clock sync.** When adapter workers run on separate hosts they timestamp events at emission, and audit-chain ordering depends on those timestamps being comparable across hosts. NTP skew of >100ms can flip the apparent order of two events ("did this fill arrive before or after that quote update?"). Specify: every host runs `chrony` (or equivalent) against a common NTP source. **The server rejects incoming messages whose `asof` timestamp drifts more than 5s from server wall clock** (configurable; covers both clock drift and replay attacks). Backtest mode is unaffected — NautilusTrader's simulated clock is the single source of time during a run.

**Future direction — broker-sourced calendars.** Both Schwab (`/marketdata/{market}/hours`) and IBKR (contract `tradingHours`) expose live trading-hours endpoints. The static JSON could be replaced by (or augmented with) a broker-sourced feed once a strategy hits the limits of the manual yearly update — e.g. unscheduled half-days, exchange-specific early closes the static file missed. Not on the current roadmap; flagged as the obvious next step when calendar drift becomes a real incident.

### 3. System-wide config layout

The system has the following config files, each with its own reload watcher:

| File                          | Scope                                                     | Defined in                                      |
| ----------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| `config/market-data.json`     | Market Data: bridge subscriptions, freshness, NATS topics | [Data plane TDD](../data/data-plane.md)         |
| `config/portfolios.json`      | Portfolios, risk limits, broker routing, reconciliation   | This section                                    |
| `config/market-calendar.json` | Market hours, holidays                                    | §2 above                                        |
| `config/brokers.json`         | Broker bundle wiring (credential host, NATS, accounts)    | [Broker integration TDD](broker-integration.md) |

Strategy registration is **not** in `config/portfolios.json` — strategies are NT-resident in the magpie-strategies repo and enabled / disabled via the lifecycle registry (`server/strategy/lifecycle.ts`). The portfolios file declares which broker and which risk envelope a portfolio uses; what trades inside that envelope is registry state.

**`config/portfolios.json` schema (v1):**

```jsonc
{
  "portfolios": {
    "main": {
      "broker": "ibkr", // which broker (per broker-integration.md) routes this portfolio's submissions
      "initial_cash": 100000,
      "limits": {
        "max_net_delta": 50, // absolute delta
        "max_net_vega": 100, // absolute vega
        "max_daily_loss": 5000, // halt trigger
        "max_symbol_concentration": 20, // per-symbol delta
        "max_drawdown": 10000, // halt trigger
        "max_order_size": 10, // quantity per intent
        "max_open_orders": 20, // pending orders
      },
      "reconciliation": {
        "interval_seconds": 60,
        "halt_on_drift": true,
      },
    },
  },
}
```

All portfolio config is reloadable via file-watch. Risk-limit edits via the GUI go through `PUT /api/risk/limits/:portfolio` (per [§1.2](#12-scope-catalog)) and the server rewrites the file; the file is the source of truth on reload.

### 4. Schema versioning (system-wide)

Wire contracts that cross process or machine boundaries are versioned; internal types are not (until they become wire contracts).

| Type                      | Status                                                                                          | Versioning approach                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audit chain (DuckDB)**  | `audit_intents` / `audit_orders` / `audit_fills` per §5; `portfolio_snapshots` per §5           | Schema is the version. Migrations via `ALTER TABLE` when columns are added; new optional columns are backwards-compatible by default. No `v` field in rows.                                       |
| **Gate RPC**              | Per [risk-gate-architecture.md](risk-gate-architecture.md) — sync NATS RPC, parent-intent shape | Wire contract (TS server ↔ Python NT bundle). Versioned via a `protocol_version` field in the request envelope. Bumps require coordinated deploys.                                                |
| **NATS subjects**         | `orders.{submit,cancel}.<broker>`, `orders.exec_reports.<broker>`, `marketdata.*.<broker>.*`    | Topic name carries the version implicitly via the broker / subject taxonomy. Payload schemas are versioned per-subject with an envelope `v` when they change shape.                               |
| **OrderIntent (in-proc)** | Defined in [order-execution.md](order-execution.md)                                             | Internal-only — never leaves the TS server process. Not versioned.                                                                                                                                |
| **Portfolio state**       | Derived from `audit_fills` + `portfolio_snapshots`                                              | Not independently versioned — it's computed, not stored.                                                                                                                                          |
| **Config files**          | §3 above                                                                                        | No version field. Config schemas are validated on load; unknown keys are ignored (forward-compatible). Breaking changes are handled by migration scripts on the file, not by version negotiation. |

**v1 principle:** Only version wire contracts that cross process or machine boundaries. Internal types (OrderIntent, in-proc portfolio state) don't need versioning until the system is distributed. The audit chain isn't a wire contract but it's persisted forever — the schema-as-version rule plus additive-only migrations is the contract.

### 5. Database schema (consolidated)

All DuckDB tables in the system. Single reference for an implementer setting up the database on day one. Table schemas are defined in detail in their owning component TDD — this section is the index with full `CREATE TABLE` statements.

**Initialization:** All tables are created at server startup in [`server/db/init.ts`](../../server/db/init.ts). The init function runs each `CREATE TABLE IF NOT EXISTS` statement in order. No ORM — raw SQL via the shared DuckDB connection.

#### Audit trail tables

Three tables joined `audit_intents → audit_orders → audit_fills` on `intent_id` and `order_id`. Each table carries a `source ∈ {qf, qf-gated, nt-native}` column identifying which surface wrote the row (Model A — writer-identity sourcing). A fourth value `backtest-gated` is reserved for `audit_intents` rows produced by the [backtest gate CLI](backtest-gate.md); those rows live only in the Minio backtest archive, never in the live DuckDB. Each table also carries a `correlation_id` column threaded by the originating writer per [observability.md §4.2](observability.md#42-correlation-id-propagation) — the framework's acceptance test ("reconstruct the full course of events for a single position lifecycle by querying a single `correlation_id`") joins on this column across the three tables. See [order-flow.md §4](order-flow.md#4-audit-chain) for the full writer mapping and dedup contract.

```sql
CREATE TABLE IF NOT EXISTS audit_intents (
  intent_id              VARCHAR PRIMARY KEY,  -- ULID, assigned at submit
  source                 VARCHAR NOT NULL,     -- 'qf' | 'qf-gated' | 'nt-native' (live DB); 'backtest-gated' also valid in backtest-archive parquet only — see backtest-gate.md
  correlation_id         VARCHAR NOT NULL,     -- ULID, threaded from the lifecycle anchor; observability.md §4.2
  portfolio              VARCHAR NOT NULL,
  strategy_id            VARCHAR,              -- nullable for operator manual *entry* (no strategy attribution). On closes: originating position's strategy_id when set; sentinel '__operator__' when closing a position that was itself operator-originated. See order-execution.md §1 for the sentinel rule.
  action                 VARCHAR NOT NULL,     -- 'open' | 'close'
  symbol                 VARCHAR NOT NULL,
  direction              VARCHAR NOT NULL,
  quantity               INTEGER NOT NULL,
  reason                 VARCHAR NOT NULL,     -- structured values when system-originated ('operator_manual', 'exit_rule_<rule>'); free-text from operator on manual entry (validated at the OPL boundary: max 500 chars, control characters stripped). Never null.
  position_id            VARCHAR,              -- set when action='close'
  exec_algorithm_id      VARCHAR,              -- when set, NT-side ExecAlgorithm handles pricing / repeg / slicing
  exec_algorithm_params  VARCHAR,              -- JSON-encoded params for the algo. Validated against the algo's handler-specific JSON Schema at the OPL boundary before insertion; max 4 KiB serialized.
  gate_decision          VARCHAR,              -- 'approve' | 'reject', set when source='qf-gated' or 'backtest-gated'
  gate_reason            VARCHAR,              -- gate-side rejection reason, set only on gate reject
  envelope_revoked_at    TIMESTAMP,            -- set when QF revokes a previously-approved envelope; see risk-gate-architecture.md §3.5
  envelope_revoke_reason VARCHAR,              -- structured RevokeReason ('portfolio_halted' | 'strategy_halted' | 'drift_hard_trip' | 'concentration_breach_other_strategy' | 'operator_initiated'); set iff envelope_revoked_at is set
  status                 VARCHAR NOT NULL,     -- 'proposed' | 'risk_check' | 'approved' | 'rejected' | ...
  created_at             TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_intents_correlation ON audit_intents(correlation_id);

CREATE TABLE IF NOT EXISTS audit_orders (
  order_id          VARCHAR PRIMARY KEY,  -- ULID
  intent_id         VARCHAR NOT NULL REFERENCES audit_intents(intent_id),
  -- QF-310: broker-side idempotency token. Populated by OPL at
  -- order construction (BEFORE any broker call), forwarded by the
  -- Python NT bridge to the broker's native client_order_id field
  -- (e.g. Schwab REST `clientOrderId`). v1: equals intent_id. Retries
  -- that create a new order_id reuse the same client_order_id, giving
  -- the broker a stable dedup key across attempts. INSERT-only —
  -- never mutated on the upsert UPDATE list. Nullable in schema
  -- (DDL-level NOT NULL deferred so the additive ALTER for existing
  -- installs doesn't need a backfill; OPL always populates).
  -- See broker-integration.md §4.1.
  client_order_id   VARCHAR,
  correlation_id    VARCHAR NOT NULL,     -- inherited from the parent intent; same value across all rows in a lifecycle
  parent_order_id   VARCHAR,              -- set when this order is a child of another (algo-emitted child orders carry the parent's broker_order_id)
  source            VARCHAR NOT NULL,     -- 'qf' | 'nt-native' (typically inherits from intent.source but may differ for algo-emitted children)
  broker            VARCHAR NOT NULL,
  status            VARCHAR NOT NULL,     -- current status (snapshot, upserted on every transition)
  created_at        TIMESTAMP NOT NULL,
  risk_checked_at   TIMESTAMP,
  approved_at       TIMESTAMP,
  submitted_at      TIMESTAMP,
  completed_at      TIMESTAMP,
  broker_order_id   VARCHAR,
  -- Rejection-reason capture. Exactly one of {risk_violations, halt_reason,
  -- broker_reason} is populated on a rejection row; all three null on
  -- non-rejection rows.
  --   risk_violations: JSON array of Violation objects
  --     ({limit, current, proposed, threshold, action}). Set when the
  --     QF risk gate or canExecute rejected the intent.
  --   halt_reason: per-strategy / per-portfolio halt label
  --     ('strategy_halted', 'portfolio_halted', 'recon_drift') when a
  --     submission was rejected due to a halt state.
  --   broker_reason: broker-side rejection reason as returned by the
  --     broker (e.g. 'INSUFFICIENT_MARGIN', 'MARKET_CLOSED', vendor code).
  --     Carried forward from BrokerExecReport.rejection_reason per
  --     broker-integration.md §4.1.
  risk_violations   VARCHAR,
  halt_reason       VARCHAR,
  broker_reason     VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_audit_orders_correlation ON audit_orders(correlation_id);
-- QF-310: dedup-lookup index for "do we already have an audit_orders
-- row for this client_order_id?" queries (used by the future retry
-- path; today the broker is the canonical dedup authority).
CREATE INDEX IF NOT EXISTS idx_audit_orders_client_order_id ON audit_orders(client_order_id);

CREATE TABLE IF NOT EXISTS audit_fills (
  fill_id         VARCHAR PRIMARY KEY,  -- ULID
  order_id        VARCHAR NOT NULL REFERENCES audit_orders(order_id),
  correlation_id  VARCHAR NOT NULL,     -- inherited from the parent order
  source          VARCHAR NOT NULL,     -- 'qf' | 'nt-native' (matches the audit_orders row that produced it)
  price           DOUBLE  NOT NULL,
  quantity        INTEGER NOT NULL,
  fees            DOUBLE,
  filled_at       TIMESTAMP NOT NULL,
  -- Producer rule for expected_price + slippage:
  --   OPL writers (source='qf') populate both: expected_price from the
  --   intent's reference price (limit price for limit orders, last quote
  --   mid for market orders captured at submit time); slippage is the
  --   signed difference (filled price vs expected, direction-aware).
  --   Audit observer writers (source='nt-native') leave both NULL —
  --   the observer sees the broker fill but not the strategy's reference
  --   price.
  -- Consumer rule for the drift-monitor's slippage aggregate
  -- (portfolio-risk-engine.md §"Strategy drift monitoring"): aggregate
  -- only over rows with expected_price IS NOT NULL; do NOT treat NULL as
  -- zero-slippage, which would understate observed slippage.
  expected_price  DOUBLE,
  slippage        DOUBLE
);
CREATE INDEX IF NOT EXISTS idx_audit_fills_correlation ON audit_fills(correlation_id);
```

Pricing decisions are made NT-side inside `ExecAlgorithm` plugins; each child order **is** the audit of one pricing decision, and the parent-child structure in `audit_orders` (`parent_order_id`) is the chain.

Join chain: `audit_fills.order_id → audit_orders.order_id → audit_orders.intent_id → audit_intents.intent_id`. The Trade Inspector endpoint (`GET /api/trades/inspect?fill_id=…`) implements the join; the `?intent_id=…` mode walks downstream from a gate decision through the full child-order fan-out. See [order-flow.md §4](order-flow.md#4-audit-chain) for the writer mapping + observer dedup contract.

#### Portfolio tables

**`portfolio_snapshots`** — Historical P&L, risk headroom, and portfolio state.
Written by: Portfolio Engine (on fill, end-of-day, market open). Read by: GUI Risk Dashboard.
Defined in: [Portfolio & Risk Engine TDD](portfolio-risk-engine.md), §7.

```sql
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  portfolio       VARCHAR NOT NULL,
  snapshot_ts     TIMESTAMP NOT NULL,
  trigger         VARCHAR NOT NULL,
  cash            DOUBLE  NOT NULL,
  equity          DOUBLE  NOT NULL,
  realized_pnl    DOUBLE  NOT NULL,
  unrealized_pnl  DOUBLE  NOT NULL,
  daily_realized  DOUBLE  NOT NULL,
  net_delta       DOUBLE  NOT NULL,
  net_vega        DOUBLE  NOT NULL,
  drawdown        DOUBLE  NOT NULL,
  peak_equity     DOUBLE  NOT NULL,
  positions_count INTEGER NOT NULL,
  halted          BOOLEAN NOT NULL,
  data_stale      BOOLEAN NOT NULL,
  PRIMARY KEY (portfolio, snapshot_ts)
);
```

#### Drift tables

**`drift_alerts`** — One row per fire of a strategy-drift check. Backs the per-(strategy, metric)-per-day alert budget enforced by [drift-detector.md §3.3](drift-detector.md#33-alert-budget--multiple-comparisons-awareness).
Written by: drift detector (`server/risk/drift-detector.ts`). Read by: alert router (for de-dup checks); GUI Strategies tab (recent-drift sparkline).
Defined in: [drift-detector.md §7](drift-detector.md#7-the-drift_alerts-table).

```sql
CREATE TABLE IF NOT EXISTS drift_alerts (
  id                VARCHAR PRIMARY KEY,         -- ULID
  alert_type        VARCHAR NOT NULL,            -- 'drift_fast_floor' | 'drift_slow_distribution'
  strategy_id       VARCHAR NOT NULL,
  portfolio_id      VARCHAR NOT NULL,
  metric            VARCHAR NOT NULL,
  observed_json     VARCHAR NOT NULL,            -- JSON: scalar OR {ci_lower, ci_upper}
  spec_range_json   VARCHAR NOT NULL,            -- JSON: [lo, hi] OR {floor} OR {ceiling}
  baseline_source   VARCHAR NOT NULL,            -- 'spec' | 'qo_pinned' | 'computed_historical'
  sample_size       INTEGER NOT NULL,
  fired_at          TIMESTAMP NOT NULL,
  fired_date_utc    DATE NOT NULL,               -- denormalized for per-day budget queries
  correlation_id    VARCHAR NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drift_alerts_budget ON drift_alerts(strategy_id, metric, fired_date_utc);
CREATE INDEX IF NOT EXISTS idx_drift_alerts_correlation ON drift_alerts(correlation_id);
```

#### Backtest tables

Backtests run in the sibling `quant-optimizer` repo against the shared data lake. Sweep results land on disk as `wfo_results_*.json` and are indexed by the [qo-runs catalog collector](../../server/catalog/collectors/qo-runs.ts), not in a DuckDB table.

#### Summary

| Table                 | Rows at v1 scale       | Growth rate                                                       | Retention  | Notes                             |
| --------------------- | ---------------------- | ----------------------------------------------------------------- | ---------- | --------------------------------- |
| `audit_intents`       | Thousands/year         | Per submitted intent (strategy + operator)                        | Indefinite | Largest of the three audit tables |
| `audit_orders`        | Thousands/year         | Per approved intent (1+ rows per intent if algo-emitted children) | Indefinite |                                   |
| `audit_fills`         | Thousands/year         | Per fill event                                                    | Indefinite |                                   |
| `portfolio_snapshots` | Tens of thousands/year | Per fill + daily                                                  | Indefinite |                                   |

Total DuckDB footprint at v1: small. `audit_intents` is the largest of the live audit tables (one row per submitted intent — strategy or operator). Even with active strategies that submit thousands of intents per day, the chain stays well within DuckDB's comfort zone for indefinite retention.

### 6. TypeScript

The TS server is TypeScript-first with strict mode on. Remaining `.js` / `.jsx` files are tracked migration debt in [docs/MIGRATION-JSX-TS.md](../MIGRATION-JSX-TS.md); CLAUDE.md's "convert any file you meaningfully touch" rule governs day-to-day. [tsconfig.json](../../tsconfig.json) is the source of truth for compiler config — including `strict: true`, `noUncheckedIndexedAccess: true`, ESM via `module: NodeNext`, and `allowJs: true` for the remaining legacy files.

Pre-commit ([.pre-commit-config.yaml](../../.pre-commit-config.yaml)) enforces ESLint + Prettier + `tsc --noEmit` on every commit; CI runs the same checks. New code is TypeScript without exception.

Broker submission and market-data ingestion no longer live as TS-side adapters — both are NT-bundle resident per [broker-integration.md](broker-integration.md) and [data-plane.md](../data/data-plane.md). The TS server interacts with brokers exclusively through NATS subjects.

### 7. Data storage layer

The storage layer abstracts the data path so code works against either an object store (Parquet catalogs, write-once / read-many) or a persistent filesystem (DuckDB databases, append-only audit / log files). The architectural target is **AWS S3 + EFS** in a cloud deployment; the current substrate is **MinIO + local disk on your-server**. The same code paths cover both — see "Substrate mapping" below.

#### Architecture

```
                  Object store         Persistent filesystem
                  ────────────         ─────────────────────
Chain Parquet     s3://bucket/chains/
Macro Parquet     s3://bucket/macro/
Backtest results  s3://bucket/results/
Audit DuckDB                           data/portfolio.duckdb
Config files                           config/*.json
```

**S3 (or S3-compatible) for bulk read-many data.** DuckDB reads S3 Parquet natively (`read_parquet('s3://...')`). No code changes between substrates — only the path prefix and the S3 client `endpoint` field change.

**Persistent FS for the audit chain and configs.** The DuckDB tables in §5 (`audit_intents`, `audit_orders`, `audit_fills`, `portfolio_snapshots`) are the indefinitely-retained system of record; the DB file lives on a real filesystem (EFS in cloud, local disk on your-server) because DuckDB needs append-friendly POSIX semantics, not object-store semantics. Config files live on the same FS so file-watch reload works.

#### Configuration

```jsonc
// config/storage.json
{
  "chains_path": "s3://magpie-data/chains",
  "macro_path": "s3://magpie-data/macro",
  "results_path": "s3://magpie-data/results",
  "duckdb_path": "data/portfolio.duckdb", // local FS path; not S3

  // S3 client config (also applies to MinIO / R2 / GCS via endpoint)
  "s3": {
    "region": "us-east-1",
    "endpoint": "https://minio.example.com", // null on AWS; set for S3-compatibles
  },
}
```

Credentials come from the standard chain (env vars, IAM role, `~/.aws/credentials`). No credentials in config files.

#### DuckDB S3 integration

```sql
INSTALL httpfs;
LOAD httpfs;
SET s3_region = 'us-east-1';
SET s3_endpoint = 'minio.example.com';   -- omit on AWS
SET s3_use_ssl = true;
-- Credentials auto-loaded from AWS SDK chain
```

Once loaded, `read_parquet('s3://…')` and `COPY … TO 's3://…'` work transparently against either substrate.

#### Substrate mapping

| Concern                      | Cloud target (AWS)     | Current substrate (your-server)      |
| ---------------------------- | ---------------------- | ------------------------------------ |
| Read-many Parquet catalogs   | AWS S3                 | MinIO (S3-compatible; swap endpoint) |
| Append-friendly DB / configs | EFS                    | Local disk                           |
| NATS persistence             | NATS persistent volume | NATS persistent volume               |

The abstraction holds because MinIO speaks the S3 wire protocol and "local disk on the server hosting MinIO" plays EFS's role for a single-host deployment. Moving to AWS later swaps the endpoint and re-mounts EFS — no code path changes.

#### What goes where

| Data                     | Storage       | Why                                                                                                 |
| ------------------------ | ------------- | --------------------------------------------------------------------------------------------------- |
| Chain Parquet            | Object store  | Bulk reads for backtests + training. Written once, read many.                                       |
| Macro Parquet            | Object store  | Same pattern as chains.                                                                             |
| Backtest results         | Object store  | Written by the optimizer; read by the GUI catalog browser.                                          |
| DuckDB audit / portfolio | Persistent FS | Indefinite retention per §5. The DB file is the system of record; restart-recovery reads from here. |
| Config files             | Persistent FS | File-watch reload requires real filesystem semantics.                                               |
| NATS data                | NATS volume   | NATS manages its own storage.                                                                       |

#### Latency

For live trading, the latency-critical path (strategy decision → gate → broker submit) is in the NT bundle and doesn't touch the object store — it works off in-memory positions and recent market data. Object-store latency (50–200 ms first read; cached after) only affects backtests and catalog browsing, neither of which is latency-sensitive. DuckDB writes on the audit path are local-disk fsync (<1 ms typical) and well within the per-order budget.

#### Audit-chain backup and restore

The `data/portfolio.duckdb` file is the indefinitely-retained system of record for the audit chain (`audit_intents` / `audit_orders` / `audit_fills` / `portfolio_snapshots` per §5). Every "rebuilt from `audit_fills` on boot" promise in [portfolio-risk-engine.md §1](portfolio-risk-engine.md#1-portfolio-state) and the gate's restart-rehydration in [risk-gate-architecture.md §5.2](risk-gate-architecture.md#52-restart-rehydration) depends on this file. It needs an explicit backup + restore story.

**Backup mechanism.** A `backup-audit-chain` write-jobs handler ([write-jobs.md §8](write-jobs.md#8-registered-handlers)) produces a consistent DuckDB checkpoint and uploads it to the object store. The handler runs `CHECKPOINT` on a read-only attach of `data/portfolio.duckdb`, copies the resulting file to a tmp path, and uploads to `${BACKUPS_URI}/audit/portfolio_<YYYYMMDD>_<HHMMSS>.duckdb`. Mirrors the M15-5 / QF-279 `backup-observability` pattern.

| Concern        | Rule                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Cadence        | Nightly via `magpie-scheduler` container cron entry (`0 2 * * *` local time).                 |
| Destination    | MinIO bucket `magpie-backups`, prefix `audit/`. AWS equivalent: `s3://<bucket>/audit/`.       |
| Retention      | Rolling 30 daily backups; first-of-month archived to 12 monthly slots (in-bucket lifecycle policy). |
| Compression    | None (DuckDB files compress poorly because rows are already column-compressed; gzip adds ~5%).      |
| Authentication | The handler runs in-process on the TS server; uses the server's existing MinIO/S3 credentials.      |
| Trigger scope  | Same `submit:write-job` scope as other write-jobs; standard operator scope bundle includes it.      |

**Operator-triggered backup.** An on-demand backup is one `POST /api/write-jobs {kind: "backup-audit-chain"}` away (operator GUI button on Settings → Data → Audit). The handler is idempotent — multiple concurrent submissions dedup on a 1-hour window via the standard write-jobs idempotency key.

**Restore procedure.** Loss of `data/portfolio.duckdb` (disk failure, accidental `rm`, corrupt fsync) breaks the audit chain and every derived state. To restore:

1. **Stop the TS server.** `systemctl --user stop magpie` (or container equivalent). Do not let the server run with a stale or missing DB — `audit_fills` replay would land an inconsistent position state into running broker connections.
2. **Identify the right backup.** List backups in MinIO at `s3://magpie-backups/audit/`; the most recent backup older than the last known-good operator action is the right choice. If broker positions have changed since the backup (the broker continued to fill orders while QF was down), the reconciliation step below will surface the drift.
3. **Copy the chosen backup over the local file.** `aws s3 cp s3://magpie-backups/audit/portfolio_<YYYYMMDD>_<HHMMSS>.duckdb data/portfolio.duckdb` (or `mc cp` for MinIO direct).
4. **Verify integrity.** `duckdb data/portfolio.duckdb "PRAGMA table_info('audit_intents'); SELECT COUNT(*) FROM audit_fills;"` — must succeed without errors.
5. **Restart the server.** `systemctl --user start magpie`. The portfolio engine replays the restored `audit_fills`; the gate rehydrates from `audit_intents`; the GUI shows the recovered state.
6. **Reconcile against the broker.** The position-reconciliation loop ([portfolio-risk-engine.md §3](portfolio-risk-engine.md#3-position-reconciliation)) runs on its next cycle (default 60s) and surfaces any drift between the restored positions and the broker's actual positions. The operator inspects every drift entry — fills the broker has that the restored DB doesn't (or vice versa) — and either manually adds the missing fills via the standard tooling or accepts the broker's view.

**What restore does not recover.** Any `correlation_id` lifecycle whose fills landed after the backup is gone; observability log retention ([RUNBOOK §"Retention and backup"](../RUNBOOK.md#retention-and-backup)) keeps the structured log evidence in Loki, but the audit-chain rows themselves are lost for that window. The reconciliation step recovers position state but not the audit trail. Backup cadence is set such that this window is at most one trading session.

### 8. Observability framework

Detail in [tdd/observability.md](observability.md). Short summary so this file is self-contained for cross-cutting reviewers:

- **Acceptance test.** An operator must be able to reconstruct the full course of events for a single position lifecycle (strategy submission or operator entry → intent → risk → broker → fill → open → … → close) by querying a single `correlation_id`. Anything that breaks single-ID traceability is a framework bug.
- **Common JSON log schema.** Required top-level fields: `ts` (RFC 3339 UTC, microsecond), `level`, `service` (kebab-case component identifier), `correlation_id` (ULID), `event` (`<category>.<action>`), `payload` (object, snake_case keys). Optional: `error`, `host`, `process`, `parent_id`. Closed key set so log indexes stay stable.
- **Correlation-ID propagation.** ULID generated at the lifecycle anchor (typically `intent.proposed` or the first wire-event of an operator-initiated action). Across the wire: `X-Correlation-Id` header on NATS messages and HTTP. Across the PyO3 boundary: first non-input argument to every entry function (explicit, not thread-local). In-process: `AsyncLocalStorage` (TS), `contextvars.ContextVar` (Python), `tracing::Span` (Rust).
- **Per-runtime helper packages.** TS logger extension under `server/logging/`; new Python package at `research/magpie-logging/` (`qf_logging`); new Rust crate at `core/qf-logging/`. Golden-test parity rule prevents drift.
- **Component event catalogs** live in component TDDs (§10 Observability section), not here. [portfolio-risk-engine.md §10](portfolio-risk-engine.md#10-observability) is the worked example.
- **Out of scope (v1):** OTel spans, runtime metrics (those stay per-component under §6 Metrics), multi-tenant correlation. All forward-compatible additions, not load-bearing for v1.

The existing system-health-vs-business-observability split documented in the [top-level TDD](../TRADING-SYSTEM-TDD.md#observability) is unchanged; the framework specified above evolves the business-observability leg (structured logs with end-to-end traceability) while the system-health leg (Prometheus + Grafana exporters) stays as specified there.

### 9. Deployment cohesion

**Principle (forward-looking).** Single-purpose infra services that Magpie depends on — package mirrors (panamax for cargo, devpi for PyPI, verdaccio for npm), the SCA scanner (OSV-Scanner), reverse proxies, log forwarders — are part of the Magpie deployment story even when they can run as standalone services. They share the system's TLS termination, log into its observability fabric per §8, are versioned in the same release train, and are included in the same docker-compose / systemd unit set as the QF server. They are not "infra I happen to also run on your-server"; they are QF components that happen to be addressable from elsewhere.

**What this means in practice when implementing these services:**

- Their deployment artifacts (Dockerfile, compose entry, systemd unit, config) live under this repo, not in a sibling ops repo.
- Their `service` log field follows the same kebab-case convention as the rest of the system (e.g. `service: "panamax-mirror"`, `service: "devpi-mirror"`) and they emit the §8 JSON schema either directly or via a small adapter.
- Their admission denials / failure modes raise alerts through the same channel as QF (per §8 acceptance test — a single `correlation_id` for a CI-time admission denial should be discoverable from the same logs view that holds the rest of the system).
- Their config (registry URLs, scoping rules, allowed-license lists) lives under `config/`, not in mirror-specific homes.
- The "Deployment topology" table in any downstream TDD includes these services as first-class entries, not implicit dependencies.

**Today.** None of the mirror infrastructure is deployed yet. The cargo workspace ships a placeholder source-replacement block in [core/.cargo/config.toml](../../core/.cargo/config.toml) gated on a deployed panamax. The Python workspace has no equivalent placeholder yet. Neither CI workflow has an OSV-Scanner step. When the Verdaccio (npm), panamax (cargo), devpi (PyPI), and OSV-Scanner deployments land — along with the per-runtime structured-logging helpers on the logging-fabric side — this principle is the acceptance bar.

**Why bother.** The alternative — a constellation of standalone services on your-server that QF "happens to talk to" — drifts. Logs scatter across services with different schemas, secret rotation forks per service, admission denials disappear into per-service log files, and version skew between QF and the mirrors becomes its own incident class. Treating them as QF components from day one is cheaper than reconciling drift later.

### 5. Retention & archival

The system retains indefinitely by default per §5 (Database schema). Retention policies apply at the write-jobs layer via the `audit-retention` handler (QF-311), enforcing per-table windowing on a configurable nightly cadence. The goal is to manage DuckDB footprint on long-running deployments while preserving audit completeness for operational queries.

**Retention policies by table:**

| Table | Mode | Window | Archive | Cadence |
| --- | --- | --- | --- | --- |
| `audit_intents` | Archive | 90 days | Parquet to MinIO `audit/archive/` | Nightly |
| `audit_orders` | Archive | 90 days | Parquet to MinIO `audit/archive/` | Nightly |
| `audit_fills` | Archive | 90 days | Parquet to MinIO `audit/archive/` | Nightly |
| `drift_alerts` | Rolling delete | 30 days | None; drift signals lose relevance | Nightly |
| `portfolio_snapshots` | Rolling delete | 90 days | None (optional low-res monthly in future) | Nightly |

**Archive mode.** Rows older than the window are exported to Parquet in MinIO (date-partitioned by `created_at`), then deleted from DuckDB. The export uses DuckDB's `COPY ... TO 's3://...'` with `httpfs` loaded, so the archive runs inline in the handler—no subprocess. Archive paths: `s3://magpie-data/audit/archive/{table}/{YYYY/MM/DD}/{table}_{YYYY-MM-DD}.parquet`.

**Rolling-window delete.** No archive; rows older than the window are deleted in-place. Used for tables whose rows have limited operational value after N days (e.g., drift alerts are re-raised if the condition persists; historical alerts are noise).

**Dry-run mode.** The handler accepts `dry_run: true` in params—counts rows that would be archived/deleted and logs the plan without executing DELETEs or S3 uploads.

**Configuration.** Cadence, windows, and archive bucket are set in [`config/retention.json`](../../config/retention.json). Override via job params when submitting to the `POST /api/write-jobs` endpoint with `kind: "audit-retention"`. Default cadence is nightly (24h); `cadence_hours` in the config is parsed by the scheduler (future; today, submission is manual or via cron container).

**Operator visibility.** The handler logs per-table row counts (archived, deleted) and any errors at info level. A future Settings panel will expose disk-usage metrics (DuckDB file size, last-sweep timestamps, rows archived per table). For now, the metric is visible in structured logs and exportable via `GET /api/telemetry/metrics` (Prometheus format).

**Future: low-res monthly archive for `portfolio_snapshots`.** Rolling deletes today; per the decision, implement rolling-window deletion for `portfolio_snapshots` but note that a monthly low-res (e.g., end-of-day snapshot per month) archive is a follow-up for longer-term P&L trend analysis. File a ticket when needed; it's deferred because the operational value (recent positions for reconciliation) is highest for the rolling window.

---

### Files

Cross-cutting files referenced above:

- [`config/portfolios.json`](../../config/portfolios.json) — Portfolio definitions, risk limits, broker routing, reconciliation cadence (§3).
- [`config/market-calendar.json`](../../config/market-calendar.json) — Market hours and holidays (§2).
- [`config/market-data.json`](../../config/market-data.json) — Bridge subscriptions and freshness rules; defined by [data-plane.md](../data/data-plane.md).
- [`config/brokers.json`](../../config/brokers.json) — Per-broker bundle wiring; defined by [broker-integration.md](broker-integration.md).
- [`config/storage.json`](../../config/storage.json) — Object-store and DB path configuration (§7).
- [`config/retention.json`](../../config/retention.json) — Per-table retention policies, archive windows, cadence (§5).
- [`server/calendar/index.ts`](../../server/calendar/index.ts) — Calendar interface (§2).
- [`server/db/init.ts`](../../server/db/init.ts) — DuckDB initialization (creates all tables in §5).
- [`server/writeJobs/handlers/audit-retention.ts`](../../server/writeJobs/handlers/audit-retention.ts) — Retention handler implementation (§5).
- [`scripts/sync-to-s3.sh`](../../scripts/sync-to-s3.sh) / [`scripts/sync-from-s3.sh`](../../scripts/sync-from-s3.sh) — Object-store Parquet sync.
- [`tsconfig.json`](../../tsconfig.json), [`eslint.config.js`](../../eslint.config.js), [`.prettierrc`](../../.prettierrc) — TS / lint / format configuration (§6).
- [`.pre-commit-config.yaml`](../../.pre-commit-config.yaml) — Pre-commit hook config (§6).
