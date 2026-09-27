/**
 * Runtime-cache equivalence tests (Step 2 scale hardening) —
 * `npx tsx tests/runtime-cache.test.ts`.
 *
 * The cache must NEVER change a result. These tests compare the uncached
 * scoring path against the cached path over EVERY retrieval pair of a
 * fixture catalogue, asserting full PairScore equality (scores, decision,
 * explanation, evidence payload) — not just the final decision. They also
 * assert the once-per-material computation counts and that caches never
 * leak across runs.
 *
 * Runs against in-memory materials (scorePair/generatePairs are pure) —
 * the real data/materialiq.db is untouched.
 */
import assert from 'node:assert/strict';
import { scorePair, generatePairs, type PairScore } from '../src/lib/matching/engine';
import { MatchingRunCache } from '../src/lib/matching/runtime';
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
function mat(
  id: number,
  organizationId: number,
  originalCode: string,
  originalDescription: string,
  attributes: MatchableMaterial['attributes'] = [],
  category = 'Bearings'
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

function attr(name: string, value: string, isCritical = false): MatchableMaterial['attributes'][number] {
  return { attributeName: name, value, normalizedValue: value.toUpperCase(), unit: null, isCritical };
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
  // Full evidence payload (attribute comparisons, conflicts, assembly,
  // decision reason, weights, contributions) — structural deep equality.
  assert.deepEqual(y.evidence, x.evidence, `${label}: evidence`);
  // And byte-level equality of the whole result object.
  assert.equal(JSON.stringify(y), JSON.stringify(x), `${label}: full JSON equality`);
}

function fixtureMaterials(): MatchableMaterial[] {
  const materials: MatchableMaterial[] = [];
  // 5 organizations × mixed categories, with attribute sets that trigger
  // agreement, CLOSE, CONFLICT, MISSING, and assembly-variation paths.
  const orgs = [1, 2, 3, 4, 5];
  const series = ['6205', '6205', '6305', '6210', '6205'];
  const seals = ['2RS', '2RS', 'ZZ', '2RS', 'ZZ'];
  for (let i = 0; i < 40; i++) {
    const org = orgs[i % 5];
    const s = series[i % 5];
    const seal = seals[i % 5];
    materials.push(
      mat(
        i + 1,
        org,
        `C-${1000 + i}`,
        `SKF BALL BEARING ${s}-${seal} FOR PUMP`,
        [
          attr('series', s, true),
          attr('seal_type', seal, true),
          attr('bore_diameter', '25', true),
          attr('bearing_type', 'Deep Groove'),
          // Assembly variation on some materials (WITH NUT analog for bolts).
          ...(i % 7 === 0 ? [] : []),
        ],
        'Bearings'
      )
    );
  }
  for (let i = 0; i < 20; i++) {
    const org = orgs[i % 5];
    materials.push(
      mat(
        100 + i + 1,
        org,
        `V-${2000 + i}`,
        `GATE VALVE CL ${i % 2 === 0 ? 150 : 300} RF CS`,
        [attr('pressure_class', `Class ${i % 2 === 0 ? 150 : 300}`, true), attr('nominal_size', 'DN50', true)],
        'Valves'
      )
    );
  }
  // Fasteners with WITH NUT / standalone variants (assembly detection path).
  materials.push(mat(200, 1, 'F-5001', 'HEX BOLT M20X80 SS304 WITH NUT', [attr('thread_specification', 'M20', true)], 'Fasteners'));
  materials.push(mat(201, 2, 'F-5002', 'HEX BOLT M20X80 SS304', [attr('thread_specification', 'M20', true)], 'Fasteners'));
  materials.push(mat(202, 2, 'F-5003', 'HEX BOLT M20X80 SS304 WITH NUT', [attr('thread_specification', 'M20', true)], 'Fasteners'));
  return materials;
}

function main(): void {
  const materials = fixtureMaterials();
  const pairs = generatePairs(materials);
  assert.ok(pairs.length > 50, `expected a substantial retrieval pair count, got ${pairs.length}`);

  test('cached scoring is byte-identical to uncached scoring for EVERY retrieval pair', () => {
    const cache = new MatchingRunCache();
    let compared = 0;
    for (const [a, b] of pairs) {
      const uncached = scorePair(a, b);
      const cached = scorePair(a, b, cache);
      assertPairScoreEqual(uncached, cached, `${a.originalCode}↔${b.originalCode}`);
      compared++;
    }
    assert.ok(compared === pairs.length);
  });

  test('representations are built once per participating material per run', () => {
    const cache = new MatchingRunCache();
    for (const [a, b] of pairs) scorePair(a, b, cache);
    const participants = new Set<number>();
    for (const [a, b] of pairs) {
      participants.add(a.id);
      participants.add(b.id);
    }
    assert.equal(cache.size, participants.size);
    assert.equal(cache.counters.representationsBuilt, participants.size);
    assert.equal(cache.counters.embeddingsBuilt, participants.size);
    assert.equal(cache.counters.fuzzyTokenizations, participants.size);
    assert.equal(cache.counters.retrievalTokenSets, participants.size);
    // Re-scoring the same pairs must build nothing further.
    for (const [a, b] of pairs) scorePair(a, b, cache);
    assert.equal(cache.counters.representationsBuilt, participants.size);
  });

  test('separate runs get separate caches — no stale cross-run data', () => {
    const cache1 = new MatchingRunCache();
    const cache2 = new MatchingRunCache();
    for (const [a, b] of pairs) scorePair(a, b, cache1);
    assert.equal(cache2.size, 0);
    const firstPair = pairs[0];
    const cached1 = scorePair(firstPair[0], firstPair[1], cache1);
    const cached2 = scorePair(firstPair[0], firstPair[1], cache2);
    assertPairScoreEqual(cached1, cached2, 'cross-cache equality');
    // cache2 built only what the single pair needed; cache1 had the full run.
    assert.equal(cache2.counters.representationsBuilt, 2);
  });

  test('cache reflects the material state of ITS run (no stale reuse after state change)', () => {
    const [a0] = pairs[0];
    // Copy of the material with a different description = different state.
    const altered = { ...a0, originalDescription: 'COMPLETELY DIFFERENT WIDGET', normalizedDescription: 'COMPLETELY DIFFERENT WIDGET' };
    const cache = new MatchingRunCache();
    const before = scorePair(a0, pairs[0][1], cache);
    // Same run, same objects: cached representation reused.
    const again = scorePair(a0, pairs[0][1], cache);
    assertPairScoreEqual(before, again, 'same-run reuse');
    // A DIFFERENT run (fresh cache) must see the altered state, not reuse.
    const freshCache = new MatchingRunCache();
    const after = scorePair(altered, pairs[0][1], freshCache);
    assert.notEqual(after.fuzzyScore, before.fuzzyScore);
  });

  test('retrieval with a cache produces the identical pair list', () => {
    const cache = new MatchingRunCache();
    const withCache = generatePairs(materials, cache);
    assert.equal(withCache.length, pairs.length);
    for (let i = 0; i < pairs.length; i++) {
      assert.equal(withCache[i][0].id, pairs[i][0].id, `pair ${i} side A`);
      assert.equal(withCache[i][1].id, pairs[i][1].id, `pair ${i} side B`);
    }
    // Retrieval consumed the same per-material token sets: one per material.
    assert.equal(cache.counters.retrievalTokenSets, materials.length);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAILURE: ${f}`);
    process.exit(1);
  }
}

main();
