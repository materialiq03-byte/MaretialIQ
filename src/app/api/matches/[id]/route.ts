import { readBoundedJsonOr } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { errors } from '@/lib/errors';
import { requireApiPermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { parseOrThrow, decisionSchema } from '@/lib/validation/schemas';
import { decideMatch } from '@/lib/services/matching-service';
import { decideMatchHardened } from '@/lib/services/match-review-service';
import { judgeScopeOrganizationIds } from '@/lib/services/judge-mode-service';
import { invalidateReadCaches, READ_CACHE_TAGS } from '@/lib/cache/read-cache';

/**
 * POST /api/matches/:id — record a reviewer decision (approve / reject /
 * defer / sent_for_review) on a pending match candidate. The acting reviewer
 * is always the authenticated session user; any client-supplied identity is
 * ignored (prototype session, no mandatory login).
 *
 * Step 23: the body may additionally carry `expectedStatus` (the status the
 * caller believes the candidate is in). When supplied, a stale decision is
 * rejected with a conflict before anything is written (§28/§29). Without it,
 * behavior is byte-identical to the existing contract.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiPermission('REVIEW_MATCHES');
    const { id } = await ctx.params;
    const matchId = Number(id);
    if (!Number.isInteger(matchId) || matchId <= 0) {
      return fail(new Error('Invalid match id'));
    }
    // Step 25 IDOR fix (§7): permission alone is not authorization — a scoped
    // CPSE reviewer may only decide candidates whose pair touches their own
    // organization. Same scoping rule as the evidence/Judge Mode endpoint.
    const scope = visibleOrganizationIds(user);
    if (scope !== null) {
      const pairOrgs = judgeScopeOrganizationIds(matchId);
      if (!pairOrgs.some((orgId) => scope.includes(orgId))) {
        throw errors.forbidden('This record belongs to a different CPSE organization');
      }
    }
    const body = await readBoundedJsonOr<Record<string, unknown>>(request, {} as Record<string, unknown>);
    const input = parseOrThrow(decisionSchema, {
      decision: body?.decision,
      reviewer: user.email,
      comment: body?.comment,
    });
    const expectedStatus = typeof body?.expectedStatus === 'string' ? body.expectedStatus : undefined;
    const result =
      expectedStatus !== undefined
        ? decideMatchHardened(matchId, { ...input, expectedStatus: expectedStatus as never }, user.email)
        : decideMatch(matchId, input, user.email);
    invalidateReadCaches(READ_CACHE_TAGS.dashboardMetrics, READ_CACHE_TAGS.analyticsSummary);
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
