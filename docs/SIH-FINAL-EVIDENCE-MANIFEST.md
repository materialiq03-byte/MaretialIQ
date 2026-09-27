# MaterialIQ — SIH 2026 FINAL EVIDENCE MANIFEST

**Problem Statement:** SIH 26099 · **Theme:** Smart Automation
**Freeze date:** 2026-09-25 · **Status:** DEMO & EVIDENCE FREEZE (Step 26)

This manifest is the authoritative index of every artifact behind the SIH
submission. Every claim in the pitch deck and demo script traces to an entry here.

---

## 1. Authoritative source

| Item | Value |
|---|---|
| Checkout | `C:\dev\MaterialIQ` (stale OneDrive mirrors exist — ONLY this path is authoritative) |
| Version control | **Not a git repository** (documented in docs/RELEASE-BASELINE.md); authoritativeness = this directory + this manifest |
| App version | `0.2.0` (package.json) |
| Framework | Next.js `^15.3.0` (15.5.25 installed), React `^19.0.0`, TypeScript |
| Runtime | Node.js v24.12.0 |
| Database | PostgreSQL 17.6 (Supabase, authoritative) · SQLite reference fallback (schema v12, frozen) |
| App schema | v19 semantics (frozen since Step 22; zero migrations in Steps 23–26) |
| Environment mode | `SIH prototype` — boot guard: production requires `REQUIRE_AUTH=true` or explicit `ALLOW_PROTOTYPE_MODE_IN_PRODUCTION=true` |

**Freeze verification (2026-09-25):** tsc clean · build green · npm test 38 files /
37 suite summaries all `passed, 0 failed` · smoke 35/35 · PG 21/21 · evaluation
byte-identical (md5 `c8c7ba9685601efe8dddacedc2df4e6f`).

## 2. Databases

| Role | Artifact | Counts (frozen) |
|---|---|---|
| Authoritative production | Supabase PG via `.env.local` (MATERIALIQ_DATABASE_URL) | 5 orgs · 120 materials · 691 attrs · 16 imports · 1289 candidates · 1289 review · 10 decisions · 1 CMI · 3 mappings · 62 audit · 5 eval runs · 5 users · 0 sessions · 19 public tables · 65 indexes |
| SQLite reference | `data/materialiq.db` (READ-ONLY, schema v12) | same business counts |
| Demo dataset | `data/` tree (synthetic) — see §3 | 5 CPSEs, 25 seeded materials + reference copy 120 |
| Isolation rule | All tests/smoke/benchmarks run on copies under `.freebuff/` or temp dirs | production never touched by tests |

## 3. Frozen demo dataset (Phase 2)

- **Files:** `data/materialiq.db` (authoritative demo DB for live demo),
  `data/synthetic-imports/` (per-CPSE XLSX/CSV seeds), `data/cpse-feeds/`
  (Step 22 adapter feeds: CPCL/NTPC/BHEL/NLC/SAIL `.csv`)
- **Label (mandatory in all materials):** *"Synthetic demonstration data created
  for SIH prototype evaluation."* — never real CPSE procurement data.
- **Composition (demo DB):** 5 CPSEs × 5 categories (Bearings, Valves, Motors,
  Pumps, Fasteners); reference copy: 120 materials / 691 attributes / 1289
  candidates / 1289 review items / 10 decisions / 1 CMI / 3 mappings.
- **Key demonstration records:** CP-1001 (CPCL), NT-8821 (NTPC), SL-7721 (SAIL),
  BH-4410 (BHEL), Class 150/300 valve pair, 415V/230V motor pair, CP-5001
  (with-nut assembly) / BH-1102 (bare bolt), FAG/SKF cross-brand pair,
  CMI-BRG-6205 (first harmonized identity), candidate 4640 (flagship conflict).
- **Checksum:** SHA-256 of `data/materialiq.db` recorded at freeze in
  `.freebuff/step26-demo-dataset.txt` (regenerate with
  `certutil -hashfile data\materialiq.db SHA256`).

## 4. Evaluation evidence (Phase 7)

- Dataset: `data/evaluation/ground-truth-pairs.json` — **50 hand-labelled synthetic
  cross-CPSE pairs** (MATCH 18 · NEEDS_REVIEW 13 · NOT_A_MATCH 19).
- Frozen metrics (run-0005): accuracy **0.84** · macro P **0.8730** · macro R
  **0.8596** · macro F1 **0.8327** · weighted F1 **0.8375** · conflict detection
  **20/20** · FP **0** · FN **0** · review rate **0.42**.
- Byte-identity proof: `npx tsx scripts/evaluate.ts` on an isolated copy →
  `.freebuff/evaluation-report.json` md5 **c8c7ba9685601efe8dddacedc2df4e6f**
  (verified 2026-09-25, Steps 23–25).
- Honesty label: *"Prototype evaluation on synthetic data"* — never production accuracy.

## 5. Performance evidence (Phase 8)

Measured in the prototype test environment (isolated SQLite, Node v24). No
enterprise-scale guarantees.

| Measure | Result | Source |
|---|---|---|
| Judge brief (evidence composition, no rescoring) | 0.30–0.46 ms @ 1k–100k candidates, EXPLAIN = PK SEARCH | `.freebuff/step24-bench.mts` |
| Evidence detail | 0.24–0.27 ms | `.freebuff/step23-bench.mts` |
| Review decision | ~1.2 ms | step23 bench |
| Review queue p50 (10k / 100k candidates) | ~20 ms / ~760 ms (covering index `idx_match_status_score`) | step23 bench |
| 30k-candidate matching persistence | chunked (5,000/tx), heartbeat-guarded | matching-job tests |
| HTTP API through full security middleware | median 3.8–5.2 ms (health/materials/evidence) | Step 25 curl timing |
| Import pipeline | CSV streaming (50 MB cap), XLSX 5 MB, chunked async jobs, adapter overhead ~4% @100k | Step 22 bench |

## 6. Security evidence (Phase 9)

- Controls: session auth (scrypt, HttpOnly/SameSite/Secure cookies, 12h TTL),
  RBAC (4 roles), organization isolation + IDOR scoping, CSRF origin checks,
  rate limiting (10/60/600 per min), security headers (CSP/nosniff/frame/
  referrer/permissions/HSTS), 1 MB JSON caps, upload caps, CSV formula-injection
  guard, parameterized SQL + allowlisted ORDER BY, audit trail with
  CHECK-constrained vocabulary, TLS verify-full (pinned CA), production boot
  guard, secret redaction in logs, backup/verify/restore tooling.
- **Honest disclosure:** Step 25's security audit found and FIXED two real IDOR
  gaps (cross-org decision API returned 200; evidence denial was 500). Both now
  403, regression-tested.
- Evidence: `tests/security-hardening.test.ts` — 40/40 (real `next start`, real
  sessions). Docs: SECURITY.md, THREAT-MODEL.md, PRODUCTION-READINESS.md.
- **Not claimed:** penetration testing, SOC 2 / ISO / OWASP certification.

## 7. Backup / recovery evidence (Phase 10)

| Item | Value |
|---|---|
| Backup artifact | `backups/materialiq-pg-20260921T102818Z/` (19 files) |
| Timestamp | 2026-09-21T10:28:18Z |
| Rows / tables | 3,496 rows / 17 tables |
| Checksums | manifest SHA-256 per file — **VERIFY PASS, 0 failures** (re-run 2026-09-25) |
| PG version | 17.6 recorded in manifest |
| Secrets in backup | none (scrypt hashes only; sessions excluded per Step 7A) |
| Restore drill | isolated `postgres:17` container + `scripts/pg-restore.ts` + parity validator → counts/id-coverage/row-hashes/evidence-hashes/FK(19 edges)/65 indexes/flagship rows ALL PASS; app smoke 35/35 on restored DB; evaluation 50/50 identical (Step 11 record, run.md) |
| Platform caveat | **Supabase free tier provides no managed PITR** — recovery relies on the documented manual procedure (docs/BACKUP-RECOVERY.md) |

## 8. Test evidence

- Canonical chain: `npm test` = `scripts/test-env-guard.js` + 38 test files →
  37 suite summaries, all `passed, 0 failed` (2026-09-25).
- Suites include: engine/pipeline, import (sync/async/streaming/batch/HTTP
  contract), matching (retrieval/adapter/prefilter/prepared/persistence/
  short-circuit/funnel/job), Steps 17–21 (UOM, governance, history, versioning,
  cockpit), Step 22 (cpse-integration, 32 areas), Step 23
  (matching-review-hardening, 39 areas), Step 24 (matching-judge-mode, 36 tests /
  40 areas), Step 25 (security-hardening, 40 areas).
- PostgreSQL integration: `tests/pg-integration.test.ts` 21/21 (Supabase).
- TypeScript: clean. Production build: green.

## 9. Screenshots (Phase 13)

Captured 2026-09-25 against the live demo server (synthetic data, no dev tools,
no localhost-visible artifacts in presentation crops). Stored under
`.freebuff/step26-screenshots/`. Index:

1. `01-dashboard.png` — command center KPIs
2. `02-matching-workspace.png` — review queue with summary metrics
3. `03-technical-comparison.png` — flagship conflict pair side-by-side
4. `04-why-this-result.png` — WHY section on workbench
5. `05-judge-mode-why-review.png` — WHY_REVIEW brief (seal/power conflict)
6. `06-judge-mode-why-match.png` — WHY_MATCH brief
7. `07-human-review.png` — decision panel (Accept/Reject/Defer)
8. `08-cmi.png` — common material identity + mappings
9. `09-governance-cockpit.png` — unified governance work queue
10. `10-procurement.png` — supplier intelligence / opportunities
11. `10b-uom-governance.png` — steward dashboard / rule versions
12. `11-import-center.png` — async import center
13. `11b-cpse-integrations.png` — five source adapters

## 10. Presentation & demo documents

| Artifact | Path |
|---|---|
| Final PPT (14-slide content spec) | `docs/SIH-FINAL-PPT.md` |
| Demo script (7–10 min journey, 10 scenarios) | `docs/DEMO-SCRIPT.md` (Step 26 edition) |
| 3-minute pitch | `docs/SIH-FINAL-PPT.md` §3-minute pitch |
| Judge Q&A (25 answers) | `docs/SIH-JUDGE-QA.md` |
| Demo failure/fallback plan | `docs/SIH-DEMO-FALLBACK.md` |
| Architecture diagram | `docs/SIH-ARCHITECTURE.md` |
| Solution overview | `docs/SOLUTION-OVERVIEW.md` |
| Demo dataset record | `.freebuff/step26-demo-dataset.txt` |

## 11. Documentation set (Phase 12)

README · SOLUTION-OVERVIEW · ARCHITECTURE · MATCHING-REVIEW · JUDGE-MODE ·
CPSE-INTEGRATION · PROCUREMENT · SECURITY · THREAT-MODEL · PRODUCTION-READINESS ·
BACKUP-RECOVERY · RELEASE-BASELINE · DEMO-SCRIPT · SIH-FINAL-PPT ·
SIH-JUDGE-QA · SIH-DEMO-FALLBACK · SIH-FINAL-EVIDENCE-MANIFEST (this file).

## 12. Freeze rule

After Step 26: **no** new features, matching changes, evaluation changes, schema
changes, AI-claim embellishment, or unverified benchmarks. Allowed: demo-blocking
bug fixes (with regression rerun), documentation corrections, presentation work.
Next phase (separate): premium UI/UX transformation.
