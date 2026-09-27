import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiUser } from '@/lib/auth/guard';
import { getGovernanceCockpit } from '@/lib/services/procurement-service';

/**
 * GET /api/procurement/governance - governance cockpit aggregation
 * (Step 21 section 14): summary, unified work queue, health indicators,
 * UOM quality, recent activity, monthly summary and reconciliation.
 * Read-only (requireApiUser); authorization for MUTATIONS stays on the
 * existing governed endpoints (MANAGE_UOM_RULES there). Reads create no
 * audit rows (section 14/17).
 */
export async function GET(_request: NextRequest) {
  try {
    await requireApiUser();
    return ok(getGovernanceCockpit());
  } catch (e) {
    return fail(e);
  }
}
