// ── Generic Sidecar Source ────────────────────────────────────────
// Used for any data dir that drops `.parquet.meta.json` next to its
// parquets but has no structured run log. Used for ETFs and chains-
// refresh (the vol-buyer 18:00 ET cron, which writes one sidecar per
// run).

import {
  collectSidecars,
  synthesizeRuns,
  activityFromSidecars,
  type Sidecar,
} from "../parsers/sidecar.js";
import type { DownloadRun, RunActivityEntry, SourceAggregator } from "../types.js";

export interface SidecarSourceDeps {
  source: string;
  idPrefix: string;
  dir: string;
}

export function createSidecarSource(deps: SidecarSourceDeps): SourceAggregator {
  return {
    source: deps.source,
    async list(): Promise<DownloadRun[]> {
      const sidecars = collectSidecars(deps.dir);
      return synthesizeRuns(sidecars, {
        source: deps.source,
        idPrefix: deps.idPrefix,
      });
    },
    async detail(runId: string): Promise<RunActivityEntry[] | null> {
      const day = runId.split(":").at(-1);
      if (!day) return null;
      const sidecars = collectSidecars(deps.dir).filter(
        (s) => s.meta.fetched_at.slice(0, 10) === day,
      );
      if (sidecars.length === 0) return null;
      return activityFromSidecars(sidecars);
    },
  };
}

// Re-export for service registry convenience.
export type { Sidecar };
