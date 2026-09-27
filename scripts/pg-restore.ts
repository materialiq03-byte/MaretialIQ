/**
 * Step 11 §E — restore a MaterialIQ pg backup directory into a FRESH,
 * ISOLATED PostgreSQL database. NEVER points at production: the target is
 * the local PostgresTestAdapter (isolated container). Applies the reviewed
 * v11 schema from supabase/migrations, loads every backup table in
 * dependency order, then resets identity sequences above imported maxima.
 *
 * Usage: npx tsx scripts/pg-restore.ts <backupDir>
 * Reads test PG config from environment:
 *   MATERIALIQ_TEST_PG_HOST/PORT/USER/PASSWORD/DATABASE (no secrets printed)
 */
import fs from 'node:fs';
import path from 'node:path';

const ORDER = [
  'organizations',
  'users',
  'data_imports', // material_records.import_id REFERENCES data_imports(id)
  'material_records',
  'material_attributes',
  'match_candidates',
  'match_decisions',
  'review_queue',
  'common_materials',
  'material_mappings',
  'audit_logs',
  'evaluation_runs',
  'matching_runs',
  'matching_run_chunks',
  'import_runs',
  'import_run_chunks',
  'import_rows',
];

async function main(): Promise<void> {
  const dir = path.resolve(process.argv[2] || '');
  if (!dir || !fs.existsSync(path.join(dir, 'manifest.json'))) {
    console.error('usage: npx tsx scripts/pg-restore.ts <backupDir>');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const tables = manifest.tables as Record<string, { rows: number; file: string; sha256: string }>;
  const missing = ORDER.filter((t) => !tables[t]);
  if (missing.length) {
    console.error(`backup missing tables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const { Client } = require('pg');
  const client = new Client({
    host: process.env.MATERIALIQ_TEST_PG_HOST || '127.0.0.1',
    port: Number(process.env.MATERIALIQ_TEST_PG_PORT || 54329),
    user: process.env.MATERIALIQ_TEST_PG_USER || 'postgres',
    password: process.env.MATERIALIQ_TEST_PG_PASSWORD || 'postgres',
    database: process.env.MATERIALIQ_TEST_PG_DATABASE || 'materialiq_restore_test',
  });
  await client.connect();

  const targetVersion = (await client.query('SELECT version() v')).rows[0].v.split(' on ')[0];
  console.log(`Restore target: ${targetVersion} (isolated local instance)`);
  console.log(`Backup source:  ${manifest.sourceServerVersion}`);

  // Safety: the target must be an empty MaterialIQ database.
  const existing = await client.query(
    `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'`
  );
  if (existing.rows[0].n > 0) {
    console.error(`REFUSING: target public schema has ${existing.rows[0].n} tables — must be empty.`);
    await client.end();
    process.exit(1);
  }

  // 1. Schema
  const schemaSql = fs.readFileSync('supabase/migrations/20260920120000_materialiq_v11_schema.sql', 'utf8');
  await client.query(schemaSql);
  console.log('Schema applied (materialiq v11).');

  // 2. Data in dependency order, inside one transaction
  await client.query('BEGIN');
  try {
    for (const t of ORDER) {
      const body = fs.readFileSync(path.join(dir, tables[t].file), 'utf8');
      if (!body) {
        console.log(`  ${t.padEnd(20)} 0 rows (empty)`);
        continue;
      }
      const lines = body.split('\n').filter((l) => l.length > 0);
      const cols = Object.keys(JSON.parse(lines[0]));
      const colList = cols.map((c) => `"${c}"`).join(', ');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      // jsonb columns must be cast explicitly; everything else infers from text params
      const jsonbCols = new Set(
        (
          await client.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema='public' AND table_name=$1 AND data_type IN ('jsonb','json')`,
            [t]
          )
        ).rows.map((r: { column_name: string }) => r.column_name)
      );
      let inserted = 0;
      for (const line of lines) {
        const row = JSON.parse(line);
        const vals = cols.map((c) => {
          const v = row[c];
          if (jsonbCols.has(c) && v != null && typeof v !== 'string') return JSON.stringify(v);
          return v;
        });
        await client.query(
          `INSERT INTO "${t}" (${colList}) VALUES (${placeholders})`,
          vals
        );
        inserted++;
      }
      console.log(`  ${t.padEnd(20)} ${String(inserted).padStart(5)} rows`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  // 3. Sequence reset above imported maxima
  const seqTables = ['organizations', 'users', 'material_records', 'material_attributes', 'match_candidates', 'match_decisions', 'review_queue', 'common_materials', 'material_mappings', 'audit_logs', 'evaluation_runs'];
  for (const t of seqTables) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), COALESCE((SELECT MAX(id) FROM "${t}"), 1))`
    );
  }
  console.log('Identity sequences reset above imported maxima.');
  await client.end();
  console.log('RESTORE COMPLETE');
}

main().catch((e: Error) => {
  console.error(`RESTORE FAILED: ${e.message}`);
  process.exit(1);
});
