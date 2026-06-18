import React from "react";

// ── ErrorBoundary ───────────────────────────────────────────────────
// Top-level boundary so a throw in any component renders a visible
// message instead of unmounting the whole tree to a blank page. React
// has no hook equivalent, so this stays a class component.

export interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // No logger on the client; surface to the console so the failure
    // is diagnosable rather than swallowed.
    console.error("Uncaught render error:", error, info.componentStack);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="error-boundary">
        <h1>Something went wrong</h1>
        <p>The interface hit an unexpected error and stopped rendering.</p>
        <pre className="error-boundary__detail">{error.message}</pre>
        <button type="button" className="btn" onClick={this.handleReload}>
          Reload
        </button>
      </div>
    );
  }
}
