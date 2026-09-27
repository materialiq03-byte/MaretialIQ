import { NextRequest } from 'next/server';
import { ok, fail, parsePagination } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { listSuppliersWithIntelligence } from '@/lib/services/procurement-service';

/**
 * GET /api/procurement/suppliers - supplier intelligence list (section 25:
 * read permission only; Step 16 adds no mutations). All filtering, search
 * and pagination are server-side; read operations create no audit rows.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission('VIEW_MAPPINGS');
    const params = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(params);
    const q = params.get('q') ?? undefined;
    const org = params.get('organizationId');
    const cmi = params.get('cmiId');
    const result = await Promise.resolve(
      listSuppliersWithIntelligence(
        {
          q: q || undefined,
          organizationId: org ? Number(org) : undefined,
          cmiId: cmi ? Number(cmi) : undefined,
          dateFrom: params.get('dateFrom') ?? undefined,
          dateTo: params.get('dateTo') ?? undefined,
          uom: params.get('uom') ?? undefined,
          currency: params.get('currency') ?? undefined,
        },
        page,
        pageSize
      )
    );
    return ok({ suppliers: result.items, total: result.total, page, pageSize });
  } catch (e) {
    return fail(e);
  }
}
