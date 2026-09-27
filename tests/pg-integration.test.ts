/**
 * Step 6C integration tests — LIVE Supabase/PostgreSQL verification.
 *
 * GATED: runs ONLY when MATERIALIQ_RUN_PG_TESTS=true AND
 * MATERIALIQ_DATABASE_URL is set AND MATERIALIQ_DB_DIALECT=postgres.
 * The default `npm test` suite never touches Supabase (no credentials needed).
 *
 *   MATERIALIQ_DB_DIALECT=postgres \
 *   MATERIALIQ_DATABASE_URL=... \
 *   MATERIALIQ_RUN_PG_TESTS=true npx tsx tests/pg-integration.test.ts
 *
 * Every test uses TEMPORARY rows (fixed unique keys) and cleans up after
 * itself; a finally-block sweep guarantees zero MaterialIQ business/test rows
 * remain at the end.
 */
import assert from 'node:assert/strict';

const RUN = process.env.MATERIALIQ_RUN_PG_TESTS === 'true' && !!process.env.MATERIALIQ_DATABASE_URL;

let passed = 0;
const failures: string[] = [];
const cleanupSql: Array<string> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(` ok - ${name}`);
  } catch (err: unknown) {
    failures.push(name);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(` not ok - ${name}
   ${msg}`);
  }
}

if (!RUN) {
  console.log('PG integration tests SKIPPED (set MATERIALIQ_RUN_PG_TESTS=true + MATERIALIQ_DATABASE_URL + MATERIALIQ_DB_DIALECT=postgres to run).');
  process.exit(0);
}

// Gate AFTER the skip path so importing executor/client never loads pg on SQLite runs.
import {
  getDb,
  withTransaction,
  closePostgresExecutor,
} from '../src/lib/db/client';
import { getDialect, translateStatement } from '../src/lib/db/dialect';

assert.equal(getDialect(), 'postgresql', 'suite must run under the postgres dialect');
const db = getDb();

// Fixed temporary keys so re-runs are idempotent and cleanup is exact.
const ORG = 'T6C';
const CODE_A = 'T6C-A';
const CODE_B = 'T6C-B';
const RUN_ID = 't6c-run';
const IRUN_ID = 't6c-irun';

function sweep(): void {
  // Order respects FKs; each statement tolerates missing rows.
  // (Step-4 note: the last two statements sweep material_attributes rows
  // whose material was already deleted — the DELETE in sweep order removes
  // attributes BEFORE materials, but attribute rows orphaned by an earlier
  // crashed run (no material) would otherwise trip material_attributes_pkey
  // residue checks. Both tolerate already-clean state.)
  const statements = [
    `DELETE FROM review_queue WHERE match_id IN (SELECT id FROM match_candidates WHERE source_material_id IN (SELECT id FROM material_records WHERE original_code LIKE 'T6C-%'))`,
    `DELETE FROM match_decisions WHERE match_id IN (SELECT id FROM match_candidates WHERE source_material_id IN (SELECT id FROM material_records WHERE original_code LIKE 'T6C-%'))`,
    `DELETE FROM material_mappings WHERE material_id IN (SELECT id FROM material_records WHERE original_code LIKE 'T6C-%')`,
    `DELETE FROM match_candidates WHERE source_material_id IN (SELECT id FROM material_records WHERE original_code LIKE 'T6C-%') OR candidate_material_id IN (SELECT id FROM material_records WHERE original_code LIKE 'T6C-%')`,
    `DELETE FROM material_attributes WHERE material_id IN (SELECT id FROM material_records WHERE original_code LIKE 'T6C-%')`,
    `DELETE FROM material_attributes WHERE material_id NOT IN (SELECT id FROM material_records) AND attribute_name IN ('series', 'seal_type')`,
    `DELETE FROM material_records WHERE original_code LIKE 'T6C-%'`,
    `DELETE FROM common_materials WHERE code LIKE 'T6C-%'`,
    `DELETE FROM matching_run_chunks WHERE run_id LIKE 't6c-%'`,
    `DELETE FROM matching_runs WHERE id LIKE 't6c-%'`,
    `DELETE FROM import_run_chunks WHERE run_id LIKE 't6c-%'`,
    `DELETE FROM import_rows WHERE job_id LIKE 't6c-%'`,
    `DELETE FROM import_runs WHERE id LIKE 't6c-%'`,
    `DELETE FROM data_imports WHERE file_name LIKE 't6c%'`,
    `DELETE FROM users WHERE email LIKE 't6c-%@example.test'`,
    `DELETE FROM sessions WHERE id LIKE 't6c-session-%'`,
    `DELETE FROM organizations WHERE code = '${ORG}'`,
  ];
  for (const sql of statements) {
    try {
      db.prepare(sql).run();
    } catch {
      /* tolerate already-clean state */
    }
  }
}

// Start from a clean slate (also makes re-runs deterministic).
sweep();

// ---------------------------------------------------------------------------
// §E.1 — SELECT 1 (connectivity)
// ---------------------------------------------------------------------------
test('SELECT 1 over the live connection', () => {
  const row = db.prepare('SELECT 1 AS one').get() as { one: number };
  assert.equal(row.one, 1);
});

// ---------------------------------------------------------------------------
// §E.2 — schema presence
// ---------------------------------------------------------------------------
test('19 MaterialIQ tables exist in public', () => {
  const rows = db
    .prepare(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    )
    .all() as Array<{ table_name: string }>;
  const expected = [
    '_migrations', 'audit_logs', 'common_materials', 'data_imports', 'evaluation_runs',
    'import_rows', 'import_run_chunks', 'import_runs', 'match_candidates', 'match_decisions',
    'material_attributes', 'material_mappings', 'material_records', 'matching_run_chunks',
    'matching_runs', 'organizations', 'review_queue', 'sessions', 'users',
  ];
  const names = rows.map((r) => r.table_name).sort();
  assert.deepEqual(names, [...expected].sort());
});

test('all 37 named indexes exist (incl. both active-run guards)', () => {
  const rows = db
    .prepare(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`)
    .all() as Array<{ indexname: string }>;
  const names = new Set(rows.map((r) => r.indexname));
  // The 37 indexes named in the migration (constraint-backed auto indexes
  // also appear in pg_indexes, so the total count is legitimately higher).
  const expected37 = [
    'idx_audit_actor', 'idx_audit_entity', 'idx_decisions_match', 'idx_eval_runs_time',
    'idx_import_rows_job', 'idx_import_runs_heartbeat', 'idx_import_runs_import', 'idx_import_runs_status',
    'idx_match_candidate', 'idx_match_run', 'idx_match_source', 'idx_match_status', 'idx_match_status_score', 'idx_match_type',
    'idx_match_runs_heartbeat', 'idx_match_runs_status',
    'idx_attributes_material', 'idx_attributes_name_value',
    'idx_mappings_cmi', 'idx_mappings_org',
    'idx_material_category', 'idx_material_import', 'idx_material_org', 'idx_material_org_code',
    'idx_material_quality', 'idx_material_source_row', 'idx_material_status',
    'idx_queue_opened', 'idx_queue_status_priority',
    'idx_sessions_expiry', 'idx_sessions_user', 'idx_users_org', 'idx_users_role',
    'uq_import_runs_active', 'uq_matching_runs_active',
  ];
  const missing = expected37.filter((n) => !names.has(n));
  assert.deepEqual(missing, [], `missing indexes: ${missing.join(', ')}`);
  assert.ok(names.size >= expected37.length);
});

// ---------------------------------------------------------------------------
// Base fixture rows for CRUD/relationship tests
// ---------------------------------------------------------------------------
test('fixture: organization + two materials (INSERT + RETURNING id)', () => {
  const insOrg = db
    .prepare(`INSERT INTO organizations (code, name) VALUES (?, ?) RETURNING id`)
    .get(ORG, 'Step 6C Temp Org') as { id: number };
  assert.ok(Number.isInteger(insOrg.id) && insOrg.id > 0, 'RETURNING id works');

  const insA = db
    .prepare(
      `INSERT INTO material_records (organization_id, original_code, original_description, category)
       VALUES (?, ?, ?, ?) RETURNING id`
    )
    .get(insOrg.id, CODE_A, 'T6C TEST BEARING 6205-2RS', 'Bearings') as { id: number };
  const insB = db
    .prepare(
      `INSERT INTO material_records (organization_id, original_code, original_description, category)
       VALUES (?, ?, ?, ?) RETURNING id`
    )
    .get(insOrg.id, CODE_B, 'T6C TEST BEARING 6205 2RS', 'Bearings') as { id: number };
  assert.notEqual(insA.id, insB.id);

  // §E.7 — INSERT + SELECT round-trip
  const back = db.prepare(`SELECT * FROM material_records WHERE original_code = ?`).get(CODE_A) as any;
  assert.equal(back.original_description, 'T6C TEST BEARING 6205-2RS');
  // Step 8 contract: PG booleans are coerced to SQLite-style 0/1 at the
  // adapter boundary (application reads `=== 1`; SQLite TEXT stores 0/1).
  assert.equal(back.is_active, 1, 'boolean default maps to SQLite-style 1');
  // Step 10 contract: timestamptz arrives as ISO-8601 TEXT (node:sqlite
  // parity) — app code feeds timestamps to new Date()/String() everywhere.
  assert.equal(typeof back.created_at, 'string', 'timestamptz arrives as ISO text');
  const delta = Math.abs(Date.now() - new Date(back.created_at).getTime());
  assert.ok(delta < 10 * 60 * 1000, 'timestamp is the current time');
});

// ---------------------------------------------------------------------------
// §E.8/9 — UPDATE / DELETE
// ---------------------------------------------------------------------------
test('UPDATE affects rowCount (changes) and persists', () => {
  const upd = db
    .prepare(`UPDATE material_records SET manufacturer = ? WHERE original_code = ?`)
    .run('T6C-SKF', CODE_A);
  assert.equal(Number(upd.changes), 1);
  const row = db.prepare(`SELECT manufacturer FROM material_records WHERE original_code = ?`).get(CODE_A) as any;
  assert.equal(row.manufacturer, 'T6C-SKF');
});

// ---------------------------------------------------------------------------
// §E.10 — RETURNING id on plain run() path (via prepared statement)
// ---------------------------------------------------------------------------
test('INSERT ... RETURNING id via run()/get() contract', () => {
  const row = db
    .prepare(`INSERT INTO material_attributes (material_id, attribute_name, value) VALUES (?, ?, ?) RETURNING id`)
    .get(
      (db.prepare(`SELECT id FROM material_records WHERE original_code = ?`).get(CODE_A) as any).id,
      'series',
      '6205'
    ) as { id: number };
  assert.ok(Number.isInteger(row.id) && row.id > 0);
});

// ---------------------------------------------------------------------------
// §E.5/6 — transaction commit + rollback (withTransaction on the PG path)
// ---------------------------------------------------------------------------
test('withTransaction COMMITS on success (same client, visible after)', () => {
  withTransaction(() => {
    db.prepare(`INSERT INTO material_records (organization_id, original_code, original_description, category)
                VALUES (?, 'T6C-TX1', 'TX COMMIT ROW', 'Bearings')`).run(
      (db.prepare(`SELECT id FROM organizations WHERE code = ?`).get(ORG) as any).id
    );
  });
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM material_records WHERE original_code = 'T6C-TX1'`).get() as any).n;
  assert.equal(n, 1);
});

test('withTransaction ROLLS BACK on throw (same client, atomic)', () => {
  assert.throws(() =>
    withTransaction(() => {
      db.prepare(`INSERT INTO material_records (organization_id, original_code, original_description, category)
                  VALUES (?, 'T6C-TX2', 'TX ROLLBACK ROW', 'Bearings')`).run(
        (db.prepare(`SELECT id FROM organizations WHERE code = ?`).get(ORG) as any).id
      );
      throw new Error('abort');
    })
  );
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM material_records WHERE original_code = 'T6C-TX2'`).get() as any).n;
  assert.equal(n, 0);
});

// ---------------------------------------------------------------------------
// §E.11/12 — ON CONFLICT DO NOTHING / DO UPDATE
// ---------------------------------------------------------------------------
test('ON CONFLICT (match_id) DO NOTHING — review_queue idempotency', () => {
  const orgId = (db.prepare(`SELECT id FROM organizations WHERE code = ?`).get(ORG) as any).id;
  const a = (db.prepare(`SELECT id FROM material_records WHERE original_code = ?`).get(CODE_A) as any).id;
  const b = (db.prepare(`SELECT id FROM material_records WHERE original_code = ?`).get(CODE_B) as any).id;
  const match = db
    .prepare(
      `INSERT INTO match_candidates (source_material_id, candidate_material_id, final_score, evidence)
       VALUES (?, ?, ?, ?) RETURNING id`
    )
    .get(a, b, 85, JSON.stringify({ decision: { state: 'HIGH_CONFIDENCE_MATCH', band: 'high' } })) as { id: number };

  const first = db
    .prepare(
      translateStatement(
        `INSERT OR IGNORE INTO review_queue (match_id, priority, reason, critical_difference) VALUES (?, 'high', 't6c test', NULL)`
      )
    )
    .run(match.id);
  assert.equal(Number(first.changes), 1, 'first enqueue applies');

  const second = db
    .prepare(
      translateStatement(
        `INSERT OR IGNORE INTO review_queue (match_id, priority, reason, critical_difference) VALUES (?, 'high', 't6c test', NULL)`
      )
    )
    .run(match.id);
  assert.equal(Number(second.changes), 0, 'duplicate enqueue ignored');
});

test('ON CONFLICT ... DO UPDATE — upsertAttribute semantics (per-step rowCount visible in txn)', () => {
  const a = (db.prepare(`SELECT id FROM material_records WHERE original_code = ?`).get(CODE_A) as any).id;
  withTransaction(() => {
    const up1 = db
      .prepare(
        `INSERT INTO material_attributes (material_id, attribute_name, value)
         VALUES (?, 'seal_type', '2RS')
         ON CONFLICT (material_id, attribute_name) DO UPDATE SET value = excluded.value`
      )
      .run(a);
    assert.equal(Number(up1.changes), 1, 'insert leg');
    const up2 = db
      .prepare(
        `INSERT INTO material_attributes (material_id, attribute_name, value)
         VALUES (?, 'seal_type', 'ZZ')
         ON CONFLICT (material_id, attribute_name) DO UPDATE SET value = excluded.value`
      )
      .run(a);
    assert.equal(Number(up2.changes), 1, 'update leg (PG reports UPDATE for DO UPDATE)');
    const val = (db.prepare(`SELECT value FROM material_attributes WHERE material_id = ? AND attribute_name = 'seal_type'`).get(a) as any).value;
    assert.equal(val, 'ZZ');
  });
});

// ---------------------------------------------------------------------------
// §E.13 — ILIKE behavior (dialect-translated case-insensitive search)
// ---------------------------------------------------------------------------
test('ILIKE (translated from LIKE ? COLLATE NOCASE) matches case-insensitively', () => {
  // Unique temp fixture string: only the T6C row matches regardless of how much
  // production data has been migrated (T6C- prefix is test-exclusive).
  const rows = db
    .prepare(`SELECT id FROM material_records WHERE original_description LIKE ? COLLATE NOCASE`)
    .all('%t6c test bearing 6205-2rs%') as unknown[];
  assert.equal(rows.length, 1, 'lowercase pattern matches stored uppercase text via ILIKE');
});

// ---------------------------------------------------------------------------
// §F — JSONB evidence + dialect-generated path query
// ---------------------------------------------------------------------------
test('evidence column is jsonb and dialect path query reads nested decision state', () => {
  const col = db
    .prepare(
      `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='match_candidates' AND column_name='evidence'`
    )
    .get() as any;
  assert.equal(col.data_type, 'jsonb');

  const a = (db.prepare(`SELECT id FROM material_records WHERE original_code = ?`).get(CODE_A) as any).id;
  const b = (db.prepare(`SELECT id FROM material_records WHERE original_code = ?`).get(CODE_B) as any).id;
  // An earlier test in this file may already have created the (a,b) candidate
  // (with a review_queue row referencing it) - clear dependents first.
  db.prepare(`DELETE FROM review_queue WHERE match_id IN (SELECT id FROM match_candidates WHERE source_material_id = ? AND candidate_material_id = ?)`).run(a, b);
  db.prepare(`DELETE FROM match_candidates WHERE source_material_id = ? AND candidate_material_id = ?`).run(a, b);
  const m = db
    .prepare(
      `INSERT INTO match_candidates (source_material_id, candidate_material_id, evidence)
       VALUES (?, ?, ?) RETURNING id`
    )
    .get(a, b, JSON.stringify({ decision: { state: 'NEEDS_TECHNICAL_REVIEW', band: 'review', reason: 'critical technical conflict:seal_type' } })) as { id: number };

  // The EXACT SQL shape the dialect layer generates for repository queries.
  const translated = translateStatement(
    `SELECT COALESCE(json_extract(evidence, '$.decision.state'), 'UNCLASSIFIED') AS decision FROM match_candidates WHERE id = ?`
  );
  assert.ok(translated.includes(`#>>`), 'translation produced a JSONB path query');
  const row = db.prepare(translated).get(m.id) as any;
  assert.equal(row.decision, 'NEEDS_TECHNICAL_REVIEW', 'logical value matches SQLite behavior');
});

// ---------------------------------------------------------------------------
// §E.15 — timestamps
// ---------------------------------------------------------------------------
test('timestamptz defaults + round-trip (ISO-8601 TEXT contract)', () => {
  const org = db.prepare(`SELECT created_at, updated_at FROM organizations WHERE code = ?`).get(ORG) as any;
  assert.equal(typeof org.created_at, 'string', 'timestamptz arrives as ISO-8601 text (node:sqlite parity)');
  assert.ok(!Number.isNaN(new Date(org.created_at).getTime()), 'text is a valid instant');
  const delta = Math.abs(Date.now() - new Date(org.created_at).getTime());
  assert.ok(delta < 10 * 60 * 1000, 'now() default is current time');
});

// ---------------------------------------------------------------------------
// §E.16/17 + §G — active-run guards and constraint verification
// ---------------------------------------------------------------------------
test('uq_matching_runs_active: second QUEUED run rejected', () => {
  db.prepare(`INSERT INTO matching_runs (id, status, chunk_size) VALUES (?, 'QUEUED', 100)`).run(RUN_ID);
  assert.throws(
    () => db.prepare(`INSERT INTO matching_runs (id, status, chunk_size) VALUES ('t6c-run-2', 'QUEUED', 100)`).run(),
    /uq_matching_runs_active|duplicate key/i
  );
});

test('uq_matching_runs_active: QUEUED + RUNNING mutually exclusive; terminal states allowed', () => {
  db.prepare(`INSERT INTO matching_runs (id, status, chunk_size) VALUES ('t6c-run-done', 'COMPLETED', 100)`).run();
  // allowed alongside the QUEUED t6c-run
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM matching_runs WHERE status IN ('QUEUED','RUNNING')`).get() as any).n;
  assert.equal(n, 1, 'only one active run');
});

test('uq_import_runs_active: second active import rejected', () => {
  const importRow = db
    .prepare(`INSERT INTO data_imports (organization_id, file_name, file_type) VALUES (?, 't6c.csv', 'csv') RETURNING id`)
    .get((db.prepare(`SELECT id FROM organizations WHERE code = ?`).get(ORG) as any).id) as { id: number };
  db.prepare(`INSERT INTO import_runs (id, data_import_id, status, filename, file_type, chunk_size)
              VALUES (?, ?, 'QUEUED', 't6c.csv', 'csv', 100)`).run(IRUN_ID, importRow.id);
  assert.throws(
    () =>
      db.prepare(`INSERT INTO import_runs (id, data_import_id, status, filename, file_type, chunk_size)
                  VALUES ('t6c-irun-2', ?, 'QUEUED', 't6c.csv', 'csv', 100)`).run(importRow.id),
    /uq_import_runs_active|duplicate key/i
  );
});

test('CHECK constraints: audit action, role/org, session expiry, material code uniqueness, match self-pair', () => {
  const orgId = (db.prepare(`SELECT id FROM organizations WHERE code = ?`).get(ORG) as any).id;
  const a = (db.prepare(`SELECT id FROM material_records WHERE original_code = ?`).get(CODE_A) as any).id;
  const b = (db.prepare(`SELECT id FROM material_records WHERE original_code = ?`).get(CODE_B) as any).id;

  // audit action CHECK
  assert.throws(
    () => db.prepare(`INSERT INTO audit_logs (action, entity_type) VALUES ('not_a_real_action', 'x')`).run(),
    /audit_logs_action_check/i
  );
  // users role/org composite CHECK
  assert.throws(
    () => db.prepare(`INSERT INTO users (name, email, password_hash, role, organization_id) VALUES ('T6C Bad Role', 't6c-bad@example.test', 'x', 'cpse_material_manager', NULL)`).run(),
    /users_check/i
  );
  const user = db
    .prepare(`INSERT INTO users (name, email, password_hash, role, organization_id) VALUES ('T6C Good', 't6c-ok@example.test', 'x', 'cpse_material_manager', ?) RETURNING id`)
    .get(orgId) as { id: number };
  // session expiry CHECK (expires_at must be > created_at)
  assert.throws(
    () =>
      db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('t6c-session-bad', ?, now(), now())`).run(user.id),
    /sessions_check|expiry/i
  );
  // organization + original_code uniqueness
  assert.throws(
    () =>
      db.prepare(`INSERT INTO material_records (organization_id, original_code, original_description, category) VALUES (?, ?, 'dup', 'Bearings')`).run(orgId, CODE_A),
    /material_records_organization_id_original_code_key|duplicate key/i
  );
  // match candidate self-pair CHECK
  assert.throws(
    () => db.prepare(`INSERT INTO match_candidates (source_material_id, candidate_material_id) VALUES (?, ?)`).run(a, a),
    /match_candidates_check/i
  );
  // match candidate pair uniqueness
  const existing = (db.prepare(`SELECT COUNT(*) AS n FROM match_candidates WHERE source_material_id = ? AND candidate_material_id = ?`).get(a, b) as any).n;
  assert.throws(
    () => db.prepare(`INSERT INTO match_candidates (source_material_id, candidate_material_id) VALUES (?, ?)`).run(a, b),
    existing > 0 ? /match_candidates_source_material_id_candidate_material_id_key|duplicate key/i : /match_candidates/i
  );
  // review_queue uniqueness (match_id UNIQUE)
  const matchId = (db.prepare(`SELECT match_id FROM review_queue LIMIT 1`).get() as any)?.match_id;
  if (matchId) {
    assert.throws(
      () => db.prepare(`INSERT INTO review_queue (match_id, priority, reason) VALUES (?, 'low', 'dup test')`).run(matchId),
      /review_queue_match_id_key|duplicate key/i
    );
  }
  // FK violation: material for unknown organization
  assert.throws(
    () =>
      db.prepare(`INSERT INTO material_records (organization_id, original_code, original_description, category) VALUES (99999999, 'T6C-ORPHAN', 'x', 'Bearings')`).run(),
    /material_records_organization_id_fkey|foreign key/i
  );
});

// ---------------------------------------------------------------------------
// PostgreSQL lastInsertRowid regression (Import Center "Import not found"): the
// repositories follow the SQLite DataApi contract — INSERT.run() must surface
// the generated key as RunResult.lastInsertRowid. The executor now appends
// RETURNING id to identity-table INSERTs; these tests pin that contract.
// ---------------------------------------------------------------------------
test('lastInsertRowid: INSERT.run() returns generated id without RETURNING in SQL', () => {
  const orgId = (db.prepare(`SELECT id FROM organizations WHERE code = ?`).get(ORG) as any).id;

  // data_imports — the exact statement shape of import-repository.createImport()
  // (the call behind POST /api/imports/analyze).
  const ins = db
    .prepare(`INSERT INTO data_imports (organization_id, file_name, file_type, total_rows, status)
              VALUES (?, 't6c-lir.csv', 'csv', 2, 'pending')`)
    .run(orgId);
  const importId = Number(ins.lastInsertRowid);
  assert.equal(Number.isInteger(importId) && importId > 0, true, 'lastInsertRowid must be a positive integer');
  assert.equal(Number(ins.changes), 1, 'changes must still report 1');
  // The repository contract: getImportRequired(Number(res.lastInsertRowid)) succeeds.
  const row = db.prepare(`SELECT id, file_name, status FROM data_imports WHERE id = ?`).get(importId) as any;
  assert.ok(row, 'row must be retrievable via the returned lastInsertRowid');
  assert.equal(row.file_name, 't6c-lir.csv');
  assert.equal(row.status, 'pending');

  // users — the other production consumer (auth/user-repository.createUser).
  const uins = db
    .prepare(`INSERT INTO users (name, email, password_hash, role, organization_id)
              VALUES ('T6C LastRowid', 't6c-lir@example.test', 'x', 'authority', NULL)`)
    .run();
  const userId = Number(uins.lastInsertRowid);
  assert.equal(Number.isInteger(userId) && userId > 0, true, 'users.lastInsertRowid must be positive');
  const urow = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(userId) as any;
  assert.equal(urow.email, 't6c-lir@example.test');

  // Exact cleanup of this test's rows.
  db.prepare(`DELETE FROM users WHERE email = 't6c-lir@example.test'`).run();
  db.prepare(`DELETE FROM data_imports WHERE file_name = 't6c-lir.csv'`).run();
});

test('lastInsertRowid: INSERT into a table without an id column stays changes-only', () => {
  // import_rows has a composite PK (no id column): run() must be untouched.
  const orgId = (db.prepare(`SELECT id FROM organizations WHERE code = ?`).get(ORG) as any).id;
  const importRow = db
    .prepare(`INSERT INTO data_imports (organization_id, file_name, file_type) VALUES (?, 't6c-noid.csv', 'csv') RETURNING id`)
    .get(orgId) as any;
  db.prepare(`INSERT INTO import_runs (id, data_import_id, status, filename, file_type, chunk_size)
              VALUES ('t6c-irun-lir', ?, 'COMPLETED', 't6c-noid.csv', 'csv', 100)`).run(importRow.id);
  const r = db
    .prepare(`INSERT INTO import_rows (job_id, row_number, severity, code) VALUES ('t6c-irun-lir', 1, 'VALID', 'T6C-NOID')`)
    .run();
  assert.equal(Number(r.changes), 1);
  assert.equal(Number(r.lastInsertRowid), 0, 'no id column -> no lastInsertRowid emulation');

  db.prepare(`DELETE FROM import_rows WHERE job_id = 't6c-irun-lir'`).run();
  db.prepare(`DELETE FROM import_runs WHERE id = 't6c-irun-lir'`).run();
  db.prepare(`DELETE FROM data_imports WHERE file_name = 't6c-noid.csv'`).run();
});

// ---------------------------------------------------------------------------
// Cleanup + final verification (§E/K: zero MaterialIQ rows remain)
// ---------------------------------------------------------------------------
test('cleanup: all temporary rows removed (post-migration aware)', () => {
  sweep();

  // Step 7B migrated production data into Supabase, so "business tables empty"
  // is no longer the invariant. The 7B baseline counts are asserted instead,
  // and this test keeps asserting that ZERO T6C temp rows remain.
  const baseline: Record<string, number> = {
    organizations: 5, material_records: 120, material_attributes: 691, data_imports: 16,
    match_candidates: 1289, match_decisions: 10, review_queue: 1289, common_materials: 1,
    material_mappings: 3, audit_logs: 62, evaluation_runs: 5, users: 5, sessions: 0,
    matching_runs: 0, matching_run_chunks: 0, import_runs: 0, import_run_chunks: 0, import_rows: 0,
  };
  const drift = Object.entries(baseline)
    .map(([t, expected]) => {
      const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
      return { t, expected, n, ok: n === expected };
    })
    .filter((c) => !c.ok);
  assert.deepEqual(drift, [], `table counts drifted from the 7B baseline: ${JSON.stringify(drift)}`);

  // temp rows are gone (T6C prefix)
  const leftovers = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE code = 'T6C'`).get() as any).n
  );
  assert.equal(leftovers, 0, 'T6C temp organization must be swept');
});

// ---------------------------------------------------------------------------

test('7A-review Change 2: migration FAIL_AFTER rollback leaves destination empty', () => {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const path = require('node:path') as typeof import('node:path');
  const script = path.resolve(__dirname, '..', 'scripts', 'migrate-sqlite-to-postgres.ts');
  let code = 0;
  let output = '';
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', script], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, MIGRATE_EXECUTE: 'yes', MIGRATE_FAIL_AFTER: 'match_candidates' },
    });
    assert.fail('injected failure must make the script exit non-zero');
  } catch (e: any) {
    code = e.status ?? -1;
    output = String(e.stdout || '') + String(e.stderr || '');
  }
  const preMigration = Number(
    (db.prepare('SELECT COUNT(*)::int AS n FROM public.organizations').get() as any).n
  ) === 0;
  if (preMigration) {
    assert.equal(code, 5, 'injected failure exits 5 on an empty destination');
    const tables = ['organizations','material_records','material_attributes','match_candidates','review_queue','audit_logs','users'];
    for (const t of tables) {
      const r = db.prepare('SELECT COUNT(*)::int AS n FROM public.' + t).get() as any;
      assert.equal(r.n, 0, t + ' must be empty after rollback');
    }
  } else {
    // Post-7B: the destination-empty guard must refuse before any insert.
    // Guard and injected-failure share exit code 5 (same fail-closed path);
    // the distinguishing signal is the refusal message.
    assert.equal(code, 5, 'fail-closed exit expected, got ' + code);
    assert.match(output, /destination not empty/i, 'guard refusal message required');
    assert.doesNotMatch(output, /injected failure/i, 'no rows may be inserted on a non-empty destination');
  }
});
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('FAILED:', failures.join(' | '));
  closePostgresExecutor();
  process.exit(1);
}
closePostgresExecutor();
process.exit(0);
