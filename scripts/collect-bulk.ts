#!/usr/bin/env node
// ── collect-bulk thin client (M10-3) ──────────────────────────────
//
// Hard cutover: posts a `collect-bulk` job to the M10-1 write-dispatch
// API and polls until done. The actual chain-collection logic lives
// in scripts/_collect-bulk-impl.ts, spawned server-side by the
// handler (only the QF server holds S3 write creds post-M10-6).
//
// Usage:
//   npm run collect:bulk
//   npm run collect:bulk -- --from 2019-01-02 --to 2026-04-11
//   CONCURRENCY=16 npm run collect:bulk          # passed as a job param

import { loadJobClientEnv, submitAndPoll } from "./_jobsClient.js";

loadJobClientEnv();

interface CollectBulkParams {
  from?: string;
  to?: string;
  concurrency?: number;
  reserve?: number;
  strike_limit?: number;
  rfr?: number;
}

function parseArgs(argv: string[]): CollectBulkParams {
  const out: CollectBulkParams = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") out.from = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: collect-bulk [--from YYYY-MM-DD] [--to YYYY-MM-DD]\nEnv: CONCURRENCY, RESERVE, STRIKE_LIMIT, RFR",
      );
      process.exit(0);
    }
  }
  if (process.env.CONCURRENCY) out.concurrency = Number(process.env.CONCURRENCY);
  if (process.env.RESERVE) out.reserve = Number(process.env.RESERVE);
  if (process.env.STRIKE_LIMIT) out.strike_limit = Number(process.env.STRIKE_LIMIT);
  if (process.env.RFR) out.rfr = Number(process.env.RFR);
  return out;
}

const params = parseArgs(process.argv.slice(2));
await submitAndPoll("collect-bulk", params as Record<string, unknown>, {
  label: "collect-bulk",
  pollMs: 5000,
});
