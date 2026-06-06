// ── Database Initialization ────────────────────────────────────────
// Creates all DuckDB tables at server startup.
// No ORM — raw SQL via the shared DuckDB connection.

import type { Database } from "duckdb";

// ── Table Definitions ──────────────────────────────────────────────

const TABLES = [
  // Audit trail: audit_intents
  // QF-214 — originating_signal_json holds the FULL Signal payload at
  // intent-write time. Denormalized (some redundancy with audit_signals)
  // so restart recovery can rebuild the working-order monitor's
  // per-task originating Signal without joining across an evolving
  // audit_signals payload schema. Null when the intent had no upstream
  // signal (rare; manual-mode orders + legacy paths).
  // QF-319 — source identifies which surface wrote the row (Model A,
  // writer-identity sourcing per docs/tdd/order-flow.md §4.2). `qf` =
  // OPL on operator manual entry / liquidation / exit-rule close;
  // `qf-gated` = gate-evaluator handling an NT-plugin gate RPC;
  // `nt-native` is reserved for a future NT-side intent writer (no
  // producer in current arch — see §4.1). correlation_id threads the
  // chain anchor through every row per docs/tdd/observability.md §4.2.
  `CREATE TABLE IF NOT EXISTS audit_intents (
    intent_id                VARCHAR PRIMARY KEY,
    signal_ids               VARCHAR NOT NULL,
    portfolio                VARCHAR NOT NULL,
    symbol                   VARCHAR NOT NULL,
    direction                VARCHAR NOT NULL,
    quantity                 INTEGER NOT NULL,
    strategy_id              VARCHAR NOT NULL,
    created_at               TIMESTAMP NOT NULL,
    originating_signal_json  VARCHAR,
    source                   VARCHAR NOT NULL DEFAULT 'qf',
    correlation_id           VARCHAR,
    -- QF-315: gate-evaluator outcome on qf-gated intents per
    -- risk-gate-architecture.md §3.3 + cross-cutting.md §5. Both null
    -- on source='qf' rows (OPL-originated intents don't go through
    -- the gate). envelope_id = intent_id at v1 per §3.3.
    gate_decision            VARCHAR,
    gate_reason              VARCHAR,
    envelope_id              VARCHAR,
    -- QF-318: envelope revocation timestamps + reason. Both null on
    -- never-revoked rows. envelope_revoke_reason is a structured value
    -- ('portfolio_halted' | 'strategy_halted' | 'drift_hard_trip' |
    -- 'concentration_breach_other_strategy' | 'operator_initiated')
    -- per risk-gate-architecture.md §3.5 RevokeReason.
    envelope_revoked_at      TIMESTAMP,
    envelope_revoke_reason   VARCHAR
  )`,
  // QF-214 — additive migration for installs that pre-date the
  // originating_signal_json column. DuckDB's ADD COLUMN IF NOT EXISTS
  // is idempotent; CREATE TABLE IF NOT EXISTS above won't add new
  // columns to an existing table.
  `ALTER TABLE audit_intents ADD COLUMN IF NOT EXISTS originating_signal_json VARCHAR`,
  // QF-319 — backfill source + correlation_id on pre-existing installs.
  // Default 'qf' for legacy rows (all OPL-originated before this ticket).
  `ALTER TABLE audit_intents ADD COLUMN IF NOT EXISTS source VARCHAR DEFAULT 'qf'`,
  `ALTER TABLE audit_intents ADD COLUMN IF NOT EXISTS correlation_id VARCHAR`,
  // QF-315 — gate-evaluator decision columns. Nullable since pre-gate
  // (source='qf') rows leave them null.
  `ALTER TABLE audit_intents ADD COLUMN IF NOT EXISTS gate_decision VARCHAR`,
  `ALTER TABLE audit_intents ADD COLUMN IF NOT EXISTS gate_reason VARCHAR`,
  `ALTER TABLE audit_intents ADD COLUMN IF NOT EXISTS envelope_id VARCHAR`,
  // QF-318 — envelope-revocation timestamps + reason.
  `ALTER TABLE audit_intents ADD COLUMN IF NOT EXISTS envelope_revoked_at TIMESTAMP`,
  `ALTER TABLE audit_intents ADD COLUMN IF NOT EXISTS envelope_revoke_reason VARCHAR`,
  // QF-318 — revoker queries audit_intents by envelope_id for the
  // post-revoke audit-row mutate. Index keeps that lookup constant-time
  // even as the table grows.
  `CREATE INDEX IF NOT EXISTS idx_audit_intents_envelope_id ON audit_intents(envelope_id)`,

  // Audit trail: audit_orders
  // operator_edits: QF-50 — JSON blob of fields the operator overrode
  // when approving the order from manual mode. Null when the operator
  // approved without changes. Captures keys (order_type, limit_price,
  // time_in_force, working_policy_id) where the operator's value
  // differed from the Execution Layer's recommendation on the intent.
  // QF-207: risk_violations + halt_reason capture rejection context so
  // every reject leaves an audit row that explains WHY (which risk
  // limit fired or which kill-switch reason). risk_violations is a
  // JSON-encoded array; halt_reason mirrors PortfolioEngine.halt's
  // free-form string.
  `CREATE TABLE IF NOT EXISTS audit_orders (
    order_id          VARCHAR PRIMARY KEY,
    intent_id         VARCHAR NOT NULL REFERENCES audit_intents(intent_id),
    -- QF-310: broker-side idempotency token. Set at INSERT time and
    -- never updated. v1: equals OrderIntent.client_order_id, which
    -- defaults to intent_id. Retries reuse the same client_order_id so
    -- the broker can recognize and deduplicate a 504-window resubmit.
    -- Indexed for the dedup-lookup path. Nullable in the schema (no DB-
    -- level NOT NULL) so the additive ALTER for existing installs
    -- doesn't need a backfill default; production writers in OPL always
    -- populate, and rehydration falls back to intent_id for legacy
    -- pre-QF-310 rows. See broker-integration.md §4.1.
    client_order_id   VARCHAR,
    broker            VARCHAR NOT NULL,
    execution_mode    VARCHAR NOT NULL,
    status            VARCHAR NOT NULL,
    created_at        TIMESTAMP NOT NULL,
    risk_checked_at   TIMESTAMP,
    approved_at       TIMESTAMP,
    submitted_at      TIMESTAMP,
    completed_at      TIMESTAMP,
    broker_order_id   VARCHAR,
    operator_edits    VARCHAR,
    risk_violations   VARCHAR,
    halt_reason       VARCHAR,
    -- QF-209: free-form reason string from BrokerAdapter.onRejection
    -- for orders the broker rejected after submit. Populated only on
    -- status='rejected_by_broker'; null otherwise.
    broker_rejection_reason VARCHAR,
    -- QF-210: free-form reason string for pre-submit rejection due to
    -- quote-unavailable (MD adapter throws / stale quote / inverted
    -- NBBO / zero-or-negative prices). Populated only on status='rejected'
    -- when the Execution Layer aborted before submit; null otherwise.
    quote_failure_reason VARCHAR,
    -- QF-204: free-form cancel reason for status='cancelled' transitions.
    -- Examples: 'signal_invalidated' (working-order monitor), 'operator',
    -- 'kill_switch'. Distinguishes policy-driven cancels from manual ones
    -- in the audit trail.
    cancel_reason VARCHAR,
    -- QF-319: writer-identity sourcing (Model A) per order-flow.md §4.2.
    source        VARCHAR NOT NULL DEFAULT 'qf',
    correlation_id VARCHAR,
    -- QF-244: M12-2 — which Schwab account this order came from.
    -- 'default' is the backward-compat synthetic id for pre-multi-account
    -- rows (mirrors M12-1 single-account placeholder). M12-3 sets the real
    -- account_id when routing is wired.
    account_id    VARCHAR NOT NULL DEFAULT 'default'
  )`,
  // QF-266 — additive migrations for installs that pre-date these audit_orders
  // columns. DuckDB's ADD COLUMN IF NOT EXISTS is idempotent; CREATE TABLE IF
  // NOT EXISTS above won't add new columns to an existing table, so each
  // ticket-tagged column needs its own ALTER for backfill. Mirrors the
  // QF-214 pattern used for audit_intents.originating_signal_json.
  `ALTER TABLE audit_orders ADD COLUMN IF NOT EXISTS operator_edits VARCHAR`,
  `ALTER TABLE audit_orders ADD COLUMN IF NOT EXISTS risk_violations VARCHAR`,
  `ALTER TABLE audit_orders ADD COLUMN IF NOT EXISTS halt_reason VARCHAR`,
  `ALTER TABLE audit_orders ADD COLUMN IF NOT EXISTS broker_rejection_reason VARCHAR`,
  `ALTER TABLE audit_orders ADD COLUMN IF NOT EXISTS quote_failure_reason VARCHAR`,
  `ALTER TABLE audit_orders ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR`,
  // QF-310: backfill client_order_id on existing installs. NOT NULL is
  // enforced on fresh installs via the CREATE TABLE above; for existing
  // installs we leave the column nullable (DuckDB ADD COLUMN IF NOT
  // EXISTS can't add a NOT NULL constraint without a DEFAULT). Production
  // callsite populates from intent_id; queries should treat null as
  // "pre-QF-310, no broker dedup key recorded".
  `ALTER TABLE audit_orders ADD COLUMN IF NOT EXISTS client_order_id VARCHAR`,
  `CREATE INDEX IF NOT EXISTS idx_audit_orders_client_order_id ON audit_orders(client_order_id)`,
  // QF-319 — source + correlation_id on existing installs.
  `ALTER TABLE audit_orders ADD COLUMN IF NOT EXISTS source VARCHAR DEFAULT 'qf'`,
  `ALTER TABLE audit_orders ADD COLUMN IF NOT EXISTS correlation_id VARCHAR`,
  // QF-244 — account_id on existing installs (M12-2 backfill).
  `ALTER TABLE audit_orders ADD COLUMN IF NOT EXISTS account_id VARCHAR DEFAULT 'default'`,
  // QF-319 — audit-observer dedup query looks up the OPL chain by
  // broker_order_id (the only id present in BrokerExecReport). Without
  // this index the lookup is a scan; with it the dedup path stays
  // sub-millisecond per fill.
  `CREATE INDEX IF NOT EXISTS idx_audit_orders_broker_order_id ON audit_orders(broker_order_id)`,

  // Audit trail: audit_fills
  `CREATE TABLE IF NOT EXISTS audit_fills (
    fill_id         VARCHAR PRIMARY KEY,
    order_id        VARCHAR NOT NULL REFERENCES audit_orders(order_id),
    price           DOUBLE  NOT NULL,
    quantity        INTEGER NOT NULL,
    fees            DOUBLE,
    filled_at       TIMESTAMP NOT NULL,
    expected_price  DOUBLE,
    slippage        DOUBLE,
    -- QF-319: writer-identity sourcing (Model A) per order-flow.md §4.2.
    source          VARCHAR NOT NULL DEFAULT 'qf',
    correlation_id  VARCHAR,
    -- QF-244: M12-2 — which Schwab account this fill came from.
    -- 'default' matches the backward-compat synthetic id (M12-1).
    -- M12-3 sets the real account_id when routing is wired.
    account_id      VARCHAR NOT NULL DEFAULT 'default'
  )`,
  // QF-319 — additive migration for installs that pre-date source/correlation_id.
  `ALTER TABLE audit_fills ADD COLUMN IF NOT EXISTS source VARCHAR DEFAULT 'qf'`,
  `ALTER TABLE audit_fills ADD COLUMN IF NOT EXISTS correlation_id VARCHAR`,
  // QF-244 — account_id on existing installs (M12-2 backfill).
  `ALTER TABLE audit_fills ADD COLUMN IF NOT EXISTS account_id VARCHAR DEFAULT 'default'`,

  // Audit trail: audit_pricing_decisions (QF-42)
  // Per TDD §3.4 — one row per pricing decision. An intent may produce
  // multiple decisions over its lifetime (working policy repegs), so
  // decision_id is the PK and intent_id is the foreign key.
  // `inputs_json` is a JSON blob containing the quote snapshot and
  // signal age/horizon at decision time — preserving the inputs makes
  // every decision replayable from the audit row alone.
  `CREATE TABLE IF NOT EXISTS audit_pricing_decisions (
    decision_id          VARCHAR PRIMARY KEY,
    intent_id            VARCHAR NOT NULL REFERENCES audit_intents(intent_id),
    strategy_id          VARCHAR NOT NULL,
    strategy_chosen      VARCHAR NOT NULL,
    profile_source       VARCHAR NOT NULL,
    inputs_json          VARCHAR NOT NULL,
    order_type           VARCHAR NOT NULL,
    limit_price          DOUBLE,
    limit_price_pre_snap DOUBLE,
    time_in_force        VARCHAR NOT NULL,
    working_policy_id    VARCHAR NOT NULL,
    reasoning            VARCHAR NOT NULL,
    created_at           TIMESTAMP NOT NULL
  )`,

  // Portfolio: portfolio_snapshots
  `CREATE TABLE IF NOT EXISTS portfolio_snapshots (
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
  )`,

  // Trade journal: trade lifecycle (entry → exit → P&L)
  `CREATE TABLE IF NOT EXISTS trade_journal (
    trade_id            VARCHAR PRIMARY KEY,
    portfolio           VARCHAR NOT NULL,
    strategy_id         VARCHAR NOT NULL,
    signal_ids          VARCHAR NOT NULL,
    symbol              VARCHAR NOT NULL,
    direction           VARCHAR NOT NULL,
    quantity            INTEGER NOT NULL,
    contract_multiplier INTEGER NOT NULL DEFAULT 100,
    entry_fill_id       VARCHAR NOT NULL,
    entry_price         DOUBLE  NOT NULL,
    entry_date          TIMESTAMP NOT NULL,
    entry_fees          DOUBLE  NOT NULL DEFAULT 0,
    exit_fill_id        VARCHAR,
    exit_price          DOUBLE,
    exit_date           TIMESTAMP,
    exit_fees           DOUBLE,
    exit_reason         VARCHAR,
    realized_pnl        DOUBLE,
    holding_days        INTEGER,
    status              VARCHAR NOT NULL DEFAULT 'open'
  )`,

  // QF-328 — Strategy drift detector: drift_alerts table.
  // One row per alert fire. The per-day alert budget (at most one alert
  // per (strategy_id, metric) per UTC day) is enforced by querying
  // this table before emitting — see server/risk/drift-detector.ts
  // and docs/tdd/drift-detector.md §3.3.
  // fired_date_utc is denormalized from fired_at so the budget index
  // can be a tight (strategy_id, metric, fired_date_utc) lookup.
  `CREATE TABLE IF NOT EXISTS drift_alerts (
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
    fired_date_utc    DATE NOT NULL,               -- denormalized for the per-day alert budget
    correlation_id    VARCHAR NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_drift_alerts_budget
     ON drift_alerts(strategy_id, metric, fired_date_utc)`,
  `CREATE INDEX IF NOT EXISTS idx_drift_alerts_correlation
     ON drift_alerts(correlation_id)`,
];

// ── Init Function ──────────────────────────────────────────────────

export async function initDatabase(db: Database): Promise<void> {
  for (const sql of TABLES) {
    await new Promise<void>((resolve, reject) => {
      db.run(sql, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
