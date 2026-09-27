/**
 * Step 7 — shadow blocking + ground-truth safety gate.
 * `npx tsx tests/blocking-shadow.test.ts`
 *
 * Proves, on a disposable temp SQLite DB seeded from the REAL evaluation
 * fixtures (so the ground-truth materials and attributes are the live ones):
 *
 *   1. GT SAFETY GATE (Phase 5): the union of the shadow key families keeps
 *      18/18 MATCH and 13/13 NEEDS_REVIEW ground-truth pairs — zero false
 *      exclusions of actionable pairs at α = ∞ (the only safe setting).
 *   2. OR-UNION SEMANTICS: a pair sharing ANY one family key is emitted;
 *      pairs sharing keys in several families are emitted exactly once.
 *   3. DEDUPE + DETERMINISM: two runs produce identical pair streams;
 *      same-org pairs are suppressed; cross-category pairs never emitted.
 *   4. SUBSET-TOLERANCE: a material missing an attribute still pairs through
 *      other families (no missing-attribute split).
 *   5. α GATE EXPERIMENT DIAL: α=∞ emits a strict superset of the baseline
 *      token rule; α<1 is verified to lose baseline pairs (documented reason
 *      the gate is rejected and left off).
 *   6. PRODUCTION ISOLATION: the production strategy is untouched —
 *      iteratePairs still yields exactly the baseline token-rule pairs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { analyzeImport, executeImport } from '../src/lib/services/import-center-service';
import { loadGroundTruth, loadGroundTruthMaterials, resetGroundTruthCache } from '../src/lib/matching/ground-truth';
import { iterateShadowCandidates, blockingKeys, blockingAlpha } from '../src/lib/matching/blocking-shadow';
import { distinctiveTokens } from '../src/lib/matching/retrieval';
import { iteratePairs } from '../src/lib/matching/engine';
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

/* ------------------- disposable DB seeded from evaluation fixtures ------------------- */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-blocking-'));
const testDb = new DatabaseSync(path.join(tmpDir, 'test.db'));
setDbForTests(testDb);
migrate(testDb);

const now = new Date().toISOString();
const orgIds = new Map<string, number>();
for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
  const res = testDb
    .prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
    .run(code, `${code} (blocking test)`, now, now);
  orgIds.set(code, Number(res.lastInsertRowid));
}
const FIXTURE_DIR = path.join(process.cwd(), 'data', 'evaluation', 'fixtures');
for (const orgCode of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
  const parsed = analyzeImport({
    organizationId: orgIds.get(orgCode)!,
    fileName: `${orgCode}.csv`,
    fileType: 'csv',
    payload: fs.readFileSync(path.join(FIXTURE_DIR, `${orgCode}.csv`), 'utf8'),
  });
  if (!parsed.mappingUsable) throw new Error(`mapping unusable for ${orgCode}`);
  executeImport({ importId: parsed.importId, includeWarnings: true, duplicateStrategy: 'skip', actor: 'blocking-tests' });
}

const ds = loadGroundTruth();
resetGroundTruthCache();
const { materials } = loadGroundTruthMaterials(ds);
const allMaterials = materials;
const gtMats = [...materials.values()] as MatchableMaterial[];

function mat(id: number, organizationId: number, code: string, description: string, category = 'Bearings', attributes: MatchableMaterial['attributes'] = [], partNumber: string | null = null): MatchableMaterial {
  return {
    id, organizationId, orgCode: 'O' + organizationId, originalCode: code,
    originalDescription: description, normalizedDescription: description.toLowerCase(),
    category, manufacturer: null, model: null, partNumber, uom: 'NOS', attributes,
  };
}

/* ------------------------------ 1. GT safety gate ------------------------------ */

test('GT safety gate: shadow union keeps 18/18 MATCH and 13/13 NEEDS_REVIEW pairs', () => {
  let match = 0;
  let review = 0;
  const lost: string[] = [];
  for (const p of ds.pairs) {
    if (p.ground_truth === 'NOT_A_MATCH') continue;
    const A = allMaterials.get(p.a);
    const B = allMaterials.get(p.b);
    if (!A || !B) throw new Error(`material missing for ${p.a} / ${p.b}`);
    if (A.category.trim().toLowerCase() !== B.category.trim().toLowerCase()) continue;
    const ka = new Set(blockingKeys(A));
    const kb = new Set(blockingKeys(B));
    const shared = [...ka].some((k) => kb.has(k));
    if (p.ground_truth === 'MATCH') {
      if (shared) match++;
      else lost.push(`${p.a}<->${p.b}`);
    } else {
      if (shared) review++;
      else lost.push(`${p.a}<->${p.b}`);
    }
  }
  assert.equal(match, 18, `MATCH recall must be 18/18; lost: ${lost.join(', ')}`);
  assert.equal(review, 13, `NEEDS_REVIEW recall must be 13/13; lost: ${lost.join(', ')}`);
  assert.equal(lost.length, 0, 'zero false exclusions');
});

test('blockingAlpha defaults to Infinity (gate off) and parses numeric overrides', () => {
  assert.equal(blockingAlpha(), Number.POSITIVE_INFINITY);
  const prev = process.env.BLOCKING_ALPHA;
  process.env.BLOCKING_ALPHA = '0.2';
  assert.equal(blockingAlpha(), 0.2);
  process.env.BLOCKING_ALPHA = 'inf';
  assert.equal(blockingAlpha(), Number.POSITIVE_INFINITY);
  process.env.BLOCKING_ALPHA = 'bogus';
  assert.equal(blockingAlpha(), Number.POSITIVE_INFINITY);
  if (prev === undefined) delete process.env.BLOCKING_ALPHA;
  else process.env.BLOCKING_ALPHA = prev;
});

/* ------------------------------ 2. OR-union semantics ------------------------------ */

const ORG1 = 1;
const ORG2 = 2;

test('OR-union: pair sharing only an attribute key (no shared token) is emitted', () => {
  // Different series and different descriptions — no shared distinctive token —
  // but the same manufacturer attribute value.
  const a = mat(1, ORG1, 'A1', 'HEAVY DUTY GATE VALVE 3IN', 'Valves', [
    { attributeName: 'manufacturer', value: 'AUDCO', normalizedValue: 'AUDCO', unit: null, isCritical: false },
    { attributeName: 'valve_type', value: 'GATE', normalizedValue: 'GATE', unit: null, isCritical: true },
  ]);
  const b = mat(2, ORG2, 'B1', 'GATE VALVE 150# WCB SPARE', 'Valves', [
    { attributeName: 'manufacturer', value: 'audco', normalizedValue: 'audco', unit: null, isCritical: false },
    { attributeName: 'valve_type', value: 'GATE', normalizedValue: 'GATE', unit: null, isCritical: true },
  ]);
  const pairs = [...iterateShadowCandidates([a, b])];
  assert.equal(pairs.length, 1, `expected 1 pair, got ${pairs.length}`);
  assert.deepEqual([pairs[0].materialIdA, pairs[0].materialIdB], [1, 2]);
});

test('OR-union: cross-category pairs are never emitted', () => {
  const a = mat(1, ORG1, 'A1', 'BALL BEARING 6205 2RS');
  const b = mat(2, ORG2, 'B1', 'GATE VALVE 6205 2RS', 'Valves');
  const pairs = [...iterateShadowCandidates([a, b])];
  assert.equal(pairs.length, 0);
});

test('OR-union: same-organization pairs are suppressed', () => {
  const a = mat(1, ORG1, 'A1', 'BALL BEARING 6205 2RS');
  const b = mat(2, ORG1, 'B1', 'BALL BEARING 6205 2RS');
  const pairs = [...iterateShadowCandidates([a, b])];
  assert.equal(pairs.length, 0);
});

test('dedupe: a pair sharing keys in several families is emitted exactly once', () => {
  const attrs = (): MatchableMaterial['attributes'] => [
    { attributeName: 'series', value: '6205', normalizedValue: '6205', unit: null, isCritical: false },
    { attributeName: 'seal_type', value: '2RS', normalizedValue: '2RS', unit: null, isCritical: true },
    { attributeName: 'bearing_type', value: 'DEEP GROOVE BALL', normalizedValue: 'DEEP GROOVE BALL', unit: null, isCritical: false },
  ];
  const a = mat(1, ORG1, 'A1', 'BALL BEARING 6205 2RS', 'Bearings', attrs());
  const b = mat(2, ORG2, 'B1', 'BEARING 6205 2RS', 'Bearings', attrs());
  const pairs = [...iterateShadowCandidates([a, b])];
  assert.equal(pairs.length, 1, `shared token + series + seal + type keys must dedupe to 1, got ${pairs.length}`);
});

/* ------------------------------ 4. subset-tolerance ------------------------------ */

test('subset-tolerance: material missing an attribute still pairs through other keys', () => {
  // CP-6007-like case: only bearing_type + manufacturer, no series/bore/seal.
  const a = mat(1, ORG1, 'A1', 'SPHERICAL ROLLER BEARING 22216 E', 'Bearings', [
    { attributeName: 'bearing_type', value: 'SPHERICAL ROLLER', normalizedValue: 'SPHERICAL ROLLER', unit: null, isCritical: false },
    { attributeName: 'manufacturer', value: 'FAG', normalizedValue: 'FAG', unit: null, isCritical: false },
  ]);
  const b = mat(2, ORG2, 'B1', 'SPHERICAL ROLLER BRG 22216', 'Bearings', [
    { attributeName: 'bearing_type', value: 'SPHERICAL ROLLER', normalizedValue: 'SPHERICAL ROLLER', unit: null, isCritical: false },
  ]);
  const pairs = [...iterateShadowCandidates([a, b])];
  assert.equal(pairs.length, 1, 'missing series/bore/seal must not split the pair');
});

test('part-number family keys are generated but never trusted as a sole gate (measured 13/31)', () => {
  const a = mat(1, ORG1, 'A1', 'SKF BEARING', 'Bearings', [], '22216E');
  const b = mat(2, ORG2, 'B1', 'FAG BRG', 'Bearings', [], '22216-E');
  const ka = blockingKeys(a);
  const kb = blockingKeys(b);
  assert.ok(ka.includes('PN:22216E'), `PN family key expected in ${ka.join(', ')}`);
  assert.ok(kb.includes('PN:22216E'));
  const pairs = [...iterateShadowCandidates([a, b])];
  assert.equal(pairs.length, 1, 'same PN family pairs through the PN arm');
});

/* ------------------------------ 5. α gate dial ------------------------------ */

test('α=∞ shadow stream is a superset of the baseline token rule on the GT materials', () => {
  const baseline = new Set<string>();
  for (const [a, b] of iteratePairs(gtMats)) {
    baseline.add(a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`);
  }
  const shadow = new Set<string>();
  for (const p of iterateShadowCandidates(gtMats)) {
    shadow.add(`${p.materialIdA}:${p.materialIdB}`);
  }
  for (const k of baseline) assert.ok(shadow.has(k), `baseline pair ${k} missing from shadow union`);
  // The union may add pairs (measured +16 on the reference corpus) — those
  // extras are the honest cost of the additive design.
  assert.ok(shadow.size >= baseline.size);
});

test('α<1 (documented-unsafe) demonstrably drops baseline pairs on the GT materials', () => {
  const baseline = new Set<string>();
  for (const [a, b] of iteratePairs(gtMats)) {
    baseline.add(a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`);
  }
  const gated = new Set<string>();
  for (const p of iterateShadowCandidates(gtMats, 0.05)) {
    gated.add(`${p.materialIdA}:${p.materialIdB}`);
  }
  let dropped = 0;
  for (const k of baseline) if (!gated.has(k)) dropped++;
  assert.ok(dropped > 0, `α gate at 0.05 must drop baseline pairs (measured ${dropped}) — the reason it is rejected`);
});

/* ------------------------------ 6. determinism + production isolation ------------------------------ */

test('determinism: two runs emit identical pair streams', () => {
  const run1 = [...iterateShadowCandidates(gtMats)].map((p) => `${p.materialIdA}:${p.materialIdB}`);
  const run2 = [...iterateShadowCandidates(gtMats)].map((p) => `${p.materialIdA}:${p.materialIdB}`);
  assert.deepEqual(run1, run2);
});

test('production isolation: iteratePairs still yields the exact baseline rule pairs', () => {
  // Independent reimplementation of the baseline rule for the GT materials.
  const expected = new Set<string>();
  const byCat = new Map<string, MatchableMaterial[]>();
  for (const m of gtMats) {
    const list = byCat.get(m.category) ?? [];
    list.push(m);
    byCat.set(m.category, list);
  }
  for (const [, members] of byCat) {
    const tokenSets = members.map((m) => distinctiveTokens(m));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (members[i].organizationId === members[j].organizationId) continue;
        let shared = 0;
        for (const t of tokenSets[i]) if (tokenSets[j].has(t)) shared++;
        if (shared >= 1) {
          const a = members[i].id, b = members[j].id;
          expected.add(a < b ? `${a}:${b}` : `${b}:${a}`);
        }
      }
    }
  }
  const actual = new Set<string>();
  for (const [a, b] of iteratePairs(gtMats)) {
    actual.add(a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`);
  }
  assert.equal(actual.size, expected.size);
  for (const k of expected) assert.ok(actual.has(k), `production retrieval lost baseline pair ${k}`);
});

test('test DB was isolated (temp dir, not the reference DB)', () => {
  assert.ok(tmpDir.startsWith(os.tmpdir()), `test db must live in a temp dir, got ${tmpDir}`);
  assert.ok(!fs.existsSync('data/materialiq.db') || !path.resolve(tmpDir).includes(path.resolve('data')));
});

// Cleanup (plain script — no framework hooks).
testDb.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} failing checks:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log(`\nAll ${passed} blocking-shadow checks passed.`);
}
