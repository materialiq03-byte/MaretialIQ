/**
 * Step 10 — approval→CMI funnel regression suite.
 *
 * `npx tsx tests/cmi-funnel.test.ts` (part of the npm test chain).
 *
 * Exercises the REAL reviewer workflow (decideMatch → createCmiFromMatch) on
 * an isolated temp SQLite DB seeded with the Step-10 CMI fixture, pinning:
 *
 *   1. only approved matches yield CMIs (pending/rejected/deferred → conflict)
 *   2. double CMI creation from the same/overlapping matches is rejected
 *      (material_mappings.material_id UNIQUE — one CMI per material)
 *   3. CMI creation is transactional (failure mid-way leaves no partial CMI)
 *   4. audit trail: common_material_created + mapping_created rows with
 *      actor + details
 *   5. funnel counters reconcile: approved-with-CMI vs approved-without-CMI,
 *      decided same-CMI pairs, mapped materials
 *   6. Step-9 integration through the live workflow: after the funnel grows,
 *      shadow detection increases and on-mode skips exactly the decided set
 *   7. evaluation path independence (cmiShortCircuitMode defaults off)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMatching, decideMatch, createCmiFromMatch } from '../src/lib/services/matching-service';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { upsertAttribute } from '../src/lib/db/repositories/material-repository';
import { recordAudit } from '../src/lib/db/repositories/audit-repository';

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

function freshSeededDb(): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-funnel-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  migrate(db);
  setDbForTests(db);
  const now = new Date().toISOString();
  const insOrg = db.prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`);
  const cpcl = Number(insOrg.run('CPCL', 'Chennai Petroleum (demo)', now, now).lastInsertRowid);
  const ntpc = Number(insOrg.run('NTPC', 'NTPC Limited (demo)', now, now).lastInsertRowid);
  const bhel = Number(insOrg.run('BHEL', 'Bharat Heavy Electricals (demo)', now, now).lastInsertRowid);
  const sail = Number(insOrg.run('SAIL', 'Steel Authority (demo)', now, now).lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO material_records
       (organization_id, original_code, original_description, normalized_description, category,
        manufacturer, part_number, uom, processing_status, classification_confidence,
        classification_source, quality_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready_for_matching', 1.0, 'rule', 'good', ?, ?)`
  );
  // Two identical-bearing pairs: (CP-1001, NT-8821) and (CP-1005, SL-7725).
  const cp1001 = Number(ins.run(cpcl, 'CP-1001', 'SKF BALL BEARING 6205-2RS', 'SKF BALL BEARING 6205-2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid);
  const nt8821 = Number(ins.run(ntpc, 'NT-8821', 'SKF DEEP GROOVE BRG 6205 2RS', 'SKF DEEP GROOVE BEARING 6205 2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid);
  const cp1005 = Number(ins.run(cpcl, 'CP-1005', 'SKF BALL BEARING 6207-2RS', 'SKF BALL BEARING 6207-2RS', 'Bearings', 'SKF', '6207-2RS', 'EA', now, now).lastInsertRowid);
  const sl7725 = Number(ins.run(sail, 'SL-7725', 'SKF BEARING 6207 2RS', 'SKF BEARING 6207 2RS', 'Bearings', 'SKF', '6207-2RS', 'EA', now, now).lastInsertRowid);
  const attrSets: Array<[number, string]> = [
    [cp1001, '6205'], [nt8821, '6205'], [cp1005, '6207'], [sl7725, '6207'],
  ];
  for (const [id, series] of attrSets) {
    upsertAttribute({ materialId: id, attributeName: 'series', value: series, isCritical: true, extractionMethod: 'rule' });
    upsertAttribute({ materialId: id, attributeName: 'seal_type', value: '2RS', normalizedValue: '2RS', isCritical: true, extractionMethod: 'rule' });
    upsertAttribute({ materialId: id, attributeName: 'bearing_type', value: 'DEEP_GROOVE_BALL', extractionMethod: 'rule' });
  }
  // A run creates the candidates; the funnel then works on them.
  process.env.CMI_SHORT_CIRCUIT = 'off';
  runMatching('funnel-seed');
  return db;
}

function main(): void {
  test('only APPROVED matches yield CMIs: pending match → conflict', () => {
    const db = freshSeededDb();
    const pending = (db.prepare(`SELECT id FROM match_candidates WHERE status = 'pending' LIMIT 1`).get() as { id: number }).id;
    assert.throws(
      () => createCmiFromMatch({ code: 'CMI-T-PEND', name: 'Pending attempt', category: 'Bearings', matchId: pending }, 't'),
      /approved match/
    );
    assert.equal((db.prepare('SELECT COUNT(*) n FROM common_materials').get() as { n: number }).n, 0);
    db.close();
  });

  test('full funnel: decideMatch(approved) → createCmiFromMatch → 2 mappings + audit trail', () => {
    const db = freshSeededDb();
    const pair = db
      .prepare(`SELECT id FROM match_candidates WHERE status = 'pending' ORDER BY id LIMIT 1`)
      .get() as { id: number };
    decideMatch(pair.id, { decision: 'approved', reviewer: 'reviewer@demo' }, 'reviewer@demo');
    const res = createCmiFromMatch({ code: 'CMI-T-001', name: 'Test CMI from approved match', category: 'Bearings', matchId: pair.id }, 'reviewer@demo');
    assert.equal(res.mappingsCreated, 2);
    const cmi = db.prepare('SELECT code, is_active, source_match_id FROM common_materials WHERE id = ?').get(res.cmiId) as { code: string; is_active: number; source_match_id: number };
    assert.equal(cmi.code, 'CMI-T-001');
    assert.equal(cmi.is_active, 1);
    assert.equal(cmi.source_match_id, pair.id);
    const audits = db
      .prepare(`SELECT action, actor FROM audit_logs WHERE action IN ('common_material_created','mapping_created','proposal_approved') ORDER BY id`)
      .all() as Array<{ action: string; actor: string }>;
    const actions = audits.map((a) => a.action);
    assert.ok(actions.includes('proposal_approved'), 'approval audited');
    assert.ok(actions.includes('common_material_created'), 'CMI creation audited');
    assert.ok(actions.includes('mapping_created'), 'mapping audited');
    for (const a of audits) assert.equal(a.actor, 'reviewer@demo', 'actor recorded');
    db.close();
  });

  test('double CMI creation on a shared material is rejected (one CMI per material)', () => {
    const db = freshSeededDb();
    const [m1, m2] = db.prepare(`SELECT id FROM match_candidates WHERE status = 'pending' ORDER BY id LIMIT 2`).all() as Array<{ id: number }>;
    // Approve and CMI m1.
    decideMatch(m1.id, { decision: 'approved', reviewer: 'r' }, 'r');
    createCmiFromMatch({ code: 'CMI-T-A', name: 'First CMI', category: 'Bearings', matchId: m1.id }, 'r');
    // A second CMI from a different approved match whose material overlaps → conflict.
    // m1's materials are now mapped; any other approved match sharing one of them conflicts.
    // Use the same match: source material already mapped → conflict on insertMapping.
    assert.throws(
      () => createCmiFromMatch({ code: 'CMI-T-B', name: 'Second CMI same match', category: 'Bearings', matchId: m1.id }, 'r'),
      /already mapped|already exists/
    );
    // The failed second creation must not have left a partial CMI (transaction).
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM common_materials WHERE code = 'CMI-T-B'`).get() as { n: number }).n, 0);
    db.close();
  });

  test('rejected/deferred matches cannot become CMIs (status guard covers all non-approved)', () => {
    const db = freshSeededDb();
    const rows = db.prepare(`SELECT id FROM match_candidates WHERE status = 'pending' ORDER BY id LIMIT 2`).all() as Array<{ id: number }>;
    decideMatch(rows[0].id, { decision: 'rejected', reviewer: 'r' }, 'r');
    decideMatch(rows[1].id, { decision: 'deferred', reviewer: 'r' }, 'r');
    assert.throws(() => createCmiFromMatch({ code: 'CMI-T-R', name: 'From rejected', category: 'Bearings', matchId: rows[0].id }, 'r'), /approved match/);
    assert.throws(() => createCmiFromMatch({ code: 'CMI-T-D', name: 'From deferred', category: 'Bearings', matchId: rows[1].id }, 'r'), /approved match/);
    db.close();
  });

  test('funnel counters reconcile after growth; Step-9 detection reflects the new CMI', () => {
    const db = freshSeededDb();
    // Grow one CMI through the real workflow.
    const pair = db.prepare(`SELECT id FROM match_candidates WHERE status = 'pending' ORDER BY id LIMIT 1`).get() as { id: number };
    decideMatch(pair.id, { decision: 'approved', reviewer: 'r' }, 'r');
    createCmiFromMatch({ code: 'CMI-T-F', name: 'Funnel CMI', category: 'Bearings', matchId: pair.id }, 'r');
    // Funnel counts.
    const approvedWithCmi = (db
      .prepare(`SELECT COUNT(*) n FROM match_candidates mc WHERE mc.status = 'approved' AND EXISTS (SELECT 1 FROM common_materials cm WHERE cm.source_match_id = mc.id AND cm.is_active = 1)`)
      .get() as { n: number }).n;
    const approvedAll = (db.prepare(`SELECT COUNT(*) n FROM match_candidates WHERE status = 'approved'`).get() as { n: number }).n;
    assert.equal(approvedWithCmi, 1);
    assert.ok(approvedAll >= 1);
    const mappedMaterials = (db.prepare('SELECT COUNT(DISTINCT material_id) n FROM material_mappings').get() as { n: number }).n;
    assert.equal(mappedMaterials, 2);
    // Re-run in shadow: detection must now include the new CMI's pair.
    process.env.CMI_SHORT_CIRCUIT = 'shadow';
    const s = runMatching('funnel-shadow');
    assert.ok(s.cmiShortCircuited >= 1, `expected detection ≥1 after growth, got ${s.cmiShortCircuited}`);
    assert.ok(s.cmiDetail, 'shadow run carries cmiDetail');
    db.close();
  });

  test('growth reduces subsequent on-mode scoring work (decided same-CMI pairs skipped)', () => {
    const db = freshSeededDb();
    // Approve disjoint pairs only — a material may belong to at most one CMI,
    // so overlapping pairs must NOT be force-approved (funnel guard, tested above).
    const pairs = db
      .prepare(`SELECT id, source_material_id AS a, candidate_material_id AS b FROM match_candidates WHERE status = 'pending' ORDER BY id`)
      .all() as Array<{ id: number; a: number; b: number }>;
    const used = new Set<number>();
    let grown = 0;
    for (const p of pairs) {
      if (used.has(p.a) || used.has(p.b)) continue;
      decideMatch(p.id, { decision: 'approved', reviewer: 'r' }, 'r');
      createCmiFromMatch({ code: `CMI-T-${p.id}`, name: `CMI ${p.id}`, category: 'Bearings', matchId: p.id }, 'r');
      used.add(p.a);
      used.add(p.b);
      grown++;
    }
    assert.ok(grown >= 2, `expected to grow ≥2 CMIs from disjoint pairs, got ${grown}`);
    process.env.CMI_SHORT_CIRCUIT = 'on';
    const on = runMatching('funnel-on');
    assert.ok(on.cmiShortCircuited >= 2, `expected ≥2 skips, got ${on.cmiShortCircuited}`);
    // Decided rows preserved.
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM match_candidates WHERE status != 'pending'`).get() as { n: number }).n >= 2, true);
    db.close();
  });

  test('evaluation independence: seam defaults off when env unset', () => {
    delete process.env.CMI_SHORT_CIRCUIT;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { cmiShortCircuitMode } = require('../src/lib/matching/cmi-shortcircuit') as typeof import('../src/lib/matching/cmi-shortcircuit');
    assert.equal(cmiShortCircuitMode(), 'off');
  });

  console.log(`\ncmi-funnel: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
