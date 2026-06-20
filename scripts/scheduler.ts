#!/usr/bin/env node
// ── Magpie Ingest Scheduler ─────────────────────────────────
// Long-running entrypoint for the magpie-scheduler container.
// Schedules the nightly data ingest jobs that previously ran as
// systemd timers + crontab on your-workstation:
//
//   collect-bulk    20:00 ET daily         (MarketData options chains)
//   ingest-fred     19:00 ET weekdays      (FRED macro)
//   ingest-eia      11:00 ET Wednesdays    (EIA WPSR publishes 10:30 ET)
//   ingest-cftc     20:00 ET Fridays       (CFTC COT)
//   databento-pull  18:00 ET weekdays      (Databento futures, post-close)
//   backup-observability  03:00 ET daily   (Loki+Prometheus → MinIO DR)
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
  {
    name: "backup-observability",
    schedule: "0 3 * * *",
    command: "npm",
    args: ["run", "--silent", "backup-observability"],
  },
];

function ts(): string {
  return new Date().toISOString();
}

// ── Alerting ───────────────────────────────────────────────
// Push job failures to the swagner-server ntfy backbone so a broken nightly
// ingest surfaces as a phone notification, not just a buried log line.
// Best-effort: always logs; a notify outage must never break the loop.
// Config: NTFY_URL (e.g. http://ntfy), NTFY_TOPIC, NTFY_TOKEN (from root .env).
async function notify(subject: string, body: string): Promise<void> {
  console.error(`[scheduler] ALERT: ${subject} — ${body}`);
  const url = process.env.NTFY_URL;
  const topic = process.env.NTFY_TOPIC;
  if (!url || !topic) return;
  const token = process.env.NTFY_TOKEN;
  try {
    // JSON publish (POST to base URL) so unicode in the title/message survives —
    // ntfy's title HTTP header is ASCII-only.
    const res = await fetch(url.replace(/\/+$/, ""), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        topic,
        title: subject,
        message: body,
        priority: 4,
        tags: ["warning"],
      }),
    });
    if (!res.ok) console.error(`[scheduler] notify_failed: HTTP ${res.status}`);
  } catch (e: unknown) {
    console.error(`[scheduler] notify_failed:`, e);
  }
}

function runJob(job: Job): Promise<void> {
  return new Promise((resolveRun) => {
    console.log(`[scheduler] ${ts()} ${job.name} starting`);
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolveRun();
    };
    const child = spawn(job.command, [...job.args], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code, signal) => {
      const status = code === 0 ? "ok" : `failed code=${code} signal=${signal ?? ""}`;
      console.log(`[scheduler] ${ts()} ${job.name} ${status}`);
      if (code !== 0) {
        void notify(
          `magpie: ${job.name} failed`,
          `${job.name} exited ${status}. Nightly ingest did not complete; ` +
            `check the magpie-scheduler logs. Retries on the next scheduled run.`,
        );
      }
      finish();
    });
    child.on("error", (err: Error) => {
      console.error(`[scheduler] ${ts()} ${job.name} spawn error:`, err);
      void notify(
        `magpie: ${job.name} failed to start`,
        `${job.name} could not be spawned: ${err.message}`,
      );
      finish();
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
