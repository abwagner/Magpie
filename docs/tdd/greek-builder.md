# Greek Builder — Technical Design Document

The LP solve lives in the [`qf-optimizer`][qf-opt] Rust crate. Greek
Builder (browser) calls into it via WASM (`src/lib/wasm/qf_optimizer/`).
The §3 design below is the live implementation; §1.3 / §1.4 are kept as
design history for the prior JS-solver behaviour.

[qf-opt]: ../../core/qf-optimizer/

## 1. Current System Overview

The codebase has two independent optimization systems and a manual staging flow.
This section documents exactly how each works today.

### 1.1 Manual Staging (ChainPicker)

**File**: `src/components/ChainPicker.jsx`

The simplest flow. User loads a chain, clicks +/- buttons on individual contracts
to stage trades. No optimization — purely manual position construction.

**Data flow**:

```
User enters symbol → api.stockQuote() + api.expirations()
                   → user picks expiration
                   → api.chain(symbol, expiration, strikeLimit)
                   → chain displayed in table
                   → user clicks +/- → stageContract(opt, "long"|"short")
                   → staged[] array grows
                   → stagedNet computed (Σ greeks × qty)
                   → generatePayoffCurve() → P&L chart
```

Each staged entry stores **per-option greeks** (unflipped — call delta is ~+0.5,
put delta is ~-0.5) with a signed quantity (positive=long, negative=short).
The NET row multiplies: `stagedNet.delta = Σ opt.delta × quantity`.

### 1.2 Strategy Template Optimizer (optimizer.js)

**File**: `src/lib/optimizer.js`

An EV-based optimizer that enumerates all valid combinations of predefined
strategy templates, evaluates each against scenario probabilities, and ranks
by a composite score.

#### 1.2.1 Strategy Templates

Eight templates, each with a `generate(chain, spot)` function that returns
an array of candidate leg combinations:

| Template           | Legs | How candidates are generated                                                   |
| ------------------ | ---- | ------------------------------------------------------------------------------ |
| `bull_call_spread` | 2    | Every pair (i,j) of calls where i.strike < j.strike                            |
| `bear_put_spread`  | 2    | Every pair (i,j) of puts where i.strike < j.strike                             |
| `iron_condor`      | 4    | Nested loop: every pair of OTM puts × every pair of OTM calls (capped at 5000) |
| `long_call`        | 1    | Each call with ask > 0                                                         |
| `long_put`         | 1    | Each put with ask > 0                                                          |
| `short_call`       | 1    | Each call with bid > 0                                                         |
| `short_put`        | 1    | Each put with bid > 0                                                          |
| `straddle`         | 2    | Each strike that has both a call and a put with ask > 0                        |

Each leg is a position object:

```
{
  type: "Call" | "Put",
  direction: "Long" | "Short",
  qty: 1,
  multiplier: 100,
  strike, premium, dte, iv
}
```

Premium = ask for Long, bid for Short.

#### 1.2.2 Evaluation

For each candidate combination, the optimizer:

1. Combines legs with any existing positions
2. Calls `evalPortfolio(positions, scenarios, spot, rfr, hold)` (from `eval.js`)
3. `evalPortfolio` computes P&L under each scenario:
   - Future spot = `spot × (1 + scenario.priceMove)`
   - New IV = `iv + scenario.iv_shift`
   - New time = `(dte - hold) / 365`
   - Future price = `BS.call/put(futureSpot, strike, rfr, newTime, newIV)`
   - P&L per leg = `direction × qty × multiplier × (futurePrice - premium)`
   - Sum across legs and scenarios
4. Returns `{ totalEV, maxLoss, maxGain, scResults[] }`

#### 1.2.3 Filtering and Scoring

Hard constraints (skip if violated):

- `|netDebit| > maxDebit` → skip
- `maxLoss < -(maxLossPct/100 × spot × 100)` → skip

Soft scoring:

```
score = EV × evWeight + returnProb × 1000 × probWeight + risk × 100 × riskWeight
```

Where:

- `risk = EV / |maxLoss|`
- `returnProb = Σ prob_i where pnl_i >= minReturnPct × |netDebit|`
- Weights: 0.6/0.3/0.1 (EV mode) or 0.3/0.6/0.1 (probability mode)

Returns top 50 candidates sorted by score.

#### 1.2.4 Key limitation

This optimizer does NOT target greeks at all. It optimizes expected P&L under
user-defined scenarios. Greeks are not part of the scoring function.

### 1.3 LP Optimizer (`solveLP` / `optimizePortfolio` — design history)

`solveLP` and `optimizePortfolio` were never wired into a live caller;
the only browser consumer of the LP layer is the Greek Builder Web Worker
(§1.4), which goes through `solveGreekBuilder`. This subsection is kept
as design history. The live LP solve lives in [`core/qf-optimizer/`][qf-opt]
(see §3 + §A.7).

An integer linear programming optimizer originally drafted for the
OptimizerTab. This one DOES target greeks, but it requires a model
probability distribution to work.

#### 1.3.1 Pipeline (OptimizerTab)

The full pipeline that feeds the LP optimizer:

```
1. Load chain data from API
2. Build vol surface (cubic spline in delta space)
3. Extract market PDF via Breeden-Litzenberger:
     q(K) = e^(rT) × [C(K-δ) - 2C(K) + C(K+δ)] / δ²
4. Build model PDF:
   a. Calibrate SABR to call IV smile → generate SABR-smoothed chain
   b. Extract SABR PDF from smoothed vol surface
   c. Blend in event overlays (tail scenarios with user-defined probabilities)
5. Compute edge = modelPDF - marketPDF at each strike
6. Edge → target greeks via edgeToGreeks():
     targetDelta = Σ K × edge(K) × δK / spot
     targetVega  = Σ (K-spot)² × edge(K) × δK / spot² × 100
7. LP solve: maximize expectedPnL subject to greek constraints
```

#### 1.3.2 Candidate generation (`generateCandidates`)

For each contract in the chain, generates two candidates (long and short):

```
for each contract:
  skip if IV <= 0
  for direction in [Long, Short]:
    premium = ask (Long) or bid (Short)
    greeks = BS.delta/gamma/theta/vega(spot, strike, rfr, T, iv, type) × dir
    expectedPnL = Σ over modelPDF: prob(K) × dir × (intrinsic(K) - premium) × multiplier
    cost = dir × premium × multiplier
```

**Critical detail**: Greeks are computed from scratch via Black-Scholes using
the contract's IV — they are NOT taken from the chain data. They are also
**multiplied by the contract multiplier** (100 for equities), so a delta of
0.5 becomes 50.

#### 1.3.3 LP formulation (`solveLP`)

```
maximize: Σ expectedPnL_i × x_i

subject to:
  targetDelta - deltaTol <= Σ delta_i × x_i <= targetDelta + deltaTol
  targetVega  - vegaTol  <= Σ vega_i  × x_i <= targetVega  + vegaTol
  (optional) targetGamma ± gammaTol
  (optional) targetTheta ± thetaTol
  Σ |cost_i| × x_i <= maxBudget
  Σ x_i <= maxPositions
  x_i ∈ {0, 1, 2, ...}  (integers)
```

Objective: maximize expected P&L (from the model PDF).
Constraints: keep portfolio greeks within tolerance of targets.
Budget: uses `Math.abs(cost)` — both long and short positions consume budget.

The solver library is `javascript-lp-solver` (simplex + branch-and-bound ILP).

### 1.4 Greek Builder (`solveGreekBuilder`)

`solveGreekBuilder` lives in [`src/lib/lp-optimizer.js`][lp-opt]; the LP
solve it dispatches to is [`qf-optimizer`][qf-opt]'s WASM `solve()`,
injected as the third parameter by [`src/lib/greek-builder-worker.ts`][gbw].
The bugs documented in §1.4.2 below are fixed; the design in §3 is the
live behaviour. The subsection is retained for context on the original
solver model.

[lp-opt]: ../../src/lib/lp-optimizer.js
[gbw]: ../../src/lib/greek-builder-worker.ts

The mode that lets users directly target greek profiles without needing
the full model PDF pipeline.

#### 1.4.1 How the original JS-solver model worked

Each greek gets a **mode**: max, min, flat, bound, or any.

- **max** → positive weight in composite LP objective (maximize)
- **min** → **BUG**: wired as negative weight in LP objective (pushes greek
  negative). Should be a near-zero constraint instead.
- **flat** → auto-bounded near zero using `MIN_BOUNDS` constant (correct behavior)
- **bound** → user-provided min/max range
- **any** → unconstrained (auto-constraints may upgrade)

Candidates are generated from chain data directly (not from BS recalculation).
Greeks come from the chain's own delta/gamma/theta/vega fields, flipped by
direction (× -1 for short).

#### 1.4.2 What goes wrong

**Problem 1: "Min" mode is wired as an LP objective, not a constraint.**
Users expect "min delta" = "delta near zero." The LP interprets it as "push
delta as negative as possible." When all four greeks are max/min (all
objectives, zero constraints), the LP has no structural guidance and produces
a single-leg degenerate solution.

The fix: "Min" should map to the same near-zero constraint that "Flat" uses
today. Post-fix, "Min" and "Flat" are the same behavior, so we collapse them
into one mode. Final modes: **Max / Min / Bound / Any** (4 modes, not 5).

**Problem 2: Budget uses raw cost, not margin.**
`Math.abs(cost)` is just `premium × 100`. For short options, actual capital
required is premium + SPAN margin charge, which varies with OTM distance and
can be much larger than the premium. The LP has no awareness of margin, so it
underestimates the capital needed for short positions.

A client-side SPAN estimator already exists (`src/lib/margin.js`) with
calibrated parameters for both equity and futures options. The LP should use
this to compute per-candidate margin requirements.

**Problem 3: Hard minimum leg count is wrong.**
The `posMin >= 2` constraint forces at least 2 total contracts. This is
artificial — the decision to add another leg should be driven by whether it
improves the objective while staying within constraints (budget, margin, greek
bounds). With proper flat bounds on delta, multi-leg positions emerge naturally
(a single call violates delta bounds, so the solver must add puts).

## 2. Greek Primer (for the optimizer context)

### 2.1 What the greeks mean for position construction

| Greek     | Per-option sign      | Meaning               | Long =                           | Short =                   |
| --------- | -------------------- | --------------------- | -------------------------------- | ------------------------- |
| **Delta** | Calls: +, Puts: -    | Directional exposure  | Bullish (calls) / Bearish (puts) | Inverse                   |
| **Gamma** | Always +             | Curvature / convexity | Profits from big moves           | Profits from stability    |
| **Theta** | Always - (for longs) | Time decay cost       | Pay theta daily                  | Collect theta daily       |
| **Vega**  | Always +             | Volatility exposure   | Profits from vol increase        | Profits from vol decrease |

Key relationships:

- **Gamma and theta are linked**: you cannot have positive gamma without paying
  theta (and vice versa). A straddle has high gamma and pays high theta.
- **Delta-neutral** structures require both calls and puts (straddle/strangle)
  or long+short of the same type (vertical spread).
- **ATM options** have the highest gamma, theta, and vega per dollar.

### 2.2 How greeks flow through the chain data

The chain API returns per-option greeks:

```
{ side: "call", strike: 100, delta: 0.52, gamma: 0.048, theta: -0.035, vega: 0.18, ... }
```

These are **per-option** values (not per-contract). For 1 contract (100 shares):

- Position delta = option delta × quantity (signed)
- Position gamma = option gamma × quantity (signed)
- etc.

The staged NET row computes: `Σ (option greek × quantity)` across all legs.

## 3. Proposed Design

One code change: "Min" mode currently maps to a negative LP objective weight.
It should instead map to a near-zero constraint (auto-bounds). Everything
else in the mode system is correct.

### 3.1 Mode definitions

Four modes per greek. Only **Max** contributes to the LP objective — all
others are constraints or ignored.

| Mode      | LP role                                           | What it does                                                                                                              |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Max**   | Positive weight in normalized composite objective | Maximize this greek. Can apply to multiple greeks simultaneously.                                                         |
| **Min**   | Constraint: auto-bounded near zero                | Keep this greek near zero. Uses default bounds from `MIN_BOUNDS`.                                                         |
| **Bound** | Constraint: user-provided min/max                 | Keep this greek in a custom range. For directional exposure, use a negative range (e.g., delta [-1.0, -0.2] for bearish). |
| **Any**   | No constraint, no objective                       | Unconstrained. Auto-constraints may upgrade to Min if needed.                                                             |

### 3.2 Composite objective

When multiple greeks are Max, the LP objective is a normalized weighted sum:

```
maximize Σ (greek_i / scale_i) × x_i     for all greeks where mode = "max"
```

`scale_i = max(|greek_i|)` across all candidates — normalizes each greek to
[-1, 1] so they contribute equally regardless of magnitude (delta ~0.5 vs
gamma ~0.01).

### 3.3 Auto-constraints

When key greeks are left as "Any", apply defaults to prevent degeneracy:

| Condition                                    | Action              |
| -------------------------------------------- | ------------------- |
| Any non-delta greek is Max, delta is Any     | Upgrade delta → Min |
| Delta is Max (directional), gamma is Any     | Upgrade gamma → Min |
| Theta is Max (selling premium), gamma is Any | Upgrade gamma → Min |

### 3.4 Default bounds (Min mode)

When a greek is set to Min, these bounds are applied automatically.
Per-contract aggregate scale (matches the NET row in staged trades):

| Greek | Min bounds    | Rationale                    |
| ----- | ------------- | ---------------------------- |
| Delta | [-0.20, 0.20] | ~2 ATM options net near zero |
| Gamma | [-0.05, 0.05] | ATM gamma ≈ 0.01-0.05        |
| Theta | [-0.10, 0.10] | ATM theta ≈ -0.03 to -0.05   |
| Vega  | [-0.30, 0.30] | ATM vega ≈ 0.10-0.20         |

### 3.5 Budget and margin

**No hard minimum leg count.** The solver decides how many legs to use based
on what optimizes the objective within constraints. Min bounds on delta
naturally force multi-leg structures (a single call can't satisfy delta near
zero — the solver must add offsetting positions).

#### 3.5.1 Per-leg margin (pass 1)

Each candidate's cost to the LP is its estimated margin requirement:

**Long option**: margin = `premium × multiplier` (premium paid)

**Short option (equity, Reg-T)**:

```
nakedMargin = max(
  0.20 × underlying - OTM_amount,
  0.10 × strike
) × multiplier + premium × multiplier
```

**Short option (futures, SPAN)**: Uses existing `shortOptionBP()` from
`src/lib/margin.js` — SPAN charge scales with OTM distance, calibrated
from ThinkorSwim.

The `margin.js` module needs a new `equityShortOptionBP(strike, spot,
premium, qty, multiplier, type)` function for Reg-T margin, and the builder
passes an `assetClass` flag to select the right calculation.

#### 3.5.2 Portfolio margin reconciliation (pass 2)

Per-leg margin is conservative — it doesn't account for spread netting. A
short 105 call with a long 110 call has $500 max-loss margin, not $2,000+
naked margin.

After the LP solves, compute the actual portfolio margin:

1. **Group legs into spreads**: Match short legs with long legs of the same
   type at adjacent strikes. Each matched pair is a vertical spread with
   `margin = |strike_diff| × multiplier`.
2. **Naked remainder**: Any short leg not matched to a long leg keeps its
   per-leg naked margin.
3. **Compare**: If actual portfolio margin < per-leg margin, there is freed
   capital = `per_leg_total - portfolio_total`.
4. **Re-solve**: If freed capital > 0, re-run the LP with
   `maxBudget += freed_capital`. Repeat until stable (typically 1-2 passes).

```
Pass 1:
  LP solves with per-leg margin → result has 4 legs
  Per-leg margin sum: $8,200
  Portfolio margin (spread-netted): $1,000
  Freed capital: $7,200

Pass 2:
  Re-solve with maxBudget += $7,200
  New result may add more legs
  Re-check portfolio margin → converged? Done.
```

The portfolio margin function `computePortfolioMargin(positions, spot,
assetClass)` will live in `src/lib/margin.js` alongside the existing
per-position functions.

#### 3.5.3 LP budget constraint

```
Σ margin_i × x_i <= maxBudget     (per-leg margin, adjusted by two-pass)
Σ x_i <= maxLegs                  (total contracts)
```

Net cost (debit/credit) is tracked in totals but is NOT a constraint —
margin is the real capital limiter.

### 3.6 Candidate generation

For each option in the chain, generate a long candidate (buy at ask) and a
short candidate (sell at bid). Greeks come from the chain data directly,
flipped by direction. Margin computed per-candidate.

```
candidate.delta  = chainOption.delta × dir
candidate.gamma  = chainOption.gamma × dir
candidate.theta  = chainOption.theta × dir
candidate.vega   = chainOption.vega  × dir
candidate.cost   = dir × price × multiplier
candidate.margin = (dir > 0)
  ? price × multiplier
  : shortOptionBP(strike, spot, price, 1, multiplier, type, assetClass)
```

### 3.7 Full LP model

```
Decision variables:
  x_i ∈ {0, 1, 2, ...}   for each candidate i

Objective:
  maximize Σ objValue_i × x_i
  where objValue_i = Σ (cand[greek] / scale)   for each Max-mode greek

Constraints:
  For each Min-mode greek g:
    MIN_BOUNDS[g].min <= Σ g_i × x_i <= MIN_BOUNDS[g].max

  For each Bound-mode greek g:
    user.bounds[g].min <= Σ g_i × x_i <= user.bounds[g].max

  Margin (per-leg, pass 1):
    Σ margin_i × x_i <= maxBudget

  Position count:
    Σ x_i <= maxLegs
```

After pass 1, compute portfolio margin with spread netting. If freed capital
exists, re-solve with increased budget (see §3.5.2). Typically converges in
1-2 passes.

### 3.8 Presets

| Preset            | Δ   | Γ   | Θ   | V   | Expected result              |
| ----------------- | --- | --- | --- | --- | ---------------------------- |
| Max Γ Neutral     | Min | Max | Min | Min | Long straddle/strangle       |
| Max Γ, Min Θ Drag | Min | Max | Max | Min | Straddle optimized for theta |
| Sell Premium      | Min | Min | Max | Min | Iron condor / short strangle |
| Long Vol          | Min | Min | Min | Max | Long straddle/strangle       |
| Bullish           | Max | Min | Any | Any | Bull call spread             |

### 3.9 Result → staged trades

Each solver position maps to a staged entry:

```
{
  side: candidate.side,           // "call" | "put"
  strike: candidate.strike,
  expiration: selectedExpiration,
  premium: candidate.premium,
  quantity: (long ? +qty : -qty),  // signed
  delta: candidate.rawDelta,       // per-option, unflipped
  gamma: candidate.rawGamma,
  theta: candidate.rawTheta,
  vega: candidate.rawVega,
}
```

The staged NET row then computes `Σ rawGreek × quantity`, which equals the
LP's constraint values (since `rawGreek × ±qty = greekFlipped × qty`).

## 4. Files

The LP solver itself is Rust; the JS orchestration that builds the LP
model + adapts the result lives in `src/lib/`.

| File                                     | Role                                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/qf-optimizer/`                     | Rust LP/MIP crate. `LpModel`, `solve()`. HiGHS backend native, `microlp` backend wasm32.                                                             |
| `core/qf-optimizer/src/wasm.rs`          | `wasm-bindgen` wrapper. Built via `npm run build:wasm` to `src/lib/wasm/qf_optimizer/`.                                                              |
| `core/qf-optimizer/tests/equivalence.rs` | 7 JSON-fixture cross-checks that pin the solver's results to a reference set.                                                                        |
| `src/lib/wasm/qf_optimizer/`             | Committed wasm-pack output (~196 KB). Frontend devs don't need wasm-pack for `npm run dev`; CI's rust workflow rebuilds.                             |
| `src/lib/greek-builder-worker.ts`        | Web Worker. Loads WASM, adapts result shape to the `Solve(model)` contract, injects as `solveGreekBuilder`'s `solver` parameter.                     |
| `src/lib/lp-optimizer.js`                | JS orchestration: `solveGreekBuilder`, `solveGreekLP`, `applyAutoConstraints`, `generateCandidates`, `labelStrategy`, `GREEK_BUILDER_PRESETS`.       |
| `src/lib/margin.js`                      | `candidateMargin`, `computePortfolioMargin` (spread netting), `equityShortOptionBP` (Reg-T), `shortOptionBP` (SPAN), `longOptionBP`.                 |
| `src/components/ChainPicker.tsx`         | Greek Builder UI panel: mode dropdowns, presets, Build handler (posts to the worker).                                                                |
| `src/lib/__tests__/lp-optimizer.test.js` | JS-orchestration tests: `generateCandidates`, `applyAutoConstraints`, `labelStrategy`, `GREEK_BUILDER_PRESETS`. Solver coverage is on the Rust side. |
| `src/lib/bs.js`                          | Black-Scholes / Black-76 pricing + greeks (unchanged).                                                                                               |
| `src/lib/optimizer.js`                   | Strategy template optimizer (unchanged, separate system).                                                                                            |
| `src/lib/eval.js`                        | Portfolio evaluation under scenarios (unchanged).                                                                                                    |

## 5. Verification

The verification stack is multi-layer:

**Rust crate** (`core/qf-optimizer/`):

1. `cargo test -p qf-optimizer --locked` — unit tests + fixture equivalence tests + doctests.
2. `cargo clippy -p qf-optimizer --all-targets --all-features --locked -- -D warnings` — clean.
3. `cargo build -p qf-optimizer --target wasm32-unknown-unknown --no-default-features --features wasm` — wasm32 compiles.

**Frontend** (Web Worker + WASM):

4. `npm test` — vitest suite; the JS-orchestration tests in
   `src/lib/__tests__/lp-optimizer.test.js` exercise the
   non-solver code paths.
5. `npm run typecheck` + `npm run build` — clean.
6. Manual: open Greek Builder in browser, pick "Max Γ Neutral" →
   produces ≥2 distinct legs, delta near 0, positive gamma. Worker
   postMessage payload carries `solveMs` + `solverBackend: "wasm"`.
7. Manual: tight contradictory bounds → `{ feasible: false, reason: "No feasible solution …" }`.

**Perf**: WASM solves a realistic Greek-Builder model (~200 variables) in
1-2 ms, well under any perceptible UX threshold. The marshaling floor for
sub-millisecond solves is the bottleneck, not the LP solve itself.

## 6. Observability

Per the [observability framework](observability.md). The Greek Builder
runs entirely client-side (Web Worker), so it does **not** feed the
central JSON log stream that the server-side components use. Instead,
observability today comes through three surfaces:

| Surface              | Mechanism                                                                                    | Carried fields                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Worker `postMessage` | `greek-builder-worker.ts` augments the solve result with timing + backend tags               | `solveMs` (wall time of the WASM `solve()` call), `solverBackend` (`"wasm"`), `feasible`, `reason`                          |
| Browser console      | `log()` shim in `src/lib/log.js` writes structured lines to `console`                        | `Greek builder: <label>, <n> contracts, Δ=…, Γ=…, Θ=…, V=…, margin=$…`; `Greek builder pass 2: freed $X via spread netting` |
| Rust panic hook      | `installPanicHook()` (called once after WASM `init()`) routes Rust panics to `console.error` | Standard Rust panic message + Rust backtrace if `RUST_BACKTRACE` was set at compile time                                    |

The events the Web Worker would emit if it had access to the central
log stream (proposed; not implemented):

| Event                              | Payload (key fields)                                                                          | Emitted when                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `greek_builder.solve.started`      | `correlation_id`, `chain_size`, `modes`, `max_budget`, `max_legs`                             | Worker receives a Build message.                                                                |
| `greek_builder.solve.completed`    | `correlation_id`, `solve_ms`, `feasible`, `n_legs`, `contracts`, `Δ`, `Γ`, `Θ`, `V`, `margin` | WASM `solve()` returns and result formatting is done.                                           |
| `greek_builder.solve.infeasible`   | `correlation_id`, `solve_ms`, `reason`                                                        | LP returned `feasible: false`.                                                                  |
| `greek_builder.margin.pass2_freed` | `correlation_id`, `freed_usd`, `per_leg_margin`, `portfolio_margin`                           | Pass 2 portfolio-margin reconciliation freed enough capital to warrant a re-solve.              |
| `greek_builder.wasm.init`          | `wasm_bytes`, `init_ms`                                                                       | One-shot per worker boot when WASM is loaded. Sampled at `info` only on first init per session. |
| `greek_builder.wasm.panic`         | `panic_message`, `wasm_module_version`                                                        | Rust panic propagated through `console_error_panic_hook`.                                       |

Wiring these to the central log requires a client-side telemetry
endpoint (not yet implemented). When that lands, the worker forwards
the events above as JSON over fetch; the server appends them to the
same JSON line stream the rest of the system writes to. Until then,
operators rely on the worker postMessage payload and browser console
for diagnostics.

---

## Appendix A: Math Reference

The optimizer pipeline above leans on a handful of standard options-pricing
constructs. This section is the reference for how each one is computed and
why it matters. It is not implementation-specific — these are the underlying
math models used in `src/lib/probability.js`, `vol-surface.js`, `sabr.js`,
`rv-analysis.js`, `event-model.js`, and `edge-greeks.js`.

### Pipeline

```
Chain Data → Vol Surface → Market PDF → Edge Heatmap → Target Greeks → Optimal Positions
                              ↑
                        Model PDF (SABR, RV, Events)
```

### A.1 Breeden-Litzenberger

The risk-neutral PDF implied by option prices. For European options the PDF
of the terminal asset price `S` at expiry `T` is the second partial
derivative of call prices with respect to strike:

```
q(K) = e^(rT) × ∂²C / ∂K²
```

Discrete approximation (finite differences):

```
P(S = K) ≈ e^(rT) × [C(K-δ) - 2C(K) + C(K+δ)] / δ²
```

where `C(K)` is the call price at strike `K` and `δ` is the strike spacing.
This gives a non-parametric, model-free probability distribution directly
from market prices.

**Why it matters:** the Market PDF is the market's collective belief about
future outcomes — fat tails, skew, and kurtosis embedded in option prices.
The LP optimizer uses it as the baseline distribution that the Model PDF
deviates from.

### A.2 Vol Surface

Raw implied vols from the chain are noisy. The smooth surface is built in
three steps:

1. **Delta space** — fit the vol smile per expiry using cubic spline
   interpolation in delta space (not strike space). Delta normalizes for
   moneyness, which handles changing ATM levels better.
2. **Flat forward variance** — interpolate across expiries using total
   variance (`σ²T`). This keeps calendar spread prices non-negative
   (no arbitrage).
3. **Arbitrage-free constraints** — calendar spreads (`σ²T` must increase
   with `T`) and butterfly spreads (`∂²C/∂K² ≥ 0`) must be non-negative.

### A.3 SABR Model

Stochastic Alpha Beta Rho — used for smoothing the per-expiry vol smile and
producing a clean Model PDF.

| Parameter | Meaning                                                 |
| --------- | ------------------------------------------------------- |
| α (alpha) | ATM vol level                                           |
| β (beta)  | Backbone / CEV exponent (typically fixed at 0.5 or 1.0) |
| ρ (rho)   | Correlation between asset and vol (drives skew)         |
| ν (nu)    | Vol-of-vol (drives smile curvature)                     |

**Hagan approximation** gives a closed-form formula for SABR implied vol,
enabling fast least-squares calibration against market IVs.

**Strengths:** fast per-expiry calibration, intuitive parameters, good for
interpolating the smile. **Limitations:** per-expiry only (no term
structure), can produce negative densities in extreme wings.

### A.4 Realized vs Implied Volatility

**Vol Risk Premium (VRP):** IV consistently exceeds realized vol because
option sellers demand compensation for uncertainty. `VRP = IV - RV` is
typically positive.

**Estimators:**

- **Close-to-close** — standard deviation of log returns × √252
- **Parkinson** — uses high-low range, more efficient than close-to-close

**Application:** if we believe future RV will be lower than current IV
(the typical case), the market-implied distribution is too wide. Using RV
as the vol input produces a narrower Model PDF, revealing overpriced
options.

### A.5 Event Overlays

Mixture distribution for discrete catalysts (earnings, FOMC, geopolitical):

```
P(S) = P(event) × P(S | event) + P(no event) × P(S | no event)
```

Each event has a probability and price impact (mean return + conditional
vol). The system blends conditional log-normal distributions with the base
(market-implied) distribution to form the final Model PDF.

### A.6 Edge-to-Greeks Mapping

Edge is `modelPDF − marketPDF` at each strike. Different shapes of edge
map to different target Greeks:

| Edge Type      | Measurement               | Target Greek  | Trade Expression     |
| -------------- | ------------------------- | ------------- | -------------------- |
| Directional    | E_model[S] vs E_market[S] | Delta         | Calls, puts, futures |
| Volatility     | Var_model vs Var_market   | Vega, Gamma   | Straddles, strangles |
| Skew           | Asymmetry in edge         | Skew delta    | Risk reversals       |
| Kurtosis       | Wing vs center edge       | Wing gamma    | Butterflies, condors |
| Term structure | Edge variation by DTE     | Calendar vega | Calendars, diagonals |

Concrete formulas used in `edge-greeks.js`:

```
targetDelta = Σ K × edge(K) × δK / spot
targetVega  = Σ (K-spot)² × edge(K) × δK / spot² × 100
```

### A.7 LP Optimization

Portfolio Greeks are additive (linear in position quantities), which makes
the optimization a linear program. Integer constraints ensure
whole-contract positions.

```
Maximize: E[P&L] = Σ P(scenarioᵢ) × P&L(scenarioᵢ)

Subject to:
  Δ_portfolio ∈ [target_Δ ± tolerance]
  ν_portfolio ∈ [target_v ± tolerance]
  total_cost ≤ budget
  contract_count ≤ max_legs
```

**Implementation:** the LP/MIP solve lives in the [`qf-optimizer`][qf-opt]
Rust crate via [`good_lp`][good-lp]'s API. Backend is compile-time gated —
native builds use HiGHS (vendored C++); the wasm32 build uses `microlp`
(HiGHS doesn't cross-compile to wasm32). Same return shape across backends.

[good-lp]: https://docs.rs/good_lp
[qf-opt]: ../../core/qf-optimizer/

**Pattern labeling:** after the LP solver finds optimal quantities, the
system identifies known strategy patterns (bull call spread, iron condor,
straddle, etc.) in the result. See `labelStrategy` in `lp-optimizer.js`.

### A.8 Glossary

| Term         | Definition                                                                   |
| ------------ | ---------------------------------------------------------------------------- |
| PDF          | Probability density function — distribution of future prices                 |
| CDF          | Cumulative distribution function — P(S ≤ K)                                  |
| Risk-neutral | Probability measure where all assets earn the risk-free rate in expectation  |
| Moneyness    | Strike / Spot — how far in/out of the money                                  |
| Vol surface  | Implied vol as a function of (strike, time-to-expiry)                        |
| Edge         | `modelPDF − marketPDF` — where our view differs from the market              |
| Greeks       | Sensitivities: Delta (price), Gamma (delta change), Theta (time), Vega (vol) |
| VRP          | Volatility risk premium — IV minus realized vol                              |
| ATM          | At-the-money — strike ≈ spot                                                 |
| OTM          | Out-of-the-money — calls with strike > spot, puts with strike < spot         |
| ILP          | Integer linear programming — LP with integer-valued variables                |
