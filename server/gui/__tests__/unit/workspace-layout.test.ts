import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLayoutStore, type WorkspaceLayoutOverride } from "../../workspace-layout.js";
import { createLogger } from "../../../logger.js";

const silent = createLogger("test", "warn");

const OPERATE: WorkspaceLayoutOverride = {
  rows: "260px 1fr 200px",
  cols: "300px 1fr 1fr 380px",
};

describe("WorkspaceLayoutStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qf-ws-layout-"));
    path = join(dir, "workspace-layouts.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty when the file is missing", async () => {
    const store = new WorkspaceLayoutStore({ path, logger: silent });
    await store.load();
    expect(store.get()).toEqual({ version: 1, layouts: {} });
    expect(store.forWorkspace("operate")).toBeUndefined();
  });

  it("persists a layout via setLayout and reloads it", async () => {
    const store = new WorkspaceLayoutStore({ path, logger: silent });
    await store.load();
    await store.setLayout("operate", OPERATE);
    expect(store.forWorkspace("operate")).toEqual(OPERATE);

    const reloaded = new WorkspaceLayoutStore({ path, logger: silent });
    await reloaded.load();
    expect(reloaded.forWorkspace("operate")).toEqual(OPERATE);

    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ version: 1, layouts: { operate: OPERATE } });
  });

  it("fires onChange with the full config after a write", async () => {
    let seen: unknown = null;
    const store = new WorkspaceLayoutStore({ path, logger: silent, onChange: (c) => (seen = c) });
    await store.load();
    await store.setLayout("investigate", OPERATE);
    expect(seen).toEqual({ version: 1, layouts: { investigate: OPERATE } });
  });

  it("trims whitespace and merges multiple workspaces", async () => {
    const store = new WorkspaceLayoutStore({ path, logger: silent });
    await store.load();
    await store.setLayout("operate", OPERATE);
    await store.setLayout("research", { rows: "  1fr 1fr  ", cols: " 1.2fr 1fr " });
    expect(store.forWorkspace("research")).toEqual({ rows: "1fr 1fr", cols: "1.2fr 1fr" });
    expect(Object.keys(store.get().layouts)).toEqual(["operate", "research"]);
  });

  it("rejects an invalid workspace id", async () => {
    const store = new WorkspaceLayoutStore({ path, logger: silent });
    await store.load();
    await expect(store.setLayout("Bad Id!", OPERATE)).rejects.toThrow(/invalid workspace id/);
  });

  it("rejects an override with empty track strings", async () => {
    const store = new WorkspaceLayoutStore({ path, logger: silent });
    await store.load();
    await expect(store.setLayout("operate", { rows: "", cols: "1fr" })).rejects.toThrow(
      /rows must be a non-empty string/,
    );
  });

  it("rejects an override with a non-whitelisted grid track value", async () => {
    const store = new WorkspaceLayoutStore({ path, logger: silent });
    await store.load();
    // calc()/var()/url() and arbitrary functions are not on the
    // whitelist — they must never be persisted or broadcast.
    await expect(
      store.setLayout("operate", { rows: "1fr", cols: "calc(100% - 10px) 1fr" }),
    ).rejects.toThrow(/invalid grid track/);
    await expect(
      store.setLayout("operate", { rows: "url(evil) 1fr", cols: "1fr" }),
    ).rejects.toThrow(/invalid grid track/);
  });

  it("rejects an override declaring an unreasonable number of tracks", async () => {
    const store = new WorkspaceLayoutStore({ path, logger: silent });
    await store.load();
    const huge = Array.from({ length: 200 }, () => "1fr").join(" ");
    await expect(store.setLayout("operate", { rows: huge, cols: "1fr" })).rejects.toThrow(
      /too many tracks/,
    );
  });

  it("accepts minmax() and fit-content() track values", async () => {
    const store = new WorkspaceLayoutStore({ path, logger: silent });
    await store.load();
    const override = {
      rows: "minmax(80px, 1fr) auto",
      cols: "fit-content(200px) 1fr max-content",
    };
    await store.setLayout("operate", override);
    expect(store.forWorkspace("operate")).toEqual(override);
  });

  it("throws on an unsupported persisted version", async () => {
    await writeFile(path, JSON.stringify({ version: 2, layouts: {} }), "utf8");
    const store = new WorkspaceLayoutStore({ path, logger: silent });
    await expect(store.load()).rejects.toThrow(/unsupported version/);
  });
});
