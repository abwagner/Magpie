// Tests for the useResearchEvents hook. Uses a hand-rolled fake
// WebSocket constructor that lets the test fire onopen / onmessage /
// onclose at controlled times — this is cleaner than mocking the
// global WebSocket and avoids surface-area drift.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useResearchEvents } from "./useResearchEvents.js";
import { SESSION_TOKEN_STORAGE_KEY } from "./useSessionToken.js";
import type { ResearchResultMessage, ResearchStatusMessage } from "../../types/research.js";

// ── Fake WebSocket ──────────────────────────────────────────────────

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readyState = 0;
  url: string;
  onopen: (() => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  fireOpen(): void {
    this.onopen?.();
  }

  fireMessage(payload: object): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

const FakeWsCtor = FakeWebSocket as unknown as typeof WebSocket;

const statusMsg = (
  job_id: string,
  state: "pending" | "running" | "completed" | "failed",
  extra: Partial<ResearchStatusMessage["job"]> = {},
): ResearchStatusMessage => ({
  kind: "status",
  subject: `research.jobs.status.${job_id}`,
  job: {
    job_id,
    state,
    submitted_at: "2026-05-15T20:00:00Z",
    correlation_id: null,
    ...extra,
  },
});

const resultMsg = (job_id: string): ResearchResultMessage => ({
  kind: "result",
  subject: `research.jobs.result.${job_id}`,
  result: {
    job_id,
    run_id: "r",
    strategy_id: "x",
    strategy_version: "v1",
    start_date: "2024-01-01",
    end_date: "2024-12-31",
    portfolio: "p",
    metrics: { sharpe: 1.5 },
    trade_count: 10,
  },
});

beforeEach(() => {
  FakeWebSocket.reset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("useResearchEvents", () => {
  it("starts disconnected, becomes connected on open", () => {
    const { result } = renderHook(() =>
      useResearchEvents({ wsCtor: FakeWsCtor, reconnect: false }),
    );
    expect(result.current.connected).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => FakeWebSocket.instances[0]!.fireOpen());
    expect(result.current.connected).toBe(true);
  });

  it("accumulates JobStatus updates by job_id", () => {
    const { result } = renderHook(() =>
      useResearchEvents({ wsCtor: FakeWsCtor, reconnect: false }),
    );
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());
    act(() => ws.fireMessage(statusMsg("j1", "pending")));
    act(() => ws.fireMessage(statusMsg("j1", "running")));
    act(() => ws.fireMessage(statusMsg("j2", "pending")));

    expect(Object.keys(result.current.jobs)).toHaveLength(2);
    expect(result.current.jobs.j1?.state).toBe("running");
    expect(result.current.jobs.j2?.state).toBe("pending");
  });

  it("stores the latest correlation_id seen", () => {
    const { result } = renderHook(() =>
      useResearchEvents({ wsCtor: FakeWsCtor, reconnect: false }),
    );
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());
    act(() => ws.fireMessage(statusMsg("j1", "running", { correlation_id: "cid-xyz" })));
    expect(result.current.lastCorrelationId).toBe("cid-xyz");
  });

  it("merges a result envelope into the results map", () => {
    const { result } = renderHook(() =>
      useResearchEvents({ wsCtor: FakeWsCtor, reconnect: false }),
    );
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());
    act(() => ws.fireMessage(resultMsg("j1")));
    expect(result.current.results.j1?.metrics.sharpe).toBe(1.5);
  });

  it("ignores malformed messages and surfaces them via lastError", () => {
    const { result } = renderHook(() =>
      useResearchEvents({ wsCtor: FakeWsCtor, reconnect: false }),
    );
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());
    act(() => {
      ws.onmessage?.(new MessageEvent("message", { data: "not json" }));
    });
    expect(result.current.lastError).toMatch(/parse failure/);
  });

  it("appends ?token=<jwt> when localStorage has a session token", () => {
    window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, "tok-abc");
    renderHook(() => useResearchEvents({ wsCtor: FakeWsCtor, reconnect: false }));
    expect(FakeWebSocket.instances[0]!.url).toContain("token=tok-abc");
  });

  it("uses the explicit token option over the ambient one", () => {
    window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, "ambient");
    renderHook(() =>
      useResearchEvents({
        wsCtor: FakeWsCtor,
        reconnect: false,
        token: "explicit-override",
      }),
    );
    expect(FakeWebSocket.instances[0]!.url).toContain("token=explicit-override");
  });

  it("does not append a token query when none is configured", () => {
    renderHook(() => useResearchEvents({ wsCtor: FakeWsCtor, reconnect: false, token: null }));
    expect(FakeWebSocket.instances[0]!.url).not.toContain("token=");
  });

  it("uses the override url when provided", () => {
    renderHook(() =>
      useResearchEvents({
        wsCtor: FakeWsCtor,
        reconnect: false,
        url: "ws://custom.test/ws/research",
      }),
    );
    expect(FakeWebSocket.instances[0]!.url).toMatch(/^ws:\/\/custom\.test/);
  });
});
