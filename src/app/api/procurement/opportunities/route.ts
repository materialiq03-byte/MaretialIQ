import { NextRequest } from 'next/server';
import { ok, fail, parsePagination } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import {
  listOpportunities,
  detectProcurementOpportunities,
  type OpportunityRow,
} from '@/lib/services/procurement-opportunity-service';
import type { OpportunityStatus, OpportunityType } from '@/lib/types/domain';

/**
 * GET /api/procurement/opportunities — filtered, paginated list (view
 * permission). POST — run deterministic detection (edit permission).
 * Detection is idempotent and audit-silent.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission('VIEW_MAPPINGS');
    const params = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(params);
    const type = params.get('type');
    const status = params.get('status');
    const cmi = params.get('cmiId');
    const org = params.get('organizationId');
    const sup = params.get('supplierId');
    const result = listOpportunities(
      {
        type: (type as OpportunityType) || undefined,
        status: (status as OpportunityStatus) || undefined,
        cmiId: cmi ? Number(cmi) : undefined,
        organizationId: org ? Number(org) : undefined,
        supplierId: sup ? Number(sup) : undefined,
      },
      page,
      pageSize
    );
    return ok({
      opportunities: result.items.map(parseEvidence),
      total: result.total,
      page,
      pageSize,
    });
  } catch (err) {
    return fail(err);
  }
}

export async function POST() {
  try {
    await requireApiPermission('EDIT_MATERIALS');
    const summary = detectProcurementOpportunities();
    return ok(summary, 201);
  } catch (err) {
    return fail(err);
  }
}

function parseEvidence(o: OpportunityRow) {
  let evidence: unknown = o.evidence;
  try {
    evidence = JSON.parse(o.evidence);
  } catch {
    /* keep raw string */
  }
  return { ...o, evidence };
}
