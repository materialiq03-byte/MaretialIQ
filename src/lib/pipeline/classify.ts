/**
 * Deterministic category classification.
 *
 * Transparent keyword rules over the normalized token list. The result shape
 * is designed to be replaceable: an ML classifier later would produce the
 * same `ClassificationResult` with a different `source`.
 */
import { normalizeTokens } from './normalize';

export const CATEGORIES = ['Bearings', 'Valves', 'Motors', 'Pumps', 'Fasteners'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Whole-token or substring rules per category, evaluated in declaration order. */
export const CATEGORY_RULES: Record<Category, string[]> = {
  Bearings: ['BEARING', 'BRG', 'BALL'],
  Valves: ['VALVE', 'VLV', 'GATE', 'GLOBE', 'BUTTERFLY', 'CHECK'],
  Motors: ['MOTOR', 'MTR', 'INDUCTION'],
  Pumps: ['PUMP', 'PMP', 'CENTRIFUGAL', 'MONOBLOCK', 'SUBMERSIBLE'],
  Fasteners: ['BOLT', 'NUT', 'SCREW', 'WASHER', 'STUD'],
};

export interface ClassificationResult {
  category: Category | null;
  subcategory: string | null;
  /** Rule-derived: matched signals ÷ signals available. Never a model score. */
  confidence: number | null;
  /** e.g. 'rule:keyword'. ML would supply e.g. 'classifier_model:v1'. */
  source: string;
}

function matchToken(token: string, rule: string): boolean {
  if (token === rule) return true;
  // Plural tolerance: BOLTS→BOLT, BEARINGS→BEARING (never for short codes).
  if (rule.length > 3 && token === `${rule}S`) return true;
  // Substring support only for abbreviation-style rules (BRG, VLV, MTR, PMP):
  // "BRG6205" counts for Bearings; "BEARING" never matches unrelated words.
  if (rule.length <= 3) return token.includes(rule);
  return false;
}

/** Classify from an already-normalized description string. */
export function classifyDescription(normalizedDescription: string): ClassificationResult {
  const tokens = normalizedDescription.split(/\s+/).filter(Boolean);
  const hits: Array<{ category: Category; token: string; rule: string }> = [];
  for (const category of CATEGORIES) {
    for (const token of tokens) {
      for (const rule of CATEGORY_RULES[category]) {
        if (matchToken(token, rule)) {
          hits.push({ category, token, rule });
        }
      }
    }
  }

  const counts = new Map<Category, number>();
  for (const h of hits) counts.set(h.category, (counts.get(h.category) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) {
    return { category: null, subcategory: null, confidence: null, source: 'rule:keyword' };
  }

  const [best, bestCount] = ranked[0];
  const totalSignals = ranked.reduce((sum, [, n]) => sum + n, 0);
  // Confidence = share of keyword signals pointing at the winning category,
  // penalised when competing categories also fired (ambiguity lowers it).
  const confidence = totalSignals > 0 ? Math.round((bestCount * 100) / totalSignals) : null;

  return {
    category: best,
    subcategory: deriveSubcategory(best, tokens),
    confidence,
    source: 'rule:keyword',
  };
}

const SUBCATEGORY_RULES: Record<Category, Array<{ match: string; label: string }>> = {
  Bearings: [
    { match: 'BALL', label: 'Ball bearings' },
    { match: 'ROLLER', label: 'Roller bearings' },
    { match: 'BEARING', label: 'Bearings' },
  ],
  Valves: [
    { match: 'GATE', label: 'Gate valves' },
    { match: 'GLOBE', label: 'Globe valves' },
    { match: 'BUTTERFLY', label: 'Butterfly valves' },
    { match: 'VALVE', label: 'Valves' },
  ],
  Motors: [
    { match: 'INDUCTION', label: 'Induction motors' },
    { match: 'MOTOR', label: 'Motors' },
  ],
  Pumps: [
    { match: 'CENTRIFUGAL', label: 'Centrifugal pumps' },
    { match: 'SUBMERSIBLE', label: 'Submersible pumps' },
    { match: 'MONOBLOCK', label: 'Monoblock pumps' },
    { match: 'PUMP', label: 'Pumps' },
  ],
  Fasteners: [
    { match: 'BOLT', label: 'Bolts' },
    { match: 'NUT', label: 'Nuts' },
    { match: 'SCREW', label: 'Screws' },
    { match: 'WASHER', label: 'Washers' },
    { match: 'STUD', label: 'Studs' },
  ],
};

function deriveSubcategory(category: Category, tokens: string[]): string | null {
  for (const rule of SUBCATEGORY_RULES[category]) {
    if (tokens.some((t) => t.includes(rule.match))) return rule.label;
  }
  return null;
}
