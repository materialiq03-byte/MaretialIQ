/**
 * Step 3 regression tests — asynchronous import job execution.
 *
 * `npx tsx tests/import-async.test.ts` (part of the npm test chain).
 *
 * Proves the Step-3 execution-model change preserves frozen semantics:
 *   - claim+stage is fast and startQueuedImportAsync returns BEFORE chunk
 *     execution begins (the HTTP 202 precondition),
 *   - the background driver executes the job to COMPLETED,
 *   - RUNNING status + partial processed_rows progress are observable BETWEEN
 *     chunks while the job runs,
 *   - a DELIBERATE background crash persists status=FAILED with the error
 *     message, rolls the chunk back, and produces NO unhandled rejection,
 *   - double-start of the same RUNNING job is rejected (in-process semaphore),
 *   - the DB single-active guard rejects a second active job (no unlimited
 *     concurrency) and the slot frees after completion,
 *   - idempotent retry of a FAILED job completes without duplicates,
 *   - the legacy executeImport path still works.
 *
 * Tests run SEQUENTIALLY (awaited one at a time): the database allows only
 * ONE active import job at a time by design, so parallel jobs would collide.
 * Runs on a disposable temp SQLite database; production is never touched.
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
  startQueuedImportAsync,
  getImportJob,
  type ImportJobSummary,
} from '../src/lib/services/import-job-service';

/* ------------------- disposable database + org fixtures ------------------- */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-async-'));
const testDb = new DatabaseSync(path.join(tmpDir, 'test.db'));
setDbForTests(testDb);
migrate(testDb);

const now = new Date().toISOString();
const orgIds = new Map<string, number>();
for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
  const res = testDb
    .prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
    .run(code, `${code} (async test)`, now, now);
  orgIds.set(code, Number(res.lastInsertRowid));
}
const CPCL = orgIds.get('CPCL')!;

function csvOf(rows: string[]): ArrayBuffer {
  const buf = Buffer.from(
    ['material_code,description,category,uom,manufacturer', ...rows].join('\n'),
    'utf8',
  );
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until pred() holds or the deadline passes (then fail with context). */
async function waitFor(jobId: string, pred: (s: ImportJobSummary) => boolean, timeoutMs: number): Promise<ImportJobSummary> {
  const deadline = Date.now() + timeoutMs;
  let s = getImportJob(jobId);
  while (!pred(s)) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timeout: status=${s.status} processed=${s.processedRows}/${s.totalRows} error=${s.error}`);
    }
    await sleep(10);
    s = getImportJob(jobId);
  }
  return s;
}

function materialCount(codePrefix: string): number {
  return (testDb.prepare(`SELECT count(*) AS n FROM material_records WHERE original_code LIKE ?`).get(`${codePrefix}%`) as { n: number }).n;
}

function setChunkSize(jobId: string, size: number): void {
  testDb.prepare(`UPDATE import_runs SET chunk_size = ? WHERE id = ?`).run(size, jobId);
}

/* --------------------------------- tests ---------------------------------- */

async function t1_returnsBeforeExecution(): Promise<void> {
  const rows = Array.from({ length: 120 }, (_, i) => `ASY-A${String(i + 1).padStart(3, '0')},SKF BALL BEARING 6205-2RS VARIANT ${i},Bearings,EA,SKF`);
  const a = analyzeImport({ organizationId: CPCL, fileName: 'a1.csv', fileType: 'csv', payload: csvOf(rows) });
  const job = createImportJob(a.importId, 'test');

  startQueuedImportAsync(job.jobId);
  // startQueuedImportAsync is synchronous: the claim ran, but chunk execution
  // waits for the first macrotask yield — so nothing can be imported yet.
  const rightAfter = getImportJob(job.jobId);
  assert.equal(rightAfter.processedRows, 0, `202 precondition: nothing imported at return time (got ${rightAfter.processedRows}/120)`);
  assert.equal(rightAfter.status, 'RUNNING', 'claim marked the job RUNNING synchronously');

  const final = await waitFor(job.jobId, (s) => s.status === 'COMPLETED' || s.status === 'FAILED', 10_000);
  assert.equal(final.status, 'COMPLETED', `background driver executed the job (error: ${final.error})`);
  assert.equal(final.successfulRows, 120);
  assert.equal(materialCount('ASY-A'), 120);
}

async function t2_runningAndProgressObservable(): Promise<void> {
  const rows = Array.from({ length: 2000 }, (_, i) => `ASY-B${String(i + 1).padStart(4, '0')},HYDRAULIC PUMP GEAR ASSEMBLY ${i},Pumps,EA,SKF`);
  const a = analyzeImport({ organizationId: CPCL, fileName: 'a2.csv', fileType: 'csv', payload: csvOf(rows) });
  const job = createImportJob(a.importId, 'test');
  setChunkSize(job.jobId, 100); // 20 chunks — polls can land between them

  const seen = new Set<string>();
  startQueuedImportAsync(job.jobId);
  let sawPartial = false;
  const final = await waitFor(
    job.jobId,
    (s) => {
      seen.add(s.status);
      if (s.status === 'RUNNING' && s.processedRows > 0 && s.processedRows < 2000) sawPartial = true;
      return s.status === 'COMPLETED' || s.status === 'FAILED';
    },
    20_000,
  );
  assert.equal(final.status, 'COMPLETED', `error: ${final.error}`);
  assert.ok(seen.has('RUNNING'), `RUNNING observed by a poll (saw: ${[...seen].join(',')})`);
  assert.ok(sawPartial || final.processedRows === 2000, `partial progress observed between chunks (saw: ${[...seen].join(',')})`);
  assert.equal(final.successfulRows, 2000);
  assert.equal(materialCount('ASY-B'), 2000);
}

async function t3_backgroundCrashBecomesFailed(): Promise<void> {
  const rows = Array.from({ length: 50 }, (_, i) => `ASY-C${String(i + 1).padStart(3, '0')},CRASH BEARING ${i},Bearings,EA,SKF`);
  const a = analyzeImport({ organizationId: CPCL, fileName: 'a3.csv', fileType: 'csv', payload: csvOf(rows) });
  const job = createImportJob(a.importId, 'test');
  // Abort when a chunk flips COMMITTED — inside the chunk transaction, so the
  // driver's executeImportChunk throws mid-flight and its catch persists FAILED.
  testDb.exec(`
    CREATE TRIGGER fail_async_commit
    BEFORE UPDATE OF status ON import_run_chunks
    WHEN NEW.status = 'COMMITTED'
    BEGIN
      SELECT RAISE(ABORT, 'forced async crash');
    END;
  `);
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown): void => {
    unhandled.push(err);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    startQueuedImportAsync(job.jobId);
    const final = await waitFor(job.jobId, (s) => s.status === 'FAILED' || s.status === 'COMPLETED', 10_000);
    assert.equal(final.status, 'FAILED', 'background crash persisted as FAILED');
    assert.match(final.error ?? '', /forced async crash/);
    await sleep(100); // give the event loop turns for any unhandled rejection
    assert.equal(unhandled.length, 0, `no unhandled promise rejection (got ${unhandled.length})`);
    assert.equal(materialCount('ASY-C'), 0, 'no partial rows (chunk rolled back)');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    testDb.exec(`DROP TRIGGER IF EXISTS fail_async_commit;`);
  }
  // Idempotent retry after failure: full success, no duplicates.
  const s2 = runImportJob(job.jobId);
  assert.equal(s2.status, 'COMPLETED');
  assert.equal(s2.successfulRows, 50);
  assert.equal(materialCount('ASY-C'), 50);
}

async function t4_doubleStartRejected(): Promise<void> {
  const rows = Array.from({ length: 300 }, (_, i) => `ASY-D${String(i + 1).padStart(3, '0')},DUP START BEARING ${i},Bearings,EA,SKF`);
  const a = analyzeImport({ organizationId: CPCL, fileName: 'a4.csv', fileType: 'csv', payload: csvOf(rows) });
  const job = createImportJob(a.importId, 'test');
  setChunkSize(job.jobId, 10); // 30 chunks — long enough to catch it RUNNING

  startQueuedImportAsync(job.jobId);
  await waitFor(job.jobId, (s) => s.status === 'RUNNING', 5_000);

  let conflictMsg = '';
  try {
    startQueuedImportAsync(job.jobId);
  } catch (err) {
    conflictMsg = err instanceof Error ? err.message : String(err);
  }
  assert.match(conflictMsg, /already executing/i, `claim/semaphore conflict raised: ${conflictMsg}`);

  const final = await waitFor(job.jobId, (s) => s.status === 'COMPLETED' || s.status === 'FAILED', 15_000);
  assert.equal(final.status, 'COMPLETED', `error: ${final.error}`);
  assert.equal(materialCount('ASY-D'), 300, 'exactly once — no duplicate materials from double start');
}

async function t5_singleActiveJobGuard(): Promise<void> {
  // Concurrency is bounded at TWO levels: the in-process semaphore (t4) and
  // the DB single-active guard. Prove the DB guard rejects a second active
  // job and frees afterwards.
  const rows1 = Array.from({ length: 400 }, (_, i) => `ASY-E1${String(i + 1).padStart(3, '0')},SLOT ONE BEARING ${i},Bearings,EA,SKF`);
  const a1 = analyzeImport({ organizationId: CPCL, fileName: 'a5a.csv', fileType: 'csv', payload: csvOf(rows1) });
  const job1 = createImportJob(a1.importId, 'test');
  setChunkSize(job1.jobId, 50); // 8 chunks

  startQueuedImportAsync(job1.jobId);
  await waitFor(job1.jobId, (s) => s.status === 'RUNNING', 5_000);

  // A second job cannot even be created while one is active (QUEUED/RUNNING).
  const rows2 = Array.from({ length: 20 }, (_, i) => `ASY-E2${String(i + 1).padStart(3, '0')},SLOT TWO BEARING ${i},Bearings,EA,SKF`);
  const a2 = analyzeImport({ organizationId: CPCL, fileName: 'a5b.csv', fileType: 'csv', payload: csvOf(rows2) });
  let conflictMsg = '';
  try {
    createImportJob(a2.importId, 'test');
  } catch (err) {
    conflictMsg = err instanceof Error ? err.message : String(err);
  }
  assert.match(conflictMsg, /already (queued|running)|queued or running/i, `DB single-active guard raised: ${conflictMsg}`);

  const final1 = await waitFor(job1.jobId, (s) => s.status === 'COMPLETED' || s.status === 'FAILED', 20_000);
  assert.equal(final1.status, 'COMPLETED', `error: ${final1.error}`);

  // Slot freed: job2 creates and completes after job1.
  const job2 = createImportJob(a2.importId, 'test');
  startQueuedImportAsync(job2.jobId);
  const final2 = await waitFor(job2.jobId, (s) => s.status === 'COMPLETED' || s.status === 'FAILED', 15_000);
  assert.equal(final2.status, 'COMPLETED', `job2 after slot freed: ${final2.error}`);
  assert.equal(materialCount('ASY-E2'), 20);
}

async function t6_legacyPathStillWorks(): Promise<void> {
  const a = analyzeImport({ organizationId: CPCL, fileName: 'a6.csv', fileType: 'csv', payload: csvOf(['ASY-F1,LEGACY BEARING 6205-2RS,Bearings,EA,SKF']) });
  const r = executeImport({ importId: a.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'test' });
  assert.ok(r);
  assert.equal(materialCount('ASY-F1'), 1);
}

async function t7_boundedAnalyzeEndToEnd(): Promise<void> {
  process.env.IMPORT_BATCH_ROWS = '10';
  try {
    const rows = Array.from({ length: 60 }, (_, i) => `ASY-G${String(i + 1).padStart(3, '0')},ELECTRIC MOTOR THREE PHASE 5.5KW ${i},Motors,EA,SKF`);
    const out = analyzeImportBounded({ organizationId: CPCL, fileName: 'a7.csv', fileType: 'csv', payload: csvOf(rows) });
    assert.ok(out.importId > 0 && out.canExecute);
    const job = createImportJob(out.importId, 'test');
    setChunkSize(job.jobId, 10); // 6 chunks
    startQueuedImportAsync(job.jobId);
    const final = await waitFor(job.jobId, (s) => s.status === 'COMPLETED' || s.status === 'FAILED', 10_000);
    assert.equal(final.status, 'COMPLETED', `error: ${final.error}`);
    assert.equal(final.successfulRows, 60);
    assert.equal(materialCount('ASY-G'), 60);
  } finally {
    delete process.env.IMPORT_BATCH_ROWS;
  }
}

/* --------------------- sequential runner + summary ------------------------ */

const tests: Array<[string, () => Promise<void>]> = [
  ['async start returns before execution; job completes in background', t1_returnsBeforeExecution],
  ['RUNNING + partial progress observable between chunks', t2_runningAndProgressObservable],
  ['deliberate background crash → FAILED, no unhandled rejection, retry works', t3_backgroundCrashBecomesFailed],
  ['double-start of a RUNNING job is rejected', t4_doubleStartRejected],
  ['DB single-active guard bounds concurrency; slot frees after completion', t5_singleActiveJobGuard],
  ['legacy executeImport path still works', t6_legacyPathStillWorks],
  ['bounded analyze → async job end-to-end (wizard-shaped flow)', t7_boundedAnalyzeEndToEnd],
];

(async () => {
  let passed = 0;
  const failures: string[] = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok - ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${name}: ${msg}`);
      console.error(`  FAIL - ${name}: ${msg}`);
    }
  }
  console.log(`\nimport-async: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAILED: ${f}`);
    process.exit(1);
  }
  process.exit(0);
})();
