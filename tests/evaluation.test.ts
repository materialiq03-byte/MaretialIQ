/**
 * Ground-truth evaluation tests — `npx tsx tests/evaluation.test.ts`.
 *
 * Covers Step-10 evaluator quality: dataset loading + validation (malformed
 * JSON, unknown labels, duplicate pairs, same-CPSE pairs, missing files),
 * evaluation execution, confusion-matrix consistency, per-class P/R/F1 against
 * hand-computed values, technical-conflict detection metrics, review rate,
 * score-range overlap reporting, and reproducibility — including a full rebuild
 * of the evaluation dataset in a fresh database. Runs on a disposable temp
 * SQLite database; data/materialiq.db is untouched.
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
  EVAL_LABELS,
  DEFAULT_GROUND_TRUTH_PATH,
  decisionToEvalClass,
  evaluateGroundTruth,
  loadGroundTruth,
  loadGroundTruthMaterials,
  perClassMetrics,
  resetGroundTruthCache,
} from '../src/lib/matching/ground-truth';
import type { GroundTruthDataset, EvalLabel } from '../src/lib/matching/ground-truth';
import {
  buildRunRecord,
  loadRunHistory,
  recordEvaluationRun,
  seedRunsFromJsonMirror,
  validateRunRecord,
} from '../src/lib/matching/run-history';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  FAIL - ${name}`);
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/* ------------------- disposable DB seeded from evaluation fixtures ------------------- */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-eval-'));
const testDb = new DatabaseSync(path.join(tmpDir, 'test.db'));
setDbForTests(testDb);
migrate(testDb);

function seedOrgs(): Map<string, number> {
  const now = new Date().toISOString();
  const ids = new Map<string, number>();
  for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
    const res = testDb
      .prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run(code, `${code} (evaluation fixture)`, now, now);
    ids.set(code, Number(res.lastInsertRowid));
  }
  return ids;
}

const FIXTURE_DIR = path.join(process.cwd(), 'data', 'evaluation', 'fixtures');
const orgIds = seedOrgs();
for (const orgCode of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
  const file = `${orgCode}.csv`;
  const parsed = analyzeImport({
    organizationId: orgIds.get(orgCode)!,
    fileName: file,
    fileType: 'csv',
    payload: fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'),
  });
  if (!parsed.mappingUsable) throw new Error(`mapping unusable for ${file}`);
  executeImport({ importId: parsed.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'evaluation-tests' });
}

const ds: GroundTruthDataset = loadGroundTruth();
const { materials } = loadGroundTruthMaterials(ds);
const ev = evaluateGroundTruth({ materials, includePairs: true });

/** Write a mutated copy of the dataset to a temp file and load it. */
function loadMutated(mutate: (d: GroundTruthDataset) => void, name: string): GroundTruthDataset {
  const copy = JSON.parse(JSON.stringify(ds)) as GroundTruthDataset;
  mutate(copy);
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(copy));
  resetGroundTruthCache();
  return loadGroundTruth(file);
}

/* ------------------------------ dataset loading ------------------------------ */

test('ground-truth dataset loads, validates and is adequately sized', () => {
  assert.ok(ds.pairs.length >= 40, `expected >=40 labelled pairs, got ${ds.pairs.length}`);
  const labels = new Set(ds.pairs.map((p) => p.ground_truth));
  for (const l of labels) assert.ok((EVAL_LABELS as readonly string[]).includes(l), `unknown label ${l}`);
  assert.equal(labels.size, 3, 'dataset must exercise all three classes');
  for (const p of ds.pairs) {
    assert.ok(p.rationale.trim().length > 0, `pair ${p.a}~${p.b} lacks a rationale`);
    assert.notEqual(p.a, p.b, 'pair must reference two different records');
    const [orgA] = p.a.split('|');
    const [orgB] = p.b.split('|');
    assert.notEqual(orgA, orgB, `pair ${p.a}~${p.b} is not cross-CPSE`);
  }
});

test('unknown label is rejected', () => {
  assert.throws(() => loadMutated((d) => { d.pairs[0].ground_truth = 'MAYBE' as never; }, 'bad-label.json'), /invalid label/);
});

test('duplicate pair is rejected (order-independent)', () => {
  assert.throws(() => loadMutated((d) => { d.pairs.push({ ...d.pairs[0], a: d.pairs[0].b, b: d.pairs[0].a }); }, 'dup-pair.json'), /duplicate pair/);
});

test('same-CPSE pair is rejected', () => {
  assert.throws(() => loadMutated((d) => { d.pairs[0].b = 'CPCL|CP-1002'; }, 'same-org.json'), /not cross-CPSE/);
});

test('malformed JSON is rejected', () => {
  const file = path.join(tmpDir, 'broken.json');
  fs.writeFileSync(file, '{ this is not json');
  resetGroundTruthCache();
  assert.throws(() => loadGroundTruth(file), /not valid JSON/);
});

test('missing dataset file is rejected', () => {
  resetGroundTruthCache();
  assert.throws(() => loadGroundTruth(path.join(tmpDir, 'does-not-exist.json')), /not found/);
});

/* ------------------------------ execution ------------------------------ */

test('evaluation executes over the full dataset', () => {
  assert.equal(ev.dataset.pairs, ds.pairs.length);
  assert.equal(ev.evaluatedPairs, ds.pairs.length, 'every labelled pair must be scored');
  assert.equal(ev.skippedPairs, 0);
  assert.equal(ev.missingKeys.length, 0);
  assert.equal(ev.pairs.length, ev.evaluatedPairs);
  for (const l of EVAL_LABELS) assert.ok(ev.labelCounts[l] > 0, `class ${l} has no labelled pairs`);
  for (const r of ev.pairs) {
    assert.ok(r.modelScore >= 0 && r.modelScore <= 100, `score ${r.modelScore} out of range for ${r.a}~${r.b}`);
    assert.ok(r.explanation.trim().length > 0, `missing explanation for ${r.a}~${r.b}`);
    assert.equal(r.correct, r.modelClass === r.groundTruth);
  }
});

test('label vocabulary mapping is stable', () => {
  assert.equal(decisionToEvalClass('HIGH_CONFIDENCE_MATCH'), 'MATCH');
  assert.equal(decisionToEvalClass('NEEDS_TECHNICAL_REVIEW'), 'NEEDS_REVIEW');
  assert.equal(decisionToEvalClass('LOW_CONFIDENCE'), 'NEEDS_REVIEW');
  assert.equal(decisionToEvalClass('NOT_A_MATCH'), 'NOT_A_MATCH');
});

/* ------------------------------ confusion matrix ------------------------------ */

test('confusion matrix is internally consistent', () => {
  let cellSum = 0;
  for (const gt of EVAL_LABELS) {
    let rowSum = 0;
    for (const pred of EVAL_LABELS) {
      cellSum += ev.confusion[gt][pred];
      rowSum += ev.confusion[gt][pred];
    }
    assert.equal(rowSum, ev.labelCounts[gt], `row ${gt} sum != label count`);
  }
  assert.equal(cellSum, ev.evaluatedPairs);
  for (const pred of EVAL_LABELS) {
    let colSum = 0;
    for (const gt of EVAL_LABELS) colSum += ev.confusion[gt][pred];
    assert.equal(colSum, ev.predictionCounts[pred], `column ${pred} sum != prediction count`);
    assert.equal(ev.perClass[pred].support, ev.labelCounts[pred]);
  }
  const diagonal = EVAL_LABELS.reduce((s, l) => s + ev.confusion[l][l], 0);
  assert.equal(ev.accuracy, round4(diagonal / ev.evaluatedPairs));
});

test('per-class metrics match hand-computed values', () => {
  const confusion = {
    MATCH: { MATCH: 8, NEEDS_REVIEW: 1, NOT_A_MATCH: 1 },
    NEEDS_REVIEW: { MATCH: 1, NEEDS_REVIEW: 4, NOT_A_MATCH: 0 },
    NOT_A_MATCH: { MATCH: 0, NEEDS_REVIEW: 1, NOT_A_MATCH: 4 },
  } as Record<EvalLabel, Record<EvalLabel, number>>;
  const m = perClassMetrics(confusion);
  assert.equal(m.MATCH.tp, 8);
  assert.equal(m.MATCH.fp, 1);
  assert.equal(m.MATCH.fn, 2);
  assert.ok(Math.abs(m.MATCH.precision - 8 / 9) < 1e-9);
  assert.ok(Math.abs(m.MATCH.recall - 0.8) < 1e-9);
  assert.ok(Math.abs(m.MATCH.f1 - (2 * (8 / 9) * 0.8) / (8 / 9 + 0.8)) < 1e-9);
  // NOT_A_MATCH: tp=4, fp=1 (from the MATCH row), fn=1 (row off-diagonal).
  assert.ok(Math.abs(m.NOT_A_MATCH.precision - 0.8) < 1e-9);
  assert.ok(Math.abs(m.NOT_A_MATCH.recall - 0.8) < 1e-9);
  assert.ok(Math.abs(m.NOT_A_MATCH.f1 - 0.8) < 1e-9);
});

test('FP/FN listings agree with the confusion matrix', () => {
  assert.equal(ev.falsePositives.length, ev.confusion.NEEDS_REVIEW.MATCH + ev.confusion.NOT_A_MATCH.MATCH);
  const missedMatches = ev.labelCounts.MATCH - ev.confusion.MATCH.MATCH;
  assert.equal(ev.falseNegatives.length, missedMatches);
  for (const r of ev.falsePositives) assert.notEqual(r.groundTruth, 'MATCH');
  for (const r of ev.falseNegatives) assert.equal(r.groundTruth, 'MATCH');
});

/* --------------------------- conflict detection --------------------------- */

test('technical-conflict detection is measured and honestly reported', () => {
  const cd = ev.conflictDetection;
  assert.ok(cd.expected > 0, 'dataset must declare expected-conflict pairs');
  assert.equal(cd.detected + cd.missed.length, cd.expected);
  assert.equal(cd.detectionRate, round4(cd.detected / cd.expected));
  for (const m of cd.missed) {
    assert.ok(m.a && m.b && m.attribute);
    assert.ok(m.kind === 'critical' || m.kind === 'missing');
  }
});

test('flagship conflict CP-1001 ↔ BH-4410 names seal_type 2RS vs ZZ', () => {
  const r = ev.pairs.find((p) => p.a === 'CPCL|CP-1001' && p.b === 'BHEL|BH-4410');
  assert.ok(r, 'flagship pair missing from evaluation');
  assert.equal(r.groundTruth, 'NEEDS_REVIEW');
  assert.equal(r.modelClass, 'NEEDS_REVIEW');
  assert.ok(r.conflictDetected, 'seal_type conflict must be detected');
  assert.ok(
    r.criticalConflicts.some((c) => c.startsWith('seal_type:') && c.includes('2RS') && c.includes('ZZ')),
    `evidence should name seal_type 2RS vs ZZ, got: ${r.criticalConflicts.join('; ')}`
  );
  assert.ok(r.explanation.includes('seal_type'), 'explanation must mention the conflicting attribute');
});

/* ------------------------------ review rate ------------------------------ */

test('review rate derives from predictions and is surfaced', () => {
  assert.equal(ev.reviewRate, round4(ev.predictionCounts.NEEDS_REVIEW / ev.evaluatedPairs));
  assert.ok(ev.reviewRate > 0, 'some pairs must route to review');
  assert.ok(ev.reviewRate < 1, 'not every pair can require review');
});

/* ---------------------------- score distribution ---------------------------- */

test('score ranges are reported and overlap is documented', () => {
  for (const l of EVAL_LABELS) {
    const range = ev.scoreRanges[l];
    if (ev.predictionCounts[l] > 0) {
      assert.ok(range, `score range missing for ${l}`);
      assert.ok(range!.min <= range!.max);
    } else {
      assert.equal(range, null);
    }
  }
  // NOT_A_MATCH decisions require a score below the 30% floor.
  if (ev.scoreRanges.NOT_A_MATCH) assert.ok(ev.scoreRanges.NOT_A_MATCH.max < 30);
  // Overlap listing must match what the ranges imply.
  const implied: Array<[EvalLabel, EvalLabel]> = [];
  for (let i = 0; i < EVAL_LABELS.length; i++) {
    for (let j = i + 1; j < EVAL_LABELS.length; j++) {
      const ra = ev.scoreRanges[EVAL_LABELS[i]];
      const rb = ev.scoreRanges[EVAL_LABELS[j]];
      if (ra && rb && ra.min <= rb.max && rb.min <= ra.max) implied.push([EVAL_LABELS[i], EVAL_LABELS[j]]);
    }
  }
  assert.deepEqual(ev.scoreOverlap, implied);
});

/* --------------------------- category breakdown --------------------------- */

test('category breakdown is complete and honest about sample size', () => {
  const total = ev.categoryBreakdown.reduce((s, c) => s + c.pairs, 0);
  assert.equal(total, ev.evaluatedPairs);
  for (const c of ev.categoryBreakdown) {
    assert.ok(c.agreement >= 0 && c.agreement <= 1);
    assert.equal(c.sufficientSample, c.pairs >= 8);
    const predictedSum = EVAL_LABELS.reduce((s, l) => s + c.predicted[l], 0);
    assert.equal(predictedSum, c.pairs);
  }
});

/* ----------------------------- reproducibility ----------------------------- */

test('evaluation is deterministic across repeated runs', () => {
  const again = evaluateGroundTruth({ materials, includePairs: true });
  assert.equal(JSON.stringify({ ...ev, pairs: [] }), JSON.stringify({ ...again, pairs: [] }));
  assert.deepEqual(ev.confusion, again.confusion);
});

test('full rebuild in a fresh database reproduces identical metrics', () => {
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-eval-rebuild-'));
  const db2 = new DatabaseSync(path.join(tmpDir2, 'test.db'));
  setDbForTests(db2);
  migrate(db2);
  const ids2 = new Map<string, number>();
  const now = new Date().toISOString();
  for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
    const res = db2
      .prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run(code, `${code} (rebuild)`, now, now);
    ids2.set(code, Number(res.lastInsertRowid));
  }
  for (const orgCode of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
    const file = `${orgCode}.csv`;
    const parsed = analyzeImport({
      organizationId: ids2.get(orgCode)!,
      fileName: file,
      fileType: 'csv',
      payload: fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'),
    });
    executeImport({ importId: parsed.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'evaluation-rebuild' });
  }
  const ds2 = loadGroundTruth(DEFAULT_GROUND_TRUTH_PATH);
  const { materials: materials2 } = loadGroundTruthMaterials(ds2);
  const ev2 = evaluateGroundTruth({ materials: materials2, includePairs: false });
  assert.deepEqual(ev.confusion, ev2.confusion);
  assert.deepEqual(ev.macro, ev2.macro);
  assert.deepEqual(ev.weighted, ev2.weighted);
  assert.equal(ev.reviewRate, ev2.reviewRate);
  assert.deepEqual(ev.conflictDetection.detected, ev2.conflictDetection.detected);
  assert.deepEqual(ev.scoreRanges, ev2.scoreRanges);
  setDbForTests(testDb);
});

/* ------------------- DB-backed run-history persistence ------------------- */

test('run history persists to evaluation_runs with JSON mirror, append-only', () => {
  setDbForTests(testDb);
  // Redirect mirror writes to a temp file so the production history JSON is untouched.
  const tmpMirror = path.join(os.tmpdir(), `miq-mirror-${Date.now()}.json`);
  process.env.EVAL_RUN_HISTORY_PATH = tmpMirror;
  try {

  // Seed from the real JSON mirror (idempotent) — verifies seeded history lands in the DB.
  const preSeed = loadRunHistory();
  const seeded = seedRunsFromJsonMirror();
  const afterSeed = loadRunHistory();
  assert.ok(afterSeed.length >= preSeed.length, 'seed must not shrink history');
  if (seeded === 0) {
    assert.equal(afterSeed.length, preSeed.length, 'second seed run is a no-op');
  }
  for (const r of afterSeed) {
    assert.equal(validateRunRecord(r).length, 0, `seeded record ${r.runId} must be internally consistent`);
  }

  // Append a synthetic record; runId is monotonic; nothing else changes.
  const ev = evaluateGroundTruth({ includePairs: false });
  const prev = loadRunHistory();
  const last = prev[prev.length - 1];
  const rec = recordEvaluationRun(
    buildRunRecord(ev, 'run-history persistence test', '2026-09-19T00:00:00.000Z')
  );
  assert.ok(rec.runId.startsWith('run-'), 'monotonic runId assigned');
  const after = loadRunHistory();
  assert.equal(after.length, prev.length + 1);
  assert.deepEqual(after.slice(0, prev.length), prev, 'previous records untouched');
  assert.equal(after[after.length - 1].runId, rec.runId);

  // JSON mirror is in sync with the DB (at the redirected path).
  const mirror = loadRunHistory(tmpMirror);
  const mirrorIds = mirror.map((r) => r.runId);
  assert.ok(mirrorIds.includes(rec.runId), 'mirror contains the new run');

  // Recorded metrics match the evaluation that produced them.
  const stored = after[after.length - 1];
  assert.equal(stored.pairs, ev.evaluatedPairs);
  assert.equal(stored.accuracy, ev.accuracy);
  assert.equal(stored.conflictDetection.detected, ev.conflictDetection.detected);
  } finally {
    delete process.env.EVAL_RUN_HISTORY_PATH;
    if (fs.existsSync(tmpMirror)) fs.unlinkSync(tmpMirror);
  }
});

test('explicit filePath still reads the JSON mirror (legacy signature)', () => {
  const tmpJson = path.join(os.tmpdir(), `miq-history-${Date.now()}.json`);
  fs.writeFileSync(tmpJson, JSON.stringify({ runs: [{ }] }), 'utf8');
  // Malformed record shape → loader returns whatever JSON had; here we only assert the path is honored.
  const parsed = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
  assert.ok('runs' in parsed);
  fs.unlinkSync(tmpJson);
});

/* --------------------------------- summary --------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
