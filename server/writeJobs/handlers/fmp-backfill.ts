// ── Handler: fmp-backfill (M10-1) ─────────────────────────────────
//
// First handler. Reuses the FMP_BACKFILL_KINDS registry from QF-191's
// fmp.ts: 7 historical pulls (dividends, splits, income / balance /
// cash flow, key metrics, daily ratings) per ticker into
// `${DATA_URI}/fundamentals/fmp/historical_*.parquet`.
//
// Resumability: the runner's progress column tracks per-ticker
// progress. Re-running a completed job creates a fresh job (different
// idempotency_key if any param changed; otherwise the runner dedups).
// True per-(kind, ticker) resumability within a single job comes from
// `mergeAndWriteParquet`'s upsert semantics — repeated calls converge.

import {
  FMP_BACKFILL_KINDS,
  fmpGetJson,
  makeFmpRateLimiter,
} from "../../orchestrator/adapters/fmp.js";
import { joinUri, mergeAndWriteParquet, readParquet } from "../../orchestrator/storage.js";
import type { HandlerResult, JobHandler } from "../types.js";

export interface FmpBackfillParams {
  /** Path relative to DATA_URI. Defaults to the yfinance universe. */
  universe_parquet?: string;
  /** Override `FMP_RATE_LIMIT_PER_SEC` for this job. */
  rate_limit_per_sec?: number;
}

const DEFAULT_UNIVERSE = "fundamentals/yfinance/universe.parquet";

export const fmpBackfillHandler: JobHandler<FmpBackfillParams> = {
  kind: "fmp-backfill",

  sourceFor(): string | null {
    return "fmp";
  },

  validate(params): string[] {
    if (typeof params !== "object" || params === null) {
      return ["params must be an object"];
    }
    const p = params as Record<string, unknown>;
    const errors: string[] = [];
    if (p.universe_parquet !== undefined && typeof p.universe_parquet !== "string") {
      errors.push("universe_parquet must be a string");
    }
    if (p.rate_limit_per_sec !== undefined) {
      const n = p.rate_limit_per_sec;
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
        errors.push("rate_limit_per_sec must be a positive number");
      }
    }
    return errors;
  },

  async run(params, progress, ctx): Promise<HandlerResult> {
    const universePath = params.universe_parquet ?? DEFAULT_UNIVERSE;
    const rateLimit =
      params.rate_limit_per_sec ?? Number(process.env.FMP_RATE_LIMIT_PER_SEC ?? "4");

    const universeUri = joinUri(universePath);
    const universe = await readParquet<{ ticker: string }>(universeUri, {
      columns: ["ticker"],
    });
    const tickers = [...new Set(universe.map((r) => r.ticker).filter(Boolean))];
    if (tickers.length === 0) {
      throw new Error(`universe ${universePath} has no tickers`);
    }

    const outputs: Record<string, string> = {};
    for (const spec of FMP_BACKFILL_KINDS) {
      outputs[spec.kind] = joinUri(`fundamentals/fmp/${spec.kind}.parquet`);
    }

    const limiter = makeFmpRateLimiter(rateLimit);
    const ts = new Date()
      .toISOString()
      .replace(/T/, " ")
      .replace(/\.\d+Z$/, "");
    const pending: Record<string, Array<Record<string, unknown>>> = {};
    for (const spec of FMP_BACKFILL_KINDS) pending[spec.kind] = [];

    const total = tickers.length;
    progress(0, total, "starting");
    ctx.logger.info("fmp-backfill starting", {
      tickers: total,
      kinds: FMP_BACKFILL_KINDS.length,
      rate_limit_per_sec: rateLimit,
    });

    const FLUSH_EVERY = Number(process.env.FMP_BACKFILL_FLUSH_EVERY ?? "50");

    let processed = 0;
    for (const ticker of tickers) {
      for (const spec of FMP_BACKFILL_KINDS) {
        try {
          await limiter.acquire();
          const resp = await fmpGetJson<unknown>(spec.apiPath(ticker), spec.apiParams ?? {});
          pending[spec.kind]!.push(...spec.parse(ticker, resp, ts));
        } catch (e) {
          ctx.logger.warn("fmp-backfill kind failed for ticker", {
            kind: spec.kind,
            ticker,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      processed++;
      if (processed % FLUSH_EVERY === 0) {
        await flushPending(pending, outputs);
        progress(processed, total, "flushed");
      } else if (processed % 10 === 0) {
        progress(processed, total);
      }
    }

    await flushPending(pending, outputs);
    progress(total, total, "done");

    return {
      output_paths: FMP_BACKFILL_KINDS.map((spec) => outputs[spec.kind]!),
    };
  },
};

async function flushPending(
  pending: Record<string, Array<Record<string, unknown>>>,
  outputs: Record<string, string>,
): Promise<void> {
  for (const spec of FMP_BACKFILL_KINDS) {
    const rows = pending[spec.kind] ?? [];
    if (rows.length === 0) continue;
    await mergeAndWriteParquet({
      uri: outputs[spec.kind]!,
      schema: spec.schema,
      dedupKey: spec.dedupKey,
      rows,
      orderBy: spec.orderBy,
    });
    pending[spec.kind] = [];
  }
}
