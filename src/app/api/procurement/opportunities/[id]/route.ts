import { readBoundedJsonOr } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import {
  getOpportunityRequired,
  acknowledgeOpportunity,
  dismissOpportunity,
  resolveOpportunity,
  reopenOpportunity,
} from '@/lib/services/procurement-opportunity-service';
import { opportunityReviewSchema, parseOrThrow } from '@/lib/validation/schemas';
import { listOpportunitySourceRecords } from '@/lib/db/repositories/procurement-repository';

type Action = 'acknowledge' | 'dismiss' | 'resolve' | 'reopen';

/**
 * GET — one opportunity with parsed evidence and bounded source-record
 * traceability (section 23). POST — one governed human transition
 * (section 27: server-side authorization; section 28: audited).
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireApiPermission('VIEW_MAPPINGS');
    const { id } = await ctx.params;
    const row = getOpportunityRequired(Number(id));
    let evidence: unknown = row.evidence;
    try {
      evidence = JSON.parse(row.evidence);
    } catch {
      /* keep raw */
    }
    const sourceRecords = listOpportunitySourceRecords(row, 200).map((r) => ({
      id: r.record.id,
      organization: r.org_code,
      materialCode: r.material_code,
      cmiCode: r.cmi_code,
      supplier: r.supplier_name,
      purchaseDate: r.record.purchase_date,
      quantity: r.record.quantity,
      uom: r.record.uom,
      unitPrice: r.record.unit_price,
      currency: r.record.currency,
      status: r.record.procurement_status,
    }));
    return ok({ ...row, evidence, sourceRecords });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiPermission('EDIT_MATERIALS');
    const { id } = await ctx.params;
    const body = await readBoundedJsonOr<Record<string, unknown>>(request, {} as Record<string, unknown>);
    const { action, ...rest } = body as { action?: Action } & Record<string, unknown>;
    const input = parseOrThrow(opportunityReviewSchema, rest);
    const numId = Number(id);
    switch (action) {
      case 'acknowledge':
        return ok(acknowledgeOpportunity(numId, { actor: user.email, reason: input.reason }));
      case 'dismiss':
        return ok(dismissOpportunity(numId, { actor: user.email, reason: input.reason as string }));
      case 'resolve':
        return ok(resolveOpportunity(numId, { actor: user.email, reason: input.reason as string }));
      case 'reopen':
        return ok(reopenOpportunity(numId, { actor: user.email, reason: input.reason as string }));
      default:
        return fail(new Error('Unknown action'));
    }
  } catch (err) {
    return fail(err);
  }
}
