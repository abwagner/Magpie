import { describe, it, expect, afterEach } from "vitest";
import { createFillLog } from "../../fill-log.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Fill } from "../../../../src/types/order.js";

const testPath = join(tmpdir(), `test-fills-${Date.now()}.jsonl`);

afterEach(() => {
  if (existsSync(testPath)) unlinkSync(testPath);
});

function makeFill(id: string): Fill {
  return {
    fill_id: id,
    order_id: "order-1",
    intent_id: "intent-1",
    portfolio: "main",
    symbol: "EQ:SPY",
    direction: "Long",
    quantity: 1,
    price: 500,
    fees: 1,
    filled_at: "2026-04-08T14:30:00Z",
    broker: "paper",
  };
}

describe("fill-log", () => {
  it("creates file on first append", () => {
    const log = createFillLog(testPath);
    log.append(makeFill("fill-1"));
    expect(existsSync(testPath)).toBe(true);
  });

  it("reads back appended fills", () => {
    const log = createFillLog(testPath);
    log.append(makeFill("fill-1"));
    log.append(makeFill("fill-2"));

    const fills = log.read();
    expect(fills.length).toBe(2);
    expect(fills[0]!.fill_id).toBe("fill-1");
    expect(fills[1]!.fill_id).toBe("fill-2");
  });

  it("returns empty array for non-existent file", () => {
    const log = createFillLog(join(tmpdir(), "nonexistent.jsonl"));
    expect(log.read()).toEqual([]);
  });

  it("includes version field", () => {
    const log = createFillLog(testPath);
    log.append(makeFill("fill-1"));
    const fills = log.read();
    expect(fills[0]!.v).toBe(1);
  });
});
