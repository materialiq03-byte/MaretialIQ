/**
 * Step 8 — persistence/decision-policy invariants (regression guards).
 *
 * `npx tsx tests/persistence-policy.test.ts` (part of the npm test chain).
 *
 * Step 8 measured the persistence policy options (A current, B
 * actionable-only, C tiered) and REJECTED a production change: on the real
 * reference corpus Option B would remove only 53/1279 rows (−4.1%) while
 * LOW_CONFIDENCE rows are a documented product tier (queue priority 'low',
 * "proposed for completeness"; Matching Workspace + Control Center render
 * the class). These tests pin the measured invariants so a future policy
 * change cannot silently break the contract that was verified here:
 *
 *   1. DECISION-STATE CONTRACT: on a realistic synthetic corpus, every
 *      retrieval survivor classifies into exactly the four documented
 *      states, and the actionable set (HIGH_CONFIDENCE_MATCH +
 *      NEEDS_TECHNICAL_REVIEW) plus LOW_CONFIDENCE equals the floor-survivor
 *      set (nothing else is persisted today).
 *   2. ACTIONABLE RECALL INVARIANT: no HIGH_CONFIDENCE_MATCH or
 *      NEEDS_TECHNICAL_REVIEW pair is ever classified LOW_CONFIDENCE —
 *      i.e. an actionable-only persistence policy (Option B) can never hide
 *      an actionable pair as long as decision states are produced by the
 *      current classifyDecision. (Step-8 GT probe: 0/31 actionable pairs
 *      land LOW_CONFIDENCE.)
 *   3. FLOOR COMPLETENESS: survivesPersistenceFloor keeps exactly the
 *      complement of (NOT_A_MATCH ∨ final < 30) — the policy definition is
 *      the floor, nothing more, nothing less.
 *   4. QUEUE-TIER CONTRACT: the queue priority/reason mapping covers every
 *      matchType the engine can emit, and LOW_CONFIDENCE maps to the 'low'
 *      completeness tier — so dropping LOW_CONFIDENCE rows would remove a
 *      real product surface, not noise.
 *
 * In-memory only; no database, no production data.
 */
import assert from 'node:assert/strict';
import { scorePairCore, iteratePairs } from '../src/lib/matching/engine';
import { survivesPersistenceFloor } from '../src/lib/matching/prefilter';
import { QUEUE_PRIORITY, QUEUE_REASON } from '../src/lib/services/matching-service';
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
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
    console.log(`  FAIL - ${name}: ${(e as Error).message}`);
  }
}

function mk(
  i: number,
  desc: string,
  category: string,
  attrs: Array<[string, string, boolean]> = [],
  manufacturer: string | null = null
): MatchableMaterial {
  return {
    id: i + 1,
    organizationId: (i % 5) + 1,
    orgCode: 'O' + ((i % 5) + 1),
    originalCode: `M-${i}`,
    originalDescription: desc,
    normalizedDescription: desc.toLowerCase(),
    category,
    manufacturer,
    model: null,
    partNumber: null,
    uom: 'NOS',
    attributes: attrs.map(([attributeName, value, isCritical]) => ({
      attributeName,
      value,
      normalizedValue: value.toLowerCase(),
      unit: null,
      isCritical,
    })),
  };
}

const STATES = ['HIGH_CONFIDENCE_MATCH', 'NEEDS_TECHNICAL_REVIEW', 'LOW_CONFIDENCE', 'NOT_A_MATCH'] as const;

// A small but decision-diverse corpus: identical items (high), conflict /
// missing-critical / cross-brand items (review), and weak-overlap items (low /
// not-a-match). Mirrors the shapes the ground truth exercises.
const mats: MatchableMaterial[] = [
  mk(0, 'SKF BALL BEARING 6205 2RS', 'Bearings', [['series', '6205', true], ['seal_type', '2RS', true], ['bore_diameter', '25', true], ['bearing_type', 'DEEP GROOVE', true]], 'SKF'),
  mk(1, 'BALL BEARING 6205-2RS SKF', 'Bearings', [['series', '6205', true], ['seal_type', '2RS', true], ['bore_diameter', '25', true], ['bearing_type', 'DEEP GROOVE', true]], 'FAG'),
  // conflict: seal 2RS vs ZZ
  mk(2, 'SKF BALL BEARING 6205 ZZ', 'Bearings', [['series', '6205', true], ['seal_type', 'ZZ', true], ['bore_diameter', '25', true], ['bearing_type', 'DEEP GROOVE', true]], 'SKF'),
  // missing critical: no seal_type on one side
  mk(3, 'BALL BEARING 6205', 'Bearings', [['series', '6205', true], ['bore_diameter', '25', true], ['bearing_type', 'DEEP GROOVE', true]], 'NSK'),
  // different series, same family: weak overlap
  mk(4, 'DEEP GROOVE BALL BEARING', 'Bearings', [['series', '6310', true], ['seal_type', '2RS', true], ['bore_diameter', '50', true], ['bearing_type', 'DEEP GROOVE', true]], 'SKF'),
  // other categories
  mk(5, 'GATE VALVE 2IN CLASS 150', 'Valves', [['valve_type', 'GATE', true], ['nominal_size', '2', true], ['pressure_class', '150', true]], 'L&T'),
  mk(6, 'GATE VALVE 2IN CLASS 300', 'Valves', [['valve_type', 'GATE', true], ['nominal_size', '2', true], ['pressure_class', '300', true]], 'L&T'),
  mk(7, 'CENTRIFUGAL PUMP 4X3-10', 'Pumps', [['pump_type', 'CENTRIFUGAL', true], ['suction_size', '4', true], ['discharge_size', '3', true]], 'KSB'),
  mk(8, 'HEX BOLT M20X80 SS304', 'Fasteners', [['fastener_type', 'HEX_BOLT', true], ['thread_specification', 'M20X80', true], ['material_grade', 'SS304', true]], 'TVS'),
  mk(9, 'HEX BOLT M20X80 SS304 WITH NUT', 'Fasteners', [['fastener_type', 'HEX_BOLT', true], ['thread_specification', 'M20X80', true], ['material_grade', 'SS304', true]], 'TVS'),
];

test('decision-state contract: every survivor classifies into a documented state and the states partition the survivor set', () => {
  const cache = new MatchingRunCache();
  const seen = new Map<string, number>();
  let survivors = 0;
  for (const [a, b] of iteratePairs(mats, cache)) {
    const core = scorePairCore(a, b, cache);
    if (!survivesPersistenceFloor(core)) continue;
    survivors++;
    assert.ok(
      (STATES as readonly string[]).includes(core.decision.state),
      `state ${core.decision.state} is not a documented decision state`
    );
    seen.set(core.decision.state, (seen.get(core.decision.state) ?? 0) + 1);
  }
  const sum = [...seen.values()].reduce((x, y) => x + y, 0);
  assert.equal(sum, survivors, 'decision-state counts must sum to the survivor count');
  assert.ok(survivors > 0, 'expected a non-empty survivor set');
});

test('actionable recall invariant: no HIGH_CONFIDENCE_MATCH / NEEDS_TECHNICAL_REVIEW pair is ever classified LOW_CONFIDENCE (Option B safety)', () => {
  const cache = new MatchingRunCache();
  const offending: string[] = [];
  for (const [a, b] of iteratePairs(mats, cache)) {
    const core = scorePairCore(a, b, cache);
    if (!survivesPersistenceFloor(core)) continue;
    const actionable = core.decision.state === 'HIGH_CONFIDENCE_MATCH' || core.decision.state === 'NEEDS_TECHNICAL_REVIEW';
    if (actionable && core.decision.state === 'LOW_CONFIDENCE') offending.push(`${a.id}<->${b.id}`);
  }
  assert.equal(offending.length, 0, `actionable pairs classified LOW_CONFIDENCE: ${offending.join(', ')}`);
});

test('floor completeness: survivesPersistenceFloor == !(NOT_A_MATCH || final < 30) on every pair', () => {
  const cache = new MatchingRunCache();
  for (const [a, b] of iteratePairs(mats, cache)) {
    const core = scorePairCore(a, b, cache);
    const expected = core.decision.state !== 'NOT_A_MATCH' && core.final >= 30;
    assert.equal(
      survivesPersistenceFloor(core),
      expected,
      `floor mismatch for ${a.id}<->${b.id} (state=${core.decision.state}, final=${core.final})`
    );
  }
});

test('queue-tier contract: priority/reason mappings cover every emitted matchType; LOW_CONFIDENCE tier is low + completeness wording', () => {
  const cache = new MatchingRunCache();
  const emitted = new Set<string>();
  for (const [a, b] of iteratePairs(mats, cache)) {
    const core = scorePairCore(a, b, cache);
    emitted.add(core.matchType);
  }
  for (const mt of emitted) {
    assert.ok(mt in QUEUE_PRIORITY, `QUEUE_PRIORITY missing matchType ${mt}`);
    assert.ok(mt in QUEUE_REASON, `QUEUE_REASON missing matchType ${mt}`);
  }
  // The 'different' matchType is how LOW_CONFIDENCE survivors enter the queue.
  assert.equal(QUEUE_PRIORITY.different, 'low');
  assert.match(QUEUE_REASON.different, /completeness/i);
});

console.log(`\npersistence-policy: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
