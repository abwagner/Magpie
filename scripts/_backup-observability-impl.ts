#!/usr/bin/env tsx
// ── Observability Backup (QF-279 / M15-5) ─────────────────────────
// Snapshots the local Loki + Prometheus filesystem stores to a MinIO
// (S3-compatible) bucket as a date-stamped offsite DR copy, then
// expires snapshots older than the retention window.
//
// This is the subprocess spawned by the `backup-observability`
// write-jobs handler. It mirrors scripts/_sync-to-s3-impl.ts: the
// handler keeps the orchestration; the actual `aws s3 sync` shell-outs
// live here because migrating them inline gains nothing.
//
// Usage:
//   npx tsx scripts/_backup-observability-impl.ts --bucket magpie-observability-backups
//   npx tsx scripts/_backup-observability-impl.ts --endpoint-url https://s3.example.com --dry-run
//   npx tsx scripts/_backup-observability-impl.ts  # reads from config/storage.json + env

import { resolve, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ── Stores ────────────────────────────────────────────────────────
// The two filesystem-backed observability stores. Paths are relative
// to the repo root and match the bind mounts an operator points the
// loki/prometheus containers at (see deploy/observability/).
const STORES = [
  { name: "loki", localSubpath: "deploy/observability/data/loki" },
  { name: "prometheus", localSubpath: "deploy/observability/data/prometheus" },
] as const;

const DEFAULT_RETENTION_DAYS = 30;

// ── Args ──────────────────────────────────────────────────────────

export interface BackupOpts {
  bucket?: string;
  endpointUrl?: string;
  region?: string;
  retentionDays: number;
  dryRun: boolean;
}

/** Parse CLI args into options. Throws on invalid input so it can be unit
 *  tested; the CLI wrapper (`main`) catches and exits non-zero. */
export function parseArgs(args: string[]): BackupOpts {
  const opts: BackupOpts = { dryRun: false, retentionDays: DEFAULT_RETENTION_DAYS };

  const takeValue = (i: number, flag: string): string => {
    const v = args[i];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--bucket") opts.bucket = takeValue(++i, arg);
    else if (arg === "--endpoint-url") opts.endpointUrl = takeValue(++i, arg);
    else if (arg === "--region") opts.region = takeValue(++i, arg);
    else if (arg === "--retention-days") {
      const raw = takeValue(++i, arg);
      const v = Number(raw);
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error(`--retention-days must be a positive integer, got: ${raw}`);
      }
      opts.retentionDays = v;
    } else if (arg === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unknown flag: ${arg}`);
  }

  return opts;
}

// ── Config ───────────────────────────────────────────────────────

interface StorageConfig {
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  observabilityBackupBucket?: string;
}

function loadConfig(): StorageConfig | null {
  const configPath = resolve(ROOT_DIR, "config", "storage.json");
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, "utf-8")) as StorageConfig;
}

// ── Snapshot helpers ──────────────────────────────────────────────

/** UTC date stamp (YYYY-MM-DD) used as the snapshot prefix segment. */
export function snapshotDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Snapshot S3 prefixes older than `retentionDays` from `now`, given the
 *  set of existing date-stamped snapshot dates. Pure so it can be unit
 *  tested without touching S3. */
export function expiredSnapshots(
  existing: readonly string[],
  retentionDays: number,
  now: Date = new Date(),
): string[] {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffStr = snapshotDate(cutoff);
  return existing.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoffStr).sort();
}

/** Run the AWS CLI with arguments passed as an array — NO shell — so
 *  job-submitted values (bucket, endpoint URL) can never be interpreted
 *  as shell syntax. */
function aws(args: string[]): string {
  return execFileSync("aws", args, { encoding: "utf-8", stdio: "pipe" });
}

function endpointArgs(endpointUrl?: string): string[] {
  return endpointUrl ? ["--endpoint-url", endpointUrl] : [];
}

function syncStore(args: {
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
  const cliArgs = [
    "s3",
    "sync",
    localPath,
    s3Path,
    "--exclude",
    "*.tmp",
    ...(dryRun ? ["--dryrun"] : []),
    ...endpointArgs(endpointUrl),
  ];
  console.log(
    `  ${BOLD}${label}:${RESET} ${localPath} → ${s3Path}${dryRun ? ` ${DIM}(dry run)${RESET}` : ""}`,
  );
  const output = aws(cliArgs);
  const lines = output.trim() ? output.trim().split("\n") : [];
  console.log(`    ${GREEN}${lines.length} file(s) synced${RESET}`);
}

function expireOldSnapshots(args: {
  bucket: string;
  endpointUrl?: string;
  retentionDays: number;
  dryRun: boolean;
}): void {
  const { bucket, endpointUrl, retentionDays, dryRun } = args;
  let listing: string;
  try {
    listing = aws(["s3", "ls", `s3://${bucket}/observability/`, ...endpointArgs(endpointUrl)]);
  } catch {
    // No snapshots yet (prefix absent) — nothing to expire.
    return;
  }
  const dates = listing
    .split("\n")
    .map((l) => l.trim().match(/PRE\s+(\d{4}-\d{2}-\d{2})\/$/)?.[1])
    .filter((d): d is string => Boolean(d));
  const expired = expiredSnapshots(dates, retentionDays);
  for (const date of expired) {
    const prefix = `s3://${bucket}/observability/${date}/`;
    console.log(`  ${DIM}Expiring snapshot ${date}${dryRun ? " (dry run)" : ""}${RESET}`);
    if (!dryRun) aws(["s3", "rm", prefix, "--recursive", ...endpointArgs(endpointUrl)]);
  }
}

// ── Main ─────────────────────────────────────────────────────────

function main(): void {
  let opts: BackupOpts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const config = loadConfig();

  const bucket =
    opts.bucket ??
    process.env.OBSERVABILITY_BACKUP_BUCKET ??
    config?.observabilityBackupBucket ??
    process.env.S3_BUCKET ??
    config?.s3Bucket;
  const region = opts.region ?? process.env.S3_REGION ?? config?.s3Region ?? "us-east-1";
  const endpointUrl = opts.endpointUrl ?? process.env.S3_ENDPOINT_URL ?? config?.s3Endpoint;

  if (!bucket) {
    console.error(`\n  ${RED}No backup bucket specified.${RESET}`);
    console.error(
      `  Provide --bucket, set OBSERVABILITY_BACKUP_BUCKET, or s3Bucket in config/storage.json\n`,
    );
    process.exit(1);
  }

  const date = snapshotDate();
  const target = endpointUrl ? `${endpointUrl} ${DIM}→${RESET} ${bucket}` : bucket;
  console.log(
    `\n  ${BOLD}Observability Backup${RESET}  ${DIM}target: ${target}  snapshot: ${date}${RESET}\n`,
  );

  if (!process.env.AWS_DEFAULT_REGION) process.env.AWS_DEFAULT_REGION = region;

  try {
    for (const store of STORES) {
      syncStore({
        localPath: resolve(ROOT_DIR, store.localSubpath),
        s3Path: `s3://${bucket}/observability/${date}/${store.name}/`,
        endpointUrl,
        dryRun: opts.dryRun,
        label: store.name.charAt(0).toUpperCase() + store.name.slice(1),
      });
    }
    expireOldSnapshots({
      bucket,
      endpointUrl,
      retentionDays: opts.retentionDays,
      dryRun: opts.dryRun,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${RED}Failed: ${message}${RESET}\n`);
    process.exit(1);
  }

  console.log(`\n  ${GREEN}Done.${RESET}\n`);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
