/**
 * Matching engine — multi-signal scoring with explainable classification.
 *
 * Signals: semantic (embedding provider), fuzzy (token Dice), technical
 * (typed attribute comparison), category (explicit compatibility gate).
 * Weights and thresholds come from matching/config; every intermediate value
 * is recorded in the evidence object persisted with the candidate.
 *
 * Hard rule: a critical technical conflict FORCES needs_review regardless of
 * how high the text similarity is. Category incompatibility forces
 * `different`. Missing critical attributes cap the classification — similarity
 * never fills a specification gap.
 */
import { getEmbeddingProvider, cosineSimilarity, cosineFromNorms } from './embedding';
import { getRetrievalStrategy } from './retrieval';
import { fuzzyScore, diceFromTokens, compareTechnical, compareTechnicalPrepared, diceFromUniqueTokens } from './compare';
import { normalizedWeights, THRESHOLDS } from './config';
import { classifyDecision, type DecisionState } from './decision';
import type { MatchingRunCache } from './runtime';
import type { MatchableMaterial, MatchEvidence, MatchType } from './types';

export interface PairScore {
  semanticScore: number;
  fuzzyScore: number;
  technicalScore: number;
  categoryCompatible: boolean;
  finalScore: number;
  matchType: MatchType;
  /** Spec §7 decision state derived from the signals — what the workflow acts on. */
  decision: DecisionState;
  confidenceBand: 'high' | 'review' | 'low' | 'reject';
  explanation: string;
  criticalDifference: string | null;
  evidence: MatchEvidence;
}

/** Weighted final score from the four signals. */
export function weightedFinalScore(signals: {
  semantic: number;
  fuzzy: number;
  technical: number;
  categoryCompatible: boolean;
}): { final: number; contributions: MatchEvidence['weightedContributions'] } {
  const w = normalizedWeights();
  const category = signals.categoryCompatible ? 100 : 0;
  const contributions = {
    semantic: w.semantic * signals.semantic,
    fuzzy: w.fuzzy * signals.fuzzy,
    technical: w.technical * signals.technical,
    category: w.category * category,
  };
  const final = Math.round(contributions.semantic + contributions.fuzzy + contributions.technical + contributions.category);
  return { final, contributions };
}

/** Deterministic classification from signals + technical comparison. */
export function classify(
  signals: { semantic: number; fuzzy: number; technical: number; categoryCompatible: boolean },
  tech: { criticalConflicts: string[]; missingCritical: string[]; assemblyVariation?: boolean }
): { matchType: MatchType; reason: string } {
  const { semantic, fuzzy, technical, categoryCompatible } = signals;

  if (!categoryCompatible) {
    return {
      matchType: 'different',
      reason: `categories are incompatible — text similarity cannot override this gate`,
    };
  }
  if (tech.criticalConflicts.length > 0) {
    return {
      matchType: 'needs_review',
      reason: `critical technical conflict (${tech.criticalConflicts[0]}) — high similarity does not resolve a specification difference`,
    };
  }
  if (tech.assemblyVariation) {
    return {
      matchType: 'needs_review',
      reason: `assembly/kit variation between the two records — the offered configuration differs, equivalence needs human confirmation`,
    };
  }
  if (tech.missingCritical.length > 0 && (semantic >= THRESHOLDS.strongSemantic || fuzzy >= THRESHOLDS.strongFuzzy)) {
    return {
      matchType: 'needs_review',
      reason: `specifications incomplete (${tech.missingCritical.join(', ')}) — similarity cannot confirm equality`,
    };
  }
  if (
    technical >= THRESHOLDS.identicalTechnical &&
    fuzzy >= THRESHOLDS.identicalFuzzy &&
    semantic >= THRESHOLDS.identicalSemantic
  ) {
    return {
      matchType: 'identical',
      reason: `${technical}% technical agreement with ${fuzzy}% description and ${semantic}% semantic similarity`,
    };
  }
  if (technical >= THRESHOLDS.strongTechnical && (fuzzy >= THRESHOLDS.strongFuzzy || semantic >= THRESHOLDS.strongSemantic)) {
    return {
      matchType: 'near_duplicate',
      reason: `strong agreement (${technical}% technical, ${fuzzy}% description, ${semantic}% semantic)`,
    };
  }
  if (
    technical >= THRESHOLDS.moderateTechnical &&
    (fuzzy >= THRESHOLDS.moderateFuzzy || semantic >= THRESHOLDS.strongSemantic)
  ) {
    return {
      matchType: 'functional_equivalent',
      reason: `moderate agreement (${technical}% technical, ${fuzzy}% description) — equivalence needs confirmation`,
    };
  }
  return {
    matchType: 'different',
    reason: `weak agreement (technical ${technical}%, description ${fuzzy}%, semantic ${semantic}%)`,
  };
}

/** Compose the reviewer-facing explanation from actual comparison evidence. */
export function explain(
  a: MatchableMaterial,
  b: MatchableMaterial,
  signals: { semantic: number; fuzzy: number; technical: number; categoryCompatible: boolean },
  tech: ReturnType<typeof compareTechnical>,
  matchType: MatchType,
  reason: string
): string {
  const parts: string[] = [];
  parts.push(
    categoryLine(a, b, signals.categoryCompatible)
  );
  const agreeing = tech.comparisons.filter((c) => c.type === 'EXACT_MATCH' || c.type === 'NORMALIZED_MATCH');
  const close = tech.comparisons.filter((c) => c.type === 'CLOSE_MATCH');
  if (tech.assemblyComparison) {
    parts.push(
      `Assembly configuration: ${a.orgCode} ${a.originalCode}: ${tech.assemblyComparison.valueA}; ${b.orgCode} ${b.originalCode}: ${tech.assemblyComparison.valueB}. Assembly/kit variation detected — technical equivalence requires human review.`
    );
  }
  if (agreeing.length > 0) {
    parts.push(`Attributes agreeing: ${agreeing.map((c) => `${c.attributeName} (${c.valueA})`).join(', ')}.`);
  }
  if (close.length > 0) {
    parts.push(`Attributes within numeric tolerance: ${close.map((c) => c.attributeName).join(', ')}.`);
  }
  if (tech.missingCritical.length > 0) {
    parts.push(`Missing on one side: ${tech.missingCritical.join(', ')} — cannot confirm equality.`);
  }
  if (tech.criticalConflicts.length > 0) {
    parts.push(`Critical difference detected: ${tech.criticalConflicts.join('; ')}.`);
  }
  if (signals.fuzzy >= 85 && signals.fuzzy < 100) {
    parts.push('Descriptions differ mainly by wording or abbreviation.');
  }
  parts.push(`Classified ${matchType.replace(/_/g, ' ')}: ${reason}.`);
  return parts.join(' ');
}

function categoryLine(a: MatchableMaterial, b: MatchableMaterial, compatible: boolean): string {
  return compatible
    ? `Both materials belong to ${a.category}.`
    : `Categories differ: ${a.category} vs ${b.category}.`;
}

/** Score one pair end-to-end, returning persistable results + evidence.
 *
 * `runtime` (optional) is a run-scoped MatchingRunCache: when supplied,
 * per-material embeddings/token sets/attribute indexes are reused across
 * pairs instead of being recomputed. Results are identical either way —
 * the cached path calls the exact same builder functions, asserted by
 * tests/runtime-cache.test.ts over every retrieval pair.
 */
/**
 * CHEAP CORE of pair evaluation — signals (reusing the run cache and/or
 * prefilter-precomputed signals), final score, match type and decision.
 * Everything the persistence rule needs, none of what only evidence needs.
 * Step 5: pipelines call this, apply the pipeline drop rule, and only
 * survivors pay `finishPair` (explanation + evidence construction).
 */
export function scorePairCore(
  a: MatchableMaterial,
  b: MatchableMaterial,
  runtime?: MatchingRunCache
): {
  semantic: number;
  fuzzy: number;
  tech: ReturnType<typeof compareTechnical>;
  categoryCompatible: boolean;
  final: number;
  contributions: MatchEvidence['weightedContributions'];
  matchType: MatchType;
  reason: string;
  decision: { state: PairScore['decision']; reason: string; band: PairScore['confidenceBand'] };
  vecA: number[];
  vecB: number[];
} {
  let vecA: number[];
  let vecB: number[];
  let fuzzy: number;
  let tech: ReturnType<typeof compareTechnical>;
  if (runtime) {
    // Cached path (Step 6): every per-pair value below was moved into the
    // per-material prepared representation — the kernels consume the SAME
    // inputs and produce bitwise-identical numbers (see compare.ts /
    // embedding.ts equivalence notes; asserted per pair by
    // tests/runtime-cache.test.ts and tests/matching-prepared.test.ts).
    const repA = runtime.representation(a);
    const repB = runtime.representation(b);
    vecA = repA.embedding;
    vecB = repB.embedding;
    fuzzy = diceFromUniqueTokens(repA.uniqueFuzzyTokens, repB.uniqueFuzzyTokens, repA.fuzzyTokenCount, repB.fuzzyTokenCount);
    tech = compareTechnicalPrepared(a, b, repA.prepared, repB.prepared);
    // Precomputed norms are valid only when both vectors span the same
    // index range (the uncached kernel norms over min(len); provider vectors
    // are fixed-width, and this guard keeps equivalence unconditional).
    // ×100 + round mirrors the uncached semantic scale exactly.
    const semantic = Math.round(
      cosineFromNorms(vecA, vecB, repA.embeddingNorm, repB.embeddingNorm, vecA.length === vecB.length) * 100
    );
    const categoryCompatible = a.category.trim().toLowerCase() === b.category.trim().toLowerCase();
    const { final, contributions } = weightedFinalScore({
      semantic,
      fuzzy,
      technical: tech.score,
      categoryCompatible,
    });
    const { matchType, reason } = classify(
      { semantic, fuzzy, technical: tech.score, categoryCompatible },
      {
        criticalConflicts: tech.criticalConflicts,
        missingCritical: tech.missingCritical,
        assemblyVariation: tech.assemblyComparison !== null,
      }
    );
    const decision = classifyDecision({
      matchType,
      finalScore: final,
      technicalScore: tech.score,
      categoryCompatible,
      criticalConflicts: tech.criticalConflicts,
      missingCritical: tech.missingCritical,
      manufacturerA: a.manufacturer,
      manufacturerB: b.manufacturer,
      assemblyVariation: tech.assemblyComparison !== null,
    });
    return {
      semantic,
      fuzzy,
      tech,
      categoryCompatible,
      final,
      contributions,
      matchType,
      reason,
      decision: { state: decision.decision, reason: decision.reason, band: decision.band },
      vecA,
      vecB,
    };
  } else {
    const provider = getEmbeddingProvider();
    vecA = provider.generateEmbedding(a.normalizedDescription ?? a.originalDescription);
    vecB = provider.generateEmbedding(b.normalizedDescription ?? b.originalDescription);
    fuzzy = fuzzyScore(a.originalDescription, b.originalDescription);
    tech = compareTechnical(a, b);
  }
  const semantic = Math.round(cosineSimilarity(vecA, vecB) * 100);
  const categoryCompatible = a.category.trim().toLowerCase() === b.category.trim().toLowerCase();

  const { final, contributions } = weightedFinalScore({
    semantic,
    fuzzy,
    technical: tech.score,
    categoryCompatible,
  });
  const { matchType, reason } = classify(
    { semantic, fuzzy, technical: tech.score, categoryCompatible },
    {
      criticalConflicts: tech.criticalConflicts,
      missingCritical: tech.missingCritical,
      assemblyVariation: tech.assemblyComparison !== null,
    }
  );
  const decision = classifyDecision({
    matchType,
    finalScore: final,
    technicalScore: tech.score,
    categoryCompatible,
    criticalConflicts: tech.criticalConflicts,
    missingCritical: tech.missingCritical,
    manufacturerA: a.manufacturer,
    manufacturerB: b.manufacturer,
    assemblyVariation: tech.assemblyComparison !== null,
  });
  return {
    semantic,
    fuzzy,
    tech,
    categoryCompatible,
    final,
    contributions,
    matchType,
    reason,
    decision: { state: decision.decision, reason: decision.reason, band: decision.band },
    vecA,
    vecB,
  };
}

/**
 * EXPENSIVE TAIL of pair evaluation — the reviewer-facing explanation and
 * the persisted evidence object. Called ONLY for pairs the pipeline keeps.
 */
export function finishPair(
  a: MatchableMaterial,
  b: MatchableMaterial,
  core: ReturnType<typeof scorePairCore>
): PairScore {
  const { semantic, fuzzy, tech, categoryCompatible, final, contributions, matchType, reason } = core;
  const explanation = explain(a, b, { semantic, fuzzy, technical: tech.score, categoryCompatible }, tech, matchType, reason);
  const w = normalizedWeights();
  // Provider metadata is process-wide and part of the persisted evidence —
  // identical in cached and uncached paths (singleton lookup only).
  const provider = getEmbeddingProvider();
  const evidence: MatchEvidence = {
    provider: { name: provider.name, isFallback: provider.isFallback },
    semanticSimilarity: semantic,
    fuzzySimilarity: fuzzy,
    categoryCompatibility: categoryCompatible,
    technicalScore: tech.score,
    weights: w,
    weightedContributions: contributions,
    attributeComparisons: tech.comparisons,
    criticalConflicts: tech.criticalConflicts,
    missingCritical: tech.missingCritical,
    decisionReason: reason,
    decision: { state: core.decision.state, reason: core.decision.reason, band: core.decision.band },
    thresholds: THRESHOLDS as unknown as Record<string, number>,
    assemblyConfiguration: tech.assemblyComparison
      ? { materialA: tech.assemblyComparison.valueA ?? 'Unknown', materialB: tech.assemblyComparison.valueB ?? 'Unknown', detail: tech.assemblyComparison.detail }
      : null,
  };

  return {
    semanticScore: semantic,
    fuzzyScore: fuzzy,
    technicalScore: tech.score,
    categoryCompatible,
    finalScore: final,
    matchType,
    decision: core.decision.state,
    confidenceBand: core.decision.band,
    explanation,
    criticalDifference: tech.criticalConflicts[0] ?? null,
    evidence,
  };
}

/**
 * Full pair score — the pre-Step-5 behavior preserved verbatim:
 * cheap core (signals → final → decision) followed by the expensive tail
 * (explanation + evidence). Pipelines use scorePairCore + the drop rule +
 * finishPair so sub-floor pairs never pay the tail.
 */
export function scorePair(
  a: MatchableMaterial,
  b: MatchableMaterial,
  runtime?: MatchingRunCache
): PairScore {
  const core = scorePairCore(a, b, runtime);
  return finishPair(a, b, core);
}

/**
 * Orient one candidate pair exactly like the legacy pipeline: the material
 * from the smaller organizationId first, so reruns stay stable.
 */
function orientPair({ a, b }: { a: MatchableMaterial; b: MatchableMaterial }): [MatchableMaterial, MatchableMaterial] {
  return a.organizationId < b.organizationId ? [a, b] : [b, a];
}

/**
 * Streaming candidate enumeration — yields the SAME oriented pairs as
 * `generatePairs` in the SAME order, without materializing the O(pairs)
 * array (Step 5). Matching pipelines iterate this instead of holding
 * millions of pair objects in memory.
 */
export function* iteratePairs(
  materials: MatchableMaterial[],
  runtime?: MatchingRunCache
): Generator<[MatchableMaterial, MatchableMaterial]> {
  const strategy = getRetrievalStrategy();
  const source = strategy.iterate ? strategy.iterate(materials, runtime) : strategy.findCandidates(materials, runtime);
  for (const pair of source) {
    yield orientPair(pair);
  }
}

/**
 * Number of oriented candidate pairs — the exact length `generatePairs`
 * would return. Consumes the streaming enumeration (deterministic, cheap
 * relative to scoring) so job bookkeeping (total_candidates, chunk plan)
 * stays identical without materializing the array.
 */
export function countPairs(materials: MatchableMaterial[], runtime?: MatchingRunCache): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _pair of iteratePairs(materials, runtime)) n++;
  return n;
}

/**
 * All candidate pairs via the retrieval strategy. Pair order is normalised
 * (a.organizationId < b.organizationId) so reruns stay stable. Array form of
 * `iteratePairs` — retained for tests and small corpora; the production
 * pipelines use the streaming form.
 */
export function generatePairs(
  materials: MatchableMaterial[],
  runtime?: MatchingRunCache
): Array<[MatchableMaterial, MatchableMaterial]> {
  return [...iteratePairs(materials, runtime)];
}
