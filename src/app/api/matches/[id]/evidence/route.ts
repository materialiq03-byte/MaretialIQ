import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { errors } from '@/lib/errors';
import { requireApiPermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { parseOrThrow, idSchema } from '@/lib/validation/schemas';
import { getMatchReview } from '@/lib/services/match-review-service';
import { getJudgeBrief, judgeScopeOrganizationIds } from '@/lib/services/judge-mode-service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/matches/:id/evidence — the full review contract for one candidate
 * (§31): scores, verdict, technical comparison, conflicts, missing evidence,
 * matched attributes, assembly/manufacturer/category relationships, WHY
 * explanation, decision history, queue state, CMI state.
 *
 * Step 24: `?judge=1` returns the deterministic Judge Mode brief — the SAME
 * evidence contract presented for explanation (headlines, decision trace,
 * rule trace, source traceability, completeness). No second evidence API.
 *
 * Read-only: mutates nothing, writes zero audit rows. Authorization is
 * VIEW_MATCHES plus server-side organization scoping — a scoped CPSE user
 * cannot inspect candidates touching other organizations (IDOR, §34).
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiPermission('VIEW_MATCHES');
    const { id } = await ctx.params;
    const matchId = parseOrThrow(idSchema, id);
    // IDOR protection: scoped users may only see pairs touching their org.
    // Denied as 403 forbidden — never a 500 and never resource-existence info.
    const scope = visibleOrganizationIds(user);
    if (scope !== null) {
      const pairOrgs = judgeScopeOrganizationIds(matchId);
      if (!pairOrgs.some((orgId) => scope.includes(orgId))) {
        throw errors.forbidden('This record belongs to a different CPSE organization');
      }
    }
    if (request.nextUrl.searchParams.get('judge') === '1') {
      return ok(getJudgeBrief(matchId));
    }
    return ok(getMatchReview(matchId));
  } catch (err) {
    return fail(err);
  }
}
