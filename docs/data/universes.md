# Universes — Collection Registry

Living registry of symbol universes we collect and what ingests them. Priority order within each section is top-down — when credit / storage budget binds, work starts at the top.

Related: [sources.md](sources.md) (per-source costs, limits, auth).

---

## Equity options — MarketData.app

**Source:** MarketData.app `/v1/options/chain/?date=`
**Schedule:** nightly 20:00 ET (`collect-nightly.timer` → `collect-nightly.service` → [scripts/collect-nightly.sh](../scripts/collect-nightly.sh))
**Universe file:** [config/universe.txt](../config/universe.txt)
**Storage:** `data/chains/{SYMBOL}-{YYYY-MM}.parquet`
**Budget:** 100k credits/day. Reserve 5k. ~1 credit per symbol-day at default strike limit (50).

Priorities below are for expanding the existing universe (currently 541 symbols). All new adds backfill 2019-01-02 → yesterday unless constrained by listing date.

| #   | Universe                                  | Symbols (est, after dedup with current) | Backfill credits (est) | Source of truth                                                                                                                 | Status               |
| --- | ----------------------------------------- | --------------------------------------: | ---------------------: | ------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | **SOX / PHLX Semiconductor**              |                                   5 new |                    ~9k | iShares SOXX holdings                                                                                                           | **added 2026-04-26** |
| 2   | **KBW Bank Index**                        |                               ~5–10 new |                   ~15k | Wikipedia + Invesco KBWB holdings                                                                                               | todo                 |
| 3   | **OSX / PHLX Oil Service**                |                                ~3–8 new |                   ~10k | Wikipedia + VanEck OIH holdings                                                                                                 | todo                 |
| 4   | **DJ Transportation (DJT)**               |                                ~3–8 new |                   ~10k | Wikipedia + iShares IYT holdings                                                                                                | todo                 |
| 5   | **DJ Utilities (DJU)**                    |                                ~2–5 new |                    ~7k | Wikipedia + iShares IDU holdings                                                                                                | todo                 |
| 6   | **Nasdaq-100 current + historical drift** |                              ~30–50 new |                   ~75k | Wikipedia + cross-check [NDXT repo](https://github.com/fja05680/sp500) style                                                    | todo                 |
| 7   | **S&P 500 current + historical drift**    |                            ~100–150 new |                  ~200k | Wikipedia [List of S&P 500 companies](https://en.wikipedia.org/wiki/List_of_S%26P_500_companies) + cross-check `fja05680/sp500` | todo                 |
| 8   | **S&P 400 Mid-Cap**                       |                                 392 new |                  ~720k | iShares IJH holdings                                                                                                            | **added 2026-04-26** |
| 9   | **S&P 600 Small-Cap**                     |                                 600 new |                  ~1.1M | iShares IJR holdings                                                                                                            | **added 2026-04-26** |
| 10  | **Russell 1000**                          |          ~400 new (85% S&P 500 overlap) |                  ~750k | iShares IWB / FTSE Russell                                                                                                      | todo                 |
| 11  | **Russell 2000**                          |                                1253 new |                  ~2.3M | iShares IWM holdings                                                                                                            | **added 2026-04-26** |

Estimates assume 1 credit/symbol/trading-day × 1833 trading days (2019-01-02 → 2026-04-24) × net-new symbols. Real usage will be lower after dedup and after discounting companies that IPO'd after 2019.

### Current universe breakdown (as of 2026-04-26)

2791 symbols. Bulk additions on 2026-04-26 via [scripts/fetch-index-constituents.ts](../scripts/fetch-index-constituents.ts) from iShares holdings CSVs:

- 541 prior — 496 S&P 500, 20 Nasdaq-100 extras, 4 broad ETFs, 7 sector ETFs, hand-curated oil/airline/freight/ag adds
- 5 new from SOXX (PHLX Semiconductor): ALAB, CRDO, ENTG, MTSI, RMBS
- 392 new from IJH (S&P 400 Mid-Cap)
- 600 new from IJR (S&P 600 Small-Cap, deduped against IJH)
- 1253 new from IWM (Russell 2000, deduped against everything above)

Backfill of the 2250 net-new symbols runs via the existing nightly cron, capped at 100k credits/day with a 5k reserve. Steady state in roughly 4–6 weeks of cron runs.

---

## Futures — Databento

**Source:** Databento `GLBX.MDP3` (CME Group: CME, CBOT, NYMEX, COMEX). Cboe Futures Exchange (`XCBF.PITCH`, e.g. VX) is **not on plan** — see "Uncovered venues" below.
**Pipelines:**

- Historical: `databento_fetch.py` (single pull) + `databento_backfill.py` (batch driver). Canonical path TBD.
- Live: `databento_live.py` (Python sidecar) → NATS → [server/market-data/adapters/databento.ts](../server/market-data/adapters/databento.ts) (Node consumer).
  **Whitelists:**
- Historical pulls: [config/databento-futures.json](../config/databento-futures.json)
- Live subscriptions: [config/databento-live.json](../config/databento-live.json)
  **Storage:** `data/futures/{symbol-lower}/{schema}.parquet`
  **Operations log:** `data/databento/operations.jsonl` (gitignored, append-only). Spend audit via `python -m pipelines.dblog`.

### Plan coverage (CME Group / GLBX only)

| Tier | Schemas                                                      | Historical inclusion | Live inclusion |
| ---- | ------------------------------------------------------------ | -------------------- | -------------- |
| L0   | Status, Statistics, Definitions, Trades, OHLCV (1s/1m/1h/1d) | 15+ years            | yes            |
| L1   | TBBO, BBO, MBP-1                                             | 12 months            | yes            |
| L2   | MBP-10                                                       | 1 month              | no             |
| L3   | MBO, Imbalance                                               | 1 month              | no             |

### Cost guardrails (load-bearing — read this before adding to either JSON)

**Historical:** every chunk preflights via `databento.metadata.get_cost(...)` before fetching. **Hard $0.0 abort** — non-zero cost raises `CostLimitExceeded`. There is no override flag. The cost check is authoritative across all datasets/tiers, so we no longer maintain a hand-rolled inclusion table.

**Live:** the sidecar preflights every subscription at startup (one-time daily-cost estimate). Any non-zero cost refuses to start. No per-message metadata calls — that's why the whitelist exists.

**Whitelist invariant (both files):** only fully approved (symbol, dataset, schema) triples appear. Aspirational entries do not belong in JSON. If a triple ever preflights to non-zero, that's a bug — remove it and update this doc.

**Why this exists:** on **2026-04-24** we incurred a $483.31 charge pulling 6 months of `ohlcv-1s` for VX on `XCBF.PITCH` because the prior pipeline only _warned_ on out-of-tier date ranges and assumed CME-Globex inclusions for all datasets. The cost preflight makes that failure mode structurally impossible.

### Historical — pull_now whitelist

Source of truth: [config/databento-futures.json](../config/databento-futures.json). All on `GLBX.MDP3`.

| Symbol | Name                | Schemas                                     |
| ------ | ------------------- | ------------------------------------------- |
| CL     | Crude Oil           | ohlcv-1s, ohlcv-1m, ohlcv-1d, trades, mbp-1 |
| NG     | Natural Gas         | ohlcv-1s, ohlcv-1m, ohlcv-1d, trades        |
| ES     | E-mini S&P 500      | ohlcv-1s, ohlcv-1m, ohlcv-1d, trades        |
| NQ     | E-mini Nasdaq 100   | ohlcv-1s, ohlcv-1m, ohlcv-1d, trades        |
| YM     | E-mini Dow          | ohlcv-1s, ohlcv-1m, ohlcv-1d, trades        |
| RTY    | E-mini Russell 2000 | ohlcv-1s, ohlcv-1m, ohlcv-1d, trades        |

Plus `candidates` tier (RB, HO, BZ, GC, SI, HG, PL, PA, ZB, ZN, ZF, ZT, UB, ZC, ZS, ZW, ZM, ZL, 6E, 6J, 6B, MES, MNQ) for promotion when storage budget allows.

### Live — subscriptions

Source of truth: [config/databento-live.json](../config/databento-live.json). All on `GLBX.MDP3`. Sidecar publishes to `marketdata.live.databento.<SYMBOL>` and `marketdata.live.databento.heartbeat`.

| Schema   | Symbols                                         |
| -------- | ----------------------------------------------- |
| trades   | ES.c.0, NQ.c.0, CL.c.0, NG.c.0                  |
| mbp-1    | ES.c.0, NQ.c.0, CL.c.0                          |
| ohlcv-1s | ES.c.0, NQ.c.0, CL.c.0, NG.c.0, YM.c.0, RTY.c.0 |

### Uncovered venues / parked symbols

Tracked here in prose, **not in JSON**. Migrating into the JSON requires both (a) the venue is added to the plan and (b) the cost preflight returns $0.

- **VX (VIX futures) on `XCBF.PITCH`** — Cboe Futures Exchange is a separate commercial relationship from CME-Globex. _No_ XCBF schema is included in the standard futures plan; every byte is metered. Status: parked. We do have `data/futures/vx/ohlcv_1s.parquet` (40M, 6mo) on disk from the 2026-04-24 incident — this is the data we paid $483.31 for and should mine before pulling more.
- **ICE / Eurex / EEX** — also separate commercial relationships. Not in plan. No code path exists yet.

### On-disk inventory (as of 2026-04-25)

From `data/futures/`. Run `python -m pipelines.dblog` for the live view.

| Symbol    | Dataset        | Schema       |       Size |      Rows |        Cost | Notes                               |
| --------- | -------------- | ------------ | ---------: | --------: | ----------: | ----------------------------------- |
| CL        | GLBX.MDP3      | ohlcv-1s     |      128MB |     10.8M |       $0.00 |                                     |
| CL        | GLBX.MDP3      | ohlcv-1m     |       25MB |      1.6M |       $0.00 |                                     |
| CL        | GLBX.MDP3      | ohlcv-1h     |      0.7MB |       29K |       $0.00 |                                     |
| CL        | GLBX.MDP3      | ohlcv-1d     |      0.1MB |      3.1K |       $0.00 |                                     |
| CL        | GLBX.MDP3      | trades       |      462MB |     21.2M |       $0.00 |                                     |
| CL        | GLBX.MDP3      | mbp-1        |      1.6GB |     69.9M |       $0.00 |                                     |
| ES        | GLBX.MDP3      | ohlcv-1s     |      261MB |     21.9M |       $0.00 |                                     |
| NG        | GLBX.MDP3      | ohlcv-1s     |       74MB |      6.1M |       $0.00 |                                     |
| NQ        | GLBX.MDP3      | ohlcv-1s     |      332MB |     23.6M |       $0.00 |                                     |
| RTY       | GLBX.MDP3      | ohlcv-1s     |      160MB |     12.4M |       $0.00 |                                     |
| YM        | GLBX.MDP3      | ohlcv-1s     |      156MB |     12.0M |       $0.00 |                                     |
| **VX**    | **XCBF.PITCH** | **ohlcv-1s** |   **42MB** |  **3.7M** | **$483.31** | 2026-04-24 incident; do not re-pull |
| **Total** |                |              | **~3.2GB** | **~183M** | **$483.31** |                                     |

### Known follow-ups

- **Continuous vs. specific contract** — current `.c.0` gives front-month calendar roll. For term-structure analytics we may later want `.c.1`, `.c.2`, etc., or specific contract months.
- **systemd units** — `databento-backfill.service` (one-shot, on demand) and `databento-live.service` (long-running). TBD.
- **Schwab `/pricehistory` complement** — daily/minute equity bars; see Equity candles section below.

---

## Equity candles — Schwab (scope TBD)

**Source:** Schwab `/pricehistory` ([schwab.ts:477](../server/market-data/adapters/schwab.ts#L477))
**Cost:** Free with account. Daily or minute frequency.
**Status:** not scheduled yet — pending decision on scope.

**Open question:** What complements our existing data? Options-chain coverage via MarketData.app already gives us underlying prices embedded in every chain snapshot, so daily closes on our 541-symbol universe are redundant. Schwab candles are most useful for:

- **Low-liquidity or non-optionable equities** — names not in the options universe but potentially relevant as strategy features (small caps, recent IPOs, index rebalance adds pre-options-listing).
- **Intraday minute bars** — for realized-vol / microstructure features that the daily chain snapshots can't provide. MarketData.app doesn't expose intraday equity candles (only chains).

Parked until a concrete strategy needs sub-daily equity series.

---

## IBKR — parked

Historical equity/futures bars are possible via `reqHistoricalData` (6 req/10s, 50 msg/s). Not currently wired through any ingestion path. This doc will gain an IBKR section once a strategy or backtest justifies the bridge work.

---

## Changelog

- **2026-04-26** — equity options universe expanded 541 → 2791 symbols. Tiers 1 (SOX), 8 (S&P 400), 9 (S&P 600), 11 (Russell 2000) ingested from iShares holdings via new `scripts/fetch-index-constituents.ts`. Nightly cron drains the new backlog under existing 100k credits/day cap.
- **2026-04-24** — initial registry. Current equity options universe at 541 symbols, CL futures backfilled, all other universes todo.
