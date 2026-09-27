'use client';

/**
 * Step 13 — procurement import wizard. Same enterprise interaction model as
 * the material Import Center (source → upload → map → validate → execute →
 * result), speaking to the procurement-specific APIs. All parsing/validation
 * happens server-side; the browser only ever holds a bounded preview.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Organization {
  id: number;
  code: string;
  name: string;
  status: string;
}

interface ProcSummaryShape {
  totalRows: number;
  valid: number;
  warnings: number;
  errors: number;
  emptyRows: number;
  unknownOrganization: number;
  unknownMaterial: number;
  unknownSupplier: number;
  invalidDate: number;
  invalidQuantity: number;
  invalidPrice: number;
  invalidStatus: number;
  unknownCmi: number;
  cmiMismatch: number;
  duplicateInFile: number;
  missingPoReference: number;
  unknownUom: number;
}

interface AnalyzeResponse {
  importId: number;
  headers: string[];
  mapping: Record<string, string | null>;
  mappingUsable: boolean;
  suggestions: Array<{ header: string; target: string | null; confident: boolean }>;
  parseWarnings: string[];
  summary: ProcSummaryShape;
  previewRows: Array<{
    rowNumber: number;
    values: Record<string, string>;
    severity: 'VALID' | 'WARNING' | 'ERROR';
    problems: Array<{ rule: string; severity: string; message: string }>;
    resolved?: { orgCode: string; materialCode: string; cmiCode: string | null; supplierCode: string };
  }>;
  validationErrors: Array<{ rowNumber: number; rule: string; message: string }>;
  canExecute: boolean;
}

interface PreviewRow {
  rowNumber: number;
  values: Record<string, string>;
  severity: 'VALID' | 'WARNING' | 'ERROR';
  problems: Array<{ rule: string; severity: string; message: string }>;
  resolved?: { orgCode: string; materialCode: string; cmiCode: string | null; supplierCode: string };
}

interface JobSummary {
  jobId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  totalRows: number;
  processedRows: number;
  successfulRows: number;
  failedRows: number;
  chunkSize: number;
  progressPct: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

const STEPS = ['Source', 'Upload', 'Map columns', 'Validate', 'Execute', 'Result'] as const;

const TARGET_FIELDS: Array<{ key: string; label: string; required?: boolean }> = [
  { key: 'organization', label: 'CPSE / organization', required: true },
  { key: 'materialCode', label: 'Material code', required: true },
  { key: 'supplier', label: 'Supplier', required: true },
  { key: 'purchaseDate', label: 'Purchase date', required: true },
  { key: 'quantity', label: 'Quantity', required: true },
  { key: 'uom', label: 'UOM', required: true },
  { key: 'poReference', label: 'PO reference' },
  { key: 'deliveryDate', label: 'Delivery date' },
  { key: 'unitPrice', label: 'Unit price' },
  { key: 'currency', label: 'Currency' },
  { key: 'status', label: 'Procurement status' },
  { key: 'plantLocation', label: 'Plant / location' },
  { key: 'cmiCode', label: 'CMI code (explicit)' },
];

const PREVIEW_PAGE_SIZE = 50;

const ERROR_CATEGORIES: Array<{ key: keyof ProcSummaryShape; label: string }> = [
  { key: 'unknownOrganization', label: 'Unknown CPSE' },
  { key: 'unknownMaterial', label: 'Unknown material' },
  { key: 'unknownSupplier', label: 'Unknown supplier' },
  { key: 'invalidDate', label: 'Invalid date' },
  { key: 'invalidQuantity', label: 'Invalid quantity' },
  { key: 'unknownUom', label: 'Invalid UOM' },
  { key: 'invalidPrice', label: 'Invalid price' },
  { key: 'invalidStatus', label: 'Invalid status' },
  { key: 'unknownCmi', label: 'Unknown CMI' },
  { key: 'cmiMismatch', label: 'CMI mismatch' },
  { key: 'duplicateInFile', label: 'Duplicate line' },
];

const SEVERITY_BADGE: Record<string, string> = {
  VALID: 'approved',
  WARNING: 'pending',
  ERROR: 'rejected',
};

export default function ProcurementImportWizard({
  organizations,
  csvLimitMb = 50,
  xlsxLimitMb = 5,
}: {
  organizations: Organization[];
  csvLimitMb?: number;
  xlsxLimitMb?: number;
}) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [orgCode, setOrgCode] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [analyze, setAnalyze] = useState<AnalyzeResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [includeWarnings, setIncludeWarnings] = useState(true);
  const [severityFilter, setSeverityFilter] = useState<'ALL' | 'VALID' | 'WARNING' | 'ERROR'>('ALL');
  const [preview, setPreview] = useState<{ filteredTotal: number; rows: PreviewRow[] } | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [job, setJob] = useState<JobSummary | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const loadPreview = useCallback(async (importId: number, page: number, severity: string) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PREVIEW_PAGE_SIZE), severity });
    const res = await fetch(`/api/procurement-imports/${importId}/preview?${params.toString()}`);
    const data = await res.json().catch(() => null);
    if (res.ok && data?.data) setPreview(data.data as { filteredTotal: number; rows: PreviewRow[] });
  }, []);

  useEffect(() => {
    if (step !== 3 || !analyze) return;
    void loadPreview(analyze.importId, previewPage, severityFilter);
  }, [step, analyze, previewPage, severityFilter, loadPreview]);

  useEffect(() => {
    if (step !== 5 || !job) return;
    if (job.status === 'COMPLETED' || job.status === 'FAILED') return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/import-jobs/${job.jobId}`);
        const data = await res.json().catch(() => null);
        if (res.ok && data?.data) setJob(data.data as JobSummary);
      } catch {
        /* transient — next tick retries */
      }
    }, 1000);
    return () => clearInterval(t);
  }, [step, job]);

  function reset(): void {
    setStep(0); setError(null); setOrgCode(null); setFile(null); setAnalyze(null);
    setMapping({}); setJob(null); setPreview(null); setPreviewPage(1);
    setSeverityFilter('ALL'); setIncludeWarnings(true); setStartedAt(null);
  }

  function acceptFile(f: File | null): void {
    setError(null);
    if (!f) return;
    const lower = f.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
      setError('Unsupported file type — choose a .csv or .xlsx file.');
      return;
    }
    if (f.size === 0) { setError('The selected file is empty.'); return; }
    const isCsv = lower.endsWith('.csv');
    const limitMb = isCsv ? csvLimitMb : xlsxLimitMb;
    if (f.size > limitMb * 1024 * 1024) {
      setError(
        isCsv
          ? `CSV file exceeds the configured upload limit (${limitMb} MB). Split large procurement histories into multiple files.`
          : `XLSX file exceeds the ${limitMb} MB safety limit — export procurement data as CSV for large datasets.`
      );
      return;
    }
    setFile(f);
    setAnalyze(null);
  }

  async function uploadAndAnalyze(): Promise<void> {
    if (!file || !orgCode) return;
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('organizationCode', orgCode);
      const res = await fetch('/api/procurement-imports/analyze', { method: 'POST', body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error?.message ?? `Analysis failed (HTTP ${res.status}).`); return; }
      const result = data.data as AnalyzeResponse;
      setAnalyze(result);
      setMapping(result.mapping);
      setPreview(null); setPreviewPage(1);
      setStep(result.mappingUsable ? 3 : 2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error during upload.');
    } finally {
      setBusy(false);
    }
  }

  async function revalidate(): Promise<void> {
    if (!file || !orgCode) return;
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('organizationCode', orgCode);
      form.append('mapping', JSON.stringify(mapping));
      const res = await fetch('/api/procurement-imports/analyze', { method: 'POST', body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error?.message ?? `Validation failed (HTTP ${res.status}).`); return; }
      const result = data.data as AnalyzeResponse;
      setAnalyze(result);
      setPreview(null); setPreviewPage(1);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error during validation.');
    } finally {
      setBusy(false);
    }
  }

  async function execute(): Promise<void> {
    if (!analyze) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/import-jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importId: analyze.importId, kind: 'procurement' }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error?.message ?? `Import failed to start (HTTP ${res.status}).`); return; }
      setJob(data.data as JobSummary);
      setStartedAt(Date.now());
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error during import.');
    } finally {
      setBusy(false);
    }
  }

  const summary = analyze?.summary;
  const rows = preview?.rows ?? [];
  const previewPages = Math.max(1, Math.ceil((preview?.filteredTotal ?? 0) / PREVIEW_PAGE_SIZE));
  const durationSec = useMemo(() => {
    if (!job?.completedAt || !startedAt) return null;
    return ((new Date(job.completedAt).getTime() - startedAt) / 1000).toFixed(1);
  }, [job, startedAt]);
  const throughput = useMemo(() => {
    if (!job || !durationSec || Number(durationSec) <= 0) return null;
    return Math.round(job.processedRows / Number(durationSec)).toLocaleString();
  }, [job, durationSec]);

  return (
    <div>
      <ol className="wizard-steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''}>
            <span className="step-num">{i + 1}</span> {label}
          </li>
        ))}
      </ol>

      {error ? <div className="error-box">{error}</div> : null}

      {step === 0 ? (
        <section>
          <h2>1 · Select default CPSE</h2>
          <p className="subtitle">
            Rows are resolved against the CPSE named in each row (a mapped CPSE column). The selection below is the
            default for rows whose CPSE cell is blank.
          </p>
          <table>
            <thead>
              <tr><th></th><th>Organization</th><th>Code</th><th>Status</th></tr>
            </thead>
            <tbody>
              {organizations.map((o) => (
                <tr key={o.id} className={orgCode === o.code ? 'selected-row' : ''}>
                  <td>
                    <input type="radio" name="org" checked={orgCode === o.code} onChange={() => setOrgCode(o.code)} aria-label={`Select ${o.code}`} />
                  </td>
                  <td>{o.name.replace(' (synthetic demo)', '')}</td>
                  <td className="mono">{o.code}</td>
                  <td><span className={`badge ${o.status === 'active' ? 'approved' : 'deferred'}`}>{o.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="decision-row">
            <button className="primary" disabled={!orgCode || busy} onClick={() => setStep(1)}>Next: Upload file</button>
          </div>
        </section>
      ) : null}

      {step === 1 ? (
        <section>
          <h2>2 · Upload procurement file</h2>
          <p className="subtitle">
            Accepted: CSV (recommended for large histories — chunked background import) and XLSX (safety-limited).
            Contents are treated as untrusted data — formulas and macros are never executed.
          </p>
          <div className="record-box" style={{ marginBottom: 12 }}>
            <dl>
              <dt>CSV</dt><dd>Recommended — chunked processing (limit {csvLimitMb} MB)</dd>
              <dt>XLSX</dt><dd>Supported for spreadsheet uploads — safety-limited (limit {xlsxLimitMb} MB)</dd>
            </dl>
          </div>
          <div
            className={`dropzone${dragOver ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); acceptFile(e.dataTransfer.files?.[0] ?? null); }}
          >
            <p>Drag a procurement file here, or</p>
            <button type="button" onClick={() => fileInput.current?.click()}>Browse files</button>
            <input ref={fileInput} type="file" accept=".csv,.xlsx,.xls" hidden onChange={(e) => acceptFile(e.target.files?.[0] ?? null)} />
          </div>
          {file ? (
            <div className="record-box" style={{ marginTop: 12 }}>
              <dl>
                <dt>Filename</dt><dd className="mono">{file.name}</dd>
                <dt>Size</dt><dd>{(file.size / 1024).toFixed(1)} KB</dd>
              </dl>
              <div className="decision-row">
                <button className="primary" disabled={busy} onClick={uploadAndAnalyze}>
                  {busy ? 'Reading and validating…' : 'Next: Inspect columns'}
                </button>
                <button disabled={busy} onClick={() => { setFile(null); setAnalyze(null); }}>Remove file</button>
              </div>
            </div>
          ) : null}
          <div className="decision-row">
            <button disabled={busy} onClick={() => setStep(0)}>← Back</button>
          </div>
        </section>
      ) : null}

      {step === 2 && analyze ? (
        <section>
          <h2>3 · Map columns</h2>
          <p className="subtitle">
            Detected columns in <span className="mono">{file?.name}</span>. Suggestions are proposals — confirm or change
            them. Required: CPSE, material code, supplier, purchase date, quantity, UOM.
          </p>
          <table>
            <thead>
              <tr><th>Detected column</th><th>Maps to</th><th>Sample value (row 2)</th></tr>
            </thead>
            <tbody>
              {analyze.headers.map((header) => {
                const currentTarget = Object.entries(mapping).find(([, h]) => h === header)?.[0] ?? '';
                const suggestion = analyze.suggestions.find((s) => s.header === header);
                const sample = analyze.previewRows.find((r) => r.values[header] !== undefined)?.values[header];
                return (
                  <tr key={header}>
                    <td className="mono">
                      {header}
                      {suggestion?.confident ? <span className="badge approved"> auto</span> : null}
                    </td>
                    <td>
                      <select
                        value={currentTarget}
                        onChange={(e) => {
                          const next = { ...mapping };
                          for (const k of Object.keys(next)) if (next[k] === header) next[k] = null;
                          if (e.target.value) next[e.target.value] = header;
                          setMapping(next);
                        }}
                      >
                        <option value="">— ignore column —</option>
                        {TARGET_FIELDS.map((f) => (
                          <option key={f.key} value={f.key}>{f.label}{f.required ? ' *' : ''}</option>
                        ))}
                      </select>
                    </td>
                    <td className="evidence-detail">{sample ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="decision-row">
            <button disabled={busy} onClick={() => setStep(1)}>← Back</button>
            <button
              className="primary"
              disabled={busy || !['organization', 'materialCode', 'supplier', 'purchaseDate', 'quantity', 'uom'].every((k) => mapping[k])}
              onClick={revalidate}
            >
              {busy ? 'Validating…' : 'Next: Validate rows'}
            </button>
          </div>
        </section>
      ) : null}

      {step === 3 && analyze ? (
        <section>
          <h2>4 · Validation results</h2>
          <p className="subtitle">
            Every row checked server-side against the material master, supplier registry and CMI mappings:{' '}
            {summary?.totalRows} data rows · {summary?.valid} valid · {summary?.warnings} warnings · {summary?.errors} errors.
          </p>
          <div className="stat-grid">
            <div className="stat"><div className="value">{summary?.valid ?? 0}</div><div className="label">Valid rows</div></div>
            <div className="stat"><div className="value">{summary?.warnings ?? 0}</div><div className="label">Warnings</div></div>
            <div className="stat"><div className="value">{summary?.errors ?? 0}</div><div className="label">Errors</div></div>
            <div className="stat"><div className="value">{summary?.duplicateInFile ?? 0}</div><div className="label">Duplicate lines</div></div>
          </div>
          {summary && summary.errors > 0 ? (
            <div className="section-label">Error categories</div>
          ) : null}
          {summary && summary.errors > 0 ? (
            <div className="filterbar" role="list" aria-label="Error categories">
              {ERROR_CATEGORIES.filter((c) => Number(summary[c.key]) > 0).map((c) => (
                <span key={c.key} role="listitem">
                  {c.label} <strong>{summary[c.key]}</strong>
                </span>
              ))}
            </div>
          ) : null}
          <div className="filterbar">
            <label htmlFor="proc-sev">Show</label>
            <select id="proc-sev" value={severityFilter} onChange={(e) => { setSeverityFilter(e.target.value as typeof severityFilter); setPreviewPage(1); }}>
              <option value="ALL">All rows</option>
              <option value="VALID">Valid</option>
              <option value="WARNING">Warnings</option>
              <option value="ERROR">Errors</option>
            </select>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Row</th><th>State</th><th>CPSE</th><th>Material</th><th>CMI</th><th>Supplier</th><th>Date</th><th className="num">Qty</th><th>UOM</th><th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const v = r.values;
                  const g = (h: string | null) => (h ? v[h] ?? '' : '');
                  const m = analyze.mapping;
                  return (
                    <tr key={r.rowNumber}>
                      <td className="num">{r.rowNumber}</td>
                      <td><span className={`badge ${SEVERITY_BADGE[r.severity]}`}>{r.severity}</span></td>
                      <td className="mono">{r.resolved?.orgCode ?? g(m.organization)}</td>
                      <td className="mono">{r.resolved?.materialCode ?? g(m.materialCode)}</td>
                      <td className="mono">{r.resolved?.cmiCode ?? (g(m.cmiCode) || '—')}</td>
                      <td>{g(m.supplier)}</td>
                      <td>{g(m.purchaseDate)}</td>
                      <td className="num">{g(m.quantity)}</td>
                      <td>{g(m.uom)}</td>
                      <td className="evidence-detail">
                        {r.problems.length === 0
                          ? r.resolved?.cmiCode
                            ? 'Valid · CMI-linked'
                            : 'Valid'
                          : r.problems.map((p, i) => <div key={i}>{p.message}</div>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button disabled={previewPage <= 1} onClick={() => setPreviewPage(previewPage - 1)}>← Previous</button>
            <span>Page {previewPage} of {previewPages} ({preview?.filteredTotal ?? 0} staged rows)</span>
            <button disabled={previewPage >= previewPages} onClick={() => setPreviewPage(previewPage + 1)}>Next →</button>
          </div>
          <p className="review-meta">
            The preview is bounded server-side — the browser never receives the full dataset. Error rows never execute;
            warnings (missing PO reference, in-file duplicate lines) execute with the import.
          </p>
          <div className="decision-row">
            <label>
              <input type="checkbox" checked={includeWarnings} onChange={(e) => setIncludeWarnings(e.target.checked)} /> Include
              warning rows (missing PO reference, duplicate lines) in the import
            </label>
          </div>
          <div className="decision-row">
            <button disabled={busy} onClick={() => setStep(2)}>← Back to mapping</button>
            <button className="primary" disabled={busy || !analyze.canExecute} onClick={() => setStep(4)}>
              Next: Review execution
            </button>
          </div>
        </section>
      ) : null}

      {step === 4 && analyze ? (
        <section>
          <h2>5 · Review execution</h2>
          <p className="subtitle">
            The import runs as a chunked background job — the page shows live progress and you can leave and return.
            Existing identical purchase lines are skipped; the job does not create materials, suppliers or common
            material identities.
          </p>
          <div className="record-box">
            <dl>
              <dt>File</dt><dd className="mono">{file?.name}</dd>
              <dt>Rows to execute</dt><dd>{(includeWarnings ? (summary?.valid ?? 0) + (summary?.warnings ?? 0) : summary?.valid) ?? 0} of {summary?.totalRows}</dd>
              <dt>Rows with errors</dt><dd>{summary?.errors} (never imported)</dd>
              <dt>Default CPSE</dt><dd className="mono">{orgCode}</dd>
            </dl>
          </div>
          <div className="decision-row">
            <button disabled={busy} onClick={() => setStep(3)}>← Back to validation</button>
            <button className="primary" disabled={busy} onClick={execute}>
              {busy ? 'Starting…' : 'Start import'}
            </button>
          </div>
        </section>
      ) : null}

      {step === 5 && job ? (
        <section>
          <h2>6 · Import result</h2>
          {job.status === 'COMPLETED' ? (
            <div className="info-box">
              <strong>Import completed.</strong>{' '}
              {job.successfulRows.toLocaleString()} rows imported · {job.failedRows.toLocaleString()} rejected ·{' '}
              {durationSec ? `${durationSec} s` : ''}{throughput ? ` · ${throughput} rows/sec` : ''}
            </div>
          ) : job.status === 'FAILED' ? (
            <div className="error-box">
              Import failed: {job.error ?? 'unknown error'}. Committed chunks are kept; the job can be retried.
            </div>
          ) : (
            <div className="record-box">
              <dl>
                <dt>Status</dt><dd>{job.status}</dd>
                <dt>Progress</dt><dd>{job.processedRows} / {job.totalRows} rows ({job.progressPct}%)</dd>
                <dt>Imported so far</dt><dd>{job.successfulRows}</dd>
                <dt>Chunk size</dt><dd>{job.chunkSize} rows</dd>
              </dl>
              <p className="subtitle">Processing runs in bounded chunks — progress updates automatically.</p>
            </div>
          )}
          <div className="decision-row">
            <a className="btn" href="/procurement">View procurement records</a>
            <a className="btn" href="/procurement/import">Import another file</a>
          </div>
        </section>
      ) : null}
    </div>
  );
}
