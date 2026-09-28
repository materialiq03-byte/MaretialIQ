/**
 * Gate ② — Supabase pre-migration backup (READ-ONLY against the database).
 *
 * pg_dump is not installed on this machine, so this produces an equivalent
 * COMPLETE LOGICAL BACKUP with pure Node + the project's own pg driver:
 *   - schema: verbatim column defs (information_schema), constraints
 *     (pg_get_constraintdef), indexes (pg_indexes) and identity resets
 *   - data: every row of every public table as idempotent INSERTs
 *   - restore: psql -f <file> (drop schema public cascade; create schema public; then the dump)
 *
 * Nothing in the database is modified: the connection issues SELECT-only
 * statements (plus SET/search_path session state). TLS is CA-pinned with the
 * project's certs/supabase-ca.crt, exactly like the app's default policy.
 * Credentials come from .env.local and are never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { orderTablesByDependency, renderColumnDef } from './backup-ordering.mjs';

const ROOT = 'C:/dev/MaterialIQ';
const OUT_DIR = path.join(ROOT, '.freebuff', 'backups');
fs.mkdirSync(OUT_DIR, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SQL_PATH = path.join(OUT_DIR, `supabase-pre-v19-${STAMP}.sql`);
const JSON_PATH = path.join(OUT_DIR, `supabase-tables-${STAMP}.json`);

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
if (!env.MATERIALIQ_DATABASE_URL) {
  console.error('FATAL: MATERIALIQ_DATABASE_URL not found in .env.local');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: env.MATERIALIQ_DATABASE_URL,
  ssl: { ca: fs.readFileSync(path.join(ROOT, 'certs', 'supabase-ca.crt'), 'utf8'), rejectUnauthorized: true },
});
await client.connect();

const q = async (sql, params) => (await client.query(sql, params)).rows;

const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const ident = (s) => `"${s.replace(/"/g, '""')}"`;

const tableRows = await q(`
  SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY c.relname`);
const tables = tableRows.map((r) => r.name);
console.log(`tables: ${tables.length} -> ${tables.join(', ')}`);

// Gate 3.5 fix 1: FK-dependency ordering. Referenced tables MUST be emitted
// before their referencers or `psql -v ON_ERROR_STOP=1` fails (the original
// alphabetical order produced 3,469 "relation does not exist" errors).
const fkEdges = await q(`
  SELECT conrelid::regclass::text AS src, confrelid::regclass::text AS tgt
    FROM pg_constraint
   WHERE contype = 'f' AND connamespace = 'public'::regnamespace`);
const strip = (s) => s.replace(/^public\./, '');
const refsByTable = new Map(tables.map((t) => [t, []]));
const externalRefs = new Set();
for (const e of fkEdges) {
  const src = strip(e.src);
  const tgt = strip(e.tgt);
  if (!refsByTable.has(src)) continue; // not a backed-up table (should not happen)
  if (tgt === src) continue; // self-reference is harmless
  if (refsByTable.has(tgt)) refsByTable.get(src).push(tgt);
  else externalRefs.add(`${src} -> ${tgt}`);
}
const { order, cycles } = orderTablesByDependency(tables.map((t) => ({ name: t, references: refsByTable.get(t) })));
if (externalRefs.size) console.log(`external FK targets (not in backup set): ${[...externalRefs].join(', ')}`);
if (cycles.length) {
  console.error(`FATAL: FK dependency cycle(s) detected - no safe section order exists: ${cycles.map((c) => c.join(' <-> ')).join('; ')}`);
  console.error('Refusing to emit a backup that cannot restore with ON_ERROR_STOP=1. Nothing written.');
  await client.end();
  process.exit(2);
}
console.log(`FK-dependency order: ${order.join(' -> ')}`);
const orderedTables = order;

const lines = [];
lines.push(`-- ============================================================`);
lines.push(`-- MaterialIQ Supabase pre-migration backup (pre-v12..v19 state)`);
lines.push(`-- Generated: ${new Date().toISOString()}`);
lines.push(`-- Tables: ${orderedTables.length} | Generated with Node pg (pg_dump unavailable on host)`);
lines.push(`-- Section order: FK-dependency topological (referenced tables first) - restores with psql -v ON_ERROR_STOP=1`);
lines.push(`-- Restore: drop schema public cascade; create schema public; grant...; then psql -f this file`);
lines.push(`-- ============================================================`);
lines.push(`SET search_path = public;`);

const jsonSnap = { generatedAt: new Date().toISOString(), note: 'read-only snapshot before v12-v19 migration (FK-ordered sections, identity-preserving DDL)', tables: {} };
const manifest = [];

for (const t of orderedTables) {
  // Column definitions in ordinal order (verbatim types/defaults/nullability).
  // Gate 3.5 fix 2: identity columns are carried by is_identity/identity_generation
  // (their column_default is NULL), so the old renderer silently emitted them as
  // plain NOT NULL bigint and restored databases lost every identity sequence.
  const cols = await q(
    `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale, is_identity, identity_generation
       FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]);
  const colDefs = cols.map((c) => renderColumnDef(c, 'preserve'));
  // Constraints (verbatim).
  const cons = await q(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('p','u','f','c') ORDER BY conname`, [`public.${t}`]);
  const conLines = cons.map((c) => `  CONSTRAINT ${ident(c.conname)} ${c.def}`);
  lines.push(``);
  lines.push(`-- ---------- ${t} ----------`);
  lines.push(`CREATE TABLE IF NOT EXISTS ${ident(t)} (`);
  lines.push([...colDefs, ...conLines].join(`,\n`));
  lines.push(`);`);
  // Indexes (verbatim, minus the ones PG auto-creates for p/unique constraints).
  const idx = await q(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='${t.replace(/'/g, "''")}'
        AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE conrelid='public.${t.replace(/'/g, "''")}'::regclass)`);
  for (const i of idx) lines.push(`${i.indexdef};`);

  // Data.
  const pkCols = (await q(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'public.${t.replace(/'/g, "''")}'::regclass AND i.indisprimary ORDER BY a.attnum`)).map((r) => r.attname);
  const rows = await q(`SELECT * FROM ${ident(t)}`);
  lines.push(``);
  for (const row of rows) {
    const names = Object.keys(row).map(ident).join(', ');
    const vals = Object.values(row).map(lit).join(', ');
    const conflict = pkCols.length ? ` ON CONFLICT (${pkCols.map(ident).join(', ')}) DO NOTHING` : '';
    lines.push(`INSERT INTO ${ident(t)} (${names}) VALUES (${vals})${conflict};`);
  }
  // Identity sequence reset so future inserts continue after the max id.
  const identCols = await q(
    `SELECT a.attname FROM pg_attribute a
      WHERE a.attrelid='public.${t.replace(/'/g, "''")}'::regclass AND a.attidentity IN ('a','d')`);
  for (const ic of identCols) {
    lines.push(`SELECT setval(pg_get_serial_sequence('${t}', '${ic.attname}'), COALESCE((SELECT MAX(${ident(ic.attname)}) FROM ${ident(t)}), 0) + 1, false);`);
  }
  jsonSnap.tables[t] = { rowCount: rows.length, rows };
  manifest.push({ table: t, rows: rows.length });
  console.log(`  ${t}: ${rows.length} rows`);
}

await client.end();

fs.writeFileSync(SQL_PATH, lines.join('\n') + '\n', 'utf8');
fs.writeFileSync(JSON_PATH, JSON.stringify(jsonSnap), 'utf8');

const sqlSize = fs.statSync(SQL_PATH).size;
const jsonSize = fs.statSync(JSON_PATH).size;
console.log(`\nSQL backup : ${SQL_PATH} (${(sqlSize / 1024).toFixed(1)} KiB, ${lines.length} lines)`);
console.log(`JSON snapshot: ${JSON_PATH} (${(jsonSize / 1024).toFixed(1)} KiB)`);
console.log(`tables backed up: ${manifest.length}; total rows: ${manifest.reduce((a, m) => a + m.rows, 0)}`);
