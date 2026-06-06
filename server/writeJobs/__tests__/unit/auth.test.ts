import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { createWriteJobAuthenticator } from "../../auth.js";
import { createMemoryWriteJobTokenStore } from "../../tokens.js";

function reqWithHeader(authorization: string | undefined): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as unknown as IncomingMessage;
}

describe("WriteJobAuthenticator", () => {
  it("rejects requests without a bearer header", async () => {
    const store = createMemoryWriteJobTokenStore();
    const auth = createWriteJobAuthenticator(store);
    const decision = await auth.authenticate(reqWithHeader(undefined));
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("missing_bearer_token");
  });

  it("rejects an invalid or revoked token", async () => {
    const store = createMemoryWriteJobTokenStore();
    await store.issue({ actor: "operator", scopes: ["*"] });
    const auth = createWriteJobAuthenticator(store);
    const decision = await auth.authenticate(reqWithHeader("Bearer not-a-real-token"));
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("invalid_or_revoked_token");
  });

  it("accepts a valid bearer and surfaces the actor", async () => {
    const store = createMemoryWriteJobTokenStore();
    const { token, entry } = await store.issue({
      actor: "operator-alice",
      scopes: ["fmp-backfill"],
    });
    const auth = createWriteJobAuthenticator(store);
    const decision = await auth.authenticate(reqWithHeader(`Bearer ${token}`));
    expect(decision.ok).toBe(true);
    expect(decision.entry?.actor).toBe("operator-alice");
    expect(decision.entry?.token_id).toBe(entry.token_id);
  });

  it("rejects out-of-scope kinds", async () => {
    const store = createMemoryWriteJobTokenStore();
    const { token } = await store.issue({
      actor: "limited",
      scopes: ["fmp-backfill"],
    });
    const auth = createWriteJobAuthenticator(store);
    const ok = await auth.authorizeForKind(reqWithHeader(`Bearer ${token}`), "fmp-backfill");
    expect(ok.ok).toBe(true);
    const bad = await auth.authorizeForKind(reqWithHeader(`Bearer ${token}`), "collect-bulk");
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("kind_not_in_scope");
  });

  it("wildcard scope passes every kind", async () => {
    const store = createMemoryWriteJobTokenStore();
    const { token } = await store.issue({ actor: "admin", scopes: ["*"] });
    const auth = createWriteJobAuthenticator(store);
    for (const kind of ["fmp-backfill", "ingest", "collect-bulk", "anything"]) {
      const d = await auth.authorizeForKind(reqWithHeader(`Bearer ${token}`), kind);
      expect(d.ok).toBe(true);
    }
  });

  it("revoked tokens fail lookup", async () => {
    const store = createMemoryWriteJobTokenStore();
    const { token, entry } = await store.issue({ actor: "ephemeral", scopes: ["*"] });
    await store.revoke(entry.token_id);
    const auth = createWriteJobAuthenticator(store);
    const decision = await auth.authenticate(reqWithHeader(`Bearer ${token}`));
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("invalid_or_revoked_token");
  });
});
