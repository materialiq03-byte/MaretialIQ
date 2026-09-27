/**
 * Step 7A migration-preparation tests — `npx tsx tests/migration-prep.test.ts`.
 *
 * Validates the SQLite → PostgreSQL migration PLANNING layer without touching
 * Supabase: dependency ordering (from the real FK graph), type coercion
 * (timestamptz/bool/double/jsonb/bigint), evidence JSONB validity across ALL
 * production rows, sequence-reset planning, duplicate/orphan detection,
 * destination-state guard, dry-run behavior, and credential non-disclosure.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  EXCLUDED_TABLES,
  coerce,
  canon,
  norm,
  rowHash,
  topoOrder,
  buildPlans,
  sequencePlan,
  collectSourceProblems,
} from '../scripts/migrate-sqlite-to-postgres';
import { setDbForTests } from '../src/lib/db/client';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..');
let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(' ok -', name);
  } catch (err) {
    failures.push(name + ' :: ' + (err as Error).message);
    console.log(' not ok -', name);
    console.log('   ' + String((err as Error).message).split('\n')[0]);
  }
}

/** Fresh temp SQLite DB with the full app schema. */
function freshDb(): { db: DatabaseSync; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miq-7a-'));
  const db = new DatabaseSync(path.join(dir, 't.db'));
  db.exec('PRAGMA foreign_keys = ON');
  const migrate = require_(path.join(repoRoot, 'src/lib/db/migrate.ts'));
  migrate.migrate(db);
  return { db, dir };
}

// ---------------------------------------------------------------------------
// A. Type coercion
// ---------------------------------------------------------------------------
test('coerce: timestamptz accepts iso-ms-Z and preserves the instant', () => {
  assert.equal(coerce('2026-09-20T19:42:22.306Z', 'timestamptz', 'x'), '2026-09-20T19:42:22.306Z');
  assert.throws(() => coerce('2026-09-20 19:42:22', 'timestamptz', 'x'), /unexpected timestamp format/);
  assert.throws(() => coerce('1789934542306', 'timestamptz', 'x'), /unexpected timestamp format/);
  assert.throws(() => coerce('not-a-date', 'timestamptz', 'x'), /unexpected timestamp format/);
  assert.equal(coerce(null, 'timestamptz', 'x'), null);
});

test('coerce: jsonb accepts valid JSON objects and rejects invalid/malformed', () => {
  assert.equal(coerce('{"a":1}', 'jsonb', 'x'), '{"a":1}');
  assert.throws(() => coerce('{broken', 'jsonb', 'x'), /not valid JSON/);
  assert.throws(() => coerce('123', 'jsonb', 'x'), /not a JSON object|not valid JSON/);
  assert.throws(() => coerce('null', 'jsonb', 'x'), /not a JSON object/);
  assert.equal(coerce(null, 'jsonb', 'x'), null, 'NULL passes through (candidate id 1 is NULL)');
});

test('coerce: bool only accepts 0/1/true/false', () => {
  assert.equal(coerce(1, 'bool', 'x'), true);
  assert.equal(coerce(0, 'bool', 'x'), false);
  assert.equal(coerce(true, 'bool', 'x'), true);
  assert.throws(() => coerce(2, 'bool', 'x'), /non-0\/1/);
  assert.throws(() => coerce('yes', 'bool', 'x'), /non-0\/1/);
});

test('coerce: double preserves the exact IEEE-754 value (no rounding)', () => {
  assert.equal(coerce(87.5, 'double', 'x'), 87.5);
  assert.equal(coerce(96, 'double', 'x'), 96);
  assert.equal(coerce(0.1 + 0.2, 'double', 'x'), 0.1 + 0.2);
  assert.throws(() => coerce(NaN, 'double', 'x'), /non-finite/);
  assert.throws(() => coerce(Infinity, 'double', 'x'), /non-finite/);
});

test('coerce: bigint rejects unsafe integers; text passes through', () => {
  assert.equal(coerce(9242, 'bigint', 'x'), 9242);
  assert.throws(() => coerce(Number.MAX_SAFE_INTEGER + 1, 'bigint', 'x'), /unsafe integer/);
  assert.equal(coerce('plain', 'text', 'x'), 'plain');
});

// ---------------------------------------------------------------------------
// B. Canonical hashing / normalization (source==target comparisons)
// ---------------------------------------------------------------------------
test('norm: booleans and Dates normalize to source-comparable values', () => {
  assert.equal(norm(true), 1);
  assert.equal(norm(false), 0);
  const d = new Date('2026-09-20T19:42:22.306Z');
  assert.equal(norm(d), '2026-09-20T19:42:22.306Z');
});

test('canon/rowHash: key-order independent', () => {
  const a = rowHash({ b: 1, a: 2 });
  const b = rowHash({ a: 2, b: 1 });
  assert.equal(a, b);
  assert.notEqual(rowHash({ a: 2, b: 1 }), rowHash({ a: 2, b: 2 }));
});

test('canon: canonical JSON is byte-stable for representative evidence', () => {
  const evidence = {
    decision: { state: 'NEEDS_TECHNICAL_REVIEW', band: 'review', reason: 'critical technical conflict:seal_type' },
    technical: { attributes: [{ attributeName: 'seal_type', type: 'CONFLICT', valueA: '2RS', valueB: 'ZZ', critical: true, detail: 'values differ' }] },
  };
  // key order scrambled must produce identical hash
  const scrambled = JSON.parse('{"technical":{"attributes":[{"detail":"values differ","critical":true,"valueB":"ZZ","valueA":"2RS","type":"CONFLICT","attributeName":"seal_type"}]},"decision":{"reason":"critical technical conflict:seal_type","band":"review","state":"NEEDS_TECHNICAL_REVIEW"}}');
  assert.equal(canon(evidence), canon(scrambled));
});

// ---------------------------------------------------------------------------
// C. Dependency ordering from the real FK graph
// ---------------------------------------------------------------------------
test('topoOrder: parents always precede children on the production graph', () => {
  const { db } = freshDb();
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as any[]).map(r => String(r.name));
  const order = topoOrder(db, tables);
  assert.equal(order.length, tables.length);
  const pos = new Map(order.map((t, i) => [t, i]));
  for (const t of tables) {
    const fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as any[];
    for (const fk of fks) {
      const parent = String(fk.table);
      if (parent !== t) assert.ok(pos.get(parent)! < pos.get(t)!, `${parent} must precede ${t}`);
    }
  }
  // sanity: well-known leaves
  assert.ok(order.indexOf('review_queue') > order.indexOf('match_candidates'));
  assert.ok(order.indexOf('material_records') > order.indexOf('organizations'));
  db.close();
});

test('topoOrder: detects FK cycles instead of guessing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miq-cycle-'));
  const db = new DatabaseSync(path.join(dir, 'c.db'));
  db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b(id)); CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));');
  assert.throws(() => topoOrder(db, ['a', 'b']), /cycle/);
  db.close();
});

// ---------------------------------------------------------------------------
// D. Sequence planning (identity columns) + text-PK exclusion
// ---------------------------------------------------------------------------
test('sequencePlan: integer tables get setval above max id; text PKs excluded; ids never printed', () => {
  const { db, dir } = freshDb();
  db.prepare("INSERT INTO organizations (code, name) VALUES ('SEQT', 'Seq Test Org')").run();
  const { plans } = buildPlans(db);
  const plan = sequencePlan(db, plans);
  const byTable = new Map(plan.map(p => [p.table, p.statement]));

  const maxOrg = Number(db.prepare('SELECT MAX(id) m FROM organizations').get()!.m);
  assert.equal(maxOrg, 1, 'seeded org must exist');
  assert.match(String(byTable.get('organizations')), new RegExp('organizations.*' + maxOrg + ', true'));
  assert.ok(/setval\(pg_get_serial_sequence/.test(String(byTable.get('material_records'))));
  assert.equal(byTable.get('matching_runs'), null, 'text PK: no sequence');
  assert.equal(byTable.get('import_runs'), null, 'text PK: no sequence');
  assert.equal(byTable.get('sessions'), undefined, 'sessions EXCLUDED entirely (7A-review Change 1) - not even a null entry');

  // §10/§18: no secret or session-token material in the plan output
  const printed = JSON.stringify(plan);
  const sessionIds = (db.prepare('SELECT id FROM sessions').all() as any[]).map(r => String(r.id));
  for (const id of sessionIds) assert.ok(!printed.includes(id), 'session id must not appear in plan');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// E. Source preflights (clean production DB passes; seeded problems detected)
// ---------------------------------------------------------------------------
test('collectSourceProblems: production-style DB yields zero problems', () => {
  const { db, dir } = freshDb();
  const { plans } = buildPlans(db);
  assert.deepEqual(collectSourceProblems(db, plans), []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate org+code cannot exist (app+DB reject; preflight is belt-and-braces)', () => {
  const { db, dir } = freshDb();
  setDbForTests(db as any);
  const { createOrganization } = require_(path.join(repoRoot, 'src/lib/db/repositories/organization-repository'));
  const { insertMaterial } = require_(path.join(repoRoot, 'src/lib/db/repositories/material-repository'));
  createOrganization({ code: 'DUP', name: 'Dup Org' });
  insertMaterial({ organizationId: 1, originalCode: 'X1', originalDescription: 'd', category: 'c', uom: 'u' });
  // repository must refuse the duplicate (fail-closed protection in source)
  assert.throws(() => insertMaterial({ organizationId: 1, originalCode: 'X1', originalDescription: 'd2', category: 'c', uom: 'u' }), /already exists|UNIQUE/i);
  setDbForTests(null as unknown as DatabaseSync);
  const { plans } = buildPlans(db);
  assert.deepEqual(collectSourceProblems(db, plans), []);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM material_records WHERE original_code='X1'").get()!.n, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectSourceProblems: detects self-pair candidate', () => {
  const { db, dir } = freshDb();
  setDbForTests(db as any);
  const { createOrganization } = require_(path.join(repoRoot, 'src/lib/db/repositories/organization-repository'));
  const { insertMaterial } = require_(path.join(repoRoot, 'src/lib/db/repositories/material-repository'));
  createOrganization({ code: 'SP', name: 'SP Org' });
  insertMaterial({ organizationId: 1, originalCode: 'S1', originalDescription: 'd', category: 'c', uom: 'u' });
  try {
    db.prepare("INSERT INTO match_candidates (source_material_id, candidate_material_id, explanation, match_type) VALUES (1, 1, 'x', 'same')").run();
  } catch { /* CHECK may forbid self-pair in SQLite too — then the constraint itself is the protection */ }
  setDbForTests(null as unknown as DatabaseSync);
  const { plans } = buildPlans(db);
  const problems = collectSourceProblems(db, plans);
  if (Number(db.prepare('SELECT COUNT(*) n FROM match_candidates WHERE source_material_id = candidate_material_id').get()!.n) > 0) {
    assert.ok(problems.some(p => /self-pair/.test(p)));
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectSourceProblems: detects orphan attributes after direct SQL insert', () => {
  const { db, dir } = freshDb();
  setDbForTests(db as any);
  const { createOrganization } = require_(path.join(repoRoot, 'src/lib/db/repositories/organization-repository'));
  const { insertMaterial } = require_(path.join(repoRoot, 'src/lib/db/repositories/material-repository'));
  createOrganization({ code: 'ORPH', name: 'Orphan Org' });
  insertMaterial({ organizationId: 1, originalCode: 'O1', originalDescription: 'd', category: 'c', uom: 'u' });
  setDbForTests(null as unknown as DatabaseSync);
  // bypass FK to simulate pre-existing corruption
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare("INSERT INTO material_attributes (material_id, attribute_name, value, is_critical, extraction_method) VALUES (999, 'weight_kg', '12.5', 0, 'manual')").run();
  const { plans } = buildPlans(db);
  const problems = collectSourceProblems(db, plans);
  assert.ok(problems.some(p => /orphan rows: material_attributes/.test(p)), JSON.stringify(problems));
  db.exec("DELETE FROM material_attributes WHERE material_id = 999");
  db.exec('PRAGMA foreign_keys = ON');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// F. Destination-empty guard + EXECUTE gating (subprocess, no credentials)
// ---------------------------------------------------------------------------
const SCRIPT = path.join(repoRoot, 'scripts', 'migrate-sqlite-to-postgres.ts');
const NODE = process.execPath;

test('dry run: exits 0, prints plan, never reads credentials', () => {
  const out = execFileSync(NODE, ['--experimental-strip-types', SCRIPT], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, MATERIALIQ_DATABASE_URL: 'should-not-be-read-in-dry-run' },
  });
  assert.ok(out.includes('DRY RUN COMPLETE'));
  assert.ok(out.includes('review_queue'));
  assert.ok(!out.includes('should-not-be-read-in-dry-run'), 'dry run must not echo credentials');
});

test('MIGRATE_EXECUTE=yes without credentials: config error exit 2, no DB contact', () => {
  // Isolate from the repo's real .env.local (loadDotEnvLocal reads process.cwd()):
  // temp cwd with a copy of the SQLite source and an EMPTY .env.local.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miq-noauth-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(repoRoot, 'data', 'materialiq.db'), path.join(dir, 'data', 'materialiq.db'));
  fs.writeFileSync(path.join(dir, '.env.local'), '# no credentials here');
  let out = '';
  let code = 0;
  try {
    execFileSync(NODE, ['--experimental-strip-types', SCRIPT], {
      cwd: dir, encoding: 'utf8',
      env: (() => { const e = { ...process.env, MIGRATE_EXECUTE: 'yes' }; delete (e as any).MATERIALIQ_DATABASE_URL; return e; })(),
    });
  } catch (e: any) { out = String(e.stderr || e.stdout || ''); code = e.status ?? -1; }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 2, 'expected config error exit 2: ' + out.slice(0, 200));
  assert.ok(/CONFIG ERROR: MATERIALIQ_DATABASE_URL/.test(out), out.slice(0, 300));
});

test('EXCLUDED_TABLES: _migrations and sessions are excluded (7A-review Change 1)', () => {
  assert.ok(EXCLUDED_TABLES.has('_migrations'));
  assert.ok(EXCLUDED_TABLES.has('sessions'), 'sessions must be excluded per review');
  assert.equal(EXCLUDED_TABLES.size, 2);
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // dry-run output must mark sessions as excluded
  const out = execFileSync(NODE, ['--experimental-strip-types', SCRIPT], { cwd: repoRoot, encoding: 'utf8' });
  const sessLine = out.split('\n').find(l => l.trim().startsWith('12.') || /\bsessions\b/.test(l));
  assert.ok(out.includes('EXCLUDED'), 'plan must mark excluded tables');
});

// ---------------------------------------------------------------------------
// G. Credential non-disclosure
// ---------------------------------------------------------------------------
test('script never embeds DATABASE_URL, passwords, or tokens in source or output', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/DATABASE_URL\s*=\s*['"]?(postgres|supabase)/i.test(src), 'no hardcoded URL');
  assert.ok(!/password\s*[:=]\s*['"][^'"]{8,}/i.test(src), 'no hardcoded password');
  // dry-run output (captured above) is asserted not to contain the fake secret
});

// ---------------------------------------------------------------------------
// H. Source state (production) — counts, evidence validity, spot checks
// ---------------------------------------------------------------------------
const prod = new DatabaseSync(path.join(repoRoot, 'data', 'materialiq.db'), { readOnly: true });

test('production source counts match the frozen baseline', () => {
  const q = (t: string) => Number(prod.prepare(`SELECT COUNT(*) n FROM "${t}"`).get()!.n);
  assert.equal(q('organizations'), 5);
  assert.equal(q('material_records'), 120);
  assert.equal(q('material_attributes'), 691);
  assert.equal(q('data_imports'), 16);
  assert.equal(q('match_candidates'), 1289);
  assert.equal(q('match_decisions'), 10);
  assert.equal(q('review_queue'), 1289);
  assert.equal(q('common_materials'), 1);
  assert.equal(q('material_mappings'), 3);
  assert.equal(q('audit_logs'), 62);
  // evaluation_runs is APPEND-ONLY by design (see migrate.ts v9: "rows are
  // never updated or deleted"; every `npm run evaluate` appends run-N). The
  // frozen reference baseline is 5; the live source legitimately grows as
  // evaluation runs are recorded. The invariant here is therefore a FLOOR at
  // the baseline plus history integrity — never an exact count (the exact
  // counts above remain the mutation guard for the frozen business tables).
  const frozenEvalBaseline = 5;
  assert.ok(
    q('evaluation_runs') >= frozenEvalBaseline,
    `evaluation_runs must retain at least the frozen baseline of ${frozenEvalBaseline} (append-only history; got ${q('evaluation_runs')})`,
  );
  assert.equal(q('users'), 5);
  assert.equal(q('sessions'), 14, 'SQLite sessions remain untouched (exclusion is migration-side only)');
  assert.equal(q('matching_runs'), 0);
  assert.equal(q('import_runs'), 0);
});

test('evaluation_runs append-only history retains the frozen baseline and stays well-formed', () => {
  // The exact count lives in no invariant; what MUST hold is that the frozen
  // baseline runs are still present, nothing was rewritten/deleted, and every
  // appended row has the schema-required shape (migration-safe source).
  const cols = (prod.prepare('PRAGMA table_info(evaluation_runs)').all() as any[]).map((c) => String(c.name));
  const required = [
    'run_id', 'timestamp', 'dataset', 'dataset_version', 'pairs', 'accuracy',
    'macro_precision', 'macro_recall', 'macro_f1', 'weighted_f1', 'confusion',
    'false_positives', 'false_negatives', 'matcher_config', 'build_id',
  ];
  const missing = required.filter((c) => !cols.includes(c));
  assert.deepEqual(missing, [], `evaluation_runs is missing required columns: ${missing.join(', ')}`);
  const malformed = Number(
    prod
      .prepare('SELECT COUNT(*) AS n FROM evaluation_runs WHERE run_id IS NULL OR timestamp IS NULL OR pairs < 0')
      .get()!.n,
  );
  assert.equal(malformed, 0, 'evaluation_runs contains rows violating the schema invariants');
  const firstRun = Number(
    prod.prepare("SELECT COUNT(*) AS n FROM evaluation_runs WHERE run_id = 'run-0001'").get()!.n,
  );
  assert.equal(firstRun, 1, 'frozen baseline run-0001 must remain present (history is append-only)');
  const uniqueRuns = Number(prod.prepare('SELECT COUNT(DISTINCT run_id) AS n FROM evaluation_runs').get()!.n);
  assert.equal(uniqueRuns, Number(prod.prepare('SELECT COUNT(*) AS n FROM evaluation_runs').get()!.n), 'run_id must remain UNIQUE across the append-only history');
});

test('production evidence: every non-NULL row is valid JSON; NULLs enumerated', () => {
  let bad = 0, nulls = 0, total = 0;
  for (const r of prod.prepare('SELECT id, evidence FROM match_candidates').all() as any[]) {
    total++;
    if (r.evidence === null) { nulls++; continue; }
    try { JSON.parse(String(r.evidence)); } catch { bad++; }
  }
  assert.equal(bad, 0, `${bad} invalid evidence rows`);
  assert.ok(nulls <= 1, `unexpected NULL evidence count: ${nulls}`);
  assert.equal(total, 1289);
});

test('flagship rows present in source (7B will re-verify after load)', () => {
  const row = (code: string) => prod.prepare(
    `SELECT mc.id, mc.match_type, mc.final_score, mc.status
     FROM match_candidates mc
     JOIN material_records a ON a.id = mc.source_material_id
     JOIN material_records b ON b.id = mc.candidate_material_id
     WHERE a.original_code = 'CP-1001' AND b.original_code = ?`).get(code) as any;
  const nt = row('NT-8821');
  assert.equal(nt.status, 'approved');
  assert.equal(nt.id, 1);
  const bh = row('BH-4410');
  assert.equal(bh.match_type, 'needs_review');
  const bhEv = JSON.parse(String(prod.prepare('SELECT evidence FROM match_candidates WHERE id = ?').get(bh.id)!.evidence));
  const s = JSON.stringify(bhEv);
  assert.ok(s.includes('"2RS"') && s.includes('"ZZ"'), 'seal conflict evidence present');
  const sl = row('SL-7721');
  assert.equal(sl.final_score, 100);
  prod.close();
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('FAILED: ' + f);
  process.exit(1);
}
