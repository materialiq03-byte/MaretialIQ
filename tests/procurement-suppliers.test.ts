/**
 * Step 16 — supplier intelligence & explainable supplier visibility suite.
 *
 * `npx tsx tests/procurement-suppliers.test.ts` (part of the npm test chain).
 *
 * Runs against fresh isolated temp SQLite DBs (migration v15 applied) seeded
 * with the minimal CMI + supplier + procurement fixture. Pins the Step-16
 * contract:
 *
 *   1. supplier summary (records, distinct CPSE/CMI/material counts, period)
 *   2. supplier detail bundle assembly (org/CMI activity, matrix, recent)
 *   3. supplier -> CPSE aggregation (records per CPSE)
 *   4. supplier -> CMI aggregation (per-CMI counts, period)
 *   5. CMI -> supplier aggregation (cmiSupplierEvidenceRows)
 *   6. distinct supplier counts on CMI evidence
 *   7. distinct CPSE counts (multi-CPSE supplier)
 *   8. distinct CMI counts (multi-CMI supplier)
 *   9. UOM separation (EA + SET never combined)
 *  10. currency separation (INR + USD never combined)
 *  11. NULL price handling (counted, never zero-priced spend)
 *  12. spend reconciliation (exact decimal, sum(details) == summary)
 *  13. quantity reconciliation (sum(details) == summary, per UOM)
 *  14. procurement traceability (recent records resolve to source rows)
 *  15. server-side filters (org/date/UOM/currency)
 *  16. pagination correctness
 *  17. supplier search (code + name, server-side)
 *  18. multi-supplier signal detection
 *  19. cross-CPSE supplier signal detection
 *  20. opportunity enrichment carries supplierId for traceable links
 *  21. authorization (mutations for supplier analytics do not exist; audit silence)
 *  22. read-only audit silence (ZERO audit rows from analytics reads)
 *  23. banned language: no ranking/recommendation/savings anywhere
 *  24. no automatic supplier creation from procurement writes
 *  25. inactive supplier excluded from default activity semantics (master status preserved)
 *  26. evaluation fixture intact (no CMI/matching side effects)
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
} from '../src/lib/services/procurement-service';
import {
  getSupplierIntelligenceBundle,
  listSuppliersWithIntelligence,
  getCrossCpseSuppliers,
  getSupplierRecordsShare,
} from '../src/lib/services/procurement-service';
import {
  cmiSupplierEvidenceRows,
  getSupplierIntelligenceDetail,
  getSupplierOrgActivity,
  getSupplierCmiActivity,
} from '../src/lib/db/repositories/procurement-repository';
import { detectProcurementOpportunities } from '../src/lib/services/procurement-opportunity-service';
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

const ACTOR = 'sup-test';

interface Fixture {
  db: DatabaseSync;
  cpclId: number;
  ntpcId: number;
  cmiId: number;
  cpclBearing: number;
  ntpcBearing: number;
  cpMotor: number;
  supplierA: number;
  supplierB: number;
  supplierC: number;
}

function baseFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-sup-'));
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
  const cpMotor = Number(ins.run(cpcl, 'CP-5001', 'SIEMENS 3PH INDUCTION MOTOR 15KW 415V', 'SIEMENS 3PH INDUCTION MOTOR 15KW 415V', 'Motors', 'SIEMENS', '15KW-415V', 'SET', now, now).lastInsertRowid);
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
  const supC = createSupplierRecord({ supplierCode: 'SUP-C', supplierName: 'Gamma Motors Pvt Ltd', region: 'IN' }, ACTOR).id;
  return { db, cpclId: cpcl, ntpcId: ntpc, cmiId, cpclBearing: cpBrg, ntpcBearing: ntBrg, cpMotor, supplierA: supA, supplierB: supB, supplierC: supC };
}

/** Record procurement without extra machinery. */
function proc(
  f: Fixture,
  orgId: number,
  materialId: number,
  cmiId: number | null,
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
      organizationId: orgId, materialId, cmiId, supplierId,
      purchaseOrderReference: po, purchaseDate: date,
      quantity: qty, uom,
      unitPrice: price ?? null, currency: currency ?? null, status: 'DELIVERED',
    },
    ACTOR
  );
}

function main(): void {
  test('1. supplier summary: records + distinct CPSE/CMI/material counts + period', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '120', 'EA', '1250.50', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-2', '2026-02-15', '180.5', 'EA', '1250.50', 'INR');
    proc(f, f.cpclId, f.cpMotor, null, f.supplierA, 'PO-3', '2026-03-20', '2', 'SET', '40000', 'INR');
    const d = getSupplierIntelligenceDetail(f.supplierA);
    assert.ok(d);
    assert.equal(d.recordCount, 3);
    assert.equal(d.orgCount, 2);
    assert.equal(d.cmiCount, 1);
    assert.equal(d.materialCount, 3, 'CP bearing + NTPC bearing + CP motor');
    assert.equal(d.firstPurchaseDate, '2026-01-10');
    assert.equal(d.lastPurchaseDate, '2026-03-20');
    f.db.close();
  });

  test('2. supplier detail bundle assembles all sections', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '120', 'EA', '1250.50', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-2', '2026-02-15', '180', 'EA', '1250.50', 'INR');
    const b = getSupplierIntelligenceBundle(f.supplierA);
    assert.ok(b);
    assert.equal(b.detail.recordCount, 2);
    assert.equal(b.orgActivity.length, 2);
    assert.equal(b.cmiActivity.length, 1);
    assert.equal(b.cmiActivity[0].cmiCode, 'CMI-T-BRG');
    assert.ok(b.orgColumns.some((c) => c.code === 'CPCL') && b.orgColumns.some((c) => c.code === 'NTPC'));
    assert.equal(b.recentRecords.length, 2);
    f.db.close();
  });

  test('3. supplier -> CPSE activity: records per CPSE (descriptive)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '10', 'EA');
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-2', '2026-01-11', '10', 'EA');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-3', '2026-02-15', '10', 'EA');
    const acts = getSupplierOrgActivity(f.supplierA);
    const byCode = Object.fromEntries(acts.map((a) => [a.orgCode, a.recordCount]));
    assert.equal(byCode['CPCL'], 2);
    assert.equal(byCode['NTPC'], 1);
    f.db.close();
  });

  test('4. supplier -> CMI activity: per-CMI counts, orgs and period', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '10', 'EA');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-2', '2026-04-15', '10', 'EA');
    const cmiAct = getSupplierCmiActivity(f.supplierA);
    assert.equal(cmiAct.length, 1);
    assert.equal(cmiAct[0].cmiCode, 'CMI-T-BRG');
    assert.equal(cmiAct[0].recordCount, 2);
    assert.equal(cmiAct[0].orgCount, 2);
    assert.equal(cmiAct[0].firstPurchaseDate, '2026-01-10');
    assert.equal(cmiAct[0].lastPurchaseDate, '2026-04-15');
    f.db.close();
  });

  test('5. CMI -> supplier aggregation (cmiSupplierEvidenceRows)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '10', 'EA');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierB, 'PO-2', '2026-01-20', '10', 'EA');
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-3', '2026-02-10', '10', 'EA');
    const rows = cmiSupplierEvidenceRows([f.cmiId]);
    assert.equal(rows.length, 2, 'two distinct suppliers for the CMI');
    const bySup = Object.fromEntries(rows.map((r) => [Number(r.supplier_id), Number(r.records)]));
    assert.equal(bySup[f.supplierA], 2);
    assert.equal(bySup[f.supplierB], 1);
    f.db.close();
  });

  test('6. distinct CMI counts on supplier rows (multi-CMI supplier)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '10', 'EA');
    // Unharmonized row: counts toward materials, never toward cmiCount.
    proc(f, f.cpclId, f.cpMotor, null, f.supplierA, 'PO-2', '2026-02-10', '1', 'SET');
    const rows = listSuppliersWithIntelligence({}, 1, 50).items;
    const a = rows.find((r) => r.supplierId === f.supplierA);
    assert.ok(a);
    assert.equal(a.cmiCount, 1);
    assert.equal(a.materialCount, 2);
    f.db.close();
  });

  test('7. distinct CPSE counts (cross-CPSE supplier)', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '10', 'EA');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-2', '2026-02-10', '10', 'EA');
    const cross = getCrossCpseSuppliers(2);
    assert.equal(cross.length, 1);
    assert.equal(cross[0].supplierId, f.supplierA);
    assert.equal(cross[0].orgCount, 2);
    f.db.close();
  });

  test('8. zero-procurement supplier visible with zero metrics', () => {
    const f = baseFixture();
    const rows = listSuppliersWithIntelligence({}, 1, 50).items;
    const c = rows.find((r) => r.supplierId === f.supplierC);
    assert.ok(c, 'supplier with no procurement stays listed');
    assert.equal(c.recordCount, 0);
    assert.equal(c.orgCount, 0);
    assert.equal(c.cmiCount, 0);
    assert.equal(c.firstPurchaseDate, null);
    f.db.close();
  });

  test('9. UOM separation: EA + SET never combined', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '120', 'EA');
    proc(f, f.cpclId, f.cpMotor, null, f.supplierA, 'PO-2', '2026-02-10', '12', 'SET');
    const d = getSupplierIntelligenceDetail(f.supplierA);
    assert.ok(d);
    assert.equal(d.quantityByUom['EA'], '120');
    assert.equal(d.quantityByUom['SET'], '12');
    assert.equal(Object.keys(d.quantityByUom).length, 2, 'no combined unit key');
    f.db.close();
  });

  test('10. currency separation: INR + USD never combined', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '10', 'EA', '100', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-2', '2026-02-10', '10', 'EA', '5', 'USD');
    const d = getSupplierIntelligenceDetail(f.supplierA);
    assert.ok(d);
    assert.equal(Object.keys(d.spendByCurrency).length, 2);
    assert.ok('INR' in d.spendByCurrency && 'USD' in d.spendByCurrency);
    f.db.close();
  });

  test('11. NULL price: counted, quantity included, never zero-priced spend', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '50', 'EA');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-2', '2026-02-10', '60', 'EA', '100', 'INR');
    const d = getSupplierIntelligenceDetail(f.supplierA);
    assert.ok(d);
    assert.equal(d.recordCount, 2);
    assert.equal(d.quantityByUom['EA'], '110');
    assert.equal(d.pricedRecords, 1);
    assert.equal(d.unpricedRecords, 1);
    assert.ok(!('INR' in d.spendByCurrency && Number(d.spendByCurrency['INR']) === 0) || d.spendByCurrency['INR'] === '100.00');
    f.db.close();
  });

  test('12. spend reconciliation: exact decimal, sum(details) == summary', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '120', 'EA', '1250.50', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-2', '2026-02-15', '180', 'EA', '1250.50', 'INR');
    const d = getSupplierIntelligenceDetail(f.supplierA);
    assert.ok(d);
    // 120 x 1250.50 + 180 x 1250.50 = 300 x 1250.50 = 375150 exactly (canonical form).
    assert.equal(d.spendByCurrency['INR'], '375150');
    const rows = f.db
      .prepare(`SELECT quantity, unit_price FROM procurement_records WHERE supplier_id = ? AND currency = 'INR'`)
      .all(f.supplierA) as Array<{ quantity: string; unit_price: string }>;
    let cents = 0n;
    for (const r of rows) {
      const [qI] = r.quantity.split('.');
      const [pI, pF = ''] = r.unit_price.split('.');
      const pCents = BigInt(pI) * 100n + BigInt((pF + '00').slice(0, 2));
      cents += BigInt(qI) * pCents;
    }
    assert.equal(cents, 37515000n, '120 x 1250.50 + 180 x 1250.50 = 375150.00 = 37,515,000 cents exactly');
    // Canonical summary string is in rupees -> scale back to cents for comparison.
    const inrTotalCents = BigInt(d.spendByCurrency['INR'].replace('.', '')) * 100n;
    assert.equal(cents, inrTotalCents, 'summary reconciles exactly to the detail sum');
    f.db.close();
  });

  test('13. quantity reconciliation: sum(details) == summary, per UOM', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '120', 'EA');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-2', '2026-02-15', '180.5', 'EA');
    proc(f, f.cpclId, f.cpMotor, null, f.supplierA, 'PO-3', '2026-03-20', '2', 'SET');
    const d = getSupplierIntelligenceDetail(f.supplierA);
    assert.ok(d);
    const eaRows = f.db
      .prepare(`SELECT quantity FROM procurement_records WHERE supplier_id = ? AND uom = 'EA'`)
      .all(f.supplierA) as Array<{ quantity: string }>;
    const eaSum = eaRows.reduce((acc, r) => {
      const [qi, qf = ''] = r.quantity.split('.');
      return acc + BigInt(qi) * 100n + BigInt((qf + '00').slice(0, 2));
    }, 0n);
    assert.equal(d.quantityByUom['EA'], '300.50');
    assert.equal(eaSum, 30050n, 'detail sum (120.00 + 180.50) matches summary in cents-scale ints');
    f.db.close();
  });

  test('14. procurement traceability: recent records resolve to source rows', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-TRACE', '2026-01-10', '120', 'EA', '1250.50', 'INR');
    const b = getSupplierIntelligenceBundle(f.supplierA);
    assert.ok(b);
    const rec = b.recentRecords.find((r) => r.materialCode === 'CP-1001');
    assert.ok(rec, 'original CPSE material code preserved');
    assert.equal(rec.orgCode, 'CPCL');
    assert.equal(rec.cmiCode, 'CMI-T-BRG');
    assert.equal(rec.uom, 'EA');
    assert.equal(rec.quantity, '120');
    assert.equal(rec.unitPrice, '1250.50');
    assert.equal(rec.currency, 'INR');
    const stored = f.db
      .prepare(`SELECT COUNT(*) n FROM procurement_records WHERE supplier_id = ? AND purchase_order_reference = 'PO-TRACE'`)
      .get(f.supplierA) as { n: number };
    assert.equal(stored.n, 1, 'metric traces back to the actual record');
    f.db.close();
  });

  test('15. server-side filters: org/date/UOM/currency restrict aggregation', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '10', 'EA', '100', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-2', '2026-06-10', '20', 'SET', '200', 'USD');
    proc(f, f.cpclId, f.cpMotor, null, f.supplierA, 'PO-3', '2026-03-10', '5', 'SET');
    const byOrg = listSuppliersWithIntelligence({ organizationId: f.ntpcId }, 1, 50).items;
    assert.equal(byOrg.find((r) => r.supplierId === f.supplierA)?.recordCount, 1);
    const byUom = listSuppliersWithIntelligence({ uom: 'EA' }, 1, 50).items;
    assert.equal(byUom.find((r) => r.supplierId === f.supplierA)?.recordCount, 1);
    const byCur = listSuppliersWithIntelligence({ currency: 'INR' }, 1, 50).items;
    assert.equal(byCur.find((r) => r.supplierId === f.supplierA)?.recordCount, 1);
    const byDate = listSuppliersWithIntelligence({ dateFrom: '2026-04-01' }, 1, 50).items;
    assert.equal(byDate.find((r) => r.supplierId === f.supplierA)?.recordCount, 1);
    f.db.close();
  });

  test('16. pagination: bounded pages with correct totals', () => {
    const f = baseFixture();
    for (let i = 1; i <= 5; i++) {
      proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-' + i, '2026-01-1' + i, '10', 'EA');
    }
    const p1 = listSuppliersWithIntelligence({}, 1, 2);
    assert.equal(p1.items.length, 2);
    assert.ok(p1.total >= 3);
    const p2 = listSuppliersWithIntelligence({}, 2, 2);
    assert.equal(p2.items.length, 1, 'final partial page bounded');
    const ids = [...p1.items, ...p2.items].map((r) => r.supplierId);
    assert.equal(new Set(ids).size, ids.length, 'pages do not overlap');
    assert.equal(ids.length, p1.total, 'all suppliers reachable through pagination');
    f.db.close();
  });

  test('17. supplier search: code + name, server-side', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '10', 'EA');
    const byCode = listSuppliersWithIntelligence({ q: 'SUP-A' }, 1, 50).items;
    assert.ok(byCode.some((r) => r.supplierId === f.supplierA));
    const byName = listSuppliersWithIntelligence({ q: 'alpha bearings' }, 1, 50).items;
    assert.ok(byName.some((r) => r.supplierId === f.supplierA));
    const miss = listSuppliersWithIntelligence({ q: 'nonexistent-vendor' }, 1, 50);
    assert.equal(miss.total, 0);
    assert.equal(miss.items.length, 0);
    f.db.close();
  });

  test('18. multi-supplier signal detection for a CMI', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '120', 'EA');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierB, 'PO-2', '2026-02-10', '180', 'EA');
    detectProcurementOpportunities();
    const row = f.db
      .prepare(`SELECT COUNT(*) n FROM procurement_opportunities WHERE opportunity_type = 'MULTI_SUPPLIER_ACTIVITY' AND cmi_id = ?`)
      .get(f.cmiId) as { n: number };
    assert.equal(row.n, 1, 'multi-supplier activity is a factual signal');
    f.db.close();
  });

  test('19. cross-CPSE supplier signal: observed pattern, never a rating', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '10', 'EA');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierA, 'PO-2', '2026-02-10', '10', 'EA');
    const cross = getCrossCpseSuppliers(2);
    assert.equal(cross.length, 1);
    for (const s of cross) {
      assert.ok(!('rank' in s) && !('score' in s) && !('rating' in s), 'no ranking fields on supplier rows');
      assert.ok(Array.isArray(s.cmiActivity));
    }
    f.db.close();
  });

  test('20. opportunity enrichment carries supplierId for traceable links', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '120', 'EA', '1250.50', 'INR');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierB, 'PO-2', '2026-02-10', '180', 'EA', '1250.50', 'INR');
    detectProcurementOpportunities();
    const rows = f.db
      .prepare(`SELECT evidence FROM procurement_opportunities WHERE opportunity_type = 'MULTI_SUPPLIER_ACTIVITY' AND cmi_id = ?`)
      .all(f.cmiId) as Array<{ evidence: string }>;
    assert.ok(rows.length >= 1);
    const ev = JSON.parse(rows[0].evidence) as { suppliers?: number; supplierActivity?: Array<{ supplier?: string; supplierId?: number }> };
    assert.equal(ev.suppliers, 2, 'supplier count in evidence');
    assert.ok(Array.isArray(ev.supplierActivity) && ev.supplierActivity.length >= 2, 'supplier activity attached as enrichment');
    for (const s of ev.supplierActivity) {
      assert.ok(typeof s.supplier === 'string');
      assert.ok(typeof s.supplierId === 'number', 'supplierId present so UI can link to supplier page');
    }
    f.db.close();
  });

  test('21. read-only surface: no supplier mutation exports in the analytics layer', () => {
    const svc = require('../src/lib/services/procurement-service') as Record<string, unknown>;
    const forbidden = Object.keys(svc).filter((k) =>
      /^(create|update|delete|award|select|rank|recommend|merge|approve).*Supplier.*/i.test(k) && k !== 'createSupplierRecord'
    );
    assert.equal(forbidden.length, 0, 'no supplier recommendation/award/merge mutations: ' + forbidden.join(','));
    const repo = require('../src/lib/db/repositories/procurement-repository') as Record<string, unknown>;
    const repoForbidden = Object.keys(repo).filter((k) => /^(rank|recommend|award|merge|approve).*Supplier.*/i.test(k));
    assert.equal(repoForbidden.length, 0);
  });

  test('22. read-only audit silence: supplier analytics create ZERO audit rows', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '120', 'EA', '1250.50', 'INR');
    const before = countAudit();
    listSuppliersWithIntelligence({}, 1, 50);
    getSupplierIntelligenceBundle(f.supplierA);
    getSupplierOrgActivity(f.supplierA);
    getSupplierCmiActivity(f.supplierA);
    getCrossCpseSuppliers(2);
    getSupplierRecordsShare(f.supplierA);
    cmiSupplierEvidenceRows([f.cmiId]);
    assert.equal(countAudit(), before, 'analytics reads must not audit');
    f.db.close();
  });

  test('23. banned language: no ranking/recommendation/savings anywhere', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '120', 'EA');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierB, 'PO-2', '2026-02-10', '180', 'EA');
    detectProcurementOpportunities();
    detectProcurementOpportunities();
    const rows = f.db
      .prepare(`SELECT title, description FROM procurement_opportunities`)
      .all() as Array<{ title: string; description: string }>;
    const banned = /best supplier|preferred supplier|top supplier|recommended supplier|save[sd]? |savings of|switch to supplier|supplier consolidation|reliable supplier|strategic supplier|national supplier/i;
    for (const r of rows) {
      assert.ok(!banned.test(r.title), 'banned language in title: ' + r.title);
      assert.ok(!banned.test(r.description), 'banned language in description: ' + r.description);
    }
    f.db.close();
  });

  test('24. no automatic supplier creation from procurement writes', () => {
    const f = baseFixture();
    const before = f.db.prepare('SELECT COUNT(*) n FROM suppliers').get() as { n: number };
    assert.throws(
      () =>
        createProcurementRecord(
          {
            organizationId: f.cpclId, materialId: f.cpclBearing, cmiId: f.cmiId,
            supplierId: 999999, purchaseOrderReference: 'PO-X', purchaseDate: '2026-01-10',
            quantity: '10', uom: 'EA', status: 'DELIVERED',
          },
          ACTOR
        ),
      /supplier/i,
      'unknown supplier rejected, never auto-created'
    );
    const after = f.db.prepare('SELECT COUNT(*) n FROM suppliers').get() as { n: number };
    assert.equal(after.n, before.n, 'supplier master untouched by rejected procurement write');
    f.db.close();
  });

  test('25. supplier status is master data: deactivation preserved, no fabricated statuses', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '10', 'EA');
    f.db.prepare(`UPDATE suppliers SET is_active = 0 WHERE id = ?`).run(f.supplierA);
    const rows = listSuppliersWithIntelligence({}, 1, 50).items;
    const a = rows.find((r) => r.supplierId === f.supplierA);
    assert.ok(a);
    assert.equal(a.isActive, false, 'master status surfaced verbatim');
    assert.equal(a.recordCount, 1, 'historical activity preserved');
    f.db.close();
  });

  test('26. no matching/CMI side effects from supplier analytics', () => {
    const f = baseFixture();
    proc(f, f.cpclId, f.cpclBearing, f.cmiId, f.supplierA, 'PO-1', '2026-01-10', '120', 'EA');
    proc(f, f.ntpcId, f.ntpcBearing, f.cmiId, f.supplierB, 'PO-2', '2026-02-10', '180', 'EA');
    const cmisBefore = (f.db.prepare('SELECT COUNT(*) n FROM common_materials').get() as { n: number }).n;
    const mapsBefore = (f.db.prepare('SELECT COUNT(*) n FROM material_mappings').get() as { n: number }).n;
    const candBefore = (f.db.prepare('SELECT COUNT(*) n FROM match_candidates').get() as { n: number }).n;
    listSuppliersWithIntelligence({}, 1, 50);
    getSupplierIntelligenceBundle(f.supplierA);
    getCrossCpseSuppliers(2);
    getSupplierRecordsShare(f.supplierA);
    const cmisAfter = (f.db.prepare('SELECT COUNT(*) n FROM common_materials').get() as { n: number }).n;
    const mapsAfter = (f.db.prepare('SELECT COUNT(*) n FROM material_mappings').get() as { n: number }).n;
    const candAfter = (f.db.prepare('SELECT COUNT(*) n FROM match_candidates').get() as { n: number }).n;
    assert.equal(cmisAfter, cmisBefore, 'no CMI created');
    assert.equal(mapsAfter, mapsBefore, 'no mapping created');
    assert.equal(candAfter, candBefore, 'matching untouched');
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
