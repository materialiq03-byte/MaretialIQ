/**
 * Three-class matcher evaluation against a hand-labelled ground-truth dataset.
 *
 * SEPARATE from `evaluation.ts` (the §34 binary same-item/conflict metric over
 * the seed dataset). This module scores the explicit pair list in
 * `data/evaluation/ground-truth-pairs.json` through the REAL matching pipeline
 * (scorePair — same embedding, fuzzy, technical and decision code the product
 * runs) and aggregates honest prototype metrics:
 *
 *   • 3-class confusion over MATCH / NEEDS_REVIEW / NOT_A_MATCH
 *   • per-class, macro and weighted precision/recall/F1
 *   • technical-conflict detection (did the evidence name the expected attribute)
 *   • review rate (share of pairs routed to NEEDS_TECHNICAL_REVIEW)
 *   • score ranges per predicted class + overlap documentation
 *   • category breakdown with sample-sufficiency flagging
 *   • false-positive / false-negative listings for analysis
 *
 * Labels come from the dataset file and are derived from the technical
 * attributes stored on each record — never from engine output. Every value
 * reported is computed from the labelled pairs; nothing is hard-coded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listAllMaterialsForMatching } from '../db/repositories/matching-queries';
import { scorePair } from './engine';
import { MatchingRunCache } from './runtime';
import type { DecisionState } from './decision';
import type { MatchableMaterial } from './types';

/** Evaluation label vocabulary (ground truth AND 3-class model output). */
export const EVAL_LABELS = ['MATCH', 'NEEDS_REVIEW', 'NOT_A_MATCH'] as const;
export type EvalLabel = (typeof EVAL_LABELS)[number];

export const DEFAULT_GROUND_TRUTH_PATH = path.join(process.cwd(), 'data', 'evaluation', 'ground-truth-pairs.json');

export interface GroundTruthPair {
  a: string;
  b: string;
  category: string;
  ground_truth: EvalLabel;
  rationale: string;
  /** Attribute the evidence SHOULD name for conflict/missing pairs. */
  conflict_attribute?: string;
  /** 'critical' → expect a critical conflict; 'missing' → expect it in missingCritical. */
  expect_conflict?: 'critical' | 'missing';
}

export interface GroundTruthDataset {
  name: string;
  version: number;
  created?: string;
  label_vocabulary: Record<EvalLabel, string>;
  protocol?: string;
  pairs: GroundTruthPair[];
}

export interface LoadedGroundTruth {
  dataset: GroundTruthDataset;
  /** Material records for every referenced key, keyed by `ORG|CODE`. */
  materials: Map<string, MatchableMaterial>;
  /** Dataset keys with no active material record (skipped during scoring). */
  missingKeys: string[];
}

const cache = new Map<string, GroundTruthDataset>();

/** Parse a key like "CPCL|CP-1001". Throws when malformed. */
function parseKey(key: string, where: string): { org: string; code: string } {
  const idx = key.indexOf('|');
  if (idx <= 0 || idx === key.length - 1) throw new Error(`${where}: malformed pair key "${key}" (expected ORG|CODE)`);
  return { org: key.slice(0, idx), code: key.slice(idx + 1) };
}

/**
 * Load and fully validate the ground-truth dataset. Throws on missing file,
 * invalid JSON, unknown labels, malformed/duplicate/self pairs — evaluation
 * must never run silently on a broken dataset.
 */
export function loadGroundTruth(filePath: string = DEFAULT_GROUND_TRUTH_PATH): GroundTruthDataset {
  const cached = cache.get(filePath);
  if (cached) return cached;
  if (!fs.existsSync(filePath)) throw new Error(`ground-truth dataset not found: ${filePath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`ground-truth dataset is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ds = raw as GroundTruthDataset;
  if (!ds || typeof ds !== 'object') throw new Error('ground-truth dataset: root is not an object');
  if (!Array.isArray(ds.pairs) || ds.pairs.length === 0) throw new Error('ground-truth dataset: "pairs" must be a non-empty array');
  const seen = new Set<string>();
  ds.pairs.forEach((p, i) => {
    const where = `pair #${i + 1}`;
    const a = parseKey(p.a, where);
    const b = parseKey(p.b, where);
    if (p.a === p.b) throw new Error(`${where}: a pair must reference two different records (${p.a})`);
    if (a.org === b.org) throw new Error(`${where}: pair ${p.a} ↔ ${p.b} is not cross-CPSE`);
    if (!(EVAL_LABELS as readonly string[]).includes(p.ground_truth)) {
      throw new Error(`${where}: invalid label "${String(p.ground_truth)}" (expected one of ${EVAL_LABELS.join(', ')})`);
    }
    if (typeof p.rationale !== 'string' || p.rationale.trim().length === 0) {
      throw new Error(`${where}: every pair needs a rationale`);
    }
    const key = [p.a, p.b].sort().join('::');
    if (seen.has(key)) throw new Error(`${where}: duplicate pair ${p.a} ↔ ${p.b}`);
    seen.add(key);
  });
  cache.set(filePath, ds);
  return ds;
}

/** Clear the dataset cache (used by tests that rewrite dataset files). */
export function resetGroundTruthCache(): void {
  cache.clear();
}

/**
 * Materials referenced by the dataset, from the live matching query (same
 * loading path the matcher itself uses). Missing keys are reported, never
 * silently ignored.
 */
export function loadGroundTruthMaterials(ds: GroundTruthDataset): { materials: Map<string, MatchableMaterial>; missingKeys: string[] } {
  const all = listAllMaterialsForMatching();
  const byKey = new Map<string, MatchableMaterial>();
  for (const m of all) byKey.set(`${m.orgCode}|${m.originalCode}`, m);
  const keys = new Set<string>();
  for (const p of ds.pairs) {
    keys.add(p.a);
    keys.add(p.b);
  }
  const materials = new Map<string, MatchableMaterial>();
  const missingKeys: string[] = [];
  for (const key of keys) {
    const m = byKey.get(key);
    if (m) materials.set(key, m);
    else missingKeys.push(key);
  }
  return { materials, missingKeys: missingKeys.sort() };
}

/** Map the engine's four decision states onto the 3-class evaluation vocabulary. */
export function decisionToEvalClass(decision: DecisionState): EvalLabel {
  switch (decision) {
    case 'HIGH_CONFIDENCE_MATCH':
      return 'MATCH';
    case 'NEEDS_TECHNICAL_REVIEW':
    case 'LOW_CONFIDENCE':
      return 'NEEDS_REVIEW';
    case 'NOT_A_MATCH':
      return 'NOT_A_MATCH';
  }
}

export interface GroundTruthPairRecord {
  a: string;
  b: string;
  orgA: string;
  orgB: string;
  category: string;
  groundTruth: EvalLabel;
  modelDecision: DecisionState;
  modelClass: EvalLabel;
  modelScore: number;
  semantic: number;
  fuzzy: number;
  technical: number;
  criticalConflicts: string[];
  missingCritical: string[];
  conflictExpected: 'critical' | 'missing' | null;
  conflictAttribute: string | null;
  conflictDetected: boolean;
  correct: boolean;
  explanation: string;
  rationale: string;
}

export interface ClassMetrics {
  /** ground-truth pairs of this class */
  support: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ScoreRange {
  min: number;
  max: number;
}

export interface ConflictDetection {
  /** pairs that declare an expect_conflict attribute */
  expected: number;
  /** evidence named the expected attribute (conflict or missing-on-one-side) */
  detected: number;
  detectionRate: number;
  missed: Array<{ a: string; b: string; attribute: string; kind: 'critical' | 'missing' }>;
  /**
   * Baseline from before attribute-aware nominal comparison was introduced
   * (Step 10 first run: 18/20). Recorded for honest before/after display;
   * derived from the run history stored in .freebuff/evaluation-report.json.
   */
  previousBaseline?: {
    detected: number;
    expected: number;
    note: string;
    /** True once assembly/kit awareness is live (the former bolt WITH NUT FP). */
    assemblyAware?: boolean;
  };
}

export interface CategoryBreakdownRow {
  category: string;
  pairs: number;
  predicted: Record<EvalLabel, number>;
  agreement: number;
  /** pairs >= MIN_PAIRS_FOR_CATEGORY_METRICS */
  sufficientSample: boolean;
}

export interface GroundTruthEvaluation {
  dataset: { name: string; version: number; file: string; pairs: number };
  /** Label semantics straight from the dataset file. */
  vocabulary: Record<EvalLabel, string>;
  evaluatedPairs: number;
  skippedPairs: number;
  missingKeys: string[];
  labelCounts: Record<EvalLabel, number>;
  predictionCounts: Record<EvalLabel, number>;
  /** confusion[gt][predicted] */
  confusion: Record<EvalLabel, Record<EvalLabel, number>>;
  perClass: Record<EvalLabel, ClassMetrics>;
  macro: { precision: number; recall: number; f1: number };
  weighted: { precision: number; recall: number; f1: number };
  accuracy: number;
  reviewRate: number;
  conflictDetection: ConflictDetection;
  scoreRanges: Record<EvalLabel, ScoreRange | null>;
  /** predicted-class score ranges that intersect (documented limitation) */
  scoreOverlap: Array<[EvalLabel, EvalLabel]>;
  categoryBreakdown: CategoryBreakdownRow[];
  falsePositives: GroundTruthPairRecord[];
  falseNegatives: GroundTruthPairRecord[];
  pairs: GroundTruthPairRecord[];
}

/** Pairs needed before a category-level metric is considered meaningful. */
export const MIN_PAIRS_FOR_CATEGORY_METRICS = 8;

function emptyCounts(): Record<EvalLabel, number> {
  return { MATCH: 0, NEEDS_REVIEW: 0, NOT_A_MATCH: 0 };
}

function emptyConfusion(): Record<EvalLabel, Record<EvalLabel, number>> {
  return { MATCH: emptyCounts(), NEEDS_REVIEW: emptyCounts(), NOT_A_MATCH: emptyCounts() };
}

function safeDiv(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

/** Per-class precision/recall/F1 from a confusion matrix. */
export function perClassMetrics(confusion: Record<EvalLabel, Record<EvalLabel, number>>): Record<EvalLabel, ClassMetrics> {
  const out = {} as Record<EvalLabel, ClassMetrics>;
  for (const label of EVAL_LABELS) {
    let tp = 0;
    for (const pred of EVAL_LABELS) if (pred === label) tp += confusion[label][pred];
    let fp = 0;
    for (const gt of EVAL_LABELS) if (gt !== label) fp += confusion[gt][label];
    let fn = 0;
    for (const pred of EVAL_LABELS) if (pred !== label) fn += confusion[label][pred];
    const support = tp + fn;
    const precision = safeDiv(tp, tp + fp);
    const recall = safeDiv(tp, support);
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    out[label] = { support, tp, fp, fn, precision, recall, f1 };
  }
  return out;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * Score every labelled pair through the real pipeline and aggregate metrics.
 * Deterministic: same dataset + same material records ⇒ identical result.
 */
export function evaluateGroundTruth(options?: {
  dataset?: GroundTruthDataset;
  materials?: Map<string, MatchableMaterial>;
  filePath?: string;
  /** omit detailed pair list (page-only fields) for cheap deterministic checks */
  includePairs?: boolean;
}): GroundTruthEvaluation {
  const filePath = options?.filePath ?? DEFAULT_GROUND_TRUTH_PATH;
  const ds = options?.dataset ?? loadGroundTruth(filePath);
  const { materials, missingKeys } = options?.materials
    ? { materials: options.materials, missingKeys: [] }
    : loadGroundTruthMaterials(ds);
  const includePairs = options?.includePairs ?? true;

  const records: GroundTruthPairRecord[] = [];
  let skipped = 0;
  // Evaluation-scoped representation cache (Step 2): identical scores, one
  // embedding/tokenization per material instead of per pair.
  const runtime = new MatchingRunCache();

  for (const p of ds.pairs) {
    const a = materials.get(p.a);
    const b = materials.get(p.b);
    if (!a || !b) {
      skipped++;
      continue;
    }
    const s = scorePair(a, b, runtime);
    const modelClass = decisionToEvalClass(s.decision);
    const conflictAttribute = p.conflict_attribute ?? null;
    const conflictExpected = p.expect_conflict ?? null;
    let conflictDetected = false;
    if (conflictExpected === 'critical' && conflictAttribute) {
      // Critical attribute conflicts are normally named in criticalConflicts;
      // manufacturer conflicts are enforced by the decision rule and recorded
      // in the decision reason ("different manufacturers (FAG vs SKF) …").
      conflictDetected =
        s.evidence.criticalConflicts.some((c) => c.startsWith(`${conflictAttribute}:`)) ||
        s.evidence.decision.reason.toLowerCase().includes(conflictAttribute.toLowerCase());
    } else if (conflictExpected === 'missing' && conflictAttribute) {
      conflictDetected =
        s.evidence.missingCritical.includes(conflictAttribute) ||
        s.evidence.criticalConflicts.some((c) => c.startsWith(`${conflictAttribute}:`));
    }
    const ka = parseKey(p.a, 'pair');
    const kb = parseKey(p.b, 'pair');
    records.push({
      a: p.a,
      b: p.b,
      orgA: ka.org,
      orgB: kb.org,
      category: p.category,
      groundTruth: p.ground_truth,
      modelDecision: s.decision,
      modelClass,
      modelScore: s.finalScore,
      semantic: s.semanticScore,
      fuzzy: s.fuzzyScore,
      technical: s.technicalScore,
      criticalConflicts: s.evidence.criticalConflicts,
      missingCritical: s.evidence.missingCritical,
      conflictExpected,
      conflictAttribute,
      conflictDetected,
      correct: modelClass === p.ground_truth,
      explanation: s.explanation,
      rationale: p.rationale,
    });
  }

  const confusion = emptyConfusion();
  const labelCounts = emptyCounts();
  const predictionCounts = emptyCounts();
  const scoresByClass: Record<EvalLabel, number[]> = { MATCH: [], NEEDS_REVIEW: [], NOT_A_MATCH: [] };
  for (const r of records) {
    confusion[r.groundTruth][r.modelClass]++;
    labelCounts[r.groundTruth]++;
    predictionCounts[r.modelClass]++;
    scoresByClass[r.modelClass].push(r.modelScore);
  }

  const perClass = perClassMetrics(confusion);
  const present = EVAL_LABELS.filter((l) => perClass[l].support > 0);
  const macro = {
    precision: round4(present.length ? present.reduce((s, l) => s + perClass[l].precision, 0) / present.length : 0),
    recall: round4(present.length ? present.reduce((s, l) => s + perClass[l].recall, 0) / present.length : 0),
    f1: round4(present.length ? present.reduce((s, l) => s + perClass[l].f1, 0) / present.length : 0),
  };
  const total = records.length;
  const weighted = {
    precision: round4(EVAL_LABELS.reduce((s, l) => s + perClass[l].support * perClass[l].precision, 0) / total),
    recall: round4(EVAL_LABELS.reduce((s, l) => s + perClass[l].support * perClass[l].recall, 0) / total),
    f1: round4(EVAL_LABELS.reduce((s, l) => s + perClass[l].support * perClass[l].f1, 0) / total),
  };
  const accuracy = round4(safeDiv(records.filter((r) => r.correct).length, total));

  // Conflict detection (only pairs that declare an expectation).
  const expectedPairs = records.filter((r) => r.conflictExpected !== null && r.conflictAttribute !== null);
  const missedConflicts = expectedPairs
    .filter((r) => !r.conflictDetected)
    .map((r) => ({ a: r.a, b: r.b, attribute: r.conflictAttribute as string, kind: r.conflictExpected as 'critical' | 'missing' }));

  // Score ranges per predicted class + overlap documentation.
  const scoreRanges = {} as Record<EvalLabel, ScoreRange | null>;
  for (const label of EVAL_LABELS) {
    const xs = scoresByClass[label];
    scoreRanges[label] = xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null;
  }
  const scoreOverlap: Array<[EvalLabel, EvalLabel]> = [];
  for (let i = 0; i < EVAL_LABELS.length; i++) {
    for (let j = i + 1; j < EVAL_LABELS.length; j++) {
      const ra = scoreRanges[EVAL_LABELS[i]];
      const rb = scoreRanges[EVAL_LABELS[j]];
      if (!ra || !rb) continue;
      if (ra.min <= rb.max && rb.min <= ra.max) scoreOverlap.push([EVAL_LABELS[i], EVAL_LABELS[j]]);
    }
  }

  // Category breakdown (labels come from the dataset; sufficiency is flagged, not hidden).
  const byCategory = new Map<string, GroundTruthPairRecord[]>();
  for (const r of records) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }
  const categoryBreakdown: CategoryBreakdownRow[] = [...byCategory.entries()]
    .sort((x, y) => y[1].length - x[1].length)
    .map(([category, rows]) => {
      const predicted = emptyCounts();
      for (const r of rows) predicted[r.modelClass]++;
      return {
        category,
        pairs: rows.length,
        predicted,
        agreement: round4(safeDiv(rows.filter((r) => r.correct).length, rows.length)),
        sufficientSample: rows.length >= MIN_PAIRS_FOR_CATEGORY_METRICS,
      };
    });

  const falsePositives = records.filter((r) => r.modelClass === 'MATCH' && r.groundTruth !== 'MATCH');
  const falseNegatives = records.filter((r) => r.groundTruth === 'MATCH' && r.modelClass !== 'MATCH');

  return {
    dataset: { name: ds.name, version: ds.version, file: path.basename(filePath), pairs: ds.pairs.length },
    vocabulary: ds.label_vocabulary,
    evaluatedPairs: total,
    skippedPairs: skipped,
    missingKeys,
    labelCounts,
    predictionCounts,
    confusion,
    perClass,
    macro,
    weighted,
    accuracy,
    reviewRate: round4(safeDiv(predictionCounts.NEEDS_REVIEW, total)),
    conflictDetection: {
      expected: expectedPairs.length,
      detected: expectedPairs.length - missedConflicts.length,
      detectionRate: round4(safeDiv(expectedPairs.length - missedConflicts.length, expectedPairs.length)),
      missed: missedConflicts,
      previousBaseline: { detected: 18, expected: 20, note: 'Step-10 first run, before attribute-aware nominal comparison', assemblyAware: true },
    },
    scoreRanges,
    scoreOverlap,
    categoryBreakdown,
    falsePositives,
    falseNegatives,
    pairs: includePairs ? records : [],
  };
}
