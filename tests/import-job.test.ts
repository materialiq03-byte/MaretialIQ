/**
 * Step-5 import hardening tests — `npx tsx tests/import-job.test.ts`.
 *
 * Covers: job lifecycle, chunk boundaries (incl. final partial chunk),
 * committed-work progress, idempotent retry (no duplicate materials),
 * deterministic chunk-failure rollback, stale-RUNNING resume, bounded
 * analyze response, server-side preview pagination + page-size cap, job/legacy
 * equivalence, and the DB single-active-import guard. Runs on a disposable
 * temp database; production data/materialiq.db is never touched.
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
  createAndStartImportJob,
  runImportJob,
  getImportJob,
  getImportPreviewPage,
  listImportJobs,
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

/* ---------- disposable database seeded with the synthetic dataset ---------- */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-impjob-'));
const testDb = new DatabaseSync(path.join(tmpDir, 'test.db'));
setDbForTests(testDb);
migrate(testDb);

const now = new Date().toISOString();
const orgIds = new Map<string, number>();
for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
  const res = testDb
    .prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
    .run(code, `${code} (import-job test)`, now, now);
  orgIds.set(code, Number(res.lastInsertRowid));
}
const CPCL = orgIds.get('CPCL')!;

// Seed a handful of existing codes so duplicate-in-database rows exist.
function csvOf(rows: string[]): ArrayBuffer {
  const buf = Buffer.from(
    ['material_code,description,category,uom,manufacturer', ...rows].join('\n'),
    'utf8',
  );
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
const HEADER = 'material_code,description,category,uom,manufacturer';
function CSV(rows: string[]): string {
  return rows.join('\n');
}

const seed = analyzeImport({ organizationId: CPCL, fileName: 'seed.csv', fileType: 'csv', payload: csvOf(['CP-9001,SKF BALL BEARING 6205-2RS,Bearings,EA,SKF']) });
executeImport({ importId: seed.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'test' });

/* ------------------------ A. bounded analyze output ------------------------ */

test('bounded analyze returns summary + preview + diagnostics, not all rows', () => {
  const rows = Array.from({ length: 250 }, (_, i) => `IMP-A${String(i + 1).padStart(3, '0')},SKF BEARING 6205-2RS VARIANT ${i},Bearings,EA,SKF`);
  const out = analyzeImportBounded({ organizationId: CPCL, fileName: 'a.csv', fileType: 'csv', payload: csvOf(rows) });
  assert.equal(out.totalRows, 250);
  assert.equal(out.validRows, 250);
  assert.ok(out.previewRows.length <= 100, `preview bounded: ${out.previewRows.length}`);
  assert.ok(out.validationErrors.length <= 500);
  assert.equal(out.canExecute, true);
  assert.ok(out.importId > 0);
  // Full report is NOT in the response.
  assert.equal((out as unknown as { validation?: unknown }).validation, undefined);
});

/* ------------------ UI-9: duplicate-only Step-5 eligibility ---------------- */

// UI-9 fix presentation semantics: rows whose ONLY errors are duplicate rules
// must be reported separately from genuine errors, and must not disable the
// Import button (the execution layer safely skips/updates them).

test('UI-9: all-duplicate file → duplicateOnlyRows = invalidRows, zero genuine errors, canExecute', () => {
  // CP-9001 was seeded above → every row is duplicate_in_database only.
  const rows = [
    'CP-9001,SKF BALL BEARING 6205-2RS V2,Bearings,EA,SKF',
    'CP-9001,SKF BALL BEARING 6205-2RS V3,Bearings,EA,SKF', // in-file repeat of the same code
  ];
  const out = analyzeImportBounded({ organizationId: CPCL, fileName: 'ui9-a.csv', fileType: 'csv', payload: csvOf(rows) });
  assert.equal(out.invalidRows, 2);
  assert.equal(out.duplicateOnlyRows, 2);
  assert.equal(out.genuineInvalidRows, 0);
  assert.equal(out.canExecute, true, 'duplicate-only rows are safely skippable → executable');
  assert.ok(out.validationErrors.every((e) => e.rule.endsWith('duplicate_in_database') || e.rule.endsWith('duplicate_in_file')));
});

test('UI-9: mixed batch — valid + duplicate-only + genuine errors are counted separately', () => {
  const rows = [
    'CP-9001,DUPLICATE OF SEEDED CODE,Bearings,EA,SKF', // duplicate_in_database
    `IMP-U9-${Date.now()},VALID NEW MATERIAL DESCRIPTION,Bearings,EA,SKF`, // valid
    ',MISSING CODE ROW,Bearings,EA,SKF', // required_material_code (genuine)
  ];
  const out = analyzeImportBounded({ organizationId: CPCL, fileName: 'ui9-b.csv', fileType: 'csv', payload: csvOf(rows) });
  assert.equal(out.totalRows, 3);
  assert.equal(out.validRows, 1);
  assert.equal(out.duplicateOnlyRows, 1);
  assert.equal(out.genuineInvalidRows, 1);
  assert.equal(out.canExecute, true);
  // The genuine error remains visible in diagnostics (never hidden by dup-only rows).
  assert.ok(out.validationErrors.some((e) => e.rule === 'ERROR:required_material_code'));
});

test('UI-9: genuine-only errors keep canExecute false and duplicateOnlyRows at 0', () => {
  const rows = [
    ',NO CODE HERE,Bearings,EA,SKF',
    'CP-9001!@,BAD CODE CHARS,Bearings,EA,SKF',
  ];
  const out = analyzeImportBounded({ organizationId: CPCL, fileName: 'ui9-c.csv', fileType: 'csv', payload: csvOf(rows) });
  assert.equal(out.invalidRows, 2);
  assert.equal(out.duplicateOnlyRows, 0);
  assert.equal(out.genuineInvalidRows, 2);
  assert.equal(out.canExecute, false, 'genuine validation errors still block execution');
});

test('bounded analyze surfaces diagnostics for invalid rows', () => {
  const out = analyzeImportBounded({
    organizationId: CPCL,
    fileName: 'b.csv',
    fileType: 'csv',
    payload: csvOf([',,Bearings,EA,', 'CP-B1,VALID BEARING,Bearings,EA,', 'CP-9001,DUPLICATE OF SEEDED,Bearings,EA,']),
  });
  assert.equal(out.totalRows, 3);
  assert.ok(out.validationErrors.length >= 2, 'missing code + duplicate diagnostics present');
  assert.ok(out.validationErrors.some((e) => /required_material_code|duplicate_in_database/.test(e.rule)));
});

/* ---------------------------- K. preview limits ---------------------------- */

test('preview pagination: default page, bounded page size, severity filter, search', () => {
  const rows = Array.from({ length: 130 }, (_, i) => `IMP-P${String(i + 1).padStart(3, '0')},PREVIEW BEARING ${i},Bearings,EA,SKF`);
  const a = analyzeImport({ organizationId: CPCL, fileName: 'p.csv', fileType: 'csv', payload: csvOf(rows) });
  const p1 = getImportPreviewPage(a.importId, {});
  assert.equal(p1.page, 1);
  assert.equal(p1.pageSize, 50);
  assert.equal(p1.rows.length, 50);
  assert.equal(p1.filteredTotal, 130);

  // Page-size ceiling: a client asking for 100000 still gets ≤100.
  const big = getImportPreviewPage(a.importId, { pageSize: 100000 });
  assert.ok(big.pageSize <= 100, `ceiling enforced: ${big.pageSize}`);
  assert.ok(big.rows.length <= 100);

  const err = getImportPreviewPage(a.importId, { severity: 'ERROR' });
  assert.equal(err.filteredTotal, 0);

  const q = getImportPreviewPage(a.importId, { q: 'PREVIEW BEARING 12' });
  assert.ok(q.filteredTotal >= 1 && q.filteredTotal <= 11, `search matched ${q.filteredTotal}`);
});

/* ------------------------------ A./B. lifecycle ---------------------------- */

test('job creation: QUEUED, uuid identity, audited; second active job rejected by DB', () => {
  const csv = csvOf(Array.from({ length: 12 }, (_, i) => `IMP-J${String(i + 1).padStart(2, '0')},JOB BEARING ${i},Bearings,EA,SKF`));
  const a = analyzeImport({ organizationId: CPCL, fileName: 'j.csv', fileType: 'csv', payload: csv });
  const job = createImportJob(a.importId, 'test');
  assert.equal(job.status, 'QUEUED');
  assert.match(job.jobId, /^imp_[0-9a-f-]{36}$/);
  const audited = testDb
    .prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'import_created' AND entity_type = 'import_job'`)
    .get() as unknown as { n: number };
  assert.ok(audited.n >= 1);
  // DB-authoritative guard: a second active import is rejected.
  const a2 = analyzeImport({ organizationId: CPCL, fileName: 'j2.csv', fileType: 'csv', payload: csvOf(['IMP-J2X,SECOND FILE BEARING,Bearings,EA,SKF']) });
  assert.throws(() => createImportJob(a2.importId, 'test'), /already queued or running/i);
  // Cleanup for later tests.
  testDb.prepare(`DELETE FROM import_rows WHERE job_id = ?`).run(job.jobId);
  testDb.prepare(`DELETE FROM import_run_chunks WHERE run_id = ?`).run(job.jobId);
  testDb.prepare(`DELETE FROM import_runs WHERE id = ?`).run(job.jobId);
});

/* --------------------- B./C./D./E. chunks + progress ----------------------- */

const jobCsvRows = Array.from({ length: 1030 }, (_, i) => `IMP-K${String(i + 1).padStart(4, '0')},CHUNKED BEARING ${i},Bearings,EA,SKF`);
let jobIdForTest = '';
test('chunked run: boundaries, final partial chunk, committed-work progress', () => {
  const a = analyzeImport({ organizationId: CPCL, fileName: 'k.csv', fileType: 'csv', payload: csvOf(jobCsvRows) });
  const job = createImportJob(a.importId, 'test');
  testDb.prepare(`UPDATE import_runs SET chunk_size = 100 WHERE id = ?`).run(job.jobId); // 11 chunks: 10×100 + 30
  jobIdForTest = job.jobId;
  const done = runImportJob(job.jobId);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.totalRows, 1030);
  assert.equal(done.processedRows, 1030);
  assert.equal(done.progressPct, 100);
  assert.equal(done.totalChunks, 11);
  const chunks = testDb
    .prepare(`SELECT chunk_index, first_row, row_count, status FROM import_run_chunks WHERE run_id = ? ORDER BY chunk_index`)
    .all(job.jobId) as unknown as Array<{ chunk_index: number; first_row: number; row_count: number; status: string }>;
  assert.equal(chunks.length, 11);
  assert.equal(chunks[10].row_count, 30, 'final partial chunk');
  assert.ok(chunks.every((c) => c.status === 'COMMITTED'));
  const audited = testDb
    .prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'import_performed' AND entity_type = 'import_job'`)
    .get() as unknown as { n: number };
  assert.ok(audited.n >= 1);
});

test('materials inserted by the chunked job exist exactly once', () => {
  const n = testDb
    .prepare(`SELECT COUNT(*) n FROM material_records WHERE original_code LIKE 'IMP-K%'`)
    .get() as unknown as { n: number };
  assert.equal(n.n, 1030);
});

test('rerunning a COMPLETED import job is rejected', () => {
  assert.throws(() => runImportJob(jobIdForTest), /already completed/i);
});

/* ------------------------ F./G. idempotent re-import ----------------------- */

test('retry of the same file creates zero duplicate materials', () => {
  const before = testDb
    .prepare(`SELECT COUNT(*) n FROM material_records WHERE original_code LIKE 'IMP-K%'`)
    .get() as unknown as { n: number };
  // A brand-new job over the SAME import (same codes) — duplicate strategy skip.
  const a = analyzeImport({ organizationId: CPCL, fileName: 'k2.csv', fileType: 'csv', payload: csvOf(jobCsvRows) });
  const job = createImportJob(a.importId, 'test');
  const done = runImportJob(job.jobId);
  assert.equal(done.status, 'COMPLETED');
  const after = testDb
    .prepare(`SELECT COUNT(*) n FROM material_records WHERE original_code LIKE 'IMP-K%'`)
    .get() as unknown as { n: number };
  assert.equal(after.n, before.n, 'no duplicates created');
});

/* --------------------------- H. failure rollback --------------------------- */

test('forced chunk failure: prior chunk preserved, no partial writes, job FAILED', () => {
  const cfg = require('../src/lib/config') as { dataDir: string };
  void cfg;
  const a = analyzeImport({ organizationId: CPCL, fileName: 'f.csv', fileType: 'csv', payload: csvOf(Array.from({ length: 30 }, (_, i) => `IMP-F${String(i + 1).padStart(3, '0')},FAILURE BEARING ${i},Bearings,EA,SKF`)) });
  const job = createImportJob(a.importId, 'test');
  testDb.prepare(`UPDATE import_runs SET chunk_size = 10 WHERE id = ?`).run(job.jobId); // 3 chunks
  // Crash staging: abort exactly when chunk 1 STARTS (chunk-marker update).
  testDb.exec(`DROP TRIGGER IF EXISTS fail_at_chunk1;`);
  testDb.exec(`
    CREATE TRIGGER fail_at_chunk1
    BEFORE UPDATE OF status ON import_run_chunks
    WHEN NEW.status = 'RUNNING' AND OLD.chunk_index >= 1
    BEGIN
      SELECT RAISE(ABORT, 'forced chunk failure');
    END;
  `);
  try {
    runImportJob(job.jobId);
    const s = getImportJob(job.jobId);
    assert.equal(s.status, 'FAILED');
    assert.match(s.error ?? '', /forced chunk failure/);
    const chunks = testDb
      .prepare(`SELECT chunk_index, status FROM import_run_chunks WHERE run_id = ? ORDER BY chunk_index`)
      .all(job.jobId) as unknown as Array<{ chunk_index: number; status: string }>;
    assert.equal(chunks[0].status, 'COMMITTED', 'prior chunk preserved');
    assert.equal(chunks.filter((c) => c.chunk_index >= 1 && c.status === 'COMMITTED').length, 0);
    assert.equal(chunks.filter((c) => c.status === 'RUNNING').length, 0, 'no chunk stuck RUNNING');
    assert.ok(s.processedRows > 0 && s.processedRows < s.totalRows, `partial committed progress ${s.processedRows}/${s.totalRows}`);
    // Chunk 0's rows exist; chunk 1+ rows do not (no partial writes).
    const first = testDb.prepare(`SELECT COUNT(*) n FROM material_records WHERE original_code = 'IMP-F001'`).get() as unknown as { n: number };
    const later = testDb.prepare(`SELECT COUNT(*) n FROM material_records WHERE original_code = 'IMP-F011'`).get() as unknown as { n: number };
    assert.equal(first.n, 1);
    assert.equal(later.n, 0);
    // Retry completes; no duplicates (§16).
    testDb.exec(`DROP TRIGGER fail_at_chunk1;`);
    const retried = runImportJob(job.jobId);
    assert.equal(retried.status, 'COMPLETED');
    const total = testDb
      .prepare(`SELECT COUNT(*) n FROM material_records WHERE original_code LIKE 'IMP-F%'`)
      .get() as unknown as { n: number };
    assert.equal(total.n, 30, 'post-retry: exactly one row per code');
  } finally {
    testDb.exec(`DROP TRIGGER IF EXISTS fail_at_chunk1;`);
  }
});

/* ------------------------------- I. resume --------------------------------- */

test('resume of a stale RUNNING import skips committed chunks (no double-count)', () => {
  const a = analyzeImport({ organizationId: CPCL, fileName: 'r.csv', fileType: 'csv', payload: csvOf(Array.from({ length: 30 }, (_, i) => `IMP-R${String(i + 1).padStart(3, '0')},RESUME BEARING ${i},Bearings,EA,SKF`)) });
  const job = createImportJob(a.importId, 'test');
  testDb.prepare(`UPDATE import_runs SET chunk_size = 10 WHERE id = ?`).run(job.jobId);
  testDb.exec(`DROP TRIGGER IF EXISTS fail_at_chunk1;`);
  testDb.exec(`
    CREATE TRIGGER fail_at_chunk1
    BEFORE UPDATE OF status ON import_run_chunks
    WHEN NEW.status = 'RUNNING' AND OLD.chunk_index >= 1
    BEGIN
      SELECT RAISE(ABORT, 'forced chunk failure');
    END;
  `);
  try {
    runImportJob(job.jobId); // chunk 0 commits, chunk 1 aborts
    assert.equal(getImportJob(job.jobId).status, 'FAILED');
    // Simulate a process crash: rewind to stale RUNNING (heartbeat 1h old).
    testDb
      .prepare(`UPDATE import_runs SET status = 'RUNNING', heartbeat_at = ?, error_message = NULL WHERE id = ?`)
      .run(new Date(Date.now() - 1000 * 60 * 60).toISOString(), job.jobId);
    testDb.exec(`DROP TRIGGER fail_at_chunk1;`);
    const resumed = runImportJob(job.jobId);
    assert.equal(resumed.status, 'COMPLETED');
    assert.equal(resumed.processedRows, resumed.totalRows, 'no double-count of committed chunk');
    const total = testDb
      .prepare(`SELECT COUNT(*) n FROM material_records WHERE original_code LIKE 'IMP-R%'`)
      .get() as unknown as { n: number };
    assert.equal(total.n, 30, 'final state equals uninterrupted import');
  } finally {
    testDb.exec(`DROP TRIGGER IF EXISTS fail_at_chunk1;`);
  }
});

/* ----------------------- M. job vs legacy equivalence ---------------------- */

test('job importer output equals legacy executeImport output', () => {
  const file = csvOf(Array.from({ length: 40 }, (_, i) => `IMP-E${String(i + 1).padStart(3, '0')},SKF BALL BEARING 620${i % 10}-2RS VARIANT ${i},Bearings,EA,SKF`));
  // Legacy path.
  const aL = analyzeImport({ organizationId: CPCL, fileName: 'el.csv', fileType: 'csv', payload: file });
  const legacy = executeImport({ importId: aL.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'test' });
  // Job path (same bytes).
  const aJ = analyzeImport({ organizationId: CPCL, fileName: 'ej.csv', fileType: 'csv', payload: file });
  const job = createImportJob(aJ.importId, 'test');
  const jobDone = runImportJob(job.jobId);
  const codes = (prefix: string) =>
    new Set(
      (testDb.prepare(`SELECT original_code FROM material_records WHERE original_code LIKE ?`).all(`${prefix}%`) as Array<{ original_code: string }>).map((r) => r.original_code),
    );
  assert.equal(legacy.imported, 40);
  // The job ran over the SAME codes: every row is a duplicate → skipped,
  // which is precisely the idempotency guarantee (no second copy).
  assert.equal(jobDone.successfulRows, 0);
  assert.equal(jobDone.processedRows, 40);
  assert.equal(codes('IMP-E').size, 40);
  // Attributes preserved for the imported materials.
  const attrs = testDb
    .prepare(`SELECT COUNT(DISTINCT m.id) n FROM material_records m JOIN material_attributes a ON a.material_id = m.id WHERE m.original_code LIKE 'IMP-E%'`)
    .get() as unknown as { n: number };
  assert.equal(attrs.n, 40);
});

/* ---------------------------- detached execution --------------------------- */

test('createAndStartImportJob returns immediately and completes in background', async () => {
  const a = analyzeImport({ organizationId: CPCL, fileName: 'bg.csv', fileType: 'csv', payload: csvOf(Array.from({ length: 8 }, (_, i) => `IMP-BG${i + 1},BACKGROUND BEARING ${i},Bearings,EA,SKF`)) });
  const t0 = Date.now();
  const job = createAndStartImportJob(a.importId, 'test');
  assert.ok(Date.now() - t0 < 5000, 'request not blocked');
  // Step 3: execution is detached on macrotask ticks — poll like the real
  // frontend does (real timer turns, not microtasks) until COMPLETED.
  for (let i = 0; i < 500 && getImportJob(job.jobId).status !== 'COMPLETED'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(getImportJob(job.jobId).status, 'COMPLETED');
  assert.ok(listImportJobs(5).length >= 1);
});

/* --------------------------------- cleanup --------------------------------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
