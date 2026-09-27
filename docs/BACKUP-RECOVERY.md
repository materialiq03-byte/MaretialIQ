# MaterialIQ — PostgreSQL Backup & Recovery Runbook (Step 11)

No credentials in this document. Connection details live only in the
git-ignored `.env.local` (`MATERIALIQ_DATABASE_URL`). All scripts read it from
the environment and never print it.

## Backup inventory

| Artifact | Location | Contents |
|---|---|---|
| Logical backup | `backups/materialiq-pg-20260921T102818Z/` | 17 MaterialIQ tables as JSONL + `manifest.json` (row counts, per-file SHA-256, source PG version) |
| Pre-migration SQLite snapshot | `backups/materialiq-pre-7a-snapshot.db` | Read-only SQLite reference (Step 7A) |

`backups/` is git-ignored — never commit backup artifacts.

## Recovery runbook

1. **Identify database failure.** Symptoms: app 500s on every route, connection
   failures from Supabase, or data corruption suspected. Confirm scope before
   acting (read-only probes only).
2. **Stop the affected application instance.** Kill the `next start` process
   (it holds open pool connections). Do not let a half-connected app write.
3. **Obtain the latest verified backup.** Use the newest
   `backups/materialiq-pg-*/` directory; confirm
   `npx tsx scripts/pg-verify-backup.ts <dir>` reports PASS (checksums +
   structure). If it fails, do not use that artifact.
4. **Restore to a CLEAN PostgreSQL 17 environment.**
   - Isolated local target (proven procedure):
     `docker run -d --name materialiq-restore-pg -e POSTGRES_PASSWORD=... -p 127.0.0.1:54329:5432 postgres:17`
     then `npx tsx scripts/pg-restore.ts <backupDir>` (script refuses a
     non-empty target and loads schema + data in dependency order).
   - For a new Supabase project: create the project, apply
     `supabase/migrations/20260920120000_materialiq_v11_schema.sql`, then load
     the JSONL tables in the same dependency order with sequences reset
     (`scripts/pg-restore.ts` logic).
   - NEVER restore in place over a possibly-intact production dataset.
5. **Validate the restored database.** Run the parity validator against a
   known-good reference (production before failure, or the backup itself):
   counts, id coverage, row hashes, evidence hashes, FK orphans (19 catalog
   edges), 65 indexes, flagship rows (CMI-BRG-6205, CP-1001, NT-8821,
   SL-7721, BH-4410, candidate 4640).
6. **Point MaterialIQ at the recovered database.** Set
   `MATERIALIQ_DATABASE_URL` (and `MATERIALIQ_DB_DIALECT=postgres`) in
   `.env.local` of the app host, pin the CA if the host changed
   (`npx tsx scripts/bootstrap-pg-ca.ts`), restart `next start`.
7. **Run smoke + evaluation checks.** `SMOKE_BASE_URL=http://127.0.0.1:<port>
   npm run smoke` must be 35/35. Run the 50-pair evaluation capture
   (`.freebuff/step8-capture.ts`) and require 50/50 identical pairs and the
   frozen metrics (accuracy 0.84, macro P/R/F1 0.8730/0.8596/0.8327,
   weighted 0.8375, conflicts 20/20, FP/FN 0/0).
8. **Resume application traffic only after validation passes.** If anything
   fails, keep the app down and re-restore from a different verified backup.

## Scheduled backups (platform reality)

- The current Supabase project is on the **free tier: NO automated backups
  and NO PITR**. Supabase provides daily automated backups only on Pro
  (7-day retention), Team (14-day), Enterprise (30-day); PITR is a paid
  add-on (configurable retention, restore to any second).
- Scheduling cannot be configured programmatically for this project tier.
  Upgrade in the Supabase dashboard (Database → Backups) to enable platform
  backups; recommended retention for MaterialIQ: ≥ 7 days daily + weekly
  full (Pro/Team tiers cover this).
- Until upgraded, recreate the logical backup on a schedule (weekly is
  adequate for the demo dataset's change rate) by re-running
  `scripts/pg-backup.ts` and keeping the last N directories.

## Re-verification cadence

After any backup refresh: run `pg-verify-backup.ts` (structure) and, after
any restore or quarterly, the full parity validator + restore drill above.
