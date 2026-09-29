/**
 * PERF (Phase 3): tagged short-TTL caching for READ-ONLY aggregates only.
 *
 * Scope discipline:
 *  - Only data whose brief staleness cannot cause an incorrect technical
 *    decision is cached: dashboard KPI bundles, the matching decision-state
 *    overview and the analytics/evaluation summaries. Review decisions,
 *    imports, CMI writes and procurement writes are NEVER served from cache.
 *  - Every mutating route that affects a cached tag calls revalidateTag on
 *    its success path (see the api/* handlers), so a mutation is reflected
 *    immediately; the TTLs below are only a backstop for non-request paths
 *    (e.g. the review-console matcher trigger).
 *  - Dashboard metrics are parameterized by organization scope; the scope is
 *    part of the cache key, so no cross-CPSE data can leak between roles.
 */
import { unstable_cache, revalidateTag } from 'next/cache';

export const READ_CACHE_TAGS = {
  dashboardMetrics: 'dashboard-metrics',
  analyticsSummary: 'analytics-summary',
  evaluationSummary: 'evaluation-summary',
} as const;

/**
 * Cache a read-only producer under `tags` for `ttlSeconds`. `keys` must
 * contain every input that can change the result (e.g. org scope).
 */
export async function cachedRead<T>(
  keys: string[],
  ttlSeconds: number,
  tags: string[],
  producer: () => T,
): Promise<T> {
  const wrapped = unstable_cache(async () => producer(), ['materialiq-read-cache', ...keys], {
    tags,
    revalidate: ttlSeconds,
  });
  return wrapped();
}

/** Invalidate the given read-cache tags after a successful mutation. */
export function invalidateReadCaches(...tags: Array<string>): void {
  for (const t of tags) revalidateTag(t);
}
