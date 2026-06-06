// Smoke tests for the research-workspace panel scaffolds. Each panel
// renders against the WS hook with no live data and shows the
// connection badge + the empty-state copy.
//
// The four panels share the ConnectionBadge + PhaseFooter helpers
// exported from JobQueuePanel, so this file also covers their
// rendering directly.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConnectionBadge, JobQueuePanel, PhaseFooter } from "./JobQueuePanel.js";
import { GridHeatmapPanel } from "./GridHeatmapPanel.js";
import { WalkForwardPanel } from "./WalkForwardPanel.js";
import { ComparisonPanel } from "./ComparisonPanel.js";

afterEach(cleanup);

describe("ConnectionBadge", () => {
  it("renders 'disconnected' when neither connected nor reconnecting", () => {
    render(
      <ConnectionBadge
        connected={false}
        reconnecting={false}
        lastError={null}
        correlationId={null}
      />,
    );
    expect(screen.getByText(/disconnected/i)).toBeDefined();
  });

  it("renders 'live' when connected", () => {
    render(
      <ConnectionBadge connected reconnecting={false} lastError={null} correlationId={null} />,
    );
    expect(screen.getByText(/live/i)).toBeDefined();
  });

  it("renders 'reconnecting' when reconnecting", () => {
    render(
      <ConnectionBadge connected={false} reconnecting lastError={null} correlationId={null} />,
    );
    expect(screen.getByText(/reconnecting/i)).toBeDefined();
  });

  it("shows truncated correlation_id chip when present", () => {
    render(
      <ConnectionBadge
        connected
        reconnecting={false}
        lastError={null}
        correlationId="abc12345-deadbeef"
      />,
    );
    expect(screen.getByText("cid:abc12345")).toBeDefined();
  });

  it("shows an 'err' marker when lastError is set", () => {
    render(
      <ConnectionBadge
        connected={false}
        reconnecting={false}
        lastError="WebSocket error"
        correlationId={null}
      />,
    );
    expect(screen.getByText("err")).toBeDefined();
  });
});

describe("PhaseFooter", () => {
  it("renders the phase + note", () => {
    render(<PhaseFooter phase={3} note="lands in Phase 3" />);
    expect(screen.getByText(/Phase 3 scaffold/)).toBeDefined();
    expect(screen.getByText(/lands in Phase 3/)).toBeDefined();
  });
});

// ── Panel-level smoke tests ────────────────────────────────────────
//
// Each panel mounts the useResearchEvents hook, which tries to open
// a real WebSocket. In JSDOM the constructor is a no-op stub that
// never fires `open`, so the panel renders the disconnected empty
// state — exactly what we want to assert.

describe("JobQueuePanel", () => {
  it("renders empty-state when there are no jobs", () => {
    render(<JobQueuePanel />);
    expect(screen.getByText(/no jobs in this session/i)).toBeDefined();
  });

  it("shows the Phase 3 footer", () => {
    render(<JobQueuePanel />);
    expect(screen.getByText(/Phase 3 scaffold/)).toBeDefined();
  });
});

describe("GridHeatmapPanel", () => {
  it("renders empty-state when there are no completed grid runs", () => {
    render(<GridHeatmapPanel />);
    expect(screen.getByText(/no completed grid runs/i)).toBeDefined();
  });
});

describe("WalkForwardPanel", () => {
  it("renders empty-state when no folds have completed", () => {
    render(<WalkForwardPanel />);
    expect(screen.getByText(/no walk-forward folds completed/i)).toBeDefined();
  });
});

describe("ComparisonPanel", () => {
  it("renders empty-state when there are no completed runs", () => {
    render(<ComparisonPanel />);
    expect(screen.getByText(/no completed runs/i)).toBeDefined();
  });
});
