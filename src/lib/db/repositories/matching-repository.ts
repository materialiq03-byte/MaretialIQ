import { getDb } from '../client';
import { errors } from '../../errors';
import { nowIso } from '../util';
import type { Decision, MatchStatus, MatchType, QueuePriority, QueueStatus } from '../../types/domain';

export interface MatchCandidateRow {
  id: number;
  source_material_id: number;
  candidate_material_id: number;
  semantic_score: number;
  fuzzy_score: number;
  technical_score: number;
  category_compatible: number;
  final_score: number;
  match_type: MatchType;
  explanation: string;
  critical_difference: string | null;
  evidence: string | null;
  match_run_id: string | null;
  status: MatchStatus;
  created_at: string;
  updated_at: string;
}

export interface MatchWithContext {
  candidate: MatchCandidateRow;
  source: {
    id: number; org_code: string; original_code: string; original_description: string;
    category: string; uom: string;
  };
  candidateMat: {
    id: number; org_code: string; original_code: string; original_description: string;
    category: string; uom: string;
  };
  decision: { decision: Decision; reviewer: string; comment: string | null; decided_at: string } | null;
  queue: { id: number; priority: QueuePriority; reason: string; critical_difference: string | null;
           status: QueueStatus; assigned_reviewer: string | null } | null;
  /** Step 11, derived: for approved pairs 'cmi_created' | 'cmi_pending'; else null. */
  cmiState: 'cmi_created' | 'cmi_pending' | null;
}

const MAT_SELECT = `s.id AS s_id, s.original_code AS s_code, s.original_description AS s_desc,
  s.category AS s_category, s.uom AS s_uom, so.code AS s_org,
  c.id AS c_id, c.original_code AS c_code, c.original_description AS c_desc,
  c.category AS c_category, c.uom AS c_uom, co.code AS c_org`;

/**
 * Step 11: derived CMI state. A pair is 'cmi_created' iff BOTH materials are
 * mapped to the SAME ACTIVE common material identity; an approved pair
 * otherwise derives as 'cmi_pending'. Non-approved pairs derive NULL.
 * Computed via EXISTS subqueries - no duplicated/synced column, always
 * current CMI state; uses the material_mappings.material_id index.
 */
const CMI_STATE_EXPR = `CASE WHEN mc.status != 'approved' THEN NULL
  WHEN EXISTS (
    SELECT 1 FROM material_mappings ma
    JOIN material_mappings mb ON mb.cmi_id = ma.cmi_id
    JOIN common_materials cm ON cm.id = ma.cmi_id AND cm.is_active = 1
    WHERE ma.material_id = mc.source_material_id
      AND mb.material_id = mc.candidate_material_id
  ) THEN 'cmi_created'
  ELSE 'cmi_pending' END`;
const CMI_STATE_SELECT = `${CMI_STATE_EXPR} AS cmi_state`;

const BASE = `
  SELECT mc.*, ${MAT_SELECT},
         ${CMI_STATE_SELECT},
         d.decision AS d_decision, d.reviewer AS d_reviewer, d.comment AS d_comment,
         d.decided_at AS d_decided_at,
         rq.id AS q_id, rq.priority AS q_priority, rq.reason AS q_reason,
         rq.critical_difference AS q_crit, rq.status AS q_status,
         rq.assigned_reviewer AS q_reviewer
    FROM match_candidates mc
    JOIN material_records s ON s.id = mc.source_material_id
    JOIN organizations so ON so.id = s.organization_id
    JOIN material_records c ON c.id = mc.candidate_material_id
    JOIN organizations co ON co.id = c.organization_id
    LEFT JOIN (
      SELECT md.*, ROW_NUMBER() OVER (PARTITION BY md.match_id ORDER BY md.id DESC) rn
        FROM match_decisions md
    ) d ON d.match_id = mc.id AND d.rn = 1
    LEFT JOIN review_queue rq ON rq.match_id = mc.id`;

interface RawRow extends Record<string, unknown> {
  id: number;
}

function hydrate(r: RawRow): MatchWithContext {
  return {
    candidate: {
      id: r.id as number,
      source_material_id: r.source_material_id as number,
      candidate_material_id: r.candidate_material_id as number,
      semantic_score: r.semantic_score as number,
      fuzzy_score: r.fuzzy_score as number,
      technical_score: r.technical_score as number,
      category_compatible: r.category_compatible as number,
      final_score: r.final_score as number,
      match_type: r.match_type as MatchType,
      explanation: r.explanation as string,
      critical_difference: (r.critical_difference as string | null) ?? null,
      evidence: (r.evidence as string | null) ?? null,
      match_run_id: (r.match_run_id as string | null) ?? null,
      status: r.status as MatchStatus,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    },
    cmiState: (r.cmi_state as 'cmi_created' | 'cmi_pending' | null) ?? null,
    source: {
      id: r.s_id as number,
      org_code: r.s_org as string,
      original_code: r.s_code as string,
      original_description: r.s_desc as string,
      category: r.s_category as string,
      uom: r.s_uom as string,
    },
    candidateMat: {
      id: r.c_id as number,
      org_code: r.c_org as string,
      original_code: r.c_code as string,
      original_description: r.c_desc as string,
      category: r.c_category as string,
      uom: r.c_uom as string,
    },
    decision: r.d_decision
      ? {
          decision: r.d_decision as Decision,
          reviewer: r.d_reviewer as string,
          comment: (r.d_comment as string | null) ?? null,
          decided_at: r.d_decided_at as string,
        }
      : null,
    queue: r.q_id
      ? {
          id: r.q_id as number,
          priority: r.q_priority as QueuePriority,
          reason: r.q_reason as string,
          critical_difference: (r.q_crit as string | null) ?? null,
          status: r.q_status as QueueStatus,
          assigned_reviewer: (r.q_reviewer as string | null) ?? null,
        }
      : null,
  };
}

export interface MatchFilters {
  status?: MatchStatus;
  matchType?: MatchType;
  organizationCode?: string;
  category?: string;
  manufacturer?: string;
  /** Spec §7 decision state (stored in the evidence JSON). */
  decision?: string;
  /** Confidence band from the evidence JSON ('high' | 'review' | 'low' | 'reject'). */
  confidenceBand?: string;
  /** Step 23: restrict to candidates carrying ≥1 critical technical conflict. */
  hasCriticalConflicts?: boolean;
  minScore?: number;
  maxScore?: number;
  /** Restrict to pairs touching this material id (either side). */
  materialId?: number;
  /** Step 11: filter approved pairs by derived CMI state. */
  cmiState?: 'cmi_created' | 'cmi_pending';
  /** Step 23: deterministic ordering (default score_desc). */
  sort?: ReviewSort;
  page: number;
  pageSize: number;
}

/** Step 23: deterministic sort orders for the review workspace (§18). */
export type ReviewSort = 'score_desc' | 'score_asc' | 'oldest' | 'newest' | 'priority';

const REVIEW_SORT_SQL: Record<ReviewSort, string> = {
  score_desc: 'mc.final_score DESC, mc.id ASC',
  score_asc: 'mc.final_score ASC, mc.id ASC',
  oldest: 'mc.created_at ASC, mc.id ASC',
  newest: 'mc.created_at DESC, mc.id DESC',
  priority: `CASE COALESCE(rq.priority, 'low') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC, mc.final_score DESC, mc.id ASC`,
};

/** Parse a client-supplied sort token, failing closed to the default. */
export function parseReviewSort(value: string | undefined | null): ReviewSort {
  return value && value in REVIEW_SORT_SQL ? (value as ReviewSort) : 'score_desc';
}

export interface ApprovalCmiFunnel {
  approvedTotal: number;
  awaitingCmi: number;
  cmiCreated: number;
}

/** Step 11 KPI: where approved relationships stand relative to the registry. */
export function getApprovalCmiFunnel(): ApprovalCmiFunnel {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS approved_total,
         SUM(CASE WHEN (${CMI_STATE_EXPR}) = 'cmi_pending' THEN 1 ELSE 0 END) AS awaiting_cmi,
         SUM(CASE WHEN (${CMI_STATE_EXPR}) = 'cmi_created' THEN 1 ELSE 0 END) AS cmi_created
       FROM match_candidates mc WHERE mc.status = 'approved'`
    )
    .get() as unknown as { approved_total: number; awaiting_cmi: number | null; cmi_created: number | null };
  return {
    approvedTotal: row.approved_total,
    awaitingCmi: row.awaiting_cmi ?? 0,
    cmiCreated: row.cmi_created ?? 0,
  };
}

/**
 * JSON1 extraction helpers. The decision state and band are stored inside the
 * evidence document written by the engine — no duplicated columns, no schema
 * change, full-text-indexable later if the dataset grows.
 */
const DECISION_CLAUSE = "json_extract(mc.evidence, '$.decision.state')";
const BAND_CLAUSE = "json_extract(mc.evidence, '$.decision.band')";

export function listMatches(f: MatchFilters): { items: MatchWithContext[]; total: number } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (f.status) {
    clauses.push('mc.status = ?');
    params.push(f.status);
  }
  if (f.matchType) {
    clauses.push('mc.match_type = ?');
    params.push(f.matchType);
  }
  if (f.organizationCode) {
    clauses.push('(so.code = ? OR co.code = ?)');
    params.push(f.organizationCode, f.organizationCode);
  }
  if (f.minScore !== undefined) {
    clauses.push('mc.final_score >= ?');
    params.push(f.minScore);
  }
  if (f.maxScore !== undefined) {
    clauses.push('mc.final_score <= ?');
    params.push(f.maxScore);
  }
  if (f.materialId !== undefined) {
    clauses.push('(mc.source_material_id = ? OR mc.candidate_material_id = ?)');
    params.push(f.materialId, f.materialId);
  }
  if (f.category) {
    clauses.push('s.category = ? AND c.category = ?');
    params.push(f.category, f.category);
  }
  if (f.manufacturer) {
    clauses.push('(s.manufacturer = ? OR c.manufacturer = ?)');
    params.push(f.manufacturer, f.manufacturer);
  }
  if (f.decision) {
    clauses.push(`${DECISION_CLAUSE} = ?`);
    params.push(f.decision);
  }
  if (f.confidenceBand) {
    clauses.push(`${BAND_CLAUSE} = ?`);
    params.push(f.confidenceBand);
  }
  if (f.hasCriticalConflicts) {
    clauses.push("json_array_length(mc.evidence, '$.criticalConflicts') > 0");
  }
  if (f.cmiState) {
    clauses.push(`(${CMI_STATE_EXPR}) = ?`);
    params.push(f.cmiState);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sort = REVIEW_SORT_SQL[f.sort ?? 'score_desc'];
  const items = getDb()
    .prepare(`${BASE} ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as unknown as RawRow[];
  const total = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM match_candidates mc
           JOIN material_records s ON s.id = mc.source_material_id
           JOIN organizations so ON so.id = s.organization_id
           JOIN material_records c ON c.id = mc.candidate_material_id
           JOIN organizations co ON co.id = c.organization_id ${where}`
      )
      .get(...params) as unknown as { n: number }
  ).n;
  return { items: items.map(hydrate), total };
}

/** Manufacturers present in the catalogue — populates the match filter dropdown. */
export function listDistinctMatchManufacturers(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT manufacturer FROM material_records
          WHERE manufacturer IS NOT NULL AND manufacturer != ''
          ORDER BY manufacturer`
      )
      .all() as Array<{ manufacturer: string }>
  ).map((r) => r.manufacturer);
}

export function getMatch(id: number): MatchWithContext | undefined {
  const row = getDb().prepare(`${BASE} WHERE mc.id = ?`).get(id) as unknown as RawRow | undefined;
  return row ? hydrate(row) : undefined;
}

export function getMatchRequired(id: number): MatchWithContext {
  const row = getMatch(id);
  if (!row) throw errors.notFound('Match candidate');
  return row;
}

export interface NewMatch {
  sourceMaterialId: number;
  candidateMaterialId: number;
  semanticScore: number;
  fuzzyScore: number;
  technicalScore: number;
  categoryCompatible: boolean;
  finalScore: number;
  matchType: MatchType;
  explanation: string;
  criticalDifference?: string | null;
  evidence?: string | null;
  matchRunId?: string | null;
}

export function upsertMatch(m: NewMatch): { id: number; created: boolean } {
  const res = getDb()
    .prepare(
      `INSERT INTO match_candidates
         (source_material_id, candidate_material_id, semantic_score, fuzzy_score,
          technical_score, category_compatible, final_score, match_type, explanation,
          critical_difference, evidence, match_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_material_id, candidate_material_id) DO UPDATE SET
         semantic_score = excluded.semantic_score,
         fuzzy_score = excluded.fuzzy_score,
         technical_score = excluded.technical_score,
         category_compatible = excluded.category_compatible,
         final_score = excluded.final_score,
         match_type = excluded.match_type,
         explanation = excluded.explanation,
         critical_difference = excluded.critical_difference,
         evidence = excluded.evidence,
         match_run_id = excluded.match_run_id,
         updated_at = excluded.updated_at
       WHERE match_candidates.status = 'pending'`
    )
    .run(
      m.sourceMaterialId,
      m.candidateMaterialId,
      m.semanticScore,
      m.fuzzyScore,
      m.technicalScore,
      m.categoryCompatible ? 1 : 0,
      m.finalScore,
      m.matchType,
      m.explanation,
      m.criticalDifference ?? null,
      m.evidence ?? null,
      m.matchRunId ?? null
    );
  // Only trust lastInsertRowid when the statement actually wrote a row. On a
  // guarded UPSERT that matched a DECIDED candidate (status != 'pending')
  // nothing is written, and lastInsertRowid is a stale value pointing at no
  // row — using it used to crash enqueueReview with a FOREIGN KEY error.
  if (Number(res.changes) > 0) {
    const id = Number(res.lastInsertRowid);
    if (Number.isInteger(id) && id > 0) return { id, created: true };
  }
  const existing = getDb()
    .prepare(`SELECT id FROM match_candidates WHERE source_material_id = ? AND candidate_material_id = ?`)
    .get(m.sourceMaterialId, m.candidateMaterialId) as { id: number } | undefined;
  return { id: existing?.id ?? 0, created: false };
}

/**
 * Drop every pending candidate (and its dependent rows) before a
 * rerun. Dependents are removed FIRST — foreign keys are enforced — otherwise
 * the candidate delete fails with a FOREIGN KEY constraint error. That
 * includes common_materials rows whose source_match_id points at a pending
 * candidate (auto-created CMIs have no human decision attached, so they
 * carry no recorded review history and are safe to regenerate on the next
 * run); CMIs sourced from decided matches are left untouched.
 */
export function deletePendingMatches(): void {
  getDb()
    .prepare(
      `DELETE FROM match_decisions WHERE match_id IN (SELECT id FROM match_candidates WHERE status = 'pending')`
    )
    .run();
  getDb()
    .prepare(
      `DELETE FROM review_queue WHERE match_id IN (SELECT id FROM match_candidates WHERE status = 'pending')`
    )
    .run();
  getDb()
    .prepare(
      `DELETE FROM common_materials WHERE source_match_id IN (SELECT id FROM match_candidates WHERE status = 'pending')`
    )
    .run();
  getDb().prepare(`DELETE FROM match_candidates WHERE status = 'pending'`).run();
}

export function recordDecision(input: {
  matchId: number;
  decision: Decision;
  reviewer: string;
  comment: string | null;
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO match_decisions (match_id, decision, reviewer, comment) VALUES (?, ?, ?, ?)`
    )
    .run(input.matchId, input.decision, input.reviewer, input.comment ?? null);
  return Number(res.lastInsertRowid);
}

export function setMatchStatus(matchId: number, status: MatchStatus): void {
  getDb().prepare(`UPDATE match_candidates SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), matchId);
}

/** Insert an open queue entry; no-op if one already exists for the match. */
export function enqueueReview(input: {
  matchId: number;
  priority: QueuePriority;
  reason: string;
  criticalDifference?: string | null;
}): boolean {
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO review_queue (match_id, priority, reason, critical_difference)
       VALUES (?, ?, ?, ?)`
    )
    .run(input.matchId, input.priority, input.reason, input.criticalDifference ?? null);
  return Number(res.changes) > 0;
}

export function updateQueueEntry(
  matchId: number,
  input: { status?: QueueStatus; assignedReviewer?: string }
): void {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (input.status) {
    sets.push('status = ?');
    params.push(input.status);
    if (input.status === 'resolved') {
      sets.push('resolved_at = ?');
      params.push(nowIso());
    }
  }
  if (input.assignedReviewer !== undefined) {
    sets.push('assigned_reviewer = ?');
    params.push(input.assignedReviewer);
  }
  if (!sets.length) return;
  params.push(nowIso(), matchId);
  getDb().prepare(`UPDATE review_queue SET ${sets.join(', ')} WHERE match_id = ?`).run(...params);
}

export function resolveQueueEntry(matchId: number): void {
  getDb()
    .prepare(
      `UPDATE review_queue SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE match_id = ?`
    )
    .run(nowIso(), nowIso(), matchId);
}

export function openQueueCount(): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM review_queue WHERE status = 'open'`).get() as { n: number }
  ).n;
}
