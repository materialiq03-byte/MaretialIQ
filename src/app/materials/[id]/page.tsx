import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { getMaterialRequired, listAttributes } from '@/lib/db/repositories/material-repository';
import { listMatches } from '@/lib/db/repositories/matching-repository';
import { listMappingsForMaterial } from '@/lib/db/repositories/registry-repository';
import { listAudit } from '@/lib/db/repositories/audit-repository';
import { notFound, redirect } from 'next/navigation';
import ReprocessButton from './reprocess-button';

export const dynamic = 'force-dynamic';

const QUALITY_CLASS: Record<string, string> = {
  good: 'badge approved',
  warning: 'badge pending',
  incomplete: 'badge deferred',
  invalid: 'badge rejected',
  not_processed: 'badge neutral',
};

const METHOD_LABEL: Record<string, string> = {
  rule: 'Rule',
  manual: 'Manual',
  imported: 'Imported',
};

export default async function MaterialDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission('VIEW_MATERIALS');
  const { id } = await params;
  const materialId = Number(id);
  if (!Number.isInteger(materialId) || materialId <= 0) notFound();

  let material;
  let attributes;
  let loadError: string | null = null;
  try {
    material = getMaterialRequired(materialId);
    attributes = listAttributes(materialId);
  } catch {
    notFound();
  }
  // Org read isolation: CPSE-scoped users see only their own records.
  const scope = visibleOrganizationIds(user);
  if (scope !== null && material.organization_id !== scope[0]) redirect('/403');
  const canReprocess = user.role === 'platform_admin' || user.role === 'cpse_material_manager';

  let matches: ReturnType<typeof listMatches>['items'];
  let mappings: ReturnType<typeof listMappingsForMaterial>;
  let audit: ReturnType<typeof listAudit>['items'];
  try {
    matches = listMatches({ materialId, page: 1, pageSize: 100 }).items;
    mappings = listMappingsForMaterial(materialId);
    audit = listAudit({ entityType: 'material_record', entityId: materialId, page: 1, pageSize: 20 }).items;
  } catch (err) {
    matches = [];
    mappings = [];
    audit = [];
    loadError = err instanceof Error ? err.message : String(err);
  }

  let qualityChecks: Array<{ check: string; passed: boolean; detail: string }> = [];
  try {
    qualityChecks = material.quality_checks ? JSON.parse(material.quality_checks) : [];
  } catch {
    qualityChecks = [];
  }

  return (
    <main>
      <div className="ent-detail-head">
        <div>
          <h1>
            <span className="ent-detail-code">{material.original_code}</span>
            <span className="ent-detail-org">{material.org_code}</span>
          </h1>
          <p className="subtitle">{material.original_description}</p>
          <div className="ent-detail-badges">
            <span className="badge pending">{material.category}</span>
            <span className={`badge ${material.processing_status === 'warning' ? 'pending' : 'approved'}`}>
              {material.processing_status === 'warning' ? 'Warning' : 'Active'}
            </span>
            <span className="evidence-detail">Record #{material.id} · quality: {material.quality_status ?? 'not_processed'}</span>
          </div>
        </div>
      </div>
      {loadError ? <div className="error-box">Some related data could not be loaded: {loadError}</div> : null}

      <h2>Source Information</h2>
      <div className="compare-grid">
        <div className="record-box">
          <div className="cpse">Original information (source record preserved)</div>
          <dl>
            <dt>CPSE</dt>
            <dd>
              {material.org_name} ({material.org_code})
            </dd>
            <dt>Original code</dt>
            <dd className="mono">{material.original_code}</dd>
            <dt>Original description</dt>
            <dd>{material.original_description}</dd>
            <dt>UOM</dt>
            <dd>{material.uom}</dd>
          </dl>
        </div>
        <div className="record-box">
          <div className="cpse">Normalized information (extracted)</div>
          <dl>
            <dt>Normalized description</dt>
            <dd className="mono">{material.normalized_description ?? '—'}</dd>
            <dt>Category</dt>
            <dd>{material.category}</dd>
            <dt>Subcategory</dt>
            <dd>{material.subcategory ?? '—'}</dd>
            <dt>Classification confidence</dt>
            <dd>
              {material.classification_confidence !== null ? `${material.classification_confidence}%` : '—'}
              {material.classification_source ? ` (${material.classification_source})` : ''}
            </dd>
            <dt>Manufacturer</dt>
            <dd>{material.manufacturer ?? '—'}</dd>
            <dt>Model</dt>
            <dd className="mono">{material.model ?? '—'}</dd>
            <dt>Processing status</dt>
            <dd className="mono">{material.processing_status}</dd>
          </dl>
        </div>
      </div>

      <h2>
        Data quality{' '}
        <span className={QUALITY_CLASS[material.quality_status ?? 'not_processed'] ?? 'badge neutral'}>
          {material.quality_status ?? 'not_processed'}
        </span>
      </h2>
      {qualityChecks.length === 0 ? (
        <div className="empty-state">No quality checks recorded. Reprocess this material to run them.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Check</th>
              <th>Result</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {qualityChecks.map((c) => (
              <tr key={c.check}>
                <td className="mono">{c.check}</td>
                <td>
                  <span className={`badge ${c.passed ? 'match' : 'mismatch'}`}>{c.passed ? 'pass' : 'fail'}</span>
                </td>
                <td className="evidence-detail">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canReprocess ? (
        <form action={`/api/materials/${materialId}/reprocess`} method="post" className="decision-row">
          <ReprocessButton materialId={materialId} />
        </form>
      ) : null}

      <h2>Extracted technical attributes</h2>
      {attributes.length === 0 ? (
        <div className="empty-state">No technical attributes extracted from this description.</div>
      ) : (
        <div className="table-wrap">
          <table className="ent-table">
          <thead>
            <tr>
              <th>Attribute</th>
              <th>Value</th>
              <th>Normalized</th>
              <th>Unit</th>
              <th>Source</th>
              <th>Critical</th>
            </tr>
          </thead>
          <tbody>
            {attributes.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.attribute_name}</td>
                <td>{a.value}</td>
                <td className="mono">{a.normalized_value ?? '—'}</td>
                <td>{a.unit ?? '—'}</td>
                <td>{METHOD_LABEL[a.extraction_method] ?? a.extraction_method}</td>
                <td>{a.is_critical ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h2>Cross-CPSE relationships</h2>
      <h3 className="ent-h3">Potential matches</h3>
      {matches.length === 0 ? (
        <div className="empty-state">No match candidates involve this material yet. Run the matcher from the review queue.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Paired with</th>
              <th>Type</th>
              <th className="num">Final score</th>
              <th>Status</th>
              <th>Critical difference</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((m) => {
              const other = m.source.id === materialId ? m.candidateMat : m.source;
              return (
                <tr key={m.candidate.id}>
                  <td>
                    <span className="mono">{other.org_code}</span> {other.original_code} — {other.original_description}
                  </td>
                  <td>{m.candidate.match_type}</td>
                  <td className="num">{m.candidate.final_score}%</td>
                  <td>
                    <span className={`badge ${m.candidate.status}`}>{m.candidate.status}</span>
                  </td>
                  <td className="evidence-detail">{m.candidate.critical_difference ?? '—'}</td>
                  <td>
                    <a href={`/matching/${m.candidate.id}`}>Compare →</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3 className="ent-h3">Legacy mappings</h3>
      {mappings.length === 0 ? (
        <div className="empty-state">Not mapped to any common material identity yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>CMI code</th>
              <th>CMI name</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((mm) => (
              <tr key={String(mm.id)}>
                <td className="mono">{String(mm.cmi_code)}</td>
                <td>{String(mm.cmi_name)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Audit history</h2>
      {audit.length === 0 ? (
        <div className="empty-state">No audit events for this record.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Actor</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.action}</td>
                <td>{a.actor}</td>
                <td>{a.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
