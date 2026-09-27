/**
 * Step 11 - CMI approval workflow regression suite.
 *
 * `npx tsx tests/cmi-workflow.test.ts` (part of the npm test chain).
 *
 * Covers, against the REAL services (decideMatch/createCmiFromMatch) and the
 * REAL repository (derived cmiState, funnel, filter) on isolated DBs:
 * approved/cmi_pending derivation, approved/cmi_created derivation,
 * status guards (pending/rejected/deferred cannot create CMIs), funnel
 * reconciliation, 2 mappings + full audit trail, duplicate rejection,
 * concurrency safety, server-side filter + pagination, Step-9 default OFF.
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
import { listMatches, getApprovalCmiFunnel } from '../src/lib/db/repositories/matching-repository';
import { cmiShortCircuitMode } from '../src/lib/matching/cmi-shortcircuit';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  process.env.CMI_SHORT_CIRCUIT = 'off';
  try {
    fn();
    passed++;
    console.log('  ok - ' + name);
  } catch (e) {
    failed++;
    failures.push(name + ': ' + (e as Error).message);
    console.log('  FAIL - ' + name + ': ' + (e as Error).message);
  }
}

function freshSeededDb(): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-workflow-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  migrate(db);
  setDbForTests(db);
  const now = new Date().toISOString();
  const insOrg = db.prepare(
    "INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)"
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
  // Disjoint bearing pairs so each approved pair can become its own CMI.
  const cp1001 = Number(ins.run(cpcl, 'CP-1001', 'SKF BALL BEARING 6205-2RS', 'SKF BALL BEARING 6205-2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid);
  const nt8821 = Number(ins.run(ntpc, 'NT-8821', 'SKF DEEP GROOVE BRG 6205 2RS', 'SKF DEEP GROOVE BEARING 6205 2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid);
  const cp1005 = Number(ins.run(cpcl, 'CP-1005', 'SKF BALL BEARING 6207-2RS', 'SKF BALL BEARING 6207-2RS', 'Bearings', 'SKF', '6207-2RS', 'EA', now, now).lastInsertRowid);
  const sl7725 = Number(ins.run(sail, 'SL-7725', 'SKF BEARING 6207 2RS', 'SKF BEARING 6207 2RS', 'Bearings', 'SKF', '6207-2RS', 'EA', now, now).lastInsertRowid);
  for (const [id, series, seal] of [
    [cp1001, '6205', '2RS'], [nt8821, '6205', '2RS'],
    [cp1005, '6207', '2RS'], [sl7725, '6207', '2RS'],
  ] as Array<[number, string, string]>) {
    upsertAttribute({ materialId: id, attributeName: 'series', value: series, isCritical: true, extractionMethod: 'rule' });
    upsertAttribute({ materialId: id, attributeName: 'seal_type', value: seal, normalizedValue: seal, isCritical: true, extractionMethod: 'rule' });
    upsertAttribute({ materialId: id, attributeName: 'bearing_type', value: 'DEEP_GROOVE_BALL', extractionMethod: 'rule' });
  }
  process.env.CMI_SHORT_CIRCUIT = 'off';
  runMatching('workflow-seed');
  return db;
}

function main(): void {
  test('approved pair without CMI derives cmi_pending; pending derives null', () => {
    const db = freshSeededDb();
    decideMatch(1, { decision: 'approved', reviewer: 'r@demo' }, 'r@demo');
    const rows = listMatches({ page: 1, pageSize: 50 });
    const m1 = rows.items.find((m) => m.candidate.id === 1)!;
    assert.equal(m1.cmiState, 'cmi_pending');
    assert.equal(m1.candidate.status, 'approved');
    const pend = rows.items.find((m) => m.candidate.status === 'pending');
    if (pend) assert.equal(pend.cmiState, null);
    db.close();
  });

  test('approved pair with CMI derives cmi_created (full funnel flow)', () => {
    const db = freshSeededDb();
    decideMatch(1, { decision: 'approved', reviewer: 'r@demo' }, 'r@demo');
    createCmiFromMatch({ code: 'CMI-T-6205', name: 'Bearing 6205-2RS common identity', category: 'Bearings', matchId: 1 }, 'r@demo');
    const m1 = listMatches({ page: 1, pageSize: 50 }).items.find((m) => m.candidate.id === 1)!;
    assert.equal(m1.cmiState, 'cmi_created');
    db.close();
  });

  test('pending/rejected/deferred cannot create CMIs', () => {
    const db = freshSeededDb();
    const pend = listMatches({ status: 'pending' as never, page: 1, pageSize: 3 }).items;
    assert.throws(
      () => createCmiFromMatch({ code: 'CMI-T-P', name: 'pending attempt', category: 'Bearings', matchId: pend[0].candidate.id }, 'r'),
      /approved match/
    );
    const more = listMatches({ status: 'pending' as never, page: 1, pageSize: 3 }).items;
    decideMatch(more[1].candidate.id, { decision: 'rejected', reviewer: 'r' }, 'r');
    decideMatch(more[2].candidate.id, { decision: 'deferred', reviewer: 'r' }, 'r');
    assert.throws(
      () => createCmiFromMatch({ code: 'CMI-T-R', name: 'rejected attempt', category: 'Bearings', matchId: more[1].candidate.id }, 'r'),
      /approved match/
    );
    assert.throws(
      () => createCmiFromMatch({ code: 'CMI-T-D', name: 'deferred attempt', category: 'Bearings', matchId: more[2].candidate.id }, 'r'),
      /approved match/
    );
    db.close();
  });

  test('funnel counters reconcile: approved = awaiting + created', () => {
    const db = freshSeededDb();
    decideMatch(1, { decision: 'approved', reviewer: 'r' }, 'r');
    createCmiFromMatch({ code: 'CMI-T-A', name: 'First CMI', category: 'Bearings', matchId: 1 }, 'r');
    const more = listMatches({ status: 'pending' as never, page: 1, pageSize: 10 }).items;
    decideMatch(more[0].candidate.id, { decision: 'approved', reviewer: 'r' }, 'r');
    const f = getApprovalCmiFunnel();
    assert.equal(f.approvedTotal, f.awaitingCmi + f.cmiCreated);
    assert.equal(f.cmiCreated, 1);
    assert.equal(f.awaitingCmi, 1);
    db.close();
  });

  test('creation makes 2 mappings + full audit trail with actor', () => {
    const db = freshSeededDb();
    decideMatch(1, { decision: 'approved', reviewer: 'reviewer@demo' }, 'reviewer@demo');
    const res = createCmiFromMatch({ code: 'CMI-T-6205', name: 'Bearing 6205-2RS common identity', category: 'Bearings', matchId: 1 }, 'reviewer@demo');
    assert.equal(res.mappingsCreated, 2);
    const maps = db.prepare('SELECT COUNT(*) n FROM material_mappings WHERE cmi_id = ?').get(res.cmiId) as { n: number };
    assert.equal(maps.n, 2);
    const audits = db.prepare(
      "SELECT action, actor FROM audit_logs WHERE action IN ('common_material_created','mapping_created','proposal_approved')"
    ).all() as Array<{ action: string; actor: string }>;
    const actions = audits.map((a) => a.action);
    for (const want of ['proposal_approved', 'common_material_created', 'mapping_created']) {
      assert.ok(actions.includes(want), 'missing audit ' + want);
    }
    for (const a of audits) assert.equal(a.actor, 'reviewer@demo');
    db.close();
  });

  test('duplicate creation safely rejected; no partial state', () => {
    const db = freshSeededDb();
    decideMatch(1, { decision: 'approved', reviewer: 'r' }, 'r');
    createCmiFromMatch({ code: 'CMI-T-A', name: 'First CMI', category: 'Bearings', matchId: 1 }, 'r');
    // Same match again: both materials already mapped -> conflict, no partial CMI.
    assert.throws(
      () => createCmiFromMatch({ code: 'CMI-T-B', name: 'Second CMI same match', category: 'Bearings', matchId: 1 }, 'r'),
      /already mapped|already exists/
    );
    const orphan = db.prepare("SELECT COUNT(*) n FROM common_materials WHERE code = 'CMI-T-B'").get() as { n: number };
    assert.equal(orphan.n, 0);
    db.close();
  });

  test('concurrent-style double creation: unique mappings admit exactly one CMI', () => {
    const db = freshSeededDb();
    decideMatch(1, { decision: 'approved', reviewer: 'r' }, 'r');
    let winner = 0;
    try {
      createCmiFromMatch({ code: 'CMI-T-C1', name: 'Winner', category: 'Bearings', matchId: 1 }, 'r');
      winner++;
    } catch { /* conflict */ }
    try {
      createCmiFromMatch({ code: 'CMI-T-C2', name: 'Loser', category: 'Bearings', matchId: 1 }, 'r');
      winner++;
    } catch { /* conflict */ }
    assert.equal(winner, 1, 'exactly one creation attempt may succeed');
    const cmis = db.prepare("SELECT COUNT(*) n FROM common_materials WHERE code LIKE 'CMI-T-C%'").get() as { n: number };
    assert.equal(cmis.n, 1);
    const maps = db.prepare(
      "SELECT COUNT(*) n FROM material_mappings mm JOIN common_materials cm ON cm.id = mm.cmi_id WHERE cm.code LIKE 'CMI-T-C%'"
    ).get() as { n: number };
    assert.equal(maps.n, 2);
    db.close();
  });

  test('cmiState filter is server-side; pagination totals stay consistent', () => {
    const db = freshSeededDb();
    decideMatch(1, { decision: 'approved', reviewer: 'r' }, 'r');
    createCmiFromMatch({ code: 'CMI-T-6205', name: 'Bearing 6205-2RS', category: 'Bearings', matchId: 1 }, 'r');
    const created = listMatches({ cmiState: 'cmi_created', page: 1, pageSize: 50 });
    assert.equal(created.total, 1);
    assert.equal(created.items[0].candidate.id, 1);
    const p1 = listMatches({ page: 1, pageSize: 2 });
    const p2 = listMatches({ page: 2, pageSize: 2 });
    assert.equal(p1.total, p2.total);
    assert.equal(p1.items.length, 2);
    const f = getApprovalCmiFunnel();
    assert.equal(f.approvedTotal, f.awaitingCmi + f.cmiCreated);
    db.close();
  });

  test('Step-9 seam defaults OFF; new CMI detected in shadow mode', () => {
    delete process.env.CMI_SHORT_CIRCUIT;
    assert.equal(cmiShortCircuitMode(), 'off');
    const db = freshSeededDb();
    decideMatch(1, { decision: 'approved', reviewer: 'r' }, 'r');
    createCmiFromMatch({ code: 'CMI-T-6205', name: 'Bearing 6205-2RS', category: 'Bearings', matchId: 1 }, 'r');
    process.env.CMI_SHORT_CIRCUIT = 'shadow'; // freshSeededDb reset it to off
    const s = runMatching('workflow-shadow');
    assert.ok(s.cmiShortCircuited >= 1, 'shadow should detect the new CMI pair, got ' + s.cmiShortCircuited);
    db.close();
  });

  console.log('\ncmi-workflow: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main();
