import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWriteJobTokenStore,
  createMemoryWriteJobTokenStore,
  hasScope,
} from "../../tokens.js";

describe("WriteJobTokenStore (memory)", () => {
  it("issues + looks up by plaintext", async () => {
    const store = createMemoryWriteJobTokenStore();
    const { token, entry } = await store.issue({
      actor: "operator-bob",
      scopes: ["fmp-backfill"],
    });
    expect(entry.actor).toBe("operator-bob");
    expect(entry.scopes).toEqual(["fmp-backfill"]);
    const looked = await store.lookup(token);
    expect(looked?.token_id).toBe(entry.token_id);
  });

  it("returns null for unknown plaintext", async () => {
    const store = createMemoryWriteJobTokenStore();
    await store.issue({ actor: "x", scopes: ["*"] });
    expect(await store.lookup("nope")).toBeNull();
  });

  it("revoke makes lookup return null", async () => {
    const store = createMemoryWriteJobTokenStore();
    const { token, entry } = await store.issue({ actor: "x", scopes: ["*"] });
    expect(await store.revoke(entry.token_id)).toBe(true);
    expect(await store.lookup(token)).toBeNull();
  });

  it("rejects empty scopes / missing actor", async () => {
    const store = createMemoryWriteJobTokenStore();
    await expect(store.issue({ actor: "", scopes: ["*"] })).rejects.toThrow(/actor/);
    await expect(store.issue({ actor: "ok", scopes: [] })).rejects.toThrow(/scopes/);
  });
});

describe("WriteJobTokenStore (file-backed)", () => {
  it("round-trips through the on-disk JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qf-wjt-"));
    try {
      const path = join(dir, "tokens.json");
      const a = createFileWriteJobTokenStore({ path });
      const { token, entry } = await a.issue({
        actor: "operator-charlie",
        scopes: ["ingest", "collect-bulk"],
      });
      // Fresh store reads what the previous one wrote.
      const b = createFileWriteJobTokenStore({ path });
      const looked = await b.lookup(token);
      expect(looked?.token_id).toBe(entry.token_id);
      expect(looked?.scopes).toEqual(["ingest", "collect-bulk"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hasScope", () => {
  const make = (scopes: string[]) =>
    ({
      token_id: "x",
      actor: "x",
      scopes,
      issued_at: "",
      revoked: false,
      token_hash: "",
    }) as const;
  it("matches explicit kind", () => {
    expect(hasScope(make(["fmp-backfill"]), "fmp-backfill")).toBe(true);
    expect(hasScope(make(["fmp-backfill"]), "ingest")).toBe(false);
  });
  it("wildcard matches any kind", () => {
    expect(hasScope(make(["*"]), "fmp-backfill")).toBe(true);
    expect(hasScope(make(["*"]), "anything")).toBe(true);
  });
});
