/**
 * PERF probe (SELECT-only): data-integrity snapshot vs the documented demo
 * baseline. `npx tsx scripts/check-integrity.mts`
 */
process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
if (!process.env.MATERIALIQ_DATABASE_URL) {
  console.error('Set MATERIALIQ_DATABASE_URL first (read it from .env.local).');
  process.exit(1);
}
import { getDb } from '../src/lib/db/client';
const db = getDb();
const one = (sql: string) => (db.prepare(sql).get() as Record<string, unknown>).n;
const q = (sql: string) => db.prepare(sql).all() as unknown as Array<Record<string, unknown>>;
const counts = [
  'material_records', 'match_candidates', 'review_queue', 'match_decisions',
  'common_materials', 'material_mappings', 'audit_logs', 'data_imports',
  'procurement_records', 'suppliers', 'users', 'organizations',
  'evaluation_runs', 'matching_runs', 'material_attributes',
] as const;
for (const t of counts) console.log(t, one(`SELECT COUNT(*) AS n FROM ${t}`));
console.log('open_queue', one(`SELECT COUNT(*) AS n FROM review_queue WHERE status = 'open'`));
console.log('resolved_queue', one(`SELECT COUNT(*) AS n FROM review_queue WHERE status != 'open'`));
console.log('latest audit:', JSON.stringify(q(`SELECT action, actor, created_at FROM audit_logs ORDER BY id DESC LIMIT 5`)));
console.log('latest material:', JSON.stringify(q(`SELECT original_code, organization_id, created_at FROM material_records ORDER BY id DESC LIMIT 3`)));
console.log('latest import:', JSON.stringify(q(`SELECT id, file_name, status, created_at FROM data_imports ORDER BY id DESC LIMIT 3`)));
console.log('eval latest:', JSON.stringify(q(`SELECT id, created_at FROM evaluation_runs ORDER BY id DESC LIMIT 2`)));
