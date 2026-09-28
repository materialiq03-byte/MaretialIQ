/**
 * Option A gate ④ runner — apply v12→v19 schema + frozen-demo data to PostgreSQL.
 *
 * DESIGN: this runner is side-effect-free on import. It never connects unless an
 * explicit mode asks it to, and the write mode is triple-gated:
 *
 *   node scripts/migration/apply-pg-v12-v19.mjs --plan
 *       Default. ZERO network connections. Prints migration order, per-version
 *       statement counts, authoritative manifest, and data-source counts read
 *       from the frozen SQLite demo (opened READ ONLY).
 *
 *   node scripts/migration/apply-pg-v12-v19.mjs --preflight
 *       SELECT-only against PostgreSQL (every query is a SELECT). Refuses to
 *       run unless MATERIALIQ_RUN_PG_MIGRATION_PREFLIGHT=true. Any check
 *       failure aborts with a full report.
 *
 *   node scripts/migration/apply-pg-v12-v19.mjs --apply --i-understand-gate-4
 *       WRITE mode. Requires ALL of:
 *         - MATERIALIQ_APPLY_PG_MIGRATION=true      (env authorization)
 *         - --i-understand-gate-4                    (explicit CLI consent)
 *         - an interactive TTY                       (no accidental CI runs)
 *       Sequence: preflight (all-or-abort) -> v12..v19 one transaction each
 *       (DDL + _migrations marker) -> data step in one transaction (idempotent
 *       ON CONFLICT DO NOTHING) -> identity setvals -> verification report.
 *       A rerun of the whole runner is a no-op (idempotent by construction).
 *
 * Source data comes exclusively from the frozen demo SQLite, opened READ ONLY.
 * Credentials come from .env.local (MATERIALIQ_DATABASE_URL) and are never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url); // node:sqlite via CJS-style require in ESM
import {
  MIGRATION_SEQUENCE,
  MIGRATION_NAMES,
  buildSchemaStatements,
  MANIFEST,
  MANIFEST_DATA_STEP_TOTAL,
  MANIFEST_GRAND_TOTAL,
  BASELINE,
  buildInsertStatements,
  buildPreflightChecks,
  buildDataPhasePreflightChecks,
  buildStructuralVerificationChecks,
  buildVerificationQueries,
} from './pg-v12-v19-core.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const SQLITE_PATH = path.join(ROOT, '.freebuff', 'step26-demo-data', 'materialiq.db');
const CA_PATH = path.join(ROOT, 'certs', 'supabase-ca.crt');

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no I/O)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = new Set(argv);
  const mode = args.has('--apply') ? 'apply' : args.has('--verify') ? 'verify' : args.has('--preflight') ? 'preflight' : 'plan';
  return {
    mode,
    dataOnly: args.has('--data-only'),
    gate4Consent: args.has('--i-understand-gate-4'),
    verbose: args.has('--verbose'),
  };
}

/** Refuse write mode unless every Gate ④ authorization is present. */
export function assertApplyAllowed({ mode, gate4Consent }, env = process.env, interactive = process.stdin.isTTY === true) {
  if (mode !== 'apply') return;
  const problems = [];
  if (env.MATERIALIQ_APPLY_PG_MIGRATION !== 'true') problems.push('MATERIALIQ_APPLY_PG_MIGRATION=true is not set');
  if (!gate4Consent) problems.push('--i-understand-gate-4 was not passed');
  if (!interactive) problems.push('no interactive TTY (refusing non-interactive/CI execution)');
  if (problems.length) {
    throw new Error(`GATE 4 REFUSED — write mode requires explicit authorization:\n  - ${problems.join('\n  - ')}`);
  }
}

function loadEnvLocal() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.MATERIALIQ_DATABASE_URL) throw new Error('MATERIALIQ_DATABASE_URL not found in .env.local');
  return env;
}

async function connectPg() {
  const { default: pg } = await import('pg');
  const env = loadEnvLocal();
  const client = new pg.Client({
    connectionString: env.MATERIALIQ_DATABASE_URL,
    ssl: { ca: fs.readFileSync(CA_PATH, 'utf8'), rejectUnauthorized: true },
  });
  await client.connect();
  return client;
}

/** Open the frozen demo SQLite READ ONLY (immutable values; never written). */
function openSqliteReadOnly() {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(SQLITE_PATH, { readOnly: true, enableForeignKeyConstraints: false });
}

function printPlan() {
  const versions = buildSchemaStatements(12, 19);
  console.log('MIGRATION ORDER (per-version transaction, marker after each):');
  for (const v of versions) {
    console.log(`  v${String(v.version).padStart(2)} ${MIGRATION_NAMES[v.version].padEnd(38)} ${v.statements.length} statement(s)`);
  }
  console.log(`\nMANIFEST (authoritative, frozen SQLite source — nothing invented):`);
  for (const [table, n] of Object.entries(MANIFEST)) console.log(`  ${table.padEnd(26)} ${String(n).padStart(4)}`);
  console.log(`  ${'-'.repeat(32)}`);
  console.log(`  data-step total ${MANIFEST_DATA_STEP_TOTAL} (+ ${MANIFEST.uom_conversion_rules} v16 seed applied by the schema step) = grand total ${MANIFEST_GRAND_TOTAL}`);
  console.log(`\nBASELINE preflight targets: materials ${BASELINE.material_records} · candidates ${BASELINE.match_candidates} · queue ${BASELINE.review_queue_open} open / ${BASELINE.review_queue_resolved} resolved · audit max id ${BASELINE.audit_logs_max_id_pre} · imports ${BASELINE.data_imports_pre}`);
  console.log(`\nSource SQLite (READ ONLY): ${SQLITE_PATH}`);
  if (!fs.existsSync(SQLITE_PATH)) throw new Error(`frozen demo SQLite not found at ${SQLITE_PATH}`);
  const { statements, counts } = buildInsertStatements(openSqliteReadOnly());
  console.log(`Data step would generate ${statements.length} statements. Live source counts vs manifest:`);
  let drift = 0;
  for (const [table, n] of Object.entries(counts)) {
    const expected = MANIFEST[table];
    const ok = n === expected;
    if (!ok) drift++;
    console.log(`  ${ok ? 'ok ' : 'DRIFT'} ${table.padEnd(26)} source ${String(n).padStart(4)} / manifest ${String(expected).padStart(4)}`);
  }
  if (drift) throw new Error(`${drift} table(s) drifted from the manifest — refusing (see above)`);
  console.log('\nPLAN OK — no connections made, nothing written. Gate ④ authorizes --apply.');
}

/** SELECT-only preflight against PostgreSQL. Never issues a write. */
async function runPreflight(checks = buildPreflightChecks()) {
  if (process.env.MATERIALIQ_RUN_PG_MIGRATION_PREFLIGHT !== 'true') {
    throw new Error('refusing to connect: set MATERIALIQ_RUN_PG_MIGRATION_PREFLIGHT=true to run the SELECT-only preflight');
  }
  const client = await connectPg();
  try {
    const failures = [];
    for (const check of checks) {
      const rows = (await client.query(check.sql)).rows;
      const row = rows[0] ?? {};
      let ok = false;
      try { ok = !!check.expect(row); } catch { ok = false; }
      if (!ok) failures.push({ name: check.name, row });
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${check.name}${ok ? '' : `  -> ${JSON.stringify(row)}`}`);
    }
    if (failures.length) throw new Error(`PREFLIGHT FAILED (${failures.length} check(s)) — migration aborted, nothing written`);
    console.log('\nPREFLIGHT PASSED — pre-migration state matches the Gate ② baseline.');
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Write mode (Gate ④ only)
// ---------------------------------------------------------------------------

async function apply() {
  const args = parseArgs(process.argv.slice(2));
  assertApplyAllowed(args);
  console.log('Gate ④ authorized. Running preflight first (all-or-abort)...');
  await runPreflight(args.dataOnly ? buildDataPhasePreflightChecks() : buildPreflightChecks());

  const client = await connectPg();
  const tx = async (fn) => {
    await client.query('BEGIN');
    try { await fn(); await client.query('COMMIT'); }
    catch (err) { await client.query('ROLLBACK'); throw err; }
  };

  try {
    const preMig = (await client.query('SELECT COUNT(*)::int AS n FROM _migrations')).rows[0].n;

    // Schema: one transaction per version, marker row last (mirrors migrate()).
    // --data-only: schema v12..v19 is already applied and was just re-verified
    // by the data-phase preflight — only the data transaction remains.
    if (!args.dataOnly) {
      for (const v of buildSchemaStatements(12, 19)) {
        await tx(async () => {
          for (const s of v.statements) await client.query(s);
          await client.query('INSERT INTO _migrations ("version","name") VALUES ($1,$2) ON CONFLICT DO NOTHING', [v.version, MIGRATION_NAMES[v.version]]);
        });
        console.log(`  applied v${v.version} ${MIGRATION_NAMES[v.version]}`);
      }
    } else {
      console.log('  --data-only: schema phase already applied and verified — running data step only.');
    }

    // Data step: one transaction, idempotent inserts (rerun = no-op).
    const { statements, counts } = buildInsertStatements(openSqliteReadOnly());
    await tx(async () => { for (const s of statements) await client.query(s); });
    const inserted = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`  data step: ${statements.length} idempotent statements (${inserted} rows sourced)`);

    // Post verification.
    let postFail = 0;
    for (const c of buildVerificationQueries()) {
      const rows = (await client.query(c.sql)).rows;
      const row = rows[0] ?? {};
      const actual = Object.values(row).join('/');
      const isMig = c.table === '_migrations coverage';
      const ok = isMig ? Number(row.hi) === 19 && Number(row.n) === preMig + 8 : Number(row.n ?? row.open) === c.expected || String(actual) === String(c.expected);
      if (!ok) postFail++;
      console.log(`  ${ok ? 'ok ' : 'MISMATCH'} ${c.table}: ${actual} (expected ${isMig ? `hi 19, n ${preMig}+8` : c.expected})`);
    }
    if (postFail) throw new Error(`post-migration verification failed (${postFail})`);
    console.log('\nAPPLY COMPLETE — verified. Rollback if ever needed: restore the Gate ② backup.');
  } finally {
    await client.end();
  }
}

/** Read-only post-migration verification (--verify): SELECT-only, always allowed. */
async function runVerify() {
  if (process.env.MATERIALIQ_RUN_PG_MIGRATION_PREFLIGHT !== 'true') {
    throw new Error('refusing to connect: set MATERIALIQ_RUN_PG_MIGRATION_PREFLIGHT=true to run the SELECT-only verification');
  }
  const client = await connectPg();
  try {
    let fail = 0;
    console.log('== structural ==');
    for (const check of buildStructuralVerificationChecks()) {
      const rows = (await client.query(check.sql)).rows;
      const row = rows[0] ?? {};
      let ok = false;
      try { ok = !!check.expect(row); } catch { ok = false; }
      if (!ok) fail++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${check.name}${ok ? '' : `  -> ${JSON.stringify(row)}`}`);
    }
    console.log('== counts ==');
    for (const check of buildVerificationQueries()) {
      const rows = (await client.query(check.sql)).rows;
      const row = rows[0] ?? {};
      const actual = Object.values(row).join('/');
      const isMig = check.table === '_migrations coverage';
      const isNullPtr = check.table === 'uom_domain_rules effective pointer';
      const ok = isMig ? Number(row.hi) === 19
        : isNullPtr ? (row.effective_version_id ?? null) === null
        : Number(row.n ?? row.open) === check.expected || String(actual) === String(check.expected);
      if (!ok) fail++;
      console.log(`  ${ok ? 'ok  ' : 'MISMATCH'} ${check.table}: ${actual} (expected ${isMig ? 'hi 19' : check.expected})`);
    }
    if (fail) throw new Error(`VERIFY FAILED (${fail} check(s))`);
    console.log('\nVERIFY PASSED — post-migration state matches every expectation.');
  } finally {
    await client.end();
  }
}

// Main guard: importing this module never connects or writes. NO top-level
// await — the module must stay synchronously requirable (tests require() it).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  void (async () => {
    try {
      assertApplyAllowed(args); // Gate ④ refusal = clean ABORTED, exit 1 (never a raw stack)
      if (args.mode === 'plan') printPlan();
      else if (args.mode === 'preflight') await runPreflight(args.dataOnly ? buildDataPhasePreflightChecks() : buildPreflightChecks());
      else if (args.mode === 'verify') await runVerify();
      else await apply();
    } catch (err) {
      console.error(`\nABORTED: ${err.message}`);
      process.exit(1);
    }
  })();
}
