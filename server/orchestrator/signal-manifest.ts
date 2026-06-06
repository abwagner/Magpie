// ── Signal Manifest Types + Discovery ─────────────────────────────
// Minimal manifest surface kept for the surviving ingest path.
// The manifest walker / supervisor half was retired in QF-282;
// what remains here is:
//   - The SignalManifest shape (and its nested types)
//   - discoverManifests() used by server/orchestrator/ingest.ts

import { readFileSync, readdirSync, existsSync, type Dirent } from "node:fs";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────

export interface ManifestSchedule {
  mode: "cron" | "interval" | "event";
  /** Cron expression (mode=cron). */
  cron?: string;
  /** Seconds between ticks (mode=interval). */
  interval_seconds?: number;
  /** Active window, e.g. "09:30-15:30" (mode=interval). */
  active_hours?: string;
  /** Active days, e.g. "1-5" for Mon-Fri. */
  active_days?: string;
  /** Trigger type (mode=event). */
  trigger?: string;
  /** Files to watch (mode=event). */
  watch?: string[];
  timezone: string;
}

export interface ManifestEmit {
  symbol: string;
  kinds: string[];
}

export interface DataRefresh {
  mode: "scheduled" | "before_tick";
  cron?: string;
  timezone?: string;
}

export interface DataFreshness {
  max_age_hours?: number;
  max_age_seconds?: number;
  max_staleness_trading_days?: number;
  required: boolean;
}

export interface DataDependency {
  /** Adapter id for batch/persistent feeds (eia, fred, cftc). Omit for
   * `mode: before_tick` live deps — Magpie's market-data API handles
   * source routing internally. */
  source?: string;
  name: string;
  args: Record<string, unknown>;
  /** Parquet path relative to data_dir. Absent for live/in-memory data. */
  output?: string;
  refresh: DataRefresh;
  freshness: DataFreshness;
}

export interface SignalManifest {
  model_id: string;
  model_version: string;
  schedule: ManifestSchedule;
  emit: ManifestEmit;
  entrypoint: string;
  venv: string;
  data: DataDependency[];
  /** Absolute path to the signal directory. */
  _dir: string;
}

// ── YAML / JSON parsing ───────────────────────────────────────────

let yamlParse: ((text: string) => unknown) | null = null;

async function loadYamlParser(): Promise<(text: string) => unknown> {
  if (yamlParse) return yamlParse;
  try {
    const mod = await import("yaml");
    yamlParse = mod.parse;
    return yamlParse;
  } catch {
    throw new Error("Install the 'yaml' package: npm install yaml");
  }
}

async function readManifest(signalDir: string): Promise<SignalManifest> {
  const yamlPath = join(signalDir, "signal.yaml");
  const jsonPath = join(signalDir, "signal.json");

  let raw: string;
  let isYaml = false;

  if (existsSync(yamlPath)) {
    raw = readFileSync(yamlPath, "utf-8");
    isYaml = true;
  } else if (existsSync(jsonPath)) {
    raw = readFileSync(jsonPath, "utf-8");
  } else {
    throw new Error(`No signal.yaml or signal.json in ${signalDir}`);
  }

  let parsed: Record<string, unknown>;
  if (isYaml) {
    const parse = await loadYamlParser();
    parsed = parse(raw) as Record<string, unknown>;
  } else {
    parsed = JSON.parse(raw);
  }

  return { ...parsed, _dir: signalDir } as SignalManifest;
}

// ── Manifest discovery ────────────────────────────────────────────

/**
 * Conventional subdirectories under `dataSignalsPath` that hold manifest dirs.
 * `signals/` is for plain inference workers; `strategies/` is for full
 * portfolio-style strategies.
 */
const MANIFEST_ROOTS = ["signals", "strategies"] as const;

const MAX_WALK_DEPTH = 3;

function hasManifestFile(dir: string): boolean {
  return existsSync(join(dir, "signal.yaml")) || existsSync(join(dir, "signal.json"));
}

function readEntriesSafe(dir: string): Dirent<string>[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walkForManifests(dir: string, depth: number, out: SignalManifest[]): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  for (const entry of readEntriesSafe(dir)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const sub = join(dir, entry.name);
    if (hasManifestFile(sub)) {
      try {
        out.push(await readManifest(sub));
      } catch (e) {
        console.error(`[orchestrator] Failed to read manifest in ${sub}: ${e}`);
      }
      continue;
    }
    await walkForManifests(sub, depth + 1, out);
  }
}

/**
 * Discover all signal manifests under `dataSignalsPath`. Walks both
 * `signals/` and `strategies/` recursively (capped at MAX_WALK_DEPTH).
 */
export async function discoverManifests(dataSignalsPath: string): Promise<SignalManifest[]> {
  const manifests: SignalManifest[] = [];
  for (const root of MANIFEST_ROOTS) {
    const dir = join(dataSignalsPath, root);
    if (!existsSync(dir)) continue;
    await walkForManifests(dir, 1, manifests);
  }
  return manifests;
}
