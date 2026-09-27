/**
 * Step-6B adapter tests — `npx tsx tests/adapter.test.ts`.
 *
 * Covers: dialect SQL translation (identity on SQLite, deterministic PG
 * equivalents), the SQLite seam (byte-identical behavior), the PG executor
 * contract (translated SQL pinned, execution fails fast until wired),
 * transaction begin/rollback semantics, and job/chunk persistence + guard
 * behavior through the seam.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  getDialect,
  translateSql,
  translateStatement,
} from '../src/lib/db/dialect';
import {
  makeSqliteExecutor,
  PgPreparedStatement,
  pgExecutor,
  setAdapterForTests,
  type StatementExecutor,
  type PreparedStatementApi,
} from '../src/lib/db/adapter';
import {
  getDb,
  getRawSqliteDb,
  setDbForTests,
  withTransaction,
} from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(` ok - ${name}`);
    })
    .catch((err) => {
      failures.push(name);
      console.error(` not ok - ${name}\n   ${err?.message ?? err}`);
    });
}

// ---------------------------------------------------------------------------
// 1. Dialect: default is SQLite; SQLite translation is identity.
// ---------------------------------------------------------------------------

test('dialect defaults to sqlite', () => {
  assert.equal(getDialect(), 'sqlite');
});

test('SQLite dialect passes SQL through byte-identical (identity translation)', () => {
  const samples = [
    `INSERT OR IGNORE INTO review_queue (match_id, priority, reason, critical_difference) VALUES (?, ?, ?, ?)`,
    `SELECT id FROM material_records WHERE original_code LIKE ? COLLATE NOCASE ORDER BY original_code LIMIT 1`,
    `SELECT COALESCE(json_extract(evidence, '$.decision.state'), 'UNCLASSIFIED') AS state FROM match_candidates`,
    `BEGIN IMMEDIATE`,
    `CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`,
    `SELECT * FROM organizations WHERE length(code) BETWEEN 2 AND 10`,
  ];
  for (const sql of samples) {
    assert.equal(translateSql(sql), sql, `identity violated for: ${sql}`);
    assert.equal(translateStatement(sql), sql);
  }
});

// ---------------------------------------------------------------------------
// 2. Dialect: PostgreSQL translations (pure functions, env-gated flag flip).
// ---------------------------------------------------------------------------

test('PG translation: LIKE ? COLLATE NOCASE -> ILIKE', () => {
  process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
  try {
    assert.equal(
      translateSql(`SELECT id FROM material_records WHERE original_code LIKE ? COLLATE NOCASE LIMIT 1`),
      `SELECT id FROM material_records WHERE original_code ILIKE ? LIMIT 1`
    );
    assert.equal(
      translateSql(`SELECT 1 FROM t WHERE a LIKE 'x%' COLLATE NOCASE`),
      `SELECT 1 FROM t WHERE a ILIKE 'x%'`
    );
  } finally {
    delete process.env.MATERIALIQ_DB_DIALECT;
  }
});

test('PG translation: json_extract -> jsonb #>> path', () => {
  process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
  try {
    assert.equal(
      translateSql(`SELECT json_extract(mc.evidence, '$.decision.state') FROM match_candidates mc`),
      `SELECT (mc.evidence#>>'{decision,state}') FROM match_candidates mc`
    );
    assert.equal(
      translateSql(
        `SELECT COALESCE(json_extract(evidence, '$.decision.state'), 'UNCLASSIFIED') AS decision FROM match_candidates`
      ),
      `SELECT COALESCE((evidence#>>'{decision,state}'), 'UNCLASSIFIED') AS decision FROM match_candidates`
    );
  } finally {
    delete process.env.MATERIALIQ_DB_DIALECT;
  }
});

test('PG translation: boolean-column integer literals -> true/false (Step 8 finding)', () => {
  process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
  try {
    assert.equal(
      translateSql(`SELECT id FROM material_records WHERE is_active = 1`),
      `SELECT id FROM material_records WHERE is_active = true`
    );
    assert.equal(
      translateSql(`UPDATE material_records SET is_active = 0, updated_at = ? WHERE id = ?`),
      `UPDATE material_records SET is_active = false, updated_at = ? WHERE id = ?`
    );
    assert.equal(
      translateSql(`SELECT COUNT(*) AS n FROM material_records WHERE is_active = 1 AND organization_id = ?`),
      `SELECT COUNT(*) AS n FROM material_records WHERE is_active = true AND organization_id = ?`
    );
    // Non-boolean columns are untouched (text '6205' must never be coerced).
    assert.equal(
      translateSql(`SELECT * FROM t WHERE part_number = 1`),
      `SELECT * FROM t WHERE part_number = 1`
    );
  } finally {
    delete process.env.MATERIALIQ_DB_DIALECT;
  }
});

test('PG translation: expression-level COLLATE NOCASE equality -> lower() (Step 8 finding)', () => {
  process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
  try {
    assert.equal(
      translateSql(`SELECT id FROM material_records WHERE original_code = ? COLLATE NOCASE LIMIT 1`),
      `SELECT id FROM material_records WHERE (lower(original_code) = lower(?)) LIMIT 1`
    );
    // LIKE-side NOCASE is still ILIKE (rule precedence unchanged).
    assert.equal(
      translateSql(`SELECT id FROM material_records WHERE original_code LIKE ? COLLATE NOCASE`),
      `SELECT id FROM material_records WHERE original_code ILIKE ?`
    );
  } finally {
    delete process.env.MATERIALIQ_DB_DIALECT;
  }
});

test('PG translation: GROUP_CONCAT -> string_agg (Step 8 finding)', () => {
  process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
  try {
    assert.equal(
      translateSql(`SELECT GROUP_CONCAT(m.original_description, ' | ') AS d FROM material_records m`),
      `SELECT string_agg((m.original_description)::text, ' | ') AS d FROM material_records m`
    );
    assert.equal(
      translateSql(`SELECT GROUP_CONCAT(x) FROM t`),
      `SELECT string_agg((x)::text, ',') FROM t`
    );
  } finally {
    delete process.env.MATERIALIQ_DB_DIALECT;
  }
});

test('PG translation: INSERT OR IGNORE -> ON CONFLICT with explicit target', () => {
  process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
  try {
    assert.equal(
      translateStatement(`INSERT OR IGNORE INTO review_queue (match_id, priority, reason, critical_difference) VALUES (?, ?, ?, ?)`),
      `INSERT INTO review_queue (match_id, priority, reason, critical_difference) VALUES (?, ?, ?, ?) ON CONFLICT (match_id) DO NOTHING`
    );
    assert.equal(
      translateStatement(`INSERT OR IGNORE INTO matching_run_chunks (run_id, chunk_index, first_pair, pair_count, status) VALUES (?, ?, ?, ?, ?)`),
      `INSERT INTO matching_run_chunks (run_id, chunk_index, first_pair, pair_count, status) VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id, chunk_index) DO NOTHING`
    );
    assert.equal(
      translateStatement(`INSERT OR IGNORE INTO import_run_chunks (run_id, chunk_index, first_row, row_count, status) VALUES (?, ?, ?, ?, ?)`),
      `INSERT INTO import_run_chunks (run_id, chunk_index, first_row, row_count, status) VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id, chunk_index) DO NOTHING`
    );
  } finally {
    delete process.env.MATERIALIQ_DB_DIALECT;
  }
});

test('PG translation: unknown INSERT OR IGNORE target fails fast (no silent semantic change)', () => {
  process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
  try {
    assert.throws(
      () => translateStatement(`INSERT OR IGNORE INTO some_unknown_table (a) VALUES (?)`),
      /no registered conflict target/
    );
  } finally {
    delete process.env.MATERIALIQ_DB_DIALECT;
  }
});

test('PG translation: strftime default -> now(), AUTOINCREMENT -> identity, length -> char_length, BEGIN IMMEDIATE -> BEGIN', () => {
  process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
  try {
    assert.equal(
      translateSql(`created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
      `created_at TEXT NOT NULL DEFAULT (now())`
    );
    assert.equal(
      translateSql(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`),
      `CREATE TABLE t (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT)`
    );
    assert.equal(translateSql(`SELECT * FROM o WHERE length(code) > 2`), `SELECT * FROM o WHERE char_length(code) > 2`);
    assert.equal(translateSql(`BEGIN IMMEDIATE`), `BEGIN IMMEDIATE`); // statement translator leaves transaction verbs to withTransaction
  } finally {
    delete process.env.MATERIALIQ_DB_DIALECT;
  }
});

// ---------------------------------------------------------------------------
// 3. SQLite seam behavior (raw DatabaseSync path) — unchanged semantics.
// ---------------------------------------------------------------------------

function makeTempDb(): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miq-adapter-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

test('SQLite seam: getDataApi() IS the raw connection; insert/read/id/changes identical', () => {
  const conn = makeTempDb();
  setDbForTests(conn);
  try {
    const api = getDb();
    assert.equal(api, conn, 'SQLite path must return the raw connection');
    migrate(getRawSqliteDb());

    const res = api
      .prepare(`INSERT INTO organizations (code, name) VALUES (?, ?)`)
      .run('ZZ', 'Zeorg Industries');
    const id = Number(res.lastInsertRowid);
    assert.equal(Number.isInteger(id) && id > 0, true, 'lastInsertRowid returned');
    assert.equal(Number(res.changes), 1);

    const row = api.prepare(`SELECT id, code, name FROM organizations WHERE id = ?`).get(id) as {
      id: number;
      code: string;
      name: string;
    };
    // node:sqlite rows are null-prototype objects; compare field-wise.
    assert.equal(row.id, id);
    assert.equal(row.code, 'ZZ');
    assert.equal(row.name, 'Zeorg Industries');

    // Upsert + run() result semantics on the seam.
    const ins = api
      .prepare(`INSERT INTO organizations (code, name) VALUES (?, ?)`)
      .run('YY', 'Second Org');
    assert.equal(Number(ins.changes), 1);
    const upd = api
      .prepare(`UPDATE organizations SET status = 'inactive' WHERE code = ?`)
      .run('YY');
    assert.equal(Number(upd.changes), 1);
  } finally {
    setDbForTests(null as unknown as DatabaseSync);
    conn.close();
  }
});

test('SQLite seam: UPDATE changes count and case-insensitive search semantics preserved', () => {
  const conn = makeTempDb();
  setDbForTests(conn);
  try {
    migrate(getRawSqliteDb());
    const api = getDb();
    api
      .prepare(`INSERT INTO organizations (code, name) VALUES ('AA', 'Alpha'), ('BB', 'Beta')`)
      .run();
    // SQLite '=' is case-SENSITIVE for stored text (unlike MySQL); the app
    // never relies on case-insensitive '=' — it uses COLLATE NOCASE on LIKE.
    const upd = api.prepare(`UPDATE organizations SET status = 'inactive' WHERE code = ?`).run('aa');
    assert.equal(Number(upd.changes), 0, 'equality is case-sensitive (unchanged SQLite semantics)');
    const updExact = api.prepare(`UPDATE organizations SET status = 'inactive' WHERE code = ?`).run('AA');
    assert.equal(Number(updExact.changes), 1, 'exact-code update applies');

    const like = api
      .prepare(`SELECT id FROM organizations WHERE name LIKE ? COLLATE NOCASE`)
      .all('ALPH%');
    assert.equal(like.length, 1, 'LIKE ... COLLATE NOCASE stays case-insensitive');
  } finally {
    setDbForTests(null as unknown as DatabaseSync);
    conn.close();
  }
});

test('SQLite seam: withTransaction commits on success and rolls back on throw', () => {
  const conn = makeTempDb();
  setDbForTests(conn);
  try {
    migrate(getRawSqliteDb());
    const api = getDb();

    withTransaction(() => {
      api.prepare(`INSERT INTO organizations (code, name) VALUES ('CC', 'Commit Corp')`).run();
    });
    assert.equal(
      (api.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE code = 'CC'`).get() as { n: number }).n,
      1,
      'committed'
    );

    assert.throws(() =>
      withTransaction(() => {
        api.prepare(`INSERT INTO organizations (code, name) VALUES ('DD', 'Doomed')`).run();
        throw new Error('abort');
      })
    );
    assert.equal(
      (api.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE code = 'DD'`).get() as { n: number }).n,
      0,
      'rolled back'
    );

  } finally {
    setDbForTests(null as unknown as DatabaseSync);
    conn.close();
  }
});

test('SQLite seam: job/chunk persistence + single-active-run guard through the seam', () => {
  const conn = makeTempDb();
  setDbForTests(conn);
  try {
    migrate(getRawSqliteDb());
    const api = getDb();
    api
      .prepare(`INSERT INTO matching_runs (id, status, chunk_size) VALUES (?, 'QUEUED', ?)`)
      .run('job-1', 5000);
    assert.throws(
      () => api.prepare(`INSERT INTO matching_runs (id, status, chunk_size) VALUES (?, 'QUEUED', ?)`).run('job-2', 5000),
      /UNIQUE constraint failed/,
      'uq_matching_runs_active guard enforced through the seam'
    );
    const ig = api
      .prepare(`INSERT OR IGNORE INTO matching_run_chunks (run_id, chunk_index, first_pair, pair_count, status) VALUES (?, ?, ?, ?, 'COMMITTED')`)
      .run('job-1', 0, 0, 10);
    assert.equal(Number(ig.changes), 1, 'first chunk insert applies');
    const dup = api
      .prepare(`INSERT OR IGNORE INTO matching_run_chunks (run_id, chunk_index, first_pair, pair_count, status) VALUES (?, ?, ?, ?, 'COMMITTED')`)
      .run('job-1', 0, 0, 10);
    assert.equal(Number(dup.changes), 0, 'duplicate chunk ignored (idempotency)');
  } finally {
    setDbForTests(null as unknown as DatabaseSync);
    conn.close();
  }
});

test('SQLite seam: evidence JSON write + json_extract read round-trips', () => {
  const conn = makeTempDb();
  setDbForTests(conn);
  try {
    migrate(getRawSqliteDb());
    const api = getDb();
    api.prepare(`INSERT INTO organizations (code, name) VALUES ('CP', 'Cpse')`).run();
    const orgId = (api.prepare(`SELECT id FROM organizations WHERE code = 'CP'`).get() as { id: number }).id;
    api
      .prepare(
        `INSERT INTO material_records (organization_id, original_code, original_description, category)
         VALUES (?, 'X-1', 'TEST BEARING 6205', 'Bearings')`
      )
      .run(orgId);
    api
      .prepare(
        `INSERT INTO material_records (organization_id, original_code, original_description, category)
         VALUES (?, 'X-2', 'TEST BEARING 6205 ZZ', 'Bearings')`
      )
      .run(orgId);
    const matA = (api.prepare(`SELECT id FROM material_records WHERE original_code = 'X-1'`).get() as { id: number }).id;
    const matB = (api.prepare(`SELECT id FROM material_records WHERE original_code = 'X-2'`).get() as { id: number }).id;
    const evidence = JSON.stringify({ decision: { state: 'NEEDS_TECHNICAL_REVIEW', band: 'review' } });
    api
      .prepare(`INSERT INTO match_candidates (source_material_id, candidate_material_id, evidence) VALUES (?, ?, ?)`)
      .run(matA, matB, evidence);
    const state = (
      api
        .prepare(`SELECT json_extract(evidence, '$.decision.state') AS state FROM match_candidates WHERE id = ?`)
        .get(matA) as { state: string }
    ).state;
    assert.equal(state, 'NEEDS_TECHNICAL_REVIEW', 'json_extract works against the stored evidence (both dialects query the same logical document)');
  } finally {
    setDbForTests(null as unknown as DatabaseSync);
    conn.close();
  }
});

// ---------------------------------------------------------------------------
// 4. PostgreSQL executor contract (no live database required).
// ---------------------------------------------------------------------------

test('PG executor: pgExecutor.prepare pins the TRANSLATED SQL for repository statements', () => {
  const stmt = pgExecutor.prepare(
    `INSERT OR IGNORE INTO review_queue (match_id, priority, reason, critical_difference) VALUES (?, ?, ?, ?)`
  ) as PgPreparedStatement;
  assert.equal(
    stmt.translatedSql,
    `INSERT INTO review_queue (match_id, priority, reason, critical_difference) VALUES (?, ?, ?, ?) ON CONFLICT (match_id) DO NOTHING`
  );

  const q = pgExecutor.prepare(
    `SELECT COALESCE(json_extract(evidence, '$.decision.state'), 'UNCLASSIFIED') AS d FROM match_candidates`
  ) as PgPreparedStatement;
  assert.equal(
    q.translatedSql,
    `SELECT COALESCE((evidence#>>'{decision,state}'), 'UNCLASSIFIED') AS d FROM match_candidates`
  );

  const like = pgExecutor.prepare(
    `SELECT id FROM material_records WHERE original_description LIKE ? COLLATE NOCASE`
  ) as PgPreparedStatement;
  assert.equal(like.translatedSql, `SELECT id FROM material_records WHERE original_description ILIKE ?`);
});

test('PG executor: execution fails fast until a live driver is wired (never silently falls back)', () => {
  assert.throws(() => pgExecutor.prepare(`SELECT 1`).get(), /cannot get|not wired/);
  assert.throws(() => pgExecutor.prepare(`SELECT 1`).all(), /cannot all|not wired/);
  assert.throws(() => pgExecutor.prepare(`SELECT 1`).run(), /cannot run|not wired/);
  assert.throws(() => pgExecutor.exec(`SELECT 1`), /cannot exec|not wired/);
});

test('Adapter injection: setAdapterForTests swaps the active executor and null resets', () => {
  const calls: string[] = [];
  const fake: StatementExecutor = {
    dialect: 'postgresql',
    prepare(sql: string): PreparedStatementApi {
      calls.push(translateStatement(sql, 'postgresql')); // record what the dialect layer WOULD run
      return new PgPreparedStatement(translateStatement(sql, 'postgresql'));
    },
    exec(sql: string): void {
      calls.push(sql);
    },
  };
  setAdapterForTests(fake);
  try {
    // The injected executor is consulted once MATERIALIQ_DB_DIALECT=postgresql
    // routes getDb()/withTransaction() through the adapter path. The fake only
    // records/returns the translated SQL; nothing executes against a table.
    process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
    getDb().prepare(`SELECT * FROM t WHERE a LIKE ? COLLATE NOCASE`);
    withTransaction(() => 1); // BEGIN + COMMIT routed to the injected executor
    assert.deepEqual(calls, [`SELECT * FROM t WHERE a ILIKE ?`, `BEGIN`, `COMMIT`]);
  } finally {
    delete process.env.MATERIALIQ_DB_DIALECT;
    setAdapterForTests(null);
  }
  // After reset, the seam is back on SQLite: getDb() returns the raw
  // connection again (identity SQL, no injected interception).
  const conn = makeTempDb();
  setDbForTests(conn);
  try {
    assert.equal(getDb(), conn, 'null reset restores the default SQLite executor');
  } finally {
    setDbForTests(null as unknown as DatabaseSync);
    conn.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Data-integrity spot checks after the seam refactor (production file).
// ---------------------------------------------------------------------------

test('Production data unchanged after seam refactor (read-only spot check)', () => {
  const prod = new DatabaseSync('data/materialiq.db', { readOnly: true });
  try {
    const q = (t: string) => (prod.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    assert.equal(q('organizations'), 5);
    assert.equal(q('material_records'), 120);
    assert.equal(q('match_candidates'), 1289);
    assert.equal(q('review_queue'), 1289);
    assert.equal(q('matching_runs'), 0);
    assert.equal(q('import_runs'), 0);
    const integrity = prod.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    assert.equal(integrity.integrity_check, 'ok');
    assert.equal(prod.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    prod.close();
  }
});

// ---------------------------------------------------------------------------

setTimeout(() => {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error('FAILED:', failures.join(' | '));
    process.exit(1);
  }
  process.exit(0);
}, 500);
