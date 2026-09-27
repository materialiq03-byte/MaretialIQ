/**
 * Shared matching-domain types. Kept independent of persistence so the engine
 * stays testable and the future pgvector/pg layer can reuse them.
 */

export interface MaterialAttributeLite {
  attributeName: string;
  value: string;
  normalizedValue: string | null;
  unit: string | null;
  isCritical: boolean;
}

/** The shape the engine consumes. Produced by db/repositories/matching-queries. */
export interface MatchableMaterial {
  id: number;
  organizationId: number;
  orgCode: string;
  originalCode: string;
  originalDescription: string;
  normalizedDescription: string | null;
  category: string;
  manufacturer: string | null;
  model: string | null;
  partNumber: string | null;
  uom: string;
  attributes: MaterialAttributeLite[];
}

/** Comparison outcome for one attribute name across two records. */
export type ComparisonType =
  | 'EXACT_MATCH'
  | 'NORMALIZED_MATCH'
  | 'CLOSE_MATCH'
  | 'MISSING'
  | 'CONFLICT'
  | 'NOT_APPLICABLE';

export interface AttributeComparison {
  attributeName: string;
  type: ComparisonType;
  valueA: string | null;
  valueB: string | null;
  critical: boolean;
  detail: string;
}

/** Structured evidence persisted with every candidate. */
import type { DecisionState } from './decision';

export interface MatchEvidence {
  provider: { name: string; isFallback: boolean };
  semanticSimilarity: number;
  fuzzySimilarity: number;
  categoryCompatibility: boolean;
  technicalScore: number;
  weights: { semantic: number; fuzzy: number; technical: number; category: number };
  weightedContributions: { semantic: number; fuzzy: number; technical: number; category: number };
  attributeComparisons: AttributeComparison[];
  criticalConflicts: string[];
  missingCritical: string[];
  decisionReason: string;
  /** Spec §7 decision state with the exact rule that produced it. */
  decision: { state: DecisionState; reason: string; band: 'high' | 'review' | 'low' | 'reject' };
  thresholds: Record<string, number>;
  /** Non-null when the two records differ in assembly/kit configuration. */
  assemblyConfiguration: { materialA: string; materialB: string; detail: string } | null;
}

export type MatchType =
  | 'identical'
  | 'functional_equivalent'
  | 'near_duplicate'
  | 'needs_review'
  | 'different';
