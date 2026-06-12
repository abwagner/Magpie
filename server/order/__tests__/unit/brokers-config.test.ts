// Unit tests for the brokers config loader (QF-242 / QF-243).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBrokersConfig,
  resolveAccountForPortfolio,
  BrokersConfigError,
} from "../../brokers-config.js";
import type { PortfolioRoutingEntry } from "../../brokers-config.js";

interface CapturedLog {
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  fields?: Record<string, unknown>;
}

function makeLogger(): {
  logs: CapturedLog[];
  child: () => ReturnType<typeof makeLogger>["child"];
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
  debug: (msg: string, fields?: Record<string, unknown>) => void;
} {
  const logs: CapturedLog[] = [];
  const log = (level: CapturedLog["level"]) => (msg: string, fields?: Record<string, unknown>) =>
    void logs.push({ level, msg, ...(fields ? { fields } : {}) });
  return {
    logs,
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    debug: log("debug"),
    child: () => makeLogger() as never,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function write(dir: string, filename: string, content: unknown): void {
  writeFileSync(join(dir, filename), JSON.stringify(content));
}

// QF-341 — BrokersConfig now requires a `marketdata` block. resolveAccount
// tests don't exercise it, so attach a default to keep them type-safe.
function withMd(schwab: { accounts: Array<{ id: string; label: string; enabled: boolean }> }) {
  return {
    schwab,
    marketdata: { fallback_enabled: false, priority: [], methods: {}, heartbeat_stale_ms: 30000 },
  };
}

// ── Legacy (QF-242) shape tests ───────────────────────────────────

describe("loadBrokersConfig — legacy shape (QF-242 backward compat)", () => {
  let dir: string;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brokers-config-"));
    logger = makeLogger();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when the file is missing", () => {
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.schwab.accounts).toHaveLength(1);
    expect(cfg.schwab.accounts[0]?.enabled).toBe(false);
    expect(logger.logs.some((l) => l.level === "info" && l.msg.includes("not found"))).toBe(true);
  });

  it("synthesises a single default account from legacy enabled=false shape", () => {
    write(dir, "brokers.json", { schwab: { enabled: false } });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.schwab.accounts).toHaveLength(1);
    expect(cfg.schwab.accounts[0]?.id).toBe("default");
    expect(cfg.schwab.accounts[0]?.enabled).toBe(false);
    expect(logger.logs.some((l) => l.level === "warn" && l.msg.includes("legacy"))).toBe(true);
  });

  it("synthesises a single enabled account from legacy enabled=true shape", () => {
    write(dir, "brokers.json", {
      schwab: { enabled: true, submit_timeout_ms: 7000, query_timeout_ms: 1500 },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.schwab.accounts).toHaveLength(1);
    expect(cfg.schwab.accounts[0]?.enabled).toBe(true);
    expect(cfg.schwab.accounts[0]?.submit_timeout_ms).toBe(7000);
    expect(cfg.schwab.accounts[0]?.query_timeout_ms).toBe(1500);
    expect(logger.logs.some((l) => l.level === "warn" && l.msg.includes("legacy"))).toBe(true);
  });

  it("defaults schwab disabled when the schwab key is missing", () => {
    write(dir, "brokers.json", {});
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.schwab.accounts[0]?.enabled).toBe(false);
  });

  it("logs + ignores unknown broker keys (forward-compat)", () => {
    write(dir, "brokers.json", { schwab: { enabled: false }, ibkr: { enabled: true } });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.schwab.accounts[0]?.enabled).toBe(false);
    expect(
      logger.logs.some(
        (l) =>
          l.level === "warn" && l.msg.includes("unknown broker key") && l.fields?.key === "ibkr",
      ),
    ).toBe(true);
  });

  it("throws on unknown fields under legacy schwab (typo guard)", () => {
    write(dir, "brokers.json", { schwab: { enabled: true, enbaled: true } }); // typo
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(BrokersConfigError);
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/unknown field "enbaled"/);
  });

  it("throws when legacy enabled is not a boolean", () => {
    write(dir, "brokers.json", { schwab: { enabled: "true" } });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/must be a boolean/);
  });

  it("throws on non-positive timeouts in legacy shape", () => {
    write(dir, "brokers.json", { schwab: { enabled: true, submit_timeout_ms: 0 } });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/positive number/);
  });

  it("throws on malformed JSON", () => {
    writeFileSync(join(dir, "brokers.json"), "{ this is not json");
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(BrokersConfigError);
  });

  it("throws when the top-level isn't an object", () => {
    writeFileSync(join(dir, "brokers.json"), "[]");
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/top-level must be an object/);
  });

  it("throws when schwab isn't an object", () => {
    write(dir, "brokers.json", { schwab: "enabled" });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/schwab must be an object/);
  });
});

// ── New multi-account shape tests (QF-243) ────────────────────────

describe("loadBrokersConfig — multi-account shape (QF-243)", () => {
  let dir: string;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brokers-config-multi-"));
    logger = makeLogger();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a valid two-account config", () => {
    write(dir, "brokers.json", {
      schwab: {
        accounts: [
          { id: "personal", label: "Schwab Brokerage — Personal", enabled: true },
          { id: "ira", label: "Schwab IRA", enabled: false },
        ],
      },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.schwab.accounts).toHaveLength(2);
    expect(cfg.schwab.accounts[0]?.id).toBe("personal");
    expect(cfg.schwab.accounts[0]?.enabled).toBe(true);
    expect(cfg.schwab.accounts[1]?.id).toBe("ira");
    expect(cfg.schwab.accounts[1]?.enabled).toBe(false);
    // No legacy warning should be emitted
    expect(logger.logs.some((l) => l.level === "warn" && l.msg.includes("legacy"))).toBe(false);
  });

  it("label defaults to id when omitted", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "personal", enabled: true }] },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.schwab.accounts[0]?.label).toBe("personal");
  });

  it("preserves explicit label", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "personal", label: "My Personal Schwab", enabled: true }] },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.schwab.accounts[0]?.label).toBe("My Personal Schwab");
  });

  it("parses optional timeouts per account", () => {
    write(dir, "brokers.json", {
      schwab: {
        accounts: [{ id: "main", enabled: true, submit_timeout_ms: 5000, query_timeout_ms: 2000 }],
      },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.schwab.accounts[0]?.submit_timeout_ms).toBe(5000);
    expect(cfg.schwab.accounts[0]?.query_timeout_ms).toBe(2000);
  });

  it("throws when accounts array is missing id", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ enabled: true }] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/missing required field "id"/);
  });

  it("throws when id is empty string", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "", enabled: true }] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(
      /"id" must be a non-empty string/,
    );
  });

  it("throws when id contains invalid characters (not slug-safe)", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "My Account", enabled: true }] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/must match \[a-z0-9_-\]\+/);
  });

  it("throws on duplicate account ids", () => {
    write(dir, "brokers.json", {
      schwab: {
        accounts: [
          { id: "main", enabled: true },
          { id: "main", enabled: false },
        ],
      },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/duplicate account id "main"/);
  });

  it("throws when enabled is missing from an account", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main" }] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(
      /missing required field "enabled"/,
    );
  });

  it("throws when enabled is not a boolean on an account", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: "yes" }] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/"enabled" must be a boolean/);
  });

  it("accepts an all-disabled accounts array as a paper-only config", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: false }] },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.schwab.accounts).toHaveLength(1);
    expect(cfg.schwab.accounts.some((a) => a.enabled)).toBe(false);
  });

  it("throws when accounts array is empty", () => {
    write(dir, "brokers.json", { schwab: { accounts: [] } });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/must not be empty/);
  });

  it("throws when accounts is not an array", () => {
    write(dir, "brokers.json", { schwab: { accounts: {} } });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/accounts must be an array/);
  });

  it("throws on unknown field in account entry", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true, typo_field: 1 }] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/unknown field "typo_field"/);
  });

  it("throws on non-positive timeout in account entry", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true, submit_timeout_ms: -1 }] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/positive number/);
  });

  it("throws on unknown field alongside accounts[]", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }], extra: true },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(
      /unexpected field "extra" alongside accounts\[\]/,
    );
  });
});

// ── Portfolio routing validation ──────────────────────────────────

describe("loadBrokersConfig — portfolio routing validation", () => {
  let dir: string;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brokers-config-routing-"));
    logger = makeLogger();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts routing entries that reference existing account ids", () => {
    write(dir, "brokers.json", {
      schwab: {
        accounts: [
          { id: "personal", enabled: true },
          { id: "ira", enabled: true },
        ],
      },
    });
    const routing: PortfolioRoutingEntry[] = [
      { portfolioId: "main", accountId: "personal" },
      { portfolioId: "roth", accountId: "ira" },
    ];
    expect(() => loadBrokersConfig(dir, logger as never, routing)).not.toThrow();
  });

  it("throws when a portfolio references a non-existent account_id", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "personal", enabled: true }] },
    });
    const routing: PortfolioRoutingEntry[] = [{ portfolioId: "main", accountId: "nonexistent" }];
    expect(() => loadBrokersConfig(dir, logger as never, routing)).toThrow(
      /portfolio "main" references unknown account_id "nonexistent"/,
    );
  });

  it("accepts routing entries without an account_id (will fall back to first enabled)", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "personal", enabled: true }] },
    });
    const routing: PortfolioRoutingEntry[] = [{ portfolioId: "main" }];
    expect(() => loadBrokersConfig(dir, logger as never, routing)).not.toThrow();
  });
});

// ── marketdata fallback block (QF-341) ────────────────────────────

describe("loadBrokersConfig — marketdata fallback block (QF-341)", () => {
  let dir: string;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brokers-config-md-"));
    logger = makeLogger();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to fallback disabled when the block is absent", () => {
    write(dir, "brokers.json", { schwab: { accounts: [{ id: "a", enabled: true }] } });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.marketdata.fallback_enabled).toBe(false);
    expect(cfg.marketdata.priority).toEqual([]);
    expect(cfg.marketdata.methods).toEqual({});
    expect(cfg.marketdata.heartbeat_stale_ms).toBe(30000);
  });

  it("defaults to fallback disabled when the file is missing", () => {
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.marketdata.fallback_enabled).toBe(false);
    expect(cfg.marketdata.priority).toEqual([]);
  });

  it("parses a valid enabled block with priority over enabled brokers", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      ibkr: { enabled: true },
      marketdata: { fallback_enabled: true, priority: ["ibkr", "schwab"] },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.marketdata.fallback_enabled).toBe(true);
    expect(cfg.marketdata.priority).toEqual(["ibkr", "schwab"]);
  });

  it("accepts a disabled block naming brokers that aren't enabled yet (documents intent)", () => {
    // The ratified default ships fallback_enabled:false + ["ibkr","schwab"]
    // before either broker is enabled; that must load without error.
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: false }] },
      marketdata: { fallback_enabled: false, priority: ["ibkr", "schwab"] },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.marketdata.fallback_enabled).toBe(false);
    expect(cfg.marketdata.priority).toEqual(["ibkr", "schwab"]);
  });

  it("rejects an enabled priority entry that is not an enabled broker", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { fallback_enabled: true, priority: ["ibkr", "schwab"] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(BrokersConfigError);
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/not an enabled broker/);
  });

  it("rejects a non-array priority", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { fallback_enabled: true, priority: "schwab" },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/must be an array/);
  });

  it("rejects an empty priority array", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { fallback_enabled: true, priority: [] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/non-empty array/);
  });

  it("rejects duplicate priority entries", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { fallback_enabled: true, priority: ["schwab", "schwab"] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/duplicate/);
  });

  it("rejects non-slug priority entries", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { fallback_enabled: true, priority: ["Schwab!"] },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/slug-safe/);
  });

  it("parses a per-method override and inherits global for absent methods", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      ibkr: { enabled: true },
      marketdata: {
        fallback_enabled: true,
        priority: ["ibkr", "schwab"],
        methods: {
          quote: { fallback_enabled: true, priority: ["ibkr", "schwab"] },
          candles: { fallback_enabled: false },
        },
      },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.marketdata.methods.quote).toEqual({
      fallback_enabled: true,
      priority: ["ibkr", "schwab"],
    });
    expect(cfg.marketdata.methods.candles).toEqual({ fallback_enabled: false });
    expect(cfg.marketdata.methods.chain).toBeUndefined();
  });

  it("rejects an ineligible method key (historical_chain)", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { methods: { historical_chain: { fallback_enabled: true } } },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/not a fallback-eligible method/);
  });

  it("rejects an unknown method key", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { methods: { submit: { fallback_enabled: true } } },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/not a fallback-eligible method/);
  });

  it("rejects an unknown top-level field in the marketdata block", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { fallback_enabled: false, bogus: true },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/unknown field "bogus"/);
  });

  it("rejects an unknown field inside a method override", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { methods: { quote: { fallback_enabled: true, bogus: 1 } } },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/unknown field "bogus"/);
  });

  it("rejects a non-positive heartbeat_stale_ms", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { heartbeat_stale_ms: 0 },
    });
    expect(() => loadBrokersConfig(dir, logger as never)).toThrow(/positive number/);
  });

  it("warns on enabled + single-element priority (can never fall back)", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { fallback_enabled: true, priority: ["schwab"] },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.marketdata.priority).toEqual(["schwab"]);
    expect(
      logger.logs.some((l) => l.level === "warn" && l.msg.includes("can never fall back")),
    ).toBe(true);
  });

  it("ignores a _doc string inside the marketdata block", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { _doc: "explanatory text", fallback_enabled: false },
    });
    const cfg = loadBrokersConfig(dir, logger as never);
    expect(cfg.marketdata.fallback_enabled).toBe(false);
  });

  it("does not warn 'unknown broker key' for the marketdata block", () => {
    write(dir, "brokers.json", {
      schwab: { accounts: [{ id: "main", enabled: true }] },
      marketdata: { fallback_enabled: false },
    });
    loadBrokersConfig(dir, logger as never);
    expect(
      logger.logs.some(
        (l) => l.level === "warn" && l.fields?.key === "marketdata",
      ),
    ).toBe(false);
  });
});

// ── resolveAccountForPortfolio ────────────────────────────────────

describe("resolveAccountForPortfolio", () => {
  it("returns the matching enabled account when accountId is specified", () => {
    const cfg = withMd({
      accounts: [
        { id: "personal", label: "Personal", enabled: true },
        { id: "ira", label: "IRA", enabled: true },
      ],
    });
    const result = resolveAccountForPortfolio(cfg, "ira");
    expect(result?.id).toBe("ira");
  });

  it("falls back to first enabled account when accountId is undefined", () => {
    const cfg = withMd({
      accounts: [
        { id: "personal", label: "Personal", enabled: true },
        { id: "ira", label: "IRA", enabled: true },
      ],
    });
    const result = resolveAccountForPortfolio(cfg, undefined);
    expect(result?.id).toBe("personal");
  });

  it("falls back to first enabled when specified accountId is disabled", () => {
    const cfg = withMd({
      accounts: [
        { id: "personal", label: "Personal", enabled: true },
        { id: "ira", label: "IRA", enabled: false },
      ],
    });
    const result = resolveAccountForPortfolio(cfg, "ira");
    // ira is disabled, fall back to first enabled (personal)
    expect(result?.id).toBe("personal");
  });

  it("returns null when no enabled accounts exist", () => {
    const cfg = withMd({
      accounts: [{ id: "main", label: "main", enabled: false }],
    });
    const result = resolveAccountForPortfolio(cfg, undefined);
    expect(result).toBeNull();
  });

  it("is deterministic — always returns the same account for the same config+id", () => {
    const cfg = withMd({
      accounts: [
        { id: "a", label: "A", enabled: true },
        { id: "b", label: "B", enabled: true },
      ],
    });
    expect(resolveAccountForPortfolio(cfg, "b")?.id).toBe("b");
    expect(resolveAccountForPortfolio(cfg, "b")?.id).toBe("b");
    expect(resolveAccountForPortfolio(cfg, undefined)?.id).toBe("a");
  });
});
