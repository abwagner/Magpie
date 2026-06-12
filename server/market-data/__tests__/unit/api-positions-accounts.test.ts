// QF-272 — /api/positions + /api/accounts source from the NT broker
// when one is wired, falling back to the schwab-rest REST client on
// error / when no broker is present. schwab-rest is mocked so the
// fallback is observable without live Schwab creds.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrokerAdapter } from "../../../../src/types/order.js";
import type { MarketDataService } from "../../../../src/types/market-data.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";

vi.mock("../../../order/adapters/schwab-rest.js", () => ({
  fetchSchwabPositions: vi.fn(),
  fetchSchwabAccounts: vi.fn(),
}));

import { fetchSchwabPositions, fetchSchwabAccounts } from "../../../order/adapters/schwab-rest.js";
import { createMarketDataApi, type MarketDataApiDeps } from "../../api.js";

const mockFetchPositions = fetchSchwabPositions as unknown as ReturnType<typeof vi.fn>;
const mockFetchAccounts = fetchSchwabAccounts as unknown as ReturnType<typeof vi.fn>;

// Minimal captured response.
interface CapturedRes {
  res: ServerResponse;
  status(): number;
  body(): unknown;
}

function fakeRes(): CapturedRes {
  let status = 200;
  let body: unknown;
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(payload?: string) {
      body = payload ? JSON.parse(payload) : undefined;
      return res;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

function fakeReq(url = "/api/positions"): IncomingMessage {
  return { url } as IncomingMessage;
}

function makeApi(broker?: BrokerAdapter, service?: Partial<MarketDataService>) {
  const deps = {
    // QF-355: handlePositions calls service.getChain to fill option
    // greeks; tests with held options pass a getChain stub. Rows with
    // no options never touch it (enrichment early-returns).
    service: (service ?? {}) as MarketDataService,
    adapters: [],
    logger: createTestLogger(),
    ...(broker ? { broker } : {}),
  } as MarketDataApiDeps;
  return createMarketDataApi(deps);
}

function brokerWith(over: Partial<BrokerAdapter>): BrokerAdapter {
  return over as BrokerAdapter;
}

beforeEach(() => {
  mockFetchPositions.mockReset();
  mockFetchAccounts.mockReset();
});

describe("handlePositions (QF-272)", () => {
  it("uses the NT broker and categorizes its raw rows", async () => {
    const broker = brokerWith({
      getPositions: async () => [
        {
          symbol: "AAPL",
          direction: "Long",
          quantity: 10,
          raw: {
            instrument: { assetType: "EQUITY", symbol: "AAPL" },
            longQuantity: 10,
            shortQuantity: 0,
            averagePrice: 100,
            marketValue: 1100,
            currentDayProfitLoss: 5,
          },
        },
      ],
    });
    const api = makeApi(broker);
    const r = fakeRes();
    await api.handlePositions(fakeReq(), r.res);

    expect(mockFetchPositions).not.toHaveBeenCalled();
    const body = r.body() as { equities: Array<{ symbol: string }> };
    expect(body.equities[0]!.symbol).toBe("AAPL");
  });

  it("enriches held-option greeks from the MD chain (QF-355)", async () => {
    const broker = brokerWith({
      getPositions: async () => [
        {
          symbol: "SPY   260619C00500000",
          direction: "Long",
          quantity: 1,
          raw: {
            instrument: {
              assetType: "OPTION",
              symbol: "SPY   260619C00500000",
              putCall: "CALL",
            },
            longQuantity: 1,
            shortQuantity: 0,
            averagePrice: 4,
            marketValue: 105,
            currentDayProfitLoss: 0,
          },
        },
      ],
    });
    const getChain = vi.fn().mockResolvedValue([
      { side: "call", strike: 500, delta: 0.52, gamma: 0.015, theta: -0.08, vega: 0.22 },
    ]);
    const api = makeApi(broker, { getChain } as Partial<MarketDataService>);
    const r = fakeRes();
    await api.handlePositions(fakeReq(), r.res);

    expect(getChain).toHaveBeenCalledWith("SPY", "2026-06-19");
    const body = r.body() as { options: Array<{ delta: number; vega: number }> };
    expect(body.options[0]!.delta).toBe(0.52);
    expect(body.options[0]!.vega).toBe(0.22);
  });

  it("falls back to schwab-rest when the NT broker throws", async () => {
    const broker = brokerWith({
      getPositions: async () => {
        throw new Error("NT down");
      },
    });
    mockFetchPositions.mockResolvedValueOnce({ options: [], equities: [], futures: [] });
    const api = makeApi(broker);
    const r = fakeRes();
    await api.handlePositions(fakeReq(), r.res);

    expect(mockFetchPositions).toHaveBeenCalledOnce();
    expect(r.status()).toBe(200);
  });

  it("uses schwab-rest directly when no broker is wired", async () => {
    mockFetchPositions.mockResolvedValueOnce({ options: [], equities: [], futures: [] });
    const api = makeApi();
    const r = fakeRes();
    await api.handlePositions(fakeReq(), r.res);
    expect(mockFetchPositions).toHaveBeenCalledOnce();
  });

  it("uses schwab-rest (not NT) when a specific account is requested", async () => {
    const broker = brokerWith({
      getPositions: vi.fn(async () => []),
    });
    mockFetchPositions.mockResolvedValueOnce({ options: [], equities: [], futures: [] });
    const api = makeApi(broker);
    const r = fakeRes();
    await api.handlePositions(fakeReq("/api/positions?account=HASH9"), r.res);
    expect(broker.getPositions).not.toHaveBeenCalled();
    expect(mockFetchPositions).toHaveBeenCalledWith("HASH9");
  });
});

describe("handleAccounts (QF-272)", () => {
  it("uses the NT broker's getAccounts", async () => {
    const broker = brokerWith({
      getAccounts: async () => [{ accountNumber: "1", hashValue: "H", type: "CASH" }],
    });
    const api = makeApi(broker);
    const r = fakeRes();
    await api.handleAccounts(fakeReq("/api/accounts"), r.res);
    expect(mockFetchAccounts).not.toHaveBeenCalled();
    expect(r.body()).toEqual({ accounts: [{ accountNumber: "1", hashValue: "H", type: "CASH" }] });
  });

  it("falls back to schwab-rest when NT getAccounts throws", async () => {
    const broker = brokerWith({
      getAccounts: async () => {
        throw new Error("NT down");
      },
    });
    mockFetchAccounts.mockResolvedValueOnce([{ accountNumber: "2", hashValue: "H2" }]);
    const api = makeApi(broker);
    const r = fakeRes();
    await api.handleAccounts(fakeReq("/api/accounts"), r.res);
    expect(mockFetchAccounts).toHaveBeenCalledOnce();
    expect(r.body()).toEqual({ accounts: [{ accountNumber: "2", hashValue: "H2" }] });
  });

  it("falls back to schwab-rest when the broker has no getAccounts", async () => {
    const broker = brokerWith({ getPositions: async () => [] });
    mockFetchAccounts.mockResolvedValueOnce([{ accountNumber: "3", hashValue: "H3" }]);
    const api = makeApi(broker);
    const r = fakeRes();
    await api.handleAccounts(fakeReq("/api/accounts"), r.res);
    expect(mockFetchAccounts).toHaveBeenCalledOnce();
  });
});
