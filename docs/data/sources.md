# Data Sources — Operational Reference

Covers costs, rate limits, credit budgets, auth setup, and practical notes for each market data source. This is a living document — update it when subscriptions or API behavior changes.

For the system design of how these sources are used, see: [Data Plane TDD](data-plane.md). For the live cron schedule that actually pulls this data on the home server (job names, schedules, container ops), see [`data/CRON.md`](../../data/CRON.md).

---

## Source Summary

| Source             | Instruments                        | Live quotes             | Historical chains                      | Order placement | Cost              |
| ------------------ | ---------------------------------- | ----------------------- | -------------------------------------- | --------------- | ----------------- |
| **MarketData.app** | Equity options                     | Yes                     | Yes (no lookback limit on Trader plan) | No              | Paid (see below)  |
| **IBKR**           | Futures, futures options, equities | Yes (streaming via TWS) | No (use snapshot script)               | Yes             | ~$10/mo data subs |
| **Schwab**         | Equities, equity options           | Yes                     | No                                     | Yes (planned)   | Free with account |

**How each source plugs in:**

- **Schwab + IBKR live MD** flow through Python NT bridges (`quantfoundry-md-bridge.schwab`, `quantfoundry-ibkr-nt`) and publish on `marketdata.*` NATS subjects. The TS-side `MarketDataService` is a NATS consumer (no direct REST/TWS calls from Node). Each broker bridge is independent — there is no cross-broker fallback. Architecture: [data-plane.md §2](data-plane.md#2-live-broker-market-data); wire contract: [broker-integration.md §3.3](../tdd/broker-integration.md#33-market-data-md-bridge--ts-md-service).
- **MarketData.app** is reserved for the offline historical-chain collection script (per [collection.md](collection.md)). It does not participate in the live MD path; treat it as a batch ETL source.
- **All other sources** (FRED, EIA, CFTC, FMP, Databento, etc.) are batch ingestion through the orchestrator-adapter pattern; see [data-plane.md §3](data-plane.md#3-non-broker-batch-ingestion).

---

## Per-source capability matrix

What each source provides at its respective integration point — Schwab/IBKR through their Python NT bridges, MarketData.app through the collection script.

### Methods / data available

| Capability         | Schwab (via bridge)                      | IBKR (via bridge)                                       | MarketData.app (collection script)                                                    |
| ------------------ | ---------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Quotes (snapshot)  | ✅ `/marketdata/v1/quotes`               | ✅ TWS `reqMktData` snapshot                            | ✅ `/v1/stocks/quotes/` (or `/v1/indices/quotes/` for VIX/VIX9D/VVIX/SPX/NDX/RUT/DJX) |
| Quotes (streaming) | ✅ Schwab Streamer                       | ✅ TWS `reqMktData` streaming                           | ❌ (not live)                                                                         |
| Expirations        | ✅ derives from `/chains` payload        | ✅ TWS option-chain params                              | ✅ `/v1/options/expirations/`                                                         |
| Option chain       | ✅ `/marketdata/v1/chains` (full greeks) | ✅ TWS chain w/ `onTickOptionComputation` (full greeks) | ✅ `/v1/options/chain/` (full greeks)                                                 |
| Historical chain   | ❌ Schwab doesn't expose                 | ❌ IBKR doesn't expose                                  | ✅ `/v1/options/chain/?date=YYYY-MM-DD` (collection script only)                      |
| Candles            | ❌                                       | ✅ TWS `reqHistoricalData`                              | ✅ `/v1/stocks/candles/`                                                              |

### Response field shapes

Where adapters diverge in how they populate the unified `Quote` / `Contract` types — useful for understanding what's source-stable vs. source-specific:

| Field                    | Schwab                                                               | IBKR     | MarketData.app                                                                                                     |
| ------------------------ | -------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `Quote.bid/ask/mid/last` | `quote.bidPrice` / `askPrice` / computed `(bid+ask)/2` / `lastPrice` | _TBD_    | parallel arrays `bid[0]` / `ask[0]` / `mid[0]` / `last[0]` (often null for indices — adapter falls back to `last`) |
| `Quote.volume`           | `quote.totalVolume`                                                  | _TBD_    | `volume[0]` (often 0 for indices)                                                                                  |
| `Quote.timestamp`        | server "now" (no vendor timestamp in the Schwab response)            | _TBD_    | `updated[0]` (epoch seconds, converted to ISO)                                                                     |
| `Quote._meta.source`     | `"schwab"`                                                           | `"ibkr"` | `"marketdata"`                                                                                                     |
| `Contract` greeks        | included in `/chains` response                                       | _TBD_    | included in `/chain` response                                                                                      |
| HTTP cache hint          | none                                                                 | _TBD_    | `200` = fresh from vendor, `203` = served from MD's cache (both treated as success)                                |

### Per-source symbol quirks

Consumers use canonical QF symbols (`EQ:SPY`, `EQ:VIX`); each bridge handles the vendor-specific transform internally:

| Ticker                                             | Schwab quote endpoint | Schwab option-chain root | MD endpoint           |
| -------------------------------------------------- | --------------------- | ------------------------ | --------------------- |
| `SPY`                                              | `SPY`                 | `SPY`                    | `/stocks/quotes/SPY`  |
| `VIX`                                              | `$VIX`                | `VIXW` (weeklys)         | `/indices/quotes/VIX` |
| `SPX`                                              | `$SPX`                | `SPX`                    | `/indices/quotes/SPX` |
| `VVIX` / `VIX9D` / `NDX` / `RUT` / `DJI` / `COMPX` | `$`-prefixed          | same root                | `/indices/quotes/...` |

Classification + transforms:

- The canonical symbol parser lives at [`server/symbols/symbol.ts`](../../server/symbols/symbol.ts); each broker bridge transforms canonical → vendor-native at its boundary (Schwab's `$` prefix on index tickers, IBKR's conid lookup, etc.).
- The MarketData.app collection script applies its own path routing for indices (`/v1/indices/quotes/...` vs `/v1/stocks/quotes/...`).

### Cross-source contract notes

- Treat `Quote.mid` and `Contract.mid` as source of truth. Bridges synthesize mid from bid/ask/last when the vendor doesn't supply it.
- `Quote.source_timestamp` (per [data-plane.md §2.4](data-plane.md)) is vendor-provided when available; bridges fall back to the bridge's own arrival time when the vendor omits it.
- Greeks are present on every option-chain response from both broker sources (Schwab via `/chains`, IBKR via `onTickOptionComputation`); MarketData.app provides greeks only for live, not historical, so the collection script computes IV via bisection and derives delta/gamma/theta/vega at ingestion.
- Historical option chains are MarketData.app-only — neither broker source exposes them.

---

## MarketData.app

**Plan:** Trader
**Cost:** Paid subscription. 100,000 credits/day. Window resets at 9:30 AM Eastern.
**Auth:** Bearer token (`MD_TOKEN` in `.env`).
**Base URL:** `https://api.marketdata.app/v1/`

### Credit costs

| Operation                 | Credits                | Notes                 |
| ------------------------- | ---------------------- | --------------------- |
| Stock quote               | 1                      | Per symbol            |
| Expirations list          | 1                      | Per symbol            |
| Option chain (live)       | ~1 per 1,000 contracts | Varies by chain depth |
| Option chain (historical) | ~1 per 1,000 contracts | Same as live          |

### Credit budget planning

| Task                                                      | Credits | Notes                                         |
| --------------------------------------------------------- | ------- | --------------------------------------------- |
| 1 year of SPY daily chains (all expirations)              | ~3,000  | ~12 credits/day × 252 trading days            |
| 1 year of SPY daily chains (1 expiration)                 | ~252    | 1 credit/day                                  |
| Live monitoring (1 symbol, quote every 5s, 6.5hr session) | ~4,680  | Aggressive; caching reduces this dramatically |
| Live monitoring with 5s cache TTL                         | ~1      | 1 cache miss on first request, then cached    |

For nightly historical collection budget math, plan tier comparison, and per-symbol backfill estimates, see [collection.md §1](collection.md#1-credit-model).

**Key insight:** MarketData.app credits are primarily consumed by the historical-chain collection script (nightly backfill). The live path no longer goes through MarketData.app, so day-to-day live operation does not consume the daily credit budget at all.

### Credit accounting (response headers vs dashboard)

The `[marketdata]` log line emitted by [`src/lib/marketdata-api.js`](../../src/lib/marketdata-api.js) (`credits=<remaining>/<limit>`) reads the `x-api-ratelimit-remaining` and `x-api-ratelimit-limit` response headers. Two operator-relevant properties of those headers, confirmed against production logs in `data/chains/.bulk.log`:

- **404 responses do not consume credits.** A sequence of successful (`200`/`203`) calls decrements `remaining` by 1 each; interleaved `404` responses for the same URL leave it flat. Pruning dead probes (see [orchestrator probe list](../../server/orchestrator/api.ts)) is therefore a log-noise concern, not a credit-budget concern.
- **The headers report the per-API-key daily quota, not the MarketData dashboard's total.** The dashboard at marketdata.app may show very different "used" figures because it's reading a different scope (lifetime / paid-credit bucket vs. the daily 100k window). Treat the log-line value as authoritative for "how much of today's allowance is left" and ignore the dashboard for that question.

### Rate limits

- No documented hard rate limit, but the API returns `429` on excessive requests.
- The `collect-history.js` script uses a configurable delay (`DELAY_MS`, default 200ms) between requests.
- The `server/loader.js` background job stops on `429` and reports the error.

### Historical data

- **Lookback:** No limit on Trader plan. Data available back to ~2005.
- **Greeks:** Not provided for historical data. The collection script computes IV via bisection (`BS.impliedVol()`) and derives delta/gamma/theta/vega at ingestion time.
- **Coverage:** Equity and ETF options only. No futures.

### Quirks

- Historical chain requests with `?date=` return parallel arrays (field-per-array, not array-of-objects). The `parseChain()` function in `marketdata-api.js` handles this.
- The API occasionally returns null fields for illiquid contracts. The collection script skips contracts with null bid/ask.

---

## IBKR (Interactive Brokers)

**Account type:** Standard margin account with API access.
**Cost:** ~$10/mo for NYMEX Level 1 data subscription (required for futures options). Equity data is included with account.
**Auth:** IB Gateway or TWS running locally. The system connects via TCP socket.
**Library:** `@stoqey/ib` (npm, TWS API wrapper).

### Connection

| Setting                                 | Default                              | Env var                             |
| --------------------------------------- | ------------------------------------ | ----------------------------------- |
| Host                                    | `127.0.0.1`                          | `IBKR_HOST`                         |
| Port                                    | `4002` (Gateway), `7497` (TWS paper) | `IBKR_PORT`                         |
| Client ID (snapshot script)             | `1`                                  | `IBKR_CLIENT_ID`                    |
| Client ID (quantfoundry-ibkr-nt bridge) | `2`                                  | configured in the bridge's launcher |

**Important:** The snapshot script and the NT bridge use different client IDs to avoid conflicts. IB Gateway supports multiple concurrent client connections but each must have a unique ID.

### Running IB Gateway on Linux (Docker)

Linux has no native IB Gateway distribution, so we run the community-maintained container `ghcr.io/gnzsnz/ib-gateway:stable`. Port 4002 is mapped to the host, so the IBKR NT bridge connects to `127.0.0.1:4002` just like a native install.

A template script lives at `run_ibgateway.sh` at the repo root (gitignored because it carries your TWS credentials). The shape:

```bash
docker run -d --name ibgateway -p 4002:4002 \
  -e TWS_USERID=<your-ibkr-username> \
  -e TWS_PASSWORD=<your-ibkr-password> \
  -e TRADING_MODE=live \
  ghcr.io/gnzsnz/ib-gateway:stable
```

Add `-p 5900:5900 -e VNC_SERVER_PASSWORD=<vnc-pass>` if you want to VNC into the gateway (useful for accepting new-device prompts on first login).

**Cold start:** The container takes 15–30s after `docker run` before the TWS API port accepts connections. Wait for `nc -z 127.0.0.1 4002` to succeed before launching the IBKR NT bundle (otherwise the bridge's first connection attempt will fail and need to be retried).

**Credentials hygiene:** `run_ibgateway.sh` is in `.gitignore` because the TWS creds are embedded directly. If you want them out of disk, source from your secrets manager or pass via `--env-file` from a tmpfs path.

### Rate limits

IBKR has strict rate limits:

| Limit                                  | Value                     | Notes                                                              |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| Messages/sec                           | 50                        | Applies to all TWS API messages (quotes, orders, contract lookups) |
| Simultaneous market data subscriptions | 100 (default)             | Can be increased with subscription                                 |
| Historical data pacing                 | 6 requests per 10 seconds | Not used at v1 (no historical data from IBKR)                      |

The snapshot script handles this by batching 50 contracts at a time with 200ms delays between batches.

### Data provided

| Data type             | Available                                                                       | Greeks included                     | Notes                                                                                    |
| --------------------- | ------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Futures quotes        | Yes (streaming)                                                                 | N/A                                 | `reqMktData` with snapshot or streaming mode                                             |
| Futures option chains | Yes (snapshot)                                                                  | Yes (IV, delta, gamma, theta, vega) | Via `onTickOptionComputation` callback                                                   |
| Equity quotes         | Yes                                                                             | N/A                                 |                                                                                          |
| Equity option chains  | Yes                                                                             | Yes                                 |                                                                                          |
| Historical chains     | No                                                                              | —                                   | Use `collect-history.js` with MarketData.app instead                                     |
| Order placement       | Observation only (per [broker-integration.md §2](../tdd/broker-integration.md)) | —                                   | NT `InteractiveBrokersExecutionClient` fans exec reports back through the audit observer |
| Account positions     | Yes                                                                             | —                                   | `reqPositions` via the NT bridge                                                         |

### Quirks

- IB Gateway must be running before the IBKR NT bundle launches; its bridge `available()` check tests the TCP connection at boot.
- Contract resolution for futures is multi-step: root symbol → `reqContractDetails` → front-month selection → option parameters. The snapshot script handles this directly; the NT bridge handles it via NT's own `InteractiveBrokersInstrumentProvider`.
- Market data snapshot mode (`reqMktData` with snapshot flag) returns a single point-in-time quote, not streaming. The NT bridge uses streaming mode for subscribed symbols.
- Exchange mapping: CL → NYMEX, ES → CME, GC → COMEX, ZB → CBOT. Hardcoded in the snapshot script; the NT bridge derives it from contract details.

---

## Schwab

**Account type:** Standard brokerage account.
**Cost:** Free with account.
**Auth:** OAuth 2.0 with refresh token. Access tokens expire every 30 minutes (auto-refreshed by the Schwab bridges — `quantfoundry-schwab-nt` for orders, `quantfoundry-md-bridge.schwab` for market data; both share a `SchwabAuth` helper). Refresh tokens expire every **7 days** and must be re-issued by completing the Authorization Code flow.

### Credentials

| Credential    | Env var                | Notes                                      |
| ------------- | ---------------------- | ------------------------------------------ |
| App key       | `SCHWAB_APP_KEY`       | From Schwab developer portal               |
| App secret    | `SCHWAB_APP_SECRET`    | From Schwab developer portal               |
| Refresh token | `SCHWAB_REFRESH_TOKEN` | 7-day expiry; renewed via the helper below |

### Renewing the refresh token

When the refresh token expires (or the first time you set up), run:

```bash
npm run schwab-auth
```

That script ([scripts/schwab-auth.js](../../scripts/schwab-auth.js)):

1. Reads the app key/secret from `.env`.
2. Spins up a local HTTPS listener on `https://127.0.0.1:8182` (Schwab's registered callback URL).
3. Prints an authorize URL — open it, log in with your Schwab brokerage credentials, approve the app.
4. Catches the redirect, exchanges the one-time code for a fresh `refresh_token` + `access_token`.
5. Writes the new refresh token back into `SCHWAB_REFRESH_TOKEN` in your local `.env` (and prints it so you can copy it elsewhere if you run multiple machines).

Restart the Magpie server after the rotation so it picks up the new token.

First run generates a self-signed cert at `scripts/.schwab-auth-*.pem` (gitignored). Your browser will warn about the cert — click through ("Advanced → Proceed").

**Manual / behind-the-scenes token refresh** (what the Schwab bridges do every 30 min): `POST https://api.schwabapi.com/v1/oauth/token` with Basic auth (`app_key:app_secret`), `grant_type=refresh_token`, returns a new access token. Schwab also rotates the refresh token on each call; the bridges' shared `SchwabAuth` helper writes the rotated value back to the local `.env` so the 7-day window keeps rolling forward without manual intervention.

### Endpoints

| Endpoint                                                            | Description               |
| ------------------------------------------------------------------- | ------------------------- |
| `GET /marketdata/v1/{symbol}/quotes?fields=quote`                   | Single stock/ETF quote    |
| `GET /marketdata/v1/quotes?symbols=...`                             | Multi-symbol quotes       |
| `GET /marketdata/v1/chains?symbol=X&contractType=ALL&strikeCount=N` | Option chain              |
| `GET /trader/v1/accounts/{hash}/orders`                             | Order placement (planned) |
| `GET /trader/v1/accounts/{hash}?fields=positions`                   | Account positions         |

### Rate limits

- Not publicly documented. Conservative throttling (~1 request/sec) is the default in the Schwab adapter; rate-limit handling lives in [`research/quantfoundry-schwab-nt/`](../../research/quantfoundry-schwab-nt/).

### Data provided

| Data type             | Available     | Greeks included | Notes                               |
| --------------------- | ------------- | --------------- | ----------------------------------- |
| Equity quotes         | Yes           | N/A             |                                     |
| Equity option chains  | Yes           | Yes             |                                     |
| Futures quotes        | Partially     | N/A             | Format is inconsistent (see quirks) |
| Futures option chains | No            | —               | Not available via REST API          |
| Historical chains     | No            | —               |                                     |
| Order placement       | Yes (planned) | —               | REST API                            |
| Account positions     | Yes           | —               | Includes equities, options, futures |

### Quirks

- Futures symbol format is inconsistent across endpoints. The spike script tested `/CLM26`, `./CLM26`, `CLM26`, and `/CL` — some work on some endpoints but not others.
- OAuth refresh tokens expire after 7 days of inactivity. If the system is offline for a week, the refresh token must be manually renewed. A startup check should warn if the token is near expiry.
- The Schwab adapter is the lowest priority in the fallback chain because it lacks futures support and has the most fragile auth.

---

## Cost Summary (monthly estimate)

| Component                   | Cost               | Notes                                                                               |
| --------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| MarketData.app subscription | Trader tier        | 100k credits/day; covers nightly universe collection + live monitoring with caching |
| IBKR data subs              | ~$10/mo            | NYMEX L1. Other exchanges may add cost.                                             |
| Schwab                      | $0                 | Free with brokerage account                                                         |
| NATS                        | $0                 | Open source, self-hosted                                                            |
| DuckDB                      | $0                 | Open source, in-process                                                             |
| Compute (single k8s node)   | Varies by provider | 4-core node sufficient at v1                                                        |

The dominant ongoing cost is the MarketData.app subscription. IBKR data fees are minimal. Everything else is open source.

---

## Collection scripts reference

| Script             | Source         | Usage                                                                 | Output                            |
| ------------------ | -------------- | --------------------------------------------------------------------- | --------------------------------- |
| `npm run collect`  | MarketData.app | `-- --symbol SPY --from 2024-01-02 --to 2024-12-31 --token $MD_TOKEN` | `data/chains/SPY-YYYY-MM.parquet` |
| `npm run snapshot` | IBKR           | `-- --symbols CL,ES` (requires IB Gateway)                            | `data/chains/CL-YYYY-MM.parquet`  |

Both scripts write to the same `data/chains/` directory with the same Parquet schema. The `source` column in the Parquet file identifies which script produced each row (`"marketdata"` or `"ibkr"`).

**Live cron schedule** runs in the `quantfoundry-scheduler` Docker container on the home server, not via host crontab. The container schedules `npm run collect:bulk` (MarketData chains), `npm run ingest -- --source {fred,eia,cftc}` (macro), and `npm run databento:pull` (futures). Full job list + schedules + operator commands in [`data/CRON.md`](../../data/CRON.md). For ad-hoc one-off backfills, the `npm run collect` / `npm run snapshot` commands above can still be invoked manually.
