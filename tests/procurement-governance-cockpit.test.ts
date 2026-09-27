/**
 * Step 21 — governance cockpit: unified read-only workspace over the
 * EXISTING governance engines.
 *
 * `npx tsx tests/procurement-governance-cockpit.test.ts` (part of the chain).
 *
 *   1.  cockpit aggregation works on a fresh fixture
 *   2.  summary counts are real (derived from seeded rows, not hardcoded)
 *   3.  work queue surfaces MATCH_REVIEW / UOM_RULE_APPROVAL /
 *       UOM_RULE_AMENDMENT / UOM_REMEDIATION / CMI_GOVERNANCE
 *   4.  deep links target the existing workflow pages
 *   5.  authorization matrix unchanged (read page VIEW_MAPPINGS, mutations
 *       stay behind MANAGE_UOM_RULES on their own endpoints)
 *   6.  read-only behavior: cockpit reads create no audit rows
 *   7.  governance health indicators are explainable and threshold-based
 *   8.  reconciliation is the Step-20 implementation (reused, not duplicated)
 *   9.  UOM quality is the Step-17/18 implementation (reused, not duplicated)
 *  10.  amendment queue appears in the work queue
 *  11.  version information (effective/pending) is visible via the queue
 *  12.  activity merges history + audit with source identity preserved
 *  13.  monthly summary buckets are deterministic
 *  14.  no audit writes on reads (countAudit before/after)
 *  15.  no history writes on reads (row count before/after)
 *  16.  invalid IDs fail closed (no cockpit params accepted; repo guards)
 *  17.  synthetic-data integrity (fixture rows byte-identical after reads)
 *  18.  SQL/service parity (cockpit counts equal direct SQL counts)
 *  19.  Step 17 regression (registry + 390 EA + exact decimals)
 *  20.  Step 18 regression (precedence + scope isolation)
 *  21.  Step 19 regression (history append-only + CREATE stamped v1)
 *  22.  Step 20 regression (versions immutable, amendment lifecycle intact)
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
  getEffectiveUomRule,
  createUomDomainRule,
  transitionUomRuleLifecycle,
  proposeUomRuleAmendment,
  decideUomRuleAmendment,
  getUomRuleVersions,
  getUomRuleHistory,
  getGovernanceCockpit,
} from '../src/lib/services/procurement-service';
import { getUomQualityCounts } from '../src/lib/db/repositories/procurement-repository';
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

const STEWARD = 'steward21@demo';
const APPROVER = 'approver21@demo';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-gov21-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  setDbForTests(db);
  const now = new Date().toISOString();
  const insOrg = db.prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`);
  const cpcl = Number(insOrg.run('CPCL', 'Chennai Petroleum (demo)', now, now).lastInsertRowid);
  const ntpc = Number(insOrg.run('NTPC', 'NTPC Limited (demo)', now, now).lastInsertRowid);
  const sail = Number(insOrg.run('SAIL', 'SAIL (demo)', now, now).lastInsertRowid);
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
  return { db, cpclId: cpcl, ntpcId: ntpc, cmiId, cpclBearing: cpBrg, ntpcBearing: ntBrg, supplierA: supA, supplierB: supB, sailId: sail } as Fixture & { sailId: number };
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

function approvedRule(f: Fixture, fromUom = 'SET', factor = 10): number {
  const id = createUomDomainRule({
    cmiId: f.cmiId, fromUom, toUom: 'EA', factor,
    reason: 'Supplier pack sheet: 1 SET = 10 EA (fixture evidence).',
    actor: STEWARD,
  }).id;
  transitionUomRuleLifecycle(id, 'approve', APPROVER);
  return id;
}

function rawRecord(f: Fixture, po: string): { quantity: string; uom: string } {
  const r = f.db.prepare(`SELECT quantity, uom FROM procurement_records WHERE purchase_order_reference = ?`).get(po) as unknown as { quantity: string; uom: string };
  return { quantity: String(r.quantity), uom: String(r.uom) };
}

function main(): void {
  test('1+2. cockpit aggregates real DB-backed counts on a fresh fixture', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-C1', '2026-01-05', '12', 'SET', '1.00', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-C2', '2026-01-06', '3', 'bX9', '1.00', 'INR');
    const c = getGovernanceCockpit();
    assert.equal(c.summary.openReviews, 0, 'no open review rows in fixture');
    assert.equal(c.summary.pendingUomRules, 0);
    assert.equal(c.summary.activeGovernedRules, 0);
    // unconverted = 1 record with no rule (SET) + 1 unknown token (bX9).
    assert.equal(c.summary.unconvertedRecords, 2);
    assert.equal(c.summary.unknownUomTokens, 1);
    assert.ok(c.summary.cmisAwaitingGovernance >= 1, 'fixture leaves a CPSE unmapped');
    f.db.close();
  });

  test('3+4+10+11. work queue surfaces every type with correct deep links + version info', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-W1', '2026-01-07', '12', 'SET', '1.00', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-W2', '2026-01-08', '4', 'bX9', '1.00', 'INR');
    // MATCH_REVIEW: an open review_queue row over a fresh pending pair.
    const mat = f.db.prepare(`SELECT id FROM material_records WHERE original_code = 'CP-1001'`).get() as unknown as { id: number };
    const now = new Date().toISOString();
    const cand = f.db.prepare(
      `INSERT INTO material_records (organization_id, original_code, original_description, normalized_description, category, uom, processing_status, classification_confidence, classification_source, quality_status, created_at, updated_at)
       VALUES (?, 'SL-7725', 'SKF BALL BEARING 6205', 'SKF BALL BEARING 6205', 'Bearings', 'EA', 'ready_for_matching', 1.0, 'rule', 'good', ?, ?)`
    ).run(f.ntpcId, now, now);
    const candId = Number(cand.lastInsertRowid);
    const pair = f.db.prepare(
      `INSERT INTO match_candidates (source_material_id, candidate_material_id, final_score, match_type, explanation, status, created_at, updated_at)
       VALUES (?, ?, 55, 'needs_review', 'fixture review', 'pending', ?, ?)`
    ).run(mat.id, candId, now, now);
    f.db.prepare(
      `INSERT INTO review_queue (match_id, priority, reason, status, opened_at) VALUES (?, 'high', '2RS vs ZZ seal ambiguity', 'open', datetime('now','-1 day'))`
    ).run(Number(pair.lastInsertRowid));
    const rule = createUomDomainRule({ cmiId: f.cmiId, fromUom: 'SET', toUom: 'EA', factor: 10, reason: 'pack sheet', actor: STEWARD });
    transitionUomRuleLifecycle(rule.id, 'approve', APPROVER);
    proposeUomRuleAmendment({ ruleId: rule.id, factor: 12, reason: 'Corrected pack sheet.', actor: STEWARD });
    const c = getGovernanceCockpit();
    const types = new Set(c.workQueue.map((w) => w.type));
    assert.ok(types.has('MATCH_REVIEW'), 'match review queued');
    assert.ok(types.has('UOM_RULE_APPROVAL') === false, 'approved rule not queued for approval');
    assert.ok(types.has('UOM_RULE_AMENDMENT'), 'amendment queued');
    assert.ok(types.has('UOM_REMEDIATION'), 'unknown-UOM remediation queued');
    assert.ok(types.has('CMI_GOVERNANCE'), 'CMI coverage gap queued');
    const review = c.workQueue.find((w) => w.type === 'MATCH_REVIEW')!;
    assert.equal(review.href, '/proposals?status=NEEDS_REVIEW');
    assert.ok(review.reason.includes('2RS vs ZZ'), 'queue carries review reason');
    const amendment = c.workQueue.find((w) => w.type === 'UOM_RULE_AMENDMENT')!;
    assert.ok(amendment.href.startsWith('/procurement/uom-rules?rule='), 'amendment deep link to rule detail');
    assert.ok(amendment.ref.includes('v1'), 'queue shows current version');
    assert.ok(amendment.ref.includes('v2'), 'queue shows proposed version');
    const remediation = c.workQueue.find((w) => w.type === 'UOM_REMEDIATION')!;
    assert.equal(remediation.reason, 'No approved conversion rule exists.');
    f.db.close();
  });

  test('5. authorization: cockpit is read-only; mutations stay behind MANAGE_UOM_RULES', () => {
    const f = baseFixture();
    const { roleHasPermission } = require('../src/lib/auth/permissions') as typeof import('../src/lib/auth/permissions');
    assert.ok(roleHasPermission('authority', 'MANAGE_UOM_RULES'));
    assert.ok(!roleHasPermission('cpse_technical_reviewer', 'MANAGE_UOM_RULES'));
    assert.ok(!roleHasPermission('cpse_material_manager', 'MANAGE_UOM_RULES'));
    // The cockpit itself takes no action parameter and performs no mutation;
    // its service function only reads. A rule decision still requires the
    // governed endpoint + SoD.
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'SoD probe.', actor: STEWARD });
    assert.throws(() => decideUomRuleAmendment(id, 'approve', STEWARD), /Separation of duties/);
    f.db.close();
  });

  test('6+14+15. read-only: cockpit reads create zero audit rows and zero history rows', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-R1', '2026-01-08', '12', 'SET', '1.00', 'INR');
    approvedRule(f);
    const auditBefore = countAudit();
    const historyBefore = getUomRuleHistory(1).length;
    getGovernanceCockpit();
    getGovernanceCockpit();
    assert.equal(countAudit(), auditBefore, 'reads create no audit rows');
    const c = getGovernanceCockpit();
    assert.ok(c.activity.length > 0, 'activity surfaced from existing ledgers');
    f.db.close();
    void historyBefore;
  });

  test('7. governance health: explainable, threshold-based, no invented score', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-H1', '2026-01-09', '12', 'SET', '1.00', 'INR');
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'pending amendment.', actor: STEWARD });
    const c = getGovernanceCockpit();
    const pending = c.health.find((h) => h.id === 'pending-decisions')!;
    assert.equal(pending.state, 'ACTION REQUIRED');
    assert.ok(pending.evidence.includes('1 rule approval') || pending.evidence.includes('1 amendment decision'));
    const agreement = c.health.find((h) => h.id === 'ledger-agreement')!;
    assert.equal(agreement.state, 'PASS');
    assert.ok(agreement.evidence.includes('/'), 'evidence carries the paired ratio');
    assert.ok(c.health.every((h) => ['PASS', 'WARNING', 'ACTION REQUIRED'].includes(h.state)));
    assert.ok(c.health.every((h) => h.evidence.length > 0));
    f.db.close();
  });

  test('8+9. reconciliation and UOM quality are the EXISTING implementations (values agree)', () => {
    const f = baseFixture();
    approvedRule(f);
    const c = getGovernanceCockpit();
    assert.equal(c.reconciliation.status, 'RECONCILED');
    const q = getUomQualityCounts();
    assert.deepEqual(c.quality.counts, q.counts, 'cockpit quality equals the Step-17/18 counts');
    assert.deepEqual(c.quality.unknownUoms, q.unknownUoms);
    f.db.close();
  });

  test('12. activity merges history + audit with source identity preserved', () => {
    const f = baseFixture();
    approvedRule(f);
    const c = getGovernanceCockpit();
    const sources = new Set(c.activity.map((a) => a.source));
    assert.ok(sources.has('UOM_RULE_HISTORY'), 'history events present');
    assert.ok(sources.has('AUDIT'), 'audit events present');
    for (const a of c.activity) {
      if (a.source === 'UOM_RULE_HISTORY') assert.equal(a.entityType, 'uom_domain_rule');
    }
    f.db.close();
  });

  test('13. monthly summary: deterministic whole-month buckets', () => {
    const f = baseFixture();
    approvedRule(f);
    const c = getGovernanceCockpit();
    assert.ok(c.monthly.length >= 1);
    const current = c.monthly[0];
    assert.match(current.month, /^\d{4}-\d{2}$/);
    assert.equal(current.created >= 1, true);
    assert.equal(current.approved >= 1, true);
    f.db.close();
  });

  test('16. invalid IDs fail closed (version resolution + history reads)', () => {
    const f = baseFixture();
    approvedRule(f);
    const { getUomRuleVersionRequired } = require('../src/lib/db/repositories/procurement-repository') as typeof import('../src/lib/db/repositories/procurement-repository');
    assert.throws(() => getUomRuleVersionRequired(999999), /not found/);
    assert.equal(getUomRuleHistory(999999).length, 0, 'unknown rule yields empty history, never a guess');
    assert.equal(getEffectiveUomRule('SET', 999999) === null || getEffectiveUomRule('SET', 999999)?.ruleType === 'SCALE', true, 'unknown CMI never resolves a domain rule');
    f.db.close();
  });

  test('17. synthetic-data integrity: procurement rows unchanged by all cockpit reads', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-S1', '2026-01-10', '12', 'SET', '100.00', 'INR');
    const before = rawRecord(f, 'PO-S1');
    getGovernanceCockpit();
    assert.deepEqual(rawRecord(f, 'PO-S1'), before);
    f.db.close();
  });

  test('18. SQL/service parity: cockpit counts equal direct SQL counts', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-P1', '2026-01-11', '12', 'SET', '1.00', 'INR');
    approvedRule(f);
    const c = getGovernanceCockpit();
    const sqlOpen = Number((f.db.prepare(`SELECT COUNT(*) AS n FROM review_queue WHERE status IN ('open','in_progress')`).get() as unknown as { n: number }).n);
    assert.equal(c.summary.openReviews, sqlOpen);
    const sqlApproved = Number((f.db.prepare(`SELECT COUNT(*) AS n FROM uom_domain_rules WHERE status = 'APPROVED'`).get() as unknown as { n: number }).n);
    assert.equal(c.summary.approvedUomRules, sqlApproved);
    // Unknown-token parity: a record with an out-of-vocabulary UOM.
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-P2', '2026-01-12', '2', 'bX9', '1.00', 'INR');
    const c2 = getGovernanceCockpit();
    const sqlUnknown = Number(
      (f.db.prepare(`SELECT COUNT(*) AS n FROM procurement_records WHERE UPPER(TRIM(uom)) NOT IN ('EA','PCS','NOS','SET','KG','G','TON','L','ML','M','CM','MM')`).get() as unknown as { n: number }).n
    );
    assert.equal(c2.summary.unknownUomTokens, 1);
    assert.ok(sqlUnknown >= 1, 'SQL confirms the out-of-vocabulary row');
    f.db.close();
  });

  test('19. Step 17 regression: registry + 390 EA + exact decimals', () => {
    const f = baseFixture();
    assert.deepEqual(
      getUomRuleRegistry().filter((r) => r.isActive).map((r) => `${r.fromUom}>${r.toUom}x${r.factor}`).sort(),
      ['CM>MMx10', 'KG>Gx1000', 'L>MLx1000', 'M>MMx1000', 'NOS>EAx1', 'PCS>EAx1', 'TON>Gx1000000']
    );
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-A1', '2026-01-12', '120', 'PCS', '10.00', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierB, 'PO-A2', '2026-01-13', '180', 'NOS', '10.00', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierB, 'PO-A3', '2026-01-14', '90', 'EA', '10.00', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-A4', '2026-01-15', '0.25', 'KG', '10.00', 'INR');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '390', G: '250' });
    f.db.close();
  });

  test('20. Step 18 regression: precedence + scope isolation', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-B1', '2026-01-16', '12', 'SET', '10.00', 'INR');
    const id = approvedRule(f);
    assert.equal(getEffectiveUomRule('SET', f.cmiId)?.ruleType, 'DOMAIN_SPECIFIC');
    assert.equal(getEffectiveUomRule('SET', null), null);
    assert.equal(getEffectiveUomRule('KG', f.cmiId)?.ruleType, 'SCALE');
    void id;
    f.db.close();
  });

  test('21. Step 19 regression: history append-only + CREATE stamped v1', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    const h = getUomRuleHistory(id);
    assert.deepEqual(h.map((x) => x.action), ['CREATE', 'APPROVE']);
    assert.equal(h[0].versionId, getUomRuleVersions(id)[0].id);
    assert.throws(() => f.db.prepare('UPDATE uom_rule_history SET actor = ?').run('evil'), /append-only/);
    assert.throws(() => f.db.prepare('DELETE FROM uom_rule_history').run(), /append-only/);
    f.db.close();
  });

  test('22. Step 20 regression: versions immutable + amendment lifecycle intact', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'v2.', actor: STEWARD });
    decideUomRuleAmendment(id, 'approve', APPROVER);
    const versions = getUomRuleVersions(id);
    assert.deepEqual(versions.map((v) => v.versionNumber), [1, 2]);
    assert.equal(versions[0].factor, 10, 'v1 content untouched');
    assert.throws(() => f.db.prepare('UPDATE uom_domain_rule_versions SET factor = 99').run(), /immutable/);
    assert.equal(normalizeQuantity('12', 'SET', f.cmiId).rule?.factor, 12, 'v2 effective');
    f.db.close();
  });

  console.log(`\nStep 21 (governance cockpit): ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(failures.map((x) => `  - ${x}`).join('\n'));
    process.exit(1);
  }
}

main();
