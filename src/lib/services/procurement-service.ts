/**
 * Step 12 - procurement service layer.
 *
 * Owns the CMI-consistency validation (the identity relationship itself stays
 * authoritative in material_mappings) and audit attribution. The database
 * enforces referential integrity (FKs) and the controlled status vocabulary;
 * this layer adds the cross-table rules FKs cannot express.
 *
 * Validation contract (Step 12 section 13):
 *   1. material has an active CMI mapping and supplied cmiId matches it -> accept
 *   2. material has no CMI and cmiId is null/undefined                   -> accept
 *   3. material belongs to CMI-A but supplied cmiId = CMI-B              -> 409 reject
 *   4. cmiId references a nonexistent CMI                                -> 404 reject
 *   5. materialId references a nonexistent material                      -> 404 reject
 *   6. cmiId references an INACTIVE CMI                                  -> 409 reject
 *      (existing CMI semantics: is_active=0 disables short-circuit and
 *      registry visibility; procurement must not keep treating it as live)
 *   7. organizationId does not match the material's organization         -> 409 reject
 *      (a procurement record belongs to the CPSE that owns the material)
 * No silent repair: wrong (material, cmi) pairs are rejected, never corrected.
 */
import { withTransaction } from '../db/client';
import type { UomConversionStatus, UomRuleType, UomDomainRuleStatus } from '../types/domain';
import {
  createSupplier,
  insertProcurementRecord,
  getProcurementRecordRequired,
  getSupplierRequired,
  type ProcurementWithContext,
  type SupplierRow,
  findActiveUomRule,
  classifyUom,
  centsToDecimal,
  getCmiComparableDemand as _getCmiComparableDemand,
  type UomConversionRuleRow,
  type UomQualityCounts,
  type ComparableDemandSummary,
  listUomConversionRules,
  getUomQualityCounts,
  // Step 18: governed DOMAIN_SPECIFIC (CMI-scoped) UOM rules.
  listUomDomainRules as _listUomDomainRules,
  getUomDomainRuleRequired as _getUomDomainRuleRequired,
  insertUomDomainRule as _insertUomDomainRule,
  transitionUomDomainRule as _transitionUomDomainRule,
  resolveEffectiveUomRule as _resolveEffectiveUomRule,
  listUomDomainRulesForCmi as _listUomDomainRulesForCmi,
  getUomCountsForCmi as _getUomCountsForCmi,
  listCmiRecordsByUom as _listCmiRecordsByUom,
  getCmiComparableDemandV2 as _getCmiComparableDemandV2,
  getSupplierComparableQuantityV2 as _getSupplierComparableQuantityV2,
  getOrganizationComparableQuantityV2 as _getOrganizationComparableQuantityV2,
  type UomDomainRuleRow,
} from '../db/repositories/procurement-repository';
import { getMaterialRequired } from '../db/repositories/material-repository';
import { getCommonMaterialRequired, listMappingsForMaterial } from '../db/repositories/registry-repository';
import { recordAudit } from '../db/repositories/audit-repository';
import { errors } from '../errors';
import type { NewProcurementRecord, NewSupplier } from '../db/repositories/procurement-repository';

// Step 14 analytics re-exports (all aggregation is SQL-side; see repository).
export {
  listProcurementRecords,
  getProcurementRecord,
  listSuppliers,
  getCmiProcurementSummary,
  getCmiDemandByOrganization,
  getCmiSupplierSummary,
  listCmiProcurementOverviews,
  getOrganizationProcurementSummaries,
  getProcurementCoverage,
  type CmiDemandSummary,
  type CmiOrgDemandRow,
  type CmiSupplierRow,
  type CmiMonthlyDemandRow,
  type OrgProcurementSummaryRow,
  type CmiProcurementOverview,
  type ProcurementCoverage,
} from '../db/repositories/procurement-repository';
import { getCmiMonthlyDemandRows, type CmiMonthlyDemandRow } from '../db/repositories/procurement-repository';

/**
 * Monthly demand for one CMI with gap-filled, zero-valued months between the
 * first and last month in range (Step 14 section 11) so timelines render
 * continuously. Historical data only - no forecasting.
 */
export function getCmiMonthlyDemand(cmiId: number, from?: string, to?: string): CmiMonthlyDemandRow[] {
  const rows = getCmiMonthlyDemandRows(cmiId, from, to);
  if (rows.length === 0) return rows;
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const filled: CmiMonthlyDemandRow[] = [];
  const [startY, startM] = rows[0].month.split('-').map(Number);
  const [endY, endM] = rows[rows.length - 1].month.split('-').map(Number);
  let y = startY;
  let m = startM;
  // Guard against pathological ranges (bad input could loop long); cap at 1200 months (100 years).
  for (let i = 0; i < 1200 && (y < endY || (y === endY && m <= endM)); i++) {
    const key = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    filled.push(byMonth.get(key) ?? { month: key, recordCount: 0, quantityByUom: {}, spendByCurrency: {} });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return filled;
}

/** The CMI a material currently belongs to (active only), or null. */
export function activeCmiForMaterial(materialId: number): number | null {
  const mappings = listMappingsForMaterial(materialId) as unknown as Array<{ cmi_id: number | string; is_active?: number | boolean }>;
  if (mappings.length === 0) return null;
  // material_mappings.material_id is UNIQUE -> at most one mapping; the join
  // carries the CMI row. Read is_active defensively (SQLite 0/1, PG boolean).
  const m = mappings[0];
  const active = m.is_active === undefined ? true : Number(m.is_active) === 1;
  return active ? Number(m.cmi_id) : null;
}

export function createSupplierRecord(input: NewSupplier, actor: string): SupplierRow {
  return withTransaction(() => {
    const supplier = createSupplier(input);
    recordAudit({
      action: 'supplier_created',
      entityType: 'supplier',
      entityId: supplier.id,
      actor,
      details: { supplierCode: supplier.supplier_code, supplierName: supplier.supplier_name, region: supplier.region },
    });
    return supplier;
  });
}

export function getSupplier(id: number): SupplierRow {
  return getSupplierRequired(id);
}

/**
 * Validate + insert one procurement record. All six CMI cases plus
 * material/organization ownership are enforced here; FK violations
 * (nonexistent material/supplier) surface as 404s via the required lookups.
 */
export function createProcurementRecord(input: NewProcurementRecord, actor: string): ProcurementWithContext {
  return withTransaction(() => {
    // Case 5: nonexistent material -> 404.
    const material = getMaterialRequired(input.materialId);
    // Organization must be the material's own CPSE.
    if (input.organizationId !== material.organization_id) {
      throw errors.conflict(
        `Procurement organization ${input.organizationId} does not own material ${material.original_code} (belongs to organization ${material.organization_id})`
      );
    }
    if (input.cmiId) {
      // Case 4: nonexistent CMI -> 404; Case 6: inactive CMI -> 409.
      const cmi = getCommonMaterialRequired(input.cmiId);
      if (Number(cmi.is_active) !== 1) {
        throw errors.conflict(`Common material identity ${cmi.code} is inactive`);
      }
      // Cases 1/3: the material must actually belong to THIS CMI.
      const mapped = activeCmiForMaterial(input.materialId);
      if (mapped !== input.cmiId) {
        throw errors.conflict(
          mapped === null
            ? `Material ${material.original_code} is not mapped to any common material identity - procurement record must use cmi_id = null`
            : `Material ${material.original_code} belongs to common material identity id ${mapped}, not ${input.cmiId}`
        );
      }
    } else {
      // Explicit null CMI with a mapped material is also a mismatch: the
      // caller asked for "unharmonized" about a harmonized material. Reject
      // rather than silently downgrade (case 3 variant).
      const mapped = activeCmiForMaterial(input.materialId);
      if (mapped !== null) {
        throw errors.conflict(
          `Material ${material.original_code} is mapped to common material identity id ${mapped}; omitting cmi_id would misattribute the procurement record`
        );
      }
    }
    // Supplier must exist (FK would also catch it; explicit lookup = clean 404).
    getSupplierRequired(input.supplierId);

    const id = insertProcurementRecord(input);
    recordAudit({
      action: 'procurement_created',
      entityType: 'procurement_record',
      entityId: id,
      actor,
      details: {
        purchaseOrderReference: input.purchaseOrderReference,
        organizationId: input.organizationId,
        materialId: input.materialId,
        cmiId: input.cmiId ?? null,
        supplierId: input.supplierId,
        quantity: input.quantity,
        uom: input.uom,
        status: input.status,
      },
    });
    return getProcurementRecordRequired(id);
  });
}

// Step 19 - append-only UOM rule history + steward dashboard aggregates.
import {
  insertUomRuleHistory,
  listUomRuleHistory,
  getUomStewardOverview,
  type UomRuleHistoryRow,
  type UomRuleHistoryAction,
  type UomStewardOverview,
} from '../db/repositories/procurement-repository';

/** Chronological append-only history for one governed rule (section 6). */
export function getUomRuleHistory(ruleId: number): UomRuleHistoryRow[] {
  return listUomRuleHistory(ruleId);
}

/** Steward dashboard overview (SQL-side aggregation; read-only, audit-silent). */
export function getUomStewardDashboard(): UomStewardOverview {
  return getUomStewardOverview();
}

/** Cockpit-level summary with an optional precomputed global quality pass. */
export function getGovernanceSummary(precomputedQuality?: UomQualityCounts): GovernanceSummary {
  return _getGovernanceSummary(precomputedQuality);
}

// ---------------------------------------------------------------------------
// Step 16 - supplier intelligence (read-only, descriptive; NEVER a ranking).
//
// All metrics are SQL-side (repository) and describe recorded procurement
// activity only. No supplier scoring, ranking, recommendation, performance,
// reliability or quality inference is permitted anywhere in this layer, and
// no savings or consolidation claims are produced. Read operations must be
// audit-silent (section 26) - no recordAudit call appears here.
// Metrics denominator note (section 10): any records-share percentage uses
// ALL procurement records as the denominator and is a factual proportion.
// ---------------------------------------------------------------------------

import {
  listSupplierIntelligence,
  aggregateSupplierIntelligence,
  getSupplierIntelligenceDetail,
  getSupplierOrgActivity,
  getSupplierCmiActivity,
  getSupplierCmiOrgMatrix,
  listSupplierRecentRecords,
  type SupplierIntelligenceListRow,
  type SupplierListFilters,
  type SupplierIntelligenceDetail,
  type SupplierOrgActivityRow,
  type SupplierCmiActivityRow,
  type SupplierRecentRecordRow,
} from '../db/repositories/procurement-repository';
import { getDb } from '../db/client';

export type {
  SupplierIntelligenceListRow,
  SupplierListFilters,
  SupplierIntelligenceDetail,
  SupplierOrgActivityRow,
  SupplierCmiActivityRow,
  SupplierRecentRecordRow,
};

/**
 * Paginated supplier intelligence list. Pagination and every activity filter
 * remain server-side (sections 16/17); zero-procurement suppliers stay
 * visible with zero metrics.
 */
export function listSuppliersWithIntelligence(
  f: SupplierListFilters,
  page: number,
  pageSize: number
): { items: SupplierIntelligenceListRow[]; total: number } {
  return listSupplierIntelligence(f, page, pageSize);
}

/** Unpaginated supplier aggregation for signal computation over the (bounded) supplier master. */
export function aggregateSuppliersWithIntelligence(f: SupplierListFilters): SupplierIntelligenceListRow[] {
  return aggregateSupplierIntelligence(f);
}

/**
 * Supplier detail bundle for /procurement/suppliers/[id]: header metrics,
 * CPSE activity, CMI activity, the supplier->CMI->CPSE matrix and a bounded
 * recent-records table - all traceable back to procurement_records.
 */
export function getSupplierIntelligenceBundle(supplierId: number): {
  detail: SupplierIntelligenceDetail;
  orgActivity: SupplierOrgActivityRow[];
  cmiActivity: SupplierCmiActivityRow[];
  matrix: Array<{ cmiId: number; cmiCode: string; cells: Record<number, string> }>;
  recentRecords: SupplierRecentRecordRow[];
  orgColumns: Array<{ id: number; code: string }>;
  comparable: ComparableDemandSummary | null;
} | null {
  const detail = getSupplierIntelligenceDetail(supplierId);
  if (!detail) return null;
  const orgActivity = getSupplierOrgActivity(supplierId);
  const cmiActivity = getSupplierCmiActivity(supplierId);
  const matrix = getSupplierCmiOrgMatrix(supplierId);
  const recentRecords = listSupplierRecentRecords(supplierId, 25);
  const orgColumns = orgActivity.map((o) => ({ id: o.organizationId, code: o.orgCode }));
  // Matrix cells are keyed by org id; add CPSEs seen anywhere in the
  // supplier's activity so every column exists (em-dash where absent).
  for (const o of orgActivity) {
    if (!orgColumns.some((c) => c.id === o.organizationId)) {
      orgColumns.push({ id: o.organizationId, code: o.orgCode });
    }
  }
  const comparable = _getSupplierComparableQuantityV2(supplierId);
  return { detail, orgActivity, cmiActivity, matrix, recentRecords, orgColumns, comparable };
}

/**
 * Cross-CPSE supplier activity signal (section 9): suppliers whose recorded
 * procurement activity spans >= minCpse distinct CPSEs. An observed pattern
 * only - never "national"/"preferred"/"strategic" classification.
 */
export function getCrossCpseSuppliers(minCpse = 2): Array<SupplierIntelligenceListRow & { cmiActivity: SupplierCmiActivityRow[] }> {
  return aggregateSuppliersWithIntelligence({})
    .filter((s) => s.orgCount >= minCpse)
    .map((s) => ({ ...s, cmiActivity: getSupplierCmiActivity(s.supplierId) }));
}

/** One factual proportion (section 10): supplier records / ALL procurement records. */
export function getSupplierRecordsShare(supplierId: number): { records: number; totalRecords: number; sharePercent: number } | null {
  const detail = getSupplierIntelligenceDetail(supplierId);
  if (!detail) return null;
  const totalRow = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM procurement_records`)
    .get() as unknown as { n: number };
  const total = Number(totalRow.n);
  const share = total === 0 ? 0 : Math.round((detail.recordCount / total) * 10000) / 100;
  return { records: detail.recordCount, totalRecords: total, sharePercent: share };
}

// ---------------------------------------------------------------------------
// Step 17 - UOM harmonization service (read-only comparable-quantity layer).
// ---------------------------------------------------------------------------

/**
 * Row-level conversion with full evidence (sections 12/22/23). Exact
 * decimal arithmetic via BigInt cent-units: normalized_cents = qty_cents *
 * factor. No guessed conversions, no description inference - only an active
 * ALIAS/SCALE registry rule converts; everything else keeps the original
 * representation with a deterministic status.
 */
export function normalizeQuantity(
  quantity: string,
  uom: string | null | undefined,
  cmiId?: number | null
): {
  status: UomConversionStatus;
  originalQuantity: string;
  originalUom: string | null;
  normalizedQuantity: string;
  normalizedUom: string | null;
  rule: { id: number; fromUom: string; toUom: string; factor: number; ruleType: UomRuleType; source: string } | null;
} {
  if (!/^-?\d+(\.\d{1,2})?$/.test(quantity) || /^\.\d*$/.test(quantity)) {
    return {
      status: 'INVALID', originalQuantity: quantity,
      originalUom: uom === undefined ? null : (uom ?? null),
      normalizedQuantity: quantity, normalizedUom: uom === undefined ? null : (uom ?? null), rule: null,
    };
  }
  if (uom === null || uom === undefined || uom.trim() === '') {
    return { status: 'INVALID', originalQuantity: quantity, originalUom: null, normalizedQuantity: quantity, normalizedUom: null, rule: null };
  }
  const u = uom.trim().toUpperCase();
  // Step 18 precedence: APPROVED CMI-scoped domain rule first, then the
  // Step 17 system registry (ALIAS/SCALE), else no rule. resolveEffectiveUom
  // Rule already excludes REJECTED/DISABLED/PENDING domain rules and fail
  // closes on ambiguous live rules.
  const rule = _resolveEffectiveUomRule(u, cmiId ?? undefined);
  const dot = quantity.indexOf('.');
  const qtyCents = dot === -1 ? BigInt(quantity + '00') : BigInt(quantity.replace('.', '') + '0'.repeat(2 - (quantity.length - dot - 1)));
  if (!rule) {
    const status = (classifyUom(u) === 'UNKNOWN' ? 'UNCONVERTED' : classifyUom(u)) as UomConversionStatus;
    return { status, originalQuantity: quantity, originalUom: u, normalizedQuantity: quantity, normalizedUom: u, rule: null };
  }
  // normalized_cents = qty_cents * factor (exact: integer factor).
  const normalizedCents = qtyCents * BigInt(rule.factor);
  return {
    status: rule.ruleType === 'ALIAS' ? 'ALIAS_NORMALIZED' : 'SCALED',
    originalQuantity: quantity,
    originalUom: u,
    normalizedQuantity: centsToDecimal(normalizedCents),
    normalizedUom: rule.toUom,
    rule: { id: rule.id, fromUom: rule.fromUom, toUom: rule.toUom, factor: rule.factor, ruleType: rule.ruleType, source: rule.source },
  };
}

/** Registry + evidence for the UOM rules page (read-only; VIEW_MAPPINGS). */
export function getUomRuleRegistry(): UomConversionRuleRow[] {
  return listUomConversionRules();
}

/** Data-quality visibility (section 31) - read-only, never audited. */
export function getUomDataQuality(): UomQualityCounts {
  return getUomQualityCounts();
}

/**
 * Step 18: comparable demand under the governed precedence (APPROVED
 * CMI-scoped domain rule, then system rules, else verbatim). Identical to
 * Step 17 output when no domain rules exist.
 */
export function getCmiComparableDemand(cmiId: number) {
  return _getCmiComparableDemandV2(cmiId);
}

export function getSupplierComparableQuantity(supplierId: number) {
  return _getSupplierComparableQuantityV2(supplierId);
}

export function getOrganizationComparableQuantity(organizationId: number) {
  return _getOrganizationComparableQuantityV2(organizationId);
}

// ---------------------------------------------------------------------------
// Step 18 - UOM rule governance (MANAGE_UOM_RULES) + quality remediation.
// ---------------------------------------------------------------------------

/** Governed domain rules, any status (page view; not audited). */
export function listGovernedUomRules(): UomDomainRuleRow[] {
  return _listUomDomainRules();
}

export interface CreateUomDomainRuleInput {
  cmiId: number;
  fromUom: string;
  toUom: string;
  factor: number;
  reason: string;
  actor: string;
}

/**
 * Propose a DOMAIN_SPECIFIC rule (PENDING; never auto-active) and audit the
 * creation. cmiCode is denormalized into the audit details for readable
 * history. Scoped to one CMI; never becomes a global rule.
 */
export function createUomDomainRule(input: CreateUomDomainRuleInput): UomDomainRuleRow {
  return withTransaction(() => {
    const id = _insertUomDomainRule({
      cmiId: input.cmiId,
      fromUom: input.fromUom,
      toUom: input.toUom,
      factor: input.factor,
      reason: input.reason,
      createdBy: input.actor,
    });
    const row = _getUomDomainRuleRequired(id);
    recordAudit({
      action: 'uom_rule_created',
      entityType: 'uom_domain_rule',
      entityId: id,
      actor: input.actor,
      details: {
        cmiId: row.cmiId,
        cmiCode: row.cmiCode,
        fromUom: row.fromUom,
        toUom: row.toUom,
        factor: row.factor,
        status: row.status,
        reason: row.reason,
      },
    });
    // Step 19 (sections 3/4): the CREATE event opens the rule's append-only
    // history (previous_status NULL - there was nothing before it). Step 20:
    // it is stamped with the immutable v1 content version it created.
    insertUomRuleHistory({
      ruleId: row.id,
      cmiId: row.cmiId,
      fromUom: row.fromUom,
      toUom: row.toUom,
      factor: row.factor,
      previousStatus: null,
      newStatus: row.status,
      action: 'CREATE',
      actor: input.actor,
      reason: row.reason,
      versionId: row.pendingVersionId,
    });
    return row;
  });
}

export type UomRuleTransitionAction = 'approve' | 'reject' | 'disable' | 're-enable';

/**
 * One governed human transition with prior/new state in the audit trail.
 * Invalid transitions throw inside the transaction (nothing is written).
 */
export function transitionUomRuleLifecycle(
  id: number,
  action: UomRuleTransitionAction,
  actor: string
): { rule: UomDomainRuleRow; previousStatus: UomDomainRuleStatus } {
  return withTransaction(() => {
    const before = _getUomDomainRuleRequired(id);
    const after = _transitionUomDomainRule(id, action, actor);
    const event =
      action === 'approve' ? 'uom_rule_approved'
      : action === 'reject' ? 'uom_rule_rejected'
      : action === 'disable' ? 'uom_rule_disabled'
      : 'uom_rule_re_enabled';
    recordAudit({
      action: event,
      entityType: 'uom_domain_rule',
      entityId: id,
      actor,
      details: {
        cmiId: after.cmiId,
        cmiCode: after.cmiCode,
        fromUom: after.fromUom,
        toUom: after.toUom,
        factor: after.factor,
        previousStatus: before.status,
        newStatus: after.status,
      },
    });
    // Step 19 (section 3): every lifecycle transition is mirrored into the
    // append-only history with the previous + new status and the rule's
    // evidence. Same transaction - audit and history always agree.
    const historyAction: UomRuleHistoryAction =
      action === 'approve' ? 'APPROVE'
      : action === 'reject' ? 'REJECT'
      : action === 'disable' ? 'DISABLE'
      : 'RE_ENABLE';
    insertUomRuleHistory({
      ruleId: after.id,
      cmiId: after.cmiId,
      fromUom: after.fromUom,
      toUom: after.toUom,
      factor: after.factor,
      previousStatus: before.status,
      newStatus: after.status,
      action: historyAction,
      actor,
      reason: before.reason,
      // Step 20 version context: a decision concerns the version it
      // consumes (the pending one); disable/re-enable concern the version
      // that is (or becomes) effective.
      versionId:
        action === 'approve' || action === 'reject' ? before.pendingVersionId : after.effectiveVersionId,
      previousVersionId: action === 'approve' ? before.effectiveVersionId : null,
    });
    return { rule: after, previousStatus: before.status };
  });
}

/** Remediation: rules proposed for one CMI (any status). */
export function getUomRulesForCmi(cmiId: number): UomDomainRuleRow[] {
  return _listUomDomainRulesForCmi(cmiId);
}

export interface UomRemediationBucket {
  uom: string;
  count: number;
  /** ClassifyUom category for the token (UNKNOWN for unrecognized units). */
  category: string;
}

export interface UomRemediationBoard {
  cmiId: number;
  cmiCode: string;
  cmiName: string;
  /** Per-UOM record counts inside the CMI scope (remediation targets). */
  buckets: UomRemediationBucket[];
  /** Governing rules already proposed/approved for this CMI. */
  rules: UomDomainRuleRow[];
}

/**
 * Quality-remediation view for one CMI (section 11): the affected UOMs with
 * record counts plus the rules that already govern them. Read-only - it
 * never creates anything; a human decides whether to propose a rule.
 */
export function getUomRemediationBoard(cmiId: number): UomRemediationBoard | null {
  const row = getDb()
    .prepare(`SELECT id, code, name FROM common_materials WHERE id = ?`)
    .get(cmiId) as { id: number; code: string; name: string } | undefined;
  if (!row) return null;
  const buckets: UomRemediationBucket[] = _getUomCountsForCmi(cmiId).map((b) => ({
    uom: b.uom,
    count: b.count,
    category: classifyUom(b.uom),
  }));
  return { cmiId: row.id, cmiCode: row.code, cmiName: row.name, buckets, rules: _listUomDomainRulesForCmi(cmiId) };
}

/** Bounded affected-record list for one UOM inside one CMI (traceability). */
export function getUomAffectedRecords(cmiId: number, uom: string, limit = 25) {
  return _listCmiRecordsByUom(cmiId, uom, limit);
}

/** Effective rule for one (scope, uom) - used by governance previews/tests. */
export function getEffectiveUomRule(uom: string, cmiId?: number | null) {
  return _resolveEffectiveUomRule(uom, cmiId ?? undefined);
}

// ---------------------------------------------------------------------------
// Step 20 - versioned rule content amendments, effective-version resolution,
// agreement view and governance reconciliation.
//
// Effective-version contract (section 8): the conversion engine may use ONLY
// the live rule's effective_version_id content. PENDING/REJECTED versions and
// superseded versions never convert; a DISABLED rule never converts. With no
// amendments this is behaviorally identical to Step 18 (the effective version
// carries exactly the content the rule was approved with).
// ---------------------------------------------------------------------------

import {
  insertUomRuleVersion as _insertUomRuleVersion,
  listUomRuleVersions,
  getUomRuleVersionRequired as _getUomRuleVersionRequired,
  countUomRuleVersions,
  listUomRuleAgreement,
  reconcileUomGovernance,
  transitionUomDomainRule as _transitionUomDomainRuleRepo,
  applyUomRuleVersionDecision as _applyUomRuleVersionDecision,
  type UomRuleVersionRow,
  type UomAgreementRow,
  type UomReconciliationResult,
  type UomRuleAmendmentInput,
} from '../db/repositories/procurement-repository';

/** All immutable content versions of one rule, oldest first (section 16). */
export function getUomRuleVersions(ruleId: number): UomRuleVersionRow[] {
  return listUomRuleVersions(ruleId);
}

/** Aligned history<->audit timeline for one rule (section 13; read-only). */
export function getUomRuleAgreement(ruleId: number): UomAgreementRow[] {
  return listUomRuleAgreement(ruleId);
}

/** Governance reconciliation across ALL rules (section 14; read-only). */
export function getUomGovernanceReconciliation(): UomReconciliationResult {
  return reconcileUomGovernance();
}

export interface AmendUomRuleInput {
  ruleId: number;
  fromUom?: string;
  toUom?: string;
  factor?: number;
  reason: string;
  actor: string;
}

/**
 * Propose an amendment to an APPROVED-or-DISABLED rule (section 5/10). One
 * governed transaction writes: the immutable next version, the live rule's
 * pending pointer, the AMEND history event and the uom_rule_amended audit
 * event. Any failure rolls back everything. Conversion behavior does NOT
 * change until the amendment is approved (section 5).
 */
export function proposeUomRuleAmendment(input: AmendUomRuleInput): { rule: UomDomainRuleRow; version: UomRuleVersionRow; previousVersion: UomRuleVersionRow | null } {
  return withTransaction(() => {
    const rule = _getUomDomainRuleRequired(input.ruleId);
    if (rule.status !== 'APPROVED' && rule.status !== 'DISABLED') {
      throw errors.badRequest(`Amendments are only possible for APPROVED or DISABLED rules; rule ${rule.id} is ${rule.status}`);
    }
    if (rule.pendingVersionId !== null) {
      throw errors.conflict(`Rule ${rule.id} already has a pending amendment awaiting decision`);
    }
    const previousVersion = rule.effectiveVersionId !== null ? _getUomRuleVersionRequired(rule.effectiveVersionId) : null;
    const version = _insertUomRuleVersion({
      ruleId: input.ruleId,
      fromUom: input.fromUom,
      toUom: input.toUom,
      factor: input.factor,
      reason: input.reason,
      actor: input.actor,
    });
    recordAudit({
      action: 'uom_rule_amended',
      entityType: 'uom_domain_rule',
      entityId: rule.id,
      actor: input.actor,
      details: {
        cmiId: rule.cmiId,
        cmiCode: rule.cmiCode,
        versionId: version.id,
        versionNumber: version.versionNumber,
        previousVersionId: version.supersedesVersionId,
        previousVersionNumber: previousVersion?.versionNumber ?? null,
        previous: previousVersion
          ? { fromUom: previousVersion.fromUom, toUom: previousVersion.toUom, factor: previousVersion.factor }
          : null,
        proposed: { fromUom: version.fromUom, toUom: version.toUom, factor: version.factor },
        reason: version.amendmentReason,
      },
    });
    insertUomRuleHistory({
      ruleId: rule.id,
      cmiId: rule.cmiId,
      fromUom: version.fromUom,
      toUom: version.toUom,
      factor: version.factor,
      previousStatus: rule.status,
      newStatus: rule.status,
      action: 'AMEND',
      actor: input.actor,
      reason: version.amendmentReason,
      versionId: version.id,
      previousVersionId: version.supersedesVersionId,
    });
    return { rule: _getUomDomainRuleRequired(input.ruleId), version, previousVersion };
  });
}

/**
 * Decide a pending amendment by approving or rejecting the RULE (section 5).
 * Reuses the existing lifecycle machinery so history + audit + state stay
 * transactionally aligned: on approve the pending version becomes effective
 * (the transition consumes the pointer and re-synchronizes the live rule's
 * content columns); on reject the pointer is discarded and the effective
 * version is untouched. Requires MANAGE_UOM_RULES at the API boundary.
 * Separation of duties (section 18): the approver must differ from the
 * amendment's proposer; the initial CREATE has no proposer restriction
 * beyond the existing role matrix.
 */
export function decideUomRuleAmendment(
  ruleId: number,
  action: 'approve' | 'reject',
  actor: string
): { rule: UomDomainRuleRow; previousStatus: UomDomainRuleStatus; effectiveVersion: UomRuleVersionRow | null } {
  if (action !== 'approve' && action !== 'reject') {
    throw errors.badRequest('Amendment decisions are approve or reject');
  }
  return withTransaction(() => {
    const before = _getUomDomainRuleRequired(ruleId);
    if (before.pendingVersionId === null || before.effectiveVersionId === null) {
      throw errors.badRequest(`Rule ${ruleId} has no pending amendment to decide`);
    }
    const pending = _getUomRuleVersionRequired(before.pendingVersionId);
    if (pending.createdBy === actor) {
      throw errors.forbidden('Separation of duties: the proposer of an amendment cannot approve or reject it');
    }
    // VERSION decision, not a lifecycle transition: the rule's status never
    // changes here (approving an amendment on a DISABLED rule must not
    // silently activate it - re-enable remains a separate human act).
    const decision = _applyUomRuleVersionDecision(ruleId, action, actor);
    const event = action === 'approve' ? 'uom_rule_approved' : 'uom_rule_rejected';
    recordAudit({
      action: event,
      entityType: 'uom_domain_rule',
      entityId: ruleId,
      actor,
      details: {
        cmiId: before.cmiId,
        cmiCode: before.cmiCode,
        versionId: decision.version.id,
        versionNumber: decision.version.versionNumber,
        previousVersionId: decision.supersededVersionId ?? decision.version.supersedesVersionId,
        previousVersionNumber:
          decision.version.supersedesVersionId !== null
            ? _getUomRuleVersionRequired(decision.version.supersedesVersionId).versionNumber
            : null,
        previous: { fromUom: before.fromUom, toUom: before.toUom, factor: before.factor },
        proposed: { fromUom: decision.version.fromUom, toUom: decision.version.toUom, factor: decision.version.factor },
        amendment: true,
      },
    });
    insertUomRuleHistory({
      ruleId,
      cmiId: before.cmiId,
      fromUom: decision.version.fromUom,
      toUom: decision.version.toUom,
      factor: decision.version.factor,
      previousStatus: before.status,
      newStatus: before.status,
      action: action === 'approve' ? 'APPROVE' : 'REJECT',
      actor,
      reason: decision.version.amendmentReason,
      versionId: decision.version.id,
      previousVersionId: decision.supersededVersionId ?? decision.version.supersedesVersionId,
    });
    const after = _getUomDomainRuleRequired(ruleId);
    const effectiveVersion = after.effectiveVersionId !== null ? _getUomRuleVersionRequired(after.effectiveVersionId) : null;
    return { rule: after, previousStatus: before.status, effectiveVersion };
  });
}
// ---------------------------------------------------------------------------
// Step 21 - governance cockpit aggregation (read-only; audit-silent).
// Unifies EXISTING signals: steward overview (rules/amendments/reconciliation),
// Step 17/18 UOM quality, review-queue funnel, CMI coverage. No new event
// sources, no second reconciliation algorithm, no migration.
// ---------------------------------------------------------------------------

import {
  listOpenReviewItems,
  countOpenReviewItems,
  getGovernanceSummary as _getGovernanceSummary,
  getGovernanceMonthly,
  getGovernanceActivity,
  type GovernanceReviewItem,
  type GovernanceSummary,
  type GovernanceMonthlyRow,
  type GovernanceActivityRow,
} from '../db/repositories/procurement-repository';

export interface GovernanceWorkItem {
  type: 'MATCH_REVIEW' | 'UOM_RULE_APPROVAL' | 'UOM_RULE_AMENDMENT' | 'UOM_REMEDIATION' | 'CMI_GOVERNANCE';
  ref: string;
  scope: string;
  status: string;
  openedAt: string;
  reason: string;
  requiredAction: string;
  href: string;
}

export type GovernanceHealthState = 'PASS' | 'WARNING' | 'ACTION REQUIRED';

export interface GovernanceHealthIndicator {
  id: string;
  label: string;
  state: GovernanceHealthState;
  evidence: string;
  count?: number;
}

export interface GovernanceCockpit {
  summary: GovernanceSummary;
  workQueue: GovernanceWorkItem[];
  health: GovernanceHealthIndicator[];
  quality: {
    counts: Record<string, number>;
    unknownUoms: Array<{ uom: string; count: number }>;
    cmisRequiringRemediation: number;
  };
  activity: GovernanceActivityRow[];
  monthly: GovernanceMonthlyRow[];
  reconciliation: UomReconciliationResult;
}

export function getGovernanceCockpit(): GovernanceCockpit {
  // The global quality pass is the cockpit's most expensive reused signal -
  // compute it ONCE and hand it to both internal consumers (Step-19 steward
  // overview and Step-21 summary), so the cockpit never repeats the scan.
  const quality = getUomQualityCounts();
  const overview = getUomStewardOverview(quality);
  const summary = getGovernanceSummary(quality);
  const reviewItems = listOpenReviewItems(15);
  const now = Date.now();

  // Unified human work queue - existing work, deep-linked into existing
  // workflows. The queue NEVER performs mutations itself.
  const workQueue: GovernanceWorkItem[] = [];
  for (const r of reviewItems) {
    workQueue.push({
      type: 'MATCH_REVIEW',
      ref: `${r.sourceCode} (${r.sourceOrg}) ↔ ${r.candidateCode} (${r.candidateOrg})`,
      scope: `${r.sourceOrg} / ${r.candidateOrg}`,
      status: r.status.toUpperCase(),
      openedAt: r.openedAt,
      reason: r.reason,
      requiredAction: 'Technical review decision',
      href: '/proposals?status=NEEDS_REVIEW',
    });
  }
  for (const q of overview.pendingQueue) {
    workQueue.push({
      type: 'UOM_RULE_APPROVAL',
      ref: `Rule #${q.rule.id} — ${q.rule.fromUom}→${q.rule.toUom} ×${q.rule.factor}`,
      scope: q.rule.cmiCode,
      status: q.rule.status,
      openedAt: q.rule.createdAt,
      reason: q.rule.reason,
      requiredAction: 'Approve / Reject (MANAGE_UOM_RULES)',
      href: `/procurement/uom-rules?rule=${q.rule.id}`,
    });
  }
  for (const q of overview.amendmentQueue) {
    workQueue.push({
      type: 'UOM_RULE_AMENDMENT',
      ref: `Rule #${q.rule.id} — v${q.effectiveVersion?.versionNumber ?? '?'} → v${q.proposedVersion?.versionNumber ?? '?'} (${q.proposedVersion?.fromUom}→${q.proposedVersion?.toUom} ×${q.proposedVersion?.factor})`,
      scope: q.rule.cmiCode,
      status: 'PENDING',
      openedAt: q.proposedVersion?.createdAt ?? q.rule.updatedAt,
      reason: q.proposedVersion?.amendmentReason ?? '—',
      requiredAction: 'Decide amendment (MANAGE_UOM_RULES, proposer excluded)',
      href: `/procurement/uom-rules?rule=${q.rule.id}`,
    });
  }
  for (const u of quality.unknownUoms) {
    workQueue.push({
      type: 'UOM_REMEDIATION',
      ref: `Unknown UOM "${u.uom}" — ${u.count} record${u.count === 1 ? '' : 's'}`,
      scope: 'All CPSEs',
      status: 'UNCONVERTED',
      openedAt: '',
      reason: 'No approved conversion rule exists.',
      requiredAction: 'Investigate records, propose a scoped rule if evidence exists',
      href: '/procurement/uom-rules',
    });
  }
  if (summary.cmisAwaitingGovernance > 0) {
    workQueue.push({
      type: 'CMI_GOVERNANCE',
      ref: `${summary.cmisAwaitingGovernance} CPSE organization${summary.cmisAwaitingGovernance === 1 ? '' : 's'} without any CMI mapping`,
      scope: 'Master data',
      status: 'UNMAPPED',
      openedAt: '',
      reason: 'Coverage gap: no governed material identity covers these CPSEs yet.',
      requiredAction: 'Map materials / extend CMI coverage',
      href: '/cross-reference',
    });
  }

  // Governance health - explainable, threshold-based (no invented score).
  const reconciled = overview.reconciliation.status === 'RECONCILED';
  const ageDays = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : -1;
  };
  const oldestReview = reviewItems.reduce((max, r) => Math.max(max, ageDays(r.openedAt)), 0);
  const health: GovernanceHealthIndicator[] = [
    {
      id: 'ledger-agreement',
      label: 'Audit ↔ history agreement',
      state: reconciled ? 'PASS' : 'ACTION REQUIRED',
      evidence:
        overview.reconciliation.status === 'RECONCILED'
          ? `${overview.reconciliation.reconciledCount}/${overview.reconciliation.historyEventsChecked} governance events paired with their audit twin`
          : overview.reconciliation.discrepancies.map((d) => d.evidence).join('; '),
      count: overview.reconciliation.discrepancies.length,
    },
    {
      id: 'effective-versions',
      label: 'Rules with valid effective version',
      state:
        summary.approvedUomRules === 0
          ? 'PASS'
          : summary.approvedUomRules === summary.activeGovernedRules
            ? 'PASS'
            : 'WARNING',
      evidence: `${summary.activeGovernedRules}/${summary.approvedUomRules} approved rules point at an effective immutable version`,
      count: summary.approvedUomRules - summary.activeGovernedRules,
    },
    {
      id: 'pending-decisions',
      label: 'Pending governance decisions',
      state: summary.pendingUomRules > 0 || summary.pendingAmendments > 0 ? 'ACTION REQUIRED' : 'PASS',
      evidence: `${summary.pendingUomRules} rule approval(s), ${summary.pendingAmendments} amendment decision(s) awaiting a human`,
      count: summary.pendingUomRules + summary.pendingAmendments,
    },
    {
      id: 'uom-quality',
      label: 'UOM quality',
      state: summary.unconvertedRecords > 0 ? 'WARNING' : 'PASS',
      evidence: `${summary.unconvertedRecords} unconverted record(s); ${summary.unknownUomTokens} unknown token(s); "No approved conversion rule exists."`,
      count: summary.unconvertedRecords,
    },
    {
      id: 'review-backlog',
      label: 'Technical review backlog',
      state: summary.openReviews > 0 ? (oldestReview > 30 ? 'ACTION REQUIRED' : 'WARNING') : 'PASS',
      evidence: `${summary.openReviews} open review(s); oldest ${oldestReview} day(s)`,
      count: summary.openReviews,
    },
    {
      id: 'cmi-coverage',
      label: 'CMI governance backlog',
      state: summary.cmisAwaitingGovernance > 0 ? 'WARNING' : 'PASS',
      evidence: `${summary.cmisAwaitingGovernance} CPSE(s) without any CMI mapping`,
      count: summary.cmisAwaitingGovernance,
    },
  ];

  return {
    summary,
    workQueue,
    health,
    quality: {
      counts: quality.counts,
      unknownUoms: quality.unknownUoms,
      cmisRequiringRemediation: summary.cmisRequiringRemediation,
    },
    activity: getGovernanceActivity(15),
    monthly: getGovernanceMonthly(),
    reconciliation: overview.reconciliation,
  };
}
