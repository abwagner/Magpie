// ── Combo order construction (QF-362) ────────────────────────────────
// Turn a Stage-1 BuiltStrategy into a multi-leg combo OrderIntent
// (parent + child legs), and allocate a combo's net fill across its legs.
// Pure: no I/O. The OPL / broker bridge consume these in Stage 4.

import type { BuiltStrategy, ResolvedLeg } from "../../types/option-strategy.js";
import type { ComboLegSpec, OrderIntent, OrderLeg } from "../../types/order.js";

function sideSign(side: ResolvedLeg["side"]): 1 | -1 {
  return side === "buy" ? 1 : -1;
}

// Net price per combo unit from leg mids: debit > 0 (pay), credit < 0
// (receive). This is the natural limit price for the combo order — no
// contract multiplier (that scales dollar P/L, not the quoted net price).
export function comboNetPrice(legs: ResolvedLeg[]): number {
  const net = legs.reduce((acc, l) => acc + sideSign(l.side) * l.ratio * l.contract.mid, 0);
  return Number(net.toFixed(4));
}

export function builtStrategyToComboLegs(built: BuiltStrategy): ComboLegSpec[] {
  return built.legs.map((l, i) => ({
    leg_id: `leg-${i}`,
    right: l.right,
    side: l.side,
    ratio: l.ratio,
    option_symbol: l.contract.symbol,
    strike: l.contract.strike,
    expiration: l.contract.expiration,
  }));
}

// Fields the caller supplies that aren't derivable from the structure.
export interface ComboIntentFields {
  intent_id: string;
  portfolio: string;
  strategy_id: string;
  quantity: number; // number of combo units
  reason: string;
  created_at: string;
  signal_ids?: string[];
  account_id?: string;
  action?: OrderIntent["action"];
  // Omit for a market combo; provide "limit" to price at the net mid
  // (or pass an explicit net via `limit_price`).
  order_type?: OrderIntent["order_type"];
  limit_price?: number;
  time_in_force?: OrderIntent["time_in_force"];
}

export function builtStrategyToIntent(
  built: BuiltStrategy,
  fields: ComboIntentFields,
): OrderIntent {
  const legs = builtStrategyToComboLegs(built);
  const net = fields.limit_price ?? comboNetPrice(built.legs);
  return {
    intent_id: fields.intent_id,
    portfolio: fields.portfolio,
    strategy_id: fields.strategy_id,
    account_id: fields.account_id,
    action: fields.action ?? "open",
    symbol: built.underlying,
    // A combo has no single Long/Short direction; the legs carry the
    // per-leg sides. Mark the aggregate per the net (debit ⇒ Long bias).
    direction: net >= 0 ? "Long" : "Short",
    quantity: fields.quantity,
    reason: fields.reason,
    signal_ids: fields.signal_ids ?? [],
    created_at: fields.created_at,
    legs,
    ...(fields.order_type === "limit"
      ? { order_type: "limit" as const, limit_price: net }
      : fields.order_type
        ? { order_type: fields.order_type }
        : {}),
    ...(fields.time_in_force ? { time_in_force: fields.time_in_force } : {}),
  };
}

// Allocate a combo's net fill to its legs. The combo fills as a unit, so
// each leg's filled quantity = combo units filled × the leg ratio. The
// authoritative price is the combo net; per-leg `average_fill_price` is a
// best-effort allocation from the leg's expected mid when supplied.
export function allocateComboFillLegs(
  legs: ComboLegSpec[],
  comboUnitsFilled: number,
  legMidById?: Record<string, number>,
): OrderLeg[] {
  return legs.map((leg) => ({
    ...leg,
    filled_quantity: comboUnitsFilled * leg.ratio,
    ...(legMidById && legMidById[leg.leg_id] !== undefined
      ? { average_fill_price: legMidById[leg.leg_id] }
      : {}),
  }));
}
