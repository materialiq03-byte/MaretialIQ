/**
 * Reproducible evaluation runner — `npm run evaluate`.
 *
 * Scores the labelled ground-truth dataset through the real matching pipeline
 * against the live database, writes the full report (metrics + every labelled
 * pair with its evidence) to `.freebuff/evaluation-report.json`, and APPENDS a
 * summary record to the permanent run history
 * (`data/evaluation/run-history.json` — previous runs are never overwritten).
 * Deterministic: same dataset + same records ⇒ byte-identical metrics.
 */
import fs from 'node:fs';
import { evaluateGroundTruth } from '../src/lib/matching/ground-truth';
import {
  buildRunRecord,
  loadRunHistory,
  recordEvaluationRun,
  validateRunRecord,
} from '../src/lib/matching/run-history';

const ev = evaluateGroundTruth();
const out = '.freebuff/evaluation-report.json';
fs.writeFileSync(out, JSON.stringify(ev, null, 2));

console.log(`dataset: ${ev.dataset.name} v${ev.dataset.version} (${ev.dataset.file}, ${ev.dataset.pairs} pairs)`);
console.log(`evaluated: ${ev.evaluatedPairs} | skipped: ${ev.skippedPairs}`);
if (ev.missingKeys.length) console.log(`missing keys: ${ev.missingKeys.join(', ')}`);
console.log(`labels:      MATCH ${ev.labelCounts.MATCH} | NEEDS_REVIEW ${ev.labelCounts.NEEDS_REVIEW} | NOT_A_MATCH ${ev.labelCounts.NOT_A_MATCH}`);
console.log(`predictions: MATCH ${ev.predictionCounts.MATCH} | NEEDS_REVIEW ${ev.predictionCounts.NEEDS_REVIEW} | NOT_A_MATCH ${ev.predictionCounts.NOT_A_MATCH}`);
console.log('confusion (rows = ground truth, cols = prediction):');
for (const gt of ['MATCH', 'NEEDS_REVIEW', 'NOT_A_MATCH'] as const) {
  console.log(`  ${gt.padEnd(12)} -> MATCH ${ev.confusion[gt].MATCH} | NEEDS_REVIEW ${ev.confusion[gt].NEEDS_REVIEW} | NOT_A_MATCH ${ev.confusion[gt].NOT_A_MATCH}`);
}
console.log(`accuracy ${ev.accuracy} | macro P/R/F1 ${ev.macro.precision}/${ev.macro.recall}/${ev.macro.f1} | weighted ${ev.weighted.precision}/${ev.weighted.recall}/${ev.weighted.f1}`);
for (const l of ['MATCH', 'NEEDS_REVIEW', 'NOT_A_MATCH'] as const) {
  const c = ev.perClass[l];
  console.log(`  ${l.padEnd(12)} support ${c.support} P ${Math.round(c.precision * 10000) / 10000} R ${Math.round(c.recall * 10000) / 10000} F1 ${Math.round(c.f1 * 10000) / 10000}`);
}
console.log(`review rate: ${ev.reviewRate} | conflict detection: ${ev.conflictDetection.detected}/${ev.conflictDetection.expected} (${ev.conflictDetection.detectionRate})`);
console.log(`false positives: ${ev.falsePositives.length} | false negatives: ${ev.falseNegatives.length}`);
console.log(`score ranges: ${JSON.stringify(ev.scoreRanges)} | overlapping: ${JSON.stringify(ev.scoreOverlap)}`);

// Append to the permanent run history (existing records untouched).
const previous = loadRunHistory();
const last = previous[previous.length - 1];
const notes =
  previous.length === 0
    ? 'First recorded run.'
    : `Compared with ${last.runId}: accuracy ${last.accuracy} -> ${ev.accuracy}, macro F1 ${last.macroF1} -> ${ev.macro.f1}, conflicts ${last.conflictDetection.detected}/${last.conflictDetection.expected} -> ${ev.conflictDetection.detected}/${ev.conflictDetection.expected}, FP ${last.falsePositives} -> ${ev.falsePositives.length}, FN ${last.falseNegatives} -> ${ev.falseNegatives.length}.`;
const recorded = recordEvaluationRun(buildRunRecord(ev, notes));
console.log(`run history: ${recorded.runId} appended to evaluation_runs table + JSON mirror (${previous.length + 1} runs total)`);
console.log(`report written to ${out}`);
