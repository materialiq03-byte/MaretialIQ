import { NextRequest } from 'next/server';
import { ok, fail, parsePagination } from '@/lib/api-helpers';
import { requireApiPermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { getOrganization } from '@/lib/db/repositories/organization-repository';
import { listMatches } from '@/lib/db/repositories/matching-repository';
import { matchQuerySchema, parseOrThrow } from '@/lib/validation/schemas';
import type { MatchStatus, MatchType } from '@/lib/types/domain';

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiPermission('VIEW_MATCHES');
    const params = request.nextUrl.searchParams;
    const query = parseOrThrow(matchQuerySchema, {
      status: params.get('status') || undefined,
      matchType: params.get('matchType') || undefined,
      organizationCode: params.get('cpse')?.trim() || undefined,
      minScore: params.get('minScore') || undefined,
      page: params.get('page') || undefined,
      pageSize: params.get('pageSize') || undefined,
    });
    const { page, pageSize } = parsePagination(params);
    // Server-side org scoping: CPSE users always see only matches involving
    // their organization, regardless of requested filter.
    const scope = visibleOrganizationIds(user);
    const organizationCode = scope === null ? query.organizationCode : getOrganization(scope[0])?.code;
    const result = listMatches({
      status: query.status as MatchStatus | undefined,
      matchType: query.matchType as MatchType | undefined,
      organizationCode,
      minScore: query.minScore,
      page,
      pageSize,
    });
    return ok({ matches: result.items, total: result.total, page, pageSize });
  } catch (err) {
    return fail(err);
  }
}
