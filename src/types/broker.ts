// Frontend mirror of server/order/adapters/schwab-rest.ts's exported
// positions shape. Kept here so the GUI can type the
// /api/positions response without a server-side import.

export interface BrokerOptionPosition {
  symbol: string;
  underlying: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  dayPnl: number;
  unrealizedPnl: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface BrokerEquityPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  dayPnl: number;
  unrealizedPnl: number;
}

// Futures contracts (e.g. /CLM26). The Schwab adapter previously
// dumped these into `equities` — they're now broken out so the GUI
// can render them with futures-specific columns and so options
// strategies that target futures roots can group correctly.
export interface BrokerFuturesPosition {
  // Full contract symbol (e.g. "/CLM26"). Contract month is in the
  // third character: F G H J K M N Q U V X Z.
  symbol: string;
  // Root, e.g. "/CL". Useful for grouping all CL contract months.
  root: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  dayPnl: number;
  unrealizedPnl: number;
}

export interface BrokerPositions {
  options: BrokerOptionPosition[];
  equities: BrokerEquityPosition[];
  futures: BrokerFuturesPosition[];
}
