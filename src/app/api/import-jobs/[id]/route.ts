import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission, assertOrganizationWrite } from '@/lib/auth/guard';
import { getImportJob } from '@/lib/services/import-job-service';
import { getImportRequired } from '@/lib/db/repositories/import-repository';
import { errors } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/**
 * GET /api/import-jobs/:id — live progress for one import job. Progress is
 * derived from committed chunks only. A browser refresh re-fetches this, so
 * job state survives page reloads.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiPermission('IMPORT_MATERIALS');
    const { id } = await ctx.params;
    const job = getImportJob(id);
    const imp = getImportRequired(job.dataImportId);
    assertOrganizationWrite(user, imp.organization_id);
    return ok(job);
  } catch (err) {
    return fail(err);
  }
}
