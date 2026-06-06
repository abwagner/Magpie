// ── Handler: orchestrate-refresh (M10-5) ──────────────────────────
//
// One feed at a time — what the cron generator emits per
// (source, args, output) tuple from a signal manifest. The M10-3
// `ingest` kind operates per-source (running every dep); this one
// dispatches a single adapter call, mirroring the pre-M10 cron
// command shape (`orchestrate refresh --source X --args Y --output Z`).
//
// The handler reuses the orchestrator's adapter registry; adapters
// are bootstrapped lazily on the first invocation (registerAdapter
// throws on duplicates so we guard).

import { resolve } from "node:path";
import { bootstrapAdapters, loadConfig } from "../../orchestrator/config.js";
import { getAdapter } from "../../orchestrator/adapter.js";
import type { DataRequest } from "../../orchestrator/adapter.js";
import { joinUri } from "../../orchestrator/storage.js";
import type { HandlerResult, JobHandler } from "../types.js";

const PROJECT_ROOT = resolve(process.cwd());
let adaptersBootstrapped = false;

export interface OrchestrateRefreshParams {
  source: string;
  /** Adapter-specific args (e.g. {kind: "fundamentals", universe_parquet: "..."}). */
  args: Record<string, unknown>;
  /** Output path relative to DATA_URI. */
  output: string;
  /** Optional incremental start date. */
  since?: string;
}

export const orchestrateRefreshHandler: JobHandler<OrchestrateRefreshParams> = {
  kind: "orchestrate-refresh",

  sourceFor(params): string | null {
    return params.source ?? null;
  },

  validate(params): string[] {
    if (params === null || typeof params !== "object") return ["params must be an object"];
    const p = params as Record<string, unknown>;
    const errors: string[] = [];
    if (typeof p.source !== "string" || p.source.length === 0) errors.push("source is required");
    if (p.args === null || typeof p.args !== "object") errors.push("args must be an object");
    if (typeof p.output !== "string" || p.output.length === 0) errors.push("output is required");
    if (p.since !== undefined && typeof p.since !== "string") errors.push("since must be a string");
    return errors;
  },

  async run(params, progress, ctx): Promise<HandlerResult> {
    if (!adaptersBootstrapped) {
      bootstrapAdapters(loadConfig(PROJECT_ROOT));
      adaptersBootstrapped = true;
    }

    progress(0, 1, "fetching");
    const adapter = getAdapter(params.source);
    const request: DataRequest = {
      args: params.args,
      output: joinUri(params.output),
      ...(params.since !== undefined ? { since: params.since } : {}),
    };
    ctx.logger.info("orchestrate-refresh", {
      source: params.source,
      output: params.output,
    });
    const results = await adapter.fetch([request]);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      const msg = failed.map((r) => r.error ?? "(no message)").join("; ");
      throw new Error(`${params.source}: ${msg}`);
    }
    progress(1, 1, "done");
    // dataThrough comes from the single DataResult; may be undefined for
    // adapters that don't report it.
    const dataThrough = results[0]?.dataThrough;
    return {
      output_paths: [request.output!],
      ...(dataThrough !== undefined ? { data_through: dataThrough } : {}),
    };
  },
};
