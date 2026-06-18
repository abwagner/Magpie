// ── Strategy template catalog ────────────────────────────────────────
// One StrategyTemplate per OptionStrategyKind, expressed as relative leg
// selectors. Defaults use 1-step strike widths and ATM anchoring; the
// builder resolves them to concrete contracts and the GUI (later stage)
// lets the operator override individual strikes/expirations.
//
// Conventions: long verticals/butterflies are debit; credit spreads and
// iron structures are short-premium (net credit). Calendars/diagonals SELL
// the front expiration and BUY the back (long calendar — positive theta on
// the near leg). `steps` on an offset selector is signed (+ = higher strike).

import type { LegTemplate, OptionStrategyKind, StrategyTemplate } from "../../types/option-strategy.js";

const atm = (): LegTemplate["strike"] => ({ kind: "atm" });
const off = (steps: number): LegTemplate["strike"] => ({ kind: "offset", steps });
const front: LegTemplate["expiration"] = { kind: "front" };
const back: LegTemplate["expiration"] = { kind: "back" };

function leg(
  right: LegTemplate["right"],
  side: LegTemplate["side"],
  strike: LegTemplate["strike"],
  ratio = 1,
  expiration: LegTemplate["expiration"] = front,
): LegTemplate {
  return { right, side, ratio, strike, expiration };
}

export const STRATEGY_TEMPLATES: Record<OptionStrategyKind, StrategyTemplate> = {
  "vertical-call-debit": {
    kind: "vertical-call-debit",
    label: "Bull Call Spread",
    expirationsRequired: 1,
    legs: [leg("call", "buy", atm()), leg("call", "sell", off(1))],
  },
  "vertical-call-credit": {
    kind: "vertical-call-credit",
    label: "Bear Call Spread",
    expirationsRequired: 1,
    legs: [leg("call", "sell", atm()), leg("call", "buy", off(1))],
  },
  "vertical-put-debit": {
    kind: "vertical-put-debit",
    label: "Bear Put Spread",
    expirationsRequired: 1,
    legs: [leg("put", "buy", atm()), leg("put", "sell", off(-1))],
  },
  "vertical-put-credit": {
    kind: "vertical-put-credit",
    label: "Bull Put Spread",
    expirationsRequired: 1,
    legs: [leg("put", "sell", atm()), leg("put", "buy", off(-1))],
  },
  "calendar-call": {
    kind: "calendar-call",
    label: "Call Calendar",
    expirationsRequired: 2,
    legs: [leg("call", "sell", atm(), 1, front), leg("call", "buy", atm(), 1, back)],
  },
  "calendar-put": {
    kind: "calendar-put",
    label: "Put Calendar",
    expirationsRequired: 2,
    legs: [leg("put", "sell", atm(), 1, front), leg("put", "buy", atm(), 1, back)],
  },
  "diagonal-call": {
    kind: "diagonal-call",
    label: "Call Diagonal",
    expirationsRequired: 2,
    legs: [leg("call", "sell", atm(), 1, front), leg("call", "buy", off(1), 1, back)],
  },
  "diagonal-put": {
    kind: "diagonal-put",
    label: "Put Diagonal",
    expirationsRequired: 2,
    legs: [leg("put", "sell", atm(), 1, front), leg("put", "buy", off(-1), 1, back)],
  },
  straddle: {
    kind: "straddle",
    label: "Long Straddle",
    expirationsRequired: 1,
    legs: [leg("call", "buy", atm()), leg("put", "buy", atm())],
  },
  strangle: {
    kind: "strangle",
    label: "Long Strangle",
    expirationsRequired: 1,
    legs: [leg("call", "buy", off(1)), leg("put", "buy", off(-1))],
  },
  "iron-condor": {
    kind: "iron-condor",
    label: "Iron Condor",
    expirationsRequired: 1,
    legs: [
      leg("put", "buy", off(-2)),
      leg("put", "sell", off(-1)),
      leg("call", "sell", off(1)),
      leg("call", "buy", off(2)),
    ],
  },
  "iron-butterfly": {
    kind: "iron-butterfly",
    label: "Iron Butterfly",
    expirationsRequired: 1,
    legs: [
      leg("put", "buy", off(-1)),
      leg("put", "sell", atm()),
      leg("call", "sell", atm()),
      leg("call", "buy", off(1)),
    ],
  },
  "call-butterfly": {
    kind: "call-butterfly",
    label: "Call Butterfly",
    expirationsRequired: 1,
    legs: [leg("call", "buy", off(-1)), leg("call", "sell", atm(), 2), leg("call", "buy", off(1))],
  },
  "put-butterfly": {
    kind: "put-butterfly",
    label: "Put Butterfly",
    expirationsRequired: 1,
    legs: [leg("put", "buy", off(1)), leg("put", "sell", atm(), 2), leg("put", "buy", off(-1))],
  },
};

export const STRATEGY_KINDS = Object.keys(STRATEGY_TEMPLATES) as OptionStrategyKind[];
