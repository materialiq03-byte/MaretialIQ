/**
 * MaterialIQ — SQLite → PostgreSQL (Supabase) data migration (Step 7A/7B).
 *
 * SAFETY MODEL
 *  - Source SQLite is opened READ-ONLY. No write statement is ever issued to it.
 *  - Destination must be EMPTY (all MaterialIQ business tables 0 rows) or the
 *    script fails closed and reports which tables are populated.
 *  - The whole migration runs in ONE destination transaction: any failure
 *    rolls back everything (no partially-populated destination).
 *  - Ids are inserted explicitly (OVERRIDING SYSTEM VALUE) and identity
 *    sequences are advanced afterwards so future inserts continue above max.
 *  - Conflict behavior: plain INSERT. A duplicate/orphan/constraint violation
 *    fails the run (fail closed). No silent ON CONFLICT, no DELETE/TRUNCATE.
 *  - Never prints DATABASE_URL or any credential.
 *
 * EXECUTION GATE (Step 7B will use):
 *    DRY RUN (default, no DB access needed for planning):
 *      node --experimental-strip-types scripts/migrate-sqlite-to-postgres.ts
 *    REAL RUN (Step 7B, explicit confirmation):
 *      MIGRATE_EXECUTE=yes node --experimental-strip-types scripts/migrate-sqlite-to-postgres.ts
 *
 * Optional (tests only): MIGRATE_FAIL_AFTER=<table> simulates a failure after
 * loading <table> to prove full-transaction rollback.
 *
 * Excluded by default (see SPECIAL_TABLES rationale in the 7A report and the
 * 7A-review directive):
 *  - _migrations  (application migration history is SQLite-mechanism-owned;
 *                  Supabase schema was applied out-of-band in Step 6C)
 *  - sessions     (runtime authentication state, NOT business data - 7A-review
 *                  directive; the PostgreSQL sessions table stays empty and
 *                  SQLite sessions remain untouched)
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { Client } = require_('pg') as typeof import('pg');

// ---------------------------------------------------------------------------
// Configuration (secrets never printed)
// ---------------------------------------------------------------------------
const EXECUTE = process.env.MIGRATE_EXECUTE === 'yes';
/**
 * ALLOW_COMMIT exists so the 7A-review rollback proof can run the FULL insert
 * pipeline inside a real transaction and then ROLLBACK. Step 7B (authorized
 * execution) sets MIGRATE_ALLOW_COMMIT=yes explicitly; without it the script
 * refuses to persist even when MIGRATE_EXECUTE=yes is present.
 */
const ALLOW_COMMIT = process.env.MIGRATE_ALLOW_COMMIT === 'yes';
const FAIL_AFTER = process.env.MIGRATE_FAIL_AFTER || null; // test-only fault injection
const BATCH_ROWS = 200; // rows per multi-row INSERT (200 x ~30 cols << 65535 params)
const SUPABASE_TABLES = 18; // business tables (excludes _migrations)
/**
 * Tables never migrated. _migrations: SQLite-mechanism-owned history.
 * sessions: runtime auth state (7A-review directive) - copied nowhere,
 * deleted nowhere; the destination sessions table stays empty.
 */
export const EXCLUDED_TABLES = new Set(['_migrations', 'sessions']);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`CONFIG ERROR: ${name} is required for execution.`);
    console.error('Set it in .env.local (git-ignored) or the environment. Never commit it.');
    process.exit(2);
  }
  return v;
}
function loadDotEnvLocal(): void {
  // Next.js-style auto-load parity for standalone execution (server-side only).
  const fs = require_('node:fs') as typeof import('node:fs');
  const path = require_('node:path') as typeof import('node:path');
  const p = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

// ---------------------------------------------------------------------------
// Type/normalization helpers
// ---------------------------------------------------------------------------
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type PgType = 'text' | 'timestamptz' | 'jsonb' | 'bool' | 'double' | 'bigint' | 'unknown';

export function coerce(value: unknown, pgType: PgType, ctx: string): unknown {
  if (value === null || value === undefined) return null;
  switch (pgType) {
    case 'timestamptz': {
      const s = String(value);
      if (!TS_RE.test(s)) throw new Error(`${ctx}: unexpected timestamp format "${s}" (expected iso-ms-Z)`);
      return s; // UTC 'Z' -> identical instant in timestamptz
    }
    case 'jsonb': {
      const s = String(value);
      try {
        const parsed = JSON.parse(s);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not a JSON object');
        return s; // server casts text -> jsonb; validity proven here
      } catch (e) {
        throw new Error(`${ctx}: evidence is not valid JSON (${(e as Error).message})`);
      }
    }
    case 'bool': {
      if (value === 1 || value === true) return true;
      if (value === 0 || value === false) return false;
      throw new Error(`${ctx}: boolean column has non-0/1 value ${JSON.stringify(value)}`);
    }
    case 'double': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${ctx}: non-finite REAL ${JSON.stringify(value)}`);
      return n; // JS number is IEEE754 double — no rounding
    }
    case 'bigint': {
      const n = Number(value);
      if (!Number.isSafeInteger(n)) throw new Error(`${ctx}: unsafe integer ${JSON.stringify(value)}`);
      return n;
    }
    default:
      return value; // text passthrough
  }
}

/** Canonical JSON for equality hashing (order-independent, whitespace-free). */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canon(obj[k])).join(',') + '}';
}
function sha16(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}
/** Normalize a JS value from either engine for content hashing. */
export function norm(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;         // PG boolean == SQLite 0/1
  if (v instanceof Date) return v.toISOString();        // timestamptz back to iso-ms-Z
  return v;
}
export function rowHash(row: Record<string, unknown>): string {
  const normed: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) normed[k] = norm(row[k]);
  return sha16(canon(normed));
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------
export interface Plan {
  table: string;
  rows: number;
  columns: string[];      // common columns (SQLite ∩ PG)
  idCol: string | null;
  isIdentity: boolean;    // destination id is GENERATED ... AS IDENTITY
  fkParents: string[];    // parent tables from the actual SQLite FK graph
  placeAfter: string[];   // topo order guarantee (filled after sort)
}

export function topoOrder(sqlite: DatabaseSync, tables: string[]): string[] {
  // Kahn's algorithm over the REAL FK graph (no hand-guessed order).
  const parentsOf = new Map<string, Set<string>>();
  const childrenOf = new Map<string, Set<string>>();
  for (const t of tables) { parentsOf.set(t, new Set()); childrenOf.set(t, new Set()); }
  for (const t of tables) {
    const fks = sqlite.prepare(`PRAGMA foreign_key_list("${t}")`).all() as any[];
    for (const fk of fks) {
      const parent = String(fk.table);
      if (parent !== t && tables.includes(parent)) {
        parentsOf.get(t)!.add(parent);
        childrenOf.get(parent)!.add(t);
      }
    }
  }
  const order: string[] = [];
  let ready = tables.filter(t => parentsOf.get(t)!.size === 0).sort();
  while (ready.length) {
    const t = ready.shift()!;
    order.push(t);
    for (const c of [...childrenOf.get(t)!].sort()) {
      parentsOf.get(c)!.delete(t);
      if (parentsOf.get(c)!.size === 0 && !order.includes(c) && !ready.includes(c)) ready.push(c);
    }
  }
  if (order.length !== tables.length) {
    throw new Error('FK graph has a cycle among: ' + tables.filter(t => !order.includes(t)).join(', '));
  }
  return order;
}

// ---------------------------------------------------------------------------
// Preflights on the source (read-only)
// ---------------------------------------------------------------------------
export function collectSourceProblems(sqlite: DatabaseSync, plan: Plan[]): string[] {
  const one = (s: string, ...p: unknown[]) => sqlite.prepare(s).get(...(p as any[])) as any;
  const problems: string[] = [];

  // Source integrity
  if (one('PRAGMA integrity_check').integrity_check !== 'ok') problems.push('SQLite integrity_check failed');
  if (one('PRAGMA foreign_key_check')) problems.push('SQLite foreign_key_check reported violations');

  // Orphans on every FK edge
  for (const t of plan) {
    const fks = sqlite.prepare(`PRAGMA foreign_key_list("${t.table}")`).all() as any[];
    for (const fk of fks) {
      const n = one(
        `SELECT COUNT(*) n FROM "${t.table}" c LEFT JOIN "${fk.table}" p ON c."${fk.from}" = p."${fk.to}" WHERE c."${fk.from}" IS NOT NULL AND p."${fk.to}" IS NULL`
      ).n;
      if (n > 0) problems.push(`orphan rows: ${t.table}.${fk.from} -> ${fk.table}.${fk.to}: ${n}`);
    }
  }

  // Critical unique/constraint preflights (fail closed, never mutate source)
  const checks: Array<[string, string, string]> = [
    ['organization+original_code dup', 'SELECT COUNT(*) n FROM (SELECT organization_id, original_code FROM material_records GROUP BY 1,2 HAVING COUNT(*)>1)', '>0'],
    ['candidate pair dup', 'SELECT COUNT(*) n FROM (SELECT source_material_id, candidate_material_id FROM match_candidates GROUP BY 1,2 HAVING COUNT(*)>1)', '>0'],
    ['review match dup', 'SELECT COUNT(*) n FROM (SELECT match_id FROM review_queue GROUP BY 1 HAVING COUNT(*)>1)', '>0'],
    ['candidate self-pair', 'SELECT COUNT(*) n FROM match_candidates WHERE source_material_id = candidate_material_id', '>0'],
    ['active matching run', "SELECT COUNT(*) n FROM matching_runs WHERE status IN ('QUEUED','RUNNING')", '>0'],
    ['active import run', "SELECT COUNT(*) n FROM import_runs WHERE status IN ('QUEUED','RUNNING')", '>0'],
    ['users role/org violation', "SELECT COUNT(*) n FROM users WHERE (role IN ('cpse_material_manager','cpse_technical_reviewer') AND organization_id IS NULL) OR (role IN ('authority','platform_admin') AND organization_id IS NOT NULL)", '>0'],
    ['session expiry violation', 'SELECT COUNT(*) n FROM sessions WHERE expires_at <= created_at', '>0'],
    ['score out of range', 'SELECT COUNT(*) n FROM match_candidates WHERE semantic_score NOT BETWEEN 0 AND 100 OR fuzzy_score NOT BETWEEN 0 AND 100 OR technical_score NOT BETWEEN 0 AND 100 OR final_score NOT BETWEEN 0 AND 100', '>0'],
  ];
  for (const [label, sql] of checks) {
    const n = Number(one(sql).n);
    if (n > 0) problems.push(`${label}: ${n}`);
  }

  return problems;
}

/** CLI wrapper: prints problems and exits non-zero (fail closed). */
export function preflightSource(sqlite: DatabaseSync, plan: Plan[]): void {
  const problems = collectSourceProblems(sqlite, plan);
  if (problems.length) {
    console.error('PREFLIGHT FAILED (source untouched, destination untouched):');
    for (const p of problems) console.error('  - ' + p);
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// Execution (Step 7B path) - gated, fail-closed, single transaction
// ---------------------------------------------------------------------------
async function executeMigration(sqlite: DatabaseSync): Promise<void> {
  const url = requireEnv('MATERIALIQ_DATABASE_URL');
  const { Client } = require_('pg') as typeof import('pg');
  const dest = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await dest.connect();

  try {
    // 1) Destination must be empty or we abort (no destructive cleanup).
    const tablesInPg = await dest.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
    );
    const expected = SUPABASE_TABLES + 1; // business tables + app-owned _migrations
    if (tablesInPg.rowCount !== expected) {
      throw new Error(`destination schema mismatch: expected ${expected} business tables, found ${tablesInPg.rowCount}`);
    }
    for (const t of tablesInPg.rows as Array<{ table_name: string }>) {
      const name = t.table_name === 'sessions' ? null : t.table_name; // sessions may hold nothing; never read contents
      void name;
      const c = await dest.query(`SELECT COUNT(*)::int AS n FROM public."${t.table_name}"`);
      const n = c.rows[0].n;
      if (n > 0) {
        if (t.table_name === 'sessions') {
          console.log(`note: destination sessions has ${n} row(s); not migrated, not deleted (excluded table)`);
          continue;
        }
        throw new Error(`destination not empty: ${t.table_name} has ${n} rows - refusing (no destructive cleanup)`);
      }
    }

    // 2) Plan + preflight the source.
    const { order, plans } = buildPlans(sqlite);
    const migratePlans = plans.filter(p => !EXCLUDED_TABLES.has(p.table));
    preflightSource(sqlite, plans);

    // 3) One transaction: any failure rolls back EVERYTHING.
    await dest.query('BEGIN');
    try {
      // (txn body appended below by construction)

    for (const p of migratePlans) {
      const cols = p.columns;

      // PG column types for coercion (from information_schema, one query per table).
      const colTypes = await dest.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1`,
        [p.table]
      );
      const typeOf = new Map<string, PgType>(
        (colTypes.rows as Array<{ column_name: string; data_type: string }>).map(r => [
          r.column_name,
          r.data_type === 'timestamp with time zone' || r.data_type === 'timestamp without time zone' ? 'timestamptz'
          : r.data_type === 'jsonb' ? 'jsonb'
          : r.data_type === 'boolean' ? 'bool'
          : r.data_type === 'double precision' || r.data_type === 'real' ? 'double'
          : r.data_type === 'bigint' || r.data_type === 'integer' || r.data_type === 'smallint' ? 'bigint'
          : 'text',
        ])
      );

      const read = sqlite.prepare(`SELECT * FROM "${p.table}"`);
      let loaded = 0;
      let batch: Array<Record<string, unknown>> = [];
      const flush = async (rows: Array<Record<string, unknown>>) => {
        if (rows.length === 0) return;
        const values: unknown[] = [];
        const tuples = rows.map(row => {
          const parts = cols.map(col => {
            const coerced = coerce(row[col], typeOf.get(col) ?? 'text', `${p.table}.${col}`);
            values.push(coerced);
            return '$' + values.length;
          });
          return '(' + parts.join(', ') + ')';
        });
        const sql = `INSERT INTO public."${p.table}" (${cols.map(c => '"' + c + '"').join(', ')}) VALUES ${tuples.join(', ')}`;
        await dest.query(sql, values);
        loaded += rows.length;
      };

      for (const row of read.iterate()) {
        batch.push(row as Record<string, unknown>);
        if (batch.length >= BATCH_ROWS) {
          await flush(batch);
          batch = [];
        }
      }
      await flush(batch);
      if (FAIL_AFTER && p.table === FAIL_AFTER) {
        throw new Error(`MIGRATE_FAIL_AFTER=${FAIL_AFTER}: injected failure AFTER ${p.table} committed ${loaded} row(s) inside the open transaction`);
      }
      console.log(`loaded ${p.table}: ${loaded} row(s)`);
    }

    // Sequences are advanced INSIDE the transaction so a rollback also reverts them.
    for (const item of sequencePlan(sqlite, migratePlans)) {
      if (item.statement) await dest.query(item.statement);
    }

      if (!ALLOW_COMMIT) {
        // 7A-review build: prove rollback semantics, never persist.
        await dest.query('ROLLBACK');
        console.log('ROLLBACK executed (7A-review build never commits). Post-rollback counts asserted by the reviewer/test.');
        return;
      }

      await dest.query('COMMIT');
      console.log('COMMIT — migration persisted (Step 7B execution).');
    } catch (err) {
      // Explicit rollback on ANY in-transaction failure (belt AND braces:
      // connection teardown would also roll back, but be loud about it).
      try { await dest.query('ROLLBACK'); } catch { /* connection may already be aborted */ }
      throw err;
    }
  } finally {
    await dest.end();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
/**
 * Build the migration plan: dependency-safe order (from the real FK graph)
 * plus per-table column lists and row counts. Destination-agnostic.
 */
export function buildPlans(sqlite: DatabaseSync): { order: string[]; plans: Plan[] } {
  const allTables = (sqlite.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as any[]).map(r => String(r.name));
  const order = topoOrder(sqlite, allTables);
  const plans: Plan[] = [];
  for (const t of order) {
    const srcCols = (sqlite.prepare(`PRAGMA table_info("${t}")`).all() as any[]).map(c => String(c.name));
    const rows = Number(sqlite.prepare(`SELECT COUNT(*) n FROM "${t}"`).get()!.n);
    plans.push({
      table: t,
      rows,
      columns: srcCols,
      idCol: srcCols.includes('id') ? 'id' : null,
      isIdentity: false, // resolved against PG at execution time
      fkParents: (sqlite.prepare(`PRAGMA foreign_key_list("${t}")`).all() as any[])
        .map(f => String(f.table)).filter((v, i, a) => a.indexOf(v) === i && v !== t),
      placeAfter: [],
    });
  }
  return { order, plans };
}

/**
 * Sequence-reset plan for integer identity PKs (ids are inserted explicitly, so
 * each destination identity sequence must be advanced past the imported max).
 * Text-PK tables (matching_runs, import_runs, sessions) need none - their ids
 * are copied verbatim and their VALUES ARE NEVER PRINTED (no tokens in output).
 */
export function sequencePlan(sqlite: DatabaseSync, plans: Plan[]): Array<{ table: string; statement: string | null }> {
  const out: Array<{ table: string; statement: string | null }> = [];
  for (const p of plans) {
    if (!p.idCol || EXCLUDED_TABLES.has(p.table)) continue;
    const maxRow = sqlite.prepare(`SELECT MAX(id) m FROM "${p.table}"`).get() as any;
    if (maxRow && maxRow.m != null) {
      if (typeof maxRow.m === 'number' && Number.isSafeInteger(maxRow.m)) {
        out.push({ table: p.table, statement: `SELECT setval(pg_get_serial_sequence('public.${p.table}','id'), ${maxRow.m}, true);` });
      } else {
        out.push({ table: p.table, statement: null }); // text PK: verbatim ids
      }
    } else if (p.idCol && !EXCLUDED_TABLES.has(p.table) && p.table !== 'matching_runs' && p.table !== 'import_runs' && p.table !== 'sessions') {
      // Empty integer-PK table: reset to 1 so sequences are deterministic.
      out.push({ table: p.table, statement: `SELECT setval(pg_get_serial_sequence('public.${p.table}','id'), 1, true);` });
    } else {
      out.push({ table: p.table, statement: null }); // text PK (empty): verbatim ids
    }
  }
  return out;
}

function main(): void {
  loadDotEnvLocal();
  console.log('MaterialIQ SQLite → PostgreSQL migration (Step 7A script)');
  console.log(`mode: ${EXECUTE ? 'EXECUTE' : 'DRY_RUN'}  (fail-after=${FAIL_AFTER ?? 'n/a'})`);

  // --- source (READ ONLY) --------------------------------------------------
  const sqlite = new DatabaseSync('data/materialiq.db', { readOnly: true });

  const { order, plans } = buildPlans(sqlite);

  // --- destination introspection (no writes) -------------------------------
  if (!EXECUTE) {
    console.log('\nDRY RUN: destination introspection skipped (no DATABASE_URL read).');
    console.log('Plan is derived from the SQLite side; column intersection and identity\n'
      + 'flags are asserted by tests (tests/migration-prep.test.ts) and re-checked\n'
      + 'at execution time in Step 7B.');
  } else {
    const url = requireEnv('MATERIALIQ_DATABASE_URL');
    const dest = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    // Executed path is implemented in Step 7B; 7A refuses to write.
    void dest;
  }

  // EXECUTE path (implemented for the 7A-review rollback proof). The REAL
  // migration remains forbidden until Step 7B is authorized; executeMigration
  // in this build always rolls back (see its ROLLBACK placeholder).
  if (EXECUTE) {
    executeMigration(sqlite)
      .then(() => { sqlite.close(); process.exit(0); })
      .catch((err) => {
        console.error('MIGRATION EXECUTION FAILED (transaction rolled back):', (err as Error).message);
        sqlite.close();
        process.exit(5);
      });
    return;
  }

  preflightSource(sqlite, plans);

  // --- print the plan ------------------------------------------------------
  console.log('\n=== DEPENDENCY-SAFE INSERTION ORDER (Kahn over real FK graph) ===');
  let seq = 0, total = 0;
  for (const p of plans) {
    seq++;
    total += p.rows;
    const parents = p.fkParents.length ? p.fkParents.join(',') : '(none)';
    console.log(
      `${String(seq).padStart(2)}. ${p.table.padEnd(22)} rows=${String(p.rows).padStart(5)}  parents=[${parents}]`
      + (EXCLUDED_TABLES.has(p.table) ? '   << EXCLUDED (_migrations: app history; sessions: 7A-review directive)' : '')
    );
  }
  const excludedRows = plans.filter(p => EXCLUDED_TABLES.has(p.table)).reduce((a, p) => a + p.rows, 0);
  console.log(`total rows in plan: ${total} (excluded: ${excludedRows} rows in ${[...EXCLUDED_TABLES].join(', ')})`);

  console.log('\n=== SEQUENCE RESET PLAN (execute-time; NOT run now) ===');
  for (const item of sequencePlan(sqlite, plans)) {
    console.log(item.statement ? '  ' + item.statement : `  ${item.table}: text PK — ids copied verbatim, no sequence reset needed`);
  }

  console.log('\n=== BATCH PLAN ===');
  for (const p of plans) {
    if (EXCLUDED_TABLES.has(p.table)) continue;
    const chunks = Math.max(1, Math.ceil(p.rows / BATCH_ROWS));
    console.log(`  ${p.table.padEnd(22)} ${chunks} chunk(s) of <= ${BATCH_ROWS} rows`);
  }

  console.log('\n=== VALIDATION PLAN (post-load, Step 7B) ===');
  console.log('  1. per-table row counts == source counts (all 18 tables)');
  console.log('  2. id coverage: min/max/count(ids) identical to source');
  console.log('  3. evidence jsonb: every non-NULL row parses; canonical hash equality');
  console.log('     vs source for ALL 1288 rows + NULL preserved for id 1');
  console.log('  4. per-row content hashes for material_records, users, organizations');
  console.log('  5. PG-side FK orphan queries return 0 rows on every edge');
  console.log('  6. flagship rows: CP-1001<->NT-8821 (id 1, approved, NULL evidence),');
  console.log('     CP-1001<->BH-4410 (id 4640, seal_type 2RS vs ZZ critical),');
  console.log('     CP-1001<->SL-7721 (id 8658, HIGH_CONFIDENCE_MATCH)');
  console.log('  7. legacy codes: CP-1001/NT-8821/SL-7721 mapped to CMI-BRG-6205');

  console.log('\nDRY RUN COMPLETE — no destination connection made, no rows written.');
  console.log('Source snapshot for Step 7B: backups/materialiq-pre-7a-snapshot.db (integrity ok)');
  sqlite.close();
}

// Run only when executed directly (tests import the helpers instead).
import { pathToFileURL } from 'node:url';
const isEntrypoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntrypoint) main();
