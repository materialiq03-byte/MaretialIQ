import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { config } from '@/lib/config';
import { listOrganizations } from '@/lib/db/repositories/organization-repository';
import ProcurementImportWizard from './wizard';

export const dynamic = 'force-dynamic';

export default async function ProcurementImportPage() {
  const user = await requirePermission('IMPORT_MATERIALS');
  const scope = visibleOrganizationIds(user);
  // CPSE users may only import into their own organization; admins see all.
  const orgs = (scope === null ? listOrganizations() : listOrganizations().filter((o) => o.id === scope[0])).map(
    (o) => ({ id: o.id, code: o.code, name: o.name, status: o.status }),
  );

  return (
    <main>
      <h1>Import Procurement History</h1>
      <p className="subtitle">
        Controlled ingestion of representative procurement history into the procurement foundation. Upload CSV/XLSX,
        map columns, validate against the material master and supplier registry, then execute a chunked background
        import. Records resolve CPSE-specific material codes against the material master and, where a human-approved
        mapping exists, carry the prototype common material identity — import never creates or repairs identities.
        Demonstration environment: procurement records are representative synthetic data, not actual CPSE purchases.
      </p>
      <ProcurementImportWizard
        organizations={orgs}
        csvLimitMb={config.pipeline.maxCsvImportMb}
        xlsxLimitMb={config.pipeline.maxXlsxImportMb}
      />
    </main>
  );
}
