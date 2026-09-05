import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { HandlerResult, JobHandler } from "../types.js";
const script = resolve(process.cwd(), "scripts", "_collect-ohlcv-impl.ts");
export const collectOhlcvHandler: JobHandler<{ mode?: "backfill" | "daily"; start_index?: number }> = {
  kind: "collect-ohlcv", sourceFor: () => "marketdata",
  validate: p => p && typeof p === "object" && (!["backfill", "daily"].includes((p as any).mode ?? "backfill")) ? ["mode must be backfill or daily"] : [],
  async run(params, progress, ctx): Promise<HandlerResult> {
    const daily = params.mode === "daily";
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (params.start_index !== undefined) env.OHLCV_START_INDEX = String(params.start_index);
    progress(0, 2791, "spawning");
    return await new Promise((ok, fail) => {
      const c = spawn("npx", ["tsx", script, ...(daily ? ["--daily"] : [])], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] }); let err = "";
      c.stdout.on("data", b => { const line = b.toString(); const m = line.match(/(\d+)\/(\d+)/); if (m) progress(+m[1], +m[2]); ctx.logger.info("collect-ohlcv", { line: line.trim() }); });
      c.stderr.on("data", b => { err = (err + b).slice(-4000); }); c.on("error", fail);
      c.on("exit", code => code === 0 ? ok({ output_paths: ["s3://magpie-data/ohlcv/daily"], data_through: new Date().toISOString().slice(0,10) }) : fail(new Error(`collect-ohlcv exited ${code}: ${err}`)));
    });
  },
};
