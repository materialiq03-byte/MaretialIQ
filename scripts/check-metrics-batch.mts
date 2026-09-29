/**
 * PERF probe (SELECT-only): runs the batched dashboard metrics, the derived
 * control-center assembly and the batched blocked-code-collision lookup
 * through the REAL translator + live executor — mirrors
 * scripts/check-cmi-surface.mts. `npx tsx scripts/check-metrics-batch.mts`
 */
process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
if (!process.env.MATERIALIQ_DATABASE_URL) {
  console.error('Set MATERIALIQ_DATABASE_URL first (read it from .env.local).');
  process.exit(1);
}

import { getDashboardMetrics } from '../src/lib/db/repositories/metrics-repository';
import { listBlockedCodeCollisions } from '../src/lib/db/repositories/import-repository';
import { getControlCenterData } from '../src/lib/services/control-center-service';

const t0 = Date.now();
const m = getDashboardMetrics(null);
console.log('metrics ms:', Date.now() - t0);
console.log('totalMaterials:', m.totalMaterials, '| pendingReviews:', m.pendingReviews, '| hc:', m.highConfidenceCandidates, '| deferred:', m.deferredCount);
console.log('byCategory[:3]:', JSON.stringify(m.byCategory.slice(0, 3)));
console.log('byProcessingStatus:', JSON.stringify(m.byProcessingStatus));
console.log('byQualityStatus:', JSON.stringify(m.byQualityStatus));
console.log('byMatchType:', JSON.stringify(m.byMatchType));
console.log('byStatus:', JSON.stringify(m.byStatus));
console.log('openQueue:', JSON.stringify(m.openQueue));
console.log('queueStatus:', JSON.stringify(m.queueStatus));
console.log('matchOverview:', JSON.stringify(m.matchOverview));
console.log('perOrg:', m.perOrganization.map((o) => `${o.code}:${o.materials}/${o.pending_reviews}/${o.critical_conflicts}/${o.mappings}`).join('  '));
console.log('rows: imports=%d activity=%d decisions=%d', m.recentImports.length, m.recentActivity.length, m.recentDecisions.length);

const cc = getControlCenterData(m);
console.log('cc resolvedReviews:', cc.resolvedReviews, '| totalCandidates:', cc.totalCandidates);
console.log('cc decisionStates:', JSON.stringify(cc.decisionStates));
console.log('cc procSignals:', JSON.stringify(cc.procurementSignals));
console.log('cc harmonization:', cc.harmonization ? `${cc.harmonization.code} members=${cc.harmonization.members.length}` : 'null');
console.log('cc lastMatchRun:', JSON.stringify(cc.lastMatchRun));
console.log('collisions:', listBlockedCodeCollisions().length);
console.log('TOTAL ms:', Date.now() - t0);
