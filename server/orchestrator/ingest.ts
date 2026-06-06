// ── Ingest Orchestrator ────────────────────────────────────────────
// TS port of data-signals/data-sources/ingest_all.py.
//
// Discovers signal manifests, collects per-source DataRequest batches by
// flattening each manifest's `data:` block (entries with a `source:` are
// scheduled persistent feeds; entries without are `before_tick` live deps
// fetched at signal tick time, not here). Pre-resolves `output:` paths
// through DATA_URI so adapters receive absolute URIs and write directly.
//
// Used by:
//   - scripts/ingest.ts CLI (cron / manual via writeJobs handler)

import { discoverManifests, type SignalManifest } from "./signal-manifest.js";
import {
  adapterSupports,
  getAdapter,
  listAdapters,
  type DataRequest,
  type DataResult,
} from "./adapter.js";
import { joinUri } from "./storage.js";

export interface IngestSummary {
  source: string;
  attempted: number;
  ok: number;
  failed: number;
  results: DataResult[];
}

/**
 * Flatten manifest data deps for a single source into batched DataRequests.
 * Dedups by output URI (first occurrence wins). Live deps (no `source:`) are
 * skipped — those are owned by Magpie's market-data API, not this pipeline.
 */
export function collectSourceBatches(
  manifests: ReadonlyArray<SignalManifest>,
  source: string,
): DataRequest[] {
  const seen = new Map<string, DataRequest>();
  for (const manifest of manifests) {
    for (const dep of manifest.data ?? []) {
      if (dep.source !== source) continue;
      if (!dep.output) continue;
      const absUri = joinUri(dep.output);
      if (seen.has(absUri)) continue;
      const args = (dep.args ?? {}) as Record<string, unknown>;
      seen.set(absUri, {
        args,
        output: absUri,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Dispatch a batch to one source's adapter and collect the results. Mirrors
 * the per-source loop in ingest_all.py:run_source(). Skips silently when no
 * requests target this source.
 */
export async function runSource(source: string, requests: DataRequest[]): Promise<IngestSummary> {
  if (requests.length === 0) {
    return { source, attempted: 0, ok: 0, failed: 0, results: [] };
  }
  let adapter;
  try {
    adapter = getAdapter(source);
  } catch (e) {
    return {
      source,
      attempted: requests.length,
      ok: 0,
      failed: requests.length,
      results: requests.map((r) => ({
        request: r,
        ok: false,
        error: String((e as Error).message ?? e),
      })),
    };
  }

  // Filter out requests this adapter doesn't claim to support (e.g. unknown kind).
  const supported = requests.filter((r) => adapterSupports(adapter, r.args));
  const unsupported = requests.filter((r) => !adapterSupports(adapter, r.args));

  console.log(`[ingest] ${source}: ${supported.length} request(s)`);
  const results = await adapter.fetch(supported);
  for (const u of unsupported) {
    results.push({
      request: u,
      ok: false,
      error: `adapter "${source}" does not support args.kind="${String(u.args.kind ?? "")}"`,
    });
  }
  const ok = results.filter((r) => r.ok).length;
  return {
    source,
    attempted: requests.length,
    ok,
    failed: results.length - ok,
    results,
  };
}

/**
 * End-to-end ingest entry point. Discovers manifests, optionally filters to
 * one signal, groups by source, and runs each adapter. Returns a summary
 * per source so callers can decide on exit codes / logging.
 */
export async function runIngest(opts: {
  /** Root of the data-signals checkout (walks both signals/ and strategies/). */
  dataSignalsPath: string;
  /** Filter to one signal (directory basename). */
  signal?: string;
  /** Filter to one source (e.g. "fred"). Default: all known sources. */
  source?: string;
}): Promise<IngestSummary[]> {
  const allManifests = await discoverManifests(opts.dataSignalsPath);
  if (allManifests.length === 0) {
    console.error(
      `[ingest] no manifests found under ${opts.dataSignalsPath}/{signals,strategies}/`,
    );
    return [];
  }

  const manifests = opts.signal
    ? allManifests.filter((m) => m._dir.endsWith(`/${opts.signal}`))
    : allManifests;
  if (manifests.length === 0) {
    console.error(`[ingest] signal "${opts.signal}" not found`);
    return [];
  }

  const sourcesToRun = opts.source ? [opts.source] : listAdapters();
  console.log(
    `[ingest] manifests=${manifests.length}, sources=${sourcesToRun.length} (${sourcesToRun.join(", ")})`,
  );

  const summaries: IngestSummary[] = [];
  for (const source of sourcesToRun) {
    const batch = collectSourceBatches(manifests, source);
    const summary = await runSource(source, batch);
    summaries.push(summary);
    if (summary.attempted > 0) {
      console.log(
        `[ingest] ${source}: ${summary.ok}/${summary.attempted} ok` +
          (summary.failed > 0 ? `, ${summary.failed} failed` : ""),
      );
      for (const r of summary.results) {
        if (!r.ok) {
          console.error(
            `[ingest]   ✗ ${source} args=${JSON.stringify(r.request.args)}: ${r.error}`,
          );
        }
      }
    }
  }
  return summaries;
}
