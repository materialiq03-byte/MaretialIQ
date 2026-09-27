/**
 * Step 19 — UOM rule history, steward governance & role-based lifecycle.
 *
 * `npx tsx tests/procurement-uom-history.test.ts` (part of the npm test chain).
 *
 * Pins the Step-19 contract on top of the untouched Step-17/18 engine:
 *
 *   1. history creation: CREATE row appended with the rule
 *   2. append-only: UPDATE and DELETE physically refused
 *   3. CREATE event shape (previous NULL -> PENDING, actor, reason)
 *   4. APPROVE event (PENDING -> APPROVED)
 *   5. REJECT event (PENDING -> REJECTED)
 *   6. DISABLE event (APPROVED -> DISABLED)
 *   7. RE_ENABLE event (DISABLED -> APPROVED)
 *   8. invalid transition: nothing written (state, audit, history unchanged)
 *   9. authorization: MANAGE_UOM_RULES matrix unchanged (reads stay open)
 *  10. steward dashboard aggregation: counts, quality, remediation CMIs
 *  11. pending queue: only PENDING rules, with bounded context counts
 *  12. history API shape (chronological, actor, old/new state)
 *  13. role-based demo: steward proposes, approver decides, read-only sees
 *  14. conversion only after approval (PENDING no effect)
 *  15. conversion stops after disable
 *  16. conversion resumes after re-enable
 *  17. original procurement data untouched by every action
 *  18. Step 17 regression: system registry + 390 EA + exact decimals
 *  19. Step 18 regression: precedence + scope isolation intact
 *  20. SQL/service parity with a live APPROVED domain rule
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import {
  createSupplierRecord,
  createProcurementRecord,
  normalizeQuantity,
  getUomRuleRegistry,
  getCmiComparableDemand,
  createUomDomainRule,
  transitionUomRuleLifecycle,
  getUomRuleHistory,
  getUomStewardDashboard,
  getEffectiveUomRule,
} from '../src/lib/services/procurement-service';
import { countAudit } from '../src/lib/db/repositories/audit-repository';

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

const STEWARD = 'steward19@demo';
const APPROVER = 'approver19@demo';

interface Fixture {
  db: DatabaseSync;
  cpclId: number;
  ntpcId: number;
  cmiId: number;
  cpclBearing: number;
  ntpcBearing: number;
  supplierA: number;
  supplierB: number;
}

function baseFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-uom19-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  setDbForTests(db);
  const now = new Date().toISOString();
  const insOrg = db.prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`);
  const cpcl = Number(insOrg.run('CPCL', 'Chennai Petroleum (demo)', now, now).lastInsertRowid);
  const ntpc = Number(insOrg.run('NTPC', 'NTPC Limited (demo)', now, now).lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO material_records
       (organization_id, original_code, original_description, normalized_description, category,
        manufacturer, part_number, uom, processing_status, classification_confidence,
        classification_source, quality_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready_for_matching', 1.0, 'rule', 'good', ?, ?)`
  );
  const cpBrg = Number(ins.run(cpcl, 'CP-1001', 'SKF BALL BEARING 6205-2RS', 'SKF BALL BEARING 6205-2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid);
  const ntBrg = Number(ins.run(ntpc, 'NT-8821', 'SKF DEEP GROOVE BRG 6205 2RS', 'SKF DEEP GROOVE BEARING 6205 2RS', 'Bearings', 'SKF', '6205-2RS', 'EA', now, now).lastInsertRowid);
  const pair = db.prepare(
    `INSERT INTO match_candidates
       (source_material_id, candidate_material_id, semantic_score, fuzzy_score, technical_score,
        category_compatible, final_score, match_type, explanation, status, created_at, updated_at)
     VALUES (?, ?, 90, 88, 95, 1, 91, 'identical', 'fixture', 'approved', ?, ?)`
  ).run(cpBrg, ntBrg, now, now);
  db.prepare(
    `INSERT INTO match_decisions (match_id, decision, reviewer, comment, decided_at, created_at, updated_at)
     VALUES (?, 'approved', 'rev@demo', 'fixture approval', ?, ?, ?)`
  ).run(Number(pair.lastInsertRowid), now, now, now);
  const cmi = db.prepare(
    `INSERT INTO common_materials (code, name, category, is_active, created_at, updated_at)
     VALUES ('CMI-T-BRG', 'Test bearing CMI', 'Bearings', 1, ?, ?)`
  ).run(now, now);
  const cmiId = Number(cmi.lastInsertRowid);
  db.prepare(`INSERT INTO material_mappings (cmi_id, material_id, organization_id) VALUES (?, ?, ?)`).run(cmiId, cpBrg, cpcl);
  db.prepare(`INSERT INTO material_mappings (cmi_id, material_id, organization_id) VALUES (?, ?, ?)`).run(cmiId, ntBrg, ntpc);
  const supA = createSupplierRecord({ supplierCode: 'SUP-A', supplierName: 'Alpha Bearings Ltd', region: 'IN' }, STEWARD).id;
  const supB = createSupplierRecord({ supplierCode: 'SUP-B', supplierName: 'Beta Industrial Co', region: 'IN' }, STEWARD).id;
  return { db, cpclId: cpcl, ntpcId: ntpc, cmiId, cpclBearing: cpBrg, ntpcBearing: ntBrg, supplierA: supA, supplierB: supB };
}

function proc(f: Fixture, orgId: number, materialId: number, supplierId: number, po: string, date: string, qty: string, uom: string, price?: string, currency?: string): void {
  createProcurementRecord(
    {
      organizationId: orgId, materialId, cmiId: f.cmiId, supplierId,
      purchaseOrderReference: po, purchaseDate: date,
      quantity: qty, uom,
      unitPrice: price ?? undefined, currency: currency ?? undefined, status: 'DELIVERED',
    },
    STEWARD
  );
}

function proposeScoped(f: Fixture, fromUom = 'SET', factor = 10): number {
  return createUomDomainRule({
    cmiId: f.cmiId, fromUom, toUom: 'EA', factor,
    reason: 'Supplier pack sheet for this bearing family: 1 SET = 10 EA (fixture evidence).',
    actor: STEWARD,
  }).id;
}

/** Original procurement row as stored (quantity + uom verbatim). */
function rawRecord(f: Fixture, po: string): { quantity: string; uom: string } {
  const r = f.db.prepare(`SELECT quantity, uom FROM procurement_records WHERE purchase_order_reference = ?`).get(po) as unknown as { quantity: string; uom: string };
  return { quantity: String(r.quantity), uom: String(r.uom) };
}

function main(): void {
  test('1+3. history creation: CREATE row appended with the rule, previous NULL -> PENDING, actor + reason recorded', () => {
    const f = baseFixture();
    const id = proposeScoped(f);
    const h = getUomRuleHistory(id);
    assert.equal(h.length, 1);
    assert.equal(h[0].action, 'CREATE');
    assert.equal(h[0].previousStatus, null);
    assert.equal(h[0].newStatus, 'PENDING');
    assert.equal(h[0].actor, STEWARD);
    assert.ok((h[0].reason ?? '').includes('1 SET = 10 EA'), 'CREATE history carries the rule evidence');
    assert.equal(h[0].ruleId, id);
    assert.equal(h[0].cmiId, f.cmiId);
    assert.equal(h[0].fromUom, 'SET');
    assert.equal(h[0].toUom, 'EA');
    assert.equal(h[0].factor, 10);
    f.db.close();
  });

  test('2. append-only: UPDATE and DELETE are physically refused', () => {
    const f = baseFixture();
    const id = proposeScoped(f);
    assert.throws(() => f.db.prepare('UPDATE uom_rule_history SET actor = ? WHERE rule_id = ?').run('evil', id), /append-only/);
    assert.throws(() => f.db.prepare('DELETE FROM uom_rule_history WHERE rule_id = ?').run(id), /append-only/);
    assert.equal(getUomRuleHistory(id).length, 1, 'history intact after refusal');
    f.db.close();
  });

  test('4. APPROVE event recorded (PENDING -> APPROVED)', () => {
    const f = baseFixture();
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', APPROVER);
    const h = getUomRuleHistory(id);
    assert.equal(h.length, 2);
    assert.equal(h[1].action, 'APPROVE');
    assert.equal(h[1].previousStatus, 'PENDING');
    assert.equal(h[1].newStatus, 'APPROVED');
    assert.equal(h[1].actor, APPROVER);
    f.db.close();
  });

  test('5. REJECT event recorded (PENDING -> REJECTED)', () => {
    const f = baseFixture();
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'reject', APPROVER);
    const h = getUomRuleHistory(id);
    assert.equal(h.length, 2);
    assert.equal(h[1].action, 'REJECT');
    assert.equal(h[1].newStatus, 'REJECTED');
    f.db.close();
  });

  test('6+7. DISABLE and RE_ENABLE events recorded with correct old/new state', () => {
    const f = baseFixture();
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', APPROVER);
    transitionUomRuleLifecycle(id, 'disable', APPROVER);
    transitionUomRuleLifecycle(id, 're-enable', APPROVER);
    const h = getUomRuleHistory(id);
    assert.deepEqual(h.map((x) => x.action), ['CREATE', 'APPROVE', 'DISABLE', 'RE_ENABLE']);
    assert.deepEqual(h.map((x) => [x.previousStatus, x.newStatus]), [
      [null, 'PENDING'],
      ['PENDING', 'APPROVED'],
      ['APPROVED', 'DISABLED'],
      ['DISABLED', 'APPROVED'],
    ]);
    assert.equal(h[0].actor, STEWARD, 'CREATE attributed to the proposing steward');
    assert.ok(h.slice(1).every((x) => x.actor === APPROVER), 'lifecycle events attributed to the approver');
    f.db.close();
  });

  test('8. invalid transition: state, audit and history all unchanged (fail closed)', () => {
    const f = baseFixture();
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', APPROVER);
    const beforeHistory = getUomRuleHistory(id).length;
    const beforeAudit = countAudit();
    assert.throws(() => transitionUomRuleLifecycle(id, 'approve', APPROVER), /Invalid transition/);
    assert.throws(() => transitionUomRuleLifecycle(id, 're-enable', APPROVER), /Invalid transition/);
    assert.equal(getUomRuleHistory(id).length, beforeHistory, 'no history rows for refused actions');
    assert.equal(countAudit(), beforeAudit, 'no audit rows for refused actions');
    f.db.close();
  });

  test('9. authorization matrix unchanged; history reads are not gated by MANAGE_UOM_RULES', () => {
    const f = baseFixture();
    const { roleHasPermission } = require('../src/lib/auth/permissions') as typeof import('../src/lib/auth/permissions');
    assert.ok(roleHasPermission('authority', 'MANAGE_UOM_RULES'));
    assert.ok(roleHasPermission('platform_admin', 'MANAGE_UOM_RULES'));
    assert.ok(!roleHasPermission('cpse_material_manager', 'MANAGE_UOM_RULES'));
    assert.ok(!roleHasPermission('cpse_technical_reviewer', 'MANAGE_UOM_RULES'));
    const id = proposeScoped(f);
    // History read (VIEW_MAPPINGS-class) works without governance rights.
    assert.equal(getUomRuleHistory(id).length, 1);
    f.db.close();
  });

  test('10. steward dashboard aggregation: lifecycle counts, quality buckets, remediation CMIs', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-S1', '2026-01-05', '120', 'PCS', '10.00', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierB, 'PO-S2', '2026-01-06', '12', 'SET', '50.00', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-S3', '2026-01-07', '3', 'PKT', '1.00', 'INR');
    const a = proposeScoped(f);
    const b = createUomDomainRule({ cmiId: f.cmiId, fromUom: 'DRUM', toUom: 'ML', factor: 200, reason: 'drum sheet', actor: STEWARD }).id;
    transitionUomRuleLifecycle(a, 'approve', APPROVER);
    transitionUomRuleLifecycle(b, 'reject', APPROVER);
    const ov = getUomStewardDashboard();
    assert.equal(ov.rules.total, 2);
    assert.equal(ov.rules.pending, 0);
    assert.equal(ov.rules.approved, 1);
    assert.equal(ov.rules.rejected, 1);
    assert.equal(ov.rules.disabled, 0);
    assert.ok(ov.quality.totalRecords >= 2, 'quality total counts procurement records');
    assert.ok((ov.quality.counts.VALID_ALIAS ?? 0) >= 1, 'PCS record visible in quality buckets');
    assert.equal(ov.quality.cmisRequiringRemediation, 1, 'the CMI holding the SET record needs remediation');
    assert.ok(ov.activity.created >= 2 && ov.activity.approved >= 1 && ov.activity.rejected >= 1, 'activity counted from history');
    f.db.close();
  });

  test('11. pending queue: only PENDING rules, with affected-record context', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-Q1', '2026-01-10', '5', 'SET', '1.00', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-Q2', '2026-01-11', '7', 'SET', '1.00', 'INR');
    const id = proposeScoped(f);
    let ov = getUomStewardDashboard();
    assert.equal(ov.pendingQueue.length, 1);
    const q = ov.pendingQueue[0];
    assert.equal(q.rule.id, id);
    assert.equal(q.affectedRecords, 2, 'bounded COUNT over the CMI+UOM scope');
    assert.equal(q.cmiRecordCount, 2);
    assert.equal(q.historyCount, 1);
    transitionUomRuleLifecycle(id, 'approve', APPROVER);
    ov = getUomStewardDashboard();
    assert.equal(ov.pendingQueue.length, 0, 'approved rules leave the queue');
    f.db.close();
  });

  test('12. history API shape: chronological, attributable, old/new state per event', () => {
    const f = baseFixture();
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', APPROVER);
    transitionUomRuleLifecycle(id, 'disable', APPROVER);
    const h = getUomRuleHistory(id);
    const ids = h.map((x) => x.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'chronological by id');
    assert.ok(h.every((x) => x.actor.length > 0), 'every event attributable');
    assert.ok(h.every((x) => x.createdAt.length > 0), 'every event timestamped');
    f.db.close();
  });

  test('13. role-based demo: steward proposes, approver decides, read-only role sees but cannot act', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-D1', '2026-01-12', '4', 'SET', '25.00', 'INR');
    const id = proposeScoped(f); // steward (no MANAGE_UOM_RULES) proposes via governed API
    // steward cannot transition (permission lives at the API boundary; the
    // matrix pinned in test 9). Approver walks the lifecycle.
    transitionUomRuleLifecycle(id, 'approve', APPROVER);
    // read-only role: history + dashboard visible...
    assert.equal(getUomRuleHistory(id).length, 2);
    assert.ok(getUomStewardDashboard().rules.total >= 1);
    // ...but role matrix denies governance to reviewer/manager.
    const { roleHasPermission } = require('../src/lib/auth/permissions') as typeof import('../src/lib/auth/permissions');
    assert.ok(!roleHasPermission('cpse_technical_reviewer', 'MANAGE_UOM_RULES'));
    f.db.close();
  });

  test('14+15+16. conversion only after approval; stops on disable; resumes on re-enable (exact 12 SET -> 120 EA)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-L1', '2026-01-14', '12', 'SET', '100.00', 'INR');
    const id = proposeScoped(f);
    const p = normalizeQuantity('12', 'SET', f.cmiId);
    assert.equal(p.status, 'UNCONVERTED', 'PENDING: no conversion');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { SET: '12' }, 'PENDING: aggregation unchanged');
    transitionUomRuleLifecycle(id, 'approve', APPROVER);
    const ap = normalizeQuantity('12', 'SET', f.cmiId);
    assert.equal(ap.status, 'SCALED');
    assert.equal(ap.normalizedUom, 'EA');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '120' }, 'APPROVED: 12 SET -> 120 EA');
    transitionUomRuleLifecycle(id, 'disable', APPROVER);
    const dp = normalizeQuantity('12', 'SET', f.cmiId);
    assert.equal(dp.status, 'UNCONVERTED', 'DISABLED: conversion stops');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { SET: '12' }, 'DISABLED: aggregation unchanged');
    transitionUomRuleLifecycle(id, 're-enable', APPROVER);
    const rp = normalizeQuantity('12', 'SET', f.cmiId);
    assert.equal(rp.status, 'SCALED');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '120' }, 'RE-ENABLED: conversion resumes');
    f.db.close();
  });

  test('17. original procurement data untouched by every lifecycle action', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-O1', '2026-01-15', '12', 'SET', '100.00', 'INR');
    const before = rawRecord(f, 'PO-O1');
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', APPROVER);
    transitionUomRuleLifecycle(id, 'disable', APPROVER);
    transitionUomRuleLifecycle(id, 're-enable', APPROVER);
    assert.deepEqual(rawRecord(f, 'PO-O1'), before, 'quantity and UOM verbatim through the whole lifecycle');
    f.db.close();
  });

  test('18. Step 17 regression: system registry untouched, 390 EA example, exact decimals', () => {
    const f = baseFixture();
    assert.deepEqual(
      getUomRuleRegistry().filter((r) => r.isActive).map((r) => `${r.fromUom}>${r.toUom}x${r.factor}`).sort(),
      ['CM>MMx10', 'KG>Gx1000', 'L>MLx1000', 'M>MMx1000', 'NOS>EAx1', 'PCS>EAx1', 'TON>Gx1000000'],
      'seven SYSTEM_DEFINED rules unchanged'
    );
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-A1', '2026-01-16', '120', 'PCS', '10.00', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierB, 'PO-A2', '2026-01-17', '180', 'NOS', '10.00', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierB, 'PO-A3', '2026-01-18', '90', 'EA', '10.00', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-A4', '2026-01-19', '0.25', 'KG', '10.00', 'INR');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '390', G: '250' }, '390 EA + exact 0.25 KG -> 250 G');
    f.db.close();
  });

  test('19. Step 18 regression: precedence + scope isolation intact', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-P1', '2026-01-20', '12', 'SET', '10.00', 'INR');
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', APPROVER);
    const rule = getEffectiveUomRule('SET', f.cmiId);
    assert.ok(rule && rule.ruleType === 'DOMAIN_SPECIFIC', 'domain rule wins in scope');
    assert.equal(getEffectiveUomRule('SET', null), null, 'unscoped resolution never sees the domain rule');
    assert.equal(getEffectiveUomRule('KG', f.cmiId)?.ruleType, 'SCALE', 'system scale rule still applies');
    f.db.close();
  });

  test('20. SQL/service parity with a live APPROVED domain rule', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-V1', '2026-01-21', '12', 'SET', '10.00', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierB, 'PO-V2', '2026-01-22', '3.5', 'SET', '10.00', 'INR');
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', APPROVER);
    const svc = normalizeQuantity('12', 'SET', f.cmiId);
    const sql = getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom;
    assert.equal(svc.rule?.ruleType, 'DOMAIN_SPECIFIC');
    assert.equal(svc.normalizedUom, 'EA');
    assert.ok(sql && 'EA' in sql, 'SQL path converted SET via the approved domain rule');
    assert.equal(sql.EA, '155', '12 + 3.5 SET -> 120 + 35 = 155 EA exact: (1200 + 350) cents x 10');
    f.db.close();
  });

  console.log(`\nStep 19 (UOM rule history & steward governance): ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(failures.map((x) => `  - ${x}`).join('\n'));
    process.exit(1);
  }
}

main();
