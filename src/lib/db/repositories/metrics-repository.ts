import { getDb } from '../client';
import { countByProcessingStatus, countByQualityStatus } from './material-repository';

/**
 * Dashboard metrics, computed from the database with an optional organization
 * scope. `organizationId = null` means platform-wide (authority/admin and the
 * CPSE dashboards' cross-CPSE counters where the role is entitled to them).
 * Every number on every dashboard comes from one of these queries — nothing
 * is hardcoded in UI components.
 */
export interface DashboardMetrics {
  totalMaterials: number;
  pendingReviews: number;
  potentialDuplicates: number;
  functionalEquivalents: number;
  criticalConflicts: number;
  commonIdentities: number;
  totalMappings: number;
  importsCompleted: number;
  pendingImports: number;
  organizations: number;
  users: number;
  byMatchType: Array<{ match_type: string; n: number }>;
  byStatus: Array<{ status: string; n: number }>;
  byCategory: Array<{ category: string; n: number }>;
  byProcessingStatus: Array<{ processing_status: string; n: number }>;
  byQualityStatus: Array<{ quality_status: string; n: number }>;
  openQueue: Array<{ priority: string; n: number }>;
  /** Review-queue workload by status (open / resolved). */
  queueStatus: Array<{ status: string; n: number }>;
  recentImports: Array<{
    id: number; file_name: string; org_code: string; status: string;
    total_rows: number; successful_rows: number; failed_rows: number; created_at: string;
  }>;
  recentActivity: Array<{
    id: number; action: string; entity_type: string; entity_id: number | null;
    actor: string; created_at: string;
  }>;
  perOrganization: Array<{
    id: number; code: string; name: string; materials: number;
    pending_reviews: number; critical_conflicts: number; mappings: number;
  }>;
  deferredCount: number;
  /** Pending candidates grouped by prototype decision state (from evidence JSON). */
  matchOverview: Array<{ decision: string; n: number }>;
  /** Pending HIGH_CONFIDENCE_MATCH candidates — the headline matching metric. */
  highConfidenceCandidates: number;
  recentDecisions: Array<{
    id: number; decision: string; reviewer: string; match_id: number;
    s_code: string; s_org: string; c_code: string; c_org: string; decided_at: string;
  }>;
}

export function getDashboardMetrics(organizationId?: number | null): DashboardMetrics {
  const db = getDb();
  const one = (sql: string, ...params: Array<string | number>): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  // Org scope: CPSE dashboards restrict material/import metrics to their org.
  // Match/review metrics are inherently cross-CPSE; CPSE users see those that
  // involve their organization.
  const scoped = organizationId !== null && organizationId !== undefined;
  const orgFilter = scoped ? ' AND organization_id = ?' : '';
  const orgParams = scoped ? [organizationId] : [];

  const matchOrgFilter = scoped
    ? ' AND (source_material_id IN (SELECT id FROM material_records WHERE organization_id = ?) OR candidate_material_id IN (SELECT id FROM material_records WHERE organization_id = ?))'
    : '';
  const matchOrgParams = scoped ? [organizationId, organizationId] : [];

  return {
    totalMaterials: one(
      `SELECT COUNT(*) AS n FROM material_records WHERE is_active = 1${orgFilter}`, ...orgParams
    ),
    pendingReviews: one(
      `SELECT COUNT(*) AS n FROM review_queue rq WHERE rq.status = 'open'${scoped
        ? ' AND (rq.match_id IN (SELECT mc.id FROM match_candidates mc JOIN material_records s ON s.id = mc.source_material_id JOIN material_records c ON c.id = mc.candidate_material_id WHERE s.organization_id = ? OR c.organization_id = ?))'
        : ''}`,
      ...matchOrgParams
    ),
    potentialDuplicates: one(
      `SELECT COUNT(*) AS n FROM match_candidates WHERE match_type = 'near_duplicate' AND status = 'pending'${matchOrgFilter}`,
      ...matchOrgParams
    ),
    functionalEquivalents: one(
      `SELECT COUNT(*) AS n FROM match_candidates WHERE match_type = 'functional_equivalent' AND status = 'pending'${matchOrgFilter}`,
      ...matchOrgParams
    ),
    criticalConflicts: one(
      `SELECT COUNT(*) AS n FROM match_candidates WHERE critical_difference IS NOT NULL AND status = 'pending'${matchOrgFilter}`,
      ...matchOrgParams
    ),
    commonIdentities: one(`SELECT COUNT(*) AS n FROM common_materials WHERE is_active = 1`),
    totalMappings: one(
      `SELECT COUNT(*) AS n FROM material_mappings${scoped ? ' WHERE organization_id = ?' : ''}`,
      ...orgParams
    ),
    importsCompleted: one(
      `SELECT COUNT(*) AS n FROM data_imports WHERE status = 'completed'${orgFilter}`, ...orgParams
    ),
    pendingImports: one(
      `SELECT COUNT(*) AS n FROM data_imports WHERE status IN ('pending','processing')${orgFilter}`,
      ...orgParams
    ),
    organizations: one(`SELECT COUNT(*) AS n FROM organizations WHERE status = 'active'`),
    users: one(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`),
    byMatchType: db
      .prepare(
        `SELECT match_type, COUNT(*) AS n FROM match_candidates WHERE 1=1${matchOrgFilter} GROUP BY match_type`
      )
      .all(...matchOrgParams) as Array<{ match_type: string; n: number }>,
    byStatus: db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM match_candidates WHERE 1=1${matchOrgFilter} GROUP BY status`
      )
      .all(...matchOrgParams) as Array<{ status: string; n: number }>,
    byCategory: db
      .prepare(
        `SELECT category, COUNT(*) AS n FROM material_records WHERE is_active = 1${orgFilter} GROUP BY category ORDER BY n DESC, category`
      )
      .all(...orgParams) as Array<{ category: string; n: number }>,
    byProcessingStatus: scoped
      ? (db
          .prepare(
            `SELECT processing_status, COUNT(*) AS n FROM material_records WHERE is_active = 1 AND organization_id = ? GROUP BY processing_status`
          )
          .all(organizationId) as Array<{ processing_status: string; n: number }>)
      : countByProcessingStatus(),
    byQualityStatus: scoped
      ? (db
          .prepare(
            `SELECT COALESCE(quality_status, 'not_processed') AS quality_status, COUNT(*) AS n
               FROM material_records WHERE is_active = 1 AND organization_id = ? GROUP BY quality_status ORDER BY n DESC, quality_status`
          )
          .all(organizationId) as Array<{ quality_status: string; n: number }>)
      : countByQualityStatus(),
    openQueue: db
      .prepare(
        `SELECT rq.priority, COUNT(*) AS n FROM review_queue rq WHERE rq.status = 'open'${scoped
          ? ' AND (rq.match_id IN (SELECT mc.id FROM match_candidates mc JOIN material_records s ON s.id = mc.source_material_id JOIN material_records c ON c.id = mc.candidate_material_id WHERE s.organization_id = ? OR c.organization_id = ?))'
          : ''} GROUP BY rq.priority`
      )
      .all(...matchOrgParams) as Array<{ priority: string; n: number }>,
    queueStatus: db
      .prepare(
        `SELECT rq.status, COUNT(*) AS n FROM review_queue rq WHERE 1=1${scoped
          ? ' AND (rq.match_id IN (SELECT mc.id FROM match_candidates mc JOIN material_records s ON s.id = mc.source_material_id JOIN material_records c ON c.id = mc.candidate_material_id WHERE s.organization_id = ? OR c.organization_id = ?))'
          : ''} GROUP BY rq.status`
      )
      .all(...matchOrgParams) as Array<{ status: string; n: number }>,
    recentImports: db
      .prepare(
        `SELECT d.id, d.file_name, o.code AS org_code, d.status, d.total_rows,
                d.successful_rows, d.failed_rows, d.created_at
           FROM data_imports d JOIN organizations o ON o.id = d.organization_id
          ${scoped ? 'WHERE d.organization_id = ?' : ''}
          ORDER BY d.created_at DESC LIMIT 5`
      )
      .all(...orgParams) as DashboardMetrics['recentImports'],
    recentActivity: db
      .prepare(`SELECT id, action, entity_type, entity_id, actor, created_at FROM audit_logs ORDER BY id DESC LIMIT 10`)
      .all() as DashboardMetrics['recentActivity'],
    perOrganization: db
      .prepare(
        `SELECT o.id, o.code, o.name,
                (SELECT COUNT(*) FROM material_records m WHERE m.organization_id = o.id AND m.is_active = 1) AS materials,
                (SELECT COUNT(*) FROM review_queue rq JOIN match_candidates mc ON mc.id = rq.match_id
                  JOIN material_records s ON s.id = mc.source_material_id
                  JOIN material_records c ON c.id = mc.candidate_material_id
                  WHERE rq.status = 'open' AND (s.organization_id = o.id OR c.organization_id = o.id)) AS pending_reviews,
                (SELECT COUNT(*) FROM match_candidates mc WHERE mc.status = 'pending' AND mc.critical_difference IS NOT NULL
                  AND (mc.source_material_id IN (SELECT id FROM material_records WHERE organization_id = o.id)
                    OR mc.candidate_material_id IN (SELECT id FROM material_records WHERE organization_id = o.id))) AS critical_conflicts,
                (SELECT COUNT(*) FROM material_mappings mm WHERE mm.organization_id = o.id) AS mappings
           FROM organizations o WHERE o.status = 'active' ORDER BY o.code`
      )
      .all() as DashboardMetrics['perOrganization'],
    deferredCount: one(
      `SELECT COUNT(*) AS n FROM match_candidates WHERE status = 'deferred'${matchOrgFilter}`,
      ...matchOrgParams
    ),
    matchOverview: (
      db
        .prepare(
          `SELECT COALESCE(json_extract(evidence, '$.decision.state'), 'UNCLASSIFIED') AS decision,
                  COUNT(*) AS n
             FROM match_candidates WHERE status = 'pending'${matchOrgFilter}
            GROUP BY decision ORDER BY n DESC, decision`
        )
        .all(...matchOrgParams) as Array<{ decision: string; n: number }>
    ).filter((r) => r.decision !== 'UNCLASSIFIED'),
    highConfidenceCandidates: one(
      `SELECT COUNT(*) AS n FROM match_candidates
        WHERE status = 'pending' AND json_extract(evidence, '$.decision.state') = 'HIGH_CONFIDENCE_MATCH'${matchOrgFilter}`,
      ...matchOrgParams
    ),
    recentDecisions: db
      .prepare(
        `SELECT md.id, md.decision, md.reviewer, md.match_id,
                s.original_code AS s_code, so.code AS s_org,
                c.original_code AS c_code, co.code AS c_org, md.decided_at
           FROM match_decisions md
           JOIN match_candidates mc ON mc.id = md.match_id
           JOIN material_records s ON s.id = mc.source_material_id
           JOIN organizations so ON so.id = s.organization_id
           JOIN material_records c ON c.id = mc.candidate_material_id
           JOIN organizations co ON co.id = c.organization_id
          ${scoped ? 'WHERE s.organization_id = ? OR c.organization_id = ?' : ''}
          ORDER BY md.id DESC LIMIT 8`
      )
      .all(...matchOrgParams) as DashboardMetrics['recentDecisions'],
  };
}
