import { readBoundedJson } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { errors } from '@/lib/errors';
import { requireApiPermission, assertOrganizationWrite } from '@/lib/auth/guard';
import { getImportRequired } from '@/lib/db/repositories/import-repository';
import {
  createAndStartImportJob,
  getImportJob,
  listImportJobs,
  startQueuedImportAsync,
} from '@/lib/services/import-job-service';
import { invalidateReadCaches, READ_CACHE_TAGS } from '@/lib/cache/read-cache';

export const dynamic = 'force-dynamic';

/**
 * Step-5 import job API. The import executes in bounded chunks OUTSIDE the
 * request lifecycle (in-process prototype runner, not a distributed worker);
 * the request returns immediately with the job id.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireApiPermission('IMPORT_MATERIALS');
    const body = (await readBoundedJson<unknown>(request).catch(() => null)) as
      | { importId?: number; jobId?: string; kind?: 'materials' | 'procurement' }
      | null;
    if (!body) throw errors.badRequest('JSON body required');

    // Resume path: POST { jobId } re-claims a FAILED or stale-RUNNING job.
    if (typeof body.jobId === 'string' && body.jobId.trim()) {
      const job = getImportJob(body.jobId.trim());
      const imp = getImportRequired(job.dataImportId);
      assertOrganizationWrite(user, imp.organization_id);
      startQueuedImportAsync(job.jobId);
      invalidateReadCaches(READ_CACHE_TAGS.dashboardMetrics, READ_CACHE_TAGS.analyticsSummary);
      return ok(job, 202);
    }

    // Create path: POST { importId } validates + starts a chunked import job.
    // Step 13: POST { importId, kind: 'procurement' } starts a procurement
    // import job (same job model, procurement executor).
    const importId = Number(body.importId);
    if (!Number.isInteger(importId) || importId <= 0) {
      throw errors.badRequest('importId (number) or jobId (string) is required');
    }
    const kind = body.kind === 'procurement' ? 'procurement' : 'materials';
    const imp = getImportRequired(importId);
    assertOrganizationWrite(user, imp.organization_id);

    const job = createAndStartImportJob(importId, user.email, kind);
    return ok(job, 202);
  } catch (err) {
    return fail(err);
  }
}

/** Small observability listing (newest first, bounded). */
export async function GET() {
  try {
    await requireApiPermission('IMPORT_MATERIALS');
    return ok({ jobs: listImportJobs(10) });
  } catch (err) {
    return fail(err);
  }
}
