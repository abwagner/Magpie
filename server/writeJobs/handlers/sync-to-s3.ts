// ── Handler: sync-to-s3 (M10-3) ───────────────────────────────────
//
// Spawns scripts/_sync-to-s3-impl.ts as a subprocess. The impl
// shells out to `aws s3 sync`; migrating it inline gains nothing.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { HandlerResult, JobHandler } from "../types.js";

const PROJECT_ROOT = resolve(process.cwd());
const IMPL_SCRIPT = resolve(PROJECT_ROOT, "scripts", "_sync-to-s3-impl.ts");

const KNOWN_SUBDIRS = new Set([
  "chains",
  "signals",
  "macro",
  "futures",
  "etfs",
  "fills",
  "results",
  "databento",
]);

export interface SyncToS3Params {
  only?: string;
  include?: string[];
  exclude?: string[];
  bucket?: string;
  endpoint_url?: string;
  region?: string;
  dry_run?: boolean;
}

export const syncToS3Handler: JobHandler<SyncToS3Params> = {
  kind: "sync-to-s3",

  validate(params): string[] {
    if (params === null || typeof params !== "object") return ["params must be an object"];
    const p = params as Record<string, unknown>;
    const errors: string[] = [];
    if (p.only !== undefined) {
      if (typeof p.only !== "string" || !KNOWN_SUBDIRS.has(p.only)) {
        errors.push(`only must be one of: ${[...KNOWN_SUBDIRS].join(", ")}`);
      }
    }
    for (const k of ["include", "exclude"] as const) {
      const v = p[k];
      if (v !== undefined) {
        if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
          errors.push(`${k} must be a string array`);
        }
      }
    }
    return errors;
  },

  async run(params, progress, ctx): Promise<HandlerResult> {
    const args: string[] = [IMPL_SCRIPT];
    if (params.only) args.push("--only", params.only);
    if (params.bucket) args.push("--bucket", params.bucket);
    if (params.endpoint_url) args.push("--endpoint-url", params.endpoint_url);
    if (params.region) args.push("--region", params.region);
    if (params.dry_run) args.push("--dry-run");
    for (const sub of params.include ?? []) args.push(`--${sub}`);
    for (const sub of params.exclude ?? []) args.push(`--no-${sub}`);

    ctx.logger.info("sync-to-s3 subprocess starting", { args, dry_run: !!params.dry_run });
    progress(0, null, "spawning");

    return new Promise((resolveJob, reject) => {
      const child = spawn("npx", ["tsx", ...args], {
        cwd: PROJECT_ROOT,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderrTail = "";
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          if (line.trim().length === 0) continue;
          ctx.logger.info("sync-to-s3", { line });
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-4000);
        for (const line of text.split("\n")) {
          if (line.trim().length === 0) continue;
          ctx.logger.warn("sync-to-s3 stderr", { line });
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolveJob({ output_paths: [] });
        } else {
          reject(new Error(`sync-to-s3 impl exited ${code}: ${stderrTail.slice(-500)}`));
        }
      });
    });
  },
};
