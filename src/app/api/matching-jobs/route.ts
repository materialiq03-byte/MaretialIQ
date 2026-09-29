import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { createAndStartMatchingJob, listMatchingJobs } from '@/lib/services/matching-job-service';
import { invalidateReadCaches, READ_CACHE_TAGS } from '@/lib/cache/read-cache';

/**
 * Step-4 matching job API — create + start a matching run as a background
 * job and return immediately. The matching algorithm itself is untouched;
 * execution moves out of the request lifecycle in bounded chunks.
 */
export async function POST() {
  try {
    const user = await requireApiPermission('RUN_MATCHING');
    const job = createAndStartMatchingJob(user.email);
    invalidateReadCaches(READ_CACHE_TAGS.dashboardMetrics, READ_CACHE_TAGS.analyticsSummary);
    return ok(job, 202);
  } catch (err) {
    return fail(err);
  }
}

/** Small observability listing (newest first, bounded). */
export async function GET() {
  try {
    await requireApiPermission('RUN_MATCHING');
    return ok({ jobs: listMatchingJobs(10) });
  } catch (err) {
    return fail(err);
  }
}
