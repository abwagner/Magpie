import { loadJobClientEnv, submitAndPoll } from "./_jobsClient.js";
loadJobClientEnv();
const i = process.argv.indexOf("--start-index");
const start_index = i >= 0 ? Number(process.argv[i + 1]) : undefined;
await submitAndPoll("collect-ohlcv", { mode: process.argv.includes("--daily") ? "daily" : "backfill", ...(Number.isFinite(start_index) ? { start_index } : {}) }, { label: "collect-ohlcv", pollMs: 5000 });
