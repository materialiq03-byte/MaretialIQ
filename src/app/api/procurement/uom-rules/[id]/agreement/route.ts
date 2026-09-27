import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission, requireApiUser } from '@/lib/auth/guard';
import { errors } from '@/lib/errors';
import { getUomRuleAgreement } from '@/lib/services/procurement-service';

/**
 * GET /api/procurement/uom-rules/[id]/agreement - the aligned history<->audit
 * timeline for one governed rule (Step 20 section 13). Read-only; every row
 * shows whether the two append-only ledgers agree (audit presence, action and
 * content evidence). Fail-closed on non-numeric ids.
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser();
    const { id } = await ctx.params;
    const ruleId = Number(id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) throw errors.badRequest('rule id must be a positive integer');
    const agreement = getUomRuleAgreement(ruleId);
    if (agreement.length === 0) throw errors.notFound('UOM rule or its governance events');
    return ok({ ruleId, agreement });
  } catch (e) {
    return fail(e);
  }
}

export const runtime = 'nodejs';
void requireApiPermission;
