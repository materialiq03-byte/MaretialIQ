# Procurement Data Foundation (Step 12)

> **Data governance:** All procurement records in this prototype are **representative synthetic
> procurement data for demonstration — not actual CPSE purchasing records**. Common Material
> Identities (CMIs) referenced by procurement are **prototype common material identities — not
> official national material codes**.

## Purpose

The procurement layer links purchase history to materials and, where a human-approved
harmonization exists, to the material's Common Material Identity. This creates the identity
bridge that future cross-CPSE demand/spend analytics will aggregate on — without duplicating
any matching logic and without ever modifying matching behavior.

Conceptual chain (only the tail exists after Step 12):

ORGANIZATION -> MATERIAL -> MATERIAL MAPPING -> CMI -> PROCUREMENT RECORD -> { SUPPLIER, PROCUREMENT EVENT }

## Schema (migration v13 SQLite / appendix to the frozen PG v11 schema)

### suppliers

| column | type (SQLite / PG) | notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT / bigint IDENTITY | in PG IDENTITY_TABLES |
| supplier_code | TEXT UNIQUE NOT NULL | deterministic identity |
| supplier_name | TEXT NOT NULL | |
| region | TEXT NULL | |
| is_active | 0/1 CHECK / boolean NOT NULL DEFAULT 1 | |
| created_at, updated_at | timestamp defaults | project convention |

### procurement_records

| column | type | notes |
|---|---|---|
| organization_id | FK -> organizations | must own the material (service-enforced) |
| material_id | FK -> material_records | |
| cmi_id | FK -> common_materials, **nullable** | only set when the material's active CMI mapping exists; procurement **never creates or infers CMIs** |
| supplier_id | FK -> suppliers | |
| purchase_order_reference | TEXT NOT NULL | source-unique idempotency key for the seeder |
| purchase_date / delivery_date | TEXT YYYY-MM-DD | delivery nullable |
| quantity | TEXT + CHECK (CAST(quantity AS REAL) > 0) | exact decimal preserved (SQLite has no decimal type; the CAST makes the check real) |
| uom | TEXT 1-12 chars | **preserved verbatim; no conversion, ever** |
| unit_price / currency | TEXT / TEXT(3), nullable as a pair | CHECK: both NULL or both set; text storage keeps exact decimal digits, no float |
| plant_location | TEXT NULL | |
| procurement_status | CHECK IN (ORDERED, PARTIALLY_DELIVERED, DELIVERED, CANCELLED) | controlled vocabulary |
| source_system | TEXT NULL | e.g. synthetic-seed |

## CMI relationship and validation contract

material_mappings / common_materials remain the **authoritative** identity relationship.
The service layer (src/lib/services/procurement-service.ts) enforces, with **no silent repair**:

| case | situation | result |
|---|---|---|
| 1 | material's active CMI mapping = supplied cmi_id | accept |
| 2 | material unmapped, cmi_id null | accept |
| 3 | material mapped to CMI-A, record claims CMI-B (or claims null) | 409 reject |
| 4 | cmi_id nonexistent | 404 reject |
| 5 | material_id nonexistent | 404 reject |
| 6 | CMI inactive (is_active = 0) | 409 reject — inactive is the kill switch, matching semantics |
| 7 | organization_id != material's organization | 409 reject |

## Indexes (and why)

idx_proc_org, idx_proc_material, idx_proc_cmi, idx_proc_supplier, idx_proc_date —
single-column filters for the four FKs and the default purchase_date DESC list ordering.
idx_proc_cmi_date (cmi_id, purchase_date) and idx_proc_org_date (organization_id, purchase_date)
— the two composite access paths for "CMI/CPSE demand over time", the core future analytics
pattern. Verified with EXPLAIN on an isolated PostgreSQL 16 (Docker, 100k synthetic rows):
both composites are used (Bitmap Index Scan on idx_proc_cmi_date / idx_proc_org_date).

## Deterministic seed

    DATA_DIR=<isolated dir> MATERIALIQ_DB_DIALECT=sqlite npx tsx scripts/seed-procurement.ts

- Refuses to run against PostgreSQL (writes only to the isolated SQLite the DATA_DIR pins).
- Idempotent: re-running skips when procurement_records is non-empty (reports counts).
- Deterministic (mulberry32 PRNG, no Math.random): identical base DB -> byte-identical rows.
- Scenarios: A = CMI-BRG-6205 demand across CPCL/NTPC/SAIL (cmi-linked); B = unharmonized
  material (cmi NULL); C/D/E = multi-supplier, multi-month, all five CPSEs.
- ~215 records, 10 suppliers; everything flows through the validated service (audit included).

## Isolated scale benchmark (synthetic; NOT production performance)

Docker postgres:16-alpine on 127.0.0.1:55432, container destroyed after measurement.

| metric | result |
|---|---|
| bulk insert 1k / 10k / 100k | 14.4k / 18.5k / 17.6k rows/s |
| cmi-filtered list (50 rows) | p50 1.05 ms, p95 1.38 ms |
| org-filtered list | p50 0.97 ms, p95 1.16 ms |
| date-range count | p50 4.29 ms, p95 4.91 ms |
| supplier-filtered count | p50 1.91 ms, p95 2.60 ms |
| paginated list (OFFSET 10000) | p50 5.75 ms, p95 6.88 ms |
| CMI aggregation (GROUP BY cmi_id) | p50 8.46 ms, p95 9.42 ms |

## Authorization & audit

- Read (GET /api/procurement, procurement page): VIEW_MAPPINGS + organization scoping.
- Write (POST /api/procurement): EDIT_MATERIALS, validated by zod schemas
  (procurementCreateSchema, supplierCreateSchema).
- Audit: procurement_created, supplier_created (added to the action CHECK in both dialects),
  actor-attributed; read-only queries generate no audit rows.

## UI

- /procurement (sidebar: DATA -> Procurement): totals strip (records / CPSEs / suppliers /
  CMI-linked / unharmonized), server-side filterable + paginated table
  (Date, CPSE, Material, CMI, Supplier, Qty, UOM, Status, Unit price).
- Common Materials page: each CMI with procurement data shows a linked-procurement summary
  (records, CPSEs, suppliers, per-UOM totals, date range) labelled as synthetic demonstration
  data. Quantities aggregate **per UOM only — no unit conversions are applied**.

## Implemented now vs future

**Implemented now:** schema, suppliers, procurement records with CMI linkage, validation
contract, aggregation primitive (getCmiProcurementSummary), UI foundation, seed, indexes,
auth, audit, tests.

**Future (explicitly NOT in Step 12):** spend aggregation, demand aggregation, supplier
analysis, procurement opportunity detection, price benchmarking, savings estimation, demand
forecasting, UOM harmonization/conversion metadata, procurement Import Center reusing the
existing import architecture, SAP/ERP integration, real CPSE procurement data.


---

# Procurement Import & Ingestion (Step 13)

## Purpose

Production-style ingestion of representative procurement history into the
Step-12 foundation: upload CSV/XLSX → analyze → map columns → validate →
bounded preview → async chunked import. Reuses the **existing** Import Center
machinery (import_runs, chunk ledger, single-active guard, batch writers,
async 202 runner, heartbeats, stale recovery) — only the staging table and
chunk executor are procurement-specific. Matching, CMI creation, and material
master data are NEVER modified by procurement ingestion.

## Supported input & limits

- CSV: up to 50 MB (incremental record-by-record parsing, 64 KB line cap).
- XLSX: up to 5 MB (whole-workbook parse is memory-sensitive).
- These are the frozen pipeline limits (`IMPORT_MAX_CSV_MB` / `IMPORT_MAX_XLSX_MB`);
  the UI states them verbatim and never claims "unlimited enterprise files".

## Input contract

Required: CPSE (organization), material code, supplier, purchase date,
quantity, UOM. Optional: PO reference, delivery date, unit price, currency,
plant/location, procurement status, explicit CMI code. Status vocabulary:
ORDERED / PARTIALLY_DELIVERED / DELIVERED / CANCELLED. Price and currency
must appear together or not at all (Step-12 CHECK). Dates accept ISO
`yyyy-mm-dd` (calendar-validated) and `dd/mm/yyyy`/`dd-mm-yyyy`.

## Column mapping

The analyzer suggests mappings from alias families (CPSE/Organization/Entity,
Material Code/Item/Vendor codes, Vendor/Supplier, PO Date/Order Date,
Qty/Ordered Quantity, Unit/UOM, Rate/Unit Price, Currency Code, Status,
Plant/Site, CMI Code/ID). Suggestions are advisory — the user can override
any mapping; a mapping missing a required target blocks execution.

## Material resolution (organization-aware)

Rows resolve `(CPSE, material code)` against the material master — never
material code alone, because CPSEs use overlapping code spaces. Unknown
combinations are validation errors; import never creates materials.

## CMI resolution (consumption only)

- Material has an ACTIVE mapping → the record carries that CMI automatically.
- Material has an INACTIVE mapping → WARNING; the record is imported with
  cmi_id NULL (the preview mirrors exactly what is stored).
- Explicit CMI in the input: must exist AND match the material's mapping,
  else the row is rejected. Import never repairs or invents mappings.
- No CMI mapping → cmi_id NULL (never fabricated).

## Supplier behavior

Suppliers must already exist (code or exact name). Import NEVER creates
suppliers from uploaded text — unknown supplier is a validation error, which
prevents supplier-master pollution.

## Duplicate policy & idempotency

Signature = deterministic JSON framing of the full source line (org,
material, PO ref, date, quantity, UOM, CMI). A partial unique index on
`row_signature` (non-empty) enforces it in the DB — the final authority behind three layers of defense:

1. intra-chunk seen-set,
2. cross-chunk + re-run batched pre-check (one bounded query per 500 rows),
3. the unique index itself.

Legitimate repeated purchases (different PO/date/quantity) import normally;
the identical source line re-imports as a deterministic SKIP. The signature
is NUL-free JSON framing because node:sqlite truncates bound strings at
embedded NUL bytes.

## Async / batch processing

POST /api/import-jobs { importId, kind: 'procurement' } → 202 + job id;
chunks execute on macrotask ticks with per-chunk transactions, heartbeats,
stale-RUNNING recovery, and a single-active-import guard (partial unique
index). Each chunk: ≤4 batched resolution queries → re-validate → batched
INSERT (bounded multi-row statements). Statement profile is O(chunk), not
O(row). The claim-time snapshot cache parses the (potentially multi-MB)
row_report once per import, not once per chunk — without it, 100k-row
imports were quadratic.

## Validation summary & error handling

Analyze returns totalRows / valid / warning / error plus per-rule counts
(unknown CPSE, unknown material, unknown supplier, invalid date/quantity/
price/currency/status, CMI mismatch, unknown CMI, in-file duplicate, missing
PO reference, unknown UOM). Preview is bounded (first 50 rows) with explicit
VALID/WARNING/ERROR labels plus text markers (never color-only). Analyze-time
rejects are file-level accounting (data_imports.error_rows); job counters
reflect the execution phase. Every skipped row is explainable from the
row_report; no silent drops.

## Authorization & audit

Both routes are server-gated: `IMPORT_MATERIALS` + `assertOrganizationWrite`
(own-CPSE only; authority is read-only; platform_admin passes). Audit events:
`procurement_import_started` (with the real actor, emitted from
createImportJob so both the direct and HTTP paths produce it),
`procurement_import_completed` (last chunk, with imported/skipped/failed),
`procurement_import_failed` (chunk failure with error), plus the shared
import_created/import_started/import_performed lifecycle.

## Measured performance (isolated synthetic benchmark; NOT production numbers)

Deterministic CSV (11 columns), 5 orgs / 1000 materials / 20 suppliers,
single process, SQLite temp DB:

| rows | analyze | import | total | throughput |
|---|---|---|---|---|
| 1,000 | 93 ms | 169 ms | 262 ms | 3,817 rows/s |
| 10,000 | 311 ms | 2,287 ms | 2,598 ms | 3,849 rows/s |
| 100,000 | 2,227 ms | 112,266 ms | 114,493 ms | 873 rows/s |

Two fixes landed during measurement: (1) the executor originally re-parsed
the full row_report JSON blob per chunk — quadratic at scale; a claim-time
snapshot cache made the 100k import ~2x faster (218s -> 112s). (2) The
blob SELECT is now lazy (fetched only on cache miss), avoiding a ~15 MB
read per chunk at 100k rows. The residual 100k slope is dominated by the
row_report blob growth itself (analyze writes ~15 MB of JSON; per-chunk
counter UPDATEs and signature pre-checks scale with it) — a known
reporting-layer cost, NOT per-row DB round trips (per-chunk insert
throughput is flat). XLSX was not benchmarked at scale (the format is
bounded to 5 MB by policy); CSV remains the enterprise path.

## Limitations

- Single-process runner (prototype architecture, unchanged from Step 3).
- row_report is a JSON blob per import — multi-hundred-MB single files would
  need external staging before any further scale-up.
- No UOM normalization (by design; future UOM harmonization step).
- No automatic CMI/material/supplier creation (by design).

## Implemented now vs future

IMPLEMENTED: full import workflow (CSV+XLSX), column mapping with aliases,
org-aware material resolution, CMI consumption, supplier resolution,
deterministic idempotency, async chunked execution, bounded preview and
diagnostics, authorization, audit lifecycle, UI wizard under DATA.

FUTURE: spend/demand analytics, supplier analysis, opportunity detection,
UOM harmonization, procurement Import Center enhancements (saved templates,
scheduled imports), SAP/ERP connectors.

---

# Step 14 — Spend & Demand Aggregation (2026-09-24)

## Aggregation model

All procurement analytics run **database-side** (GROUP BY / SUM / COUNT / MIN / MAX) over
`procurement_records` — the frozen source of truth for procurement history. Import staging tables
(`procurement_import_rows`, `row_report`) are never queried by analytics. Node only decodes
integer-cent totals with `BigInt` (`centsToDecimal`) — no floating-point arithmetic anywhere in a
persisted monetary or quantity total.

Exactness contract: quantity and unit_price hold at most 2 fraction digits (enforced at insert), so
`ROUND(quantity * 100)` and `ROUND(quantity * unit_price * 100)` are true integers; `SUM` over
`INTEGER`s is exact far beyond benchmark scale. Verified: 10 × 0.1 + 0.2 → `0.30` exactly, never
`0.30000000000000004`.

## CMI relationship

CMI aggregation uses the existing authoritative identity chain (`material_mappings →
common_materials`) via the record's stored `cmi_id`. Analytics never reconstruct CMI membership
from similarity, never create or modify mappings, and never run the matching engine.

## Aggregation levels implemented

| Operation | Level | Source |
|---|---|---|
| `getCmiProcurementSummary(cmiId)` | CMI (§9) | counts, per-UOM quantity, per-currency spend, priced/unpriced split, date range |
| `getCmiDemandByOrganization(cmiId)` | CMI + CPSE (§10) | per-CPSE records + per-UOM quantity + per-currency spend |
| `getCmiSupplierSummary(cmiId)` | CMI + supplier (§12) | descriptive only — never a ranking |
| `getCmiMonthlyDemand(cmiId, from, to)` | CMI + month (§11) | gap-filled zero months; historical only, NO forecasting |
| `getOrganizationProcurementSummaries()` | CPSE overall (§13) | linked/unharmonized split per CPSE |
| `listCmiProcurementOverviews()` | per-CMI rollup | Common Material Demand table source |
| `getProcurementCoverage()` | harmonized vs unharmonized (§14) | linked/total ratio + per-state quantity & spend |

## UOM rules

Quantities aggregate **per UOM only**. `120 EA + 180 EA + 90 EA → 390 EA`; `120 EA + 50 SET` stays
separate (`EA: 120`, `SET: 50`). No conversion factors exist anywhere in Step 14; UOM normalization
is future work.

## Spend & currency rules

Spend = `quantity × unit_price`, computed per record in the DB and summed as integer cents.
Currencies are never merged and no exchange rates exist: an INR total and a USD total are separate
buckets. **NULL price** records count toward records/quantity/CPSE/supplier counts and are tracked
separately (`pricedRecords` / `unpricedRecords`) but contribute zero fabricated spend — NULL is
never treated as a zero price.

## Harmonization coverage

`coverageRatio = CMI-linked records / total records` (null when no records exist). Per-state
quantity and spend splits are exposed (`cmiLinked*` / `unharmonized*`). This is a synthetic
demonstration metric, not real CPSE adoption.

## Filtering & pagination

The procurement list remains fully server-side paginated (bounded page size). Step-14 filters added:
`currency` and `uom` exact-match (joining CPSE, CMI, supplier, material, date range, status,
harmonization state). All filters are parameterized SQL-side.

## Indexes & query plans (MEASURED, isolated SQLite, EXPLAIN QUERY PLAN)

The Step-12 indexes already cover the aggregation patterns; **no new indexes were needed**:
- coverage rollup → `SCAN … USING COVERING INDEX idx_proc_cmi`
- CMI-filtered summary → `SEARCH … idx_proc_cmi (cmi_id=?)`
- org+status page → `SEARCH … idx_proc_org_date (organization_id=?)`
- monthly group → `SEARCH … idx_proc_cmi_date (cmi_id=?)` (+ small temp B-tree for the month GROUP BY)

## Performance (MEASURED — isolated synthetic benchmark, NOT production CPSE performance)

| Rows | Coverage p50 | CPSE summaries | CMI summary | Demand-by-org | Monthly | Supplier | Filtered page |
|---|---|---|---|---|---|---|---|
| 1,000 | 1 ms | 1 ms | 0 ms | 1 ms | 0 ms | 0 ms | 1 ms |
| 10,000 | 10 ms | 10 ms | 1 ms | 2 ms | 2 ms | 2 ms | 1 ms |
| 100,000 | 179 ms | 235 ms | 37 ms | 45 ms | 120 ms | 49 ms | 11 ms |

(p95 within ~5% of p50 at every scale; 100k seeding 2.2 s.) Direct SQL aggregation is comfortably
interactive at 100k rows — **no materialized views, cache layer, or analytics warehouse introduced**
(simple architecture kept per §19; revisit only if measured latency demands it).

## Audit & authorization

Every read operation is audit-silent (verified by test: audit count unchanged across all analytics
calls). Authorization is unchanged — pages/APIs gate on the existing `VIEW_MAPPINGS` /
`EDIT_MATERIALS` permissions; the server-side org write guard is re-asserted by test.

## Implemented now vs future

**IMPLEMENTED (Step 14):** all aggregation levels above, exact-decimal/BIGINT-cent decoding,
UOM/currency separation, NULL-price handling, harmonization coverage, DB-side filtering, UI
intelligence sections on `/procurement` (Common Material Demand, Demand by CPSE) and the CMI card
(demand by CPSE table, supplier list, historical monthly demand line), synthetic-data disclaimers
preserved.

**FUTURE (not in Step 14):** procurement opportunity detection, supplier ranking/intelligence,
savings analysis, price benchmarking, demand forecasting, UOM harmonization/conversion, currency
conversion, materialized-view/warehouse layer if measured scale demands it, SAP/ERP integration.

---

# Step 15 — Procurement Opportunity Detection (IMPLEMENTED NOW)

## What an opportunity is

An opportunity means "observed procurement pattern that may deserve human
investigation" — never "do this". Every signal is descriptive, explainable and
review-gated. There are no savings claims, no supplier rankings, no
recommendations and no forecasting anywhere in this layer.

## Opportunity taxonomy and deterministic rules

| Type | Rule (threshold) | Notes |
|---|---|---|
| `CROSS_CPSE_DEMAND` | ≥ 2 distinct CPSEs purchase the same active CMI | evidence carries per-CPSE × per-UOM demand |
| `REPEATED_PROCUREMENT` | ≥ 2 records AND ≥ 2 distinct purchase dates | duplicate import rows can't inflate this (Step-13 row signatures) |
| `FRAGMENTED_DEMAND` | ≥ 2 CPSEs AND ≥ 3 records | descriptive only; never "consolidate" |
| `MULTI_SUPPLIER_ACTIVITY` | ≥ 2 distinct suppliers | factual activity, never a ranking |
| `HIGH_PROCUREMENT_ACTIVITY` | CMI event count ≥ top-decile threshold of the current detection run | DATASET-RELATIVE (needs ≥ 2 CMIs); explicitly labelled, not an industry benchmark |
| `UNHARMONIZED_RELATED_PROCUREMENT` | `cmi_id IS NULL` AND (approved match decision for the material OR the same CPSE has an active CMI member in the same category) | grouped per CPSE + category; material-master REVIEW signal only — never auto-maps |

Signal score (transparent, documented):
`priority_signal = 2 × CPSEs + 2 × suppliers + records`. Deterministic
ordering: score DESC, then id ASC. No ML, no opaque model, no external AI API.

## Evidence model

Each opportunity persists a bounded JSON evidence blob: orgs, suppliers,
records, distinct purchase dates, period, per-org × per-UOM demand buckets
(exact decimal via the Step-14 cents helpers), per-supplier activity, monthly
event counts and the rule factors. Evidence aggregates reconcile 1:1 to the
underlying `procurement_records` (verified by test).

## Persistence & identity

Opportunities are PERSISTED (humans must be able to acknowledge/dismiss/resolve
them). `procurement_opportunities` carries a deterministic
`detection_key = TYPE|scope|period` with a UNIQUE constraint — detection reruns
are idempotent upserts that refresh evidence but NEVER touch human status.

## Human lifecycle

`OPEN → ACKNOWLEDGED | DISMISSED | RESOLVED`, terminal states reopenable with
an explicit reason. Transitions are transactional with a from-state guard: two
competing updates serialize at the DB — exactly one wins, the loser gets 409.
Dismiss/resolve/reopen REQUIRE a short reason (stored + audited); acknowledge
does not.

## Authorization & audit

Read/list/detail: existing `VIEW_MAPPINGS` permission. Transitions and
detection runs: `EDIT_MATERIALS`, re-verified server-side on every request.
Detection and all reads are audit-SILENT; the four transition actions
(`procurement_opportunity_{acknowledged,dismissed,resolved,reopened}`) record
actor, previous/new status, reason and detection key.

## UI

- `/procurement/opportunities` — KPI band, type/status/CPSE/CMI filters,
  server-filtered table, `Run detection` action.
- `/procurement/opportunities/[id]` — WHY FLAGGED, demand by CPSE (per UOM),
  supplier activity (never ranked), source procurement records (bounded
  traceability), governed status actions with reason prompt.
- CMI cards (Common Materials) show open-signal links; `/procurement` carries a
  compact opportunities strip; the platform dashboard gains a three-number
  Procurement Visibility panel.

## Detection performance (MEASURED — isolated synthetic SQLite benchmark, NOT production CPSE performance)

| Procurement rows | Full detection run | Opportunity page | Detail + source records | CMI aggregate | Unharmonized scan |
|---|---|---|---|---|---|
| 1,000 | 50 ms | 0.3 ms | <0.1 ms | 0.2 ms | 0.1 ms |
| 11,000 | 125 ms | 0.2 ms | <0.1 ms | 1.7 ms | 1.4 ms |
| 111,000 | 1,270 ms | 0.2 ms | <0.1 ms | 77 ms | 24 ms |

Detection cost grows sub-linearly (single GROUP BY pass + bounded per-CMI
evidence queries + one unharmonized scan). EXPLAIN QUERY PLAN confirms index
usage (`idx_opp_status`, `idx_proc_cmi`); no new procurement indexes required.
One-time upsert of 52 opportunities at 1k scale; thereafter reruns only refresh.

## FUTURE (not in Step 15)

Supplier intelligence and ranking methodologies, validated savings analysis
(requires a formal baseline methodology), demand forecasting, inventory
optimization, UOM harmonization, currency conversion, approval workflows with
notifications, SAP/ERP integration.

## Step 15 addendum — opportunity source-record traceability (2026-09-24)

IMPLEMENTED NOW: the opportunity detail page's "Source procurement records" table
shows exactly the evidence population for org-scoped
UNHARMONIZED_RELATED_PROCUREMENT signals — the unharmonized records of the
capped evidence material list inside the detection period. It no longer shows
the CPSE's full procurement book (which leaked CMI-linked rows into the
traceability table of an unharmonized signal).

Mechanics: `listOpportunitySourceRecords` reads the opportunity's evidence JSON
`materialIds` (validated positive integers, parameterized IN clause via the new
`ProcFilters.materialIds`), combined with `organizationId`, `harmonized: false`
and the detection period. CMI-scoped and material-scoped opportunity types are
unchanged (they already reconciled).

Verification (MEASURED, isolated SQLite copy, 204 seeded records): signal
id=13 evidence.records=17 → source rows=17, 0 CMI-linked, 0 out-of-period —
RECONCILES=YES. Regression-locked by
`unharmonized signal source records reconcile to evidence (section 23/38)`
in tests/procurement-opportunities.test.ts (24 checks, all green).

Gates after the fix: npm test chain 372 ok / 0 failed, tsc clean, build green,
smoke 35/35 (isolated v15 copy), PG integration 21/21, evaluation
byte-identical (accuracy 0.84, macro P/R/F1 0.8730/0.8596/0.8327, weighted
0.8375, conflicts 20/20). Both frozen baselines unchanged.

## Step 16 — supplier intelligence & explainable supplier visibility (IMPLEMENTED)

A read-only visibility layer above the procurement foundation. It answers which
suppliers supplied a CMI, which CPSEs purchased from a supplier, and what
quantity/spend was recorded — while preserving UOM, currency and traceability
boundaries. **Supplier metrics describe recorded procurement activity and are
not supplier performance ratings.** No ranking, no recommendation, no savings
claims, no reliability/quality inference — enforced by test.

### Architecture

```
suppliers (existing master, untouched — no auto-creation, no merging)
     ↓
procurement_records (source of truth)
     ↓ SQL aggregation (GROUP BY supplier_id / organization_id / cmi_id / uom / currency)
supplier intelligence repository → service → route → UI
```

All aggregation is database-side (SQL GROUP BY / COUNT / SUM / MIN / MAX on
procurement_records); Node never scans full procurement history. CMI identity
comes only from the stored `cmi_id` — never re-inferred. No new tables, no
warehouse/cache layer.

### Supplier metrics (IMPLEMENTED — definitions)

- recordCount — procurement records with this supplier_id
- orgCount — DISTINCT organization_id (CPSEs purchasing from the supplier)
- cmiCount — DISTINCT cmi_id (NULL-cmi rows not counted)
- materialCount — DISTINCT material_id
- quantityByUom — SUM(quantity) per UOM, exact decimal; UOMs never combined
- spendByCurrency — SUM(quantity × unit_price) per currency, exact-decimal
  integer arithmetic (Step-14 cent helpers); currencies never combined
- pricedRecords / unpricedRecords — unpriced rows count toward records,
  quantity, CPSEs, suppliers; they never contribute spend (NULL ≠ 0)
- firstPurchaseDate / lastPurchaseDate — MIN/MAX purchase_date
- isActive — verbatim master-data field (no fabricated statuses:
  no PREFERRED/BLACKLISTED/STRATEGIC)

### Proportion (IMPLEMENTED, documented denominator)

Supplier records share = supplier records / ALL procurement records
(denominator = total procurement_records in the dataset). A factual
proportion — not a supplier rating.

### Visibility surfaces (IMPLEMENTED)

- /procurement/suppliers — paginated list (SUPPLIER | CODE | CPSEs | CMIs |
  RECORDS | LATEST ACTIVITY | STATUS), server-side search over code+name
  (indexed LIKE), server-side filters: CPSE, CMI, date range, UOM, currency
- /procurement/suppliers/[id] — detail: activity metrics, quantity by UOM,
  spend by currency, "Recorded procurement activity by CPSE", CMI activity
  with per-CMI CPSE counts, supplier→CMI→CPSE matrix (UOM-labelled cells,
  em-dash where absent), bounded recent-records table (25) linking each
  metric back to procurement_records (traceability §18)
- CMI cross-reference cards — supplier activity per CMI (supplier, records,
  CPSE count, per-UOM quantity) — descriptive only
- Opportunity detail (Step 15) — supplier evidence rows now carry supplierId
  and link to the supplier page (enrichment, not ranking)
- Sidebar: DATA → Procurement → Suppliers

### Signals (IMPLEMENTED, descriptive)

- MULTI_SUPPLIER_ACTIVITY — CMIs with ≥2 suppliers (Step-15 detection;
  evidence includes per-supplier records with supplierId)
- CROSS_CPSE_SUPPLIER_ACTIVITY — suppliers spanning ≥2 CPSEs
  (getCrossCpseSuppliers; observed pattern; never "national/preferred/
  strategic")
- Records-share proportion with documented denominator

### Authorization & audit (IMPLEMENTED)

Read: VIEW_MAPPINGS via requireApiPermission (server-side on both route
files). Step 16 adds NO mutations, therefore NO new audit events; analytics
reads create ZERO audit rows (verified by test 22). Supplier master remains
governed by the Step-12/13 rules (creation via explicit mutation with audit;
imports require pre-existing suppliers — policy A preserved).

### Performance (MEASURED — isolated synthetic SQLite benchmark, NOT production CPSE performance)

1k / 11k / 111k cumulative procurement records, 20 suppliers, 50 CMIs;
p50 | p95 over 7 runs (`.freebuff/step16-bench.mts`):

| Operation                              | 1k            | 11k           | 111k            |
|----------------------------------------|---------------|---------------|-----------------|
| supplier list (aggregated, 20/page)    | 0.5 / 0.6 ms  | 3.6 / 3.7 ms  | 200 / 205 ms    |
| supplier search (q)                    | 0.4 / 0.5 ms  | 2.2 / 2.2 ms  | 111 / 112 ms    |
| supplier list (org+currency filter)    | 0.3 / 0.4 ms  | 2.0 / 2.1 ms  | 182 / 187 ms    |
| supplier detail bundle (7 queries)     | 0.6 / 1.5 ms  | 2.5 / 6.2 ms  | 114 / 117 ms    |
| supplier detail header metrics         | 0.1 / 0.2 ms  | 0.5 / 0.5 ms  | 29 / 30 ms      |
| supplier → CPSE activity               | 0.1 / 0.1 ms  | 0.5 / 0.6 ms  | 30 / 31 ms      |
| supplier → CMI activity                | 0.1 / 0.2 ms  | 0.7 / 0.7 ms  | 32 / 33 ms      |
| supplier→CMI→CPSE matrix               | 0.1 / 0.1 ms  | 0.4 / 0.4 ms  | 12 / 14 ms      |
| supplier recent records (25)           | 0.1 / 0.2 ms  | 0.3 / 0.3 ms  | 10 / 11 ms      |
| cross-CPSE suppliers                   | 0.5 / 0.7 ms  | 3.7 / 3.9 ms  | 204 / 207 ms    |
| CMI → supplier evidence                | 0.1 / 0.2 ms  | 0.6 / 0.7 ms  | 26 / 27 ms      |

EXPLAIN QUERY PLAN at 111k: every supplier-scoped query SEARCHes
`idx_proc_supplier (supplier_id=?)`; the CPSE/CMI join resolves via the
integer primary key. No table scans of procurement_records. **No new indexes
were added** — the Step-12 `supplier_id` index covers all Step-16 access
paths (§28: added only justified indexes; none required). integrity_check ok,
foreign_key_check 0 violations.

### FUTURE (not in Step 16)

Supplier master harmonization (duplicate detection/merging under human
governance), supplier performance analytics (requires authoritative
delivery/quality/qualification data), validated savings analysis, supplier
qualification workflows, demand forecasting, FX conversion, SAP/ERP supplier
integration.

## Step 17 — UOM harmonization & comparable quantity intelligence (IMPLEMENTED)

A controlled, explainable unit-of-measure layer above the procurement
foundation. It makes quantities comparable across CPSEs ONLY where an
explicit, authoritative conversion rule exists. Original quantity + original
UOM are always preserved; comparable quantities are derived at read time.

```
ORIGINAL QUANTITY + ORIGINAL UOM
        ↓
EXPLICIT UOM RULE (uom_conversion_rules registry, directional, integer factor)
        ↓
NORMALIZED QUANTITY + CANONICAL UOM
        ↓
COMPARABLE AGGREGATION (CMI / CPSE / supplier, per canonical UOM)
```

What it is NOT: no guessed or inferred conversions, no description-based
parsing ("1 SET = 10 PCS" in free text is ignored), no semantic similarity, no
LLM involvement. UOM conversion is governed master data — enforced by test
(banned-language + DOMAIN_SPECIFIC-exclusion checks).

### UOM vocabulary (IMPLEMENTED)

- KNOWN_UOMS (§4): EA, PCS, NOS, SET, KG, G, TON, L, ML, M, CM, MM
- CANONICAL_UOMS (§4): EA (count), G (mass), ML (volume), MM (length)
- Unknown tokens (anything else, e.g. `bX9`) are reported as UNKNOWN in
  quality buckets and UNCONVERTED at row level — never converted, never
  dropped, always visible in the diagnostics list

### Conversion registry (IMPLEMENTED, migration v16)

`uom_conversion_rules`: from_uom, to_uom (CHECK from<>to, trim non-empty),
factor INTEGER > 0, rule_type CHECK IN ('ALIAS','SCALE','DOMAIN_SPECIFIC'),
source (SYSTEM_DEFINED), description, is_active, UNIQUE(from_uom,to_uom,
rule_type). Indexes: idx_uom_rules_from, idx_uom_rules_active(is_active,
from_uom). Seeded with 7 SYSTEM_DEFINED rules:

| from | to | factor | type | note |
|------|----|--------|------|------|
| PCS | EA | 1 | ALIAS | count-unit alias |
| NOS | EA | 1 | ALIAS | count-unit alias |
| KG | G | 1000 | SCALE | SI mass |
| TON | G | 1000000 | SCALE | direct hop to canonical; NO chains (never TON→KG→G); metric tonne only |
| L | ML | 1000 | SCALE | SI volume |
| M | MM | 1000 | SCALE | SI length |
| CM | MM | 10 | SCALE | SI length |

Directional by design: G→KG, ML→L etc. are deliberately NOT registered
(factors must stay integral; reverse derivation is future work). SET has NO
rule — no authoritative generic conversion exists, so SET stays UNCONVERTED
rather than being guessed. DOMAIN_SPECIFIC is reserved vocabulary: unpopulated
and NEVER applied globally (material-scoped pack conversions are future work).

### Conversion statuses (§12) and data-quality buckets (§31)

- NORMALIZED — already canonical (EA/G/ML/MM)
- ALIAS_NORMALIZED — converted via an ALIAS rule
- SCALED — converted via a SCALE rule
- UNCONVERTED — known UOM with no active rule (e.g. SET), or UNKNOWN token
  (service maps UNKNOWN→UNCONVERTED; quality buckets keep them distinct)
- INCOMPATIBLE — reserved (dimension mismatches never aggregate anyway:
  separate canonical buckets mean EA and KG are never summed)
- INVALID — unparseable quantity, or missing/blank UOM

Quality buckets: VALID_CANONICAL / VALID_ALIAS / VALID_CONVERTED /
UNCONVERTED / UNKNOWN, derived from status counts, plus an unknownUoms
diagnostic list (bounded to 50 tokens).

### Decimal safety (IMPLEMENTED)

Reuses the Step-14 exact-decimal contract: quantities hold ≤2 fraction digits
at rest; normalized_cents = qty_cents × factor in pure integer arithmetic
(BigInt on the Node side, INTEGER SUM in SQL). No floating point, no rounding
artifacts: 0.25 KG → 250 G, 1.5 PCS → 1.50 EA, 3 TON → 3000000 G,
99999999999.99 TON → 99999999999990000 G — exact. Presentation strips a
trailing `.00` only; 1.50 stays 1.50.

### Read surfaces (IMPLEMENTED)

- normalizeQuantity(quantity, uom) — row-level conversion with full evidence:
  status, original*, normalized*, and rule {id, fromUom, toUom, factor,
  ruleType, source}
- getCmiComparableDemand(cmiId) — comparable + original per canonical/original
  UOM, status + quality counts, and a per-CPSE breakdown (org rows carry
  original → comparable quantities; the CMI card shows
  "Comparable demand (Step 17 UOM normalization)")
- getSupplierComparableQuantity / bundle.comparable — supplier summary row
  "Comparable quantity (by canonical UOM — Step 17 rules)"
- getOrganizationComparableQuantity — CPSE-level comparable totals
- getUomDataQuality / GET /api/procurement/uom-rules (VIEW_MAPPINGS) —
  registry + quality; /procurement/uom-rules read-only page with an explicit
  disclaimer; "UOM Rules" nav entry
- Procurement list: canonicalUom filter (records normalized to X: source UOM
  or an active rule target) — deliberately distinct from the verbatim `uom`
  filter; labelled "Canonical UOM" in the UI
- Opportunity evidence (Step 15/§18): comparableDemand block added to CMI
  evidence with the note "Comparable quantity calculated using configured UOM
  normalization rules." — enrichment only, source records still traceable

### Authorization, audit, idempotency (IMPLEMENTED)

Read-only layer: VIEW_MAPPINGS on the new route; NO mutations exist; ZERO
audit rows from any analytics read (verified by test 15). No writes to
procurement_records, no warehouse/cache tables, no destructive migration
(v16 only CREATEs). Import Center (Step 13) preserves source UOM verbatim —
normalization happens at read time, so imports stay byte-identical.

### Seed coverage (§32, IMPLEMENTED)

Seven demo records PO-UOM-001..007 (0.25 KG→250 G · 1.5 PCS→1.50 EA NULL
price · 12 SET unconverted · 750 ML USD · 3 TON→3,000,000 G · 2.5 M→2500 MM
EUR · 18 bX9 unknown). Fresh seed: 211 procurement records, 0 rejected;
CMI-BRG-6205 summary: 7 records, quantityByUom {EA:390, KG:0.25, ML:750,
PCS:1.50, SET:12}, spend {INR:504912.69, USD:24825}, priced 6 / unpriced 1.

### Performance (MEASURED — isolated synthetic SQLite benchmark, NOT production CPSE performance)

1k / 11k / 111k cumulative procurement records, 20 suppliers, 50 CMIs, 8 UOM
tokens incl. alias/scale/unknown; p50 | p95 over 7 runs
(`.freebuff/step17-bench.mts`):

| Operation                              | 1k           | 11k           | 111k            |
|----------------------------------------|--------------|---------------|-----------------|
| CMI comparable demand (UOM join)       | 0.7 / 1.7 ms | 2.6 / 3.8 ms  | 191 / 209 ms    |
| CPSE comparable quantity               | 0.7 / 0.9 ms | 4.0 / 7.4 ms  | 180 / 187 ms    |
| supplier comparable quantity           | 0.2 / 0.3 ms | 1.1 / 1.1 ms  | 106 / 114 ms    |
| supplier bundle incl. comparable       | 1.0 / 1.7 ms | 3.5 / 4.6 ms  | 432 / 504 ms    |
| UOM data-quality scan                  | 1.9 / 2.1 ms | 17.4 / 17.7 ms| 595 / 605 ms    |
| UOM registry read                      | 0.0 / 0.1 ms | 0.0 / 0.0 ms  | 0.1 / 0.2 ms    |
| row normalizeQuantity ×1000            | 28.3 / 30.5 ms | 26.8 / 27.7 ms | 80.5 / 88.1 ms |
| list (canonicalUom=EA)                 | 0.4 / 0.9 ms | 1.0 / 1.3 ms  | 48 / 61 ms      |

EXPLAIN QUERY PLAN at 111k: the normalization join SEARCHes
`idx_uom_rules_active (is_active, from_uom)` LEFT-JOIN over a ≤7-row registry;
CMI scope resolves via `idx_proc_cmi`. The canonicalUom filter uses the
verbatim-UOM OR + indexed registry subquery. integrity_check ok,
foreign_key_check 0 violations.

### FUTURE (not in Step 17)

Material-specific (DOMAIN_SPECIFIC) conversions with authoritative per-
material pack data; reverse/scale-down rules if master data ever demands
non-integral factors; CPSE-published UOM dictionaries and master-data sync;
SAP/ERP UOM ISO code integration; quality remediation workflows for UNKNOWN
UOMs; unit-dimension inference is explicitly out of scope forever (no
guessed conversions).

## Step 18 — material-specific UOM rules, governance & quality remediation (IMPLEMENTED)

Extends the Step-17 engine with the governed human layer: DOMAIN_SPECIFIC
rules scoped to one CMI, a PENDING→APPROVED/REJECTED (+DISABLED/re-enable)
lifecycle, audited governance actions and a quality-remediation surface. The
Step-17 guarantees are untouched: the 7 SYSTEM_DEFINED rules, vocabularies,
statuses, exact decimal arithmetic and read-only analytics are unchanged.

### Data model (migration v17, CREATE-only)

`uom_domain_rules`: cmi_id (FK, the scope), from_uom/to_uom (CHECK from<>to),
factor INTEGER > 0, rule_type pinned 'DOMAIN_SPECIFIC', status CHECK IN
('PENDING','APPROVED','REJECTED','DISABLED') DEFAULT 'PENDING', source
'GOVERNED', reason NOT NULL (evidence required), created_by, approved_by,
decided_at, timestamps. Indexes: idx_uom_domain_lookup(cmi_id, from_uom,
status); partial UNIQUE uq_uom_domain_live ON (cmi_id, from_uom) WHERE status
IN ('PENDING','APPROVED','DISABLED') — schema-level guarantee of at most one
LIVE rule per (CMI, source UOM); a REJECTED rule may be superseded.
SQLite audit_logs CHECK extended (v17 rebuild) with the five governed events.

### Rule precedence (section 5) — service and SQL identical

1. APPROVED domain rule scoped to the record's CMI →
2. SYSTEM_DEFINED ALIAS → 3. SYSTEM_DEFINED SCALE → 4. UNCONVERTED.
`resolveEffectiveUomRule(uom, cmiId?)` implements it row-level; the SQL
aggregation joins uom_domain_rules (APPROVED only, dr.cmi_id = pr.cmi_id)
ahead of the Step-17 registry join. PENDING/REJECTED/DISABLED never convert.
Domain rules only ever apply to records of the scoped CMI — a SET→EA rule is
invisible to every other CMI and to all unscoped reads (never global).

### Governance workflow (sections 4/8/9)

Create (PENDING, audited uom_rule_created) → Approve/Reject (audited, actor +
previous/new state) → Disable → Re-enable. Invalid transitions fail closed.
New permission MANAGE_UOM_RULES (authority + platform_admin) guards
POST /api/procurement/uom-rules and POST /api/procurement/uom-rules/[id]/
transition. Reads remain unaudited. No rule becomes active automatically;
creation requires an explicit human reason/evidence (fail-closed validation:
unknown CMI, non-canonical target, self-conversion, non-integer factor,
duplicate live rule all rejected).

### Quality remediation (section 11)

/procurement/uom-rules shows the per-CMI remediation board (UOM buckets with
categories + record counts, "View affected records" links into the filtered
procurement list) and the unknown-UOM diagnostics with the wording "No
approved conversion rule exists." The proposal form (scope, from, canonical
to, integer factor, mandatory evidence) creates PENDING rules only; nothing
is ever created automatically. Governance UI sections: SYSTEM RULES and
MATERIAL-SPECIFIC RULES with Scope | Material/CMI | From | To | Factor |
Status | Evidence | Creator | Approver | Action.

### Performance (MEASURED — isolated synthetic SQLite benchmark, NOT production CPSE performance)

Same 1k/11k/111k harness with one APPROVED domain rule live
(`.freebuff/step18-bench.mts`): scoped CMI comparable 78.9 ms p50 @111k
(Step-17 path: 67.1 ms; +12% for the extra indexed hop), CPSE 86.6 ms,
supplier 43.7 ms, bundle 157.4 ms. EXPLAIN: `SEARCH dr USING
idx_uom_domain_lookup (cmi_id=? AND from_uom=? AND status=?)` LEFT-JOIN over
the tiny governed table — no procurement scans added. integrity ok, FK 0.

## Step 19 — UOM rule history, steward governance & role-based lifecycle (IMPLEMENTED)

### Rule history (append-only)

Migration v18 adds `uom_rule_history` — an append-only chronological record of every
governance event on a governed DOMAIN_SPECIFIC rule: rule_id, scope (cmi_id), from_uom,
to_uom, factor, rule_type, previous_status, new_status, action (CREATE / APPROVE / REJECT /
DISABLE / RE_ENABLE), actor, reason (the rule's evidence at that moment) and created_at.
Append-only is **physical**, not conventional: SQLite BEFORE UPDATE/DELETE triggers abort
any rewrite ("historical records must never be rewritten/deleted"); the PostgreSQL appendix
grants INSERT only (REVOKE UPDATE, DELETE). A partial UNIQUE index allows at most one
CREATE row per rule; migration backfills one CREATE row per pre-existing rule
(previous_status NULL → PENDING, actor = created_by), idempotent on re-run. History rows
are written ONLY inside the governed create/transition service transactions — the same
transaction that writes the audit event — so audit and history always agree. Reads are
audit-silent. The live rule in `uom_domain_rules` remains authoritative; history answers
"what happened to this rule over time?" and is never rewritten or deleted when a rule is
disabled or re-enabled.

### Steward dashboard

`/procurement/uom-steward` (nav: UOM Steward) — enterprise governance view in the existing
dense console style:

- RULES: total / pending / approved / rejected / disabled (SQL GROUP BY over the governed table).
- QUALITY: unknown UOMs with counts, unconverted records (UNCONVERTED + UNKNOWN), CMIs
  requiring remediation (SQL COUNT(DISTINCT cmi_id) over records with out-of-vocabulary UOMs),
  full quality distribution; unknown tokens are labelled "No approved conversion rule exists."
- ACTIVITY: rules created / approved / rejected / disabled / re-enabled over the last 30 days,
  aggregated from the history table (never procurement records), plus the 25 most recent events
  with actor, old→new state and the rule's current status.
- WORK QUEUE: every PENDING rule awaiting a human decision — scope, conversion, status,
  created by/when, CMI record count, affected-record count (bounded indexed COUNTs), history
  count, Review deep-link to the rule detail.

The page is read-only; governance mutations remain on `/procurement/uom-rules`.

### Rule detail + history UI

`/procurement/uom-rules?rule=<id>` (deep-linked from the steward dashboard and from every
rule row) shows scope, conversion, type/source, evidence/reason, creator/approver,
timestamps, a "View affected records" link and the append-only history table. Governance
actions render per current status (PENDING → Approve/Reject; APPROVED → Disable; DISABLED →
Re-enable); invalid ids fail closed to "no governed rule matches that id".

### Role-based governance demo

Uses the EXISTING roles/permissions (demo-switcher), no new authentication: a STEWARD-class
role (e.g. cpse_material_manager, no MANAGE_UOM_RULES) investigates remediation buckets and
proposes a rule via the governed API (creation itself is not gated); an APPROVER role
(authority / platform_admin, holds MANAGE_UOM_RULES) reviews scope/conversion/evidence/
affected records/history and approves, rejects, disables or re-enables; any other role is
read-only (pages + history visible, mutation buttons absent and API-denied). The full demo
walk: unknown/unconverted → investigate → propose (PENDING) → review → approve (conversion
appears) → disable (conversion stops) → re-enable (conversion resumes) — every step audited
and historically visible.

### API

- GET `/api/procurement/uom-rules/[id]/history` — append-only history for one rule
  (chronological; fail-closed on non-numeric ids and unknown rules).
- GET `/api/procurement/uom-steward` — the steward overview (counts, quality, activity,
  pending queue, recent activity).
- Existing governance routes unchanged: propose (POST /api/procurement/uom-rules) and
  transition (POST /api/procurement/uom-rules/[id]/transition) now also append history
  inside the same transaction. Authorization unchanged: MANAGE_UOM_RULES gates all
  mutations; reads remain VIEW_MAPPINGS-class.

### Step 17/18 invariants preserved

The seven SYSTEM_DEFINED rules, the precedence (approved domain > system ALIAS > system
SCALE > UNCONVERTED), scope isolation, exact integer-cent arithmetic, original-record
preservation and the no-guessing policy are untouched. The conversion engine itself
(resolution + SQL joins) did not change in this step — only governance observability grew.

### Tests & performance (synthetic, isolated)

`tests/procurement-uom-history.test.ts` (16 checks, in the npm test chain): history creation,
physical append-only (UPDATE/DELETE refused), every event type with correct old→new state and
actor, invalid-transition atomicity (no state/audit/history writes), authorization matrix,
steward aggregation, pending-queue context counts, history shape, role-based walk, conversion
only-after-approval / stops-on-disable / resumes-on-re-enable, original-data preservation,
Step 17 regression (registry + 390 EA + decimals), Step 18 regression (precedence + scope),
SQL/service parity with a live domain rule. Isolated benchmark (`step19-bench.mts`, NOT
production CPSE performance): 1k/11k/111k — history-by-rule ≈0 ms at every scale; steward
dashboard 2.3/20.1/369.8 ms p50 (dominated by the reused Step-17 global quality pass; the
new governance aggregates are ≤1 ms); comparables unchanged from Step 18. EXPLAIN: history
by rule = SEARCH idx_uom_rule_history_rule; activity = SEARCH idx_uom_rule_history_time;
pending-queue counts = SEARCH idx_proc_cmi; no scans; integrity ok, FK 0.

## Step 20 — versioned rule content amendment, audit/history reconciliation (IMPLEMENTED)

### Version model

Migration v19 adds `uom_domain_rule_versions` — immutable CONTENT versions of governed
DOMAIN_SPECIFIC rules: rule_id FK, version_number (UNIQUE per rule), cmi_id, from_uom,
to_uom, factor, rule_type, amendment_reason, created_by, created_at,
supersedes_version_id. Immutability is **physical** (SQLite UPDATE/DELETE triggers abort;
PG appendix grants INSERT only). The live rule in `uom_domain_rules` stays the lifecycle
authority and gains two pointer columns (plain INTEGER, deliberately FK-free to avoid a
cycle with versions.rule_id — the backup tool's topological sort forbids cycles):
`effective_version_id` (the ONLY content conversion may use) and `pending_version_id`
(amendment awaiting decision). The live row's denormalized from/to/factor/reason always
mirror the effective version, so read models stay single-sourced.

Backfill (documented, deterministic): exactly one v1 per pre-existing rule, content equal
to the live row; APPROVED/DISABLED rules get `effective_version_id = v1` (DISABLED rules
were approved before being disabled and convert again on re-enable); PENDING/REJECTED
rules keep NULL. New rules get their v1 written inside the creation transaction. No
conversion behavior changes for un-amended rules.

### Amendment lifecycle

APPROVED/DISABLED rule → propose amendment (one governed transaction: immutable next
version with MAX+1 numbering inside the tx + UNIQUE(rule_id, version_number) so races
cannot duplicate, pending pointer, AMEND history event, `uom_rule_amended` audit event)
→ PENDING version converts NOTHING → authorized decision: APPROVE makes v_next effective
(status never changes — approving an amendment on a DISABLED rule must not silently
activate it; re-enable stays a separate human act), REJECT discards the pending pointer.
Decisions are VERSION decisions: they consume the pending version and write APPROVE/REJECT
history rows with version context (`version_id` = decided version,
`previous_version_id` = superseded one). Amendment fields: factor, to_uom, from_uom, with
all Step-18 validation preserved (canonical target, factor > 0, from ≠ to, mandatory
evidence, one pending amendment at a time). Old versions remain available forever and are
never rewritten.

Separation of duties (section 18, explicit): the proposer of an amendment cannot approve
or reject it (enforced in `decideUomRuleAmendment`; the initial CREATE keeps the existing
Step-18 role matrix without new policy). Authorization otherwise unchanged:
MANAGE_UOM_RULES gates all mutations; read-only roles can view versions/history/agreement.

### Effective-version resolution (section 8/20)

One authoritative resolver: the SQL scoped join keeps matching on the live rule's
APPROVED status, but the rule's content IS the effective version's content (synchronized
at decision time inside the same transaction). Row-level
`resolveEffectiveUomRule`/`normalizeQuantity` reads the same live row. Precedence is
unchanged (APPROVED CMI rule → system ALIAS → system SCALE → UNCONVERTED); PENDING,
REJECTED, superseded versions and DISABLED rules never convert. With no amendments,
output is byte-identical to Step 18.

### Audit ↔ history agreement + reconciliation (sections 13/14)

HISTORY = rule-state chronology; AUDIT = security/governance record; two separate
append-only ledgers, never merged. New read-only observability:

- `listUomRuleAgreement(ruleId)` — per-rule timeline pairing each history event with its
  audit twin (greedy one-to-one match on rule+actor+expected action within ±5s, mirroring
  how the ledgers are appended in the same transactions). Each row shows action, version
  and previous version, status transition, content, reason, audit id/action and whether
  the audit's conversion evidence agrees (`auditDetailsMatch`).
- `reconcileUomGovernance()` — whole-ledger reconciliation returning
  RECONCILED or DISCREPANCIES_FOUND with explicit evidence
  (MISSING_AUDIT_EVENT / UNEXPECTED_AUDIT_EVENT). Read-only: discrepancies are reported,
  never repaired.

### API

- POST `/api/procurement/uom-rules/[id]/amend` — propose amendment (MANAGE_UOM_RULES).
- PATCH `/api/procurement/uom-rules/[id]/amend` — decide pending amendment
  (approve|reject; MANAGE_UOM_RULES; SoD enforced in service).
- GET `/api/procurement/uom-rules/[id]/agreement` — read-only agreement timeline.
- Existing transition route unchanged and still used for lifecycle decisions.

### UI

Rule detail (`/procurement/uom-rules?rule=<id>`) now shows: VERSIONS (immutable content —
effective / pending / superseded badges, supersedes chain, amendment reasons), Propose
amendment form (governed roles), Approve/Reject amendment actions when a version is
pending, the Step-19 append-only history, and the AUDIT ↔ HISTORY AGREEMENT table.
Steward dashboard gains: AMENDMENT WORK QUEUE (rule, scope, current vs proposed version
with conversions, proposer, reason, affected-record count, Review), VERSION ACTIVITY
(total versions, superseded, amendments proposed/approved/rejected over 30 days) and a
RECONCILIATION panel (history/audit events checked, reconciled count, discrepancy count
and evidence table; RECONCILED / DISCREPANCIES_FOUND status badge).

### Tests & performance (synthetic, isolated)

`tests/procurement-uom-versioning.test.ts` (20 checks, in the chain) covers the section-24
areas: v1 creation, deterministic numbering, UNIQUE constraint, pending/inert amendments,
approval effectiveness with exact comparable math (12 SET ×12 = 144 EA; 12+2.5 SET ×12 =
174 EA), rejection, disable/re-enable with amended versions, physical immutability, old
content survival, AMEND history + audit with old/proposed content, atomicity via a
sabotage trigger (a failed amendment leaves ZERO trace in any ledger), invalid proposals
write nothing, authorization + SoD, original-data preservation, SQL/service parity,
Step-17/18/19 regressions, reconciliation clean + injected-discrepancy detection, steward
queue, version ordering, migration idempotency. Benchmark (`step20-bench.mts`, isolated
synthetic SQLite, NOT production CPSE performance): version list ≈0 ms, agreement 0.1 ms,
reconciliation ≈0 ms at every scale including 111k; comparables unchanged
(CMI V2 69.2 ms @111k); steward dashboard 334.6 ms p50 @111k (dominated by the reused
global quality pass). EXPLAIN: `SEARCH v USING idx_uom_rule_versions_rule`; comparables
and queue unchanged (idx_proc_cmi / idx_uom_domain_lookup / idx_uom_rules_active). No
procurement scans introduced by version resolution. integrity ok, FK 0.

## Step 21 — governance cockpit & unified human work queue (IMPLEMENTED)

### Cockpit architecture

`/procurement/governance` (nav: Procurement → Governance) is a **read-only** orchestration
layer over the existing engines. No migration, no new event source, no second
reconciliation algorithm, no duplicated quality logic — the cockpit aggregates what
Steps 12–20 already record:

- SUMMARY: open technical reviews (`review_queue` open/in_progress), pending UOM rules,
  approved rules, rules with a valid effective version, pending amendments, CPSE
  organizations without any CMI mapping, unknown-UOM tokens, unconverted records, CMIs
  requiring remediation, governance events over 30 days. Every number is SQL-side or a
  direct call into the Step-17/18 quality pass.
- HUMAN WORK QUEUE (unified): MATCH_REVIEW (from review_queue ⨝ match_candidates, with
  both material codes, orgs, priority and reason; deep link `/proposals?status=NEEDS_REVIEW`),
  UOM_RULE_APPROVAL (Step-19 steward pending queue; deep link rule detail),
  UOM_RULE_AMENDMENT (Step-20 amendment queue; the ref shows current → proposed version
  and conversion), UOM_REMEDIATION (unknown UOMs; "No approved conversion rule exists."),
  CMI_GOVERNANCE (coverage gap → `/cross-reference`). The queue routes users into the
  existing workflows; it never mutates.
- GOVERNANCE HEALTH: six explainable, threshold-based indicators (PASS / WARNING /
  ACTION REQUIRED) with evidence strings — audit↔history agreement (Step-20
  reconciliation reused verbatim), effective-version coverage, pending decisions, UOM
  quality, review backlog age, CMI backlog. No invented score, no AI-confidence number.
- UOM QUALITY: the Step-17/18 buckets and unknown-UOM diagnostics, reused as-is.
- RULE & AMENDMENT ACTIVITY: merged read-only timeline of UOM rule history + audit trail,
  each row source-tagged (HISTORY vs AUDIT) so identity is preserved; never merged
  physically.
- STEWARD MONTHLY SUMMARY: whole-month buckets from `uom_rule_history`
  (created / approved / rejected / disabled / re-enabled / amendments proposed, last 12
  months with events). Amendment approvals are distinguished from initial approvals via
  version context.
- RECONCILIATION: the Step-20 result (RECONCILED / DISCREPANCIES_FOUND + evidence),
  displayed as-is; the cockpit never repairs.

### Data sources

`review_queue`, `match_candidates`, `material_records`, `organizations`,
`material_mappings`, `common_materials`, `procurement_records` (aggregate counts only),
`uom_domain_rules`, `uom_domain_rule_versions`, `uom_rule_history`, `audit_logs` — all
existing tables. **No migration was added in this step.**

### Authorization & audit

Page and API are read-only: `requirePermission('VIEW_MAPPINGS')` /
`requireApiUser()`. Mutations stay on their existing governed endpoints
(MANAGE_UOM_RULES, separation of duties). Reads create zero audit rows and zero history
rows (pinned by tests). The page shows a role-appropriate note; no client-side security.

### Performance (isolated synthetic SQLite — NOT production CPSE performance)

1k/11k/111k: full cockpit 2.4/58→24/434.6 ms p50 — after threading the global quality
pass through as a single computation (926 → 434.6 ms @111k). Work-queue review items
0.1 ms (`idx_queue_status_priority`), activity/monthly ≈0 ms
(`idx_uom_rule_history_*`), summary 21.6 ms at 111k (quality scan dominates; the Step-17
engine itself was deliberately not restructured). EXPLAIN: all cockpit queries SEARCH on
existing indexes; the only SCANs are over the tiny governed tables and
`organizations`/`material_mappings` (tens of rows in the data model), never an
unbounded procurement scan. integrity ok, FK 0.

### Tests

`tests/procurement-governance-cockpit.test.ts` (15 checks, in the chain): real counts,
all five queue types + deep links, version info in queue refs, authorization matrix,
read-only (no audit/history writes), explainable health, reconciliation/quality reuse,
activity source identity, monthly determinism, invalid-ID fail-closed, synthetic-data
integrity, SQL/service parity, Step-17/18/19/20 regressions.

### Limitations & future

The cockpit observes; it does not act. Review-backlog aging uses queue `opened_at` only;
the monthly report is history-table-derived (audit-only events are out of its buckets);
export is not included (FUTURE: CSV/print steward report, saved filters, per-CPSE
cockpit scopes, richer diff UI on the queue rows).

## Step 22 — CPSE integration layer: source adapters & ERP-agnostic ingestion (IMPLEMENTED)

Integration boundary between heterogeneous CPSE material-master feeds and the EXISTING Import
Center. NOT live ERP/CPSE integration — synthetic demo adapters over clearly labelled synthetic
source formats (see docs/CPSE-INTEGRATION.md for the full document). Procurement boundaries are
unchanged: nothing here touches procurement_records, UOM rules, review_queue, matching or CMI
governance; ingestion only makes materials AVAILABLE to the existing engines, exactly like an
Import Center import always did.

### What was added (src/lib/integrations/)

- `canonical-contract.ts` — one canonical ingestion contract (CanonicalMaterialRow); CPSE is
  never inferred from data; identity is CPSE+sourceSystem+sourceRecordId (never description,
  never UUID); semantic extraction deliberately stays downstream in the existing pipeline.
- `adapter-interface.ts` — declared adapter profile (field map + vocabulary + validation) and
  the shared row builder (unknown source columns RETAINED in sourceMetadata).
- `adapters.ts` — five synthetic profiles: CPCL-MATERIAL-v1, NTPC-MATERIAL-v1,
  BHEL-MATERIAL-v1, NLC-MATERIAL-v1, SAIL-MATERIAL-v1 (different headers/vocab, same rules).
- `registry.ts` — the single resolution mechanism; duplicate id / duplicate CPSE registration
  fails loudly; API view exposes no secrets.
- `parse-and-validate.ts` — feed parsing REUSING the existing CSV/XLSX engine, per-row
  validation with structured {row, field, code, message} diagnostics, source-quality report
  (rows/valid/warnings/errors/duplicates + per-field coverage) computed from ACTUAL data.
- `integration-service.ts` — read-only analyze (no DB writes, audit-silent, idempotent) and
  execute via the EXISTING analyzeImport + chunked async import job; integration metadata
  (adapter id/version, source identity model, validation summary, field mapping/coverage)
  stored additively in the import's existing row_report JSON — NO schema change (stays v19).

### Boundary guarantees

Reuse, not replacement: the Import Center, its validator, the async job engine, audit actions
(existing import_* vocabulary with integration context), permissions (IMPORT_MATERIALS + org
scoping; no new permission vocabulary) and traceability (import_id + source_row +
UNIQUE(organization_id, original_code)) are all reused verbatim. Matching/harmonization remain
separate stages — no auto-approval, no auto-CMI. A feed with validation errors imports nothing.

## Step 23 — matching & technical-review hardening (IMPLEMENTED)

Procurement boundaries untouched: no procurement table, UOM rule, governance or cockpit logic
changed. The matching engine, weights (30/20/30/20) and verdict thresholds (80/60/30) are
frozen and test-asserted; Step 23 adds the review CONTRACT and workspace hardening on top —
`getMatchReview` composes persisted scores/evidence into the reviewer-facing structure
(technical comparison rows, conflicts, missing evidence, assembly/manufacturer/category
relationships, deterministic WHY bullets), `GET /api/matches/:id/evidence` serves it read-only
(audit-silent), `POST /api/matches/:id` accepts an optional `expectedStatus` staleness guard,
and the review queue gains category/band/conflict filters, deterministic sorting and a real
summary (open reviews, conflicts, missing evidence, assembly, cross-brand). The Governance
Cockpit keeps reading the same review_queue/match_candidates sources — no duplication. See
docs/MATCHING-REVIEW.md. No schema change (stays v19).
