import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNightlyLog,
  loadNightlyLog,
  activityFromRaw,
  _resetCache,
} from "../../parsers/nightly-log.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nightly-log-"));
  _resetCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const COMPLETE_RUN = `
  ── Nightly Collection ──
  2026-04-26 23:36:54


  Bulk Collection

  Range:       2019-01-02 → 2026-04-25 (1894 trading days)
  Symbols:     2
  Concurrency: 8

  [1/2] SPY  2019-01-02 → 2021-03-31  (backfill)
  [2/2] QQQ  2019-01-02 → 2021-03-31  (backfill)

[marketdata] 203 /options/chain/SPY/  280ms  credits=99000/100000
[marketdata] 404 /options/chain/QQQ/  131ms  credits=98999/100000
  → Wrote SPY-2019-01.parquet
    72 contracts (1 credits used [98998 remaining])

  Done
  Fetched:    105,875 requests in 6270s (16.9 req/s)
  Contracts:  4,247,781
  Credits:    95,006 used, 4,993 remaining
  Holidays:   10868 market-closed dates discovered
  Storage:    50523 parquet files


  ── Nightly Complete ──
  2026-04-27 01:20:31
`;

const CREDIT_CAP_RUN = `
  ── Nightly Collection ──
  2026-04-25 23:00:00

  [1/1] SPY  2019-01-02 → 2026-04-24  (backfill)

[marketdata] 203 /options/chain/SPY/  280ms  credits=5006/100000
  Credits low (4999 remaining, reserve 5000) — stopping.

  Done
  Fetched:    100,000 requests in 7000s (14.3 req/s)
  Contracts:  3,000,000
  Credits:    95,001 used, 4,999 remaining
  Holidays:   500 market-closed dates discovered
  Storage:    40000 parquet files


  ── Nightly Complete ──
  2026-04-26 00:56:40
`;

const INCOMPLETE_RUN = `
  ── Nightly Collection ──
  2026-04-24 23:00:00

  [1/1] AAPL  2019-01-02 → 2026-04-23  (backfill)
[marketdata] 203 /options/chain/AAPL/  280ms  credits=99000/100000
`;

const OLD_FORMAT_STORAGE = `
  ── Nightly Collection ──
  2026-04-11 00:00:01

  [1/1] SPY  2019-01-02 → 2026-04-10  (backfill)

  Done
  Fetched:    50,000 requests in 3000s (16.7 req/s)
  Contracts:  1,000,000
  Credits:    50,000 used, 50,000 remaining
  Holidays:   100 market-closed dates discovered
  Storage:    359M in 4321 files


  ── Nightly Complete ──
  2026-04-11 02:00:00
`;

describe("parseNightlyLog", () => {
  it("parses a complete run with summary block", async () => {
    const path = join(dir, "log.txt");
    writeFileSync(path, COMPLETE_RUN);

    const parsed = await parseNightlyLog(path, "marketdata.app:chains-nightly");
    expect(parsed).toHaveLength(1);
    const run = parsed[0]!.run;
    expect(run.id).toBe("chains-nightly:2026-04-26T23:36:54Z");
    expect(run.source).toBe("marketdata.app:chains-nightly");
    expect(run.started_at).toBe("2026-04-26T23:36:54Z");
    expect(run.finished_at).toBe("2026-04-27T01:20:31Z");
    expect(run.status).toBe("ok");
    expect(run.request_count).toBe(105875);
    expect(run.duration_seconds).toBe(6270);
    expect(run.rows_written).toBe(4247781);
    expect(run.files_written).toBe(50523);
    expect(run.credits).toEqual({ used: 95006, remaining: 4993, cap: 100000 });
    expect(run.error_count).toBe(1); // the 404 on QQQ
  });

  it("flags credit-cap stops as stopped-credit-cap", async () => {
    const path = join(dir, "log.txt");
    writeFileSync(path, CREDIT_CAP_RUN);

    const parsed = await parseNightlyLog(path, "marketdata.app:chains-nightly");
    expect(parsed).toHaveLength(1);
    const run = parsed[0]!.run;
    expect(run.status).toBe("stopped-credit-cap");
    expect(run.notes).toContain("Credits low — stopping");
  });

  it("treats unfinished runs as incomplete", async () => {
    const path = join(dir, "log.txt");
    writeFileSync(path, INCOMPLETE_RUN);

    const parsed = await parseNightlyLog(path, "marketdata.app:chains-nightly");
    expect(parsed).toHaveLength(1);
    const run = parsed[0]!.run;
    expect(run.status).toBe("incomplete");
    expect(run.finished_at).toBeNull();
    expect(run.duration_seconds).toBeNull();
  });

  it("handles the older 'Storage: 359M in N files' format", async () => {
    const path = join(dir, "log.txt");
    writeFileSync(path, OLD_FORMAT_STORAGE);

    const parsed = await parseNightlyLog(path, "marketdata.app:chains-nightly");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.run.files_written).toBe(4321);
  });

  it("splits multiple runs concatenated in one file", async () => {
    const path = join(dir, "log.txt");
    writeFileSync(path, COMPLETE_RUN + CREDIT_CAP_RUN + INCOMPLETE_RUN);

    const parsed = await parseNightlyLog(path, "marketdata.app:chains-nightly");
    expect(parsed).toHaveLength(3);
    expect(parsed.map((p) => p.run.status)).toEqual(["ok", "stopped-credit-cap", "incomplete"]);
  });

  it("aggregates per-symbol activity for drilldown", async () => {
    const path = join(dir, "log.txt");
    writeFileSync(path, COMPLETE_RUN);

    const parsed = await parseNightlyLog(path, "marketdata.app:chains-nightly");
    const activity = activityFromRaw(parsed[0]!.raw);
    const spy = activity.find((a) => a.symbol === "SPY");
    const qqq = activity.find((a) => a.symbol === "QQQ");
    expect(spy).toBeTruthy();
    expect(spy?.files_touched).toBe(1);
    expect(qqq).toBeTruthy();
    expect(qqq?.errors).toHaveLength(1);
    expect(qqq?.errors[0]?.http_status).toBe(404);
  });

  it("returns [] when the log file is missing", async () => {
    const parsed = await loadNightlyLog(join(dir, "nope.log"), "x");
    expect(parsed).toEqual([]);
  });
});
