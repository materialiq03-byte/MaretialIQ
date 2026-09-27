# MaterialIQ — Release Baseline

**Project:** MaterialIQ — AI-Powered Material Intelligence & Harmonization
**Problem statement:** SIH26099
**Baseline date:** 2026-09-19
**Application version / build identifier:** v0.2.0 · matcher config `cfg-16eb5f` (Node v24.12.0, Next.js 15, React 19, SQLite via `node:sqlite`). Source is not under git version control; this document plus `data/evaluation/run-history.json` and the `evaluation_runs` table are the authoritative baseline record.

## Verification results (all executed on baseline date)

| Check | Result |
|---|---|
| Database migration | **v8** (`evaluation_runs` applied; versions 1–8 present) |
| Tests | **140/140 PASS** (7 suites) |
| TypeScript | **PASS** (`tsc --noEmit` clean) |
| Production build | **PASS** (Next.js, all pages generated) |
| Smoke test | **PASS — 35/35** (`npm run smoke`) |
| DB integrity | **PASS** (`PRAGMA integrity_check` = ok, `foreign_key_check` = 0 rows) |
| Evaluation (`npm run evaluate`) | Deterministic re-run, **append-only** history record created |

## Evaluation baseline (run-0005, dataset `ground-truth-pairs.json` v1, 50 pairs)

| Metric | Value |
|---|---|
| Accuracy | **0.84** |
| Macro Precision | **0.8730** |
| Macro Recall | **0.8596** |
| Macro F1 | **0.8327** |
| Weighted F1 | **0.8375** |
| Technical Conflict Detection | **20/20** |
| False Positives | **0** |
| False Negatives | **0** |
| Review rate | 0.42 |

Full history: run-0001 (0.80) → run-0002 (0.82) → run-0003 (0.82) → run-0004 (0.84) → run-0005 (0.84, re-verification).
These are prototype results on a synthetic labelled dataset — **not production accuracy**.

## Data baseline

| Item | Count |
|---|---|
| Materials (`material_records`, active) | **120** |
| CPSEs (`organizations`, active) | **5** — CPCL, NTPC, BHEL, NLC, SAIL |
| Common Material Identities | **1** (CMI-BRG-6205; 3 legacy mappings) |
| Legacy mappings (`material_mappings`) | **3** |
| Review queue | **1279 open** / 10 resolved |
| Human decisions (`match_decisions`) | **10** — 6 approved, 1 deferred, 3 rejected (immutable) |
| Imports (`data_imports`) | **16** (14 completed, 2 failed — preserved history) |
| Audit rows (`audit_logs`) | **61** |
| Evaluation run records | **5** (4 in JSON mirror + baseline re-run; all in DB) |

## Frozen core logic (Step 15)

The following are **frozen** as of this baseline. Future modifications must be bug fixes
only unless explicitly approved:

- ingestion (Import & Validation Center workflow, duplicate protection)
- normalization (description normalization layer; source records never modified)
- attribute extraction (technical attribute pipeline)
- candidate retrieval (cross-CPSE blocking strategy)
- semantic similarity (deterministic embedding signal)
- fuzzy similarity (token/fact canonicalization)
- technical comparison (typed per-attribute comparison)
- category-aware attribute strategies (nominal / measured / enum / text registry)
- assembly/kit detection (vocabulary-driven configuration signal)
- decision thresholds (high ≥ 80, review ≥ 60, reject < 30)
- review workflow (pending → human decision; decided matches immutable)
- CMI approval gate (identity creation only from approved matches)
- legacy mappings (original CPSE codes preserved, never overwritten)
- audit events (action vocabulary incl. `common_material_created`)
- evaluation dataset (`data/evaluation/ground-truth-pairs.json` — labels unchanged)
- evaluation metrics (metric definitions and computation)
- evaluation run history (append-only, DB table + JSON mirror)

## Verification commands

```
npm test          # 140/140
npm run typecheck # tsc --noEmit
npm run build     # production build
npm run smoke     # 35/35 against a running server
npm run evaluate  # deterministic metrics + append-only history record
npm run db:migrate
```
