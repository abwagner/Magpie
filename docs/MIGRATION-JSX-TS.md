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

| File                     | Status | Notes                                |
| ------------------------ | ------ | ------------------------------------ |
| `server/data-sources.js` | ✅     | Migrated to `.ts` (QF-343)           |
| `server/loader.js`       | ✅     | Migrated to `.ts` (QF-343)           |

---

## `src/lib/` math libraries

These are low-churn computation libraries. Most are dependency-free and
well-tested; migration is deprioritised until a ticket meaningfully touches
them.

| File                        | Status | Notes                      |
| --------------------------- | ------ | -------------------------- |
| `src/lib/probability.js`    | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/sabr.js`           | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/vol-surface.js`    | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/event-model.js`    | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/eval.js`           | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/edge-greeks.js`    | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/margin.js`         | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/time.js`           | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/rv-analysis.js`    | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/log.js`            | ✅     | Already `.ts`              |
| `src/lib/payoff.js`         | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/curves.js`         | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/futures-specs.js`  | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/symbols.js`        | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/marketdata-api.js` | ✅     | Migrated to `.ts` (QF-343) |
| `src/lib/optimizer.js`      | ✅     | Migrated to `.ts` (QF-343) |

---

## Policy notes

- `allowJs: true` is on so remaining `.js` files typecheck minimally;
  `allowImportingTsExtensions` is intentionally **off** — all new/migrated
  files must use `.js` import specifiers per NodeNext resolution.
- Migrating a math lib is a meaningful change; do it when you're editing the
  lib, not as a no-op rename.
- `src/lib/wasm/qf_optimizer/qf_optimizer.js` is a generated wasm-bindgen
  artifact and ships with its own companion `qf_optimizer.d.ts`. It is **not**
  migration debt and intentionally stays `.js` — do not convert it.
