// ── Issue Write-Job Token CLI (M10-1) ─────────────────────────────
//
// Mints a new bearer token for the write-dispatch API and prints it
// to stdout exactly once — the token is hashed before being persisted
// to the on-disk store, so this is your only chance to capture it.
//
// Usage:
//   npm run issue-write-token -- --actor operator-awagner --scopes '*'
//   npm run issue-write-token -- --actor cron-server --scopes fmp-backfill,ingest
//
// Token-store path defaults to `WRITE_JOB_TOKEN_PATH` env var, or
// `data/secrets/write-job-tokens.json` if unset.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileWriteJobTokenStore } from "../server/writeJobs/tokens.js";

// .env auto-load — mirrors server/index.js so the script picks up
// WRITE_JOB_TOKEN_PATH from .env without `set -a; source .env`.
const __script_dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__script_dir, "..");
function loadDotEnv(path: string): void {
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1]!.trim()]) {
        process.env[m[1]!.trim()] = m[2]!.trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* file missing is fine */
  }
}
loadDotEnv(resolve(PROJECT_ROOT, ".env"));
loadDotEnv(resolve(homedir(), ".env"));

function parseArgs(argv: string[]): { actor?: string; scopes?: string[]; path?: string } {
  const out: { actor?: string; scopes?: string[]; path?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--actor") out.actor = argv[++i];
    else if (a === "--scopes") {
      const v = argv[++i] ?? "";
      out.scopes = v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (a === "--path") out.path = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.actor) {
    console.error("--actor is required (e.g. --actor operator-awagner)");
    process.exit(1);
  }
  if (!args.scopes || args.scopes.length === 0) {
    console.error('--scopes is required (e.g. --scopes "*" or --scopes fmp-backfill,ingest)');
    process.exit(1);
  }
  const path =
    args.path ??
    process.env.WRITE_JOB_TOKEN_PATH ??
    resolve(process.cwd(), "data", "secrets", "write-job-tokens.json");
  const store = createFileWriteJobTokenStore({ path });
  const { token, entry } = await store.issue({ actor: args.actor, scopes: args.scopes });
  console.log("Token issued — capture this now; it is not stored in plaintext.\n");
  console.log(`  actor:    ${entry.actor}`);
  console.log(`  scopes:   ${entry.scopes.join(", ")}`);
  console.log(`  token_id: ${entry.token_id}`);
  console.log(`  store:    ${path}\n`);
  console.log(`  token:    ${token}\n`);
  console.log("Use with:");
  console.log(`  curl -H "Authorization: Bearer ${token}" http://localhost:3001/api/write-jobs`);
}

void main().catch((e: unknown) => {
  console.error("[issue-write-token] fatal:", e);
  process.exit(1);
});
