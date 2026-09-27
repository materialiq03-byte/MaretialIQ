/**
 * Step 15 - procurement opportunity detection & human-review service.
 *
 * An opportunity means "observed procurement pattern that may deserve human
 * investigation" - never "do this" (section 3). Detection is deterministic
 * SQL over the Step-14 aggregation layer plus a small unharmonized-relationship
 * query; it is READ-ONLY on the business tables and audit-SILENT (section 28).
 * Only human status transitions are authorized + audited.
 *
 * Rules (all thresholds documented in docs/PROCUREMENT.md):
 *   CROSS_CPSE_DEMAND            orgs >= 2 (section 11)
 *   REPEATED_PROCUREMENT         records >= 2 AND distinct purchase dates >= 2
 *                                (section 12; Step-13 row-signature idempotency
 *                                keeps duplicate import rows out of the count)
 *   FRAGMENTED_DEMAND            orgs >= 2 AND records >= 3 (section 13;
 *                                descriptive - never "consolidate")
 *   MULTI_SUPPLIER_ACTIVITY      suppliers >= 2 (section 14; never a ranking)
 *   HIGH_PROCUREMENT_ACTIVITY    top 10% of per-CMI event counts within this
 *                                detection run (section 16B - DATASET-RELATIVE,
 *                                never an industry benchmark)
 *   UNHARMONIZED_RELATED_...     cmi IS NULL AND (approved match decision for
 *                                the material OR same CPSE+category as an
 *                                active CMI member) - a material-master review
 *                                signal only; never creates mappings (section 15)
 *
 * Signal score (section 9) = 2*orgs + 2*suppliers + records, fully documented;
 * deterministic ordering, no ML, no opaque model (section 10).
 *
 * Lifecycle (sections 6/31): OPEN -> ACKNOWLEDGED / DISMISSED / RESOLVED,
 * terminal states reopenable explicitly. Detection reruns upsert evidence on
 * the deterministic detection_key and NEVER touch human status (section 32).
 */
import {
  listOpportunities,
  aggregateCmiProcurement,
  cmiDemandEvidenceRows,
  cmiSupplierEvidenceRows,
  cmiMonthlyEvidenceRows,
  getCmiComparableDemand,
  aggregateUnharmonizedWithRelationship,
  upsertOpportunity,
  transitionOpportunity,
  getOpportunityRequired,
  listOpportunitySourceRecords,
  type OpportunityRow,
  type OpportunityTransition,
  type CmiDetectionAggregate,
} from '../db/repositories/procurement-repository';
import { centsToDecimal } from '../db/repositories/procurement-repository';
import { recordAudit } from '../db/repositories/audit-repository';
import { errors } from '../errors';
import type { OpportunityType } from '../types/domain';

export {
  listOpportunities,
  getOpportunity,
  getOpportunityRequired,
  type OpportunityRow,
  type OpportunityFilters,
  type OpportunityTransition,
} from '../db/repositories/procurement-repository';

export interface DetectionSummary {
  created: number;
  refreshed: number;
  totalOpen: number;
  byType: Record<string, number>;
}

/** Deterministic signal score (section 9) - transparent formula. */
function signalScore(a: { orgs: number; suppliers: number; records: number }): number {
  return 2 * a.orgs + 2 * a.suppliers + a.records;
}

function demandByOrgAndUom(cmiId: number, all: ReturnType<typeof cmiDemandEvidenceRows>) {
  return all
    .filter((r) => r.cmi_id === cmiId)
    .map((r) => ({
      org: r.org_code,
      uom: r.uom,
      qty: centsToDecimal(r.qty_cents),
      records: r.records,
    }));
}

function upsert(
  input: Parameters<typeof upsertOpportunity>[0],
  created: DetectionSummary,
  byType: Record<string, number>
): void {
  const res = upsertOpportunity(input);
  if (res.created) created.created += 1;
  else created.refreshed += 1;
  byType[input.type] = (byType[input.type] ?? 0) + 1;
}

/** Evidence for one CMI from the Step-14-style aggregate rows. */
function buildCmiEvidence(a: CmiDetectionAggregate): Record<string, any> {
  const demand = cmiDemandEvidenceRows([a.cmi_id]);
  const monthly = cmiMonthlyEvidenceRows([a.cmi_id]);
  return {
    cmis: a.cmi_code,
    cmiName: a.cmi_name,
    category: a.category,
    orgs: a.orgs,
    suppliers: a.suppliers,
    records: a.records,
    distinctPurchaseDates: a.distinct_dates,
    period: { start: a.first_date, end: a.last_date },
    demandByOrgAndUom: demandByOrgAndUom(a.cmi_id, demand),
    monthlyEvents: monthly
      .filter((m) => m.cmi_id === a.cmi_id)
      .map((m) => ({ month: m.ym, records: m.records })),
    rule: {
      signalScore: signalScore(a),
      formula: '2*orgs + 2*suppliers + records',
    },
    // Step 17 section 18: comparable demand ONLY from valid normalization
    // (active ALIAS/SCALE rules). Unconverted UOMs stay in demandByOrgAndUom
    // with their original units and are never merged into a unified total.
    comparableDemand: {
      ...getCmiComparableDemand(a.cmi_id),
      note: 'Comparable quantity calculated using configured UOM normalization rules.',
    },
  };
}

/**
 * Run opportunity detection. Idempotent (section 32): same dataset + period
 * => same detection_keys => same opportunity identities; evidence refreshed,
 * human statuses untouched, no duplicates. Read-only on business tables and
 * audit-silent (section 28) - nothing here calls recordAudit.
 */
export function detectProcurementOpportunities(): DetectionSummary {
  const created: DetectionSummary = { created: 0, refreshed: 0, totalOpen: 0, byType: {} };

  const aggregates = aggregateCmiProcurement();
  const cmiIds = aggregates.map((a) => a.cmi_id);
  const demandRows = cmiDemandEvidenceRows(cmiIds);
  const supplierRows = cmiSupplierEvidenceRows(cmiIds);
  const monthlyRows = cmiMonthlyEvidenceRows(cmiIds);

  // HIGH_PROCUREMENT_ACTIVITY (section 16B): dataset-relative top-decile
  // threshold over per-CMI event counts. top10 = ceil(0.1 * n); threshold is
  // the n-top10th value; CMIs strictly above the median-half qualify. With a
  // single CMI no ranking is possible, so the rule needs >= 2 CMIs.
  const sortedCounts = aggregates.map((a) => a.records).sort((x, y) => x - y);
  const top10 = Math.max(1, Math.ceil(sortedCounts.length * 0.1));
  const highThreshold =
    sortedCounts.length >= 2 ? sortedCounts[sortedCounts.length - top10] : Infinity;

  for (const a of aggregates) {
    const evidence = buildCmiEvidence(a);
    evidence.demandByOrgAndUom = demandRows
      .filter((r) => r.cmi_id === a.cmi_id)
      .map((r) => ({ org: r.org_code, uom: r.uom, qty: centsToDecimal(r.qty_cents), records: r.records }));
    evidence.monthlyEvents = monthlyRows
      .filter((m) => m.cmi_id === a.cmi_id)
      .map((m) => ({ month: m.ym, records: m.records }));
    evidence.supplierActivity = supplierRows
      .filter((s) => s.cmi_id === a.cmi_id)
      // Step 16 (section 21): include the supplier master id so the detail page
      // can link evidence rows to the supplier-intelligence page. Enrichment,
      // not ranking.
      .map((s) => ({ supplier: s.supplier_name, supplierId: s.supplier_id, records: s.records, first: s.first_date, last: s.last_date }));
    const score = signalScore(a);
    const keyBase = a.cmi_id;
    const period = { start: a.first_date, end: a.last_date };

    if (a.orgs >= 2) {
      upsert(
        {
          detectionKey: `CROSS_CPSE_DEMAND|cmi:${keyBase}|all`,
          type: 'CROSS_CPSE_DEMAND',
          title: `Cross-CPSE demand visibility for ${a.cmi_code}`,
          description: `${a.orgs} CPSEs purchased this common material across ${a.records} procurement records. Demand quantities are aggregated per UOM only - no unit conversions are applied. This is an observation for human procurement review, not a purchasing instruction.`,
          evidence,
          prioritySignal: score,
          cmiId: a.cmi_id,
          periodStart: period.start,
          periodEnd: period.end,
        },
        created,
        created.byType
      );
    }

    if (a.records >= 2 && a.distinct_dates >= 2) {
      upsert(
        {
          detectionKey: `REPEATED_PROCUREMENT|cmi:${keyBase}|all`,
          type: 'REPEATED_PROCUREMENT',
          title: `Repeated procurement activity for ${a.cmi_code}`,
          description: `${a.records} procurement records on ${a.distinct_dates} distinct purchase dates detected. Repeated activity is a factual signal for human review - no reorder quantity or timing is suggested.`,
          evidence,
          prioritySignal: score,
          cmiId: a.cmi_id,
          periodStart: period.start,
          periodEnd: period.end,
        },
        created,
        created.byType
      );
    }

    if (a.orgs >= 2 && a.records >= 3) {
      upsert(
        {
          detectionKey: `FRAGMENTED_DEMAND|cmi:${keyBase}|all`,
          type: 'FRAGMENTED_DEMAND',
          title: `Demand distributed across CPSEs for ${a.cmi_code}`,
          description: `Demand is distributed across ${a.orgs} CPSEs and ${a.records} procurement events. This is a descriptive observation - whether consolidated procurement is appropriate remains a human judgment.`,
          evidence,
          prioritySignal: score,
          cmiId: a.cmi_id,
          periodStart: period.start,
          periodEnd: period.end,
        },
        created,
        created.byType
      );
    }

    if (a.suppliers >= 2) {
      upsert(
        {
          detectionKey: `MULTI_SUPPLIER_ACTIVITY|cmi:${keyBase}|all`,
          type: 'MULTI_SUPPLIER_ACTIVITY',
          title: `Multiple suppliers active for ${a.cmi_code}`,
          description: `${a.suppliers} suppliers appear in procurement records for this common material. Supplier activity patterns are factual observations - suppliers are never ranked or compared for preference.`,
          evidence,
          prioritySignal: score,
          cmiId: a.cmi_id,
          periodStart: period.start,
          periodEnd: period.end,
        },
        created,
        created.byType
      );
    }

    if (a.records >= highThreshold) {
      const topShare = Math.round((top10 / sortedCounts.length) * 100);
      upsert(
        {
          detectionKey: `HIGH_PROCUREMENT_ACTIVITY|cmi:${keyBase}|all`,
          type: 'HIGH_PROCUREMENT_ACTIVITY',
          title: `High procurement activity for ${a.cmi_code}`,
          description: `${a.records} procurement events place this CMI in the top ${topShare}% of activity within THIS demonstration dataset (threshold: ${highThreshold} events; dataset-relative rule, not an industry benchmark).`,
          evidence: { ...evidence, rule: { ...evidence.rule, highThreshold, datasetRelative: true, topShare } },
          prioritySignal: score,
          cmiId: a.cmi_id,
          periodStart: period.start,
          periodEnd: period.end,
        },
        created,
        created.byType
      );
    }
  }

  for (const u of aggregateUnharmonizedWithRelationship()) {
    const materialIds = parseMaterialIds(u.evidence_material_ids);
    upsert(
      {
        detectionKey: `UNHARMONIZED_RELATED_PROCUREMENT|org:${u.organization_id}|cat:${u.category}`,
        type: 'UNHARMONIZED_RELATED_PROCUREMENT',
        title: `Unharmonized procurement review signal — ${u.org_name} / ${u.category}`,
        description: `${u.records} procurement records (${u.materials} materials) remain unharmonized while the same CPSE already maintains an approved common material identity in the ${u.category} category, or an approved matching relationship exists. Procurement stays unharmonized - this signal only suggests material-master review.`,
        evidence: {
          organization: u.org_name,
          category: u.category,
          records: u.records,
          materials: u.materials,
          period: { start: u.first_date, end: u.last_date },
          materialIds: materialIds,
          reviewHint: 'Compare the material master entries for these materials with the existing common material identity in this category.',
        },
        prioritySignal: u.records,
        organizationId: u.organization_id,
        periodStart: u.first_date,
        periodEnd: u.last_date,
      },
      created,
      created.byType
    );
  }

  created.totalOpen = listOpportunities({ status: 'OPEN' }, 1, 1).total;
  return created;
}

/** Parse the capped "1,2,3" material-id list from the unharmonized aggregate. */
function parseMaterialIds(raw: string): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);
}

const TRANSITION_AUDIT: Record<OpportunityTransition, Parameters<typeof recordAudit>[0]['action']> = {
  acknowledge: 'procurement_opportunity_acknowledged',
  dismiss: 'procurement_opportunity_dismissed',
  resolve: 'procurement_opportunity_resolved',
  reopen: 'procurement_opportunity_reopened',
};

export interface ReviewInput {
  actor: string;
  reason?: string;
}

/** OPEN -> ACKNOWLEDGED. Acknowledgment is NOT acceptance of any action. */
export function acknowledgeOpportunity(id: number, input: ReviewInput): OpportunityRow {
  return apply(id, 'acknowledge', input);
}

/** Terminal dismissal - requires a reason (section 29). */
export function dismissOpportunity(id: number, input: ReviewInput & { reason: string }): OpportunityRow {
  return apply(id, 'dismiss', input);
}

/** Terminal resolution - requires a reason (section 29). */
export function resolveOpportunity(id: number, input: ReviewInput & { reason: string }): OpportunityRow {
  return apply(id, 'resolve', input);
}

/** Explicit reopen from DISMISSED/RESOLVED - requires a reason. */
export function reopenOpportunity(id: number, input: ReviewInput & { reason: string }): OpportunityRow {
  return apply(id, 'reopen', input);
}

function apply(
  id: number,
  transition: OpportunityTransition,
  input: ReviewInput & { reason?: string }
): OpportunityRow {
  const requiresReason = transition === 'dismiss' || transition === 'resolve' || transition === 'reopen';
  if (requiresReason && (!input.reason || input.reason.trim().length === 0)) {
    throw errors.badRequest(`A reason is required to ${transition} an opportunity`);
  }
  const previousStatus = getOpportunityRequired(id).status;
  const row = transitionOpportunity(id, transition, input.actor, input.reason?.trim());
  recordAudit({
    action: TRANSITION_AUDIT[transition],
    entityType: 'procurement_opportunity',
    entityId: row.id,
    actor: input.actor,
    details: {
      previousStatus,
      newStatus: row.status,
      reason: input.reason?.trim() ?? null,
      detectionKey: row.detection_key,
      opportunityType: row.opportunity_type,
    },
  });
  return row;
}
