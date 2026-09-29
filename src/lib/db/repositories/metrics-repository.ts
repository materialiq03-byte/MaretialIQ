import { getDb } from '../client';

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

type SqlParam = string | number;

const textAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface GroupBranch {
  /** Discriminator stored in the first UNION-ALL column (0..n). */
  tag: number;
  sql: string;
  params: SqlParam[];
}

interface GroupRow {
  t: number;
  g: string;
  n: number;
}

/**
 * PERF: the dashboard used to issue each grouped aggregate as its own
 * sequential round trip. The sync PostgreSQL bridge allows exactly one
 * in-flight query at a time, so per-request latency is dominated by
 * round-trip count. Grouping same-table aggregates into one UNION ALL
 * statement removes round trips without touching results: same rows, same
 * values, and each consumer's ORDER BY is re-applied in JS below (ASCII
 * keys, so JS string ordering equals SQL byte ordering).
 */
function runGroupBatch(db: ReturnType<typeof getDb>, branches: GroupBranch[]): Map<number, GroupRow[]> {
  const sql = branches.map((b) => b.sql).join('\nUNION ALL\n');
  const rows = db
    .prepare(sql)
    .all(...branches.flatMap((b) => b.params)) as unknown as GroupRow[];
  const grouped = new Map<number, GroupRow[]>();
  for (const r of rows) {
    const list = grouped.get(Number(r.t));
    if (list) list.push(r);
    else grouped.set(Number(r.t), [r]);
  }
  return grouped;
}

export function getDashboardMetrics(organizationId?: number | null): DashboardMetrics {
  const db = getDb();

  // Org scope: CPSE dashboards restrict material/import metrics to their org.
  // Match/review metrics are inherently cross-CPSE; CPSE users see those that
  // involve their organization.
  const scoped = organizationId !== null && organizationId !== undefined;
  const orgFilter = scoped ? ' AND organization_id = ?' : '';
  const orgParams: SqlParam[] = scoped ? [organizationId as number] : [];

  const matchOrgFilter = scoped
    ? ' AND (source_material_id IN (SELECT id FROM material_records WHERE organization_id = ?) OR candidate_material_id IN (SELECT id FROM material_records WHERE organization_id = ?))'
    : '';
  const matchOrgParams: SqlParam[] = scoped ? [organizationId as number, organizationId as number] : [];

  // ---- scalar batch: every independent COUNT in one statement --------------
  // Each subquery is the verbatim predicate of the scalar query it replaces;
  // parameters appear in the same textual order they are appended here.
  const scalarSelects: string[] = [];
  const scalarParams: SqlParam[] = [];
  const addScalar = (alias: string, sql: string, params: SqlParam[] = []) => {
    scalarSelects.push(`(${sql}) AS ${alias}`);
    scalarParams.push(...params);
  };
  addScalar('total_materials', `SELECT COUNT(*) FROM material_records mr WHERE mr.is_active = 1${scoped ? ' AND mr.organization_id = ?' : ''}`, orgParams);
  addScalar('potential_duplicates', `SELECT COUNT(*) FROM match_candidates WHERE match_type = 'near_duplicate' AND status = 'pending'${matchOrgFilter}`, matchOrgParams);
  addScalar('functional_equivalents', `SELECT COUNT(*) FROM match_candidates WHERE match_type = 'functional_equivalent' AND status = 'pending'${matchOrgFilter}`, matchOrgParams);
  addScalar('critical_conflicts', `SELECT COUNT(*) FROM match_candidates WHERE critical_difference IS NOT NULL AND status = 'pending'${matchOrgFilter}`, matchOrgParams);
  addScalar('common_identities', `SELECT COUNT(*) FROM common_materials cm WHERE cm.is_active = 1`);
  addScalar('total_mappings', `SELECT COUNT(*) FROM material_mappings${scoped ? ' WHERE organization_id = ?' : ''}`, orgParams);
  addScalar('imports_completed', `SELECT COUNT(*) FROM data_imports WHERE status = 'completed'${orgFilter}`, orgParams);
  addScalar('pending_imports', `SELECT COUNT(*) FROM data_imports WHERE status IN ('pending','processing')${orgFilter}`, orgParams);
  addScalar('organizations', `SELECT COUNT(*) FROM organizations WHERE status = 'active'`);
  addScalar('users', `SELECT COUNT(*) FROM users WHERE status = 'active'`);
  addScalar('deferred_count', `SELECT COUNT(*) FROM match_candidates WHERE status = 'deferred'${matchOrgFilter}`, matchOrgParams);
  addScalar(
    'high_confidence_candidates',
    `SELECT COUNT(*) FROM match_candidates
        WHERE status = 'pending' AND json_extract(evidence, '$.decision.state') = 'HIGH_CONFIDENCE_MATCH'${matchOrgFilter}`,
    matchOrgParams
  );
  addScalar(
    'pending_reviews',
    `SELECT COUNT(*) FROM review_queue rq WHERE rq.status = 'open'${scoped
      ? ' AND (rq.match_id IN (SELECT mc.id FROM match_candidates mc JOIN material_records s ON s.id = mc.source_material_id JOIN material_records c ON c.id = mc.candidate_material_id WHERE s.organization_id = ? OR c.organization_id = ?))'
      : ''}`,
    matchOrgParams
  );
  const s = db.prepare(`SELECT ${scalarSelects.join(', ')}`).get(...scalarParams) as Record<
    | 'total_materials' | 'potential_duplicates' | 'functional_equivalents' | 'critical_conflicts'
    | 'common_identities' | 'total_mappings' | 'imports_completed' | 'pending_imports'
    | 'organizations' | 'users' | 'deferred_count' | 'high_confidence_candidates'
    | 'pending_reviews',
    number
  >;

  // ---- grouped batch: match_candidates (byMatchType, byStatus, matchOverview)
  const matchGrouped = runGroupBatch(db, [
    { tag: 0, sql: `SELECT 0 AS t, match_type AS g, COUNT(*) AS n FROM match_candidates WHERE 1=1${matchOrgFilter} GROUP BY match_type`, params: matchOrgParams },
    { tag: 1, sql: `SELECT 1 AS t, status AS g, COUNT(*) AS n FROM match_candidates WHERE 1=1${matchOrgFilter} GROUP BY status`, params: matchOrgParams },
    { tag: 2, sql: `SELECT 2 AS t, COALESCE(json_extract(evidence, '$.decision.state'), 'UNCLASSIFIED') AS g, COUNT(*) AS n FROM match_candidates WHERE status = 'pending'${matchOrgFilter} GROUP BY g`, params: matchOrgParams },
  ]);

  // ---- grouped batch: material_records (byCategory, byProcessingStatus, byQualityStatus)
  const matScope = scoped ? ' AND m.organization_id = ?' : '';
  const materialGrouped = runGroupBatch(db, [
    { tag: 0, sql: `SELECT 0 AS t, category AS g, COUNT(*) AS n FROM material_records m WHERE m.is_active = 1${matScope} GROUP BY category`, params: orgParams },
    { tag: 1, sql: `SELECT 1 AS t, processing_status AS g, COUNT(*) AS n FROM material_records m WHERE m.is_active = 1${matScope} GROUP BY processing_status`, params: orgParams },
    { tag: 2, sql: `SELECT 2 AS t, COALESCE(quality_status, 'not_processed') AS g, COUNT(*) AS n FROM material_records m WHERE m.is_active = 1${matScope} GROUP BY g`, params: orgParams },
  ]);

  // ---- grouped batch: review_queue (openQueue, queueStatus) ----------------
  const rqScope = scoped
    ? ' AND (rq.match_id IN (SELECT mc.id FROM match_candidates mc JOIN material_records s ON s.id = mc.source_material_id JOIN material_records c ON c.id = mc.candidate_material_id WHERE s.organization_id = ? OR c.organization_id = ?))'
    : '';
  const queueGrouped = runGroupBatch(db, [
    { tag: 0, sql: `SELECT 0 AS t, rq.priority AS g, COUNT(*) AS n FROM review_queue rq WHERE rq.status = 'open'${rqScope} GROUP BY rq.priority`, params: matchOrgParams },
    { tag: 1, sql: `SELECT 1 AS t, rq.status AS g, COUNT(*) AS n FROM review_queue rq WHERE 1=1${rqScope} GROUP BY rq.status`, params: matchOrgParams },
  ]);

  const asPairs = (rows: GroupRow[] | undefined) =>
    (rows ?? []).map((r) => ({ g: r.g, n: Number(r.n) }));

  // Original ORDER BYs re-applied here (the union carries no ordering):
  //   byCategory / byQualityStatus / matchOverview: n DESC, key ASC
  //   byProcessingStatus: key ASC  |  byMatchType / byStatus / queue groups: raw SQL order
  const byCategory = asPairs(materialGrouped.get(0)).sort(
    (a, b) => b.n - a.n || textAsc(a.g, b.g)
  ) as unknown as Array<{ category: string; n: number }>;
  const byProcessingStatus = asPairs(materialGrouped.get(1)).sort((a, b) =>
    textAsc(a.g, b.g)
  ) as unknown as Array<{ processing_status: string; n: number }>;
  const byQualityStatus = asPairs(materialGrouped.get(2)).sort(
    (a, b) => b.n - a.n || textAsc(a.g, b.g)
  ) as unknown as Array<{ quality_status: string; n: number }>;
  const matchOverview = asPairs(matchGrouped.get(2))
    .sort((a, b) => b.n - a.n || textAsc(a.g, b.g))
    .filter((r) => r.g !== 'UNCLASSIFIED')
    .map((r) => ({ decision: r.g, n: r.n }));

  return {
    totalMaterials: Number(s.total_materials),
    pendingReviews: Number(s.pending_reviews),
    potentialDuplicates: Number(s.potential_duplicates),
    functionalEquivalents: Number(s.functional_equivalents),
    criticalConflicts: Number(s.critical_conflicts),
    commonIdentities: Number(s.common_identities),
    totalMappings: Number(s.total_mappings),
    importsCompleted: Number(s.imports_completed),
    pendingImports: Number(s.pending_imports),
    organizations: Number(s.organizations),
    users: Number(s.users),
    byMatchType: asPairs(matchGrouped.get(0)) as unknown as Array<{ match_type: string; n: number }>,
    byStatus: asPairs(matchGrouped.get(1)) as unknown as Array<{ status: string; n: number }>,
    byCategory,
    byProcessingStatus,
    byQualityStatus,
    openQueue: asPairs(queueGrouped.get(0)) as unknown as Array<{ priority: string; n: number }>,
    queueStatus: asPairs(queueGrouped.get(1)) as unknown as Array<{ status: string; n: number }>,
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
    deferredCount: Number(s.deferred_count),
    matchOverview,
    highConfidenceCandidates: Number(s.high_confidence_candidates),
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
