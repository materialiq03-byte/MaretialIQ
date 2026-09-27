import { readBoundedJsonOr } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { errors } from '@/lib/errors';
import {
  proposeUomRuleAmendment,
  decideUomRuleAmendment,
} from '@/lib/services/procurement-service';
import { uomRuleAmendSchema, uomRuleAmendDecisionSchema, parseOrThrow } from '@/lib/validation/schemas';

/**
 * POST /api/procurement/uom-rules/[id]/amend - propose a new immutable
 * content version for an APPROVED or DISABLED governed rule (Step 20 section
 * 5). One governed transaction writes version + pointer + history + audit;
 * conversion behavior is unchanged until approval (section 5/10). Requires
 * MANAGE_UOM_RULES.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiPermission('MANAGE_UOM_RULES');
    const { id } = await ctx.params;
    const ruleId = Number(id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) throw errors.badRequest('rule id must be a positive integer');
    const body = await readBoundedJsonOr<Record<string, unknown>>(request, {} as Record<string, unknown>);
    const input = parseOrThrow(uomRuleAmendSchema, body);
    const result = proposeUomRuleAmendment({
      ruleId,
      fromUom: input.fromUom,
      toUom: input.toUom,
      factor: input.factor,
      reason: input.reason,
      actor: user.email,
    });
    return ok(result, 201);
  } catch (e) {
    return fail(e);
  }
}

/**
 * PATCH /api/procurement/uom-rules/[id]/amend - decide the pending amendment
 * (approve | reject). This is a VERSION decision: the rule's lifecycle state
 * never changes here. Requires MANAGE_UOM_RULES; separation of duties is
 * enforced in the service (proposer ≠ decider).
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiPermission('MANAGE_UOM_RULES');
    const { id } = await ctx.params;
    const ruleId = Number(id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) throw errors.badRequest('rule id must be a positive integer');
    const body = await readBoundedJsonOr<Record<string, unknown>>(request, {} as Record<string, unknown>);
    const input = parseOrThrow(uomRuleAmendDecisionSchema, body);
    const result = decideUomRuleAmendment(ruleId, input.action, user.email);
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}
