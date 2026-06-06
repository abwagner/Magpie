// ── Handler: chain-store (M10-4) ──────────────────────────────────
//
// Lets an operator land a chain snapshot through the dispatcher (with
// auth + audit + single-flight per kind). Intended for backfilling
// holes or replaying a stored payload, NOT for the server's hot chain-
// fetch path — that stays direct via Storage.storeChain because the
// dispatcher's per-kind serialization would queue every concurrent
// quote refresh behind a single in-flight job.
//
// Scope clarification from the M10-4 plan: hot-path storeChain
// callers in server/index.js are intentionally not migrated. The
// MinIO IAM rotation in M10-6 enforces the single-writer guarantee
// at the storage layer (only the server box holds write creds), so
// the dispatcher's role for server-internal writes is "operator
// surface" rather than "every write."

import type { StoreContract } from "../../storage.js";
import { writeChainParquet } from "../../storage.js";
import type { HandlerResult, JobHandler } from "../types.js";

export interface ChainStoreParams {
  symbol: string;
  date: string;
  contracts: StoreContract[];
  source?: string;
}

export const chainStoreHandler: JobHandler<ChainStoreParams> = {
  kind: "chain-store",

  validate(params): string[] {
    if (params === null || typeof params !== "object") return ["params must be an object"];
    const p = params as Record<string, unknown>;
    const errors: string[] = [];
    if (typeof p.symbol !== "string" || p.symbol.length === 0) {
      errors.push("symbol is required");
    }
    if (typeof p.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) {
      errors.push("date must be YYYY-MM-DD");
    }
    if (!Array.isArray(p.contracts)) {
      errors.push("contracts must be an array");
    } else if (p.contracts.length === 0) {
      errors.push("contracts must be non-empty");
    }
    if (p.source !== undefined && typeof p.source !== "string") {
      errors.push("source must be a string");
    }
    return errors;
  },

  async run(params, progress, ctx): Promise<HandlerResult> {
    progress(0, params.contracts.length, "writing");
    ctx.logger.info("chain-store handler running", {
      symbol: params.symbol,
      date: params.date,
      contracts: params.contracts.length,
    });
    const result = await writeChainParquet(
      params.symbol,
      params.date,
      params.contracts,
      params.source ?? "operator",
    );
    progress(params.contracts.length, params.contracts.length, "done");
    return { output_paths: [result.uri] };
  },
};
