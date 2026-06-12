// ── Envelope revoker ─────────────────────────────────────────────────
//
// Implements docs/tdd/risk-gate-architecture.md §3.5 envelope revocation
// on the QF side. The caller publishes a RevokeRequest on
// `orders.gate.revoke.<broker>`, expects a RevokeResponse of `revoked`
// or `envelope_unknown` (both success), and on success mutates the
// corresponding audit_intents row.
//
// Failure handling per §3.5:
//   - Timeout = 100ms per attempt (revoke is off the trading hot path)
//   - 3 retries with exponential backoff (100ms, 200ms, 400ms baseline)
//   - On persistent failure: log error + emit `envelope_revoke_failed`
//     alert + return { status: 'failed', attempts: 3 } so the caller
//     can mark the envelope `revoke_pending` for later retry. The audit
//     row mutate is skipped on failure.
//
// Idempotency: `envelope_unknown` from the plugin is treated as success.
// This handles restart-replay (QF re-sends a revoke after restart;
// plugin's in-memory registry was cleared so the envelope is unknown).
//
// Pending-intents update (status → envelope_revoked, capacity reclaim)
// is QF-316's responsibility; this module exposes the revoke hook +
// audit mutate only, and QF-316 wires its handler off the same revoke
// success path via a callback.
//
// QF-318.

import type { NatsConnection } from "nats";
import { StringCodec } from "nats";
import type { Database } from "duckdb";
import type { Logger } from "../logger.js";
import { orders } from "../../src/types/subjects.js";

// ── Wire contract (mirrors risk-gate-architecture.md §3.5) ────────────

export type RevokeReason =
  | "portfolio_halted"
  | "strategy_halted"
  | "drift_hard_trip"
  | "concentration_breach_other_strategy"
  | "operator_initiated";

export interface RevokeRequest {
  envelope_id: string;
  reason: RevokeReason;
  asof: string;
}

export type RevokeStatus = "revoked" | "envelope_unknown" | "failed";

export interface RevokeResponse {
  status: RevokeStatus;
  // attempts is populated on 'failed' so the caller can decide on
  // backoff / alerting policy. Missing / undefined on success.
  attempts?: number;
}

// ── Wire-level response shape from the gate plugin ────────────────────

interface PluginRevokeReply {
  status: "revoked" | "envelope_unknown";
}

// ── Audit mutator (separated so tests can stub the DB side cleanly) ──

export type AuditEnvelopeRevokeMutator = (
  envelopeId: string,
  reason: RevokeReason,
  revokedAt: string,
) => Promise<void>;

export function createAuditEnvelopeRevokeMutator(
  db: Database,
  logger: Logger,
): AuditEnvelopeRevokeMutator {
  return async (envelopeId, reason, revokedAt): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      db.run(
        `UPDATE audit_intents
           SET envelope_revoked_at    = ?,
               envelope_revoke_reason = ?
         WHERE envelope_id = ?`,
        revokedAt,
        reason,
        envelopeId,
        (err: Error | null) => {
          if (err) {
            logger.error("audit_intents envelope-revoke mutate failed", {
              envelope_id: envelopeId,
              reason,
              error: String(err),
            });
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
  };
}

// ── Alert publisher (kept structural — tests stub a callable) ─────────

export type RevokeFailureAlertEmitter = (envelopeId: string, attempts: number) => void;

// ── Revoker factory ───────────────────────────────────────────────────

export interface EnvelopeRevokerConfig {
  broker: string;
  // Default 100ms per §3.5. Per-attempt; the overall budget is
  // ~100 + 200 + 400 = 700ms across the 3 attempts.
  timeoutMs?: number;
  // Default 3. Set 0 to disable retry (one attempt only).
  maxRetries?: number;
  // Default 100ms. Backoff doubles per attempt.
  retryBaseMs?: number;
}

export interface EnvelopeRevokerDeps {
  nc: NatsConnection;
  config: EnvelopeRevokerConfig;
  logger: Logger;
  auditMutator: AuditEnvelopeRevokeMutator;
  alertEmitter?: RevokeFailureAlertEmitter;
  // Test seam. Defaults to setTimeout(..., ms).
  sleep?: (ms: number) => Promise<void>;
  // Test seam. Defaults to () => new Date().toISOString().
  now?: () => string;
}

export interface EnvelopeRevoker {
  revokeEnvelope(envelopeId: string, reason: RevokeReason): Promise<RevokeResponse>;
}

const DEFAULT_TIMEOUT_MS = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 100;

export function createEnvelopeRevoker(deps: EnvelopeRevokerDeps): EnvelopeRevoker {
  const { nc, config, logger, auditMutator, alertEmitter } = deps;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date().toISOString());
  const sc = StringCodec();
  const subject = orders.gate.revoke(config.broker);

  return {
    async revokeEnvelope(envelopeId: string, reason: RevokeReason): Promise<RevokeResponse> {
      let attempts = 0;
      let lastError: unknown = null;
      while (attempts <= maxRetries) {
        attempts += 1;
        const req: RevokeRequest = {
          envelope_id: envelopeId,
          reason,
          asof: now(),
        };
        try {
          const msg = await nc.request(subject, sc.encode(JSON.stringify(req)), {
            timeout: timeoutMs,
          });
          const reply = JSON.parse(sc.decode(msg.data)) as PluginRevokeReply;
          // Both 'revoked' and 'envelope_unknown' are success per §3.5.
          // envelope_unknown handles restart-replay (plugin had no
          // record; treat as already-revoked, idempotent).
          if (reply.status === "revoked" || reply.status === "envelope_unknown") {
            await auditMutator(envelopeId, reason, req.asof).catch((err) => {
              // Mutate failure logs at the writer level; we surface the
              // revoke success to the caller regardless — the wire
              // revoke landed, the audit mutate can be retried later.
              logger.warn("envelope-revoker: audit mutate failed post-success", {
                envelope_id: envelopeId,
                error: String(err),
              });
            });
            return { status: reply.status };
          }
          // Defensive: unknown status — treat as transient, retry.
          lastError = new Error(`unexpected status: ${String(reply.status)}`);
        } catch (err) {
          lastError = err;
        }
        if (attempts <= maxRetries) {
          // Exponential backoff: 100, 200, 400, ... ms.
          await sleep(retryBaseMs * Math.pow(2, attempts - 1));
        }
      }
      // Exhausted retries.
      logger.error("envelope_revoke_failed", {
        broker: config.broker,
        envelope_id: envelopeId,
        attempts,
        last_error: String(lastError),
      });
      alertEmitter?.(envelopeId, attempts);
      return { status: "failed", attempts };
    },
  };
}
