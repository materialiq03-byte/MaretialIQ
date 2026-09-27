# MaterialIQ — SIH 2026 Solution Overview (PS 26099)

**One-line answer to the problem statement:** MaterialIQ is an ERP-agnostic
material intelligence layer that ingests heterogeneous material-master data from
multiple CPSEs through governed source adapters, normalizes it into one canonical
contract, preserves source traceability, and feeds an explainable, human-governed
harmonization pipeline — turning fragmented masters into comparable, auditable
material intelligence.

## What is implemented (all verified — see SIH-FINAL-EVIDENCE-MANIFEST.md)

**Ingestion & integration (Step 22).** Five governed source adapters
(CPCL/NTPC/BHEL/NLC/SAIL, each `*-MATERIAL-v1`) translate realistic synthetic
source formats into one canonical contract with source identity
(CPSE + source system + source record id), idempotent re-ingestion, structured
row-level validation, and source quality reporting computed from actual data.
Feeds the EXISTING async Import Center (chunked jobs, bounded uploads).

**Deterministic matching (frozen core).** Inverted-index candidate retrieval;
multi-signal scoring — semantic 30% (trigram-hashed representation + cosine),
fuzzy 20% (token similarity), technical 30% (category-aware attribute comparison),
rules 20% (critical attributes, assembly detection, manufacturer policy) — with
persisted evidence documents. Verdict bands: ≥80 high-confidence (requires no
critical conflict + manufacturer agreement), 60–79 review, <30 not-a-match.

**Review hardening + explainability (Steps 23–24).** A stable review contract
(side-by-side materials, attribute matrix with EXACT/NORMALIZED/CLOSE/MISSING/
CONFLICT relations and importance, structured conflicts, missing evidence, CMI
state, decision history), queue filters/sorting/summary, stale-decision protection
(409 on expectedStatus mismatch), and **Judge Mode** — a read-only, deterministic
WHY layer (WHY MATCH / WHY REVIEW / WHY NOT MATCH) with a decision trace, rule
trace, and source traceability. No LLM anywhere; no rescoring in the explanation
layer (0.3 ms briefs from persisted evidence).

**Governance (Steps 17–21).** UOM conversion registry (SYSTEM rules) + governed
material-specific UOM domain rules: proposal → approval with separation of duties,
versioned rule content, immutable history, reconciliation, and a steward
dashboard. Governance Cockpit: one human work queue across governed surfaces,
governance health, activity — read-only by design.

**Procurement intelligence (Steps 11–17).** Procurement records linked to
materials/CMIs; demand aggregated per UOM only where an explicit active rule
exists (never silently converted); spend per currency without invented exchange
rates; supplier views descriptive, not rankings; opportunities (cross-CPSE demand,
repeated purchases, unharmonized spend) surfaced for human review.

**Security & operations (Step 25).** Session auth (scrypt, HttpOnly/SameSite
cookies), RBAC, organization isolation with IDOR scoping, CSRF origin checks,
rate limiting, security headers, bounded bodies/uploads, CSV-injection-safe
exports, parameterized SQL, audit trail with CHECK-constrained vocabulary,
TLS-verified PostgreSQL, production boot guard, structured security logging,
health endpoints, verified backup/verify/restore tooling. Two IDOR gaps found by
our own audit were fixed and regression-tested.

## Verification summary

- 38 test files, 37 suite summaries — all `passed, 0 failed` (incl. 40-area
  security suite over real HTTP with real sessions)
- PostgreSQL integration 21/21 (Supabase) · TypeScript clean · production build green
- Smoke 35/35 on the frozen demo dataset
- Evaluation (50 hand-labelled synthetic pairs): accuracy 0.84, macro F1 0.8327,
  weighted F1 0.8375, conflict detection 20/20, FP 0, FN 0 — byte-identical
  (md5 c8c7ba9685601efe8dddacedc2df4e6f)
- Performance (prototype environment): judge brief 0.3 ms @ 100k candidates
  (EXPLAIN: PK search), evidence 0.26 ms, decision 1.2 ms, API 3.8–5.2 ms through
  full security middleware

## Honest boundaries

Synthetic data only; no live ERP/CPSE connectivity; prototype-scale evaluation;
single-instance rate limiting; application-level org isolation (RLS deferred with
rationale); no compliance certifications. Details: SECURITY.md, THREAT-MODEL.md.

## Where to look in the product

Dashboard `/` · Matching Workspace `/proposals` · Workbench `/matching/[id]` ·
Judge Mode `/matching/[id]/judge` · Common Materials `/cross-reference` ·
Import Center `/imports` · Integration Center `/integrations` · Procurement
`/procurement` · UOM Steward `/procurement/uom-steward` · Governance Cockpit
`/procurement/governance` · Evaluation `/evaluation`
