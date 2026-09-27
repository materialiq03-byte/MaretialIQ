/**
 * Step 12 - deterministic synthetic procurement dataset seeder.
 *
 * Representative synthetic procurement data for demonstration — NOT actual
 * CPSE purchasing records. Deterministic: same DB state + seed => identical
 * rows. Idempotent: re-running skips already-present purchase-order
 * references and reports inserted/skipped.
 *
 * SAFETY: refuses to run against PostgreSQL (writes only to the isolated
 * SQLite the DATA_DIR points at) and refuses to run when procurement records
 * already exist from another source system.
 *
 *   DATA_DIR=<isolated dir> npx tsx scripts/seed-procurement.ts
 */
import { getRawSqliteDb, getDb } from '../src/lib/db/client';
import { getDialect } from '../src/lib/db/dialect';
import { migrate } from '../src/lib/db/migrate';
import { createProcurementRecord, createSupplierRecord } from '../src/lib/services/procurement-service';
import { listProcurementRecords } from '../src/lib/db/repositories/procurement-repository';
import type { ProcurementStatus } from '../src/lib/types/domain';

if (getDialect() !== 'sqlite') {
  console.error('Refusing to run: procurement seed writes only to isolated SQLite (unset MATERIALIQ_DB_DIALECT).');
  process.exit(1);
}

const db = getRawSqliteDb();
migrate(db);

/** Deterministic small PRNG (mulberry32) — no Math.random anywhere. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SupplierSeed {
  code: string; name: string; region: string;
}

const SUPPLIERS: SupplierSeed[] = [
  { code: 'SUP-SKF-INDIA', name: 'SKF India Ltd', region: 'Pune, IN' },
  { code: 'SUP-FAG-IBL', name: 'FAG Industrial Bearings', region: 'Chennai, IN' },
  { code: 'SUP-AUDCO', name: 'Audco India Ltd', region: 'Chennai, IN' },
  { code: 'SUP-KIRLOSKAR', name: 'Kirloskar Brothers Ltd', region: 'Pune, IN' },
  { code: 'SUP-UNB', name: 'Unbrako Fasteners', region: 'Faridabad, IN' },
  { code: 'SUP-TVSSUNDARAM', name: 'TVS Sundaram Fasteners', region: 'Madurai, IN' },
  { code: 'SUP-LNT-VALVES', name: 'L&T Valves', region: 'Coimbatore, IN' },
  { code: 'SUP-KSB', name: 'KSB Pumps Ltd', region: 'Pune, IN' },
  { code: 'SUP-CRI', name: 'CRI Pumps', region: 'Coimbatore, IN' },
  { code: 'SUP-BHEL-EPD', name: 'BHEL Electrical Products Div', region: 'Bhopal, IN' },
];

const STATUSES: ProcurementStatus[] = ['ORDERED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED'];

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function main(): void {
  // --- Idempotency probe ---------------------------------------------------
  const existing = (db.prepare('SELECT COUNT(*) n FROM procurement_records').get() as { n: number }).n;
  if (existing > 0) {
    console.log(`procurement_records already has ${existing} row(s) - seed skipped (idempotent).`);
    return;
  }

  const actor = 'procurement-seed';
  let suppliersCreated = 0;
  for (const s of SUPPLIERS) {
    const dup = db.prepare('SELECT id FROM suppliers WHERE supplier_code = ?').get(s.code);
    if (dup) continue;
    createSupplierRecord({ supplierCode: s.code, supplierName: s.name, region: s.region }, actor);
    suppliersCreated++;
  }
  const supplierIds = new Map<string, number>();
  for (const row of db.prepare('SELECT id, supplier_code FROM suppliers').all() as Array<{ id: number; supplier_code: string }>) {
    supplierIds.set(row.supplier_code, row.id);
  }

  // --- Resolve materials ----------------------------------------------------
  const byCode = (code: string, org: string): { id: number; org: number; category: string } | null => {
    const r = db
      .prepare(
        `SELECT m.id, m.organization_id, m.category FROM material_records m
          JOIN organizations o ON o.id = m.organization_id
         WHERE m.original_code = ? AND o.code = ?`
      )
      .get(code, org) as { id: number; organization_id: number; category: string } | undefined;
    return r ? { id: r.id, org: r.organization_id, category: r.category } : null;
  };

  const cmi = db.prepare(`SELECT id, code FROM common_materials WHERE code = 'CMI-BRG-6205' AND is_active = 1`).get() as { id: number } | undefined;
  const cmiMembers = cmi
    ? (db.prepare('SELECT material_id FROM material_mappings WHERE cmi_id = ?').all(cmi.id) as Array<{ material_id: number }>).map((r) => Number(r.material_id))
    : [];
  const cmiMat = (code: string, org: string): { id: number; org: number; category: string } | null => {
    const m = byCode(code, org);
    return m && cmiMembers.includes(m.id) ? m : null;
  };

  const ntpc6205 = cmi ? cmiMat('NT-8821', 'NTPC') : null;
  const sail6205 = cmi ? cmiMat('SL-7721', 'SAIL') : null;
  const cpcl6205 = cmi ? cmiMat('CP-1001', 'CPCL') : null;
  // A harmonized-agnostic unharmonized material: pick any NTPC motor/valve that has no mapping.
  const unharmonized = db
    .prepare(
      `SELECT m.id, m.organization_id, m.category, m.original_code FROM material_records m
        LEFT JOIN material_mappings mm ON mm.material_id = m.id
       WHERE mm.id IS NULL AND m.original_code = 'NT-5510'
       LIMIT 1`
    )
    .get() as { id: number; organization_id: number; category: string; original_code: string } | undefined;

  const inserts: Array<{ orgId: number; matId: number; cmiId: number | null; supCode: string; po: string; date: string; qty: string; uom: string; price: string | null; status: ProcurementStatus; note: string }> = [];

  // --- Scenario A: common-CMI demand across the three mapped CPSEs ----------
  // (Same CMI-BRG-6205 identity, three CPSE codes, deterministic quantities.)
  const scenarioA: Array<[typeof cpcl6205, string, string, string]> = [
    [cpcl6205, 'CPCL', '120', '2026-03-04'],
    [ntpc6205, 'NTPC', '180', '2026-03-19'],
    [sail6205, 'SAIL', '90', '2026-04-07'],
  ];
  let aSeq = 0;
  for (const [mat, org, qty, date] of scenarioA) {
    if (!mat) continue;
    aSeq++;
    inserts.push({
      orgId: mat.org, matId: mat.id, cmiId: cmi?.id ?? null,
      supCode: pick(makeRng(1000 + aSeq), ['SUP-SKF-INDIA', 'SUP-FAG-IBL']),
      po: `PO-BRG6205-${String(aSeq).padStart(3, '0')}`,
      date, qty, uom: 'EA',
      price: pick(makeRng(2000 + aSeq), ['1250.50', '1310.00', '1198.25']),
      status: 'DELIVERED', note: 'scenario-A',
    });
  }

  // --- Scenario B: unharmonized material (cmi_id = NULL) ---------------------
  if (unharmonized) {
    inserts.push({
      orgId: unharmonized.organization_id, matId: unharmonized.id, cmiId: null,
      supCode: 'SUP-BHEL-EPD', po: 'PO-UNH-001', date: '2026-02-11',
      qty: '25', uom: 'SET', price: '860.00', status: 'ORDERED', note: 'scenario-B',
    });
  }

  // --- Scenarios C/D/E: multi-supplier, multi-month, all five CPSEs ----------
  // Deterministic spread over 2026-01..2026-06 across every organization.
  const rng = makeRng(20260101);
  const orgs = db.prepare('SELECT id, code FROM organizations ORDER BY code').all() as Array<{ id: number; code: string }>;
  const supCodes = SUPPLIERS.map((s) => s.code);
  const statusWeights: ProcurementStatus[] = ['DELIVERED', 'DELIVERED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'ORDERED', 'CANCELLED'];
  const monthDays: Array<[string, number]> = [['2026-01', 31], ['2026-02', 28], ['2026-03', 31], ['2026-04', 30], ['2026-05', 31], ['2026-06', 30]];
  const bulkMaterials = db
    .prepare(
      `SELECT m.id, m.organization_id, m.category, m.uom, m.original_code FROM material_records m
        LEFT JOIN material_mappings mm ON mm.material_id = m.id
       WHERE mm.id IS NULL ORDER BY m.id`
    )
    .all() as Array<{ id: number; organization_id: number; category: string; uom: string; original_code: string }>;
  const byOrg = new Map<number, typeof bulkMaterials>();
  for (const m of bulkMaterials) {
    if (!byOrg.has(m.organization_id)) byOrg.set(m.organization_id, []);
    byOrg.get(m.organization_id)!.push(m);
  }
  let eSeq = 0;
  const perOrg = 40; // 5 orgs -> 200 bulk records
  for (const org of orgs) {
    const pool = byOrg.get(org.id) ?? [];
    if (pool.length === 0) continue;
    for (let i = 0; i < perOrg; i++) {
      eSeq++;
      const mat = pool[Math.floor(rng() * pool.length)];
      const [month, days] = monthDays[Math.floor(rng() * monthDays.length)];
      const day = 1 + Math.floor(rng() * days);
      const qty = String(5 + Math.floor(rng() * 400));
      const priced = rng() > 0.15;
      inserts.push({
        orgId: org.id, matId: mat.id, cmiId: null,
        supCode: supCodes[Math.floor(rng() * supCodes.length)],
        po: `PO-GEN-${String(eSeq).padStart(4, '0')}`,
        date: `${month}-${String(day).padStart(2, '0')}`,
        qty,
        uom: mat.uom || 'EA',
        price: priced ? `${(50 + Math.floor(rng() * 4000))}.${String(Math.floor(rng() * 100)).padStart(2, '0')}` : null,
        status: statusWeights[Math.floor(rng() * statusWeights.length)],
        note: 'scenario-CDE',
      });
    }
  }

  // --- Step 17 (section 32): UOM harmonization demo cases --------------------
  // Representative alias/scale/incompatible/unknown coverage. Original UOM and
  // quantity are preserved by the platform (never mutated); normalization is
  // derived at read time from the uom_conversion_rules registry.
  const uomCases: Array<{ org: string; code: string; cmi: boolean; po: string; date: string; qty: string; uom: string; price: string | null; currency: string; sup: string }> = [
    { org: 'CPCL', code: 'CP-1001', cmi: true,  po: 'PO-UOM-001', date: '2026-05-14', qty: '0.25', uom: 'KG', price: '410.75', currency: 'INR', sup: 'SUP-SKF-INDIA' },      // SCALED -> 250 G
    { org: 'CPCL', code: 'CP-1001', cmi: true,  po: 'PO-UOM-002', date: '2026-05-21', qty: '1.5',  uom: 'PCS', price: null,      currency: 'INR', sup: 'SUP-FAG-IBL' },        // ALIAS -> 1.5 EA, NULL price
    { org: 'NTPC', code: 'NT-8821', cmi: true,  po: 'PO-UOM-003', date: '2026-06-02', qty: '12',   uom: 'SET', price: '980.00', currency: 'INR', sup: 'SUP-KIRLOSKAR' },      // no rule -> UNCONVERTED
    { org: 'SAIL', code: 'SL-7721', cmi: true,  po: 'PO-UOM-004', date: '2026-06-11', qty: '750',  uom: 'ML',  price: '33.10',  currency: 'USD', sup: 'SUP-KSB' },            // SCALED -> 0.75 L? no: ML unknown
    { org: 'BHEL', code: 'BH-2210', cmi: false, po: 'PO-UOM-005', date: '2026-06-18', qty: '3',    uom: 'TON', price: '8750.00', currency: 'INR', sup: 'SUP-LNT-VALVES' },     // SCALED -> 3,000,000 G
    { org: 'NLC',  code: 'NL-2214', cmi: false, po: 'PO-UOM-006', date: '2026-06-25', qty: '2.5',  uom: 'M',   price: '155.00', currency: 'EUR', sup: 'SUP-CRI' },            // SCALED -> 2500 MM
    { org: 'NTPC', code: 'NT-7150', cmi: false, po: 'PO-UOM-007', date: '2026-06-27', qty: '18',   uom: 'bX9', price: null,      currency: 'INR', sup: 'SUP-UNB' },            // UNKNOWN uom
  ];
  for (const c of uomCases) {
    const mat = c.cmi ? (byCode(c.code, c.org) as { id: number; org: number } | null) : null;
    const target = mat ?? byCode(c.code, c.org);
    if (!target) { console.error(`UOM demo material missing: ${c.code}/${c.org}`); continue; }
    inserts.push({
      orgId: target.org, matId: target.id, cmiId: c.cmi && cmi ? cmi.id : null,
      supCode: c.sup, po: c.po, date: c.date, qty: c.qty, uom: c.uom,
      price: c.price, status: 'DELIVERED', note: 'scenario-UOM',
    });
  }
  // Currency override per §32 multi-currency: rewrite the two non-INR cases.
  for (const r of inserts) {
    if (r.po === 'PO-UOM-004') { (r as { currencyHint?: string }).currencyHint = 'USD'; }
    if (r.po === 'PO-UOM-006') { (r as { currencyHint?: string }).currencyHint = 'EUR'; }
  }

  // --- Step 18 (§3/§4/§8): demo governed DOMAIN_SPECIFIC rule ---------------
  // A CMI-scoped SET -> EA pack conversion proposed for CMI-BRG-6205. It is
  // seeded PENDING and therefore has ZERO analytical effect (section 4:
  // PENDING = visible but not used; approval is a human governance act in
  // the UI/API). Creation is audited via the governed service path.
  if (cmi) {
    try {
      const { createUomDomainRule } = require('../src/lib/services/procurement-service') as typeof import('../src/lib/services/procurement-service');
      const rule = createUomDomainRule({
        cmiId: cmi.id,
        fromUom: 'SET',
        toUom: 'EA',
        factor: 10,
        reason:
          'Demo proposal (not yet approved): supplier pack sheet for this bearing family lists 1 SET = 10 EA. Pending human verification against the source document.',
        actor: 'seed@governance.demo',
      });
      console.log(`UOM domain rule proposed: ${rule.cmiCode} ${rule.fromUom}->${rule.toUom} x${rule.factor} (${rule.status})`);
    } catch (err) {
      // Idempotent re-seed: a live rule for (CMI, SET) already exists.
      console.log(`UOM domain rule seed skipped: ${(err as Error).message}`);
    }
  }

  // --- Execute inserts through the validated service ------------------------
  let inserted = 0;
  let rejected = 0;
  for (const r of inserts) {
    try {
      createProcurementRecord(
        {
          organizationId: r.orgId,
          materialId: r.matId,
          cmiId: r.cmiId,
          supplierId: supplierIds.get(r.supCode)!,
          purchaseOrderReference: r.po,
          purchaseDate: r.date,
          quantity: r.qty,
          uom: r.uom,
          unitPrice: r.price ?? undefined,
          currency: ((r as { currencyHint?: string }).currencyHint ?? (r.price ? 'INR' : undefined)) as 'INR' | 'USD' | 'EUR' | undefined,
          status: r.status,
          sourceSystem: 'synthetic-seed',
        },
        actor
      );
      inserted++;
    } catch (err) {
      rejected++;
      console.error(`REJECTED ${r.po}: ${(err as Error).message}`);
    }
  }

  // --- Report ----------------------------------------------------------------
  const total = (db.prepare('SELECT COUNT(*) n FROM procurement_records').get() as { n: number }).n;
  const cmiLinked = (db.prepare('SELECT COUNT(*) n FROM procurement_records WHERE cmi_id IS NOT NULL').get() as { n: number }).n;
  const unlinked = (db.prepare('SELECT COUNT(*) n FROM procurement_records WHERE cmi_id IS NULL').get() as { n: number }).n;
  const orgCov = (db.prepare('SELECT COUNT(DISTINCT organization_id) n FROM procurement_records').get() as { n: number }).n;
  const supCov = (db.prepare('SELECT COUNT(DISTINCT supplier_id) n FROM procurement_records').get() as { n: number }).n;
  console.log(`Suppliers created: ${suppliersCreated} (total ${supplierIds.size})`);
  console.log(`Procurement inserted: ${inserted}, rejected: ${rejected}, total rows: ${total}`);
  console.log(`CMI-linked: ${cmiLinked}, unharmonized (cmi NULL): ${unlinked}`);
  console.log(`Organizations covered: ${orgCov}/5, suppliers used: ${supCov}`);
  if (cmi) {
    const { getCmiProcurementSummary } = require('../src/lib/db/repositories/procurement-repository') as typeof import('../src/lib/db/repositories/procurement-repository');
    console.log('CMI-BRG-6205 summary:', JSON.stringify(getCmiProcurementSummary(cmi.id)));
  }
  console.log('NOTE: representative synthetic procurement data for demonstration - not actual CPSE purchasing records.');
}

main();
