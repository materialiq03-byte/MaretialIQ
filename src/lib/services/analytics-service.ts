/**
 * Cross-CPSE harmonization analytics (TRD §20 "Analytics" module).
 * Every figure is a live SQL aggregate over data/materialiq.db — nothing is
 * hard-coded, per FR-16 and PRD §14.
 */
import { getDb } from '../db/client';

export interface AnalyticsData {
  materialsByCategory: Array<{ category: string; n: number }>;
  materialsByOrg: Array<{ code: string; n: number }>;
  /** decision-state distribution over persisted candidates (JSON evidence) */
  decisions: Array<{ decision: string; n: number }>;
  /** match-type classification distribution */
  matchTypes: Array<{ match_type: string; n: number }>;
  /** pending review queue by priority */
  reviewPriority: Array<{ priority: string; n: number }>;
  /** top critical differences currently pending review */
  topConflicts: Array<{ attribute: string; n: number }>;
  /** per-CPSE: records, pending duplicates found, open reviews involving it */
  cpseTable: Array<{
    code: string;
    materials: number;
    candidates: number;
    pendingReviews: number;
    highConfidence: number;
  }>;
  cmis: number;
  mappings: number;
  importsTotal: number;
  importsRejectedRows: number;
}

function jsonCount(column: string, path: string): Array<{ decision: string; n: number }> {
  const rows = getDb()
    .prepare(
      `SELECT json_extract(${column}, '${path}') AS decision, COUNT(*) AS n
         FROM match_candidates GROUP BY decision ORDER BY n DESC, decision`
    )
    .all() as Array<{ decision: string; n: number }>;
  // node:sqlite returns null-prototype rows, which cannot cross the
  // Server→Client Component boundary (Recharts). Clone to plain objects.
  return rows.map((r) => ({ decision: r.decision, n: r.n }));
}

/** Pull "attr: A vs B" out of stored critical_difference / decision reasons. */
function conflictBreakdown(): Array<{ attribute: string; n: number }> {
  const rows = getDb()
    .prepare(
      `SELECT json_extract(evidence, '$.decision.reason') AS reason, COUNT(*) AS n
         FROM match_candidates
        WHERE json_extract(evidence, '$.decision.state') = 'NEEDS_TECHNICAL_REVIEW'
          AND json_extract(evidence, '$.decision.reason') LIKE 'critical technical conflict:%'
        GROUP BY reason ORDER BY n DESC, reason LIMIT 12`
    )
    .all() as Array<{ reason: string; n: number }>;
  return rows.map((r) => {
    const m = /conflict: ([a-z_]+):/i.exec(r.reason);
    // plain-object clone: see jsonCount note re null prototypes
    return { attribute: m ? m[1] : r.reason.replace('critical technical conflict: ', ''), n: r.n };
  });
}

export function getAnalytics(): AnalyticsData {
  const db = getDb();
  const decisions = jsonCount('evidence', '$.decision.state');
  // de-escalate legacy rows whose evidence lacks a decision object
  const legacy = decisions.find((d) => d.decision === null)?.n ?? 0;
  const cleaned = decisions.filter((d) => d.decision !== null);
  if (legacy > 0) cleaned.push({ decision: 'legacy (pre-decision evidence)', n: legacy });

  const byOrg = (db
    .prepare(
      `SELECT o.code, COUNT(*) AS n FROM material_records m
        JOIN organizations o ON o.id = m.organization_id
       WHERE m.is_active = 1 GROUP BY o.code ORDER BY o.code`
    )
    .all() as Array<{ code: string; n: number }>).map((r) => ({ code: r.code, n: r.n }));

  const cpseTable = db
    .prepare(
      `SELECT o.code,
              (SELECT COUNT(*) FROM material_records m WHERE m.organization_id = o.id AND m.is_active = 1) AS materials,
              (SELECT COUNT(*) FROM match_candidates mc
                 JOIN material_records s ON s.id = mc.source_material_id
                 JOIN material_records c ON c.id = mc.candidate_material_id
                WHERE s.organization_id = o.id OR c.organization_id = o.id) AS candidates,
              (SELECT COUNT(*) FROM review_queue rq
                 JOIN match_candidates mc ON mc.id = rq.match_id
                 JOIN material_records s ON s.id = mc.source_material_id
                 JOIN material_records c ON c.id = mc.candidate_material_id
                WHERE rq.status = 'open' AND (s.organization_id = o.id OR c.organization_id = o.id)) AS pendingReviews,
              (SELECT COUNT(*) FROM match_candidates mc
                 JOIN material_records s ON s.id = mc.source_material_id
                 JOIN material_records c ON c.id = mc.candidate_material_id
                WHERE (s.organization_id = o.id OR c.organization_id = o.id)
                  AND json_extract(mc.evidence, '$.decision.state') = 'HIGH_CONFIDENCE_MATCH') AS highConfidence
         FROM organizations o ORDER BY o.code`
    )
    .all() as AnalyticsData['cpseTable'];

  const imports = db
    .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(error_rows), 0) AS rejected FROM data_imports`)
    .get() as { total: number; rejected: number };

  return {
    materialsByCategory: (db
      .prepare(`SELECT category, COUNT(*) AS n FROM material_records WHERE is_active = 1 GROUP BY category ORDER BY n DESC, category`)
      .all() as Array<{ category: string; n: number }>).map((r) => ({ category: r.category, n: r.n })),
    materialsByOrg: byOrg,
    decisions: cleaned,
    matchTypes: (db
      .prepare(`SELECT match_type, COUNT(*) AS n FROM match_candidates GROUP BY match_type ORDER BY n DESC, match_type`)
      .all() as Array<{ match_type: string; n: number }>).map((r) => ({ match_type: r.match_type, n: r.n })),
    reviewPriority: (db
      .prepare(`SELECT priority, COUNT(*) AS n FROM review_queue WHERE status = 'open' GROUP BY priority ORDER BY n DESC, priority`)
      .all() as Array<{ priority: string; n: number }>).map((r) => ({ priority: r.priority, n: r.n })),
    topConflicts: conflictBreakdown(),
    cpseTable: cpseTable.map((r) => ({
      code: r.code,
      materials: r.materials,
      candidates: r.candidates,
      pendingReviews: r.pendingReviews,
      highConfidence: r.highConfidence,
    })),
    cmis: (db.prepare(`SELECT COUNT(*) AS n FROM common_materials`).get() as { n: number }).n,
    mappings: (db.prepare(`SELECT COUNT(*) AS n FROM material_mappings`).get() as { n: number }).n,
    importsTotal: imports.total,
    importsRejectedRows: imports.rejected,
  };
}
