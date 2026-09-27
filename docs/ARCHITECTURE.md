# MaterialIQ — System Architecture

**SIH26099 — AI-Powered Material Intelligence & Harmonization**

Status: architecture for review. No implementation has begun against this document.
The current Node/SQLite prototype in this repository is a **workflow-validation
artifact only** and will be superseded by this architecture; it is not the starting
codebase.

Application classification labels (`IDENTICAL`,
`POTENTIALLY_FUNCTIONALLY_EQUIVALENT`, etc.) are prototype conventions, not
official government standards.

---

## 1. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        Browser (enterprise LAN)                     │
│              Next.js App Router UI (React Server Components          │
│              + TanStack Query for live review/matching views)        │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ HTTPS (JSON)
┌──────────────────────────────▼─────────────────────────────────────┐
│                     FastAPI application (Python 3.12)               │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────────┐  │
│  │ Auth/RBAC  │ │ Ingestion  │ │ Matching   │ │ Review/Approval │  │
│  │ middleware │ │ service    │ │ pipeline   │ │ service         │  │
│  └────────────┘ └────────────┘ └────────────┘ └─────────────────┘  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────────┐  │
│  │ Audit log  │ │ Analytics  │ │ Mapping/   │ │ Admin/Settings  │  │
│  │ service    │ │ service    │ │ CMI service│ │ service         │  │
│  └────────────┘ └────────────┘ └────────────┘ └─────────────────┘  │
└───────────┬──────────────────────┬─────────────────┬───────────────┘
            │ SQLAlchemy (async)   │                 │
┌───────────▼──────────┐  ┌────────▼─────────┐  ┌────▼──────────────┐
│ PostgreSQL 16        │  │ AI service layer │  │ Object storage     │
│ + pgvector           │  │ (in-process,     │  │ (imported files,   │
│ relational + vectors │  │ model in Docker  │  │ optional: MinIO or │
│                      │  │ image)           │  │ volume mount)      │
└──────────────────────┘  └──────────────────┘  └───────────────────┘
```

Key decisions:

- **One FastAPI service, not microservices.** The prototype scope (hackathon,
  demo-scale data) does not justify distributed operations. Module boundaries inside
  the service are drawn so that extraction later is possible.
- **AI runs in-process** behind a `MatchingService` interface. Sentence-Transformers
  loads at startup into a worker; matching is a batch job plus an on-demand
  re-score endpoint. No external paid API in the demo path; the interface allows an
  external model service later.
- **PostgreSQL + pgvector** is the single datastore: relational integrity for the
  workflow, vector index for candidate retrieval. This avoids operating a separate
  vector DB and keeps one transaction boundary for mapping approvals.
- **Normal software handles everything deterministic** (auth, ingestion, CRUD,
  filters, pagination, audit). AI is invoked only inside the matching pipeline
  stages where judgment is required: semantic similarity, attribute extraction,
  recommendation, explanation drafting.

## 2. Detailed Folder Structure

```
materialiq/
├── docker-compose.yml
├── .env.example                  # every variable documented; no real secrets
├── Makefile                      # make dev / test / lint / migrate / seed
├── README.md
│
├── backend/
│   ├── Dockerfile
│   ├── pyproject.toml            # uv/pip; ruff + mypy config
│   ├── alembic.ini
│   ├── alembic/versions/         # ordered migrations only, no auto-gen noise
│   ├── app/
│   │   ├── main.py               # FastAPI factory, middleware, router mount
│   │   ├── config.py             # pydantic-settings, env-based
│   │   ├── db/
│   │   │   ├── base.py           # DeclarativeBase, naming conventions
│   │   │   ├── session.py        # async engine + session factory
│   │   │   └── mixins.py         # TimestampMixin, IdMixin
│   │   ├── models/               # SQLAlchemy ORM (one file per aggregate)
│   │   │   ├── user.py  role.py  organization.py  import.py
│   │   │   ├── material.py       # MaterialRecord, MaterialAttribute
│   │   │   ├── embedding.py  candidate.py  decision.py
│   │   │   ├── review.py  common_material.py  mapping.py  audit.py
│   │   ├── schemas/              # Pydantic request/response models
│   │   │   ├── auth.py  material.py  import.py  matching.py
│   │   │   ├── review.py  common_material.py  analytics.py
│   │   ├── api/                  # routers, thin: parse → service → respond
│   │   │   ├── deps.py           # CurrentUser, CurrentOrg, DbSession, Page
│   │   │   ├── v1/
│   │   │   │   ├── auth.py  users.py  organizations.py
│   │   │   │   ├── materials.py  imports.py
│   │   │   │   ├── matching.py  review.py
│   │   │   │   ├── common_materials.py  mappings.py
│   │   │   │   ├── analytics.py  audit.py  settings.py  health.py
│   │   ├── services/             # all business logic; routers stay thin
│   │   │   ├── auth_service.py  user_service.py
│   │   │   ├── import_service.py         # file validation, row parsing, batch upsert
│   │   │   ├── material_service.py       # normalization, classification, attributes
│   │   │   ├── matching_service.py       # pipeline orchestration (see §5)
│   │   │   ├── review_service.py         # queue, decisions, conflict checks
│   │   │   ├── cmi_service.py            # common material identity + mappings
│   │   │   ├── analytics_service.py      # all metrics, SQL-defined
│   │   │   └── audit_service.py
│   │   ├── ai/                        # the ONLY AI code
│   │   │   ├── embeddings.py          # sentence-transformers wrapper
│   │   │   ├── normalizer.py          # text normalization (deterministic)
│   │   │   ├── attribute_extractor.py # seals/bore/material-grade from text
│   │   │   ├── classifier.py          # match-type classification rules+model
│   │   │   ├── explainer.py           # evidence-based explanation composition
│   │   │   └── model_registry.py      # model name, version, loaded singleton
│   │   └── workers/                   # background jobs (FastAPI BackgroundTasks now,
│   │       └── matching_job.py        # Celery/RQ swap-in point later)
│   └── tests/
│       ├── unit/                      # pure functions: normalizer, classifier
│       ├── integration/               # API + DB via testcontainers/pytest-postgresql
│       └── fixtures/                  # synthetic CPSE datasets
│
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tailwind.config.ts
│   ├── components.json                # shadcn/ui
│   ├── src/
│   │   ├── app/
│   │   │   ├── (auth)/login/page.tsx
│   │   │   ├── (app)/layout.tsx       # shell: sidebar, topbar, org switcher
│   │   │   ├── (app)/dashboard/page.tsx
│   │   │   ├── (app)/materials/page.tsx        # list + filters + pagination
│   │   │   ├── (app)/materials/[id]/page.tsx
│   │   │   ├── (app)/imports/page.tsx
│   │   │   ├── (app)/matching/page.tsx
│   │   │   ├── (app)/matching/[id]/page.tsx
│   │   │   ├── (app)/review/page.tsx
│   │   │   ├── (app)/review/[id]/page.tsx
│   │   │   ├── (app)/common-materials/page.tsx
│   │   │   ├── (app)/common-materials/[id]/page.tsx
│   │   │   ├── (app)/mappings/page.tsx
│   │   │   ├── (app)/analytics/page.tsx
│   │   │   ├── (app)/audit/page.tsx
│   │   │   └── (app)/settings/page.tsx
│   │   ├── components/
│   │   │   ├── ui/                    # shadcn/ui generated primitives
│   │   │   ├── layout/                # Sidebar, Topbar, OrgSwitcher
│   │   │   ├── materials/             # MaterialTable, AttributeSheet, StatusBadge
│   │   │   ├── matching/              # CandidateTable, ScoreBars, EvidencePanel
│   │   │   ├── review/                # DecisionPanel, ConflictBanner, CompareView
│   │   │   └── analytics/             # Recharts wrappers (flat, no effects)
│   │   ├── lib/
│   │   │   ├── api-client.ts          # typed fetch wrapper, error normalization
│   │   │   ├── query-keys.ts
│   │   │   └── format.ts
│   │   ├── hooks/                     # useMaterials, useReviewQueue, useDecision…
│   │   ├── types/                     # mirrors backend Pydantic response models
│   │   └── styles/globals.css
│   └── tests/                         # vitest: form validation, key components
│
└── docs/
    ├── ARCHITECTURE.md                # this file
    ├── DECISIONS.md                   # ADR log
    └── sample-data.md                 # synthetic dataset contract
```

## 3. Database ER-Style Relationship Description

PostgreSQL + pgvector. Every table: `id UUID PK default gen_random_uuid()`,
`created_at`, `updated_at` (TimestampMixin). Naming: snake_case, FK constraints
explicit, indexes on every FK and on listed query columns.

```
roles ─────────────┐
  (id, name UNIQUE, description)
                   │ user_roles (user_id, role_id) PK(user_id, role_id)
users ─────────────┤
  (id, email UNIQUE CITEXT, password_hash, full_name, is_active,
   last_login_at)
                   │
cpse_organizations (id, code UNIQUE, name, description, is_active)
                   │
data_imports ──────┤
  (id, org_id FK→cpse_organizations, uploaded_by FK→users,
   file_name, file_hash UNIQUE, file_size_bytes, row_count,
   valid_row_count, error_row_count, status CHECK IN
   (pending,validating,validated,processing,completed,failed),
   error_report JSONB, created_at)
                   │ 1:N
material_records ──┘
  (id, org_id FK, import_id FK NULL, original_code NOT NULL,
   original_description NOT NULL,
   normalized_description, category, subcategory, manufacturer,
   model, part_number, material_type, dimensions, technical_specs JSONB,
   uom, source_file, source_row INTEGER, processing_status CHECK IN
   (pending,normalized,classified,extracted,embedded,failed),
   is_active, UNIQUE(org_id, original_code))
   INDEX(org_id), INDEX(category), INDEX(processing_status),
   UNIQUE partial index: original_code unique per org even when inactive

material_attributes (id, material_id FK→material_records ON DELETE CASCADE,
   attribute_key NOT NULL, attribute_value, attribute_type CHECK IN
   (dimension,specification,seal_type,capacity,standard,other),
   is_critical BOOLEAN, source_text, confidence NUMERIC(4,3) NULL)
   UNIQUE(material_id, attribute_key), INDEX(attribute_key, attribute_value)
   -- normalized attribute model: one row per extracted attribute instead of
   -- hundreds of sparse columns; is_critical drives conflict detection.

material_embeddings (material_id PK/FK→material_records ON DELETE CASCADE,
   embedding vector(384) NOT NULL, model_name NOT NULL, model_version NOT NULL,
   created_at)
   -- 1:1 with material_records; pgvector HNSW index (cosine).
   -- 384 dims = all-MiniLM-L6-v2; model recorded so re-embedding is possible.

match_candidates
  (id, source_material_id FK, candidate_material_id FK,
   run_id FK→matching_runs NULL, semantic_score NUMERIC(5,4),
   fuzzy_score NUMERIC(5,4), attribute_score NUMERIC(5,4),
   category_compatible BOOLEAN, critical_conflicts JSONB,
   overall_confidence NUMERIC(5,4) NOT NULL,
   match_type CHECK IN (identical, potentially_functionally_equivalent,
                        near_duplicate, different, needs_human_review),
   explanation TEXT NOT NULL, status CHECK IN (pending,in_review,decided),
   UNIQUE(source_material_id, candidate_material_id),
   CHECK (source_material_id <> candidate_material_id))
   INDEX(overall_confidence DESC), INDEX(match_type), INDEX(status)

matching_runs (id, started_by FK→users, started_at, finished_at,
   pairs_compared, candidates_created, status CHECK IN
   (running,completed,failed), parameters JSONB)
   -- every dashboard "last run" figure comes from this table.

match_decisions (id, match_candidate_id FK→match_candidates UNIQUE,
   decided_by FK→users, decided_at DEFAULT now(),
   decision CHECK IN (approved,rejected,deferred),
   rationale TEXT NOT NULL CHECK (length(trim(rationale)) >= 10),
   created_at)
   -- immutable: corrections create a new decision row; audit trail preserved.

review_queue
  (id, match_candidate_id FK UNIQUE, assigned_to FK→users NULL,
   status CHECK IN (open,in_progress,resolved), priority CHECK IN
   (high,medium,low), opened_at, resolved_at)
   INDEX(status, priority)

common_materials
  (id, common_code UNIQUE NOT NULL, name, description, category,
   created_by FK→users, approved_decision_id FK→match_decisions, is_active)
   -- created ONLY from an approved decision; FK is the proof.

material_mappings (id, common_material_id FK→common_materials,
   material_record_id FK→material_records, org_id FK,
   mapped_by FK→users, mapped_at, is_active,
   UNIQUE(material_record_id))          -- one active identity per record
   -- original codes live in material_records and are NEVER mutated or deleted;
   -- mappings only add identity, preserving full traceability.

audit_logs (id BIGSERIAL PK, actor_id FK→users NULL, action VARCHAR NOT NULL,
   entity_type, entity_id, details JSONB, request_id, created_at)
   INDEX(entity_type, entity_id), INDEX(actor_id, created_at)
   -- INSERT-only; no UPDATE/DELETE grant for the app role.
```

**Schema decision — normalized attributes vs. wide columns.** Material records keep
identity fields (code, description, org, source, status) as columns because they are
always present and drive unique constraints. Technical reality varies per category
(bore/seal for bearings, NB/PN for gaskets, cores/sqmm for cables): a sparse
wide-table design would either explode into nullable columns or force JSON blobs
that cannot be validated or indexed. `material_attributes` (key/type/value with
`is_critical`) gives category-agnostic storage, enables per-attribute conflict
comparison and indexing, and keeps `technical_specs JSONB` only as the raw
pre-extraction dump for transparency.

## 4. API Architecture

REST under `/api/v1`, JSON only, versioned prefix. Routers parse and authorize,
services own logic, one Pydantic response model per endpoint. All list endpoints:
`?page=&page_size=` (max 200), `?sort=`, plus the filters listed; every list returns
`{items, total, page, page_size}`.

```
POST   /auth/login            → {access_token, token_type}  (JWT, 8h)
POST   /auth/logout
GET    /auth/me
GET    /users                 (admin)      POST /users (admin)
GET    /organizations
POST   /imports               multipart: file (xlsx/csv), org_id
GET    /imports               ?status=&org_id=
GET    /imports/{id}          → rows, error report, per-row validation results
POST   /imports/{id}/process
GET    /materials             ?org_id=&category=&status=&q=&page=
GET    /materials/{id}        → record + attributes + active mappings
POST   /materials/{id}/reprocess
POST   /matching/runs         {scope: org|all}  (matching-engine role)
GET    /matching/runs         GET /matching/runs/{id}
GET    /matching/candidates   ?status=&match_type=&org_id=&min_confidence=
GET    /matching/candidates/{id} → full evidence breakdown (scores per signal,
                                  per-attribute comparison, explanation)
GET    /review/queue          ?priority=&status=&assigned_to=
POST   /review/queue/{candidate_id}/decision   {decision, rationale}
                                  → 409 on stale/impossible decisions, listed
                                    conflicts block approval (see §8)
GET    /common-materials      GET /common-materials/{id}
GET    /mappings              ?org_id=&common_material_id=
GET    /analytics/summary     → every figure SQL-computed from live tables
GET    /audit                 ?actor=&entity_type=&entity_id=&from=&to=
GET    /health                → {db, ai_model_loaded}
```

Error contract (uniform, safe):

```json
{ "error": { "code": "conflict", "message": "human-readable, no internals",
             "details": [ ... field-level or conflict data ... ] } }
```

Codes: 400 validation, 401 unauthenticated, 403 unauthorized (with required-role
note), 404, 409 business-conflict (stale decision, approval blocked by critical
attribute conflict, duplicate import hash), 422 request-shape errors, 500 with
correlation `request_id` and no stack trace.

## 5. AI Service Architecture

AI is confined to five functions behind `backend/app/ai/*`, each deterministic in
interface, versioned, and optional per run:

```
                 ┌────────────────────────────────────────────────┐
 ingest → normalize (deterministic regex/whitespace/abbreviation map)
       → classify category (rule table first; TF-IDF NB fallback*)
       → extract attributes (regex + gazetteer: 6205-2RS → {model: 6205,
          seal: 2RS}; bore 25mm; "SS304" → {standard: AISI 304})
       → embed (all-MiniLM-L6-v2, 384d, stored to pgvector)
                 └────────────────────────────────────────────────┘
 matching run:
   1. RETRIEVAL   pgvector cosine top-k (k=20) per material, per org pair
                  ∪ RapidFuzz token_set_ratio ≥ 85 candidates
   2. SCORING     per candidate pair:
        semantic  = cosine(embedding_a, embedding_b)
        fuzzy     = RapidFuzz token_set_ratio / 100
        attribute = weighted agreement over material_attributes
                    (critical attrs weighted 3×, missing ignored)
        category  = compatible bool (gating: incompatible → different)
   3. CLASSIFY    rules over (semantic, fuzzy, attribute, conflicts):
        identical                    attr≥0.98 ∧ semantic≥0.95 ∧ no conflicts
        near_duplicate               semantic≥0.9 ∧ no critical conflicts
        potentially_functionally_equiv
                                     semantic≥0.85 ∧ critical conflicts empty
                                     after equivalence table (e.g. 2RS~contact
                                     seal families across vendors) — else
        needs_human_review           any critical conflict OR scores ambiguous
        different                    category incompatible ∧ semantic<0.85
        (*thresholds in settings, tuned on the labeled synthetic set; every
         rule firing is recorded in `explanation`.)
   4. EXPLAIN     evidence list composed from actual stored values only:
        [{field, value_a, value_b, verdict, detail}] + narrative sentence.
        The explainer never invents figures; it quotes scores and attributes.
   5. PERSIST     match_candidates rows; review_queue inserts for
        needs_human_review and low-confidence bands.
```

- Model load at app startup (lazy in dev); a single registry records model name +
  version in `material_embeddings` and `matching_runs.parameters`, so results are
  reproducible and re-embedding migrations are possible.
- Every AI output stores raw evidence alongside the verdict; reviewers see the
  inputs, not just the conclusion. Re-computation on view for evidence, cached
  scores only for ranking.
- Equivalence tables (e.g., seal-family equivalences) live in settings/DB, are
  visible in the UI, and their application is always shown in explanations.

## 6. Frontend Architecture

- **Design system:** Tailwind + shadcn/ui primitives only. Single neutral palette,
  one accent, 8px spacing scale, visible focus rings, WCAG-AA contrast. No
  gradients, no glows, no decorative motion. Data-dense tables, 13–14px base.
- **Data:** TanStack Query for all reads with typed `query-keys.ts` cache keys;
  mutations invalidate precisely; forms use React Hook Form + Zod schemas mirrored
  from backend. Analytics charts: Recharts, flat styling, axis labels always shown.
- **Pages (all 14 in the IA):**
  - `/login` — credentials; demo users listed from env-configured seed.
  - `/dashboard` — metric cards (imported materials, requiring review, potential
    duplicates, functional equivalents, unresolved conflicts, common identities) +
    recent activity table; every number from `/analytics/summary`.
  - `/materials`, `/materials/[id]` — filterable paginated catalog; detail shows
    normalized view, extracted attributes with confidence, original record, status
    history.
  - `/imports` — upload with client+server validation, import history with
    row/error counts, per-import error report.
  - `/matching`, `/matching/[id]` — runs list and run detail: candidates grouped by
    classification, per-pair evidence panel (score bars labeled as comparison
    results, attribute-by-attribute table, explanation).
  - `/review`, `/review/[id]` — open queue with priority; detail: side-by-side
    records, critical-conflict banner, decision form (approved/rejected/deferred)
    requiring a ≥10-char rationale, conflict-blocked approvals surfaced inline.
  - `/common-materials`, `/common-materials/[id]` — identity register; detail shows
    the hub-and-spoke mapping to each CPSE code with full traceability.
  - `/mappings` — cross-org map table, filterable, exportable CSV.
  - `/analytics` — pipeline status distribution, match-type distribution, decision
    throughput over time (all live SQL).
  - `/audit` — filterable event log (read-only).
  - `/settings` — orgs, users/roles, equivalence tables, threshold visibility.
- **States:** every list has skeleton loading, a designed empty state, and an error
  state with retry; every mutation has pending feedback and inline error handling.

## 7. Data Flow

```
IMPORT     xlsx/csv → upload (org-scoped) → validate header/rows/file
           → data_imports row (hash-dedup) → parse rows with source_file/row
           → material_records (original fields verbatim) → validation report
PIPELINE   per record: normalize → classify → extract attributes → embed
           → processing_status advances; failures recorded per row, never silent
MATCHING   run requested → retrieval (vector ∪ fuzzy) → scoring → classification
           → match_candidates + explanations → needs_human_review → review_queue
REVIEW     reviewer opens queue → evidence panel → decision with rationale
           → match_decisions (immutable) → candidate status decided
CMI        approval → cmi_service creates common_material (FK to the decision)
           → material_mappings rows per member record → codes untouched
ANALYTICS  every card/counter = SQL over these tables; audit_logs records every
           mutating action with actor, entity, request_id
```

## 8. Authentication / Authorization Design

- **AuthN:** JWT bearer tokens (8h expiry), password hashing with bcrypt, login
  rate-limited, `audit_logs` on login/logout/failed attempts.
- **AuthZ:** role table + `user_roles`; FastAPI dependency `require_roles(...)`
  per router/endpoint. Roles for the prototype:
  `admin` (users, orgs, settings), `data_engineer` (imports, reprocessing, runs),
  `matching_engine` (trigger runs, view candidates),
  `reviewer` (decisions in review queue), `viewer` (read-only).
  Enforced server-side on every endpoint; the UI hides actions it cannot call but
  never relies on hiding.
- **Server-side validation:** Pydantic on every request; file validation on upload
  (extension, size ≤ 20MB, MIME sniff, header schema check, hash dedup); all
  queries parameterized via SQLAlchemy.
- **Safe errors:** handlers map exceptions to the error contract; internal details
  never leave the server; correlation IDs in logs and responses.
- **Audit logging:** `audit_service.log(actor, action, entity, details, request_id)`
  invoked in every mutating service call; audit table is append-only.
- **Secrets:** `.env` only, `.env.example` documents each variable, no secret ever
  committed; CORS restricted to the frontend origin.

## 9. Development Phases

- **Phase 0 — Foundations (start here):** repo scaffolding, Docker Compose
  (postgres+pgvector, backend, frontend), Alembic initial migration with the full
  schema, auth (login/users/roles), audit logging, health check.
- **Phase 1 — Ingestion & catalog:** import upload/validation/error report,
  material records + attributes, normalization + classification + extraction +
  embeddings pipeline, materials UI with filters/detail, statuses.
- **Phase 2 — Matching:** retrieval, scoring, classification, explanation,
  matching runs UI, candidate detail with evidence; `needs_human_review` routing.
- **Phase 3 — Review & CMI:** review queue, decision flow with conflict blocking
  and immutable decisions, common material creation on approval, mappings register,
  cross-org traceability UI.
- **Phase 4 — Analytics & hardening:** dashboard + analytics from live SQL, audit
  UI, settings UI, performance pass (indexes, pagination everywhere), e2e demo
  script, seed-data polish, documentation.
- Demo-critical path if time compresses: Phases 0→1→2→3 in order, Phase 4 scope
  reduced to dashboard + audit UI.

## 10. Dependencies

**Backend:** fastapi, uvicorn[standard], pydantic, pydantic-settings, sqlalchemy[asyncio],
asyncpg, alembic, pgvector (python client), python-jose[crypto] (JWT), passlib[bcrypt],
python-multipart, openpyxl, pandas, rapidfuzz, sentence-transformers, scikit-learn,
numpy, httpx (tests), pytest, pytest-asyncio, ruff, mypy.

**Frontend:** next (App Router, TS), react, react-dom, tailwindcss, shadcn/ui
(radix primitives), @tanstack/react-query, react-hook-form, @hookform/resolvers,
zod, recharts, lucide-react (icons only, used sparingly), typescript, vitest,
@testing-library/react.

**Infrastructure:** docker, docker-compose (postgres/pgvector 0.7+, backend,
frontend; Supabase-compatible connection string option).

## 11. Environment Variables Required

```
# --- Database (Supabase or local pgvector image) ---
DATABASE_URL=postgresql+asyncpg://user:password@host:5432/materialiq
# Supabase direct: same string; pool settings via ?pool_size=..&max_overflow=..

# --- Auth ---
JWT_SECRET=            # 64+ random chars; generate: openssl rand -hex 32
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=480

# --- App ---
ENVIRONMENT=development|staging|production
CORS_ORIGINS=http://localhost:3000
BACKEND_PORT=8000
FRONTEND_PORT=3000
MAX_UPLOAD_SIZE_MB=20
DEFAULT_PAGE_SIZE=25
MAX_PAGE_SIZE=200

# --- AI ---
EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
EMBEDDING_DIMENSION=384
MATCH_SEMANTIC_THRESHOLD=0.85
MATCH_FUZZY_THRESHOLD=85
MATCH_RETRIEVAL_K=20
# thresholds exposed in settings UI; env provides defaults only

# --- Synthetic data (demo honesty flags) ---
SEED_DEMO_DATA=true
DEMO_DATA_LABEL="Synthetic demonstration data — not production CPSE data"

# --- Frontend ---
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api/v1
```

## 12. Testing Strategy

- **Unit (backend):** normalizer, attribute extractor (bearing/gasket/cable
  patterns incl. `6205-2RS` vs `6205-ZZ`), classification rules, confidence
  math, explanation generation (assert explanations quote stored values only),
  RBAC dependency logic.
- **Unit (frontend):** Zod form schemas, filter-state encoding, decision-form
  validation (rationale length), query keys.
- **Integration (backend):** pytest + transactional test DB: auth flows, import →
  validation → records with `source_row` provenance, matching run determinism
  (same input → same candidates/scores), decision conflict rules (409 paths),
  CMI creation only via approval, audit rows written for every mutation.
- **Contract:** Pydantic response models are the contract; frontend types mirror
  them; a smoke test walks representative endpoints on every CI run.
- **E2E (Playwright, minimal):** login → import synthetic file → run matching →
  open a `needs_human_review` pair → attempt approve (blocked on conflict) →
  reject with rationale → approve clean pair → verify common material + mapping.
- **The 2RS/ZZ case is a named regression test:** descriptions highly similar,
  critical attribute `seal_type` conflicts → must classify `needs_human_review`,
  approval must be blocked, explanation must show the seal conflict.
- CI: ruff + mypy + pytest on backend; eslint + tsc + vitest on frontend; compose
  up for integration jobs.

## 13. Demo Strategy

- **Synthetic dataset (4 CPSEs — CPCL, NTPC, SAIL, BHEL), ~60–80 records:** the
  given bearing scenario verbatim (CP-1001, NT-8821, SL-7721 identical `6205-2RS`
  items; BH-4410 `6205-ZZ` seal variant) plus per-CPSE codes in plausible local
  formats, plus gaskets, cables, valves; deliberate pairs covering every
  classification; some dirty rows (missing UOM, malformed HSN) to demonstrate
  validation; a duplicate import file to demonstrate hash-dedup.
- **Demo script (10–12 min):**
  1. Login (role switch shown) → dashboard, every figure explained as live SQL.
  2. Import NTPC sheet → validation report with row errors → catalog shows new
     records with original codes.
  3. Run matching → candidate list across classifications → open a clean
     identical pair → evidence panel → approve → common material created.
  4. Open **BHEL BH-4410 vs NTPC NT-8821** → system flags critical seal conflict →
     attempts to approve are blocked with explanation → reviewer rejects with
     rationale → shows human-approval importance and technical-difference display.
  5. Common materials → hub view mapping CPCL/NTPC/SAIL codes → mappings page →
     original codes everywhere preserved.
  6. Audit page → the full trail just produced, with actor + timestamps.
- **Honesty labels:** demo banner everywhere: synthetic data, not real CPSE data;
  classification labels labeled as application conventions; AI panels always show
  evidence with values; "no automated approval" is stated in the UI.
- **Fallback:** pre-seeded database snapshot; if the model fails to load, matching
  falls back to fuzzy-only scoring with a visible degradation notice — the demo
  never hard-fails.

## 14. Potential Technical Risks and Mitigations

1. **Embedding model download/size in offline judging environments.**
   *Mitigation:* bake the model into the backend Docker image; fuzzy-only fallback
   path; document an offline model cache volume.
2. **pgvector scale/latency at larger corpora.** *Mitigation:* HNSW index, per-org
   pair-scoped retrieval, top-k caps; at demo scale (<100k rows) this is
   comfortably fast; document upgrade path (partitioning, external vector store).
3. **False confidence in AI recommendations.** *Mitigation:* scores displayed as
   comparison results with per-field evidence; critical-attribute conflict gate;
   `needs_human_review` routing conservative by default; approval blocked on
   conflicts — product rule, not just model behavior.
4. **Workflow integrity races** (two reviewers deciding simultaneously).
   *Mitigation:* decisions on decided candidates return 409; review_queue status
   transitions guarded in SQL; immutable decision table.
5. **Synthetic data too clean → demo looks fake.** *Mitigation:* seeded dirt:
   abbreviations, missing fields, transposed specs, duplicate import, near-miss
   codes; validation error report showcased deliberately.
6. **SQLAlchemy + pgvector type friction / Alembic drift.** *Mitigation:* pinned
   versions; vector column created via Alembic op with `vector(384)`; migration
   test in CI; `model_version` recorded to force re-embedding on model change.
7. **Auth scope creep.** *Mitigation:* simple roles/JWT as specced; no SSO in
   prototype; documented as production hardening item.
8. **Supabase compatibility gaps** (extensions/permissions). *Mitigation:* enable
   `vector` extension in migration bootstrap; local pgvector image is the default
   compose path so the demo never depends on external service availability.
9. **Timeline risk across 4 phases.** *Mitigation:* demo-critical path defined in
   §9; every phase ends in a runnable, demonstrable state.

---

*End of architecture document. Awaiting review before implementation begins.*
