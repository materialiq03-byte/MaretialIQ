# MaterialIQ — SIH Architecture & Technical Stack (Step 26 Freeze)

## 1. Architecture

```
                         CPSE SOURCES (synthetic demo feeds)
        ┌──────────────────┬──────────────────┬──────────────────┐
        │      CPCL        │       NTPC       │  BHEL / NLC / SAIL│
        │ MAT_CODE/MAT_DESC│ MATERIAL_ID/…    │  ITEM_CODE / …    │
        └──────────────────┴──────────────────┴──────────────────┘
                                  │
                                  ▼
                    CPSE INTEGRATION LAYER (Step 22)
        governed source adapters · CPCL-MATERIAL-v1 … SAIL-MATERIAL-v1
              one canonical contract · source identity · idempotent
                                  │
                                  ▼
                     IMPORT / VALIDATION (async, chunked)
                    bounded uploads · structured row errors
                                  │
                                  ▼
                      MATERIAL NORMALIZATION
          terminology + category rules (deterministic pipeline)
                                  │
                                  ▼
                    CANDIDATE RETRIEVAL (inverted index)
                                  │
                                  ▼
                           MATCHING ENGINE
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   SEMANTIC 30%            FUZZY 20%              TECHNICAL 30%
 (trigram hashing,      (token similarity)   (attribute comparison,
  cosine similarity)                          nominal vs measured)
        └───────────────────────┼───────────────────────┘
                                ▼
                       CATEGORY / RULES 20%
                (critical attributes · assembly · cross-brand)
                                │
        ┌───────────────────────┴───────────────────────┐
        ▼                                               ▼
   CONFLICT DETECTION                          EXPLAINABILITY
 (critical seal/voltage/                  WHY MATCH / WHY REVIEW / WHY NOT
  class/series conflicts)                 (Judge Mode — deterministic)
        └───────────────────────┬───────────────────────┘
                                ▼
                      TECHNICAL REVIEW (queue)
                                ▼
                         HUMAN DECISION
                Accept / Reject / Defer (attributable)
                          ┌───────┴────────┐
                          ▼                ▼
                   CMI / MAPPING       PROCUREMENT
                  (governed identity)  (demand/spend per CMI)
                          └───────┬────────┘
                                  ▼
                       UOM GOVERNANCE · AUDIT

Cross-cutting: Authentication · RBAC · Organization isolation ·
Audit trail · Security headers/rate limits/CSRF · Versioned UOM rules ·
Health/observability
```

**Honest AI labeling:** the implemented intelligence is *deterministic and
algorithmic* — trigram-hashed semantic representation, cosine + token fuzzy
similarity, rule-based technical comparison. NOT an LLM, transformer, or neural
model. Correct phrasing: **"AI-assisted deterministic material similarity and
technical rule analysis."**

## 2. Technical stack (actual, frozen)

**Frontend:** Next.js 15 (App Router, RSC) · React 19 · TypeScript
**Backend:** Next.js route handlers · server-side services/repositories ·
Next middleware (security) · instrumentation.ts (boot guard)
**Database:** PostgreSQL 17.6 (Supabase, authoritative; worker-thread bridge,
pool max 5, TLS verify-full) · SQLite (node:sqlite) reference fallback · schema v19
**Matching:** deterministic trigram-hashed representation · cosine similarity ·
fuzzy token similarity · technical attribute comparison (exact/normalized/close/
missing/conflict; nominal-vs-measured) · category-aware critical rules ·
inverted-index candidate retrieval · persisted evidence documents
**Governance:** CMI workflow · human review queue · UOM conversion + domain rules ·
rule versioning (amendments with separation of duties) · append-style audit trail
**Security:** session auth (scrypt, HttpOnly/SameSite cookies) · RBAC (4 roles) ·
org scoping · CSRF origin checks · in-memory rate limiting · security headers ·
bounded bodies/uploads · CSV-injection-safe exports · structured security logging
**Docs quality:** zero claims beyond what is implemented.

## 3. Component map (for judges who ask "where is X?")

| Capability | Where |
|---|---|
| Adapters / canonical contract | `src/lib/integrations/` |
| Import engine (authoritative) | `src/lib/services/import-*.ts`, Import Center UI |
| Matching engine (frozen) | `src/lib/matching/` (engine, compare, decision, config) |
| Review contract / hardening | `src/lib/services/match-review-service.ts` |
| Judge Mode | `src/lib/services/judge-mode-service.ts`, `/matching/[id]/judge` |
| UOM + governance | `src/lib/db/repositories/procurement-repository.ts`, `/procurement/uom-steward`, `/procurement/governance` |
| Security core | `src/lib/security/*`, `src/middleware.ts`, `src/instrumentation.ts` |
| Evaluation | `scripts/evaluate.ts`, `data/evaluation/ground-truth-pairs.json`, `/evaluation` |
