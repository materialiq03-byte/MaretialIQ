/**
 * Inverted-index retrieval tests (Step 3) — `npx tsx tests/retrieval.test.ts`.
 *
 * The inverted index must produce EXACTLY the candidate pairs the preserved
 * quadratic reference produces — same pairs, same orientation, same order,
 * no extras, no omissions — for any material set. Uses in-memory materials
 * only (retrieval is pure); the real data/materialiq.db is untouched.
 */
import assert from 'node:assert/strict';
import {
  BlockingRetrieval,
  findCandidatesQuadratic,
  type CandidatePair,
  type RetrievalStats,
} from '../src/lib/matching/retrieval';
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

function mat(
  id: number,
  organizationId: number,
  originalCode: string,
  description: string,
  category = 'Bearings'
): MatchableMaterial {
  return {
    id,
    organizationId,
    orgCode: `ORG${organizationId}`,
    originalCode,
    originalDescription: description,
    normalizedDescription: description.toUpperCase(),
    category,
    manufacturer: null,
    model: null,
    partNumber: null,
    uom: 'EA',
    attributes: [],
  };
}

function pairKey(p: CandidatePair): string {
  const [x, y] = p.a.id < p.b.id ? [p.a.id, p.b.id] : [p.b.id, p.a.id];
  return `${x}:${y}`;
}

function assertPairSetsEqual(oldPairs: CandidatePair[], newPairs: CandidatePair[], label: string): void {
  const oldSet = new Map(oldPairs.map((p) => [pairKey(p), p]));
  const newSet = new Map(newPairs.map((p) => [pairKey(p), p]));
  const missing = [...oldSet.keys()].filter((k) => !newSet.has(k));
  const extra = [...newSet.keys()].filter((k) => !oldSet.has(k));
  assert.deepEqual(extra, [], `${label}: new-only pairs`);
  assert.deepEqual(missing, [], `${label}: old-only pairs`);
  assert.equal(newPairs.length, oldPairs.length, `${label}: pair count`);
  // Exact sequence equality (orientation + order observable by callers).
  assert.equal(
    JSON.stringify(newPairs.map((p) => [p.a.id, p.b.id])),
    JSON.stringify(oldPairs.map((p) => [p.a.id, p.b.id])),
    `${label}: ordered pair sequence`
  );
}

function fixture(): MatchableMaterial[] {
  const materials: MatchableMaterial[] = [];
  const orgs = [1, 2, 3, 4, 5];
  // Bearings: rich token overlap (BEARING/6205/2RS/ZZ/DEEP/GROOVE).
  for (let i = 0; i < 25; i++) {
    materials.push(
      mat(i + 1, orgs[i % 5], `B-${i}`, `SKF BALL BEARING 6205-${i % 2 === 0 ? '2RS' : 'ZZ'} DEEP GROOVE PUMP`)
    );
  }
  // Valves: CL 150 / CL 300 families.
  for (let i = 0; i < 10; i++) {
    materials.push(mat(100 + i, orgs[i % 5], `V-${i}`, `GATE VALVE CL ${i % 2 === 0 ? 150 : 300} RF`, 'Valves'));
  }
  // Fasteners: assembly vocabulary.
  materials.push(mat(200, 1, 'F-1', 'HEX BOLT M20X80 SS304 WITH NUT', 'Fasteners'));
  materials.push(mat(201, 2, 'F-2', 'HEX BOLT M20X80 SS304', 'Fasteners'));
  // Edge cases: empty token set, single-token material, duplicate tokens.
  materials.push(mat(300, 1, 'E-1', ''));
  materials.push(mat(301, 2, 'E-2', '--'));
  materials.push(mat(302, 3, 'S-1', 'BEARING'));
  materials.push(mat(303, 4, 'S-2', 'BEARING BEARING BEARING'));
  materials.push(mat(304, 5, 'S-3', 'BEARING'));
  return materials;
}

function main(): void {
  const strategy = new BlockingRetrieval();
  const materials = fixture();

  test('old and new retrieval produce identical ordered pair sets', () => {
    assertPairSetsEqual(findCandidatesQuadratic(materials), strategy.findCandidates(materials), 'fixture');
  });

  test('old and new retrieval are identical with the run cache supplied', () => {
    const cache = new MatchingRunCache();
    assertPairSetsEqual(
      findCandidatesQuadratic(materials, cache),
      strategy.findCandidates(materials, cache),
      'fixture+cache'
    );
  });

  test('pairs sharing many tokens appear exactly once (dedup)', () => {
    const pairs = strategy.findCandidates(materials);
    const keys = pairs.map(pairKey);
    assert.equal(new Set(keys).size, keys.length);
    // The 6205/2RS cluster shares BEARING, BALL, SKF, 6205, DEEP, GROOVE, PUMP.
    // (ids 1 and 2 sit in different orgs under the mod-5 org pattern.)
    const dense = pairs.filter((p) => p.a.id === 1 && p.b.id === 2);
    assert.equal(dense.length, 1);
  });

  test('single shared token qualifies (threshold=1), zero shared tokens never qualify', () => {
    const pairs = strategy.findCandidates(materials);
    // S-1/S-2/S-4 share exactly the single token BEARING (cross-org) → candidates.
    const s12 = pairs.find((p) => (p.a.id === 302 && p.b.id === 303) || (p.a.id === 303 && p.b.id === 302));
    assert.ok(s12, 'single-shared-token pair (302,303) must be a candidate');
    // Empty-token materials never appear.
    assert.ok(!pairs.some((p) => [300, 301].includes(p.a.id) || [300, 301].includes(p.b.id)));
  });

  test('same-organization pairs are excluded', () => {
    const pairs = strategy.findCandidates(materials);
    for (const p of pairs) {
      assert.notEqual(p.a.organizationId, p.b.organizationId, `pair ${pairKey(p)} same org`);
    }
  });

  test('zero cross-category candidates', () => {
    const pairs = strategy.findCandidates(materials);
    for (const p of pairs) {
      assert.equal(p.a.category, p.b.category, `pair ${pairKey(p)} cross-category`);
    }
  });

  test('stats: postings, accumulator size, same-org discards, zero cross-category', () => {
    const stats: RetrievalStats = {
      materialsIndexed: 0, tokenPostings: 0, pairKeysBeforeThreshold: 0, candidatePairsEmitted: 0,
      sameOrganizationDiscarded: 0, crossCategoryPairs: 99, pairwiseChecks: 0,
    };
    const pairs = strategy.findCandidates(materials, undefined, stats);
    assert.equal(stats.materialsIndexed, materials.length);
    assert.equal(stats.candidatePairsEmitted, pairs.length);
    assert.equal(stats.crossCategoryPairs, 0);
    assert.ok(stats.tokenPostings > 0);
    assert.ok(stats.pairKeysBeforeThreshold >= pairs.length);
    assert.ok(stats.sameOrganizationDiscarded >= 0);
  });

  test('deterministic output across repeated calls', () => {
    const a = strategy.findCandidates(materials).map((p) => [p.a.id, p.b.id]);
    const b = strategy.findCandidates(materials).map((p) => [p.a.id, p.b.id]);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test('edge: empty catalogue and single material', () => {
    assert.deepEqual(strategy.findCandidates([]), []);
    assert.deepEqual(strategy.findCandidates([materials[0]]), []);
    assert.deepEqual(findCandidatesQuadratic([]), []);
    assert.deepEqual(findCandidatesQuadratic([materials[0]]), []);
  });

  test('edge: same-org single-category cluster produces nothing', () => {
    const cluster = [
      mat(1, 9, 'X-1', 'BEARING 6205 2RS'),
      mat(2, 9, 'X-2', 'BEARING 6205 2RS'),
      mat(3, 9, 'X-3', 'BEARING 6205 2RS'),
    ];
    assert.deepEqual(strategy.findCandidates(cluster), []);
    assertPairSetsEqual(findCandidatesQuadratic(cluster), strategy.findCandidates(cluster), 'same-org cluster');
  });

  test('repeated tokens inside one description do not inflate shared counts', () => {
    const pair = [mat(1, 1, 'R-1', 'BEARING BEARING 6205'), mat(2, 2, 'R-2', 'BEARING 6205')];
    // BEARING + 6205 shared → 2 shared tokens; a multiset count would say 3.
    const oldPairs = findCandidatesQuadratic(pair);
    const newPairs = strategy.findCandidates(pair);
    assert.equal(oldPairs.length, 1);
    assertPairSetsEqual(oldPairs, newPairs, 'repeat-tokens');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAILURE: ${f}`);
    process.exit(1);
  }
}

main();
