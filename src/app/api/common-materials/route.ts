import { readBoundedJson } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { listCmiWithMembers } from '@/lib/services/registry-service';
import { createCmiFromMatch } from '@/lib/services/matching-service';
import { cmiCreateSchema, parseOrThrow } from '@/lib/validation/schemas';

export async function GET() {
  try {
    await requireApiPermission('VIEW_MAPPINGS');
    return ok({ commonMaterials: listCmiWithMembers() });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireApiPermission('CREATE_COMMON_IDENTITY');
    const body = await readBoundedJson<unknown>(request);
    const input = parseOrThrow(cmiCreateSchema, body);
    const result = createCmiFromMatch(input, user.email);
    return ok(result, 201);
  } catch (err) {
    return fail(err);
  }
}
