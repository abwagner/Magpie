// Settings · Activity · Alerts — frontend mirror of
// server/alerts/router.ts. Server is authoritative.

export type AlertLevel = "info" | "warning" | "critical";
export type AlertChannel = "log" | "internal" | "slack";

export interface AlertEvent {
  ts: string;
  type: string;
  level: AlertLevel;
  message: string;
  payload?: Record<string, unknown>;
}

export interface AlertRule {
  id: string;
  description?: string;
  match: {
    type_prefix?: string;
    levels?: AlertLevel[];
  };
  channels: AlertChannel[];
}

export interface AlertsConfig {
  version: 1;
  rules: AlertRule[];
}

export interface AlertsRecentResponse {
  events: AlertEvent[];
}
