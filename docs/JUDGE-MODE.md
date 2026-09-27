# Judge Mode — Explainability Layer (Step 24)

**Status: IMPLEMENTED (Step 24) as a deterministic, read-only explanation layer.**
Judge Mode answers one question — *“Why did MaterialIQ make this decision?”* — from
real, persisted evidence. It contains **no LLM, no generated text, and no rescoring**:
every bullet, count, and score comes from the persisted match evidence, the technical
comparison, the matching rules, or the human governance record.

---

## Architecture

```
persisted match_candidates (+ evidence JSON)
        ↓
getMatchReview()                ← Step 23 match-review-service (authoritative, never re-scores)
        ↓
buildJudgeBrief()               ← Step 24 judge-mode-service (presentation layer)
        ↓
GET /api/matches/:id/evidence?judge=1   ← same Step 23 evidence API, additive ?judge=1
        ↓
/matching/[id]/judge            ← read-only SIH review view (print-friendly)
```

Judge Mode **consumes** the Step 23 contract (`getMatchReview`); it does not duplicate
its evidence-generation logic. It adds only presentation composition:

- decision trace (stage-by-stage path with per-stage actual evidence)
- deterministic WHY bullets tailored to the question being asked
- source traceability (Step 22 integration metadata)
- rule trace (only rules that actually affected the candidate)
- summary counts computed from the evidence rows

**Zero writes:** no audit rows, no history rows, no decision writes, no CMI writes.
Reads are audit-silent by the same convention as every other read path (asserted by tests).

## The judge brief

One stable, deterministic structure per candidate:

| Field | Content |
|---|---|
| `question` | `WHY_MATCH` \| `WHY_REVIEW` \| `WHY_NOT_MATCH` \| `WHY_UNCLASSIFIED` — derived from the persisted verdict + human decision state |
| `completeness` | `COMPLETE` (full persisted evidence) \| `LIMITED` (legacy candidate) |
| `headline` | both materials, verdict label, final score, human-review requirement, reason, WHY bullets |
| `decisionTrace` | 10 stages (source → category → text → technical → conflict check → rules → score → verdict → human review → CMI) each with actual data |
| `scoreDecomposition` | the four persisted components (semantic 30%, fuzzy 20%, technical 30%, rules 20%) — displayed values are the server’s, never recomputed in the client |
| `technicalMatrix` | the Step 23 comparison rows (`attribute / left / right / relation / importance / basis`) |
| `conflicts`, `missingEvidence` | criticality + system effect only — no invented engineering consequences |
| `ruleTrace` | only rules with actual effect (same-category gate, critical comparisons, nominal identity, manufacturer policy, assembly detection) |
| `sourceTrace` | per side: CPSE, source system + adapter version, source record id, import reference — from Step 22 `row_report` metadata; legacy records render *“Source metadata unavailable for this legacy record.”* |
| `humanDecision` | decision history from the existing review records (reviewer, decision, reason, previous→new status, timestamp) |
| `cmiState` | `AWAITING CMI` / `CMI CREATED` / `NO CMI CREATED` from existing mapping tables |
| `summary` | counts of exact / normalized / close / missing / conflicts / critical, from actual rows |

### WHY modes (negative decisions included)

- **WHY MATCH** — same category, aligned critical attributes, manufacturer satisfies policy, no critical conflict, score ≥ high-confidence threshold.
- **WHY REVIEW** — e.g. *“Critical conflict on Power Rating: 75 KW vs 30 KW — human technical review required.”* plus *“A human technical reviewer decides — the system never auto-approves conflicts.”*
- **WHY NOT MATCH** — score below threshold / category exclusion / nominal identity differences.
- **WHY UNCLASSIFIED** — legacy/limited candidates where the persisted verdict cannot be re-derived; shown honestly rather than guessed.

## System assessment vs human decision

Every view separates the two, visually and structurally:

- SYSTEM ASSESSMENT: verdict + score + evidence (deterministic engine output)
- HUMAN DECISION: pending / accepted / rejected / deferred, with reviewer attribution

The system never presents an automated verdict as an engineering approval. CMI creation
remains a separate governed workflow — Judge Mode only displays its state.

## Legacy candidates (honesty rules)

Candidates predating the evidence document are `completeness: LIMITED`:

- scores come from the persisted candidate columns, labelled as such;
- the brief states *“Detailed persisted evidence is unavailable for this legacy candidate.”*;
- **never** fabricated: 0% weights, fake matrix rows, fake conflicts, invented source metadata.

## Completeness indicator

`COMPLETE` only when the evidence required by the contract exists (evidence JSON +
comparison rows). A deliberately binary indicator — no invented “explainability %”.

## Security

- Read-only API, but fully authorized: `requireApiUser` + organization-scope guard (IDOR: an out-of-scope candidate id resolves to not-found, not data).
- Invalid candidate → structured `not_found`; no internal details leak.
- No secrets, connection strings, or infrastructure metadata in briefs.

## Performance

Measured isolated (`.freebuff/step24-bench.mts`, synthetic SQLite):

| Candidates | Judge brief (p50) |
|---|---|
| 1k | ~0.29 ms |
| 10k | ~0.30 ms |
| 100k | ~0.31 ms |

Flat cost — every read is an indexed point lookup (candidate by primary key, materials
by primary key, import row by unique index); no candidate-table scan, no re-matching.
Step 23 evidence detail measured 0.26 ms; the added composition is +~0.04 ms.

## IMPLEMENTED vs FUTURE

**IMPLEMENTED:** judge brief service + `?judge=1` API extension, `/matching/[id]/judge`
view, decision trace, WHY modes (match/review/not/unclassified), source trace, rule
trace, human/system separation, completeness indicator, print-friendly layout,
40-area test suite in the chain.

**FUTURE (documented, not built):** interactive expandable trace accordions (current
trace is rendered inline), PDF/“export review” as a distinct subsystem (browser print
is provided), multi-candidate judge digest, i18n wording packs. Step 26 freezes the
SIH demo evidence; the premium visual redesign comes after engineering is frozen.

## Limitations

- Explanations are only as complete as persisted evidence — legacy rows are LIMITED by design.
- Judge Mode derives the *question* from persisted verdict + decision state; it never
  re-derives the verdict itself.
- Benchmarks are synthetic; no production-CPSE performance is claimed.
