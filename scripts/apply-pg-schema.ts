/**
 * Apply the reviewed MaterialIQ PostgreSQL schema (Step 6A draft, unmodified)
 * to the configured Supabase/PostgreSQL database.
 *
 * Env-gated: requires MATERIALIQ_DATABASE_URL; refuses to run when the public
 * schema already contains MaterialIQ tables (no silent re-apply / no drops).
 *
 *   MATERIALIQ_DATABASE_URL=... npx tsx scripts/apply-pg-schema.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

async function main(): Promise<void> {
  const connectionString = process.env.MATERIALIQ_DATABASE_URL;
  if (!connectionString) {
    console.error('Refusing to run: MATERIALIQ_DATABASE_URL is not set.');
    process.exit(1);
  }

  const migrationPath = path.join(process.cwd(), 'supabase', 'migrations', '20260920120000_materialiq_v11_schema.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    // --- Pre-flight: the public schema must be free of MaterialIQ tables ---
    const pre = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name`
    );
    const existing = (pre.rows as Array<{ table_name: string }>).map((r) => r.table_name);
    const materialiqTables = existing.filter((t) =>
      [
        'organizations', 'material_records', 'material_attributes', 'data_imports',
        'match_candidates', 'match_decisions', 'review_queue', 'common_materials',
        'material_mappings', 'audit_logs', 'evaluation_runs', 'users', 'sessions',
        'matching_runs', 'matching_run_chunks', 'import_runs', 'import_run_chunks',
        'import_rows', '_migrations',
      ].includes(t)
    );
    if (materialiqTables.length > 0) {
      console.error(`Refusing to apply: MaterialIQ tables already exist (${materialiqTables.join(', ')}).`);
      process.exit(1);
    }
    if (existing.length > 0) {
      console.log(`Note: public schema also contains non-MaterialIQ tables (left untouched): ${existing.join(', ')}`);
    }

    // --- Apply the migration verbatim, as ONE transaction ------------------
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('Applied 20260920120000_materialiq_v11_schema.sql (single transaction).');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    // --- Post-apply verification -------------------------------------------
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log(`tables (${tables.rows.length}):`, (tables.rows as any[]).map((r) => r.table_name).join(', '));

    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`
    );
    console.log(`indexes (${indexes.rows.length})`);

    const guards = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('uq_matching_runs_active','uq_import_runs_active')`
    );
    console.log('active-run guards:', (guards.rows as any[]).map((r) => r.indexname).join(', '));

    const checks = await client.query(
      `SELECT COUNT(*)::int AS n FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND c.contype = 'c'`
    );
    console.log('CHECK constraints:', checks.rows[0].n);

    const fks = await client.query(
      `SELECT COUNT(*)::int AS n FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND c.contype = 'f'`
    );
    console.log('foreign keys:', fks.rows[0].n);

    const policies = await client.query(`SELECT COUNT(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`);
    console.log('RLS policies:', policies.rows[0].n);

    const ext = await client.query(
      `SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql','uuid-ossp','pgcrypto','pg_stat_statements','supabase_vault') ORDER BY extname`
    );
    console.log('unexpected extensions:', ext.rows.length === 0 ? 'none' : (ext.rows as any[]).map((r) => r.extname).join(', '));

    const evidence = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='match_candidates' AND column_name='evidence'`
    );
    console.log('evidence column type:', evidence.rows[0]?.data_type);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('SCHEMA APPLY FAILED:', (err && err.message) || err);
  process.exit(1);
});
