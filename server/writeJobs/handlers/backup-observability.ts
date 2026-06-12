// ── Handler: backup-observability (QF-279 / M15-5) ─────────────────
//
// Snapshots the local Loki + Prometheus filesystem stores to a MinIO
// bucket as offsite DR. Spawns scripts/_backup-observability-impl.ts as
// a subprocess; the impl shells out to `aws s3 sync` + `aws s3 rm`
// (retention pruning). Mirrors the sync-to-s3 handler — the impl owns
// the shell-outs, the handler owns dispatch + logging.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { HandlerResult, JobHandler } from "../types.js";

const PROJECT_ROOT = resolve(process.cwd());
const IMPL_SCRIPT = resolve(PROJECT_ROOT, "scripts", "_backup-observability-impl.ts");

export interface BackupObservabilityParams {
  bucket?: string;
  endpoint_url?: string;
  region?: string;
  /** Daily snapshots to retain before expiry. Defaults to 30 (impl side). */
  retention_days?: number;
  dry_run?: boolean;
}

// S3 bucket naming: lowercase alphanumerics, dots and hyphens, must start
// and end with an alphanumeric. (3-63 char length per AWS, enforced too.)
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

// Flags whose values may carry endpoints/credentials/regions and should be
// masked before the args array is logged.
const REDACT_FLAGS = new Set(["--bucket", "--endpoint-url", "--region"]);

/** Mask the values following sensitive flags so the args array is safe to
 *  log. The impl-script path and flag names themselves are kept. */
export function redactArgs(args: string[]): string[] {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    if (REDACT_FLAGS.has(out[i]!)) out[i + 1] = "***";
  }
  return out;
}

export function buildArgs(params: BackupObservabilityParams): string[] {
  const args: string[] = [IMPL_SCRIPT];
  if (params.bucket) args.push("--bucket", params.bucket);
  if (params.endpoint_url) args.push("--endpoint-url", params.endpoint_url);
  if (params.region) args.push("--region", params.region);
  if (params.retention_days !== undefined) {
    args.push("--retention-days", String(params.retention_days));
  }
  if (params.dry_run) args.push("--dry-run");
  return args;
}

export const backupObservabilityHandler: JobHandler<BackupObservabilityParams> = {
  kind: "backup-observability",

  validate(params): string[] {
    if (params === null || typeof params !== "object") return ["params must be an object"];
    const p = params as Record<string, unknown>;
    const errors: string[] = [];
    for (const k of ["bucket", "endpoint_url", "region"] as const) {
      if (p[k] !== undefined && typeof p[k] !== "string") errors.push(`${k} must be a string`);
    }
    // Defense-in-depth: even though the impl no longer shells out, reject
    // structurally bogus values at the submit boundary.
    if (typeof p.bucket === "string") {
      if (p.bucket.length < 3 || p.bucket.length > 63 || !BUCKET_RE.test(p.bucket)) {
        errors.push("bucket must be a valid S3 bucket name");
      }
    }
    if (typeof p.endpoint_url === "string") {
      let url: URL | undefined;
      try {
        url = new URL(p.endpoint_url);
      } catch {
        // Leave undefined; flagged as invalid below.
      }
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
        errors.push("endpoint_url must be a valid http(s) URL");
      }
    }
    if (p.retention_days !== undefined) {
      const v = p.retention_days;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        errors.push("retention_days must be a positive integer");
      }
    }
    if (p.dry_run !== undefined && typeof p.dry_run !== "boolean") {
      errors.push("dry_run must be a boolean");
    }
    return errors;
  },

  async run(params, progress, ctx): Promise<HandlerResult> {
    const args = buildArgs(params);
    ctx.logger.info("backup-observability subprocess starting", {
      args: redactArgs(args),
      dry_run: !!params.dry_run,
    });
    progress(0, null, "spawning");

    return new Promise((resolveJob, reject) => {
      const child = spawn("npx", ["tsx", ...args], {
        cwd: PROJECT_ROOT,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderrTail = "";
      child.stdout.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim().length === 0) continue;
          ctx.logger.info("backup-observability", { line });
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-4000);
        for (const line of text.split("\n")) {
          if (line.trim().length === 0) continue;
          ctx.logger.warn("backup-observability stderr", { line });
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolveJob({ output_paths: [] });
        } else {
          reject(new Error(`backup-observability impl exited ${code}: ${stderrTail.slice(-500)}`));
        }
      });
    });
  },
};
