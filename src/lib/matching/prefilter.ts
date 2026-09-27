/**
 * Step 5 — the persistence-floor fast path (lossless by construction).
 *
 * Both matching pipelines (legacy `runMatching` and the chunked job runner)
 * have ALWAYS dropped a candidate pair after full scoring iff:
 *
 *   score.decision === 'NOT_A_MATCH' || score.finalScore < DECISION_THRESHOLDS.notAMatch
 *
 * Step 5 restructures evaluation into a cheap core and an expensive tail:
 *
 *   scorePairCore(a, b, runtime)  — signals (run-cached), final score, match
 *                                   type, decision                  [cheap]
 *   finishPair(a, b, core)        — explanation strings + the persisted
 *                                   evidence object                 [expensive]
 *
 * `survivesPersistenceFloor` is THE drop rule, applied to the core BEFORE the
 * tail is built, so pairs the pipeline would drop anyway never pay for
 * evidence construction. This is not an approximation of the pipeline's
 * behavior — it IS the pipeline's behavior, evaluated earlier:
 *
 *   - The predicate operates on the core's own `decision` and `final`, the
 *     exact values `scorePair` persists (scorePair = core + tail, verbatim).
 *   - Survivors continue through the untouched `finishPair`, so every
 *     persisted row is bit-identical to the pre-Step-5 pipeline.
 *   - Recall of HIGH_CONFIDENCE_MATCH / NEEDS_TECHNICAL_REVIEW pairs above
 *     the floor is 100% BY CONSTRUCTION — nothing but the tail is skipped.
 *
 * Note the legacy rule's second disjunct: a pair with critical conflicts and
 * a final score below the floor classifies NEEDS_TECHNICAL_REVIEW (conflict
 * rules precede the floor check in classifyDecision) but is dropped by
 * `finalScore < notAMatch`. That pre-existing behavior is preserved verbatim
 * — the fast path drops exactly what the legacy path drops.
 *
 * The reduction share therefore equals the pipeline's own NOT_A_MATCH /
 * sub-floor share — pairs that were never persisted are pure wasted tail
 * work. It is data-dependent: realistic long material-master descriptions
 * separate strongly (large drop share); short synthetic descriptions cluster
 * above the floor (small share).
 *
 * Memory: candidate enumeration is streaming (iteratePairs — O(1) pairs in
 * flight), and per-material signals live in the run-scoped MatchingRunCache.
 * No pair-keyed structure exists anywhere in the pipeline.
 *
 * Env: MATCH_PREFILTER=off restores the pre-Step-5 score-everything
 * accounting exactly (every pair pays the tail and keeps its byDecision
 * entry). The default is enabled because the drop verdict is the pipeline's
 * own.
 */
import { DECISION_THRESHOLDS } from './decision';

/** True unless MATCH_PREFILTER=off (the pre-Step-5 score-everything path). */
export function prefilterEnabled(): boolean {
  return process.env.MATCH_PREFILTER !== 'off';
}

/**
 * The parts of scorePairCore's return the persistence rule reads. Declared
 * structurally so the rule cannot depend on anything the cheap core does not
 * already compute.
 */
export interface PersistenceVerdict {
  final: number;
  decision: { state: string };
}

/**
 * THE pipeline drop rule, single source of truth for both matching pipelines:
 *
 *   drop  ⇔  decision === 'NOT_A_MATCH' || final < DECISION_THRESHOLDS.notAMatch
 *   keep  ⇔  decision !== 'NOT_A_MATCH' && final ≥ DECISION_THRESHOLDS.notAMatch
 *
 * Applied to the cheap core before the expensive tail; survivors are
 * persisted through the untouched finishPair, so persisted output is
 * bit-identical to the legacy score-everything pipeline.
 */
export function survivesPersistenceFloor(core: PersistenceVerdict): boolean {
  return core.decision.state !== 'NOT_A_MATCH' && core.final >= DECISION_THRESHOLDS.notAMatch;
}
