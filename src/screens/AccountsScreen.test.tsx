import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountsScreen } from "./AccountsScreen.js";
import * as api from "../lib/api.js";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

// Mock the API
vi.mock("../lib/api.js");

function mockAccounts(overrides: Partial<api.Account>[] = []) {
  const defaults: api.Account[] = [
    {
      id: "prod-main",
      label: "Production Main",
      enabled: true,
      broker: "schwab",
      last_sync_at: new Date(Date.now() - 2 * 60000).toISOString(), // 2 min ago
      sync_status: "healthy",
    },
    {
      id: "test-paper",
      label: "Test Paper",
      enabled: false,
      broker: "schwab",
      last_sync_at: new Date(Date.now() - 8 * 3600000).toISOString(), // 8 hours ago
      sync_status: "degraded",
    },
  ];
  return defaults.map((base, i) => ({ ...base, ...overrides[i] }));
}

describe("AccountsScreen", () => {
  it("renders the screen header", async () => {
    vi.mocked(api.listAccounts).mockResolvedValue({
      accounts: mockAccounts(),
    });
    render(<AccountsScreen />);
    await waitFor(() => {
      expect(screen.getByText(/Settings · System · Accounts/i)).toBeDefined();
    });
  });

  it("loads and displays accounts on mount", async () => {
    const accounts = mockAccounts();
    vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
    render(<AccountsScreen />);

    await waitFor(() => {
      expect(screen.getByText("Production Main")).toBeDefined();
      expect(screen.getByText("Test Paper")).toBeDefined();
    });
  });

  it("displays account metadata: label, broker, id, enabled status", async () => {
    const accounts = mockAccounts();
    vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
    render(<AccountsScreen />);

    await waitFor(() => {
      // Both accounts have broker SCHWAB (so multiple matches)
      expect(screen.getAllByText("SCHWAB").length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("prod-main")).toBeDefined();
      // Disabled badge on second account
      expect(screen.getByText("DISABLED")).toBeDefined();
    });
  });

  it("displays sync status badge with correct tone", async () => {
    const accounts = mockAccounts();
    vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
    render(<AccountsScreen />);

    await waitFor(() => {
      const badges = screen.getAllByText(/HEALTHY|DEGRADED/i);
      expect(badges.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("HEALTHY")).toBeDefined();
      expect(screen.getByText("DEGRADED")).toBeDefined();
    });
  });

  it("formats last_sync_at relative to now", async () => {
    const accounts = mockAccounts();
    vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
    render(<AccountsScreen />);

    await waitFor(() => {
      // ~2 minutes ago
      expect(screen.getByText(/synced \d+m ago/i)).toBeDefined();
      // ~8 hours ago
      expect(screen.getByText(/synced \d+h ago/i)).toBeDefined();
    });
  });

  it("calls disableAccount and reloads on disable button click", async () => {
    const accounts = mockAccounts();
    const firstAccount = accounts[0];
    if (!firstAccount) throw new Error("test setup failure");
    const disabledAccounts = [
      { ...firstAccount, enabled: false },
      ...accounts.slice(1),
    ];
    vi.mocked(api.listAccounts)
      .mockResolvedValueOnce({ accounts })
      .mockResolvedValueOnce({ accounts: disabledAccounts });
    vi.mocked(api.disableAccount).mockResolvedValue({
      account: { ...firstAccount, enabled: false },
    });

    render(<AccountsScreen />);
    await waitFor(() => {
      expect(screen.getByText("Production Main")).toBeDefined();
    });

    // Get first disable button (only enabled account's is clickable)
    const disableButtons = screen.getAllByText("Disable");
    fireEvent.click(disableButtons[0]!);

    await waitFor(() => {
      expect(api.disableAccount).toHaveBeenCalledWith("prod-main");
    });
    // Verify reload was called
    expect(api.listAccounts).toHaveBeenCalledTimes(2); // initial + reload
  });

  it("calls relinkAccount and opens a new tab on relink", async () => {
    const accounts = mockAccounts();
    vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
    vi.mocked(api.relinkAccount).mockResolvedValue({
      redirect_url: "https://auth.example.com/oauth?...=prod-main",
      account_id: "prod-main",
    });

    const windowOpenSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<AccountsScreen />);
    await waitFor(() => {
      expect(screen.getByText("Production Main")).toBeDefined();
    });

    const relinkButtons = screen.getAllByText("Re-link");
    fireEvent.click(relinkButtons[0]!);

    await waitFor(() => {
      expect(api.relinkAccount).toHaveBeenCalledWith("prod-main");
      expect(windowOpenSpy).toHaveBeenCalledWith(
        "https://auth.example.com/oauth?...=prod-main",
        "_blank",
      );
    });
  });

  it("displays error message on API failure", async () => {
    vi.mocked(api.listAccounts).mockRejectedValue(new Error("Network error"));
    render(<AccountsScreen />);

    await waitFor(() => {
      expect(screen.getByText(/Error:/i)).toBeDefined();
      expect(screen.getByText(/Network error/)).toBeDefined();
    });
  });

  it("shows loading state initially", () => {
    vi.mocked(api.listAccounts).mockImplementation(
      () => new Promise(() => {
        /* never resolves */
      }),
    );
    render(<AccountsScreen />);
    expect(screen.getByText(/Loading accounts/i)).toBeDefined();
  });

  it("shows empty state when no accounts exist", async () => {
    vi.mocked(api.listAccounts).mockResolvedValue({ accounts: [] });
    render(<AccountsScreen />);

    await waitFor(() => {
      expect(screen.getByText(/No accounts configured/i)).toBeDefined();
    });
  });

  it("disables disable button when account is already disabled", async () => {
    const accounts = mockAccounts();
    vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
    render(<AccountsScreen />);

    await waitFor(() => {
      const disableButtons = screen.getAllByText("Disable");
      // Second account is disabled; its disable button should be disabled
      expect(disableButtons[1]?.hasAttribute("disabled")).toBe(true);
    });
  });

  describe("sync status badge derivation", () => {
    it("renders healthy when status is healthy", async () => {
      const allAccounts = mockAccounts();
      const accounts = [allAccounts[0]!]; // healthy
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText("HEALTHY")).toBeDefined();
      });
    });

    it("renders degraded when status is degraded", async () => {
      const allAccounts = mockAccounts();
      const accounts = [allAccounts[1]!]; // degraded
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText("DEGRADED")).toBeDefined();
      });
    });

    it("renders disconnected when status is disconnected", async () => {
      const accounts: api.Account[] = [
        {
          id: "disconnected",
          label: "Broken",
          enabled: true,
          broker: "schwab",
          last_sync_at: null,
          sync_status: "disconnected",
        },
      ];
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText("DISCONNECTED")).toBeDefined();
      });
    });
  });

  describe("formatLastSync helper", () => {
    it("formats times < 1 minute ago", async () => {
      const allAccounts = mockAccounts();
      const base = allAccounts[0];
      if (!base) throw new Error("test setup failure");
      const accounts: api.Account[] = [
        {
          ...base,
          last_sync_at: new Date(Date.now() - 30000).toISOString(),
        },
      ];
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText(/synced < 1m ago/i)).toBeDefined();
      });
    });

    it("formats times in minutes", async () => {
      const allAccounts = mockAccounts();
      const base = allAccounts[0];
      if (!base) throw new Error("test setup failure");
      const accounts: api.Account[] = [
        {
          ...base,
          last_sync_at: new Date(Date.now() - 25 * 60000).toISOString(),
        },
      ];
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText(/synced 25m ago/i)).toBeDefined();
      });
    });

    it("formats times in hours", async () => {
      const allAccounts = mockAccounts();
      const base = allAccounts[0];
      if (!base) throw new Error("test setup failure");
      const accounts: api.Account[] = [
        {
          ...base,
          last_sync_at: new Date(Date.now() - 3 * 3600000).toISOString(),
        },
      ];
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText(/synced 3h ago/i)).toBeDefined();
      });
    });

    it("formats times in days", async () => {
      const allAccounts = mockAccounts();
      const base = allAccounts[0];
      if (!base) throw new Error("test setup failure");
      const accounts: api.Account[] = [
        {
          ...base,
          last_sync_at: new Date(Date.now() - 5 * 86400000).toISOString(),
        },
      ];
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText(/synced 5d ago/i)).toBeDefined();
      });
    });

    it("shows 'never' when last_sync_at is null", async () => {
      const allAccounts = mockAccounts();
      const base = allAccounts[0];
      if (!base) throw new Error("test setup failure");
      const accounts: api.Account[] = [
        {
          ...base,
          last_sync_at: null,
        },
      ];
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText("never")).toBeDefined();
      });
    });
  });

  describe("AddAccountForm", () => {
    it("renders the add account form", async () => {
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts: mockAccounts() });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText("Add Account")).toBeDefined();
        expect(screen.getByPlaceholderText(/e.g. prod-main/)).toBeDefined();
        expect(screen.getByPlaceholderText(/e.g. Production Main/)).toBeDefined();
      });
    });

    it("submits form with valid id and optional label", async () => {
      vi.mocked(api.listAccounts)
        .mockResolvedValueOnce({ accounts: mockAccounts() })
        .mockResolvedValueOnce({ accounts: mockAccounts() }); // after create
      vi.mocked(api.createAccount).mockResolvedValue({
        account: {
          id: "staging",
          label: "Staging Environment",
          enabled: true,
          broker: "schwab",
          last_sync_at: null,
          sync_status: "disconnected",
        },
        restart_required: true,
      });

      render(<AccountsScreen />);
      await waitFor(() => {
        expect(screen.getByText("Add Account")).toBeDefined();
      });

      const idInput = screen.getByPlaceholderText(/e.g. prod-main/) as HTMLInputElement;
      const labelInput = screen.getByPlaceholderText(/e.g. Production Main/) as HTMLInputElement;
      const submitButton = screen.getByText("Create Account");

      fireEvent.change(idInput, { target: { value: "staging" } });
      fireEvent.change(labelInput, { target: { value: "Staging Environment" } });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(api.createAccount).toHaveBeenCalledWith({
          id: "staging",
          label: "Staging Environment",
        });
      });
    });

    it("shows restart required notice after successful creation", async () => {
      vi.mocked(api.listAccounts)
        .mockResolvedValueOnce({ accounts: mockAccounts() })
        .mockResolvedValueOnce({ accounts: mockAccounts() }); // after create
      vi.mocked(api.createAccount).mockResolvedValue({
        account: {
          id: "new-account",
          label: "new-account",
          enabled: true,
          broker: "schwab",
          last_sync_at: null,
          sync_status: "disconnected",
        },
        restart_required: true,
      });

      render(<AccountsScreen />);
      await waitFor(() => {
        expect(screen.getByText("Add Account")).toBeDefined();
      });

      const idInput = screen.getByPlaceholderText(/e.g. prod-main/) as HTMLInputElement;
      const submitButton = screen.getByText("Create Account");

      fireEvent.change(idInput, { target: { value: "new-account" } });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Restart required:/)).toBeDefined();
      });
    });

    it("displays server error inline when duplicate id", async () => {
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts: mockAccounts() });
      vi.mocked(api.createAccount).mockRejectedValue(
        new Error('account id "prod-main" already exists'),
      );

      render(<AccountsScreen />);
      await waitFor(() => {
        expect(screen.getByText("Add Account")).toBeDefined();
      });

      const idInput = screen.getByPlaceholderText(/e.g. prod-main/) as HTMLInputElement;
      const submitButton = screen.getByText("Create Account");

      fireEvent.change(idInput, { target: { value: "prod-main" } });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/already exists/)).toBeDefined();
      });
    });

    it("validates slug format client-side", async () => {
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts: mockAccounts() });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText("Add Account")).toBeDefined();
      });

      const idInput = screen.getByPlaceholderText(/e.g. prod-main/) as HTMLInputElement;
      const submitButton = screen.getByText("Create Account");

      // Try with invalid characters (uppercase, spaces)
      fireEvent.change(idInput, { target: { value: "Invalid ID" } });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(
          screen.getByText(/lowercase letters, numbers, hyphens, and underscores/),
        ).toBeDefined();
      });

      // createAccount should not have been called
      expect(api.createAccount).not.toHaveBeenCalled();
    });

    it("disables submit button when id is empty", async () => {
      vi.mocked(api.listAccounts).mockResolvedValue({ accounts: mockAccounts() });
      render(<AccountsScreen />);

      await waitFor(() => {
        expect(screen.getByText("Add Account")).toBeDefined();
      });

      const submitButton = screen.getByText("Create Account") as HTMLButtonElement;
      expect(submitButton.disabled).toBe(true);
    });

    it("clears form fields after successful creation", async () => {
      vi.mocked(api.listAccounts)
        .mockResolvedValueOnce({ accounts: mockAccounts() })
        .mockResolvedValueOnce({ accounts: mockAccounts() }); // after create
      vi.mocked(api.createAccount).mockResolvedValue({
        account: {
          id: "new-account",
          label: "new-account",
          enabled: true,
          broker: "schwab",
          last_sync_at: null,
          sync_status: "disconnected",
        },
        restart_required: true,
      });

      render(<AccountsScreen />);
      await waitFor(() => {
        expect(screen.getByText("Add Account")).toBeDefined();
      });

      const idInput = screen.getByPlaceholderText(/e.g. prod-main/) as HTMLInputElement;
      const labelInput = screen.getByPlaceholderText(/e.g. Production Main/) as HTMLInputElement;
      const submitButton = screen.getByText("Create Account");

      fireEvent.change(idInput, { target: { value: "new-account" } });
      fireEvent.change(labelInput, { target: { value: "New Account" } });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(idInput.value).toBe("");
        expect(labelInput.value).toBe("");
      });
    });

    it("reloads accounts list after successful creation", async () => {
      vi.mocked(api.listAccounts)
        .mockResolvedValueOnce({ accounts: mockAccounts() })
        .mockResolvedValueOnce({ accounts: mockAccounts() }); // after create
      vi.mocked(api.createAccount).mockResolvedValue({
        account: {
          id: "new-account",
          label: "new-account",
          enabled: true,
          broker: "schwab",
          last_sync_at: null,
          sync_status: "disconnected",
        },
        restart_required: true,
      });

      render(<AccountsScreen />);
      await waitFor(() => {
        expect(screen.getByText("Add Account")).toBeDefined();
      });

      const idInput = screen.getByPlaceholderText(/e.g. prod-main/) as HTMLInputElement;
      const submitButton = screen.getByText("Create Account");

      fireEvent.change(idInput, { target: { value: "new-account" } });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(api.listAccounts).toHaveBeenCalledTimes(2); // initial + after create
      });
    });
  });
});
