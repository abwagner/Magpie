#!/usr/bin/env node
// ── Databento Daily Pull (M10 dispatch impl, QF-238) ──────────────
// Reads config/databento-futures.json pull_now tier and runs the
// orchestrator's databento adapter once per (symbol, schema) pair.
//
// Invoked by:
//   - server/writeJobs/handlers/databento-pull.ts (cron path)
//   - scripts/databento-pull.ts (manual trigger via write-jobs API)
//
// Heavyweight schemas (trades, ohlcv-1s, mbp-1) stay in the config but
// the cost preflight in the adapter will refuse them if the daily
// delta exceeds the free entitlement; non-refused schemas proceed.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabentoAdapter, outputUriFor } from "../server/orchestrator/adapters/databento.js";
import type { DataRequest } from "../server/orchestrator/adapter.js";
import { initS3, dataUri } from "../server/orchestrator/storage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const CONFIG_PATH = resolve(PROJECT_ROOT, "config", "databento-futures.json");

interface TierEntry {
  symbol: string;
  dataset: string;
  schemas: string[];
}
interface Config {
  tiers: { pull_now?: TierEntry[] };
}

function loadPullNow(): TierEntry[] {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const cfg = JSON.parse(raw) as Config;
  return cfg.tiers?.pull_now ?? [];
}

function toRequests(tier: TierEntry[]): DataRequest[] {
  const reqs: DataRequest[] = [];
  for (const entry of tier) {
    for (const schema of entry.schemas) {
      reqs.push({
        args: { symbol: entry.symbol, dataset: entry.dataset, schema },
        output: outputUriFor(entry.symbol, schema),
      });
    }
  }
  return reqs;
}

async function main(): Promise<void> {
  // The adapter's mergeAndWriteParquetAuto path opens its own DuckDB
  // for each write; initS3 here is a no-op for file:// dev runs but
  // ensures the credentials are parseable before we burn a Databento
  // API call on a misconfigured deploy.
  void dataUri();
  // Initialize S3 creds lazily inside withDb via the storage layer —
  // calling initS3 directly here would need its own db. Skip; trust
  // the storage layer.
  void initS3;

  const tier = loadPullNow();
  if (tier.length === 0) {
    console.log("[databento-pull] pull_now tier is empty; nothing to do");
    return;
  }

  const requests = toRequests(tier);
  console.log(
    `[databento-pull] ${tier.length} symbol(s), ${requests.length} (symbol, schema) request(s)`,
  );

  const adapter = createDatabentoAdapter();
  const results = await adapter.fetch(requests);

  let ok = 0;
  let refused = 0;
  let failed = 0;
  for (const r of results) {
    const args = r.request.args as { symbol?: string; schema?: string };
    const label = `${args.symbol}/${args.schema}`;
    if (r.ok) {
      ok++;
      console.log(`[databento-pull] ✓ ${label}${r.dataThrough ? ` through=${r.dataThrough}` : ""}`);
    } else if (r.error?.startsWith("cost preflight refused")) {
      refused++;
      console.log(`[databento-pull] ⊘ ${label}: ${r.error}`);
    } else {
      failed++;
      console.error(`[databento-pull] ✗ ${label}: ${r.error}`);
    }
  }

  console.log(
    `[databento-pull] done — ok=${ok} refused=${refused} failed=${failed} (of ${results.length})`,
  );
  // Refusals are expected for heavyweight schemas outside the free
  // entitlement; only hard failures fail the run.
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[databento-pull] fatal:", err);
  process.exit(1);
});
