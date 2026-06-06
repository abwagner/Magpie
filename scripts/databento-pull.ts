#!/usr/bin/env node
// ── databento-pull thin client (QF-238) ───────────────────────────
//
// Posts a `databento-pull` job to the M10-1 write-dispatch API.
// Server-side handler spawns scripts/_databento-pull-impl.ts in-process
// so DATABENTO_API_KEY + MinIO write creds come from the server's env,
// not the operator's box (post-M10-6 IAM lockdown).
//
// Usage:
//   npm run databento:pull

import { loadJobClientEnv, submitAndPoll } from "./_jobsClient.js";

loadJobClientEnv();

await submitAndPoll(
  "databento-pull",
  {},
  {
    label: "databento-pull",
    pollMs: 5000,
  },
);
