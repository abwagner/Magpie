// ── Write-Job Auth (M10-1) ────────────────────────────────────────
//
// Bearer-token check for the write-dispatch API. Mirrors the
// signal-ingress auth at `server/signals/auth.ts` but enforces
// always-required: write endpoints are never anonymous.

import type { IncomingMessage } from "node:http";
import { hasScope, type WriteJobTokenEntry, type WriteJobTokenStore } from "./tokens.js";

export interface AuthDecision {
  ok: boolean;
  entry?: WriteJobTokenEntry;
  reason?: "missing_bearer_token" | "invalid_or_revoked_token" | "kind_not_in_scope";
}

export interface WriteJobAuthenticator {
  /** Header-only check; the caller verifies kind scope separately
   *  after parsing the request body. */
  authenticate(req: IncomingMessage): Promise<AuthDecision>;
  /** Combined check: header + kind scope. Convenience for the common
   *  POST path where the kind is parsed before any handler runs. */
  authorizeForKind(req: IncomingMessage, kind: string): Promise<AuthDecision>;
}

export function createWriteJobAuthenticator(store: WriteJobTokenStore): WriteJobAuthenticator {
  async function authenticate(req: IncomingMessage): Promise<AuthDecision> {
    const presented = extractBearer(req);
    if (!presented) {
      return { ok: false, reason: "missing_bearer_token" };
    }
    const entry = await store.lookup(presented);
    if (entry === null) {
      return { ok: false, reason: "invalid_or_revoked_token" };
    }
    return { ok: true, entry };
  }
  return {
    authenticate,
    async authorizeForKind(req, kind): Promise<AuthDecision> {
      const decision = await authenticate(req);
      if (!decision.ok || !decision.entry) return decision;
      if (!hasScope(decision.entry, kind)) {
        return { ok: false, reason: "kind_not_in_scope" };
      }
      return decision;
    },
  };
}

export function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (m === null) return null;
  const token = m[1]?.trim();
  return token && token.length > 0 ? token : null;
}
