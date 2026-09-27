/**
 * Step 14 — procurement spend & demand aggregation regression suite.
 *
 * `npx tsx tests/procurement-analytics.test.ts` (part of the npm test chain).
 *
 * Runs against a fresh isolated temp SQLite DB (migrations applied), seeded
 * with the Step-12-style fixture (2 CPSEs, 2 CMIs, 2 suppliers, mapped +
 * unharmonized materials). Pins the Step-14 contract:
 *
 *   1. CMI summary (records, CPSEs, suppliers, dates)
 *   2. CMI + CPSE demand
 *   3. CMI + supplier summary
 *   4. monthly demand (incl. gap-filled zero months + date-range filter)
 *   5. organization summary
 *   6. harmonization coverage
 *   7. unharmonized records remain visible (NULL cmi_id path)
 *   8. UOM grouping (EA + SET never merged)
 *   9. currency grouping (INR + USD never merged)
 *  10. NULL price: counted, not fabricated as 0 spend
 *  11. decimal precision (0.1 + 0.2 artifacts impossible)
 *  12. quantity validation (DEC2 guard unchanged)
 *  13. date filtering on aggregation
 *  14. supplier filtering (list path)
 *  15. status filtering (list path)
 *  16. pagination preserved
 *  17. authorization (guard contract re-asserted)
 *  18. read operations create NO audit rows
 *  19. CMI with no procurement (empty aggregation)
 *  20. CMI with multiple CPSEs
 *  21. aggregation reconciliation (sum(detail) === aggregation, exact)
 *  22. large synthetic dataset correctness (5k rows, reconciliation + perf)
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
  listProcurementRecords,
  getCmiProcurementSummary,
  getCmiDemandByOrganization,
  getCmiSupplierSummary,
  getCmiMonthlyDemand,
  getOrganizationProcurementSummaries,
  listCmiProcurementOverviews,
  getProcurementCoverage,
} from '../src/lib/services/procurement-service';
import { centsToDecimal } from '../src/lib/db/repositories/procurement-repository';
import { upsertAttribute } from '../src/lib/db/repositories/material-repository';
import { runMatching, decideMatch, createCmiFromMatch } from '../src/lib/services/matching-service';
import { assertOrganizationWrite } from '../src/lib/auth/guard';
import type { SessionUser } from '../src/lib/auth/types';

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

const ACTOR = 'procurement-analytics-test';

interface Fixture {
  db: DatabaseSync;
  cpclId: number;
  ntpcId: number;
  cmiAId: number;
  cmiBId: number;
  cpclBearing: number;
  ntpcBearing: number;
  unharmonized: number;
  supplierA: number;
  supplierB: number;
  auditCountBefore: number;
}

function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-pan-'));
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
  const cpMotor = Number(ins.run(cpcl, 'CP-5001', 'SIEMENS 3PH INDUCTION MOTOR 15KW 415V', 'SIEMENS 3PH INDUCTION MOTOR 15KW 415V', 'Motors', 'SIEMENS', '15KW-415V', 'EA', now, now).lastInsertRowid);
  for (const id of [cpBrg, ntBrg]) {
    upsertAttribute({ materialId: id, attributeName: 'series', value: '6205', isCritical: true, extractionMethod: 'rule' });
    upsertAttribute({ materialId: id, attributeName: 'seal_type', value: '2RS', normalizedValue: '2RS', isCritical: true, extractionMethod: 'rule' });
  }
  process.env.CMI_SHORT_CIRCUIT = 'off';
  runMatching('pan-test');
  const pair = db.prepare(`SELECT id FROM match_candidates WHERE status='pending' ORDER BY id LIMIT 1`).get() as { id: number };
  decideMatch(pair.id, { decision: 'approved', reviewer: 'rev@demo' }, 'rev@demo');
  const cmiA = createCmiFromMatch({ code: 'CMI-T-BRG', name: 'Test bearing CMI', category: 'Bearings', matchId: pair.id }, 'rev@demo');
  db.prepare(`INSERT INTO common_materials (code, name, category, source_match_id, is_active, created_at, updated_at) VALUES ('CMI-T-EMPTY', 'Empty CMI', 'Bearings', ?, 1, ?, ?)`).run(pair.id, now, now);
  const cmiBId = (db.prepare(`SELECT id FROM common_materials WHERE code='CMI-T-EMPTY'`).get() as { id: number }).id;
  const supA = createSupplierRecord({ supplierCode: 'SUP-A', supplierName: 'Supplier A', region: 'IN' }, ACTOR).id;
  const supB = createSupplierRecord({ supplierCode: 'SUP-B', supplierName: 'Supplier B', region: 'IN' }, ACTOR).id;
  const auditCountBefore = (db.prepare('SELECT COUNT(*) n FROM audit_logs').get() as { n: number }).n;
  return { db, cpclId: cpcl, ntpcId: ntpc, cmiAId: cmiA.cmiId, cmiBId, cpclBearing: cpBrg, ntpcBearing: ntBrg, unharmonized: cpMotor, supplierA: supA, supplierB: supB, auditCountBefore };
}

/** Seed a small deterministic analytics corpus: 2 CPSEs, 2 suppliers, 2 UOMs, 2 currencies, NULL prices, 4 months. */
function seedCorpus(f: Fixture): void {
  const orgOf = new Map<number, number>(
    (f.db.prepare('SELECT id, organization_id FROM material_records').all() as unknown as Array<{ id: number; organization_id: number }>).map((r) => [Number(r.id), Number(r.organization_id)])
  );
  const rows: Array<[number, number | null, number, string, string, string, string | null, string | null]> = [
    // material, cmi, supplier, date, qty, uom, price, currency
    [f.cpclBearing, f.cmiAId, f.supplierA, '2026-01-05', '120', 'EA', '1250.50', 'INR'],
    [f.ntpcBearing, f.cmiAId, f.supplierA, '2026-01-19', '180', 'EA', '1199.99', 'INR'],
    [f.cpclBearing, f.cmiAId, f.supplierB, '2026-03-04', '90', 'EA', '1300.00', 'INR'],
    [f.ntpcBearing, f.cmiAId, f.supplierB, '2026-03-28', '10.25', 'SET', '80.05', 'USD'],
    [f.ntpcBearing, f.cmiAId, f.supplierB, '2026-04-15', '5', 'SET', null, null],
  ];
  const pois: Array<[number, number, number | null, number, string, string, string, string, string | null, string | null]> = [];
  let po = 0;
  for (const [mat, cmi, sup, date, qty, uom, price, cur] of rows) {
    po++;
    pois.push([orgOf.get(mat)!, mat, cmi, sup, `PO-PAN-${String(po).padStart(3, '0')}`, date, qty, uom, price, cur]);
  }
  // unharmonized + multi-currency extras
  pois.push([f.cpclId, f.unharmonized, null, f.supplierA, 'PO-PAN-UNH-1', '2026-02-11', '25', 'SET', '860.00', 'INR']);
  pois.push([f.cpclId, f.unharmonized, null, f.supplierB, 'PO-PAN-UNH-2', '2026-05-02', '3', 'EA', '45.10', 'USD']);
  for (const [org, mat, cmi, sup, poref, date, qty, uom, price, cur] of pois) {
    createProcurementRecord(
      {
        organizationId: org, materialId: mat, cmiId: cmi, supplierId: sup,
        purchaseOrderReference: poref, purchaseDate: date,
        quantity: qty, uom, unitPrice: price ?? undefined, currency: cur ?? undefined,
        status: 'DELIVERED',
      },
      ACTOR
    );
  }
}

function main(): void {
  test('1. CMI summary: records, CPSEs, suppliers, priced/unpriced, dates', () => {
    const f = fixture();
    seedCorpus(f);
    const s = getCmiProcurementSummary(f.cmiAId)!;
    assert.ok(s, 'summary exists');
    assert.equal(s.cmiCode, 'CMI-T-BRG');
    assert.equal(s.recordCount, 5);
    assert.equal(s.orgCount, 2, 'two CPSEs purchase this CMI');
    assert.equal(s.supplierCount, 2);
    assert.equal(s.pricedRecords, 4);
    assert.equal(s.unpricedRecords, 1, 'NULL price counted, never fabricated');
    assert.equal(s.firstPurchaseDate, '2026-01-05');
    assert.equal(s.lastPurchaseDate, '2026-04-15');
    assert.equal(s.isActive, true);
    f.db.close();
  });

  test('2. CMI + CPSE demand preserves UOM per organization', () => {
    const f = fixture();
    seedCorpus(f);
    const rows = getCmiDemandByOrganization(f.cmiAId)!;
    assert.equal(rows.length, 2);
    const cpcl = rows.find((r) => r.orgCode === 'CPCL')!;
    const ntpc = rows.find((r) => r.orgCode === 'NTPC')!;
    assert.equal(cpcl.recordCount, 2);
    assert.equal(ntpc.recordCount, 3);
    assert.equal(cpcl.quantityByUom['EA'], '210', '120 + 90 exact');
    assert.equal(ntpc.quantityByUom['EA'], '180');
    assert.equal(ntpc.quantityByUom['SET'], '15.25', '10.25 + 5 exact, separate UOM');
    f.db.close();
  });

  test('3. CMI + supplier summary is descriptive with per-UOM/currency totals', () => {
    const f = fixture();
    seedCorpus(f);
    const rows = getCmiSupplierSummary(f.cmiAId);
    assert.equal(rows.length, 2);
    const a = rows.find((r) => r.supplierCode === 'SUP-A')!;
    const b = rows.find((r) => r.supplierCode === 'SUP-B')!;
    assert.equal(a.recordCount, 2);
    assert.equal(b.recordCount, 3);
    assert.equal(b.unpricedRecords, 1, 'unpriced attributed to the right supplier');
    assert.equal(b.quantityByUom['SET'], '15.25');
    f.db.close();
  });

  test('4. Monthly demand: exact months, gap-filled zeros, date-range filter', () => {
    const f = fixture();
    seedCorpus(f);
    const all = getCmiMonthlyDemand(f.cmiAId);
    assert.equal(all.length, 4, '2026-01..2026-04 contiguous');
    assert.deepEqual(all.map((m) => m.month), ['2026-01', '2026-02', '2026-03', '2026-04']);
    assert.equal(all[1].recordCount, 0, 'February gap-filled with zero, not dropped');
    assert.equal(all[0].quantityByUom['EA'], '300');
    assert.equal(all[2].quantityByUom['EA'], '90');
    const ranged = getCmiMonthlyDemand(f.cmiAId, '2026-03-01', '2026-12-31');
    assert.deepEqual(ranged.map((m) => m.month), ['2026-03', '2026-04'], 'from-filter respected');
    f.db.close();
  });

  test('5. Organization summary: linked/unharmonized split, zero-procurement orgs included', () => {
    const f = fixture();
    seedCorpus(f);
    const rows = getOrganizationProcurementSummaries();
    assert.equal(rows.length, 2, 'every CPSE appears');
    const cpcl = rows.find((r) => r.orgCode === 'CPCL')!;
    assert.equal(cpcl.recordCount, 4);
    assert.equal(cpcl.cmiLinkedRecords, 2);
    assert.equal(cpcl.unharmonizedRecords, 2);
    assert.equal(cpcl.spendByCurrency['INR'], '288560', '120x1250.50 + 25x860.00 + 90x1300.00 exact');
    f.db.close();
  });

  test('6. Harmonization coverage: linked/total exact ratio + per-state splits', () => {
    const f = fixture();
    seedCorpus(f);
    const c = getProcurementCoverage();
    assert.equal(c.totalRecords, 7);
    assert.equal(c.cmiLinkedRecords, 5);
    assert.equal(c.unharmonizedRecords, 2);
    assert.ok(Math.abs(c.coverageRatio! - 5 / 7) < 1e-12);
    assert.equal(c.totalQuantityByUom['EA'], '393', '210+180+3 exact');
    assert.equal(c.cmiLinkedQuantityByUom['EA'], '390');
    assert.equal(c.unharmonizedQuantityByUom['EA'], '3');
    assert.equal(c.spendByCurrency['INR'], '504558.20');
    assert.equal(c.cmiLinkedSpendByCurrency['INR'], '483058.20');
    assert.equal(c.unharmonizedSpendByCurrency['INR'], '21500', '25 x 860.00 (trailing .00 stripped by centsToDecimal)');
    assert.equal(c.cmiLinkedSpendByCurrency['USD'], '820.51', '10.25 x 80.05');
    assert.equal(c.unharmonizedSpendByCurrency['USD'], '135.30');
    f.db.close();
  });

  test('7. Unharmonized records remain visible through the standard list path', () => {
    const f = fixture();
    seedCorpus(f);
    const unharm = listProcurementRecords({ harmonized: false }, 1, 50);
    assert.equal(unharm.total, 2);
    assert.ok(unharm.items.every((i) => i.record.cmi_id === null && i.cmi_code === null));
    const harm = listProcurementRecords({ harmonized: true }, 1, 50);
    assert.equal(harm.total, 5);
    f.db.close();
  });

  test('8. UOM grouping: EA and SET never merged (no fabricated conversion)', () => {
    const f = fixture();
    seedCorpus(f);
    const s = getCmiProcurementSummary(f.cmiAId)!;
    assert.equal(s.uoms.length, 2);
    assert.equal(s.totalQuantityByUom['EA'], '390');
    assert.equal(s.totalQuantityByUom['SET'], '15.25');
    assert.equal(s.totalQuantityByUom['undefined'], undefined, 'no merged bucket exists');
    f.db.close();
  });

  test('9. Currency grouping: INR and USD never merged, no exchange rate invented', () => {
    const f = fixture();
    seedCorpus(f);
    const c = getProcurementCoverage();
    assert.equal(Object.keys(c.spendByCurrency).length, 2);
    assert.ok('INR' in c.spendByCurrency && 'USD' in c.spendByCurrency);
    assert.equal(c.spendByCurrency['INR'], '504558.20');
    assert.equal(c.spendByCurrency['USD'], '955.81');
    f.db.close();
  });

  test('10. NULL price: contributes quantity/counts but zero fabricated spend', () => {
    const f = fixture();
    seedCorpus(f);
    const s = getCmiProcurementSummary(f.cmiAId)!;
    assert.equal(s.pricedRecords, 4);
    assert.equal(s.unpricedRecords, 1);
    // 10.25 SET x 80.05 = 820.5125 -> stored/rounded to cents 820.51 (SET USD bucket)
    assert.equal(s.spendByCurrency['USD'], '820.51');
    const orgRows = getCmiDemandByOrganization(f.cmiAId)!;
    const ntpc = orgRows.find((r) => r.orgCode === 'NTPC')!;
    assert.equal(ntpc.spendByCurrency['USD'], '820.51');
    f.db.close();
  });

  test('11. Decimal precision: 0.1+0.2 has no float artifacts (BigInt cents)', () => {
    const f = fixture();
    const r1 = createProcurementRecord({ organizationId: f.cpclId, materialId: f.unharmonized, cmiId: null, supplierId: f.supplierA, purchaseOrderReference: 'PO-DEC-1', purchaseDate: '2026-03-01', quantity: '0.1', uom: 'EA', unitPrice: '0.1', currency: 'INR', status: 'ORDERED' }, ACTOR);
    const r2 = createProcurementRecord({ organizationId: f.cpclId, materialId: f.unharmonized, cmiId: null, supplierId: f.supplierA, purchaseOrderReference: 'PO-DEC-2', purchaseDate: '2026-03-02', quantity: '0.2', uom: 'EA', unitPrice: '0.1', currency: 'INR', status: 'ORDERED' }, ACTOR);
    void r1; void r2;
    const s = getCmiProcurementSummary(f.cmiBId); // empty CMI sanity
    assert.ok(s);
    const unharmRows = listProcurementRecords({ harmonized: false }, 1, 10);
    assert.equal(unharmRows.total, 2);
    const cov = getProcurementCoverage();
    assert.equal(cov.totalQuantityByUom['EA'], '0.30', 'exactly 0.30, never 0.30000000000000004');
    assert.equal(cov.spendByCurrency['INR'], '0.03', 'exactly 0.03');
    f.db.close();
  });

  test('12. Quantity validation guard unchanged (DEC2, >0)', () => {
    const f = fixture();
    assert.throws(
      () => createProcurementRecord({ organizationId: f.cpclId, materialId: f.unharmonized, cmiId: null, supplierId: f.supplierA, purchaseOrderReference: 'PO-BADQ', purchaseDate: '2026-03-01', quantity: '0.333', uom: 'EA', status: 'ORDERED' }, ACTOR),
      /exact decimal/
    );
    assert.throws(
      () => createProcurementRecord({ organizationId: f.cpclId, materialId: f.unharmonized, cmiId: null, supplierId: f.supplierA, purchaseOrderReference: 'PO-BADQ2', purchaseDate: '2026-03-01', quantity: '0', uom: 'EA', status: 'ORDERED' }, ACTOR),
      /positive|> 0|quantity/
    );
    f.db.close();
  });

  test('13. Date filtering on aggregation path (monthly demand range)', () => {
    const f = fixture();
    seedCorpus(f);
    const q1 = getCmiMonthlyDemand(f.cmiAId, '2026-01-01', '2026-03-31');
    assert.deepEqual(q1.map((m) => m.month), ['2026-01', '2026-02', '2026-03']);
    assert.equal(q1[q1.length - 1].quantityByUom['EA'], '90');
    f.db.close();
  });

  test('14/15/16. Supplier + status filters and pagination on the list path', () => {
    const f = fixture();
    seedCorpus(f);
    const bySup = listProcurementRecords({ supplierId: f.supplierA }, 1, 50);
    assert.equal(bySup.total, 3);
    const delivered = listProcurementRecords({ status: 'DELIVERED' }, 1, 3);
    assert.equal(delivered.items.length, 3, 'bounded page size respected');
    assert.equal(delivered.total, 7);
    const page2 = listProcurementRecords({}, 2, 3);
    assert.equal(page2.items.length, 3);
    assert.notEqual(page2.items[0].record.id, delivered.items[0].record.id, 'pagination slices differ');
    // Section 20: currency + UOM exact-match filters (server-side).
    const inr = listProcurementRecords({ currency: 'INR' }, 1, 50);
    assert.equal(inr.total, 4, 'INR rows only');
    const usd = listProcurementRecords({ currency: 'USD' }, 1, 50);
    assert.equal(usd.total, 2, 'USD rows only (never mixed with INR)');
    const ea = listProcurementRecords({ uom: 'EA' }, 1, 50);
    assert.equal(ea.total, 4, 'EA rows only');
    const set = listProcurementRecords({ uom: 'SET' }, 1, 50);
    assert.equal(set.total, 3, 'SET rows only (never merged with EA)');
    const both = listProcurementRecords({ currency: 'USD', uom: 'SET' }, 1, 50);
    assert.equal(both.total, 1, 'compound currency+UOM filter');
    f.db.close();
  });

  test('17. Authorization contract unchanged (server-side org guard)', () => {
    const f = fixture();
    const cpseUser: SessionUser = { id: 9, name: 'CP', email: 'cp@demo', role: 'cpse_material_manager', organizationId: f.cpclId, organizationCode: 'CPCL', organizationName: 'CPCL', demoSwitched: false };
    const otherCpse: SessionUser = { ...cpseUser, organizationId: f.ntpcId, organizationCode: 'NTPC' };
    const authority: SessionUser = { id: 10, name: 'AU', email: 'au@demo', role: 'authority', organizationId: null, organizationCode: null, organizationName: null, demoSwitched: false };
    assert.doesNotThrow(() => assertOrganizationWrite(cpseUser, f.cpclId));
    assert.throws(() => assertOrganizationWrite(otherCpse, f.cpclId), /different CPSE/);
    assert.throws(() => assertOrganizationWrite(authority, f.cpclId), /read-only/);
    f.db.close();
  });

  test('18. Read operations create NO audit rows', () => {
    const f = fixture();
    seedCorpus(f);
    const before = (f.db.prepare('SELECT COUNT(*) n FROM audit_logs').get() as { n: number }).n;
    getCmiProcurementSummary(f.cmiAId);
    getCmiDemandByOrganization(f.cmiAId);
    getCmiSupplierSummary(f.cmiAId);
    getCmiMonthlyDemand(f.cmiAId);
    getOrganizationProcurementSummaries();
    listCmiProcurementOverviews();
    getProcurementCoverage();
    listProcurementRecords({}, 1, 50);
    const after = (f.db.prepare('SELECT COUNT(*) n FROM audit_logs').get() as { n: number }).n;
    assert.equal(after, before, 'analytics reads are audit-silent');
    f.db.close();
  });

  test('19. CMI with no procurement: zeroed aggregation and null dates', () => {
    const f = fixture();
    const s = getCmiProcurementSummary(f.cmiBId)!;
    assert.ok(s, 'empty CMI still summarizes');
    assert.equal(s.recordCount, 0);
    assert.equal(s.orgCount, 0);
    assert.equal(s.supplierCount, 0);
    assert.deepEqual(s.totalQuantityByUom, {});
    assert.deepEqual(s.spendByCurrency, {});
    assert.equal(s.firstPurchaseDate, null);
    assert.equal(s.lastPurchaseDate, null);
    const ov = listCmiProcurementOverviews();
    const empty = ov.find((o) => o.cmiId === f.cmiBId)!;
    assert.equal(empty.recordCount, 0, 'overview includes CMIs without activity');
    f.db.close();
  });

  test('20. CMI with multiple CPSEs: org demand rows carry both', () => {
    const f = fixture();
    seedCorpus(f);
    const rows = getCmiDemandByOrganization(f.cmiAId)!;
    assert.deepEqual(rows.map((r) => r.orgCode).sort(), ['CPCL', 'NTPC']);
    assert.equal(rows.reduce((a, r) => a + r.recordCount, 0), 5, 'no silent row loss across CPSEs');
    f.db.close();
  });

  test('21. Aggregation reconciliation: sum(detail) === aggregation at every level', () => {
    const f = fixture();
    seedCorpus(f);
    const details = f.db.prepare('SELECT cmi_id, uom, currency, quantity, unit_price FROM procurement_records').all() as unknown as Array<{ cmi_id: number | null; uom: string; currency: string | null; quantity: string; unit_price: string | null }>;
    const cents = (v: string): bigint => {
      const [i, frac = ''] = v.split('.');
      return BigInt(i + frac.padEnd(2, '0').slice(0, 2));
    };
    const expectQty: Record<string, bigint> = {};
    for (const d of details) {
      if (d.cmi_id !== f.cmiAId) continue;
      expectQty[d.uom] = (expectQty[d.uom] ?? 0n) + cents(d.quantity);
    }
    const s = getCmiProcurementSummary(f.cmiAId)!;
    for (const [uom, expectCents] of Object.entries(expectQty)) {
      assert.equal(cents(s.totalQuantityByUom[uom] ?? '0'), expectCents, 'CMI qty reconciliation for ' + uom);
    }
    // Spend: q*x*p where both have 2dp -> product has 4dp; DB rounds at 2dp of the product.
    const expectSpend: Record<string, bigint> = {};
    for (const d of details) {
      if (!d.unit_price || !d.currency) continue;
      const prod = cents(d.quantity) * cents(d.unit_price); // value in 1e-4 currency units
      expectSpend[d.currency] = (expectSpend[d.currency] ?? 0n) + prod / 100n; // 1e-4 units -> cents
    }
    const cov = getProcurementCoverage();
    for (const [cur, expectCents] of Object.entries(expectSpend)) {
      assert.equal(cents(cov.spendByCurrency[cur] ?? '0'), expectCents, 'coverage spend reconciliation for ' + cur);
    }
    const orgRows = getOrganizationProcurementSummaries();
    assert.equal(orgRows.reduce((a, r) => a + r.recordCount, 0), cov.totalRecords, 'org records reconcile to total');
    f.db.close();
  });

  test('22. Large synthetic dataset: 5k rows reconcile and aggregate fast', () => {
    const f = fixture();
    const t0 = Date.now();
    const ins = f.db.prepare(
      "INSERT INTO procurement_records (organization_id, material_id, cmi_id, supplier_id, purchase_order_reference, purchase_date, quantity, uom, unit_price, currency, procurement_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DELIVERED', datetime('now'), datetime('now'))"
    );
    f.db.exec('BEGIN');
    for (let i = 0; i < 5000; i++) {
      const cmi = i % 2 === 0 ? f.cmiAId : null;
      const mat = i % 2 === 0 ? f.cpclBearing : f.unharmonized;
      const org = i % 2 === 0 ? f.cpclId : f.ntpcId;
      const sup = i % 3 === 0 ? f.supplierB : f.supplierA;
      const priced = i % 5 !== 0;
      ins.run(
        org, mat, cmi, sup,
        'PO-BULK-' + i,
        '2026-0' + (1 + (i % 6)) + '-' + String(1 + (i % 28)).padStart(2, '0'),
        String((i % 400) + 1) + '.' + String(i % 100).padStart(2, '0'),
        i % 2 === 0 ? 'EA' : 'SET',
        priced ? String((i % 900) + 10) + '.' + String(i % 100).padStart(2, '0') : null,
        priced ? 'INR' : null
      );
    }
    f.db.exec('COMMIT');
    const insertMs = Date.now() - t0;

    const t1 = Date.now();
    const cov = getProcurementCoverage();
    const coverageMs = Date.now() - t1;
    assert.equal(cov.totalRecords, 5000);

    const s = getCmiProcurementSummary(f.cmiAId)!;
    assert.equal(s.recordCount, 2500);
    const raw = f.db.prepare(
      'SELECT uom, CAST(SUM(CAST(ROUND(quantity * 100) AS INTEGER)) AS TEXT) s FROM procurement_records WHERE cmi_id = ? GROUP BY uom'
    ).all(f.cmiAId) as unknown as Array<{ uom: string; s: string }>;
    for (const r of raw) {
      assert.equal(centsToDecimal(r.s), s.totalQuantityByUom[r.uom], '5k reconciliation ' + r.uom);
    }
    const t2 = Date.now();
    getOrganizationProcurementSummaries();
    listCmiProcurementOverviews();
    const multiMs = Date.now() - t2;
    console.log('    [perf] 5k insert ' + insertMs + 'ms, coverage ' + coverageMs + 'ms, summaries ' + multiMs + 'ms');
    assert.ok(coverageMs < 2000, 'coverage aggregation over 5k rows stays interactive');
    f.db.close();
  });

  console.log('\nprocurement-analytics: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    for (const x of failures) console.log('  FAILED: ' + x);
    process.exit(1);
  }
}

main();
