import { readBoundedJsonOr } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import {
  getUomRuleRegistry,
  getUomDataQuality,
  listGovernedUomRules,
  createUomDomainRule,
} from '@/lib/services/procurement-service';
import { uomDomainRuleCreateSchema, parseOrThrow } from '@/lib/validation/schemas';

/**
 * GET /api/procurement/uom-rules - UOM rule registry + data quality.
 *
 * Step 17: SYSTEM_DEFINED registry (read-only) + procurement quality
 * visibility. Step 18 adds the governed DOMAIN_SPECIFIC rules (all statuses)
 * to the same payload. Reads create no audit rows (sections 25/26).
 */
export async function GET(_request: NextRequest) {
  try {
    await requireApiPermission('VIEW_MAPPINGS');
    const rules = getUomRuleRegistry();
    const domainRules = listGovernedUomRules();
    const quality = getUomDataQuality();
    return ok({ rules, domainRules, quality });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /api/procurement/uom-rules - propose a DOMAIN_SPECIFIC (CMI-scoped)
 * UOM rule (Step 18 sections 8/9). Requires MANAGE_UOM_RULES; the rule always
 * starts PENDING (never active automatically) and creation is audited with
 * actor, scope, conversion and reason. Reads stay unaudited; only this
 * governed mutation writes audit rows.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireApiPermission('MANAGE_UOM_RULES');
    const body = await readBoundedJsonOr<Record<string, unknown>>(request, {} as Record<string, unknown>);
    const input = parseOrThrow(uomDomainRuleCreateSchema, body);
    const rule = createUomDomainRule({
      cmiId: input.cmiId,
      fromUom: input.fromUom,
      toUom: input.toUom,
      factor: input.factor,
      reason: input.reason,
      actor: user.email,
    });
    return ok(rule);
  } catch (e) {
    return fail(e);
  }
}
