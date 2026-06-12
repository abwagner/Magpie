import { useEffect, useState } from "react";
import { Icon } from "../components/ui/Icon.js";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import type { Account } from "../lib/api.js";
import {
  listAccounts,
  createAccount,
  disableAccount,
  relinkAccount,
} from "../lib/api.js";

// Settings · System · Accounts
//
// List trading accounts with label/broker/enabled status, last-sync time,
// and sync_status badges (healthy/degraded/disconnected). Actions: disable,
// re-link (opens OAuth redirect URL), and add new account via form.
// Spec: docs/archive/SETTINGS-STUBS.md → "System → Accounts"

const SYNC_STATUS_TONES: Record<string, string> = {
  healthy: "pos",
  degraded: "warn",
  disconnected: "neg",
};

const SLUG_RE = /^[a-z0-9_-]+$/;

interface AddFormState {
  id: string;
  label: string;
  error: string | null;
  loading: boolean;
  restartRequired: boolean;
}

export function AccountsScreen() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AddFormState>({
    id: "",
    label: "",
    error: null,
    loading: false,
    restartRequired: false,
  });

  // Load accounts on mount
  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    try {
      setLoading(true);
      setError(null);
      const res = await listAccounts();
      setAccounts(res.accounts);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function handleDisable(accountId: string) {
    try {
      await disableAccount(accountId);
      await loadAccounts();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  async function handleRelink(accountId: string) {
    try {
      const res = await relinkAccount(accountId);
      // Open the redirect URL in a new tab
      window.open(res.redirect_url, "_blank");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  function validateId(id: string): string | null {
    if (!id || id.length === 0) {
      return "Account ID is required";
    }
    if (!SLUG_RE.test(id)) {
      return 'Account ID must contain only lowercase letters, numbers, hyphens, and underscores';
    }
    return null;
  }

  async function handleAddAccount(e: React.FormEvent) {
    e.preventDefault();

    // Client-side validation
    const idError = validateId(form.id);
    if (idError) {
      setForm((prev) => ({ ...prev, error: idError }));
      return;
    }

    // Clear previous error/success state
    setForm((prev) => ({ ...prev, error: null, loading: true, restartRequired: false }));

    try {
      const res = await createAccount({
        id: form.id,
        label: form.label || form.id,
      });

      // Success: reset form and reload list
      setForm({
        id: "",
        label: "",
        error: null,
        loading: false,
        restartRequired: res.restart_required ?? false,
      });

      await loadAccounts();
    } catch (e) {
      const errMsg = String((e as Error).message ?? e);
      setForm((prev) => ({ ...prev, error: errMsg, loading: false }));
    }
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · System · Accounts"
        title="Accounts"
        body="Trading accounts configured on this server. Shows label, broker, enabled status, last sync time, and reconciliation status. Actions: disable (stops new submissions) and re-link (OAuth refresh)."
      />

      {error && (
        <div
          style={{
            background: "rgba(255, 100, 100, 0.1)",
            border: "1px solid rgba(255, 100, 100, 0.3)",
            borderRadius: "var(--r-2)",
            padding: 12,
            color: "var(--text-neg)",
            fontSize: 12,
          }}
        >
          <strong>Error:</strong> {error}
        </div>
      )}

      <AddAccountForm
        form={form}
        onInputChange={(field, value) => setForm((prev) => ({ ...prev, [field]: value }))}
        onSubmit={handleAddAccount}
      />

      {form.restartRequired && (
        <div
          style={{
            background: "rgba(255, 192, 0, 0.1)",
            border: "1px solid rgba(255, 192, 0, 0.3)",
            borderRadius: "var(--r-2)",
            padding: 12,
            color: "var(--warn)",
            fontSize: 12,
          }}
        >
          <strong>Restart required:</strong> Account configuration changes require a server restart
          to take effect.
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--text-3)", fontSize: 12 }}>Loading accounts...</div>
      ) : accounts.length === 0 ? (
        <div style={{ color: "var(--text-3)", fontSize: 12 }}>No accounts configured.</div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 10,
          }}
        >
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onDisable={handleDisable}
              onRelink={handleRelink}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface AddAccountFormProps {
  form: AddFormState;
  onInputChange: (field: keyof Omit<AddFormState, "error" | "loading" | "restartRequired">, value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

function AddAccountForm({ form, onInputChange, onSubmit }: AddAccountFormProps) {
  return (
    <form onSubmit={onSubmit}>
      <div
        style={{
          background: "var(--bg-pane)",
          border: "1px solid var(--border-1)",
          borderRadius: "var(--r-2)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-1)" }}>
          Add Account
        </div>

        {form.error && (
          <div
            style={{
              background: "rgba(255, 100, 100, 0.1)",
              border: "1px solid rgba(255, 100, 100, 0.3)",
              borderRadius: "var(--r-1)",
              padding: 8,
              color: "var(--text-neg)",
              fontSize: 11,
            }}
          >
            {form.error}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 11, fontWeight: 500, color: "var(--text-2)" }}>
            Account ID
            <span style={{ color: "var(--text-neg)", marginLeft: 2 }}>*</span>
          </label>
          <input
            type="text"
            placeholder="e.g. prod-main, test-paper"
            value={form.id}
            onChange={(e) => onInputChange("id", e.currentTarget.value)}
            disabled={form.loading}
            style={{
              padding: "6px 8px",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              border: `1px solid ${form.error ? "var(--border-neg)" : "var(--border-1)"}`,
              borderRadius: "var(--r-1)",
              background: "var(--bg-base)",
              color: "var(--text-1)",
              cursor: form.loading ? "not-allowed" : "text",
            }}
          />
          <span style={{ fontSize: 10, color: "var(--text-3)" }}>
            Lowercase letters, numbers, hyphens, and underscores only
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 11, fontWeight: 500, color: "var(--text-2)" }}>
            Label (optional)
          </label>
          <input
            type="text"
            placeholder="e.g. Production Main Account"
            value={form.label}
            onChange={(e) => onInputChange("label", e.currentTarget.value)}
            disabled={form.loading}
            style={{
              padding: "6px 8px",
              fontSize: 12,
              border: "1px solid var(--border-1)",
              borderRadius: "var(--r-1)",
              background: "var(--bg-base)",
              color: "var(--text-1)",
              cursor: form.loading ? "not-allowed" : "text",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            type="submit"
            disabled={form.loading || !form.id}
            style={{
              flex: 1,
              padding: "8px 12px",
              fontSize: 12,
              fontWeight: 600,
              color: form.loading || !form.id ? "var(--text-4)" : "var(--text-pos)",
              background: form.loading || !form.id ? "var(--bg-elev)" : "transparent",
              border: `1px solid ${form.loading || !form.id ? "var(--border-2)" : "var(--border-pos)"}`,
              borderRadius: "var(--r-1)",
              cursor: form.loading || !form.id ? "not-allowed" : "pointer",
              opacity: form.loading || !form.id ? 0.5 : 1,
            }}
            title={!form.id ? "Enter an account ID" : form.loading ? "Creating account..." : "Create account"}
          >
            {form.loading ? "Creating..." : "Create Account"}
          </button>
        </div>

        <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 4 }}>
          Server restart required after account creation. Broker and sync status will be initialized after restart.
        </div>
      </div>
    </form>
  );
}

function AccountCard({
  account,
  onDisable,
  onRelink,
}: {
  account: Account;
  onDisable: (id: string) => void;
  onRelink: (id: string) => void;
}) {
  const statusTone = SYNC_STATUS_TONES[account.sync_status] ?? "neutral";
  const lastSyncHint = account.last_sync_at ? formatLastSync(account.last_sync_at) : "never";

  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Header: label + enabled badge */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 2,
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--text-1)", fontSize: 13 }}>
          {account.label}
        </span>
        {!account.enabled && <span className="badge neg">DISABLED</span>}
      </div>

      {/* Broker & ID row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 8,
          fontSize: 11,
          color: "var(--text-3)",
        }}
      >
        <span className="dim">Broker:</span>
        <span className="mono">{account.broker.toUpperCase()}</span>
        <span className="dim">ID:</span>
        <span className="mono">{account.id}</span>
      </div>

      {/* Sync status + last sync */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
        }}
      >
        <span className={`badge ${statusTone}`}>{account.sync_status.toUpperCase()}</span>
        <span className="dim" style={{ fontSize: 10 }}>
          {lastSyncHint}
        </span>
      </div>

      {/* Action buttons */}
      <div
        style={{
          display: "flex",
          gap: 6,
          marginTop: 4,
        }}
      >
        <button
          type="button"
          onClick={() => onRelink(account.id)}
          style={{
            flex: 1,
            padding: "4px 8px",
            fontSize: 10,
            fontWeight: 600,
            color: "var(--text-1)",
            background: "var(--bg-elev)",
            border: "1px solid var(--border-1)",
            borderRadius: "var(--r-1)",
            cursor: "pointer",
          }}
          title="Open OAuth flow in a new tab"
        >
          <Icon name="cog" size={9} style={{ display: "inline", marginRight: 3 }} />
          Re-link
        </button>
        <button
          type="button"
          onClick={() => onDisable(account.id)}
          disabled={!account.enabled}
          style={{
            flex: 1,
            padding: "4px 8px",
            fontSize: 10,
            fontWeight: 600,
            color: account.enabled ? "var(--text-neg)" : "var(--text-4)",
            background: account.enabled ? "transparent" : "transparent",
            border: `1px solid ${account.enabled ? "var(--border-neg)" : "var(--border-2)"}`,
            borderRadius: "var(--r-1)",
            cursor: account.enabled ? "pointer" : "not-allowed",
            opacity: account.enabled ? 1 : 0.5,
          }}
          title="Set enabled=false; stops new order submissions"
        >
          <Icon name="minus" size={9} style={{ display: "inline", marginRight: 3 }} />
          Disable
        </button>
      </div>
    </div>
  );
}

function formatLastSync(isoString: string): string {
  try {
    const now = new Date();
    const then = new Date(isoString);
    const diffMs = now.getTime() - then.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return "synced < 1m ago";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `synced ${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `synced ${diffHr}h ago`;
    const diffDy = Math.floor(diffHr / 24);
    return `synced ${diffDy}d ago`;
  } catch {
    return "sync time unavailable";
  }
}
