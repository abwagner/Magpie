// ── Accounts API (QF-248) ──────────────────────────────────────────
// CRUD + sync-status endpoints for multi-account management.
// GET /api/accounts → list all accounts with sync status
// POST /api/accounts → append to brokers.json
// POST /api/accounts/:id/disable → set enabled=false
// POST /api/accounts/:id/re-link → passthrough to Schwab auth (QF-161)

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "../logger.js";
import type { BrokersConfig, SchwabAccountConfig } from "../order/brokers-config.js";
import type { OrderSubmissionAdapter, OrderObservationAdapter } from "../../src/types/order.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AccountResponse {
  id: string;
  label: string;
  enabled: boolean;
  broker: string;
  last_sync_at: string | null;
  sync_status: "healthy" | "degraded" | "disconnected";
}

export interface CreateAccountRequest {
  id: string;
  label?: string;
  enabled?: boolean;
}

export interface AccountsApiDeps {
  logger: Logger;
  configDir: string;
  brokersConfig: BrokersConfig;
  brokers: Map<string, OrderSubmissionAdapter>;
  reconcileBrokers: Map<string, OrderObservationAdapter>;
  lastSyncTimes: Map<string, number>;
}

// ── Helpers ────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(res: ServerResponse, data: unknown, status: number = 200): void {
  res.writeHead(status, CORS_HEADERS);
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as unknown);
      } catch {
        resolve({});
      }
    });
  });
}

const SLUG_RE = /^[a-z0-9_-]+$/;

// ── Status derivation ──────────────────────────────────────────────

/**
 * Derive sync status from adapter availability + freshness of last sync.
 * "healthy": adapter available + sync within 5 minutes
 * "degraded": adapter available but sync older
 * "disconnected": adapter not available
 */
function deriveSyncStatus(
  accountId: string,
  lastSyncMs: number | undefined,
  adapterAvailable: boolean,
): "healthy" | "degraded" | "disconnected" {
  if (!adapterAvailable) return "disconnected";
  if (lastSyncMs === undefined) return "degraded";
  const ageMs = Date.now() - lastSyncMs;
  const FIVE_MIN_MS = 5 * 60 * 1000;
  return ageMs < FIVE_MIN_MS ? "healthy" : "degraded";
}

// ── Factory ────────────────────────────────────────────────────────

export function createAccountsApi(deps: AccountsApiDeps) {
  const { logger, configDir, brokersConfig, brokers, lastSyncTimes } = deps;

  /**
   * GET /api/accounts
   * List all accounts with status derived from brokers.json +
   * in-memory adapter states.
   */
  async function handleList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const accounts: AccountResponse[] = [];
      for (const account of brokersConfig.schwab.accounts) {
        const adapter = brokers.get(account.id);
        const isAvailable = adapter ? await adapter.available() : false;
        const lastSyncMs = lastSyncTimes.get(account.id);
        const status = deriveSyncStatus(account.id, lastSyncMs, isAvailable);
        const lastSyncAt = lastSyncMs ? new Date(lastSyncMs).toISOString() : null;
        accounts.push({
          id: account.id,
          label: account.label,
          enabled: account.enabled,
          broker: "schwab",
          last_sync_at: lastSyncAt,
          sync_status: status,
        });
      }
      json(res, { accounts });
    } catch (e) {
      logger.error("accounts list failed", { error: String(e) });
      json(res, { error: String((e as Error).message ?? e) }, 500);
    }
  }

  /**
   * POST /api/accounts
   * Append a new account entry to brokers.json; reject if id exists
   * or doesn't match slug pattern.
   * Body: { id: string, label?: string, enabled?: boolean }
   * Returns the new account or error.
   */
  async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = (await readBody(req)) as unknown;
      const createReq = body as Record<string, unknown>;

      // Validate required field
      if (!createReq.id || typeof createReq.id !== "string") {
        json(res, { error: "id (non-empty string) is required" }, 400);
        return;
      }

      // Validate slug format
      if (!SLUG_RE.test(createReq.id)) {
        json(
          res,
          {
            error: `id must match [a-z0-9_-]+ (got "${createReq.id}")`,
          },
          400,
        );
        return;
      }

      // Check for duplicate
      if (brokersConfig.schwab.accounts.some((a) => a.id === createReq.id)) {
        json(res, { error: `account id "${createReq.id}" already exists` }, 409);
        return;
      }

      // Build new account
      const newAccount: SchwabAccountConfig = {
        id: createReq.id,
        label:
          typeof createReq.label === "string" && createReq.label.length > 0
            ? createReq.label
            : createReq.id,
        enabled: createReq.enabled === true,
      };

      // Load, modify, and write brokers.json
      const brokerPath = resolve(configDir, "brokers.json");
      let fileData: Record<string, unknown> = {};
      if (existsSync(brokerPath)) {
        try {
          fileData = JSON.parse(readFileSync(brokerPath, "utf-8")) as Record<string, unknown>;
        } catch (e) {
          throw new Error(`Failed to parse brokers.json: ${(e as Error).message}`, {
            cause: e,
          });
        }
      }

      // Ensure schwab.accounts exists and is an array
      if (!fileData.schwab) fileData.schwab = {};
      const schwab = fileData.schwab as Record<string, unknown>;
      if (!Array.isArray(schwab.accounts)) {
        schwab.accounts = [];
      }
      const accounts = schwab.accounts as SchwabAccountConfig[];
      accounts.push(newAccount);

      // Write back
      writeFileSync(brokerPath, JSON.stringify(fileData, null, 2) + "\n", "utf-8");

      // Hot-reload: For now, respond "restart required" since reloading
      // brokers.json during runtime isn't trivial (would need re-wiring
      // the NT bridge adapter). A future QF-xxx can implement hot-reload.
      logger.info("Account created; server restart required", { account_id: newAccount.id });

      json(
        res,
        {
          account: {
            id: newAccount.id,
            label: newAccount.label,
            enabled: newAccount.enabled,
            broker: "schwab",
            last_sync_at: null,
            sync_status: "disconnected",
          },
          restart_required: true,
        },
        201,
      );
    } catch (e) {
      logger.error("account create failed", { error: String(e) });
      json(res, { error: String((e as Error).message ?? e) }, 500);
    }
  }

  /**
   * POST /api/accounts/:id/disable
   * Set enabled=false in brokers.json. In-flight orders complete;
   * new submits on that account are rejected with "account disabled".
   * (The rejection is enforced at OrderPlane.submit time, not here.)
   */
  async function handleDisable(accountId: string, _req: IncomingMessage, res: ServerResponse) {
    try {
      // Find the account
      const account = brokersConfig.schwab.accounts.find((a) => a.id === accountId);
      if (!account) {
        json(res, { error: `Account "${accountId}" not found` }, 404);
        return;
      }

      // Load brokers.json
      const brokerPath = resolve(configDir, "brokers.json");
      let fileData: Record<string, unknown> = {};
      if (existsSync(brokerPath)) {
        try {
          fileData = JSON.parse(readFileSync(brokerPath, "utf-8")) as Record<string, unknown>;
        } catch (e) {
          throw new Error(`Failed to parse brokers.json: ${(e as Error).message}`, {
            cause: e,
          });
        }
      }

      // Disable the account
      if (!fileData.schwab) fileData.schwab = {};
      const schwab = fileData.schwab as Record<string, unknown>;
      if (!Array.isArray(schwab.accounts)) {
        json(res, { error: "Invalid brokers.json structure" }, 400);
        return;
      }
      const accounts = schwab.accounts as SchwabAccountConfig[];
      const found = accounts.find((a) => a.id === accountId);
      if (found) {
        found.enabled = false;
      }

      // Write back
      writeFileSync(brokerPath, JSON.stringify(fileData, null, 2) + "\n", "utf-8");

      logger.info("Account disabled; server restart required", { account_id: accountId });

      // Rebuild response from updated config
      const response: AccountResponse = {
        id: account.id,
        label: account.label,
        enabled: false,
        broker: "schwab",
        last_sync_at: lastSyncTimes.get(accountId)
          ? new Date(lastSyncTimes.get(accountId)!).toISOString()
          : null,
        sync_status: "disconnected",
      };

      json(res, { account: response, restart_required: true }, 200);
    } catch (e) {
      logger.error("account disable failed", { error: String(e), account_id: accountId });
      json(res, { error: String((e as Error).message ?? e) }, 500);
    }
  }

  /**
   * POST /api/accounts/:id/re-link
   * Passthrough to the existing Schwab auth flow (QF-161).
   * Returns a redirect URL for the OAuth flow.
   * Body (optional): none for now.
   * Returns: { redirect_url: string } or error.
   *
   * TODO: Implement token-store callback when auth completes.
   * For now, return the redirect URL only.
   */
  async function handleReLink(accountId: string, _req: IncomingMessage, res: ServerResponse) {
    try {
      // Validate account exists
      const account = brokersConfig.schwab.accounts.find((a) => a.id === accountId);
      if (!account) {
        json(res, { error: `Account "${accountId}" not found` }, 404);
        return;
      }

      // TODO: Invoke the existing Schwab auth flow from QF-161.
      // For now, document the deferred work clearly:
      // The auth endpoint would be constructed here, parameterized by account_id.
      // The callback (after user approves) needs to:
      //   1. Extract the authorization code from the OAuth reply.
      //   2. Exchange it for access/refresh tokens.
      //   3. Store them in a per-account token store (e.g., env, file, vault).
      //
      // Placeholder: return a mock redirect URL so the endpoint structure is complete.
      const redirectUrl = `https://api.schwabapi.com/v1/oauth/authorize?client_id=<YOUR_APP_KEY>&redirect_uri=<YOUR_CALLBACK_URI>&response_type=code&scope=PlaceTrades AccountAccess MoveMoney`;

      logger.warn("re-link for account; auth flow partially implemented", {
        account_id: accountId,
        status: "TODO: complete oauth callback + token-store update",
      });

      json(res, { redirect_url: redirectUrl, account_id: accountId }, 200);
    } catch (e) {
      logger.error("account re-link failed", { error: String(e), account_id: accountId });
      json(res, { error: String((e as Error).message ?? e) }, 500);
    }
  }

  return {
    async handleList(req: IncomingMessage, res: ServerResponse): Promise<void> {
      return handleList(req, res);
    },

    async handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
      return handleCreate(req, res);
    },

    async handleDisable(accountId: string, req: IncomingMessage, res: ServerResponse) {
      return handleDisable(accountId, req, res);
    },

    async handleReLink(accountId: string, req: IncomingMessage, res: ServerResponse) {
      return handleReLink(accountId, req, res);
    },
  };
}
