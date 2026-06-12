// ── Cross-Broker Market-Data Fallback Selector (QF-341) ───────────
//
// Service-layer fallback for read-only marketdata.rpc.* methods, layered
// on top of the explicit-`broker` request contract from
// docs/tdd/broker-integration.md §5.2. Defined in
// docs/tdd/marketdata-fallback.md §3.
//
// Eligible methods (TDD §1): quote, chain, expirations, candles. Orders,
// positions, exec-reports, historical_chain are NEVER routed here.
//
// Behavior is opt-in and config-gated. When `fallback_enabled` is false
// for a method (the default), the selector dispatches only to the
// explicitly-requested broker and rejects with BridgeUnavailableError on
// failure — identical to today. When enabled, it walks the effective
// priority starting at the requested broker, skipping brokers whose
// `available()` is false, returning the first success tagged with its
// served-from source + the brokers tried.

import type { MarketDataAdapter } from "../../src/types/market-data.js";
import type { Logger } from "../logger.js";
import type { AlertRouter } from "../alerts/router.js";
import {
  type MarketDataFallbackConfig,
  type MdFallbackMethod,
  MD_FALLBACK_METHODS,
} from "../order/brokers-config.js";

// ── Error ──────────────────────────────────────────────────────────

/**
 * Raised when every candidate broker in the effective priority order is
 * unavailable for a request. Same shape/semantics as today's no-fallback
 * rejection (TDD §3.4) — fallback only widens the set of sources tried
 * before this error, never converts a total outage into a silent success.
 */
export class BridgeUnavailableError extends Error {
  public readonly method: MdFallbackMethod;
  public readonly requestedBroker: string;
  public readonly sourcesTried: string[];
  constructor(method: MdFallbackMethod, requestedBroker: string, sourcesTried: string[]) {
    super(
      `marketdata.rpc.${method}: no available broker (requested "${requestedBroker}", tried ` +
        `[${sourcesTried.join(", ")}])`,
    );
    this.name = "BridgeUnavailableError";
    this.method = method;
    this.requestedBroker = requestedBroker;
    this.sourcesTried = sourcesTried;
  }
}

// ── Result ─────────────────────────────────────────────────────────

export interface FallbackResult<T> {
  /** The dispatched method's result payload (non-null). */
  data: T;
  /** The broker that actually served the request (the `_meta.source`). */
  source: string;
  /** Brokers attempted, in order, up to and including `source`. */
  sources_tried: string[];
  /** True when `source` differs from the requested broker (degraded). */
  served_via_fallback: boolean;
}

// ── Selector ───────────────────────────────────────────────────────

export interface FallbackSelectorDeps {
  /** Broker id → MD adapter (e.g. the per-broker nt-bridge-md adapters). */
  adapters: Map<string, MarketDataAdapter>;
  /** Parsed marketdata fallback policy (config/brokers.json). */
  config: MarketDataFallbackConfig;
  logger: Logger;
  /** Optional alert router for fallback_active/cleared events (TDD §5). */
  alertRouter?: AlertRouter;
}

export interface FallbackSelector {
  /**
   * Dispatch `method` for the explicitly-requested broker, applying the
   * config-gated fallback policy. `call` runs the actual RPC against a
   * chosen adapter and returns null when that adapter can't serve the
   * request (timeout / error-frame / not_supported), per the adapter
   * contract. Returns the first success; throws BridgeUnavailableError
   * when every candidate is exhausted.
   */
  dispatch<T>(
    method: MdFallbackMethod,
    requestedBroker: string,
    call: (adapter: MarketDataAdapter) => Promise<T | null>,
  ): Promise<FallbackResult<T>>;
  /** Set/replace the alert router after construction (boot-order helper). */
  setAlertRouter(router: AlertRouter): void;
  /**
   * Broker ids currently serving as a fallback target for ≥1 method
   * (the latched `fallback_active` set). Drives the Settings → Bridges
   * `serving_as_fallback` indicator (TDD §4.2).
   */
  brokersServingAsFallback(): Set<string>;
}

const ELIGIBLE = new Set<string>(MD_FALLBACK_METHODS);

export function createFallbackSelector(deps: FallbackSelectorDeps): FallbackSelector {
  const { adapters, config, logger } = deps;
  let alertRouter = deps.alertRouter;

  // Per-(method, broker) latch so fallback_active fires once per engaged
  // method/target and clears exactly once when it stops being needed.
  const fallbackActive = new Set<string>();
  const latchKey = (method: MdFallbackMethod, broker: string): string => `${method}:${broker}`;

  function effectivePolicy(method: MdFallbackMethod): {
    enabled: boolean;
    priority: string[];
  } {
    const override = config.methods[method];
    const enabled = override?.fallback_enabled ?? config.fallback_enabled;
    const priority = override?.priority ?? config.priority;
    return { enabled, priority };
  }

  /**
   * Build the candidate order for a request: the requested broker first
   * (preferred), then the tail of the effective priority after the
   * requested broker's position. Brokers ahead of the requested one in
   * the global order are NOT tried (the request names the preferred
   * source; fallback is the failover tail, TDD §3.2).
   */
  function candidateOrder(requestedBroker: string, priority: string[]): string[] {
    const idx = priority.indexOf(requestedBroker);
    if (idx === -1) {
      // Requested broker not in the priority list: try it alone, then the
      // full priority tail (it may still be served by a configured target).
      return [requestedBroker, ...priority.filter((b) => b !== requestedBroker)];
    }
    return priority.slice(idx);
  }

  function fireFallbackActive(method: MdFallbackMethod, broker: string, requested: string): void {
    const key = latchKey(method, broker);
    if (fallbackActive.has(key)) return;
    fallbackActive.add(key);
    if (!alertRouter) return;
    void alertRouter
      .record({
        type: `bridge.fallback_active.${broker}`,
        level: "info",
        message:
          `Market-data fallback engaged for ${method}: serving via "${broker}" ` +
          `because "${requested}" is unavailable`,
        payload: { method, broker, requested_broker: requested },
      })
      .catch((err) => {
        logger.warn("fallback-selector: fallback_active alert failed", {
          error: String(err),
          method,
          broker,
        });
      });
  }

  function fireFallbackCleared(method: MdFallbackMethod, broker: string): void {
    const key = latchKey(method, broker);
    if (!fallbackActive.has(key)) return;
    fallbackActive.delete(key);
    if (!alertRouter) return;
    void alertRouter
      .record({
        type: `bridge.fallback_cleared.${broker}`,
        level: "info",
        message: `Market-data fallback cleared for ${method}: "${broker}" no longer serving as fallback`,
        payload: { method, broker },
      })
      .catch((err) => {
        logger.warn("fallback-selector: fallback_cleared alert failed", {
          error: String(err),
          method,
          broker,
        });
      });
  }

  // When the primary served the request (no fallback), clear any latched
  // fallback_active for the OTHER candidate targets of this method.
  function clearOtherTargets(method: MdFallbackMethod, served: string, candidates: string[]): void {
    for (const broker of candidates) {
      if (broker !== served) fireFallbackCleared(method, broker);
    }
  }

  async function dispatch<T>(
    method: MdFallbackMethod,
    requestedBroker: string,
    call: (adapter: MarketDataAdapter) => Promise<T | null>,
  ): Promise<FallbackResult<T>> {
    if (!ELIGIBLE.has(method)) {
      // Defensive: callers should never route an ineligible method here.
      throw new Error(`fallback-selector: method "${method}" is not fallback-eligible`);
    }

    const { enabled, priority } = effectivePolicy(method);
    const sourcesTried: string[] = [];

    // ── No-fallback path: dispatch only to the requested broker. ──
    if (!enabled) {
      const adapter = adapters.get(requestedBroker);
      sourcesTried.push(requestedBroker);
      if (adapter) {
        const data = await call(adapter);
        if (data !== null) {
          return { data, source: requestedBroker, sources_tried: sourcesTried, served_via_fallback: false };
        }
      }
      throw new BridgeUnavailableError(method, requestedBroker, sourcesTried);
    }

    // ── Fallback path: walk the candidate order. ──
    const candidates = candidateOrder(requestedBroker, priority);
    for (const broker of candidates) {
      sourcesTried.push(broker);
      const adapter = adapters.get(broker);
      if (!adapter) {
        logger.debug("fallback-selector: no adapter for broker; skipping", { method, broker });
        continue;
      }
      // Cheap pre-check: skip a doomed RPC if the bridge is known down.
      let avail = false;
      try {
        avail = await adapter.available();
      } catch (err) {
        logger.debug("fallback-selector: available() threw; treating as down", {
          method,
          broker,
          error: String(err),
        });
      }
      if (!avail) continue;

      const data = await call(adapter);
      if (data === null) continue; // adapter couldn't serve; advance.

      const servedViaFallback = broker !== requestedBroker;
      if (servedViaFallback) {
        fireFallbackActive(method, broker, requestedBroker);
      } else {
        // Primary served — clear any stale fallback latches for this method.
        clearOtherTargets(method, broker, candidates);
      }
      return {
        data,
        source: broker,
        sources_tried: sourcesTried,
        served_via_fallback: servedViaFallback,
      };
    }

    throw new BridgeUnavailableError(method, requestedBroker, sourcesTried);
  }

  return {
    dispatch,
    setAlertRouter(router: AlertRouter): void {
      alertRouter = router;
    },
    brokersServingAsFallback(): Set<string> {
      const brokers = new Set<string>();
      for (const key of fallbackActive) {
        // key = "method:broker"; the broker is everything after the first ":".
        const sep = key.indexOf(":");
        if (sep !== -1) brokers.add(key.slice(sep + 1));
      }
      return brokers;
    },
  };
}
