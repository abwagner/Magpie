# Architecture-B doc revamp audit — 2026-06 (QF-270 / M14-1.0)

Precursor to the M14-1 **Architecture B** rewrite pass. This is an **audit / checklist only** — it does **not** rewrite any audited doc. It walks the entire `docs/` tree (one row per file) and records, per doc: a status, a one-line note, a line-reduction target, whether the doc needs a diagram, and an **action verdict** for the downstream rewrite pass. Every `rewrite` / `retire` verdict gets a detail block below the tables naming **what drifted from code** so the next phase has a concrete worklist.

Companion to the earlier doc-fleet sweep (QF-141 / QF-186, the format this extends — that log was retired in the top-level-TDD rewrite, commit `7934659`; this audit re-establishes the per-doc table). Target-state references that defined the audit's "is this still load-bearing?" bar:

- [TRADING-SYSTEM-TDD.md](TRADING-SYSTEM-TDD.md) — the post-retirement anchor (already on the "Magpie" brand, signal subsystem gone, NT-bundle topology).
- [tdd/deployment-topology.md](tdd/deployment-topology.md) — QF-202, Option B (full `qf-server` on `your-server.example.com`; laptop is a thin client).
- The retirement cascade that drove most drift: signals subsystem (`server/signals/`, `src/types/signal.ts`) removed by QF-261 / QF-281 / QF-339; analytics API by QF-225; JS backtest engine by QF-137.

## Completeness

**34 of 34** `.md` files under `docs/` have a row (every file from `find docs -name '*.md'`). No sampling — full coverage. Counts cross-checked against the file tree at audit time.

## Status vocabulary (from QF-186)

- `pass` — reviewed; current and accurate as-is.
- `current` — implemented-and-accurate behavior doc; describes shipped code correctly.
- `design` — forward-looking spec; explicitly marks itself not-yet-implemented and that's still true vs code. Accurate as a design.
- `drifted` — doc describes a state the code has moved past (stale-vs-code).
- `frozen` — intentional point-in-time historical snapshot with a HISTORICAL banner; not forward-looking.

## Action-verdict vocabulary (extends QF-186)

- **`pass`** — no change needed.
- **`trim`** — mechanical reduction only (dedupe, collapse, drop stale file-path refs / dead doc links). **No semantic change** to the design.
- **`rewrite`** — semantically stale vs code; needs a real Architecture-B rewrite pass. Each is enumerated in a detail block below with the drifted section + the code reality.
- **`retire`** — doc is dead; delete it (or it is already-dead history that should be dropped rather than carried).
- **`merge`** — doc should fold into another rather than stand alone.

`trim` vs `rewrite` boundary: a doc with only dead cross-links / migrated file paths but a correct design is `trim`; a doc whose **status banner or behavioral claims contradict shipped code** is `rewrite`.

---

## Top-level docs

| file                         | status  | 1-line note                                                                                                                                  | line-reduction target | diagram needed?     | action verdict |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------- | -------------- |
| `docs/README.md`             | current | Doc index; accurate map, links resolve, lists deployment-topology + the design tier. Lists 5 TDD tiers correctly.                            | none (72 → 72)        | no                  | pass           |
| `docs/TRADING-SYSTEM-TDD.md` | drifted | Anchor doc, mostly fresh — but §System Components still says GUI has "six workspaces (… / Signals / …)"; the GUI has five (Signals retired). | ~5 lines              | no (3 good mermaid) | trim           |
| `docs/RUNBOOK.md`            | drifted | Largest doc (1337 ln). Dead-doc links + Node-20 + polyglot rollback section + M13 broker-migration steps now landed.                         | ~300 lines            | no                  | rewrite        |
| `docs/OPEN-QUESTIONS.md`     | current | Consolidated open-questions snapshot; entries still open vs code. Source-doc pointers resolve.                                               | none (49 → 49)        | no                  | pass           |
| `docs/CODING-STANDARDS.md`   | drifted | TS/Rust/Python conventions are fine, but it links 6 retired docs + `server/index.js` + `analytics/` + a stale Phase-6/7 build order.         | ~60 lines             | no                  | rewrite        |
| `docs/MIGRATION-JSX-TS.md`   | current | Tracker; every row is ✅ (all `.js`/`.jsx` migrated by QF-343). Effectively a "done" record — keep as the proof.                             | ~10 lines             | no                  | trim           |

## Component TDDs (`docs/tdd/`)

| file                                      | status  | 1-line note                                                                                                                                                                      | line-reduction target  | diagram needed?   | action verdict |
| ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------- | -------------- |
| `tdd/deployment-topology.md`              | current | QF-202 Option-B decision; just merged, defines the Architecture-B target. The doc others should converge on.                                                                     | none (160 → 160)       | no                | pass           |
| `tdd/strategy-deployment-topology.md`     | current | Paper-live vs prod, state contract. Minor: `magpie-prod-bundle/` now exists (doc says "not yet created"); links dead `dependency-admission.md`.                            | ~5 lines               | no (1 mermaid)    | trim           |
| `tdd/risk-gate-architecture.md`           | drifted | Strong design, but status table marks gate subjects "Designed; not implemented" while `server/risk/gate-handler.ts` + `evaluator.ts` ship and are wired. §5.2/§5.3 out of order. | ~10 lines              | no                | rewrite        |
| `tdd/exec-algorithms.md`                  | design  | Catalog deliberately empty; accurate as design intent. Links dead `dependency-admission.md` (§11).                                                                               | ~3 lines               | no (2 mermaid)    | trim           |
| `tdd/nats-subjects.md`                    | drifted | §2.4 Signals family + §3 callsite table reference `server/signals/*` + `src/types/signal.ts` — all retired (QF-261/281/339).                                                     | ~40 lines              | no                | rewrite        |
| `tdd/broker-integration.md`               | current | Thorough, current NT-bundle contract. Minor: §3.3/§4.2 use colon symbol form (`EQ:AAPL`) vs nats-subjects' dotted NATS-safe form.                                                | ~5 lines               | no (1 mermaid)    | trim           |
| `tdd/order-execution.md`                  | current | OPL lifecycle + exit controls; file refs (`ibkr-observer.ts`, `schwab-rest.ts`, `nt-bridge.ts`) all exist. Accurate.                                                             | ~10 lines              | no (1 mermaid)    | pass           |
| `tdd/order-flow.md`                       | current | Two-flows-one-chain; accurate writer mapping + dedup. Minor: links `cross-cutting.md §3` for audit DDL (actually §5).                                                            | ~5 lines               | no (good mermaid) | trim           |
| `tdd/portfolio-risk-engine.md`            | drifted | 666 ln. §"Strategy drift monitoring" says "not implemented" but drift detector shipped. Markdown defect: stray fence ~ln 92.                                                     | ~120 lines             | no                | rewrite        |
| `tdd/cross-cutting.md`                    | drifted | 673 ln. Two `### 5` sections (Database schema + Retention both numbered 5). Links dead `dependency-admission.md`. 1Password (QF-349) section is accurate.                        | ~120 lines             | no                | trim           |
| `tdd/greek-builder.md`                    | drifted | Math is stable; but file paths are stale — `ChainPicker.jsx`, `optimizer.js`, `lp-optimizer.js` all migrated to `.tsx`/`.ts` (QF-343).                                           | ~30 lines              | no                | trim           |
| `tdd/gui.md`                              | current | 513 ln, dense + accurate (5 workspaces, QF-346/350/351 surfaces). Links `../../../.claude/plans/magpie-v2.md` (outside repo).                                              | ~20 lines              | no                | trim           |
| `tdd/observability.md`                    | current | Framework + correlation-ID; accurate, helpers shipped. §7 table marks component §10s done.                                                                                       | ~10 lines              | no (good mermaid) | pass           |
| `tdd/drift-detector.md`                   | drifted | Opens "No drift detector lives in `server/risk/` today" — but `drift-detector.ts` + `fast-tier.ts` + `slow-tier.ts` + `baseline-resolver.ts` all ship.                           | ~5 lines (status only) | no                | rewrite        |
| `tdd/exit-rule-monitor.md`                | drifted | §1 "design intent, not implemented (QF-321)" — but `server/portfolio/exit-rule-monitor.ts` is implemented and wired in `index.ts`.                                               | ~5 lines (status only) | no                | rewrite        |
| `tdd/alerts.md`                           | current | Router design; `config/alerts.yaml`, three channels, producer callsites. Accurate.                                                                                               | ~5 lines               | no (1 mermaid)    | pass           |
| `tdd/write-jobs.md`                       | current | Queue + 7 handlers; single-writer funnel. Accurate vs `server/writeJobs/`.                                                                                                       | ~5 lines               | no (1 mermaid)    | pass           |
| `tdd/marketdata-fallback.md`              | design  | QF-341 — ratified 2026-06-07, not yet implemented; status banner is honest. Forward-looking scoped reversal of "no fallback".                                                    | none (256 → 256)       | no                | pass           |
| `tdd/backtest-gate.md`                    | design  | No code yet; honest "design doc" banner. Companion to qo-port-investigation.                                                                                                     | none (201 → 201)       | no                | pass           |
| `tdd/qo-typescript-port-investigation.md` | current | QF-305 research/recommendation (keep the shim). Stable verdict doc.                                                                                                              | none (288 → 288)       | no                | pass           |
| `tdd/signal-orchestrator.md`              | drifted | Self-declares "retired (M14-2 / QF-260)" + "full rewrite planned for M14-1". Describes a removed subsystem. The canonical M14-1 rewrite target.                                  | retire body (35 → ~12) | no                | rewrite        |

## Data docs (`docs/data/`)

| file                 | status  | 1-line note                                                                                       | line-reduction target | diagram needed? | action verdict |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------- | --------------------- | --------------- | -------------- |
| `data/data-plane.md` | current | Data-in component TDD; three flows, NT-bundle MD, batch ingestion. Fresh vs current architecture. | ~15 lines             | no (1 mermaid)  | trim           |
| `data/collection.md` | current | Offline MarketData.app chain ETL; operational, accurate.                                          | ~10 lines             | no              | pass           |
| `data/sources.md`    | current | Per-source costs/limits/auth. Minor: Schwab "order placement (planned)" now shipped (QF-353).     | ~5 lines              | no              | trim           |
| `data/universes.md`  | current | Collection registry; living operational doc. Accurate.                                            | none (165 → 165)      | no              | pass           |

## Archive (`docs/archive/`)

| file                        | status | 1-line note                                                                                              | line-reduction target | diagram needed? | action verdict |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------------------- | --------------------- | --------------- | -------------- |
| `archive/QF-ISSUES.md`      | frozen | HISTORICAL banner (archived 2026-04-28); read-only history with intentional broken links. Leave frozen.  | none                  | no              | pass           |
| `archive/TODO.md`           | frozen | HISTORICAL banner; superseded by Plane. Read-only. Leave frozen.                                         | none                  | no              | pass           |
| `archive/SETTINGS-STUBS.md` | frozen | HISTORICAL banner; placeholder-Settings snapshot superseded by shipped Settings (gui.md §5 = all wired). | none                  | no              | pass           |

---

## Verdict tally

**Headline: 15 pass · 11 trim · 8 rewrite · 0 retire · 0 merge** (34 distinct files).

| verdict   | count | docs                                                                                                                                                                                                                    |
| --------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`    | 15    | README, OPEN-QUESTIONS, deployment-topology, order-execution, observability, alerts, write-jobs, marketdata-fallback, backtest-gate, qo-typescript-port-investigation, collection, universes + the 3 frozen `archive/*` |
| `trim`    | 11    | TRADING-SYSTEM-TDD, MIGRATION-JSX-TS, strategy-deployment-topology, exec-algorithms, broker-integration, order-flow, cross-cutting, greek-builder, gui, data-plane, sources                                             |
| `rewrite` | 8     | RUNBOOK, CODING-STANDARDS, risk-gate-architecture, nats-subjects, portfolio-risk-engine, drift-detector, exit-rule-monitor, signal-orchestrator                                                                         |
| `retire`  | 0     | — (the three `archive/*` docs are correctly frozen, not dead; no doc is delete-on-sight)                                                                                                                                |
| `merge`   | 0     | — (signal-orchestrator's surviving content folds into its own M14-1 rewrite, not into another doc)                                                                                                                      |

---

## Rewrite worklist (the high-value Architecture-B targets)

Each block: the **doc section that drifted** → the **code reality** it must be reconciled against.

### `tdd/signal-orchestrator.md` — rewrite (highest priority; self-declared M14-1 target)

- **Drift:** the whole doc documents the boot-time + periodic scheduled-feed refresh loop and `server/orchestrator/` tick runner. The doc's own banner says the loop was removed (QF-260) and "a full rewrite of this document is planned for M14-1."
- **Code reality:** `server/signals/` is gone entirely; the surviving `server/orchestrator/` adapter registry + manifest discovery is what should be documented, scoped to the M10 ingest CLI + `/api/signals/*` surface. The rewrite is the M14-1 deliverable this whole audit precedes.

### `tdd/nats-subjects.md` — rewrite (signals family is dead)

- **Drift:** §2.4 "Signals (model workers ↔ strategy runners / monitors)" documents `signals.<model_id>.<asset_class>.<symbol-tokens>`, built by `buildSubject()` in `server/signals/publish.ts`. §3's callsite table lists `server/signals/publish.ts`, `ws-bridge.ts`, `drift-detector.ts`, `exit-monitor.ts` consumers and `src/types/signal.ts`.
- **Code reality:** `server/signals/` and `src/types/signal.ts` do not exist (retired QF-261 / QF-281 / QF-339). The `signals.*` subject family has no producer or consumer in the codebase. The `<model_id>` / `<asset_class>` grammar variables and the JetStream `signals.>` stream are dead. The doc's QF-335 subject-registry modules (`src/types/subjects.ts`, `research/magpie-subjects`) DO exist and are correct — keep those. Drop the signals family + signals callsites.

### `tdd/drift-detector.md` — rewrite (shipped, doc says not-shipped)

- **Drift:** opening line — "This is a **design** doc. No drift detector lives in `server/risk/` today."
- **Code reality:** `server/risk/drift-detector.ts`, `fast-tier.ts`, `slow-tier.ts`, `baseline-resolver.ts` all exist and reference this doc's sections in their headers. The two-tier design shipped (QF-328/329/330/331). Flip the status banner to implemented and reconcile any per-section deltas against the modules; the design body is largely correct, so this is a status + verification rewrite, not a redesign.

### `tdd/exit-rule-monitor.md` — rewrite (shipped + wired, doc says design-intent)

- **Drift:** §1 — "Today (2026-05) … the monitor is **design intent, not implemented**. This doc consolidates the contract so QF-321 can implement against a single spec."
- **Code reality:** `server/portfolio/exit-rule-monitor.ts` (439 lines) is implemented and wired in `server/index.ts` (`createExitRuleMonitor(...)`, fed by `exitRuleMonitor?.onPositionUpdate(update)`). QF-321/351 landed. Flip status to implemented; verify the rule schema + GUI surface (QF-350) against the shipped module.

### `tdd/portfolio-risk-engine.md` — rewrite (drift section stale) + trim (size/defect)

- **Drift:** §"Strategy drift monitoring" carries "**Status: design intent, not implemented.**" same as drift-detector — superseded by the shipped `server/risk/` drift modules.
- **Code reality:** drift detector shipped (see above). Also a **markdown defect**: a stray closing code-fence around line 92 (after the portfolio-state JS block) leaves the following prose mis-fenced. At 666 lines the doc is the second-largest; §11 (option lifecycle, QF-309) is a large parked block that should be cross-checked against QF-309/321 status. Fix the status banner + the fence, then trim.

### `tdd/risk-gate-architecture.md` — rewrite (status claims stale)

- **Drift:** the doc presents the gate as forward-looking ("Phase 1 — Gate plugin skeleton" etc.); the nats-subjects companion marks `orders.gate.<broker>` "Designed; not implemented."
- **Code reality:** `server/risk/gate-handler.ts` (NATS subscriber on `orders.gate.<broker>`, `createGateHandler` wired in `index.ts`) and `server/portfolio/evaluator.ts` ship; `bin/gate-evaluator-cli.ts` ships (the backtest-gate shim). The QF-side gate evaluator + handler are real; the NT-side plugin (`research/magpie-risk-gate/`) exists as a package. Reconcile the "designed/not-implemented" framing with what has landed; keep genuinely-future parts (envelope revocation §3.5, parent-budget child fast-path) flagged as such. Also fix §5.2/§5.3 ordering (5.3 precedes 5.2).

### `docs/CODING-STANDARDS.md` — rewrite (dead refs + stale build order)

- **Drift:** links six retired docs — `polyglot-migration-tdd.md`, `polyglot-migration-plan.md` (header + Rust/Python sections), `dispatch-architecture.md` (§"Writes go through dispatch"), `dependency-admission.md`, `dependency-pins.md`, `VALIDATION.md`. The §"Writes go through dispatch" exception names `server/index.js`. §"Implementation Order" Phase 5 lists `server/analytics/api.ts` + `analytics/scheduler.ts`; Phase 6/7 list a pre-NT-bundle build order.
- **Code reality:** none of those six docs exist under `docs/`. `server/index.js` is now `server/index.ts` (QF-280). `server/analytics/` was deleted (QF-225). Brokers/MD are NT-bundle-resident, not the Phase-7 TS adapters listed. The TS/Rust/Python convention sections themselves are accurate — the rewrite is repointing dead links + replacing the obsolete implementation-order appendix.

### `docs/RUNBOOK.md` — rewrite (Architecture-B topology + dead refs + size)

- **Drift:** §1 Prerequisites links dead `dependency-admission.md` and lists "Node.js 20+" (deployment-topology + CLAUDE.md target Node 22). §12.x "Rollback procedures (polyglot migration)" is consolidated from the retired `polyglot-migration-tdd.md §10` and `dependency-pins.md` (both gone). M13-0x broker-migration steps (TWS bridge, `schwab.ts` adapter deletion) describe a migration that has landed. At 1337 lines it is by far the largest doc and predates the Option-B (full server on `your-server.example.com`) deployment decision.
- **Code reality:** Option B is decided ([deployment-topology.md](tdd/deployment-topology.md)); the RUNBOOK's start-the-system / go-live sections should reflect single-host `docker compose` with `qf-server` on the home server, not a laptop `npm start`. Node 22. Drop the polyglot rollback section + dead-doc links; fold M13 from "migration steps" into steady-state operation.

---

## Trim notes (mechanical, no semantic change — for completeness)

- `TRADING-SYSTEM-TDD.md`: §System Components GUI line says "six workspaces (… Signals …)"; the GUI ships five (Signals retired). One-line fix.
- `cross-cutting.md`: de-duplicate the two `### 5` headings (Database schema vs Retention & archival both numbered 5); repoint dead `dependency-admission.md`. 673 ln → candidate for ~120-line reduction once the DDL blocks are the only canonical copy.
- `greek-builder.md`: repoint `ChainPicker.jsx` → `.tsx`, `optimizer.js`/`lp-optimizer.js` → `.ts` (QF-343 migrated all). Keep the §1.3/§1.4 JS-solver design history but fix the live file paths.
- `gui.md`: `../../../.claude/plans/magpie-v2.md` is an out-of-repo link (×2); decide whether to inline the v2 list or drop the link.
- `strategy-deployment-topology.md` + `exec-algorithms.md`: repoint dead `dependency-admission.md`; note `magpie-prod-bundle/` now exists.
- `order-flow.md`: `cross-cutting.md §3` audit-DDL anchor should be `§5`.
- `broker-integration.md`: align the §3.3/§4.2 symbol form (`EQ:AAPL`, colon) with the NATS-safe dotted form the subject registry uses.
- `sources.md`: Schwab "order placement (planned)" → shipped (QF-353).
- `MIGRATION-JSX-TS.md`: every row ✅; collapse to a short "migration complete" record (keep `wasm-bindgen` carve-out note).

---

## Notes for the rewrite pass

1. **The archive tier is correct.** `archive/*` are intentionally-frozen snapshots with HISTORICAL banners and deliberately-broken relative links. Do **not** "fix" them — leave frozen.
2. **`deployment-topology.md` is the convergence target.** Where other docs (RUNBOOK especially) still imply a laptop-pinned server, reconcile toward Option B.
3. **The biggest single source of drift is the signals retirement.** It touches `signal-orchestrator.md` (full rewrite), `nats-subjects.md §2.4/§3` (drop family), and the GUI/TRADING-SYSTEM "six workspaces" line. Sequencing the signals cleanups together will close most of the `rewrite` queue.
4. **Three "design intent" banners are now false** (drift-detector, exit-rule-monitor, portfolio-risk-engine §drift) because the code shipped under the M13/Phase-D work. These are cheap status-flip rewrites, not redesigns.
