// ── Research WebSocket client ───────────────────────────────────────
// Browser WS connection to the TS server's research event proxy.
// The server subscribes to NATS `research.jobs.status.*` +
// `research.jobs.result.*` and forwards messages to connected GUI
// clients. The server endpoint itself is a follow-on PR (QF-112
// scaffold ships the client + hook; the proxy lands when the
// orchestrator's data path stabilises).
//
// Auth model: the existing user-session token rides on the WS URL
// query string. Browser WebSocket can't set custom headers, so the
// server reads `?token=<jwt>` and validates against the session
// store. Token presence is required when the env-flag
// `VITE_RESEARCH_WS_AUTH_REQUIRED=1` is set; otherwise (local dev)
// the connection works anonymously.

import type { ResearchWsMessage } from "../../types/research.js";

interface ImportMetaEnv {
  readonly VITE_RESEARCH_WS_URL?: string;
  readonly VITE_API_URL?: string;
}
interface ImportMetaWithEnv {
  readonly env?: ImportMetaEnv;
}

const DEFAULT_API_URL = "http://localhost:3001";

export function defaultResearchWsUrl(): string {
  const env = (import.meta as unknown as ImportMetaWithEnv).env;
  if (env?.VITE_RESEARCH_WS_URL) return env.VITE_RESEARCH_WS_URL;
  const apiUrl = env?.VITE_API_URL || DEFAULT_API_URL;
  return apiUrl.replace(/^http/, "ws") + "/ws/research";
}

export interface ConnectResearchWsOptions {
  url?: string;
  token?: string | null;
  /** Override WebSocket constructor — tests pass a fake. */
  wsCtor?: typeof WebSocket;
}

export interface ConnectResearchWsHandlers {
  onMessage: (msg: ResearchWsMessage) => void;
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  onParseError?: (raw: string, error: unknown) => void;
}

/** Open a research-event WebSocket. Caller owns the returned
 *  socket (no auto-reconnect at this layer; the
 *  :func:`useResearchEvents` hook is the resilient layer).
 */
export function connectResearchWs(
  handlers: ConnectResearchWsHandlers,
  options: ConnectResearchWsOptions = {},
): WebSocket {
  const base = options.url ?? defaultResearchWsUrl();
  const url = options.token
    ? `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(options.token)}`
    : base;
  const WsImpl = options.wsCtor ?? WebSocket;
  const ws = new WsImpl(url);
  ws.onopen = () => handlers.onOpen?.();
  ws.onerror = (e) => handlers.onError?.(e);
  ws.onclose = (e) => handlers.onClose?.(e);
  ws.onmessage = (e: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(e.data) as ResearchWsMessage;
      handlers.onMessage(parsed);
    } catch (err) {
      handlers.onParseError?.(e.data, err);
    }
  };
  return ws;
}
