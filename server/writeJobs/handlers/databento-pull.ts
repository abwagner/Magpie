// ── Handler: databento-pull (QF-238) ──────────────────────────────
//
// Spawns scripts/_databento-pull-impl.ts as a subprocess so the
// long-running CSV fetch + parquet write doesn't block the runner
// event loop. Mirrors the collect-bulk handler pattern.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { HandlerResult, JobHandler } from "../types.js";

const PROJECT_ROOT = resolve(process.cwd());
const IMPL_SCRIPT = resolve(PROJECT_ROOT, "scripts", "_databento-pull-impl.ts");

// No params today — driven entirely by config/databento-futures.json.
// Reserved for future overrides (e.g. --symbol CL to refresh one).
export interface DatabentoPullParams {
  symbol?: string;
}

export const databentoPullHandler: JobHandler<DatabentoPullParams> = {
  kind: "databento-pull",

  sourceFor(): string | null {
    return "databento";
  },

  validate(params): string[] {
    if (params === null || typeof params !== "object") return ["params must be an object"];
    return [];
  },

  async run(params, progress, ctx): Promise<HandlerResult> {
    const args: string[] = [IMPL_SCRIPT];
    // Reserved for the future per-symbol override; not consumed yet.
    void params;

    const env: NodeJS.ProcessEnv = { ...process.env };
    ctx.logger.info("databento-pull subprocess starting", {
      hasDatabentoKey: !!env.DATABENTO_API_KEY,
    });
    progress(0, null, "spawning");

    return new Promise<{ output_paths: string[] }>((resolveRun, rejectRun) => {
      const child = spawn("tsx", args, {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      let stderrTail = "";
      child.stdout?.on("data", (buf: Buffer) => {
        const lines = buf.toString("utf-8").split("\n");
        for (const line of lines) {
          if (line.length > 0) ctx.logger.info("databento-pull", { line });
        }
      });
      child.stderr?.on("data", (buf: Buffer) => {
        const s = buf.toString("utf-8");
        stderrTail = (stderrTail + s).slice(-2000);
        for (const line of s.split("\n")) {
          if (line.length > 0) ctx.logger.warn("databento-pull stderr", { line });
        }
      });
      child.on("error", (err) => rejectRun(err));
      child.on("exit", (code) => {
        if (code === 0) {
          resolveRun({ output_paths: [] });
        } else {
          rejectRun(new Error(`databento-pull impl exited ${code}: ${stderrTail.slice(-500)}`));
        }
      });
    });
  },
};
