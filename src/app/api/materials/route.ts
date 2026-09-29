import { readBoundedJson } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail, parsePagination } from '@/lib/api-helpers';
import { requireApiPermission, visibleOrganizationIds, assertOrganizationWrite } from '@/lib/auth/guard';
import { getOrganization } from '@/lib/db/repositories/organization-repository';
import { listMaterials, listCategories, type MaterialSortField } from '@/lib/db/repositories/material-repository';
import { createMaterial } from '@/lib/services/material-service';
import { materialCreateSchema, parseOrThrow } from '@/lib/validation/schemas';
import { invalidateReadCaches, READ_CACHE_TAGS } from '@/lib/cache/read-cache';

const SORT_FIELDS: MaterialSortField[] = ['code', 'category', 'org', 'updated', 'description'];

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiPermission('VIEW_MATERIALS');
    const params = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(params);
    const sortParam = params.get('sort') as MaterialSortField | null;
    // Org scoping: CPSE users are pinned to their own organization.
    const scope = visibleOrganizationIds(user);
    const organizationCode =
      scope === null ? params.get('cpse')?.trim() || undefined : getOrganization(scope[0])?.code;
    const result = listMaterials({
      search: params.get('q')?.trim() || undefined,
      organizationCode,
      category: params.get('category')?.trim() || undefined,
      page,
      pageSize,
      sort: sortParam && SORT_FIELDS.includes(sortParam) ? sortParam : 'code',
      direction: params.get('dir') === 'desc' ? 'desc' : 'asc',
    });
    return ok({
      materials: result.items,
      total: result.total,
      page,
      pageSize,
      categories: listCategories(),
    });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireApiPermission('EDIT_MATERIALS');
    const body = await readBoundedJson<unknown>(request);
    const input = parseOrThrow(materialCreateSchema, body);
    assertOrganizationWrite(user, input.organizationId);
    const created = createMaterial(input, user.email);
    invalidateReadCaches(READ_CACHE_TAGS.dashboardMetrics, READ_CACHE_TAGS.analyticsSummary);
    return ok({ materialId: created.id }, 201);
  } catch (err) {
    return fail(err);
  }
}
