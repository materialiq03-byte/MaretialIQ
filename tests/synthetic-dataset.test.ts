/**
 * Step 6 + 7 verification tests — `npx tsx tests/synthetic-dataset.test.ts`.
 *
 * Verifies the synthetic CPSE dataset (data/synthetic-imports/*.csv) flows
 * through the real Import Center (parse → validate → execute) and that the
 * Step 5 matching engine produces the designed scenarios WITHOUT any
 * hard-coded results. DB-backed tests run on a disposable temp database;
 * data/materialiq.db is never touched by this suite.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests, getDb } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { parseImportFile } from '../src/lib/services/file-parse-service';
import { suggestMapping, validateRows, mappingIsUsable } from '../src/lib/services/import-validation';
import { analyzeImport, executeImport } from '../src/lib/services/import-center-service';
import { runMatching, decideMatch, createCmiFromMatch } from '../src/lib/services/matching-service';
import { getDashboardMetrics } from '../src/lib/db/repositories/metrics-repository';
import { listAudit } from '../src/lib/db/repositories/audit-repository';
import { getMatch } from '../src/lib/db/repositories/matching-repository';
import type { DecisionState } from '../src/lib/matching/decision';

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
    console.log(`  FAIL - ${name}`);
  }
}

const CSV_DIR = path.join(process.cwd(), 'data', 'synthetic-imports');
const CPSE_FILES = ['CPCL.csv', 'NTPC.csv', 'BHEL.csv', 'NLC.csv', 'SAIL.csv'];

/* ---------------- §11.1 dataset validates; §11.4 dedup ------------------- */

test('all five synthetic CSVs parse and validate 10 rows each through the real pipeline', () => {
  for (const file of CPSE_FILES) {
    const parsed = parseImportFile(file, fs.readFileSync(path.join(CSV_DIR, file), 'utf8'));
    assert.equal(parsed.rows.length, 10, `${file} must contain 10 rows`);
    const { mapping } = suggestMapping(parsed.headers);
    assert.ok(mappingIsUsable(mapping), `${file} headers must auto-map`);
    const result = validateRows(parsed.rows, mapping, new Map());
    assert.equal(result.summary.errors, 0, `${file}: unexpected validation errors`);
    assert.ok(result.summary.valid + result.summary.warnings === 10, `${file}: all rows valid or warned`);
  }
});

test('validation-scenarios file flags every designed rule (missing code/desc, dup, bad category, malformed qty, bad UOM, bad code)', () => {
  const parsed = parseImportFile('VALIDATION-SCENARIOS.csv', fs.readFileSync(path.join(CSV_DIR, 'VALIDATION-SCENARIOS.csv'), 'utf8'));
  const { mapping } = suggestMapping(parsed.headers);
  const result = validateRows(parsed.rows, mapping, new Map());
  const rules = new Set(result.rows.flatMap((r) => r.problems.map((p) => p.rule)));
  for (const rule of [
    'duplicate_in_file', 'required_material_code', 'required_description', 'unknown_category',
    'malformed_quantity', 'unknown_uom', 'invalid_code_format',
  ]) {
    assert.ok(rules.has(rule), `expected rule ${rule} to fire`);
  }
  assert.ok(result.summary.errors > 0, 'invalid rows must be errors');
});

test('duplicate material code within same CPSE is an error and duplicate-in-database maps to the existing record', () => {
  const parsed = parseImportFile('BHEL.csv', fs.readFileSync(path.join(CSV_DIR, 'BHEL.csv'), 'utf8'));
  const { mapping } = suggestMapping(parsed.headers);
  const existing = new Map([['BH-3001', { materialId: 999, originalCode: 'BH-3001' }]]);
  const result = validateRows(parsed.rows, mapping, existing);
  const dup = result.rows.find((r) => r.duplicateOf);
  assert.ok(dup && dup.duplicateOf?.materialId === 999);
  assert.ok(dup.problems.some((p) => p.rule === 'duplicate_in_database'));
});

/* --------------- DB-backed: full import → match → decide ------------------ */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-synth-'));
const testDb = new DatabaseSync(path.join(tmpDir, 'test.db'));
migrate(testDb);
setDbForTests(testDb);

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

function importCsv(orgCode: string, orgId: number, file: string): number {
  const out = analyzeImport({
    organizationId: orgId,
    fileName: file,
    fileType: 'csv',
    payload: fs.readFileSync(path.join(CSV_DIR, file), 'utf8'),
  });
  assert.ok(out.mappingUsable, `${file}: mapping must be usable`);
  executeImport({ importId: out.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'synthetic-tests' });
  return out.importId;
}

function pairBetween(a: string, b: string) {
  const row = getDb()
    .prepare(
      `SELECT mc.id FROM match_candidates mc
         JOIN material_records s ON s.id = mc.source_material_id
         JOIN material_records c ON c.id = mc.candidate_material_id
        WHERE (s.original_code = ? AND c.original_code = ?) OR (s.original_code = ? AND c.original_code = ?)`
    )
    .get(a, b, b, a) as { id: number } | undefined;
  return row ? getMatch(row.id) : undefined;
}

function decisionOf(codeA: string, codeB: string): { state: DecisionState; score: number; conflict: string | null } | null {
  const m = pairBetween(codeA, codeB);
  if (!m) return null;
  const ev = m.candidate.evidence ? (JSON.parse(m.candidate.evidence) as { decision?: { state?: DecisionState } }) : null;
  return {
    state: ev?.decision?.state ?? 'LOW_CONFIDENCE',
    score: m.candidate.final_score,
    conflict: m.candidate.critical_difference,
  };
}

const orgIds = seedOrgs();
let importIds: number[] = [];

/** Count helper — node:sqlite .get() is typed loosely under strict mode. */
function count(sql: string, ...params: Array<string | number>): number {
  return (getDb().prepare(sql).get(...params) as { n: number | null }).n ?? 0;
}

test('§11.2 ten valid records import per CPSE through analyze→execute (50 total)', () => {
  importIds = CPSE_FILES.map((f) => {
    const orgCode = f.replace('.csv', '');
    return importCsv(orgCode, orgIds.get(orgCode)!, f);
  });
  assert.equal(count('SELECT COUNT(*) n FROM material_records'), 50);
  for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
    assert.equal(
      count('SELECT COUNT(*) n FROM material_records m JOIN organizations o ON o.id=m.organization_id WHERE o.code = ?', code),
      10,
      `${code} must have 10 records`
    );
  }
});

test('§11.5 imported records carry correct organization FK + source row traceability', () => {
  const bad = count(
    `SELECT COUNT(*) n FROM material_records m
      WHERE m.import_id IS NULL OR m.source_row IS NULL
         OR NOT EXISTS (SELECT 1 FROM data_imports d WHERE d.id = m.import_id AND d.organization_id = m.organization_id)`
  );
  assert.equal(bad, 0);
});

test('§11.4 re-importing the same file skips all 10 (no silent overwrite)', () => {
  const importId = importCsv('CPCL', orgIds.get('CPCL')!, 'CPCL.csv');
  const counts = getDb()
    .prepare(`SELECT imported_rows, skipped_existing_rows FROM data_imports WHERE id = ?`)
    .get(importId) as { imported_rows: number; skipped_existing_rows: number };
  assert.equal(counts?.imported_rows, 0);
  assert.equal(counts?.skipped_existing_rows, 10);
  assert.equal(count('SELECT COUNT(*) n FROM material_records'), 50);
});

test('§11.6 §11.13 existing seed-style records untouched by re-import; import history + audit recorded', () => {
  // Original descriptions must be byte-identical after the duplicate re-import.
  const row = getDb()
    .prepare(`SELECT original_description FROM material_records WHERE original_code = 'CP-6001'`)
    .get() as { original_description: string } | undefined;
  assert.equal(row?.original_description, 'SKF BALL BEARING 6308-2RS');
  const audits = listAudit({ page: 1, pageSize: 50 });
  assert.ok(audits.items.some((a) => a.action === 'import_performed'));
  assert.ok(count(`SELECT COUNT(*) n FROM data_imports WHERE status = 'completed'`) >= 6);
});

test('§11.12 Step 5 engine runs unchanged over the imported dataset', () => {
  const summary = runMatching('synthetic-tests');
  assert.ok(summary.pairsCompared > 100, `expected many pairs, got ${summary.pairsCompared}`);
  assert.ok(summary.candidatesCreated > 50);
});

test('§11.7 §19.1 strong bearing similarity yields HIGH_CONFIDENCE_MATCH candidates (no hard-coding)', () => {
  for (const [a, b] of [['CP-6001', 'NT-6401'], ['CP-6001', 'NL-7701'], ['CP-6001', 'SL-9901']] as const) {
    const d = decisionOf(a, b);
    assert.ok(d, `candidate ${a} vs ${b} must exist`);
    assert.equal(d.state, 'HIGH_CONFIDENCE_MATCH');
  }
});

test('§11.8 §19.2 2RS vs ZZ (CP-6001 vs BH-3001) → NEEDS_TECHNICAL_REVIEW naming both values', () => {
  const d = decisionOf('CP-6001', 'BH-3001');
  assert.ok(d);
  assert.equal(d.state, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(d.conflict?.includes('seal_type') && d.conflict?.includes('2RS') && d.conflict?.includes('ZZ'), d.conflict ?? '');
  const m = pairBetween('CP-6001', 'BH-3001')!;
  assert.ok(m.candidate.explanation.includes('Critical difference'));
});

test('§11.9 §19.3 valve Class 150 vs Class 300 (CP-6002 vs NT-6402) → NEEDS_TECHNICAL_REVIEW', () => {
  const d = decisionOf('CP-6002', 'NT-6402');
  assert.ok(d);
  assert.equal(d.state, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(d.conflict?.includes('pressure_class'), d.conflict ?? '');
});

test('§11.10 §19.4 motor 415V vs 230V (CP-6005 vs BH-3005) → NEEDS_TECHNICAL_REVIEW; identical specs → HIGH', () => {
  const conflict = decisionOf('CP-6005', 'BH-3005');
  assert.ok(conflict);
  assert.equal(conflict.state, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(conflict.conflict?.includes('voltage_rating'), conflict.conflict ?? '');
  const same = decisionOf('CP-6005', 'BH-3006');
  assert.ok(same);
  assert.equal(same.state, 'HIGH_CONFIDENCE_MATCH');
});

test('§11.11 §19.5 different categories are never harmonized', () => {
  const cross = count(
    `SELECT COUNT(*) n FROM match_candidates mc
       JOIN material_records s ON s.id = mc.source_material_id
       JOIN material_records c ON c.id = mc.candidate_material_id
      WHERE s.category != c.category`
  );
  assert.equal(cross, 0);
  // Explicit gate test through the scoring path:
  const { scorePair } = require('../src/lib/matching/engine') as typeof import('../src/lib/matching/engine');
  const a = { id: 9001, organizationId: 1, orgCode: 'CPCL', originalCode: 'X1', originalDescription: 'SKF BALL BEARING 6205-2RS', normalizedDescription: 'SKF BALL BEARING 6205-2RS', category: 'Bearings', manufacturer: 'SKF', model: null, partNumber: null, uom: 'EA', attributes: [] };
  const b = { ...a, id: 9002, orgCode: 'NTPC', category: 'Pumps', originalDescription: 'SKF BALL BEARING 6205-2RS PUMP' };
  const s = scorePair(a, b);
  assert.equal(s.matchType, 'different');
});

test('§19.6 abbreviation normalization (D.G. BRG / CENT. PMP / BRG / V/V) matches canonical wording', () => {
  const d1 = decisionOf('NT-6408', 'NL-7709'); // D.G. BRG vs plain BEARING
  assert.ok(d1 && d1.state === 'HIGH_CONFIDENCE_MATCH');
  const d2 = decisionOf('BH-3003', 'SL-9903'); // CENT. PMP vs CENTRIFUGAL PUMP
  assert.ok(d2 && d2.state === 'HIGH_CONFIDENCE_MATCH');
  // V/V gate-valve abbreviation: normalize V/V → gate valve candidate exists
  const gate = pairBetween('CP-6002', 'SL-9902');
  assert.ok(gate, 'gate valve twins must pair');
});

test('§19.7 missing attributes force review, never equivalence', () => {
  // NT-6405 has no B3 mount token vs CP-6005 (mounting attr present on one side only).
  const d = decisionOf('CP-6005', 'NT-6405');
  assert.ok(d);
  assert.notEqual(d.state, 'HIGH_CONFIDENCE_MATCH');
});

test('§19.8 review queue entries created for review-band candidates', () => {
  const open = count(`SELECT COUNT(*) n FROM review_queue WHERE status = 'open'`);
  assert.ok(open > 20, `expected many open queue items, got ${open}`);
  const q = getDb()
    .prepare(
      `SELECT rq.id FROM review_queue rq JOIN match_candidates mc ON mc.id = rq.match_id
        WHERE mc.critical_difference LIKE '%seal_type%' AND rq.status = 'open' LIMIT 1`
    )
    .get();
  assert.ok(q, 'seal-conflict pair must be queued');
});

test('§19.9 approval gating: CMI requires human-approved match; §19.10 legacy codes preserved', () => {
  const reviewPair = pairBetween('CP-6001', 'BH-3001')!;
  assert.throws(
    () => createCmiFromMatch({ code: 'NMC-SHOULD-FAIL', name: 'x', category: 'Bearings', matchId: reviewPair.candidate.id }, 'tests'),
    /only be created from an approved match/
  );
  const high = pairBetween('CP-6001', 'NT-6401')!;
  decideMatch(high.candidate.id, { decision: 'approved', reviewer: 'verifier', comment: 'verified' }, 'synthetic-tests');
  const cmi = createCmiFromMatch(
    { code: 'NMC-TEST-0001', name: 'Ball bearing 6308-2RS (synthetic demo)', category: 'Bearings', matchId: high.candidate.id },
    'synthetic-tests'
  );
  assert.equal(cmi.mappingsCreated, 2);
  // Original codes untouched and still present.
  const codes = getDb()
    .prepare(`SELECT original_code FROM material_records WHERE original_code IN ('CP-6001','NT-6401') ORDER BY original_code`)
    .all() as Array<{ original_code: string }>;
  assert.deepEqual(codes.map((c) => c.original_code), ['CP-6001', 'NT-6401']);
});

test('§19.11 audit trail records matching run, decision, mapping', () => {
  const actions = new Set(listAudit({ page: 1, pageSize: 200 }).items.map((a) => a.action));
  for (const action of ['match_generated', 'proposal_approved', 'common_material_created', 'mapping_created', 'import_performed'] as const) {
    assert.ok(actions.has(action), `audit must contain ${action}`);
  }
});

test('§19.12 dashboard metrics come from the database (§15)', () => {
  const m = getDashboardMetrics(null);
  assert.equal(m.totalMaterials, 50);
  assert.equal(m.organizations, 5);
  assert.ok(m.highConfidenceCandidates > 0);
  assert.ok(m.pendingReviews > 0);
  assert.ok(m.commonIdentities >= 1);
  assert.equal(count(`SELECT COUNT(*) n FROM common_materials WHERE code = 'NMC-TEST-0001'`), 1);
});

test('§11.14 §18 no official/national material code generated or implied', () => {
  // Every CMI code in the system must be an explicit prototype identifier,
  // never an NMC-style official code created automatically by the engine.
  const cmis = getDb().prepare(`SELECT code FROM common_materials`).all() as Array<{ code: string }>;
  for (const c of cmis) {
    assert.match(c.code, /^(CMI-|NMC-TEST-|NMC-000)/, `CMI code ${c.code} must be a labelled prototype identifier`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error(failures.map((f) => ` - ${f}`).join('\n'));
  process.exitCode = 1;
}
