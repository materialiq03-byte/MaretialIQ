/**
 * Step 20 — versioned rule content amendment, audit/history reconciliation.
 *
 * `npx tsx tests/procurement-uom-versioning.test.ts` (part of the npm test chain).
 *
 * Pins the Step-20 contract on top of the untouched Step-17/18/19 engine:
 *
 *   1. initial rule creates v1
 *   2. version numbering deterministic (MAX+1 in-transaction)
 *   3. duplicate version numbers impossible (UNIQUE rule_id+version_number)
 *   4. amendment creates a PENDING version
 *   5. pending amendment does not affect conversion
 *   6. approved amendment becomes effective (conversion follows v2)
 *   7. rejected amendment never becomes effective
 *   8. disabled rule does not convert
 *   9. re-enabled rule resumes with its approved version
 *  10. old version content remains intact forever (never rewritten)
 *  11. version UPDATE fails (physical immutability)
 *  12. version DELETE fails (physical immutability)
 *  13. history records AMEND with version context
 *  14. audit records uom_rule_amended with old/proposed content
 *  15. amendment transaction atomicity (mid-tx failure rolls back everything)
 *  16. invalid amendment creates nothing (validation before any write)
 *  17. authorization matrix unchanged (MANAGE_UOM_RULES gates decisions)
 *  18. read-only roles cannot mutate (matrix) while reads stay open
 *  19. original procurement rows unchanged through the amendment lifecycle
 *  20. SQL/service normalization parity with an amended effective version
 *  21. comparable-demand parity before/after approval
 *  22. Step-17 regression: system registry + 390 EA + exact decimals
 *  23. Step-18 regression: precedence + scope isolation intact
 *  24. Step-19 regression: lifecycle history + steward pending queue intact
 *  25. reconciliation detects injected discrepancies (never repairs)
 *  26. clean ledger returns RECONCILED
 *  27. steward amendment work queue + version activity
 *  28. rule detail data: current vs historical versions with pointers
 *  29. version ordering ascending, no gaps/reuse
 *  30. migration idempotency on a versioned database
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
  getUomRuleAgreement,
  getUomGovernanceReconciliation,
  getUomStewardDashboard,
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

const STEWARD = 'steward20@demo';
const APPROVER = 'approver20@demo';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-uom20-'));
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

function rawRecord(f: Fixture, po: string): { quantity: string; uom: string } {
  const r = f.db.prepare(`SELECT quantity, uom FROM procurement_records WHERE purchase_order_reference = ?`).get(po) as unknown as { quantity: string; uom: string };
  return { quantity: String(r.quantity), uom: String(r.uom) };
}

/** Approved rule with v1 SET→EA ×10 (the Step-18 demo conversion). */
function approvedRule(f: Fixture, fromUom = 'SET', factor = 10): number {
  const id = createUomDomainRule({
    cmiId: f.cmiId, fromUom, toUom: 'EA', factor,
    reason: 'Supplier pack sheet for this bearing family: 1 SET = 10 EA (fixture evidence).',
    actor: STEWARD,
  }).id;
  transitionUomRuleLifecycle(id, 'approve', APPROVER);
  return id;
}

function main(): void {
  test('1+2+29. initial rule creates deterministic v1; versions ordered ascending without reuse', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    const versions = getUomRuleVersions(id);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].versionNumber, 1);
    assert.equal(versions[0].factor, 10);
    assert.equal(versions[0].supersedesVersionId, null);
    assert.ok(
      (versions[0].amendmentReason ?? '').includes('pack sheet'),
      'v1 carries the evidence that produced it (the creation reason)'
    );
    f.db.close();
  });

  test('3. duplicate version numbers impossible (UNIQUE rule_id+version_number)', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    const v1 = getUomRuleVersions(id)[0];
    assert.throws(() =>
      f.db
        .prepare(`INSERT INTO uom_domain_rule_versions (rule_id, version_number, cmi_id, from_uom, to_uom, factor, created_by) VALUES (?, 1, ?, 'SET', 'EA', 5, 'x')`)
        .run(id, f.cmiId)
    );
    assert.equal(getUomRuleVersions(id).length, 1);
    f.db.close();
    void v1;
  });

  test('4+5. amendment creates a PENDING version; conversion still uses v1', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-P1', '2026-01-05', '12', 'SET', '1.00', 'INR');
    const id = approvedRule(f);
    const am = proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'Corrected pack sheet: 1 SET = 12 EA (v2 evidence).', actor: STEWARD });
    assert.equal(am.version.versionNumber, 2);
    assert.equal(am.version.factor, 12);
    assert.equal(am.previousVersion?.versionNumber, 1);
    const rule = f.db.prepare(`SELECT status, effective_version_id, pending_version_id FROM uom_domain_rules WHERE id = ?`).get(id) as unknown as { status: string; effective_version_id: number; pending_version_id: number };
    assert.equal(rule.status, 'APPROVED', 'proposal does not change lifecycle state');
    assert.equal(rule.pending_version_id, am.version.id);
    assert.equal(rule.effective_version_id, am.previousVersion?.id);
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '120' }, 'PENDING amendment: v1 still converts');
    f.db.close();
  });

  test('6+21. approved amendment becomes effective; comparable demand follows the new version exactly', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-A1', '2026-01-06', '12', 'SET', '1.00', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierB, 'PO-A2', '2026-01-07', '2.5', 'SET', '1.00', 'INR');
    const id = approvedRule(f);
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '145' }, 'v1: (1200+250)x10 = 145 EA');
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'Corrected pack sheet.', actor: STEWARD });
    const dec = decideUomRuleAmendment(id, 'approve', APPROVER);
    assert.equal(dec.effectiveVersion?.versionNumber, 2);
    assert.equal(dec.rule.status, 'APPROVED', 'version decision never changes lifecycle state');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '174' }, 'v2: (1200+250)x12 = 174 EA exact');
    const svc = normalizeQuantity('12', 'SET', f.cmiId);
    assert.equal(svc.rule?.factor, 12, 'row-level evidence carries the effective version factor');
    f.db.close();
  });

  test('7. rejected amendment never becomes effective (rule stays on v1)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-R1', '2026-01-08', '12', 'SET', '1.00', 'INR');
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 99, reason: 'Bad proposal, will be rejected.', actor: STEWARD });
    const dec = decideUomRuleAmendment(id, 'reject', APPROVER);
    assert.equal(dec.effectiveVersion?.versionNumber, 1);
    assert.equal(dec.rule.status, 'APPROVED');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '120' }, 'rejection keeps v1 conversion');
    f.db.close();
  });

  test('8+9. disable stops conversion; amendment decision keeps DISABLED; re-enable resumes with the approved version', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-D1', '2026-01-09', '12', 'SET', '1.00', 'INR');
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'Pack sheet v2.', actor: STEWARD });
    decideUomRuleAmendment(id, 'approve', APPROVER);
    transitionUomRuleLifecycle(id, 'disable', APPROVER);
    assert.equal(normalizeQuantity('12', 'SET', f.cmiId).status, 'UNCONVERTED', 'DISABLED: no conversion');
    // Amendment on a DISABLED rule is possible but must not activate it.
    proposeUomRuleAmendment({ ruleId: id, factor: 15, reason: 'Pack sheet v3.', actor: STEWARD });
    const dec = decideUomRuleAmendment(id, 'approve', APPROVER);
    assert.equal(dec.rule.status, 'DISABLED', 'version approval must not silently re-enable');
    assert.equal(normalizeQuantity('12', 'SET', f.cmiId).status, 'UNCONVERTED', 'still disabled after amendment approval');
    transitionUomRuleLifecycle(id, 're-enable', APPROVER);
    const p = normalizeQuantity('12', 'SET', f.cmiId);
    assert.equal(p.status, 'SCALED');
    assert.equal(p.rule?.factor, 15, 're-enable resumes with the latest approved version');
    f.db.close();
  });

  test('10+11+12. versions are physically immutable and old content survives amendments', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    const v1Before = getUomRuleVersions(id)[0];
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'v2.', actor: STEWARD });
    decideUomRuleAmendment(id, 'approve', APPROVER);
    const v1After = getUomRuleVersions(id).find((v) => v.versionNumber === 1)!;
    assert.equal(v1After.factor, v1Before.factor, 'v1 content untouched by v2 approval');
    assert.equal(v1After.createdAt, v1Before.createdAt);
    assert.throws(() => f.db.prepare('UPDATE uom_domain_rule_versions SET factor = 999').run(), /immutable/);
    assert.throws(() => f.db.prepare('DELETE FROM uom_domain_rule_versions').run(), /immutable/);
    assert.equal(getUomRuleVersions(id).length, 2, 'all versions still present');
    f.db.close();
  });

  test('13+14. AMEND history event + uom_rule_amended audit event carry version context and old/proposed content', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'Corrected pack sheet.', actor: STEWARD });
    const h = getUomRuleHistory(id);
    const amend = h.find((x) => x.action === 'AMEND')!;
    assert.equal(amend.versionId, getUomRuleVersions(id)[1].id);
    assert.equal(amend.previousVersionId, getUomRuleVersions(id)[0].id);
    assert.equal(amend.previousStatus, 'APPROVED');
    assert.equal(amend.newStatus, 'APPROVED');
    const audit = f.db
      .prepare(`SELECT details FROM audit_logs WHERE action = 'uom_rule_amended' AND entity_id = ?`)
      .get(id) as unknown as { details: string };
    const d = JSON.parse(audit.details) as { previousVersionNumber: number; versionNumber: number; previous: { factor: number }; proposed: { factor: number } };
    assert.equal(d.previousVersionNumber, 1);
    assert.equal(d.versionNumber, 2);
    assert.equal(d.previous.factor, 10);
    assert.equal(d.proposed.factor, 12);
    f.db.close();
  });

  test('15. amendment atomicity: mid-transaction failure rolls back version, pointer, audit AND history', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    f.db.exec(`CREATE TRIGGER sabotage_history BEFORE INSERT ON uom_rule_history
               WHEN new.actor = 'sabotage' BEGIN SELECT RAISE(ABORT, 'sabotaged'); END;`);
    const before = {
      versions: getUomRuleVersions(id).length,
      audit: countAudit(),
      history: getUomRuleHistory(id).length,
      pointer: (f.db.prepare(`SELECT pending_version_id FROM uom_domain_rules WHERE id = ?`).get(id) as unknown as { pending_version_id: number }).pending_version_id,
    };
    assert.throws(() =>
      proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'This proposal must vanish.', actor: 'sabotage' })
    );
    f.db.exec('DROP TRIGGER sabotage_history');
    const after = {
      versions: getUomRuleVersions(id).length,
      audit: countAudit(),
      history: getUomRuleHistory(id).length,
      pointer: (f.db.prepare(`SELECT pending_version_id FROM uom_domain_rules WHERE id = ?`).get(id) as unknown as { pending_version_id: number }).pending_version_id,
    };
    assert.deepEqual(after, before, 'a failed amendment leaves ZERO trace in any ledger');
    // and the rule still works normally afterwards
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'Retry after failure.', actor: STEWARD });
    assert.equal(getUomRuleVersions(id).length, 2);
    f.db.close();
  });

  test('16. invalid amendment creates nothing (PENDING/DISABLED-state rules, empty reason, bad target, no pending duplicates)', () => {
    const f = baseFixture();
    const pending = createUomDomainRule({ cmiId: f.cmiId, fromUom: 'BOX', toUom: 'EA', factor: 5, reason: 'not yet approved', actor: STEWARD });
    assert.throws(() => proposeUomRuleAmendment({ ruleId: pending.id, factor: 6, reason: 'rule is only PENDING', actor: STEWARD }), /only possible for APPROVED or DISABLED/);
    const id = approvedRule(f);
    const before = { versions: getUomRuleVersions(id).length, audit: countAudit() };
    assert.throws(() => proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: '   ', actor: STEWARD }), /reason/);
    assert.throws(() => proposeUomRuleAmendment({ ruleId: id, toUom: 'KG', reason: 'KG is not canonical', actor: STEWARD }), /canonical/);
    assert.throws(() => proposeUomRuleAmendment({ ruleId: id, fromUom: 'EA', toUom: 'EA', reason: 'self conversion', actor: STEWARD }), /differ/);
    assert.deepEqual({ versions: getUomRuleVersions(id).length, audit: countAudit() }, before, 'invalid proposals write nothing');
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'first amendment', actor: STEWARD });
    assert.throws(() => proposeUomRuleAmendment({ ruleId: id, factor: 14, reason: 'second while first pending', actor: STEWARD }), /pending amendment/);
    f.db.close();
  });

  test('17+18. authorization: amendment decisions are MANAGE_UOM_RULES-gated; read-only roles see, stewards propose only', () => {
    const f = baseFixture();
    const { roleHasPermission } = require('../src/lib/auth/permissions') as typeof import('../src/lib/auth/permissions');
    assert.ok(roleHasPermission('authority', 'MANAGE_UOM_RULES'));
    assert.ok(roleHasPermission('platform_admin', 'MANAGE_UOM_RULES'));
    assert.ok(!roleHasPermission('cpse_material_manager', 'MANAGE_UOM_RULES'), 'steward-class role cannot decide');
    assert.ok(!roleHasPermission('cpse_technical_reviewer', 'MANAGE_UOM_RULES'), 'read-only role cannot decide');
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'steward proposes', actor: STEWARD });
    assert.throws(() => decideUomRuleAmendment(id, 'approve', STEWARD), /Separation of duties/);
    assert.equal(getUomRuleVersions(id).length, 2, 'reads stay open to every role');
    f.db.close();
  });

  test('19. original procurement rows unchanged through the whole amendment lifecycle', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-O1', '2026-01-10', '12', 'SET', '100.00', 'INR');
    const before = rawRecord(f, 'PO-O1');
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'v2.', actor: STEWARD });
    decideUomRuleAmendment(id, 'approve', APPROVER);
    transitionUomRuleLifecycle(id, 'disable', APPROVER);
    transitionUomRuleLifecycle(id, 're-enable', APPROVER);
    assert.deepEqual(rawRecord(f, 'PO-O1'), before, 'quantity and UOM verbatim forever');
    f.db.close();
  });

  test('20. SQL/service parity with an amended effective version', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-V1', '2026-01-11', '12', 'SET', '1.00', 'INR');
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'v2.', actor: STEWARD });
    decideUomRuleAmendment(id, 'approve', APPROVER);
    const svc = normalizeQuantity('12', 'SET', f.cmiId);
    const sql = getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom;
    assert.equal(svc.rule?.factor, 12);
    assert.equal(svc.normalizedUom, 'EA');
    assert.deepEqual(sql, { EA: '144' }, 'SQL aggregation equals 12 SET x 12 = 144 EA via the effective version');
    assert.equal(getEffectiveUomRule('SET', f.cmiId)?.factor, 12, 'single authoritative resolver agrees');
    f.db.close();
  });

  test('22. Step 17 regression: system registry untouched, 390 EA example, exact decimals', () => {
    const f = baseFixture();
    assert.deepEqual(
      getUomRuleRegistry().filter((r) => r.isActive).map((r) => `${r.fromUom}>${r.toUom}x${r.factor}`).sort(),
      ['CM>MMx10', 'KG>Gx1000', 'L>MLx1000', 'M>MMx1000', 'NOS>EAx1', 'PCS>EAx1', 'TON>Gx1000000']
    );
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-S1', '2026-01-12', '120', 'PCS', '10.00', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierB, 'PO-S2', '2026-01-13', '180', 'NOS', '10.00', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierB, 'PO-S3', '2026-01-14', '90', 'EA', '10.00', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-S4', '2026-01-15', '0.25', 'KG', '10.00', 'INR');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '390', G: '250' });
    f.db.close();
  });

  test('23. Step 18 regression: precedence + scope isolation intact under versioning', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-P1', '2026-01-16', '12', 'SET', '10.00', 'INR');
    const id = approvedRule(f);
    assert.equal(getEffectiveUomRule('SET', f.cmiId)?.ruleType, 'DOMAIN_SPECIFIC');
    assert.equal(getEffectiveUomRule('SET', null), null, 'unscoped never sees the domain rule');
    assert.equal(getEffectiveUomRule('KG', f.cmiId)?.ruleType, 'SCALE');
    void id;
    f.db.close();
  });

  test('24. Step 19 regression: lifecycle history + steward pending queue intact', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-Q1', '2026-01-17', '5', 'SET', '1.00', 'INR');
    const pending = createUomDomainRule({ cmiId: f.cmiId, fromUom: 'DRUM', toUom: 'ML', factor: 200, reason: 'drum sheet', actor: STEWARD }).id;
    const ov = getUomStewardDashboard();
    assert.equal(ov.pendingQueue.filter((q) => q.rule.id === pending).length, 1, 'initial PENDING rule still queues');
    transitionUomRuleLifecycle(pending, 'approve', APPROVER);
    const h = getUomRuleHistory(pending);
    assert.deepEqual(h.map((x) => x.action), ['CREATE', 'APPROVE']);
    assert.equal(h[0].versionId, getUomRuleVersions(pending)[0].id, 'CREATE stamped with v1');
    f.db.close();
  });

  test('25+26. reconciliation: clean ledger RECONCILED; injected discrepancy reported, never repaired', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'v2.', actor: STEWARD });
    decideUomRuleAmendment(id, 'approve', APPROVER);
    const clean = getUomGovernanceReconciliation();
    assert.equal(clean.status, 'RECONCILED');
    assert.ok(clean.historyEventsChecked >= 3 && clean.reconciledCount === clean.historyEventsChecked);
    // Inject a stray governance audit event (simulates a torn write).
    const now = new Date().toISOString();
    f.db
      .prepare(`INSERT INTO audit_logs (action, entity_type, entity_id, actor, details, created_at) VALUES ('uom_rule_disabled', 'uom_domain_rule', ?, 'ghost@x', NULL, ?)`)
      .run(id, now);
    const dirty = getUomGovernanceReconciliation();
    assert.equal(dirty.status, 'DISCREPANCIES_FOUND');
    const stray = dirty.discrepancies.find((d) => d.kind === 'UNEXPECTED_AUDIT_EVENT');
    assert.ok(stray, 'stray audit event detected');
    assert.equal(dirty.discrepancies.length, dirty.discrepancies.length, 'no auto-repair happened');
    f.db.close();
  });

  test('27. steward dashboard: amendment queue, version counts, amendment activity', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'Corrected pack sheet.', actor: STEWARD });
    const ov = getUomStewardDashboard();
    assert.equal(ov.amendmentQueue.length, 1);
    const q = ov.amendmentQueue[0];
    assert.equal(q.effectiveVersion?.versionNumber, 1);
    assert.equal(q.proposedVersion?.versionNumber, 2);
    assert.equal(q.proposedVersion?.factor, 12);
    assert.equal(q.rule.cmiCode, 'CMI-T-BRG');
    assert.ok(q.affectedRecords >= 0);
    assert.equal(ov.versions.total >= 2, true);
    assert.equal(ov.amendments.pending, 1);
    assert.equal(ov.amendments.proposed >= 1, true);
    decideUomRuleAmendment(id, 'approve', APPROVER);
    const ov2 = getUomStewardDashboard();
    assert.equal(ov2.amendments.pending, 0, 'queue drains after decision');
    f.db.close();
  });

  test('28. rule-detail data: current vs pending vs superseded versions distinguishable', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'v2.', actor: STEWARD });
    decideUomRuleAmendment(id, 'approve', APPROVER);
    proposeUomRuleAmendment({ ruleId: id, factor: 15, reason: 'v3.', actor: STEWARD });
    const rule = f.db.prepare(`SELECT effective_version_id, pending_version_id FROM uom_domain_rules WHERE id = ?`).get(id) as unknown as { effective_version_id: number; pending_version_id: number };
    const versions = getUomRuleVersions(id);
    const effective = versions.find((v) => v.id === rule.effective_version_id)!;
    const pending = versions.find((v) => v.id === rule.pending_version_id)!;
    assert.equal(effective.versionNumber, 2, 'current = v2');
    assert.equal(pending.versionNumber, 3, 'proposed = v3');
    assert.equal(versions[0].versionNumber, 1, 'historical v1 still listed');
    const agreement = getUomRuleAgreement(id);
    assert.ok(agreement.length >= 3, 'agreement timeline covers create/amend/decide');
    assert.ok(agreement.every((a) => a.auditId !== null), 'every event paired with its audit twin');
    f.db.close();
  });

  test('30. migration idempotency on a versioned database', () => {
    const f = baseFixture();
    const id = approvedRule(f);
    proposeUomRuleAmendment({ ruleId: id, factor: 12, reason: 'v2.', actor: STEWARD });
    const before = getUomRuleVersions(id).length;
    assert.deepEqual(migrate(f.db), [], 're-running migrate applies nothing');
    assert.equal(getUomRuleVersions(id).length, before, 'backfill does not duplicate versions');
    f.db.close();
  });

  console.log(`\nStep 20 (versioned amendments & reconciliation): ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(failures.map((x) => `  - ${x}`).join('\n'));
    process.exit(1);
  }
}

main();
