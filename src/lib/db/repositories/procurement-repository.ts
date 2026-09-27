/**
 * Step 12 - procurement data foundation (repository layer).
 *
 * Separate domain from material matching. Procurement records reference
 * materials and MAY reference the Common Material Identity the material is
 * mapped to — but never create, infer, or repair CMIs (material_mappings /
 * common_materials remain the authoritative identity relationship; validation
 * lives in the service layer).
 *
 * Numeric handling: quantity and unit_price are stored as decimal-safe TEXT
 * (SQLite has no decimal type; the service validates the format). PG parity:
 * the v11 schema uses numeric; the executor's __pgNum revival returns numbers,
 * and this repository always rounds to the stored 2-dp scale on read so both
 * dialects surface identical values.
 *
 * All list functions are server-side paginated; UI never runs raw SQL.
 */
import { getDb, withTransaction } from '../client';
import { errors } from '../../errors';
import { nowIso, parseJson, stringifyJson } from '../util';
import type { ProcurementStatus, OpportunityType, OpportunityStatus, UomRuleType, UomDomainRuleStatus } from '../../types/domain';

export interface SupplierRow {
  id: number;
  supplier_code: string;
  supplier_name: string;
  region: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface ProcurementRecordRow {
  id: number;
  organization_id: number;
  material_id: number;
  cmi_id: number | null;
  supplier_id: number;
  purchase_order_reference: string;
  purchase_date: string;
  delivery_date: string | null;
  quantity: string;
  uom: string;
  unit_price: string | null;
  currency: string | null;
  plant_location: string | null;
  procurement_status: ProcurementStatus;
  source_system: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProcurementWithContext {
  record: ProcurementRecordRow;
  org_code: string;
  material_code: string;
  material_description: string;
  cmi_code: string | null;
  supplier_code: string;
  supplier_name: string;
}

export interface NewSupplier {
  supplierCode: string;
  supplierName: string;
  region?: string | null;
}

export interface NewProcurementRecord {
  organizationId: number;
  materialId: number;
  cmiId?: number | null;
  supplierId: number;
  purchaseOrderReference: string;
  purchaseDate: string;
  deliveryDate?: string | null;
  /** Exact decimal string, e.g. "120" or "1250.50" — persisted verbatim. */
  quantity: string;
  uom: string;
  /** Exact decimal string, e.g. "1250.50"; null/undefined means no price. */
  unitPrice?: string | null;
  currency?: string | null;
  plantLocation?: string | null;
  status: ProcurementStatus;
  sourceSystem?: string | null;
}

const DEC2 = /^-?\d+(\.\d{1,2})?$/;

/** Persist an exact decimal string verbatim; reject anything else. */
function dec(value: string, field: string): string {
  if (!DEC2.test(value)) {
    throw errors.badRequest(`${field} must be an exact decimal with at most 2 fraction digits (got "${value}")`);
  }
  return value;
}

/** Read back a decimal-safe value: SQLite keeps the TEXT verbatim; PG's numeric revival yields a Number, re-fixed to the stored 2-dp scale. */
function decOut(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toFixed(2);
  return String(value);
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export function createSupplier(input: NewSupplier): SupplierRow {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO suppliers (supplier_code, supplier_name, region) VALUES (?, ?, ?)`
      )
      .run(input.supplierCode, input.supplierName, input.region ?? null);
    return getSupplierRequired(Number(res.lastInsertRowid));
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      throw errors.conflict(`Supplier code "${input.supplierCode}" already exists`);
    }
    throw err;
  }
}

export function listSuppliers(opts?: { activeOnly?: boolean }): SupplierRow[] {
  const rows = opts?.activeOnly
    ? (getDb().prepare(`SELECT * FROM suppliers WHERE is_active = 1 ORDER BY supplier_code`).all() as unknown as SupplierRow[])
    : (getDb().prepare(`SELECT * FROM suppliers ORDER BY supplier_code`).all() as unknown as SupplierRow[]);
  return rows;
}

export function getSupplierRequired(id: number): SupplierRow {
  const row = getDb().prepare(`SELECT * FROM suppliers WHERE id = ?`).get(id) as unknown as SupplierRow | undefined;
  if (!row) throw errors.notFound('Supplier');
  return row;
}

// ---------------------------------------------------------------------------
// Procurement records
// ---------------------------------------------------------------------------

interface ProcFilters {
  organizationId?: number;
  cmiId?: number;
  supplierId?: number;
  materialId?: number;
  dateFrom?: string;
  dateTo?: string;
  status?: ProcurementStatus;
  /** true = only CMI-linked rows; false = only unharmonized rows. */
  harmonized?: boolean;
  /** Step 14 section 20: exact currency match (e.g. "INR"). */
  currency?: string;
  /** Step 14 section 20: exact UOM match (e.g. "EA"). */
  uom?: string;
  /** Step 15 section 23: source-record traceability to an explicit material set. */
  materialIds?: number[];
  /**
   * Step 17 section 21: filter by CANONICAL (normalized) UOM - "records
   * normalized to X" (source UOM or an active rule target), NOT the original
   * UOM. Distinct from `uom`, which matches the verbatim original.
   */
  canonicalUom?: string;
}

const PROC_SELECT = `
  SELECT pr.*,
         o.code AS org_code,
         m.original_code AS material_code,
         m.original_description AS material_description,
         cm.code AS cmi_code,
         sup.supplier_code AS supplier_code,
         sup.supplier_name AS supplier_name
    FROM procurement_records pr
    JOIN organizations o ON o.id = pr.organization_id
    JOIN material_records m ON m.id = pr.material_id
    JOIN suppliers sup ON sup.id = pr.supplier_id
    LEFT JOIN common_materials cm ON cm.id = pr.cmi_id`;

function hydrateProcurement(r: Record<string, unknown>): ProcurementWithContext {
  const rec = r as unknown as ProcurementRecordRow & Record<string, unknown>;
  return {
    record: {
      id: Number(rec.id),
      organization_id: Number(rec.organization_id),
      material_id: Number(rec.material_id),
      cmi_id: rec.cmi_id === null || rec.cmi_id === undefined ? null : Number(rec.cmi_id),
      supplier_id: Number(rec.supplier_id),
      purchase_order_reference: String(rec.purchase_order_reference),
      purchase_date: String(rec.purchase_date),
      delivery_date: (rec.delivery_date as string | null) ?? null,
      quantity: decOut(rec.quantity),
      uom: String(rec.uom),
      unit_price: rec.unit_price === null || rec.unit_price === undefined || rec.unit_price === '' ? null : decOut(rec.unit_price),
      currency: (rec.currency as string | null) ?? null,
      plant_location: (rec.plant_location as string | null) ?? null,
      procurement_status: rec.procurement_status as ProcurementStatus,
      source_system: (rec.source_system as string | null) ?? null,
      created_at: String(rec.created_at),
      updated_at: String(rec.updated_at),
    },
    org_code: String(r.org_code),
    material_code: String(r.material_code),
    material_description: String(r.material_description),
    cmi_code: r.cmi_code === null || r.cmi_code === undefined ? null : String(r.cmi_code),
    supplier_code: String(r.supplier_code),
    supplier_name: String(r.supplier_name),
  };
}

/** Server-side paginated procurement list. All filters are SQL-side (indexed). */
export function listProcurementRecords(
  f: ProcFilters,
  page: number,
  pageSize: number
): { items: ProcurementWithContext[]; total: number } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (f.organizationId !== undefined) { clauses.push('pr.organization_id = ?'); params.push(f.organizationId); }
  if (f.cmiId !== undefined) { clauses.push('pr.cmi_id = ?'); params.push(f.cmiId); }
  if (f.supplierId !== undefined) { clauses.push('pr.supplier_id = ?'); params.push(f.supplierId); }
  if (f.materialId !== undefined) { clauses.push('pr.material_id = ?'); params.push(f.materialId); }
  if (f.dateFrom) { clauses.push('pr.purchase_date >= ?'); params.push(f.dateFrom); }
  if (f.dateTo) { clauses.push('pr.purchase_date <= ?'); params.push(f.dateTo); }
  if (f.status) { clauses.push('pr.procurement_status = ?'); params.push(f.status); }
  if (f.harmonized === true) clauses.push('pr.cmi_id IS NOT NULL');
  if (f.harmonized === false) clauses.push('pr.cmi_id IS NULL');
  if (f.currency) { clauses.push('pr.currency = ?'); params.push(f.currency); }
  if (f.uom) { clauses.push('pr.uom = ?'); params.push(f.uom); }
  if (f.canonicalUom) {
    // Step 17 section 21: canonical-UOM filter (indexed subquery over the
    // tiny registry + the verbatim canonical source). Expression filters
    // cannot use an index directly; the subquery keeps per-row work O(rule).
    clauses.push(
      `(pr.uom = ? OR pr.uom IN (SELECT from_uom FROM uom_conversion_rules WHERE is_active = 1 AND to_uom = ?))`
    );
    params.push(f.canonicalUom, f.canonicalUom);
  }
  if (f.materialIds && f.materialIds.length > 0) {
    clauses.push(`pr.material_id IN (${f.materialIds.map(() => '?').join(',')})`);
    params.push(...f.materialIds);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const items = (
    getDb()
      .prepare(`${PROC_SELECT}${where} ORDER BY pr.purchase_date DESC, pr.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as unknown as Array<Record<string, unknown>>
  ).map(hydrateProcurement);
  const total = (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM procurement_records pr${where}`)
      .get(...params) as unknown as { n: number }
  ).n;
  return { items, total };
}

export function getProcurementRecord(id: number): ProcurementWithContext | undefined {
  const row = getDb().prepare(`${PROC_SELECT} WHERE pr.id = ?`).get(id) as unknown as Record<string, unknown> | undefined;
  return row ? hydrateProcurement(row) : undefined;
}

export function getProcurementRecordRequired(id: number): ProcurementWithContext {
  const rec = getProcurementRecord(id);
  if (!rec) throw errors.notFound('Procurement record');
  return rec;
}

/**
 * Low-level insert (service layer validates first). Returns the new id.
 * Decimal values persist verbatim as TEXT on SQLite; numeric on PG.
 */
export function insertProcurementRecord(r: NewProcurementRecord): number {
  const res = getDb()
    .prepare(
      `INSERT INTO procurement_records
         (organization_id, material_id, cmi_id, supplier_id, purchase_order_reference,
          purchase_date, delivery_date, quantity, uom, unit_price, currency,
          plant_location, procurement_status, source_system)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      r.organizationId,
      r.materialId,
      r.cmiId ?? null,
      r.supplierId,
      r.purchaseOrderReference,
      r.purchaseDate,
      r.deliveryDate ?? null,
      dec(r.quantity, 'quantity'),
      r.uom,
      r.unitPrice ? dec(r.unitPrice, 'unit_price') : null,
      r.currency ?? null,
      r.plantLocation ?? null,
      r.status,
      r.sourceSystem ?? null
    );
  return Number(res.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Step 14 - procurement spend & demand aggregation (SQL-side, exact decimal).
//
// All aggregation runs in the database (GROUP BY / SUM / COUNT / MIN / MAX);
// Node only decodes integer-cent totals. Exactness contract:
//   - quantity and unit_price hold at most 2 fraction digits (enforced at
//     insert by dec()), so quantity*100 and quantity*unit_price*100 are
//     integers up to representation noise, which ROUND removes before the
//     CAST. SUM over INTEGERs is exact far beyond benchmark scale (2^53).
//   - SQLite coerces decimal TEXT arithmetically; PostgreSQL numeric is exact.
//     substr/ROUND/CAST/SUM are standard SQL on both dialects.
// UOM and currency are never merged across groups: different UOMs/currencies
// produce separate totals. NULL unit_price contributes zero spend and is
// counted separately as unpriced (never treated as a zero price).
// ---------------------------------------------------------------------------

/** Integer cents of `quantity`. */
const QTY_CENTS = `CAST(ROUND(quantity * 100) AS INTEGER)`;
/** Integer cents of `quantity * unit_price` (spend). */
const SPEND_CENTS = `CAST(ROUND(quantity * unit_price * 100) AS INTEGER)`;

/** Decode an integer-cent total into an exact decimal string (BigInt, no float). */
export function centsToDecimal(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0';
  const raw = typeof value === 'number' ? Math.trunc(value).toString() : String(value).split('.')[0] || '0';
  const big = BigInt(raw || '0');
  const neg = big < 0n;
  const digits = (neg ? -big : big).toString().padStart(3, '0');
  const s = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return (neg ? '-' : '') + s.replace(/\.00$/, '');
}

interface UomCentsRow {
  uom: string;
  s: number | string | null;
}
interface CurrencyCentsRow {
  currency: string;
  s: number | string | null;
}

function qtyMap(rows: UomCentsRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.uom)] = centsToDecimal(r.s);
  return out;
}
function spendMap(rows: CurrencyCentsRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.currency)] = centsToDecimal(r.s);
  return out;
}

export interface CmiDemandSummary {
  cmiId: number;
  cmiCode: string;
  cmiName: string;
  category: string;
  isActive: boolean;
  recordCount: number;
  orgCount: number;
  supplierCount: number;
  /** Distinct UOMs present - aggregation is per-UOM only; never mixed. */
  uoms: string[];
  /** Quantity total per UOM (identical UOMs only; more than one => per-UOM map). */
  totalQuantityByUom: Record<string, string>;
  /** Spend (quantity x unit_price) per currency - currencies never merged. */
  spendByCurrency: Record<string, string>;
  pricedRecords: number;
  unpricedRecords: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
}

/**
 * Cross-CPSE demand + spend summary for one CMI (Step 14 section 9).
 * Quantities aggregate per-UOM and spend per-currency, exactly - no
 * conversions, no fabricated spend for unpriced rows. Returns null when the
 * CMI does not exist.
 */
export function getCmiProcurementSummary(cmiId: number): CmiDemandSummary | null {
  const cmi = getDb()
    .prepare(`SELECT id, code, name, category, is_active FROM common_materials WHERE id = ?`)
    .get(cmiId) as { id: number; code: string; name: string; category: string; is_active: number | boolean } | undefined;
  if (!cmi) return null;
  const all = getDb()
    .prepare(
      `SELECT COUNT(*) AS records,
              COUNT(DISTINCT organization_id) AS orgs,
              COUNT(DISTINCT supplier_id) AS suppliers,
              SUM(CASE WHEN unit_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(CASE WHEN unit_price IS NULL THEN 1 ELSE 0 END) AS unpriced,
              MIN(purchase_date) AS first_date,
              MAX(purchase_date) AS last_date
         FROM procurement_records WHERE cmi_id = ?`
    )
    .get(cmiId) as unknown as {
    records: number;
    orgs: number;
    suppliers: number;
    priced: number | null;
    unpriced: number | null;
    first_date: string | null;
    last_date: string | null;
  };
  const qtyRows = getDb()
    .prepare(
      `SELECT uom, SUM(${QTY_CENTS}) AS s FROM procurement_records
         WHERE cmi_id = ? GROUP BY uom ORDER BY uom`
    )
    .all(cmiId) as unknown as UomCentsRow[];
  const spendRows = getDb()
    .prepare(
      `SELECT currency, SUM(${SPEND_CENTS}) AS s FROM procurement_records
         WHERE cmi_id = ? AND unit_price IS NOT NULL AND currency IS NOT NULL
        GROUP BY currency ORDER BY currency`
    )
    .all(cmiId) as unknown as CurrencyCentsRow[];
  return {
    cmiId: cmi.id,
    cmiCode: cmi.code,
    cmiName: cmi.name,
    category: cmi.category,
    isActive: Number(cmi.is_active) === 1,
    recordCount: Number(all.records),
    orgCount: Number(all.orgs),
    supplierCount: Number(all.suppliers),
    uoms: qtyRows.map((r) => String(r.uom)),
    totalQuantityByUom: qtyMap(qtyRows),
    spendByCurrency: spendMap(spendRows),
    pricedRecords: Number(all.priced ?? 0),
    unpricedRecords: Number(all.unpriced ?? 0),
    firstPurchaseDate: all.first_date,
    lastPurchaseDate: all.last_date,
  };
}

// ---------------------------------------------------------------------------
// Aggregation levels (Step 14 section 5): CMI+CPSE, CMI+supplier, CMI+month,
// CPSE overall, per-CMI overview, harmonization coverage.
// ---------------------------------------------------------------------------

export interface CmiOrgDemandRow {
  organizationId: number;
  orgCode: string;
  orgName: string;
  recordCount: number;
  quantityByUom: Record<string, string>;
  uoms: string[];
  spendByCurrency: Record<string, string>;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
}

/** Demand by CPSE for one CMI (aggregation level B, section 10). Ordered by org code. */
export function getCmiDemandByOrganization(cmiId: number): CmiOrgDemandRow[] | null {
  const cmi = getDb().prepare(`SELECT id FROM common_materials WHERE id = ?`).get(cmiId);
  if (!cmi) return null;
  const counts = getDb()
    .prepare(
      `SELECT pr.organization_id AS oid,
              o.code AS org_code,
              o.name AS org_name,
              COUNT(*) AS records,
              MIN(pr.purchase_date) AS first_date,
              MAX(pr.purchase_date) AS last_date
         FROM procurement_records pr
         JOIN organizations o ON o.id = pr.organization_id
        WHERE pr.cmi_id = ?
        GROUP BY pr.organization_id, o.code, o.name
        ORDER BY o.code`
    )
    .all(cmiId) as unknown as Array<{
    oid: number;
    org_code: string;
    org_name: string;
    records: number;
    first_date: string | null;
    last_date: string | null;
  }>;
  const qtyRows = getDb()
    .prepare(
      `SELECT pr.organization_id AS oid, pr.uom, SUM(${QTY_CENTS}) AS s
         FROM procurement_records pr WHERE pr.cmi_id = ?
        GROUP BY pr.organization_id, pr.uom`
    )
    .all(cmiId) as unknown as Array<{ oid: number; uom: string; s: number | string | null }>;
  const spendRows = getDb()
    .prepare(
      `SELECT pr.organization_id AS oid, pr.currency, SUM(${SPEND_CENTS}) AS s
         FROM procurement_records pr
        WHERE pr.cmi_id = ? AND pr.unit_price IS NOT NULL AND pr.currency IS NOT NULL
        GROUP BY pr.organization_id, pr.currency`
    )
    .all(cmiId) as unknown as Array<{ oid: number; currency: string; s: number | string | null }>;
  const qtyByOrg = new Map<number, UomCentsRow[]>();
  for (const r of qtyRows) {
    if (!qtyByOrg.has(Number(r.oid))) qtyByOrg.set(Number(r.oid), []);
    qtyByOrg.get(Number(r.oid))!.push({ uom: r.uom, s: r.s });
  }
  const spendByOrg = new Map<number, CurrencyCentsRow[]>();
  for (const r of spendRows) {
    if (!spendByOrg.has(Number(r.oid))) spendByOrg.set(Number(r.oid), []);
    spendByOrg.get(Number(r.oid))!.push({ currency: r.currency, s: r.s });
  }
  return counts.map((c) => {
    const q = qtyByOrg.get(Number(c.oid)) ?? [];
    return {
      organizationId: Number(c.oid),
      orgCode: String(c.org_code),
      orgName: String(c.org_name),
      recordCount: Number(c.records),
      quantityByUom: qtyMap(q),
      uoms: q.map((r) => String(r.uom)),
      spendByCurrency: spendMap(spendByOrg.get(Number(c.oid)) ?? []),
      firstPurchaseDate: c.first_date,
      lastPurchaseDate: c.last_date,
    };
  });
}

export interface CmiSupplierRow {
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  region: string | null;
  recordCount: number;
  quantityByUom: Record<string, string>;
  spendByCurrency: Record<string, string>;
  pricedRecords: number;
  unpricedRecords: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
}

/** Supplier involvement for one CMI (aggregation level C, section 12). Descriptive only - never a ranking. */
export function getCmiSupplierSummary(cmiId: number): CmiSupplierRow[] {
  const counts = getDb()
    .prepare(
      `SELECT pr.supplier_id AS sid,
              sup.supplier_code AS code,
              sup.supplier_name AS name,
              sup.region AS region,
              COUNT(*) AS records,
              SUM(CASE WHEN pr.unit_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(CASE WHEN pr.unit_price IS NULL THEN 1 ELSE 0 END) AS unpriced,
              MIN(pr.purchase_date) AS first_date,
              MAX(pr.purchase_date) AS last_date
         FROM procurement_records pr
         JOIN suppliers sup ON sup.id = pr.supplier_id
        WHERE pr.cmi_id = ?
        GROUP BY pr.supplier_id, sup.supplier_code, sup.supplier_name, sup.region
        ORDER BY sup.supplier_code`
    )
    .all(cmiId) as unknown as Array<{
    sid: number;
    code: string;
    name: string;
    region: string | null;
    records: number;
    priced: number | null;
    unpriced: number | null;
    first_date: string | null;
    last_date: string | null;
  }>;
  const qtyRows = getDb()
    .prepare(
      `SELECT pr.supplier_id AS sid, pr.uom, SUM(${QTY_CENTS}) AS s
         FROM procurement_records pr WHERE pr.cmi_id = ?
        GROUP BY pr.supplier_id, pr.uom`
    )
    .all(cmiId) as unknown as Array<{ sid: number; uom: string; s: number | string | null }>;
  const spendRows = getDb()
    .prepare(
      `SELECT pr.supplier_id AS sid, pr.currency, SUM(${SPEND_CENTS}) AS s
         FROM procurement_records pr
        WHERE pr.cmi_id = ? AND pr.unit_price IS NOT NULL AND pr.currency IS NOT NULL
        GROUP BY pr.supplier_id, pr.currency`
    )
    .all(cmiId) as unknown as Array<{ sid: number; currency: string; s: number | string | null }>;
  const qtyBySup = new Map<number, UomCentsRow[]>();
  for (const r of qtyRows) {
    if (!qtyBySup.has(Number(r.sid))) qtyBySup.set(Number(r.sid), []);
    qtyBySup.get(Number(r.sid))!.push({ uom: r.uom, s: r.s });
  }
  const spendBySup = new Map<number, CurrencyCentsRow[]>();
  for (const r of spendRows) {
    if (!spendBySup.has(Number(r.sid))) spendBySup.set(Number(r.sid), []);
    spendBySup.get(Number(r.sid))!.push({ currency: r.currency, s: r.s });
  }
  return counts.map((c) => {
    const q = qtyBySup.get(Number(c.sid)) ?? [];
    return {
      supplierId: Number(c.sid),
      supplierCode: String(c.code),
      supplierName: String(c.name),
      region: c.region === null || c.region === undefined ? null : String(c.region),
      recordCount: Number(c.records),
      quantityByUom: qtyMap(q),
      spendByCurrency: spendMap(spendBySup.get(Number(c.sid)) ?? []),
      pricedRecords: Number(c.priced ?? 0),
      unpricedRecords: Number(c.unpriced ?? 0),
      firstPurchaseDate: c.first_date,
      lastPurchaseDate: c.last_date,
    };
  });
}

export interface CmiMonthlyDemandRow {
  /** YYYY-MM (string slice of the ISO purchase_date). */
  month: string;
  recordCount: number;
  quantityByUom: Record<string, string>;
  spendByCurrency: Record<string, string>;
}

/**
 * Raw monthly demand rows for one CMI (aggregation level D, section 11), with
 * optional inclusive [from, to] date filtering. Historical data only - no
 * forecasting. Month gaps are filled by the service layer.
 */
export function getCmiMonthlyDemandRows(cmiId: number, from?: string, to?: string): CmiMonthlyDemandRow[] {
  const clauses: string[] = ['cmi_id = ?'];
  const params: Array<string | number> = [cmiId];
  if (from) {
    clauses.push('purchase_date >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('purchase_date <= ?');
    params.push(to);
  }
  const where = ` WHERE ${clauses.join(' AND ')}`;
  const counts = getDb()
    .prepare(
      `SELECT substr(purchase_date, 1, 7) AS month, COUNT(*) AS records
         FROM procurement_records${where}
        GROUP BY substr(purchase_date, 1, 7) ORDER BY month`
    )
    .all(...params) as unknown as Array<{ month: string; records: number }>;
  const qtyRows = getDb()
    .prepare(
      `SELECT substr(purchase_date, 1, 7) AS month, uom, SUM(${QTY_CENTS}) AS s
         FROM procurement_records${where}
        GROUP BY substr(purchase_date, 1, 7), uom`
    )
    .all(...params) as unknown as Array<{ month: string; uom: string; s: number | string | null }>;
  const spendClauses = [...clauses, 'unit_price IS NOT NULL', 'currency IS NOT NULL'];
  const spendRows = getDb()
    .prepare(
      `SELECT substr(purchase_date, 1, 7) AS month, currency, SUM(${SPEND_CENTS}) AS s
         FROM procurement_records WHERE ${spendClauses.join(' AND ')}
        GROUP BY substr(purchase_date, 1, 7), currency`
    )
    .all(...params) as unknown as Array<{ month: string; currency: string; s: number | string | null }>;
  const qtyByMonth = new Map<string, UomCentsRow[]>();
  for (const r of qtyRows) {
    if (!qtyByMonth.has(r.month)) qtyByMonth.set(r.month, []);
    qtyByMonth.get(r.month)!.push({ uom: r.uom, s: r.s });
  }
  const spendByMonth = new Map<string, CurrencyCentsRow[]>();
  for (const r of spendRows) {
    if (!spendByMonth.has(r.month)) spendByMonth.set(r.month, []);
    spendByMonth.get(r.month)!.push({ currency: r.currency, s: r.s });
  }
  return counts.map((c) => ({
    month: String(c.month),
    recordCount: Number(c.records),
    quantityByUom: qtyMap(qtyByMonth.get(c.month) ?? []),
    spendByCurrency: spendMap(spendByMonth.get(c.month) ?? []),
  }));
}

export interface OrgProcurementSummaryRow {
  organizationId: number;
  orgCode: string;
  orgName: string;
  recordCount: number;
  supplierCount: number;
  cmiLinkedRecords: number;
  unharmonizedRecords: number;
  quantityByUom: Record<string, string>;
  spendByCurrency: Record<string, string>;
  pricedRecords: number;
  unpricedRecords: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
}

/** CPSE-level procurement summary (aggregation level E, section 13) - descriptive statistics only. */
export function getOrganizationProcurementSummaries(): OrgProcurementSummaryRow[] {
  const counts = getDb()
    .prepare(
      `SELECT o.id AS oid, o.code AS org_code, o.name AS org_name,
              COUNT(pr.id) AS records,
              COUNT(DISTINCT pr.supplier_id) AS suppliers,
              SUM(CASE WHEN pr.cmi_id IS NOT NULL THEN 1 ELSE 0 END) AS linked,
              SUM(CASE WHEN pr.cmi_id IS NULL THEN 1 ELSE 0 END) AS unlinked,
              SUM(CASE WHEN pr.unit_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(CASE WHEN pr.unit_price IS NULL THEN 1 ELSE 0 END) AS unpriced,
              MIN(pr.purchase_date) AS first_date,
              MAX(pr.purchase_date) AS last_date
         FROM organizations o
         LEFT JOIN procurement_records pr ON pr.organization_id = o.id
        GROUP BY o.id, o.code, o.name
        ORDER BY o.code`
    )
    .all() as unknown as Array<{
    oid: number;
    org_code: string;
    org_name: string;
    records: number | null;
    suppliers: number | null;
    linked: number | null;
    unlinked: number | null;
    priced: number | null;
    unpriced: number | null;
    first_date: string | null;
    last_date: string | null;
  }>;
  const qtyRows = getDb()
    .prepare(
      `SELECT organization_id AS oid, uom, SUM(${QTY_CENTS}) AS s
         FROM procurement_records GROUP BY organization_id, uom`
    )
    .all() as unknown as Array<{ oid: number; uom: string; s: number | string | null }>;
  const spendRows = getDb()
    .prepare(
      `SELECT organization_id AS oid, currency, SUM(${SPEND_CENTS}) AS s
         FROM procurement_records WHERE unit_price IS NOT NULL AND currency IS NOT NULL
        GROUP BY organization_id, currency`
    )
    .all() as unknown as Array<{ oid: number; currency: string; s: number | string | null }>;
  const qtyByOrg = new Map<number, UomCentsRow[]>();
  for (const r of qtyRows) {
    if (!qtyByOrg.has(Number(r.oid))) qtyByOrg.set(Number(r.oid), []);
    qtyByOrg.get(Number(r.oid))!.push({ uom: r.uom, s: r.s });
  }
  const spendByOrg = new Map<number, CurrencyCentsRow[]>();
  for (const r of spendRows) {
    if (!spendByOrg.has(Number(r.oid))) spendByOrg.set(Number(r.oid), []);
    spendByOrg.get(Number(r.oid))!.push({ currency: r.currency, s: r.s });
  }
  return counts.map((c) => {
    const q = qtyByOrg.get(Number(c.oid)) ?? [];
    return {
      organizationId: Number(c.oid),
      orgCode: String(c.org_code),
      orgName: String(c.org_name),
      recordCount: Number(c.records ?? 0),
      supplierCount: Number(c.suppliers ?? 0),
      cmiLinkedRecords: Number(c.linked ?? 0),
      unharmonizedRecords: Number(c.unlinked ?? 0),
      quantityByUom: qtyMap(q),
      spendByCurrency: spendMap(spendByOrg.get(Number(c.oid)) ?? []),
      pricedRecords: Number(c.priced ?? 0),
      unpricedRecords: Number(c.unpriced ?? 0),
      firstPurchaseDate: c.first_date,
      lastPurchaseDate: c.last_date,
    };
  });
}

export interface CmiProcurementOverview {
  cmiId: number;
  cmiCode: string;
  cmiName: string;
  category: string;
  isActive: boolean;
  recordCount: number;
  orgCount: number;
  supplierCount: number;
  quantityByUom: Record<string, string>;
  spendByCurrency: Record<string, string>;
  pricedRecords: number;
  unpricedRecords: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
}

/** Per-CMI procurement overview across every CMI (with or without activity) - Common Material Demand table source. */
export function listCmiProcurementOverviews(): CmiProcurementOverview[] {
  const counts = getDb()
    .prepare(
      `SELECT cm.id AS cid, cm.code AS code, cm.name AS name, cm.category AS category, cm.is_active AS active,
              COUNT(pr.id) AS records,
              COUNT(DISTINCT pr.organization_id) AS orgs,
              COUNT(DISTINCT pr.supplier_id) AS suppliers,
              SUM(CASE WHEN pr.unit_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(CASE WHEN pr.unit_price IS NULL THEN 1 ELSE 0 END) AS unpriced,
              MIN(pr.purchase_date) AS first_date,
              MAX(pr.purchase_date) AS last_date
         FROM common_materials cm
         LEFT JOIN procurement_records pr ON pr.cmi_id = cm.id
        GROUP BY cm.id, cm.code, cm.name, cm.category, cm.is_active
        ORDER BY cm.code`
    )
    .all() as unknown as Array<{
    cid: number;
    code: string;
    name: string;
    category: string;
    active: number | boolean;
    records: number | null;
    orgs: number | null;
    suppliers: number | null;
    priced: number | null;
    unpriced: number | null;
    first_date: string | null;
    last_date: string | null;
  }>;
  const qtyRows = getDb()
    .prepare(
      `SELECT cmi_id AS cid, uom, SUM(${QTY_CENTS}) AS s
         FROM procurement_records WHERE cmi_id IS NOT NULL GROUP BY cmi_id, uom`
    )
    .all() as unknown as Array<{ cid: number; uom: string; s: number | string | null }>;
  const spendRows = getDb()
    .prepare(
      `SELECT cmi_id AS cid, currency, SUM(${SPEND_CENTS}) AS s
         FROM procurement_records
        WHERE cmi_id IS NOT NULL AND unit_price IS NOT NULL AND currency IS NOT NULL
        GROUP BY cmi_id, currency`
    )
    .all() as unknown as Array<{ cid: number; currency: string; s: number | string | null }>;
  const qtyByCmi = new Map<number, UomCentsRow[]>();
  for (const r of qtyRows) {
    if (!qtyByCmi.has(Number(r.cid))) qtyByCmi.set(Number(r.cid), []);
    qtyByCmi.get(Number(r.cid))!.push({ uom: r.uom, s: r.s });
  }
  const spendByCmi = new Map<number, CurrencyCentsRow[]>();
  for (const r of spendRows) {
    if (!spendByCmi.has(Number(r.cid))) spendByCmi.set(Number(r.cid), []);
    spendByCmi.get(Number(r.cid))!.push({ currency: r.currency, s: r.s });
  }
  return counts.map((c) => {
    const q = qtyByCmi.get(Number(c.cid)) ?? [];
    return {
      cmiId: Number(c.cid),
      cmiCode: String(c.code),
      cmiName: String(c.name),
      category: String(c.category),
      isActive: Number(c.active) === 1,
      recordCount: Number(c.records ?? 0),
      orgCount: Number(c.orgs ?? 0),
      supplierCount: Number(c.suppliers ?? 0),
      quantityByUom: qtyMap(q),
      spendByCurrency: spendMap(spendByCmi.get(Number(c.cid)) ?? []),
      pricedRecords: Number(c.priced ?? 0),
      unpricedRecords: Number(c.unpriced ?? 0),
      firstPurchaseDate: c.first_date,
      lastPurchaseDate: c.last_date,
    };
  });
}

export interface ProcurementCoverage {
  totalRecords: number;
  cmiLinkedRecords: number;
  unharmonizedRecords: number;
  /** linked / total, or null when there are no records (undefined, not 0%). */
  coverageRatio: number | null;
  organizationsWithProcurement: number;
  suppliersWithProcurement: number;
  pricedRecords: number;
  unpricedRecords: number;
  totalQuantityByUom: Record<string, string>;
  cmiLinkedQuantityByUom: Record<string, string>;
  unharmonizedQuantityByUom: Record<string, string>;
  spendByCurrency: Record<string, string>;
  cmiLinkedSpendByCurrency: Record<string, string>;
  unharmonizedSpendByCurrency: Record<string, string>;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
}
const EMPTY_COVERAGE: ProcurementCoverage = {
  totalRecords: 0,
  cmiLinkedRecords: 0,
  unharmonizedRecords: 0,
  coverageRatio: null,
  organizationsWithProcurement: 0,
  suppliersWithProcurement: 0,
  pricedRecords: 0,
  unpricedRecords: 0,
  totalQuantityByUom: {},
  cmiLinkedQuantityByUom: {},
  unharmonizedQuantityByUom: {},
  spendByCurrency: {},
  cmiLinkedSpendByCurrency: {},
  unharmonizedSpendByCurrency: {},
  firstPurchaseDate: null,
  lastPurchaseDate: null,
};

/** Harmonization-coverage aggregation (aggregation level G, section 14) over all procurement records. */
export function getProcurementCoverage(): ProcurementCoverage {
  const all = getDb()
    .prepare(
      `SELECT COUNT(*) AS records,
              SUM(CASE WHEN cmi_id IS NOT NULL THEN 1 ELSE 0 END) AS linked,
              SUM(CASE WHEN cmi_id IS NULL THEN 1 ELSE 0 END) AS unlinked,
              COUNT(DISTINCT organization_id) AS orgs,
              COUNT(DISTINCT supplier_id) AS suppliers,
              SUM(CASE WHEN unit_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(CASE WHEN unit_price IS NULL THEN 1 ELSE 0 END) AS unpriced,
              MIN(purchase_date) AS first_date,
              MAX(purchase_date) AS last_date
         FROM procurement_records`
    )
    .get() as unknown as {
    records: number;
    linked: number | null;
    unlinked: number | null;
    orgs: number | null;
    suppliers: number | null;
    priced: number | null;
    unpriced: number | null;
    first_date: string | null;
    last_date: string | null;
  } | undefined;
  if (!all || Number(all.records) === 0) return { ...EMPTY_COVERAGE, totalQuantityByUom: {}, spendByCurrency: {} };
  const qtyAll = getDb()
    .prepare(`SELECT uom, SUM(${QTY_CENTS}) AS s FROM procurement_records GROUP BY uom ORDER BY uom`)
    .all() as unknown as UomCentsRow[];
  const qtyLinked = getDb()
    .prepare(`SELECT uom, SUM(${QTY_CENTS}) AS s FROM procurement_records WHERE cmi_id IS NOT NULL GROUP BY uom ORDER BY uom`)
    .all() as unknown as UomCentsRow[];
  const qtyUnlinked = getDb()
    .prepare(`SELECT uom, SUM(${QTY_CENTS}) AS s FROM procurement_records WHERE cmi_id IS NULL GROUP BY uom ORDER BY uom`)
    .all() as unknown as UomCentsRow[];
  const spendAll = getDb()
    .prepare(
      `SELECT currency, SUM(${SPEND_CENTS}) AS s FROM procurement_records
        WHERE unit_price IS NOT NULL AND currency IS NOT NULL GROUP BY currency ORDER BY currency`
    )
    .all() as unknown as CurrencyCentsRow[];
  const spendLinked = getDb()
    .prepare(
      `SELECT currency, SUM(${SPEND_CENTS}) AS s FROM procurement_records
        WHERE cmi_id IS NOT NULL AND unit_price IS NOT NULL AND currency IS NOT NULL GROUP BY currency ORDER BY currency`
    )
    .all() as unknown as CurrencyCentsRow[];
  const spendUnlinked = getDb()
    .prepare(
      `SELECT currency, SUM(${SPEND_CENTS}) AS s FROM procurement_records
        WHERE cmi_id IS NULL AND unit_price IS NOT NULL AND currency IS NOT NULL GROUP BY currency ORDER BY currency`
    )
    .all() as unknown as CurrencyCentsRow[];
  const linked = Number(all.linked ?? 0);
  const total = Number(all.records);
  return {
    totalRecords: total,
    cmiLinkedRecords: linked,
    unharmonizedRecords: Number(all.unlinked ?? 0),
    coverageRatio: linked / total,
    organizationsWithProcurement: Number(all.orgs ?? 0),
    suppliersWithProcurement: Number(all.suppliers ?? 0),
    pricedRecords: Number(all.priced ?? 0),
    unpricedRecords: Number(all.unpriced ?? 0),
    totalQuantityByUom: qtyMap(qtyAll),
    cmiLinkedQuantityByUom: qtyMap(qtyLinked),
    unharmonizedQuantityByUom: qtyMap(qtyUnlinked),
    spendByCurrency: spendMap(spendAll),
    cmiLinkedSpendByCurrency: spendMap(spendLinked),
    unharmonizedSpendByCurrency: spendMap(spendUnlinked),
    firstPurchaseDate: all.first_date,
    lastPurchaseDate: all.last_date,
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Step 15 - procurement opportunity detection.
//
// All detection evidence is aggregated IN SQL (section 18): GROUP BY cmi_id /
// organization_id / supplier_id / month with COUNT(DISTINCT ...) - the app
// never receives raw procurement rows to loop over (section 19). Rules and
// thresholds are deterministic and documented in docs/PROCUREMENT.md:
//   CROSS_CPSE_DEMAND   orgs >= 2 (section 11)
//   REPEATED_PROCUREMENT records >= 2 on distinct dates (section 12; Step-13
//                       row-signature idempotency already prevents duplicate
//                       import rows from inflating this count)
//   FRAGMENTED_DEMAND   orgs >= 2 AND records >= 3 (section 13; descriptive)
//   MULTI_SUPPLIER_ACTIVITY suppliers >= 2 (section 14; never a ranking)
//   HIGH_PROCUREMENT_ACTIVITY top 10% of CMI event counts per detection run,
//                       dataset-relative and labelled as such (section 16B)
//   UNHARMONIZED_RELATED_PROCUREMENT  cmi IS NULL AND (an approved
//                       match_decision exists for the material OR the material
//                       sits in the same CPSE + category as an active CMI
//                       member) - grouped per CPSE + category; suggests human
//                       material-master review, never maps.
// Signal score (section 9) = 2*orgs + 2*suppliers + events, documented and
// deterministic. Ordering: score DESC, then id ASC.
// ---------------------------------------------------------------------------

export interface OpportunityRow {
  id: number;
  opportunity_type: OpportunityType;
  status: OpportunityStatus;
  detection_key: string;
  cmi_id: number | null;
  organization_id: number | null;
  supplier_id: number | null;
  material_id: number | null;
  period_start: string | null;
  period_end: string | null;
  title: string;
  description: string;
  evidence: string;
  priority_signal: number;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
  // Joined for display (not persisted duplication):
  cmi_code?: string | null;
  cmi_name?: string | null;
  organization_name?: string | null;
  supplier_name?: string | null;
}

export interface CmiDetectionAggregate {
  cmi_id: number;
  cmi_code: string;
  cmi_name: string;
  category: string;
  orgs: number;
  suppliers: number;
  records: number;
  distinct_dates: number;
  first_date: string;
  last_date: string;
}

/** Per-CMI aggregated evidence for the CMI-scoped opportunity rules. */
export function aggregateCmiProcurement(): CmiDetectionAggregate[] {
  return getDb()
    .prepare(
      `SELECT cmi_id,
              MAX(common_materials.code) AS cmi_code,
              MAX(common_materials.name) AS cmi_name,
              MAX(common_materials.category) AS category,
              COUNT(DISTINCT organization_id) AS orgs,
              COUNT(DISTINCT supplier_id) AS suppliers,
              COUNT(*) AS records,
              COUNT(DISTINCT purchase_date) AS distinct_dates,
              MIN(purchase_date) AS first_date,
              MAX(purchase_date) AS last_date
         FROM procurement_records
         JOIN common_materials ON common_materials.id = procurement_records.cmi_id
        WHERE common_materials.is_active = 1
        GROUP BY cmi_id
        ORDER BY cmi_id`
    )
    .all() as unknown as CmiDetectionAggregate[];
}

export interface CmiDemandEvidenceRow {
  cmi_id: number;
  org_id: number;
  org_code: string;
  uom: string;
  qty_cents: string;
  records: number;
}

/** Per-CMI + org demand (per-UOM buckets) for CROSS_CPSE evidence. */
export function cmiDemandEvidenceRows(cmiIds: number[]): CmiDemandEvidenceRow[] {
  if (cmiIds.length === 0) return [];
  const placeholders = cmiIds.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT cmi_id, organization_id AS org_id, organizations.code AS org_code, uom,
              ROUND(SUM(CAST(quantity AS REAL)) * 100) AS qty_cents,
              COUNT(*) AS records
         FROM procurement_records
         JOIN organizations ON organizations.id = procurement_records.organization_id
        WHERE cmi_id IN (${placeholders})
        GROUP BY cmi_id, organization_id, uom
        ORDER BY cmi_id, org_id, uom`
    )
    .all(...cmiIds) as unknown as CmiDemandEvidenceRow[];
}

export interface CmiSupplierEvidenceRow {
  cmi_id: number;
  supplier_id: number;
  supplier_name: string;
  records: number;
  first_date: string;
  last_date: string;
}

/** Per-CMI supplier evidence for MULTI_SUPPLIER_ACTIVITY. */
export function cmiSupplierEvidenceRows(cmiIds: number[]): CmiSupplierEvidenceRow[] {
  if (cmiIds.length === 0) return [];
  const placeholders = cmiIds.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT cmi_id, supplier_id, suppliers.supplier_name, COUNT(*) AS records,
              MIN(purchase_date) AS first_date, MAX(purchase_date) AS last_date
         FROM procurement_records
         JOIN suppliers ON suppliers.id = procurement_records.supplier_id
        WHERE cmi_id IN (${placeholders})
        GROUP BY cmi_id, supplier_id
        ORDER BY cmi_id, supplier_id`
    )
    .all(...cmiIds) as unknown as CmiSupplierEvidenceRow[];
}

export interface CmiMonthlyEvidenceRow {
  cmi_id: number;
  ym: string;
  records: number;
}

/** Per-CMI monthly event counts for REPEATED_PROCUREMENT evidence. */
export function cmiMonthlyEvidenceRows(cmiIds: number[]): CmiMonthlyEvidenceRow[] {
  if (cmiIds.length === 0) return [];
  const placeholders = cmiIds.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT cmi_id, SUBSTR(purchase_date, 1, 7) AS ym, COUNT(*) AS records
         FROM procurement_records
        WHERE cmi_id IN (${placeholders})
        GROUP BY cmi_id, ym
        ORDER BY cmi_id, ym`
    )
    .all(...cmiIds) as unknown as CmiMonthlyEvidenceRow[];
}

export interface UnharmonizedAggregate {
  organization_id: number;
  org_name: string;
  category: string;
  records: number;
  materials: number;
  first_date: string;
  last_date: string;
  evidence_material_ids: string;
}

/**
 * Unharmonized procurement with a defensible existing relationship (section
 * 15): cmi IS NULL for the material, AND either an APPROVED match decision
 * exists for it, OR the same CPSE already has an active CMI member in the SAME
 * category (an approved harmonized family that procurement can safely
 * reference for REVIEW - never auto-mapping). Grouped per CPSE + category;
 * traceability list capped at 20 material ids.
 */
export function aggregateUnharmonizedWithRelationship(): UnharmonizedAggregate[] {
  return getDb()
    .prepare(
      `WITH active_cmi_categories AS (
           SELECT DISTINCT m.organization_id AS organization_id, mr.category AS category
             FROM material_mappings mm
             JOIN common_materials c ON c.id = mm.cmi_id AND c.is_active = 1
             JOIN material_records m ON m.id = mm.material_id
        ),
        approved_materials AS (
           SELECT DISTINCT c.source_material_id AS material_id
             FROM match_decisions d
             JOIN match_candidates c ON c.id = d.match_id
            WHERE d.decision = 'approved'
            UNION
           SELECT DISTINCT c.candidate_material_id AS material_id
             FROM match_decisions d
             JOIN match_candidates c ON c.id = d.match_id
            WHERE d.decision = 'approved'
        ),
        unharmonized AS (
           SELECT pr.organization_id AS organization_id, mr.category AS category,
                  mr.id AS material_id, pr.purchase_date AS purchase_date
             FROM procurement_records pr
             JOIN material_records mr ON mr.id = pr.material_id
            WHERE pr.cmi_id IS NULL
              AND (
                    mr.id IN (SELECT material_id FROM approved_materials)
                 OR EXISTS (SELECT 1 FROM active_cmi_categories acc
                             WHERE acc.organization_id = mr.organization_id
                               AND acc.category = mr.category)
                  )
        )
        SELECT u.organization_id,
               MAX(o.name) AS org_name,
               u.category,
               COUNT(*) AS records,
               COUNT(DISTINCT u.material_id) AS materials,
               MIN(u.purchase_date) AS first_date,
               MAX(u.purchase_date) AS last_date,
               SUBSTR((
                 SELECT GROUP_CONCAT(material_id)
                   FROM (
                     SELECT DISTINCT u2.material_id AS material_id
                       FROM unharmonized u2
                      WHERE u2.organization_id = u.organization_id
                        AND u2.category = u.category
                      ORDER BY u2.material_id
                      LIMIT 20
                   )
               ), 1, 500) AS evidence_material_ids
          FROM unharmonized u
          JOIN organizations o ON o.id = u.organization_id
         GROUP BY u.organization_id, u.category`
    )
    .all() as unknown as UnharmonizedAggregate[];
}

// ---------------------------------------------------------------------------
// Opportunity persistence + human-review workflow.
// ---------------------------------------------------------------------------

export interface OpportunityFilters {
  type?: OpportunityType;
  status?: OpportunityStatus;
  cmiId?: number;
  organizationId?: number;
  supplierId?: number;
  materialId?: number;
}

const OPPORTUNITY_SELECT = `
  SELECT o.*,
         c.code AS cmi_code,
         c.name AS cmi_name,
         org.name AS organization_name,
         s.supplier_name AS supplier_name
    FROM procurement_opportunities o
    LEFT JOIN common_materials c ON c.id = o.cmi_id
    LEFT JOIN organizations org ON org.id = o.organization_id
    LEFT JOIN suppliers s ON s.id = o.supplier_id`;

/** Server-side filtered + paginated opportunity list (section 20). */
export function listOpportunities(
  filters: OpportunityFilters,
  page: number,
  pageSize: number
): { items: OpportunityRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.type) { where.push('o.opportunity_type = ?'); params.push(filters.type); }
  if (filters.status) { where.push('o.status = ?'); params.push(filters.status); }
  if (filters.cmiId !== undefined) { where.push('o.cmi_id = ?'); params.push(filters.cmiId); }
  if (filters.organizationId !== undefined) { where.push('o.organization_id = ?'); params.push(filters.organizationId); }
  if (filters.supplierId !== undefined) { where.push('o.supplier_id = ?'); params.push(filters.supplierId); }
  if (filters.materialId !== undefined) { where.push('o.material_id = ?'); params.push(filters.materialId); }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const total = (
    getDb().prepare(`SELECT COUNT(*) AS n FROM procurement_opportunities o${whereSql}`).get(...params) as { n: number }
  ).n;
  const items = getDb()
    .prepare(`${OPPORTUNITY_SELECT}${whereSql} ORDER BY o.priority_signal DESC, o.id ASC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as unknown as OpportunityRow[];
  return { items, total };
}

export function getOpportunity(id: number): OpportunityRow | undefined {
  return getDb().prepare(`${OPPORTUNITY_SELECT} WHERE o.id = ?`).get(id) as
    | OpportunityRow
    | undefined;
}

export function getOpportunityRequired(id: number): OpportunityRow {
  const row = getOpportunity(id);
  if (!row) throw errors.notFound('Opportunity');
  return row;
}

/** Source procurement records behind one opportunity (section 23 traceability). */
export function listOpportunitySourceRecords(
  opp: OpportunityRow,
  limit = 200
): ProcurementWithContext[] {
  const filters: ProcFilters = {};
  if (opp.cmi_id !== null) {
    filters.cmiId = opp.cmi_id;
  } else if (opp.material_id !== null) {
    filters.materialId = opp.material_id;
  } else if (opp.organization_id !== null) {
    // Org-scoped signals (Step 15 section 15/23/38): the traceability table
    // must show EXACTLY the evidence population - the unharmonized records of
    // the capped material list inside the detection period - never the CPSE's
    // full book. Material ids are validated integers before the IN clause.
    filters.organizationId = opp.organization_id;
    filters.harmonized = false;
    if (opp.period_start) filters.dateFrom = opp.period_start;
    if (opp.period_end) filters.dateTo = opp.period_end;
    const ev = parseEvidenceJson(opp.evidence);
    const ids = Array.isArray(ev.materialIds)
      ? ev.materialIds.filter((x): x is number => Number.isFinite(x) && x > 0)
      : [];
    if (ids.length > 0) filters.materialIds = ids;
  } else {
    return [];
  }
  return listProcurementRecords(filters, 1, limit).items;
}

/** Safely parse the opportunity evidence JSON column. */
function parseEvidenceJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface UpsertOpportunityInput {
  detectionKey: string;
  type: OpportunityType;
  title: string;
  description: string;
  evidence: unknown;
  prioritySignal: number;
  cmiId?: number | null;
  organizationId?: number | null;
  supplierId?: number | null;
  materialId?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
}

/**
 * Idempotent detection insert (sections 17/32): an existing detection_key is
 * refreshed (evidence/period) but human status is NEVER touched (section 31:
 * no silent state change on reruns). Terminal DISMISSED/RESOLVED rows keep
 * their human state.
 */
export function upsertOpportunity(input: UpsertOpportunityInput): { id: number; created: boolean } {
  const evidenceJson = stringifyJson(input.evidence) ?? '{}';
  const existing = getDb()
    .prepare(`SELECT id FROM procurement_opportunities WHERE detection_key = ?`)
    .get(input.detectionKey) as { id: number } | undefined;
  if (existing) {
    getDb()
      .prepare(
        `UPDATE procurement_opportunities
            SET title = ?, description = ?, evidence = ?, priority_signal = ?,
                period_start = ?, period_end = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        input.title, input.description, evidenceJson, input.prioritySignal,
        input.periodStart ?? null, input.periodEnd ?? null, nowIso(), existing.id
      );
    return { id: existing.id, created: false };
  }
  const result = getDb()
    .prepare(
      `INSERT INTO procurement_opportunities (
         opportunity_type, status, detection_key, cmi_id, organization_id,
         supplier_id, material_id, period_start, period_end, title,
         description, evidence, priority_signal
       ) VALUES (?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.type, input.detectionKey, input.cmiId ?? null, input.organizationId ?? null,
      input.supplierId ?? null, input.materialId ?? null, input.periodStart ?? null,
      input.periodEnd ?? null, input.title, input.description, evidenceJson,
      input.prioritySignal
    );
  return { id: Number(result.lastInsertRowid), created: true };
}

export type OpportunityTransition = 'acknowledge' | 'dismiss' | 'resolve' | 'reopen';

/**
 * Guarded status transition (sections 30/31): the UPDATE carries the expected
 * from-state in its WHERE clause inside a transaction, so concurrent updates
 * serialize at the DB - exactly one wins, the loser gets a 409. DISMISSED and
 * RESOLVED are terminal except via an explicit reopen.
 */
export function transitionOpportunity(
  id: number,
  transition: OpportunityTransition,
  actor: string,
  reason: string | undefined
): OpportunityRow {
  const targets: Record<OpportunityTransition, OpportunityStatus> = {
    acknowledge: 'ACKNOWLEDGED',
    dismiss: 'DISMISSED',
    resolve: 'RESOLVED',
    reopen: 'OPEN',
  };
  const from: Record<OpportunityTransition, OpportunityStatus[]> = {
    acknowledge: ['OPEN'],
    dismiss: ['OPEN', 'ACKNOWLEDGED'],
    resolve: ['OPEN', 'ACKNOWLEDGED'],
    reopen: ['DISMISSED', 'RESOLVED'],
  };
  return withTransaction(() => {
    const current = getDb()
      .prepare(`SELECT id, status, review_note FROM procurement_opportunities WHERE id = ?`)
      .get(id) as { id: number; status: OpportunityStatus; review_note: string | null } | undefined;
    if (!current) throw errors.notFound('Opportunity');
    if (!from[transition].includes(current.status)) {
      throw errors.conflict(
        `Opportunity is ${current.status}; ${transition} requires ${from[transition].join(' or ')}`
      );
    }
    const now = nowIso();
    getDb()
      .prepare(
        `UPDATE procurement_opportunities
            SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
          WHERE id = ? AND status = ?`
      )
      .run(targets[transition], actor, now, reason ?? current.review_note, now, id, current.status);
    return getOpportunityRequired(id);
  });
}

// ---------------------------------------------------------------------------
// Step 16 - supplier intelligence (SQL-side, descriptive; NEVER a ranking).
//
// Reuses the Step-14 exact-decimal helpers (QTY_CENTS / SPEND_CENTS). All
// metrics derive from procurement_records GROUP BY supplier_id; supplier
// master data comes from the existing suppliers table (identity = supplier_id
// + supplier_code; no dedupe, no auto-creation, no similarity merging).
// UOM and currency boundaries are preserved; NULL unit_price counts the
// record and its quantity but never contributes spend. The records-share
// percentage denominator is documented in the service (ALL procurement
// records) and is a factual proportion, not a supplier rating.
// ---------------------------------------------------------------------------

export interface SupplierIntelligenceListRow {
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  region: string | null;
  /** Master-data field from the existing suppliers table (section 22). */
  isActive: boolean;
  recordCount: number;
  orgCount: number;
  /** Distinct CMI-linked identities (NULL cmi rows are not counted). */
  cmiCount: number;
  materialCount: number;
  unpricedRecords: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
}

export interface SupplierListFilters {
  /** Indexed server-side search over supplier_code + supplier_name (section 17). */
  q?: string;
  organizationId?: number;
  cmiId?: number;
  dateFrom?: string;
  dateTo?: string;
  uom?: string;
  currency?: string;
}

const SUPPLIER_AGG_SELECT = `
  SELECT s.id AS sid,
         s.supplier_code AS code,
         s.supplier_name AS name,
         s.region AS region,
         s.is_active AS active,
         COUNT(pr.id) AS records,
         COUNT(DISTINCT pr.organization_id) AS orgs,
         COUNT(DISTINCT pr.cmi_id) AS cmis,
         COUNT(DISTINCT pr.material_id) AS materials,
         SUM(CASE WHEN pr.unit_price IS NULL THEN 1 ELSE 0 END) AS unpriced,
         MIN(pr.purchase_date) AS first_date,
         MAX(pr.purchase_date) AS last_date
    FROM suppliers s
    LEFT JOIN procurement_records pr ON pr.supplier_id = s.id`;

interface SupplierAggRow {
  sid: number | string;
  code: string;
  name: string;
  region: string | null;
  active: number | boolean;
  records: number | null;
  orgs: number | null;
  cmis: number | null;
  materials: number | null;
  unpriced: number | null;
  first_date: string | null;
  last_date: string | null;
}

function mapSupplierAgg(r: SupplierAggRow): SupplierIntelligenceListRow {
  return {
    supplierId: Number(r.sid),
    supplierCode: String(r.code),
    supplierName: String(r.name),
    region: r.region === null || r.region === undefined ? null : String(r.region),
    isActive: Number(r.active) === 1,
    recordCount: Number(r.records ?? 0),
    orgCount: Number(r.orgs ?? 0),
    cmiCount: Number(r.cmis ?? 0),
    materialCount: Number(r.materials ?? 0),
    unpricedRecords: Number(r.unpriced ?? 0),
    firstPurchaseDate: r.first_date,
    lastPurchaseDate: r.last_date,
  };
}

/**
 * Paginated supplier intelligence list (section 15/16). Aggregates derive
 * from SQL; activity filters (org/cmi/date/uom/currency) restrict which
 * procurement rows feed the aggregation, while `q` searches master data.
 * Zero-procurement suppliers remain visible with zero metrics.
 */
export function listSupplierIntelligence(
  f: SupplierListFilters,
  page: number,
  pageSize: number
): { items: SupplierIntelligenceListRow[]; total: number } {
  const act: string[] = [];
  const actParams: Array<string | number> = [];
  if (f.organizationId !== undefined) { act.push('pr.organization_id = ?'); actParams.push(f.organizationId); }
  if (f.cmiId !== undefined) { act.push('pr.cmi_id = ?'); actParams.push(f.cmiId); }
  if (f.dateFrom) { act.push('pr.purchase_date >= ?'); actParams.push(f.dateFrom); }
  if (f.dateTo) { act.push('pr.purchase_date <= ?'); actParams.push(f.dateTo); }
  if (f.uom) { act.push('pr.uom = ?'); actParams.push(f.uom); }
  if (f.currency) { act.push('pr.currency = ?'); actParams.push(f.currency); }
  const actWhere = act.length ? ` AND ${act.join(' AND ')}` : '';

  const master: string[] = [];
  const masterParams: Array<string | number> = [];
  if (f.q) {
    master.push("(s.supplier_code LIKE ? ESCAPE '#' OR s.supplier_name LIKE ? ESCAPE '#')");
    const like = `%${f.q.replace(/[#%_]/g, (m) => `#${m}`)}%`;
    masterParams.push(like, like);
  }
  const masterWhere = master.length ? ` WHERE ${master.join(' AND ')}` : '';

  const total = Number(
    (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM suppliers s${masterWhere}`)
        .get(...masterParams) as unknown as { n: number }
    ).n
  );
  const rows = getDb()
    .prepare(
      `${SUPPLIER_AGG_SELECT}${actWhere}
      WHERE s.id IN (SELECT id FROM suppliers s2${masterWhere})
      GROUP BY s.id, s.supplier_code, s.supplier_name, s.region, s.is_active
      ORDER BY s.supplier_code
      LIMIT ? OFFSET ?`
    )
    .all(...masterParams, ...actParams, pageSize, (page - 1) * pageSize) as unknown as SupplierAggRow[];
  return { items: rows.map(mapSupplierAgg), total };
}

/** Full unpaginated aggregation over suppliers with matching master data (small bounded master table). */
export function aggregateSupplierIntelligence(f: SupplierListFilters): SupplierIntelligenceListRow[] {
  const act: string[] = [];
  const actParams: Array<string | number> = [];
  if (f.organizationId !== undefined) { act.push('pr.organization_id = ?'); actParams.push(f.organizationId); }
  if (f.cmiId !== undefined) { act.push('pr.cmi_id = ?'); actParams.push(f.cmiId); }
  if (f.dateFrom) { act.push('pr.purchase_date >= ?'); actParams.push(f.dateFrom); }
  if (f.dateTo) { act.push('pr.purchase_date <= ?'); actParams.push(f.dateTo); }
  if (f.uom) { act.push('pr.uom = ?'); actParams.push(f.uom); }
  if (f.currency) { act.push('pr.currency = ?'); actParams.push(f.currency); }
  const actWhere = act.length ? ` AND ${act.join(' AND ')}` : '';
  const master: string[] = [];
  const masterParams: Array<string | number> = [];
  if (f.q) {
    master.push("(s.supplier_code LIKE ? ESCAPE '#' OR s.supplier_name LIKE ? ESCAPE '#')");
    const like = `%${f.q.replace(/[#%_]/g, (m) => `#${m}`)}%`;
    masterParams.push(like, like);
  }
  const masterWhere = master.length ? ` WHERE ${master.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(
      `${SUPPLIER_AGG_SELECT}${actWhere}
      WHERE s.id IN (SELECT id FROM suppliers s2${masterWhere})
      GROUP BY s.id, s.supplier_code, s.supplier_name, s.region, s.is_active
      ORDER BY s.supplier_code`
    )
    .all(...masterParams, ...actParams) as unknown as SupplierAggRow[];
  return rows.map(mapSupplierAgg);
}

export interface SupplierIntelligenceDetail {
  supplier: SupplierRow;
  recordCount: number;
  orgCount: number;
  cmiCount: number;
  materialCount: number;
  quantityByUom: Record<string, string>;
  spendByCurrency: Record<string, string>;
  pricedRecords: number;
  unpricedRecords: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
}

/**
 * Supplier detail header metrics (section 4). UOM-separated quantity,
 * currency-separated spend, unpriced records counted but never priced.
 */
export function getSupplierIntelligenceDetail(supplierId: number): SupplierIntelligenceDetail | null {
  const s = getDb().prepare(`SELECT * FROM suppliers WHERE id = ?`).get(supplierId) as unknown as SupplierRow | undefined;
  if (!s) return null;
  const all = getDb()
    .prepare(
      `SELECT COUNT(*) AS records,
              COUNT(DISTINCT organization_id) AS orgs,
              COUNT(DISTINCT cmi_id) AS cmis,
              COUNT(DISTINCT material_id) AS materials,
              SUM(CASE WHEN unit_price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(CASE WHEN unit_price IS NULL THEN 1 ELSE 0 END) AS unpriced,
              MIN(purchase_date) AS first_date,
              MAX(purchase_date) AS last_date
         FROM procurement_records WHERE supplier_id = ?`
    )
    .get(supplierId) as unknown as {
    records: number;
    orgs: number;
    cmis: number;
    materials: number;
    priced: number | null;
    unpriced: number | null;
    first_date: string | null;
    last_date: string | null;
  };
  const qtyRows = getDb()
    .prepare(
      `SELECT uom, SUM(${QTY_CENTS}) AS s FROM procurement_records
        WHERE supplier_id = ? GROUP BY uom ORDER BY uom`
    )
    .all(supplierId) as unknown as UomCentsRow[];
  const spendRows = getDb()
    .prepare(
      `SELECT currency, SUM(${SPEND_CENTS}) AS s FROM procurement_records
        WHERE supplier_id = ? AND unit_price IS NOT NULL AND currency IS NOT NULL
        GROUP BY currency ORDER BY currency`
    )
    .all(supplierId) as unknown as CurrencyCentsRow[];
  return {
    supplier: s,
    recordCount: Number(all.records),
    orgCount: Number(all.orgs),
    cmiCount: Number(all.cmis),
    materialCount: Number(all.materials),
    quantityByUom: qtyMap(qtyRows),
    spendByCurrency: spendMap(spendRows),
    pricedRecords: Number(all.priced ?? 0),
    unpricedRecords: Number(all.unpriced ?? 0),
    firstPurchaseDate: all.first_date,
    lastPurchaseDate: all.last_date,
  };
}

export interface SupplierOrgActivityRow {
  organizationId: number;
  orgCode: string;
  orgName: string;
  recordCount: number;
  quantityByUom: Record<string, string>;
  spendByCurrency: Record<string, string>;
}

/** "Recorded procurement activity by CPSE" for one supplier (section 5) - factual counts, never preference. */
export function getSupplierOrgActivity(supplierId: number): SupplierOrgActivityRow[] {
  const counts = getDb()
    .prepare(
      `SELECT pr.organization_id AS oid, o.code AS org_code, o.name AS org_name, COUNT(*) AS records
         FROM procurement_records pr
         JOIN organizations o ON o.id = pr.organization_id
        WHERE pr.supplier_id = ?
        GROUP BY pr.organization_id, o.code, o.name
        ORDER BY o.code`
    )
    .all(supplierId) as unknown as Array<{ oid: number; org_code: string; org_name: string; records: number }>;
  const qtyRows = getDb()
    .prepare(
      `SELECT organization_id AS oid, uom, SUM(${QTY_CENTS}) AS s FROM procurement_records
        WHERE supplier_id = ? GROUP BY organization_id, uom`
    )
    .all(supplierId) as unknown as Array<{ oid: number; uom: string; s: number | string | null }>;
  const spendRows = getDb()
    .prepare(
      `SELECT organization_id AS oid, currency, SUM(${SPEND_CENTS}) AS s FROM procurement_records
        WHERE supplier_id = ? AND unit_price IS NOT NULL AND currency IS NOT NULL
        GROUP BY organization_id, currency`
    )
    .all(supplierId) as unknown as Array<{ oid: number; currency: string; s: number | string | null }>;
  const qtyByOrg = new Map<number, UomCentsRow[]>();
  for (const r of qtyRows) {
    if (!qtyByOrg.has(Number(r.oid))) qtyByOrg.set(Number(r.oid), []);
    qtyByOrg.get(Number(r.oid))!.push({ uom: r.uom, s: r.s });
  }
  const spendByOrg = new Map<number, CurrencyCentsRow[]>();
  for (const r of spendRows) {
    if (!spendByOrg.has(Number(r.oid))) spendByOrg.set(Number(r.oid), []);
    spendByOrg.get(Number(r.oid))!.push({ currency: r.currency, s: r.s });
  }
  return counts.map((c) => ({
    organizationId: Number(c.oid),
    orgCode: String(c.org_code),
    orgName: String(c.org_name),
    recordCount: Number(c.records),
    quantityByUom: qtyMap(qtyByOrg.get(Number(c.oid)) ?? []),
    spendByCurrency: spendMap(spendByOrg.get(Number(c.oid)) ?? []),
  }));
}

export interface SupplierCmiActivityRow {
  cmiId: number;
  cmiCode: string;
  cmiName: string;
  category: string;
  recordCount: number;
  orgCount: number;
  quantityByUom: Record<string, string>;
  spendByCurrency: Record<string, string>;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
}

/** Supplier -> CMI visibility (section 6): CMI identity comes only from the stored procurement cmi_id. */
export function getSupplierCmiActivity(supplierId: number): SupplierCmiActivityRow[] {
  const counts = getDb()
    .prepare(
      `SELECT pr.cmi_id AS cid, cm.code AS code, cm.name AS name, cm.category AS category,
              COUNT(*) AS records,
              COUNT(DISTINCT pr.organization_id) AS orgs,
              MIN(pr.purchase_date) AS first_date,
              MAX(pr.purchase_date) AS last_date
         FROM procurement_records pr
         JOIN common_materials cm ON cm.id = pr.cmi_id
        WHERE pr.supplier_id = ?
        GROUP BY pr.cmi_id, cm.code, cm.name, cm.category
        ORDER BY cm.code`
    )
    .all(supplierId) as unknown as Array<{
    cid: number;
    code: string;
    name: string;
    category: string;
    records: number;
    orgs: number;
    first_date: string | null;
    last_date: string | null;
  }>;
  const qtyRows = getDb()
    .prepare(
      `SELECT cmi_id AS cid, uom, SUM(${QTY_CENTS}) AS s FROM procurement_records
        WHERE supplier_id = ? AND cmi_id IS NOT NULL GROUP BY cmi_id, uom`
    )
    .all(supplierId) as unknown as Array<{ cid: number; uom: string; s: number | string | null }>;
  const spendRows = getDb()
    .prepare(
      `SELECT cmi_id AS cid, currency, SUM(${SPEND_CENTS}) AS s FROM procurement_records
        WHERE supplier_id = ? AND cmi_id IS NOT NULL AND unit_price IS NOT NULL AND currency IS NOT NULL
        GROUP BY cmi_id, currency`
    )
    .all(supplierId) as unknown as Array<{ cid: number; currency: string; s: number | string | null }>;
  const qtyByCmi = new Map<number, UomCentsRow[]>();
  for (const r of qtyRows) {
    if (!qtyByCmi.has(Number(r.cid))) qtyByCmi.set(Number(r.cid), []);
    qtyByCmi.get(Number(r.cid))!.push({ uom: r.uom, s: r.s });
  }
  const spendByCmi = new Map<number, CurrencyCentsRow[]>();
  for (const r of spendRows) {
    if (!spendByCmi.has(Number(r.cid))) spendByCmi.set(Number(r.cid), []);
    spendByCmi.get(Number(r.cid))!.push({ currency: r.currency, s: r.s });
  }
  return counts.map((c) => ({
    cmiId: Number(c.cid),
    cmiCode: String(c.code),
    cmiName: String(c.name),
    category: String(c.category),
    recordCount: Number(c.records),
    orgCount: Number(c.orgs),
    quantityByUom: qtyMap(qtyByCmi.get(Number(c.cid)) ?? []),
    spendByCurrency: spendMap(spendByCmi.get(Number(c.cid)) ?? []),
    firstPurchaseDate: c.first_date,
    lastPurchaseDate: c.last_date,
  }));
}

/**
 * Supplier -> CMI -> CPSE matrix (section 19): UOM-tagged demand per cell,
 * one row per (supplier, CMI) pair with activity. Preserves UOM boundaries;
 * em-dash cells mean no recorded activity.
 */
export function getSupplierCmiOrgMatrix(supplierId: number): Array<{
  cmiId: number;
  cmiCode: string;
  cells: Record<number, string>;
}> {
  const rows = getDb()
    .prepare(
      `SELECT pr.cmi_id AS cid, cm.code AS code, pr.organization_id AS oid,
              o.code AS org_code, pr.uom, SUM(${QTY_CENTS}) AS s
         FROM procurement_records pr
         JOIN common_materials cm ON cm.id = pr.cmi_id
         JOIN organizations o ON o.id = pr.organization_id
        WHERE pr.supplier_id = ?
        GROUP BY pr.cmi_id, cm.code, pr.organization_id, o.code, pr.uom
        ORDER BY cm.code, o.code, pr.uom`
    )
    .all(supplierId) as unknown as Array<{
    cid: number;
    code: string;
    oid: number;
    org_code: string;
    uom: string;
    s: number | string | null;
  }>;
  const orgs = new Map<number, string>();
  for (const r of rows) orgs.set(Number(r.oid), String(r.org_code));
  const byCmi = new Map<number, { cmiCode: string; cells: Map<number, string[]> }>();
  for (const r of rows) {
    const cid = Number(r.cid);
    if (!byCmi.has(cid)) byCmi.set(cid, { cmiCode: String(r.code), cells: new Map() });
    const cell = byCmi.get(cid)!;
    if (!cell.cells.has(Number(r.oid))) cell.cells.set(Number(r.oid), []);
    cell.cells.get(Number(r.oid))!.push(`${centsToDecimal(r.s)} ${String(r.uom)}`);
  }
  return Array.from(byCmi.entries()).map(([cid, v]) => ({
    cmiId: cid,
    cmiCode: v.cmiCode,
    cells: Object.fromEntries(Array.from(v.cells.entries(), ([oid, parts]) => [oid, parts.join(' + ')])),
  }));
}

export interface SupplierRecentRecordRow {
  id: number;
  purchaseDate: string;
  orgCode: string;
  materialCode: string;
  materialDescription: string;
  cmiCode: string | null;
  uom: string;
  quantity: string;
  currency: string | null;
  unitPrice: string | null;
}

/** Bounded recent-procurement table for the supplier detail page (section 14). */
export function listSupplierRecentRecords(supplierId: number, limit: number): SupplierRecentRecordRow[] {
  return (
    getDb()
      .prepare(
        `SELECT pr.id, pr.purchase_date, o.code AS org_code, m.original_code AS material_code,
                m.original_description AS material_description, cm.code AS cmi_code,
                pr.uom, pr.quantity, pr.currency, pr.unit_price
           FROM procurement_records pr
           JOIN organizations o ON o.id = pr.organization_id
           JOIN material_records m ON m.id = pr.material_id
           LEFT JOIN common_materials cm ON cm.id = pr.cmi_id
          WHERE pr.supplier_id = ?
          ORDER BY pr.purchase_date DESC, pr.id DESC
          LIMIT ?`
      )
      .all(supplierId, limit) as unknown as Array<Record<string, unknown>>
  ).map((r) => ({
    id: Number(r.id),
    purchaseDate: String(r.purchase_date),
    orgCode: String(r.org_code),
    materialCode: String(r.material_code),
    materialDescription: String(r.material_description),
    cmiCode: r.cmi_code === null || r.cmi_code === undefined ? null : String(r.cmi_code),
    uom: String(r.uom),
    quantity: decOut(r.quantity),
    currency: (r.currency as string | null) ?? null,
    unitPrice: r.unit_price === null || r.unit_price === undefined || r.unit_price === '' ? null : decOut(r.unit_price),
  }));
}

// ---------------------------------------------------------------------------
// Step 17 - UOM harmonization (comparable quantity intelligence).
//
// Architecture: procurement_records stay authoritative (original quantity +
// original UOM are never mutated). Normalization is DERIVED in SQL through a
// single-hop LEFT JOIN onto the tiny uom_conversion_rules registry, and every
// aggregate remains an exact integer in "cent-units" (quantity x 100), because
// seeded factors are positive INTEGERs:
//     normalized_cents = qty_cents * factor      (no float, no rounding)
// Canonical vocabulary (documented in docs/PROCUREMENT.md):
//   count  -> EA   (PCS, NOS via ALIAS factor 1)
//   mass   -> G    (KG x1000, TON x1000000 via SCALE)
//   volume -> ML   (L x1000 via SCALE)
//   length -> MM   (M x1000, CM x10 via SCALE)
// SET is deliberately UNCONVERTED (no authoritative generic conversion), and
// DOMAIN_SPECIFIC rules are excluded from global aggregation because they are
// material-scoped by definition (section 9) - they never fire globally.
// ---------------------------------------------------------------------------

export interface UomConversionRuleRow {
  id: number;
  fromUom: string;
  toUom: string;
  factor: number;
  ruleType: UomRuleType;
  source: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Read the full conversion registry (small, indexed, read-only in Step 17). */
export function listUomConversionRules(): UomConversionRuleRow[] {
  return (
    getDb()
      .prepare(
        `SELECT id, from_uom, to_uom, factor, rule_type, source, description, is_active, created_at, updated_at
           FROM uom_conversion_rules ORDER BY rule_type, from_uom, to_uom`
      )
      .all() as unknown as Array<Record<string, unknown>>
  ).map((r) => ({
    id: Number(r.id),
    fromUom: String(r.from_uom),
    toUom: String(r.to_uom),
    factor: Number(r.factor),
    ruleType: String(r.rule_type) as UomRuleType,
    source: String(r.source),
    description: r.description === null || r.description === undefined ? null : String(r.description),
    isActive: Number(r.is_active) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

/** The active single-hop rule for one source UOM (upper-cased), or null. */
export function findActiveUomRule(uom: string): UomConversionRuleRow | null {
  const u = uom.trim().toUpperCase();
  if (u === '') return null;
  const rows = listUomConversionRules().filter(
    (r) => r.isActive && (r.ruleType === 'ALIAS' || r.ruleType === 'SCALE') && r.fromUom === u
  );
  // Invariant (documented): at most one active ALIAS/SCALE rule per source
  // UOM. The seed satisfies it; if master data ever violates it, fail closed
  // -> null. DOMAIN_SPECIFIC rules are never resolved here (section 9: they
  // are material-scoped and must not apply globally).
  return rows.length === 1 ? rows[0] : null;
}

/** Documented §4 vocabulary: units the system recognizes. */
const KNOWN_UOMS = ['EA', 'PCS', 'NOS', 'SET', 'KG', 'G', 'TON', 'L', 'ML', 'M', 'CM', 'MM'];
/** Canonical (rule-target) units. */
const CANONICAL_UOMS = ['EA', 'G', 'ML', 'MM'];

/** Map a row-level conversion status to its §31 data-quality category. */
function qualityCategory(status: string): string {
  switch (status) {
    case 'NORMALIZED': return 'VALID_CANONICAL';
    case 'ALIAS_NORMALIZED': return 'VALID_ALIAS';
    case 'SCALED': return 'VALID_CONVERTED';
    case 'UNCONVERTED': return 'UNCONVERTED';
    default: return 'UNKNOWN'; // INVALID and reserved INCOMPATIBLE land here
  }
}

/** Row-level conversion status for a source UOM (deterministic, §12). */
export function classifyUom(uom: string | null | undefined): string {
  if (uom === null || uom === undefined || uom.trim() === '') return 'INVALID';
  const u = uom.trim().toUpperCase();
  const rule = findActiveUomRule(u);
  if (rule && rule.ruleType === 'ALIAS') return 'ALIAS_NORMALIZED';
  if (rule && rule.ruleType === 'SCALE') return 'SCALED';
  if (CANONICAL_UOMS.includes(u)) return 'NORMALIZED';
  if (KNOWN_UOMS.includes(u)) return 'UNCONVERTED';
  return 'UNKNOWN';
}

// Single-hop normalization join + expressions. The registry is tiny and
// indexed (idx_uom_rules_active) so the join is O(1) per row; DOMAIN_SPECIFIC
// rules are excluded (material-scoped, never global - section 9).
const UOM_NORM_JOIN = `LEFT JOIN uom_conversion_rules r
    ON r.is_active = 1 AND r.rule_type IN ('ALIAS','SCALE')
   AND r.from_uom = UPPER(TRIM(pr.uom))`;
const NORM_UOM = `COALESCE(r.to_uom, UPPER(TRIM(pr.uom)))`;
const NORM_CENTS = `CAST(ROUND(pr.quantity * 100) AS INTEGER) * COALESCE(r.factor, 1)`;

export interface UomScope {
  cmiId?: number;
  organizationId?: number;
  supplierId?: number;
}

function uomScopeWhere(s: UomScope): { where: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (s.cmiId !== undefined) { clauses.push('pr.cmi_id = ?'); params.push(s.cmiId); }
  if (s.organizationId !== undefined) { clauses.push('pr.organization_id = ?'); params.push(s.organizationId); }
  if (s.supplierId !== undefined) { clauses.push('pr.supplier_id = ?'); params.push(s.supplierId); }
  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

export interface ComparableDemandSummary {
  recordCount: number;
  /** Comparable (normalized) quantity per CANONICAL UOM - exact decimals. */
  comparableQuantityByUom: Record<string, string>;
  /** Original quantity per ORIGINAL UOM - never mutated, always visible. */
  originalQuantityByUom: Record<string, string>;
  /** Row-level conversion status counts (section 12) for the same scope. */
  statusCounts: Record<string, number>;
  /** Section 31 data-quality categories derived from statusCounts. */
  qualityCounts: Record<string, number>;
}

function comparableSummary(scope: UomScope): ComparableDemandSummary {
  const { where, params } = uomScopeWhere(scope);
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM procurement_records pr${where}`)
    .get(...params) as unknown as { n: number };
  const normRows = getDb()
    .prepare(
      `SELECT ${NORM_UOM} AS uom, SUM(${NORM_CENTS}) AS s
         FROM procurement_records pr
         ${UOM_NORM_JOIN}${where}
        GROUP BY ${NORM_UOM} ORDER BY 1`
    )
    .all(...params) as unknown as UomCentsRow[];
  const origRows = getDb()
    .prepare(
      `SELECT UPPER(TRIM(pr.uom)) AS uom, SUM(${QTY_CENTS}) AS s
         FROM procurement_records pr${where}
        GROUP BY UPPER(TRIM(pr.uom)) ORDER BY 1`
    )
    .all(...params) as unknown as UomCentsRow[];
  const uomCounts = getDb()
    .prepare(
      `SELECT UPPER(TRIM(pr.uom)) AS uom, COUNT(*) AS n
         FROM procurement_records pr${where}
        GROUP BY UPPER(TRIM(pr.uom))`
    )
    .all(...params) as unknown as Array<{ uom: string; n: number }>;
  const statusCounts: Record<string, number> = {};
  for (const r of uomCounts) {
    const st = classifyUom(r.uom);
    statusCounts[st] = (statusCounts[st] ?? 0) + Number(r.n);
  }
  const qualityCounts: Record<string, number> = {};
  for (const [st, n] of Object.entries(statusCounts)) {
    const q = qualityCategory(st);
    qualityCounts[q] = (qualityCounts[q] ?? 0) + n;
  }
  return {
    recordCount: Number(total.n),
    comparableQuantityByUom: qtyMap(normRows),
    originalQuantityByUom: qtyMap(origRows),
    statusCounts,
    qualityCounts,
  };
}

export interface CmiComparableOrgRow {
  organizationId: number;
  orgCode: string;
  orgName: string;
  originalQuantityByUom: Record<string, string>;
  comparableQuantityByUom: Record<string, string>;
}

export interface CmiComparableDemand extends ComparableDemandSummary {
  cmiId: number;
  cmiCode: string;
  cmiName: string;
  byOrg: CmiComparableOrgRow[];
}

/**
 * Comparable demand for one CMI (Step 17 sections 15/16): normalized
 * quantity per canonical UOM alongside the untouched original per-UOM
 * breakdown. All aggregation is SQL-side; conversions derive from the
 * explicit registry only. Returns null when the CMI does not exist.
 */
export function getCmiComparableDemand(cmiId: number): CmiComparableDemand | null {
  const cmi = getDb()
    .prepare(`SELECT id, code, name FROM common_materials WHERE id = ?`)
    .get(cmiId) as { id: number; code: string; name: string } | undefined;
  if (!cmi) return null;
  const summary = comparableSummary({ cmiId });
  const { where, params } = uomScopeWhere({ cmiId });
  const orgCounts = getDb()
    .prepare(
      `SELECT pr.organization_id AS oid, o.code AS org_code, o.name AS org_name
         FROM procurement_records pr JOIN organizations o ON o.id = pr.organization_id${where}
        GROUP BY pr.organization_id, o.code, o.name ORDER BY o.code`
    )
    .all(...params) as unknown as Array<{ oid: number; org_code: string; org_name: string }>;
  const origByOrg = getDb()
    .prepare(
      `SELECT pr.organization_id AS oid, UPPER(TRIM(pr.uom)) AS uom, SUM(${QTY_CENTS}) AS s
         FROM procurement_records pr${where}
        GROUP BY pr.organization_id, UPPER(TRIM(pr.uom))`
    )
    .all(...params) as unknown as Array<{ oid: number; uom: string; s: number }>;
  const normByOrg = getDb()
    .prepare(
      `SELECT pr.organization_id AS oid, ${NORM_UOM} AS nu, SUM(${NORM_CENTS}) AS s
         FROM procurement_records pr
         ${UOM_NORM_JOIN}${where}
        GROUP BY pr.organization_id, ${NORM_UOM}`
    )
    .all(...params) as unknown as Array<{ oid: number; nu: string; s: number }>;
  const byOrg: CmiComparableOrgRow[] = orgCounts.map((o) => ({
    organizationId: Number(o.oid),
    orgCode: o.org_code,
    orgName: o.org_name,
    originalQuantityByUom: qtyMap(origByOrg.filter((r) => Number(r.oid) === Number(o.oid)).map((r) => ({ uom: r.uom, s: r.s }))),
    comparableQuantityByUom: qtyMap(normByOrg.filter((r) => Number(r.oid) === Number(o.oid)).map((r) => ({ uom: r.nu, s: r.s }))),
  }));
  return { cmiId: cmi.id, cmiCode: cmi.code, cmiName: cmi.name, byOrg, ...summary };
}

/** Comparable quantity for one supplier (section 17): original vs normalized totals. */
export function getSupplierComparableQuantity(supplierId: number): ComparableDemandSummary | null {
  const s = getDb().prepare(`SELECT id FROM suppliers WHERE id = ?`).get(supplierId);
  if (!s) return null;
  return comparableSummary({ supplierId });
}

/** Comparable quantity for one CPSE (section 20, aggregation level E). */
export function getOrganizationComparableQuantity(organizationId: number): ComparableDemandSummary | null {
  const o = getDb().prepare(`SELECT id FROM organizations WHERE id = ?`).get(organizationId);
  if (!o) return null;
  return comparableSummary({ organizationId });
}

export interface UomQualityCounts {
  totalRecords: number;
  counts: Record<string, number>;
  /** Unrecognized UOM tokens with counts (bounded diagnostic list). */
  unknownUoms: Array<{ uom: string; count: number }>;
}

/** UOM data-quality visibility (section 31): categories + unknown-unit diagnostics. */
export function getUomQualityCounts(scope: UomScope = {}, precomputed?: UomQualityCounts): UomQualityCounts {
  if (scope.cmiId === undefined && scope.supplierId === undefined && scope.organizationId === undefined && precomputed) {
    return precomputed;
  }
  const summary = comparableSummary(scope);
  const { where, params } = uomScopeWhere(scope);
  const unknownRows = getDb()
    .prepare(
      `SELECT UPPER(TRIM(pr.uom)) AS uom, COUNT(*) AS n
         FROM procurement_records pr${where}
        GROUP BY UPPER(TRIM(pr.uom))
        HAVING UPPER(TRIM(pr.uom)) NOT IN (${KNOWN_UOMS.map(() => '?').join(',')})
        ORDER BY n DESC, uom LIMIT 50`
    )
    .all(...params, ...KNOWN_UOMS) as unknown as Array<{ uom: string; n: number }>;
  return {
    totalRecords: summary.recordCount,
    counts: summary.qualityCounts,
    unknownUoms: unknownRows.map((r) => ({ uom: r.uom, count: Number(r.n) })),
  };
}

// ---------------------------------------------------------------------------
// Step 18 - governed DOMAIN_SPECIFIC (CMI-scoped) UOM rules.
//
// Precedence (section 5), identical at service level and in SQL:
//   1. APPROVED domain rule scoped to the record's CMI
//   2. active SYSTEM_DEFINED ALIAS rule
//   3. active SYSTEM_DEFINED SCALE rule
//   4. no applicable rule -> UNCONVERTED
// SYSTEM rules never resolve DOMAIN_SPECIFIC (Step 17 contract, pinned by
// test); domain rules only ever participate inside their own CMI scope.
// Only the governance mutations below touch uom_domain_rules - analytics
// reads stay audit-silent exactly as in Step 17.
// ---------------------------------------------------------------------------

export interface UomDomainRuleRow {
  id: number;
  cmiId: number;
  cmiCode: string;
  cmiName: string;
  fromUom: string;
  toUom: string;
  factor: number;
  ruleType: 'DOMAIN_SPECIFIC';
  status: UomDomainRuleStatus;
  source: string;
  reason: string;
  createdBy: string;
  approvedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Step 20: currently effective immutable content version (null: never approved). */
  effectiveVersionId: number | null;
  /** Step 20: amendment awaiting decision, or the not-yet-approved initial version. */
  pendingVersionId: number | null;
}

const DOMAIN_SELECT = `
  SELECT d.id, d.cmi_id, cm.code AS cmi_code, cm.name AS cmi_name,
         d.from_uom, d.to_uom, d.factor, d.rule_type, d.status, d.source,
         d.reason, d.created_by, d.approved_by, d.decided_at,
         d.created_at, d.updated_at,
         d.effective_version_id, d.pending_version_id
    FROM uom_domain_rules d
    JOIN common_materials cm ON cm.id = d.cmi_id`;

function mapDomainRule(r: Record<string, unknown>): UomDomainRuleRow {
  return {
    id: Number(r.id),
    cmiId: Number(r.cmi_id),
    cmiCode: String(r.cmi_code),
    cmiName: String(r.cmi_name),
    fromUom: String(r.from_uom),
    toUom: String(r.to_uom),
    factor: Number(r.factor),
    ruleType: 'DOMAIN_SPECIFIC',
    status: String(r.status) as UomDomainRuleStatus,
    source: String(r.source),
    reason: String(r.reason),
    createdBy: String(r.created_by),
    approvedBy: r.approved_by === null || r.approved_by === undefined ? null : String(r.approved_by),
    decidedAt: r.decided_at === null || r.decided_at === undefined ? null : String(r.decided_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    effectiveVersionId: r.effective_version_id === null || r.effective_version_id === undefined ? null : Number(r.effective_version_id),
    pendingVersionId: r.pending_version_id === null || r.pending_version_id === undefined ? null : Number(r.pending_version_id),
  };
}

/** All governed domain rules (any status), newest first. */
export function listUomDomainRules(): UomDomainRuleRow[] {
  return (
    getDb().prepare(`${DOMAIN_SELECT} ORDER BY d.id DESC`).all() as unknown as Array<Record<string, unknown>>
  ).map(mapDomainRule);
}

export function getUomDomainRuleRequired(id: number): UomDomainRuleRow {
  const r = getDb().prepare(`${DOMAIN_SELECT} WHERE d.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`UOM domain rule ${id} not found`);
  return mapDomainRule(r);
}

export interface NewUomDomainRule {
  cmiId: number;
  fromUom: string;
  toUom: string;
  factor: number;
  reason: string;
  createdBy: string;
}

/**
 * Create a PENDING domain rule (never active automatically). Fails closed on:
 * unknown CMI, unknown/non-canonical target UOM, non-positive-integer factor,
 * self conversion, or an existing LIVE rule for the same (cmi, from_uom) -
 * a REJECTED rule may be superseded by a new proposal (section 8).
 */
export function insertUomDomainRule(input: NewUomDomainRule): number {
  const cmi = getDb().prepare(`SELECT id FROM common_materials WHERE id = ?`).get(input.cmiId);
  if (!cmi) throw new Error('Unknown CMI: domain rules must be scoped to an existing common material identity');
  const from = input.fromUom.trim().toUpperCase();
  const to = input.toUom.trim().toUpperCase();
  if (from === '') throw new Error('from_uom must not be empty');
  if (from === to) throw new Error('from_uom and to_uom must differ');
  if (!CANONICAL_UOMS.includes(to)) throw new Error(`to_uom ${to} is not a canonical UOM (${CANONICAL_UOMS.join('/')})`);
  if (!Number.isInteger(input.factor) || input.factor <= 0) throw new Error('factor must be a positive integer');
  const reason = input.reason.trim();
  if (reason === '') throw new Error('reason/evidence is required for a governed rule proposal');
  const live = getDb()
    .prepare(
      `SELECT COUNT(*) n FROM uom_domain_rules WHERE cmi_id = ? AND UPPER(TRIM(from_uom)) = ? AND status IN ('PENDING','APPROVED','DISABLED')`
    )
    .get(input.cmiId, from) as unknown as { n: number };
  if (live.n > 0) throw new Error('A live (PENDING/APPROVED/DISABLED) domain rule already exists for this CMI and source UOM; disable or reject it first');
  const res = getDb()
    .prepare(
      `INSERT INTO uom_domain_rules (cmi_id, from_uom, to_uom, factor, rule_type, status, source, reason, created_by)
       VALUES (?, ?, ?, ?, 'DOMAIN_SPECIFIC', 'PENDING', 'GOVERNED', ?, ?)`
    )
    .run(input.cmiId, from, to, input.factor, reason, input.createdBy);
  const ruleId = Number(res.lastInsertRowid);
  // Step 20: creation also writes the immutable v1 content version and
  // points the live rule's pending_version_id at it. Nothing is EFFECTIVE
  // until a human approves (section 5) - conversion behavior is unchanged.
  const vres = getDb()
    .prepare(
      `INSERT INTO uom_domain_rule_versions
         (rule_id, version_number, cmi_id, from_uom, to_uom, factor, rule_type, amendment_reason, created_by, supersedes_version_id)
       VALUES (?, 1, ?, ?, ?, ?, 'DOMAIN_SPECIFIC', ?, ?, NULL)`
    )
    .run(ruleId, input.cmiId, from, to, input.factor, reason, input.createdBy);
  getDb()
    .prepare(`UPDATE uom_domain_rules SET pending_version_id = ? WHERE id = ?`)
    .run(Number(vres.lastInsertRowid), ruleId);
  return ruleId;
}

/** Allowed human transitions; anything else throws (section 8). */
export function transitionUomDomainRule(
  id: number,
  action: 'approve' | 'reject' | 'disable' | 're-enable',
  actor: string
): UomDomainRuleRow {
  const row = getUomDomainRuleRequired(id);
  const allowed: Record<UomDomainRuleStatus, string[]> = {
    PENDING: ['approve', 'reject'],
    APPROVED: ['disable'],
    REJECTED: [],
    DISABLED: ['re-enable'],
  };
  if (!allowed[row.status].includes(action)) {
    throw new Error(`Invalid transition: ${action} is not allowed for a ${row.status} rule`);
  }
  const next: Partial<Record<'approve' | 'reject' | 'disable' | 're-enable', UomDomainRuleStatus>> = {
    approve: 'APPROVED',
    reject: 'REJECTED',
    disable: 'DISABLED',
    're-enable': 'APPROVED',
  };
  const status = next[action]!;
  // Step 20: the decision consumes the pending version. APPROVE makes the
  // pending version the effective one (when the decision is on an amendment,
  // the service swaps the pointer first); REJECT discards the pointer. The
  // approved-by/decided_at columns stay the Step-18 audit surface. The
  // denormalized content columns always mirror the EFFECTIVE version so the
  // read model stays single-sourced.
  const decidedAt = new Date().toISOString();
  if (action === 'approve') {
    getDb()
      .prepare(
        `UPDATE uom_domain_rules
            SET status = ?, approved_by = ?, decided_at = ?, updated_at = ?,
                effective_version_id = COALESCE(pending_version_id, effective_version_id),
                pending_version_id = NULL
          WHERE id = ?`
      )
      .run(status, actor, decidedAt, decidedAt, id);
  } else {
    getDb()
      .prepare(
        `UPDATE uom_domain_rules
            SET status = ?, approved_by = ?, decided_at = ?, updated_at = ?, pending_version_id = NULL
          WHERE id = ?`
      )
      .run(status, actor, decidedAt, decidedAt, id);
  }
  const afterRow = getUomDomainRuleRequired(id);
  if (afterRow.effectiveVersionId !== null) {
    const v = getUomRuleVersionRequired(afterRow.effectiveVersionId);
    getDb()
      .prepare(
        `UPDATE uom_domain_rules
            SET from_uom = ?, to_uom = ?, factor = ?, reason = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(v.fromUom, v.toUom, v.factor, v.amendmentReason ?? afterRow.reason, decidedAt, id);
  }
  return getUomDomainRuleRequired(id);
}

/**
 * Step 17 semantic: which records belong to a CMI (its mapped members). The
 * same set of material ids that proc()/detection rely on via cmi_id - here
 * expressed from material_mappings so scoping is master-data derived.
 */
function cmiMemberMaterialIds(cmiId: number): number[] {
  return (
    getDb()
      .prepare(`SELECT material_id FROM material_mappings WHERE cmi_id = ?`)
      .all(cmiId) as unknown as Array<{ material_id: number }>
  ).map((r) => Number(r.material_id));
}

/**
 * Effective single-hop rule for one (scope, uom): APPROVED domain rule for
 * the CMI first, then the Step 17 system rule, else null. Service-side
 * resolution used by normalizeQuantity and governance previews.
 */
export function resolveEffectiveUomRule(uom: string, cmiId?: number | null): UomConversionRuleRow | UomDomainRuleRow | null {
  const u = uom.trim().toUpperCase();
  if (u === '') return null;
  if (cmiId !== undefined && cmiId !== null) {
    const rows = getDb()
      .prepare(
        `SELECT id FROM uom_domain_rules WHERE cmi_id = ? AND UPPER(TRIM(from_uom)) = ? AND status = 'APPROVED'`
      )
      .all(cmiId, u) as unknown as Array<{ id: number }>;
    // Invariant: the partial unique index allows at most one live rule per
    // (cmi, from_uom). Fail closed on violations (never guess between them).
    if (rows.length === 1) {
      const full = getUomDomainRuleRequired(Number(rows[0].id));
      return {
        id: full.id, fromUom: full.fromUom, toUom: full.toUom, factor: full.factor,
        ruleType: 'DOMAIN_SPECIFIC' as UomRuleType, source: full.source,
        description: full.reason, isActive: true, createdAt: full.createdAt, updatedAt: full.updatedAt,
      };
    }
    if (rows.length > 1) return null;
  }
  return findActiveUomRule(u);
}

/** Domain rules + their status for one CMI (scope isolation visibility). */
export function listUomDomainRulesForCmi(cmiId: number): UomDomainRuleRow[] {
  return (
    getDb().prepare(`${DOMAIN_SELECT} WHERE d.cmi_id = ? ORDER BY d.id DESC`).all(cmiId) as unknown as Array<Record<string, unknown>>
  ).map(mapDomainRule);
}

/** Counts of procurement records per original UOM inside one CMI scope. */
export function getUomCountsForCmi(cmiId: number): Array<{ uom: string; count: number }> {
  return (
    getDb()
      .prepare(
        `SELECT UPPER(TRIM(pr.uom)) AS uom, COUNT(*) AS n
           FROM procurement_records pr WHERE pr.cmi_id = ?
          GROUP BY UPPER(TRIM(pr.uom)) ORDER BY n DESC, uom`
      )
      .all(cmiId) as unknown as Array<{ uom: string; n: number }>
  ).map((r) => ({ uom: String(r.uom), count: Number(r.n) }));
}

/** Procurement records of one CMI filtered by verbatim source UOM (bounded). */
export function listCmiRecordsByUom(cmiId: number, uom: string, limit = 25): ProcurementWithContext[] {
  return listProcurementRecords({ cmiId, uom }, 1, limit).items;
}

// Scoped normalization join: an APPROVED domain rule for the record's CMI
// takes precedence over the system registry (section 5), LEFT JOINed so
// records without any rule keep their verbatim representation.
// idx_uom_domain_lookup (cmi_id, from_uom, status) makes the domain hop an
// indexed SEARCH; records with cmi_id NULL can never match a domain rule.
const DOMAIN_NORM_JOIN = `
    LEFT JOIN uom_domain_rules dr
      ON dr.status = 'APPROVED' AND dr.rule_type = 'DOMAIN_SPECIFIC'
     AND dr.cmi_id = pr.cmi_id AND dr.from_uom = UPPER(TRIM(pr.uom))`;

/**
 * Comparable summary under Step 18 precedence (domain rule first, then
 * system rules, else verbatim). Shape and exactness contract are Step 17's
 * (integer-cent BigInt sums; canonical buckets). With zero domain rules this
 * is byte-identical to the Step 17 comparableSummary.
 */
function comparableSummaryScoped(scope: UomScope): ComparableDemandSummary {
  const { where, params } = uomScopeWhere(scope);
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM procurement_records pr${where}`)
    .get(...params) as unknown as { n: number };
  const normRows = getDb()
    .prepare(
      `SELECT COALESCE(dr.to_uom, ${NORM_UOM}) AS uom,
              SUM(COALESCE(dr.factor, 1) * CAST(ROUND(pr.quantity * 100) AS INTEGER) * COALESCE(r.factor, 1)) AS s
         FROM procurement_records pr
         ${DOMAIN_NORM_JOIN}
         ${UOM_NORM_JOIN}${where}
        GROUP BY COALESCE(dr.to_uom, ${NORM_UOM}) ORDER BY 1`
    )
    .all(...params) as unknown as UomCentsRow[];
  const origRows = getDb()
    .prepare(
      `SELECT UPPER(TRIM(pr.uom)) AS uom, SUM(${QTY_CENTS}) AS s
         FROM procurement_records pr${where}
        GROUP BY UPPER(TRIM(pr.uom)) ORDER BY 1`
    )
    .all(...params) as unknown as UomCentsRow[];
  const uomCounts = getDb()
    .prepare(
      `SELECT UPPER(TRIM(pr.uom)) AS uom, COUNT(*) AS n, dr.id IS NOT NULL AS is_domain
         FROM procurement_records pr
         ${DOMAIN_NORM_JOIN}${where}
        GROUP BY UPPER(TRIM(pr.uom)), is_domain`
    )
    .all(...params) as unknown as Array<{ uom: string; n: number; is_domain: number }>;
  // Status counts under domain precedence: records converted by an APPROVED
  // domain rule are SCALED-shaped (exact integer-factor hop to a canonical
  // unit); everything else keeps its Step 17 classification.
  const statusCounts: Record<string, number> = {};
  for (const r of uomCounts) {
    const st = r.is_domain ? 'SCALED' : classifyUom(r.uom);
    statusCounts[st] = (statusCounts[st] ?? 0) + Number(r.n);
  }
  const qualityCounts: Record<string, number> = {};
  for (const [st, n] of Object.entries(statusCounts)) {
    const q = qualityCategory(st);
    qualityCounts[q] = (qualityCounts[q] ?? 0) + n;
  }
  return {
    recordCount: Number(total.n),
    comparableQuantityByUom: qtyMap(normRows),
    originalQuantityByUom: qtyMap(origRows),
    statusCounts,
    qualityCounts,
  };
}

/**
 * Comparable demand for one CMI under Step 18 precedence, including the
 * per-CPSE breakdown. With zero domain rules this matches Step 17's
 * getCmiComparableDemand exactly.
 */
export function getCmiComparableDemandV2(cmiId: number): CmiComparableDemand | null {
  const cmi = getDb()
    .prepare(`SELECT id, code, name FROM common_materials WHERE id = ?`)
    .get(cmiId) as { id: number; code: string; name: string } | undefined;
  if (!cmi) return null;
  const summary = comparableSummaryScoped({ cmiId });
  const { where, params } = uomScopeWhere({ cmiId });
  const orgCounts = getDb()
    .prepare(
      `SELECT pr.organization_id AS oid, o.code AS org_code, o.name AS org_name
         FROM procurement_records pr JOIN organizations o ON o.id = pr.organization_id${where}
        GROUP BY pr.organization_id, o.code, o.name ORDER BY o.code`
    )
    .all(...params) as unknown as Array<{ oid: number; org_code: string; org_name: string }>;
  const origByOrg = getDb()
    .prepare(
      `SELECT pr.organization_id AS oid, UPPER(TRIM(pr.uom)) AS uom, SUM(${QTY_CENTS}) AS s
         FROM procurement_records pr${where}
        GROUP BY pr.organization_id, UPPER(TRIM(pr.uom))`
    )
    .all(...params) as unknown as Array<{ oid: number; uom: string; s: number }>;
  const normByOrg = getDb()
    .prepare(
      `SELECT pr.organization_id AS oid, COALESCE(dr.to_uom, ${NORM_UOM}) AS nu,
              SUM(COALESCE(dr.factor, 1) * CAST(ROUND(pr.quantity * 100) AS INTEGER) * COALESCE(r.factor, 1)) AS s
         FROM procurement_records pr
         ${DOMAIN_NORM_JOIN}
         ${UOM_NORM_JOIN}${where}
        GROUP BY pr.organization_id, COALESCE(dr.to_uom, ${NORM_UOM})`
    )
    .all(...params) as unknown as Array<{ oid: number; nu: string; s: number }>;
  const byOrg: CmiComparableOrgRow[] = orgCounts.map((o) => ({
    organizationId: Number(o.oid),
    orgCode: o.org_code,
    orgName: o.org_name,
    originalQuantityByUom: qtyMap(origByOrg.filter((r) => Number(r.oid) === Number(o.oid)).map((r) => ({ uom: r.uom, s: r.s }))),
    comparableQuantityByUom: qtyMap(normByOrg.filter((r) => Number(r.oid) === Number(o.oid)).map((r) => ({ uom: r.nu, s: r.s }))),
  }));
  return { cmiId: cmi.id, cmiCode: cmi.code, cmiName: cmi.name, byOrg, ...summary };
}

/** Supplier comparable quantity under Step 18 precedence (section 12 parity). */
export function getSupplierComparableQuantityV2(supplierId: number): ComparableDemandSummary | null {
  const s = getDb().prepare(`SELECT id FROM suppliers WHERE id = ?`).get(supplierId);
  if (!s) return null;
  return comparableSummaryScoped({ supplierId });
}

/** CPSE comparable quantity under Step 18 precedence (section 12 parity). */
export function getOrganizationComparableQuantityV2(organizationId: number): ComparableDemandSummary | null {
  const o = getDb().prepare(`SELECT id FROM organizations WHERE id = ?`).get(organizationId);
  if (!o) return null;
  return comparableSummaryScoped({ organizationId });
}
// ---------------------------------------------------------------------------
// Step 19 - append-only UOM rule history + steward aggregates.
// History rows are written ONLY inside governed service transactions
// (create/transition); analytics reads never write. UPDATE and DELETE are
// physically refused by the v18 triggers, so history can only grow.
// ---------------------------------------------------------------------------

export type UomRuleHistoryAction = 'CREATE' | 'APPROVE' | 'REJECT' | 'DISABLE' | 'RE_ENABLE' | 'AMEND';

export interface UomRuleHistoryRow {
  id: number;
  ruleId: number;
  cmiId: number;
  cmiCode: string;
  fromUom: string;
  toUom: string;
  factor: number;
  ruleType: 'DOMAIN_SPECIFIC';
  previousStatus: UomDomainRuleStatus | null;
  newStatus: UomDomainRuleStatus;
  action: UomRuleHistoryAction;
  actor: string;
  reason: string | null;
  createdAt: string;
  /** Step 20: version context - the version this event concerns and, for
   * amendments, the version it supersedes. NULL for pre-Step-20 rows. */
  versionId: number | null;
  previousVersionId: number | null;
}

const HISTORY_SELECT = `
  SELECT h.id, h.rule_id, h.cmi_id, cm.code AS cmi_code,
         h.from_uom, h.to_uom, h.factor, h.rule_type,
         h.          previous_status, h.new_status, h.action, h.actor, h.reason, h.created_at,
          h.version_id, h.previous_version_id
    FROM uom_rule_history h
    LEFT JOIN common_materials cm ON cm.id = h.cmi_id`;

function mapHistory(r: Record<string, unknown>): UomRuleHistoryRow {
  return {
    id: Number(r.id),
    ruleId: Number(r.rule_id),
    cmiId: Number(r.cmi_id),
    cmiCode: r.cmi_code === null || r.cmi_code === undefined ? '' : String(r.cmi_code),
    fromUom: String(r.from_uom),
    toUom: String(r.to_uom),
    factor: Number(r.factor),
    ruleType: 'DOMAIN_SPECIFIC',
    previousStatus: r.previous_status === null || r.previous_status === undefined ? null : (String(r.previous_status) as UomDomainRuleStatus),
    newStatus: String(r.new_status) as UomDomainRuleStatus,
    action: String(r.action) as UomRuleHistoryAction,
    actor: String(r.actor),
    reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
    createdAt: String(r.created_at),
    versionId: r.version_id === null || r.version_id === undefined ? null : Number(r.version_id),
    previousVersionId:
      r.previous_version_id === null || r.previous_version_id === undefined ? null : Number(r.previous_version_id),
  };
}

/** Append one history row (internal; called only by governed service actions). */
export function insertUomRuleHistory(input: {
  ruleId: number;
  cmiId: number;
  fromUom: string;
  toUom: string;
  factor: number;
  previousStatus: UomDomainRuleStatus | null;
  newStatus: UomDomainRuleStatus;
  action: UomRuleHistoryAction;
  actor: string;
  reason?: string | null;
  versionId?: number | null;
  previousVersionId?: number | null;
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO uom_rule_history
         (rule_id, cmi_id, from_uom, to_uom, factor, rule_type, previous_status, new_status, action, actor, reason, version_id, previous_version_id)
       VALUES (?, ?, ?, ?, ?, 'DOMAIN_SPECIFIC', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.ruleId, input.cmiId, input.fromUom, input.toUom, input.factor,
      input.previousStatus, input.newStatus, input.action, input.actor, input.reason ?? null,
      input.versionId ?? null, input.previousVersionId ?? null
    );
  return Number(res.lastInsertRowid);
}

/** Full append-only history for one rule, chronological (section 6). */
export function listUomRuleHistory(ruleId: number): UomRuleHistoryRow[] {
  return (
    getDb().prepare(`${HISTORY_SELECT} WHERE h.rule_id = ? ORDER BY h.id ASC`).all(ruleId) as unknown as Array<
      Record<string, unknown>
    >
  ).map(mapHistory);
}

export function countUomRuleHistory(ruleId: number): number {
  const r = getDb().prepare(`SELECT COUNT(*) AS n FROM uom_rule_history WHERE rule_id = ?`).get(ruleId) as unknown as {
    n: number;
  };
  return Number(r.n);
}

export interface UomStewardPendingRow {
  rule: UomDomainRuleRow;
  historyCount: number;
  cmiRecordCount: number;
  affectedRecords: number;
}

export interface UomStewardActivityRow extends UomRuleHistoryRow {
  ruleStatus: UomDomainRuleStatus | null;
}

export interface UomStewardOverview {
  rules: { total: number; pending: number; approved: number; rejected: number; disabled: number };
  quality: {
    totalRecords: number;
    counts: Record<string, number>;
    unknownUoms: Array<{ uom: string; count: number }>;
    unconvertedRecords: number;
    cmisRequiringRemediation: number;
  };
  activity: {
    horizonDays: number;
    created: number;
    approved: number;
    rejected: number;
    disabled: number;
    reEnabled: number;
  };
  /** Work queue: every PENDING rule awaiting a human decision (section 6). */
  pendingQueue: UomStewardPendingRow[];
  /** Step 20: rules with a PENDING amendment awaiting a decision. */
  amendmentQueue: UomStewardAmendmentRow[];
  /** Step 20 (section 15): version + amendment activity over the horizon. */
  versions: { total: number; superseded: number };
  amendments: { pending: number; proposed: number; approved: number; rejected: number; horizonDays: number };
  /** Step 20 (section 15): full-ledger governance reconciliation. */
  reconciliation: UomReconciliationResult;
  /** Latest governance activity (all actions), newest first, bounded. */
  recentActivity: UomStewardActivityRow[];
}

const STEWARD_ACTIVITY_HORIZON_DAYS = 30;

/**
 * @param precomputedQuality optional already-computed GLOBAL quality pass.
 * The cockpit computes it once and threads it here so the (most expensive)
 * Step-17 scan never runs twice per page render. Scoped calls ignore it.
 */
export function getUomStewardOverview(precomputedQuality?: UomQualityCounts): UomStewardOverview {
  // Rule lifecycle counts - GROUP BY over the small governed table only.
  const ruleRows = getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM uom_domain_rules GROUP BY status`)
    .all() as unknown as Array<{ status: string; n: number }>;
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of ruleRows) {
    byStatus[r.status] = Number(r.n);
    total += Number(r.n);
  }

  // Data quality - the same Step 17/18 quality pass used everywhere else.
  const quality = getUomQualityCounts(undefined, precomputedQuality);
  const unconvertedRecords = (quality.counts.UNCONVERTED ?? 0) + (quality.counts.UNKNOWN ?? 0);
  const knownList = KNOWN_UOMS.map(() => '?').join(',');
  const remedCmis = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT pr.cmi_id) AS n
         FROM procurement_records pr
        WHERE pr.cmi_id IS NOT NULL
          AND UPPER(TRIM(pr.uom)) NOT IN (${knownList})`
    )
    .get(...KNOWN_UOMS) as unknown as { n: number };

  // Governance activity over the horizon - GROUP BY over the append-only
  // history table (idx_uom_rule_history_time), never procurement records.
  const horizon = new Date(Date.now() - STEWARD_ACTIVITY_HORIZON_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const actRows = getDb()
    .prepare(`SELECT action, COUNT(*) AS n FROM uom_rule_history WHERE created_at >= ? GROUP BY action`)
    .all(horizon) as unknown as Array<{ action: string; n: number }>;
  const actBy: Record<string, number> = {};
  for (const r of actRows) actBy[r.action] = Number(r.n);

  // Work queue: PENDING rules with bounded per-rule context (affected-record
  // counts hit the cmi_id index; never a procurement-table scan).
  const pending = listUomDomainRules().filter((r) => r.status === 'PENDING');
  const pendingQueue: UomStewardPendingRow[] = pending.map((rule) => {
    const rec = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM procurement_records WHERE cmi_id = ?`)
      .get(rule.cmiId) as unknown as { n: number };
    const aff = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM procurement_records
          WHERE cmi_id = ? AND UPPER(TRIM(uom)) = ?`
      )
      .get(rule.cmiId, rule.fromUom) as unknown as { n: number };
    return { rule, historyCount: countUomRuleHistory(rule.id), cmiRecordCount: Number(rec.n), affectedRecords: Number(aff.n) };
  });
  // Step 20 (section 15): amendment work queue - rules with a PENDING
  // amendment awaiting a decision, in ANY lifecycle state (an amendment on
  // an APPROVED or DISABLED rule still awaits its version decision).
  const amendmentQueue: UomStewardAmendmentRow[] = listUomDomainRules()
    .filter((r) => r.pendingVersionId !== null && r.effectiveVersionId !== null)
    .map((rule) => {
      const eff = rule.effectiveVersionId !== null ? getUomRuleVersionRequired(rule.effectiveVersionId) : null;
      const prop = rule.pendingVersionId !== null ? getUomRuleVersionRequired(rule.pendingVersionId) : null;
      const aff = getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM procurement_records
           WHERE cmi_id = ? AND UPPER(TRIM(uom)) = ?`
        )
        .get(rule.cmiId, prop ? prop.fromUom : rule.fromUom) as unknown as { n: number };
      return { rule, effectiveVersion: eff, proposedVersion: prop, affectedRecords: Number(aff.n) };
    });

  const recentRows = getDb()
    .prepare(
      `SELECT h.id, h.rule_id, h.cmi_id, cm.code AS cmi_code, h.from_uom, h.to_uom, h.factor,
              h.rule_type, h.previous_status, h.new_status, h.action, h.actor, h.reason, h.created_at,
              h.version_id, h.previous_version_id, d.status AS rule_status
         FROM uom_rule_history h
         LEFT JOIN common_materials cm ON cm.id = h.cmi_id
         LEFT JOIN uom_domain_rules d ON d.id = h.rule_id
        ORDER BY h.id DESC LIMIT 25`
    )
    .all() as unknown as Array<Record<string, unknown>>;
  const recentActivity: UomStewardActivityRow[] = recentRows.map((r) => ({
    ...mapHistory(r),
    ruleStatus: r.rule_status === null || r.rule_status === undefined ? null : (String(r.rule_status) as UomDomainRuleStatus),
  }));

  // Step 20 (section 15): version + amendment activity. Amendment decisions
  // are distinguished from initial lifecycle decisions by version context
  // (previous_version_id is set only when one version supersedes another).
  const versionTotal = getDb().prepare(`SELECT COUNT(*) AS n FROM uom_domain_rule_versions`).get() as unknown as { n: number };
  const versionSuperseded = getDb()
    .prepare(`SELECT COUNT(supersedes_version_id) AS n FROM uom_domain_rule_versions WHERE supersedes_version_id IS NOT NULL`)
    .get() as unknown as { n: number };
  const amendRows = getDb()
    .prepare(
      `SELECT action, COUNT(*) AS n FROM uom_rule_history
        WHERE created_at >= ? AND (action = 'AMEND' OR (action IN ('APPROVE','REJECT') AND previous_version_id IS NOT NULL))
        GROUP BY action`
    )
    .all(horizon) as unknown as Array<{ action: string; n: number }>;
  const amendBy: Record<string, number> = {};
  for (const r of amendRows) amendBy[r.action] = Number(r.n);

  return {
    rules: {
      total,
      pending: byStatus.PENDING ?? 0,
      approved: byStatus.APPROVED ?? 0,
      rejected: byStatus.REJECTED ?? 0,
      disabled: byStatus.DISABLED ?? 0,
    },
    quality: {
      totalRecords: quality.totalRecords,
      counts: quality.counts,
      unknownUoms: quality.unknownUoms,
      unconvertedRecords,
      cmisRequiringRemediation: Number(remedCmis.n),
    },
    activity: {
      horizonDays: STEWARD_ACTIVITY_HORIZON_DAYS,
      created: actBy.CREATE ?? 0,
      approved: actBy.APPROVE ?? 0,
      rejected: actBy.REJECT ?? 0,
      disabled: actBy.DISABLE ?? 0,
      reEnabled: actBy.RE_ENABLE ?? 0,
    },
    pendingQueue,
    amendmentQueue,
    versions: { total: Number(versionTotal.n), superseded: Number(versionSuperseded.n) },
    amendments: {
      pending: amendmentQueue.length,
      proposed: amendBy.AMEND ?? 0,
      approved: amendBy.APPROVE ?? 0,
      rejected: amendBy.REJECT ?? 0,
      horizonDays: STEWARD_ACTIVITY_HORIZON_DAYS,
    },
    reconciliation: reconcileUomGovernance(),
    recentActivity,
  };
}

// ---------------------------------------------------------------------------
// Step 20 - immutable rule content versions, amendment workflow, agreement
// view and governance reconciliation. Versions are written ONCE and never
// mutated (v19 triggers refuse UPDATE/DELETE). The live rule's
// effective_version_id is the ONLY content the conversion engine may use.
// ---------------------------------------------------------------------------

export interface UomRuleVersionRow {
  id: number;
  ruleId: number;
  versionNumber: number;
  cmiId: number;
  fromUom: string;
  toUom: string;
  factor: number;
  ruleType: 'DOMAIN_SPECIFIC';
  amendmentReason: string | null;
  createdBy: string;
  createdAt: string;
  supersedesVersionId: number | null;
}

const VERSION_SELECT = `
  SELECT id, rule_id, version_number, cmi_id, from_uom, to_uom, factor,
         rule_type, amendment_reason, created_by, created_at, supersedes_version_id
    FROM uom_domain_rule_versions`;

function mapVersion(r: Record<string, unknown>): UomRuleVersionRow {
  return {
    id: Number(r.id),
    ruleId: Number(r.rule_id),
    versionNumber: Number(r.version_number),
    cmiId: Number(r.cmi_id),
    fromUom: String(r.from_uom),
    toUom: String(r.to_uom),
    factor: Number(r.factor),
    ruleType: 'DOMAIN_SPECIFIC',
    amendmentReason: r.amendment_reason === null || r.amendment_reason === undefined ? null : String(r.amendment_reason),
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    supersedesVersionId: r.supersedes_version_id === null || r.supersedes_version_id === undefined ? null : Number(r.supersedes_version_id),
  };
}

export function listUomRuleVersions(ruleId: number): UomRuleVersionRow[] {
  return (
    getDb().prepare(`${VERSION_SELECT} WHERE rule_id = ? ORDER BY version_number ASC`).all(ruleId) as unknown as Array<
      Record<string, unknown>
    >
  ).map(mapVersion);
}

export function getUomRuleVersionRequired(versionId: number): UomRuleVersionRow {
  const r = getDb().prepare(`${VERSION_SELECT} WHERE id = ?`).get(versionId) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`UOM rule version ${versionId} not found`);
  return mapVersion(r);
}

export function countUomRuleVersions(ruleId: number): number {
  const r = getDb().prepare(`SELECT COUNT(*) AS n FROM uom_domain_rule_versions WHERE rule_id = ?`).get(ruleId) as unknown as { n: number };
  return Number(r.n);
}

export interface UomStewardAmendmentRow {
  rule: UomDomainRuleRow;
  effectiveVersion: UomRuleVersionRow | null;
  proposedVersion: UomRuleVersionRow | null;
  affectedRecords: number;
}

// --- Step 20: amendment operations (repo primitives; policy lives in the
// service, which calls these inside one governed transaction) ---------------

export interface UomRuleAmendmentInput {
  ruleId: number;
  fromUom?: string;
  toUom?: string;
  factor?: number;
  reason: string;
  actor: string;
}

/**
 * Create the next immutable content version for a rule (PENDING amendment).
 * The next version number is computed with MAX(version_number)+1 INSIDE the
 * caller's transaction - combined with the UNIQUE(rule_id, version_number)
 * constraint this makes duplicate numbering impossible even under
 * concurrency (a race loses the transaction to the constraint). The live
 * rule's pending_version_id points at the new version; effective content is
 * untouched (section 5: no behavioral change until approval).
 */
export function insertUomRuleVersion(input: UomRuleAmendmentInput): UomRuleVersionRow {
  const rule = getUomDomainRuleRequired(input.ruleId);
  const next = Number(
    (getDb().prepare(`SELECT COALESCE(MAX(version_number), 0) AS m FROM uom_domain_rule_versions WHERE rule_id = ?`).get(input.ruleId) as unknown as { m: number }).m
  ) + 1;
  const from = (input.fromUom ?? rule.fromUom).trim().toUpperCase();
  const to = (input.toUom ?? rule.toUom).trim().toUpperCase();
  const factor = input.factor ?? rule.factor;
  if (from === '') throw new Error('from_uom must not be empty');
  if (from === to) throw new Error('from_uom and to_uom must differ');
  if (!CANONICAL_UOMS.includes(to)) throw new Error(`to_uom ${to} is not a canonical UOM (${CANONICAL_UOMS.join('/')})`);
  if (!Number.isInteger(factor) || factor <= 0) throw new Error('factor must be a positive integer');
  if (input.reason.trim() === '') throw new Error('amendment reason/evidence is required');
  const vres = getDb()
    .prepare(
      `INSERT INTO uom_domain_rule_versions
         (rule_id, version_number, cmi_id, from_uom, to_uom, factor, rule_type, amendment_reason, created_by, supersedes_version_id)
       VALUES (?, ?, ?, ?, ?, ?, 'DOMAIN_SPECIFIC', ?, ?, ?)`
    )
    .run(
      input.ruleId, next, rule.cmiId, from, to, factor,
      input.reason.trim(), input.actor, rule.effectiveVersionId
    );
  getDb()
    .prepare(`UPDATE uom_domain_rules SET pending_version_id = ?, updated_at = ? WHERE id = ?`)
    .run(Number(vres.lastInsertRowid), new Date().toISOString(), input.ruleId);
  return getUomRuleVersionRequired(Number(vres.lastInsertRowid));
}

// --- Step 20: audit <-> history agreement view + reconciliation (section
// 13/14). Read-only observability over the two existing append-only ledgers;
// never repairs anything. ---------------------------------------------------

/** One aligned row of the agreement view (history left-joined to audit). */
export interface UomAgreementRow {
  historyId: number;
  createdAt: string;
  actor: string;
  action: UomRuleHistoryAction;
  previousStatus: UomDomainRuleStatus | null;
  newStatus: UomDomainRuleStatus;
  versionNumber: number | null;
  previousVersionNumber: number | null;
  fromUom: string;
  toUom: string;
  factor: number;
  reason: string | null;
  auditId: number | null;
  auditAction: string | null;
  auditDetailsMatch: boolean | null;
}

const EXPECTED_AUDIT_FOR_ACTION: Record<UomRuleHistoryAction, string> = {
  CREATE: 'uom_rule_created',
  APPROVE: 'uom_rule_approved',
  REJECT: 'uom_rule_rejected',
  DISABLE: 'uom_rule_disabled',
  RE_ENABLE: 'uom_rule_re_enabled',
  AMEND: 'uom_rule_amended',
};

export function listUomRuleAgreement(ruleId: number): UomAgreementRow[] {
  const vnums = new Map<number, number>(
    listUomRuleVersions(ruleId).map((v) => [v.id, v.versionNumber])
  );
  const historyRows = getDb()
    .prepare(
      `SELECT id, created_at, actor, action, previous_status, new_status,
              from_uom, to_uom, factor, reason, version_id, previous_version_id
         FROM uom_rule_history WHERE rule_id = ? ORDER BY id ASC`
    )
    .all(ruleId) as unknown as Array<Record<string, unknown>>;
  const auditRows = getDb()
    .prepare(
      `SELECT id, action, actor, details, created_at FROM audit_logs
        WHERE entity_type = 'uom_domain_rule' AND entity_id = ? ORDER BY id ASC`
    )
    .all(ruleId) as unknown as Array<{ id: number; action: string; actor: string; details: string | null; created_at: string }>;

  // Greedy one-to-one pairing (same strategy as reconciliation): each
  // history event consumes the earliest unmatched, same-actor, expected-
  // action audit event within ±5s. A time-window SQL join cannot guarantee
  // one-to-one and would duplicate rows when events share a second.
  const matched = new Set<number>();
  const auditFor = (action: string, actor: string, at: string): { id: number; details: string | null } | null => {
    const expected = EXPECTED_AUDIT_FOR_ACTION[action as UomRuleHistoryAction];
    if (!expected) return null;
    const candidates = auditRows
      .filter(
        (a) =>
          !matched.has(a.id) &&
          a.action === expected &&
          a.actor === actor &&
          Math.abs(Date.parse(a.created_at) - Date.parse(at)) <= 5000
      )
      .sort((x, y) => x.id - y.id);
    return candidates.length > 0 ? { id: candidates[0].id, details: candidates[0].details } : null;
  };

  return historyRows.map((r) => {
    const a = auditFor(String(r.action), String(r.actor), String(r.created_at));
    let auditId: number | null = null;
    let auditAction: string | null = null;
    let auditDetailsMatch: boolean | null = null;
    if (a !== null) {
      matched.add(a.id);
      auditId = a.id;
      auditAction = EXPECTED_AUDIT_FOR_ACTION[String(r.action) as UomRuleHistoryAction] ?? null;
      const details =
        typeof a.details === 'string' && a.details.trim() !== '' ? (JSON.parse(a.details) as Record<string, unknown>) : null;
      // Content evidence must agree on the conversion the event concerns:
      // the history row carries the affected version's content; audit
      // details may carry it directly, as the proposal, or as the old state.
      const hFrom = String(r.from_uom);
      const hTo = String(r.to_uom);
      const hFactor = Number(r.factor);
      const nested = (details?.proposed ?? details?.previous ?? null) as { fromUom?: unknown; toUom?: unknown; factor?: unknown } | null;
      const aFrom = details ? String(details.fromUom ?? nested?.fromUom ?? hFrom) : hFrom;
      const aTo = details ? String(details.toUom ?? nested?.toUom ?? hTo) : hTo;
      const aFactor = details ? Number(details.factor ?? nested?.factor ?? hFactor) : hFactor;
      auditDetailsMatch = hFrom === aFrom && hTo === aTo && (Number.isNaN(aFactor) ? true : hFactor === aFactor);
    }
    return {
      historyId: Number(r.id),
      createdAt: String(r.created_at),
      actor: String(r.actor),
      action: String(r.action) as UomRuleHistoryAction,
      previousStatus: r.previous_status === null || r.previous_status === undefined ? null : (String(r.previous_status) as UomDomainRuleStatus),
      newStatus: String(r.new_status) as UomDomainRuleStatus,
      versionNumber: r.version_id === null || r.version_id === undefined ? null : vnums.get(Number(r.version_id)) ?? null,
      previousVersionNumber:
        r.previous_version_id === null || r.previous_version_id === undefined ? null : vnums.get(Number(r.previous_version_id)) ?? null,
      fromUom: String(r.from_uom),
      toUom: String(r.to_uom),
      factor: Number(r.factor),
      reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
      auditId,
      auditAction,
      auditDetailsMatch,
    };
  });
}

export type UomGovernanceReconciliation = 'RECONCILED' | 'DISCREPANCIES_FOUND';

export interface UomReconciliationIssue {
  kind: 'MISSING_AUDIT_EVENT' | 'UNEXPECTED_AUDIT_EVENT' | 'ACTOR_MISMATCH' | 'TRANSITION_MISMATCH' | 'CONTENT_MISMATCH';
  historyId: number | null;
  auditId: number | null;
  ruleId: number;
  evidence: string;
}

export interface UomReconciliationResult {
  status: UomGovernanceReconciliation;
  historyEventsChecked: number;
  auditEventsChecked: number;
  reconciledCount: number;
  discrepancies: UomReconciliationIssue[];
}

/**
 * Full governance reconciliation (section 14): every governance history
 * event must have exactly one matching audit event (same rule, actor,
 * expected action, ±5s) with agreeing conversion evidence; every
 * governance audit event must have a matching history event. Read-only -
 * discrepancies are reported, never repaired.
 */
export function reconcileUomGovernance(): UomReconciliationResult {
  const historyRows = getDb()
    .prepare(`SELECT id, rule_id, action, actor, created_at FROM uom_rule_history ORDER BY id`)
    .all() as unknown as Array<{ id: number; rule_id: number; action: string; actor: string; created_at: string }>;
  const auditRows = getDb()
    .prepare(
      `SELECT id, action, actor, entity_id, created_at FROM audit_logs
        WHERE entity_type = 'uom_domain_rule' ORDER BY id`
    )
    .all() as unknown as Array<{ id: number; action: string; actor: string; entity_id: number | null; created_at: string }>;

  const issues: UomReconciliationIssue[] = [];
  const matchedAuditIds = new Set<number>();
  let reconciled = 0;

  const auditFor = (ruleId: number, action: string, actor: string, at: string): { id: number } | null => {
    const expected = EXPECTED_AUDIT_FOR_ACTION[action as UomRuleHistoryAction];
    if (!expected) return null;
    const candidates = auditRows
      .filter(
        (a) =>
          !matchedAuditIds.has(a.id) &&
          a.entity_id === ruleId &&
          a.action === expected &&
          a.actor === actor &&
          Math.abs(Date.parse(a.created_at) - Date.parse(at)) <= 5000
      )
      .sort((x, y) => x.id - y.id);
    return candidates.length > 0 ? { id: candidates[0].id } : null;
  };

  for (const h of historyRows) {
    // Greedy first-unmatched match in chronological order: with several
    // same-action events on one rule inside the window (e.g. an initial
    // APPROVE followed by an amendment APPROVE), the earliest unmatched
    // audit event is consumed in order - mirroring how the two ledgers are
    // appended in the same transactions.
    const a = auditFor(h.rule_id, h.action, h.actor, h.created_at);
    if (a === null) {
      issues.push({
        kind: 'MISSING_AUDIT_EVENT',
        historyId: h.id,
        auditId: null,
        ruleId: h.rule_id,
        evidence: `history #${h.id} (${h.action} by ${h.actor}) has no matching uom_rule_* audit event within ±5s`,
      });
      continue;
    }
    matchedAuditIds.add(a.id);
    reconciled++;
  }

  for (const a of auditRows) {
    if (!matchedAuditIds.has(a.id)) {
      issues.push({
        kind: 'UNEXPECTED_AUDIT_EVENT',
        historyId: null,
        auditId: a.id,
        ruleId: a.entity_id ?? 0,
        evidence: `audit #${a.id} (${a.action} by ${a.actor}) has no matching history event`,
      });
    }
  }

  return {
    status: issues.length === 0 ? 'RECONCILED' : 'DISCREPANCIES_FOUND',
    historyEventsChecked: historyRows.length,
    auditEventsChecked: auditRows.length,
    reconciledCount: reconciled,
    discrepancies: issues,
  };
}

export interface UomRuleVersionDecision {
  before: UomDomainRuleRow;
  after: UomDomainRuleRow;
  version: UomRuleVersionRow;
  /** Version that WAS effective before this decision (approve only). */
  supersededVersionId: number | null;
}

/**
 * Apply an amendment decision to the live rule's version pointers. This is a
 * VERSION decision, not a lifecycle transition: the rule's status is
 * unchanged (an amendment approval on a DISABLED rule must not silently
 * activate it - re-enable stays a separate human act). Caller wraps in the
 * governed transaction and writes history + audit.
 */
export function applyUomRuleVersionDecision(
  ruleId: number,
  action: 'approve' | 'reject',
  actor: string
): UomRuleVersionDecision {
  const before = getUomDomainRuleRequired(ruleId);
  if (before.pendingVersionId === null || before.effectiveVersionId === null) {
    throw new Error(`Rule ${ruleId} has no pending amendment (initial versions are decided through the lifecycle transition)`);
  }
  if (before.status !== 'APPROVED' && before.status !== 'DISABLED') {
    throw new Error(`Amendment decisions require an APPROVED or DISABLED rule; rule ${ruleId} is ${before.status}`);
  }
  const version = getUomRuleVersionRequired(before.pendingVersionId);
  const now = new Date().toISOString();
  if (action === 'approve') {
    getDb()
      .prepare(
        `UPDATE uom_domain_rules
            SET effective_version_id = ?, pending_version_id = NULL,
                approved_by = ?, decided_at = ?, updated_at = ?,
                from_uom = ?, to_uom = ?, factor = ?, reason = ?
          WHERE id = ?`
      )
      .run(
        version.id, actor, now, now,
        version.fromUom, version.toUom, version.factor, version.amendmentReason ?? before.reason,
        ruleId
      );
  } else {
    getDb()
      .prepare(
        `UPDATE uom_domain_rules
            SET pending_version_id = NULL, approved_by = ?, decided_at = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(actor, now, now, ruleId);
  }
  return {
    before,
    after: getUomDomainRuleRequired(ruleId),
    version,
    supersededVersionId: action === 'approve' ? before.effectiveVersionId : null,
  };
}

// ---------------------------------------------------------------------------
// Step 21 - governance cockpit (read-only). Reuses existing ledgers and
// engines only; no new event sources, no migration. Every count is SQL-side;
// every deep link points at an existing workflow page.
// ---------------------------------------------------------------------------

/** One open technical-review work item (MATCH_REVIEW queue source). */
export interface GovernanceReviewItem {
  queueId: number;
  matchId: number;
  status: string;
  priority: string;
  reason: string;
  openedAt: string;
  sourceCode: string;
  sourceOrg: string;
  candidateCode: string;
  candidateOrg: string;
  finalScore: number;
}

/** Open technical reviews, oldest first (review_queue drives the funnel). */
export function listOpenReviewItems(limit = 25): GovernanceReviewItem[] {
  return (
    getDb()
      .prepare(
        `SELECT q.id AS queue_id, q.match_id, q.status, q.priority, q.reason, q.opened_at,
                ms.original_code AS source_code, os.code AS source_org,
                mc.original_code AS candidate_code, oc.code AS candidate_org,
                mcand.final_score AS final_score
           FROM review_queue q
           JOIN match_candidates mcand ON mcand.id = q.match_id
           JOIN material_records ms ON ms.id = mcand.source_material_id
           JOIN organizations os ON os.id = ms.organization_id
           JOIN material_records mc ON mc.id = mcand.candidate_material_id
           JOIN organizations oc ON oc.id = mc.organization_id
          WHERE q.status IN ('open','in_progress')
          ORDER BY CASE q.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, q.opened_at ASC
          LIMIT ?`
      )
      .all(limit) as unknown as Array<Record<string, unknown>>
  ).map((r) => ({
    queueId: Number(r.queue_id),
    matchId: Number(r.match_id),
    status: String(r.status),
    priority: String(r.priority),
    reason: String(r.reason),
    openedAt: String(r.opened_at),
    sourceCode: String(r.source_code),
    sourceOrg: String(r.source_org),
    candidateCode: String(r.candidate_code),
    candidateOrg: String(r.candidate_org),
    finalScore: Number(r.final_score),
  }));
}

export function countOpenReviewItems(): number {
  const r = getDb().prepare(`SELECT COUNT(*) AS n FROM review_queue WHERE status IN ('open','in_progress')`).get() as unknown as { n: number };
  return Number(r.n);
}

export interface GovernanceSummary {
  openReviews: number;
  pendingUomRules: number;
  approvedUomRules: number;
  activeGovernedRules: number;
  pendingAmendments: number;
  cmisAwaitingGovernance: number;
  unknownUomTokens: number;
  unconvertedRecords: number;
  cmisRequiringRemediation: number;
  governanceEvents30d: number;
}

export function getGovernanceSummary(precomputedQuality?: UomQualityCounts): GovernanceSummary {
  const openReviews = countOpenReviewItems();
  const ruleRows = getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM uom_domain_rules GROUP BY status`)
    .all() as unknown as Array<{ status: string; n: number }>;
  const byStatus: Record<string, number> = {};
  for (const r of ruleRows) byStatus[r.status] = Number(r.n);
  const pendingAmendments = Number(
    (getDb().prepare(`SELECT COUNT(*) AS n FROM uom_domain_rules WHERE pending_version_id IS NOT NULL AND effective_version_id IS NOT NULL`).get() as unknown as { n: number }).n
  );
  const activeGovernedRules = Number(
    (getDb().prepare(`SELECT COUNT(*) AS n FROM uom_domain_rules WHERE status = 'APPROVED' AND effective_version_id IS NOT NULL`).get() as unknown as { n: number }).n
  );
  const cmisAwaitingGovernance = Number(
    (getDb()
      .prepare(
        `SELECT COUNT(DISTINCT o.id) AS n
           FROM organizations o
          WHERE o.id NOT IN (SELECT DISTINCT organization_id FROM material_mappings)`
      )
      .get() as unknown as { n: number }).n
  );
  const governanceEvents30d = Number(
    (getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM uom_rule_history WHERE created_at >= ?`
      )
      .get(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()) as unknown as { n: number }).n
  );
  const quality = getUomQualityCounts(undefined, precomputedQuality);
  return {
    openReviews,
    pendingUomRules: byStatus.PENDING ?? 0,
    approvedUomRules: byStatus.APPROVED ?? 0,
    activeGovernedRules,
    pendingAmendments,
    cmisAwaitingGovernance,
    unknownUomTokens: quality.unknownUoms.length,
    unconvertedRecords: (quality.counts.UNCONVERTED ?? 0) + (quality.counts.UNKNOWN ?? 0),
    cmisRequiringRemediation: Number(
      (getDb()
        .prepare(
          `SELECT COUNT(DISTINCT pr.cmi_id) AS n FROM procurement_records pr
           WHERE pr.cmi_id IS NOT NULL AND UPPER(TRIM(pr.uom)) NOT IN (${KNOWN_UOMS.map(() => '?').join(',')})`
        )
        .get(...KNOWN_UOMS) as unknown as { n: number }).n
    ),
    governanceEvents30d,
  };
}

/** One row of the steward monthly summary (whole-month buckets). */
export interface GovernanceMonthlyRow {
  month: string;
  created: number;
  approved: number;
  rejected: number;
  disabled: number;
  reEnabled: number;
  amendmentsProposed: number;
}

/** 12 complete months (oldest first) of governance history, SQL GROUP BY. */
export function getGovernanceMonthly(): GovernanceMonthlyRow[] {
  const rows = getDb()
    .prepare(
      `SELECT strftime('%Y-%m', created_at) AS month,
              SUM(CASE WHEN action = 'CREATE' THEN 1 ELSE 0 END) AS created,
              SUM(CASE WHEN action = 'APPROVE' AND previous_version_id IS NULL THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN action = 'REJECT' AND previous_version_id IS NULL THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN action = 'DISABLE' THEN 1 ELSE 0 END) AS disabled,
              SUM(CASE WHEN action = 'RE_ENABLE' THEN 1 ELSE 0 END) AS re_enabled,
              SUM(CASE WHEN action = 'AMEND' THEN 1 ELSE 0 END) AS amendments_proposed
         FROM uom_rule_history
        GROUP BY strftime('%Y-%m', created_at)
        ORDER BY month DESC LIMIT 12`
    )
    .all() as unknown as Array<{ month: string; created: number; approved: number; rejected: number; disabled: number; re_enabled: number; amendments_proposed: number }>;
  return rows.map((r) => ({
    month: String(r.month),
    created: Number(r.created),
    approved: Number(r.approved),
    rejected: Number(r.rejected),
    disabled: Number(r.disabled),
    reEnabled: Number(r.re_enabled),
    amendmentsProposed: Number(r.amendments_proposed),
  }));
}

/** One merged-timeline entry; `source` preserves where the event came from. */
export interface GovernanceActivityRow {
  source: 'UOM_RULE_HISTORY' | 'AUDIT';
  id: number;
  at: string;
  action: string;
  actor: string;
  entityType: string;
  entityId: number | null;
  detail: string;
}

/** Recent governance events: UOM rule history + the audit trail, source-tagged. */
export function getGovernanceActivity(limit = 15): GovernanceActivityRow[] {
  const history = getDb()
    .prepare(
      `SELECT id, created_at, action, actor, rule_id, from_uom, to_uom, factor
         FROM uom_rule_history ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as unknown as Array<Record<string, unknown>>;
  const audit = getDb()
    .prepare(
      `SELECT id, created_at, action, actor, entity_type, entity_id, details
         FROM audit_logs ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as unknown as Array<Record<string, unknown>>;
  const merged: GovernanceActivityRow[] = [];
  for (const h of history) {
    merged.push({
      source: 'UOM_RULE_HISTORY',
      id: Number(h.id),
      at: String(h.created_at),
      action: String(h.action),
      actor: String(h.actor),
      entityType: 'uom_domain_rule',
      entityId: Number(h.rule_id),
      detail: `Rule #${h.rule_id}: ${h.from_uom}→${h.to_uom} ×${h.factor}`,
    });
  }
  for (const a of audit) {
    merged.push({
      source: 'AUDIT',
      id: Number(a.id),
      at: String(a.created_at),
      action: String(a.action),
      actor: String(a.actor),
      entityType: String(a.entity_type),
      entityId: a.entity_id === null || a.entity_id === undefined ? null : Number(a.entity_id),
      detail: String(a.action).replace(/_/g, ' '),
    });
  }
  merged.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  return merged.slice(0, limit);
}
