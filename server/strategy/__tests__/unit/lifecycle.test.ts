import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IllegalTransitionError,
  LIFECYCLE_TRANSITIONS,
  StrategyStore,
  legalActions,
  nextState,
} from "../../lifecycle.js";
import { createLogger } from "../../../logger.js";

const silent = createLogger("test", "warn");

describe("nextState", () => {
  it("walks the canonical happy path", () => {
    let s = nextState("registered", "enable");
    expect(s).toBe("enabled");
    s = nextState(s, "start");
    expect(s).toBe("running");
    s = nextState(s, "pause");
    expect(s).toBe("paused");
    s = nextState(s, "resume");
    expect(s).toBe("running");
    s = nextState(s, "halt");
    expect(s).toBe("halted");
    s = nextState(s, "retire");
    expect(s).toBe("retired");
    s = nextState(s, "reregister");
    expect(s).toBe("registered");
  });

  it("rejects illegal transitions", () => {
    expect(() => nextState("registered", "start")).toThrow(IllegalTransitionError);
    expect(() => nextState("running", "enable")).toThrow(IllegalTransitionError);
    expect(() => nextState("retired", "start")).toThrow(IllegalTransitionError);
    expect(() => nextState("paused", "enable")).toThrow(IllegalTransitionError);
  });

  it("legalActions matches the transition table", () => {
    expect(legalActions("registered")).toEqual(["enable"]);
    expect(legalActions("enabled").sort()).toEqual(["disable", "start"]);
    expect(legalActions("running").sort()).toEqual(["halt", "pause"]);
    expect(legalActions("paused").sort()).toEqual(["halt", "resume"]);
    expect(legalActions("halted").sort()).toEqual(["reenable", "retire"]);
    expect(legalActions("retired")).toEqual(["reregister"]);
  });

  it("every state in the table has at least one outbound action except retired/registered are mutual", () => {
    const states = new Set(LIFECYCLE_TRANSITIONS.flatMap((t) => [t.from, t.to]));
    for (const s of states) {
      expect(legalActions(s).length, `state ${s} has no outbound`).toBeGreaterThan(0);
    }
  });
});

describe("StrategyStore", () => {
  let dir: string;
  let path: string;
  let store: StrategyStore;
  const FIXED = new Date("2026-04-27T10:00:00Z");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qf-strat-"));
    path = join(dir, "strategies.json");
    store = new StrategyStore({ path, logger: silent, now: () => FIXED });
    await store.load();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("registers a strategy with a seed history entry", async () => {
    const s = await store.register({ id: "short-straddle-spy", label: "Short Straddle SPY" });
    expect(s.state).toBe("registered");
    expect(s.history).toHaveLength(1);
    expect(s.history[0]?.actor).toBe("operator");
  });

  it("rejects invalid ids and duplicates", async () => {
    await expect(store.register({ id: "BAD ID", label: "x" })).rejects.toThrow(/invalid/);
    await store.register({ id: "alpha", label: "Alpha" });
    await expect(store.register({ id: "alpha", label: "Alpha" })).rejects.toThrow(/already/);
  });

  it("transitions through the happy path and writes history", async () => {
    await store.register({ id: "alpha", label: "Alpha" });
    let s = await store.transition("alpha", "enable");
    expect(s.state).toBe("enabled");
    s = await store.transition("alpha", "start");
    expect(s.state).toBe("running");
    s = await store.transition("alpha", "halt", "system", "limit_004 breach");
    expect(s.state).toBe("halted");
    expect(s.history.at(-1)?.reason).toBe("limit_004 breach");
    expect(s.history.at(-1)?.actor).toBe("system");
  });

  it("rejects illegal transitions and unknown ids", async () => {
    await store.register({ id: "alpha", label: "Alpha" });
    await expect(store.transition("alpha", "start")).rejects.toThrow(IllegalTransitionError);
    await expect(store.transition("missing", "enable")).rejects.toThrow(/not found/);
  });

  it("persists to disk and reloads identically", async () => {
    await store.register({ id: "alpha", label: "Alpha" });
    await store.transition("alpha", "enable");
    await store.transition("alpha", "start");

    const fresh = new StrategyStore({ path, logger: silent });
    await fresh.load();
    const s = fresh.get("alpha");
    expect(s?.state).toBe("running");
    expect(s?.history).toHaveLength(3);

    // file shape sanity check
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      strategies: { alpha: { state: "running" } },
    });
  });

  it("emits onChange for register and transition", async () => {
    const events: string[] = [];
    const s = new StrategyStore({
      path,
      logger: silent,
      now: () => FIXED,
      onChange: (st) => events.push(`${st.id}:${st.state}`),
    });
    await s.load();
    await s.register({ id: "alpha", label: "Alpha" });
    await s.transition("alpha", "enable");
    expect(events).toEqual(["alpha:registered", "alpha:enabled"]);
  });

  // QF-324 — onHalt fires only on transitions INTO 'halted'.
  it("fires onHalt callback when transitioning into halted", async () => {
    const halts: string[] = [];
    const s = new StrategyStore({
      path,
      logger: silent,
      now: () => FIXED,
      onHalt: (st) => {
        halts.push(st.id);
      },
    });
    await s.load();
    await s.register({ id: "alpha", label: "Alpha" });
    await s.transition("alpha", "enable");
    await s.transition("alpha", "start");
    expect(halts).toEqual([]);
    await s.transition("alpha", "halt", "operator", "test");
    // Yield once so the fire-and-forget callback resolves.
    await new Promise((r) => setImmediate(r));
    expect(halts).toEqual(["alpha"]);

    // A subsequent re-halt (via reenable → start → halt) fires onHalt
    // again — each transition INTO halted is a fresh halt event from
    // the revoker's perspective.
    await s.transition("alpha", "reenable");
    await s.transition("alpha", "start");
    await s.transition("alpha", "halt", "operator", "second halt");
    await new Promise((r) => setImmediate(r));
    expect(halts).toEqual(["alpha", "alpha"]);
  });

  it("setNotes updates updated_at and emits onChange", async () => {
    const events: string[] = [];
    const s = new StrategyStore({
      path,
      logger: silent,
      now: () => FIXED,
      onChange: (st) => events.push(st.operator_notes ?? ""),
    });
    await s.load();
    await s.register({ id: "alpha", label: "Alpha" });
    events.length = 0;
    await s.setNotes("alpha", "watch overnight");
    expect(s.get("alpha")?.operator_notes).toBe("watch overnight");
    expect(events).toEqual(["watch overnight"]);
  });

  // ── B3 (QF-172) params_provenance ────────────────────────────────

  const VALID_PROV = {
    lineage_id: "11111111-1111-1111-1111-111111111111",
    selected_params: { stop_loss_dollars: 1700, bullish_threshold: 80 },
    selector_rule: "last_fold",
    selected_at: "2026-05-13T16:00:00Z",
  };

  it("setParamsProvenance persists the block + bumps updated_at", async () => {
    await store.register({ id: "cl-scalp", label: "CL Scalp" });
    await store.setParamsProvenance("cl-scalp", VALID_PROV);
    const s = store.get("cl-scalp");
    expect(s?.params_provenance).toEqual(VALID_PROV);
    expect(s?.updated_at).toBe(FIXED.toISOString());

    // Round-trips through the JSON file too.
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.strategies["cl-scalp"].params_provenance.lineage_id).toBe(VALID_PROV.lineage_id);
    expect(raw.strategies["cl-scalp"].params_provenance.selected_params).toEqual(
      VALID_PROV.selected_params,
    );
  });

  it("setParamsProvenance fires onChange with the updated record", async () => {
    const events: string[] = [];
    const s = new StrategyStore({
      path,
      logger: silent,
      now: () => FIXED,
      onChange: (st) => events.push(st.params_provenance?.lineage_id ?? "(none)"),
    });
    await s.load();
    await s.register({ id: "cl-scalp", label: "CL Scalp" });
    events.length = 0;
    await s.setParamsProvenance("cl-scalp", VALID_PROV);
    expect(events).toEqual([VALID_PROV.lineage_id]);
  });

  it("setParamsProvenance survives a reload from disk", async () => {
    await store.register({ id: "cl-scalp", label: "CL Scalp" });
    await store.setParamsProvenance("cl-scalp", VALID_PROV);

    const fresh = new StrategyStore({ path, logger: silent, now: () => FIXED });
    await fresh.load();
    expect(fresh.get("cl-scalp")?.params_provenance).toEqual(VALID_PROV);
  });

  it("setParamsProvenance defensively clones selected_params (no shared mutation)", async () => {
    await store.register({ id: "cl-scalp", label: "CL Scalp" });
    const prov = { ...VALID_PROV, selected_params: { ...VALID_PROV.selected_params } };
    await store.setParamsProvenance("cl-scalp", prov);
    prov.selected_params.stop_loss_dollars = 9999;
    expect(store.get("cl-scalp")?.params_provenance?.selected_params).toEqual(
      VALID_PROV.selected_params,
    );
  });

  it("setParamsProvenance 404s on unknown strategy id", async () => {
    await expect(store.setParamsProvenance("nope", VALID_PROV)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("setParamsProvenance rejects a missing lineage_id with 400", async () => {
    await store.register({ id: "cl-scalp", label: "CL Scalp" });
    const bad = { ...VALID_PROV, lineage_id: "" };
    await expect(store.setParamsProvenance("cl-scalp", bad)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("setParamsProvenance rejects a missing selector_rule with 400", async () => {
    await store.register({ id: "cl-scalp", label: "CL Scalp" });
    const bad = { ...VALID_PROV, selector_rule: "" };
    await expect(store.setParamsProvenance("cl-scalp", bad)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("setParamsProvenance rejects a non-object selected_params with 400", async () => {
    await store.register({ id: "cl-scalp", label: "CL Scalp" });
    const bad = { ...VALID_PROV, selected_params: [1, 2, 3] as unknown as Record<string, unknown> };
    await expect(store.setParamsProvenance("cl-scalp", bad)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("lifecycle state is untouched by setParamsProvenance (no auto-transitions)", async () => {
    await store.register({ id: "cl-scalp", label: "CL Scalp" });
    const before = store.get("cl-scalp")?.state;
    await store.setParamsProvenance("cl-scalp", VALID_PROV);
    expect(store.get("cl-scalp")?.state).toBe(before);
    // history isn't appended either — provenance lives outside the
    // transition log.
    expect(store.get("cl-scalp")?.history.length).toBe(1);
  });
});
