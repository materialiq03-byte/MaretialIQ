/**
 * Data-quality evaluation for processed material records.
 *
 * Verdicts are categorical and rule-derived (GOOD / WARNING / INCOMPLETE /
 * INVALID). No numeric quality score is invented; each check reports what it
 * actually observed on the record.
 */
import type { QualityStatus } from '../types/domain';
import { isKnownUnit } from './units';
import { SEAL_CODES } from './extract';

export interface QualityCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface QualityReport {
  status: QualityStatus;
  checks: QualityCheck[];
}

/** Critical attribute sets per category — absence lowers the verdict. */
const EXPECTED_CRITICAL: Record<string, string[]> = {
  Bearings: ['series', 'seal_type'],
  Motors: ['power_rating', 'voltage_rating'],
  Pumps: ['suction_size', 'discharge_size'],
  Valves: ['nominal_size', 'pressure_class'],
  Fasteners: ['thread_specification', 'diameter'],
};

export interface QualityInput {
  originalDescription: string;
  normalizedDescription: string | null;
  category: string | null;
  attributes: Array<{ attributeName: string; value: string; unit: string | null }>;
}

/** Run every quality check and derive the categorical verdict. */
export function evaluateQuality(input: QualityInput): QualityReport {
  const checks: QualityCheck[] = [];

  // 1. Description present and meaningful.
  const descOk = input.originalDescription.trim().length >= 3;
  checks.push({
    check: 'description_present',
    passed: descOk,
    detail: descOk ? 'Description present' : 'Description missing or too short',
  });

  // 2. Normalization produced content.
  const normOk = (input.normalizedDescription ?? '').trim().length > 0;
  checks.push({
    check: 'normalized_description',
    passed: normOk,
    detail: normOk ? 'Normalized description generated' : 'Normalization produced no output',
  });

  // 3. Category known.
  const catOk = input.category !== null && input.category.trim() !== '';
  checks.push({
    check: 'category_classified',
    passed: catOk,
    detail: catOk ? `Classified as ${input.category}` : 'No category rule matched this description',
  });

  // 4. At least one structured attribute.
  const hasAttrs = input.attributes.length > 0;
  checks.push({
    check: 'attributes_extracted',
    passed: hasAttrs,
    detail: hasAttrs ? `${input.attributes.length} attributes extracted` : 'No technical attributes could be extracted',
  });

  // 5. Category-critical attributes present (informational → incomplete).
  const expected = input.category ? (EXPECTED_CRITICAL[input.category] ?? []) : [];
  const missing = expected.filter((name) => !input.attributes.some((a) => a.attributeName === name));
  checks.push({
    check: 'critical_attributes_present',
    passed: catOk && missing.length === 0,
    detail:
      expected.length === 0
        ? 'No category-specific critical attributes defined'
        : missing.length === 0
          ? `All expected critical attributes present (${expected.join(', ')})`
          : `Missing expected attributes: ${missing.join(', ')}`,
  });

  // 6. Unknown/suspicious units: a whole token that is a number glued to
  // letters ("11CAST", "304WITH") that is neither a known unit, a bearing
  // seal designation ("2RS") nor a protected compact code. Cross-token
  // adjacency ("11 CAST") is NOT flagged — only genuinely glued tokens.
  const suspicious: string[] = [];
  for (const token of (input.normalizedDescription ?? '').split(/\s+/).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)([A-Z]{1,6})$/.exec(token);
    if (!m) continue;
    if (SEAL_CODES.has(token)) continue;
    if (isKnownUnit(m[2])) continue;
    suspicious.push(token);
  }
  checks.push({
    check: 'units_recognised',
    passed: suspicious.length === 0,
    detail: suspicious.length === 0 ? 'No unknown unit tokens' : `Unrecognised unit-like tokens: ${suspicious.join(', ')}`,
  });

  // 7. Formatting sanity: original should not be shouting-mixed or over-punctuated.
  const letters = input.originalDescription.replace(/[^A-Za-z]/g, '');
  const upper = input.originalDescription.replace(/[^A-Z]/g, '');
  const shouting = letters.length >= 8 && upper.length / letters.length < 0.5;
  const junk = /\.{3,}|!{2,}|\?{2,}/.test(input.originalDescription);
  checks.push({
    check: 'formatting_sane',
    passed: !shouting && !junk,
    detail:
      shouting || junk
        ? 'Mixed-case or repeated punctuation in source description — verify against the source document'
        : 'Formatting looks consistent',
  });

  // Verdict derivation (documented, deterministic):
  // invalid  → no usable description (missing original OR normalization yields nothing)
  // warning  → formatting/unit sanity checks failed but data usable
  // incomplete → missing category or critical attributes
  // good     → everything passed
  const failed = (name: string) => checks.find((c) => c.check === name)?.passed === false;
  let status: QualityStatus;
  if (failed('description_present') || failed('normalized_description')) status = 'invalid';
  else if (failed('units_recognised') || failed('formatting_sane')) status = 'warning';
  else if (failed('category_classified') || failed('critical_attributes_present')) status = 'incomplete';
  else status = 'good';

  return { status, checks };
}
