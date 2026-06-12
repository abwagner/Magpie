// QF-335 — NATS subject builders + cross-language parity.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { orders, marketdata } from "./subjects.js";

// ── Direct builder assertions ──────────────────────────────────────

describe("orders subjects", () => {
  it("builds the five OPL↔bridge subjects", () => {
    expect(orders.submit("schwab")).toBe("orders.submit.schwab");
    expect(orders.cancel("schwab")).toBe("orders.cancel.schwab");
    expect(orders.status("ibkr")).toBe("orders.status.ibkr");
    expect(orders.positions("ibkr")).toBe("orders.positions.ibkr");
    expect(orders.accounts("schwab")).toBe("orders.accounts.schwab");
    expect(orders.execReports("schwab")).toBe("orders.exec_reports.schwab");
  });

  it("exposes gate as callable with a .revoke method", () => {
    expect(orders.gate("schwab")).toBe("orders.gate.schwab");
    expect(orders.gate.revoke("schwab")).toBe("orders.gate.revoke.schwab");
  });
});

describe("marketdata subjects", () => {
  it("builds the rpc family", () => {
    expect(marketdata.rpc.quote("schwab")).toBe("marketdata.rpc.quote.schwab");
    expect(marketdata.rpc.historicalChain("ibkr")).toBe(
      "marketdata.rpc.historical_chain.ibkr",
    );
  });

  it("builds stream bases and per-symbol subjects", () => {
    expect(marketdata.quotes("schwab")).toBe("marketdata.quotes.schwab");
    expect(marketdata.quotes("schwab", "EQ.SPY")).toBe(
      "marketdata.quotes.schwab.EQ.SPY",
    );
    expect(marketdata.stream("book", "ibkr", "EQ.SPY")).toBe(
      "marketdata.book.ibkr.EQ.SPY",
    );
  });

  it("builds the heartbeat subject", () => {
    expect(marketdata.heartbeat("schwab")).toBe("marketdata.schwab.heartbeat");
  });
});

// ── Cross-language parity ──────────────────────────────────────────
// The same fixture is asserted by the Python mirror
// (research/magpie-subjects) so both languages provably emit
// identical subject strings for identical inputs.

interface Case {
  builder: string;
  args: string[];
  expected: string;
}

const DISPATCH: Record<string, (...a: string[]) => string> = {
  "orders.submit": (b) => orders.submit(b!),
  "orders.cancel": (b) => orders.cancel(b!),
  "orders.status": (b) => orders.status(b!),
  "orders.positions": (b) => orders.positions(b!),
  "orders.accounts": (b) => orders.accounts(b!),
  "orders.exec_reports": (b) => orders.execReports(b!),
  "orders.gate": (b) => orders.gate(b!),
  "orders.gate.revoke": (b) => orders.gate.revoke(b!),
  "marketdata.rpc.quote": (b) => marketdata.rpc.quote(b!),
  "marketdata.rpc.expirations": (b) => marketdata.rpc.expirations(b!),
  "marketdata.rpc.chain": (b) => marketdata.rpc.chain(b!),
  "marketdata.rpc.historical_chain": (b) => marketdata.rpc.historicalChain(b!),
  "marketdata.rpc.candles": (b) => marketdata.rpc.candles(b!),
  "marketdata.quotes": (b, s) => marketdata.quotes(b!, s),
  "marketdata.trades": (b, s) => marketdata.trades(b!, s),
  "marketdata.book": (b, s) => marketdata.book(b!, s),
  "marketdata.heartbeat": (b) => marketdata.heartbeat(b!),
};

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/tdd/nats-subjects.fixtures.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
  cases: Case[];
};

describe("cross-language parity fixture", () => {
  it("covers every builder in the dispatch table", () => {
    const seen = new Set(fixture.cases.map((c) => c.builder));
    for (const name of Object.keys(DISPATCH)) {
      expect(seen).toContain(name);
    }
  });

  for (const c of fixture.cases) {
    it(`${c.builder}(${c.args.join(", ")}) → ${c.expected}`, () => {
      const build = DISPATCH[c.builder];
      expect(build, `no dispatch for ${c.builder}`).toBeDefined();
      expect(build!(...c.args)).toBe(c.expected);
    });
  }
});
