#!/usr/bin/env node
// ── ingest thin client (M10-3) ────────────────────────────────────
//
// Hard cutover: posts an `ingest` job to the M10-1 write-dispatch
// API. Server-side handler runs the orchestrator's runIngest()
// in-process.
//
// Usage:
//   npm run ingest                        # all sources, all signals
//   npm run ingest -- --source fmp        # one source only
//   npm run ingest -- --signal peg-rotation
//   npm run ingest -- --source fmp --signal peg-rotation

import { loadJobClientEnv, submitAndPoll } from "./_jobsClient.js";

loadJobClientEnv();

interface IngestParams {
  source?: string;
  signal?: string;
}

function parseArgs(argv: string[]): IngestParams {
  const out: IngestParams = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i];
    else if (a === "--signal") out.signal = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: ingest [--source <slug>] [--signal <name>]");
      process.exit(0);
    }
  }
  return out;
}

const params = parseArgs(process.argv.slice(2));
await submitAndPoll("ingest", params as Record<string, unknown>, {
  label: params.source ? `ingest:${params.source}` : "ingest",
  pollMs: 3000,
});
