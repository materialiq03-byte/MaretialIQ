# CPSE Integration Layer (Step 22)

**Status: IMPLEMENTED as a prototype layer over synthetic source formats.** This is NOT a live
ERP/CPSE connection. Every adapter below models a realistic-looking source format for the
prototype; none represents a real, proprietary CPSE schema, and no production CPSE system,
credential, or network is involved.

MaterialIQ is an **ERP-agnostic material intelligence layer that can ingest heterogeneous
material-master data from multiple CPSEs through governed source adapters, normalize it into one
canonical contract, preserve source traceability, and feed the existing explainable matching and
human-governed harmonization pipeline.**

## 1. Architecture

```
CPSE SOURCE (synthetic feed)
    ↓
SOURCE ADAPTER          src/lib/integrations/adapters.ts        (declared field map + vocabulary)
    ↓
INGESTION CONTRACT      src/lib/integrations/canonical-contract.ts
    ↓
VALIDATION              src/lib/integrations/parse-and-validate.ts
    ↓
NORMALIZATION           adapter vocabulary (source syntax only; semantics stay in MaterialIQ)
    ↓
IMPORT / STAGING        EXISTING Import Center: analyzeImport + chunked async import job
    ↓
MATERIALIQ MATERIAL MASTER
    ↓
MATCHING                EXISTING deterministic matching engine (unchanged)
    ↓
HUMAN REVIEW            EXISTING review queue / proposals (unchanged)
    ↓
CMI / GOVERNANCE        EXISTING CMI + governance cockpit (unchanged)
```

The integration layer is a **boundary, not a second pipeline**. It contains no import logic: it
translates each source feed into canonical rows and hands them to the authoritative Import
Center (`src/lib/services/import-center-service.ts` + `import-job-service.ts`), which keeps the
frozen validation, chunked durable execution, single-active-run guard, audit trail, and
duplicate strategy.

## 2. Canonical contract

One contract between every source system and MaterialIQ
(`CanonicalMaterialRow`): `cpse`, `sourceSystem`, `sourceRecordId`, `materialCode`,
`description`, `category`, `subcategory`, `manufacturer`, `partNumber`, `material`, `uom`,
`sourceDescription` (verbatim source text), `sourceMetadata` (retained unknown columns),
`sourceRowNumber`.

Deliberate non-fields (documented in `CANONICAL_CONTRACT_NOTES`):

- **CPSE is never inferred from data** — it comes only from the resolved adapter profile.
- **Identity is never the description or a generated UUID** — it is
  `CPSE + sourceSystem + sourceRecordId` (the source material code).
- **Semantic fields (voltage, pressure class, seal type, …) are not canonical inputs** — the
  existing pipeline extracts them from descriptions, and the Import Center's technical-column
  mapping carries them when a source provides them explicitly.

## 3. Source adapters (synthetic profiles)

| CPSE | Version | Source headers (synthetic) | Vocabulary examples |
|---|---|---|---|
| CPCL | `CPCL-MATERIAL-v1` | MAT_CODE, MAT_DESC, MAT_GROUP, MFR, PART_NO, MAT_GRADE, UOM | BRG→Bearings, VLV→Valves, MTRS→MTR |
| NTPC | `NTPC-MATERIAL-v1` | MATERIAL_ID, MATERIAL_DESCRIPTION, MATERIAL_GROUP, MATERIAL_SUBGROUP, MANUFACTURER, OEM_PART, BASE_UOM | FSTNR→Fasteners, EACH→EA |
| BHEL | `BHEL-MATERIAL-v1` | ITEM_CODE, ITEM_TEXT, ITEM_CATEGORY, ITEM_SUBCLASS, MAKE, PART_REFERENCE, MATERIAL_SPEC, UNIT | MOT→Motors, PMP→Pumps |
| NLC | `NLC-MATERIAL-v1` | MATERIAL_NO, DESCRIPTION, CLASS, OEM, OEM_PART_NO, UOM | BRG→Bearings, N→NOS |
| SAIL | `SAIL-MATERIAL-v1` | STOCK_CODE, MATERIAL_NAME, MATERIAL_TYPE, STEEL_GRADE, MAKE, PART_NO, UNIT_OF_MEASURE | PC→PCS, LTR→L |

All five are instances of ONE declared profile (`CpseSourceAdapter`): explicit header mapping,
explicit vocabulary, identical validation rules. No guessing, no AI, no per-CPSE code paths.

## 4. Adapter registry

`src/lib/integrations/registry.ts` is the single resolution mechanism (`getAdapterRequired`,
`getAdapterByCpseRequired`, `listAdapters`). Registration fails loudly on duplicate ids or two
adapters claiming one CPSE. The API view (`describeAdapter`) exposes id, cpse, label, version,
formats, declared field mapping, status — no secrets, no infrastructure configuration.

## 5. Source identity, idempotency, traceability

- **Stable identity:** `CPSE + sourceSystem + sourceRecordId`
  (`sourceIdentityOf()`), stamped into every diagnostic that references a source record.
- **Idempotency:** two nets, both pre-existing and unchanged:
  1. adapter-level duplicate-in-feed detection (same `sourceRecordId` twice in one feed →
     structured `Duplicate source record` error, feed refuses execution);
  2. the DB-authoritative `UNIQUE(organization_id, original_code)` + the import pipeline's
     duplicate-skip strategy (replaying a feed creates zero new rows; originals are never
     overwritten).
- **Traceability chain (§11):** source file → `data_imports` (file name, integration metadata)
  → `material_records.import_id` + `source_row` (the physical source-file row) → matching
  candidates → human decisions → CMI mapping. Every imported material remains explainable back
  to its origin.

## 6. Validation

Validation happens BEFORE canonical ingestion and never bypasses the Import Center's own
validator (both run). Structured diagnostics: `{ row, field, code, message, severity }` with
stable codes `REQUIRED_FIELD` / `INVALID_VALUE` / `CONFLICT` / `MAPPING_ERROR` and integration
error codes `SOURCE_ERROR`, `VALIDATION_ERROR`, `MAPPING_ERROR`, `DUPLICATE_SOURCE_RECORD`,
`UNSUPPORTED_FORMAT`, `ADAPTER_ERROR`, `IMPORT_ERROR` (`INTEGRATION_ERROR_CODES`). Source
conflicts are surfaced, never silently resolved (§17); unknown source columns are retained in
`sourceMetadata`, never discarded (§8). No stack traces or internals are exposed.

## 7. Integration metadata (no schema change)

Integration metadata persists inside the import's existing bounded `row_report` JSON (the
"what did the system understand" record) under an additive `integration` key: cpse,
sourceSystem, adapterId, adapterVersion, sourceFormat, sourceFileName, sourceRecordCount,
canonicalRecordCount, validationSummary, fieldMapping, fieldCoverage, sourceIdentityModel.
**No migration** — schema stays at v19, so the frozen PostgreSQL schema assertions and both
frozen baselines are untouched by construction.

## 8. APIs

| Route | Behavior |
|---|---|
| `GET /api/integrations` | registry + recent integration runs (read-only, audit-silent) |
| `POST /api/integrations/analyze` | read-only canonical preview + quality report from ACTUAL data; no import record, idempotent, audit-silent |
| `POST /api/integrations/execute` | adapter analysis → EXISTING Import Center analyze → EXISTING chunked async import job (202) |
| `GET /api/integrations/[id]` | one integration run's metadata + traceability pointers |

Authorization reuses the existing model: `IMPORT_MATERIALS` on every route plus server-side
organization scoping (a scoped CPSE user cannot run another CPSE's profile). No new permission
vocabulary. Audit reuses the existing import lifecycle actions (`import_created`,
`import_started`, `import_performed`, `import_failed`) with integration context in `details` —
no new audit actions, no per-field noise; reads stay audit-silent.

## 9. Source quality report (computed, never fabricated)

`analyzeFeed` computes from the actual parsed rows: rows received / valid / warnings / errors /
duplicates / empty, per-field coverage (populated ÷ total, e.g. manufacturer 66.7% when 2 of 3
rows carry one), and a bounded canonical preview. The `/integrations` page renders it plus the
declared field mapping (source field → canonical field).

## 10. Performance (isolated synthetic SQLite — NOT production CPSE performance)

| Rows | Adapter overhead p50 | Existing pipeline | Total | Adapter share |
|---|---|---|---|---|
| 1,000 | ~5 ms | ~101 ms | ~106 ms | 4.7% |
| 10,000 | ~34 ms | ~807 ms | ~841 ms | 4.1% |
| 100,000 | ~353 ms | ~8,305 ms | ~8,658 ms | 4.1% |

Adapter overhead (parse → transform → validate → serialize) stays ~4% of end-to-end time; the
existing pipeline remains the dominant cost. Source-identity lookup: `EXPLAIN QUERY PLAN` shows
`SEARCH … USING INDEX (organization_id=? AND original_code=?)` — the unique index serves
duplicate detection; no unbounded scans added, no new indexes needed.

## 11. Security, audit, data integrity

Fail-closed CPSE isolation: a feed can only land in the adapter's own CPSE (identity is
declared, not inferred; `assertOrganizationWrite`/org scoping on the API). A failed integration
imports nothing (validation errors abort before any import record is created). Matching remains
untouched — ingestion never approves matches, never creates CMIs, never harmonizes (§31/§32);
it only makes material available to the existing engines.

## 12. Demo data

`data/cpse-feeds/CPCL|NTPC|BHEL|NLC|SAIL-materials.csv` — clearly labelled synthetic demo feeds
in each adapter's declared source format, aligned to the five seeded CPSE organizations. The
existing enterprise synthetic dataset (`data/synthetic-imports/`, seed pipeline, evaluation
fixtures) is unchanged.

## 13. UI

`/integrations` — Integration Center: source-systems grid (adapter, version, format, status,
profile), import flow (profile → file → analyze preview → execute), integration history with
deep links into the existing `/imports/[id]` detail. Same enterprise console style; sidebar
entry "CPSE Integrations" (visible to roles holding IMPORT_MATERIALS).

## 14. Implemented vs future

**IMPLEMENTED (Step 22):** adapter abstraction + five synthetic adapters, registry with
versions, canonical contract, pre-ingestion validation with structured errors, read-only
analyze/preview/quality report, execution through the existing async import pipeline,
integration metadata + history, traceability, CPSE isolation, audit reuse, tests (32 areas),
benchmark.

**FUTURE (documented, not built — §36):** live SAP / Oracle connectors, SFTP/CSV scheduled
feeds, REST push APIs, database-replication ingestion, incremental/delta feeds, adapter
versioning migrations (re-ingest with a new contract version), per-field mapping UI,
integration-specific dashboards. None of these exist in code today.

## 15. Limitations

Synthetic adapters only — formats are plausible, not real. One prototype adapter per CPSE, CSV
first (XLSX rides the same engine). Analyze is per-feed (no cross-feed duplicate detection
before execution — the database remains the authority). Integration metadata is not exposed
through the generic Import Center UI (use `/integrations` history). No scheduled/pull ingestion
of any kind; nothing runs without an explicit authorized request.
