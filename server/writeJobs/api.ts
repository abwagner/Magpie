// ── Write-Job HTTP API (M10-1) ────────────────────────────────────
//
// Three routes:
//   POST /api/write-jobs        — submit (bearer-auth required)
//   GET  /api/write-jobs/:id    — poll status (auth required)
//   GET  /api/write-jobs        — list recent (auth required)
//
// All POSTs auth + scope-check. GETs only auth (any valid token can
// read; scoping reads behind tokens would block the operator GUI from
// listing jobs across kinds).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../logger.js";
import type { WriteJobAuthenticator } from "./auth.js";
import { ValidationError, type WriteJobRunner } from "./runner.js";
import type { WriteJobStatus } from "./types.js";

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function authError(res: ServerResponse, reason: string | undefined): void {
  const status = reason === "kind_not_in_scope" ? 403 : 401;
  json(res, { error: "unauthorized", reason: reason ?? "missing_bearer_token" }, status);
}

export interface WriteJobsApi {
  handleSubmit(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleStatus(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void>;
  handleList(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void>;
}

export function createWriteJobsApi(
  runner: WriteJobRunner,
  auth: WriteJobAuthenticator,
  logger: Logger,
): WriteJobsApi {
  return {
    async handleSubmit(req, res): Promise<void> {
      try {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = raw.length === 0 ? {} : JSON.parse(raw);
        } catch {
          return json(res, { error: "request body is not valid JSON" }, 400);
        }
        if (typeof parsed !== "object" || parsed === null) {
          return json(res, { error: "body must be a JSON object" }, 400);
        }
        const { kind, params } = parsed as { kind?: unknown; params?: unknown };
        if (typeof kind !== "string" || kind.length === 0) {
          return json(res, { error: "body.kind is required" }, 400);
        }
        const decision = await auth.authorizeForKind(req, kind);
        if (!decision.ok || !decision.entry) {
          return authError(res, decision.reason);
        }
        try {
          const result = await runner.submit({ kind, params: params ?? {} }, decision.entry.actor);
          json(
            res,
            {
              job_id: result.job_id,
              status: result.status,
              deduped: result.deduped,
            },
            result.deduped ? 200 : 202,
          );
        } catch (err) {
          if (err instanceof ValidationError) {
            return json(res, { error: "validation_failed", details: err.errors }, 400);
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith("no handler registered")) {
            return json(res, { error: "unknown_kind", detail: msg }, 400);
          }
          throw err;
        }
      } catch (err) {
        logger.error("write-jobs submit failed", { error: String(err) });
        json(res, { error: "internal error", detail: String(err) }, 500);
      }
    },

    async handleStatus(req, res, jobId): Promise<void> {
      try {
        const decision = await auth.authenticate(req);
        if (!decision.ok) return authError(res, decision.reason);
        const job = await runner.status(jobId);
        if (job === null) return json(res, { error: "job not found", job_id: jobId }, 404);
        json(res, job);
      } catch (err) {
        logger.error("write-jobs status failed", { error: String(err), job_id: jobId });
        json(res, { error: "internal error", detail: String(err) }, 500);
      }
    },

    async handleList(req, res, query): Promise<void> {
      try {
        const decision = await auth.authenticate(req);
        if (!decision.ok) return authError(res, decision.reason);
        const kind = query.get("kind") ?? undefined;
        const status = query.get("status");
        const limit = query.get("limit");
        const jobs = await runner.list({
          kind,
          status: status === null ? undefined : (status as WriteJobStatus),
          limit: limit === null ? undefined : Number.parseInt(limit, 10),
        });
        json(res, { jobs });
      } catch (err) {
        logger.error("write-jobs list failed", { error: String(err) });
        json(res, { error: "internal error", detail: String(err) }, 500);
      }
    },
  };
}
