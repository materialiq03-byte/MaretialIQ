/**
 * CMI registry surface probe (SELECT-only): runs each repository/service code
 * path used by /cross-reference through the REAL translator + live executor
 * to find which statement still raises.
 * `MATERIALIQ_DATABASE_URL=... npx tsx scripts/check-cmi-surface.mts`
 */
process.env.MATERIALIQ_DB_DIALECT = 'postgresql';
if (!process.env.MATERIALIQ_DATABASE_URL) {
  console.error('Set MATERIALIQ_DATABASE_URL first (read it from .env.local).');
  process.exit(1);
}

import { getDb } from '../src/lib/db/client';
import { listCmiWithMembers } from '../src/lib/services/registry-service';
import {
  getCmiProcurementSummary,
  getCmiDemandByOrganization,
  getCmiSupplierSummary,
  getCmiMonthlyDemandRows,
  listOpportunities,
} from '../src/lib/db/repositories/procurement-repository';
import { listOrganizations } from '../src/lib/db/repositories/organization-repository';

let step = 0;
function probe(name: string, fn: () => unknown): unknown {
  step++;
  try {
    const r = fn();
    console.log(`OK  ${step} - ${name}`);
    return r;
  } catch (e) {
    console.log(`ERR ${step} - ${name} :: ${(e as Error).message.slice(0, 90)}`);
    throw e;
  }
}

// Warm the executor + ensure SELECT-only usage throughout.
getDb().prepare('SELECT 1 AS ok').get();

const cmis = probe('listCmiWithMembers', () => listCmiWithMembers()) as unknown as Array<{
  cmi: { id: number; code: string };
  members: Array<{ id: number }>;
}>;
const cmiId = Number(cmis[0]?.cmi?.id ?? 1);

probe('listOrganizations', () => listOrganizations());
probe('getCmiProcurementSummary', () => getCmiProcurementSummary(cmiId));
probe('getCmiDemandByOrganization', () => getCmiDemandByOrganization(cmiId));
probe('getCmiSupplierSummary', () => getCmiSupplierSummary(cmiId));
probe('getCmiMonthlyDemandRows', () => getCmiMonthlyDemandRows(cmiId));
probe('listOpportunities OPEN', () => listOpportunities({ status: 'OPEN' }, 1, 500).total);
console.log('ALL CMI SURFACE OK (cmi id =', cmiId + ')');
