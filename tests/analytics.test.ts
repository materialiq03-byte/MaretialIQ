/**
 * PRD/TRD gap-closure tests — `npx tsx tests/analytics.test.ts`.
 *
 * Covers TRD §34 "Metrics" (precision/recall/F1 vs labelled ground truth),
 * TRD §20 "Analytics" (DB-derived aggregates) and the §38 acceptance items
 * introduced with the analytics page. Runs on a disposable temp database;
 * data/materialiq.db is untouched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { analyzeImport, executeImport } from '../src/lib/services/import-center-service';
import { runMatching } from '../src/lib/services/matching-service';
import { getAnalytics } from '../src/lib/services/analytics-service';
import { evaluateAgainstGroundTruth } from '../src/lib/matching/evaluation';

const failures: string[] = [];
let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  FAIL - ${name}`);
  }
}

/* ---------- disposable database seeded with the synthetic dataset ---------- */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-analytics-'));
const testDb = new DatabaseSync(path.join(tmpDir, 'test.db'));
setDbForTests(testDb);
migrate(testDb);

function seedOrgs(): Map<string, number> {
  const now = new Date().toISOString();
  const ids = new Map<string, number>();
  for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
    const res = testDb
      .prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run(code, `${code} (synthetic demo)`, now, now);
    ids.set(code, Number(res.lastInsertRowid));
  }
  return ids;
}

const CSV_DIR = path.join(process.cwd(), 'data', 'synthetic-imports');
const FILES: Array<[string, string]> = [
  ['CPCL', 'CPCL.csv'],
  ['NTPC', 'NTPC.csv'],
  ['BHEL', 'BHEL.csv'],
  ['NLC', 'NLC.csv'],
  ['SAIL', 'SAIL.csv'],
];

function importAll(orgIds: Map<string, number>): void {
  for (const [orgCode, file] of FILES) {
    const parsed = analyzeImport({
      organizationId: orgIds.get(orgCode)!,
      fileName: file,
      fileType: 'csv',
      payload: fs.readFileSync(path.join(CSV_DIR, file), 'utf8'),
    });
    if (!parsed.mappingUsable) throw new Error(`mapping unusable for ${file}`);
    executeImport({ importId: parsed.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'analytics-tests' });
  }
}

importAll(seedOrgs());
runMatching('analytics-tests');

/* ------------------------------- §34 metrics ------------------------------ */

test('§34 precision/recall/F1 computed against labelled ground truth', () => {
  const ev = evaluateAgainstGroundTruth();
  assert.ok(ev.evaluatedPairs >= 80, `expected >=80 labelled pairs, got ${ev.evaluatedPairs}`);
  assert.ok(ev.positives > 30 && ev.negatives > 30, `unbalanced labels: ${ev.positives}P/${ev.negatives}N`);
  // core PRD safety claim: conflicts are caught, not auto-approved
  assert.equal(ev.unsafeAutoMatches, 0, 'labelled conflicts must never be auto-approved');
  assert.equal(ev.falsePositives, 0);
  // the engine finds the true duplicates
  assert.ok(ev.recall >= 0.9, `recall ${ev.recall} below 0.9`);
  assert.ok(ev.precision >= 0.9, `precision ${ev.precision} below 0.9`);
  assert.ok(ev.f1 >= 0.9, `f1 ${ev.f1} below 0.9`);
  // uncertainty is surfaced, not hidden
  assert.ok(ev.humanReviewRate > 0, 'some pairs must route to review');
});

test('§34 metrics are deterministic across repeated evaluation', () => {
  const a = evaluateAgainstGroundTruth();
  const b = evaluateAgainstGroundTruth();
  assert.equal(a.f1, b.f1);
  assert.equal(a.evaluatedPairs, b.evaluatedPairs);
});

/* ----------------------------- §20 analytics ------------------------------ */

test('§20 analytics aggregates derive from the database (FR-16)', () => {
  const a = getAnalytics();
  assert.equal(a.materialsByOrg.length, 5, 'five CPSEs represented');
  assert.equal(a.materialsByOrg.reduce((s, r) => s + r.n, 0), 50, '50 imported materials');
  assert.equal(a.materialsByCategory.length, 5, 'five categories');
  assert.ok(a.decisions.length > 0, 'decision distribution present');
  const decisions = a.decisions.map((d) => d.decision);
  assert.ok(decisions.includes('HIGH_CONFIDENCE_MATCH'));
  assert.ok(decisions.includes('NEEDS_TECHNICAL_REVIEW'));
  assert.ok(a.topConflicts.length > 0, 'conflict breakdown present');
  // per-CPSE table carries the key columns
  for (const row of a.cpseTable) {
    assert.equal(row.materials, 10, `${row.code} has 10 materials`);
    assert.ok(row.candidates > 0, `${row.code} participates in candidates`);
  }
});

test('§20 analytics totals stay consistent after re-running the matcher', () => {
  const before = getAnalytics();
  runMatching('analytics-tests'); // idempotent rerun
  const after = getAnalytics();
  assert.equal(after.decisions.find((d) => d.decision === 'HIGH_CONFIDENCE_MATCH')?.n,
               before.decisions.find((d) => d.decision === 'HIGH_CONFIDENCE_MATCH')?.n);
  assert.equal(after.materialsByOrg.length, before.materialsByOrg.length);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(failures.map((f) => ` - ${f}`).join('\n'));
  process.exitCode = 1;
}
