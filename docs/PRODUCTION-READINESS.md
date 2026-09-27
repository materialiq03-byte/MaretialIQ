# MaterialIQ — Production Readiness Checklist (Step 25)

Honest deployment gate for the SIH prototype. Items marked ✅ are verified by the
Step 25 security suite (`tests/security-hardening.test.ts`), the boot guard, or the
regression chain — not aspirational.

## ENVIRONMENT
- [x] Production environment configurable — boot guard validates config at server start (`src/instrumentation.ts`)
- [x] Secrets supplied externally via env (`.env.local`); `.env*` gitignored (suite-asserted)
- [x] No committed secrets (repository scan + suite test 38)
- [ ] TLS/HTTPS termination configured at the deployment edge (deployment-specific; HSTS auto-enables over HTTPS)
- [x] `secure` cookie flag set automatically in production
- [x] Production mode (`NODE_ENV=production`) honored; unsafe configs refuse to boot

## DATABASE
- [x] PostgreSQL reachable with TLS (verify-full: pinned CA + `rejectUnauthorized:true`)
- [x] TLS verification enforced — `insecure` refuses production boot AND connect-time refusal in the executor
- [ ] Least-privilege DB role (current Supabase user is the project service role — documented limitation)
- [x] Backup available and verified (`npx tsx scripts/pg-verify-backup.ts` — PASS, 3,496 rows, 17 tables, 0 failures)
- [x] Restore procedure documented and previously drill-proven (isolated container + parity validator; see docs/BACKUP-RECOVERY.md)
- [x] Pool bounded (max 5, idle 30s, connect 10s), 4 MB result ceiling

## AUTH
- [x] `REQUIRE_AUTH=true` required for production (boot guard enforces; prototype mode needs explicit `ALLOW_PROTOTYPE_MODE_IN_PRODUCTION=true`)
- [x] Session expiration verified (12h TTL, expired rows rejected + purged)
- [x] Logout invalidates the session server-side (suite test 28)
- [x] Authorization enforced per route (permission matrix tests)
- [x] Organization isolation enforced (IDOR matrix tests)

## APPLICATION
- [x] Input validation (zod, closed enums, bounded sizes)
- [x] Rate limiting active (auth 10/min, mutations 60/min, reads 600/min; 429 + Retry-After)
- [x] Security headers active (CSP, nosniff, frame, referrer, permissions-policy, HSTS over HTTPS)
- [x] Safe error handling (no stacks/SQL/paths/env to clients)
- [x] Structured security logging with correlation ids and redaction
- [x] Health endpoints: `/api/health/live` (no DB) + `/api/health/ready` (bounded SELECT 1; safe failure)

## IMPORT
- [x] File limits configured (CSV 50 MB, XLSX 5 MB, per-format override)
- [x] Malformed files rejected (multipart/CSV/XLSX failure paths → 400, never 500)
- [x] Import jobs recover safely (heartbeat + terminal states; chunked transactions)

## AUDIT
- [x] Mutations audited (actor + details; CHECK-constrained vocabulary)
- [x] Read-only operations audit-silent (suite-asserted)
- [x] Actor identity preserved (session user; client-supplied identity ignored)

## RECOVERY
- [x] Backup verification PASS
- [x] Restore parity previously drill-verified (counts/hashes/FK 19 edges/65 indexes/flagship rows/eval 50/50 — run.md Step 11 record; Docker daemon unavailable at Step 25 time, prior evidence accepted)
- [x] Recovery smoke procedure documented (35/35 against restored DB)

## DEMO
- [x] Synthetic data clearly identified (demo labels + disclaimers)
- [x] Demo accounts controlled (demo switch disabled in production unless explicit)
- [x] Test routes disabled — no test/seed endpoints exist; test-env-guard blocks PG-targeting env in the local suite

## FREE-TIER LIMITATION (documented, not claimed)
Supabase free tier does not provide managed PITR/automated-backup guarantees of paid
infrastructure. Recovery depends on the manual backup/verify/restore procedure above.
