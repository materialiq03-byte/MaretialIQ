/**
 * Step-6 parity suite — prepared scoring vs the uncached reference path.
 *
 * `npx tsx tests/matching-prepared.test.ts` (part of the npm test chain).
 *
 * The uncached scorePair path (fresh tokenization, fresh assembly detection,
 * fresh config Sets, full norm recomputation, legacy compareTechnical) is the
 * SEMANTIC REFERENCE. The cached path consumes the per-material prepared
 * representation (MaterialRuntime: uniqueFuzzyTokens, embeddingNorm, prepared
 * attribute facts + assembly signal). This suite asserts, over a randomized
 * multi-category corpus with adversarial attribute shapes:
 *
 *   1. EXHAUSTIVE per-pair equality (every retrieval pair) of the FULL
 *      PairScore — scores, matchType, decision, band, explanation,
 *      criticalDifference, evidence payload, and byte-level JSON equality.
 *   2. Equal-loop-iteration guarantees: no pair pair-order or row-order drift.
 *   3. Determinism: re-scoring with a fresh cache yields identical output.
 *   4. The prefilter floor (survivesPersistenceFloor) agrees on every pair —
 *      the fast path can never persist a different candidate set.
 *   5. Per-kernel equivalence spot checks (dice/cosine/technical) on
 *      crafted inputs incl. multiset tokens, mixed units, canonical facts,
 *      assembly variations.
 *
 * Runs against in-memory materials only — no database, no production data.
 */
import assert from 'node:assert/strict';
import { scorePair, generatePairs, type PairScore } from '../src/lib/matching/engine';
import { MatchingRunCache } from '../src/lib/matching/runtime';
import { diceFromTokens, diceFromUniqueTokens, compareTechnical, compareTechnicalPrepared } from '../src/lib/matching/compare';
import { cosineSimilarity, cosineFromNorms } from '../src/lib/matching/embedding';
import { survivesPersistenceFloor } from '../src/lib/matching/prefilter';
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

/** Deterministic PRNG (mulberry32) — same corpus every run. */
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

function attr(
  name: string,
  value: string,
  isCritical = false,
  unit: string | null = null,
  normalizedValue?: string
): MatchableMaterial['attributes'][number] {
  return { attributeName: name, value, normalizedValue: normalizedValue ?? value.toUpperCase(), unit, isCritical };
}

function mat(
  id: number,
  organizationId: number,
  originalCode: string,
  originalDescription: string,
  attributes: MatchableMaterial['attributes'],
  category: string
): MatchableMaterial {
  return {
    id,
    organizationId,
    orgCode: `ORG${organizationId}`,
    originalCode,
    originalDescription,
    normalizedDescription: originalDescription.toUpperCase(),
    category,
    manufacturer: 'SKF',
    model: null,
    partNumber: null,
    uom: 'EA',
    attributes,
  };
}

/**
 * Randomized corpus spanning all five categories with attribute shapes that
 * force every comparison path: exact, normalized, canonical-fact collapse,
 * CLOSE_MATCH (within/outside tolerance), unit-mismatch numeric, nominal
 * numeric (never close), MISSING (one-sided + both-sided), enum conflicts,
 * and assembly/kit wording variants. Descriptions vary in length so the
 * semantic/fuzzy/technical signal mix varies per pair.
 */
function corpus(): MatchableMaterial[] {
  const rnd = mulberry32(20260923);
  const mats: MatchableMaterial[] = [];
  let id = 1;

  const push = (
    org: number,
    desc: string,
    attrs: MatchableMaterial['attributes'],
    category: string
  ) => mats.push(mat(id++, org, `M-${id}`, desc, attrs, category));

  // Bearings: series variants (nominal numeric), seals (enum), bore (measured),
  // type facts with canonicalization variants, assembly wording variants.
  const seriesList = ['6205', '6205', '6310', '6206', '6205.4', '6205'];
  const sealList = ['2RS', '2RS', 'ZZ', '2RS1', '2RS'];
  const boreList = ['25', '25', '50', '30', '25.4', '25.2'];
  const typeList = ['Deep Groove', 'DEEP GROOVE BALL', 'Deep Groove Ball', 'TAPER ROLLER', 'Deep Groove', 'DEEP GROOVE'];
  const wording = ['SKF BALL BEARING {s}-{se} FOR PUMP', 'SKF DEEP GROOVE BRG {s} {se}', 'BALL BEARING {s}{se} SKF MAKE', 'SKF {s}-{se} DEEP GROOVE BALL BEARING'];
  for (let i = 0; i < 24; i++) {
    const s = seriesList[Math.floor(rnd() * seriesList.length)];
    const se = sealList[Math.floor(rnd() * sealList.length)];
    const bore = boreList[Math.floor(rnd() * boreList.length)];
    const ty = typeList[Math.floor(rnd() * typeList.length)];
    const w = wording[Math.floor(rnd() * wording.length)];
    const desc = w.replace('{s}', s).replace('{se}', se) + (i % 9 === 0 ? ' WITH NUT' : '');
    push((i % 5) + 1, desc, [
      attr('series', s, true),
      attr('seal_type', se, true),
      attr('bore_diameter', bore, true, 'mm'),
      attr('bearing_type', ty),
      // One-sided attribute on some rows → MISSING criticals for some pairs.
      ...(i % 5 === 0 ? [attr('internal_clearance', 'C3')] : []),
    ], 'Bearings');
  }

  // Valves: class canonicalization (150# vs Class 150), nominal size (nominal
  // numeric), body material (enum), unit-mismatch pressure (measured bar).
  for (let i = 0; i < 14; i++) {
    const cls = i % 2 === 0 ? `${i % 3 === 0 ? '150#' : 'Class 150'}` : 'Class 300';
    const dn = ['DN50', 'DN80', 'DN50'][i % 3];
    const mat2 = ['CS', 'SS304', 'CS'][i % 3];
    const desc = `GATE VALVE ${cls} ${dn} RF ${mat2}` + (i % 7 === 0 ? ' COMPLETE SET' : '');
    push((i % 5) + 1, desc, [
      attr('pressure_class', cls, true),
      attr('nominal_size', dn, true),
      attr('body_material', mat2, true),
      attr('pressure_rating', `${10 + (i % 4)} bar`, false, 'bar'),
      ...(i % 4 === 0 ? [attr('end_connection', 'FLANGED RF', true)] : []),
    ], 'Valves');
  }

  // Motors: measured values near/beyond tolerance, unit mismatches.
  for (let i = 0; i < 10; i++) {
    const kw = [11, 11, 15, 11.5, 11][i % 5];
    const kv = [415, 415, 400, 230][i % 4];
    const hz = [50, 50, 60][i % 3];
    const desc = `INDUCTION MOTOR ${kw}KW ${kv}V ${hz}HZ 3PH TEFC`;
    push((i % 5) + 1, desc, [
      attr('power_rating', `${kw}`, true, 'kW'),
      attr('voltage_rating', `${kv}`, true, 'V'),
      attr('frequency', `${hz}`, true, 'Hz'),
      attr('motor_type', 'Induction', true),
      attr('phase', 'THREE_PHASE', true),
      ...(i % 6 === 0 ? [attr('speed', '1470', true, 'rpm')] : []),
    ], 'Motors');
  }

  // Pumps: nominal suction/discharge (never close), measured pressure.
  for (let i = 0; i < 8; i++) {
    const s = ['DN80', 'DN100'][i % 2];
    const d = ['DN80', 'DN65'][i % 2];
    const desc = `CENTRIFUGAL PUMP SUCTION ${s} DISCHARGE ${d} CI CASING`;
    push((i % 5) + 1, desc, [
      attr('pump_type', 'Centrifugal', true),
      attr('suction_size', s, true),
      attr('discharge_size', d, true),
      attr('casing_material', 'Cast Iron', true),
      attr('pressure_class', `${8 + (i % 3)} bar`, false, 'bar'),
    ], 'Pumps');
  }

  // Fasteners: thread (nominal), measured length with near values, assembly.
  for (let i = 0; i < 12; i++) {
    const th = ['M16', 'M20', 'M16'][i % 3];
    const len = [60, 60, 60.9, 80][i % 4];
    const grade = ['8.8', '8.8', 'SS304'][i % 3];
    const kit = i % 3 === 0 ? ' WITH WASHER' : i % 5 === 0 ? ' WITH NUT AND WASHER' : '';
    const desc = `HEX BOLT ${th}X${len} ${grade}${kit}`;
    push((i % 5) + 1, desc, [
      attr('fastener_type', 'Hex Bolt', true),
      attr('thread_specification', th, true),
      attr('diameter', '16', false, 'mm'),
      attr('length', `${len}`, true, 'mm'),
      attr('material_grade', grade, true),
    ], 'Fasteners');
  }

  // Long-description noise rows: force pairs with low signals (potential drops)
  // so the floor agreement is exercised against sub-floor cores too.
  const noise = [
    'HYDRAULIC POWER PACK UNIT WITH COOLING CIRCUIT AND FILTER ARRANGEMENT FOR STEAM TURBINE LUBE OIL SYSTEM SUPPLY',
    'CENTRIFUGAL BLOWER ASSEMBLY COMPLETE WITH SILENCER AND FLEXIBLE CONNECTION FOR AIR PREHEATER SECONDARY AIR DUCT',
    'HIGH PRESSURE ROTARY SCREW COMPRESSOR PACKAGE WITH AIR DRYER AND RECEIVER TANK FOR INSTRUMENT AIR DISTRIBUTION',
    'VERTICAL TURBINE FIRE WATER PUMP SET COMPLETE WITH DIESEL ENGINE DRIVER AND CONTROL PANEL FOR FIRE FIGHTING',
  ];
  for (let i = 0; i < 6; i++) {
    push((i % 5) + 1, noise[i % noise.length], [attr('size', noise[i % noise.length].slice(0, 30))], 'Motors');
  }

  return mats;
}

function assertPairScoreEqual(x: PairScore, y: PairScore, label: string): void {
  assert.equal(y.semanticScore, x.semanticScore, `${label}: semanticScore`);
  assert.equal(y.fuzzyScore, x.fuzzyScore, `${label}: fuzzyScore`);
  assert.equal(y.technicalScore, x.technicalScore, `${label}: technicalScore`);
  assert.equal(y.categoryCompatible, x.categoryCompatible, `${label}: categoryCompatible`);
  assert.equal(y.finalScore, x.finalScore, `${label}: finalScore`);
  assert.equal(y.matchType, x.matchType, `${label}: matchType`);
  assert.equal(y.decision, x.decision, `${label}: decision`);
  assert.equal(y.confidenceBand, x.confidenceBand, `${label}: confidenceBand`);
  assert.equal(y.explanation, x.explanation, `${label}: explanation`);
  assert.equal(y.criticalDifference, x.criticalDifference, `${label}: criticalDifference`);
  assert.deepEqual(y.evidence, x.evidence, `${label}: evidence`);
  assert.equal(JSON.stringify(y), JSON.stringify(x), `${label}: full JSON equality`);
}

function main(): void {
  const materials = corpus();

  test('kernel equivalence: unique-set Dice ≡ multiset Dice (incl. repeated tokens, mixed lengths)', () => {
    const cases: Array<[string[], string[]]> = [
      [['A', 'B', 'C'], ['A', 'B', 'C']],
      [['A', 'A', 'B'], ['A', 'B', 'B']],
      [['CLASS', '300'], ['CLASS_300']],
      [['BRG', '6205', '2RS'], ['BEARING', '6205', '2RS', 'SKF']],
      [[], ['A']],
      [['A'], []],
      [['X', 'X', 'X'], ['X']],
    ];
    for (const [ta, tb] of cases) {
      const ua = new Set(ta);
      const ub = new Set(tb);
      assert.equal(
        diceFromUniqueTokens(ua, ub, ta.length, tb.length),
        diceFromTokens(ta, tb),
        `dice mismatch for [${ta}] vs [${tb}]`
      );
    }
  });

  test('kernel equivalence: cosineFromNorms ≡ cosineSimilarity (bitwise) on provider vectors', () => {
    const rnd = mulberry32(42);
    for (let trial = 0; trial < 200; trial++) {
      const dim = 256;
      const a: number[] = [];
      const b: number[] = [];
      for (let i = 0; i < dim; i++) a.push(rnd() < 0.8 ? 0 : rnd());
      for (let i = 0; i < dim; i++) b.push(rnd() < 0.8 ? 0 : rnd());
      let na = 0;
      let nb = 0;
      for (let i = 0; i < dim; i++) {
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      const normA = Math.sqrt(na);
      const normB = Math.sqrt(nb);
      assert.equal(
        cosineFromNorms(a, b, normA, normB, a.length === b.length),
        cosineSimilarity(a, b),
        `cosine mismatch trial ${trial}`
      );
      // Zero-vector edge must stay 0 in both.
    }
    assert.equal(cosineFromNorms([0, 0], [1, 1], 0, Math.SQRT2, true), cosineSimilarity([0, 0], [1, 1]));
  });

  test('kernel equivalence: compareTechnicalPrepared ≡ compareTechnical (deep) on every fixture pair', () => {
    const cache = new MatchingRunCache();
    for (const m of materials) cache.representation(m);
    let n = 0;
    for (let i = 0; i < materials.length; i++) {
      for (let j = i + 1; j < materials.length; j++) {
        const a = materials[i];
        const b = materials[j];
        const ra = cache.representation(a);
        const rb = cache.representation(b);
        const ref = compareTechnical(a, b, ra.attributeIndex, rb.attributeIndex);
        const prep = compareTechnicalPrepared(a, b, ra.prepared, rb.prepared);
        assert.deepEqual(prep, ref, `${a.originalCode}↔${b.originalCode}: technical deep equality`);
        n++;
      }
    }
    assert.ok(n > 500, `expected >500 pairs, got ${n}`);
  });

  test('EXHAUSTIVE parity: cached PairScore is byte-identical to the uncached reference for EVERY retrieval pair', () => {
    const pairs = generatePairs(materials);
    assert.ok(pairs.length > 400, `expected a substantial pair count, got ${pairs.length}`);
    const cache = new MatchingRunCache();
    let compared = 0;
    for (const [a, b] of pairs) {
      const ref = scorePair(a, b); // uncached = semantic reference
      const opt = scorePair(a, b, cache);
      assertPairScoreEqual(ref, opt, `${a.originalCode}↔${b.originalCode}`);
      compared++;
    }
    assert.equal(compared, pairs.length);
  });

  test('ordering + determinism: fresh cache reproduces the identical pair stream and results', () => {
    const pairs = generatePairs(materials);
    const c1 = new MatchingRunCache();
    const c2 = new MatchingRunCache();
    for (let i = 0; i < pairs.length; i++) {
      const [a, b] = pairs[i];
      const r1 = scorePair(a, b, c1);
      const r2 = scorePair(a, b, c2);
      assert.equal(JSON.stringify(r2), JSON.stringify(r1), `pair ${i} cross-cache`);
    }
    assert.equal(c1.counters.representationsBuilt, c2.counters.representationsBuilt);
  });

  test('persistence-floor agreement: survivesPersistenceFloor(core) identical both paths for every pair', () => {
    const pairs = generatePairs(materials);
    const cache = new MatchingRunCache();
    let kept = 0;
    for (const [a, b] of pairs) {
      const ref = scorePair(a, b); // uncached reference (decision/final are the floor's only inputs)
      const opt = scorePair(a, b, cache);
      assert.equal(
        survivesPersistenceFloor({ final: opt.finalScore, decision: { state: opt.decision } }),
        survivesPersistenceFloor({ final: ref.finalScore, decision: { state: ref.decision } }),
        `floor disagreement ${a.originalCode}↔${b.originalCode}`
      );
      if (survivesPersistenceFloor({ final: opt.finalScore, decision: { state: opt.decision } })) kept++;
    }
    assert.ok(kept > 0);
  });

  test('once-per-material: prepared facts built exactly once per material; re-scoring builds nothing', () => {
    const cache = new MatchingRunCache();
    const pairs = generatePairs(materials);
    for (const [a, b] of pairs) scorePair(a, b, cache);
    const participants = new Set<number>();
    for (const [a, b] of pairs) {
      participants.add(a.id);
      participants.add(b.id);
    }
    assert.equal(cache.counters.representationsBuilt, participants.size);
    for (const [a, b] of pairs) scorePair(a, b, cache);
    assert.equal(cache.counters.representationsBuilt, participants.size, 're-scoring must build nothing');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAILURE: ${f}`);
    process.exit(1);
  }
}

main();
