import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { describeMatchingJob, runJob, getMatchingJob } from '@/lib/services/matching-job-service';
import { invalidateReadCaches, READ_CACHE_TAGS } from '@/lib/cache/read-cache';

/**
 * Single matching-job status/resume endpoint. GET returns live progress
 * (committed-work based). POST re-claims a FAILED or stale-RUNNING job and
 * resumes it; committed chunks are skipped, so no duplicate work occurs.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireApiPermission('RUN_MATCHING');
    const { id } = await ctx.params;
    return ok(describeMatchingJob(id));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireApiPermission('RUN_MATCHING');
    const { id } = await ctx.params;
    // Validate the job exists first so a bad id is a 404, not a run failure.
    getMatchingJob(id);
    const summary = runJob(id);
    invalidateReadCaches(READ_CACHE_TAGS.dashboardMetrics, READ_CACHE_TAGS.analyticsSummary);
    return ok(summary, 202);
  } catch (err) {
    return fail(err);
  }
}
