import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { errors } from '@/lib/errors';
import { requireApiPermission, assertOrganizationWrite } from '@/lib/auth/guard';
import { getImportRequired } from '@/lib/db/repositories/import-repository';
import { getProcurementPreviewPage } from '@/lib/services/procurement-import-service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/procurement-imports/:id/preview — server-side paginated preview
 * over a procurement import's staged rows. Page size is capped at 100
 * server-side; the browser never receives the full dataset.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiPermission('IMPORT_MATERIALS');
    const { id } = await ctx.params;
    const importId = Number(id);
    if (!Number.isInteger(importId) || importId <= 0) throw errors.badRequest('Invalid import id');
    const imp = getImportRequired(importId);
    assertOrganizationWrite(user, imp.organization_id);

    const params = request.nextUrl.searchParams;
    const severityParam = (params.get('severity') ?? 'ALL').toUpperCase();
    const severity = (['ALL', 'VALID', 'WARNING', 'ERROR'].includes(severityParam)
      ? severityParam
      : 'ALL') as 'ALL' | 'VALID' | 'WARNING' | 'ERROR';

    const result = getProcurementPreviewPage(importId, {
      page: Number.parseInt(params.get('page') ?? '1', 10) || 1,
      pageSize: Number.parseInt(params.get('pageSize') ?? '50', 10) || 50,
      severity,
      q: params.get('q') ?? undefined,
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
