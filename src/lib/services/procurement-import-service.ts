/**
 * Step 13 — procurement ingestion on the EXISTING import architecture.
 *
 * Reuses (not re-implements): the Import Center upload/analyze lifecycle
 * (data_imports + row_report + upload-store), the Step-5 job model
 * (import_runs / import_run_chunks / single-active guard / heartbeats /
 * stale recovery — see import-job-service), and the Step-2 batch writers.
 * This module adds ONLY the procurement-specific seam:
 *
 *   - column aliases + suggestions (ProcField targets),
 *   - the procurement row validator (pure, resolution memoized),
 *   - organization-aware material resolution (org + code — never code alone:
 *     different CPSEs reuse codes), supplier resolution, CMI consumption,
 *   - analyze for CSV (bounded streaming, two passes over the buffer) and
 *     XLSX (batch parse, workbook memory covered by the XLSX safety limit),
 *   - the batched chunk executor (resolution in ≤3 bounded queries per
 *     chunk, then one multi-row INSERT — no per-row round trips),
 *   - deterministic duplicate policy: the SAME purchase line (org, PO,
 *     date, material, supplier, quantity, uom) is skipped on re-import,
 *     while legitimate repeated purchases import normally. The database
 *     unique index uq_procurement_row_signature is the final authority.
 *
 * Governance (frozen): ingestion CONSUMES the identity layer — it never
 * creates CMIs, materials, or suppliers, and never repairs mappings. An
 * explicit CMI reference that contradicts material_mappings rejects the row.
 */
import { getDb, withTransaction } from '../db/client';
import { batchInsertReturning, maxBatchRows } from '../db/batch-writer';
import { recordAudit } from '../db/repositories/audit-repository';
import { errors } from '../errors';
import type { ProcurementStatus } from '../types/domain';
import { PROCUREMENT_STATUSES } from '../types/domain';
import { CsvRecordIterator, splitCsvLine, parseImportFile } from './file-parse-service';
import { storeUpload } from './upload-store';
import { createImport, getImportRequired } from '../db/repositories/import-repository';
import type { DataImportRow } from '../db/repositories/import-repository';
import { getOrganizationRequired } from '../db/repositories/organization-queries';
import { createImportJob } from './import-job-service';

/* ----------------------------- column targets ----------------------------- */

export const PROC_FIELDS = [
  { key: 'organization', label: 'CPSE / organization', required: true },
  { key: 'materialCode', label: 'Material code', required: true },
  { key: 'supplier', label: 'Supplier', required: true },
  { key: 'purchaseDate', label: 'Purchase date', required: true },
  { key: 'quantity', label: 'Quantity', required: true },
  { key: 'uom', label: 'UOM', required: true },
  { key: 'poReference', label: 'PO reference', required: false },
  { key: 'deliveryDate', label: 'Delivery date', required: false },
  { key: 'unitPrice', label: 'Unit price', required: false },
  { key: 'currency', label: 'Currency', required: false },
  { key: 'status', label: 'Procurement status', required: false },
  { key: 'plantLocation', label: 'Plant / location', required: false },
  { key: 'cmiCode', label: 'CMI code (explicit)', required: false },
] as const;

export type ProcFieldKey = (typeof PROC_FIELDS)[number]['key'];
export type ProcColumnMapping = Record<ProcFieldKey, string | null>;

const REQUIRED_PROC_FIELDS: ProcFieldKey[] = ['organization', 'materialCode', 'supplier', 'purchaseDate', 'quantity', 'uom'];

/** Common procurement column aliases → canonical target. First match wins. */
const PROC_ALIASES: ReadonlyArray<readonly [RegExp, ProcFieldKey]> = [
  [/^(cpse_?name|cpse|organi[sz]ation_?name|organi[sz]ation|org_?name|org|entity|company)$/i, 'organization'],
  [/^(material_?code|material_?id|item_?code|item_?id|item|material)$/i, 'materialCode'],
  [/^(supplier_?code|supplier_?id|supplier|vendor_?code|vendor_?id|vendor)$/i, 'supplier'],
  [/^(purchase_?date|po_?date|order_?date|purchasing_?date)$/i, 'purchaseDate'],
  [/^(deli[vv]ery_?date|received_?date|grn_?date)$/i, 'deliveryDate'],
  [/^(ordered_?qty|ordered_?quantity|purchase_?qty|purchase_?quantity|qty|quantity)$/i, 'quantity'],
  [/^(uom|unit_?of_?measure|unit)$/i, 'uom'],
  [/^(po_?(no|number|ref|reference)?|purchase_?order(_?(no|number|ref|reference))?|order_?reference)$/i, 'poReference'],
  [/^(unit_?price|rate|price|cost)$/i, 'unitPrice'],
  [/^(currency_?code|currency)$/i, 'currency'],
  [/^(procurement_?status|po_?status|status)$/i, 'status'],
  [/^(plant_?location|plant|location|site|store)$/i, 'plantLocation'],
  [/^(cmi_?code|cmi_?id|cmi|common_?material_?code)$/i, 'cmiCode'],
];

export interface ProcMappingSuggestion {
  header: string;
  target: ProcFieldKey | null;
  confident: boolean;
}

export function suggestProcurementMapping(headers: string[]): {
  mapping: ProcColumnMapping;
  suggestions: ProcMappingSuggestion[];
} {
  const mapping: ProcColumnMapping = {
    organization: null, materialCode: null, supplier: null, purchaseDate: null,
    quantity: null, uom: null, poReference: null, deliveryDate: null, unitPrice: null,
    currency: null, status: null, plantLocation: null, cmiCode: null,
  };
  const suggestions: ProcMappingSuggestion[] = [];
  const taken = new Set<ProcFieldKey>();
  const norm = (h: string) => h.trim().toLowerCase().replace(/[\s\-.]+/g, '_');
  // Two rounds: exact alias matches first (confident), then contains-matches.
  for (const round of [0, 1] as const) {
    for (const header of headers) {
      const key = norm(header);
      const currentTarget = (Object.keys(mapping) as ProcFieldKey[]).find((k) => mapping[k] === header);
      if (currentTarget) continue;
      let hit: ProcFieldKey | null = null;
      if (round === 0) {
        for (const [re, target] of PROC_ALIASES) {
          if (re.test(key) && !taken.has(target)) { hit = target; break; }
        }
      } else {
        for (const [re, target] of PROC_ALIASES) {
          const m = key.match(re);
          if (m && !taken.has(target)) { hit = target; break; }
        }
        if (!hit) {
          for (const [re, target] of PROC_ALIASES) {
            const src = re.source.replace(/^\^/, '').replace(/\$$/, '');
            if (src.length >= 4 && key.includes(src) && !taken.has(target)) { hit = target; break; }
          }
        }
      }
      if (hit) {
        mapping[hit] = header;
        taken.add(hit);
        suggestions.push({ header, target: hit, confident: round === 0 });
      } else {
        suggestions.push({ header, target: null, confident: false });
      }
    }
  }
  return { mapping, suggestions };
}

export function procMappingIsUsable(mapping: ProcColumnMapping): boolean {
  return REQUIRED_PROC_FIELDS.every((k) => typeof mapping[k] === 'string' && mapping[k]!.trim().length > 0);
}

/* ------------------------------- row model -------------------------------- */

/** A normalized, ready-to-persist procurement row (validation output). */
export interface ProcurementInput {
  rowNumber: number;
  orgCode: string;
  materialCode: string;
  cmiCode: string | null;
  supplierCode: string;
  purchaseOrderReference: string;
  purchaseDate: string;        // ISO yyyy-mm-dd
  deliveryDate: string | null;
  quantity: string;            // exact decimal text, > 0
  uom: string;                 // source UOM preserved verbatim
  unitPrice: string | null;
  currency: string | null;
  plantLocation: string | null;
  status: ProcurementStatus;
  /** Raw-source identity of the purchase line (dedup within/between runs). */
  rowSignature: string;
}

export interface ProcRowProblem {
  rule: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
}

export interface ProcRowReport {
  rowNumber: number;
  values: Record<string, string>;
  severity: 'VALID' | 'WARNING' | 'ERROR';
  empty: boolean;
  problems: ProcRowProblem[];
  /** Present when the row is executable (VALID/WARNING). */
  input?: ProcurementInput;
}

export interface ProcSummary {
  totalRows: number;
  valid: number;
  warnings: number;
  errors: number;
  emptyRows: number;
    unknownOrganization: number;
  unknownMaterial: number;
  unknownSupplier: number;
  invalidDate: number;
  invalidQuantity: number;
  invalidPrice: number;
  invalidStatus: number;
  unknownCmi: number;
  cmiMismatch: number;
  duplicateInFile: number;
  missingPoReference: number;
  unknownUom: number;
}

export interface ProcResolution {
  /** upper(org code) → id */
  orgs: Map<string, number>;
  /** `${orgId}\u0000${MATERIAL_CODE_UPPER}` → material id */
  materials: Map<string, number>;
  /** upper(supplier_code) or lower(supplier_name) → id */
  suppliers: Map<string, number>;
  /** upper(cmi code) → { id, active } */
  cmisByCode: Map<string, { id: number; active: boolean }>;
  /** material id → its mapping's CMI (material_mappings.material_id UNIQUE) */
  cmiByMaterial: Map<number, { id: number; active: boolean }>;
  /** CMI id → code/activity (auto-carried links must display the real code) */
  cmisById: Map<number, { code: string; active: boolean }>;
}

/* --------------------------- resolution (batched) -------------------------- */

/**
 * Resolve a bounded set of keys against the master data in a handful of
 * queries (never per row). Read-only; used by analyze and by the chunk
 * executor (the executor runs it inside its own transaction).
 */
export function resolveProcurementMasters(
  orgCodes: Iterable<string>,
  materialPairs: Iterable<{ orgCode: string; code: string }>,
  supplierKeys: Iterable<string>,
  cmiCodes: Iterable<string>,
): ProcResolution {
  const db = getDb();
  const orgs = new Map<string, number>();
  const orgCodeList = [...new Set([...orgCodes].map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (orgCodeList.length > 0) {
    const ph = orgCodeList.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT id, code FROM organizations WHERE UPPER(code) IN (${ph})`)
      .all(...(orgCodeList as never[])) as Array<{ id: number; code: string }>;
    for (const r of rows) orgs.set(String(r.code).trim().toUpperCase(), Number(r.id));
  }

  const materials = new Map<string, number>();
  const wantMaterials = new Set<string>();
  const materialOrgs = new Set<string>();
  for (const p of materialPairs) {
    const code = String(p.code ?? '').trim().toUpperCase();
    const org = String(p.orgCode ?? '').trim().toUpperCase();
    if (code && org) { wantMaterials.add(code); materialOrgs.add(org); }
  }
  if (wantMaterials.size > 0 && orgs.size > 0) {
    const codes = [...wantMaterials];
    const orgIds = [...new Set([...materialOrgs].map((o) => orgs.get(o)).filter((v): v is number => v !== undefined))];
    // Bounded slices keep the IN-lists proportional to master data.
    for (let i = 0; i < codes.length; i += 500) {
      const slice = codes.slice(i, i + 500);
      const ph = slice.map(() => '?').join(', ');
      const orgPh = orgIds.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT m.id, m.original_code, m.organization_id
             FROM material_records m
            WHERE m.is_active = 1 AND m.organization_id IN (${orgPh}) AND UPPER(m.original_code) IN (${ph})`,
        )
        .all(...(orgIds as never[]), ...(slice as never[])) as Array<{ id: number; original_code: string; organization_id: number }>;
      const idToOrgCode = new Map<number, string>();
      for (const c of orgCodeList) {
        const oid = orgs.get(c);
        if (oid !== undefined) idToOrgCode.set(oid, c);
      }
      for (const r of rows) {
        const orgCode = idToOrgCode.get(Number(r.organization_id));
        if (orgCode) materials.set(`${Number(r.organization_id)}\u0000${String(r.original_code).trim().toUpperCase()}`, Number(r.id));
      }
    }
  }

  const suppliers = new Map<string, number>();
  const supplierList = [...new Set([...supplierKeys].map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (supplierList.length > 0) {
    const upper = supplierList.map((s) => s.toUpperCase());
    const ph = supplierList.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT id, supplier_code, supplier_name FROM suppliers WHERE UPPER(supplier_code) IN (${ph})`)
      .all(...(upper as never[])) as Array<{ id: number; supplier_code: string; supplier_name: string }>;
    for (const r of rows) suppliers.set(String(r.supplier_code).trim().toUpperCase(), Number(r.id));
    // Name fallback: deterministic exact case-insensitive name match.
    const missing = supplierList.filter((s) => !suppliers.has(s.toUpperCase()));
    if (missing.length > 0) {
      const ph2 = missing.map(() => '?').join(', ');
      const wanted = new Set(missing.map((m) => m.toLowerCase()));
      const rows2 = db
        .prepare(`SELECT id, supplier_name FROM suppliers WHERE LOWER(supplier_name) IN (${ph2})`)
        .all(...(missing.map((m) => m.toLowerCase()) as never[])) as Array<{ id: number; supplier_name: string }>;
      for (const r of rows2) {
        if (wanted.has(String(r.supplier_name).trim().toLowerCase())) {
          suppliers.set(String(r.supplier_name).trim().toLowerCase(), Number(r.id));
        }
      }
    }
  }

  const cmisByCode = new Map<string, { id: number; active: boolean }>();
  const cmiList = [...new Set([...cmiCodes].map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean))];
  if (cmiList.length > 0) {
    const ph = cmiList.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT id, code, is_active FROM common_materials WHERE UPPER(code) IN (${ph})`)
      .all(...(cmiList as never[])) as Array<{ id: number; code: string; is_active: number | boolean }>;
    for (const r of rows) cmisByCode.set(String(r.code).trim().toUpperCase(), { id: Number(r.id), active: Number(r.is_active) === 1 });
  }

  const cmiByMaterial = new Map<number, { id: number; active: boolean }>();
  const cmisById = new Map<number, { code: string; active: boolean }>();
  const materialIds = new Set<number>();
  for (const v of materials.values()) materialIds.add(v);
  if (materialIds.size > 0) {
    const ids = [...materialIds];
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      const ph = slice.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT mm.material_id, mm.cmi_id, cm.is_active
             FROM material_mappings mm JOIN common_materials cm ON cm.id = mm.cmi_id
            WHERE mm.material_id IN (${ph})`,
        )
        .all(...(slice as never[])) as Array<{ material_id: number; cmi_id: number; is_active: number | boolean }>;
      for (const r of rows) {
        cmiByMaterial.set(Number(r.material_id), { id: Number(r.cmi_id), active: Number(r.is_active) === 1 });
      }
    }
    // One bounded lookup so auto-carried links can show their real code.
    const mappedIds = [...new Set([...cmiByMaterial.values()].map((v) => v.id))];
    for (let i = 0; i < mappedIds.length; i += 500) {
      const slice = mappedIds.slice(i, i + 500);
      const ph = slice.map(() => '?').join(', ');
      const rows = db
        .prepare(`SELECT id, code, is_active FROM common_materials WHERE id IN (${ph})`)
        .all(...(slice as never[])) as Array<{ id: number; code: string; is_active: number | boolean }>;
      for (const r of rows) {
        cmisById.set(Number(r.id), { code: String(r.code).trim().toUpperCase(), active: Number(r.is_active) === 1 });
      }
    }
  }

  return { orgs, materials, suppliers, cmisByCode, cmiByMaterial, cmisById };
}

/* ------------------------------ field helpers ------------------------------ */

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Parse a date cell to ISO yyyy-mm-dd. Accepts ISO (yyyy-mm-dd, with optional
 * time part) and dd/mm/yyyy + dd-mm-yyyy (common CPSE spreadsheet format).
 * Returns null for unparseable input — callers decide severity.
 */
export function parseProcurementDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** Validity check for a REAL calendar date (rejects 2026-02-31 etc.). */
export function isRealCalendarDate(iso: string): boolean {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= days;
}

function normalizeQty(raw: string): string | null {
  const s = raw.trim().replace(/,/g, '');
  if (!DECIMAL_RE.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Canonical text: strip trailing zeros after a fraction (12.50 → 12.5,
  // 12.00 → 12) so the signature and stored value are stable.
  const [int, frac] = s.split('.');
  const f = (frac ?? '').replace(/0+$/, '');
  return f ? `${int}.${f}` : int;
}

function normalizePrice(raw: string): string | null {
  const s = raw.trim().replace(/,/g, '').replace(/^[₹$]/, '');
  if (!s) return null;
  if (!DECIMAL_RE.test(s)) return null;
  const [int, frac] = s.split('.');
  const f = ((frac ?? '') + '00').slice(0, 2).replace(/0+$/, '');
  return f ? `${int}.${f}` : int;
}

/** Upper-case code, length-capped (SQL column widths are capped too). */
function normCode(raw: string, maxLen: number): string {
  return raw.trim().toUpperCase().slice(0, maxLen);
}

function emptySummary(): ProcSummary {
  return {
    totalRows: 0, valid: 0, warnings: 0, errors: 0, emptyRows: 0,
    unknownOrganization: 0, unknownMaterial: 0, unknownSupplier: 0,
    invalidDate: 0, invalidQuantity: 0, invalidPrice: 0, invalidStatus: 0,
    unknownCmi: 0, cmiMismatch: 0, duplicateInFile: 0,
    missingPoReference: 0, unknownUom: 0,
  };
}

/* ------------------------------- validator --------------------------------- */

const UOM_MAX = 12;

/**
 * Procurement row validator. Field-level syntax checks are pure; existence
 * checks use a memoized ProcResolution that callers refresh in bounded
 * batches (analyze refreshes periodically; the chunk executor refreshes per
 * chunk — see executeProcurementChunk).
 */
export class ProcurementRowValidator {
  readonly summary: ProcSummary = emptySummary();
  private readonly resolution: ProcResolution;
  private readonly mapping: ProcColumnMapping;
  private readonly seenSignatures = new Map<string, number>(); // first rowNumber
  private readonly supplierCache = new Map<string, number | null>();

  constructor(mapping: ProcColumnMapping, resolution: ProcResolution) {
    this.mapping = mapping;
    this.resolution = resolution;
  }

  /** Add rows resolved in a later batch (chunk execution). */
  extendResolution(resolution: ProcResolution): void {
    (this.resolution as { orgs: Map<string, number> }).orgs = resolution.orgs;
    (this.resolution as { materials: Map<string, number> }).materials = resolution.materials;
    (this.resolution as { suppliers: Map<string, number> }).suppliers = resolution.suppliers;
    (this.resolution as { cmisByCode: Map<string, { id: number; active: boolean }> }).cmisByCode = resolution.cmisByCode;
    (this.resolution as { cmiByMaterial: Map<number, { id: number; active: boolean }> }).cmiByMaterial = resolution.cmiByMaterial;
    (this.resolution as { cmisById: Map<number, { code: string; active: boolean }> }).cmisById = resolution.cmisById;
  }

  next(row: { rowNumber: number; values: Record<string, string> }): ProcRowReport {
    const m = this.mapping;
    const sum = this.summary;
    sum.totalRows++;
    const values = row.values;
    if (Object.values(values).every((v) => (v ?? '').trim() === '')) {
      sum.emptyRows++;
      return { rowNumber: row.rowNumber, values, severity: 'VALID', empty: true, problems: [] };
    }
    const problems: ProcRowProblem[] = [];
    const get = (k: ProcFieldKey): string => (m[k] ? (values[m[k] as string] ?? '').trim() : '');

    // --- organization (required) ---
    const orgCode = normCode(get('organization'), 12);
    const orgId = orgCode ? this.resolution.orgs.get(orgCode) : undefined;
    if (!orgCode) {
      problems.push({ rule: 'unknown_organization', severity: 'ERROR', message: 'CPSE / organization is missing.' });
      sum.unknownOrganization++;
    } else if (orgId === undefined) {
      problems.push({ rule: 'unknown_organization', severity: 'ERROR', message: `Unknown CPSE organization "${orgCode}".` });
      sum.unknownOrganization++;
    }

    // --- material code (required) ---
    const materialCode = normCode(get('materialCode'), 60);
    const materialId = orgId !== undefined && materialCode ? this.resolution.materials.get(`${orgId}\u0000${materialCode}`) : undefined;
    if (!materialCode) {
      problems.push({ rule: 'unknown_material', severity: 'ERROR', message: 'Material code is missing.' });
      sum.unknownMaterial++;
    } else if (orgId !== undefined && materialId === undefined) {
      problems.push({
        rule: 'unknown_material',
        severity: 'ERROR',
        message: `Material "${materialCode}" does not exist for CPSE ${orgCode}. Materials are never created by procurement import.`,
      });
      sum.unknownMaterial++;
    }

    // --- supplier (required) ---
    const supplierRaw = get('supplier');
    const supplierKey = supplierRaw ? (this.resolution.suppliers.has(supplierRaw.toUpperCase()) ? supplierRaw.toUpperCase() : supplierRaw.toLowerCase()) : '';
    const supplierId = supplierKey ? this.supplierCache.get(supplierKey) ?? this.resolution.suppliers.get(supplierKey) : undefined;
    if (!supplierRaw) {
      problems.push({ rule: 'unknown_supplier', severity: 'ERROR', message: 'Supplier is missing.' });
      sum.unknownSupplier++;
    } else if (supplierId === undefined || supplierId === null) {
      problems.push({
        rule: 'unknown_supplier',
        severity: 'ERROR',
        message: `Supplier "${supplierRaw}" is not in the supplier master. Suppliers are never created by procurement import.`,
      });
      sum.unknownSupplier++;
    }

    // --- purchase date (required) ---
    const dateRaw = get('purchaseDate');
    const purchaseDate = parseProcurementDate(dateRaw);
    if (!dateRaw) {
      problems.push({ rule: 'invalid_date', severity: 'ERROR', message: 'Purchase date is missing.' });
      sum.invalidDate++;
    } else if (!purchaseDate || !isRealCalendarDate(purchaseDate)) {
      problems.push({ rule: 'invalid_date', severity: 'ERROR', message: `Purchase date "${dateRaw}" is not a valid date (use YYYY-MM-DD or DD/MM/YYYY).` });
      sum.invalidDate++;
    }

    // --- quantity (required) ---
    const qtyRaw = get('quantity');
    const quantity = qtyRaw ? normalizeQty(qtyRaw) : null;
    if (!qtyRaw) {
      problems.push({ rule: 'invalid_quantity', severity: 'ERROR', message: 'Quantity is missing.' });
      sum.invalidQuantity++;
    } else if (quantity === null) {
      problems.push({ rule: 'invalid_quantity', severity: 'ERROR', message: `Quantity "${qtyRaw}" must be a positive number (max 2 fraction digits).` });
      sum.invalidQuantity++;
    }

    // --- uom (required) ---
    const uom = get('uom');
    if (!uom) {
      problems.push({ rule: 'invalid_uom', severity: 'ERROR', message: 'UOM is missing.' });
      sum.unknownUom++;
    } else if (uom.length > UOM_MAX) {
      problems.push({ rule: 'invalid_uom', severity: 'ERROR', message: `UOM "${uom}" exceeds ${UOM_MAX} characters.` });
      sum.unknownUom++;
    }

    // --- optional fields ---
    const poReference = get('poReference');
    if (!poReference) {
      problems.push({ rule: 'missing_po_reference', severity: 'WARNING', message: 'PO reference is empty.' });
      sum.missingPoReference++;
    }
    let deliveryDate: string | null = null;
    const delRaw = get('deliveryDate');
    if (delRaw) {
      deliveryDate = parseProcurementDate(delRaw);
      if (!deliveryDate || !isRealCalendarDate(deliveryDate)) {
        problems.push({ rule: 'invalid_date', severity: 'ERROR', message: `Delivery date "${delRaw}" is not a valid date.` });
        sum.invalidDate++;
        deliveryDate = null;
      }
    }
    let unitPrice: string | null = null;
    let currency: string | null = null;
    const priceRaw = get('unitPrice');
    const currencyRaw = get('currency');
    if (priceRaw || currencyRaw) {
      if (priceRaw) {
        unitPrice = normalizePrice(priceRaw);
        if (unitPrice === null) {
          problems.push({ rule: 'invalid_price', severity: 'ERROR', message: `Unit price "${priceRaw}" must be a positive decimal (max 2 fraction digits).` });
          sum.invalidPrice++;
        }
      } else {
        problems.push({ rule: 'invalid_price', severity: 'ERROR', message: 'Unit price supplied without currency — the pair is required.' });
        sum.invalidPrice++;
      }
      if (currencyRaw) {
        currency = currencyRaw.toUpperCase().slice(0, 8);
      } else {
        problems.push({ rule: 'invalid_currency', severity: 'ERROR', message: 'Currency supplied without unit price — the pair is required.' });
        sum.invalidPrice++;
      }
    }
    let status: ProcurementStatus = 'ORDERED';
    const statusRaw = get('status');
    if (statusRaw) {
      const up = statusRaw.toUpperCase().replace(/[\s\-]+/g, '_');
      if ((PROCUREMENT_STATUSES as readonly string[]).includes(up)) status = up as ProcurementStatus;
      else {
        problems.push({ rule: 'invalid_status', severity: 'ERROR', message: `Status "${statusRaw}" must be one of: ${PROCUREMENT_STATUSES.join(', ')}.` });
        sum.invalidStatus++;
      }
    }
    const plantLocation = get('plantLocation') || null;

    // --- CMI consumption (never creation, never repair) ---
    let cmiId: number | null = null;
    let cmiCode: string | null = null;
    const cmiRaw = normCode(get('cmiCode'), 40);
    if (cmiRaw) {
      const cmi = this.resolution.cmisByCode.get(cmiRaw);
      if (!cmi) {
        problems.push({ rule: 'unknown_cmi', severity: 'ERROR', message: `Common material identity "${cmiRaw}" does not exist.` });
        sum.unknownCmi++;
      } else {
        cmiCode = cmiRaw;
        cmiId = cmi.id;
        if (!cmi.active) {
          problems.push({ rule: 'cmi_mismatch', severity: 'ERROR', message: `Common material identity ${cmiRaw} is inactive.` });
          sum.cmiMismatch++;
        }
        if (materialId !== undefined) {
          const mapped = this.resolution.cmiByMaterial.get(materialId);
          if (mapped && mapped.id !== cmi.id) {
            problems.push({ rule: 'cmi_mismatch', severity: 'ERROR', message: `Material ${materialCode} belongs to CMI id ${mapped.id}, not ${cmiRaw}. Mappings are never changed by import.` });
            sum.cmiMismatch++;
          } else if (!mapped) {
            problems.push({ rule: 'cmi_mismatch', severity: 'ERROR', message: `Material ${materialCode} is not mapped to ${cmiRaw}. Import never repairs mappings.` });
            sum.cmiMismatch++;
          }
        }
      }
    } else if (materialId !== undefined) {
      // No explicit CMI: consume the CURRENT mapping state (Step 13 §8).
      // The record mirrors the mapping. An INACTIVE mapping cannot be
      // represented (Step-12 semantics: records carry active CMI links
      // only), so keep cmi_id NULL and surface a WARNING - the next
      // matching run re-evaluates; import never repairs mappings.
      const mapped = this.resolution.cmiByMaterial.get(materialId);
      if (mapped) {
        const info = this.resolution.cmisById.get(mapped.id);
        if (mapped.active) {
          cmiCode = info?.code ?? null;
          cmiId = mapped.id;
        } else {
          // resolved.cmiCode stays NULL so the preview mirrors exactly what
          // will be stored; the warning names the mapping it mirrors.
          problems.push({
            rule: 'cmi_mismatch',
            severity: 'WARNING',
            message: `Material ${materialCode} maps to CMI ${info?.code ?? String(mapped.id)}, which is inactive; the record will not carry the CMI link.`,
          });
          sum.cmiMismatch++;
        }
      }
    }

    const hasError = problems.some((p) => p.severity === 'ERROR');
    const severity: ProcRowReport['severity'] = hasError ? 'ERROR' : problems.length > 0 ? 'WARNING' : 'VALID';
    if (severity === 'VALID') sum.valid++;
    else if (severity === 'WARNING') sum.warnings++;
    else sum.errors++;

    if (hasError) {
      return { rowNumber: row.rowNumber, values, severity, empty: false, problems };
    }
    const input: ProcurementInput = {
      rowNumber: row.rowNumber,
      orgCode,
      materialCode,
      cmiCode,
      supplierCode: supplierRaw,
      purchaseOrderReference: poReference,
      purchaseDate: purchaseDate ?? '',
      deliveryDate,
      quantity: quantity ?? '',
      uom,
      unitPrice,
      currency,
      plantLocation,
      status,
      // JSON framing: deterministic AND NUL-free (node:sqlite truncates bound
      // strings at embedded NUL bytes, which would corrupt a backslash-u0000 key).
      rowSignature: JSON.stringify([orgCode, materialCode, poReference.toUpperCase(), purchaseDate ?? '', quantity ?? '', uom.toUpperCase(), cmiCode ?? '']),
      // JSON framing: deterministic AND NUL-free (node:sqlite truncates bound
      // strings at embedded NUL bytes, which would corrupt a NUL-joined key).
    };
    const first = this.seenSignatures.get(input.rowSignature);
    if (first !== undefined) {
      // In-file duplicate: same purchase line twice in ONE upload. The first
      // occurrence executes; repeats are downgraded to WARNING so the user
      // sees them, but they do NOT block the import (partial-row policy).
      problems.push({ rule: 'duplicate_in_file', severity: 'WARNING', message: `Identical purchase line already seen in row ${first} of this file — the repeat is skipped at import.` });
      sum.valid--;
      sum.duplicateInFile++;
      sum.warnings++;
      return { rowNumber: row.rowNumber, values, severity: 'WARNING', empty: false, problems, input };
    }
    this.seenSignatures.set(input.rowSignature, row.rowNumber);
    return { rowNumber: row.rowNumber, values, severity, empty: false, problems, input };
  }
}

/* --------------------------- analyze (bounded) ----------------------------- */

export const PROC_PREVIEW_MAX_ROWS = 100;
const PROC_MAX_DIAGNOSTICS = 500;
/** In-memory resolution batches during CSV streaming (bounded). */
const PROC_RESOLVE_BATCH = 5000;

export interface ProcurementAnalyzeOutput {
  importId: number;
  headers: string[];
  mapping: ProcColumnMapping;
  mappingUsable: boolean;
  suggestions: ProcMappingSuggestion[];
  parseWarnings: string[];
  summary: ProcSummary;
  previewRows: Array<{
    rowNumber: number;
    values: Record<string, string>;
    severity: 'VALID' | 'WARNING' | 'ERROR';
    problems: Array<{ rule: string; severity: string; message: string }>;
    resolved?: { orgCode: string; materialCode: string; cmiCode: string | null; supplierCode: string };
  }>;
  validationErrors: Array<{ rowNumber: number; rule: string; message: string }>;
  canExecute: boolean;
}

function persistProcurementReport(imp: DataImportRow, report: unknown, summary: ProcSummary, mapping: ProcColumnMapping): void {
  getDb()
    .prepare(
      `UPDATE data_imports
          SET workflow_status = 'validating', valid_rows = ?, error_rows = ?, warning_rows = ?,
              column_mapping = ?, row_report = ?
        WHERE id = ?`,
    )
    .run(
      summary.valid,
      summary.errors,
      summary.warnings,
      JSON.stringify(mapping),
      JSON.stringify(report),
      imp.id,
    );
}

function boundedOutput(
  importId: number,
  headers: string[],
  mapping: ProcColumnMapping,
  mappingUsable: boolean,
  suggestions: ProcMappingSuggestion[],
  parseWarnings: string[],
  problems: ProcRowReport[],
  firstRows: ProcRowReport[],
  summary: ProcSummary,
): ProcurementAnalyzeOutput {
  const validationErrors = problems
    .flatMap((r) => r.problems.map((p) => ({ rowNumber: r.rowNumber, rule: p.rule, message: p.message })))
    .slice(0, PROC_MAX_DIAGNOSTICS);
  const previewRows = firstRows.map((r) => ({
    rowNumber: r.rowNumber,
    values: r.values,
    severity: r.severity,
    problems: r.problems.map((p) => ({ rule: p.rule, severity: p.severity, message: p.message })),
    resolved: r.input
      ? { orgCode: r.input.orgCode, materialCode: r.input.materialCode, cmiCode: r.input.cmiCode, supplierCode: r.input.supplierCode }
      : undefined,
  }));
  const executable = summary.valid + summary.warnings > 0;
  return {
    importId,
    headers,
    mapping,
    mappingUsable,
    suggestions,
    parseWarnings,
    summary,
    previewRows,
    validationErrors,
    canExecute: mappingUsable && executable,
  };
}

/**
 * Bounded procurement analyze — CSV streaming path. Two bounded passes over
 * the byte buffer: (1) parse + map + validate with O(1) row memory, staging
 * the executable rows' ProcurementInput into the row_report; (2) the stored
 * report IS the execution source (no re-parse drift). Resolution happens in
 * bounded batches so a chunk of unknown codes never grows unbounded.
 */
export function analyzeProcurementCsv(
  buffer: Buffer,
  fileName: string,
  fileType: 'csv' | 'xlsx',
  organizationId: number,
  mappingOverride?: Record<string, string | null> | null,
): ProcurementAnalyzeOutput {
  getOrganizationRequired(organizationId);

  let headers: string[] = [];
  let rows: Array<{ rowNumber: number; values: Record<string, string> }>;
  const parseWarnings: string[] = [];
  if (fileType === 'csv') {
    const it = new CsvRecordIterator(buffer);
    const headerRecord = it.next();
    if (headerRecord == null || headerRecord.trim() === '') {
      throw errors.badRequest('The file contains no data rows (only a header or nothing at all).');
    }
    headers = splitCsvLine(headerRecord);
    rows = [];
    let rowNumber = 2; // header occupies line 1
    for (;;) {
      const record = it.next();
      if (record == null) break;
      if (record.trim() === '') continue;
      const cells = splitCsvLine(record);
      const values: Record<string, string> = {};
      headers.forEach((h, i) => { values[h] = cells[i] ?? ''; });
      rows.push({ rowNumber, values });
      rowNumber++;
    }
  } else {
    const ab = buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
      ? (buffer.buffer as ArrayBuffer)
      : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const parsed = parseImportFile(fileName, ab);
    headers = parsed.headers;
    parseWarnings.push(...parsed.errors.map((e) => `row ${e.row}: ${e.message}`));
    rows = parsed.rows.map((r) => ({ rowNumber: r.rowNumber, values: r.values }));
  }
  if (rows.length === 0) {
    throw errors.badRequest('The file contains no data rows (only a header or nothing at all).');
  }

  const suggested = suggestProcurementMapping(headers);
  const mapping: ProcColumnMapping = { ...suggested.mapping, ...(mappingOverride ?? {}) } as ProcColumnMapping;
  const mappingUsable = procMappingIsUsable(mapping);

  const summary = emptySummary();
  const problems: ProcRowReport[] = [];
  const previewRows: ProcRowReport[] = [];
  const staged: ProcRowReport[] = [];
  const validator = new ProcurementRowValidator(mapping, resolveProcurementMasters([], [], [], []));

  let batch: Array<{ rowNumber: number; values: Record<string, string> }> = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    const orgCodes = new Set<string>();
    const pairs: Array<{ orgCode: string; code: string }> = [];
    const supplierKeys = new Set<string>();
    const cmiCodes = new Set<string>();
    for (const r of batch) {
      const get = (k: ProcFieldKey): string => (mapping[k] ? (r.values[mapping[k] as string] ?? '').trim() : '');
      const org = get('organization').toUpperCase().slice(0, 12);
      if (org) orgCodes.add(org);
      const mc = get('materialCode').toUpperCase().slice(0, 60);
      if (org && mc) pairs.push({ orgCode: org, code: mc });
      const sup = get('supplier');
      if (sup) supplierKeys.add(sup);
      const cmi = get('cmiCode').toUpperCase().slice(0, 40);
      if (cmi) cmiCodes.add(cmi);
    }
    validator.extendResolution(resolveProcurementMasters(orgCodes, pairs, supplierKeys, cmiCodes));
    for (const r of batch) {
      const report = validator.next(r);
      if (report.problems.length > 0) problems.push(report);
      if (previewRows.length < PROC_PREVIEW_MAX_ROWS) previewRows.push(report);
      if (!report.empty && report.input) staged.push(report);
    }
    batch = [];
  };

  for (const r of rows) {
    batch.push(r);
    if (batch.length >= PROC_RESOLVE_BATCH) flush();
  }
  flush();
  Object.assign(summary, validator.summary);

  if (summary.totalRows === 0) {
    throw errors.badRequest('The file contains no data rows (only a header or nothing at all).');
  }

  const imp = createImport({ organizationId, fileName, fileType, totalRows: summary.totalRows });
  let uploadStored = false;
  try {
    storeUpload(imp.id, fileName, buffer);
    uploadStored = true;
  } catch {
    uploadStored = false;
  }
  persistProcurementReport(
    imp,
    {
      kind: 'procurement',
      headers,
      mapping,
      suggestions: suggested.suggestions,
      uploadStored,
      summary,
      // Execution source: the staged VALID/WARNING inputs (bounded to the
      // file's own size on disk — the same bound import_rows staging uses).
      staged,
      problems: problems.slice(0, PROC_MAX_DIAGNOSTICS),
    },
    summary,
    mapping,
  );

  return boundedOutput(imp.id, headers, mapping, mappingUsable, suggested.suggestions, parseWarnings, problems, previewRows, summary);
}

/* --------------------- server-side paginated preview ----------------------- */

/**
 * Server-side paginated preview over a procurement import's staged rows.
 * Only one page (plus counts) ever crosses the service boundary — the
 * browser never receives the full dataset.
 */
export function getProcurementPreviewPage(
  importId: number,
  opts: { page?: number; pageSize?: number; severity?: 'ALL' | 'VALID' | 'WARNING' | 'ERROR'; q?: string } = {},
): {
  importId: number;
  page: number;
  pageSize: number;
  filteredTotal: number;
  rows: ProcRowReport[];
} {
  const imp = getImportRequired(importId);
  const report = JSON.parse(imp.row_report ?? '{}') as { kind?: string; staged?: ProcRowReport[] };
  if (report.kind !== 'procurement' || !Array.isArray(report.staged)) {
    throw errors.conflict('This import is not a procurement import (or has not been analyzed).');
  }
  let rows = report.staged.filter((r) => !r.empty);
  if (opts.severity && opts.severity !== 'ALL') rows = rows.filter((r) => r.severity === opts.severity);
  const q = (opts.q ?? '').trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (r) => String(r.rowNumber).includes(q) || Object.values(r.values).some((v) => v.toLowerCase().includes(q)),
    );
  }
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 50), 100); // hard ceiling
  const page = Math.max(1, opts.page ?? 1);
  const start = (page - 1) * pageSize;
  return { importId, page, pageSize, filteredTotal: rows.length, rows: rows.slice(start, start + pageSize) };
}

/* ------------------------------ job creation ------------------------------- */

/**
 * Create a procurement import job. Same durable job model as material
 * imports: import_runs (kind='procurement'), single-active guard, chunk
 * plan. The claim/execute mechanics live in import-job-service and are
 * SHARED — this module only stages procurement rows.
 */
export function createProcurementImportJob(dataImportId: number, actor: string): string {
  const imp = getImportRequired(dataImportId);
  const report = JSON.parse(imp.row_report ?? '{}') as { kind?: string };
  if (report.kind !== 'procurement') {
    throw errors.badRequest('Import is not a procurement import.');
  }
  // Reuses createImportJob (same import_runs row, single-active guard, audit)
  // with kind='procurement'; the executor dispatch reads the same column.
  // The procurement_import_started audit is emitted by createImportJob so
  // BOTH the direct path and the HTTP job route produce it with the actor.
  return createImportJob(dataImportId, actor, 'procurement').jobId;
}

/* ------------------------------ chunk executor ----------------------------- */

/**
 * Execute ONE bounded chunk of a procurement import inside its own
 * transaction: stage rows → batch-resolve → validate → batch-insert valid
 * rows. Failure rolls back only this chunk (job-level handling in
 * import-job-service marks the job FAILED and retryable).
 *
 * Statement profile per batch (vs ~3 round trips per row naive):
 *   resolution (≤4 bounded queries per chunk) + 1 multi-row INSERT per
 *   IMPORT_BATCH_ROWS slice + 1 counters UPDATE per chunk.
 */
/**
 * Claim-time snapshot cache (Step 13 §26): the executor previously re-parsed
 * the full row_report JSON per chunk — O(chunks × reportSize) — which made
 * 100k-row imports quadratic (~2.2 s of pure JSON parsing per 100 chunks).
 * Chunks run sequentially in the single in-process runner, so parsing once
 * at the first chunk (i.e. snapshotting the report as of claim time, exactly
 * like the material path's staging snapshot) preserves semantics while
 * restoring linear scaling. Keyed by (importId, report length); a failed
 * parse is never cached, so corruption still fails the chunk (test 13).
 */
let stagedReportCache: {
  importId: number;
  reportLength: number;
  parsed: { staged?: ProcRowReport[]; mapping?: ProcColumnMapping };
} | null = null;

function loadStagedReport(importId: number): { staged?: ProcRowReport[]; mapping?: ProcColumnMapping } {
  // Column-scoped re-fetch ONLY on a cache miss — `SELECT *` would drag the
  // multi-MB row_report blob across the wire (well: out of the row store)
  // for every chunk, which dominated the 100k benchmark.
  if (stagedReportCache && stagedReportCache.importId === importId) {
    return stagedReportCache.parsed;
  }
  const row = getDb()
    .prepare(`SELECT row_report FROM data_imports WHERE id = ?`)
    .get(importId) as { row_report: string | null } | undefined;
  if (!row) throw errors.notFound('Import');
  const parsed = JSON.parse(row.row_report ?? '{}') as { staged?: ProcRowReport[]; mapping?: ProcColumnMapping };
  stagedReportCache = { importId, reportLength: (row.row_report ?? '').length, parsed };
  return parsed;
}

export function executeProcurementChunk(jobId: string, chunkIndex: number): void {
  withTransaction(() => {
    const db = getDb();
    const job = db.prepare(`SELECT id, data_import_id, chunk_size, status FROM import_runs WHERE id = ?`).get(jobId) as
      | { id: string; data_import_id: number; chunk_size: number; status: string }
      | undefined;
    if (!job) throw errors.notFound('Import job');
    db.prepare(`UPDATE import_run_chunks SET status = 'RUNNING' WHERE run_id = ? AND chunk_index = ?`).run(jobId, chunkIndex);

    const report = loadStagedReport(job.data_import_id);
    const staged = (report.staged ?? []).filter((r) => !r.empty && r.input);
    const chunkSize = job.chunk_size;
    const slice = staged.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize);

    // 1) Batch resolution for this chunk's distinct keys (≤4 queries).
    const orgCodes = new Set<string>();
    const pairs: Array<{ orgCode: string; code: string }> = [];
    const supplierKeys = new Set<string>();
    const cmiCodes = new Set<string>();
    for (const r of slice) {
      const input = r.input!;
      if (input.orgCode) orgCodes.add(input.orgCode);
      if (input.orgCode && input.materialCode) pairs.push({ orgCode: input.orgCode, code: input.materialCode });
      if (input.supplierCode) supplierKeys.add(input.supplierCode);
      if (input.cmiCode) cmiCodes.add(input.cmiCode);
    }
    const resolution = resolveProcurementMasters(orgCodes, pairs, supplierKeys, cmiCodes);

    // 2) Re-validate inside the transaction with fresh resolution — protects
    // against master-data changes between analyze and execute (e.g. a material
    // deleted or a mapping deactivated). Invalid rows are skipped and counted.
    const validator = new ProcurementRowValidator(report.mapping!, resolution);
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const rows: unknown[][] = [];
    const seen = new Set<string>();
    for (const r of slice) {
      const input = r.input!;
      const report2 = validator.next({ rowNumber: input.rowNumber, values: r.values });
      const errors2 = report2.problems.filter((p) => p.severity === 'ERROR');
      if (errors2.length > 0 || !report2.input) {
        failed++;
        continue; // explainable skip; chunk continues (partial-row policy)
      }
      const sig = report2.input.rowSignature;
      if (seen.has(sig)) { skipped++; continue; } // intra-chunk duplicate
      seen.add(sig);
      rows.push([
        input.orgCode,
        input.materialCode,
        input.cmiCode,
        input.supplierCode,
        input.purchaseOrderReference,
        input.purchaseDate,
        input.deliveryDate,
        input.quantity,
        input.uom,
        input.unitPrice,
        input.currency,
        input.plantLocation,
        input.status,
        sig,
      ]);
    }

    // 3) Resolve to ids and INSERT in bounded multi-row statements. Rejected
    // rows (FK/signature) fail the whole chunk via the job failure path —
    // the DB remains the final authority.
    const inserts: unknown[][] = [];
    for (const r of rows) {
      const [orgCode, materialCode, cmiCode, supplierCode, poRef, pDate, dDate, qty, uom, price, currency, plant, status, sig] = r as string[];
      const orgId = resolution.orgs.get(orgCode.toUpperCase());
      const materialId = orgId !== undefined ? resolution.materials.get(`${orgId}\u0000${materialCode.toUpperCase()}`) : undefined;
      const supplierKey = resolution.suppliers.has(supplierCode.toUpperCase()) ? supplierCode.toUpperCase() : supplierCode.toLowerCase();
      const supplierId = resolution.suppliers.get(supplierKey);
      if (orgId === undefined || materialId === undefined || supplierId === undefined) {
        // Resolution says valid but ids missing — defensive: count as skipped
        // (should not happen; validator already gated these).
        skipped++;
        continue;
      }
      let cmiId: number | null = null;
      if (cmiCode) {
        const cmi = resolution.cmisByCode.get(cmiCode.toUpperCase());
        if (cmi && cmi.active) cmiId = cmi.id;
      }
      inserts.push([orgId, materialId, cmiId, supplierId, poRef || '', pDate, dDate, qty, uom, price, currency, plant, status, job.data_import_id, sig]);
    }
    // Cross-chunk + re-run idempotency (Step 13 §19): signatures already in
    // procurement_records (an earlier chunk or an earlier run) are SKIPPED
    // deterministically - the unique index stays the final authority.
    if (inserts.length > 0) {
      const existing = new Set<string>();
      const allSigs = [...new Set(inserts.map((r) => String(r[14])))];
      for (let i = 0; i < allSigs.length; i += 500) {
        const s = allSigs.slice(i, i + 500);
        const ph = s.map(() => '?').join(', ');
        const found = db
          .prepare(`SELECT row_signature FROM procurement_records WHERE row_signature IN (${ph})`)
          .all(...(s as never[])) as Array<{ row_signature: string }>;
        for (const f of found) existing.add(f.row_signature);
      }
      const fresh = inserts.filter((r) => {
        if (existing.has(String(r[14]))) { skipped++; return false; }
        return true;
      });
      inserts.length = 0;
      inserts.push(...fresh);
    }
    if (inserts.length > 0) {
      batchInsertReturning({
        insertSql: `INSERT INTO procurement_records
           (organization_id, material_id, cmi_id, supplier_id, purchase_order_reference,
            purchase_date, delivery_date, quantity, uom, unit_price, currency,
            plant_location, procurement_status, source_system, row_signature)`,
        columnCount: 15,
        rows: inserts,
        returning: 'id',
      });
      imported += inserts.length;
    }

    // 4) Commit ledger + job counters (frozen import_runs accounting shape).
    db.prepare(`UPDATE import_run_chunks SET status = 'COMMITTED' WHERE run_id = ? AND chunk_index = ?`).run(jobId, chunkIndex);
    db.prepare(
      `UPDATE import_runs
          SET processed_rows = processed_rows + ?, successful_rows = successful_rows + ?,
              failed_rows = failed_rows + ?, heartbeat_at = ?
        WHERE id = ?`,
    ).run(slice.length, imported, failed, new Date().toISOString(), jobId);
    db.prepare(
      `UPDATE data_imports
          SET successful_rows = successful_rows + ?, duplicate_rows = duplicate_rows + ?, failed_rows = failed_rows + ?
        WHERE id = ?`,
    ).run(imported, skipped, failed, job.data_import_id);

    // Procurement-specific lifecycle audit (Step 13 §20): emitted when the
    // last chunk commits. import_* audits stay on the shared material path.
    const remaining = db
      .prepare(`SELECT COUNT(*) n FROM import_run_chunks WHERE run_id = ? AND status <> 'COMMITTED'`)
      .get(jobId) as { n: number };
    if (remaining.n === 0) {
      recordAudit({
        action: 'procurement_import_completed',
        entityType: 'import_job',
        entityId: job.data_import_id,
        actor: 'system',
        details: { jobId, imported, skipped, failed },
      });
    }
  });
}
