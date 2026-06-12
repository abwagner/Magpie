// Unit tests for the cross-broker MD fallback selector (QF-341).
// Covers: skip-unavailable, success-tagging, exhaustion, eligible-vs-
// ineligible methods, fallback-disabled passthrough, and the
// fallback_active / fallback_cleared alert transitions.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFallbackSelector,
  BridgeUnavailableError,
  type FallbackSelector,
} from "../../fallback-selector.js";
import type { MarketDataFallbackConfig } from "../../../order/brokers-config.js";
import type { MarketDataAdapter } from "../../../../src/types/market-data.js";
import type { AlertEvent } from "../../../alerts/router.js";

// ── Fakes ──────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => makeLogger(),
  };
}

// A minimal MD adapter whose availability + per-call result are
// controllable. `result` returns the served value or null (can't serve).
function makeAdapter(
  name: string,
  opts: { available: boolean; result: unknown | null },
): MarketDataAdapter {
  return {
    name: `nt-bridge/${name}`,
    available: vi.fn(async () => opts.available),
    stockQuote: vi.fn(async () => opts.result as never),
    expirations: vi.fn(async () => opts.result as never),
    chain: vi.fn(async () => opts.result as never),
    historicalChain: vi.fn(async () => null),
  };
}

// Records alert events the selector emits.
function makeAlertRouter() {
  const events: AlertEvent[] = [];
  return {
    events,
    record: vi.fn(async (input: Omit<AlertEvent, "ts"> & { ts?: string }) => {
      const ev: AlertEvent = { ts: input.ts ?? "T", ...input };
      events.push(ev);
      return ev;
    }),
    // Unused-by-selector members, present for type compatibility.
    load: vi.fn(),
    get: vi.fn(),
    replace: vi.fn(),
    setInternalSink: vi.fn(),
    recent: vi.fn(() => []),
  };
}

function baseConfig(over: Partial<MarketDataFallbackConfig> = {}): MarketDataFallbackConfig {
  return {
    fallback_enabled: true,
    priority: ["ibkr", "schwab"],
    methods: {},
    heartbeat_stale_ms: 30000,
    ...over,
  };
}

function build(
  adapters: Record<string, MarketDataAdapter>,
  config: MarketDataFallbackConfig,
  router?: ReturnType<typeof makeAlertRouter>,
): FallbackSelector {
  const map = new Map(Object.entries(adapters));
  const sel = createFallbackSelector({
    adapters: map,
    config,
    logger: makeLogger() as never,
  });
  if (router) sel.setAlertRouter(router as never);
  return sel;
}

const callQuote = (a: MarketDataAdapter) => a.stockQuote("AAPL");

// ── Disabled passthrough ───────────────────────────────────────────

describe("fallback selector — fallback disabled", () => {
  it("dispatches only to the requested broker and tags no fallback", async () => {
    const ibkr = makeAdapter("ibkr", { available: true, result: { bid: 1 } });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build({ ibkr, schwab }, baseConfig({ fallback_enabled: false }));

    const res = await sel.dispatch("quote", "ibkr", callQuote);
    expect(res.source).toBe("ibkr");
    expect(res.served_via_fallback).toBe(false);
    expect(res.sources_tried).toEqual(["ibkr"]);
    // No iteration to schwab even though it is available.
    expect(schwab.stockQuote).not.toHaveBeenCalled();
  });

  it("rejects with BridgeUnavailableError when the requested broker can't serve", async () => {
    const ibkr = makeAdapter("ibkr", { available: true, result: null });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build({ ibkr, schwab }, baseConfig({ fallback_enabled: false }));

    await expect(sel.dispatch("quote", "ibkr", callQuote)).rejects.toBeInstanceOf(
      BridgeUnavailableError,
    );
    expect(schwab.stockQuote).not.toHaveBeenCalled();
  });
});

// ── Selector walk ──────────────────────────────────────────────────

describe("fallback selector — walk", () => {
  it("returns the requested broker when it can serve (no fallback)", async () => {
    const ibkr = makeAdapter("ibkr", { available: true, result: { bid: 1 } });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build({ ibkr, schwab }, baseConfig());

    const res = await sel.dispatch("quote", "ibkr", callQuote);
    expect(res.source).toBe("ibkr");
    expect(res.served_via_fallback).toBe(false);
    expect(schwab.available).not.toHaveBeenCalled();
  });

  it("skips an unavailable broker without an RPC and falls back to the next", async () => {
    const ibkr = makeAdapter("ibkr", { available: false, result: { bid: 1 } });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build({ ibkr, schwab }, baseConfig());

    const res = await sel.dispatch("quote", "ibkr", callQuote);
    expect(res.source).toBe("schwab");
    expect(res.served_via_fallback).toBe(true);
    expect(res.sources_tried).toEqual(["ibkr", "schwab"]);
    // ibkr was skipped before any RPC.
    expect(ibkr.stockQuote).not.toHaveBeenCalled();
    expect(schwab.stockQuote).toHaveBeenCalledTimes(1);
  });

  it("advances when an available broker returns null (per-request failure)", async () => {
    const ibkr = makeAdapter("ibkr", { available: true, result: null });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build({ ibkr, schwab }, baseConfig());

    const res = await sel.dispatch("quote", "ibkr", callQuote);
    expect(res.source).toBe("schwab");
    expect(res.served_via_fallback).toBe(true);
    expect(ibkr.stockQuote).toHaveBeenCalledTimes(1);
  });

  it("starts at the requested broker, not the head of the order", async () => {
    // Requested = schwab (tail). ibkr ahead of it must NOT be tried.
    const ibkr = makeAdapter("ibkr", { available: true, result: { bid: 1 } });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build({ ibkr, schwab }, baseConfig());

    const res = await sel.dispatch("quote", "schwab", callQuote);
    expect(res.source).toBe("schwab");
    expect(res.sources_tried).toEqual(["schwab"]);
    expect(ibkr.available).not.toHaveBeenCalled();
  });

  it("exhausts to BridgeUnavailableError when every candidate is down", async () => {
    const ibkr = makeAdapter("ibkr", { available: false, result: null });
    const schwab = makeAdapter("schwab", { available: false, result: null });
    const sel = build({ ibkr, schwab }, baseConfig());

    const err = await sel.dispatch("quote", "ibkr", callQuote).catch((e) => e);
    expect(err).toBeInstanceOf(BridgeUnavailableError);
    expect((err as BridgeUnavailableError).sourcesTried).toEqual(["ibkr", "schwab"]);
  });

  it("respects a per-method override disabling fallback", async () => {
    const ibkr = makeAdapter("ibkr", { available: true, result: null });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build(
      { ibkr, schwab },
      baseConfig({ methods: { quote: { fallback_enabled: false } } }),
    );

    await expect(sel.dispatch("quote", "ibkr", callQuote)).rejects.toBeInstanceOf(
      BridgeUnavailableError,
    );
    expect(schwab.stockQuote).not.toHaveBeenCalled();
  });

  it("uses a per-method priority override over the global order", async () => {
    const ibkr = makeAdapter("ibkr", { available: true, result: { bid: 1 } });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build(
      { ibkr, schwab },
      baseConfig({ methods: { quote: { priority: ["schwab", "ibkr"] } } }),
    );

    // Requested ibkr, but the method order is schwab-first → requested
    // broker is the tail; only ibkr is tried.
    const res = await sel.dispatch("quote", "ibkr", callQuote);
    expect(res.source).toBe("ibkr");
    expect(res.sources_tried).toEqual(["ibkr"]);
  });
});

// ── Eligible vs ineligible ─────────────────────────────────────────

describe("fallback selector — method eligibility", () => {
  it("throws for an ineligible method", async () => {
    const ibkr = makeAdapter("ibkr", { available: true, result: { bid: 1 } });
    const sel = build({ ibkr }, baseConfig());
    await expect(
      // @ts-expect-error — deliberately passing an ineligible method.
      sel.dispatch("historical_chain", "ibkr", callQuote),
    ).rejects.toThrow(/not fallback-eligible/);
  });
});

// ── Alert transitions ──────────────────────────────────────────────

describe("fallback selector — fallback_active / fallback_cleared alerts", () => {
  let router: ReturnType<typeof makeAlertRouter>;
  beforeEach(() => {
    router = makeAlertRouter();
  });

  it("fires fallback_active once when fallback first engages for a method", async () => {
    const ibkr = makeAdapter("ibkr", { available: false, result: null });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build({ ibkr, schwab }, baseConfig(), router);

    await sel.dispatch("quote", "ibkr", callQuote);
    await sel.dispatch("quote", "ibkr", callQuote); // second engage — no re-fire

    const active = router.events.filter((e) => e.type === "bridge.fallback_active.schwab");
    expect(active).toHaveLength(1);
    expect(active[0]?.level).toBe("info");
    expect(active[0]?.payload).toMatchObject({ method: "quote", broker: "schwab" });
  });

  it("fires fallback_cleared when the primary recovers and serves again", async () => {
    // First call: ibkr down → fallback to schwab (active fires).
    const ibkr = makeAdapter("ibkr", { available: false, result: { bid: 1 } });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build({ ibkr, schwab }, baseConfig(), router);
    await sel.dispatch("quote", "ibkr", callQuote);
    expect(router.events.some((e) => e.type === "bridge.fallback_active.schwab")).toBe(true);

    // ibkr recovers and serves the requested broker directly.
    (ibkr.available as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await sel.dispatch("quote", "ibkr", callQuote);

    const cleared = router.events.filter((e) => e.type === "bridge.fallback_cleared.schwab");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.payload).toMatchObject({ method: "quote", broker: "schwab" });
  });

  it("brokersServingAsFallback reflects the latch state", async () => {
    // ibkr can serve (result set) but is initially unavailable, so the
    // first call falls back to schwab; once ibkr's heartbeat returns it
    // serves directly and the latch clears.
    const ibkr = makeAdapter("ibkr", { available: false, result: { bid: 1 } });
    const schwab = makeAdapter("schwab", { available: true, result: { bid: 2 } });
    const sel = build({ ibkr, schwab }, baseConfig(), router);

    expect(sel.brokersServingAsFallback().size).toBe(0);
    await sel.dispatch("quote", "ibkr", callQuote);
    expect([...sel.brokersServingAsFallback()]).toEqual(["schwab"]);

    (ibkr.available as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await sel.dispatch("quote", "ibkr", callQuote);
    expect(sel.brokersServingAsFallback().size).toBe(0);
  });
});
