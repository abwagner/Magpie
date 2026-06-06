// ── Orchestrator Config + Adapter Bootstrap ────────────────────────
// Extracted from the retired lifecycle.ts (QF-282).
// Provides the two functions still needed by writeJobs handlers after
// the supervisor / manifest-walker surface was removed.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { registerAdapter } from "./adapter.js";
import { createEiaAdapter } from "./adapters/eia.js";
import { createFredAdapter } from "./adapters/fred.js";
import { createCftcAdapter } from "./adapters/cftc.js";
import { createOfacAdapter } from "./adapters/ofac.js";
import { createFmpAdapter } from "./adapters/fmp.js";
import { createYfinancialAdapter } from "./adapters/yfinancial.js";
import { createPortwatchAdapter } from "./adapters/portwatch.js";
import { createGfwAdapter } from "./adapters/gfw.js";
import { createMarinecadastreAdapter } from "./adapters/marinecadastre.js";
import { createAisstreamAdapter } from "./adapters/aisstream.js";

// ── Types ─────────────────────────────────────────────────────────

export interface SignalConfigEntry {
  enabled: boolean;
}

export interface OrchestratorConfig {
  dataSignalsPath: string;
  dataDir: string;
  ingressUrl: string;
  env: Record<string, string>;
  /** Active signals keyed by directory name (e.g. "vol-buyer"). */
  signals: Record<string, SignalConfigEntry>;
  /**
   * Legacy flat list; read-only fallback on first load. Writes always
   * use the object form. Kept for migration compatibility.
   */
  activeSignals: string[];
}

// ── Config loading ────────────────────────────────────────────────

const CONFIG_FILE = "config/orchestrator.json";

export function loadConfig(projectRoot: string): OrchestratorConfig {
  const configPath = resolve(projectRoot, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new Error(`Orchestrator config not found: ${configPath}`);
  }
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));

  // New shape: raw.signals = { "vol-buyer": { enabled: true }, ... }
  // Legacy fallback: raw.active_signals = ["vol-buyer", ...] — seed as all enabled.
  const signals: Record<string, SignalConfigEntry> = {};
  if (raw.signals && typeof raw.signals === "object") {
    for (const [name, entry] of Object.entries(raw.signals as Record<string, SignalConfigEntry>)) {
      signals[name] = { enabled: entry?.enabled !== false };
    }
  } else if (Array.isArray(raw.active_signals)) {
    for (const name of raw.active_signals) signals[name] = { enabled: true };
  }

  return {
    dataSignalsPath: resolve(projectRoot, raw.data_signals_path ?? "../data-signals"),
    dataDir: resolve(projectRoot, raw.data_dir ?? "data/macro"),
    ingressUrl: raw.ingress_url ?? "http://localhost:3001/signals",
    env: raw.env ?? {},
    signals,
    activeSignals: Object.keys(signals),
  };
}

// ── Adapter bootstrap ─────────────────────────────────────────────

export function bootstrapAdapters(_config: OrchestratorConfig): void {
  registerAdapter(createEiaAdapter());
  registerAdapter(createFredAdapter());
  registerAdapter(createCftcAdapter());
  registerAdapter(createOfacAdapter());
  registerAdapter(createFmpAdapter());
  registerAdapter(createYfinancialAdapter());
  registerAdapter(createPortwatchAdapter());
  registerAdapter(createGfwAdapter());
  registerAdapter(createMarinecadastreAdapter());
  registerAdapter(createAisstreamAdapter());
}
