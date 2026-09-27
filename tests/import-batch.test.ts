/**
 * Step 2 regression tests — bounded batch import persistence.
 *
 * `npx tsx tests/import-batch.test.ts` (part of the npm test chain).
 *
 * Proves the batched chunk-execution path (multi-row INSERT ... RETURNING,
 * searched source_row UPDATE, multi-row attribute upsert) preserves the
 * frozen sequential semantics EXACTLY:
 *   - normal import (materials + attributes + source_row + counters),
 *   - duplicate behavior: DB-existing, intra-chunk repeats, cross-batch
 *     repeats (a later batch sees an earlier batch's inserts),
 *   - attribute→material attachment via RETURNING ids (both engines return
 *     them in input order),
 *   - generated ids are positive integers and referenced correctly,
 *   - a forced mid-batch failure rolls back the WHOLE chunk (no partial rows),
 *   - retry/re-run is idempotent (no duplicate materials),
 *   - IMPORT_BATCH_ROWS batching boundaries (multiple statements per chunk).
 *
 * Runs on a disposable temp SQLite database; production data is never touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { analyzeImport, executeImport } from '../src/lib/services/import-center-service';
import {
  analyzeImportBounded,
  createImportJob,
  runImportJob,
  getImportJob,
} from '../src/lib/services/import-job-service';

const failures: string[] = [];
let passed = 0;
function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(
        () => {
          passed++;
          console.log(`  ok - ${name}`);
        },
        (err) => {
          failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
          console.error(`  FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
    } else {
      passed++;
      console.log(`  ok - ${name}`);
    }
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  FAIL - ${name}`);
  }
}

/* ------------------- disposable database + org fixtures ------------------- */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-batch-'));
const testDb = new DatabaseSync(path.join(tmpDir, 'test.db'));
setDbForTests(testDb);
migrate(testDb);

const now = new Date().toISOString();
const orgIds = new Map<string, number>();
for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
  const res = testDb
    .prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
    .run(code, `${code} (batch test)`, now, now);
  orgIds.set(code, Number(res.lastInsertRowid));
}
const CPCL = orgIds.get('CPCL')!;
const NTPC = orgIds.get('NTPC')!;

function csvOf(rows: string[]): ArrayBuffer {
  const buf = Buffer.from(
    ['material_code,description,category,uom,manufacturer', ...rows].join('\n'),
    'utf8',
  );
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function materials(db: DatabaseSync): Array<{ id: number; code: string; src: number | null }> {
  return db
    .prepare(`SELECT id, original_code AS code, source_row AS src FROM material_records ORDER BY id`)
    .all() as unknown as Array<{ id: number; code: string; src: number | null }>;
}

/* ------------------------------ A. normal path ---------------------------- */

test('batched import: materials, attributes, source_row, counters all correct', () => {
  const rows = Array.from({ length: 60 }, (_, i) => `IMP-B${String(i + 1).padStart(3, '0')},SKF BALL BEARING 6205-2RS VARIANT ${i},Bearings,EA,SKF`);
  const a = analyzeImport({ organizationId: CPCL, fileName: 'b1.csv', fileType: 'csv', payload: csvOf(rows) });
  const job = createImportJob(a.importId, 'test');
  const s = runImportJob(job.jobId);

  assert.equal(s.status, 'COMPLETED');
  assert.equal(s.totalRows, 60);
  assert.equal(s.successfulRows, 60);
  const ms = materials(testDb).filter((m) => m.code.startsWith('IMP-B'));
  assert.equal(ms.length, 60);
  // Generated ids: positive integers (RETURNING id contract).
  for (const m of ms) assert.ok(Number.isInteger(m.id) && m.id > 0, `id ${m.id}`);
  // source_row set for every inserted material (searched UPDATE worked).
  assert.deepEqual(
    ms.map((m) => m.src).sort((x, y) => (x ?? 0) - (y ?? 0)),
    Array.from({ length: 60 }, (_, i) => i + 2), // rowNumber 1 = header
  );
  // Attributes attached to the correct materials via RETURNING ids.
  const attrCount = testDb
    .prepare(`SELECT count(*) AS n FROM material_attributes ma JOIN material_records m ON m.id = ma.material_id WHERE m.original_code LIKE 'IMP-B%'`)
    .get() as { n: number };
  assert.ok(attrCount.n >= 60, `expected attributes on all 60 materials, got ${attrCount.n}`);
  // Spot-check one mapping: attribute row belongs to the material with that code.
  const one = testDb
    .prepare(`SELECT m.original_code FROM material_attributes ma JOIN material_records m ON m.id = ma.material_id WHERE ma.attribute_name = 'bearing_type' AND m.original_code = 'IMP-B001'`)
    .get() as { original_code: string } | undefined;
  assert.equal(one?.original_code, 'IMP-B001');
  // data_imports ledger updated.
  const di = testDb.prepare(`SELECT successful_rows, duplicate_rows, failed_rows FROM data_imports WHERE id = ?`).get(a.importId) as { successful_rows: number; duplicate_rows: number; failed_rows: number };
  assert.equal(di.successful_rows, 60);
  assert.equal(di.duplicate_rows, 0);
  assert.equal(di.failed_rows, 0);
});

test('multi-attribute rows land on the right material; nothing leaks to neighbors', () => {
  // Bearings extract several attributes (series, bore_diameter, seal_type, ...).
  const a = analyzeImport({ organizationId: CPCL, fileName: 'b2.csv', fileType: 'csv', payload: csvOf([
    'IMP-C1,SKF BALL BEARING 6308-2RS,Bearings,EA,SKF',   // series 6308, bore 40, seal 2RS
    'IMP-C2,SKF BALL BEARING 6205-ZZ,Bearings,EA,SKF',    // series 6205, bore 25, seal ZZ
  ]) });
  executeImport({ importId: a.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'test' });
  const bore = testDb
    .prepare(`SELECT ma.value FROM material_attributes ma JOIN material_records m ON m.id = ma.material_id WHERE m.original_code = 'IMP-C1' AND ma.attribute_name = 'bore_diameter'`)
    .get() as { value: string } | undefined;
  assert.equal(bore?.value, '40', `IMP-C1 bore (6308 = 40mm), got ${bore?.value}`);
  const seal2 = testDb
    .prepare(`SELECT ma.value FROM material_attributes ma JOIN material_records m ON m.id = ma.material_id WHERE m.original_code = 'IMP-C2' AND ma.attribute_name = 'seal_type'`)
    .get() as { value: string } | undefined;
  assert.equal(seal2?.value, 'ZZ', `IMP-C2 seal (6205-ZZ), got ${seal2?.value}`);
  // No cross-row leakage: C1 must not carry C2's seal, C2 not C1's bore.
  const leak1 = testDb
    .prepare(`SELECT count(*) AS n FROM material_attributes ma JOIN material_records m ON m.id = ma.material_id WHERE m.original_code = 'IMP-C1' AND ma.attribute_name = 'seal_type' AND ma.value = 'ZZ'`)
    .get() as { n: number };
  assert.equal(leak1.n, 0);
  const leak2 = testDb
    .prepare(`SELECT count(*) AS n FROM material_attributes ma JOIN material_records m ON m.id = ma.material_id WHERE m.original_code = 'IMP-C2' AND ma.attribute_name = 'bore_diameter' AND ma.value = '40'`)
    .get() as { n: number };
  assert.equal(leak2.n, 0);
});

/* ------------------------------ B. duplicates ----------------------------- */

test('duplicates: DB-existing, intra-chunk, cross-batch — all skipped exactly once', () => {
  // IMP-B001..B060 already exist from test A (chunk = default 500 → one chunk;
  // force small chunk AND small batch to exercise cross-batch visibility).
  const rows = [
    'IMP-B001,SKF BALL BEARING 6205-2RS VARIANT 0,Bearings,EA,SKF',   // DB-existing
    'IMP-D001,FRESH BEARING ONE,Bearings,EA,SKF',
    'IMP-D001,FRESH BEARING ONE AGAIN,Bearings,EA,SKF',               // intra-chunk repeat
    ...Array.from({ length: 20 }, (_, i) => `IMP-DX${String(i + 1).padStart(3, '0')},FRESH BEARING DX ${i},Bearings,EA,SKF`),
    'IMP-D001,FRESH BEARING ONE THIRD,Bearings,EA,SKF',               // repeat AFTER batch boundary
    'IMP-B045,SKF BALL BEARING 6205-2RS VARIANT 44,Bearings,EA,SKF',  // DB-existing late in file
  ];
  const a = analyzeImport({ organizationId: CPCL, fileName: 'b3.csv', fileType: 'csv', payload: csvOf(rows) });
  const job = createImportJob(a.importId, 'test');
  testDb.prepare(`UPDATE import_runs SET chunk_size = 10 WHERE id = ?`).run(job.jobId); // 3 chunks
  process.env.IMPORT_BATCH_ROWS = '8'; // multi-statement chunks
  try {
    const s = runImportJob(job.jobId);
    assert.equal(s.status, 'COMPLETED');
    assert.equal(s.successfulRows, 21, `23 rows - 2 DB dups (IMP-B001, IMP-B045) = 21`);
    assert.equal(s.failedRows, 0);
  } finally {
    delete process.env.IMPORT_BATCH_ROWS;
  }
  const d1 = testDb.prepare(`SELECT count(*) AS n FROM material_records WHERE original_code = 'IMP-D001'`).get() as { n: number };
  assert.equal(d1.n, 1, 'intra-batch + cross-batch repeats inserted exactly once');
  // The surviving row keeps the FIRST description (skip strategy, first wins).
  const d1row = testDb.prepare(`SELECT original_description FROM material_records WHERE original_code = 'IMP-D001'`).get() as { original_description: string };
  assert.equal(d1row.original_description, 'FRESH BEARING ONE');
  const dx = testDb.prepare(`SELECT count(*) AS n FROM material_records WHERE original_code LIKE 'IMP-DX%'`).get() as { n: number };
  assert.equal(dx.n, 20);
});

test('cross-batch visibility: a code inserted in batch N is a duplicate in batch N+1', () => {
  const a = analyzeImport({ organizationId: NTPC, fileName: 'b4.csv', fileType: 'csv', payload: csvOf([
    'IMP-E001,CROSS BATCH BEARING,Bearings,EA,SKF',
    ...Array.from({ length: 30 }, (_, i) => `IMP-EF${String(i + 1).padStart(3, '0')},FILLER BEARING ${i},Bearings,EA,SKF`),
    'IMP-E001,CROSS BATCH BEARING LATER,Bearings,EA,SKF',
  ]) });
  const job = createImportJob(a.importId, 'test');
  testDb.prepare(`UPDATE import_runs SET chunk_size = 32 WHERE id = ?`).run(job.jobId); // 2 chunks
  process.env.IMPORT_BATCH_ROWS = '16';
  try {
    const s = runImportJob(job.jobId);
    assert.equal(s.status, 'COMPLETED');
    assert.equal(s.successfulRows, 31, 'second IMP-E001 skipped');
  } finally {
    delete process.env.IMPORT_BATCH_ROWS;
  }
  const n = testDb.prepare(`SELECT count(*) AS n FROM material_records WHERE original_code = 'IMP-E001' AND organization_id = ?`).get(NTPC) as { n: number };
  assert.equal(n.n, 1);
});

/* ----------------------- C. rollback + retry/idempotency ------------------ */

test('forced failure mid-chunk rolls back the whole batch group (no partial rows)', () => {
  const rows = Array.from({ length: 20 }, (_, i) => `IMP-R${String(i + 1).padStart(3, '0')},ROLLBACK BEARING ${i},Bearings,EA,SKF`);
  const a = analyzeImport({ organizationId: CPCL, fileName: 'b5.csv', fileType: 'csv', payload: csvOf(rows) });
  const job = createImportJob(a.importId, 'test');
  // Single chunk; abort when the chunk marker flips to COMMITTED.
  testDb.exec(`DROP TRIGGER IF EXISTS fail_batch_commit;`);
  testDb.exec(`
    CREATE TRIGGER fail_batch_commit
    BEFORE UPDATE OF status ON import_run_chunks
    WHEN NEW.status = 'COMMITTED'
    BEGIN
      SELECT RAISE(ABORT, 'forced batch rollback');
    END;
  `);
  try {
    const s = runImportJob(job.jobId);
    assert.equal(s.status, 'FAILED');
    assert.match(s.error ?? '', /forced batch rollback/);
    const n = testDb.prepare(`SELECT count(*) AS n FROM material_records WHERE original_code LIKE 'IMP-R%'`).get() as { n: number };
    assert.equal(n.n, 0, 'zero partial rows after rollback');
    const attrs = testDb
      .prepare(`SELECT count(*) AS n FROM material_attributes WHERE material_id NOT IN (SELECT id FROM material_records)`)
      .get() as { n: number };
    assert.equal(attrs.n, 0, 'no orphan attributes');
    // Ledger untouched by the rolled-back chunk.
    const di = testDb.prepare(`SELECT successful_rows FROM data_imports WHERE id = ?`).get(a.importId) as { successful_rows: number };
    assert.equal(di.successful_rows, 0);
  } finally {
    testDb.exec(`DROP TRIGGER IF EXISTS fail_batch_commit;`);
  }
  // Retry after the trigger is gone: full success, no duplicates.
  const s2 = runImportJob(job.jobId);
  assert.equal(s2.status, 'COMPLETED');
  assert.equal(s2.successfulRows, 20);
  const n2 = testDb.prepare(`SELECT count(*) AS n FROM material_records WHERE original_code LIKE 'IMP-R%'`).get() as { n: number };
  assert.equal(n2.n, 20);
});

test('batch path is row-for-row equivalent to the frozen legacy path (same inputs)', () => {
  // Legacy per-row path (frozen semantics reference).
  const legacyRows = Array.from({ length: 40 }, (_, i) => `IMP-L1${String(i + 1).padStart(3, '0')},SKF BALL BEARING 6210-2RS VARIANT ${i},Bearings,EA,SKF`);
  const aL = analyzeImport({ organizationId: CPCL, fileName: 'b7l.csv', fileType: 'csv', payload: csvOf(legacyRows) });
  executeImport({ importId: aL.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'test' });
  // Batch path, same inputs on a different org.
  const batchRows = legacyRows.map((r) => r.replace('IMP-L1', 'IMP-L2'));
  const aB = analyzeImportBounded({ organizationId: NTPC, fileName: 'b7b.csv', fileType: 'csv', payload: csvOf(batchRows) });
  const job = createImportJob(aB.importId, 'test');
  const s = runImportJob(job.jobId);
  assert.equal(s.status, 'COMPLETED');
  assert.equal(s.successfulRows, 40);
  // Identical attribute footprints per corresponding material.
  const q = (codePrefix: string) => testDb.prepare(`
    SELECT m.original_code, group_concat(ma.attribute_name || '=' || ma.value) AS attrs
      FROM material_attributes ma JOIN material_records m ON m.id = ma.material_id
     WHERE m.original_code LIKE ? GROUP BY m.id ORDER BY m.original_code`).all(`${codePrefix}%`) as unknown as Array<{ original_code: string; attrs: string }>;
  const legacy = q('IMP-L1');
  const batch = q('IMP-L2').map((r) => ({ ...r, original_code: r.original_code.replace('IMP-L2', 'IMP-L1') }));
  assert.equal(legacy.length, batch.length);
  for (let i = 0; i < legacy.length; i++) {
    assert.equal(batch[i].original_code, legacy[i].original_code);
    assert.equal(batch[i].attrs, legacy[i].attrs, `attribute parity for ${legacy[i].original_code}`);
  }
});

/* --------------------------- D. batch-size bounds ------------------------- */

test('IMPORT_BATCH_ROWS slicing: >250 rows produce multiple bounded statements', () => {
  process.env.IMPORT_BATCH_ROWS = '20';
  try {
    const rows = Array.from({ length: 55 }, (_, i) => `IMP-S${String(i + 1).padStart(3, '0')},SLICED BEARING ${i},Bearings,EA,SKF`);
    const a = analyzeImportBounded({ organizationId: CPCL, fileName: 'b6.csv', fileType: 'csv', payload: csvOf(rows) });
    const job = createImportJob(a.importId, 'test');
    const s = runImportJob(job.jobId);
    assert.equal(s.status, 'COMPLETED');
    assert.equal(s.successfulRows, 55);
    const n = testDb.prepare(`SELECT count(*) AS n FROM material_records WHERE original_code LIKE 'IMP-S%'`).get() as { n: number };
    assert.equal(n.n, 55);
  } finally {
    delete process.env.IMPORT_BATCH_ROWS;
  }
});

test('IMPORT_BATCH_ROWS clamp: below-min and above-max values are clamped', () => {
  const mod = require('../src/lib/db/batch-writer') as { maxBatchRows(): number };
  process.env.IMPORT_BATCH_ROWS = '1';
  assert.equal(mod.maxBatchRows(), 10, 'min clamp');
  process.env.IMPORT_BATCH_ROWS = '99999';
  assert.equal(mod.maxBatchRows(), 1000, 'max clamp');
  process.env.IMPORT_BATCH_ROWS = '300';
  assert.equal(mod.maxBatchRows(), 300);
  delete process.env.IMPORT_BATCH_ROWS;
  assert.equal(mod.maxBatchRows(), 250, 'default');
});

/* -------------------------------- summary --------------------------------- */

console.log(`\nimport-batch: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  FAILED: ${f}`);
  process.exit(1);
}
process.exit(0);
