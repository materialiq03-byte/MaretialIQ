import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission, requireApiUser } from '@/lib/auth/guard';
import { errors } from '@/lib/errors';
import { getUomRuleHistory } from '@/lib/services/procurement-service';

/**
 * GET /api/procurement/uom-rules/[id]/history - append-only lifecycle history
 * for one governed UOM domain rule (Step 19 section 13). Read-only, audited
 * nowhere (section 12). Fail-closed on non-numeric ids and unknown rules.
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser();
    const { id } = await ctx.params;
    const ruleId = Number(id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) throw errors.badRequest('rule id must be a positive integer');
    const history = getUomRuleHistory(ruleId);
    if (history.length === 0) throw errors.notFound('UOM rule or its history');
    return ok({ ruleId, history });
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /api/procurement/uom-rules - protected by requireApiPermission on the
 * parent route; re-declared here for reference only (see ../route.ts).
 * This file intentionally keeps MANAGE_UOM_RULES out of read paths: history
 * is a read surface (VIEW_MAPPINGS-class visibility, section 11: read-only
 * user -> GET allowed, mutations denied).
 */
export const runtime = 'nodejs';
void requireApiPermission;
