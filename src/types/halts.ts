// Settings · Risk · Emergency — frontend mirror of
// server/risk/halts.ts. Server is authoritative.

export type HaltEventKind = "halt" | "reset";

export interface HaltEvent {
  ts: string;
  portfolio_id: string;
  kind: HaltEventKind;
  reason: string;
  actor: string;
}

export interface HaltsHistoryResponse {
  events: HaltEvent[];
}
