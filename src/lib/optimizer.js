import { evalPortfolio } from "./eval.js";
import { log } from "./log.js";

function makePosition(opt, direction, spot, dte) {
  return {
    id: 0,
    type: opt.side === "call" ? "Call" : "Put",
    direction,
    qty: 1,
    multiplier: 100,
    entryPrice: spot,
    strike: opt.strike,
    premium:
      direction === "Long"
        ? opt.ask || opt.mid || opt.last || 0
        : opt.bid || opt.mid || opt.last || 0,
    dte: opt.dte || dte,
    iv: opt.iv || 0.3,
    label: `${opt.strike}${opt.side === "call" ? "C" : "P"}`,
  };
}

export const STRATEGIES = {
  bull_call_spread: {
    name: "Bull Call Spread",
    description: "Long lower call + short higher call",
    generate(chain, spot) {
      const calls = chain
        .filter((c) => c.side === "call" && c.bid > 0)
        .sort((a, b) => a.strike - b.strike);
      const candidates = [];
      for (let i = 0; i < calls.length; i++)
        for (let j = i + 1; j < calls.length; j++)
          candidates.push([
            makePosition(calls[i], "Long", spot),
            makePosition(calls[j], "Short", spot),
          ]);
      return candidates;
    },
  },
  bear_put_spread: {
    name: "Bear Put Spread",
    description: "Long higher put + short lower put",
    generate(chain, spot) {
      const puts = chain
        .filter((c) => c.side === "put" && c.bid > 0)
        .sort((a, b) => a.strike - b.strike);
      const candidates = [];
      for (let i = 0; i < puts.length; i++)
        for (let j = i + 1; j < puts.length; j++)
          candidates.push([
            makePosition(puts[i], "Short", spot),
            makePosition(puts[j], "Long", spot),
          ]);
      return candidates;
    },
  },
  iron_condor: {
    name: "Iron Condor",
    description: "Short OTM put + long further OTM put + short OTM call + long further OTM call",
    generate(chain, spot) {
      const puts = chain
        .filter((c) => c.side === "put" && c.strike < spot && c.bid > 0)
        .sort((a, b) => a.strike - b.strike);
      const calls = chain
        .filter((c) => c.side === "call" && c.strike > spot && c.bid > 0)
        .sort((a, b) => a.strike - b.strike);
      const candidates = [];
      for (let pi = 0; pi < puts.length; pi++)
        for (let pj = pi + 1; pj < puts.length; pj++)
          for (let ci = 0; ci < calls.length; ci++)
            for (let cj = ci + 1; cj < calls.length; cj++) {
              candidates.push([
                makePosition(puts[pi], "Long", spot), // long OTM put wing
                makePosition(puts[pj], "Short", spot), // short OTM put
                makePosition(calls[ci], "Short", spot), // short OTM call
                makePosition(calls[cj], "Long", spot), // long OTM call wing
              ]);
              if (candidates.length > 5000) return candidates; // cap to avoid explosion
            }
      return candidates;
    },
  },
  long_call: {
    name: "Long Call",
    description: "Single long call",
    generate(chain, spot) {
      return chain
        .filter((c) => c.side === "call" && c.ask > 0)
        .map((c) => [makePosition(c, "Long", spot)]);
    },
  },
  long_put: {
    name: "Long Put",
    description: "Single long put",
    generate(chain, spot) {
      return chain
        .filter((c) => c.side === "put" && c.ask > 0)
        .map((c) => [makePosition(c, "Long", spot)]);
    },
  },
  short_call: {
    name: "Short Call",
    description: "Single short call (naked)",
    generate(chain, spot) {
      return chain
        .filter((c) => c.side === "call" && c.bid > 0)
        .map((c) => [makePosition(c, "Short", spot)]);
    },
  },
  short_put: {
    name: "Short Put",
    description: "Single short put (naked)",
    generate(chain, spot) {
      return chain
        .filter((c) => c.side === "put" && c.bid > 0)
        .map((c) => [makePosition(c, "Short", spot)]);
    },
  },
  straddle: {
    name: "Long Straddle",
    description: "Long call + long put at same strike",
    generate(chain, spot) {
      const byStrike = new Map();
      chain.forEach((c) => {
        if (!byStrike.has(c.strike)) byStrike.set(c.strike, {});
        byStrike.get(c.strike)[c.side] = c;
      });
      const candidates = [];
      for (const [, opts] of byStrike) {
        if (opts.call?.ask > 0 && opts.put?.ask > 0) {
          candidates.push([
            makePosition(opts.call, "Long", spot),
            makePosition(opts.put, "Long", spot),
          ]);
        }
      }
      return candidates;
    },
  },
};

function netDebit(legs) {
  return legs.reduce(
    (s, l) => s + (l.direction === "Long" ? -1 : 1) * l.premium * l.qty * l.multiplier,
    0,
  );
}

function score(result, returnProb, target) {
  const evWeight = target.optimizeFor === "ev" ? 0.6 : 0.3;
  const probWeight = target.optimizeFor === "probability" ? 0.6 : 0.3;
  const riskWeight = 0.1;
  const ev = result.totalEV;
  const risk = result.maxLoss !== 0 ? ev / Math.abs(result.maxLoss) : 0;
  return ev * evWeight + returnProb * 1000 * probWeight + risk * 100 * riskWeight;
}

export async function optimize(config, onProgress) {
  const { chain, scenarios, spot, rfr, hold, existingPositions = [], target } = config;
  if (!chain?.length || !scenarios?.length) return [];

  const enabledStrategies = Object.entries(STRATEGIES).filter(([key]) =>
    target.strategies.includes(key),
  );

  let totalCandidates = 0;
  let evaluated = 0;
  const results = [];
  const t0 = Date.now();

  log(
    "info",
    `Optimizer: ${enabledStrategies.length} strategies, spot=$${spot}, ${scenarios.length} scenarios`,
  );

  for (const [key, strategy] of enabledStrategies) {
    const candidates = strategy.generate(chain, spot);
    totalCandidates += candidates.length;
    log("info", `${strategy.name}: ${candidates.length} candidates`);

    for (const legs of candidates) {
      const positions = [...existingPositions, ...legs];
      const result = evalPortfolio(positions, scenarios, spot, rfr, hold);
      const nd = netDebit(legs);

      // hard constraints
      if (target.maxDebit > 0 && Math.abs(nd) > target.maxDebit) {
        evaluated++;
        continue;
      }
      if (target.maxLossPct > 0 && result.maxLoss < -((target.maxLossPct / 100) * spot * 100)) {
        evaluated++;
        continue;
      }

      // probability of meeting return target
      const returnProb = result.scResults
        .filter((r) => r.pnl >= (target.minReturnPct / 100) * Math.abs(nd || 1))
        .reduce((s, r) => s + r.prob, 0);

      results.push({
        strategyKey: key,
        strategyName: strategy.name,
        legs,
        result,
        netDebit: nd,
        returnProb,
        score: score(result, returnProb, target),
      });

      evaluated++;
      if (evaluated % 200 === 0 && onProgress) {
        onProgress({ evaluated, total: totalCandidates, phase: strategy.name });
        // yield to UI
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  log(
    "info",
    `Optimizer done: ${evaluated} evaluated, ${results.length} passed constraints, ${elapsed}s`,
  );

  return results.slice(0, 50);
}
