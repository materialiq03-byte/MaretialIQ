'use strict';
/**
 * Step 23 — matching & technical-review hardening tests.
 *
 * `npx tsx tests/matching-review-hardening.test.ts` (part of the chain).
 *
 *   1-15.  result contract, score breakdown, technical comparison semantics
 *          (exact / normalized / close / missing / critical conflict /
 *          nominal conflict / assembly / manufacturer / cross-category),
 *          verdicts
 *   16-19. review queue retrieval, filters, sorting, pagination
 *   20-31. evidence contract, decisions (accept/reject/defer), reason
 *          validation, authorization, audit + read silence, stale/duplicate
 *          safety, CMI handoff
 *   32.    known demo scenarios (§24)
 *   33-38. Steps 17-22 regressions
 *   39.    evaluation-parity guards (thresholds/weights/ground truth)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { getMatchReview, getReviewSummary, decideMatchHardened } from '../src/lib/services/match-review-service';
import { runMatching, decideMatch, createCmiFromMatch } from '../src/lib/services/matching-service';
import { listMatches } from '../src/lib/db/repositories/matching-repository';
import { listAudit, countAudit } from '../src/lib/db/repositories/audit-repository';
import { roleHasPermission } from '../src/lib/auth/permissions';
import { decisionSchema } from '../src/lib/validation/schemas';
import { classifyDecision, DECISION_THRESHOLDS } from '../src/lib/matching/decision';
import { RAW_WEIGHTS } from '../src/lib/matching/config';
import { compareAttribute } from '../src/lib/matching/compare';
import { runPipeline } from '../src/lib/pipeline';
import { SEED } from '../scripts/seed-data';
import {
  createSupplierRecord,
  createProcurementRecord,
  normalizeQuantity,
  getUomRuleRegistry,
  getCmiComparableDemand,
  getEffectiveUomRule,
  createUomDomainRule,
  transitionUomRuleLifecycle,
  proposeUomRuleAmendment,
  decideUomRuleAmendment,
  getUomRuleVersions,
  getUomRuleHistory,
  getGovernanceCockpit,
} from '../src/lib/services/procurement-service';
import { getAdapterRequired, listAdapters } from '../src/lib/integrations/registry';
import { analyzeIntegration } from '../src/lib/integrations/integration-service';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  process.env.CMI_SHORT_CIRCUIT = 'off';
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
    console.log(`  FAIL - ${name}: ${(e as Error).message}`);
  }
}

const REVIEWER = 'reviewer23@demo';

interface Fixture {
  db: DatabaseSync;
  orgIds: Map<string, number>;
  materialIds: Map<string, number>; // 'CODE' → id
  pairId: (aCode: string, bCode: string) => number | undefined;
}

function insertMaterial(
  f: Fixture,
  orgCode: string,
  code: string,
  description: string,
  category: string,
  manufacturer: string | null,
  attrs: Array<{ name: string; value: string; unit?: string; critical?: boolean }>,
): number {
  const out = runPipeline({ originalDescription: description, categoryOverride: category });
  const res = f.db
    .prepare(
      `INSERT INTO material_records
         (organization_id, original_code, original_description, normalized_description,
          category, subcategory, manufacturer, model, part_number, material_type, uom,
          processing_status, classification_confidence, classification_source, quality_status, quality_checks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      f.orgIds.get(orgCode) as number, code, description, out.normalizedDescription,
      out.classification.category ?? category, out.classification.subcategory ?? null,
      manufacturer, null, null, null, 'NOS',
      out.processingStatus, out.classification.confidence, out.classification.source,
      out.quality.status, JSON.stringify(out.quality.checks),
    );
  const id = Number(res.lastInsertRowid);
  for (const a of attrs) {
    f.db
      .prepare(
        `INSERT INTO material_attributes (material_id, attribute_name, value, normalized_value, unit, is_critical, extraction_method, confidence)
         VALUES (?, ?, ?, ?, ?, ?, 'rule', NULL)`,
      )
      .run(id, a.name, a.value, a.value, a.unit ?? null, a.critical ? 1 : 0);
  }
  f.materialIds.set(code, id);
  return id;
}

function bearingAttrs(seal: string, bore = '25', series = '6205'): Array<{ name: string; value: string; unit?: string; critical?: boolean }> {
  return [
    { name: 'bore_diameter', value: bore, unit: 'mm', critical: true },
    { name: 'outer_diameter', value: '52', unit: 'mm' },
    { name: 'width', value: '15', unit: 'mm' },
    { name: 'seal_type', value: seal, critical: true },
    { name: 'bearing_type', value: 'Deep groove ball', critical: true },
    { name: 'series', value: series, critical: true },
  ];
}

function baseFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-mrh23-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  setDbForTests(db);
  const now = new Date().toISOString();
  const insOrg = db.prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`);
  const orgIds = new Map<string, number>();
  for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
    orgIds.set(code, Number(insOrg.run(code, `${code} (step23 fixture)`, now, now).lastInsertRowid));
  }
  const f: Fixture = { db, orgIds, materialIds: new Map(), pairId: undefined as never };

  // Seeded demo dataset (same shape as scripts/seed.ts) — the known scenarios.
  for (const org of SEED) {
    for (const m of org.materials) {
      const out = runPipeline({ originalDescription: m.description, categoryOverride: m.category });
      const res = db
        .prepare(
          `INSERT INTO material_records
             (organization_id, original_code, original_description, normalized_description,
              category, subcategory, manufacturer, model, part_number, material_type, uom,
              processing_status, classification_confidence, classification_source, quality_status, quality_checks)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          orgIds.get(org.code) as number, m.code, m.description, out.normalizedDescription,
          out.classification.category ?? m.category, out.classification.subcategory ?? m.subcategory ?? null,
          m.manufacturer ?? null, m.model ?? null, null, m.materialType ?? null, m.uom ?? 'NOS',
          out.processingStatus, out.classification.confidence, out.classification.source,
          out.quality.status, JSON.stringify(out.quality.checks),
        );
      const materialId = Number(res.lastInsertRowid);
      f.materialIds.set(m.code, materialId);
      for (const a of out.attributes) {
        db.prepare(
          `INSERT INTO material_attributes (material_id, attribute_name, value, normalized_value, unit, is_critical, extraction_method, confidence)
           VALUES (?, ?, ?, ?, ?, ?, 'rule', ?)`,
        ).run(materialId, a.attributeName, a.value, a.normalizedValue ?? null, a.unit ?? null, a.isCritical ? 1 : 0, a.confidence ?? null);
      }
    }
  }

  // Crafted pairs for comparison semantics (§4-§11).
  insertMaterial(f, 'CPCL', 'M23-CLOSE-A', 'SKF BALL BEARING 6205 2RS', 'Bearings', 'SKF', bearingAttrs('2RS', '25'));
  insertMaterial(f, 'NTPC', 'M23-CLOSE-B', 'SKF BALL BEARING 6205 2RS', 'Bearings', 'SKF', bearingAttrs('2RS', '25.4'));
  insertMaterial(f, 'CPCL', 'M23-MISS-A', 'SKF BALL BEARING 6205', 'Bearings', 'SKF', bearingAttrs('2RS').filter((a) => a.name !== 'seal_type'));
  insertMaterial(f, 'NTPC', 'M23-MISS-B', 'SKF BALL BEARING 6205 2RS', 'Bearings', 'SKF', bearingAttrs('2RS'));
  insertMaterial(f, 'CPCL', 'M23-NOM-A', 'SKF BALL BEARING 6205 2RS', 'Bearings', 'SKF', bearingAttrs('2RS', '25', '6205'));
  insertMaterial(f, 'NTPC', 'M23-NOM-B', 'SKF BALL BEARING 6310 2RS', 'Bearings', 'SKF', bearingAttrs('2RS', '50', '6310'));
  insertMaterial(f, 'CPCL', 'M23-XBRD-A', 'SKF BALL BEARING 6205 2RS', 'Bearings', 'SKF', bearingAttrs('2RS'));
  insertMaterial(f, 'NTPC', 'M23-XBRD-B', 'SKF BALL BEARING 6205 2RS', 'Bearings', 'FAG', bearingAttrs('2RS'));
  insertMaterial(f, 'CPCL', 'M23-VLT-A', 'SIEMENS INDUCTION MOTOR 3PH', 'Motors', 'SIEMENS', [
    { name: 'motor_type', value: 'Induction', critical: true },
    { name: 'voltage_rating', value: '415', unit: 'V', critical: true },
    { name: 'power_rating', value: '75', unit: 'kW', critical: true },
  ]);
  insertMaterial(f, 'NTPC', 'M23-VLT-B', 'SIEMENS INDUCTION MOTOR 3PH', 'Motors', 'SIEMENS', [
    { name: 'motor_type', value: 'Induction', critical: true },
    { name: 'voltage_rating', value: '230', unit: 'V', critical: true },
    { name: 'power_rating', value: '75', unit: 'kW', critical: true },
  ]);
  insertMaterial(f, 'CPCL', 'M23-CLS-A', 'GATE VALVE 6IN 150 RF', 'Valves', 'L&T', [
    { name: 'valve_type', value: 'Gate', critical: true },
    { name: 'nominal_size', value: '6', unit: 'inch', critical: true },
    { name: 'pressure_class', value: '150#', critical: true },
  ]);
  insertMaterial(f, 'NTPC', 'M23-CLS-B', 'GATE VALVE 6IN 300 RF', 'Valves', 'L&T', [
    { name: 'valve_type', value: 'Gate', critical: true },
    { name: 'nominal_size', value: '6', unit: 'inch', critical: true },
    { name: 'pressure_class', value: '300#', critical: true },
  ]);

  const pairStmt = db.prepare(
    `SELECT mc.id FROM match_candidates mc
      JOIN material_records s ON s.id = mc.source_material_id
      JOIN material_records c ON c.id = mc.candidate_material_id
     WHERE (s.original_code = ? AND c.original_code = ?) OR (s.original_code = ? AND c.original_code = ?)`,
  );
  f.pairId = (a: string, b: string) => {
    const row = pairStmt.get(a, b, b, a) as unknown as { id: number } | undefined;
    return row?.id;
  };

  runMatching('step23-fixture');
  return f;
}

/* ------------------- 1-3: contract + breakdown + comparison ------------------- */

test('1. result contract: full reviewer-facing structure composed from persisted data', () => {
  const f = baseFixture();
  const id = f.pairId('CP-1001', 'NT-8821')!;
  const r = getMatchReview(id);
  assert.equal(r.candidateId, id);
  assert.equal(r.leftMaterial.code, 'CP-1001');
  assert.equal(r.rightMaterial.code, 'NT-8821');
  assert.equal(r.leftMaterial.cpse, 'CPCL');
  assert.equal(r.rightMaterial.cpse, 'NTPC');
  assert.ok(r.leftMaterial.attributes.length > 0, 'left attributes present');
  assert.ok(typeof r.semanticScore === 'number' && typeof r.fuzzyScore === 'number');
  assert.ok(typeof r.technicalScore === 'number' && typeof r.ruleScore === 'number');
  assert.ok(r.technicalComparison.length > 0);
  assert.ok(Array.isArray(r.conflicts) && Array.isArray(r.missingEvidence) && Array.isArray(r.matchedAttributes));
  assert.ok(['same', 'different', 'unknown'].includes(r.manufacturerRelationship));
  assert.ok(['same_category', 'cross_category'].includes(r.categoryRelationship));
  assert.ok(r.why.points.length >= 5, 'WHY explanation is substantive');
  assert.ok(r.thresholds.highConfidence === 80);
  f.db.close();
});

test('2. score breakdown: components sum from the frozen 30/20/30/20 weights', () => {
  const f = baseFixture();
  const id = f.pairId('CP-1001', 'NT-8821')!;
  const r = getMatchReview(id);
  const composed = Math.round(
    0.3 * r.semanticScore + 0.2 * r.fuzzyScore + 0.3 * r.technicalScore + 0.2 * r.ruleScore,
  );
  assert.equal(composed, r.finalScore, 'final = weighted composition of the four persisted signals');
  assert.deepEqual(RAW_WEIGHTS, { semantic: 0.3, fuzzy: 0.2, technical: 0.3, category: 0.2 }, 'frozen weights untouched');
  f.db.close();
});

test('3. technical comparison rows: attribute/left/right/relation/importance', () => {
  const f = baseFixture();
  const id = f.pairId('CP-1001', 'BH-4410')!;
  const r = getMatchReview(id);
  const seal = r.technicalComparison.find((c) => c.attribute === 'seal_type');
  assert.ok(seal, 'seal comparison present');
  assert.equal(seal.relation, 'CONFLICT');
  assert.equal(seal.importance, 'CRITICAL');
  assert.match(seal.leftValue ?? '', /2RS/);
  assert.match(seal.rightValue ?? '', /ZZ/);
  assert.ok(seal.basis.length > 0, 'each row carries its basis');
  f.db.close();
});

/* ------------------------ 4-9: comparison semantics ------------------------ */

test('4. exact attribute relation', () => {
  const f = baseFixture();
  const id = f.pairId('CP-1001', 'NT-8821')!;
  const r = getMatchReview(id);
  const bore = r.technicalComparison.find((c) => c.attribute === 'bore_diameter');
  assert.equal(bore?.relation, 'EXACT');
  assert.equal(bore?.importance, 'CRITICAL');
  f.db.close();
});

test('5. normalized attribute relation (equal after normalization)', () => {
  const row = compareAttribute(
    'bearing_type',
    { attributeName: 'bearing_type', value: 'Deep groove ball', normalizedValue: 'deep groove ball', unit: null, isCritical: true },
    { attributeName: 'bearing_type', value: 'DEEP GROOVE BALL', normalizedValue: 'deep groove ball', unit: null, isCritical: true },
    true,
    'Bearings',
  );
  assert.equal(row?.type, 'NORMALIZED_MATCH');
  const mapped = row && (row.type === 'NORMALIZED_MATCH') ? 'NORMALIZED' : row?.type;
  assert.equal(mapped, 'NORMALIZED');
});

test('6. close numeric attribute within the 2% measured tolerance', () => {
  const f = baseFixture();
  const id = f.pairId('M23-CLOSE-A', 'M23-CLOSE-B')!;
  const r = getMatchReview(id);
  const bore = r.technicalComparison.find((c) => c.attribute === 'bore_diameter');
  assert.equal(bore?.relation, 'CLOSE', '25 vs 25.4 mm is within the measured tolerance');
  assert.ok(bore?.basis.includes('tolerance'));
  f.db.close();
});

test('7. missing attribute surfaces as MISSING with importance', () => {
  const f = baseFixture();
  const id = f.pairId('M23-MISS-A', 'M23-MISS-B')!;
  const r = getMatchReview(id);
  const seal = r.technicalComparison.find((c) => c.attribute === 'seal_type');
  assert.ok(seal, 'seal row present even when one side lacks it');
  assert.equal(seal.relation, 'MISSING');
  assert.ok(r.missingEvidence.includes('seal_type'), 'missing critical evidence lists the attribute');
  f.db.close();
});

test('8. critical conflict model: attribute, values, criticality, assessment, source', () => {
  const f = baseFixture();
  const id = f.pairId('CP-1001', 'BH-4410')!;
  const r = getMatchReview(id);
  assert.equal(r.conflicts.length >= 1, true);
  const seal = r.conflicts.find((c) => c.attribute === 'seal_type')!;
  assert.equal(seal.criticality, 'CRITICAL');
  assert.match(seal.leftValue ?? '', /2RS/);
  assert.match(seal.rightValue ?? '', /ZZ/);
  assert.equal(seal.assessment, 'Technical review required.');
  assert.equal(seal.source, 'attribute_comparison');
  assert.equal(r.verdict, 'NEEDS_TECHNICAL_REVIEW');
  f.db.close();
});

test('9. nominal values never approximate: 6205 vs 6310 CONFLICTS (not CLOSE)', () => {
  const f = baseFixture();
  const id = f.pairId('M23-NOM-A', 'M23-NOM-B')!;
  const r = getMatchReview(id);
  const series = r.technicalComparison.find((c) => c.attribute === 'series');
  assert.equal(series?.relation, 'CONFLICT', 'nominal series numbers are equal-or-conflict');
  const row = compareAttribute(
    'series',
    { attributeName: 'series', value: '6205', normalizedValue: '6205', unit: null, isCritical: true },
    { attributeName: 'series', value: '6310', normalizedValue: '6310', unit: null, isCritical: true },
    true,
    'Bearings',
  );
  assert.equal(row?.type, 'CONFLICT', 'compareAttribute directly confirms nominal conflict (1.7% numeric gap is irrelevant)');
  f.db.close();
});

/* ----------------- 10-12: assembly, manufacturer, cross-category ----------------- */

test('10. assembly difference is visible and routed to review', () => {
  const f = baseFixture();
  // Find any persisted candidate carrying assembly evidence (seeded WITH NUT records).
  const rows = f.db.prepare(
    `SELECT id FROM match_candidates WHERE json_extract(evidence, '$.assemblyConfiguration') IS NOT NULL LIMIT 1`,
  ).all() as unknown as Array<{ id: number }>;
  assert.ok(rows.length > 0, 'at least one assembly-difference candidate persisted');
  const r = getMatchReview(rows[0].id);
  assert.ok(r.assemblyEvidence);
  assert.ok(r.assemblyEvidence!.detail.length > 0);
  assert.equal(r.verdict, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(r.why.points.some((p) => p.includes('Assembly/kit difference')));
  f.db.close();
});

test('11. manufacturer difference: cross-brand high scorer routes to review', () => {
  const f = baseFixture();
  const id = f.pairId('M23-XBRD-A', 'M23-XBRD-B')!;
  const r = getMatchReview(id);
  assert.equal(r.manufacturerRelationship, 'different');
  assert.equal(r.verdict, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(r.reason.toLowerCase().includes('manufacturer'), 'rule reason cites the cross-brand rule');
  f.db.close();
});

test('12. cross-category candidates are excluded by retrieval', () => {
  const f = baseFixture();
  const cross = Number(
    (f.db.prepare(
      `SELECT COUNT(*) AS n FROM match_candidates mc
         JOIN material_records s ON s.id = mc.source_material_id
         JOIN material_records c ON c.id = mc.candidate_material_id
        WHERE s.category != c.category`,
    ).get() as unknown as { n: number }).n,
  );
  assert.equal(cross, 0, 'no candidate spans two categories');
  const voltage = f.pairId('M23-VLT-A', 'M23-VLT-B');
  const valveCls = f.pairId('M23-CLS-A', 'M23-CLS-B');
  assert.ok(voltage && valveCls, 'same-category crafted pairs were compared');
  const rv = getMatchReview(voltage!);
  assert.equal(rv.conflicts.some((c) => c.attribute === 'voltage_rating'), true, '415V vs 230V conflicts');
  const rc = getMatchReview(valveCls!);
  assert.equal(rc.conflicts.some((c) => c.attribute === 'pressure_class'), true, 'Class 150 vs 300 conflicts');
  assert.equal(rc.technicalComparison.find((c) => c.attribute === 'pressure_class')?.relation, 'CONFLICT', 'nominal pressure class is never CLOSE');
  f.db.close();
});

/* --------------------------- 13-15: verdicts ------------------------------- */

test('13. review verdict: reviewRequired true only for review/unclassified', () => {
  const f = baseFixture();
  const conflict = getMatchReview(f.pairId('CP-1001', 'BH-4410')!);
  assert.equal(conflict.reviewRequired, true);
  const high = getMatchReview(f.pairId('CP-1001', 'NT-8821')!);
  assert.equal(high.reviewRequired, false);
  f.db.close();
});

test('14. high-confidence verdict: score, no conflicts, same manufacturer', () => {
  const f = baseFixture();
  const id = f.pairId('CP-1001', 'SL-7721')!;
  const r = getMatchReview(id);
  assert.equal(r.verdict, 'HIGH_CONFIDENCE_MATCH');
  assert.ok(r.finalScore >= 80);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.manufacturerRelationship, 'same');
  f.db.close();
});

test('15. not-a-match verdict: classification rule deterministic', () => {
  const d = classifyDecision({
    matchType: 'different', finalScore: 12, technicalScore: 0,
    categoryCompatible: true, criticalConflicts: [], missingCritical: [],
    manufacturerA: 'SKF', manufacturerB: 'SKF',
  });
  assert.equal(d.decision, 'NOT_A_MATCH');
  assert.equal(d.band, 'reject');
  const incompat = classifyDecision({
    matchType: 'different', finalScore: 95, technicalScore: 100,
    categoryCompatible: false, criticalConflicts: [], missingCritical: [],
    manufacturerA: 'SKF', manufacturerB: 'SKF',
  });
  assert.equal(incompat.decision, 'NOT_A_MATCH', 'category-incompatible pairs are never matches');
  f4Close();
  function f4Close(): void {
    /* classification unit — no fixture needed */
  }
});

/* --------------------- 16-19: queue retrieval/filters/sort/pagination --------------------- */

test('16. review queue retrieval: candidates + queue rows + summary metrics', () => {
  const f = baseFixture();
  const { items, total } = listMatches({ status: 'pending', sort: 'score_desc', page: 1, pageSize: 50 });
  assert.ok(total > 10);
  for (const m of items) assert.equal(m.candidate.status, 'pending');
  const s = getReviewSummary();
  assert.equal(typeof s.openReviews, 'number');
  assert.ok(s.highConfidence > 0 && s.technicalConflicts > 0);
  f.db.close();
});

test('17. filters: status, band, conflict presence, category, CPSE', () => {
  const f = baseFixture();
  const pending = listMatches({ status: 'pending', page: 1, pageSize: 200 });
  const reviewBand = listMatches({ status: 'pending', confidenceBand: 'review', page: 1, pageSize: 200 });
  const conflicts = listMatches({ status: 'pending', hasCriticalConflicts: true, page: 1, pageSize: 200 });
  assert.ok(reviewBand.items.length > 0);
  assert.ok(conflicts.items.length > 0, 'conflict filter finds the seal-conflict pairs');
  assert.ok(conflicts.items.length < pending.total, 'conflict filter is a real subset');
  for (const m of conflicts.items) {
    assert.ok((m.candidate.critical_difference ?? '').length > 0, 'filtered rows carry a critical difference');
  }
  const bearings = listMatches({ category: 'Bearings', page: 1, pageSize: 200 });
  for (const m of bearings.items) {
    assert.equal(m.source.category, 'Bearings');
    assert.equal(m.candidateMat.category, 'Bearings');
  }
  const cpcl = listMatches({ organizationCode: 'CPCL', page: 1, pageSize: 200 });
  assert.ok(cpcl.items.length > 0);
  for (const m of cpcl.items) {
    assert.ok(m.source.org_code === 'CPCL' || m.candidateMat.org_code === 'CPCL');
  }
  f.db.close();
});

test('18. sorting: deterministic score/age/priority orders', () => {
  const f = baseFixture();
  const desc = listMatches({ sort: 'score_desc', page: 1, pageSize: 50 }).items.map((m) => m.candidate.final_score);
  const asc = listMatches({ sort: 'score_asc', page: 1, pageSize: 50 }).items.map((m) => m.candidate.final_score);
  for (let i = 1; i < desc.length; i++) assert.ok(desc[i - 1] >= desc[i], 'score_desc ordered');
  for (let i = 1; i < asc.length; i++) assert.ok(asc[i - 1] <= asc[i], 'score_asc ordered');
  const oldest = listMatches({ sort: 'oldest', page: 1, pageSize: 50 }).items.map((m) => m.candidate.created_at);
  for (let i = 1; i < oldest.length; i++) assert.ok(oldest[i - 1] <= oldest[i], 'oldest ordered');
  const prio = listMatches({ sort: 'priority', page: 1, pageSize: 200 }).items;
  const prioRank = (p: string | null) => (p === 'high' ? 0 : p === 'medium' ? 1 : 2);
  const ranks = prio.map((m) => prioRank(m.queue?.priority ?? null));
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i - 1] <= ranks[i], 'priority groups ordered high→low');
  f.db.close();
});

test('19. pagination: stable slices, no overlap, total preserved', () => {
  const f = baseFixture();
  const p1 = listMatches({ sort: 'score_desc', page: 1, pageSize: 10 });
  const p2 = listMatches({ sort: 'score_desc', page: 2, pageSize: 10 });
  assert.equal(p1.items.length, 10);
  const ids1 = new Set(p1.items.map((m) => m.candidate.id));
  for (const m of p2.items) assert.equal(ids1.has(m.candidate.id), false, 'pages do not overlap');
  assert.ok(p2.items.length > 0);
  f.db.close();
});

/* ------------------- 20-24: evidence + decisions --------------------------- */

test('20. evidence contract is read-only and complete (endpoint implementation)', () => {
  const f = baseFixture();
  const id = f.pairId('CP-1001', 'NT-8821')!;
  const before = countAudit();
  const r = getMatchReview(id);
  getReviewSummary();
  listMatches({ status: 'pending', page: 1, pageSize: 5 });
  assert.equal(countAudit(), before, 'evidence/queue reads write ZERO audit rows');
  assert.ok(r.decisionHistory.length === 0, 'no decision yet');
  assert.ok(r.why.points.some((p) => p.includes('Decision rule')));
  f.db.close();
});

test('21. decision endpoint implementation: hardened path preserves existing semantics', () => {
  const f = baseFixture();
  const id = f.pairId('CP-3001', 'NL-6610');
  assert.ok(id, 'a reviewable candidate exists');
  const out = decideMatchHardened(id!, { decision: 'approved', reviewer: REVIEWER, comment: 'specs verified', expectedStatus: 'pending' }, REVIEWER);
  assert.equal(out.status, 'approved');
  assert.equal(out.stale, false);
  f.db.close();
});

test('22. accept: status approved, decision recorded, queue resolved', () => {
  const f = baseFixture();
  const id = f.pairId('CP-2005', 'BH-2210')!;
  const out = decideMatchHardened(id, { decision: 'approved', reviewer: REVIEWER, expectedStatus: 'pending' }, REVIEWER);
  assert.equal(out.status, 'approved');
  const r = getMatchReview(id);
  assert.equal(r.status, 'approved');
  assert.equal(r.decisionHistory[0].reviewer, REVIEWER);
  assert.equal(r.queue?.status, 'resolved');
  f.db.close();
});

test('23. reject + defer: recorded with reasons and statuses', () => {
  const f = baseFixture();
  const rejId = f.pairId('CP-3001', 'NL-6610')!;
  const rej = decideMatchHardened(rejId, { decision: 'rejected', reviewer: REVIEWER, comment: 'Different frame size — not interchangeable', expectedStatus: 'pending' }, REVIEWER);
  assert.equal(rej.status, 'rejected');
  const defId = f.pairId('NT-8821', 'NL-3310')!;
  const def = decideMatchHardened(defId, { decision: 'deferred', reviewer: REVIEWER, comment: 'Awaiting datasheet', expectedStatus: 'pending' }, REVIEWER);
  assert.equal(def.status, 'deferred');
  const rr = getMatchReview(rejId);
  assert.equal(rr.decisionHistory[0].comment, 'Different frame size — not interchangeable');
  f.db.close();
});

test('24. reason validation: schema enforces reviewer identity and comment bounds', () => {
  assert.throws(() => decisionSchema.parse({ decision: 'approved', reviewer: 'x' }), /Reviewer name required|too_small/);
  assert.throws(() => decisionSchema.parse({ decision: 'approved', reviewer: 'ok@demo', comment: 'x'.repeat(1001) }), /too_big|1000/);
  assert.throws(() => decisionSchema.parse({ decision: 'nuke', reviewer: 'ok@demo' }), /invalid/i);
  const okParsed = decisionSchema.parse({ decision: 'approved', reviewer: 'reviewer@demo' });
  assert.equal(okParsed.comment, undefined);
});

/* --------------------- 25-28: authorization + audit ------------------------ */

test('25. authorization matrix: review vs view permissions reused, none added', () => {
  assert.equal(roleHasPermission('cpse_technical_reviewer', 'REVIEW_MATCHES'), true);
  assert.equal(roleHasPermission('cpse_material_manager', 'REVIEW_MATCHES'), false);
  assert.equal(roleHasPermission('authority', 'REVIEW_MATCHES'), false);
  assert.equal(roleHasPermission('cpse_material_manager', 'VIEW_MATCHES'), true);
  const perms = require('../src/lib/auth/permissions') as typeof import('../src/lib/auth/permissions');
  assert.equal(perms.PERMISSIONS.includes('MANAGE_REVIEWS' as never), false, 'no duplicate permission invented');
  assert.equal(roleHasPermission('cpse_technical_reviewer', 'APPROVE_MATCH'), true);
  assert.equal(roleHasPermission('cpse_material_manager', 'APPROVE_MATCH'), false);
});

test('26. audit: decision mutations recorded with actor + previous/new status context', () => {
  const f = baseFixture();
  const id = f.pairId('CP-1001', 'SL-7721')!;
  decideMatchHardened(id, { decision: 'approved', reviewer: REVIEWER, comment: 'same 6205-2RS', expectedStatus: 'pending' }, REVIEWER);
  const events = listAudit({ entityType: 'match_candidate', entityId: id, page: 1, pageSize: 10 }).items;
  const approve = events.find((e) => e.action === 'proposal_approved');
  assert.ok(approve, 'existing proposal_approved action reused');
  assert.equal(approve?.actor, REVIEWER);
  const details = approve?.details as Record<string, unknown> | null;
  assert.equal(details?.decision, 'approved');
  assert.equal(details?.comment, 'same 6205-2RS');
  f.db.close();
});

test('27. read audit-silence across the whole review workspace surface', () => {
  const f = baseFixture();
  const before = countAudit();
  getMatchReview(f.pairId('CP-1001', 'NT-8821')!);
  getReviewSummary();
  listMatches({ sort: 'priority', page: 1, pageSize: 25 });
  listAudit({ entityType: 'match_candidate', page: 1, pageSize: 5 });
  assert.equal(countAudit(), before);
  f.db.close();
});

test('28. decision history is immutable: decided rows never re-scored on rerun', () => {
  const f = baseFixture();
  const id = f.pairId('CP-1001', 'NT-8821')!;
  decideMatchHardened(id, { decision: 'approved', reviewer: REVIEWER, expectedStatus: 'pending' }, REVIEWER);
  const before = f.db.prepare(`SELECT final_score, status, updated_at FROM match_candidates WHERE id = ?`).get(id) as unknown as { final_score: number; status: string; updated_at: string };
  runMatching('step23-rerun'); // full rerun: pending candidates are regenerated
  const after = f.db.prepare(`SELECT final_score, status, updated_at FROM match_candidates WHERE id = ?`).get(id) as unknown as { final_score: number; status: string; updated_at: string };
  assert.equal(after.status, 'approved', 'decided row untouched by rerun');
  assert.equal(after.final_score, before.final_score);
  assert.equal(after.updated_at, before.updated_at);
  f.db.close();
});

/* ------------------- 29-31: stale/duplicate safety + CMI ------------------- */

test('29. stale decision safety: expectedStatus mismatch fails closed with nothing written', () => {
  const f = baseFixture();
  const id = f.pairId('CP-2005', 'SL-3312')!;
  decideMatchHardened(id, { decision: 'approved', reviewer: REVIEWER, expectedStatus: 'pending' }, REVIEWER);
  const auditBefore = countAudit();
  assert.throws(
    () => decideMatchHardened(id, { decision: 'rejected', reviewer: REVIEWER, expectedStatus: 'pending' }, REVIEWER),
    /Stale review/,
  );
  assert.equal(countAudit(), auditBefore, 'stale mutation wrote nothing');
  const r = getMatchReview(id);
  assert.equal(r.status, 'approved', 'original decision intact');
  f.db.close();
});

test('30. duplicate decision safety: already-decided candidate conflicts (existing guard)', () => {
  const f = baseFixture();
  const id = f.pairId('CP-2005', 'NL-4420')!;
  decideMatchHardened(id, { decision: 'approved', reviewer: REVIEWER, expectedStatus: 'pending' }, REVIEWER);
  assert.throws(
    () => decideMatchHardened(id, { decision: 'approved', reviewer: REVIEWER }, REVIEWER),
    /already approved/,
  );
  assert.throws(
    () => decideMatchHardened(id, { decision: 'rejected', reviewer: REVIEWER, expectedStatus: 'approved' as never }, REVIEWER),
    /Stale review|already/,
  );
  const decisions = f.db.prepare(`SELECT COUNT(*) AS n FROM match_decisions WHERE match_id = ?`).get(id) as unknown as { n: number };
  assert.equal(decisions.n, 1, 'exactly one decision row — no double submission');
  f.db.close();
});

test('31. CMI handoff: approved → cmi_pending; governed creation → cmi_created', () => {
  const f = baseFixture();
  const id = f.pairId('CP-1001', 'NT-8821')!;
  decideMatchHardened(id, { decision: 'approved', reviewer: REVIEWER, expectedStatus: 'pending' }, REVIEWER);
  let r = getMatchReview(id);
  assert.equal(r.cmiState, 'cmi_pending', 'approved but awaiting governed CMI creation');
  createCmiFromMatch({ code: 'CMI-23-BRG', name: '6205-2RS deep groove (step23)', category: 'Bearings', matchId: id }, REVIEWER);
  r = getMatchReview(id);
  assert.equal(r.cmiState, 'cmi_created');
  // NOT automatically created for other approved pairs:
  const otherId = f.pairId('NT-8821', 'SL-7721')!;
  decideMatchHardened(otherId, { decision: 'approved', reviewer: REVIEWER, expectedStatus: 'pending' }, REVIEWER);
  assert.equal(getMatchReview(otherId).cmiState, 'cmi_pending', 'approval alone never creates a CMI');
  f.db.close();
});

/* ----------------------- 32: known demo scenarios -------------------------- */

test('32. known demo scenarios (§24) behave per existing scoring semantics', () => {
  const f = baseFixture();
  const s1 = getMatchReview(f.pairId('CP-1001', 'NT-8821')!);
  assert.equal(s1.verdict, 'HIGH_CONFIDENCE_MATCH', 'scenario 1');
  const s2 = getMatchReview(f.pairId('CP-1001', 'SL-7721')!);
  assert.equal(s2.verdict, 'HIGH_CONFIDENCE_MATCH', 'scenario 2');
  const s3 = getMatchReview(f.pairId('CP-1001', 'BH-4410')!);
  assert.equal(s3.verdict, 'NEEDS_TECHNICAL_REVIEW', 'scenario 3');
  assert.ok(s3.conflicts.some((c) => c.attribute === 'seal_type'));
  // Scenario 4/5 covered in test 12 (Class 150 vs 300; 415V vs 230V).
  // Scenario 6: 6205 vs 6310 — not equivalent, conflicts (test 9 asserts the
  // relation; here the pair-level verdict).
  const s6 = getMatchReview(f.pairId('M23-NOM-A', 'M23-NOM-B')!);
  assert.equal(s6.verdict, 'NEEDS_TECHNICAL_REVIEW', 'scenario 6: different series routes to review per scoring semantics');
  // Scenario 7: cross-category exclusion (test 12).
  // Scenario 8: FAG vs SKF cross-brand review (test 11).
  // Scenario 9: assembly difference (test 10).
  f.db.close();
});

/* --------------------- 33-38: Steps 17-22 regressions ---------------------- */

const STEWARD = 'steward23@demo';
const APPROVER = 'approver23@demo';

test('33. Step 17 regression: UOM registry + comparable quantity math unchanged', () => {
  const f = baseFixture();
  const now = new Date().toISOString();
  const cmi = f.db.prepare(`INSERT INTO common_materials (code, name, category, is_active, created_at, updated_at) VALUES ('CMI-23', 'brg', 'Bearings', 1, ?, ?)`).run(now, now);
  const cmiId = Number(cmi.lastInsertRowid);
  f.db.prepare(`INSERT INTO material_mappings (cmi_id, material_id, organization_id) VALUES (?, ?, ?)`).run(cmiId, f.materialIds.get('CP-1001') as number, f.orgIds.get('CPCL') as number);
  f.db.prepare(`INSERT INTO material_mappings (cmi_id, material_id, organization_id) VALUES (?, ?, ?)`).run(cmiId, f.materialIds.get('NT-8821') as number, f.orgIds.get('NTPC') as number);
  const supA = createSupplierRecord({ supplierCode: 'S23A', supplierName: 'Alpha 23', region: 'IN' }, STEWARD).id;
  createProcurementRecord({ organizationId: f.orgIds.get('CPCL')!, materialId: f.materialIds.get('CP-1001')!, cmiId, supplierId: supA, purchaseOrderReference: 'PO-23A', purchaseDate: '2026-02-01', quantity: '120', uom: 'PCS', status: 'DELIVERED' }, STEWARD);
  createProcurementRecord({ organizationId: f.orgIds.get('NTPC')!, materialId: f.materialIds.get('NT-8821')!, cmiId, supplierId: supA, purchaseOrderReference: 'PO-23B', purchaseDate: '2026-02-02', quantity: '270', uom: 'EA', status: 'DELIVERED' }, STEWARD);
  assert.deepEqual(getCmiComparableDemand(cmiId)?.comparableQuantityByUom, { EA: '390' });
  assert.deepEqual(getUomRuleRegistry().filter((r) => r.isActive).map((r) => `${r.fromUom}>${r.toUom}x${r.factor}`).sort(),
    ['CM>MMx10', 'KG>Gx1000', 'L>MLx1000', 'M>MMx1000', 'NOS>EAx1', 'PCS>EAx1', 'TON>Gx1000000']);
  f.db.close();
});

test('34. Step 18 regression: governed UOM rules + precedence + SoD unchanged', () => {
  const f = baseFixture();
  const now = new Date().toISOString();
  const cmi = f.db.prepare(`INSERT INTO common_materials (code, name, category, is_active, created_at, updated_at) VALUES ('CMI-23B', 'brg', 'Bearings', 1, ?, ?)`).run(now, now);
  const cmiId = Number(cmi.lastInsertRowid);
  const id = createUomDomainRule({ cmiId, fromUom: 'SET', toUom: 'EA', factor: 10, reason: 'pack sheet (23 fixture).', actor: STEWARD }).id;
  transitionUomRuleLifecycle(id, 'approve', APPROVER);
  assert.equal(getEffectiveUomRule('SET', cmiId)?.ruleType, 'DOMAIN_SPECIFIC');
  assert.equal(getEffectiveUomRule('SET', null), null);
  // Separation of duties lives in the amendment flow (existing Step-18/20 semantics).
  proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'SoD probe (23).', actor: STEWARD });
  assert.throws(() => decideUomRuleAmendment(id, 'approve', STEWARD), /Separation of duties/);
  f.db.close();
});

test('35. Step 19 regression: UOM rule history append-only + CREATE→APPROVE stamped', () => {
  const f = baseFixture();
  const now = new Date().toISOString();
  const cmi = f.db.prepare(`INSERT INTO common_materials (code, name, category, is_active, created_at, updated_at) VALUES ('CMI-23C', 'brg', 'Bearings', 1, ?, ?)`).run(now, now);
  const cmiId = Number(cmi.lastInsertRowid);
  const id = createUomDomainRule({ cmiId, fromUom: 'SET', toUom: 'EA', factor: 10, reason: 'pack sheet.', actor: STEWARD }).id;
  transitionUomRuleLifecycle(id, 'approve', APPROVER);
  assert.deepEqual(getUomRuleHistory(id).map((x) => x.action), ['CREATE', 'APPROVE']);
  assert.throws(() => f.db.prepare('UPDATE uom_rule_history SET actor = ?').run('evil'), /append-only/);
  f.db.close();
});

test('36. Step 20 regression: rule versions immutable + amendment lifecycle intact', () => {
  const f = baseFixture();
  const now = new Date().toISOString();
  const cmi = f.db.prepare(`INSERT INTO common_materials (code, name, category, is_active, created_at, updated_at) VALUES ('CMI-23D', 'brg', 'Bearings', 1, ?, ?)`).run(now, now);
  const cmiId = Number(cmi.lastInsertRowid);
  const id = createUomDomainRule({ cmiId, fromUom: 'SET', toUom: 'EA', factor: 10, reason: 'pack sheet.', actor: STEWARD }).id;
  transitionUomRuleLifecycle(id, 'approve', APPROVER);
  proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'corrected sheet.', actor: STEWARD });
  decideUomRuleAmendment(id, 'approve', APPROVER);
  const versions = getUomRuleVersions(id);
  assert.deepEqual(versions.map((v) => v.versionNumber), [1, 2]);
  assert.throws(() => f.db.prepare('UPDATE uom_domain_rule_versions SET factor = 99').run(), /immutable/);
  assert.equal(normalizeQuantity('12', 'SET', cmiId).rule?.factor, 12);
  f.db.close();
});

test('37. Step 21 regression: governance cockpit aggregation unchanged', () => {
  const f = baseFixture();
  const c = getGovernanceCockpit();
  assert.ok(c.summary.openReviews >= 0);
  assert.ok(c.health.every((h) => ['PASS', 'WARNING', 'ACTION REQUIRED'].includes(h.state)));
  assert.ok(Array.isArray(c.workQueue));
  f.db.close();
});

test('38. Step 22 regression: integration adapters + registry unchanged', () => {
  assert.deepEqual(listAdapters().map((a) => a.id), ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']);
  const a = analyzeIntegration({
    adapterId: 'CPCL', fileName: 'CPCL-materials.csv',
    payload: fs.readFileSync(path.join(process.cwd(), 'data', 'cpse-feeds', 'CPCL-materials.csv'), 'utf8'),
  });
  assert.equal(a.rowsValid, 5);
  assert.equal(a.canExecute, true);
});

/* ------------------------ 39: evaluation parity guards --------------------- */

test('39. evaluation parity: frozen thresholds/weights + ground-truth pair semantics', () => {
  assert.deepEqual(DECISION_THRESHOLDS, { highConfidence: 80, reviewFloor: 60, notAMatch: 30 }, 'thresholds untouched');
  assert.deepEqual(RAW_WEIGHTS, { semantic: 0.3, fuzzy: 0.2, technical: 0.3, category: 0.2 }, 'weights untouched');
  // Ground-truth anchors from data/evaluation/ground-truth-pairs.json:
  const f = baseFixture();
  const gt1 = getMatchReview(f.pairId('CP-1001', 'NT-8821')!);
  assert.equal(gt1.verdict, 'HIGH_CONFIDENCE_MATCH', 'ground-truth MATCH pair classifies as high confidence');
  const gt2 = getMatchReview(f.pairId('CP-1001', 'BH-4410')!);
  assert.equal(gt2.verdict, 'NEEDS_TECHNICAL_REVIEW', 'ground-truth NEEDS_REVIEW pair stays in review');
  assert.ok((gt2.technicalComparison.find((c) => c.attribute === 'seal_type')?.basis.length ?? 0) > 0);
  f.db.close();
});

console.log(`\nStep 23 (matching & review hardening): ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(failures.map((x) => `  - ${x}`).join('\n'));
  process.exit(1);
}
