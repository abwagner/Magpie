// ErrorBoundary — renders children normally, and on a child throw shows
// the fallback instead of letting the error unmount the whole tree.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.js";

afterEach(cleanup);

function Boom(): never {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div>healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy")).toBeTruthy();
  });

  it("renders the fallback (with the error message) when a child throws", () => {
    // React logs the caught error; silence it for a clean test run.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();
    spy.mockRestore();
  });
});
