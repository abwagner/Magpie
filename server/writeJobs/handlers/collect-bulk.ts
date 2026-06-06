// ── Handler: collect-bulk (M10-3) ─────────────────────────────────
//
// Spawns scripts/_collect-bulk-impl.ts as a subprocess. The impl
// holds the per-symbol manifest + parallel API fetch machinery
// (~650 lines); migrating that wholesale into the runner would risk
// regressing the live cron, so the M10-3 cutover keeps the impl as a
// private script the server invokes via spawn. The dispatcher still
// owns auth + audit; the IAM rotation in M10-6 makes the spawn the
// ONLY way to acquire write creds.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { HandlerResult, JobHandler } from "../types.js";

const PROJECT_ROOT = resolve(process.cwd());
const IMPL_SCRIPT = resolve(PROJECT_ROOT, "scripts", "_collect-bulk-impl.ts");

export interface CollectBulkParams {
  from?: string;
  to?: string;
  concurrency?: number;
  reserve?: number;
  strike_limit?: number;
  rfr?: number;
}

export const collectBulkHandler: JobHandler<CollectBulkParams> = {
  kind: "collect-bulk",

  validate(params): string[] {
    if (params === null || typeof params !== "object") return ["params must be an object"];
    const p = params as Record<string, unknown>;
    const errors: string[] = [];
    if (p.from !== undefined && !isIsoDate(p.from)) errors.push("from must be YYYY-MM-DD");
    if (p.to !== undefined && !isIsoDate(p.to)) errors.push("to must be YYYY-MM-DD");
    for (const k of ["concurrency", "reserve", "strike_limit", "rfr"] as const) {
      if (p[k] !== undefined) {
        const n = p[k];
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
          errors.push(`${k} must be a non-negative number`);
        }
      }
    }
    return errors;
  },

  async run(params, progress, ctx): Promise<HandlerResult> {
    const args: string[] = [IMPL_SCRIPT];
    if (params.from) args.push("--from", params.from);
    if (params.to) args.push("--to", params.to);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (params.concurrency !== undefined) env.CONCURRENCY = String(params.concurrency);
    if (params.reserve !== undefined) env.RESERVE = String(params.reserve);
    if (params.strike_limit !== undefined) env.STRIKE_LIMIT = String(params.strike_limit);
    if (params.rfr !== undefined) env.RFR = String(params.rfr);

    ctx.logger.info("collect-bulk subprocess starting", { args, hasMdToken: !!env.MD_TOKEN });
    progress(0, null, "spawning");

    return new Promise((resolveJob, reject) => {
      const child = spawn("npx", ["tsx", ...args], {
        cwd: PROJECT_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderrTail = "";
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          if (line.trim().length === 0) continue;
          ctx.logger.info("collect-bulk", { line });
          const m = line.match(/(\d+)\s*\/\s*(\d+)/);
          if (m) progress(Number(m[1]), Number(m[2]));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-4000);
        for (const line of text.split("\n")) {
          if (line.trim().length === 0) continue;
          ctx.logger.warn("collect-bulk stderr", { line });
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          // Outputs are per-symbol per-month parquets; we don't enumerate
          // them here. The Settings → Data → Catalog tab is the source of
          // truth for what's in MinIO post-run.
          resolveJob({ output_paths: [] });
        } else {
          reject(new Error(`collect-bulk impl exited ${code}: ${stderrTail.slice(-500)}`));
        }
      });
    });
  },
};

function isIsoDate(v: unknown): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
