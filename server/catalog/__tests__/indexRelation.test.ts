// ── indexRelation unit tests ──────────────────────────────────────

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIndexRelationLookup } from "../indexRelation.js";

const UNIVERSE_FIXTURE = `
# ── Broad Market ETFs ─────────────────────────────────────────────
SPY
QQQ

# ── S&P 500 Constituents ─────────────────────────────────────────
AAPL
MSFT
TMUS

# ── NASDAQ-100 extras (not in S&P 500) ───────────────────────────
ASML
MELI
`;

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
  const path = join(dir, "universe.txt");
  writeFileSync(path, UNIVERSE_FIXTURE);
  return path;
}

describe("createIndexRelationLookup", () => {
  const lookup = createIndexRelationLookup(writeFixture());

  it("classifies broad market ETFs as spx-index", () => {
    expect(lookup.classify("SPY")).toBe("spx-index");
    expect(lookup.classify("QQQ")).toBe("spx-index");
    expect(lookup.classify("IVV")).toBe("spx-index");
  });

  it("classifies VIX derivatives", () => {
    expect(lookup.classify("VXX")).toBe("vix-derived");
    expect(lookup.classify("UVXY")).toBe("vix-derived");
  });

  it("classifies parsed S&P 500 components", () => {
    expect(lookup.classify("AAPL")).toBe("spx-component");
    expect(lookup.classify("TMUS")).toBe("spx-component");
  });

  it("classifies NDX extras distinctly from SPX components", () => {
    expect(lookup.classify("ASML")).toBe("ndx-extra");
  });

  it("classifies sector ETFs", () => {
    expect(lookup.classify("XLE")).toBe("sector-etf");
    expect(lookup.classify("USO")).toBe("sector-etf");
  });

  it("strips EQ: prefix used by signal producers", () => {
    expect(lookup.classify("EQ:SPY")).toBe("spx-index");
    expect(lookup.classify("EQ:AAPL")).toBe("spx-component");
  });

  it("normalizes futures symbols (root and contract month)", () => {
    expect(lookup.classify("/CL")).toBe("commodity");
    expect(lookup.classify("CLM25")).toBe("commodity");
    expect(lookup.classify("CL.c.0")).toBe("commodity");
  });

  it("classifies FRED macro series codes", () => {
    expect(lookup.classify("fed_funds_rate")).toBe("rates");
    expect(lookup.classify("treasury_10y")).toBe("rates");
    expect(lookup.classify("BAMLH0A0HYM2")).toBe("credit");
    expect(lookup.classify("DTWEXBGS")).toBe("fx");
  });

  it("falls back to unrelated for unknown symbols", () => {
    expect(lookup.classify("FOOBAR")).toBe("unrelated");
    expect(lookup.classify("")).toBe("unrelated");
  });
});
