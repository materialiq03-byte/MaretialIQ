import { requirePermission } from '@/lib/auth/guard';
import { visibleOrganizationIds } from '@/lib/auth/guard';
import { getImportRequired } from '@/lib/db/repositories/import-repository';
import { getDb } from '@/lib/db/client';
import { notFound, redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

interface ReportShape {
  headers: string[];
  mapping: Record<string, string | null>;
  rows?: Array<{
    rowNumber: number;
    values: Record<string, string>;
    severity: 'VALID' | 'WARNING' | 'ERROR';
    empty: boolean;
    problems: Array<{ rule: string; severity: string; message: string; suggestion?: string }>;
  }>;
  problems?: Array<{
    rowNumber: number;
    values: Record<string, string>;
    severity: 'VALID' | 'WARNING' | 'ERROR';
    empty: boolean;
    problems: Array<{ rule: string; severity: string; message: string; suggestion?: string }>;
  }>;
  summary?: unknown;
}

export default async function ImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission('IMPORT_MATERIALS');
  const { id } = await params;
  const importId = Number(id);
  if (!Number.isInteger(importId) || importId <= 0) notFound();

  let imp;
  try {
    imp = getImportRequired(importId);
  } catch {
    notFound();
  }
  // Org isolation: a CPSE user can only view their own organization's imports.
  const scope = visibleOrganizationIds(user);
  if (scope !== null && imp.organization_id !== scope[0]) redirect('/403');

  let report: ReportShape | null = null;
  try {
    report = imp.row_report ? (JSON.parse(imp.row_report) as ReportShape) : null;
  } catch {
    report = null;
  }

  const imported = getDb()
    .prepare(
      `SELECT m.id, m.original_code, m.original_description, m.category, m.processing_status, m.quality_status, m.source_row
         FROM material_records m WHERE m.import_id = ? ORDER BY m.source_row LIMIT 200`
    )
    .all(importId) as Array<{
    id: number; original_code: string; original_description: string; category: string;
    processing_status: string; quality_status: string | null; source_row: number | null;
  }>;

  const codeHeader = report?.mapping.originalCode ?? '';
  const descHeader = report?.mapping.originalDescription ?? '';
  // Bounded reports carry problem rows only; legacy reports embed all rows.
  const problemRows = (report?.rows ?? report?.problems ?? []).filter((r) => r.problems.length > 0);

  return (
    <main>
      <h1>
        Import #{imp.id} — <span className="mono">{imp.file_name}</span>
      </h1>
      <p className="subtitle">
        Full record of what was uploaded, what the system understood, and what entered the material master.
      </p>

      <h2>Record</h2>
      <div className="compare-grid">
        <div className="record-box">
          <div className="cpse">Source</div>
          <dl>
            <dt>CPSE</dt>
            <dd className="mono">{imp.org_code}</dd>
            <dt>Filename</dt>
            <dd className="mono">{imp.file_name}</dd>
            <dt>File type</dt>
            <dd>{imp.file_type.toUpperCase()}</dd>
            <dt>Uploaded</dt>
            <dd>{imp.created_at.slice(0, 19).replace('T', ' ')}</dd>
          </dl>
        </div>
        <div className="record-box">
          <div className="cpse">Processing</div>
          <dl>
            <dt>Workflow status</dt>
            <dd className="mono">{imp.workflow_status}</dd>
            <dt>Total data rows</dt>
            <dd>{imp.total_rows}</dd>
            <dt>Valid / warning / error</dt>
            <dd>
              {imp.valid_rows} / {imp.warning_rows} / {imp.error_rows}
            </dd>
            <dt>Imported / updated / skipped</dt>
            <dd>
              {imp.imported_rows} / {imp.updated_rows} / {imp.skipped_existing_rows}
            </dd>
            <dt>Validated / imported at</dt>
            <dd>
              {imp.validated_at?.slice(0, 19).replace('T', ' ') ?? '—'} /{' '}
              {imp.imported_at?.slice(0, 19).replace('T', ' ') ?? '—'}
            </dd>
          </dl>
        </div>
      </div>

      <h2>Column mapping</h2>
      {report ? (
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Detected column</th>
              <th>Mapped to</th>
            </tr>
          </thead>
          <tbody>
            {report.headers.map((h) => {
              const target = Object.entries(report.mapping).find(([, v]) => v === h)?.[0] ?? null;
              return (
                <tr key={h}>
                  <td className="mono">{h}</td>
                  <td>{target ?? '— ignored —'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      ) : (
        <div className="empty-state">No validation report was stored for this import (legacy or failed analysis).</div>
      )}

      <h2>Validation problems</h2>
      {problemRows.length === 0 ? (
        <div className="empty-state">No validation problems were recorded for this import.</div>
      ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Row</th>
              <th>Material code</th>
              <th>Description</th>
              <th>Problem</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>
            {problemRows.map((r) => (
              <tr key={r.rowNumber}>
                <td className="num">{r.rowNumber}</td>
                <td className="mono">{(codeHeader && r.values[codeHeader]) || '—'}</td>
                <td>{(descHeader && r.values[descHeader]) || '—'}</td>
                <td className="evidence-detail">
                  {r.problems.map((p) => (
                    <div key={p.rule}>
                      <strong>{p.rule}:</strong> {p.message}
                    </div>
                  ))}
                </td>
                <td>
                  <span className={`badge ${r.severity === 'WARNING' ? 'pending' : 'rejected'}`}>{r.severity}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <p>
        <a className="btn" href={`/api/imports/${imp.id}/errors`}>Download error report (CSV)</a>
      </p>

      <h2>Materials created by this import</h2>
      {imported.length === 0 ? (
        <div className="empty-state">No material records were created by this import.</div>
      ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source row</th>
              <th>Material code</th>
              <th>Description</th>
              <th>Category</th>
              <th>Processing status</th>
              <th>Quality</th>
            </tr>
          </thead>
          <tbody>
            {imported.map((m) => (
              <tr key={m.id}>
                <td className="num">{m.source_row ?? '—'}</td>
                <td className="mono">
                  <a href={`/materials/${m.id}`}>{m.original_code}</a>
                </td>
                <td>{m.original_description}</td>
                <td>{m.category}</td>
                <td className="mono">{m.processing_status}</td>
                <td>
                  <span className={`badge ${m.quality_status === 'good' ? 'approved' : m.quality_status === 'warning' ? 'pending' : 'neutral'}`}>
                    {m.quality_status ?? '—'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </main>
  );
}
