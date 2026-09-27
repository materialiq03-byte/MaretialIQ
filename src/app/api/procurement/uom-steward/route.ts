import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiUser } from '@/lib/auth/guard';
import { getUomStewardDashboard } from '@/lib/services/procurement-service';

/**
 * GET /api/procurement/uom-steward - steward dashboard overview (Step 19
 * section 13): rule lifecycle counts, UOM data quality, governance activity,
 * the PENDING work queue and recent history activity. SQL-side aggregation;
 * read-only; audit-silent (section 12).
 */
export async function GET(_request: NextRequest) {
  try {
    await requireApiUser();
    return ok(getUomStewardDashboard());
  } catch (e) {
    return fail(e);
  }
}
