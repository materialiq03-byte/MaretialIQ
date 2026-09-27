import { getDashboardMetrics, type DashboardMetrics } from '../db/repositories/metrics-repository';
import { visibleOrganizationIds } from '../auth/guard';
import type { SessionUser } from '../auth/types';

/**
 * Role-aware metrics access. CPSE users are scoped to their organization;
 * authority and platform_admin see platform-wide figures. Authorization lives
 * here, not in the page components.
 */
export function getMetricsForUser(user: SessionUser): DashboardMetrics {
  const scope = visibleOrganizationIds(user);
  return getDashboardMetrics(scope === null ? null : scope[0] ?? -1);
}

/** Legacy platform-wide metrics for the public API route (admin-gated there). */
export function getMetrics(): DashboardMetrics {
  return getDashboardMetrics(null);
}
