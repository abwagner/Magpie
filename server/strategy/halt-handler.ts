// ── Strategy halt → envelope revoke wiring ────────────────────────────
//
// QF-324 hooks the StrategyStore's onHalt callback into the gate's
// envelope-revoker (QF-318) and the pending-intents log (QF-316). On
// transition into `halted`:
//
//   1. Look up every pending intent for the strategy via
//      pendingIntents.getActiveForStrategy(strategyId).
//   2. For each, call revoker.revokeEnvelope(envelope_id,
//      'strategy_halted'). The revoker handles its own retries,
//      idempotency, and audit-row mutate (per QF-318).
//   3. On success ('revoked' or 'envelope_unknown'), mark the
//      pending-intents row as envelope_revoked so the local view
//      converges with the gate plugin's. Failed revokes leave the
//      pending-intents row pending — operator alert fires from the
//      revoker per QF-318.
//
// Side-effect-only module: no return value. Errors are logged at the
// boundary; they do not throw back to the lifecycle transition.
//
// Open positions are intentionally NOT auto-closed per
// docs/tdd/order-execution.md §5.3 — operator decides whether to
// manually liquidate (§5.2) or wait for declared exit rules to trip.

import type { Logger } from "../logger.js";
import type { Strategy } from "./lifecycle.js";
import type { PendingIntentsStore } from "../risk/pending-intents.js";
import type { EnvelopeRevoker, RevokeResponse } from "../risk/envelope-revoker.js";

export interface StrategyHaltHandlerDeps {
  logger: Logger;
  pendingIntents: PendingIntentsStore;
  // Per-broker revokers keyed by broker name. The handler dispatches to
  // the right revoker per envelope's broker tag. Production wires one
  // revoker per enabled broker; tests can pass a Map with stubs.
  revokers: Map<string, EnvelopeRevoker>;
  now?: () => string;
}

export type StrategyHaltHandler = (strategy: Strategy) => Promise<void>;

export function createStrategyHaltHandler(deps: StrategyHaltHandlerDeps): StrategyHaltHandler {
  const { logger, pendingIntents, revokers } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  return async (strategy: Strategy): Promise<void> => {
    const envelopes = pendingIntents.getActiveForStrategy(strategy.id);
    if (envelopes.length === 0) {
      logger.info("strategy halted: no open envelopes to revoke", {
        strategy_id: strategy.id,
      });
      return;
    }
    logger.info("strategy halted: revoking open envelopes", {
      strategy_id: strategy.id,
      envelope_count: envelopes.length,
    });

    // Revoke in parallel. Each revoker call is bounded (per-attempt
    // timeout + 3 retries per QF-318); the total wait is dominated by
    // the slowest broker. Errors are logged per-envelope; one failing
    // revoke doesn't block the others.
    const results = await Promise.all(
      envelopes.map(async (env): Promise<{ envelope_id: string; result: RevokeResponse }> => {
        const revoker = revokers.get(env.broker);
        if (!revoker) {
          logger.warn("strategy halt: no revoker for broker", {
            strategy_id: strategy.id,
            broker: env.broker,
            envelope_id: env.envelope_id,
          });
          return {
            envelope_id: env.envelope_id,
            result: { status: "failed", attempts: 0 },
          };
        }
        const result = await revoker.revokeEnvelope(env.envelope_id, "strategy_halted");
        return { envelope_id: env.envelope_id, result };
      }),
    );

    // Mark pending-intents rows for successful revokes. Failed revokes
    // stay pending — the operator alert from the revoker carries the
    // diagnostic; subsequent operator action (manual retry or relevant
    // fix) lands them.
    const ts = now();
    let revoked = 0;
    let failed = 0;
    for (const { envelope_id, result } of results) {
      if (result.status === "revoked" || result.status === "envelope_unknown") {
        pendingIntents.markEnvelopeRevoked(envelope_id, ts);
        revoked += 1;
      } else {
        failed += 1;
      }
    }
    logger.info("strategy halt revoke loop complete", {
      strategy_id: strategy.id,
      revoked,
      failed,
    });
  };
}
