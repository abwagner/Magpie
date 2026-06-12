import { describe, it, expect } from "vitest";
import { createDisconnectedAdapter } from "../../adapters/disconnected.js";

describe("disconnected broker adapter", () => {
  it("reports itself unavailable", async () => {
    const adapter = createDisconnectedAdapter();
    expect(await adapter.available()).toBe(false);
  });

  it("refuses submitOrder", async () => {
    const adapter = createDisconnectedAdapter();
    await expect(
      adapter.submitOrder({
        client_order_id: "intent-1",
        symbol: "SPY",
        direction: "Long",
        quantity: 1,
        orderType: "market",
      }),
    ).rejects.toThrow(/no broker configured/);
  });

  it("refuses cancelOrder", async () => {
    const adapter = createDisconnectedAdapter();
    await expect(adapter.cancelOrder("fake-1")).rejects.toThrow(/no broker configured/);
  });

  it("returns unknown status for any order id", async () => {
    const adapter = createDisconnectedAdapter();
    const status = await adapter.getOrderStatus("fake-1");
    expect(status).toEqual({
      broker_order_id: "fake-1",
      status: "unknown",
      filled_quantity: 0,
      average_fill_price: null,
      rejection_reason: null,
    });
  });

  it("returns no positions", async () => {
    const adapter = createDisconnectedAdapter();
    expect(await adapter.getPositions()).toEqual([]);
  });

  it("never fires fill or rejection callbacks", () => {
    const adapter = createDisconnectedAdapter();
    let fired = false;
    adapter.onFill(() => {
      fired = true;
    });
    adapter.onRejection?.(() => {
      fired = true;
    });
    expect(fired).toBe(false);
  });
});
