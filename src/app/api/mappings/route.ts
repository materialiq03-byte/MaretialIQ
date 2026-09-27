import { NextRequest } from 'next/server';
import { ok, fail, parsePagination } from '@/lib/api-helpers';
import { requireApiPermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { getOrganization } from '@/lib/db/repositories/organization-repository';
import { listMappings } from '@/lib/db/repositories/registry-repository';

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiPermission('VIEW_MAPPINGS');
    const params = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(params);
    // Org scoping: CPSE users see mappings relevant to their organization.
    const scope = visibleOrganizationIds(user);
    const organizationCode =
      scope === null ? params.get('cpse')?.trim() || undefined : getOrganization(scope[0])?.code;
    const result = listMappings({
      cmiId: params.get('cmiId') ? Number(params.get('cmiId')) : undefined,
      organizationCode,
      page,
      pageSize,
    });
    return ok({ mappings: result.items, total: result.total, page, pageSize });
  } catch (err) {
    return fail(err);
  }
}
