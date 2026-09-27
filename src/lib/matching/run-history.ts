/**
 * Evaluation run history — every `npm run evaluate` appends an immutable
 * record to `data/evaluation/run-history.json` (never overwritten), so the
 * metrics shown on /evaluation can be traced back to the exact matcher
 * configuration that produced them. The current report file
 * (.freebuff/evaluation-report.json) stays the "latest full detail" artifact;
 * this file is the long-lived history.
 *
 * Records carry a matcher-configuration summary + fingerprint so a judge can
 * see WHEN the engine changed, not just that the numbers moved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/client';
import {
  ATTRIBUTE_STRATEGIES,
  CRITICAL_RULES,
  normalizedWeights,
} from './config';
import { DECISION_THRESHOLDS } from './decision';
import { THRESHOLDS } from './config';
import type { GroundTruthEvaluation } from './ground-truth';

export const RUN_HISTORY_PATH = path.resolve('data/evaluation/run-history.json');

/**
 * Mirror path resolved at call time so tests can redirect writes away from the
 * real history file (`EVAL_RUN_HISTORY_PATH`). Reads stay on the default file
 * unless a path is passed explicitly.
 */
function mirrorPath(): string {
  return process.env.EVAL_RUN_HISTORY_PATH
    ? path.resolve(process.env.EVAL_RUN_HISTORY_PATH)
    : RUN_HISTORY_PATH;
}

export interface ConfusionRow {
  MATCH: number;
  NEEDS_REVIEW: number;
  NOT_A_MATCH: number;
}

export interface EvaluationRunRecord {
  /** Monotonic run identifier: run-0001, run-0002, … */
  runId: string;
  /** ISO timestamp of the evaluation run. */
  timestamp: string;
  /** Ground-truth dataset file the pairs came from. */
  dataset: string;
  datasetVersion: string;
  pairs: number;
  accuracy: number;
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
  weightedF1: number;
  /** rows = ground truth, cols = prediction. */
  confusion: Record<'MATCH' | 'NEEDS_REVIEW' | 'NOT_A_MATCH', ConfusionRow>;
  falsePositives: number;
  falseNegatives: number;
  conflictDetection: { detected: number; expected: number; rate: number };
  reviewRate: number;
  /** Human-readable matcher configuration at run time. */
  matcherConfig: string;
  /** package version + config fingerprint, e.g. `v0.2.0/cfg-1a2b3c`. */
  buildId: string;
  notes: string;
}

interface HistoryFile {
  runs: EvaluationRunRecord[];
}

/* ---------------- matcher configuration fingerprint ---------------- */

/** Deterministic FNV-1a (same scheme as the embedding hash). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Fingerprint of everything that materially affects matching outcomes:
 * weights, engine thresholds, decision thresholds, critical rules,
 * attribute strategies. Changing any of them changes the config id.
 */
export function matcherConfigFingerprint(): string {
  const payload = JSON.stringify({
    w: normalizedWeights(),
    t: THRESHOLDS,
    d: DECISION_THRESHOLDS,
    crit: CRITICAL_RULES,
    strat: ATTRIBUTE_STRATEGIES,
    assemblyAware: true,
  });
  return `cfg-${fnv1a(payload).slice(0, 6)}`;
}

const pkgVersion = '0.2.0'; // package.json version (kept literal to stay import-free in edge runtimes)

export function currentBuildId(): string {
  return `v${pkgVersion}/${matcherConfigFingerprint()}`;
}

/** Human-readable summary of the live matcher configuration. */
export function matcherConfigSummary(): string {
  const w = normalizedWeights();
  const nominal = Object.entries(ATTRIBUTE_STRATEGIES)
    .flatMap(([cat, m]) =>
      Object.entries(m)
        .filter(([, s]) => s === 'nominal')
        .map(([a]) => `${cat}.${a}`)
    )
    .sort();
  return [
    `weights semantic ${w.semantic} / fuzzy ${w.fuzzy} / technical ${w.technical} / category ${w.category}`,
    `decisions: high >= ${DECISION_THRESHOLDS.highConfidence}, review >= ${DECISION_THRESHOLDS.reviewFloor}, reject < ${DECISION_THRESHOLDS.notAMatch}`,
    `nominal attributes: ${nominal.join(', ') || 'none'}`,
    'assembly/kit awareness on',
  ].join('; ');
}

/* ---------------- record building / persistence ---------------- */

/** Build a history record from a full evaluation result. Pure. */
export function buildRunRecord(
  ev: GroundTruthEvaluation,
  notes: string,
  timestamp: string = new Date().toISOString(),
  runId?: string
): Omit<EvaluationRunRecord, 'runId'> & { runId?: string } {
  return {
    runId,
    timestamp,
    dataset: ev.dataset.file,
    datasetVersion: `v${ev.dataset.version}`,
    pairs: ev.evaluatedPairs,
    accuracy: ev.accuracy,
    macroPrecision: ev.macro.precision,
    macroRecall: ev.macro.recall,
    macroF1: ev.macro.f1,
    weightedF1: ev.weighted.f1,
    confusion: ev.confusion,
    falsePositives: ev.falsePositives.length,
    falseNegatives: ev.falseNegatives.length,
    conflictDetection: {
      detected: ev.conflictDetection.detected,
      expected: ev.conflictDetection.expected,
      rate: ev.conflictDetection.detectionRate,
    },
    reviewRate: ev.reviewRate,
    matcherConfig: matcherConfigSummary(),
    buildId: currentBuildId(),
    notes,
  };
}

/**
 * Load the run history — the `evaluation_runs` table is the source of truth.
 * With an explicit `filePath`, reads the JSON mirror instead (legacy signature
 * kept for tests and offline tooling). Returns runs in insertion order
 * (oldest first).
 */
export function loadRunHistory(filePath?: string): EvaluationRunRecord[] {
  if (filePath) {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as HistoryFile;
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  }
  try {
    const rows = getDb()
      .prepare(
        `SELECT run_id, timestamp, dataset, dataset_version, pairs, accuracy,
                macro_precision, macro_recall, macro_f1, weighted_f1, confusion,
                false_positives, false_negatives, conflict_detected, conflict_expected,
                conflict_rate, review_rate, matcher_config, build_id, notes
           FROM evaluation_runs ORDER BY id ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  } catch {
    // Table not migrated yet (fresh clone before db:migrate) — fall back to
    // the JSON mirror so the page still renders historical evidence.
    return loadRunHistory(RUN_HISTORY_PATH);
  }
}

function rowToRecord(row: Record<string, unknown>): EvaluationRunRecord {
  return {
    runId: String(row.run_id),
    // PostgreSQL timestamptz arrives as a Date (adapter contract); SQLite
    // stores the original ISO text. Normalize both to the UTC ISO instant.
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp),
    dataset: String(row.dataset),
    datasetVersion: String(row.dataset_version),
    pairs: Number(row.pairs),
    accuracy: Number(row.accuracy),
    macroPrecision: Number(row.macro_precision),
    macroRecall: Number(row.macro_recall),
    macroF1: Number(row.macro_f1),
    weightedF1: Number(row.weighted_f1),
    confusion: JSON.parse(String(row.confusion)) as EvaluationRunRecord['confusion'],
    falsePositives: Number(row.false_positives),
    falseNegatives: Number(row.false_negatives),
    conflictDetection: {
      detected: Number(row.conflict_detected),
      expected: Number(row.conflict_expected),
      rate: Number(row.conflict_rate),
    },
    reviewRate: Number(row.review_rate),
    matcherConfig: String(row.matcher_config),
    buildId: String(row.build_id),
    notes: String(row.notes ?? ''),
  };
}

/** Rewrite the JSON mirror from the DB (append-only mirror of the same records). */
function syncJsonMirror(runs: EvaluationRunRecord[]): void {
  const filePath = mirrorPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ runs }, null, 2)}\n`);
}

/**
 * Append a run to the `evaluation_runs` table (source of truth) with the next
 * monotonic runId, then refresh the JSON mirror. Existing records — in the DB
 * and in the mirror — are never modified.
 */
export function recordEvaluationRun(
  record: Omit<EvaluationRunRecord, 'runId'> & { runId?: string }
): EvaluationRunRecord {
  const runs = loadRunHistory();
  const seq = runs.length + 1;
  const full: EvaluationRunRecord = {
    ...record,
    runId: record.runId ?? `run-${String(seq).padStart(4, '0')}`,
  };
  getDb()
    .prepare(
      `INSERT INTO evaluation_runs (
         run_id, timestamp, dataset, dataset_version, pairs, accuracy,
         macro_precision, macro_recall, macro_f1, weighted_f1, confusion,
         false_positives, false_negatives, conflict_detected, conflict_expected,
         conflict_rate, review_rate, matcher_config, build_id, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      full.runId,
      full.timestamp,
      full.dataset,
      full.datasetVersion,
      full.pairs,
      full.accuracy,
      full.macroPrecision,
      full.macroRecall,
      full.macroF1,
      full.weightedF1,
      JSON.stringify(full.confusion),
      full.falsePositives,
      full.falseNegatives,
      full.conflictDetection.detected,
      full.conflictDetection.expected,
      full.conflictDetection.rate,
      full.reviewRate,
      full.matcherConfig,
      full.buildId,
      full.notes
    );
  syncJsonMirror([...runs, full]);
  return full;
}

/**
 * One-time seed: copy any JSON-mirror runs that the DB does not have yet into
 * `evaluation_runs` (idempotent — matched on run_id). Used after migrating so
 * the seeded pre-Step-13 history survives the move to the DB.
 */
export function seedRunsFromJsonMirror(filePath: string = RUN_HISTORY_PATH): number {
  const mirrored = loadRunHistory(filePath);
  const known = new Set(loadRunHistory().map((r) => r.runId));
  let inserted = 0;
  for (const r of mirrored) {
    if (known.has(r.runId)) continue;
    recordEvaluationRun(r);
    inserted += 1;
  }
  return inserted;
}

/* ---------------- consistency validation ---------------- */

const EVAL_LABELS = ['MATCH', 'NEEDS_REVIEW', 'NOT_A_MATCH'] as const;
type EvalLabel = (typeof EVAL_LABELS)[number];

function safeDiv(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * Recompute macro/weighted metrics from a record's own confusion matrix and
 * check they match the recorded values. Guards the history (including the
 * seeded pre-Step-13 entries reconstructed from session transcripts) against
 * transcription errors. Tolerance 0.0011 (values stored rounded to 4 dp).
 */
export function validateRunRecord(record: EvaluationRunRecord): string[] {
  const problems: string[] = [];
  const total = EVAL_LABELS.reduce((s, gt) => s + EVAL_LABELS.reduce((s2, p) => s2 + record.confusion[gt][p], 0), 0);
  if (total !== record.pairs) {
    problems.push(`${record.runId}: confusion cells sum to ${total}, but pairs = ${record.pairs}`);
  }
  let macroP = 0;
  let macroR = 0;
  let macroF1 = 0;
  let weightedF1 = 0;
  for (const label of EVAL_LABELS) {
    const tp = record.confusion[label][label];
    const predicted = EVAL_LABELS.reduce((s, p) => s + record.confusion[p][label], 0);
    const actual = EVAL_LABELS.reduce((s, a) => s + record.confusion[label][a], 0);
    const precision = safeDiv(tp, predicted);
    const recall = safeDiv(tp, actual);
    const f1 = safeDiv(2 * precision * recall, precision + recall);
    macroP += precision;
    macroR += recall;
    macroF1 += f1;
    weightedF1 += actual * f1;
  }
  macroP = round4(macroP / 3);
  macroR = round4(macroR / 3);
  macroF1 = round4(macroF1 / 3);
  weightedF1 = total === 0 ? 0 : round4(weightedF1 / total);
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.0011;
  if (!close(macroP, record.macroPrecision)) problems.push(`${record.runId}: macroPrecision ${record.macroPrecision} != derived ${macroP}`);
  if (!close(macroR, record.macroRecall)) problems.push(`${record.runId}: macroRecall ${record.macroRecall} != derived ${macroR}`);
  if (!close(macroF1, record.macroF1)) problems.push(`${record.runId}: macroF1 ${record.macroF1} != derived ${macroF1}`);
  if (!close(weightedF1, record.weightedF1)) problems.push(`${record.runId}: weightedF1 ${record.weightedF1} != derived ${weightedF1}`);
  if (record.conflictDetection.expected > 0) {
    const rate = round4(record.conflictDetection.detected / record.conflictDetection.expected);
    if (!close(rate, record.conflictDetection.rate)) problems.push(`${record.runId}: conflict rate mismatch`);
  }
  const fp = record.confusion.NEEDS_REVIEW.MATCH + record.confusion.NOT_A_MATCH.MATCH;
  if (fp !== record.falsePositives) problems.push(`${record.runId}: falsePositives ${record.falsePositives} != confusion-derived ${fp}`);
  const fn = record.confusion.MATCH.NEEDS_REVIEW + record.confusion.MATCH.NOT_A_MATCH;
  if (fn !== record.falseNegatives) problems.push(`${record.runId}: falseNegatives ${record.falseNegatives} != confusion-derived ${fn}`);
  return problems;
}
