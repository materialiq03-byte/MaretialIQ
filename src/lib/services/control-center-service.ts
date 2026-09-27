/**
 * Control-center data assembly for the redesigned dashboard (Step 16A).
 *
 * READ-ONLY aggregation built on top of existing queries and repositories —
 * it introduces no new tables, no writes, and no engine changes. Every value
 * shown on the control-center dashboard comes from one of these sources:
 *   - metrics-repository (materials, CPSEs, reviews, identities, activity)
 *   - evaluation run history (latest accuracy — real, never hard-coded)
 *   - matching run audit trail (last engine run summary)
 *   - review queue open entries joined to their match candidates
 *
 * The flagship review case is the highest-priority OPEN queue entry (priority
 * high first, then strongest critical conflict) — real data, not a fixed ID.
 * If the queue is empty the panel renders an honest empty state instead.
 */
import { getDb } from '../db/client';
import type { DashboardMetrics } from '../db/repositories/metrics-repository';
import { loadRunHistory } from '../matching/run-history';
import { listOpportunities } from './procurement-opportunity-service';

export interface FlagshipReviewCase {
  matchId: number;
  sourceOrg: string;
  sourceCode: string;
  sourceDescription: string;
  candidateOrg: string;
  candidateCode: string;
  candidateDescription: string;
  criticalDifference: string | null;
  queuePriority: string | null;
}

export interface ControlCenterData {
  metrics: DashboardMetrics;
  resolvedReviews: number;
  evaluationAccuracy: number | null;
  evaluationRunId: string | null;
  lastMatchRun: { pairsCompared: number; candidatesCreated: number; at: string } | null;
  /** Pending decision-state distribution (from candidate evidence). */
  decisionStates: Array<{ state: string; n: number }>;
  /** Candidates dropped per run as NOT_A_MATCH (from the last run audit details). */
  droppedNotAMatch: number | null;
  /** The classic flagship pair CP-1001 ↔ BH-4410, whatever its decision state. */
  flagship: FlagshipReviewCase | null;
  /** The strongest OPEN technical-review case (what a reviewer should look at now). */
  openConflict: FlagshipReviewCase | null;
  /** UI-8.1: top OPEN attention cases (same ordering as flagship, limit 3). Read-only. */
  attentionCases: FlagshipReviewCase[];
  /** Latest human review decisions (real audit rows), newest first. */
  recentDecisions: Array<{
    matchId: number; action: string; reviewer: string; at: string;
  }>;
  /** Total candidates ever created (pending + decided). */
  totalCandidates: number;
  /** The active common material identity with its preserved legacy members. */
  harmonization: {
    code: string;
    name: string;
    category: string;
    members: Array<{ org: string; code: string }>;
  } | null;
  /** Step 15: compact procurement-signal counts (OPEN opportunities only). */
  procurementSignals: {
    openOpportunities: number;
    cmiLinkedRecords: number;
    unharmonizedRecords: number;
  };
}

export function getControlCenterData(metrics: DashboardMetrics): ControlCenterData {
  const db = getDb();

  // Resolved reviews = review-queue rows no longer open.
  const resolvedReviews = (
    db.prepare("SELECT COUNT(*) AS n FROM review_queue WHERE status != 'open'").get() as { n: number }
  ).n;

  // Latest real evaluation accuracy from the append-only run history.
  const runs = loadRunHistory();
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

  // Last matching run from the audit trail (details JSON written by runMatching).
  const runRow = db
    .prepare(
      `SELECT details, created_at FROM audit_logs WHERE action = 'match_generated' ORDER BY id DESC LIMIT 1`
    )
    .get() as { details: string; created_at: string } | undefined;
  let lastMatchRun: ControlCenterData['lastMatchRun'] = null;
  let droppedNotAMatch: number | null = null;
  if (runRow) {
    try {
      const d = JSON.parse(runRow.details) as {
        pairsCompared?: number;
        candidatesCreated?: number;
        droppedNotAMatch?: number;
      };
      if (typeof d.pairsCompared === 'number') {
        lastMatchRun = {
          pairsCompared: d.pairsCompared,
          candidatesCreated: d.candidatesCreated ?? 0,
          at: runRow.created_at,
        };
      }
      if (typeof d.droppedNotAMatch === 'number') droppedNotAMatch = d.droppedNotAMatch;
    } catch {
      // Malformed historical details — omit the panel values rather than guess.
    }
  }

  // Decision-state distribution over pending candidates (same JSON path the
  // metrics repository uses for matchOverview — reused verbatim).
  const decisionStates = (
    db
      .prepare(
        `SELECT COALESCE(json_extract(evidence, '$.decision.state'), 'UNCLASSIFIED') AS state,
                COUNT(*) AS n
           FROM match_candidates WHERE status = 'pending'
          GROUP BY state ORDER BY n DESC`
      )
      .all() as Array<{ state: string; n: number }>
  ).filter((r) => r.state !== 'UNCLASSIFIED');

  // Flagship case: the strongest TEXTUAL similarity among open critical-conflict
  // candidates (seal-class conflicts first, then combined semantic+fuzzy score).
  // That combination is the demo's core story — "almost the same words, different
  // part" — and it is real data, not a fixed ID. Falls back to any open
  // critical-conflict entry, then to any open entry; empty queue → honest empty state.
  // UI-8.1: the same ordering is reused read-only for the top-3 attention list —
  // no new logic, just a larger LIMIT on the identical query shape.
  const attentionRows = db
    .prepare(
      `SELECT rq.match_id, rq.priority, mc.critical_difference,
              so.code AS source_org, s.original_code AS source_code,
              s.original_description AS source_description,
              co.code AS candidate_org, c.original_code AS candidate_code,
              c.original_description AS candidate_description
         FROM review_queue rq
         JOIN match_candidates mc ON mc.id = rq.match_id
         JOIN material_records s ON s.id = mc.source_material_id
         JOIN material_records c ON c.id = mc.candidate_material_id
         JOIN organizations so ON so.id = s.organization_id
         JOIN organizations co ON co.id = c.organization_id
        WHERE rq.status = 'open'
        ORDER BY mc.critical_difference IS NULL,
                 mc.critical_difference NOT LIKE 'seal_type%',
                 (mc.semantic_score + mc.fuzzy_score) DESC
        LIMIT 3`
    )
    .all() as Array<{
      match_id: number; priority: string; critical_difference: string | null;
      source_org: string; source_code: string; source_description: string;
      candidate_org: string; candidate_code: string; candidate_description: string;
    }>;

  const toCase = (r: (typeof attentionRows)[number]): FlagshipReviewCase => ({
    matchId: r.match_id,
    sourceOrg: r.source_org,
    sourceCode: r.source_code,
    sourceDescription: r.source_description,
    candidateOrg: r.candidate_org,
    candidateCode: r.candidate_code,
    candidateDescription: r.candidate_description,
    criticalDifference: r.critical_difference,
    // Queue priority ('high'/'medium'/'low') is not a decision state — the
    // open case always renders as NEEDS TECHNICAL REVIEW.
    queuePriority: 'pending',
  });

  const flagship: FlagshipReviewCase | null = attentionRows.length > 0 ? toCase(attentionRows[0]) : null;
  const attentionCases: FlagshipReviewCase[] = attentionRows.map(toCase);

  // Total candidates (KPI: everything the engine has ever proposed).
  const totalCandidates = (
    db.prepare('SELECT COUNT(*) AS n FROM match_candidates').get() as { n: number }
  ).n;

  // The classic flagship pair (CP-1001 ↔ BH-4410): a real lookup by material
  // codes, not a hard-coded match ID. It may be pending OR already decided —
  // both states render honestly (decided state shows the recorded decision).
  const flagshipPair = db
    .prepare(
      `SELECT mc.id, mc.status, mc.critical_difference,
              COALESCE(md.decision, 'pending') AS decision,
              so.code AS source_org, s.original_code AS source_code,
              s.original_description AS source_description,
              co.code AS candidate_org, c.original_code AS candidate_code,
              c.original_description AS candidate_description
         FROM match_candidates mc
         LEFT JOIN match_decisions md ON md.match_id = mc.id
         JOIN material_records s ON s.id = mc.source_material_id
         JOIN material_records c ON c.id = mc.candidate_material_id
         JOIN organizations so ON so.id = s.organization_id
         JOIN organizations co ON co.id = c.organization_id
        WHERE (s.original_code = 'CP-1001' AND c.original_code = 'BH-4410')
           OR (s.original_code = 'BH-4410' AND c.original_code = 'CP-1001')
        LIMIT 1`
    )
    .get() as
    | {
        id: number; status: string; critical_difference: string | null; decision: string;
        source_org: string; source_code: string; source_description: string;
        candidate_org: string; candidate_code: string; candidate_description: string;
      }
    | undefined;

  const flagshipClassic: FlagshipReviewCase | null = flagshipPair
    ? {
        matchId: flagshipPair.id,
        sourceOrg: flagshipPair.source_org,
        sourceCode: flagshipPair.source_code,
        sourceDescription: flagshipPair.source_description,
        candidateOrg: flagshipPair.candidate_org,
        candidateCode: flagshipPair.candidate_code,
        candidateDescription: flagshipPair.candidate_description,
        criticalDifference: flagshipPair.critical_difference,
        queuePriority: flagshipPair.decision,
      }
    : null;

  // Harmonization outcome: the active CMI and its preserved legacy members.
  const cmiRow = db
    .prepare(
      `SELECT id, code, name, category FROM common_materials WHERE is_active = 1 ORDER BY id DESC LIMIT 1`
    )
    .get() as { id: number; code: string; name: string; category: string } | undefined;
  let harmonization: ControlCenterData['harmonization'] = null;
  if (cmiRow) {
    const members = (
      db
        .prepare(
          `SELECT o.code AS org, mr.original_code AS code
             FROM material_mappings m
             JOIN organizations o ON o.id = m.organization_id
             JOIN material_records mr ON mr.id = m.material_id
            WHERE m.cmi_id = ? ORDER BY o.code`
        )
        .all(cmiRow.id) as Array<{ org: string; code: string }>
    );
    harmonization = { code: cmiRow.code, name: cmiRow.name, category: cmiRow.category, members };
  }

  // Latest human review decisions — real audit rows, newest first.
  const recentDecisions = (
    db
      .prepare(
        `SELECT entity_id AS match_id, action, actor, created_at
           FROM audit_logs
          WHERE action IN ('proposal_approved', 'proposal_rejected', 'proposal_deferred')
            AND entity_id IS NOT NULL
          ORDER BY id DESC LIMIT 5`
      )
      .all() as Array<{ match_id: number; action: string; actor: string; created_at: string }>
  ).map((r) => ({ matchId: r.match_id, action: r.action, reviewer: r.actor, at: r.created_at }));

  return {
    metrics,
    resolvedReviews,
    evaluationAccuracy: lastRun ? lastRun.accuracy : null,
    evaluationRunId: lastRun ? lastRun.runId : null,
    lastMatchRun,
    decisionStates,
    droppedNotAMatch,
    flagship: flagshipClassic,
    openConflict: flagship,
    attentionCases,
    recentDecisions,
    totalCandidates,
    harmonization,
    procurementSignals: buildProcurementSignals(db),
  };
}

/**
 * Step 15 (section 26): three compact numbers for the dashboard - open
 * opportunity count, CMI-linked records, unharmonized records. Wrapped in a
 * try/catch: procurement tables may not exist on pre-Step-12 databases.
 */
function buildProcurementSignals(db: ReturnType<typeof getDb>): ControlCenterData['procurementSignals'] {
  try {
    const open = listOpportunities({ status: 'OPEN' }, 1, 1).total;
    const coverage = db
      .prepare(
        `SELECT SUM(CASE WHEN cmi_id IS NOT NULL THEN 1 ELSE 0 END) AS linked,
                SUM(CASE WHEN cmi_id IS NULL THEN 1 ELSE 0 END) AS unlinked
           FROM procurement_records`
      )
      .get() as { linked: number | null; unlinked: number | null };
    return {
      openOpportunities: open,
      cmiLinkedRecords: coverage.linked ?? 0,
      unharmonizedRecords: coverage.unlinked ?? 0,
    };
  } catch {
    // procurement tables may not exist on pre-Step-12 databases.
    return { openOpportunities: 0, cmiLinkedRecords: 0, unharmonizedRecords: 0 };
  }
}
