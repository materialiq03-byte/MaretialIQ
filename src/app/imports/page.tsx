import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { config } from '@/lib/config';
import { listImports } from '@/lib/db/repositories/import-repository';
import { listOrganizations } from '@/lib/db/repositories/organization-repository';
import ImportWizard from './import-wizard';

export const dynamic = 'force-dynamic';

const WORKFLOW_BADGE: Record<string, string> = {
  uploaded: 'neutral',
  validating: 'pending',
  ready: 'pending',
  importing: 'pending',
  completed: 'approved',
  completed_with_warnings: 'pending',
  failed: 'rejected',
};

/**
 * Phase UI-3 — Material Data Import: ingestion console presentation over the
 * FROZEN import pipeline contracts. The stage strip mirrors what the
 * pipeline actually does (source → validation → normalization → matching →
 * human review); no stage is implied to run automatically that does not.
 */
export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('IMPORT_MATERIALS');
  const sp = await searchParams;
  const showHistory = sp.history === '1';

  let imports: ReturnType<typeof listImports>['items'];
  let total: number;
  let orgs: ReturnType<typeof listOrganizations>;
  let loadError: string | null = null;
  const scope = visibleOrganizationIds(user);
  try {
    const result = listImports({ page: 1, pageSize: 20, organizationId: scope === null ? undefined : scope[0] });
    imports = result.items;
    total = result.total;
    // CPSE users may only import into their own organization.
    orgs = scope === null ? listOrganizations() : listOrganizations().filter((o) => o.id === scope[0]);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    imports = [];
    total = 0;
    orgs = [];
  }

  return (
    <main className="hq-root">
      <section className="hq3-pagehead" aria-label="Material data import">
        <div>
          <p className="hq3-kicker">DATA INGESTION</p>
          <h1>Material Data Import</h1>
          <p className="hq3-sub">
            Bring CPSE material data into the MaterialIQ intelligence pipeline — ingest and validate material master data
            before it enters harmonization. Authorized material data can be ingested here. Prototype environment:
            demonstration datasets contain 5 CPSEs × 10 representative records (in <span className="mono">data/synthetic-imports/</span>) — these are DEMONSTRATION
            DATASETS, not the platform's capacity. Enterprise CSV material masters are processed through chunked import
            jobs; XLSX uploads remain subject to a safety limit. Material codes in this environment are prototype
            identifiers, not official CPSE or government codes.
          </p>
        </div>
      </section>

      {/* Pipeline stages — what an import feeds, in order. Text labels, not decoration. */}
      <ol className="hq3-flowstrip" aria-label="Pipeline stages fed by an import">
        <li>
          <span className="hq3-flow-n">01</span>
          <span className="hq3-flow-name">SOURCE</span>
          <span className="hq3-flow-note">CSV/XLSX upload per CPSE</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">02</span>
          <span className="hq3-flow-name">VALIDATION</span>
          <span className="hq3-flow-note">Row-level checks + warnings</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">03</span>
          <span className="hq3-flow-name">NORMALIZATION</span>
          <span className="hq3-flow-note">Description + UOM normalization</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">04</span>
          <span className="hq3-flow-name">MATCHING</span>
          <span className="hq3-flow-note">Candidate discovery on import</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">05</span>
          <span className="hq3-flow-name">REVIEW</span>
          <span className="hq3-flow-note">Human technical validation</span>
        </li>
      </ol>

      {loadError ? (
        <div className="error-box">Failed to load import data: {loadError}</div>
      ) : (
        <ImportWizard
          organizations={orgs.map((o) => ({ id: o.id, code: o.code, name: o.name, status: o.status }))}
          csvLimitMb={config.pipeline.maxCsvImportMb}
          xlsxLimitMb={config.pipeline.maxXlsxImportMb}
        />
      )}

      <section aria-label="Import history">
        <h2 className="hq3-sec"><span className="hq6-secno">01</span> Import history</h2>
        {imports.length === 0 ? (
          <div className="empty-state">No imports recorded yet. Completed imports appear here with their row statistics.</div>
        ) : (
          <div className="table-wrap">
          <table className="hq3-imports">
            <thead>
              <tr>
                <th>#</th>
                <th>Filename</th>
                <th>CPSE</th>
                <th>Uploaded</th>
                <th className="num">Rows</th>
                <th className="num">Imported</th>
                <th className="num">Warnings</th>
                <th className="num">Errors</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {imports.map((i) => (
                <tr key={i.id}>
                  <td className="num">{i.id}</td>
                  <td className="mono">{i.file_name}</td>
                  <td>
                    <span className="mw-org">{i.org_code}</span>
                  </td>
                  <td>{i.created_at.slice(0, 19).replace('T', ' ')}</td>
                  <td className="num">{i.total_rows}</td>
                  <td className="num">{i.imported_rows || i.successful_rows}</td>
                  <td className="num">{i.warning_rows}</td>
                  <td className="num">{i.error_rows || i.failed_rows}</td>
                  <td>
                    <span className={`badge ${WORKFLOW_BADGE[i.workflow_status] ?? 'neutral'}`}>
                      {i.workflow_status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td>
                    <a href={`/imports/${i.id}`}>Details</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {total > 20 ? <p className="review-meta">Showing the 20 most recent of {total} imports.</p> : null}
      </section>
    </main>
  );
}
