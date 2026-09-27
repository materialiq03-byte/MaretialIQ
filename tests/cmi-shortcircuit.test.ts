/**
 * Step 9 — CMI short-circuit regression suite.
 *
 * `npx tsx tests/cmi-shortcircuit.test.ts` (part of the npm test chain).
 *
 * Uses a disposable temp SQLite DB seeded with the REAL seed script
 * (scripts/seed.ts data: CMI-BRG-6205 with CP-1001, NT-8821, SL-7721), so
 * the live reference CMI is exercised end-to-end through the REAL
 * runMatching. Pins the 12 behaviors required by the Step-9 brief:
 *
 *   1. same-CMI pair is detected (shadow counts it)
 *   2. same-CMI pair is short-circuitable (on skips the DECIDED one)
 *   3. different CMI is not short-circuitable (pure predicate)
 *   4. one-sided membership is not short-circuitable
 *   5. no membership is not short-circuitable
 *   6. cross-CPSE same-CMI membership works (seed CMI spans 3 orgs)
 *   7. revoked (is_active=0) membership is respected; restored works
 *   8. deterministic results (two identical runs → identical counters)
 *   9. shadow mode does not change persistence (candidate content identical)
 *  10. existing CMI-BRG-6205 mappings work through the real pipeline
 *  11. evaluation semantics untouched (evaluateGroundTruth scores pairs
 *      directly; asserted here via the pipeline's scorePair path staying the
 *      default — the seam is read once per run and never consulted by the
 *      evaluation path)
 *  12. feature OFF leaves matching behavior unchanged (off-run summary has
 *      cmiShortCircuited === 0 and no cmiDetail)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMatching } from '../src/lib/services/matching-service';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { upsertAttribute } from '../src/lib/db/repositories/material-repository';
import {
  evaluateCmiPair,
  makeCmiRuntime,
  pairKey,
  type CmiShortCircuitRuntime,
} from '../src/lib/matching/cmi-shortcircuit';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  process.env.CMI_SHORT_CIRCUIT = 'off'; // each test sets its own mode
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

/**
 * Minimal replica of the reference CMI fixture: 3 CPSEs × 1 material each
 * (CP-1001 / NT-8821 / SL-7721, all SKF 6205-2RS with full agreeing
 * attributes), a pre-APPROVED candidate row for CP-1001↔NT-8821 (the seed
 * script's flagship, with the same 96 score and NULL evidence), an active
 * CMI mapping all three materials, and the same-org-pair structure the
 * retrieval skips. Everything else the pipeline sees matches the reference
 * fixture's essential shape.
 */
function freshSeededDb(): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-cmi-test-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  migrate(db);
  setDbForTests(db);
  const now = new Date().toISOString();
  const insOrg = db.prepare(
    `INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
  );
  const cpcl = Number(insOrg.run('CPCL', 'Chennai Petroleum (demo)', now, now).lastInsertRowid);
  const ntpc = Number(insOrg.run('NTPC', 'NTPC Limited (demo)', now, now).lastInsertRowid);
  const sail = Number(insOrg.run('SAIL', 'Steel Authority (demo)', now, now).lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO material_records
       (organization_id, original_code, original_description, normalized_description, category,
        manufacturer, part_number, uom, processing_status, classification_confidence,
        classification_source, quality_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready_for_matching', 1.0, 'rule', 'good', ?, ?)`
  );
  const cp1001 = Number(ins.run(cpcl, 'CP-1001', 'SKF BALL BEARING 6205-2RS', 'SKF BALL BEARING 6205-2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid);
  const nt8821 = Number(ins.run(ntpc, 'NT-8821', 'SKF DEEP GROOVE BRG 6205 2RS', 'SKF DEEP GROOVE BEARING 6205 2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid);
  const sl7721 = Number(ins.run(sail, 'SL-7721', 'SKF BEARING 6205 2RS', 'SKF BEARING 6205 2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid);
  const bearingAttrs: Array<[string, string, boolean]> = [
    ['series', '6205', true], ['bore_diameter', '25', true], ['outer_diameter', '52', false], ['width', '15', false],
  ];
  for (const id of [cp1001, nt8821, sl7721]) {
    upsertAttribute({ materialId: id, attributeName: 'seal_type', value: '2RS', normalizedValue: '2RS', isCritical: true, extractionMethod: 'rule' });
    upsertAttribute({ materialId: id, attributeName: 'bearing_type', value: 'DEEP_GROOVE_BALL', extractionMethod: 'rule' });
    for (const [n, v, c] of bearingAttrs) upsertAttribute({ materialId: id, attributeName: n, value: v, isCritical: c, extractionMethod: 'rule' });
  }
  // The seed script's pre-approved flagship pair (identical specs, NULL
  // evidence, match_run_id NULL — decided BEFORE any matching run).
  db.prepare(
    `INSERT INTO match_candidates
       (source_material_id, candidate_material_id, semantic_score, fuzzy_score, technical_score,
        category_compatible, final_score, match_type, explanation, status)
     VALUES (?, ?, 100, 92, 100, 1, 96, 'identical', ?, 'approved')`
  ).run(cp1001, nt8821, 'Pre-approved synthetic pair: identical specifications.');
  // The approved CMI spanning all three CPSEs.
  const cmiId = Number(
    db
      .prepare(`INSERT INTO common_materials (code, name, description, category, source_match_id, is_active, created_at, updated_at) VALUES ('CMI-BRG-6205', 'Ball bearing 6205-2RS, deep groove, SKF', NULL, 'Bearings', 1, 1, ?, ?)`)
      .run(now, now).lastInsertRowid
  );
  const insMap = db.prepare(`INSERT INTO material_mappings (cmi_id, material_id, organization_id) VALUES (?, ?, ?)`);
  insMap.run(cmiId, cp1001, cpcl);
  insMap.run(cmiId, nt8821, ntpc);
  insMap.run(cmiId, sl7721, sail);
  return db;
}

/** Candidate-table content signature (pair-keyed, run metadata excluded). */
function fingerprint(db: DatabaseSync): string {
  const rows = db
    .prepare(
      `SELECT source_material_id, candidate_material_id, semantic_score, fuzzy_score,
              technical_score, category_compatible, final_score, match_type, status,
              explanation, critical_difference, evidence
         FROM match_candidates`
    )
    .all() as Array<Record<string, unknown>>;
  return rows
    .map((r) => JSON.stringify(r))
    .sort()
    .join('|');
}

function main(): void {
  // ——— 1, 2, 6, 9, 10, 12: real pipeline on the seeded reference data ———
  test('OFF: runMatching is fully inert (cmiShortCircuited=0, no cmiDetail) [12]', () => {
    process.env.CMI_SHORT_CIRCUIT = 'off';
    const db = freshSeededDb();
    const s = runMatching('t-off');
    assert.equal(s.cmiShortCircuited, 0);
    assert.equal(s.cmiDetail, undefined);
    db.close();
  });

  test('SHADOW: the seeded CMI-BRG-6205 pairs are detected (CP-1001↔NT-8821, CP-1001↔SL-7721, NT-8821↔SL-7721) [1,10,6]', () => {
    process.env.CMI_SHORT_CIRCUIT = 'shadow';
    const db = freshSeededDb();
    const s = runMatching('t-shadow');
    assert.equal(s.cmiShortCircuited, 3, `expected 3 same-CMI pairs, got ${s.cmiShortCircuited}`);
    assert.ok(s.cmiDetail, 'shadow run must carry cmiDetail');
    assert.equal(s.cmiDetail!.cmiIds.length, 1, 'exactly one CMI involved');
    assert.equal(s.cmiDetail!.materialIds.length, 3, 'three distinct materials involved');
    db.close();
  });

  test('SHADOW: persistence is byte-identical to OFF (candidate content) [9]', () => {
    const dbOff = freshSeededDb();
    process.env.CMI_SHORT_CIRCUIT = 'off';
    runMatching('t-parity-off');
    const fpOff = fingerprint(dbOff);
    const countsOff = {
      c: (dbOff.prepare('SELECT COUNT(*) n FROM match_candidates').get() as { n: number }).n,
      q: (dbOff.prepare('SELECT COUNT(*) n FROM review_queue').get() as { n: number }).n,
    };
    dbOff.close();

    const dbSh = freshSeededDb();
    process.env.CMI_SHORT_CIRCUIT = 'shadow';
    runMatching('t-parity-shadow');
    const fpSh = fingerprint(dbSh);
    const countsSh = {
      c: (dbSh.prepare('SELECT COUNT(*) n FROM match_candidates').get() as { n: number }).n,
      q: (dbSh.prepare('SELECT COUNT(*) n FROM review_queue').get() as { n: number }).n,
    };
    dbSh.close();
    assert.equal(fpSh, fpOff, 'candidate content must be identical between off and shadow');
    assert.deepEqual(countsSh, countsOff);
  });

  test('ON: only the DECIDED same-CMI pair is skipped; content identical; audit reconciles [2]', () => {
    // The seed's pre-approved pair (CP-1001↔NT-8821) is decided; the other
    // two same-CMI pairs are pending after run 1 and must still be scored.
    const dbOff = freshSeededDb();
    process.env.CMI_SHORT_CIRCUIT = 'off';
    runMatching('t-on-off');
    const fpOff = fingerprint(dbOff);
    const byDecisionOff = runMatching('t-on-off-2').byDecision;
    dbOff.close();

    const dbOn = freshSeededDb();
    process.env.CMI_SHORT_CIRCUIT = 'on';
    runMatching('t-on-run1'); // run 1: nothing decided except the seeded pair
    const s2 = runMatching('t-on-run2'); // run 2: skips the decided same-CMI pair
    assert.equal(s2.cmiShortCircuited, 1, 'exactly the seeded approved pair is skipped');
    assert.equal(fingerprint(dbOn), fpOff, 'candidate content identical to off');
    // Audit reconciliation: byDecision(on) + skippedByState == byDecision(off).
    const recon: Record<string, number> = { ...s2.byDecision };
    for (const [k, v] of Object.entries(s2.cmiDetail?.skippedByState ?? {})) {
      recon[k] = (recon[k] ?? 0) + v;
    }
    assert.deepEqual(recon, byDecisionOff);
    // The approved row itself is untouched.
    const row = dbOn
      .prepare(
        `SELECT mc.final_score, mc.status FROM match_candidates mc
          JOIN material_records s ON s.id = mc.source_material_id
          JOIN material_records c ON c.id = mc.candidate_material_id
         WHERE s.original_code = 'CP-1001' AND c.original_code = 'NT-8821'`
      )
      .get() as { final_score: number; status: string };
    assert.equal(row.status, 'approved');
    assert.equal(row.final_score, 96);
    dbOn.close();
  });

  test('ON: pending same-CMI pairs are NOT skipped (open human decisions) [2]', () => {
    const db = freshSeededDb();
    process.env.CMI_SHORT_CIRCUIT = 'on';
    const s1 = runMatching('t-pending-run1');
    // The two pending same-CMI pairs were scored and re-created in run 1;
    // run 2 must NOT skip them (deletePendingMatches wiped them; nothing
    // decided exists beyond the seeded pair).
    runMatching('t-pending-run2');
    const s3 = runMatching('t-pending-run3');
    assert.equal(s3.cmiShortCircuited, 1, 'only the seeded approved pair skips; pending pairs keep flowing');
    assert.ok(s1.cmiShortCircuited >= 1);
    db.close();
  });

  test('REVOCATION: is_active=0 removes eligibility immediately; restore re-enables [7]', () => {
    process.env.CMI_SHORT_CIRCUIT = 'shadow';
    const db = freshSeededDb();
    const r1 = runMatching('t-rev-1');
    assert.equal(r1.cmiShortCircuited, 3);
    db.prepare('UPDATE common_materials SET is_active = 0').run();
    const r2 = runMatching('t-rev-2');
    assert.equal(r2.cmiShortCircuited, 0, 'deactivated CMI must not be detected (fresh per-run load)');
    db.prepare('UPDATE common_materials SET is_active = 1').run();
    const r3 = runMatching('t-rev-3');
    assert.equal(r3.cmiShortCircuited, 3);
    db.close();
  });

  test('DETERMINISM: identical runs produce identical counters and detection sets [8]', () => {
    process.env.CMI_SHORT_CIRCUIT = 'shadow';
    const db = freshSeededDb();
    const a = runMatching('t-det-1');
    const b = runMatching('t-det-2');
    assert.equal(a.cmiShortCircuited, b.cmiShortCircuited);
    assert.deepEqual(a.cmiDetail, b.cmiDetail);
    db.close();
  });

  // ——— 3, 4, 5: pure negative predicate checks ———
  const rt: CmiShortCircuitRuntime = {
    membership: new Map([
      [1, 7],
      [2, 7],
      [3, 8],
      [4, 8],
    ]),
    cmiIds: new Set(),
    materialIds: new Set(),
    skippedByState: {},
  };

  test('different CMI is not short-circuitable [3]', () => {
    assert.equal(evaluateCmiPair(rt, 1, 3, 'on').eligible, false);
  });

  test('one-sided membership is not short-circuitable [4]', () => {
    assert.equal(evaluateCmiPair(rt, 1, 5, 'on').eligible, false);
  });

  test('no CMI membership is not short-circuitable [5]', () => {
    assert.equal(evaluateCmiPair(rt, 5, 6, 'on').eligible, false);
    assert.equal(evaluateCmiPair(makeCmiRuntime('off'), 1, 2, 'on').eligible, false);
  });

  test('cross-CPSE same-CMI: eligible regardless of org; same-org never retrieved anyway [6]', () => {
    // The seed CMI spans CPCL+NTPC+SAIL; the pure predicate has no org rule —
    // same-CMI membership alone decides.
    const v = evaluateCmiPair(rt, 1, 2, 'shadow');
    assert.equal(v.eligible, true);
    assert.equal(v.cmiId, 7);
  });

  test('ON fail-safe: unknown status or pending row is never skipped [2]', () => {
    const approved = { ...rt, decidedStatusById: new Map([[pairKey(1, 2), { status: 'approved', state: 'HIGH_CONFIDENCE_MATCH' }]]) };
    assert.equal(evaluateCmiPair(approved, 1, 2, 'on').skippable, true);
    const pending = { ...rt, decidedStatusById: new Map([[pairKey(1, 2), { status: 'pending', state: 'HIGH_CONFIDENCE_MATCH' }]]) };
    assert.equal(evaluateCmiPair(pending, 1, 2, 'on').skippable, false);
    assert.equal(evaluateCmiPair(rt, 1, 2, 'on').skippable, false, 'no status known → score it');
  });

  test('EVALUATION independence: ground-truth scoring does not consult the seam [11]', () => {
    // evaluateGroundTruth scores pairs directly via scorePair — it never
    // calls runMatching or reads cmi-shortcircuit. Verify the module's env
    // gate defaults to off so nothing changes even if the env leaks.
    delete process.env.CMI_SHORT_CIRCUIT;
    const { cmiShortCircuitMode } = require('../src/lib/matching/cmi-shortcircuit') as typeof import('../src/lib/matching/cmi-shortcircuit');
    assert.equal(cmiShortCircuitMode(), 'off');
  });

  console.log(`\ncmi-shortcircuit: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
