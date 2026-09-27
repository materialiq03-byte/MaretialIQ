import { readBoundedJsonOr } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { transitionUomRuleLifecycle } from '@/lib/services/procurement-service';
import { uomRuleTransitionSchema, parseOrThrow } from '@/lib/validation/schemas';

/**
 * POST /api/procurement/uom-rules/[id]/transition - one governed lifecycle
 * transition per request (Step 18 sections 4/8/9): PENDING -> APPROVED |
 * REJECTED, APPROVED -> DISABLED, DISABLED -> re-enabled (APPROVED).
 * Requires MANAGE_UOM_RULES; invalid transitions fail closed; every allowed
 * transition is audited with who/what/when/scope/previous/new state.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiPermission('MANAGE_UOM_RULES');
    const { id } = await ctx.params;
    const body = await readBoundedJsonOr<Record<string, unknown>>(request, {} as Record<string, unknown>);
    const input = parseOrThrow(uomRuleTransitionSchema, body);
    const result = transitionUomRuleLifecycle(Number(id), input.action, user.email);
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}
