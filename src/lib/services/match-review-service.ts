/**
 * Step 23 — Match & technical-review hardening service.
 *
 * ONE stable result contract over the EXISTING matching engine's persisted
 * output. This service COMPOSES persisted candidate data (scores, evidence
 * JSON, materials, decisions, queue state) into reviewer-facing structures;
 * it never re-scores a pair, never re-runs the matching corpus, and never
 * mutates anything on reads (audit-silent). Scoring semantics stay exactly
 * where they were: engine + decision.ts + config.ts remain authoritative.
 *
 * Decision hardening: the existing decideMatch guards (pending-only, SoD-free
 * audit, queue resolution) are reused verbatim; this service adds the
 * smallest safe optimistic-concurrency check (expectedStatus) so a stale UI
 * cannot decide a candidate whose state changed after loading.
 */
import {
  getMatchRequired,
  type MatchWithContext,
} from '../db/repositories/matching-repository';
import { getMaterialsForComparison } from '../db/repositories/matching-queries';
import { getCommonMaterialByMatchId } from '../db/repositories/registry-repository';
import { getDb } from '../db/client';
import { errors } from '../errors';
import { DECISION_THRESHOLDS } from '../matching/decision';
import type { MatchEvidence, AttributeComparison } from '../matching/types';
import type { DecisionState } from '../matching/decision';
import { decideMatch as baseDecideMatch } from './matching-service';
import type { DecisionInput } from '../validation/schemas';
import type { MatchStatus } from '../types/domain';

/* ----------------------------- result contract ----------------------------- */

/** One explicit technical-attribute comparison row (§4). */
export interface TechnicalComparisonRow {
  attribute: string;
  leftValue: string | null;
  rightValue: string | null;
  relation: 'EXACT' | 'NORMALIZED' | 'CLOSE' | 'MISSING' | 'CONFLICT' | 'NOT_APPLICABLE';
  importance: 'CRITICAL' | 'IMPORTANT' | 'INFORMATIONAL';
  basis: string;
}

/** One structured technical conflict (§8). */
export interface TechnicalConflict {
  attribute: string;
  leftValue: string | null;
  rightValue: string | null;
  criticality: 'CRITICAL' | 'IMPORTANT';
  assessment: string;
  source: 'attribute_comparison' | 'engine_critical_difference';
}

/** Deterministic "WHY?" bullets (§33) — every line traces to stored data. */
export interface WhyExplanation {
  verdict: DecisionState | 'UNCLASSIFIED';
  ruleReason: string;
  points: string[];
}

/** The stable match-review result (§3). */
export interface MatchReview {
  candidateId: number;
  leftMaterial: {
    id: number;
    cpse: string;
    code: string;
    description: string;
    normalizedDescription: string | null;
    category: string;
    manufacturer: string | null;
    model: string | null;
    partNumber: string | null;
    uom: string;
    attributes: Array<{ name: string; value: string; unit: string | null; critical: boolean }>;
  };
  rightMaterial: MatchReview['leftMaterial'];
  semanticScore: number;
  fuzzyScore: number;
  technicalScore: number;
  ruleScore: number;
  finalScore: number;
  verdict: DecisionState | 'UNCLASSIFIED';
  verdictBand: 'high' | 'review' | 'low' | 'reject' | 'unknown';
  matchType: string;
  reviewRequired: boolean;
  reason: string;
  technicalComparison: TechnicalComparisonRow[];
  conflicts: TechnicalConflict[];
  missingEvidence: string[];
  matchedAttributes: TechnicalComparisonRow[];
  assemblyEvidence: { materialA: string; materialB: string; detail: string } | null;
  manufacturerRelationship: 'same' | 'different' | 'unknown';
  categoryRelationship: 'same_category' | 'cross_category';
  thresholds: Record<string, number>;
  decisionHistory: Array<{ decision: string; reviewer: string; comment: string | null; decidedAt: string }>;
  queue: { id: number; priority: string; status: string; reason: string; openedAt: string | null } | null;
  cmiState: 'cmi_created' | 'cmi_pending' | null;
  status: MatchStatus;
  why: WhyExplanation;
}

const IMPORTANCE: Record<string, 'CRITICAL' | 'IMPORTANT' | 'INFORMATIONAL'> = {
  CRITICAL: 'CRITICAL',
  IMPORTANT: 'IMPORTANT',
  INFORMATIONAL: 'INFORMATIONAL',
};

function importanceOf(row: AttributeComparison): 'CRITICAL' | 'IMPORTANT' | 'INFORMATIONAL' {
  if (row.critical) return IMPORTANCE.CRITICAL;
  // Non-critical comparisons still matter when they disagree.
  return row.type === 'CONFLICT' ? IMPORTANCE.IMPORTANT : IMPORTANCE.INFORMATIONAL;
}

function relationOf(type: AttributeComparison['type']): TechnicalComparisonRow['relation'] {
  switch (type) {
    case 'EXACT_MATCH': return 'EXACT';
    case 'NORMALIZED_MATCH': return 'NORMALIZED';
    case 'CLOSE_MATCH': return 'CLOSE';
    case 'MISSING': return 'MISSING';
    case 'CONFLICT': return 'CONFLICT';
    default: return 'NOT_APPLICABLE';
  }
}

function toRows(comparisons: AttributeComparison[]): TechnicalComparisonRow[] {
  return comparisons.map((c) => ({
    attribute: c.attributeName,
    leftValue: c.valueA,
    rightValue: c.valueB,
    relation: relationOf(c.type),
    importance: importanceOf(c),
    basis: c.detail,
  }));
}

function parseEvidenceDoc(json: string | null): MatchEvidence | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as MatchEvidence;
  } catch {
    return null;
  }
}

function materialSide(m: Awaited<ReturnType<typeof getMaterialsForComparison>>[number]) {
  return {
    id: m.id,
    cpse: m.orgCode,
    code: m.originalCode,
    description: m.originalDescription,
    normalizedDescription: m.normalizedDescription,
    category: m.category,
    manufacturer: m.manufacturer,
    model: m.model,
    partNumber: m.partNumber,
    uom: m.uom,
    attributes: m.attributes.map((a) => ({
      name: a.attributeName,
      value: a.value,
      unit: a.unit,
      critical: a.isCritical,
    })),
  };
}

/**
 * Compose the review contract for one candidate. Pure read: no writes, no
 * audit rows, no rescoring — everything derives from persisted state.
 */
export function getMatchReview(matchId: number): MatchReview {
  const match: MatchWithContext = getMatchRequired(matchId);
  const ev = parseEvidenceDoc(match.candidate.evidence);
  const materials = getMaterialsForComparison(match.source.id, match.candidateMat.id);
  const [leftMat, rightMat] = materials;

  const comparisons = ev?.attributeComparisons ?? [];
  const rows = toRows(comparisons);
  const conflicts: TechnicalConflict[] = rows
    .filter((r) => r.relation === 'CONFLICT')
    .map((r) => ({
      attribute: r.attribute,
      leftValue: r.leftValue,
      rightValue: r.rightValue,
      criticality: r.importance === 'CRITICAL' ? 'CRITICAL' : 'IMPORTANT',
      // Documented comparison outcome only — no invented engineering consequences.
      assessment: r.importance === 'CRITICAL' ? 'Technical review required.' : 'Values differ; recorded for traceability.',
      source: 'attribute_comparison',
    }));
  // Engine-level critical differences not covered by a comparison row
  // (e.g. derived rules) surface from the persisted critical_difference.
  const cd = match.candidate.critical_difference;
  if (cd && !conflicts.some((c) => cd.toLowerCase().includes(c.attribute.toLowerCase().replace(/_/g, ' ')) || cd.includes(c.attribute))) {
    conflicts.push({
      attribute: cd.split(':')[0]?.trim() || 'critical_difference',
      leftValue: null,
      rightValue: null,
      criticality: 'CRITICAL',
      assessment: 'Technical review required.',
      source: 'engine_critical_difference',
    });
  }

  const manufacturerA = leftMat?.manufacturer ?? null;
  const manufacturerB = rightMat?.manufacturer ?? null;
  const manufacturerRelationship =
    manufacturerA && manufacturerB
      ? manufacturerA.trim().toUpperCase() === manufacturerB.trim().toUpperCase()
        ? 'same'
        : 'different'
      : 'unknown';
  const categoryRelationship =
    match.source.category.trim().toLowerCase() === match.candidateMat.category.trim().toLowerCase()
      ? 'same_category'
      : 'cross_category';

  const verdict = ev?.decision?.state ?? 'UNCLASSIFIED';
  const missing = ev?.missingCritical ?? [];
  const assembly = ev?.assemblyConfiguration ?? null;
  const band = ev?.decision?.band ?? 'unknown';

  // Deterministic WHY bullets — every line cites stored values (§33/§34).
  const points: string[] = [];
  if (ev?.weights) {
    points.push(`Combined score ${Math.round(match.candidate.final_score)}% from ${Math.round((ev.weights.semantic ?? 0) * 100)}% semantic + ${Math.round((ev.weights.fuzzy ?? 0) * 100)}% fuzzy + ${Math.round((ev.weights.technical ?? 0) * 100)}% technical + ${Math.round((ev.weights.category ?? 0) * 100)}% category weights.`);
  } else {
    points.push(`Combined score ${Math.round(match.candidate.final_score)}% (persisted components: semantic ${Math.round(match.candidate.semantic_score)}, fuzzy ${Math.round(match.candidate.fuzzy_score)}, technical ${Math.round(match.candidate.technical_score)}, category ${match.candidate.category_compatible ? 100 : 0}); the full evidence document is not available for this legacy candidate.`);
  }
  points.push(`Category relationship: ${categoryRelationship.replace('_', ' ')} (${match.source.category} ↔ ${match.candidateMat.category}).`);
  points.push(`Manufacturer relationship: ${manufacturerRelationship}${manufacturerA && manufacturerB ? ` (${manufacturerA} vs ${manufacturerB})` : ''}.`);
  const exactRows = rows.filter((r) => r.relation === 'EXACT' || r.relation === 'NORMALIZED');
  if (exactRows.length > 0) {
    points.push(`Agreeing technical attributes: ${exactRows.map((r) => `${r.attribute.replace(/_/g, ' ')} (${r.leftValue} = ${r.rightValue})`).join('; ')}.`);
  }
  const closeRows = rows.filter((r) => r.relation === 'CLOSE');
  for (const r of closeRows) points.push(`${r.attribute.replace(/_/g, ' ')} is within the numeric tolerance: ${r.leftValue} vs ${r.rightValue} (${r.basis}).`);
  for (const m of missing) points.push(`Missing critical evidence: ${m.replace(/_/g, ' ')} is absent on one record — equality cannot be confirmed.`);
  for (const c of conflicts) points.push(`Conflict on ${c.attribute.replace(/_/g, ' ')}: ${c.leftValue ?? '?'} vs ${c.rightValue ?? '?'} (${c.criticality.toLowerCase()}) — ${c.assessment.toLowerCase()}`);
  if (assembly) points.push(`Assembly/kit difference: ${assembly.detail} (${assembly.materialA} vs ${assembly.materialB}).`);
  points.push(`Decision rule: ${ev?.decision?.reason ?? match.candidate.explanation}`);
  if (verdict === 'NEEDS_TECHNICAL_REVIEW') points.push('Therefore a human technical reviewer decides — the system never auto-approves conflicts.');
  if (verdict === 'HIGH_CONFIDENCE_MATCH') points.push(`Therefore eligible for human approval under the ${DECISION_THRESHOLDS.highConfidence}% high-confidence rule with no critical difference.`);
  if (verdict === 'NOT_A_MATCH') points.push(`Therefore excluded from equivalence (below the ${DECISION_THRESHOLDS.notAMatch}% floor or incompatible categories).`);

  return {
    candidateId: match.candidate.id,
    leftMaterial: materialSide(leftMat),
    rightMaterial: materialSide(rightMat),
    semanticScore: match.candidate.semantic_score,
    fuzzyScore: match.candidate.fuzzy_score,
    technicalScore: match.candidate.technical_score,
    ruleScore: match.candidate.category_compatible ? 100 : 0,
    finalScore: match.candidate.final_score,
    verdict,
    verdictBand: band,
    matchType: match.candidate.match_type,
    reviewRequired: verdict === 'NEEDS_TECHNICAL_REVIEW' || verdict === 'UNCLASSIFIED',
    reason: ev?.decision?.reason ?? ev?.decisionReason ?? match.candidate.explanation,
    technicalComparison: rows,
    conflicts,
    missingEvidence: missing,
    matchedAttributes: rows.filter((r) => r.relation === 'EXACT' || r.relation === 'NORMALIZED' || r.relation === 'CLOSE'),
    assemblyEvidence: assembly,
    manufacturerRelationship,
    categoryRelationship,
    thresholds: { ...DECISION_THRESHOLDS } as unknown as Record<string, number>,
    decisionHistory: match.decision
      ? [{ decision: match.decision.decision, reviewer: match.decision.reviewer, comment: match.decision.comment, decidedAt: match.decision.decided_at }]
      : [],
    queue: match.queue
      ? { id: match.queue.id, priority: match.queue.priority, status: match.queue.status, reason: match.queue.reason, openedAt: null }
      : null,
    cmiState: match.cmiState,
    status: match.candidate.status,
    why: { verdict, ruleReason: ev?.decision?.reason ?? match.candidate.explanation, points },
  };
}

/* ------------------------------ review summary ------------------------------ */

export interface ReviewSummary {
  openReviews: number;
  highConfidence: number;
  technicalConflicts: number;
  missingCriticalEvidence: number;
  assemblyDifferences: number;
  crossBrand: number;
}

/**
 * Compact review metrics (§19) — every value computed from actual rows via
 * the same JSON1 extraction the queue filters use. Read-only, audit-silent.
 */
export function getReviewSummary(): ReviewSummary {
  const db = getDb();
  const openReviews = (db.prepare(`SELECT COUNT(*) AS n FROM review_queue WHERE status = 'open'`).get() as unknown as { n: number }).n;
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN json_extract(mc.evidence, '$.decision.state') = 'HIGH_CONFIDENCE_MATCH' THEN 1 ELSE 0 END) AS high_confidence,
         SUM(CASE WHEN json_array_length(mc.evidence, '$.criticalConflicts') > 0 THEN 1 ELSE 0 END) AS conflicts,
         SUM(CASE WHEN json_array_length(mc.evidence, '$.missingCritical') > 0 THEN 1 ELSE 0 END) AS missing,
         SUM(CASE WHEN json_extract(mc.evidence, '$.assemblyConfiguration') IS NOT NULL THEN 1 ELSE 0 END) AS assembly,
         SUM(CASE WHEN s.manufacturer IS NOT NULL AND c.manufacturer IS NOT NULL
                   AND UPPER(TRIM(s.manufacturer)) != UPPER(TRIM(c.manufacturer)) THEN 1 ELSE 0 END) AS cross_brand
       FROM match_candidates mc
       JOIN material_records s ON s.id = mc.source_material_id
       JOIN material_records c ON c.id = mc.candidate_material_id
       WHERE mc.status = 'pending'`,
    )
    .get() as unknown as { high_confidence: number | null; conflicts: number | null; missing: number | null; assembly: number | null; cross_brand: number | null };
  return {
    openReviews,
    highConfidence: row.high_confidence ?? 0,
    technicalConflicts: row.conflicts ?? 0,
    missingCriticalEvidence: row.missing ?? 0,
    assemblyDifferences: row.assembly ?? 0,
    crossBrand: row.cross_brand ?? 0,
  };
}

/* --------------------------- hardened decisions ---------------------------- */

export interface HardenedDecisionInput extends DecisionInput {
  /**
   * Optimistic concurrency (§28/§29): the status the caller believed the
   * candidate to be in. When supplied and no longer true, the mutation is
   * rejected as stale (409) — the client must refresh before deciding.
   */
  expectedStatus?: MatchStatus;
}

/**
 * Apply a reviewer decision with the existing guards (pending-only, existing
 * audit actions, queue resolution) plus the expectedStatus staleness check.
 *
 * Concurrency note: withTransaction is single-transaction-per-service-fn
 * (nested BEGIN throws), so the staleness pre-check runs before the decision
 * transaction. The decision path itself re-validates pending status INSIDE
 * its own transaction and conflicts on decided rows, so the worst race case
 * is the existing safe "already decided" error — never a double decision.
 */
export function decideMatchHardened(
  matchId: number,
  input: HardenedDecisionInput,
  actor: string,
): { status: MatchStatus; stale: boolean } {
  if (input.expectedStatus !== undefined) {
    const current = getMatchRequired(matchId).candidate.status;
    if (current !== input.expectedStatus) {
      throw errors.conflict(
        `Stale review: the candidate is now "${current}" (you expected "${input.expectedStatus}"). Refresh and decide on the current state.`,
      );
    }
  }
  // Existing decision path — same transaction, same audit, same queue effects.
  const result = baseDecideMatch(matchId, input, actor);
  return { ...result, stale: false };
}

/* ------------------------------ queue queries ------------------------------ */

/** Deterministic sort tokens are owned by the repository (single source). */
export { parseReviewSort } from '../db/repositories/matching-repository';
export type { ReviewSort } from '../db/repositories/matching-repository';

/** SQL fragment for a sort token (used by the review-queue API). */
export function reviewSortSql(sort: import('../db/repositories/matching-repository').ReviewSort | undefined): string {
  switch (sort) {
    case 'score_asc': return 'mc.final_score ASC, mc.id ASC';
    case 'oldest': return 'mc.created_at ASC, mc.id ASC';
    case 'newest': return 'mc.created_at DESC, mc.id DESC';
    case 'priority': return `CASE COALESCE(rq.priority, 'low') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC, mc.final_score DESC, mc.id ASC`;
    default: return 'mc.final_score DESC, mc.id ASC';
  }
}
