// ── Slack webhook channel (QF-61) ─────────────────────────────────
//
// Posts a formatted message to an Incoming Webhook URL. Webhook URLs
// are configured via env var (SLACK_WEBHOOK_URL); the router only
// dispatches to this channel when an event matches a rule with
// `channels: [slack]`.
//
// Keep this tiny — Slack accepts JSON POST with a `text` field; no
// SDK needed.

import type { AlertEvent, AlertLevel } from "../router.js";

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  info: "🔵",
  warning: "🟡",
  critical: "🔴",
};

export async function postToSlack(webhookUrl: string, event: AlertEvent): Promise<void> {
  const emoji = LEVEL_EMOJI[event.level];
  const lines = [
    `${emoji} *[${event.level.toUpperCase()}] ${event.type}*`,
    `_${event.ts}_`,
    event.message,
  ];
  if (event.payload && Object.keys(event.payload).length > 0) {
    lines.push("```\n" + JSON.stringify(event.payload, null, 2) + "\n```");
  }
  const body = { text: lines.join("\n") };
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook returned HTTP ${res.status}`);
  }
}
