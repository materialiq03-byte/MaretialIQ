# MaterialIQ — Material Harmonization Review Console

**SIH 2026 · Problem Statement 26099 · Smart Automation.** An ERP-agnostic material
intelligence layer for CPSEs: governed source-adapter ingestion → one canonical
contract → deterministic, explainable matching → human-governed harmonization →
CMI / procurement intelligence.

Cross-CPSE material harmonization: a deterministic matching engine proposes candidate
mappings between material records from different CPSE organisations, every proposal
carries computed scores and a written explanation, and **nothing becomes a mapping
without a recorded human decision**. Original CPSE material codes are never modified.

**Documents:** solution overview `docs/SOLUTION-OVERVIEW.md` · architecture
`docs/SIH-ARCHITECTURE.md` · evidence manifest `docs/SIH-FINAL-EVIDENCE-MANIFEST.md`
· demo script `docs/DEMO-SCRIPT.md` · judge Q&A `docs/SIH-JUDGE-QA.md` · security
`docs/SECURITY.md` · threat model `docs/THREAT-MODEL.md`. Honest AI framing:
*deterministic similarity + technical rule analysis* — no LLM.

> **All data in this repository is synthetic demonstration data.** It does not
> represent any real CPSE catalogue, and match classifications are application
> conventions, not official standards.

## Install

```bash
npm install
```

Requires **Node >= 22.5** (uses the built-in `node:sqlite` module — no native
compile step, no external database service).

## Configure

Copy `.env.example` to `.env` and adjust if needed. Everything works with defaults
for local development; see the environment table below.

## Initialize the database & seed synthetic demo data

```bash
npm run db:migrate   # creates/updates SQLite schema (versioned migrations)
npm run db:seed      # loads the synthetic 5-CPSE demo dataset + initial match run
npm test             # pipeline tests: normalization, classification, extraction, units, quality
```

Seeding is idempotent. To rebuild from scratch: stop the dev server, delete
`data/materialiq.db*`, and run both commands again.

### SIH 2026 synthetic demo dataset (Step 6)

50 additional realistic records (10 per CPSE — CPCL/CP-6xxx, NTPC/NT-64xx,
BHEL/BH-30xx, NLC/NL-77xx, SAIL/SL-99xx) live in `data/synthetic-imports/*.csv`,
designed with intentional harmonization scenarios:

- **Strong match** — `CP-6001` ↔ `NT-6401` ↔ `SL-9901` (SKF 6308-2RS ball
  bearing, three wordings: BALL BEARING / BALL BRG / BALL BRG)
- **Seal conflict** — `CP-6001` vs `BH-3001` (6308-2RS vs 6308-ZZ) →
  NEEDS_TECHNICAL_REVIEW naming `seal_type: 2RS vs ZZ`
- **Pressure-class conflict** — `CP-6002` vs `NT-6402` (gate valve 2in 150# vs
  300#) → NEEDS_TECHNICAL_REVIEW naming `pressure_class`
- **Voltage conflict** — `CP-6005` vs `BH-3005` (SIEMENS 30KW 415V vs 230V) →
  NEEDS_TECHNICAL_REVIEW naming `voltage_rating`
- **Category gate** — bearing vs pump wording pairs never become candidates
- **Validation fixtures** — `VALIDATION-SCENARIOS.csv` exercises missing code,
  missing description, in-file duplicate codes, unsupported category, malformed
  voltage, bad UOM, and illegal code characters

These are unmodified input CSVs: import them through the Data Import Center
(upload → CPSE → mapping → validation → confirm) and the Step 5 engine computes
all match decisions — nothing is hard-coded. The CSVs are **synthetic demo data
— not official CPSE data**; imported codes are prototype identifiers, not
government material codes.

## Run development server

```bash
npm run dev          # prints its own localhost port on startup
```

## Production build

```bash
npm run build
npm start
```

## Docker (one-command demo, TRD §18/§35)

```bash
docker compose up --build      # → http://localhost:3000
# or: docker build -t materialiq . && docker run -p 3000:3000 materialiq
```

The image runs `db:migrate` + `db:seed` (both idempotent) before serving; the
SQLite database lives in the `materialiq-data` volume so demo data persists
across container replacements. Health check: `GET /api/health`.

## Analytics & matcher quality (PRD §15, TRD §20/§34)

`/analytics` renders Recharts dashboards built from live SQL aggregates:
decision-state distribution, materials by category/CPSE, top pending critical
conflicts, and a per-CPSE harmonization snapshot — plus **matcher quality
against the labelled synthetic ground truth** (same-item groups vs conflicting
variants designed into `data/synthetic-imports/`):

- **Precision** — of pairs auto-matched HIGH_CONFIDENCE, share truly same-item
- **Recall** — of true same-item pairs, share found as high-confidence candidates
- **F1** — harmonic mean of the two
- **Conflicts caught / unsafe auto-matches** — the fail-safe metric (target: 0 unsafe)

A conflict pair routed to human review counts as correctly caught. Metrics are
deterministic and re-computed from the same engine that produced the stored
candidates (`src/lib/matching/evaluation.ts`, tests in `tests/analytics.test.ts`).

## Current architecture

```
src/
├── app/                     # Next.js App Router pages + /api route handlers
│   ├── page.tsx             # Dashboard (SQL-computed metrics only)
│   ├── materials/           # Catalog (search/filter/sort/pagination) + [id] detail
│   ├── proposals/           # Approval queue + decision card component
│   ├── cross-reference/     # Common material identities + per-CPSE mappings
│   └── api/                 # REST handlers: organizations, materials, matches,
│                            #   imports, review-queue, common-materials, mappings,
│                            #   metrics, audit
├── components/              # (reserved; shared components live next to their pages)
├── lib/
│   ├── config.ts            # env-driven configuration
│   ├── errors.ts            # AppError hierarchy → HTTP mapping
│   ├── api-helpers.ts       # JSON envelope, error translation, pagination
│   ├── pipeline/            # DATA INTELLIGENCE PIPELINE (deterministic, no AI)
│   │   ├── normalize.ts     # description normalization (safe token expansion)
│   │   ├── classify.ts      # rule-based category classifier
│   │   ├── extract.ts       # per-category technical attribute extraction
│   │   ├── units.ts         # unit canonicalisation (no conversions)
│   │   ├── quality.ts       # GOOD/WARNING/INCOMPLETE/INVALID checks
│   │   └── index.ts         # orchestrator
│   ├── matching/engine.ts   # deterministic scoring + classification (no AI yet)
│   ├── services/            # business logic: material (incl. import), file-parse,
│   │                        #   matching, registry, metrics
│   ├── validation/schemas.ts# zod schemas for every input
│   ├── types/domain.ts      # shared enums
│   └── db/
│       ├── client.ts        # node:sqlite connection, WAL, FK enforcement
│       ├── migrate.ts       # versioned migrations
│       └── repositories/    # all SQL lives here, one file per aggregate
└── scripts/
    ├── migrate.ts           # npm run db:migrate
    ├── seed.ts              # npm run db:seed (synthetic data only)
    └── seed-data.ts         # the synthetic dataset
```

Layers: **route handler → service (validation, transactions, audit) → repository
(SQL) → SQLite**. Pages call services/repositories directly for server-rendered
reads; route handlers wrap everything in uniform JSON error handling.

### Data intelligence pipeline (Step 3)

Every material — seeded or imported — passes through the same deterministic
pipeline (`src/lib/pipeline/`), with the original description **always** preserved:

1. **Normalization** — uppercase, whitespace/punctuation collapse, glued unit
   splitting (`75KW → 75 KW`), safe token-exact abbreviation expansion
   (`BRG → BEARING`, `MTR → MOTOR`, `PMP → PUMP`, `VLV → VALVE`). Compact codes
   (`6205-2RS`, `M20X80`, `8X6-11`, `600#`) are protected and never mangled;
   replacements never fire inside tokens, so technical meaning cannot change.
2. **Classification** — transparent keyword rules per category with a
   rule-derived confidence (share of keyword signals for the winning category) and
   `classification_source` provenance. Designed to be replaced by an ML classifier
   returning the same shape.
3. **Attribute extraction** — per-category deterministic rules: bearings
   (series/seal 2RS-vs-ZZ/bore/type), motors (power/voltage/frequency/phase/rpm/
   mounting/IP), pumps (sizes/power/material), valves (size/pressure class/
   connection/material), fasteners (thread/diameter/length/grade). Missing facts
   are absent, never fabricated.
4. **Unit normalization** — spelling canonicalisation only (`VOLTS → V`,
   `220V` = `220 V` = `220 volts`); magnitudes are **never** converted.
5. **Data quality** — categorical verdict (GOOD / WARNING / INCOMPLETE / INVALID)
   from seven recorded checks; no invented scores. Stored on the record and shown
   on the material detail page.

Processing states: `imported → normalised → classified → attributes_extracted →
ready_for_matching`, with `warning`/`error` as quality-flagged states.
Reprocessing (detail-page button or `POST /api/materials/[id]/reprocess`) re-runs
the pipeline without touching original code/description; manual attributes are
preserved.

### Data Import Center (Step 4)

`/imports` is a six-step governed workflow (Source → Upload → Map columns →
Validate → Review → Import), plus `/imports/[id]` for the full record of any
import and a downloadable CSV error report.

- **Two phases, nothing partial** — `analyzeImport` parses, maps and validates
  without touching the material master; `executeImport` writes only the rows the
  user confirmed. Invalid rows can never enter the master.
- **Column mapping** — headers are matched against known aliases (`Material No`,
  `Item Code`, `Short Text`, …); ambiguous headers stay unmapped for the user.
  `material_code` and `description` must be mapped or the import cannot proceed.
- **Validation severities** — ERROR (missing required fields, duplicate code in
  file, malformed values, unknown supplied category) excludes the row; WARNING
  (unknown UOM, missing optional manufacturer, over-long optional field)
  imports only if the user explicitly includes warnings; VALID passes.
- **Duplicate safety** — codes already in the CPSE master are detected at
  validation time. Execution follows the chosen strategy: `skip` (imported = 0,
  counted), `update` (refreshes optional fields only — original code and
  description are never overwritten), or `cancel`.
- **Workflow statuses** — `uploading → validating → ready → importing →
  completed / completed_with_warnings / failed`, stored alongside row counters
  and the full row report (`row_report`) for auditability.

APIs: `POST /api/imports/analyze` (multipart file or JSON CSV),
`POST /api/imports/[id]/execute`, `GET /api/imports/[id]`,
`GET /api/imports/[id]/errors` (CSV report). The original one-shot
`POST /api/imports` remains for programmatic imports.

**Import** (both paths, CSV/XLSX, 5 MB cap, extension allowlist, formulas/macros
never executed) runs rows through the same pipeline and reports totalRows /
successful / failed / new / duplicate-codes / warnings / missing-descriptions
with per-row errors. Failed rows are never silently discarded.

### Database schema (10 tables)

`organizations`, `data_imports`, `material_records`, `material_attributes`
(flexible name/value/normalized/unit/critical attributes — no wide sparse columns),
`match_candidates` (semantic/fuzzy/technical/final scores, classification,
explanation, critical difference), `match_decisions` (append-only history),
`review_queue`, `common_materials`, `material_mappings` (traceability: CMI → CPSE →
original code; original codes immutable), `audit_logs` (append-only). Foreign keys
enforced, unique constraints on business keys (`(org, code)` per material, one
active mapping per material, one queue row per match), CHECK constraints on every
status enum, indexes on all FKs and filter columns.

### Matching rules (deterministic, transparent)

- **Fuzzy score** — Dice coefficient over synonym-normalised description tokens
  (BRG→BEARING, VLV→VALVE, …).
- **Technical score** — agreement across structured `material_attributes`; a
  disagreement on a critical attribute (seal type, voltage, pressure class, bore)
  is surfaced as an explicit conflict and blocks `identical` classification.
- **Final score** — configurable weighted model (prototype defaults: 30% semantic
  + 20% fuzzy + 30% technical + 20% category) with documented thresholds in
  `src/lib/matching/config.ts`.
- **Decision states** — each pending candidate carries a prototype decision state
  (`HIGH_CONFIDENCE_MATCH`, `NEEDS_TECHNICAL_REVIEW`, `LOW_CONFIDENCE`,
  `NOT_A_MATCH`) derived by rule from the signals and stored in its evidence
  document; configurable via `MATCH_T_DECISION_*` env vars. `/matching` lists all
  candidates with filters (CPSE, category, decision, confidence band, manufacturer,
  score range); `/matching/[id]` shows the side-by-side comparison with the
  "Why this decision?" evidence. NOT_A_MATCH pairs are counted but not persisted.
- The BHEL `6205-ZZ` record vs. the `6205-2RS` records is the built-in example of
  "very similar description, critical difference, routes to human review".

## SIH 2026 prototype mode (login disabled)

**For the SIH 2026 prototype the login requirement is intentionally disabled.** Opening the app goes straight to the Dashboard as a full-permission "SIH Demo Operator" identity — no sign-in, no redirects, all five demo CPSEs (CPCL, NTPC, BHEL, NLC, SAIL) visible. A "SIH 2026 • Prototype / Demo Environment" banner makes the mode explicit. **This is a prototype-only configuration and is not production-ready security.**

- **How:** `config.prototypeMode` (on unless `REQUIRE_AUTH=true`) plus a fallback identity in `src/lib/auth/guard.ts`. The edge middleware no longer gates, `/login` redirects to `/`, and the auth stack (scrypt, sessions, permission matrix, audit) remains intact and unused underneath.
- **Restore real authentication:** set `REQUIRE_AUTH=true` and restart — the middleware cookie gate, `/login` page, and per-role permission checks reactivate unchanged.
- Not restored by this mode: the login rate limiting and prod-hardening listed below are roadmap items, not implemented features.

## Authentication, roles & demo accounts (REQUIRE_AUTH=true)

All accounts and organizations in the prototype are **synthetic demonstration identities** — none represent real government systems or people.

- **Login** at `/login` (server-validated sessions; `HttpOnly` session cookie; scrypt password hashes; no plaintext or hash is ever returned by an API).
- **Roles**: `CPSE Material Manager` (own-CPSE materials, imports, editing), `CPSE Technical Reviewer` (review queue, match decisions), `Authority` (cross-CPSE read-only oversight), `Platform Administrator` (user/organization management, all data, audit).
- Permissions are defined once in `src/lib/auth/permissions.ts` and enforced **server-side** on every page (`requirePermission`) and API route (`requireApiPermission`). Organization isolation (e.g. a CPCL user cannot modify NTPC records) is enforced in the services, not the UI.
- All protected routes redirect anonymous users to `/login`; insufficient permission renders `403 — Access Restricted`.
- Security events (logins, failed logins, role changes, demo switches, decisions) are recorded in the audit log.

### Demo accounts (seeded via `npm run db:seed`)

| Account | Email | Role | Organization |
| --- | --- | --- | --- |
| CPCL Manager | `cpcl.manager@materialiq.demo` | CPSE Material Manager | CPCL |
| CPCL Reviewer | `cpcl.reviewer@materialiq.demo` | CPSE Technical Reviewer | CPCL |
| NTPC Reviewer | `ntpc.reviewer@materialiq.demo` | CPSE Technical Reviewer | NTPC |
| Authority | `authority@materialiq.demo` | Authority | — (all) |
| Administrator | `admin@materialiq.demo` | Platform Administrator | — (all) |

Password (development only, override with `DEMO_PASSWORD` before seeding): `demo-password`.
The login page shows a clearly-labelled **Demo Accounts** helper that prefills credentials; authentication itself is always the normal flow.

### Demo role switching

A **Demo Role Switcher** is available to a signed-in Platform Administrator on `/admin` in non-production environments (`ALLOW_DEMO_SWITCH=true` also enables it explicitly). Switching creates a *real* database-backed session for the selected account and applies its actual role/organization scope — it is not a client-side variable. In production the switcher and API are disabled.

### Security notes

- Passwords: `scrypt` (Node crypto) with per-user salt; never logged, never serialized.
- Sessions: opaque random tokens in SQLite with expiry; cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- The edge middleware only checks cookie presence; every page and API re-validates the session, role, and organization scope against the database.
- Do not deploy this prototype with demo credentials enabled.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `./data` | SQLite database directory |
| `DB_PATH` | `<DATA_DIR>/materialiq.db` | Database file override |
| `DEFAULT_PAGE_SIZE` | `10` | List endpoint default page size |
| `MAX_PAGE_SIZE` | `100` | List endpoint maximum page size |
| `MATCH_FUZZY_THRESHOLD` | `55` | Minimum fuzzy score to consider a pair |
| `MATCH_CRITICAL_PENALTY` | `25` | Reserved for scoring tuning |
| `MATCH_CRITICAL_ATTRIBUTES` | `seal_type,voltage_rating,pressure_class,bore_diameter` | Attributes treated as critical |
| `MAX_IMPORT_FILE_MB` | `5` | Import upload size cap |
| `DEMO_DATA_LABEL` | `Synthetic demonstration data — not production CPSE data` | Banner text |
| `DEMO_PASSWORD` | `demo-password` | Password assigned to seeded demo accounts (set before `db:seed`) |
| `ALLOW_DEMO_SWITCH` | unset | Set `true` to enable demo role switching in production builds (default: off) |

No secrets are required; no external services are used.

## API surface

`/api/health`, `/api/metrics`, `/api/organizations`, `/api/materials`,
`/api/materials/[id]`, `/api/materials/[id]/reprocess`, `/api/imports`,
`/api/matches`, `/api/matches/[id]`, `/api/matches/[id]/decision`,
`/api/matches/run`, `/api/review-queue`, `/api/common-materials`,
`/api/mappings`, `/api/audit`.

All list endpoints accept `page`/`pageSize` and return `{data: {items|…, total, page,
pageSize}}`. Errors return `{error: {code, message, details?}}` — internal details
are logged server-side, never returned.
