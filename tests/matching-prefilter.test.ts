/**
 * Step-5 regression tests — the provably-lossless persistence-floor prefilter.
 *
 * `npx tsx tests/matching-prefilter.test.ts` (part of the npm test chain).
 *
 * What is proven, against the UNTOUCHED scoring/decision pipeline:
 *   1. Exhaustive agreement on a seeded corpus: for EVERY retrieval pair, the
 *      cheap-core verdict (the shared persistence-floor rule, as both
 *      pipelines apply it) equals the persisted pipeline's own rule
 *      (score.decision === 'NOT_A_MATCH' || finalScore < notAMatch).
 *      This is the losslessness proof.
 *   2. Recall: every HIGH_CONFIDENCE_MATCH / NEEDS_TECHNICAL_REVIEW pair is
 *      kept — 100% actionable recall by measurement, not just by argument.
 *   3. The task's business case: wording-different near-duplicates
 *      ("SKF BALL BEARING 6205-2RS" vs "SKF DEEP GROOVE BRG 6205 2RS")
 *      are kept as candidates.
 *   4. runMatching persisted output (match_candidates + review_queue) is
 *      BIT-IDENTICAL with MATCH_PREFILTER=off vs on.
 *   5. runJob output likewise identical, chunk plan intact (lifecycle,
 *      failure-rollback and resume semantics stay covered by
 *      matching-job.test.ts).
 *   6. Streaming enumeration at dense scale completes deterministically and
 *      exercises both keep and drop paths on millions of pairs.
 *
 * The 25k/30k stress benchmarks live in .freebuff/step5-bench.ts (kept out of
 * the unit suite for runtime); this suite proves semantics, the bench proves scale.
 *
 * All tests run against a disposable temp SQLite database; production
 * Supabase and data/materialiq.db are untouched (test-env guard active).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { insertMaterial, upsertAttribute } from '../src/lib/db/repositories/material-repository';
import { listAllMaterialsForMatching } from '../src/lib/db/repositories/matching-queries';
import { scorePair, scorePairCore, generatePairs, iteratePairs, countPairs } from '../src/lib/matching/engine';
import { MatchingRunCache } from '../src/lib/matching/runtime';
import { survivesPersistenceFloor, prefilterEnabled } from '../src/lib/matching/prefilter';
import { runMatching } from '../src/lib/services/matching-service';
import { createMatchingJob, runJob } from '../src/lib/services/matching-job-service';
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

/* --------------------------- deterministic RNG ---------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ corpus design ----------------------------- */

const ORGS = ['CPCL', 'NTPC', 'BHEL', 'SAIL', 'NLC'] as const;

/** One product family: replicated across orgs with wording variants + attribute variety. */
interface FamilySpec {
  category: string;
  familyToken: string;
  /** per-org description variants (same item, different wording). */
  wordings: string[];
  attrs: Array<[string, string, boolean]>; // name, value, critical
  /** org index → attribute overrides (conflicts / omissions). */
  overrides?: Record<number, Record<string, string | null>>;
  manufacturer: string;
}

const FAMILIES: FamilySpec[] = [
  {
    category: 'Bearings', familyToken: '6205',
    wordings: [
      'SKF BALL BEARING 6205-2RS SEALED CHROME STEEL',
      'SKF DEEP GROOVE BRG 6205 2RS SEALED CHROME STEEL',
      'SKF DEEP GROOVE BALL BRG 6205 2RS CHROME STEEL C3',
      'SKF BALL BEARING 6205 RS SEALED CHROME STEEL',
    ],
    attrs: [['series', '6205', true], ['seal_type', '2RS', true], ['bore_diameter', '25', true], ['outer_diameter', '52', false], ['material_type', 'CHROME_STEEL', false]],
    manufacturer: 'SKF',
  },
  {
    category: 'Bearings', familyToken: '6308',
    wordings: [
      'FAG SPHERICAL ROLLER BEARING 6308 ZZ C3 STEEL',
      'FAG SPHERICAL ROLLER BRG 6308 ZZ STEEL C3',
      'FAG SPHERICAL ROLLER BEARING 6308 ZZ C3 MACHINED BRASS CAGE',
    ],
    attrs: [['series', '6308', true], ['seal_type', 'ZZ', true], ['bore_diameter', '40', true], ['material_type', 'STEEL', false]],
    manufacturer: 'FAG',
    overrides: { 2: { seal_type: '2RS' } }, // seal conflict variant
  },
  {
    category: 'Valves', familyToken: 'GATE150',
    wordings: [
      'GATE VALVE 2IN 150# RF WCB FLANGED ENDS',
      'GATE VLV 2IN CLASS 150 WCB FLANGED ENDS',
      'GATE VALVE 2 IN 150 WCB RAISED FACE FLANGE',
    ],
    attrs: [['valve_type', 'GATE', true], ['nominal_size', '2IN', true], ['pressure_class', '150', true], ['body_material', 'WCB', true], ['end_connection', 'FLANGED', false]],
    manufacturer: 'AUDCO',
    overrides: { 1: { pressure_class: '300' } }, // pressure-class conflict variant
  },
  {
    category: 'Valves', familyToken: 'GLOBE300',
    wordings: [
      'GLOBE VALVE 4IN 300# A216 WCB SOCKET WELD',
      'GLOBE VLV 4IN CLASS 300 A216 WCB SW ENDS',
    ],
    attrs: [['valve_type', 'GLOBE', true], ['nominal_size', '4IN', true], ['pressure_class', '300', true], ['body_material', 'A216_WCB', true], ['end_connection', 'SOCKET_WELD', false]],
    manufacturer: 'LNT',
  },
  {
    category: 'Motors', familyToken: 'MTR30',
    wordings: [
      'SIEMENS 30KW 415V B3 INDUCTION MOTOR THREE PHASE',
      'SIEMENS 30 KW 415V B3 IND MTR THREE PHASE',
      'SIEMENS INDUCTION MOTOR 30KW 415V B3 FOOT MOUNTED',
    ],
    attrs: [['motor_type', 'INDUCTION', true], ['power_rating', '30', true], ['voltage_rating', '415', true], ['phase', 'THREE_PHASE', true], ['frequency', '50', true]],
    manufacturer: 'SIEMENS',
    overrides: { 3: { voltage_rating: '230' } }, // voltage conflict variant
  },
  {
    category: 'Pumps', familyToken: 'KSB43',
    wordings: [
      'KSB CENTRIFUGAL PUMP 4X3-10 CAST IRON WITH BASEPLATE',
      'KSB CENTRIFUGAL PMP 4X3-10 CI BASEPLATE MOUNTED',
      'KSB CENTRIFUGAL PUMP 4X3-10 CAST IRON SPARE ROTOR',
    ],
    attrs: [['pump_type', 'CENTRIFUGAL', true], ['suction_size', '4IN', true], ['discharge_size', '3IN', true], ['casing_material', 'CAST_IRON', true], ['power_rating', '7.5', true]],
    manufacturer: 'KSB',
  },
  {
    category: 'Fasteners', familyToken: 'M20X80',
    wordings: [
      'HEX BOLT M20X80 SS304 A2-70 FULL THREAD',
      'HEX BOLT M20 X 80 SS304 A2-70 FULLY THREADED',
      'HEX BOLT M20X80 SS304 A2-70 FULL THREAD WITH NUT',
    ],
    attrs: [['fastener_type', 'HEX_BOLT', true], ['thread_specification', 'M20', true], ['diameter', '20', true], ['length', '80', true], ['material_grade', 'A2-70', true]],
    manufacturer: 'UNBRAKO',
  },
  {
    category: 'Fasteners', familyToken: 'M16X65',
    wordings: [
      'HEX BOLT M16X65 SS316 A4-80 HALF THREAD',
      'HEX BOLT M16 X 65 SS316 A4-80 HALF THREADED',
    ],
    attrs: [['fastener_type', 'HEX_BOLT', true], ['thread_specification', 'M16', true], ['diameter', '16', true], ['length', '65', true], ['material_grade', 'A4-80', true]],
    manufacturer: 'UNBRAKO',
  },
];

/**
 * Generic junk items: realistic-length descriptions that share exactly one
 * incidental token with a family (STEEL / 4IN / SPARE / BEARING / VALVE …)
 * but describe a different item — the source of sub-floor pairs the prefilter
 * must be able to drop.
 */
const JUNK: Array<[string, string]> = [
  ['Bearings', 'INDUSTRIAL OIL SEAL 4IN NBR DOUBLE LIP SHAFT MOUNTED SPARE'],
  ['Bearings', 'THERMOCOUPLE ASSEMBLY 4IN STEM SS316 BEARING TEMP MONITORING'],
  ['Valves', 'HIGH TEMP BALL VALVE 4IN SCREWED ENDS SPARE FOR MAINTENANCE'],
  ['Valves', 'BRASS FITTING VALVE 4IN THREADED NPT BRASS BODY SPARE'],
  ['Motors', 'THRUST BEARING 4IN CS SPARE FOR MOTOR OVERHAUL ACTIVITY'],
  ['Motors', 'REINFORCED CABLE GLAND 4IN CU ARMORED MOTOR FEEDER'],
  ['Pumps', 'CENTRIFUGAL PUMP 4IN GAUGE GLASS ASSEMBLY SPARE PART'],
  ['Pumps', 'STEEL REINFORCED SUCTION HOSE 4IN FOR PUMP PRIMING UNIT'],
  ['Fasteners', 'REINFORCED WELDING ELECTRODE 4IN LENGTH CARBON STEEL PACK'],
  ['Fasteners', 'STEEL EXPANSION ANCHOR BOLT 4IN EMBEDMENT M12 GRADE SPARE'],
];

/**
 * Distractor materials: long, realistic, UNRELATED items that embed one weak
 * token of a family (its series number, a category word, "SPARE") — the
 * calibrated shape of sub-floor pairs (sem ≈ 22–26, fuz ≤ 12, final < 30).
 * Deterministic: index-driven, no RNG.
 */
const DISTRACTOR_TEMPLATES: Array<[string, string, Array<(v: string) => string>]> = [
  // Bearings
  ['Bearings', '6205', [
    (v) => `BRIDGE RECTIFIER MODULE 35A 1200V WITH HEATSINK ${v} SERIES MOUNTING KIT TERMINAL SPARE`,
    (v) => `VIBRATION MONITORING SENSOR MOUNTING BRACKET FOR ${v} SIZE HOUSING INDUSTRIAL PANEL`,
  ]],
  ['Bearings', '6308', [
    (v) => `PLC ANALOG INPUT CARD 8CH 4-20MA ${v} GRID TERMINAL ASSIGNMENT INDUSTRIAL CABINET`,
    (v) => `HYDRAULIC POWER PACK 5HP WITH COOLING CIRCUIT ${v} SERIES VALVE MANIFOLD MOUNTED`,
  ]],
  // Valves
  ['Valves', 'GATE', [
    (v) => `CONTROL ROOM HVAC DUCT ${v} DAMPER ACTIVATOR 24V ELECTRIC SPARE FOR AIR HANDLING UNIT`,
    (v) => `SLUICE GATE ${v} TYPE CAST IRON FRAME FOR CIVIL DRAIN CHANNEL MAINTENANCE SPARE`,
  ]],
  ['Valves', 'GLOBE', [
    (v) => `PLANETARY GEARBOX RATIO 40:1 INPUT ${v} FLANGE MOUNTED INDUSTRIAL DRIVE SPARE`,
    (v) => `WORLD TRADE PLAIN CARBON PLATE ${v} GRADE THICKNESS MILL CERTIFIED STORAGE RACK`,
  ]],
  // Motors
  ['Motors', 'MTR30', [
    (v) => `MTR30 DESIGNATION PLATE ENGRAVER TEMPLATE FOR MOTOR NAMEPLATE REPAIR SHOP SPARE`,
    (v) => `VARIABLE FREQUENCY DRIVE 30KW PANEL MOUNTED WITH ${v} RATING LABEL COOLING FAN SPARE`,
  ]],
  // Pumps
  ['Pumps', 'KSB43', [
    (v) => `${v} PUMP FOUNDATION BOLT SET WITH TEMPLATES AND GROUT FOR CIVIL WORKS PACKAGE`,
    (v) => `STRAINER BASKET ${v} FABRICATION DRAWING AS-BUILT REVISION SPARE DOCUMENTATION`,
  ]],
  // Fasteners
  ['Fasteners', 'M20X80', [
    (v) => `ANCHOR FASTENER ${v} EMBEDMENT TYPE WITH HEAVY DUTY WASHER AND LOCK NUT PACKAGE`,
    (v) => `THREADED ROD ${v} CLASS DIN 975 FULL LENGTH INDUSTRIAL RACKING INSTALLATION SPARE`,
  ]],
  ['Fasteners', 'M16X65', [
    (v) => `CABLE TRAY SUPPORT CLUSTER ${v} HOT DIP GALVANIZED INDUSTRIAL RACEWAY SPARE KIT`,
    (v) => `SUPPORT HANGER ROD ${v} SIZE WITH BEAM CLAMP AND HEX NUTS FOR PIPE ROUTING SPARE`,
  ]],
];

function seedCorpus(db: DatabaseSync): number {
  migrate(db);
  setDbForTests(db);
  const now = new Date().toISOString();
  const insOrg = db.prepare(
    `INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
  );
  const orgIds = ORGS.map((code) => Number(insOrg.run(code, `${code} (synthetic demo)`, now, now).lastInsertRowid));

  const rng = mulberry32(20260922);
  let count = 0;

  // Families replicated across 2-4 orgs (wording variants), with attribute
  // variety: omissions, conflicts, and per-family manufacturers.
  for (const fam of FAMILIES) {
    const orgCount = 2 + Math.floor(rng() * 3); // 2..4 orgs
    for (let k = 0; k < orgCount; k++) {
      const orgIdx = (k * 2 + FAMILIES.indexOf(fam)) % ORGS.length;
      const wording = fam.wordings[k % fam.wordings.length];
      const id = insertMaterial({
        organizationId: orgIds[orgIdx],
        originalCode: `${ORGS[orgIdx]}-${fam.familyToken}-${k}`,
        originalDescription: wording,
        normalizedDescription: wording.toUpperCase(),
        category: fam.category,
        manufacturer: fam.manufacturer,
        partNumber: fam.familyToken,
        uom: 'EA',
      });
      count++;
      for (const [name, value, critical] of fam.attrs) {
        const override = fam.overrides?.[orgIdx]?.[name];
        if (override === null) continue; // deliberate omission → missingCritical path
        upsertAttribute({
          materialId: id,
          attributeName: name,
          value: override ?? value,
          normalizedValue: override ?? value,
          isCritical: critical,
          extractionMethod: 'rule',
        });
      }
    }
  }

  // Generic junk spread over orgs and categories.
  JUNK.forEach(([category, description], i) => {
    const orgIdx = i % ORGS.length;
    const id = insertMaterial({
      organizationId: orgIds[orgIdx],
      originalCode: `${ORGS[orgIdx]}-JUNK-${i}`,
      originalDescription: description,
      normalizedDescription: description.toUpperCase(),
      category,
      uom: 'EA',
    });
    count++;
    if (i % 4 === 0) {
      upsertAttribute({ materialId: id, attributeName: 'nominal_size', value: '4IN', normalizedValue: '4IN', isCritical: true, extractionMethod: 'rule' });
    } else if (i % 4 === 1) {
      upsertAttribute({ materialId: id, attributeName: 'material_type', value: 'STEEL', normalizedValue: 'STEEL', extractionMethod: 'rule' });
    }
  });

  // Distractors: several copies per template across orgs, embedding one weak
  // family token each — long unrelated texts that must land below the floor.
  DISTRACTOR_TEMPLATES.forEach(([category, familyToken, templates], dIdx) => {
    templates.forEach((render, tIdx) => {
      for (let k = 0; k < 4; k++) {
        const orgIdx = (k * 3 + dIdx * 2 + tIdx) % ORGS.length;
        const description = render(familyToken);
        const id = insertMaterial({
          organizationId: orgIds[orgIdx],
          originalCode: `${ORGS[orgIdx]}-DSTR-${dIdx}-${tIdx}-${k}`,
          originalDescription: description,
          normalizedDescription: description.toUpperCase(),
          category,
          uom: 'EA',
        });
        count++;
      }
    });
  });

  return count;
}

/* --------------------------------- setup ---------------------------------- */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-prefilter-'));
const testDb = new DatabaseSync(path.join(tmpDir, 'test.db'));
seedCorpus(testDb);
const materials = listAllMaterialsForMatching();
const runtime = new MatchingRunCache();

/** Pipeline persistence rule, verbatim from both matching pipelines. */
function pipelinePersists(finalScore: number, criticalConflicts: string[]): boolean {
  return criticalConflicts.length > 0 || finalScore >= 30;
}

function pairKey(a: MatchableMaterial, b: MatchableMaterial): string {
  return a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
}

/* ------------------- 1. exhaustive losslessness agreement ------------------ */

test('core verdict equals the pipeline persistence rule for EVERY retrieval pair', () => {
  const pairs = generatePairs(materials, runtime);
  assert.ok(pairs.length > 500, `corpus too small: ${pairs.length} pairs`);
  let kept = 0;
  let dropped = 0;
  for (const [a, b] of pairs) {
    // The production fast path's verdict: the shared rule on the cheap core.
    const willKeep = survivesPersistenceFloor(scorePairCore(a, b, runtime));
    // Cross-check against a FULL scorePair (core + tail) — proves the cheap
    // core's verdict equals the persisted pipeline's own rule for every pair.
    const score = scorePair(a, b, runtime);
    const persists = pipelinePersists(score.finalScore, score.evidence.criticalConflicts);
    assert.equal(
      willKeep,
      persists,
      `pair ${pairKey(a, b)} (${a.originalCode} vs ${b.originalCode}): core=${willKeep} pipeline=${persists} final=${score.finalScore} conflicts=${score.evidence.criticalConflicts.length}`
    );
    if (willKeep) kept++;
    else dropped++;
  }
  assert.ok(dropped > 20, `corpus must exercise drops meaningfully (dropped=${dropped})`);
  assert.ok(kept > 20, `corpus must exercise keeps meaningfully (kept=${kept})`);
});

test('every actionable pair survives: 100% HIGH_CONFIDENCE_MATCH / NEEDS_TECHNICAL_REVIEW recall', () => {
  const pairs = generatePairs(materials, runtime);
  let high = 0;
  let review = 0;
  for (const [a, b] of pairs) {
    const score = scorePair(a, b, runtime);
    const kept = survivesPersistenceFloor(scorePairCore(a, b, runtime));
    if (score.decision === 'HIGH_CONFIDENCE_MATCH') {
      high++;
      assert.ok(kept, `HIGH_CONFIDENCE_MATCH pair ${pairKey(a, b)} was dropped — RECALL LOSS`);
    }
    if (score.decision === 'NEEDS_TECHNICAL_REVIEW') {
      review++;
      assert.ok(kept, `NEEDS_TECHNICAL_REVIEW pair ${pairKey(a, b)} was dropped — RECALL LOSS`);
    }
  }
  assert.ok(high >= 3 && review >= 3, `corpus must exercise both actionable states (high=${high}, review=${review})`);
});

test('the SKF 6205-2RS wording-variant near-duplicate stays a candidate', () => {
  const pairs = generatePairs(materials, runtime);
  const cp = materials.find((m) => m.originalDescription === 'SKF BALL BEARING 6205-2RS SEALED CHROME STEEL');
  const nt = materials.find((m) => m.originalDescription === 'SKF DEEP GROOVE BRG 6205 2RS SEALED CHROME STEEL');
  assert.ok(cp && nt, 'business-case materials must exist in the corpus');
  const pair = pairs.find(([a, b]) => pairKey(a, b) === pairKey(cp, nt));
  assert.ok(pair, 'the wording-variant pair must be a retrieval candidate');
  assert.ok(survivesPersistenceFloor(scorePairCore(pair[0], pair[1], runtime)), 'the wording-variant pair must be KEPT by the persistence-floor rule');
  const score = scorePair(pair[0], pair[1], runtime);
  assert.ok(score.finalScore >= 60 || score.evidence.criticalConflicts.length > 0, 'business-case pair must be reviewable/high');
});

/* ----------------------- 4. runMatching output parity ---------------------- */

const CANDIDATE_COLUMNS = [
  'source_material_id', 'candidate_material_id', 'semantic_score', 'fuzzy_score',
  'technical_score', 'category_compatible', 'final_score', 'match_type',
  'explanation', 'critical_difference', 'evidence',
] as const;

function candidateSnapshot(): Array<Record<string, unknown>> {
  return (testDb
    .prepare(`SELECT ${CANDIDATE_COLUMNS.join(', ')} FROM match_candidates ORDER BY source_material_id, candidate_material_id`)
    .all() as unknown as Array<Record<string, unknown>>);
}

function queueSnapshot(): Array<Record<string, unknown>> {
  return (testDb
    .prepare(
      `SELECT c.source_material_id, c.candidate_material_id, q.priority, q.reason, q.critical_difference, q.status
         FROM review_queue q JOIN match_candidates c ON c.id = q.match_id
        ORDER BY c.source_material_id, c.candidate_material_id`
    )
    .all() as unknown as Array<Record<string, unknown>>);
}

test('runMatching persisted rows are bit-identical with MATCH_PREFILTER off vs on', () => {
  const saved = process.env.MATCH_PREFILTER;
  try {
    process.env.MATCH_PREFILTER = 'off';
    assert.equal(prefilterEnabled(), false);
    const off = runMatching('prefilter-tests');
    const offCandidates = candidateSnapshot();
    const offQueue = queueSnapshot();

    process.env.MATCH_PREFILTER = 'on';
    assert.equal(prefilterEnabled(), true);
    const on = runMatching('prefilter-tests');
    const onCandidates = candidateSnapshot();
    const onQueue = queueSnapshot();

    // Summary accounting.
    assert.equal(off.droppedByPrefilter, 0, 'off run must not drop via prefilter');
    const sumOff = Object.values(off.byDecision).reduce((x, y) => x + y, 0);
    assert.equal(sumOff, off.pairsCompared, 'off run scores every pair');
    // Fast path: scored pairs (byDecision) + skipped-tail drops == total, and
    // the per-state drop breakdown reconciles EXACTLY against the legacy run.
    const sumOn = Object.values(on.byDecision).reduce((x, y) => x + y, 0);
    assert.equal(
      sumOn + on.droppedByPrefilter,
      on.pairsCompared,
      `on run: scored + prefilter-dropped == total (sumOn=${sumOn} dropped=${on.droppedByPrefilter} total=${on.pairsCompared} byDecision=${JSON.stringify(on.byDecision)} droppedByState=${JSON.stringify(on.droppedByState)})`
    );
    assert.ok(on.droppedByPrefilter > 0, 'corpus must drop pairs via prefilter');
    for (const state of ['HIGH_CONFIDENCE_MATCH', 'NEEDS_TECHNICAL_REVIEW', 'LOW_CONFIDENCE', 'NOT_A_MATCH'] as const) {
      const droppedForState = on.droppedByState?.[state] ?? 0;
      assert.equal(
        (on.byDecision[state] ?? 0) + droppedForState,
        off.byDecision[state] ?? 0,
        `${state}: fast-path scored + dropped must equal legacy count`
      );
    }
    assert.equal(on.pairsCompared, off.pairsCompared);
    assert.equal(on.candidatesCreated, off.candidatesCreated);
    assert.equal(on.reviewItemsCreated, off.reviewItemsCreated);

    // Persisted rows: identical content (ids/timestamps/run ids excluded).
    assert.equal(onCandidates.length, offCandidates.length, `candidate row count ${onCandidates.length} vs ${offCandidates.length}`);
    for (let i = 0; i < offCandidates.length; i++) {
      assert.deepEqual(onCandidates[i], offCandidates[i], `candidate row ${i} differs`);
    }
    assert.deepEqual(onQueue, offQueue);
  } finally {
    if (saved === undefined) delete process.env.MATCH_PREFILTER;
    else process.env.MATCH_PREFILTER = saved;
  }
});

/* -------------------------- 5. runJob output parity ------------------------ */

test('runJob output is bit-identical with MATCH_PREFILTER off vs on, chunk plan intact', () => {
  const saved = process.env.MATCH_PREFILTER;
  try {
    process.env.MATCH_PREFILTER = 'off';
    const jobOff = createMatchingJob('prefilter-tests');
    const doneOff = runJob(jobOff.jobId);
    assert.equal(doneOff.status, 'COMPLETED');
    assert.equal(doneOff.processed, doneOff.total);
    const offCandidates = candidateSnapshot();
    const offQueue = queueSnapshot();

    process.env.MATCH_PREFILTER = 'on';
    const jobOn = createMatchingJob('prefilter-tests');
    const doneOn = runJob(jobOn.jobId);
    assert.equal(doneOn.status, 'COMPLETED');
    assert.equal(doneOn.processed, doneOn.total);
    assert.equal(doneOn.total, doneOff.total, 'deterministic pair count');
    const onCandidates = candidateSnapshot();
    const onQueue = queueSnapshot();

    assert.equal(onCandidates.length, offCandidates.length);
    for (let i = 0; i < offCandidates.length; i++) {
      assert.deepEqual(onCandidates[i], offCandidates[i], `job candidate row ${i} differs`);
    }
    assert.deepEqual(onQueue, offQueue);

    const chunks = testDb
      .prepare(`SELECT status FROM matching_run_chunks WHERE run_id = ?`)
      .all(jobOn.jobId) as unknown as Array<{ status: string }>;
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.every((c) => c.status === 'COMMITTED'), 'all chunks committed');

    testDb.prepare(`DELETE FROM matching_run_chunks WHERE run_id = ?`).run(jobOff.jobId);
    testDb.prepare(`DELETE FROM matching_runs WHERE id = ?`).run(jobOff.jobId);
    testDb.prepare(`DELETE FROM matching_run_chunks WHERE run_id = ?`).run(jobOn.jobId);
    testDb.prepare(`DELETE FROM matching_runs WHERE id = ?`).run(jobOn.jobId);
  } finally {
    if (saved === undefined) delete process.env.MATCH_PREFILTER;
    else process.env.MATCH_PREFILTER = saved;
  }
});

/* --------------------- 6. dense-scale streaming behavior ------------------- */

/**
 * Dense corpus: three same-category template groups sharing the weak token
 * "SPARE" — within-group pairs are near-identical (kept); cross-group pairs
 * are long unrelated texts whose scores cluster near the floor (the 256-dim
 * trigram-hash collision floor keeps their cosine ≈ 25–40, so some drop and
 * some sit just above the floor — exactly the boundary zone the prefilter
 * must get right). The exhaustive every-pair proof lives in the seeded
 * corpus test; THIS test verifies agreement on a 1% deterministic sample at
 * millions-of-pairs scale, plus determinism and bounded streaming.
 */
function denseMaterials(n: number): MatchableMaterial[] {
  const out: MatchableMaterial[] = [];
  for (let i = 0; i < n; i++) {
    const org = (i % 5) + 1;
    const code = `D-${String(i).padStart(6, '0')}`;
    const series = ['6205', '6308', '6008'][i % 3];
    const seal = ['2RS', 'ZZ', 'C3'][i % 3];
    const desc =
      i % 3 === 0
        ? `DEEP GROOVE BALL BEARING ${series} ${seal} SEALED CHROME STEEL C3 CLEARANCE SPARE`
        : i % 3 === 1
          ? `SEAMLESS CARBON STEEL PIPE 4IN SCH ${40 + (i % 3) * 10} ASTM A106 GRB PLAIN ENDS HYDRO TESTED SPARE`
          : `ELECTRIC ARC FURNACE TRANSFORMER 15MVA OLTC WITH COOLING RADIATORS GASKET KIT SPARE`;
    out.push({
      id: i + 1,
      organizationId: org,
      orgCode: `ORG${org}`,
      originalCode: code,
      originalDescription: desc,
      normalizedDescription: desc,
      category: 'Bearings',
      manufacturer: i % 7 === 0 ? 'SKF' : 'FAG',
      model: null,
      partNumber: null,
      uom: 'EA',
      attributes: [],
    });
  }
  return out;
}

test('dense-scale streaming: deterministic kept-stream, sampled 1% agreement, bounded enumeration', () => {
  const dense = denseMaterials(3000);
  const cache = new MatchingRunCache();
  const total = countPairs(dense, cache);
  assert.ok(total > 3_000_000, `dense corpus expected millions of pairs, got ${total}`);

  const hashKept = (): { hash: string; kept: number; dropped: number } => {
    let h = 0x811c9dc5;
    let kept = 0;
    let dropped = 0;
    for (const [a, b] of iteratePairs(dense, cache)) {
      if (survivesPersistenceFloor(scorePairCore(a, b, cache))) {
        kept++;
        h ^= a.id;
        h = Math.imul(h, 0x01000193);
        h ^= b.id;
        h = Math.imul(h, 0x01000193);
      } else {
        dropped++;
      }
    }
    return { hash: (h >>> 0).toString(16), kept, dropped };
  };

  const startHeap = process.memoryUsage().heapUsed;
  const run1 = hashKept();
  const run2 = hashKept();
  const endHeap = process.memoryUsage().heapUsed;

  assert.equal(run1.hash, run2.hash, 'kept stream must be deterministic across runs');
  assert.equal(run1.kept, run2.kept);
  assert.ok(run1.kept > 100_000, `dense corpus must keep pairs (kept=${run1.kept})`);

  // Scaled agreement: every 100th enumerated pair must classify identically
  // under the cheap-core rule and under full scoring + the pipeline rule.
  let checked = 0;
  let droppedSeen = 0;
  let position = 0;
  for (const [a, b] of iteratePairs(dense, cache)) {
    const willKeep = survivesPersistenceFloor(scorePairCore(a, b, cache));
    if (!willKeep) droppedSeen++;
    if (position % 100 === 0) {
      const score = scorePair(a, b, cache);
      assert.equal(
        willKeep,
        pipelinePersists(score.finalScore, score.evidence.criticalConflicts),
        `scaled agreement failure at position ${position}: final=${score.finalScore}`
      );
      checked++;
    }
    position++;
  }
  assert.ok(checked > 30_000, `sample too small: ${checked}`);
  assert.ok(droppedSeen > 0, 'dense corpus must exercise the drop path (boundary-zone pairs)');
  assert.equal(run1.kept + droppedSeen, total);

  // Bounded enumeration: the streaming pass must not balloon the heap with a
  // pairs array (loose guard — the precise 25k/30k numbers are in the bench).
  assert.ok(endHeap - startHeap < 800 * 1024 * 1024, `heap grew ${(endHeap - startHeap) / 1048576}MB`);
});

/* --------------------------------- done ------------------------------------ */

testDb.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
