// ── Append-Only Fill Log ───────────────────────────────────────────
// JSONL format, one file per portfolio. Source of truth for position
// reconstruction on crash recovery.
// Defined in: docs/tdd/order-execution.md, §3

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Fill } from "../../src/types/order.js";

// ── Types ──────────────────────────────────────────────────────────

export interface FillLog {
  append(fill: Fill): void;
  read(): Fill[];
  path: string;
}

// ── Implementation ─────────────────────────────────────────────────

export function createFillLog(filePath: string): FillLog {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    path: filePath,

    append(fill: Fill): void {
      const line = JSON.stringify({ ...fill, v: fill.v ?? 1 }) + "\n";
      appendFileSync(filePath, line, "utf-8");
    },

    read(): Fill[] {
      if (!existsSync(filePath)) return [];

      const content = readFileSync(filePath, "utf-8").trim();
      if (!content) return [];

      const fills: Fill[] = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          fills.push(JSON.parse(line) as Fill);
        } catch {
          // Skip corrupted lines — log would be ideal but we don't have
          // a logger here. The crash-recovery test validates this behavior.
        }
      }
      return fills;
    },
  };
}
