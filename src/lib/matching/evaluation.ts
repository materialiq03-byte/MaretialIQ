/**
 * Matcher quality evaluation against a labelled synthetic ground-truth set
 * (PRD §15, TRD §34 "Metrics" row).
 *
 * The labels are derived from the CONSTRUCTION of the synthetic dataset in
 * data/synthetic-imports/*.csv — each record was authored to represent a
 * specific real-world item, so "same item" groups and "different item /
 * conflicting variant" pairs are known by design, not guessed by the engine.
 *
 * Evaluation protocol (documented for reviewers):
 *   • Universe  — every labelled cross-organization pair in the dataset
 *   • Positive  — both records represent the SAME item AND brand/variant
 *   • Negative  — same family but a materially different item, spec or
 *                 brand-conflicting variant (e.g. 2RS vs ZZ, 415V vs 230V,
 *                 Class 150 vs 300, different sizes, different brands)
 *   • Prediction— engine decision HIGH_CONFIDENCE_MATCH counts as "match";
 *                 review / low / not-a-match count as "not auto-matched"
 *   A pair the engine routes to review instead of auto-approving is a TRUE
 *   NEGATIVE when labelled negative — that is exactly the fail-safe behaviour
 *   the product is supposed to exhibit.
 *
 * Ambiguous pairs (same designation, different manufacturer — deliberately
 * part of the demo) are labelled NEGATIVE: with our §9 cross-brand rule the
 * engine must NOT auto-approve them, so counting them as positives would
 * reward unsafe behaviour.
 */
import { listAllMaterialsForMatching } from '../db/repositories/matching-queries';
import { scorePair } from './engine';
import type { MatchableMaterial } from './types';

/** Same-item groups from the synthetic dataset (brand-consistent). */
export const SAME_ITEM_GROUPS: string[][] = [
  // SKF 6308-2RS deep groove ball bearing (CPCL/NTPC/NLC/SAIL)
  ['CPCL|CP-6001', 'NTPC|NT-6401', 'NLC|NL-7701', 'SAIL|SL-9901'],
  // Gate valve 2" 150# RF WCB (AUDCO)
  ['CPCL|CP-6002', 'BHEL|BH-3002', 'NLC|NL-7702', 'SAIL|SL-9902'],
  // KSB centrifugal pump 4x3-10 cast iron
  ['CPCL|CP-6003', 'NTPC|NT-6403', 'BHEL|BH-3003', 'NLC|NL-7703', 'SAIL|SL-9903'],
  // Ball valve 1" 150# SS316 (AUDCO)
  ['CPCL|CP-6004', 'NTPC|NT-6404', 'NLC|NL-7705'],
  // Siemens 30KW 415V B3 induction motor
  ['CPCL|CP-6005', 'NTPC|NT-6405', 'BHEL|BH-3006', 'SAIL|SL-9905'],
  // Hex bolt M20x80 SS304 A2-70
  ['CPCL|CP-6006', 'NTPC|NT-6406'],
  // FAG spherical roller 22216 E (brand-consistent positives only)
  ['CPCL|CP-6007', 'SAIL|SL-9907'],
  // SKF spherical roller 22216 E
  ['BHEL|BH-3007', 'NLC|NL-7707'],
  // Globe valve 4" 300# A216 WCB (L&T)
  ['CPCL|CP-6008', 'SAIL|SL-9908'],
  // SKF 6309-2RS C3
  ['NTPC|NT-6408', 'NLC|NL-7709'],
  // Hex bolt M16x65 SS316
  ['BHEL|BH-3004', 'NLC|NL-7704', 'SAIL|SL-9904'],
  // SKF 6310-2RS C3
  ['CPCL|CP-6009', 'SAIL|SL-9909'],
  // KSB centrifugal pump 6x4-14 cast iron
  ['CPCL|CP-6010', 'SAIL|SL-9910'],
  // Butterfly valve 8" 150# cast iron (AUDCO)
  ['BHEL|BH-3008', 'NLC|NL-7708'],
];

/**
 * Conflicting / different-item pairs: similar family, but a technical rule or
 * attribute difference means they must NOT be auto-matched. Labelled from the
 * dataset design (seal, voltage, pressure class, size, type, brand conflicts).
 */
export const CONFLICT_PAIRS: Array<[string, string]> = [
  // Bearing seal conflicts: 2RS vs ZZ
  ['CPCL|CP-6001', 'BHEL|BH-3001'],
  ['NTPC|NT-6401', 'BHEL|BH-3001'],
  ['NLC|NL-7701', 'BHEL|BH-3001'],
  ['SAIL|SL-9901', 'BHEL|BH-3001'],
  ['CPCL|CP-6009', 'BHEL|BH-3009'],
  ['SAIL|SL-9909', 'BHEL|BH-3009'],
  ['NTPC|NT-6408', 'BHEL|BH-3009'],
  ['NLC|NL-7709', 'BHEL|BH-3009'],
  // Same designation, different manufacturer (cross-brand rule)
  ['CPCL|CP-6007', 'BHEL|BH-3007'],
  ['CPCL|CP-6007', 'NLC|NL-7707'],
  ['SAIL|SL-9907', 'BHEL|BH-3007'],
  ['SAIL|SL-9907', 'NLC|NL-7707'],
  // Motor voltage conflict: 415V vs 230V
  ['CPCL|CP-6005', 'BHEL|BH-3005'],
  ['NTPC|NT-6405', 'BHEL|BH-3005'],
  ['SAIL|SL-9905', 'BHEL|BH-3005'],
  ['BHEL|BH-3006', 'BHEL|BH-3005'],
  // Valve pressure-class conflict: 150# vs 300#
  ['CPCL|CP-6002', 'NTPC|NT-6402'],
  ['BHEL|BH-3002', 'NTPC|NT-6402'],
  ['NLC|NL-7702', 'NTPC|NT-6402'],
  ['SAIL|SL-9902', 'NTPC|NT-6402'],
  // Globe valve 150# vs 300#
  ['CPCL|CP-6008', 'NTPC|NT-6407'],
  ['SAIL|SL-9908', 'NTPC|NT-6407'],
  // Bearing series conflicts: 6308 vs 6309 / 6310
  ['CPCL|CP-6001', 'NTPC|NT-6408'],
  ['CPCL|CP-6001', 'CPCL|CP-6009'],
  ['NTPC|NT-6401', 'SAIL|SL-9909'],
  // Bearing type conflicts
  ['BHEL|BH-3011', 'CPCL|CP-6001'],
  ['BHEL|BH-3011', 'BHEL|BH-3007'],
  ['BHEL|BH-3011', 'NLC|NL-7707'],
  // Pump type/size conflicts
  ['CPCL|CP-6003', 'NTPC|NT-6409'],
  ['CPCL|CP-6010', 'CPCL|CP-6003'],
  ['SAIL|SL-9910', 'NTPC|NT-6403'],
  ['CPCL|CP-6010', 'NTPC|NT-6409'],
  // Valve type conflicts
  ['NTPC|NT-6410', 'CPCL|CP-6004'],
  ['NTPC|NT-6410', 'BHEL|BH-3008'],
  ['NTPC|NT-6410', 'CPCL|CP-6002'],
  // Fastener type/size conflicts
  ['CPCL|CP-6006', 'NLC|NL-7706'],
  ['CPCL|CP-6006', 'SAIL|SL-9906'],
  ['CPCL|CP-6006', 'NLC|NL-7710'],
  ['BHEL|BH-3004', 'CPCL|CP-6006'],
  ['NLC|NL-7704', 'NLC|NL-7706'],
  ['SAIL|SL-9904', 'SAIL|SL-9906'],
];

export interface EvaluationMetrics {
  /** labelled pairs scored */
  evaluatedPairs: number;
  positives: number;
  negatives: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** share of evaluated pairs the engine routes to NEEDS_TECHNICAL_REVIEW */
  humanReviewRate: number;
  /** negative pairs correctly NOT auto-approved (the fail-safe metric) */
  conflictsCaught: number;
  /** negative pairs the engine wrongly auto-approved */
  unsafeAutoMatches: number;
}

/** Evaluate the engine over the labelled synthetic ground truth. */
export function evaluateAgainstGroundTruth(): EvaluationMetrics {
  const materials = listAllMaterialsForMatching();
  const byKey = new Map<string, MatchableMaterial>();
  for (const m of materials) byKey.set(`${m.orgCode}|${m.originalCode}`, m);

  const positives: Array<[string, string]> = [];
  for (const group of SAME_ITEM_GROUPS) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) positives.push([group[i], group[j]]);
    }
  }

  let tp = 0, fp = 0, tn = 0, fn = 0, review = 0, caught = 0, unsafe = 0;
  let evaluated = 0;

  const judge = (aKey: string, bKey: string, expectMatch: boolean): void => {
    const a = byKey.get(aKey);
    const b = byKey.get(bKey);
    if (!a || !b) return; // record absent (e.g. trimmed dataset) — skip pair
    evaluated++;
    const s = scorePair(a, b);
    const predictedMatch = s.decision === 'HIGH_CONFIDENCE_MATCH';
    if (s.decision === 'NEEDS_TECHNICAL_REVIEW') review++;
    if (expectMatch) {
      if (predictedMatch) tp++; else fn++;
    } else {
      if (predictedMatch) { fp++; unsafe++; } else { tn++; caught++; }
    }
  };

  for (const [a, b] of positives) judge(a, b, true);
  for (const [a, b] of CONFLICT_PAIRS) judge(a, b, false);

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    evaluatedPairs: evaluated,
    positives: tp + fn,
    negatives: tn + fp,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision,
    recall,
    f1,
    humanReviewRate: evaluated > 0 ? review / evaluated : 0,
    conflictsCaught: caught,
    unsafeAutoMatches: unsafe,
  };
}
