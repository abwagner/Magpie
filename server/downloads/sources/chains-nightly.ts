// ── chains-nightly source ─────────────────────────────────────────
// Wraps the .nightly.log parser. Detail lookup re-uses the same parsed
// payload (cached by mtime) so it's effectively free.

import { join } from "node:path";
import { loadNightlyLog, activityFromRaw } from "../parsers/nightly-log.js";
import type { DownloadRun, RunActivityEntry, SourceAggregator } from "../types.js";

export interface ChainsNightlyDeps {
  chainsDir: string;
}

const SOURCE = "marketdata.app:chains-nightly";

export function createChainsNightlySource(deps: ChainsNightlyDeps): SourceAggregator {
  const logPath = join(deps.chainsDir, ".nightly.log");

  return {
    source: SOURCE,
    async list(): Promise<DownloadRun[]> {
      const parsed = await loadNightlyLog(logPath, SOURCE);
      const runs = parsed.map((p) => p.run);
      runs.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
      return runs;
    },
    async detail(runId: string): Promise<RunActivityEntry[] | null> {
      const parsed = await loadNightlyLog(logPath, SOURCE);
      const hit = parsed.find((p) => p.run.id === runId);
      if (!hit) return null;
      return activityFromRaw(hit.raw);
    },
  };
}
