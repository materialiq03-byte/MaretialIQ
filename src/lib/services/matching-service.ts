import { withTransaction, getDb } from '../db/client';
import {
  upsertMatch,
  deletePendingMatches,
  enqueueReview,
  recordDecision,
  setMatchStatus,
  resolveQueueEntry,
  getMatchRequired,
} from '../db/repositories/matching-repository';
import { createCommonMaterial, insertMapping } from '../db/repositories/registry-repository';
import { recordAudit } from '../db/repositories/audit-repository';
import { listAllMaterialsForMatching } from '../db/repositories/matching-queries';
import { scorePairCore, finishPair, iteratePairs, countPairs } from '../matching/engine';
import { MatchingRunCache } from '../matching/runtime';
import { prefilterEnabled, survivesPersistenceFloor } from '../matching/prefilter';
import {
  cmiShortCircuitMode,
  makeCmiRuntime,
  evaluateCmiPair,
  trackCmiPair,
  trackCmiSkip,
  type CmiShortCircuitRuntime,
} from '../matching/cmi-shortcircuit';
import { DECISION_THRESHOLDS } from '../matching/decision';
import { errors } from '../errors';
import type { DecisionInput } from '../validation/schemas';
import type { Decision, MatchStatus, MatchType, QueuePriority } from '../types/domain';

export interface MatchRunSummary {
  runId: string;
  pairsCompared: number;
  candidatesCreated: number;
  reviewItemsCreated: number;
  /** Pairs per prototype decision state (HIGH_CONFIDENCE_MATCH etc.). */
  byDecision: Record<string, number>;
  /** Pairs dropped below the NOT_A_MATCH floor — not persisted, only counted. */
  droppedNotAMatch: number;
  /**
   * Pairs the Step-5 fast path removed WITHOUT building the expensive
   * evidence tail: exactly the pairs the legacy path scores and then drops
   * (its own persistence-floor rule, applied earlier). Persisted output is
   * bit-identical either way; MATCH_PREFILTER=off restores the legacy
   * score-everything accounting (droppedByPrefilter = 0, every pair counted
   * in byDecision).
   */
  droppedByPrefilter: number;
  /**
   * Fast path only: dropped pairs by the decision state the legacy pipeline
   * would have recorded for them (all drops land in NOT_A_MATCH except the
   * sub-floor critical-conflict band, which classifies
   * NEEDS_TECHNICAL_REVIEW before the floor rule fires — preserved verbatim).
   * Lets audit/summaries reconcile byDecision against the legacy run.
   */
  droppedByState: Record<string, number>;
  /**
   * Step 9: pairs whose materials share an ACTIVE CMI mapping. shadow: they
   * were scored normally (detection only). on: DECIDED same-CMI pairs were
   * NOT re-scored — their existing candidate rows, scores, evidence and
   * review history are preserved verbatim (upsertMatch would ignore those
   * writes anyway). off: always 0.
   */
  cmiShortCircuited: number;
  /**
   * Step 9 audit detail: distinct CMIs + material ids involved, and (on
   * mode) skipped pairs by the existing row's stored decision state — so
   * byDecision(on) + skippedByState == byDecision(off).
   */
  cmiDetail?: {
    cmiIds: number[];
    materialIds: number[];
    skippedByState?: Record<string, number>;
  };
  durationMs: number;
}

// Exported for tests (queue-tier contract); shape is frozen by MatchType.
export const QUEUE_REASON: Record<MatchType, string> = {
  identical: 'Confirmed identical candidates ready for approval',
  near_duplicate: 'Near duplicate requiring confirmation',
  functional_equivalent: 'Functionally equivalent candidate requiring confirmation',
  needs_review: 'Critical technical difference requires expert review',
  different: 'Low-similarity pair proposed for completeness',
};

export const QUEUE_PRIORITY: Record<MatchType, QueuePriority> = {
  identical: 'low',
  near_duplicate: 'medium',
  functional_equivalent: 'medium',
  needs_review: 'high',
  different: 'low',
};

/**
 * Step 9: the stored decision state of an existing decided candidate row
 * (audit reconciliation for 'on'-mode skips). Falls back to the row status
 * if evidence JSON is unavailable.
 */
function existingStateOf(runtime: CmiShortCircuitRuntime, a: number, b: number): string {
  const existing = runtime.decidedStatusById?.get(
    a < b ? a * 4294967296 + b : b * 4294967296 + a
  );
  return existing?.state ?? 'UNKNOWN';
}

/** Run the full matching pipeline for all active cross-org material pairs. */
export function runMatching(actor: string): MatchRunSummary {
  const started = Date.now();
  const runId = `run_${Date.now()}`;
  const materials = listAllMaterialsForMatching();
  // Run-scoped representation cache: per-material embeddings/token sets are
  // built once and reused for every candidate pair of THIS run (Step 2).
  const runtime = new MatchingRunCache();
  // Step 5: the persistence-floor fast path (MATCH_PREFILTER=off restores
  // the legacy score-everything path). Streaming enumeration replaces the
  // O(pairs) array; the count pass is a cheap deterministic re-enumeration.
  const fastPath = prefilterEnabled();
  const totalPairs = countPairs(materials, runtime);
  // Step 9: CMI short-circuit (off by default; shadow counts only; 'on'
  // skips re-scoring of DECIDED same-CMI pairs — their rows are preserved
  // verbatim, and upsertMatch's status guard would ignore those writes).
  const cmiMode = cmiShortCircuitMode();
  const cmiRuntime: CmiShortCircuitRuntime = makeCmiRuntime(cmiMode);

  return withTransaction(() => {
    deletePendingMatches();
    let candidatesCreated = 0;
    let reviewItemsCreated = 0;
    let droppedNotAMatch = 0;
    let droppedByPrefilter = 0;
    let cmiShortCircuited = 0;
    const droppedByState: Record<string, number> = {};
    const byDecision: Record<string, number> = {};
    for (const [a, b] of iteratePairs(materials, runtime)) {
      // Step 9: same-active-CMI pairs. shadow: count and continue to normal
      // scoring. on: skip ONLY decided pairs (fail-safe: anything else is
      // scored normally).
      const cmiVerdict = evaluateCmiPair(cmiRuntime, a.id, b.id, cmiMode);
      if (cmiVerdict.eligible) {
        trackCmiPair(cmiRuntime, cmiVerdict, a.id, b.id);
        if (cmiMode === 'shadow') {
          // Detection only: the pair continues through normal scoring.
          cmiShortCircuited++;
        } else if (cmiVerdict.skippable) {
          cmiShortCircuited++;
          trackCmiSkip(cmiRuntime, existingStateOf(cmiRuntime, a.id, b.id));
          continue;
        }
      }
      // Step 5: evaluate the cheap core, apply the pipeline drop rule, and
      // pay the explanation/evidence tail ONLY for survivors. Bit-identical
      // to the legacy score-everything path (scorePair = core + tail).
      const core = scorePairCore(a, b, runtime);
      const keep = survivesPersistenceFloor(core);
      if (fastPath) {
        if (!keep) {
          // Fast path: sub-floor pairs skip the tail and stay out of
          // byDecision; droppedByPrefilter (+ per-state breakdown) preserves
          // the audit totals the legacy run would have produced.
          droppedByPrefilter++;
          droppedByState[core.decision.state] = (droppedByState[core.decision.state] ?? 0) + 1;
          continue;
        }
        // Only pairs that survive (and get persisted) count in byDecision.
        byDecision[core.decision.state] = (byDecision[core.decision.state] ?? 0) + 1;
      } else {
        // Legacy accounting: every scored pair is counted per decision state
        // (NOT_A_MATCH included), THEN the drop rule applies — audit details
        // remain byte-identical to the pre-Step-5 run.
        byDecision[core.decision.state] = (byDecision[core.decision.state] ?? 0) + 1;
        if (!keep) {
          droppedNotAMatch++;
          continue;
        }
      }
      const score = finishPair(a, b, core);
      const inserted = upsertMatch({
        sourceMaterialId: a.id,
        candidateMaterialId: b.id,
        semanticScore: score.semanticScore,
        fuzzyScore: score.fuzzyScore,
        technicalScore: score.technicalScore,
        categoryCompatible: score.categoryCompatible,
        finalScore: score.finalScore,
        matchType: score.matchType,
        explanation: score.explanation,
        criticalDifference: score.criticalDifference,
        evidence: JSON.stringify(score.evidence),
        matchRunId: runId,
      });
      if (inserted.created) candidatesCreated++;
      const enqueued = enqueueReview({
        matchId: inserted.id,
        priority: QUEUE_PRIORITY[score.matchType],
        reason: QUEUE_REASON[score.matchType],
        criticalDifference: score.criticalDifference,
      });
      if (enqueued) reviewItemsCreated++;
    }
    recordAudit({
      action: 'match_generated',
      entityType: 'match_run',
      actor,
      details: { runId, pairsCompared: totalPairs, candidatesCreated, reviewItemsCreated, byDecision, droppedNotAMatch, droppedByPrefilter, droppedByState, prefilterEnabled: fastPath, cmiShortCircuit: cmiMode, cmiShortCircuited, cmiIds: [...cmiRuntime.cmiIds].sort((x, y) => x - y), cmiMaterialIds: [...cmiRuntime.materialIds].sort((x, y) => x - y) },
    });
    // Data-integrity guard: any queue row pointing at a decided match is closed.
    getDb()
      .prepare(
        `UPDATE review_queue SET status = 'resolved', resolved_at = ?, updated_at = ?
          WHERE status = 'open'
            AND match_id IN (SELECT id FROM match_candidates WHERE status != 'pending')`
      )
      .run(new Date().toISOString(), new Date().toISOString());
    return {
      runId,
      pairsCompared: totalPairs,
      candidatesCreated,
      reviewItemsCreated,
      byDecision,
      droppedNotAMatch,
      droppedByPrefilter,
      droppedByState,
      cmiShortCircuited,
      ...(cmiMode !== 'off'
        ? {
            cmiDetail: {
              cmiIds: [...cmiRuntime.cmiIds].sort((x, y) => x - y),
              materialIds: [...cmiRuntime.materialIds].sort((x, y) => x - y),
              ...(cmiMode === 'on' ? { skippedByState: { ...cmiRuntime.skippedByState } } : {}),
            },
          }
        : {}),
      durationMs: Date.now() - started,
    };
  });
}

/** Decision-state thresholds exposed for UI display (why is this band shown?). */
export function getDecisionBands() {
  return DECISION_THRESHOLDS;
}

/** Apply a reviewer decision to a pending match, with guards + audit. */
export function decideMatch(matchId: number, input: DecisionInput, actor: string): { status: MatchStatus } {
  return withTransaction(() => {
    const match = getMatchRequired(matchId);
    if (match.candidate.status !== 'pending') {
      throw errors.conflict(
        `This match was already ${match.candidate.status} — refresh to see the current state.`
      );
    }
    recordDecision({
      matchId,
      decision: input.decision,
      reviewer: input.reviewer,
      comment: input.comment ?? null,
    });
    const statusMap: Record<Decision, MatchStatus | 'pending'> = {
      approved: 'approved',
      rejected: 'rejected',
      deferred: 'deferred',
      sent_for_review: 'pending',
    };
    const newStatus = statusMap[input.decision];
    setMatchStatus(matchId, newStatus);
    if (input.decision === 'sent_for_review') {
      enqueueReview({
        matchId,
        priority: 'high',
        reason: 'Senior reviewer requested re-assessment',
        criticalDifference: match.candidate.critical_difference,
      });
    } else {
      resolveQueueEntry(matchId);
    }
    const auditAction: Record<Decision, 'proposal_approved' | 'proposal_rejected' | 'proposal_deferred'> = {
      approved: 'proposal_approved',
      rejected: 'proposal_rejected',
      deferred: 'proposal_deferred',
      sent_for_review: 'proposal_deferred',
    };
    recordAudit({
      action: auditAction[input.decision],
      entityType: 'match_candidate',
      entityId: matchId,
      actor: input.reviewer,
      details: { decision: input.decision, comment: input.comment ?? null },
    });
    return { status: newStatus };
  });
}

export interface CreateCmiInput {
  code: string;
  name: string;
  description?: string;
  category: string;
  matchId: number;
}

/** Create a common material identity from an approved match, then map members. */
export function createCmiFromMatch(input: CreateCmiInput, actor: string): { cmiId: number; mappingsCreated: number } {
  return withTransaction(() => {
    const match = getMatchRequired(input.matchId);
    if (match.candidate.status !== 'approved') {
      throw errors.conflict('A common material identity can only be created from an approved match');
    }
    const cmi = createCommonMaterial({
      code: input.code,
      name: input.name,
      description: input.description,
      category: input.category,
      sourceMatchId: input.matchId,
    });
    const orgOf = getDb().prepare(
      `SELECT organization_id, original_code FROM material_records WHERE id = ?`
    );
    const orgA = orgOf.get(match.source.id) as { organization_id: number; original_code: string };
    const orgB = orgOf.get(match.candidateMat.id) as { organization_id: number; original_code: string };
    insertMapping({ cmiId: cmi.id, materialId: match.source.id, organizationId: orgA.organization_id });
    insertMapping({ cmiId: cmi.id, materialId: match.candidateMat.id, organizationId: orgB.organization_id });
    recordAudit({
      action: 'common_material_created',
      entityType: 'common_material',
      entityId: cmi.id,
      actor,
      details: { matchId: input.matchId, code: input.code, category: input.category, mappingsCreated: 2 },
    });
    recordAudit({
      action: 'mapping_created',
      entityType: 'common_material',
      entityId: cmi.id,
      actor,
      details: { matchId: input.matchId, code: input.code, members: [orgA.original_code, orgB.original_code] },
    });
    return { cmiId: cmi.id, mappingsCreated: 2 };
  });
}
