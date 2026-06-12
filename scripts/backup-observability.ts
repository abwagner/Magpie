#!/usr/bin/env node
// ── backup-observability thin client (QF-279 / M15-5) ─────────────
//
// Posts a `backup-observability` job to the M10-1 write-jobs dispatch
// API. The actual `aws s3 sync` + retention pruning lives in
// scripts/_backup-observability-impl.ts, spawned server-side by the
// handler. Invoked daily by the systemd timer
// (deploy/systemd/magpie-backup-observability.timer).
//
// Usage:
//   npm run backup-observability
//   npm run backup-observability -- --bucket magpie-observability-backups
//   npm run backup-observability -- --retention-days 30 --dry-run

import { loadJobClientEnv, submitAndPoll } from "./_jobsClient.js";

loadJobClientEnv();

interface BackupObservabilityParams {
  bucket?: string;
  endpoint_url?: string;
  region?: string;
  retention_days?: number;
  dry_run?: boolean;
}

function parseArgs(argv: string[]): BackupObservabilityParams {
  const out: BackupObservabilityParams = {};
  const takeValue = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bucket") out.bucket = takeValue(++i, a);
    else if (a === "--endpoint-url") out.endpoint_url = takeValue(++i, a);
    else if (a === "--region") out.region = takeValue(++i, a);
    else if (a === "--retention-days") {
      const raw = takeValue(++i, a);
      const v = Number(raw);
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error(`--retention-days must be a positive integer, got: ${raw}`);
      }
      out.retention_days = v;
    } else if (a === "--dry-run") out.dry_run = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: backup-observability [--bucket B] [--endpoint-url U] [--region R] [--retention-days N] [--dry-run]",
      );
      process.exit(0);
    }
  }
  return out;
}

const params = parseArgs(process.argv.slice(2));
await submitAndPoll("backup-observability", params as Record<string, unknown>, {
  label: "backup-observability",
  pollMs: 3000,
});
