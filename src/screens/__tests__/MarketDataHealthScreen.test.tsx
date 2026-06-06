// Tests for the BatchFreshnessPanel subcomponent of MarketDataHealthScreen.
// The outer screen depends on multiple API calls and polling; we test the
// isolated panel with explicit prop injection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BatchFreshnessPanel } from "../MarketDataHealthScreen.js";
import type { FreshnessResponse, SourceFreshness } from "../../types/catalog.js";

// ── Mock api.ts ───────────────────────────────────────────────────

vi.mock("../../lib/api.js", () => ({
  getWriteJobToken: vi.fn(() => null),
  setWriteJobToken: vi.fn(),
  submitIngest: vi.fn(),
  getCatalogFreshness: vi.fn(),
}));

import * as api from "../../lib/api.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Fixtures ──────────────────────────────────────────────────────

const FRESH_SOURCE: SourceFreshness = {
  source: "fred",
  last_success_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  data_through: "2026-05-23",
  expected_cadence_hours: 24,
  age_hours: 2,
  status: "fresh",
};

const STALE_SOURCE: SourceFreshness = {
  source: "fmp",
  last_success_at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
  data_through: "2026-05-15",
  expected_cadence_hours: 24,
  age_hours: 192,
  status: "stale",
};

const MISSING_SOURCE: SourceFreshness = {
  source: "ofac",
  last_success_at: null,
  data_through: null,
  expected_cadence_hours: 168,
  age_hours: null,
  status: "missing",
};

const FRESH_RESPONSE: FreshnessResponse = {
  sources: [FRESH_SOURCE],
};

const MIXED_RESPONSE: FreshnessResponse = {
  sources: [FRESH_SOURCE, STALE_SOURCE, MISSING_SOURCE],
};

// ── Helpers ───────────────────────────────────────────────────────

function makeMockApi(tokenValue: string | null = null): ReturnType<typeof vi.spyOn>[] {
  const getToken = vi.spyOn(api, "getWriteJobToken").mockReturnValue(tokenValue);
  const setToken = vi.spyOn(api, "setWriteJobToken").mockImplementation(() => undefined);
  return [getToken, setToken];
}

// ── Row rendering at each status ──────────────────────────────────

describe("BatchFreshnessPanel — row rendering", () => {
  beforeEach(() => {
    makeMockApi();
  });

  it("renders a fresh row with ✅ badge", () => {
    render(
      <BatchFreshnessPanel freshness={FRESH_RESPONSE} freshnessError={null} onRefresh={() => {}} />,
    );
    expect(screen.getByText("fred")).toBeDefined();
    expect(screen.getByLabelText("fresh")).toBeDefined();
  });

  it("renders a stale row with ⚠ badge", () => {
    render(
      <BatchFreshnessPanel
        freshness={{ sources: [STALE_SOURCE] }}
        freshnessError={null}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("fmp")).toBeDefined();
    expect(screen.getByLabelText("stale")).toBeDefined();
  });

  it("renders a missing row with 🔴 badge", () => {
    render(
      <BatchFreshnessPanel
        freshness={{ sources: [MISSING_SOURCE] }}
        freshnessError={null}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("ofac")).toBeDefined();
    expect(screen.getByLabelText("missing")).toBeDefined();
  });

  it("renders loading state when freshness is null", () => {
    render(<BatchFreshnessPanel freshness={null} freshnessError={null} onRefresh={() => {}} />);
    expect(screen.getByText(/loading/i)).toBeDefined();
  });

  it("renders error state when freshnessError is set", () => {
    render(
      <BatchFreshnessPanel
        freshness={null}
        freshnessError="connection refused"
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/connection refused/i)).toBeDefined();
  });

  it("renders empty state when sources array is empty", () => {
    render(
      <BatchFreshnessPanel
        freshness={{ sources: [] }}
        freshnessError={null}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/no sources configured/i)).toBeDefined();
  });

  it("sorts missing before stale before fresh", () => {
    render(
      <BatchFreshnessPanel freshness={MIXED_RESPONSE} freshnessError={null} onRefresh={() => {}} />,
    );
    const rows = screen.getAllByRole("row");
    // rows[0] is header; rows[1..] are data rows sorted missing→stale→fresh
    expect(rows[1]?.textContent).toContain("ofac");
    expect(rows[2]?.textContent).toContain("fmp");
    expect(rows[3]?.textContent).toContain("fred");
  });
});

// ── Run-now button visibility rules ───────────────────────────────

describe("BatchFreshnessPanel — Run-now button visibility", () => {
  it("does NOT show Run-now buttons when no token is saved", () => {
    makeMockApi(null);
    render(
      <BatchFreshnessPanel freshness={MIXED_RESPONSE} freshnessError={null} onRefresh={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: /Run now/i })).toBeNull();
  });

  it("shows Run-now buttons only for stale and missing rows when token is saved", () => {
    makeMockApi("test-token-1234");
    render(
      <BatchFreshnessPanel freshness={MIXED_RESPONSE} freshnessError={null} onRefresh={() => {}} />,
    );
    // stale fmp and missing ofac should have buttons
    expect(screen.getByRole("button", { name: /Run now: fmp/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Run now: ofac/i })).toBeDefined();
    // fresh fred should NOT have a button
    expect(screen.queryByRole("button", { name: /Run now: fred/i })).toBeNull();
  });
});

// ── Click → POST flow ─────────────────────────────────────────────

describe("BatchFreshnessPanel — Run-now click → POST", () => {
  it("calls submitIngest with the source and shows the returned job_id", async () => {
    makeMockApi("test-token-abcd");
    const submitMock = vi
      .spyOn(api, "submitIngest")
      .mockResolvedValue({ job_id: "job-xyz-001", status: "queued", deduped: false });

    const onRefresh = vi.fn();
    render(
      <BatchFreshnessPanel
        freshness={{ sources: [STALE_SOURCE] }}
        freshnessError={null}
        onRefresh={onRefresh}
      />,
    );

    const button = screen.getByRole("button", { name: /Run now: fmp/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith("fmp");
    });

    await waitFor(() => {
      expect(screen.getByText(/job-xyz-001/)).toBeDefined();
    });

    expect(onRefresh).toHaveBeenCalled();
  });

  it("shows an error message when submitIngest rejects", async () => {
    makeMockApi("test-token-abcd");
    vi.spyOn(api, "submitIngest").mockRejectedValue(new Error("unauthorized"));

    render(
      <BatchFreshnessPanel
        freshness={{ sources: [MISSING_SOURCE] }}
        freshnessError={null}
        onRefresh={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Run now: ofac/i }));

    await waitFor(() => {
      expect(screen.getByText(/Error: unauthorized/i)).toBeDefined();
    });
  });

  it("does not clobber an in-flight submission (button disabled while in-flight)", async () => {
    makeMockApi("test-token-abcd");
    // Never resolves during the test so the in-flight state persists.
    vi.spyOn(api, "submitIngest").mockReturnValue(new Promise(() => {}));

    render(
      <BatchFreshnessPanel
        freshness={{ sources: [STALE_SOURCE] }}
        freshnessError={null}
        onRefresh={() => {}}
      />,
    );

    const button = screen.getByRole("button", { name: /Run now: fmp/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(/Submitting/i)).toBeDefined();
    });

    // The button retains its aria-label but becomes disabled while in-flight.
    const btn = screen.getByRole("button", { name: /Run now: fmp/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
