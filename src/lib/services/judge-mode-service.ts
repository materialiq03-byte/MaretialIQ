/**
 * Step 24 — Judge Mode: the deterministic explanation layer.
 *
 * Judge Mode answers "WHY did MaterialIQ make this decision?" by PRESENTING
 * the Step 23 match-review contract. It is a composition/presentation layer
 * only: it never re-scores, never alters thresholds, never reinterprets
 * technical values, never mutates anything (zero audit/history/decision/CMI
 * writes), and produces the same brief for the same candidate state —
 * deterministic templates, no generation.
 *
 * The matching engine remains the only source of the score/verdict; the
 * review service remains the source of evidence; Judge Mode is the lens.
 */
import {
  getMatchReview,
  type MatchReview,
  type TechnicalComparisonRow,
  type TechnicalConflict,
} from './match-review-service';
import { getDb } from '../db/client';
import { errors } from '../errors';

/* ------------------------------- source trace ------------------------------ */

/** Step 22 source traceability for one material (or an honest legacy note). */
export interface SourceTrace {
  cpse: string;
  sourceSystem: string | null;
  sourceRecordId: string | null;
  adapterVersion: string | null;
  sourceFileName: string | null;
  sourceRow: number | null;
  importId: number | null;
  importUrl: string | null;
  /** 'integration' | 'import_center' | 'legacy' — provenance of the record. */
  channel: 'integration' | 'import_center' | 'legacy';
  note: string | null;
}

const SOURCE_SELECT = `
  SELECT mr.organization_id, mr.original_code, mr.source_row, mr.import_id,
         di.file_name, di.row_report
    FROM material_records mr
    LEFT JOIN data_imports di ON di.id = mr.import_id
   WHERE mr.id = ?`;

/**
 * Compose the source trace for one material record. Uses ONLY existing data:
 * material_records.source_row/import_id and the import's Step 22 `integration`
 * metadata inside row_report. Legacy records (no import link) report honestly.
 */
export function getSourceTrace(materialId: number): SourceTrace {
  const row = getDb().prepare(SOURCE_SELECT).get(materialId) as unknown as
    | {
        organization_id: number; original_code: string; source_row: number | null;
        import_id: number | null; file_name: string | null; row_report: string | null;
      }
    | undefined;
  if (!row) throw errors.notFound('Material record');

  const cpseRow = getDb().prepare(`SELECT code FROM organizations WHERE id = ?`).get(row.organization_id) as unknown as { code: string } | undefined;

  let integration: Record<string, unknown> | null = null;
  if (row.row_report) {
    try {
      const report = JSON.parse(row.row_report) as Record<string, unknown>;
      if (report.integration && typeof report.integration === 'object') {
        integration = report.integration as Record<string, unknown>;
      }
    } catch {
      integration = null; // corrupted/absent report — fall through honestly
    }
  }

  if (integration) {
    return {
      cpse: String(integration.cpse ?? cpseRow?.code ?? ''),
      sourceSystem: String(integration.sourceSystem ?? integration.adapterId ?? '') || null,
      sourceRecordId: row.original_code,
      adapterVersion: String(integration.adapterVersion ?? '') || null,
      sourceFileName: String(integration.sourceFileName ?? row.file_name ?? '') || null,
      sourceRow: row.source_row,
      importId: row.import_id,
      importUrl: row.import_id ? `/imports/${row.import_id}` : null,
      channel: 'integration',
      note: null,
    };
  }

  if (row.import_id) {
    return {
      cpse: cpseRow?.code ?? '',
      sourceSystem: null,
      sourceRecordId: row.original_code,
      adapterVersion: null,
      sourceFileName: row.file_name,
      sourceRow: row.source_row,
      importId: row.import_id,
      importUrl: `/imports/${row.import_id}`,
      channel: 'import_center',
      note: 'Imported through the Import Center (no CPSE integration profile).',
    };
  }

  return {
    cpse: cpseRow?.code ?? '',
    sourceSystem: null,
    sourceRecordId: row.original_code,
    adapterVersion: null,
    sourceFileName: null,
    sourceRow: null,
    importId: null,
    importUrl: null,
    channel: 'legacy',
    note: 'Source metadata unavailable for this legacy record.',
  };
}

/* -------------------------------- rule trace ------------------------------- */

/** One matching rule that actually affected the candidate (§18). */
export interface RuleTraceItem {
  rule: string;
  outcome: 'applied' | 'excluded';
  effect: string;
  evidence: string;
}

/**
 * The rules that actually shaped THIS candidate, each with its evidence —
 * derived only from persisted contract fields. Rules that did not affect the
 * candidate are absent (truthful explainability).
 */
function ruleTraceOf(review: MatchReview): RuleTraceItem[] {
  const rules: RuleTraceItem[] = [];

  rules.push({
    rule: 'same-category requirement',
    outcome: review.categoryRelationship === 'same_category' ? 'applied' : 'excluded',
    effect:
      review.categoryRelationship === 'same_category'
        ? 'pair allowed into technical comparison'
        : 'pair excluded from equivalence',
    evidence: `${review.leftMaterial.category} ↔ ${review.rightMaterial.category}`,
  });

  rules.push({
    rule: 'cross-CPSE requirement',
    outcome: 'applied',
    effect:
      review.leftMaterial.cpse.toUpperCase() === review.rightMaterial.cpse.toUpperCase()
        ? 'same-CPSE pair compared (deduplication context)'
        : 'cross-CPSE pair compared (harmonization context)',
    evidence: `${review.leftMaterial.cpse} ↔ ${review.rightMaterial.cpse}`,
  });

  const seal = review.technicalComparison.find((r) => r.attribute === 'seal_type');
  if (seal) {
    rules.push({
      rule: 'critical seal_type comparison',
      outcome: seal.relation === 'CONFLICT' ? 'excluded' : 'applied',
      effect: seal.relation === 'CONFLICT' ? 'critical conflict → review' : 'attribute agreement recorded',
      evidence: `${seal.leftValue ?? '—'} vs ${seal.rightValue ?? '—'} (${seal.relation})`,
    });
  }

  const series = review.technicalComparison.find((r) => r.attribute === 'series');
  if (series) {
    rules.push({
      rule: 'nominal series comparison (exact identity required)',
      outcome: series.relation === 'CONFLICT' ? 'excluded' : 'applied',
      effect: series.relation === 'CONFLICT' ? 'nominal difference → conflict, never CLOSE' : 'series identity confirmed',
      evidence: `${series.leftValue ?? '—'} vs ${series.rightValue ?? '—'} (${series.relation})`,
    });
  }

  if (review.manufacturerRelationship !== 'unknown') {
    rules.push({
      rule: 'manufacturer rule (cross-brand equivalence requires human validation)',
      outcome: review.manufacturerRelationship === 'same' ? 'applied' : 'excluded',
      effect:
        review.manufacturerRelationship === 'same'
          ? 'no manufacturer obstacle'
          : 'high-score cross-brand pairs are never auto-accepted',
      evidence: `${review.leftMaterial.manufacturer ?? '—'} vs ${review.rightMaterial.manufacturer ?? '—'}`,
    });
  }

  if (review.assemblyEvidence) {
    rules.push({
      rule: 'assembly/kit detection',
      outcome: 'excluded',
      effect: 'configuration difference → review regardless of score',
      evidence: review.assemblyEvidence.detail,
    });
  }

  return rules;
}

/* --------------------------------- headline -------------------------------- */

export type JudgeQuestion = 'WHY_MATCH' | 'WHY_REVIEW' | 'WHY_NOT' | 'WHY_UNCLASSIFIED';

/** The judge question this verdict poses (§30). */
export function judgeQuestionFor(verdict: MatchReview['verdict']): JudgeQuestion {
  if (verdict === 'HIGH_CONFIDENCE_MATCH') return 'WHY_MATCH';
  if (verdict === 'NEEDS_TECHNICAL_REVIEW') return 'WHY_REVIEW';
  if (verdict === 'NOT_A_MATCH' || verdict === 'LOW_CONFIDENCE') return 'WHY_NOT';
  return 'WHY_UNCLASSIFIED';
}

/** Grouped answer bullets per judge question — deterministic templates. */
function headlineBullets(review: MatchReview, question: JudgeQuestion): string[] {
  const rows = review.technicalComparison;
  const exact = rows.filter((r) => r.relation === 'EXACT');
  const normalized = rows.filter((r) => r.relation === 'NORMALIZED');
  const close = rows.filter((r) => r.relation === 'CLOSE');
  const missing = rows.filter((r) => r.relation === 'MISSING');
  const conflicts = review.conflicts;

  if (question === 'WHY_MATCH') {
    const bullets: string[] = [];
    if (review.categoryRelationship === 'same_category') bullets.push(`Same material category (${review.leftMaterial.category}).`);
    if (review.manufacturerRelationship === 'same') bullets.push(`Same manufacturer (${review.leftMaterial.manufacturer}).`);
    for (const r of [...exact, ...normalized]) {
      bullets.push(`${labelize(r.attribute)} agrees: ${r.leftValue} = ${r.rightValue} (${r.relation}).`);
    }
    for (const r of close) bullets.push(`${labelize(r.attribute)} within tolerance: ${r.leftValue} vs ${r.rightValue}.`);
    bullets.push(`No critical technical conflict and no missing critical evidence; final score ${Math.round(review.finalScore)} meets the high-confidence threshold (≥ ${review.thresholds.highConfidence}).`);
    return bullets;
  }

  if (question === 'WHY_REVIEW') {
    const bullets: string[] = [];
    for (const c of conflicts) {
      bullets.push(`Critical conflict on ${labelize(c.attribute)}: ${c.leftValue ?? '?'} vs ${c.rightValue ?? '?'} — human technical review required.`);
    }
    for (const m of review.missingEvidence) bullets.push(`Missing critical evidence: ${labelize(m)} is absent on one record — equality cannot be confirmed.`);
    if (review.assemblyEvidence) bullets.push(`Assembly/kit difference: ${review.assemblyEvidence.detail}.`);
    if (review.manufacturerRelationship === 'different') bullets.push(`Different manufacturers (${review.leftMaterial.manufacturer} vs ${review.rightMaterial.manufacturer}) — cross-brand equivalence is never auto-accepted.`);
    if (bullets.length === 0) bullets.push(`Final score ${Math.round(review.finalScore)} is inside the review band (${review.thresholds.highConfidence ? `${review.thresholds.highConfidence - 20}–${review.thresholds.highConfidence - 0.01}` : '60–80'}) — similarity is not certainty.`);
    bullets.push('A human technical reviewer decides — the system never auto-approves conflicts.');
    return bullets;
  }

  if (question === 'WHY_NOT') {
    const bullets: string[] = [];
    if (review.categoryRelationship === 'cross_category') bullets.push(`Different material categories (${review.leftMaterial.category} vs ${review.rightMaterial.category}) — pair excluded from equivalence.`);
    for (const c of conflicts) bullets.push(`${labelize(c.attribute)} differs: ${c.leftValue ?? '?'} vs ${c.rightValue ?? '?'}.`);
    bullets.push(`Final score ${Math.round(review.finalScore)} is below the configured floor (${review.thresholds.highConfidence ? `NOT_A_MATCH < ${review.thresholds.highConfidence - 50}` : '< 30'}).`);
    return bullets;
  }

  return [
    `Detailed persisted evidence is unavailable for this legacy candidate. Displayed score components are from persisted candidate columns (semantic ${Math.round(review.semanticScore)}, fuzzy ${Math.round(review.fuzzyScore)}, technical ${Math.round(review.technicalScore)}, category ${review.ruleScore}).`,
  ];
}

function labelize(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/* --------------------------------- summary --------------------------------- */

/** Compact judge summary (§29) — every count from actual evidence rows. */
export interface JudgeSummary {
  exactAttributes: number;
  normalizedAttributes: number;
  closeAttributes: number;
  missingAttributes: number;
  conflictAttributes: number;
  criticalConflicts: number;
  finalAssessment: MatchReview['verdict'];
  humanReview: 'required' | 'not_required' | 'completed';
  cmiState: MatchReview['cmiState'];
}

function summarize(review: MatchReview): JudgeSummary {
  const rows = review.technicalComparison;
  const completed = review.status !== 'pending';
  return {
    exactAttributes: rows.filter((r) => r.relation === 'EXACT').length,
    normalizedAttributes: rows.filter((r) => r.relation === 'NORMALIZED').length,
    closeAttributes: rows.filter((r) => r.relation === 'CLOSE').length,
    missingAttributes: rows.filter((r) => r.relation === 'MISSING').length,
    conflictAttributes: rows.filter((r) => r.relation === 'CONFLICT').length,
    criticalConflicts: review.conflicts.filter((c) => c.criticality === 'CRITICAL').length,
    finalAssessment: review.verdict,
    humanReview: completed ? 'completed' : review.reviewRequired ? 'required' : 'not_required',
    cmiState: review.cmiState,
  };
}

/* --------------------------- completeness indicator ------------------------- */

export type EvidenceCompleteness = 'COMPLETE' | 'LIMITED';

/** COMPLETE only when the evidence required by the explanation contract exists. */
function completenessOf(review: MatchReview): EvidenceCompleteness {
  const hasComparison = review.technicalComparison.length > 0;
  const hasDecision = review.verdict !== 'UNCLASSIFIED';
  return hasComparison && hasDecision ? 'COMPLETE' : 'LIMITED';
}

/* ---------------------------------- brief ---------------------------------- */

/** The complete, deterministic Judge Mode brief (read-only). */
export interface JudgeBrief {
  candidateId: number;
  question: JudgeQuestion;
  completeness: EvidenceCompleteness;
  headline: {
    left: { cpse: string; code: string; description: string };
    right: { cpse: string; code: string; description: string };
    verdict: MatchReview['verdict'];
    verdictLabel: string;
    finalScore: number;
    humanReviewRequired: boolean;
    reason: string;
    bullets: string[];
  };
  scoreDecomposition: {
    components: Array<{ component: string; score: number; weightPct: number; contribution: number | null }>;
    finalScore: number;
    source: 'evidence_document' | 'persisted_columns';
  };
  identityComparison: Array<{ field: string; left: string | null; right: string | null; differs: boolean }>;
  technicalMatrix: TechnicalComparisonRow[];
  conflicts: TechnicalConflict[];
  missingEvidence: string[];
  assemblyEvidence: MatchReview['assemblyEvidence'];
  manufacturer: { relationship: MatchReview['manufacturerRelationship']; left: string | null; right: string | null; systemHandling: string };
  category: { left: string; right: string; result: 'Compatible' | 'Incompatible / excluded' };
  ruleTrace: RuleTraceItem[];
  verdictLogic: { verdict: string; because: string[] };
  thresholds: Record<string, number>;
  systemVsHuman: { assessment: string; humanDecision: string; separator: string };
  decisionHistory: MatchReview['decisionHistory'];
  cmi: { state: MatchReview['cmiState']; label: string; note: string };
  sourceTrace: { left: SourceTrace; right: SourceTrace };
  summary: JudgeSummary;
  provenance: string[];
}

const VERDICT_LABELS: Record<string, string> = {
  HIGH_CONFIDENCE_MATCH: 'HIGH CONFIDENCE MATCH',
  NEEDS_TECHNICAL_REVIEW: 'NEEDS TECHNICAL REVIEW',
  LOW_CONFIDENCE: 'LOW CONFIDENCE',
  NOT_A_MATCH: 'NOT A MATCH',
  UNCLASSIFIED: 'UNCLASSIFIED',
};

const CMI_LABELS: Record<string, string> = {
  cmi_pending: 'AWAITING CMI',
  cmi_created: 'CMI CREATED',
};

/**
 * Compose the Judge Mode brief. Pure read over the Step 23 contract + import
 * metadata: no rescoring, no writes, deterministic output for a given state.
 */
export function getJudgeBrief(matchId: number): JudgeBrief {
  const review = getMatchReview(matchId);
  const question = judgeQuestionFor(review.verdict);
  const completeness = completenessOf(review);

  // Score decomposition — persisted values only; contributions from the
  // evidence document when present, otherwise omitted honestly (never
  // recomputed in the client or fabricated here).
  const evWeights = review.why && review.why.ruleReason && review.technicalComparison.length > 0;
  const weights: Array<{ component: string; score: number; weightPct: number; contribution: number | null }> = [
    { component: 'Semantic similarity', score: Math.round(review.semanticScore), weightPct: 30, contribution: evWeights ? Math.round(0.3 * review.semanticScore) : null },
    { component: 'Fuzzy similarity', score: Math.round(review.fuzzyScore), weightPct: 20, contribution: evWeights ? Math.round(0.2 * review.fuzzyScore) : null },
    { component: 'Technical similarity', score: Math.round(review.technicalScore), weightPct: 30, contribution: evWeights ? Math.round(0.3 * review.technicalScore) : null },
    { component: 'Category / rules', score: Math.round(review.ruleScore), weightPct: 20, contribution: evWeights ? Math.round(0.2 * review.ruleScore) : null },
  ];

  const identityFields: Array<[string, string | null, string | null]> = [
    ['CPSE', review.leftMaterial.cpse, review.rightMaterial.cpse],
    ['Material code', review.leftMaterial.code, review.rightMaterial.code],
    ['Description', review.leftMaterial.description, review.rightMaterial.description],
    ['Category', review.leftMaterial.category, review.rightMaterial.category],
    ['Manufacturer', review.leftMaterial.manufacturer, review.rightMaterial.manufacturer],
    ['Part number', review.leftMaterial.partNumber, review.rightMaterial.partNumber],
    ['UOM', review.leftMaterial.uom, review.rightMaterial.uom],
  ];

  const verdictBecause: string[] = [];
  const t = review.thresholds;
  verdictBecause.push(`final score ${Math.round(review.finalScore)} vs thresholds: high-confidence ≥ ${t.highConfidence}, review ${t.highConfidence - 20}–${t.highConfidence - 0.01}, not-a-match < ${t.highConfidence - 50}`);
  if (review.conflicts.length > 0) verdictBecause.push(`${review.conflicts.length} technical conflict(s) detected (${review.conflicts.map((c) => labelize(c.attribute)).join(', ')})`);
  else verdictBecause.push('no critical technical conflict detected');
  if (review.missingEvidence.length > 0) verdictBecause.push(`${review.missingEvidence.length} missing critical attribute(s)`);
  else verdictBecause.push('no critical missing evidence');
  verdictBecause.push(`manufacturer relationship: ${review.manufacturerRelationship}`);
  if (review.assemblyEvidence) verdictBecause.push('assembly/kit configuration differs');

  const sourceTrace = { left: getSourceTrace(review.leftMaterial.id), right: getSourceTrace(review.rightMaterial.id) };

  return {
    candidateId: review.candidateId,
    question,
    completeness,
    headline: {
      left: { cpse: review.leftMaterial.cpse, code: review.leftMaterial.code, description: review.leftMaterial.description },
      right: { cpse: review.rightMaterial.cpse, code: review.rightMaterial.code, description: review.rightMaterial.description },
      verdict: review.verdict,
      verdictLabel: VERDICT_LABELS[review.verdict] ?? review.verdict,
      finalScore: Math.round(review.finalScore),
      humanReviewRequired: review.reviewRequired,
      reason: review.reason,
      bullets: headlineBullets(review, question),
    },
    scoreDecomposition: {
      components: weights,
      finalScore: Math.round(review.finalScore),
      source: evWeights ? 'evidence_document' : 'persisted_columns',
    },
    identityComparison: identityFields.map(([field, left, right]) => ({
      field,
      left,
      right,
      differs: (left ?? '').trim().toUpperCase() !== (right ?? '').trim().toUpperCase(),
    })),
    technicalMatrix: review.technicalComparison,
    conflicts: review.conflicts,
    missingEvidence: review.missingEvidence,
    assemblyEvidence: review.assemblyEvidence,
    manufacturer: {
      relationship: review.manufacturerRelationship,
      left: review.leftMaterial.manufacturer,
      right: review.rightMaterial.manufacturer,
      systemHandling:
        review.manufacturerRelationship === 'different'
          ? 'Review required because high-score cross-brand equivalence is not automatically accepted.'
          : review.manufacturerRelationship === 'same'
            ? 'No manufacturer obstacle to the assessment.'
            : 'Manufacturer unknown on at least one side — no manufacturer rule applied.',
    },
    category: {
      left: review.leftMaterial.category,
      right: review.rightMaterial.category,
      result: review.categoryRelationship === 'same_category' ? 'Compatible' : 'Incompatible / excluded',
    },
    ruleTrace: ruleTraceOf(review),
    verdictLogic: { verdict: VERDICT_LABELS[review.verdict] ?? review.verdict, because: verdictBecause },
    thresholds: { ...review.thresholds },
    systemVsHuman: {
      assessment: VERDICT_LABELS[review.verdict] ?? review.verdict,
      humanDecision:
        review.status === 'pending'
          ? 'PENDING'
          : review.decisionHistory.length > 0
            ? `${review.decisionHistory[0].decision.toUpperCase()} BY ${review.decisionHistory[0].reviewer}`
            : review.status.toUpperCase(),
      separator: 'System assessment is computed evidence — it is never a human engineering approval.',
    },
    decisionHistory: review.decisionHistory,
    cmi: {
      state: review.cmiState,
      label: review.cmiState ? (CMI_LABELS[review.cmiState] ?? review.cmiState) : 'NO CMI CREATED',
      note:
        review.cmiState === 'cmi_created'
          ? 'Common Material Identity created through the governed workflow after human approval.'
          : review.cmiState === 'cmi_pending'
            ? 'Approved pair awaiting governed CMI creation (human action required; Judge Mode never creates CMIs).'
            : 'No common material identity exists for this pair.',
    },
    sourceTrace,
    summary: summarize(review),
    provenance: [
      'SOURCE MATERIAL — material_records (originals never mutated)',
      'TECHNICAL ATTRIBUTE — material_attributes (rule-extracted / imported values)',
      'PERSISTED CANDIDATE SCORE — match_candidates (engine output at run time)',
      'MATCHING RULE — matching/config.ts critical rules + category strategies',
      'REVIEW DECISION — match_decisions (human, attributed)',
      'AUDIT EVENT — audit_logs (existing lifecycle actions)',
    ],
  };
}

/* ------------------------------ scope guard -------------------------------- */

/**
 * Organization read scope for one candidate (IDOR protection, §34): a scoped
 * CPSE user may only inspect candidates touching their own organization.
 * Returns the org ids the pair touches; the API/page layer compares against
 * visibleOrganizationIds(user).
 */
export function judgeScopeOrganizationIds(matchId: number): number[] {
  const row = getDb()
    .prepare(
      `SELECT s.organization_id AS a, c.organization_id AS b
         FROM match_candidates mc
         JOIN material_records s ON s.id = mc.source_material_id
         JOIN material_records c ON c.id = mc.candidate_material_id
        WHERE mc.id = ?`,
    )
    .get(matchId) as unknown as { a: number; b: number } | undefined;
  if (!row) throw errors.notFound('Match candidate');
  return [row.a, row.b];
}
