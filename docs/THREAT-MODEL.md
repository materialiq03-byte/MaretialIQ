# MaterialIQ — Threat Model (Step 25)

Lightweight, evidence-based threat model for the SIH prototype. Residual risk is
stated honestly; nothing here claims zero risk.

## Actors

1. Unauthenticated attacker (network)
2. Authenticated normal user (read-only CPSE roles)
3. Authenticated reviewer (can decide matches)
4. Governance steward / authority (UOM rules)
5. Platform administrator
6. Malicious import source (compromised CPSE feed)
7. Compromised client (malicious browser)

## Threat register

| Threat | Attack surface | Existing mitigation | Remaining risk / residual limitation |
|---|---|---|---|
| Unauthorized API access | all `/api/*` routes | Middleware session gate + per-route `requireApiPermission`; 401 before handlers run | Prototype mode (default) bypasses auth by design — production MUST set `REQUIRE_AUTH=true`; no MFA |
| IDOR | `:id` endpoints (materials, matches, evidence, judge, imports, audit) | Server-side org-scope resolution per request; 403/404 denials; IDOR matrix in security suite | Endpoints not carrying an org attribute rely on permission checks alone; new endpoints must repeat the pattern |
| Cross-organization data access | list/detail endpoints, adapters | `visibleOrganizationIds` read scoping; `assertOrganizationWrite` for mutations; adapter CPSE checks | Application-level only — PG RLS deferred (documented decision); a compromised app server sees all rows |
| CSRF | state-changing APIs | `SameSite=Lax` HttpOnly cookie + middleware Origin/host check (403 `csrf_rejected`, loopback-normalized) | No per-request CSRF token (origin check is the control); older browsers without Origin header would pass (modern browsers send it on cross-origin POSTs) |
| Brute-force / rate abuse | login, mutations, expensive reads | Fixed-window limiter: auth 10/min, mutations 60/min, reads 600/min; 429 + Retry-After | In-memory per-instance (multi-instance needs shared store); no persistent ban/lockout |
| Malicious uploads | import/integration analyze+execute | Extension allowlist, per-format size caps, parsed as DATA only (no execution), bounded row/field handling, malformed → 400 | XLSX parser (xlsx@0.18.5) has known prototype-pollution/ReDoS advisories — parsed input is untrusted; cap 5 MB and treat as accepted risk (no fix available) |
| Oversized JSON | JSON mutation routes | 1 MB streaming cap → 413, Content-Length pre-check | None material; cap is generous but bounded |
| CSV formula injection | error-report CSV export | Leading-apostrophe guard on `= + - @ \t \r` cells before quoting; nosniff | Applies to the one export path; future export features must reuse `csvEscape` |
| XSS | imported descriptions, review reasons, judge briefs | React escaping, zero `dangerouslySetInnerHTML`, CSP `default-src 'self'`, nosniff | CSP allows `'unsafe-inline'`/`'unsafe-eval'` scripts (Next.js runtime requirement) — documented exception |
| SQL injection | all queries | Parameterized statements; allowlisted ORDER BY maps; no string-built SQL | None identified (injection payload test passes) |
| Session theft | session cookie | HttpOnly (no JS access), Secure in production, 12h expiry, server-side invalidation, logout deletes row | No rotation on privilege change; no device binding; TLS required in production for Secure flag to matter |
| Secret leakage | logs, errors, repo, backups | Logging redaction layer; generic 500s; `.env*` gitignored; backups hold scrypt hashes only | Backups themselves must be stored securely (filesystem-level trust); no encryption-at-rest of backup artifacts |
| Database compromise | Supabase PG | TLS verify-full with pinned CA; bounded pool (max 5, 10s connect, 4 MB result ceiling); fail-closed TLS config | Application-level authorization only (no RLS); a stolen service credential sees everything |
| Malicious/incorrect imported material data | import pipeline | Validation with structured errors, duplicate identity net (UNIQUE(org, code)), idempotent re-ingestion, nothing auto-approved | Imported garbage still becomes reviewable data — human review is the control (by design) |
| Expensive query abuse | queue/summary/analytics endpoints | pageSize clamp (max 100), bounded aggregation queries, indexed access (EXPLAIN-verified covering indexes) | 100k-candidate summary is ~0.9 s — bounded but not free; rate limiter caps repeat abuse |
| Audit tampering | audit_logs table | CHECK-constrained vocabulary, append-only conventions, actor attribution | Database-level tampering possible for a DBA — no hash chain; trust boundary is the DB itself |
| Backup exposure | backups/ directory | No plaintext credentials (scrypt hashes only), sessions excluded by policy, no connection strings | Directory is on local disk; storage/transport security is operational, not enforced by code |
