import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { parseOrThrow, idSchema } from '@/lib/validation/schemas';
import { requireApiPermission } from '@/lib/auth/guard';
import { getIntegrationRun } from '@/lib/integrations/integration-service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/[id] — one integration run's metadata + traceability
 * pointers (source file → import → material master → matching → review).
 * Read-only and audit-silent; the linked pages are the existing workflows.
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireApiPermission('IMPORT_MATERIALS');
    const { id } = await ctx.params;
    const importId = parseOrThrow(idSchema, id);
    return ok(getIntegrationRun(importId));
  } catch (err) {
    return fail(err);
  }
}
