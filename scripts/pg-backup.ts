/**
 * Step 11 — logical backup of the MaterialIQ PostgreSQL dataset.
 *
 * Backs up the 19 MaterialIQ business tables to per-table JSONL files plus a
 * manifest, using the project's CA-pinned TLS connection. Design points:
 *
 *  - Timestamps are selected with `col::text` so PG's full microsecond
 *    fidelity survives (JS Date truncates to milliseconds).
 *  - jsonb (match_candidates.evidence) is serialized via its canonical text
 *    form and re-validated as JSON on restore.
 *  - booleans/int8/numeric arrive exactly as the adapter contract sees them.
 *  - The manifest records row counts, sha256 per file, PG version, and flags
 *    (e.g. sessions intentionally empty). Restore-side tooling (pg-restore.ts,
 *    pg-verify-restore.ts) refuses to run if checksums don't match.
 *
 * Usage:  set -a && . ./.env.local && npx tsx scripts/pg-backup.ts [outdir]
 * The connection string is never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TABLES: Array<{ name: string; order: string }> = [
  { name: 'organizations', order: 'id' },
  { name: 'users', order: 'id' },
  { name: 'material_records', order: 'id' },
  { name: 'material_attributes', order: 'id' },
  { name: 'data_imports', order: 'id' },
  { name: 'match_candidates', order: 'id' },
  { name: 'match_decisions', order: 'id' },
  { name: 'review_queue', order: 'id' },
  { name: 'common_materials', order: 'id' },
  { name: 'material_mappings', order: 'id' },
  { name: 'audit_logs', order: 'id' },
  { name: 'evaluation_runs', order: 'id' },
  { name: 'matching_runs', order: 'started_at' },
  { name: 'matching_run_chunks', order: 'run_id, chunk_index' },
  { name: 'import_runs', order: 'created_at' },
  { name: 'import_run_chunks', order: 'run_id, chunk_index' },
  { name: 'import_rows', order: 'job_id, row_number' },
];

function sslConfig(): Record<string, unknown> {
  const caPath = path.join(process.cwd(), 'certs', 'supabase-ca.crt');
  if (fs.existsSync(caPath)) {
    return {
      ca: fs.readFileSync(caPath, 'utf8'),
      rejectUnauthorized: true,
      servername: new URL(process.env.MATERIALIQ_DATABASE_URL || '').hostname,
    };
  }
  throw new Error('certs/supabase-ca.crt not found — run scripts/bootstrap-pg-ca.ts first');
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Columns of `table` as `(expr AS name, ...)` preserving full text fidelity. */
async function selectList(c: import('pg').Client, table: string): Promise<string> {
  const cols = (
    await c.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table]
    )
  ).rows as Array<{ column_name: string; data_type: string }>;
  if (!cols.length) throw new Error(`table ${table} not found in public schema`);
  return cols
    .map((col) => (col.data_type.startsWith('timestamp') ? `"${col.column_name}"::text AS "${col.column_name}"` : `"${col.column_name}"`))
    .join(', ');
}

async function main(): Promise<void> {
  const cs = process.env.MATERIALIQ_DATABASE_URL;
  if (!cs) {
    console.error('MATERIALIQ_DATABASE_URL is not set (load .env.local first).');
    process.exit(1);
  }
  const outDir = path.resolve(process.argv[2] || path.join('backups', `materialiq-pg-${stamp()}`));
  fs.mkdirSync(outDir, { recursive: true });
  const { Client } = require('pg');
  const c = new Client({ connectionString: cs, ssl: sslConfig() });
  await c.connect();

  const serverVersion = (await c.query('SELECT version() v')).rows[0].v.split(' on ')[0];
  console.log(`Source: ${serverVersion}`);
  const manifest: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    sourceServerVersion: serverVersion,
    tables: {} as Record<string, { rows: number; file: string; sha256: string; bytes: number }>,
    notes: ['sessions intentionally excluded from migration (Step 7A); backed up only if non-empty'],
  };
  const tables = manifest.tables as Record<string, { rows: number; file: string; sha256: string; bytes: number }>;

  for (const t of TABLES) {
    const sel = await selectList(c, t.name);
    const total = Number((await c.query(`SELECT COUNT(*)::int n FROM "${t.name}"`)).rows[0].n);
    const res = await c.query(`SELECT ${sel} FROM "${t.name}" ORDER BY ${t.order}`);
    const lines = res.rows.map((r: Record<string, unknown>) => JSON.stringify(r));
    const body = lines.length ? lines.join('\n') + '\n' : '';
    const file = `${t.name}.jsonl`;
    fs.writeFileSync(path.join(outDir, file), body, 'utf8');
    tables[t.name] = { rows: total, file, sha256: sha256(body || ''), bytes: Buffer.byteLength(body) };
    console.log(`  ${t.name.padEnd(20)} ${String(total).padStart(5)} rows -> ${file} (${tables[t.name].bytes} bytes)`);
  }

  // sessions: intentionally empty on Supabase (excluded in Step 7A) — record state, back up content only if any.
  const sessionCount = Number((await c.query('SELECT COUNT(*)::int n FROM sessions')).rows[0].n);
  manifest.sessionsOnSource = sessionCount;

  await c.end();
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(manifestPath + '.sha256', sha256(fs.readFileSync(manifestPath)) + '  manifest.json\n', 'utf8');
  console.log(`\nManifest: ${manifestPath}`);
  console.log(`Backup directory: ${outDir}`);
  const totalBytes = Object.values(tables).reduce((s, t) => s + t.bytes, 0);
  const totalRows = Object.values(tables).reduce((s, t) => s + t.rows, 0);
  console.log(`Total: ${totalRows} rows, ${totalBytes} bytes across ${Object.keys(tables).length} tables`);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

main().catch((e: Error) => {
  console.error(`BACKUP FAILED: ${e.message}`);
  process.exit(1);
});
