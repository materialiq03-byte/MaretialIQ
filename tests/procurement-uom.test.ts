/**
 * Step 17 — UOM harmonization & comparable-quantity intelligence suite.
 *
 * `npx tsx tests/procurement-uom.test.ts` (part of the npm test chain).
 *
 * Runs against a fresh isolated temp SQLite DB (migration v16 applied) with
 * the minimal CMI + supplier + procurement fixture. Pins the Step-17 contract:
 *
 *   1. registry seed: 7 SYSTEM_DEFINED directional rules, integer factors
 *   2. canonical pass-through: EA/G/ML/MM stay NORMALIZED, quantity unchanged
 *   3. alias conversion: PCS -> EA factor 1 with full evidence
 *   4. scale conversion: KG -> G factor 1000 with full evidence
 *   5. decimal safety: 0.1 / 0.25 / 1.5 / 1000 / large quantities, no float artifacts
 *   6. direct-hop policy: TON -> G x1000000 (no chains), reverse G -> KG absent
 *   7. incompatible/unknown/unconverted statuses (SET, unknown UOM, bad quantity)
 *   8. normalization is read-only: originals never mutated
 *   9. CMI comparable demand: 390 EA example + per-CPSE breakdown
 *  10. CMI comparable demand: aliases/scales kept in separate canonical buckets
 *  11. CPSE aggregation with original verbatim preservation
 *  12. supplier aggregation + bundle integration
 *  13. canonical-UOM filter distinct from original-UOM filter
 *  14. currency separation + NULL-price behavior on comparable scope
 *  15. audit silence: analytics reads create ZERO audit rows
 *  16. no destructive writes: conversions never touch procurement_records
 *  17. banned language: no guessed/inferred conversion wording anywhere
 *  18. opportunity evidence stays traceable with comparableDemand enrichment
 *  19. evaluation fixture intact (no CMI/matching side effects)
 *  20. DOMAIN_SPECIFIC rules never applied globally
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
  getUomDataQuality,
  getCmiComparableDemand,
  getSupplierComparableQuantity,
  getOrganizationComparableQuantity,
  getSupplierIntelligenceBundle,
} from '../src/lib/services/procurement-service';
import {
  listProcurementRecords,
  getOrganizationProcurementSummaries,
  listOpportunitySourceRecords,
} from '../src/lib/db/repositories/procurement-repository';
import { countAudit } from '../src/lib/db/repositories/audit-repository';
import { detectProcurementOpportunities, listOpportunities } from '../src/lib/services/procurement-opportunity-service';

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

const ACTOR = 'uom-test';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-uom-'));
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

function main(): void {
  test('1. registry seed: 7 SYSTEM_DEFINED directional rules with integer factors', () => {
    const f = baseFixture();
    const rules = getUomRuleRegistry();
    assert.equal(rules.length, 7);
    assert.ok(rules.every((r) => r.source === 'SYSTEM_DEFINED' && r.isActive && Number.isInteger(r.factor) && r.factor > 0));
    assert.ok(rules.every((r) => r.fromUom !== r.toUom), 'no self-conversion rules');
    const byFrom: Record<string, { to: string; factor: number; type: string }> = {};
    for (const r of rules) byFrom[r.fromUom] = { to: r.toUom, factor: r.factor, type: r.ruleType };
    assert.deepEqual(byFrom['PCS'], { to: 'EA', factor: 1, type: 'ALIAS' });
    assert.deepEqual(byFrom['NOS'], { to: 'EA', factor: 1, type: 'ALIAS' });
    assert.deepEqual(byFrom['KG'], { to: 'G', factor: 1000, type: 'SCALE' });
    assert.deepEqual(byFrom['TON'], { to: 'G', factor: 1000000, type: 'SCALE' });
    assert.deepEqual(byFrom['L'], { to: 'ML', factor: 1000, type: 'SCALE' });
    assert.deepEqual(byFrom['M'], { to: 'MM', factor: 1000, type: 'SCALE' });
    assert.deepEqual(byFrom['CM'], { to: 'MM', factor: 10, type: 'SCALE' });
    assert.equal(byFrom['SET'], undefined, 'SET has no rule - stays UNCONVERTED');
    assert.ok(rules.every((r) => r.ruleType !== 'DOMAIN_SPECIFIC'), 'DOMAIN_SPECIFIC reserved and unpopulated');
    f.db.close();
  });

  test('2. canonical pass-through: EA/G/ML/MM NORMALIZED, quantity unchanged, no rule', () => {
    const f = baseFixture();
    for (const [q, u] of [['90', 'EA'], ['0.25', 'G'], ['750', 'ML'], ['120', 'MM']] as const) {
      const n = normalizeQuantity(q, u);
      assert.equal(n.status, 'NORMALIZED', `${q} ${u}`);
      assert.equal(n.normalizedQuantity, q);
      assert.equal(n.normalizedUom, u);
      assert.equal(n.rule, null);
      assert.equal(n.originalUom, u);
    }
    f.db.close();
  });

  test('3. alias conversion: PCS -> EA factor 1 with full conversion evidence', () => {
    const f = baseFixture();
    const n = normalizeQuantity('180', 'PCS');
    assert.equal(n.status, 'ALIAS_NORMALIZED');
    assert.equal(n.originalQuantity, '180');
    assert.equal(n.originalUom, 'PCS');
    assert.equal(n.normalizedQuantity, '180');
    assert.equal(n.normalizedUom, 'EA');
    assert.ok(n.rule);
    assert.equal(n.rule.fromUom, 'PCS');
    assert.equal(n.rule.toUom, 'EA');
    assert.equal(n.rule.factor, 1);
    assert.equal(n.rule.ruleType, 'ALIAS');
    assert.equal(n.rule.source, 'SYSTEM_DEFINED');
    f.db.close();
  });

  test('4. scale conversion: KG -> G factor 1000 with full conversion evidence', () => {
    const f = baseFixture();
    const n = normalizeQuantity('1.25', 'KG');
    assert.equal(n.status, 'SCALED');
    assert.equal(n.originalQuantity, '1.25');
    assert.equal(n.originalUom, 'KG');
    assert.equal(n.normalizedQuantity, '1250', '1.25 KG -> 1250 G, no float artifacts');
    assert.equal(n.normalizedUom, 'G');
    assert.ok(n.rule);
    assert.equal(n.rule.ruleType, 'SCALE');
    assert.equal(n.rule.factor, 1000);
    f.db.close();
  });

  test('5. decimal safety: 0.1 / 0.25 / 1.5 / 1000 / large, all exact (integer-cent BigInt)', () => {
    const f = baseFixture();
    const cases: Array<[string, string, string, string]> = [
      // [qty, uom, expected normalized quantity, expected uom]
      ['0.1', 'KG', '100', 'G'],
      ['0.25', 'KG', '250', 'G'],
      ['1.5', 'PCS', '1.50', 'EA'],
      ['1000', 'M', '1000000', 'MM'],
      ['0.01', 'KG', '10', 'G'],
      ['99999999999.99', 'TON', '99999999999990000', 'G'],
      ['0.01', 'EA', '0.01', 'EA'],
    ];
    for (const [q, u, expectQty, expectUom] of cases) {
      const n = normalizeQuantity(q, u);
      assert.equal(n.normalizedQuantity, expectQty, `${q} ${u}`);
      assert.equal(n.normalizedUom, expectUom);
      assert.ok(!n.normalizedQuantity.includes('e'), 'no scientific notation');
    }
    f.db.close();
  });

  test('6. directional/direct-hop policy: TON -> G direct x1000000; no chains; no reverse rules', () => {
    const f = baseFixture();
    const ton = normalizeQuantity('3', 'TON');
    assert.equal(ton.status, 'SCALED');
    assert.equal(ton.normalizedQuantity, '3000000');
    assert.equal(ton.normalizedUom, 'G');
    assert.equal(ton.rule?.factor, 1000000, 'single hop TON -> G, never TON -> KG -> G');
    assert.equal(normalizeQuantity('1', 'G').rule, null, 'reverse G -> ... is not registered (directional registry)');
    assert.equal(normalizeQuantity('1', 'G').status, 'NORMALIZED', 'G is canonical; reverse conversion is not a rule');
    f.db.close();
  });

  test('7. statuses: SET UNCONVERTED, unknown UOM UNCONVERTED, bad quantity INVALID', () => {
    const f = baseFixture();
    const set = normalizeQuantity('12', 'SET');
    assert.equal(set.status, 'UNCONVERTED');
    assert.equal(set.normalizedQuantity, '12');
    assert.equal(set.normalizedUom, 'SET', 'kept separate unless an authoritative rule exists');
    assert.equal(set.rule, null);
    const unk = normalizeQuantity('18', 'bX9');
    assert.equal(unk.status, 'UNCONVERTED', 'UNKNOWN UOM -> UNCONVERTED status at service level');
    assert.equal(unk.originalUom, 'BX9');
    assert.equal(unk.normalizedUom, 'BX9');
    assert.equal(unk.rule, null);
    for (const bad of ['abc', '1,5', '1.234', '1e3', '']) {
      assert.equal(normalizeQuantity(bad, 'EA').status, 'INVALID', `bad quantity ${JSON.stringify(bad)}`);
    }
    assert.equal(normalizeQuantity('10', '   ').status, 'INVALID', 'blank UOM is invalid');
    assert.equal(normalizeQuantity('10', '').status, 'INVALID');
    f.db.close();
  });

  test('8. normalization is read-only: procurement rows keep original quantity + UOM verbatim', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '0.25', 'KG', '410.75', 'INR');
    normalizeQuantity('0.25', 'KG');
    getUomDataQuality();
    getCmiComparableDemand(f.cmiId);
    const rows = f.db
      .prepare(`SELECT quantity, uom FROM procurement_records WHERE purchase_order_reference = 'PO-1'`)
      .all() as Array<{ quantity: string; uom: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quantity, '0.25', 'original quantity preserved verbatim');
    assert.equal(rows[0].uom, 'KG', 'original UOM preserved verbatim');
    const counts = f.db
      .prepare(`SELECT COUNT(*) n FROM uom_conversion_rules WHERE rule_type = 'DOMAIN_SPECIFIC'`)
      .get() as { n: number };
    assert.equal(counts.n, 0, 'registry untouched by reads');
    f.db.close();
  });

  test('9. CMI comparable demand: 120 PCS + 180 NOS + 90 EA -> 390 EA with per-CPSE breakdown', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '120', 'PCS', '1250.50', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-15', '180', 'NOS', '1250.50', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierB, 'PO-3', '2026-03-20', '90', 'EA', '1250.50', 'INR');
    const d = getCmiComparableDemand(f.cmiId);
    assert.ok(d);
    assert.equal(d.cmiCode, 'CMI-T-BRG');
    assert.equal(d.recordCount, 3);
    assert.deepEqual(d.comparableQuantityByUom, { EA: '390' });
    assert.deepEqual(d.originalQuantityByUom, { EA: '90', NOS: '180', PCS: '120' }, 'originals remain visible');
    assert.equal(d.statusCounts['ALIAS_NORMALIZED'], 2);
    assert.equal(d.statusCounts['NORMALIZED'], 1);
    assert.deepEqual(d.qualityCounts, { VALID_ALIAS: 2, VALID_CANONICAL: 1 });
    assert.equal(d.byOrg.length, 2);
    const cpcl = d.byOrg.find((o) => o.orgCode === 'CPCL');
    const ntpc = d.byOrg.find((o) => o.orgCode === 'NTPC');
    assert.ok(cpcl && ntpc);
    assert.deepEqual(cpcl.originalQuantityByUom, { EA: '90', PCS: '120' });
    assert.deepEqual(cpcl.comparableQuantityByUom, { EA: '210' });
    assert.deepEqual(ntpc.originalQuantityByUom, { NOS: '180' });
    assert.deepEqual(ntpc.comparableQuantityByUom, { EA: '180' });
    f.db.close();
  });

  test('10. CMI comparable demand: canonical buckets stay separated (EA + G + SET)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '120', 'PCS', '1250.50', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-15', '0.25', 'KG', '410.75', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierB, 'PO-3', '2026-03-20', '12', 'SET', '40000', 'INR');
    const d = getCmiComparableDemand(f.cmiId);
    assert.ok(d);
    assert.deepEqual(d.comparableQuantityByUom, { EA: '120', G: '250', SET: '12' }, 'EA/G/SET never combined');
    assert.equal(d.statusCounts['UNCONVERTED'], 1);
    assert.deepEqual(d.qualityCounts, { VALID_ALIAS: 1, VALID_CONVERTED: 1, UNCONVERTED: 1 });
    f.db.close();
  });

  test('11. CPSE aggregation: comparable quantity + verbatim original (case/space preserved)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '120', 'PCS', '1250.50', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-2', '2026-01-11', '180', 'EA', '1250.50', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierB, 'PO-3', '2026-01-12', '1', 'kg', '410.75', 'INR');
    const o = getOrganizationComparableQuantity(f.cpclId);
    assert.ok(o);
    assert.deepEqual(o.comparableQuantityByUom, { EA: '300', G: '1000' }, 'case-insensitive rule match merges kg into G');
    assert.ok(o.originalQuantityByUom['KG'] === '1', 'original total kept (comparable summary displays upper-cased UOM per section 11)');
    assert.ok(o.originalQuantityByUom['kg'] === undefined, 'display keys are normalized; the verbatim value lives on the row');
    const summaries = getOrganizationProcurementSummaries();
    const cpclSummary = summaries.find((s) => s.organizationId === f.cpclId);
    assert.ok(cpclSummary);
    assert.ok(cpclSummary.quantityByUom['kg'] === '1', 'Step-14 summaries preserve verbatim UOM too');
    f.db.close();
  });

  test('12. supplier aggregation: comparable + original, wired into the intelligence bundle', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '120', 'PCS', '1250.50', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-15', '2.5', 'M', '55.25', 'EUR');
    const s = getSupplierComparableQuantity(f.supplierA);
    assert.ok(s);
    assert.deepEqual(s.comparableQuantityByUom, { EA: '120', MM: '2500' });
    assert.deepEqual(s.originalQuantityByUom, { M: '2.50', PCS: '120' }, 'original verbatim value, cents-normalized presentation');
    const b = getSupplierIntelligenceBundle(f.supplierA);
    assert.ok(b);
    assert.ok(b.comparable, 'bundle carries the comparable summary');
    assert.deepEqual(b.comparable?.comparableQuantityByUom, { EA: '120', MM: '2500' });
    assert.equal(getSupplierComparableQuantity(999999), null, 'unknown supplier -> null, never fabricated');
    f.db.close();
  });

  test('13. canonical-UOM filter distinct from original-UOM filter (no ambiguity)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '120', 'PCS', '1250.50', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-2', '2026-01-11', '180', 'EA', '1250.50', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierB, 'PO-3', '2026-01-12', '0.25', 'KG', '410.75', 'INR');
    const byOriginal = listProcurementRecords({ uom: 'EA' }, 1, 50);
    assert.equal(byOriginal.total, 1, 'original filter matches verbatim UOM only');
    const byCanonical = listProcurementRecords({ canonicalUom: 'EA' }, 1, 50);
    assert.equal(byCanonical.total, 2, 'canonical filter includes source UOMs of active rules (PCS)');
    assert.ok(byCanonical.items.every((i) => ['PCS', 'EA'].includes(i.record.uom)));
    assert.ok(byCanonical.items.every((i) => !['KG'].includes(i.record.uom)), 'KG records are not in the EA canonical bucket');
    const byCanonicalG = listProcurementRecords({ canonicalUom: 'G' }, 1, 50);
    assert.equal(byCanonicalG.total, 1);
    assert.equal(byCanonicalG.items[0].record.uom, 'KG');
    f.db.close();
  });

  test('14. currency separation + NULL price behavior on comparable scope', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '1.5', 'PCS', '50.25', 'USD');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-15', '120', 'PCS', '75.00', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierB, 'PO-3', '2026-03-20', '10', 'PCS', undefined);
    const d = getCmiComparableDemand(f.cmiId);
    assert.ok(d);
    assert.deepEqual(d.comparableQuantityByUom, { EA: '131.50' }, 'quantities comparable across currencies');
    assert.deepEqual(d.originalQuantityByUom, { PCS: '131.50' }, 'original kept, cents-normalized presentation only');
    const summary = f.db
      .prepare(
        `SELECT SUM(CASE WHEN currency='USD' THEN 1 ELSE 0 END) usd,
                SUM(CASE WHEN currency='INR' THEN 1 ELSE 0 END) inr,
                SUM(CASE WHEN unit_price IS NULL THEN 1 ELSE 0 END) unpriced
           FROM procurement_records WHERE cmi_id = ?`
      )
      .get(f.cmiId) as { usd: number; inr: number; unpriced: number };
    assert.equal(summary.usd, 1);
    assert.equal(summary.inr, 1);
    assert.equal(summary.unpriced, 1, 'NULL price counted, never zero-priced spend');
    f.db.close();
  });

  test('15. audit silence: all UOM analytics reads create ZERO audit rows', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '0.25', 'KG', '410.75', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-15', '120', 'PCS', '1250.50', 'INR');
    const before = countAudit();
    getUomRuleRegistry();
    getUomDataQuality();
    normalizeQuantity('0.25', 'KG');
    getCmiComparableDemand(f.cmiId);
    getSupplierComparableQuantity(f.supplierA);
    getOrganizationComparableQuantity(f.cpclId);
    getSupplierIntelligenceBundle(f.supplierA);
    listProcurementRecords({ canonicalUom: 'EA' }, 1, 50);
    assert.equal(countAudit(), before, 'analytics reads must not audit');
    f.db.close();
  });

  test('16. no destructive writes: detection + comparable reads leave procurement untouched', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '0.25', 'KG', '410.75', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-15', '120', 'PCS', '1250.50', 'INR');
    const before = f.db
      .prepare(`SELECT purchase_order_reference, quantity, uom FROM procurement_records ORDER BY id`)
      .all();
    getCmiComparableDemand(f.cmiId);
    getUomDataQuality();
    detectProcurementOpportunities();
    const after = f.db
      .prepare(`SELECT purchase_order_reference, quantity, uom FROM procurement_records ORDER BY id`)
      .all();
    assert.deepEqual(after, before, 'no quantity/UOM mutation from any read or detection');
    f.db.close();
  });

  test('17. banned language: no guessed/inferred conversion wording anywhere', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '120', 'PCS', '1250.50', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-10', '180', 'NOS', '1250.50', 'INR');
    detectProcurementOpportunities();
    const rows = f.db
      .prepare(`SELECT title, description FROM procurement_opportunities`)
      .all() as Array<{ title: string; description: string }>;
    const banned = /inferred conversion|estimated conversion|approximate|guessed conversion|semantic uom|likely equals|assumed conversion/i;
    for (const r of rows) {
      assert.ok(!banned.test(r.title), 'banned language in title: ' + r.title);
      assert.ok(!banned.test(r.description), 'banned language in description: ' + r.description);
    }
    const oppEvidence = f.db
      .prepare(`SELECT evidence FROM procurement_opportunities`)
      .all() as Array<{ evidence: string }>;
    for (const r of oppEvidence) {
      assert.ok(!banned.test(r.evidence), 'banned language in evidence');
    }
    f.db.close();
  });

  test('18. opportunity evidence stays traceable with comparableDemand enrichment', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '120', 'PCS', '1250.50', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-10', '180', 'NOS', '1250.50', 'INR');
    proc(f, f.cpclId, f.cpclBearing, f.supplierB, 'PO-3', '2026-03-10', '90', 'EA', '1250.50', 'INR');
    detectProcurementOpportunities();
    const opps = listOpportunities({}, 1, 100).items;
    assert.ok(opps.length >= 1, 'opportunity detected');
    const withCmi = opps.find((o) => o.cmi_id === f.cmiId) ?? opps[0];
    const row = f.db.prepare(`SELECT evidence FROM procurement_opportunities WHERE id = ?`).get(withCmi.id) as { evidence: string };
    const evidence = JSON.parse(row.evidence) as Record<string, unknown>;
    const cd = evidence['comparableDemand'] as { recordCount: number; comparableQuantityByUom: Record<string, string> } | undefined;
    assert.ok(cd, 'comparableDemand present in evidence');
    assert.equal(cd.recordCount, 3);
    assert.deepEqual(cd.comparableQuantityByUom, { EA: '390' });
    const src = listOpportunitySourceRecords(withCmi as unknown as Parameters<typeof listOpportunitySourceRecords>[0], 200);
    assert.equal(src.length, 3, 'source records remain traceable via filters');
    assert.ok(src.every((s) => ['PO-1', 'PO-2', 'PO-3'].includes(s.record.purchase_order_reference)));
    f.db.close();
  });

  test('19. evaluation fixture intact: comparable reads cause no CMI/matching side effects', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '0.25', 'KG', '410.75', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.supplierA, 'PO-2', '2026-02-10', '120', 'PCS', '1250.50', 'INR');
    const cmisBefore = (f.db.prepare('SELECT COUNT(*) n FROM common_materials').get() as { n: number }).n;
    const mapsBefore = (f.db.prepare('SELECT COUNT(*) n FROM material_mappings').get() as { n: number }).n;
    const candBefore = (f.db.prepare('SELECT COUNT(*) n FROM match_candidates').get() as { n: number }).n;
    const rulesBefore = (f.db.prepare('SELECT COUNT(*) n FROM uom_conversion_rules').get() as { n: number }).n;
    getCmiComparableDemand(f.cmiId);
    getUomDataQuality();
    getSupplierComparableQuantity(f.supplierA);
    const cmisAfter = (f.db.prepare('SELECT COUNT(*) n FROM common_materials').get() as { n: number }).n;
    const mapsAfter = (f.db.prepare('SELECT COUNT(*) n FROM material_mappings').get() as { n: number }).n;
    const candAfter = (f.db.prepare('SELECT COUNT(*) n FROM match_candidates').get() as { n: number }).n;
    const rulesAfter = (f.db.prepare('SELECT COUNT(*) n FROM uom_conversion_rules').get() as { n: number }).n;
    assert.equal(cmisAfter, cmisBefore, 'no CMI created');
    assert.equal(mapsAfter, mapsBefore, 'no mapping created');
    assert.equal(candAfter, candBefore, 'matching untouched');
    assert.equal(rulesAfter, rulesBefore, 'UOM registry untouched');
    f.db.close();
  });

  test('20. DOMAIN_SPECIFIC rules exist in the schema vocabulary but are never applied globally', () => {
    const f = baseFixture();
    // Register a DOMAIN_SPECIFIC rule directly (reserved capability, section 9)
    // and prove the aggregation layer ignores it: SET would convert if the
    // global join applied non-ALIAS/SCALE rules.
    f.db.prepare(
      `INSERT INTO uom_conversion_rules (from_uom, to_uom, factor, rule_type, source, description)
       VALUES ('SET', 'EA', 4, 'DOMAIN_SPECIFIC', 'FIXTURE', 'Per-material pack: 1 SET = 4 EA (never global).')`
    ).run();
    proc(f, f.cpclId, f.cpclBearing, f.supplierA, 'PO-1', '2026-01-10', '12', 'SET', '40000', 'INR');
    const d = getCmiComparableDemand(f.cmiId);
    assert.ok(d);
    assert.deepEqual(d.comparableQuantityByUom, { SET: '12' }, 'DOMAIN_SPECIFIC rule NOT applied globally');
    assert.equal(d.statusCounts['UNCONVERTED'], 1);
    const n = normalizeQuantity('12', 'SET');
    assert.equal(n.status, 'UNCONVERTED', 'row-level conversion also ignores DOMAIN_SPECIFIC');
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
