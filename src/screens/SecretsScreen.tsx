import { useEffect, useState } from "react";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import { getSecretsStatus } from "../lib/api.js";
import type { SecretCategory, SecretStatus, SecretsStatusResponse } from "../types/secrets.js";

// Settings · System · Secrets (QF-56)
//
// Read-only audit of which env-var secrets the server has loaded. Never
// displays the secret VALUES — only set/not-set, expiry where known,
// the .env key name, and an instructions / re-auth hint per slot.
// Spec: docs/archive/SETTINGS-STUBS.md → "System → Secrets".
//
// Server-side single source of truth lives in
// `server/auth/secrets-status.ts`; new secrets get one row there, not
// here. This file is presentation only.

const CATEGORY_LABEL: Record<SecretCategory, string> = {
  "broker-schwab": "Broker · Schwab",
  "broker-ibkr": "Broker · IBKR",
  "market-data": "Market data",
  "external-signals": "External data signals",
  storage: "Storage",
};

// Category render order, top-down.
const CATEGORY_ORDER: SecretCategory[] = [
  "broker-schwab",
  "broker-ibkr",
  "market-data",
  "external-signals",
  "storage",
];

export function SecretsScreen() {
  const [data, setData] = useState<SecretsStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getSecretsStatus()
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · System · Secrets"
        title="Secrets"
        body="Read-only audit: which secrets the server has loaded from .env, when applicable tokens expire, and how to obtain or rotate each one. Secret values are never displayed."
      />
      {loading && !data ? (
        <div className="dim" style={{ fontSize: 12 }}>
          Loading…
        </div>
      ) : error ? (
        <div className="neg" style={{ fontSize: 12 }}>
          Failed to load: {error}
        </div>
      ) : data ? (
        <SecretsTable data={data} />
      ) : null}
    </div>
  );
}

function SecretsTable({ data }: { data: SecretsStatusResponse }) {
  // Group secrets by category, preserving the server's order within each.
  const groups = new Map<SecretCategory, SecretStatus[]>();
  for (const s of data.secrets) {
    const list = groups.get(s.category) ?? [];
    list.push(s);
    groups.set(s.category, list);
  }

  const generated = new Date(data.generated_at);

  return (
    <>
      {CATEGORY_ORDER.filter((c) => groups.has(c)).map((category) => (
        <CategoryPanel key={category} category={category} secrets={groups.get(category) ?? []} />
      ))}
      <div className="dim2" style={{ fontSize: 10, marginTop: 4 }}>
        Snapshot generated {generated.toLocaleString()} · source of truth:{" "}
        <span className="mono">server/auth/secrets-status.ts</span>
      </div>
    </>
  );
}

function CategoryPanel({
  category,
  secrets,
}: {
  category: SecretCategory;
  secrets: SecretStatus[];
}) {
  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
        {CATEGORY_LABEL[category]}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "var(--text-4)", fontSize: 11 }}>
            <th style={{ textAlign: "left", padding: "4px 8px 4px 0", fontWeight: 500 }}>Secret</th>
            <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Status</th>
            <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Env var</th>
            <th style={{ textAlign: "left", padding: "4px 0 4px 8px", fontWeight: 500 }}>
              How to obtain / rotate
            </th>
          </tr>
        </thead>
        <tbody>
          {secrets.map((s) => (
            <SecretRow key={s.env_var} secret={s} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SecretRow({ secret }: { secret: SecretStatus }) {
  const expiryLabel = secret.expires_at ? formatExpiry(secret.expires_at) : null;
  const statusTone = secret.set ? "pos" : "warn";
  const statusLabel = secret.set ? "SET" : "NOT SET";

  return (
    <tr style={{ borderTop: "1px solid var(--border-1)", verticalAlign: "top" }}>
      <td style={{ padding: "8px 8px 8px 0", color: "var(--text-2)" }}>{secret.name}</td>
      <td style={{ padding: "8px 8px" }}>
        <span className={`badge ${statusTone}`}>{statusLabel}</span>
        {expiryLabel && (
          <div className={expiryLabel.tone} style={{ fontSize: 10, marginTop: 4 }}>
            {expiryLabel.text}
          </div>
        )}
      </td>
      <td className="mono dim" style={{ padding: "8px 8px", fontSize: 11 }}>
        {secret.env_var}
      </td>
      <td style={{ padding: "8px 0 8px 8px" }}>
        {secret.instructions && (
          <div className="dim" style={{ fontSize: 11, lineHeight: 1.5 }}>
            {secret.instructions}
          </div>
        )}
        {secret.reauth_command && (
          <div className="mono dim2" style={{ fontSize: 10, marginTop: 4 }}>
            Rotate: <span style={{ color: "var(--text-2)" }}>{secret.reauth_command}</span>
          </div>
        )}
      </td>
    </tr>
  );
}

// 7d window for "expiring soon" — Schwab's refresh token lifetime is 7 days,
// so warn whenever we drop below half the cycle. Tone-coded so an operator
// glancing at the screen sees urgency without reading the date.
function formatExpiry(iso: string): { text: string; tone: string } {
  const expMs = Date.parse(iso);
  if (Number.isNaN(expMs)) return { text: `expires ${iso}`, tone: "dim2" };
  const now = Date.now();
  const diffMs = expMs - now;
  if (diffMs <= 0) return { text: "EXPIRED", tone: "neg" };
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const dateStr = new Date(expMs).toLocaleString();
  const text =
    days > 0 ? `expires in ${days}d ${hours}h · ${dateStr}` : `expires in ${hours}h · ${dateStr}`;
  const tone = days >= 4 ? "dim2" : days >= 1 ? "warn" : "neg";
  return { text, tone };
}
