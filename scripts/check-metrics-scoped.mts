/** PERF probe (SELECT-only): the org-scoped branch of getDashboardMetrics. */
process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
if (!process.env.MATERIALIQ_DATABASE_URL) {
  console.error('Set MATERIALIQ_DATABASE_URL first (read it from .env.local).');
  process.exit(1);
}
import { getDashboardMetrics } from '../src/lib/db/repositories/metrics-repository';
const m = getDashboardMetrics(2);
console.log('org2 totalMaterials:', m.totalMaterials, '(expect 24)');
console.log('pendingReviews:', m.pendingReviews, '| totalMappings:', m.totalMappings, '| importsDone:', m.importsCompleted);
console.log('byProcessingStatus:', JSON.stringify(m.byProcessingStatus));
console.log('byQualityStatus:', JSON.stringify(m.byQualityStatus));
console.log('matchOverview:', JSON.stringify(m.matchOverview));
console.log('recentImports orgs:', m.recentImports.map((i) => i.org_code).join(','));
console.log('recentDecisions:', m.recentDecisions.length, 'rows; matchOverview sorted n DESC:', m.matchOverview.every((r, i, a) => i === 0 || a[i - 1].n >= r.n));
