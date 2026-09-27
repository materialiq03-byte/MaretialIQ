/**
 * Import workflow tests — `npx tsx tests/import.test.ts`.
 * Covers the required cases: valid CSV/XLSX, missing columns, missing row
 * values, duplicates (file + database), optional missing, invalid UOM,
 * empty file, all-invalid, mixed, successful import, history, re-upload.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { suggestMapping, mappingIsUsable, validateRows } from '../src/lib/services/import-validation';
import { analyzeImport, executeImport } from '../src/lib/services/import-center-service';
import { parseImportFile } from '../src/lib/services/file-parse-service';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('async test harness not supported here');
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  FAIL - ${name}`);
  }
}

/* --------------------------------- setup ---------------------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-import-test-'));
const db = new DatabaseSync(path.join(tmp, 'test.db'));
db.exec('PRAGMA foreign_keys = ON');
setDbForTests(db);
migrate(db);

db.prepare(`INSERT INTO organizations (code, name) VALUES ('CPCL', 'Test CPCL')`).run();
const orgId = Number(db.prepare(`SELECT id FROM organizations WHERE code='CPCL'`).get()!.id);

const CSV = (rows: string[]) => rows.join('\n');
const HEADER = 'material_code,description,category,uom,manufacturer';
const read = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'samples', name));

/* ------------------------- 1. valid CSV analysis -------------------------- */

test('valid CSV parses with correct mapping', () => {
  const csv = CSV([HEADER, 'CP-9001,SKF BALL BEARING 6205-2RS,Bearings,EA,SKF']);
  const out = analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv });
  assert.equal(out.mappingUsable, true);
  assert.equal(out.mapping.originalCode, 'material_code');
  assert.equal(out.mapping.originalDescription, 'description');
});

/* -------------------------- 2. valid XLSX parse --------------------------- */

test('valid XLSX parses with correct mapping', () => {
  const parsed = parseImportFile('sample-import-ntpc.xlsx', new Uint8Array(read('sample-import-ntpc.xlsx')).buffer);
  assert.equal(parsed.rows.length, 3);
  const s = suggestMapping(parsed.headers);
  assert.equal(s.mapping.originalCode, 'material_code');
  assert.equal(s.mapping.originalDescription, 'description');
});

/* --------------------- 3. missing material_code column -------------------- */

test('missing material_code column blocks validation', () => {
  const csv = CSV(['description,uom', 'SKF BEARING 6205,EA']);
  const out = analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv });
  assert.equal(out.mappingUsable, false);
  assert.equal(out.mapping.originalCode, null);
});

/* ---------------------- 4. missing description column --------------------- */

test('missing description column blocks validation', () => {
  const csv = CSV(['material_code,uom', 'CP-9002,EA']);
  const out = analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv });
  assert.equal(out.mappingUsable, false);
});

/* ---------------------- 5. missing code in a row -------------------------- */

test('row with missing material code is an ERROR', () => {
  const csv = CSV([HEADER, ',SKF BEARING 6207,Bearings,EA,']);
  const out = analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv });
  const row = out.validation.rows[0];
  assert.equal(row.severity, 'ERROR');
  assert.ok(row.problems.some((p) => p.rule === 'required_material_code'));
});

/* ------------------- 6. missing description in a row ---------------------- */

test('row with missing description is an ERROR', () => {
  const csv = CSV([HEADER, 'CP-9003,,Bearings,EA,']);
  const out = analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv });
  assert.ok(out.validation.rows[0].problems.some((p) => p.rule === 'required_description'));
});

/* ------------------- 7. duplicate code inside the file -------------------- */

test('duplicate code within the file is an ERROR on the second row', () => {
  const csv = CSV([
    HEADER,
    'CP-9004,SKF BEARING 6205-2RS,Bearings,EA,',
    'CP-9004,DUPLICATE BEARING,Bearings,EA,',
  ]);
  const out = analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv });
  const dup = out.validation.rows.find((r) => r.problems.some((p) => p.rule === 'duplicate_in_file'));
  assert.ok(dup, 'expected a duplicate_in_file problem');
  assert.equal(dup!.rowNumber, 3);
  assert.equal(out.validation.summary.duplicateInFile, 1);
});

/* ------------------- 8. duplicate code in the database -------------------- */

test('duplicate code already in database is detected', () => {
  // First import creates CP-9005.
  const csv1 = CSV([HEADER, 'CP-9005,SKF BALL BEARING 6205-2RS,Bearings,EA,SKF']);
  const a1 = analyzeImport({ organizationId: orgId, fileName: 't1.csv', fileType: 'csv', payload: csv1 });
  executeImport({ importId: a1.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'test' });
  // Second upload with the same code.
  const csv2 = CSV([HEADER, 'CP-9005,ANOTHER BEARING TEXT,Bearings,EA,SKF']);
  const a2 = analyzeImport({ organizationId: orgId, fileName: 't2.csv', fileType: 'csv', payload: csv2 });
  const row = a2.validation.rows.find((r) => !r.empty)!;
  assert.ok(row.problems.some((p) => p.rule === 'duplicate_in_database'));
  assert.equal(row.duplicateOf?.originalCode, 'CP-9005');
});

/* ------------------- 9. optional fields missing = warning ------------------ */

test('missing optional manufacturer is a WARNING, not an error', () => {
  const csv = CSV([HEADER, 'CP-9006,GATE VALVE SLAB 6IN 600# RTJ,Valves,EA,']);
  const out = analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv });
  const row = out.validation.rows[0];
  assert.equal(row.severity, 'WARNING');
  assert.ok(row.problems.some((p) => p.rule === 'optional_manufacturer_missing'));
});

/* --------------------------- 10. invalid UOM ------------------------------- */

test('unknown UOM is a WARNING with the value preserved', () => {
  const csv = CSV([HEADER, 'CP-9007,CENTRIFUGAL PUMP 8X6-11,Pumps,BAG,KSB']);
  const out = analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv });
  const row = out.validation.rows[0];
  assert.ok(row.problems.some((p) => p.rule === 'unknown_uom' && p.severity === 'WARNING'));
  assert.equal(row.severity, 'WARNING');
});

/* ---------------------------- 11. empty file ------------------------------- */

test('empty file (header only) is rejected with a clear message', () => {
  const csv = CSV([HEADER]);
  assert.throws(
    () => analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv }),
    /no data rows/i
  );
});

/* -------------------------- 12. all rows invalid --------------------------- */

test('all rows invalid: validation completes, zero importable', () => {
  const csv = CSV([HEADER, ',BEARING NO CODE,Bearings,EA,', 'CP-9008,,Valves,EA,']);
  const out = analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv });
  assert.equal(out.validation.summary.errors, 2);
  assert.equal(out.validation.summary.valid, 0);
  // Execution must refuse to write anything.
  const res = executeImport({ importId: out.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'test' });
  assert.equal(res.imported, 0);
  const count = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM material_records WHERE organization_id=?`).get(orgId)!.n
  );
  assert.ok(count >= 1); // only the earlier CP-9005 exists
});

/* ----------------------- 13. mixed valid/invalid rows ---------------------- */

test('mixed file: invalid rows excluded, valid rows importable', () => {
  const csv = CSV([
    HEADER,
    'CP-9010,SKF BALL BEARING 6205-2RS,Bearings,EA,SKF',   // valid
    ',NO CODE HERE,Bearings,EA,',                            // error
    'CP-9011,GATE VALVE 6IN 600# RTJ,Valves,BAG,AUDCO',      // warning (UOM)
  ]);
  const out = analyzeImport({ organizationId: orgId, fileName: 't.csv', fileType: 'csv', payload: csv });
  assert.equal(out.validation.summary.valid, 1);
  assert.equal(out.validation.summary.warnings, 1);
  assert.equal(out.validation.summary.errors, 1);
  const res = executeImport({ importId: out.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'test' });
  assert.equal(res.imported, 2); // valid + warning row
  assert.equal(res.excludedInvalid, 1);
  // The excluded row must NOT exist.
  const missing = db.prepare(`SELECT id FROM material_records WHERE original_code='CP-9010'`).get();
  assert.ok(missing, 'valid row imported');
  const none = db
    .prepare(`SELECT COUNT(*) AS n FROM material_records WHERE original_description='NO CODE HERE'`)
    .get()!.n;
  assert.equal(none, 0, 'invalid row must never enter the master');
});

/* ---------------------- 14. full pipeline on import ------------------------ */

test('imported rows run through the pipeline (normalize/extract/quality)', () => {
  const row = db
    .prepare(`SELECT * FROM material_records WHERE original_code='CP-9010'`)
    .get() as { normalized_description: string; processing_status: string; quality_status: string | null };
  assert.equal(row.normalized_description, 'SKF BALL BEARING 6205-2RS');
  assert.equal(row.processing_status, 'attributes_extracted');
  assert.equal(row.quality_status, 'good');
  const attrs = db
    .prepare(
      `SELECT attribute_name FROM material_attributes ma JOIN material_records m ON m.id=ma.material_id
        WHERE m.original_code='CP-9010' AND ma.attribute_name='seal_type'`
    )
    .all();
  assert.equal(attrs.length, 1);
});

/* ------------------------- 15. import history rows ------------------------- */

test('import history records the workflow', () => {
  const rows = db
    .prepare(`SELECT file_name, workflow_status, imported_rows FROM data_imports ORDER BY id`)
    .all() as Array<{ file_name: string; workflow_status: string; imported_rows: number }>;
  assert.ok(rows.length >= 4);
  const completed = rows.filter((r) => r.workflow_status === 'completed' || r.workflow_status === 'completed_with_warnings');
  assert.ok(completed.length >= 3);
});

/* --------------------------- 16. re-upload behavior ------------------------ */

test('re-uploading the same file: codes detected as duplicates, skip strategy imports nothing', () => {
  const csv = CSV([HEADER, 'CP-9010,SKF BALL BEARING 6205-2RS,Bearings,EA,SKF']);
  const out = analyzeImport({ organizationId: orgId, fileName: 'reupload.csv', fileType: 'csv', payload: csv });
  const row = out.validation.rows.find((r) => !r.empty)!;
  assert.ok(row.problems.some((p) => p.rule === 'duplicate_in_database'));
  const res = executeImport({ importId: out.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'test' });
  assert.equal(res.imported, 0);
  assert.equal(res.skippedExisting, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
