/**
 * Prototype decision states.
 *
 * The five match classifications (identical, near_duplicate,
 * functional_equivalent, needs_review, different) are what the matcher
 * compares; the four decision states below are what the review workflow acts
 * on. The mapping is intentionally boring and fully rule-derived:
 *
 *   HIGH_CONFIDENCE_MATCH     — high score, no critical conflict, attributes agree
 *   NEEDS_TECHNICAL_REVIEW    — critical conflict, OR score in the review band,
 *                               OR incomplete specification on a strong pair
 *   LOW_CONFIDENCE            — weak evidence, kept for completeness
 *   NOT_A_MATCH               — categories incompatible or evidence below floor
 *
 * PROTOTYPE thresholds — not an official standard and not a CPSE methodology.
 */
import { THRESHOLDS } from './config';
import type { MatchType } from './types';

export const DECISION_STATES = [
  'HIGH_CONFIDENCE_MATCH',
  'NEEDS_TECHNICAL_REVIEW',
  'LOW_CONFIDENCE',
  'NOT_A_MATCH',
] as const;

export type DecisionState = (typeof DECISION_STATES)[number];

/** Human-readable labels used in the UI. */
export const DECISION_STATE_LABELS: Record<DecisionState, string> = {
  HIGH_CONFIDENCE_MATCH: 'High-confidence match',
  NEEDS_TECHNICAL_REVIEW: 'Needs technical review',
  LOW_CONFIDENCE: 'Low confidence',
  NOT_A_MATCH: 'Not a match',
};

/**
 * Score bands (configurable via env; see matching/config). A pair must clear
 * the high band on the combined score AND show no unresolved critical signal
 * to be called HIGH_CONFIDENCE_MATCH.
 */
export const DECISION_THRESHOLDS = {
  /** minimum combined score for HIGH_CONFIDENCE_MATCH */
  highConfidence: num(process.env.MATCH_T_DECISION_HIGH, 80),
  /** minimum combined score below which a non-conflicting pair is LOW_CONFIDENCE */
  reviewFloor: num(process.env.MATCH_T_DECISION_REVIEW_FLOOR, 60),
  /** below this the pair is NOT_A_MATCH and is not persisted at all */
  notAMatch: num(process.env.MATCH_T_DECISION_NOT_A_MATCH, 30),
};

function num(value: string | undefined, fallback: number): number {
  const n = value ? parseFloat(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export interface DecisionInput {
  matchType: MatchType;
  finalScore: number;
  technicalScore: number;
  categoryCompatible: boolean;
  criticalConflicts: string[];
  missingCritical: string[];
  /**
   * Manufacturer of each side, when both are known. A pair from two different
   * named manufacturers is never auto-declared equivalent: cross-brand
   * interchange is a procurement/engineering judgement, not something text or
   * attribute agreement can prove. Such pairs still surface as candidates, but
   * always route through human review (spec §9).
   */
  manufacturerA?: string | null;
  manufacturerB?: string | null;
  /**
   * True when the two records differ in assembly/kit configuration (e.g. a
   * bare bolt vs the same bolt offered WITH NUT). Attribute comparison cannot
   * see the extra component, so the pair must go to human review regardless
   * of how similar the text looks — the configuration may or may not change
   * the procurement identity.
   */
  assemblyVariation?: boolean;
}

export interface DecisionResult {
  decision: DecisionState;
  /** machine-readable rule that fired, recorded in evidence */
  reason: string;
  /** which confidence band the combined score falls into */
  band: 'high' | 'review' | 'low' | 'reject';
}

/** Rule-derived decision state for one candidate pair. */
export function classifyDecision(input: DecisionInput): DecisionResult {
  const { matchType, finalScore, categoryCompatible, criticalConflicts, missingCritical, manufacturerA, manufacturerB } = input;

  if (!categoryCompatible) {
    return { decision: 'NOT_A_MATCH', reason: 'categories are incompatible — pair excluded from equivalence', band: 'reject' };
  }
  if (criticalConflicts.length > 0) {
    return { decision: 'NEEDS_TECHNICAL_REVIEW', reason: `critical technical conflict: ${criticalConflicts[0]}`, band: 'review' };
  }
  if (finalScore < DECISION_THRESHOLDS.notAMatch) {
    return { decision: 'NOT_A_MATCH', reason: `combined score ${finalScore}% is below the ${DECISION_THRESHOLDS.notAMatch}% floor`, band: 'reject' };
  }
  if (input.assemblyVariation) {
    return {
      decision: 'NEEDS_TECHNICAL_REVIEW',
      reason: 'assembly/kit configuration differs between the records — the extra component may or may not change the procurement identity, so a human decides',
      band: 'review',
    };
  }
  const manufacturersDiffer =
    Boolean(manufacturerA) &&
    Boolean(manufacturerB) &&
    manufacturerA!.trim().toUpperCase() !== manufacturerB!.trim().toUpperCase();
  if (finalScore >= DECISION_THRESHOLDS.highConfidence && missingCritical.length === 0 && !manufacturersDiffer) {
    return { decision: 'HIGH_CONFIDENCE_MATCH', reason: `combined score ${finalScore}% with no critical difference and complete attributes`, band: 'high' };
  }
  if (manufacturersDiffer && finalScore >= DECISION_THRESHOLDS.highConfidence) {
    return {
      decision: 'NEEDS_TECHNICAL_REVIEW',
      reason: `different manufacturers (${manufacturerA} vs ${manufacturerB}) with high score ${finalScore}% — cross-brand equivalence requires engineering validation`,
      band: 'review',
    };
  }
  if (finalScore >= DECISION_THRESHOLDS.reviewFloor || matchType === 'needs_review') {
    return {
      decision: 'NEEDS_TECHNICAL_REVIEW',
      reason:
        missingCritical.length > 0
          ? `score ${finalScore}% but specification incomplete (${missingCritical.join(', ')}) — evidence insufficient to confirm equivalence`
          : `score ${finalScore}% is in the review band (${DECISION_THRESHOLDS.reviewFloor}–${DECISION_THRESHOLDS.highConfidence}%)`,
      band: 'review',
    };
  }
  return { decision: 'LOW_CONFIDENCE', reason: `combined score ${finalScore}% — weak evidence, kept for completeness`, band: 'low' };
}

/**
 * Which decision states are worth showing as actionable work in the UI.
 * NOT_A_MATCH pairs are stored only for auditability and never queued.
 */
export const ACTIONABLE_DECISIONS: DecisionState[] = ['HIGH_CONFIDENCE_MATCH', 'NEEDS_TECHNICAL_REVIEW'];

export { THRESHOLDS };
