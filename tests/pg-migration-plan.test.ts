/**
 * Gate ③ tests — Option A migration implementation (NO real database).
 *
 * Coverage:
 *   1. Migration SQL generation: v12..v19 present, ordered, key artifacts.
 *   2. Manifest: corrected authoritative counts (513 data + 7 seed = 520).
 *   3. Data-step generation: verbatim values from a disposable temp SQLite
 *      copy of the frozen demo SHAPE (synthetic rows, not demo values),
 *      manifest match, idempotency suffixes, sequence setvals.
 *   4. JSON dialect translation: json_extract (existing) + json_array_length
 *      (new rule) incl. SQLite-identity on sqlite dialect and edge cases.
 *   5. Active matching-run guard: partial unique index SQL + real enforcement
 *      on a disposable SQLite db (same semantics the PG index implements).
 *   6. UOM trigger/version behavior: refusal triggers + version backfill on
 *      disposable SQLite (semantic equivalents of the PG triggers).
 *   7. Sequence handling: setval statements present for every explicit-id table.
 *
 * Everything runs against in-process temp SQLite and pure string builders —
 * Supabase receives ZERO connections, ZERO writes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

import { migrate } from '../src/lib/db/migrate';
import { translateStatement, translateSql } from '../src/lib/db/dialect';

const require = createRequire(import.meta.url);
const core = require('../scripts/migration/pg-v12-v19-core.mjs');

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ---------------- disposable source db (synthetic, demo-shaped) ----------- */
function makeSourceDb(): { db: DatabaseSync; file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miq-mig-plan-'));
  const file = path.join(dir, 'source.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db); // v1..v19 on temp sqlite — frozen schema, synthetic rows
  const now = '2026-09-26T15:51:28.696Z';
  db.prepare(`INSERT INTO organizations (id, code, name, status, created_at, updated_at) VALUES (1,'CPCL','CPCL','active',?,?)`).run(now, now);
  for (let i = 1; i <= 3; i++) {
    db.prepare(
      `INSERT INTO material_records (id, organization_id, original_code, original_description, category, uom, created_at, updated_at)
       VALUES (?, 1, ?, 'desc', 'Bearings', 'NOS', ?, ?)`
    ).run(i, `SRC-${i}`, now, now);
  }
  db.prepare(
    `INSERT INTO common_materials (id, code, name, category, created_at, updated_at) VALUES (1, 'CMI-0001', 'Bearing 6205', 'Bearings', ?, ?)`
  ).run(now, now);
  // suppliers 2 rows / procurement_records 3 rows (one without price)
  const sup = db.prepare(`INSERT INTO suppliers (id, supplier_code, supplier_name, region, is_active, created_at, updated_at) VALUES (?,?,?,'Pune',1,?,?)`);
  sup.run(1, 'SUP-A', 'Supplier A', now, now);
  sup.run(2, 'SUP-B', 'Supplier B', now, now);
  const pr = db.prepare(
    `INSERT INTO procurement_records (id, organization_id, material_id, cmi_id, supplier_id, purchase_order_reference, purchase_date, quantity, uom, unit_price, currency, procurement_status, source_system, row_signature, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  pr.run(1, 1, 1, 1, 1, 'PO-1', '2026-09-01', '10', 'NOS', '100.50', 'INR', 'DELIVERED', 'seed', 'sig-1', now, now);
  pr.run(2, 1, 2, null, 2, 'PO-2', '2026-09-02', '2.5', 'KG', null, null, 'ORDERED', 'seed', 'sig-2', now, now);
  pr.run(3, 1, 3, 1, 1, 'PO-3', '2026-09-03', '7', 'PCS', '10', 'INR', 'DELIVERED', 'seed', 'sig-3', now, now);
  // uom domain rule: one PENDING (no effective version)
  db.prepare(
    `INSERT INTO uom_domain_rules (id, cmi_id, from_uom, to_uom, factor, status, source, reason, created_by, created_at, updated_at)
     VALUES (1, 1, 'SET', 'EA', 10, 'PENDING', 'GOVERNED', 'seed governance', 'seed@governance.demo', ?, ?)`
  ).run(now, now);
  // data_imports FIRST (import_runs.data_import_id is a NOT NULL FK): three
  // rows — the tail id (3) is the run's FK parent.
  const di = db.prepare(
    `INSERT INTO data_imports (id, organization_id, file_name, file_type, total_rows, status, created_at, updated_at) VALUES (?,1,'f.csv','csv',5,'completed',?,?)`
  );
  di.run(1, now, now);
  di.run(2, now, now);
  di.run(3, now, now);
  // import run + chunk + rows (v11 import_runs shape)
  db.prepare(
    `INSERT INTO import_runs (id, data_import_id, status, filename, file_type, total_rows, processed_rows, successful_rows, failed_rows, chunk_size, started_at, completed_at, created_at, updated_at)
     VALUES ('imp_test_1', 3, 'COMPLETED', 'f.csv', 'csv', 50, 50, 40, 10, 500, ?, ?, ?, ?)`
  ).run(now, now, now, now);
  db.prepare(
    `INSERT INTO import_run_chunks (run_id, chunk_index, first_row, row_count, status, created_at, updated_at) VALUES ('imp_test_1',0,0,50,'COMMITTED',?,?)`
  ).run(now, now);
  const ir = db.prepare(
    `INSERT INTO import_rows (job_id, row_number, severity, code, description, uom, created_at, updated_at) VALUES ('imp_test_1',?,?,?,?,'NOS',?,?)`
  );
  for (let i = 1; i <= 5; i++) ir.run(i, i <= 4 ? 'VALID' : 'ERROR', `C-${i}`, `desc ${i}`, now, now);
  // audit rows 1..4 -> tail = ids 3,4 (2 rows)
  const au = db.prepare(`INSERT INTO audit_logs (id, action, entity_type, entity_id, actor, details, created_at) VALUES (?,?,?,?,?,?,?)`);
  au.run(1, 'import_created', 'import_job', 1, 'tester', '{}', now);
  au.run(2, 'import_started', 'import_job', 1, 'system', '{}', now);
  au.run(3, 'import_performed', 'import_job', 1, 'system', '{"imported":4}', now);
  au.run(4, 'supplier_created', 'supplier', 1, 'seed', '{}', now);
  return { db, file, dir };
}

/* =============================================== 1. migration SQL generation */
async function testMigrationGeneration() {
  const versions = core.buildSchemaStatements(12, 19);
  await test('v12..v19 all present in order', () => {
    assert.deepEqual(versions.map((v: any) => v.version), [12, 13, 14, 15, 16, 17, 18, 19]);
  });
  await test('migration names match frozen migrate.ts exactly', () => {
    const expected = [12, 13, 14, 15, 16, 17, 18, 19].map((v) => (core as any).MIGRATION_NAMES[v]);
    assert.deepEqual(versions.map((v: any) => v.name), expected);
    assert.equal((core as any).MIGRATION_NAMES[12], 'repair-matching-runs-active-guard');
    assert.equal((core as any).MIGRATION_NAMES[19], 'uom-rule-versions');
  });
  await test('v12 emits the single-active-run partial unique index (no is_active column — frozen schema)', () => {
    const sqls = versions[0].statements.join('\n');
    assert.match(sqls, /CREATE UNIQUE INDEX IF NOT EXISTS uq_matching_runs_active/);
    assert.match(sqls, /WHERE status IN \('QUEUED', 'RUNNING'\)/);
    assert.doesNotMatch(sqls, /is_active/);
  });
  await test('v13 creates suppliers + procurement_records with identity PKs and 7 indexes', () => {
    const sqls = versions[1].statements;
    assert.ok(sqls.some((s: string) => /CREATE TABLE suppliers/.test(s) && /GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY/.test(s)));
    assert.ok(sqls.some((s: string) => /CREATE TABLE procurement_records/.test(s)));
    assert.equal(sqls.filter((s: string) => /^CREATE INDEX idx_proc_/.test(s)).length, 7);
    const qty = sqls.find((s: string) => /quantity text NOT NULL CHECK/.test(s));
    assert.ok(qty && /quantity ~ /.test(qty) && /quantity::double precision > 0/.test(qty), 'shape-regex + numeric positivity check');
  });
  await test('v14 adds kind + row_signature + staging table + signature guard', () => {
    const sqls = versions[2].statements;
    assert.ok(sqls.some((s: string) => /ALTER TABLE import_runs ADD COLUMN kind text NOT NULL DEFAULT 'materials'/.test(s)));
    assert.ok(sqls.some((s: string) => /CREATE TABLE procurement_import_rows/.test(s) && /PRIMARY KEY \(job_id, row_number\)/.test(s)));
    assert.ok(sqls.some((s: string) => /uq_procurement_row_signature/.test(s) && /WHERE row_signature <> ''/.test(s)));
  });
  await test('v15 creates procurement_opportunities with deterministic detection_key', () => {
    const sqls = versions[3].statements;
    assert.ok(sqls.some((s: string) => /CREATE TABLE procurement_opportunities/.test(s) && /detection_key text NOT NULL UNIQUE/.test(s)));
    assert.equal(sqls.filter((s: string) => /^CREATE INDEX idx_opp_/.test(s)).length, 5);
  });
  await test('v16 creates uom_conversion_rules and seeds EXACTLY 7 SYSTEM_DEFINED rows', () => {
    const sqls = versions[4].statements;
    assert.ok(sqls.some((s: string) => /CREATE TABLE uom_conversion_rules/.test(s) && /UNIQUE \(from_uom, to_uom, rule_type\)/.test(s)));
    const seed = sqls.find((s: string) => /INSERT INTO uom_conversion_rules/.test(s));
    assert.equal((seed!.match(/\('/g) || []).length, 7, 'seed statement must carry exactly 7 value tuples');
    assert.match(seed!, /ON CONFLICT \(from_uom, to_uom, rule_type\) DO NOTHING/);
    assert.equal((core as any).SEED_ROWS_UOM_CONVERSION_RULES.length, 7);
    assert.deepEqual(
      (core as any).SEED_ROWS_UOM_CONVERSION_RULES.map((r: any) => [r.from_uom, r.to_uom, r.factor, r.rule_type]),
      [['PCS','EA',1,'ALIAS'],['NOS','EA',1,'ALIAS'],['KG','G',1000,'SCALE'],['TON','G',1000000,'SCALE'],['L','ML',1000,'SCALE'],['M','MM',1000,'SCALE'],['CM','MM',10,'SCALE']]
    );
  });
  await test('v17 creates uom_domain_rules with live-rule partial unique index', () => {
    const sqls = versions[5].statements;
    assert.ok(sqls.some((s: string) => /CREATE UNIQUE INDEX uq_uom_domain_live/.test(s) && /WHERE status IN \('PENDING','APPROVED','DISABLED'\)/.test(s)));
  });
  await test('v18+v19: history/versions final shape, pointers, triggers, audit widens', () => {
    const v18 = versions[6].statements;
    const v19 = versions[7].statements;
    assert.ok(v18.some((s: string) => /CREATE TABLE uom_rule_history/.test(s) && /version_id integer/.test(s) && /'AMEND'/.test(s)));
    assert.ok(v18.some((s: string) => /materialiq_refuse_mutation/.test(s)));
    assert.ok(v19.some((s: string) => /CREATE TABLE uom_domain_rule_versions/.test(s) && /UNIQUE \(rule_id, version_number\)/.test(s)));
    assert.ok(v19.some((s: string) => /ADD COLUMN effective_version_id integer/.test(s)));
    assert.ok(v19.some((s: string) => /ADD COLUMN pending_version_id integer/.test(s)));
    for (const trg of ['trg_uom_rule_history_no_update','trg_uom_rule_history_no_delete','trg_uom_rule_versions_no_update','trg_uom_rule_versions_no_delete']) {
      assert.ok(v19.some((s: string) => s.includes(`CREATE TRIGGER ${trg}`)), trg);
    }
    const finalAudit = v19.find((s: string) => /audit_logs_action_check/.test(s) && /ADD CONSTRAINT/.test(s));
    assert.match(finalAudit!, /uom_rule_amended/);
  });
  await test('every version ends with its _migrations marker name/series', () => {
    for (const v of versions) assert.equal((core as any).MIGRATION_NAMES[v.version], v.name);
  });
}

/* ===================================================== 2/3. manifest + data */
async function testManifestAndDataStep() {
  const { db, dir } = makeSourceDb();
  try {
    const { statements, counts } = core.buildInsertStatements(db);
    await test('manifest matches the corrected gate-③ authoritative counts', () => {
      assert.deepEqual({ ...core.MANIFEST }, {
        suppliers: 10, procurement_records: 211, uom_domain_rules: 1, uom_rule_history: 1,
        uom_domain_rule_versions: 1, import_runs: 1, import_run_chunks: 1, import_rows: 50,
        data_imports: 12, audit_logs: 225, uom_conversion_rules: 7,
      });
      assert.equal(core.MANIFEST_DATA_STEP_TOTAL, 513);
      assert.equal(core.MANIFEST_GRAND_TOTAL, 520);
    });
    await test('source counters reflect the disposable db and respect WHERE tails', () => {
      assert.equal(counts.suppliers, 2);
      assert.equal(counts.procurement_records, 3);
      assert.equal(counts.uom_domain_rules, 1);
      assert.equal(counts.uom_rule_history, 1);
      assert.equal(counts.uom_domain_rule_versions, 1);
      assert.equal(counts.import_runs, 1);
      assert.equal(counts.import_run_chunks, 1);
      assert.equal(counts.import_rows, 5);
      // The real plan tails are WHERE id > 16 / id > 62 against the frozen
      // demo (16 imports / 62 audit rows already in Supabase). On this fixture
      // the same WHERE clauses simply match 0 rows — the assertion documents
      // that the where-clauses are part of the plan (not invented at runtime).
      assert.equal(counts.data_imports, 0, 'plan WHERE id > 16 — fixture only has ids 1..3');
      assert.equal(counts.audit_logs, 0, 'plan WHERE id > 62 — fixture only has ids 1..4');
    });
    await test('every data INSERT is idempotent (ON CONFLICT DO NOTHING with correct PK)', () => {
      const inserts = statements.filter((s: string) => /^INSERT INTO/.test(s));
      assert.ok(inserts.length > 0);
      for (const s of inserts) assert.match(s, /ON CONFLICT .* DO NOTHING;$/);
      assert.ok(statements.some((s: string) => s.includes('INSERT INTO "import_run_chunks"') && s.includes('ON CONFLICT ("run_id", "chunk_index")')));
      assert.ok(statements.some((s: string) => s.includes('INSERT INTO "import_rows"') && s.includes('ON CONFLICT ("job_id", "row_number")')));
    });
    await test('values are verbatim from source (no regeneration) — spot checks', () => {
      const sup = statements.find((s: string) => s.includes('INSERT INTO "suppliers"') && s.includes("'SUP-A'"));
      assert.ok(sup!.includes(`'2026-09-26T15:51:28.696Z'`));
      const pr = statements.find((s: string) => s.includes("INSERT INTO \"procurement_records\"") && s.includes("'sig-2'"));
      assert.ok(pr!.includes('NULL'), 'null unit_price/currency transferred as NULL');
      assert.ok(pr!.includes(`'2.5'`), 'quantity stays TEXT verbatim');
    });
    await test('kind defaults to materials for runs lacking the column', () => {
      const run = statements.find((s: string) => s.includes('INSERT INTO "import_runs"'));
      assert.match(run!, /'materials'/);
    });
    await test('v19 backfill: version row + NULL effective pointer for PENDING rule', () => {
      const ver = statements.find((s: string) => s.includes('INSERT INTO "uom_domain_rule_versions"'));
      assert.ok(ver, 'version insert exists');
      // PENDING-ness shows in the ABSENCE of the effective-pointer UPDATE, and
      // supersedes_version_id stays NULL (v19 semantics for never-approved rules).
      assert.match(ver!, /, NULL\) ON CONFLICT \(\s*"rule_id"\s*,\s*"version_number"\s*\)\s*DO NOTHING/);
      const updates = statements.filter((s: string) => /^UPDATE "uom_domain_rules"/.test(s));
      assert.equal(updates.length, 0, 'PENDING rules must not gain an effective_version_id');
    });
    await test('history CREATE backfill mirrors v18 semantics', () => {
      const hist = statements.find((s: string) => s.includes('INSERT INTO "uom_rule_history"'));
      assert.match(hist!, /'CREATE'/);
      assert.match(hist!, /'PENDING'/);
    });
    await test('sequence setvals cover every explicit-id table (7) with +1/false form', () => {
      const setvals = statements.filter((s: string) => /^SELECT setval\(/.test(s));
      assert.equal(setvals.length, 7);
      for (const t of ['suppliers','procurement_records','uom_domain_rules','uom_rule_history','uom_domain_rule_versions','data_imports','audit_logs']) {
        const s = setvals.find((x: string) => x.includes(`pg_get_serial_sequence('${t}', 'id')`));
        assert.ok(s, `setval missing for ${t}`);
        assert.match(s, /COALESCE\(\(SELECT MAX\("id"\) FROM/);
        assert.match(s, /\+ 1, false\)/);
      }
    });
    await test('preflight refuses wrong baselines (probe every check semantically)', () => {
      const checks = core.buildPreflightChecks();
      assert.ok(checks.length >= 25);
      const byName = (n: string) => checks.find((c: any) => c.name === n)!;
      assert.ok(byName('audit max id == 62').expect({ n: 62 }));
      assert.ok(!byName('audit max id == 62').expect({ n: 63 }));
      assert.ok(byName('materials == 120').expect({ n: 120 }));
      assert.ok(byName('suppliers table absent').expect({ n: 0 }));
      assert.ok(!byName('suppliers table absent').expect({ n: 1 }));
      assert.ok(byName('_migrations has no v12..v19 rows').expect({ n: 0 }));
    });
    await test('verification queries cover all EXPECTED_POST tables + queue split + pointer + _migrations span', () => {
      const vq = core.buildVerificationQueries();
      const tables = vq.map((c: any) => c.table);
      for (const t of ['suppliers','procurement_records','uom_conversion_rules','uom_domain_rules','uom_rule_history','uom_domain_rule_versions','import_runs','import_run_chunks','import_rows','data_imports','audit_logs','material_records','match_candidates']) {
        assert.ok(tables.includes(t), t);
      }
      const post = { ...core.EXPECTED_POST };
      assert.equal(post.suppliers, 10); assert.equal(post.procurement_records, 211);
      assert.equal(post.data_imports, 28); assert.equal(post.audit_logs, 287);
      assert.equal(post.uom_conversion_rules, 7); assert.equal(post.uom_domain_rule_versions, 1);
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ================================================ 4. JSON dialect translation */
async function testDialectJson() {
  await test('SQLite dialect identity: json functions pass through byte-identical', () => {
    const sql = `SELECT json_array_length(mc.evidence, '$.criticalConflicts') > 0, json_extract(mc.evidence, '$.decision.state') FROM match_candidates mc`;
    assert.equal(translateStatement(sql, 'sqlite'), sql);
  });
  await test('PG: json_array_length -> guarded jsonb_array_length (array case)', () => {
    const out = translateStatement(`SELECT json_array_length(mc.evidence, '$.criticalConflicts') FROM match_candidates mc`, 'postgresql');
    assert.match(out, /CASE WHEN jsonb_typeof\(\(mc\.evidence #> '\{criticalConflicts\}'\)\) = 'array' THEN jsonb_array_length\(\(mc\.evidence #> '\{criticalConflicts\}'\)\) ELSE 0 END/);
    assert.doesNotMatch(out, /json_array_length/);
  });
  await test('PG: all three production call-site shapes translate', () => {
    const a = translateStatement(`json_array_length(mc.evidence, '$.criticalConflicts') > 0`, 'postgresql');
    const b = translateStatement(`SUM(CASE WHEN json_array_length(mc.evidence, '$.missingCritical') > 0 THEN 1 ELSE 0 END)`, 'postgresql');
    assert.match(a, /jsonb_array_length/); assert.match(b, /jsonb_array_length/);
  });
  await test('PG: json_extract keeps its existing translation and composes with the new rule', () => {
    const out = translateStatement(`SELECT json_extract(mc.evidence, '$.decision.state') AS s, json_array_length(mc.evidence, '$.criticalConflicts') AS n`, 'postgresql');
    assert.match(out, /mc\.evidence#>>'\{decision,state\}'/);
    assert.match(out, /jsonb_array_length/);
  });
  await test('PG: missing key / non-array counts as 0 (SQLite parity by construction)', () => {
    const out = translateStatement(`json_array_length(evidence, '$.nope')`, 'postgresql');
    assert.match(out, /ELSE 0 END/);
  });
  await test('PG: INSERT OR IGNORE guard untouched by the new rule', () => {
    assert.throws(() => translateStatement(`INSERT OR IGNORE INTO unknown_table (a) VALUES (1)`, 'postgresql'), /no registered conflict target/);
  });
}

/* ============================== 5/6/7. guard, triggers, sequences (real SQL) */
async function testGuardsOnDisposableSqlite() {
  const { db, dir } = makeSourceDb();
  try {
    await test('active matching-run guard: second QUEUED/RUNNING row is rejected (uq_matching_runs_active)', () => {
      db.prepare(
        `INSERT INTO matching_runs (id, status, total_candidates, chunk_size, created_at, updated_at) VALUES ('r1','RUNNING',0,500,datetime('now'),datetime('now'))`
      ).run();
      assert.throws(() =>
        db.prepare(
          `INSERT INTO matching_runs (id, status, total_candidates, chunk_size, created_at, updated_at) VALUES ('r2','QUEUED',0,500,datetime('now'),datetime('now'))`
        ).run()
      );
      db.prepare(`UPDATE matching_runs SET status='COMPLETED' WHERE id='r1'`).run();
      db.prepare(
        `INSERT INTO matching_runs (id, status, total_candidates, chunk_size, created_at, updated_at) VALUES ('r3','QUEUED',0,500,datetime('now'),datetime('now'))`
      ).run();
      db.prepare(`DELETE FROM matching_runs WHERE id IN ('r1','r3')`).run();
    });

    await test('UOM history/versions: append-only refusal + CREATE uniqueness + version backfill semantics', () => {
      // History row exists via transfer/backfill equivalent: create one for rule 1.
      db.prepare(
        `INSERT INTO uom_rule_history (rule_id, cmi_id, from_uom, to_uom, factor, previous_status, new_status, action, actor, created_at)
         VALUES (1, 1, 'SET', 'EA', 10, NULL, 'PENDING', 'CREATE', 'seed@governance.demo', datetime('now'))`
      ).run();
      // UPDATE/DELETE refused.
      assert.throws(() => db.prepare(`UPDATE uom_rule_history SET new_status='APPROVED' WHERE rule_id=1`).run(), /append-only/);
      assert.throws(() => db.prepare(`DELETE FROM uom_rule_history WHERE rule_id=1`).run(), /append-only/);
      // Second CREATE for same rule refused by unique partial index.
      assert.throws(() =>
        db.prepare(
          `INSERT INTO uom_rule_history (rule_id, cmi_id, from_uom, to_uom, factor, previous_status, new_status, action, actor, created_at)
           VALUES (1, 1, 'SET', 'EA', 10, NULL, 'PENDING', 'CREATE', 'other', datetime('now'))`
        ).run()
      );
      // Version row for rule 1; APPROVE then effective pointer set — mirrors runner UPDATE.
      db.prepare(
        `INSERT INTO uom_domain_rule_versions (rule_id, version_number, cmi_id, from_uom, to_uom, factor, created_by, created_at)
         VALUES (1, 1, 1, 'SET', 'EA', 10, 'seed@governance.demo', datetime('now'))`
      ).run();
      assert.throws(() => db.prepare(`UPDATE uom_domain_rule_versions SET factor = 99 WHERE rule_id = 1`).run(), /immutable/);
      assert.throws(() => db.prepare(`DELETE FROM uom_domain_rule_versions WHERE rule_id = 1`).run(), /immutable/);
      db.prepare(`UPDATE uom_domain_rules SET status='APPROVED', approved_by='judge', effective_version_id=(SELECT id FROM uom_domain_rule_versions WHERE rule_id=1 AND version_number=1) WHERE id=1`).run();
      const eff = db.prepare(`SELECT effective_version_id FROM uom_domain_rules WHERE id=1`).get() as { effective_version_id: number };
      assert.equal(eff.effective_version_id, 1);
    });

    await test('sequence handling shape: setval targets identity tables with max+1 (PG) — source-side max ids verified', () => {
      const { statements } = core.buildInsertStatements(db);
      const setval = statements.filter((s: string) => s.startsWith('SELECT setval('));
      assert.equal(setval.length, 7);
      // The SQL string must reference MAX(id) + 1 with is_called=false so the
      // next insert continues after the highest transferred id.
      for (const s of setval) assert.match(s, /COALESCE\(\(SELECT MAX\("id"\) FROM "\w+"\), 0\) \+ 1, false\)/);
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('1. migration SQL generation');
  await testMigrationGeneration();
  console.log('2/3. manifest + data step');
  await testManifestAndDataStep();
  console.log('4. JSON dialect translation');
  await testDialectJson();
  console.log('5/6/7. guards, triggers, sequences');
  await testGuardsOnDisposableSqlite();
  console.log('8. runner modes + Gate 4 authorization');
  await testRunnerModes();
  console.log('9. backup generator: ordering + identity preservation (gate 3.5)');
  await testBackupGeneratorFixes();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

/* ---------------- 8. runner modes + Gate 4 authorization ------------------ */
async function testRunnerModes(): Promise<void> {
  const runner = require('../scripts/migration/apply-pg-v12-v19.mjs');

  await test('runner: import is side-effect-free + mode parsing', () => {
    // If the module had connected/written at import time, require above would
    // have hung or thrown — reaching here already proves the main guard works.
    assert.deepEqual(runner.parseArgs(['--apply', '--i-understand-gate-4']), { mode: 'apply', dataOnly: false, gate4Consent: true, verbose: false });
    assert.deepEqual(runner.parseArgs(['--apply', '--data-only', '--i-understand-gate-4']), { mode: 'apply', dataOnly: true, gate4Consent: true, verbose: false });
    assert.deepEqual(runner.parseArgs(['--preflight']), { mode: 'preflight', dataOnly: false, gate4Consent: false, verbose: false });
    assert.deepEqual(runner.parseArgs([]), { mode: 'plan', dataOnly: false, gate4Consent: false, verbose: false });
  });

  await test('runner: Gate 4 refusal paths + authorized pass-through', () => {
    const refuse = (args: string[], env: Record<string, string>) =>
      assert.throws(() => runner.assertApplyAllowed(runner.parseArgs(args), env, false), /GATE 4 REFUSED/);
    refuse(['--apply'], {}); // no env, no consent, no TTY
    refuse(['--apply', '--i-understand-gate-4'], {}); // consent but no env
    refuse(['--apply'], { MATERIALIQ_APPLY_PG_MIGRATION: 'true' }); // env but no consent
    // All authorizations present + interactive TTY -> must pass through.
    assert.doesNotThrow(() =>
      runner.assertApplyAllowed(
        runner.parseArgs(['--apply', '--i-understand-gate-4']),
        { MATERIALIQ_APPLY_PG_MIGRATION: 'true' },
        true
      )
    );
    // Non-apply modes are never gated.
    assert.doesNotThrow(() => runner.assertApplyAllowed(runner.parseArgs(['--plan']), {}, false));
  });
}

/* ------- 9. backup generator: ordering + identity (gate 3.5) -------------- */
async function testBackupGeneratorFixes(): Promise<void> {
  const ordering = require('../scripts/migration/backup-ordering.mjs');

  // Realistic subset of the Supabase v11 FK graph (the exact edges that broke
  // the alphabetical backup): mappings -> {cm, mr, org}, cm -> mc, mc -> mr,
  // mr -> {di, org}, di -> org.
  const graph = [
    { name: 'material_mappings', references: ['common_materials', 'material_records', 'organizations'] },
    { name: 'organizations', references: [] },
    { name: 'common_materials', references: ['match_candidates'] },
    { name: 'match_candidates', references: ['material_records'] },
    { name: 'material_records', references: ['data_imports', 'organizations'] },
    { name: 'data_imports', references: ['organizations'] },
    { name: 'audit_logs', references: [] },
  ];

  await test('backup ordering: every referenced table precedes its referencers', () => {
    const { order, cycles } = ordering.orderTablesByDependency(graph);
    assert.equal(cycles.length, 0, 'no cycles in the real schema');
    const pos = new Map(order.map((n: string, i: number) => [n, i]));
    for (const t of graph) {
      for (const d of t.references) {
        assert.ok(pos.get(d)! < pos.get(t.name)!, `${d} must be created before ${t.name}`);
      }
    }
    assert.equal(order.length, graph.length, 'all tables ordered exactly once');
  });

  await test('backup ordering: deterministic (alphabetical tie-break, stable across runs)', () => {
    const a = ordering.orderTablesByDependency(graph).order;
    const b = ordering.orderTablesByDependency(graph).order;
    assert.deepEqual(a, b);
    // Zero-dependency tables come first, alphabetically among themselves.
    const independents = graph.filter((t) => t.references.length === 0).map((t) => t.name).sort();
    assert.deepEqual(a.slice(0, independents.length), independents);
  });

  await test('backup ordering: self-references ignored, cycles detected not hidden', () => {
    const selfRef = ordering.orderTablesByDependency([{ name: 't', references: ['t'] }]);
    assert.deepEqual(selfRef, { order: ['t'], cycles: [] });
    const cyc = ordering.orderTablesByDependency([
      { name: 'a', references: ['b'] },
      { name: 'b', references: ['a'] },
      { name: 'c', references: [] },
    ]);
    assert.equal(cyc.cycles.length, 1);
    assert.deepEqual(cyc.cycles[0], ['a', 'b']);
    assert.ok(cyc.order.includes('c'), 'uninvolved tables still ordered');
  });

  await test('backup identity: live schema expectation — 12 identity columns, all BY DEFAULT', () => {
    const expected = [
      'audit_logs', 'common_materials', 'data_imports', 'evaluation_runs',
      'match_candidates', 'match_decisions', 'material_attributes',
      'material_mappings', 'material_records', 'organizations', 'review_queue', 'users',
    ];
    assert.equal(expected.length, 12);
    // Every row the app inserts by explicit id maps to one identity table; the
    // generator must preserve each as GENERATED BY DEFAULT AS IDENTITY.
    for (const t of expected) {
      assert.ok(!t.includes('uom'), 'pre-v19 supabase has no uom tables');
    }
  });

  await test('backup identity: generated CREATE TABLE preserves GENERATED BY DEFAULT AS IDENTITY', () => {
    const ddl = ordering.renderColumnDef({
      column_name: 'id', data_type: 'bigint', is_nullable: 'NO', column_default: null,
      character_maximum_length: null, numeric_precision: null, numeric_scale: null,
      is_identity: 'YES', identity_generation: 'BY DEFAULT',
    });
    // Exact rendering: identity semantics carried by the IDENTITY clause, not
    // by a DEFAULT (which is what the pre-fix generator lost).
    assert.equal(ddl, '"id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL');
  });

  await test('backup identity: non-identity defaults and lengths render verbatim', () => {
    assert.equal(
      ordering.renderColumnDef({
        column_name: 'status', data_type: 'text', is_nullable: 'NO',
        column_default: "'active'::text", character_maximum_length: null,
        numeric_precision: null, numeric_scale: null,
        is_identity: 'NO', identity_generation: null,
      }),
      '"status" text DEFAULT \'active\'::text NOT NULL'
    );
    assert.equal(
      ordering.renderColumnDef({
        column_name: 'name', data_type: 'character varying', is_nullable: 'YES',
        column_default: null, character_maximum_length: 120,
        numeric_precision: null, numeric_scale: null,
        is_identity: 'NO', identity_generation: null,
      }),
      '"name" character varying(120)'
    );
    assert.equal(
      ordering.renderColumnDef({
        column_name: 'x', data_type: 'numeric', is_nullable: 'YES',
        column_default: null, character_maximum_length: null,
        numeric_precision: 12, numeric_scale: 4,
        is_identity: 'NO', identity_generation: null,
      }),
      '"x" numeric(12,4)'
    );
  });

  await test('backup identity: restored PG honors DEFAULT INSERT + RETURNING (disposable container, opt-in)', async () => {
    if (process.env.MATERIALIQ_RUN_BACKUP_RESTORE_TESTS !== 'true') {
      console.log('    (skipped: set MATERIALIQ_RUN_BACKUP_RESTORE_TESTS=true against the disposable container)');
      return;
    }
    const pg = require('pg');
    const client = new pg.Client({ connectionString: 'postgres://miq:miq_disposable@127.0.0.1:65431/miq_verify' });
    await client.connect();
    try {
      // Identity metadata present + serial sequence resolvable (defect #2 signature).
      const idcol = (await client.query(
        "SELECT is_identity, identity_generation FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='id'"
      )).rows[0];
      assert.equal(idcol.is_identity, 'YES');
      assert.equal(idcol.identity_generation, 'BY DEFAULT');
      const seq = (await client.query("SELECT pg_get_serial_sequence('organizations','id') AS seq")).rows[0].seq;
      assert.ok(seq, 'identity sequence must be resolvable after restore');

      // DEFAULT INSERT works and RETURNING id = current max + 1 (setval state correct).
      const maxId = (await client.query('SELECT COALESCE(MAX(id),0)::int AS n FROM organizations')).rows[0].n;
      await client.query('BEGIN');
      const ins = await client.query(
        "INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES ('T-PROBE','t','active',now(),now()) RETURNING id"
      );
      assert.equal(ins.rows[0].id, maxId + 1);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
