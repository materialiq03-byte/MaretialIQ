import { readBoundedJson } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { errors } from '@/lib/errors';
import { requireApiPermission, assertOrganizationWrite } from '@/lib/auth/guard';
import { getImportRequired } from '@/lib/db/repositories/import-repository';
import { executeImport } from '@/lib/services/import-center-service';
import { invalidateReadCaches, READ_CACHE_TAGS } from '@/lib/cache/read-cache';

export const dynamic = 'force-dynamic';

interface ExecuteBody {
  includeWarnings?: boolean;
  duplicateStrategy?: 'skip' | 'update' | 'cancel';
  actor?: string;
}

/**
 * POST /api/imports/:id/execute — phase 2. Writes ONLY the rows the user
 * confirmed (valid + optionally warning rows), applying the duplicate
 * strategy. Invalid rows never enter the material master.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiPermission('IMPORT_MATERIALS');
    const { id } = await ctx.params;
    const importId = Number(id);
    if (!Number.isInteger(importId) || importId <= 0) {
      throw errors.badRequest('Invalid import id');
    }
    const imp = getImportRequired(importId);
    assertOrganizationWrite(user, imp.organization_id);

    let body: ExecuteBody | null = null;
    try {
      body = (await readBoundedJson<unknown>(request)) as ExecuteBody;
    } catch {
      // Malformed JSON must be a 400, not an unhandled 500.
      throw errors.badRequest('Request body must be valid JSON');
    }
    if (body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      throw errors.badRequest('Request body must be a JSON object');
    }
    if (body?.duplicateStrategy !== undefined && !['skip', 'update', 'cancel'].includes(body.duplicateStrategy)) {
      throw errors.badRequest('duplicateStrategy must be one of: skip, update, cancel');
    }
    if (body?.includeWarnings !== undefined && typeof body.includeWarnings !== 'boolean') {
      throw errors.badRequest('includeWarnings must be a boolean');
    }
    const duplicateStrategy = body?.duplicateStrategy === 'update' ? 'update' : body?.duplicateStrategy === 'cancel' ? 'cancel' : 'skip';

    const result = executeImport({
      importId,
      includeWarnings: body?.includeWarnings !== false,
      duplicateStrategy,
      actor: typeof body?.actor === 'string' && body.actor.trim() ? body.actor.trim().slice(0, 120) : user.email,
    });
    invalidateReadCaches(READ_CACHE_TAGS.dashboardMetrics, READ_CACHE_TAGS.analyticsSummary);
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
