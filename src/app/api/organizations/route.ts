import { readBoundedJson } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { listOrganizations, createOrganization } from '@/lib/db/repositories/organization-repository';
import { listOrganizationsWithCounts } from '@/lib/db/repositories/organization-queries';
import { orgCreateSchema, parseOrThrow } from '@/lib/validation/schemas';
import type { OrgStatus } from '@/lib/types/domain';

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission('VIEW_MATERIALS');
    const status = request.nextUrl.searchParams.get('status') as OrgStatus | null;
    const withCounts = request.nextUrl.searchParams.get('withCounts') === 'true';
    const data = withCounts ? listOrganizationsWithCounts() : listOrganizations(status ?? undefined);
    return ok({ organizations: data });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireApiPermission('MANAGE_ORGANIZATIONS');
    const body = await readBoundedJson<unknown>(request);
    const input = parseOrThrow(orgCreateSchema, body);
    const created = createOrganization(input);
    return ok({ organization: created }, 201);
  } catch (err) {
    return fail(err);
  }
}
