#!/usr/bin/env node
// ── Magpie Ingest Scheduler ─────────────────────────────────
// Long-running entrypoint for the quantfoundry-scheduler container.
// Schedules the nightly data ingest jobs that previously ran as
// systemd timers + crontab on your-workstation:
//
//   collect-bulk    20:00 ET daily         (MarketData options chains)
//   ingest-fred     19:00 ET weekdays      (FRED macro)
//   ingest-eia      11:00 ET Wednesdays    (EIA WPSR publishes 10:30 ET)
//   ingest-cftc     20:00 ET Fridays       (CFTC COT)
//   databento-pull  18:00 ET weekdays      (Databento futures, post-close)
//
// Logs to stdout; docker captures.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Cron } from "croner";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TZ = "America/New_York";

interface Job {
  name: string;
  schedule: string;
  command: string;
  args: readonly string[];
}

const JOBS: readonly Job[] = [
  {
    name: "collect-bulk",
    schedule: "0 20 * * *",
    command: "npm",
    args: ["run", "--silent", "collect:bulk"],
  },
  {
    name: "ingest-fred",
    schedule: "0 19 * * 1-5",
    command: "npm",
    args: ["run", "--silent", "ingest", "--", "--source", "fred"],
  },
  {
    name: "ingest-eia",
    schedule: "0 11 * * 3",
    command: "npm",
    args: ["run", "--silent", "ingest", "--", "--source", "eia"],
  },
  {
    name: "ingest-cftc",
    schedule: "0 20 * * 5",
    command: "npm",
    args: ["run", "--silent", "ingest", "--", "--source", "cftc"],
  },
  {
    name: "databento-pull",
    schedule: "0 18 * * 1-5",
    command: "npm",
    args: ["run", "--silent", "databento:pull"],
  },
];

function ts(): string {
  return new Date().toISOString();
}

function runJob(job: Job): Promise<void> {
  return new Promise((resolveRun) => {
    console.log(`[scheduler] ${ts()} ${job.name} starting`);
    const child = spawn(job.command, [...job.args], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code, signal) => {
      const status = code === 0 ? "ok" : `failed code=${code} signal=${signal ?? ""}`;
      console.log(`[scheduler] ${ts()} ${job.name} ${status}`);
      resolveRun();
    });
  });
}

function main(): void {
  console.log(`[scheduler] ${ts()} Magpie ingest scheduler starting (tz=${TZ})`);
  const tasks: Cron[] = [];
  for (const job of JOBS) {
    const task = new Cron(job.schedule, { timezone: TZ, name: job.name, protect: true }, () => {
      runJob(job).catch((e: unknown) => {
        console.error(`[scheduler] ${job.name} threw:`, e);
      });
    });
    tasks.push(task);
    const next = task.nextRun();
    console.log(
      `[scheduler]   ${job.name.padEnd(13)} ${job.schedule.padEnd(13)} next=${next?.toISOString() ?? "n/a"}`,
    );
  }

  const shutdown = (sig: NodeJS.Signals): void => {
    console.log(`[scheduler] ${ts()} received ${sig}, stopping tasks`);
    for (const task of tasks) {
      task.stop();
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`[scheduler] ${ts()} ready`);
}

main();
