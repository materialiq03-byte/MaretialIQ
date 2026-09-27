# Matching & Technical Review Architecture (Step 23)

**Status: hardening layer IMPLEMENTED over the existing deterministic engine.** The scoring
engine, thresholds, weights and critical-attribute configuration are UNCHANGED — Step 23 makes
the existing intelligence understandable, filterable, and operationally safe. MaterialIQ is
**AI-assisted deterministic material similarity and technical rule analysis**: trigram/FNV-1a
hashing with cosine similarity, fuzzy token (Dice) similarity, category-aware technical rule
comparison. It is NOT transformer embeddings, neural models, or LLM reasoning, and no UI copy
claims otherwise.

## 1. Pipeline (unchanged)

```
CPSE MATERIAL → CANDIDATE RETRIEVAL (inverted token index, category gating)
  → SEMANTIC (30%) + FUZZY (20%) + TECHNICAL (30%) + CATEGORY/RULES (20%)
  → CONFLICT DETECTION (category-aware critical attributes)
  → EXPLAINABLE SCORE → verdict
      HIGH_CONFIDENCE_MATCH   ≥80, no critical conflict/missing evidence, same manufacturer
      NEEDS_TECHNICAL_REVIEW  60–80, OR any critical conflict, OR assembly difference,
                              OR cross-brand with high score
      NOT_A_MATCH             <30 (not persisted) or incompatible categories
  → HUMAN TECHNICAL REVIEW (accept / reject / defer) → GOVERNED CMI WORKFLOW
```

Authoritative code: `src/lib/matching/engine.ts` (scorePairCore/finishPair), `compare.ts`
(attribute comparison), `decision.ts` (verdict rules), `config.ts` (weights, thresholds,
`CRITICAL_RULES`, `ATTRIBUTE_STRATEGIES`). Thresholds are env-overridable but defaults are
frozen and asserted by tests. Weights 30/20/30/20 preserved.

## 2. Nominal vs measured (§6)

`ATTRIBUTE_STRATEGIES` is category-aware: `nominal` attributes (bearing `series`, valve
`pressure_class`/`nominal_size`, fastener `thread_specification`, pump `suction_size`…) are
equal-after-canonicalization or CONFLICT — never CLOSE, no matter how numerically near (6205 vs
6310 is 1.7% apart and still a conflict). `measured` attributes (bore, voltage, power…) earn
CLOSE_MATCH within the 2% relative tolerance (unit-consistent). Enum attributes are vocabulary
equality only. `closeMatchRelativeTolerance = 0.02` preserved.

## 3. Result contract (`getMatchReview`, §3)

`src/lib/services/match-review-service.ts` composes PERSISTED state into one reviewer-facing
structure: both material sides (CPSE, code, descriptions, category, manufacturer, part number,
UOM, attributes), the four component scores + final, verdict + band + reason,
`technicalComparison[]` (`{attribute, leftValue, rightValue, relation, importance, basis}` with
relations EXACT/NORMALIZED/CLOSE/MISSING/CONFLICT/NOT_APPLICABLE and importance
CRITICAL/IMPORTANT/INFORMATIONAL), `conflicts[]` (§8 model: attribute, values, criticality,
documented assessment only, evidence source), `missingEvidence`, `matchedAttributes`,
`assemblyEvidence`, `manufacturerRelationship` (same/different/unknown),
`categoryRelationship`, `thresholds`, `decisionHistory`, `queue`, `cmiState`
(`cmi_pending`/`cmi_created` — derived, never duplicated), `status`, and `why` — the
deterministic WHY bullets (§33). **No rescoring ever happens on read**; legacy candidates
without a full evidence document explain from persisted columns and say so.

## 4. Review workspace (§9/§10/§11)

- `/proposals` — the queue: real summary KPIs (open reviews, high-confidence, critical
  conflicts, missing critical evidence, assembly differences, cross-brand — all SQL-computed
  from actual rows via the same JSON1 extraction the filters use), filters (status,
  classification, CMI state, verdict band, critical-conflict-only, category, CPSE, sort), and
  proposal cards with side-by-side records + score tables.
- `/matching/[id]` — the engineering workbench: verdict header, critical-difference callout,
  side-by-side records with links to the original material pages, the attribute-by-attribute
  comparison table (importance + basis per row), the evidence panel (weighted contributions of
  all four signals), the **"Why this result?"** section (Step 23 foundation for Step 24 Judge
  Mode — deterministic bullet list, every line citing stored values), decision pipeline, CMI
  gating (display only), audit history, and the decision panel.
- Desktop-first, existing enterprise console styling; no decorative redesign (§35/§36).

## 5. Decisions, safety, audit (§13/§14/§28/§29)

`POST /api/matches/:id` (existing contract, unchanged without the new field) accepts an
optional `expectedStatus`. With it, a stale decision fails 409 **before any write** ("Stale
review: the candidate is now …"). Without it, behavior is byte-identical to the previous
contract. The existing pending-only guard (in-transaction) prevents duplicate decisions;
decided rows are never re-scored by reruns (`upsertMatch` status guard) and decision history is
immutable. Audit reuses the existing `proposal_approved`/`proposal_rejected`/`proposal_deferred`
actions with actor, decision, comment; reads (evidence, queue, summary, detail pages) write
ZERO audit rows. Authorization reuses REVIEW_MATCHES (mutations) / VIEW_MATCHES (reads) — no
new permission vocabulary; the acting reviewer is always the authenticated session user.

## 6. APIs (§30/§31/§32)

| Route | Behavior |
|---|---|
| `GET /api/matches` | existing list (unchanged) |
| `GET /api/matches/:id/evidence` | NEW read-only full result contract; audit-silent |
| `POST /api/matches/:id` | existing decision + optional `expectedStatus` staleness guard |
| `GET /api/review-queue` | extended filters (`category`, `band`, `conflict`), `sort`, optional `summary=1` |

Input validation via the existing zod schemas (`decisionSchema` bounds reviewer identity and
comments); errors use the existing ok/fail conventions with no internal leakage.

## 7. Review queue mechanics (§16/§17/§18)

Pagination remains the existing LIMIT/OFFSET (bounded pageSize ≤ 200; consistent with the
current architecture and dataset — the frozen baseline holds 1,289 candidates). Sorting is
deterministic, owned by `matching-repository.parseReviewSort`: score_desc/score_asc/oldest/
newest/priority (priority = queue tier high→medium→low, then score). Filters use existing
columns plus the existing JSON1 extraction over the persisted evidence document (decision band,
critical-conflict presence) — no new columns, no browser-side set computation.

## 8. CMI handoff (§26)

Approval alone never creates a common material identity: the contract exposes the derived
`cmiState` (approved → `cmi_pending`; both materials mapped to one active CMI → `cmi_created`),
and the workbench routes creation into the EXISTING governed workflow (CREATE_COMMON_IDENTITY
permission, explicit human action, existing audits). No auto-CMI, no duplicated creation logic.

## 9. Performance (isolated synthetic SQLite — NOT production CPSE performance, §40)

| Candidates | Queue page p50 | Filter p50 | Detail (evidence) p50 | Summary | Decision p50 |
|---|---|---|---|---|---|
| 1,000 | 1.3 ms | 1.7 ms | 0.26 ms | 1.9 ms | 1.4 ms |
| 10,000 | 22 ms | 24 ms | 0.24 ms | 33 ms | 1.2 ms |
| 100,000 | ~790 ms | ~740 ms | 0.26 ms | ~920 ms | 1.2 ms |

Evidence composition is O(1) per candidate (persisted document + two material reads) — it
never re-runs matching. Decision mutations stay ~1.2 ms at every scale. At 100k candidates the
list page is dominated by the exact COUNT(*) the existing pagination contract requires (the
real baseline corpus is 1,289 candidates → ~10 ms). EXPLAIN at 100k:
`SEARCH mc USING COVERING INDEX idx_match_status_score (status=?)` — no material-table scans;
the only TEMP B-TREE is the secondary `id` tiebreak on the order-by. The engine's own
architecture (inverted retrieval, prefilter, scorePairCore/finishPair split, memoized facts,
CMI short-circuit) is untouched (§20).

## 10. IMPLEMENTED vs FUTURE

**IMPLEMENTED (Step 23):** result contract + evidence/conflict/WHY models, evidence API,
staleness-guarded decisions, queue filters/sort/summary, workspace KPIs, 39-area test suite,
review-workflow benchmarks. **FUTURE (documented, not built):** Step 24 Judge Mode (deep
per-signal drill-down), richer reviewer notes threads, keyset pagination if corpora grow
orders of magnitude, saved filter sets, per-CPSE queue scopes beyond the existing org scoping.

## 11. Limitations

Legacy candidates seeded before evidence JSON existed (e.g. the flagship demo pair) expose
scores but not the full comparison table — the WHY section states this honestly instead of
fabricating breakdowns; re-running the matcher regenerates full evidence for pending pairs
(decided rows are never rewritten). The prototype provider is the deterministic hashing
fallback; if a real embedding endpoint is configured the UI labels the provider truthfully
either way. Queue pagination is OFFSET-based per the existing architecture (bounded and safe at
this dataset scale).

## Step 24 — Judge Mode (explainability layer)

Step 24 added a dedicated read-only Judge Mode on top of this contract:

- `src/lib/services/judge-mode-service.ts` — `buildJudgeBrief()` composes the
  presentation brief (question, completeness, headline + WHY bullets, decision trace,
  score decomposition, rule trace, source trace, summary) **from `getMatchReview()`
  output only** — no rescoring, no threshold reinterpretation.
- `GET /api/matches/:id/evidence?judge=1` — same evidence API, additive judge mode.
- `/matching/[id]/judge` — SIH review view with print-friendly layout.

WHY modes: WHY_MATCH / WHY_REVIEW / WHY_NOT_MATCH / WHY_UNCLASSIFIED (legacy/limited),
all deterministic templates over persisted evidence. Source traceability reuses Step 22
integration metadata and honestly reports "Source metadata unavailable for this legacy
record." when absent. See **docs/JUDGE-MODE.md** for the full contract, security model
(read-only, audit-silent, IDOR-scoped) and performance (brief ~0.3 ms flat 1k→100k).

Details: docs/JUDGE-MODE.md. Tests: tests/matching-judge-mode.test.ts (chain).
