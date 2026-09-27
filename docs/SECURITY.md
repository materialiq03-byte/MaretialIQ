# MaterialIQ — Security Documentation (Step 25)

**Status: prototype-grade security controls, honestly documented.** MaterialIQ is an
SIH 2026 prototype (PS 26099). This document describes what is ACTUALLY IMPLEMENTED —
it makes no compliance, certification, or penetration-test claims (no SOC 2, no ISO
27001, no OWASP certification, no production compliance).

## 1. Authentication

- Session authentication: opaque 256-bit random session ids (`randomBytes(32)`,
  base64url) stored as DB rows (`sessions` table); the browser carries only the
  opaque id in an HttpOnly cookie — no identity/role claims client-side.
- Passwords (when `REQUIRE_AUTH=true`): scrypt (N=16384, r=8, p=1, 64-byte key,
  per-user salt), constant-time verification (`timingSafeEqual`). No plaintext
  storage; passwords never logged (redaction layer, §16).
- **Prototype/demo mode (DEFAULT):** authentication is intentionally bypassed —
  every request gets a full-permission prototype identity. This is a documented
  SIH-demo configuration, not production security. Real deployments MUST set
  `REQUIRE_AUTH=true`.

## 2. Authorization / RBAC

- Server-side only. Roles: `platform_admin`, `authority`, `cpse_material_manager`,
  `cpse_technical_reviewer` with a fixed permission vocabulary
  (`src/lib/auth/permissions.ts`). Route handlers enforce via
  `requireApiPermission(...)`; pages via `requirePermission(...)`. UI button
  visibility is never the security boundary.

## 3. Organization isolation

- `visibleOrganizationIds(user)` read-scopes every list query;
  `assertOrganizationWrite` pins mutations to the user's own CPSE
  (`platform_admin` passes; `authority` is read-only by design).
- CPSE adapters reject profiles foreign to the caller's organization; the
  client-provided CPSE is never trusted.

## 4. IDOR protection

- Every ID-addressed endpoint re-resolves scope server-side. Cross-CPSE access to
  evidence/Judge Mode/decisions → 403 (existence is not leaked); unknown ids → 404;
  malformed ids → 400. Covered by the security suite's IDOR matrix
  (`tests/security-hardening.test.ts`, cross-org candidates/materials/imports/
  Judge Mode/audit).

## 5. CSRF protection

- Session cookie is `SameSite=Lax`, `HttpOnly`, `secure` in production, 12h expiry.
- Defense in depth: middleware rejects any state-changing `/api/` request whose
  `Origin` host differs from the request host (403 `csrf_rejected`). Loopback
  aliases (127.0.0.1/localhost/::1) are normalized on both sides so legitimate
  local use isn't false-positive rejected. Non-browser clients (no Origin) pass.

## 6. Rate limiting

- In-memory fixed-window limiter per client IP (`src/lib/security/rate-limit.ts`):
  auth endpoints 10/min, mutations 60/min, reads 600/min (env-overridable via
  `MATERIALIQ_RATE_LIMIT_*`). 429 + `Retry-After`; fail-open on internal error;
  5,000-key cap with aging sweep.
- **Limitation:** per-instance, in-memory — a multi-instance deployment needs a
  shared store (Redis or equivalent). Documented as an accepted prototype limit;
  no Redis was introduced for this step.

## 7. Security headers

Every response (middleware): CSP (`default-src 'self'`, scripts self+inline+eval for
the Next runtime, `frame-ancestors 'self'`, `object-src 'none'`, `base-uri 'self'`,
`form-action 'self'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options:
SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`
(camera/microphone/geolocation/payment/usb off), HSTS only when served over HTTPS.

## 8. Input validation

- Zod schemas for every JSON body/query (`parseOrThrow` + `errors.validation` → 400
  with field-level details). Enums are closed; sizes are capped; unknown enum
  values are rejected, never coerced.
- Route params parsed as integers with range checks (400/404 on failure).

## 9. Upload limits

- Per-format caps from `maxUploadMbFor`: CSV 50 MB (streamed/bounded), XLSX 5 MB
  (memory-bound safety), legacy `MAX_IMPORT_FILE_MB` override honored. Enforced in
  imports/procurement/integration analyze+execute; extension allowlist (`.csv`,
  `.xlsx`, `.xls` only). Malformed multipart → 400 (never 500).

## 10. JSON body limits

- `readBoundedJsonOr` on every JSON mutation route: 1 MB cap, `Content-Length`
  pre-check plus streaming count, 413 `payload_too_large` (survives the tolerant
  parse fallback so an oversized body can't masquerade as a 400). Absent/invalid
  bodies fall through to zod for the historical 400 contract.

## 11. CSV formula-injection protection

- The one CSV export (`/api/imports/:id/errors`) guards cells beginning with
  `= + - @ \t \r` by a leading apostrophe at the ENCODING layer — checked BEFORE
  quoting — plus `nosniff` on the response. Stored source data is never mutated.

## 12. SQL injection protections

- All queries parameterized (`?` placeholders); no user input is ever concatenated
  into SQL. Dynamic ORDER BY uses fixed allowlist maps (`SORTABLE`,
  `REVIEW_SORT_SQL`); filters map to parameterized clauses. Verified by an
  injection-payload test through the API.

## 13. XSS handling

- React JSX escaping everywhere; zero `dangerouslySetInnerHTML` in the codebase
  (audited). API responses are `application/json` + `nosniff`; CSP blocks inline
  script. Stored-XSS payload test asserts the payload is never served executable.

## 14. TLS configuration

- PostgreSQL: default is certificate-validated TLS (pinned CA, `rejectUnauthorized:
  true`, explicit SNI — verify-full equivalent). `MATERIALIQ_PG_SSL=insecure` is a
  local-dev convenience: production boot is REFUSED (instrumentation guard) and the
  executor refuses at connect time. `disable` mode exists only for isolated local
  test containers.

## 15. Secret management

- Secrets via env only (`.env.local`); `.env*` is gitignored; no secrets in the
  repository (suite-asserted). Structured logging redacts
  password/session/token/key/URL-class fields at the logging boundary
  (`src/lib/security/log.ts`). Backup JSONL contains only scrypt hashes (not
  reversible; no plaintext credentials).

## 16. Audit / security events

- Single audit subsystem (`audit_logs`, CHECK-constrained action vocabulary).
  Mutations audited with actor + details; reads are audit-silent (asserted by
  tests). Auth events (`user_login`, `user_login_failed`, `user_logout`,
  `demo_role_switched`) exist in the existing vocabulary — no second audit trail.
- Structured operational events (`authz_denied`, `rate_limited`, `csrf_rejected`,
  `import_failed`, …) go to stderr as JSON lines with a correlation id.

## 17. Correlation IDs

- `correlationId()` generates a short per-event id included in every structured
  security log line for grouping a request's events.

## 18. Error handling

- Typed `AppError` → stable JSON `{error:{code,message}}` with correct statuses
  (400/401/403/404/409/413/429/500). Unknown errors log server-side and return a
  generic 500 — no stack traces, SQL, paths, or env ever reach the client
  (suite-asserted).

## 19. Backup / recovery

- See `docs/BACKUP-RECOVERY.md` (full procedure). Backup verify:
  `npx tsx scripts/pg-verify-backup.ts <dir>` (checksums, structure, counts). The
  frozen backup contains no credentials/sessions (Step 7A policy). Restore drill
  (isolated Docker PostgreSQL + parity validator) documented and previously proven;
  Supabase free tier does NOT provide managed PITR — documented limitation.

## 20. Production environment requirements

- `REQUIRE_AUTH=true` (mandatory in production — boot fails otherwise unless
  `ALLOW_PROTOTYPE_MODE_IN_PRODUCTION=true` is set consciously, which prints a
  warning), validated TLS, secrets supplied externally, HTTPS for `secure` cookies.
- Guard runs at server boot via `src/instrumentation.ts` (`register()`), so
  `next build` (compilation) is not blocked but serving an unsafe config is.

## 21. Prototype/demo-mode limitations

- Default prototype identity bypasses authentication (SIH demo convenience).
- Demo role switching disabled in production unless `ALLOW_DEMO_SWITCH=true`.
- Demo/synthetic data is labeled; no demo rows are written to production databases.

## 22. Known limitations

- In-memory rate limiting is single-instance only.
- Audit immutability is application-level (CHECK-constrained vocabulary + append
  conventions); a database-level attacker could still mutate rows — no cryptographic
  tamper-evidence is claimed.
- Organization isolation is application-level; PostgreSQL RLS is deferred (Step 25
  decision: RLS on pooled `pg` connections via one service role would require
  per-request `SET ROLE` plumbing across the worker-thread bridge — deferred with
  evidence, not silently skipped).
- No password-based brute-force lockout beyond the auth rate limit bucket.
- No security certification of any kind is claimed.
