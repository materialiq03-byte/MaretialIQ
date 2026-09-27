import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { getDashboardMetrics } from '@/lib/db/repositories/metrics-repository';

export async function GET() {
  try {
    const user = await requireApiPermission('VIEW_DASHBOARD');
    const scope = visibleOrganizationIds(user);
    return ok(getDashboardMetrics(scope === null ? null : scope[0] ?? -1));
  } catch (err) {
    return fail(err);
  }
}
