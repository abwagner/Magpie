# JSX → TS Migration Tracker

Migration status for remaining `.js`/`.jsx` files in the codebase. The rule
(CLAUDE.md) is: **no new `.js`/`.jsx`** — convert any file you meaningfully
touch instead of editing the legacy extension in place.

## Status key

| Symbol | Meaning                        |
| ------ | ------------------------------ |
| ✅     | Migrated to TypeScript         |
| 🚧     | In progress / tracked in Plane |
| ⏳     | Queued, not yet started        |

---

## Server entry point

| File                      | Status | Ticket | Notes                                           |
| ------------------------- | ------ | ------ | ----------------------------------------------- |
| `server/index.js` → `.ts` | ✅     | QF-280 | Migrated; strict+noUncheckedIndexedAccess clean |

---

## Server legacy JS modules

| File                     | Status | Notes                                         |
| ------------------------ | ------ | --------------------------------------------- |
| `server/data-sources.js` | ⏳     | Legacy data-source adapters; no active ticket |
| `server/loader.js`       | ⏳     | Legacy chain loader; no active ticket         |

---

## `src/lib/` math libraries

These are low-churn computation libraries. Most are dependency-free and
well-tested; migration is deprioritised until a ticket meaningfully touches
them.

| File                        | Status | Notes |
| --------------------------- | ------ | ----- |
| `src/lib/probability.js`    | ⏳     |       |
| `src/lib/sabr.js`           | ⏳     |       |
| `src/lib/vol-surface.js`    | ⏳     |       |
| `src/lib/event-model.js`    | ⏳     |       |
| `src/lib/eval.js`           | ⏳     |       |
| `src/lib/edge-greeks.js`    | ⏳     |       |
| `src/lib/margin.js`         | ⏳     |       |
| `src/lib/time.js`           | ⏳     |       |
| `src/lib/rv-analysis.js`    | ⏳     |       |
| `src/lib/log.js`            | ⏳     |       |
| `src/lib/payoff.js`         | ⏳     |       |
| `src/lib/curves.js`         | ⏳     |       |
| `src/lib/futures-specs.js`  | ⏳     |       |
| `src/lib/symbols.js`        | ⏳     |       |
| `src/lib/marketdata-api.js` | ⏳     |       |
| `src/lib/optimizer.js`      | ⏳     |       |

---

## Policy notes

- `allowJs: true` is on so remaining `.js` files typecheck minimally;
  `allowImportingTsExtensions` is intentionally **off** — all new/migrated
  files must use `.js` import specifiers per NodeNext resolution.
- Migrating a math lib is a meaningful change; do it when you're editing the
  lib, not as a no-op rename.
