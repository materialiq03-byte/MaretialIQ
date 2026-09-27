import { NextRequest } from 'next/server';
import { ok, fail, parsePagination } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { listAudit } from '@/lib/db/repositories/audit-repository';

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission('VIEW_AUDIT');
    const params = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(params);
    const result = listAudit({
      entityType: params.get('entityType')?.trim() || undefined,
      entityId: params.get('entityId') ? Number(params.get('entityId')) : undefined,
      actor: params.get('actor')?.trim() || undefined,
      page,
      pageSize,
    });
    return ok({ items: result.items, total: result.total, page, pageSize });
  } catch (err) {
    return fail(err);
  }
}
