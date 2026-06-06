#!/usr/bin/env tsx
// ── S3 Sync ──────────────────────────────────────────────────────
// Syncs local Parquet data to an S3-compatible bucket (AWS S3 or MinIO).
// Idempotent — only uploads new/changed files. Suitable for cron scheduling.
//
// Usage:
//   npx tsx scripts/sync-to-s3.ts --bucket quantfoundry-data
//   npx tsx scripts/sync-to-s3.ts --endpoint-url https://s3.example.com
//   npx tsx scripts/sync-to-s3.ts --only chains --dry-run
//   npx tsx scripts/sync-to-s3.ts --no-chains --no-futures   # everything else
//   npx tsx scripts/sync-to-s3.ts  # reads from config/storage.json + env

import { resolve, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ── Subdir set ────────────────────────────────────────────────────
// All known data subdirs that may be synced. Added/removed here propagates
// through the CLI flags and the default sync set.
const KNOWN_SUBDIRS = [
  "chains",
  "signals",
  "macro",
  "futures",
  "etfs",
  "fills",
  "results",
  "databento",
] as const;
type Subdir = (typeof KNOWN_SUBDIRS)[number];

// ── Args ──────────────────────────────────────────────────────────

interface SyncOpts {
  bucket?: string;
  endpointUrl?: string;
  region?: string;
  /** When set, only this subdir is synced (overrides include/exclude). */
  only?: Subdir;
  /** Per-subdir explicit include (--<subdir>). Empty = no explicit selection. */
  include: Set<Subdir>;
  /** Per-subdir explicit exclude (--no-<subdir>). */
  exclude: Set<Subdir>;
  dryRun: boolean;
}

function parseArgs(): SyncOpts {
  const args = process.argv.slice(2);
  const opts: SyncOpts = { dryRun: false, include: new Set(), exclude: new Set() };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--bucket") opts.bucket = args[++i];
    else if (arg === "--endpoint-url") opts.endpointUrl = args[++i];
    else if (arg === "--region") opts.region = args[++i];
    else if (arg === "--only") {
      const v = args[++i] as Subdir | undefined;
      if (!v || !KNOWN_SUBDIRS.includes(v)) {
        console.error(`Unknown --only value: ${v}. Expected one of: ${KNOWN_SUBDIRS.join(", ")}`);
        process.exit(1);
      }
      opts.only = v;
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--no-")) {
      const sub = arg.slice("--no-".length) as Subdir;
      if (KNOWN_SUBDIRS.includes(sub)) opts.exclude.add(sub);
      else {
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
      }
    } else if (arg.startsWith("--")) {
      const sub = arg.slice("--".length) as Subdir;
      if (KNOWN_SUBDIRS.includes(sub)) opts.include.add(sub);
      else {
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
      }
    }
  }

  return opts;
}

function selectSubdirs(opts: SyncOpts): readonly Subdir[] {
  if (opts.only) return [opts.only];
  // Explicit includes win; otherwise default to all known subdirs minus explicit excludes.
  const base = opts.include.size > 0 ? Array.from(opts.include) : Array.from(KNOWN_SUBDIRS);
  return base.filter((s) => !opts.exclude.has(s));
}

// ── Config ───────────────────────────────────────────────────────

interface StorageConfig {
  mode?: string;
  localDir?: string;
  s3Bucket?: string;
  s3Prefix?: string;
  s3Region?: string;
  s3Endpoint?: string;
}

function loadConfig(): StorageConfig | null {
  const configPath = resolve(ROOT_DIR, "config", "storage.json");
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, "utf-8")) as StorageConfig;
}

// ── Sync ─────────────────────────────────────────────────────────

function runSync(args: {
  localPath: string;
  s3Path: string;
  endpointUrl?: string;
  dryRun: boolean;
  label: string;
}): void {
  const { localPath, s3Path, endpointUrl, dryRun, label } = args;
  if (!existsSync(localPath)) {
    console.log(`  ${DIM}Skip ${label}: ${localPath} does not exist${RESET}`);
    return;
  }

  const flags = [
    `--exclude "*.tmp"`,
    `--exclude ".DS_Store"`,
    dryRun ? "--dryrun" : "",
    endpointUrl ? `--endpoint-url "${endpointUrl}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const cmd = `aws s3 sync "${localPath}" "${s3Path}" ${flags}`.trim();

  console.log(
    `  ${BOLD}${label}:${RESET} ${localPath} → ${s3Path}${dryRun ? ` ${DIM}(dry run)${RESET}` : ""}`,
  );

  try {
    const output = execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
    if (output.trim()) {
      const lines = output.trim().split("\n");
      console.log(`    ${GREEN}${lines.length} file(s) synced${RESET}`);
      for (const line of lines.slice(0, 10)) {
        console.log(`    ${DIM}${line}${RESET}`);
      }
      if (lines.length > 10) {
        console.log(`    ${DIM}... and ${lines.length - 10} more${RESET}`);
      }
    } else {
      console.log(`    ${DIM}Already in sync${RESET}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`    ${RED}Failed: ${message}${RESET}`);
    process.exit(1);
  }
}

// ── Main ─────────────────────────────────────────────────────────

function main(): void {
  const opts = parseArgs();
  const config = loadConfig();

  const bucket = opts.bucket ?? process.env.S3_BUCKET ?? config?.s3Bucket;
  const region = opts.region ?? process.env.S3_REGION ?? config?.s3Region ?? "us-east-1";
  const endpointUrl = opts.endpointUrl ?? process.env.S3_ENDPOINT_URL ?? config?.s3Endpoint;

  if (!bucket) {
    console.error(`\n  ${RED}No S3 bucket specified.${RESET}`);
    console.error(`  Provide --bucket flag or set s3Bucket in config/storage.json\n`);
    process.exit(1);
  }

  const subdirs = selectSubdirs(opts);
  if (subdirs.length === 0) {
    console.error(`\n  ${RED}No subdirs selected.${RESET}\n`);
    process.exit(1);
  }

  const target = endpointUrl ? `${endpointUrl} ${DIM}→${RESET} ${bucket}` : bucket;
  console.log(`\n  ${BOLD}S3 Sync${RESET}  ${DIM}target: ${target}  region: ${region}${RESET}`);
  console.log(`  ${DIM}subdirs: ${subdirs.join(", ")}${RESET}\n`);

  if (!process.env.AWS_DEFAULT_REGION) process.env.AWS_DEFAULT_REGION = region;

  for (const sub of subdirs) {
    runSync({
      localPath: resolve(ROOT_DIR, "data", sub),
      s3Path: `s3://${bucket}/${sub}/`,
      endpointUrl,
      dryRun: opts.dryRun,
      label: sub.charAt(0).toUpperCase() + sub.slice(1),
    });
  }

  console.log(`\n  ${GREEN}Done.${RESET}\n`);
}

main();
