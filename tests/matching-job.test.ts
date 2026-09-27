/**
 * Step-4 job execution model tests — `npx tsx tests/matching-job.test.ts`.
 *
 * Covers job lifecycle (QUEUED→RUNNING→COMPLETED/FAILED), chunked
 * independent commits, committed-work progress accounting, DB-authoritative
 * single-active-run concurrency, idempotent persistence (no duplicate
 * candidate/review rows), failure rollback (only the failing chunk), resume
 * (committed chunks skipped), and final-output equivalence with the legacy
 * synchronous runMatching(). Runs on a disposable temp database; the
 * production data/materialiq.db is never touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { executeImport, analyzeImport } from '../src/lib/services/import-center-service';
import { runMatching } from '../src/lib/services/matching-service';
import {
  createMatchingJob,
  createAndStartMatchingJob,
  runJob,
  getMatchingJob,
  listMatchingJobs,
  describeMatchingJob,
} from '../src/lib/services/matching-job-service';

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-job-'));
const testDb = new DatabaseSync(path.join(tmpDir, 'test.db'));
setDbForTests(testDb);
migrate(testDb);

const now = new Date().toISOString();
const orgIds = new Map<string, number>();
for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
  const res = testDb
    .prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
    .run(code, `${code} (job test)`, now, now);
  orgIds.set(code, Number(res.lastInsertRowid));
}

const CSV_DIR = path.join(process.cwd(), 'data', 'synthetic-imports');
for (const [code, file] of [
  ['CPCL', 'CPCL.csv'],
  ['NTPC', 'NTPC.csv'],
  ['BHEL', 'BHEL.csv'],
  ['NLC', 'NLC.csv'],
  ['SAIL', 'SAIL.csv'],
] as Array<[string, string]>) {
  const buf = fs.readFileSync(path.join(CSV_DIR, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const analysis = analyzeImport({ organizationId: orgIds.get(code)!, fileName: file, fileType: 'csv', payload: ab });
  const execution = executeImport({ importId: analysis.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'job-test@example.com' });
  assert.ok(execution.imported > 0, `seed import for ${code}`);
}

/* --------------------------- reference output ------------------------------ */

const legacy = runMatching('job-legacy@example.com');
test('legacy run produces the expected candidate volume', () => {
  assert.ok(legacy.candidatesCreated > 0);
});

function candidateKeys(): Set<string> {
  const rows = testDb
    .prepare(`SELECT source_material_id, candidate_material_id, final_score, match_type FROM match_candidates`)
    .all() as unknown as Array<{ source_material_id: number; candidate_material_id: number; final_score: number; match_type: string }>;
  return new Set(rows.map((r) => `${r.source_material_id}:${r.candidate_material_id}:${r.final_score}:${r.match_type}`));
}
const legacyKeys = candidateKeys();

let jobIdForTest = '';

/* ------------------------------- lifecycle --------------------------------- */

test('job creation inserts QUEUED with uuid identity and audits it', () => {
  const job = createMatchingJob('job-test@example.com');
  assert.equal(job.status, 'QUEUED');
  assert.match(job.jobId, /^job_[0-9a-f-]{36}$/);
  assert.ok(job.chunkSize >= 1);
  const audited = testDb
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'match_generated' AND entity_type = 'matching_job'`)
    .get() as unknown as { n: number };
  assert.ok(audited.n >= 1);
  testDb.prepare(`DELETE FROM matching_run_chunks WHERE run_id = ?`).run(job.jobId);
  testDb.prepare(`DELETE FROM matching_runs WHERE id = ?`).run(job.jobId);
});

test('full job run reaches COMPLETED with processed == total and audits completion', () => {
  const job = createMatchingJob('job-test@example.com');
  jobIdForTest = job.jobId;
  const done = runJob(job.jobId);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.processed, done.total);
  assert.equal(done.total, legacy.pairsCompared);
  assert.ok(done.progressPct === 100);
  const audited = testDb
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'matching_job' AND details LIKE '%"event":"job_completed"%'`)
    .get() as unknown as { n: number };
  assert.ok(audited.n >= 1);
});

test('chunk plan persisted: chunk count and boundaries are correct', () => {
  const chunks = testDb
    .prepare(`SELECT chunk_index, first_pair, pair_count, status FROM matching_run_chunks WHERE run_id = ? ORDER BY chunk_index`)
    .all(jobIdForTest) as unknown as Array<{ chunk_index: number; first_pair: number; pair_count: number; status: string }>;
  const total = legacy.pairsCompared;
  const size = getMatchingJob(jobIdForTest).chunkSize;
  const expected = Math.ceil(total / size);
  assert.equal(chunks.length, expected);
  assert.equal(chunks[0].first_pair, 0);
  const last = chunks[chunks.length - 1];
  assert.equal(last.pair_count, total - (expected - 1) * size);
  assert.ok(chunks.every((c) => c.status === 'COMMITTED'));
});

test('progress is derived from committed work only', () => {
  const s = getMatchingJob(jobIdForTest);
  assert.equal(s.processed, s.total);
  assert.equal(s.progressPct, 100);
  assert.ok(listMatchingJobs(5).length >= 1);
  assert.match(describeMatchingJob(jobIdForTest), /COMPLETED/);
});

/* ------------------------------ idempotency -------------------------------- */

test('rerunning a COMPLETED job is rejected (no duplicate candidates)', () => {
  assert.throws(
    () => runJob(jobIdForTest),
    (err: unknown) => err instanceof Error && /already completed/i.test(err.message),
  );
  const before = (testDb.prepare(`SELECT COUNT(*) AS n FROM match_candidates`).get() as unknown as { n: number }).n;
  assert.equal(before, legacy.candidatesCreated);
});

test('re-running matching produces zero duplicate candidate/review rows', () => {
  const candBefore = (testDb.prepare(`SELECT COUNT(*) AS n FROM match_candidates`).get() as unknown as { n: number }).n;
  const queueBefore = (testDb.prepare(`SELECT COUNT(*) AS n FROM review_queue`).get() as unknown as { n: number }).n;
  const job2 = createMatchingJob('job-test@example.com');
  runJob(job2.jobId);
  const candAfter = (testDb.prepare(`SELECT COUNT(*) AS n FROM match_candidates`).get() as unknown as { n: number }).n;
  const queueAfter = (testDb.prepare(`SELECT COUNT(*) AS n FROM review_queue`).get() as unknown as { n: number }).n;
  assert.equal(candAfter, candBefore, 'candidate rows are upserted, never duplicated');
  assert.equal(queueAfter, queueBefore, 'review queue rows use INSERT OR IGNORE');
});

/* ---------------------------- output equivalence --------------------------- */

test('job output is identical to the legacy synchronous run', () => {
  const jobKeys = candidateKeys();
  assert.equal(jobKeys.size, legacyKeys.size);
  for (const k of legacyKeys) assert.ok(jobKeys.has(k), `missing ${k}`);
  for (const k of jobKeys) assert.ok(legacyKeys.has(k), `extra ${k}`);
});

/* --------------------------- concurrency guard ----------------------------- */

test('a second active job is rejected while one is QUEUED/RUNNING (DB guard)', () => {
  const active = createMatchingJob('job-test@example.com'); // stays QUEUED
  assert.throws(() => createMatchingJob('job-test@example.com'), /queued or running/i);
  testDb.prepare(`DELETE FROM matching_run_chunks WHERE run_id = ?`).run(active.jobId);
  testDb.prepare(`DELETE FROM matching_runs WHERE id = ?`).run(active.jobId);
});

/* -------------------------- failure + resume ------------------------------- */

test('forced chunk failure rolls back only that chunk and preserves prior chunks', () => {
  const cfg = require('../src/lib/config') as { config: { pipeline: { matchingChunkSize: number } } };
  const orig = cfg.config.pipeline.matchingChunkSize;
  (cfg.config.pipeline as { matchingChunkSize: number }).matchingChunkSize = 4;
  // Crash staging: abort exactly when chunk 1 STARTS (chunk-marker update).
  // Chunk 0 therefore commits for real before the failure — a genuine
  // crash-between-chunks with prior work durably persisted.
  testDb.exec(`DROP TRIGGER IF EXISTS fail_at_chunk1;`);
  testDb.exec(`
    CREATE TRIGGER fail_at_chunk1
    BEFORE UPDATE OF status ON matching_run_chunks
    WHEN NEW.status = 'RUNNING' AND OLD.chunk_index >= 1
    BEGIN
      SELECT RAISE(ABORT, 'forced chunk failure');
    END;
  `);
  try {
    const job = createMatchingJob('job-test@example.com');
    // runJob deliberately does NOT throw on chunk failure — it marks the job
    // FAILED, records the error, and stops at the first failed chunk.
    runJob(job.jobId);
    const s = getMatchingJob(job.jobId);
    assert.equal(s.status, 'FAILED');
    assert.match(s.error ?? '', /forced chunk failure/);
    // Chunk 0 committed and survived; nothing later committed.
    const chunks = testDb
      .prepare(`SELECT chunk_index, status FROM matching_run_chunks WHERE run_id = ? ORDER BY chunk_index`)
      .all(job.jobId) as unknown as Array<{ chunk_index: number; status: string }>;
    assert.ok(chunks.length >= 2, 'multiple chunks planned');
    assert.equal(chunks[0].status, 'COMMITTED', 'prior chunk preserved');
    assert.equal(chunks.filter((c) => c.chunk_index >= 1 && c.status === 'COMMITTED').length, 0, 'no later chunk committed');
    assert.equal(chunks.filter((c) => c.status === 'RUNNING').length, 0, 'no chunk stuck RUNNING');
    // Progress reflects exactly the committed chunk.
    assert.ok(s.processed > 0 && s.processed < s.total, `partial progress: ${s.processed}/${s.total}`);
    // Remove the fault injection, then retry through the normal FAILED path.
    testDb.exec(`DROP TRIGGER fail_at_chunk1;`);
    const retried = runJob(job.jobId);
    assert.equal(retried.status, 'COMPLETED');
    assert.equal(retried.processed, retried.total);
    assert.equal(candidateKeys().size, legacyKeys.size, 'post-retry output equals legacy output');
    testDb.prepare(`DELETE FROM matching_run_chunks WHERE run_id = ?`).run(job.jobId);
    testDb.prepare(`DELETE FROM matching_runs WHERE id = ?`).run(job.jobId);
  } finally {
    testDb.exec(`DROP TRIGGER IF EXISTS fail_at_chunk1;`);
    (cfg.config.pipeline as { matchingChunkSize: number }).matchingChunkSize = orig;
  }
});

test('resume of a stale RUNNING job skips committed chunks (no double-count)', () => {
  const cfg = require('../src/lib/config') as { config: { pipeline: { matchingChunkSize: number } } };
  const orig = cfg.config.pipeline.matchingChunkSize;
  (cfg.config.pipeline as { matchingChunkSize: number }).matchingChunkSize = 4;
  const job = createMatchingJob('job-test@example.com');
  (cfg.config.pipeline as { matchingChunkSize: number }).matchingChunkSize = orig;
  // Crash staging identical to the failure test: chunk 0 commits for real,
  // chunk 1 aborts. Then simulate a process crash by rewinding the job from
  // FAILED to a stale RUNNING state (heartbeat an hour old) WITHOUT
  // resetting counters or chunk markers.
  testDb.exec(`DROP TRIGGER IF EXISTS fail_at_chunk1;`);
  testDb.exec(`
    CREATE TRIGGER fail_at_chunk1
    BEFORE UPDATE OF status ON matching_run_chunks
    WHEN NEW.status = 'RUNNING' AND OLD.chunk_index >= 1
    BEGIN
      SELECT RAISE(ABORT, 'forced chunk failure');
    END;
  `);
  try {
    runJob(job.jobId);
    const afterCrash = getMatchingJob(job.jobId);
    assert.equal(afterCrash.status, 'FAILED');
    testDb
      .prepare(`UPDATE matching_runs SET status = 'RUNNING', heartbeat_at = ?, error_message = NULL WHERE id = ?`)
      .run(new Date(Date.now() - 1000 * 60 * 60).toISOString(), job.jobId);
    // Fault removed; the takeover must now proceed past chunk 1.
    testDb.exec(`DROP TRIGGER fail_at_chunk1;`);
    const resumed = runJob(job.jobId);
    assert.equal(resumed.status, 'COMPLETED');
    // Chunk 0 committed exactly once: counters must not double-count it.
    assert.equal(resumed.processed, resumed.total, 'no double-count of committed chunks');
    assert.equal(candidateKeys().size, legacyKeys.size, 'final output equals legacy output');
    const chunks = testDb
      .prepare(`SELECT status FROM matching_run_chunks WHERE run_id = ?`)
      .all(job.jobId) as unknown as Array<{ status: string }>;
    assert.ok(chunks.every((c) => c.status === 'COMMITTED'));
    testDb.prepare(`DELETE FROM matching_run_chunks WHERE run_id = ?`).run(job.jobId);
    testDb.prepare(`DELETE FROM matching_runs WHERE id = ?`).run(job.jobId);
  } finally {
    testDb.exec(`DROP TRIGGER IF EXISTS fail_at_chunk1;`);
    (cfg.config.pipeline as { matchingChunkSize: number }).matchingChunkSize = orig;
  }
});

/* --------------------------------- cleanup --------------------------------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
