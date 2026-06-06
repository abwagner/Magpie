#!/usr/bin/env node
// ── sync-to-s3 thin client (M10-3) ────────────────────────────────
//
// Hard cutover: posts a `sync-to-s3` job to the M10-1 dispatch API.
// The actual `aws s3 sync` invocations live in
// scripts/_sync-to-s3-impl.ts, spawned server-side by the handler.
//
// Usage:
//   npm run sync-to-s3
//   npm run sync-to-s3 -- --only chains
//   npm run sync-to-s3 -- --no-chains --no-futures

import { loadJobClientEnv, submitAndPoll } from "./_jobsClient.js";

loadJobClientEnv();

interface SyncToS3Params {
  only?: string;
  include?: string[];
  exclude?: string[];
  bucket?: string;
  endpoint_url?: string;
  region?: string;
  dry_run?: boolean;
}

function parseArgs(argv: string[]): SyncToS3Params {
  const out: SyncToS3Params = { include: [], exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") out.only = argv[++i];
    else if (a === "--bucket") out.bucket = argv[++i];
    else if (a === "--endpoint-url") out.endpoint_url = argv[++i];
    else if (a === "--region") out.region = argv[++i];
    else if (a === "--dry-run") out.dry_run = true;
    else if (a?.startsWith("--no-")) out.exclude!.push(a.slice("--no-".length));
    else if (a?.startsWith("--") && a !== "--help" && a !== "-h") {
      // Bare --<subdir> flag (include filter)
      out.include!.push(a.slice("--".length));
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: sync-to-s3 [--bucket B] [--endpoint-url U] [--only sub] [--dry-run] [--<sub> ...] [--no-<sub> ...]",
      );
      process.exit(0);
    }
  }
  if (out.include!.length === 0) delete out.include;
  if (out.exclude!.length === 0) delete out.exclude;
  return out;
}

const params = parseArgs(process.argv.slice(2));
await submitAndPoll("sync-to-s3", params as Record<string, unknown>, {
  label: "sync-to-s3",
  pollMs: 3000,
});
