/**
 * Platform user administration API — Step 26 gap fix.
 *
 * The /admin/users UI has POSTed here since it was built, but the route
 * itself was never implemented (404). Implemented now following the existing
 * route conventions (see /api/organizations/route.ts): permission guard →
 * bounded body read → zod validation → service call → ok/fail helpers.
 *
 * All business rules (password length, CPSE-role organization requirement,
 * duplicate-email conflict, scrypt hashing, user_created audit record) live
 * in admin-service.createUserAsync and are unchanged.
 */
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { listUsers, createUserAsync } from '@/lib/auth/admin-service';
import { readBoundedJson } from '@/lib/security/request-limit';
import { userCreateSchema, parseOrThrow } from '@/lib/validation/schemas';
import { revalidateTag } from 'next/cache';

export async function GET() {
  try {
    await requireApiPermission('MANAGE_USERS');
    return ok({ users: listUsers() });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireApiPermission('MANAGE_USERS');
    const body = await readBoundedJson<unknown>(request);
    const input = parseOrThrow(userCreateSchema, body);
    const user = await createUserAsync(input, actor.email);
    revalidateTag('dashboard-metrics');
    return ok({ user }, 201);
  } catch (err) {
    return fail(err);
  }
}
