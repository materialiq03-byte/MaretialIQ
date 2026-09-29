import { getDashboardMetrics, type DashboardMetrics } from '../db/repositories/metrics-repository';
import { visibleOrganizationIds } from '../auth/guard';
import type { SessionUser } from '../auth/types';
import { cachedRead, READ_CACHE_TAGS } from '../cache/read-cache';

/** Short backstop TTL; every mutation route revalidates the tag sooner. */
const DASHBOARD_TTL_SECONDS = 30;

/**
 * Role-aware metrics access. CPSE users are scoped to their organization;
 * authority and platform_admin see platform-wide figures. Authorization lives
 * here, not in the page components.
 *
 * PERF (Phase 3): the read-only KPI bundle is served through the tagged
 * short-TTL read cache, keyed by org scope. Mutating routes revalidate
 * 'dashboard-metrics', so writes are never stale beyond the request in which
 * they happen; the TTL only covers non-request writes (e.g. the async
 * review-console matcher job). Decisions/imports themselves are never
 * served from this cache.
 */
export async function getMetricsForUser(user: SessionUser): Promise<DashboardMetrics> {
  const scope = visibleOrganizationIds(user);
  const orgId = scope === null ? null : scope[0] ?? -1;
  return cachedRead(
    ['dashboard-metrics', String(orgId)],
    DASHBOARD_TTL_SECONDS,
    [READ_CACHE_TAGS.dashboardMetrics],
    () => getDashboardMetrics(orgId),
  );
}

/** Legacy platform-wide metrics for the public API route (admin-gated there). */
export async function getMetrics(): Promise<DashboardMetrics> {
  return cachedRead(['dashboard-metrics', 'null'], DASHBOARD_TTL_SECONDS, [READ_CACHE_TAGS.dashboardMetrics], () =>
    getDashboardMetrics(null),
  );
}
