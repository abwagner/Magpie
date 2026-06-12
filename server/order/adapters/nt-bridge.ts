// ── NT Bridge Broker Adapter ──────────────────────────────────────
// TS-side client for the QF↔NT NATS-RPC bridge. The Python NT service
// (lives in a sibling repo, deliberately out of scope here — see the
// follow-up Plane ticket spawned by QF-233 + QF-235) is the server.
// Wire-format + subject layout: docs/tdd/broker-integration.md §3.
//
// Two halves of the BrokerAdapter contract (QF-234) share this same
// implementation: the active broker (Schwab) uses submit/cancel +
// observation; IBKR uses only the observation half (per QF-235 — that
// ticket constructs an OrderObservationAdapter view from this same
// adapter factory).
//
// QF-233.

import type { NatsConnection } from "nats";
import { StringCodec } from "nats";
import type {
  BrokerAccount,
  BrokerAdapter,
  BrokerExecReport,
  BrokerOrderStatus,
  BrokerPosition,
  BrokerRejection,
  Fill,
  SubmitOrderParams,
} from "../../../src/types/order.js";
import type { Logger } from "../../logger.js";
import { orders } from "../../../src/types/subjects.js";

// ── Config ─────────────────────────────────────────────────────────

export interface NtBridgeConfig {
  // "schwab" | "ibkr" — the suffix on the NATS subjects.
  broker: string;
  // QF-246 — M12-4: per-account NATS-subject namespacing. When set to a
  // non-"default" id the adapter targets the per-account subjects
  // (orders.submit.schwab.<accountId>, ...) that the matching Python
  // bridge process subscribes to, and stamps the id on every fanned-out
  // Fill / rejection for the audit-attribution path. Absent / "default"
  // keeps the bare un-suffixed subjects of the QF-237 single-account
  // deploy. See docs/tdd/broker-integration.md §3.
  accountId?: string;
  // Reply timeout for submitOrder. The Python bridge translates inbound
  // JSON to NT's OrderFactory call + waits for NT's submit ack, so
  // ~5s is comfortable. Configurable for stress tests / slow nets.
  submitTimeoutMs?: number;
  // Reply timeout for cancel / status / positions queries — cheaper
  // round-trips that shouldn't take longer than a NATS hop + an NT
  // synchronous lookup.
  queryTimeoutMs?: number;
}

const DEFAULT_SUBMIT_TIMEOUT_MS = 5_000;
const DEFAULT_QUERY_TIMEOUT_MS = 2_000;
// QF-246 — the legacy single-account sentinel: subjects drop the suffix
// so the bare orders.submit.<broker> family the Python "default" bridge
// owns keeps working unmodified.
export const DEFAULT_ACCOUNT_ID = "default";

// QF-246 — build the per-account subject suffix. "" for the default
// account (legacy bare subjects); ".<accountId>" otherwise. Mirrors
// subjects_for() in the Python bridge so both ends agree on the wire.
// Exported so the audit observer consumer namespaces its exec_reports
// subscription the same way.
export function accountSubjectSuffix(accountId: string | undefined): string {
  return accountId === undefined || accountId === DEFAULT_ACCOUNT_ID ? "" : `.${accountId}`;
}

// ── Wire payloads (request/reply) ──────────────────────────────────

interface SubmitReply {
  broker_order_id?: string;
  accepted?: boolean;
  error?: string;
}

interface CancelReply {
  accepted?: boolean;
  error?: string;
}

// ── Factory ────────────────────────────────────────────────────────

export function createNtBridgeAdapter(
  nc: NatsConnection,
  config: NtBridgeConfig,
  logger: Logger,
): BrokerAdapter {
  const submitTimeoutMs = config.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
  const queryTimeoutMs = config.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const accountId = config.accountId ?? DEFAULT_ACCOUNT_ID;
  // QF-335 builders own the base subject; QF-246 appends the per-account
  // suffix ("" for the "default" account, ".<accountId>" otherwise).
  const suffix = accountSubjectSuffix(config.accountId);
  const submitSubject = orders.submit(config.broker) + suffix;
  const cancelSubject = orders.cancel(config.broker) + suffix;
  const statusSubject = orders.status(config.broker) + suffix;
  const positionsSubject = orders.positions(config.broker) + suffix;
  const accountsSubject = orders.accounts(config.broker) + suffix;
  const execReportsSubject = orders.execReports(config.broker) + suffix;

  const sc = StringCodec();
  const fillCallbacks: Array<(fill: Fill) => void> = [];
  const rejectionCallbacks: Array<(rejection: BrokerRejection) => void> = [];

  // ── exec_reports subscription ──
  // Fire-and-forget — fans NT execution reports out to the registered
  // onFill / onRejection callbacks. The async loop runs for the
  // lifetime of the adapter; the adapter doesn't expose a close()
  // method because production wires it for the server lifetime.
  const execReportsSub = nc.subscribe(execReportsSubject);
  void (async () => {
    for await (const msg of execReportsSub) {
      let report: BrokerExecReport;
      try {
        report = JSON.parse(sc.decode(msg.data)) as BrokerExecReport;
      } catch (err) {
        logger.warn("nt-bridge: malformed exec_report payload", {
          broker: config.broker,
          error: String(err),
        });
        continue;
      }
      dispatchExecReport(report);
    }
  })();

  function dispatchExecReport(report: BrokerExecReport): void {
    if (report.event === "fill" || report.event === "partial_fill") {
      if (!report.fill) {
        logger.warn("nt-bridge: fill event missing fill payload", {
          broker: config.broker,
          broker_order_id: report.broker_order_id,
        });
        return;
      }
      // OrderPlane enriches intent_id + portfolio from the matched order;
      // we leave them as empty strings so the dispatch key (broker_order_id)
      // is what matters. broker field on the Fill is the report's broker.
      // QF-246 — stamp account_id so M12-3's audit-attribution path can
      // read it even for NT-native fills OPL didn't initiate. The report's
      // own account_id wins (the originating bridge knows best); we fall
      // back to this adapter's configured account.
      const fill: Fill = {
        fill_id: report.fill.fill_id,
        order_id: report.broker_order_id,
        intent_id: "",
        portfolio: "",
        symbol: "",
        direction: "",
        quantity: report.fill.quantity,
        price: report.fill.price,
        fees: report.fill.fees ?? 0,
        filled_at: report.ts,
        broker: report.broker,
        broker_order_id: report.broker_order_id,
        account_id: report.account_id ?? accountId,
      };
      for (const cb of fillCallbacks) cb(fill);
      return;
    }
    if (report.event === "rejected") {
      // QF-246 — stamp account_id on rejections too (mirrors the Fill
      // path above) so M12-3's audit-attribution path can read it for
      // per-account bridges. The report's own account_id wins; we fall
      // back to this adapter's configured account when it's absent.
      const rejection: BrokerRejection = {
        broker_order_id: report.broker_order_id,
        reason: report.rejection_reason ?? "unknown",
        ...(report.broker_reason_code ? { broker_reason_code: report.broker_reason_code } : {}),
        rejected_at: report.ts,
        account_id: report.account_id ?? accountId,
      };
      for (const cb of rejectionCallbacks) cb(rejection);
      return;
    }
    // "cancelled" and "submitted" events are informational only at
    // this layer — OrderPlane drives the cancelled/submitted state from
    // the local cancelOrder() / submitOrder() call sites. The bridge
    // logs them for forensics but doesn't fan them out.
    logger.debug("nt-bridge: informational exec_report", {
      broker: config.broker,
      event: report.event,
      broker_order_id: report.broker_order_id,
    });
  }

  // ── Request/reply helpers ──
  async function requestJson<T>(subject: string, payload: unknown, timeoutMs: number): Promise<T> {
    const msg = await nc.request(subject, sc.encode(JSON.stringify(payload)), {
      timeout: timeoutMs,
    });
    return JSON.parse(sc.decode(msg.data)) as T;
  }

  // ── Adapter implementation ──
  return {
    name: config.broker,

    async available(): Promise<boolean> {
      // The bridge is "available" iff NATS is connected. Production
      // wires the adapter only after nc is open, so we treat the NATS
      // connection as authoritative — a separate health-check call to
      // the Python service is left to a higher layer (e.g. a periodic
      // `orders.status.<broker>` ping by the operator dashboard).
      return !nc.isClosed();
    },

    async submitOrder(params: SubmitOrderParams): Promise<string> {
      const reply = await requestJson<SubmitReply>(submitSubject, params, submitTimeoutMs);
      if (reply.error || !reply.broker_order_id) {
        throw new Error(`nt-bridge submit rejected: ${reply.error ?? "no broker_order_id"}`);
      }
      return reply.broker_order_id;
    },

    async cancelOrder(brokerOrderId: string): Promise<void> {
      const reply = await requestJson<CancelReply>(
        cancelSubject,
        { broker_order_id: brokerOrderId, reason: "qf_cancel" },
        queryTimeoutMs,
      );
      if (reply.error) {
        throw new Error(`nt-bridge cancel rejected: ${reply.error}`);
      }
    },

    async getOrderStatus(brokerOrderId: string): Promise<BrokerOrderStatus> {
      return requestJson<BrokerOrderStatus>(
        statusSubject,
        { broker_order_id: brokerOrderId },
        queryTimeoutMs,
      );
    },

    async getPositions(): Promise<BrokerPosition[]> {
      const reply = await requestJson<BrokerPosition[] | { error: string }>(
        positionsSubject,
        {},
        queryTimeoutMs,
      );
      if (!Array.isArray(reply)) {
        throw new Error(`nt-bridge positions failed: ${reply.error ?? "non-array reply"}`);
      }
      return reply;
    },

    // QF-272 — account discovery for /api/accounts. Throws on the
    // bridge's `{error}` reply so the market-data layer falls back to the
    // schwab-rest REST path.
    async getAccounts(): Promise<BrokerAccount[]> {
      const reply = await requestJson<BrokerAccount[] | { error: string }>(
        accountsSubject,
        {},
        queryTimeoutMs,
      );
      if (!Array.isArray(reply)) {
        throw new Error(`nt-bridge accounts failed: ${reply.error ?? "non-array reply"}`);
      }
      return reply;
    },

    onFill(callback: (fill: Fill) => void): void {
      fillCallbacks.push(callback);
    },

    onRejection(callback: (rejection: BrokerRejection) => void): void {
      rejectionCallbacks.push(callback);
    },
  };
}
