# MaterialIQ — Supabase RLS design (Step 6A — design only, NOTHING applied)

Status: **draft for review**. No RLS is enabled and no policy exists on
Supabase in Step 6A. This document defines the strategy to implement during
the cutover step.

## Access models to distinguish

| Model | Who | Channel | RLS posture |
|---|---|---|---|
| A. Server-side trusted access (current, and the only model in the prototype) | Next.js server routes/services | direct Postgres connection with a server-only credential | **Bypass RLS** — the app's own permission guard (`requireApiPermission`, roles `cpse_material_manager`, `cpse_technical_reviewer`, `authority`, `platform_admin`) is the authorization layer, exactly as with SQLite today |
| B. Authenticated user access (future) | Logged-in users via Supabase Auth (auth.users) | PostgREST / supabase-js with the user's JWT | **RLS enabled**, policies keyed on `auth.uid()` mapped to the `users` table |
| C. Anonymous/public | No JWT | PostgREST | **Deny by default** — RLS with no policy = no access |

## Strategy

1. **Step 6A (this step):** tables created WITHOUT `ENABLE ROW LEVEL SECURITY`.
   The migration intentionally does not enable RLS so the schema apply cannot
   accidentally lock out the trusted server role before the cutover is
   designed end-to-end. The security advisor reports 0 lints with RLS disabled
   *only while the tables are inaccessible to anon/authenticated roles* — the
   cutover must `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated`
   so Model C is denied at the grant level regardless of RLS state.
2. **Cutover step (6B/6C):**
   - Grant usage to a dedicated `materialiq_app` role (or service-role key),
     never the anon key, for Model A traffic.
   - `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on all business tables, with
     **no policies for `anon`/`authenticated`** until Model B ships. This keeps
     deny-by-default for browsers while the trusted role bypasses via
     `BYPASSRLS` or table owner semantics.
   - Only when Model B is implemented, add per-table policies using the mapping
     below.

## Future Model B policy sketch (NOT applied)

- `users.organization_id` links to the CPSE; policies compare
  `(select organization_id from users where id = auth.uid())` (wrapped in a
  `select` so the policy is a per-statement, not per-row, initplan).
- `organizations`, `material_records`, `material_attributes`: readable by any
  authenticated MaterialIQ user; writable only by
  `cpse_material_manager` of the owning organization (or `platform_admin`).
- `match_candidates`, `review_queue`, `match_decisions`:
  readable cross-organization (matching is platform-wide by design);
  decision writes restricted to `cpse_technical_reviewer`/`authority`.
- `common_materials`, `material_mappings`: readable cross-organization;
  writable only by `authority` (mirrors CMI approval gating).
- `audit_logs`: **append/insert-only for everyone; no update/delete policy at
  all** — immutability enforced at the policy level.
- `matching_runs`, `matching_run_chunks`, `import_runs`, `import_run_chunks`,
  `import_rows`: server-role only (no client policies).
- Restrictive cross-CPSE visibility (a CPSE seeing only its own materials)
  must NOT be applied to reads, because matching/review workflows are
  cross-CPSE by product definition; it would be expressed only on write paths.

## Validation hooks for cutover

- Re-run security advisor after enabling RLS: expected lints only if grants to
  `anon`/`authenticated` are accidentally left wide.
- Verify `select count(*) from pg_policies` matches this document when Model B
  lands; zero policies is the correct end-state for 6A.
