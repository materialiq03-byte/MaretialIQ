import { NextRequest } from 'next/server';
import { ok, fail, parsePagination } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { loadRunHistory, validateRunRecord } from '@/lib/matching/run-history';

/**
 * GET /api/evaluation-runs — the permanent evaluation run history
 * (newest first). Read-only; every record is the immutable summary of one
 * `npm run evaluate` execution.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission('VIEW_ANALYTICS');
    const params = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(params);
    const runs = loadRunHistory().slice().reverse();
    const start = (page - 1) * pageSize;
    const items = runs.slice(start, start + pageSize);
    return ok({ runs: items, total: runs.length, page, pageSize });
  } catch (err) {
    return fail(err);
  }
}
