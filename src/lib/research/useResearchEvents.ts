// ── useResearchEvents hook ──────────────────────────────────────────
// Maintains a live map of {job_id → JobStatus} from the research-
// event WebSocket. Reconnects on close with exponential backoff,
// surfaces the current connection state, and exposes the latest
// correlation_id seen (handy for the "current job" badge in the
// scaffolds).
//
// Auth: pulls the session token from useSessionToken() and passes
// it as a query param to the underlying connect helper. When the
// user has no token and `VITE_RESEARCH_WS_AUTH_REQUIRED` is set, the
// server is expected to refuse; the hook surfaces that as a
// disconnected state with `lastError` populated.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectResearchWs } from "./ws.js";
import { useSessionToken } from "./useSessionToken.js";
import type { JobResult, JobStatus, ResearchWsMessage } from "../../types/research.js";

export interface UseResearchEventsState {
  /** Latest known status per job_id. Updates in-place on each WS msg. */
  jobs: Record<string, JobStatus>;
  /** Latest standalone result per job_id (mirrors `status.result`
   *  when both arrive; useful when only `result` came over the wire). */
  results: Record<string, JobResult>;
  /** True between successful WS open and close events. */
  connected: boolean;
  /** True while a reconnect attempt is queued. */
  reconnecting: boolean;
  /** Last error message produced by the WS layer. */
  lastError: string | null;
  /** Most recent correlation_id observed on an inbound message. */
  lastCorrelationId: string | null;
}

export interface UseResearchEventsOptions {
  /** Override WS URL; defaults to the env-derived one. */
  url?: string;
  /** Override token; defaults to useSessionToken(). */
  token?: string | null;
  /** Constructor for tests. */
  wsCtor?: typeof WebSocket;
  /** Disable reconnect (tests). */
  reconnect?: boolean;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export function useResearchEvents(options: UseResearchEventsOptions = {}): UseResearchEventsState {
  const ambientToken = useSessionToken();
  const token = options.token !== undefined ? options.token : ambientToken;
  const reconnect = options.reconnect !== false;

  const [jobs, setJobs] = useState<Record<string, JobStatus>>({});
  const [results, setResults] = useState<Record<string, JobResult>>({});
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastCorrelationId, setLastCorrelationId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number>(INITIAL_BACKOFF_MS);
  const closedByUsRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMessage = useCallback((msg: ResearchWsMessage) => {
    if (msg.kind === "status") {
      setJobs((prev) => ({ ...prev, [msg.job.job_id]: msg.job }));
      if (msg.job.correlation_id) setLastCorrelationId(msg.job.correlation_id);
      // If the status carries a final result inline, update that map too.
      if (msg.job.result) {
        setResults((prev) => ({ ...prev, [msg.job.job_id]: msg.job.result! }));
      }
    } else if (msg.kind === "result") {
      setResults((prev) => ({ ...prev, [msg.result.job_id]: msg.result }));
    }
  }, []);

  useEffect(() => {
    closedByUsRef.current = false;

    function open() {
      const ws = connectResearchWs(
        {
          onMessage: handleMessage,
          onOpen: () => {
            setConnected(true);
            setReconnecting(false);
            setLastError(null);
            retryRef.current = INITIAL_BACKOFF_MS;
          },
          onClose: () => {
            setConnected(false);
            wsRef.current = null;
            if (closedByUsRef.current || !reconnect) return;
            setReconnecting(true);
            reconnectTimerRef.current = setTimeout(() => {
              retryRef.current = Math.min(retryRef.current * 2, MAX_BACKOFF_MS);
              open();
            }, retryRef.current);
          },
          onError: () => {
            setLastError("WebSocket error");
          },
          onParseError: (_raw, err) => {
            setLastError(`message parse failure: ${String(err)}`);
          },
        },
        {
          url: options.url,
          token,
          wsCtor: options.wsCtor,
        },
      );
      wsRef.current = ws;
    }

    open();

    return () => {
      closedByUsRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [handleMessage, options.url, options.wsCtor, token, reconnect]);

  return useMemo(
    () => ({
      jobs,
      results,
      connected,
      reconnecting,
      lastError,
      lastCorrelationId,
    }),
    [jobs, results, connected, reconnecting, lastError, lastCorrelationId],
  );
}
