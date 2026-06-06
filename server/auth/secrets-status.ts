// ── Settings · System · Secrets — server-side status reporter ────────────
//
// Builds the response for `GET /api/secrets/status`. Never returns secret
// VALUES — only "set / not set", token expiry where known, and a string
// instruction or re-auth command per slot.
//
// Single source of truth for what the system considers a secret. The
// migration TDD (docs/archive/SETTINGS-STUBS.md → "System → Secrets")
// originally proposed scattering a `requiresEnv()` array across every
// adapter; centralising here is simpler and reflects how secrets are
// inherently a cross-cutting concern. New secrets get one row added to
// SECRETS below — adapters don't change.

import { getTokenStatus as getSchwabTokenStatus } from "../market-data/adapters/schwab.js";

export type SecretCategory =
  | "broker-schwab"
  | "broker-ibkr"
  | "market-data"
  | "external-signals"
  | "storage";

export interface SecretStatus {
  /** Display name shown in the UI. */
  name: string;
  /** Env var the server reads from `process.env`. */
  env_var: string;
  /** True iff the env var is set to a non-empty string at request time. */
  set: boolean;
  /** Coarse grouping the UI uses for section headers. */
  category: SecretCategory;
  /** Free-form instructions on how to obtain the secret (.env.example, vendor URL, etc.). */
  instructions?: string;
  /** ISO-8601 expiry timestamp where the secret has a known TTL (Schwab refresh token today). */
  expires_at?: string;
  /** Optional CLI command to refresh the secret (e.g. `npm run schwab-auth`). */
  reauth_command?: string;
}

export interface SecretsStatusResponse {
  /** Wall-clock when the snapshot was built. Lets the UI show staleness. */
  generated_at: string;
  secrets: SecretStatus[];
}

interface SecretSpec {
  name: string;
  env_var: string;
  category: SecretCategory;
  instructions?: string;
  reauth_command?: string;
}

// ── Static registry ──────────────────────────────────────────────────────
// Schwab's three env vars are listed here for shape consistency, but
// `getSchwabTokenStatus()` is the more authoritative source for the refresh
// token (it tracks expiry, not just presence). The Schwab refresh-token
// row is enriched below in `getSecretsStatus`.
const SECRETS: SecretSpec[] = [
  // ── Broker · Schwab ────────────────────────────────────────────────
  {
    name: "Schwab app key",
    env_var: "SCHWAB_APP_KEY",
    category: "broker-schwab",
    instructions: "Create at developer.schwab.com; .env.example key SCHWAB_APP_KEY.",
  },
  {
    name: "Schwab app secret",
    env_var: "SCHWAB_APP_SECRET",
    category: "broker-schwab",
    instructions:
      "Pair with the app key from developer.schwab.com; .env.example key SCHWAB_APP_SECRET.",
  },
  {
    name: "Schwab refresh token",
    env_var: "SCHWAB_REFRESH_TOKEN",
    category: "broker-schwab",
    instructions: "Auto-rotates every 7 days. Re-auth required after expiry.",
    reauth_command: "npm run schwab-auth",
  },
  // ── Broker · IBKR ───────────────────────────────────────────────────
  // IBKR doesn't use a token; the connection is local socket to TWS /
  // IB Gateway. These three rows are presence-of-config rather than
  // true secrets, but operators expect them on this screen.
  {
    name: "IBKR host",
    env_var: "IBKR_HOST",
    category: "broker-ibkr",
    instructions: "Host running TWS or IB Gateway. Default 127.0.0.1; .env.example key IBKR_HOST.",
  },
  {
    name: "IBKR port",
    env_var: "IBKR_PORT",
    category: "broker-ibkr",
    instructions: "TWS=7497 paper / 7496 live; IB Gateway=4002 paper / 4001 live.",
  },
  {
    name: "IBKR client id",
    env_var: "IBKR_CLIENT_ID",
    category: "broker-ibkr",
    instructions: "Any unique small int; multiple processes pick different ids.",
  },
  // ── Market data vendors ────────────────────────────────────────────
  {
    name: "MarketData.app token",
    env_var: "MD_TOKEN",
    category: "market-data",
    instructions: "From dashboard.marketdata.app; .env.example key MD_TOKEN.",
  },
  {
    name: "Databento API key",
    env_var: "DATABENTO_API_KEY",
    category: "market-data",
    instructions: "From databento.com console; .env.example key DATABENTO_API_KEY.",
  },
  // ── External data signals ──────────────────────────────────────────
  {
    name: "FMP API key",
    env_var: "FMP_API_KEY",
    category: "external-signals",
    instructions: "Financial Modeling Prep — site.financialmodelingprep.com/developer.",
  },
  {
    name: "EIA API key",
    env_var: "EIA_API_KEY",
    category: "external-signals",
    instructions: "U.S. Energy Information Administration — api.eia.gov register.",
  },
  {
    name: "FRED API key",
    env_var: "FRED_API_KEY",
    category: "external-signals",
    instructions: "St. Louis Fed — fredaccount.stlouisfed.org/apikeys.",
  },
  {
    name: "AISStream API key",
    env_var: "AISSTREAM_API_KEY",
    category: "external-signals",
    instructions: "aisstream.io — ship-tracking AIS feed.",
  },
  {
    name: "CDSE client id",
    env_var: "CDSE_CLIENT_ID",
    category: "external-signals",
    instructions: "Copernicus Data Space — dataspace.copernicus.eu.",
  },
  {
    name: "CDSE client secret",
    env_var: "CDSE_CLIENT_SECRET",
    category: "external-signals",
    instructions: "Pair with CDSE_CLIENT_ID.",
  },
  {
    name: "Global Fishing Watch token",
    env_var: "GFW_API_TOKEN",
    category: "external-signals",
    instructions: "globalfishingwatch.org/our-apis — bearer token.",
  },
  // ── Storage (MinIO via S3-compatible API) ──────────────────────────
  {
    name: "MinIO / S3 access key",
    env_var: "S3_ACCESS_KEY",
    category: "storage",
    instructions: "MinIO console at s3.example.com; .env.example key S3_ACCESS_KEY.",
  },
  {
    name: "MinIO / S3 secret key",
    env_var: "S3_SECRET_KEY",
    category: "storage",
    instructions: "Pair with S3_ACCESS_KEY.",
  },
];

function isSet(envVar: string): boolean {
  const v = process.env[envVar];
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Build the secrets-status snapshot. Reads `process.env` at call time so
 * `.env` changes between requests are reflected without a restart (the
 * server caches modules, not env vars).
 */
export function getSecretsStatus(): SecretsStatusResponse {
  const schwabToken = getSchwabTokenStatus();

  const secrets: SecretStatus[] = SECRETS.map((spec) => {
    const base: SecretStatus = {
      name: spec.name,
      env_var: spec.env_var,
      set: isSet(spec.env_var),
      category: spec.category,
    };
    if (spec.instructions) base.instructions = spec.instructions;
    if (spec.reauth_command) base.reauth_command = spec.reauth_command;

    // Enrich the Schwab refresh-token row with the real expiry the
    // adapter is tracking. The `set` flag stays env-var driven so a
    // missing env var still reads "not set" even if a stale tokenState
    // is still loaded in memory.
    if (spec.env_var === "SCHWAB_REFRESH_TOKEN" && schwabToken.available) {
      const expMs = schwabToken.refresh_token_expires_at;
      if (typeof expMs === "number") {
        base.expires_at = new Date(expMs).toISOString();
      }
    }

    return base;
  });

  return {
    generated_at: new Date().toISOString(),
    secrets,
  };
}
