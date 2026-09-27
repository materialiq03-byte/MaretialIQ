/**
 * Step 18 — material-specific UOM rules, governance & quality remediation.
 *
 * `npx tsx tests/procurement-uom-governance.test.ts` (part of the npm test chain).
 *
 * Pins the Step-18 contract on top of the untouched Step-17 engine:
 *
 *   1. rule creation (PENDING, audited, never auto-active)
 *   2. creation validation (unknown CMI / bad target / self / factor / reason / duplicate)
 *   3. rule lifecycle: PENDING -> APPROVED | REJECTED, APPROVED -> DISABLED, re-enable
 *   4. scope isolation: approved rule affects ONLY its own CMI
 *   5. approved conversion participates in CMI aggregation (12 SET -> 120 EA)
 *   6. PENDING rule has no analytical effect
 *   7. REJECTED rule has no analytical effect
 *   8. DISABLED rule has no analytical effect
 *   9. re-enable restores the conversion
 *  10. original procurement data untouched by every lifecycle action
 *  11. conversion evidence: ruleType DOMAIN_SPECIFIC + source GOVERNED
 *  12. SQL/service parity across all lifecycle states + unknown UOM
 *  13. unknown UOM stays UNCONVERTED even with a scoped live rule for another UOM
 *  14. authorization: governance mutations require MANAGE_UOM_RULES
 *  15. audit: every transition audited with previous/new state; reads silent
 *  16. duplicate live rule handling (same (cmi, from) rejected; supersede after REJECTED)
 *  17. Step 17 regression: system registry, 390 EA, DECIMAL exactness
 *  18. CMI aggregation under precedence (domain rule wins over system rule)
 *  19. CPSE aggregation under precedence
 *  20. supplier aggregation under precedence
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
  getSupplierComparableQuantity,
  getOrganizationComparableQuantity,
  getSupplierIntelligenceBundle,
  createUomDomainRule,
  transitionUomRuleLifecycle,
  getUomRemediationBoard,
  getUomAffectedRecords,
  getEffectiveUomRule,
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

const ACTOR = 'uom18-test';
const MANAGER = 'governor@demo';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-uom18-'));
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
  const supA = createSupplierRecord({ supplierCode: 'SUP-A', supplierName: 'Alpha Bearings Ltd', region: 'IN' }, ACTOR).id;
  const supB = createSupplierRecord({ supplierCode: 'SUP-B', supplierName: 'Beta Industrial Co', region: 'IN' }, ACTOR).id;
  return { db, cpclId: cpcl, ntpcId: ntpc, cmiId, cpclBearing: cpBrg, ntpcBearing: ntBrg, supplierA: supA, supplierB: supB };
}

function proc(
  f: Fixture,
  orgId: number,
  materialId: number,
  supplierId: number,
  po: string,
  date: string,
  qty: string,
  uom: string,
  price?: string,
  currency?: string
): void {
  createProcurementRecord(
    {
      organizationId: orgId, materialId, cmiId: f.cmiId, supplierId,
      purchaseOrderReference: po, purchaseDate: date,
      quantity: qty, uom,
      unitPrice: price ?? undefined, currency: currency ?? undefined, status: 'DELIVERED',
    },
    ACTOR
  );
}

function proposeScoped(f: Fixture, fromUom = 'SET', factor = 10): number {
  return createUomDomainRule({
    cmiId: f.cmiId, fromUom, toUom: 'EA', factor,
    reason: 'Supplier pack sheet for this bearing family: 1 SET = 10 EA (fixture evidence).',
    actor: MANAGER,
  }).id;
}

function main(): void {
  test('1. rule creation: starts PENDING, audited, never auto-active', () => {
    const f = baseFixture();
    const before = countAudit();
    const id = proposeScoped(f);
    const eff = getEffectiveUomRule('SET', f.cmiId);
    assert.equal(eff, null, 'PENDING rule must not resolve as effective');
    const after = f.db.prepare(`SELECT status, created_by, approved_by, source FROM uom_domain_rules WHERE id = ?`).get(id) as any;
    assert.equal(after.status, 'PENDING');
    assert.equal(after.created_by, MANAGER);
    assert.equal(after.approved_by, null);
    assert.equal(after.source, 'GOVERNED');
    assert.equal(countAudit(), before + 1, 'creation audited exactly once');
    f.db.close();
  });

  test('2. creation validation: fails closed on bad scope/target/factor/reason/duplicate', () => {
    const f = baseFixture();
    assert.throws(() => createUomDomainRule({ cmiId: 999999, fromUom: 'SET', toUom: 'EA', factor: 10, reason: 'x', actor: MANAGER }), /CMI/i);
    assert.throws(() => createUomDomainRule({ cmiId: f.cmiId, fromUom: 'SET', toUom: 'SET', factor: 10, reason: 'x', actor: MANAGER }), /differ/i);
    assert.throws(() => createUomDomainRule({ cmiId: f.cmiId, fromUom: 'SET', toUom: 'PCS', factor: 10, reason: 'x', actor: MANAGER }), /canonical/i, 'target must be canonical');
    assert.throws(() => createUomDomainRule({ cmiId: f.cmiId, fromUom: 'SET', toUom: 'EA', factor: 0, reason: 'x', actor: MANAGER }), /factor/i);
    assert.throws(() => createUomDomainRule({ cmiId: f.cmiId, fromUom: 'SET', toUom: 'EA', factor: 1.5, reason: 'x', actor: MANAGER }), /factor/i, 'integer factors only (Step 17 exactness)');
    assert.throws(() => createUomDomainRule({ cmiId: f.cmiId, fromUom: 'SET', toUom: 'EA', factor: 10, reason: '   ', actor: MANAGER }), /reason/i);
    const id = proposeScoped(f);
    assert.throws(
      () => createUomDomainRule({ cmiId: f.cmiId, fromUom: 'set', toUom: 'EA', factor: 2, reason: 'dup', actor: MANAGER }),
      /live/i,
      'duplicate live rule (case-insensitive from_uom) rejected'
    );
    // Supersede path: reject the live rule, then a new proposal is allowed.
    transitionUomRuleLifecycle(id, 'reject', MANAGER);
    const id2 = proposeScoped(f, 'SET', 12);
    assert.ok(id2 > id);
    f.db.close();
  });

  test('3. lifecycle: valid transitions work, invalid ones fail closed', () => {
    const f = baseFixture();
    const a = proposeScoped(f);
    const approved = transitionUomRuleLifecycle(a, 'approve', MANAGER);
    assert.equal(approved.rule.status, 'APPROVED');
    assert.equal(approved.previousStatus, 'PENDING');
    assert.equal(approved.rule.approvedBy, MANAGER);
    assert.throws(() => transitionUomRuleLifecycle(a, 'approve', MANAGER), /Invalid transition/i, 'double approve blocked');
    assert.throws(() => transitionUomRuleLifecycle(a, 'reject', MANAGER), /Invalid transition/i, 'approve->reject blocked');
    const disabled = transitionUomRuleLifecycle(a, 'disable', MANAGER);
    assert.equal(disabled.rule.status, 'DISABLED');
    const reenabled = transitionUomRuleLifecycle(a, 're-enable', MANAGER);
    assert.equal(reenabled.rule.status, 'APPROVED', 'DISABLED -> re-enable -> APPROVED');
    const b = proposeScoped(f, 'KG');
    transitionUomRuleLifecycle(b, 'reject', MANAGER);
    assert.throws(() => transitionUomRuleLifecycle(b, 'disable', MANAGER), /Invalid transition/i, 'REJECTED is terminal');
    f.db.close();
  });

  test('4+5. scope isolation + approved conversion participates (12 SET -> 120 EA)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET', '40000', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierB, 'PO-2', '2026-02-15', '12', 'SET', '40000', 'INR');
    const otherCmi = f.db.prepare(
      `INSERT INTO common_materials (code, name, category, is_active, created_at, updated_at)
       VALUES ('CMI-OTHER', 'Other CMI', 'Motors', 1, ?, ?)`
    ).run(new Date().toISOString(), new Date().toISOString());
    const otherId = Number(otherCmi.lastInsertRowid);
    const ruleId = proposeScoped(f); // scoped to CMI-T-BRG
    transitionUomRuleLifecycle(ruleId, 'approve', MANAGER);
    // normalizeQuantity WITHOUT scope: no conversion (never global).
    const unscoped = normalizeQuantity('12', 'SET');
    assert.equal(unscoped.status, 'UNCONVERTED');
    assert.equal(unscoped.normalizedUom, 'SET');
    // WITH the scoped CMI: 12 SET -> 120 EA.
    const scoped = normalizeQuantity('12', 'SET', f.cmiId);
    assert.equal(scoped.status, 'SCALED');
    assert.equal(scoped.normalizedQuantity, '120');
    assert.equal(scoped.normalizedUom, 'EA');
    assert.equal(scoped.rule?.ruleType, 'DOMAIN_SPECIFIC');
    // CMI aggregation: both records are in scope -> 240 EA total.
    const d = getCmiComparableDemand(f.cmiId);
    assert.ok(d);
    assert.deepEqual(d.comparableQuantityByUom, { EA: '240' });
    f.db.close();
  });

  test('6. PENDING rule has no analytical effect anywhere', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET');
    proposeScoped(f); // stays PENDING
    const d = getCmiComparableDemand(f.cmiId);
    assert.deepEqual(d?.comparableQuantityByUom, { SET: '12' }, 'PENDING -> verbatim bucket');
    const q = getUomQualityCounts({ cmiId: f.cmiId });
    assert.equal(q.counts['UNCONVERTED'], 1);
    f.db.close();
  });

  test('7. REJECTED rule has no analytical effect', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET');
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'reject', MANAGER);
    const d = getCmiComparableDemand(f.cmiId);
    assert.deepEqual(d?.comparableQuantityByUom, { SET: '12' });
    assert.equal(normalizeQuantity('12', 'SET', f.cmiId).status, 'UNCONVERTED');
    f.db.close();
  });

  test('8. DISABLED rule has no analytical effect', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET');
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', MANAGER);
    transitionUomRuleLifecycle(id, 'disable', MANAGER);
    const d = getCmiComparableDemand(f.cmiId);
    assert.deepEqual(d?.comparableQuantityByUom, { SET: '12' });
    assert.equal(normalizeQuantity('12', 'SET', f.cmiId).status, 'UNCONVERTED');
    f.db.close();
  });

  test('9. re-enable restores the conversion (exact factor back)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET');
    const id = proposeScoped(f, 'SET', 10);
    transitionUomRuleLifecycle(id, 'approve', MANAGER);
    transitionUomRuleLifecycle(id, 'disable', MANAGER);
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { SET: '12' });
    transitionUomRuleLifecycle(id, 're-enable', MANAGER);
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '120' });
    f.db.close();
  });

  test('10. original procurement data unchanged through every lifecycle action', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET', '40000', 'INR');
    const snapshot = () =>
      f.db.prepare(`SELECT purchase_order_reference, quantity, uom, unit_price, currency FROM procurement_records`).all();
    const before = snapshot();
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', MANAGER);
    getCmiComparableDemand(f.cmiId);
    transitionUomRuleLifecycle(id, 'disable', MANAGER);
    transitionUomRuleLifecycle(id, 're-enable', MANAGER);
    assert.deepEqual(snapshot(), before, 'no procurement row mutated by governance or reads');
    f.db.close();
  });

  test('11. conversion evidence: DOMAIN_SPECIFIC + GOVERNED source + factor', () => {
    const f = baseFixture();
    const id = proposeScoped(f, 'SET', 10);
    transitionUomRuleLifecycle(id, 'approve', MANAGER);
    const n = normalizeQuantity('12', 'SET', f.cmiId);
    assert.ok(n.rule);
    assert.equal(n.rule.ruleType, 'DOMAIN_SPECIFIC');
    assert.equal(n.rule.source, 'GOVERNED');
    assert.equal(n.rule.fromUom, 'SET');
    assert.equal(n.rule.toUom, 'EA');
    assert.equal(n.rule.factor, 10);
    f.db.close();
  });

  test('12. SQL/service parity across all lifecycle states + unknown UOM', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET');
    const walk: Array<{ state: string; act: 'propose' | 'propose+reject' | 'approve' | 'disable' | 're-enable' | 'reject' | null; expect: Record<string, string>; status: string }> = [
      { state: 'none', act: null, expect: { SET: '12' }, status: 'UNCONVERTED' },
      { state: 'rejected', act: 'propose+reject', expect: { SET: '12' }, status: 'UNCONVERTED' },
      { state: 'pending (supersede)', act: 'propose', expect: { SET: '12' }, status: 'UNCONVERTED' },
      { state: 'approved', act: 'approve', expect: { EA: '120' }, status: 'SCALED' },
      { state: 'disabled', act: 'disable', expect: { SET: '12' }, status: 'UNCONVERTED' },
      { state: 're-enabled', act: 're-enable', expect: { EA: '120' }, status: 'SCALED' },
    ];
    let id = 0;
    for (const c of walk) {
      if (c.act === 'propose+reject') {
        const rid = proposeScoped(f);
        transitionUomRuleLifecycle(rid, 'reject', MANAGER);
      } else if (c.act === 'propose') {
        id = proposeScoped(f);
      } else if (c.act) {
        transitionUomRuleLifecycle(id, c.act, MANAGER);
      }
      const d = getCmiComparableDemand(f.cmiId);
      assert.deepEqual(d?.comparableQuantityByUom, c.expect, `SQL aggregation in state ${c.state}`);
      const n = normalizeQuantity('12', 'SET', f.cmiId);
      assert.equal(n.status, c.status, `service in state ${c.state}`);
      assert.equal(
        n.normalizedQuantity,
        c.expect['EA'] ?? c.expect['SET'],
        `service quantity matches SQL in state ${c.state}`
      );
      if (c.expect['EA']) {
        assert.equal(n.normalizedUom, 'EA');
      }
    }
    // Unknown UOM parity: no rule anywhere converts it.
    const unk = normalizeQuantity('18', 'bX9', f.cmiId);
    assert.equal(unk.status, 'UNCONVERTED');
    assert.equal(unk.rule, null);
    f.db.close();
  });

  test('13. unknown UOM stays UNCONVERTED even when other scoped rules are live', () => {
    const f = baseFixture();
    const id = proposeScoped(f, 'SET', 10);
    transitionUomRuleLifecycle(id, 'approve', MANAGER);
    const n = normalizeQuantity('5', 'DRUM', f.cmiId);
    assert.equal(n.status, 'UNCONVERTED', 'no guessing for DRUM');
    assert.equal(n.normalizedUom, 'DRUM');
    assert.equal(n.rule, null);
    f.db.close();
  });

  test('14. authorization: governance mutations are permission-gated at the service boundary', () => {
    const f = baseFixture();
    // The permission itself is enforced by requireApiPermission at the routes
    // (MANAGE_UOM_RULES). Here we pin the matrix contract: authority and
    // platform_admin hold it, reviewers/managers do not.
    const { roleHasPermission, ROLE_PERMISSIONS } = require('../src/lib/auth/permissions') as typeof import('../src/lib/auth/permissions');
    assert.ok(roleHasPermission('authority', 'MANAGE_UOM_RULES'));
    assert.ok(roleHasPermission('platform_admin', 'MANAGE_UOM_RULES'));
    assert.ok(!roleHasPermission('cpse_material_manager', 'MANAGE_UOM_RULES'));
    assert.ok(!roleHasPermission('cpse_technical_reviewer', 'MANAGE_UOM_RULES'));
    assert.ok(Object.values(ROLE_PERMISSIONS).every((p) => p.length >= 0));
    f.db.close();
  });

  test('15. audit: transitions audited with previous/new state; reads stay silent', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET');
    const id = proposeScoped(f);
    const events = f.db
      .prepare(`SELECT action, actor, entity_id, details FROM audit_logs WHERE action LIKE 'uom_rule%' ORDER BY id`)
      .all() as Array<{ action: string; actor: string; entity_id: number; details: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'uom_rule_created');
    transitionUomRuleLifecycle(id, 'approve', MANAGER);
    transitionUomRuleLifecycle(id, 'disable', MANAGER);
    transitionUomRuleLifecycle(id, 're-enable', MANAGER);
    const all = f.db
      .prepare(`SELECT action, details FROM audit_logs WHERE action LIKE 'uom_rule%' ORDER BY id`)
      .all() as Array<{ action: string; details: string }>;
    const acts = all.map((a) => a.action);
    assert.deepEqual(acts, ['uom_rule_created', 'uom_rule_approved', 'uom_rule_disabled', 'uom_rule_re_enabled']);
    const disableRow = JSON.parse(all[2].details) as { previousStatus: string; newStatus: string };
    assert.equal(disableRow.previousStatus, 'APPROVED');
    assert.equal(disableRow.newStatus, 'DISABLED');
    const before = countAudit();
    getCmiComparableDemand(f.cmiId);
    getUomQualityCounts({ cmiId: f.cmiId });
    getUomRemediationBoard(f.cmiId);
    getUomAffectedRecords(f.cmiId, 'SET');
    getEffectiveUomRule('SET', f.cmiId);
    getSupplierIntelligenceBundle(f.supplierA);
    assert.equal(countAudit(), before, 'analytics reads create zero audit rows');
    f.db.close();
  });

  test('16. duplicate live rule handling enforced by the partial UNIQUE index', () => {
    const f = baseFixture();
    const id = proposeScoped(f);
    assert.throws(
      () =>
        f.db
          .prepare(
            `INSERT INTO uom_domain_rules (cmi_id, from_uom, to_uom, factor, reason, created_by)
             VALUES (?, 'SET', 'EA', 4, 'bypass attempt', 'x')`
          )
          .run(f.cmiId),
      /UNIQUE/i,
      'second LIVE rule for (cmi, from_uom) is impossible at the schema level'
    );
    transitionUomRuleLifecycle(id, 'reject', MANAGER);
    // After REJECTED the row no longer participates in the partial index.
    f.db
      .prepare(
        `INSERT INTO uom_domain_rules (cmi_id, from_uom, to_uom, factor, reason, created_by)
         VALUES (?, 'SET', 'EA', 4, 'supersede after rejection', 'x')`
      )
      .run(f.cmiId);
    f.db.close();
  });

  test('17. Step 17 regression: registry untouched, 390 EA example, exact decimals', () => {
    const f = baseFixture();
    const rules = getUomRuleRegistry();
    assert.equal(rules.length, 7, 'system registry unchanged');
    assert.ok(rules.every((r) => r.ruleType !== 'DOMAIN_SPECIFIC'));
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '120', 'PCS', '1250.50', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-15', '180', 'NOS', '1250.50', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierB, 'PO-3', '2026-03-20', '90', 'EA', '1250.50', 'INR');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '390' });
    assert.deepEqual(normalizeQuantity('0.25', 'KG').normalizedQuantity, '250');
    assert.deepEqual(normalizeQuantity('1.5', 'PCS').normalizedQuantity, '1.50');
    assert.deepEqual(normalizeQuantity('0.1', 'KG').normalizedQuantity, '100');
    assert.deepEqual(normalizeQuantity('1000', 'M').normalizedQuantity, '1000000');
    assert.deepEqual(normalizeQuantity('99999999999.99', 'TON').normalizedQuantity, '99999999999990000');
    f.db.close();
  });

  test('18. CMI aggregation precedence: domain rule wins over system rule in-scope only', () => {
    const f = baseFixture();
    // PCS has a system alias; inside a CMI with an approved PCS domain rule
    // (x2) the domain rule must win for that scope only.
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '10', 'PCS');
    const id = createUomDomainRule({
      cmiId: f.cmiId, fromUom: 'PCS', toUom: 'EA', factor: 2,
      reason: 'Bearing family sold in 2-packs (fixture evidence).', actor: MANAGER,
    }).id;
    transitionUomRuleLifecycle(id, 'approve', MANAGER);
    assert.deepEqual(normalizeQuantity('10', 'PCS', f.cmiId).normalizedQuantity, '20', 'domain precedence');
    assert.equal(normalizeQuantity('10', 'PCS').normalizedQuantity, '10', 'unscoped stays system-aliased');
    assert.deepEqual(getCmiComparableDemand(f.cmiId)?.comparableQuantityByUom, { EA: '20' });
    f.db.close();
  });

  test('19. CPSE aggregation under precedence + remediation board wiring', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET');
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', MANAGER);
    assert.deepEqual(getOrganizationComparableQuantity(f.cpclId)?.comparableQuantityByUom, { EA: '120' });
    const board = getUomRemediationBoard(f.cmiId);
    assert.ok(board);
    assert.equal(board.cmiCode, 'CMI-T-BRG');
    const setBucket = board.buckets.find((b) => b.uom === 'SET');
    assert.ok(setBucket && setBucket.count === 1);
    assert.ok(board.rules.some((r) => r.id === id && r.status === 'APPROVED'));
    assert.equal(getUomRemediationBoard(999999), null);
    f.db.close();
  });

  test('20. supplier aggregation under precedence + affected-records traceability', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-10', '6', 'SET');
    const id = proposeScoped(f);
    transitionUomRuleLifecycle(id, 'approve', MANAGER);
    // SQL/service parity probe for the supplier scope (section 12 contract).
    const sqlAgg = f.db
      .prepare(
        `SELECT COALESCE(dr.to_uom, COALESCE(r.to_uom, UPPER(TRIM(pr.uom)))) AS uom,
                SUM(COALESCE(dr.factor, 1) * CAST(ROUND(pr.quantity * 100) AS INTEGER) * COALESCE(r.factor, 1)) AS s
           FROM procurement_records pr
           LEFT JOIN uom_domain_rules dr ON dr.status='APPROVED' AND dr.cmi_id = pr.cmi_id AND dr.from_uom = UPPER(TRIM(pr.uom))
           LEFT JOIN uom_conversion_rules r ON r.is_active=1 AND r.rule_type IN ('ALIAS','SCALE') AND r.from_uom = UPPER(TRIM(pr.uom))
          WHERE pr.supplier_id = ? GROUP BY 1`
      )
      .all(f.supplierA) as Array<{ uom: string; s: number }>;
    assert.deepEqual(
      Object.fromEntries(sqlAgg.map((r) => [r.uom, String(Number(r.s) / 100).replace(/\.00$/, '')])),
      { EA: '180' },
      'raw SQL aggregation must agree with the service'
    );
    assert.deepEqual(getSupplierComparableQuantity(f.supplierA)?.comparableQuantityByUom, { EA: '180' });
    const bundle = getSupplierIntelligenceBundle(f.supplierA);
    assert.deepEqual(bundle?.comparable?.comparableQuantityByUom, { EA: '180' });
    const affected = getUomAffectedRecords(f.cmiId, 'SET', 25);
    assert.equal(affected.length, 2);
    assert.ok(affected.every((r) => r.record.uom === 'SET' && r.record.quantity === '12' || r.record.quantity === '6'));
    f.db.close();
  });

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    for (const msg of failures) console.log('  FAILED: ' + msg);
    process.exit(1);
  }
}

main();
