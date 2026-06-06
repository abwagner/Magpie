// ── Handler: ingest (M10-3) ───────────────────────────────────────
//
// Runs the orchestrator's batch ingest in-process — same surface
// scripts/ingest.ts called pre-M10. Filters by source / signal when
// the operator supplies them.
//
// Adapters are bootstrapped lazily on first ingest call; subsequent
// jobs skip the registration (registerAdapter throws on duplicates).

import { resolve } from "node:path";
import { bootstrapAdapters, loadConfig } from "../../orchestrator/config.js";
import { runIngest } from "../../orchestrator/ingest.js";
import type { HandlerResult, JobHandler } from "../types.js";

const PROJECT_ROOT = resolve(process.cwd());
let adaptersBootstrapped = false;

export interface IngestParams {
  /** Source slug filter (e.g. "fred", "eia", "fmp"). */
  source?: string;
  /** Signal-directory filter (e.g. "peg-rotation"). */
  signal?: string;
}

export const ingestHandler: JobHandler<IngestParams> = {
  kind: "ingest",

  sourceFor(params): string | null {
    return params.source ?? null;
  },

  validate(params): string[] {
    if (params === null || typeof params !== "object") {
      return ["params must be an object"];
    }
    const p = params as Record<string, unknown>;
    const errors: string[] = [];
    if (p.source !== undefined && typeof p.source !== "string") {
      errors.push("source must be a string");
    }
    if (p.signal !== undefined && typeof p.signal !== "string") {
      errors.push("signal must be a string");
    }
    return errors;
  },

  async run(params, progress, ctx): Promise<HandlerResult> {
    const config = loadConfig(PROJECT_ROOT);
    if (!adaptersBootstrapped) {
      bootstrapAdapters(config);
      adaptersBootstrapped = true;
    }

    ctx.logger.info("ingest run", {
      source: params.source ?? "(all)",
      signal: params.signal ?? "(all)",
    });
    progress(0, null, "starting");

    const summaries = await runIngest({
      dataSignalsPath: config.dataSignalsPath,
      source: params.source,
      signal: params.signal,
    });

    let totalReqs = 0;
    let totalFailed = 0;
    const outputs = new Set<string>();
    let maxDataThrough: string | undefined;
    for (const s of summaries) {
      totalReqs += s.ok + s.failed;
      totalFailed += s.failed;
      for (const r of s.results ?? []) {
        if (r.ok && r.request.output) outputs.add(r.request.output);
        if (r.dataThrough) {
          if (!maxDataThrough || r.dataThrough > maxDataThrough) {
            maxDataThrough = r.dataThrough;
          }
        }
      }
    }
    progress(totalReqs - totalFailed, totalReqs, totalFailed > 0 ? "with failures" : "done");

    if (totalFailed > 0) {
      throw new Error(
        `${totalFailed} of ${totalReqs} requests failed (see server log for per-source detail)`,
      );
    }
    return {
      output_paths: [...outputs].sort(),
      ...(maxDataThrough !== undefined ? { data_through: maxDataThrough } : {}),
    };
  },
};
