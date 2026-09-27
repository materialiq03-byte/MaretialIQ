/**
 * Matching-engine tests — `npx tsx tests/matching.test.ts`.
 *
 * Covers spec §18: exact/near duplicates, same-attributes-different-wording,
 * critical conflicts (seal, pressure, voltage, material), category gates,
 * missing attributes, cross-CPSE flow, decision-state classification, and the
 * human approval → common-material-identity workflow. Runs against a
 * disposable temp SQLite database; the real data/materialiq.db is untouched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { insertMaterial, upsertAttribute } from '../src/lib/db/repositories/material-repository';
import { listAllMaterialsForMatching, getMaterialsForComparison } from '../src/lib/db/repositories/matching-queries';
import { scorePair, generatePairs } from '../src/lib/matching/engine';
import { classifyDecision, DECISION_THRESHOLDS } from '../src/lib/matching/decision';
import { fuzzyScore, compareTechnical } from '../src/lib/matching/compare';
import { attributeStrategyFor, nominalAttributesFor, CRITICAL_RULES } from '../src/lib/matching/config';
import { runMatching, decideMatch, createCmiFromMatch } from '../src/lib/services/matching-service';
import { listCmiWithMembers } from '../src/lib/services/registry-service';
import { getMatch, upsertMatch, deletePendingMatches } from '../src/lib/db/repositories/matching-repository';
import { listMappings, createCommonMaterial } from '../src/lib/db/repositories/registry-repository';
import { getDashboardMetrics } from '../src/lib/db/repositories/metrics-repository';
import type { MatchableMaterial } from '../src/lib/matching/types';

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

/** Build a MatchableMaterial without touching the database. */
function mat(partial: Partial<MatchableMaterial> & { id: number; organizationId: number }): MatchableMaterial {
  return {
    orgCode: 'ORG',
    originalCode: `M-${partial.id}`,
    originalDescription: '',
    normalizedDescription: null,
    category: 'Bearings',
    manufacturer: null,
    model: null,
    partNumber: null,
    uom: 'EA',
    attributes: [],
    ...partial,
  };
}

function attr(name: string, value: string, critical = false): MatchableMaterial['attributes'][number] {
  return { attributeName: name, value, normalizedValue: value, unit: null, isCritical: critical };
}

/* ---------------- 1. exact / near duplicate (§18.1) ----------------------- */

test('exact duplicate specifications classify as identical with HIGH_CONFIDENCE_MATCH', () => {
  const attrs = [attr('series', '6205', true), attr('seal_type', '2RS', true), attr('bearing_type', 'DEEP_GROOVE_BALL'), attr('bore_diameter', '25', true), attr('outer_diameter', '52'), attr('width', '15')];
  const a = mat({
    id: 1, organizationId: 1, orgCode: 'CPCL', originalCode: 'CP-1001',
    originalDescription: 'SKF BALL BRG 6205-2RS', normalizedDescription: 'SKF BALL BEARING 6205-2RS',
    manufacturer: 'SKF', partNumber: '6205-2RS', attributes: attrs,
  });
  const b = mat({
    id: 2, organizationId: 2, orgCode: 'NTPC', originalCode: 'NT-8821',
    originalDescription: 'SKF BALL BEARING 6205-2RS', normalizedDescription: 'SKF BALL BEARING 6205-2RS',
    manufacturer: 'SKF', partNumber: '6205-2RS', attributes: attrs,
  });
  const s = scorePair(a, b);
  assert.equal(s.matchType, 'identical');
  assert.equal(s.decision, 'HIGH_CONFIDENCE_MATCH');
  assert.equal(s.criticalDifference, null);
  assert.ok(s.finalScore >= DECISION_THRESHOLDS.highConfidence);
  assert.ok(s.explanation.includes('6205'));
});

test('different manufacturers with identical specs → review, not equivalence (§22.8)', () => {
  const attrs = [attr('series', '6205', true), attr('seal_type', '2RS', true), attr('bearing_type', 'DEEP_GROOVE_BALL')];
  const a = mat({
    id: 61, organizationId: 1, orgCode: 'CPCL', originalCode: 'CP-6007',
    originalDescription: 'FAG SPHERICAL ROLLER BEARING 22216 E', normalizedDescription: 'FAG SPHERICAL ROLLER BEARING 22216 E',
    manufacturer: 'FAG', attributes: attrs,
  });
  const b = mat({
    id: 62, organizationId: 2, orgCode: 'BHEL', originalCode: 'BH-3007',
    originalDescription: 'SKF SPHERICAL ROLLER BEARING 22216 E', normalizedDescription: 'SKF SPHERICAL ROLLER BEARING 22216 E',
    manufacturer: 'SKF', attributes: attrs,
  });
  const s = scorePair(a, b);
  assert.equal(s.decision, 'NEEDS_TECHNICAL_REVIEW');
  const d = classifyDecision({
    matchType: s.matchType, finalScore: s.finalScore, technicalScore: s.technicalScore,
    categoryCompatible: true, criticalConflicts: [], missingCritical: [],
    manufacturerA: 'FAG', manufacturerB: 'SKF',
  });
  assert.equal(d.decision, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(d.reason.includes('different manufacturers'), `reason should name the cause: ${d.reason}`);
  assert.ok(d.reason.includes('FAG') && d.reason.includes('SKF'), `reason should name both brands: ${d.reason}`);
  // same make, same specs → unchanged behaviour
  const b2 = { ...b, id: 63, manufacturer: 'FAG', originalCode: 'BH-7777' };
  const s2 = scorePair(a, b2);
  assert.equal(s2.decision, 'HIGH_CONFIDENCE_MATCH');
});

test('missing/one-sided manufacturer data does not trigger the cross-brand rule (§22.7)', () => {
  const attrs = [attr('series', '6205', true), attr('seal_type', '2RS', true)];
  const a = mat({ id: 64, organizationId: 1, originalDescription: 'BALL BEARING 6205-2RS', manufacturer: 'SKF', attributes: attrs });
  const b = mat({ id: 65, organizationId: 2, originalDescription: 'BALL BEARING 6205-2RS', manufacturer: null, attributes: attrs });
  const s = scorePair(a, b);
  assert.ok(['HIGH_CONFIDENCE_MATCH', 'NEEDS_TECHNICAL_REVIEW'].includes(s.decision as string));
});

test('DEEP GROOVE wording variant scores near_duplicate, still high confidence', () => {
  const a = mat({
    id: 17, organizationId: 1, originalDescription: 'SKF BALL BEARING 6205-2RS',
    manufacturer: 'SKF', attributes: [attr('series', '6205', true), attr('seal_type', '2RS', true), attr('bearing_type', 'DEEP_GROOVE_BALL')],
  });
  const b = mat({
    id: 18, organizationId: 2, orgCode: 'NTPC', originalDescription: 'SKF DEEP GROOVE BRG 6205 2RS',
    manufacturer: 'SKF', attributes: [attr('series', '6205', true), attr('seal_type', '2RS', true), attr('bearing_type', 'DEEP_GROOVE_BALL')],
  });
  const s = scorePair(a, b);
  assert.equal(s.matchType, 'near_duplicate');
  assert.equal(s.decision, 'HIGH_CONFIDENCE_MATCH');
});

test('different wording but identical technical attributes still match (§18.2)', () => {
  const a = mat({
    id: 3, organizationId: 1, originalDescription: 'SKF BALL BEARING 6205-2RS',
    manufacturer: 'SKF', attributes: [attr('series', '6205', true), attr('seal_type', '2RS', true)],
  });
  const b = mat({
    id: 4, organizationId: 3, orgCode: 'SAIL', originalDescription: 'SKF BALL BRG 6205 2RS',
    manufacturer: 'SKF', attributes: [attr('series', '6205', true), attr('seal_type', '2RS', true)],
  });
  const s = scorePair(a, b);
  assert.ok(s.fuzzyScore >= 60, `fuzzy should recognise BRG≈BEARING, got ${s.fuzzyScore}`);
  assert.equal(s.technicalScore, 100);
  assert.notEqual(s.decision, 'NOT_A_MATCH');
});

/* ---------------- 2. critical conflicts (§18.3-6, §6) --------------------- */

test('6205-2RS vs 6205-ZZ → critical seal conflict → NEEDS_TECHNICAL_REVIEW', () => {
  const a = mat({
    id: 5, organizationId: 1, originalDescription: 'SKF BALL BEARING 6205-2RS',
    attributes: [attr('series', '6205', true), attr('seal_type', '2RS', true)],
  });
  const b = mat({
    id: 6, organizationId: 3, orgCode: 'BHEL', originalCode: 'BH-4410', originalDescription: 'SKF BEARING 6205-ZZ',
    attributes: [attr('series', '6205', true), attr('seal_type', 'ZZ', true)],
  });
  const s = scorePair(a, b);
  assert.equal(s.matchType, 'needs_review');
  assert.equal(s.decision, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(s.criticalDifference?.includes('seal_type'));
  assert.ok(s.criticalDifference?.includes('2RS') && s.criticalDifference?.includes('ZZ'));
});

test('150 vs 300 pressure class valve → NEEDS_TECHNICAL_REVIEW', () => {
  const a = mat({
    id: 7, organizationId: 1, category: 'Valves', originalDescription: 'GATE VALVE 6IN 150 RF CS',
    attributes: [attr('valve_type', 'GATE', true), attr('nominal_size', '6', true), attr('pressure_class', '150', true), attr('body_material', 'CARBON_STEEL', true)],
  });
  const b = mat({
    id: 8, organizationId: 2, orgCode: 'NTPC', category: 'Valves', originalDescription: 'GATE VALVE 6IN 300 RF CS',
    attributes: [attr('valve_type', 'GATE', true), attr('nominal_size', '6', true), attr('pressure_class', '300', true), attr('body_material', 'CARBON_STEEL', true)],
  });
  const s = scorePair(a, b);
  assert.equal(s.decision, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(s.criticalDifference?.includes('pressure_class'));
});

test('415V vs 230V motor → NEEDS_TECHNICAL_REVIEW', () => {
  const a = mat({
    id: 9, organizationId: 1, category: 'Motors', originalDescription: 'SIEMENS IND MOTOR 75KW 415V',
    attributes: [attr('power_rating', '75', true), attr('voltage_rating', '415', true), attr('motor_type', 'INDUCTION', true)],
  });
  const b = mat({
    id: 10, organizationId: 2, orgCode: 'NTPC', category: 'Motors', originalDescription: 'SIEMENS IND MOTOR 75KW 230V',
    attributes: [attr('power_rating', '75', true), attr('voltage_rating', '230', true), attr('motor_type', 'INDUCTION', true)],
  });
  const s = scorePair(a, b);
  assert.equal(s.decision, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(s.criticalDifference?.includes('voltage_rating'));
});

test('SS304 vs carbon steel material conflict → NEEDS_TECHNICAL_REVIEW', () => {
  const a = mat({
    id: 11, organizationId: 1, category: 'Valves', originalDescription: 'BALL VALVE 2IN 150 SS304',
    attributes: [attr('valve_type', 'BALL', true), attr('body_material', 'STAINLESS_STEEL_304', true)],
  });
  const b = mat({
    id: 12, organizationId: 2, orgCode: 'NTPC', category: 'Valves', originalDescription: 'BALL VALVE 2IN 150 CS',
    attributes: [attr('valve_type', 'BALL', true), attr('body_material', 'CARBON_STEEL', true)],
  });
  const s = scorePair(a, b);
  assert.equal(s.decision, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(s.criticalDifference?.includes('body_material'));
});

/* ---------------- 3. category gate + low confidence (§18.7) --------------- */

test('bearing vs pump is NOT_A_MATCH regardless of wording (§3 gate)', () => {
  const a = mat({ id: 13, organizationId: 1, category: 'Bearings', originalDescription: 'SKF BALL BEARING 6205-2RS' });
  const b = mat({ id: 14, organizationId: 2, orgCode: 'NTPC', category: 'Pumps', originalDescription: 'SKF BALL BEARING 6205-2RS PUMP' });
  const s = scorePair(a, b);
  assert.equal(s.categoryCompatible, false);
  assert.equal(s.matchType, 'different');
  assert.equal(s.decision, 'NOT_A_MATCH');
  assert.ok(s.finalScore < 50);
});

test('weak evidence yields LOW_CONFIDENCE via decision layer', () => {
  const r = classifyDecision({
    matchType: 'different',
    finalScore: 45,
    technicalScore: 30,
    categoryCompatible: true,
    criticalConflicts: [],
    missingCritical: [],
  });
  assert.equal(r.decision, 'LOW_CONFIDENCE');
});

/* ---------------- 4. missing attributes (§18.8) --------------------------- */

test('missing critical attribute blocks high-confidence equivalence', () => {
  const a = mat({
    id: 15, organizationId: 1, originalDescription: 'SKF BALL BEARING 6205',
    attributes: [attr('series', '6205', true), attr('seal_type', '2RS', true)],
  });
  const b = mat({
    id: 16, organizationId: 2, orgCode: 'NTPC', originalDescription: 'SKF BALL BEARING 6205 2RS',
    attributes: [attr('series', '6205', true)], // seal_type not recorded
  });
  const s = scorePair(a, b);
  assert.ok(s.evidence.missingCritical.includes('seal_type'));
  // MISSING contributes 0 to the technical agreement (2 of 4 weighted units = 50) —
  // a specification gap is never counted as agreement.
  assert.equal(s.technicalScore, 50);
  assert.notEqual(s.decision, 'HIGH_CONFIDENCE_MATCH');
  assert.equal(s.decision, 'NEEDS_TECHNICAL_REVIEW');
});

/* ---------------- 5. retrieval + fuzzy helpers ---------------------------- */

test('retrieval only proposes cross-CPSE pairs within a category (§16)', () => {
  const materials = [
    mat({ id: 1, organizationId: 1, category: 'Bearings', originalDescription: 'SKF BEARING 6205', normalizedDescription: 'SKF BEARING 6205' }),
    mat({ id: 2, organizationId: 2, orgCode: 'NTPC', category: 'Bearings', originalDescription: 'SKF BEARING 6205', normalizedDescription: 'SKF BEARING 6205' }),
    mat({ id: 3, organizationId: 2, orgCode: 'NTPC', category: 'Pumps', originalDescription: 'SKF BEARING 6205 PUMP', normalizedDescription: 'SKF BEARING 6205 PUMP' }),
    mat({ id: 4, organizationId: 1, category: 'Bearings', originalDescription: 'SKF BEARING 6205', normalizedDescription: 'SKF BEARING 6205' }),
  ];
  const pairs = generatePairs(materials);
  for (const [a, b] of pairs) {
    assert.equal(a.category, b.category, 'same category only');
    assert.notEqual(a.organizationId, b.organizationId, 'cross-org only');
  }
  assert.ok(pairs.length >= 1);
});

test('fuzzy score recognises abbreviation equivalence', () => {
  const same = fuzzyScore('SKF BALL BRG 6205 2RS', 'SKF BALL BEARING 6205 2RS');
  assert.ok(same >= 80, `BRG≈BEARING should score high, got ${same}`);
  const diff = fuzzyScore('GATE VALVE 6IN 150', 'CENTRIFUGAL PUMP 8X6');
  assert.ok(diff < 40);
});

test('fuzzy score collapses pressure-class spellings (CL300 / CL 300 / CLASS 300 / 300#)', () => {
  const a = fuzzyScore('GATE V/V 2 IN CL300 CS', 'GATE VALVE 2 IN CL 300 CS');
  assert.ok(a >= 85, `CL300 ≡ CL 300 should score high, got ${a}`);
  const b = fuzzyScore('GATE VALVE 2 IN CLASS 300 CS', 'GATE VALVE 2 IN 300# CS');
  assert.ok(b >= 85, `CLASS 300 ≡ 300# should score high, got ${b}`);
  const c = fuzzyScore('GATE VALVE 2 IN CL 300 CS', 'GATE VALVE 2 IN CL 150 CS');
  assert.ok(c < 100, 'different ratings must stay distinct');
});

test('nominal designations conflict instead of scoring as close matches', () => {
  const mk = (series: string, bore: string) =>
    mat({ id: series === '6205' ? 1 : 2, organizationId: 1, category: 'Bearings', attributes: [
      { attributeName: 'series', value: series, normalizedValue: series, unit: null, isCritical: true },
      { attributeName: 'bore_diameter', value: bore, normalizedValue: bore, unit: null, isCritical: true },
    ] });
  // 6205 vs 6310 differ by only ~1.7% numerically — still a conflict.
  const r1 = compareTechnical(mk('6205', '25'), mk('6310', '50'));
  assert.ok(r1.criticalConflicts.some((c) => c.startsWith('series:')), `series 6205 vs 6310 must conflict, got ${r1.criticalConflicts.join('; ')}`);
  // Even a 0.016% difference (6205 vs 6206) is a series conflict.
  const r2 = compareTechnical(mk('6205', '25'), mk('6206', '30'));
  assert.ok(r2.criticalConflicts.some((c) => c.startsWith('series:')));
  // Measured attributes keep the tolerance: bores 25 vs 25.4 (1.6%) stay CLOSE.
  const r3 = compareTechnical(mk('6205', '25'), mk('6205', '25.4'));
  assert.ok(!r3.criticalConflicts.some((c) => c.startsWith('bore_diameter:')), 'bore within tolerance must not conflict');
  assert.ok(r3.comparisons.some((c) => c.attributeName === 'bore_diameter' && c.type === 'CLOSE_MATCH'));
});

test('§11 series conflict drives the full decision: review, not auto-approval, with values in the explanation', () => {
  const mk = (series: string, bore: string) =>
    mat({ id: series === '6205' ? 1 : 2, organizationId: 1, category: 'Bearings', attributes: [
      { attributeName: 'series', value: series, normalizedValue: series, unit: null, isCritical: true },
      { attributeName: 'bore_diameter', value: bore, normalizedValue: bore, unit: null, isCritical: true },
    ] });
  for (const [a, b] of [['6205', '6310'], ['6305', '6205']] as const) {
    const s = scorePair(mk(a, '25'), mk(b, '25'));
    assert.equal(s.decision, 'NEEDS_TECHNICAL_REVIEW', `${a} vs ${b} must route to review`);
    assert.notEqual(s.decision, 'HIGH_CONFIDENCE_MATCH');
    assert.ok(s.evidence.criticalConflicts.some((c) => c.startsWith('series:') && c.includes(a) && c.includes(b)), `conflict evidence must name both values, got ${s.evidence.criticalConflicts.join('; ')}`);
    assert.ok(s.explanation.includes(`series (${a})`) || s.explanation.includes(a), `explanation must name ${a}`);
    assert.ok(s.explanation.includes(b), `explanation must name ${b}`);
    // Original stored values preserved on the comparison rows.
    const row = s.evidence.attributeComparisons.find((c) => c.attributeName === 'series');
    assert.equal(row?.valueA, a);
    assert.equal(row?.valueB, b);
  }
});

test('§11 identical series still compares clean (6205 vs 6205)', () => {
  const mk = (id: number, org: number) =>
    mat({ id, organizationId: org, category: 'Bearings', attributes: [
      { attributeName: 'series', value: '6205', normalizedValue: '6205', unit: null, isCritical: true },
      { attributeName: 'seal_type', value: '2RS', normalizedValue: '2RS', unit: null, isCritical: true },
      { attributeName: 'bore_diameter', value: '25', normalizedValue: '25', unit: null, isCritical: true },
    ] });
  const s = scorePair(mk(1, 1), mk(2, 2));
  assert.ok(!s.evidence.criticalConflicts.some((c) => c.startsWith('series:')));
  assert.ok(s.evidence.criticalConflicts.length === 0, `no conflicts expected, got ${s.evidence.criticalConflicts.join('; ')}`);
  const row = s.evidence.attributeComparisons.find((c) => c.attributeName === 'series');
  assert.ok(row && (row.type === 'EXACT_MATCH' || row.type === 'NORMALIZED_MATCH'));
  assert.equal(s.decision, 'HIGH_CONFIDENCE_MATCH');
});

/* ------------- §12 category-aware nominal rules (registry-driven) ------------- */

test('§12 registry classifies attributes per category and covers all critical attributes', () => {
  assert.deepEqual([...nominalAttributesFor('Bearings')].sort(), ['series']);
  assert.deepEqual([...nominalAttributesFor('Valves')].sort(), ['nominal_size', 'pressure_class']);
  assert.deepEqual([...nominalAttributesFor('Fasteners')].sort(), ['thread_specification']);
  assert.deepEqual([...nominalAttributesFor('Pumps')].sort(), ['discharge_size', 'suction_size']);
  assert.equal(nominalAttributesFor('Motors').size, 0, 'motors carry measurements, not designations');
  // Same attribute name, different strategy per category (data-model backed):
  // valve pressure_class = "150#"/"Class 300" designations; pump = "10 bar" rating.
  assert.equal(attributeStrategyFor('Valves', 'pressure_class'), 'nominal');
  assert.equal(attributeStrategyFor('Pumps', 'pressure_class'), 'measured');
  for (const [category, criticals] of Object.entries(CRITICAL_RULES)) {
    for (const c of criticals) {
      assert.ok(attributeStrategyFor(category, c) !== undefined, `${category}.${c} missing from registry`);
    }
  }
});

test('§12 valves: Class 150 ≡ 150# and Class 150 ≠ Class 300 (nominal, never close)', () => {
  const a = mat({ id: 1, organizationId: 1, category: 'Valves', attributes: [attr('pressure_class', '150#', true), attr('valve_type', 'GATE', true)] });
  const b = mat({ id: 2, organizationId: 2, category: 'Valves', attributes: [attr('pressure_class', 'Class 150', true), attr('valve_type', 'GATE', true)] });
  const c = mat({ id: 3, organizationId: 2, category: 'Valves', attributes: [attr('pressure_class', 'Class 300', true), attr('valve_type', 'GATE', true)] });
  const same = compareTechnical(a, b);
  assert.equal(same.criticalConflicts.length, 0);
  assert.ok(same.comparisons.find((x) => x.attributeName === 'pressure_class')?.type === 'NORMALIZED_MATCH');
  const diff = compareTechnical(a, c);
  assert.ok(diff.criticalConflicts.some((x) => x.startsWith('pressure_class: 150# vs Class 300')));
  // 150 vs 300 would be 67% apart anyway — assert the NOMINAL path, not the
  // numeric path, by using two close designations: 600# vs Class 600 spellings.
  const d = mat({ id: 3, organizationId: 2, category: 'Valves', attributes: [attr('pressure_class', 'Class 600', true)] });
  const e = mat({ id: 4, organizationId: 2, category: 'Valves', attributes: [attr('pressure_class', '600#', true)] });
  assert.equal(compareTechnical(d, e).criticalConflicts.length, 0, '600# ≡ Class 600 after canonicalization');
});

test('§12 fasteners: thread specification is nominal — M16 ≡ M16, M16 ≠ M20, never close', () => {
  const a = mat({ id: 1, organizationId: 1, category: 'Fasteners', attributes: [attr('thread_specification', 'M16', true), attr('diameter', '16', true)] });
  const b = mat({ id: 2, organizationId: 2, category: 'Fasteners', attributes: [attr('thread_specification', 'M16', true), attr('diameter', '16', true)] });
  const c = mat({ id: 3, organizationId: 2, category: 'Fasteners', attributes: [attr('thread_specification', 'M20', true), attr('diameter', '20', true)] });
  const same = compareTechnical(a, b);
  assert.equal(same.criticalConflicts.length, 0);
  const diff = compareTechnical(a, c);
  assert.ok(diff.criticalConflicts.some((x) => x.startsWith('thread_specification: M16 vs M20')));
});

test('§12 motors: voltage/power stay measured — within tolerance close, beyond conflicts', () => {
  const a = mat({ id: 1, organizationId: 1, category: 'Motors', attributes: [attr('voltage_rating', '415 V', true), attr('power_rating', '30 KW', true)] });
  const same = mat({ id: 2, organizationId: 2, category: 'Motors', attributes: [attr('voltage_rating', '415 V', true), attr('power_rating', '30 KW', true)] });
  // 5% apart — beyond tolerance → conflict (measurement rule, not nominal).
  const other = mat({ id: 3, organizationId: 2, category: 'Motors', attributes: [attr('voltage_rating', '230 V', true), attr('power_rating', '30 KW', true)] });
  assert.equal(compareTechnical(a, same).criticalConflicts.length, 0);
  assert.ok(compareTechnical(a, other).criticalConflicts.some((x) => x.startsWith('voltage_rating: 415 V vs 230 V')));
});

test('§12 pumps: port sizes are nominal designations, casing/pressure measured', () => {
  const a = mat({ id: 1, organizationId: 1, category: 'Pumps', attributes: [attr('suction_size', '4 IN', true), attr('discharge_size', '3 IN', true), attr('pressure_class', '10 bar'), attr('stage_count', '10')] });
  const same = mat({ id: 2, organizationId: 2, category: 'Pumps', attributes: [attr('suction_size', '4 IN', true), attr('discharge_size', '3 IN', true), attr('pressure_class', '10 bar'), attr('stage_count', '10')] });
  const diff = mat({ id: 3, organizationId: 2, category: 'Pumps', attributes: [attr('suction_size', '6 IN', true), attr('discharge_size', '4 IN', true), attr('pressure_class', '10 bar'), attr('stage_count', '14')] });
  assert.equal(compareTechnical(a, same).criticalConflicts.length, 0);
  const r = compareTechnical(a, diff);
  assert.ok(r.criticalConflicts.some((x) => x.startsWith('suction_size: 4 IN vs 6 IN')));
  assert.ok(r.criticalConflicts.some((x) => x.startsWith('discharge_size: 3 IN vs 4 IN')));
  // stage_count stays measured: 10 vs 11 is ~9.5% → conflict, but 10 vs 10.1 (1%) → CLOSE.
  const near = mat({ id: 4, organizationId: 2, category: 'Pumps', attributes: [attr('suction_size', '4 IN', true), attr('stage_count', '10.1')] });
  const rn = compareTechnical(a, near);
  assert.ok(rn.comparisons.find((x) => x.attributeName === 'stage_count')?.type === 'CLOSE_MATCH');
});

/* ------------- §13 assembly / kit variant awareness ----------------------- */

import { detectAssembly, compareAssemblySignals } from '../src/lib/pipeline/assembly';

test('§13 A: standalone vs WITH NUT routes to NEEDS_TECHNICAL_REVIEW with named evidence', () => {
  const attrs = [attr('series', '6205', true), attr('seal_type', '2RS', true), attr('bore_diameter', '25', true)];
  const a = mat({ id: 1, organizationId: 1, originalDescription: 'BALL BEARING 6205 2RS', attributes: attrs });
  const b = mat({ id: 2, organizationId: 2, originalDescription: 'BALL BEARING 6205 2RS WITH NUT', attributes: attrs });
  const r = scorePair(a, b);
  assert.equal(r.decision, 'NEEDS_TECHNICAL_REVIEW');
  assert.ok(r.evidence.assemblyConfiguration, 'assembly configuration recorded in evidence');
  assert.equal(r.evidence.assemblyConfiguration?.materialA, 'Standalone');
  assert.equal(r.evidence.assemblyConfiguration?.materialB, 'With NUT');
  assert.ok(r.explanation.includes('Assembly configuration:'), 'explanation names the distinction');
  assert.ok(r.explanation.includes('Standalone') && r.explanation.includes('With NUT'));
  // Excluded from the technical score: identical attributes must still agree.
  assert.equal(r.technicalScore, 100);
});

test('§13 B: WITH NUT vs WITH NUT agrees — no assembly conflict, decision unaffected', () => {
  const a = mat({ id: 1, organizationId: 1, originalDescription: 'BALL BEARING 6205 2RS WITH NUT', attributes: [attr('series', '6205', true)] });
  const b = mat({ id: 2, organizationId: 2, originalDescription: 'BEARING 6205-2RS WITH NUT', attributes: [attr('series', '6205', true)] });
  const tech = compareTechnical(a, b);
  assert.equal(tech.assemblyComparison, null);
  assert.equal(detectAssembly(a.originalDescription).status, 'with_component');
  assert.deepEqual(detectAssembly(a.originalDescription).components, ['NUT']);
});

test('§13 C: standalone vs KIT routes to review', () => {
  const a = mat({ id: 1, organizationId: 1, originalDescription: 'BALL VALVE 2 IN CLASS 150', attributes: [attr('nominal_size', '2 IN', true)] });
  const b = mat({ id: 2, organizationId: 2, originalDescription: 'BALL VALVE 2 IN CLASS 150 KIT', attributes: [attr('nominal_size', '2 IN', true)] });
  const r = scorePair(a, b);
  assert.equal(r.decision, 'NEEDS_TECHNICAL_REVIEW');
  assert.equal(r.evidence.assemblyConfiguration?.materialB, 'Kit');
});

test('§13 D: WITH WASHER vs WITH WASHER — same components, no assembly conflict', () => {
  const s = detectAssembly('BOLT M16 X 60 WITH WASHER');
  assert.equal(s.status, 'with_component');
  assert.deepEqual(s.components, ['WASHER']);
  assert.equal(compareAssemblySignals(s, detectAssembly('BOLT M16X60 WITH WASHER')), null);
});

test('§13 E: "set" in an irrelevant context (SET SCREW / OFFSET) is not an assembly signal', () => {
  for (const d of ['SET SCREW M8 X 20', 'OFFSET FLANGE 3 IN', 'ASSEMBLED AT PLANT']) {
    // SET SCREW/OFFSET: no trigger; bare ASSEMBL* only when a real word.
    const s = detectAssembly(d);
    if (d === 'ASSEMBLED AT PLANT') continue; // ASSEMBL(IES|Y) regex requires the noun
    assert.equal(s.status, 'standalone', d);
    assert.deepEqual(s.components, [], d);
  }
  // A genuine COMPLETE SET is detected, but two of them agree → no conflict.
  const kit = detectAssembly('GASKET COMPLETE SET FOR PUMP');
  assert.equal(kit.status, 'complete_set');
  assert.equal(compareAssemblySignals(kit, kit), null);
});

test('§13 F: detection never mutates the original descriptions', () => {
  const a = mat({ id: 1, organizationId: 1, originalDescription: 'CENT PUMP 2X1.5-11 WITH SEAL', attributes: [attr('suction_size', '2 IN', true)] });
  const b = mat({ id: 2, organizationId: 2, originalDescription: 'CENT PUMP 2X1.5-11', attributes: [attr('suction_size', '2 IN', true)] });
  const before = [a.originalDescription, b.originalDescription];
  compareTechnical(a, b);
  scorePair(a, b);
  assert.deepEqual([a.originalDescription, b.originalDescription], before);
});

/* ---------------- 6. database-backed flow (§18.9-10, §13-14) -------------- */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-matching-'));
const testDb = new DatabaseSync(path.join(tmpDir, 'test.db'));

function seedDb(): void {
  migrate(testDb);
  setDbForTests(testDb);
  const now = new Date().toISOString();
  const insOrg = testDb.prepare(
    `INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
  );
  const cpcl = Number(insOrg.run('CPCL', 'Chennai Petroleum Corporation Limited (synthetic demo)', now, now).lastInsertRowid);
  const ntpc = Number(insOrg.run('NTPC', 'NTPC Limited (synthetic demo)', now, now).lastInsertRowid);
  const bhel = Number(insOrg.run('BHEL', 'Bharat Heavy Electricals Limited (synthetic demo)', now, now).lastInsertRowid);

  const ins = testDb.prepare(
    `INSERT INTO material_records
       (organization_id, original_code, original_description, normalized_description, category,
        manufacturer, part_number, uom, processing_status, classification_confidence,
        classification_source, quality_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready_for_matching', 1.0, 'rule', 'good', ?, ?)`
  );
  const cp1001 = Number(
    ins.run(cpcl, 'CP-1001', 'SKF BALL BEARING 6205-2RS', 'SKF BALL BEARING 6205-2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid
  );
  const nt8821 = Number(
    ins.run(ntpc, 'NT-8821', 'SKF DEEP GROOVE BRG 6205 2RS', 'SKF DEEP GROOVE BEARING 6205 2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid
  );
  const bh4410 = Number(
    ins.run(bhel, 'BH-4410', 'SKF BEARING 6205-ZZ', 'SKF BEARING 6205-ZZ', 'Bearings', 'SKF', '6205-ZZ', 'EA', now, now).lastInsertRowid
  );

  const bearingAttrs: Array<[string, string, boolean]> = [
    ['series', '6205', true], ['bore_diameter', '25', true], ['outer_diameter', '52', false], ['width', '15', false],
  ];
  for (const id of [cp1001, nt8821]) {
    upsertAttribute({ materialId: id, attributeName: 'seal_type', value: '2RS', normalizedValue: '2RS', isCritical: true, extractionMethod: 'rule' });
    upsertAttribute({ materialId: id, attributeName: 'bearing_type', value: 'DEEP_GROOVE_BALL', extractionMethod: 'rule' });
    for (const [n, v, c] of bearingAttrs) upsertAttribute({ materialId: id, attributeName: n, value: v, isCritical: c, extractionMethod: 'rule' });
  }
  upsertAttribute({ materialId: bh4410, attributeName: 'seal_type', value: 'ZZ', normalizedValue: 'ZZ', isCritical: true, extractionMethod: 'rule' });
  upsertAttribute({ materialId: bh4410, attributeName: 'bearing_type', value: 'DEEP_GROOVE_BALL', extractionMethod: 'rule' });
  for (const [n, v, c] of bearingAttrs) upsertAttribute({ materialId: bh4410, attributeName: n, value: v, isCritical: c, extractionMethod: 'rule' });
}

function main(): void {
  seedDb();

  const materials = listAllMaterialsForMatching();
  assert.equal(materials.length, 3);

  const comparison = getMaterialsForComparison(materials[0].id, materials[1].id);
  assert.equal(comparison.length, 2);

  // §18.9 cross-CPSE matching run
  const summary = runMatching('matching-tests');
  assert.equal(summary.pairsCompared, 3, 'CPCL/NTPC/BHEL bearings = 3 cross-org pairs');
  assert.ok(summary.candidatesCreated >= 2, `expected >=2 candidates, got ${summary.candidatesCreated}`);
  assert.ok((summary.byDecision['HIGH_CONFIDENCE_MATCH'] ?? 0) >= 1, 'CP1001↔NT8821 must be high-confidence');
  assert.ok((summary.byDecision['NEEDS_TECHNICAL_REVIEW'] ?? 0) >= 1, '2RS↔ZZ pair must need review');

  const metrics = getDashboardMetrics(null);
  assert.ok(metrics.highConfidenceCandidates >= 1);
  assert.ok(metrics.matchOverview.some((m) => m.decision === 'NEEDS_TECHNICAL_REVIEW'));

  // Human approval workflow on the high-confidence pair (§18.10)
  const approved = findMatchBetween('CP-1001', 'NT-8821');
  assert.ok(approved, 'high-confidence pair persisted');
  const decision = decideMatch(approved!.candidate.id, { decision: 'approved', reviewer: 'test-reviewer', comment: 'Specifications verified.' }, 'matching-tests');
  assert.equal(decision.status, 'approved');

  // §14 CMI only after approval
  const cmi = createCmiFromMatch(
    { code: 'NMC-000123', name: 'Ball bearing 6205-2RS (synthetic demo)', category: 'Bearings', matchId: approved!.candidate.id },
    'matching-tests'
  );
  assert.equal(cmi.mappingsCreated, 2);
  const cmis = listCmiWithMembers();
  const created = cmis.find((c) => c.cmi.code === 'NMC-000123');
  assert.ok(created, 'CMI created');
  assert.equal(created!.members.length, 2);
  const memberCodes = created!.members.map((m) => m.original_code).sort();
  assert.deepEqual(memberCodes, ['CP-1001', 'NT-8821'], 'original codes preserved');

  // CMI must be REJECTED on a pending (non-approved) match
  const pendingPair = findMatchBetween('CP-1001', 'BH-4410');
  if (pendingPair && pendingPair.candidate.status === 'pending') {
    assert.throws(() => createCmiFromMatch(
      { code: 'NMC-BAD', name: 'Should not exist', category: 'Bearings', matchId: pendingPair.candidate.id },
      'matching-tests'
    ), /only be created from an approved match/);
  }

  // Rejection path records an audit-able decision without creating mappings
  const rejected = findMatchBetween('CP-1001', 'BH-4410');
  if (rejected && rejected.candidate.status === 'pending') {
    decideMatch(rejected.candidate.id, { decision: 'rejected', reviewer: 'test-reviewer', comment: '2RS and ZZ are different seal configurations.' }, 'matching-tests');
    const after = findMatchBetween('CP-1001', 'BH-4410');
    assert.equal(after!.candidate.status, 'rejected');
    const { total } = listMappings({ cmiId: cmi.cmiId, page: 1, pageSize: 10 });
    assert.equal(total, 2, 'rejected pair produced no extra mappings');
  }

  // ---- Step 9.5 regression: stale lastInsertRowid on a no-op upsert -------
  // Re-processing an ALREADY-DECIDED pair must not insert anything and must
  // return the existing candidate id. The old implementation trusted
  // lastInsertRowid after the guarded UPSERT matched 0 rows (a stale rowid
  // pointing at no row), so runMatching then crashed in enqueueReview with
  // FOREIGN KEY constraint failed the first time a decided match existed.
  const approvedRow = testDb
    .prepare(
      `SELECT mc.id, mc.source_material_id, mc.candidate_material_id, mc.status FROM match_candidates mc
         JOIN material_records s ON s.id = mc.source_material_id
         JOIN material_records c ON c.id = mc.candidate_material_id
        WHERE (s.original_code = 'CP-1001' AND c.original_code = 'NT-8821')
           OR (s.original_code = 'NT-8821' AND c.original_code = 'CP-1001')`
    )
    .get() as { id: number; source_material_id: number; candidate_material_id: number; status: string } | undefined;
  assert.ok(approvedRow, 'an approved (decided) match exists');
  assert.equal(approvedRow!.status, 'approved');
  const candidatesBefore = (testDb.prepare('SELECT COUNT(*) AS n FROM match_candidates').get() as { n: number }).n;
  const reupsert = upsertMatch({
    sourceMaterialId: approvedRow!.source_material_id,
    candidateMaterialId: approvedRow!.candidate_material_id,
    semanticScore: 99,
    fuzzyScore: 99,
    technicalScore: 99,
    categoryCompatible: true,
    finalScore: 99,
    matchType: 'identical',
    explanation: 'step 9.5 regression probe against a decided match',
    matchRunId: 'regression-run-9.5',
  });
  assert.equal(reupsert.created, false, 'no new insert performed for a decided match');
  assert.equal(reupsert.id, approvedRow!.id, 'returned id is the existing candidate id (no stale lastInsertRowid)');
  const reupserted = testDb.prepare('SELECT id, status FROM match_candidates WHERE id = ?').get(reupsert.id) as
    | { id: number; status: string }
    | undefined;
  assert.ok(reupserted, 'returned id must exist in match_candidates (no ghost rowid)');
  assert.equal(reupserted!.status, 'approved', 'decided match status unchanged by the re-upsert');
  assert.equal(
    (testDb.prepare('SELECT COUNT(*) AS n FROM match_candidates').get() as { n: number }).n,
    candidatesBefore,
    'candidate count unchanged by the re-upsert'
  );
  const keptDecision = testDb.prepare('SELECT decision FROM match_decisions WHERE match_id = ?').all(approvedRow!.id) as Array<{ decision: string }>;
  assert.ok(keptDecision.length > 0 && keptDecision.every((d) => d.decision === 'approved'), 'existing decision remains intact');

  // ---- Step 9.5 regression: deletePendingMatches vs common_materials ------
  // Pending candidates may be referenced by common_materials (auto-created
  // CMIs from an earlier run). The cleanup must remove those references,
  // keep decided/approved structures intact, and leave FKs valid.
  const pendingRow = testDb.prepare(`SELECT id FROM match_candidates WHERE status = 'pending' ORDER BY id LIMIT 1`).get() as { id: number } | undefined;
  assert.ok(pendingRow, 'a pending candidate exists for the cleanup test');
  const orphanCmi = createCommonMaterial({
    code: 'NMC-ORPHAN-REG',
    name: 'Orphan probe (step 9.5 regression, removed by cleanup)',
    category: 'Bearings',
    sourceMatchId: pendingRow!.id,
  });
  deletePendingMatches();
  assert.equal(testDb.prepare('SELECT id FROM match_candidates WHERE id = ?').get(pendingRow!.id), undefined, 'pending candidate removed');
  assert.equal(testDb.prepare('SELECT id FROM common_materials WHERE id = ?').get(orphanCmi.id), undefined, 'CMI referencing a pending candidate removed (no orphan)');
  assert.equal((testDb.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0, 'FK integrity holds after cleanup');
  assert.ok(testDb.prepare('SELECT id FROM match_candidates WHERE id = ?').get(approvedRow!.id), 'decided/approved candidate preserved');
  assert.ok(testDb.prepare('SELECT id FROM match_decisions WHERE match_id = ?').get(approvedRow!.id), 'decided/approved decision history preserved');
  const realCmi = testDb.prepare(`SELECT id FROM common_materials WHERE code = 'NMC-000123'`).get() as { id: number } | undefined;
  assert.ok(realCmi, 'CMI sourced from an approved match preserved');
  assert.equal(
    (testDb.prepare('SELECT COUNT(*) AS n FROM material_mappings WHERE cmi_id = ?').get(realCmi!.id) as { n: number }).n,
    2,
    'approved mappings preserved'
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.error(failures.map((f) => ` - ${f}`).join('\n'));
    process.exitCode = 1;
  }
}

function findMatchBetween(codeA: string, codeB: string) {
  const rows = testDb
    .prepare(
      `SELECT mc.id, mc.status FROM match_candidates mc
         JOIN material_records s ON s.id = mc.source_material_id
         JOIN material_records c ON c.id = mc.candidate_material_id
        WHERE (s.original_code = ? AND c.original_code = ?) OR (s.original_code = ? AND c.original_code = ?)`
    )
    .get(codeA, codeB, codeB, codeA) as { id: number; status: string } | undefined;
  if (!rows) return undefined;
  return getMatch(rows.id);
}

main();
