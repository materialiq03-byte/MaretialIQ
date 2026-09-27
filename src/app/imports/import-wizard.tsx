'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

/**
 * Data Import Center — multi-step workflow.
 *
 * Steps: Source → Upload → Map Columns → Validate → Review → Done
 * All parsing/validation happens server-side via /api/imports/analyze (bounded
 * response: summary + ≤100 preview rows + bounded diagnostics — the full row
 * set NEVER reaches React state). The validation table is server-paginated
 * via /api/imports/:id/preview. Execution is a chunked background job
 * (/api/import-jobs) polled for live, committed-work progress; a browser
 * refresh simply re-fetches the job status from the server.
 */

const STEPS = ['Source', 'Upload', 'Map columns', 'Validate', 'Review', 'Done'] as const;

interface Suggestion {
  header: string;
  target: string | null;
  confident: boolean;
}

interface RowProblem {
  rule: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
  suggestion?: string;
}

interface PreviewRow {
  rowNumber: number;
  values: Record<string, string>;
  severity: 'VALID' | 'WARNING' | 'ERROR';
  problems: RowProblem[];
}

interface BoundedAnalyzeResponse {
  importId: number;
  headers: string[];
  mapping: Record<string, string | null>;
  suggestions: Suggestion[];
  mappingUsable: boolean;
  parseWarnings: string[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  /** UI-9 fix: ERROR rows whose ONLY errors are duplicate rules (skippable/updatable). */
  duplicateOnlyRows?: number;
  /** UI-9 fix: ERROR rows with genuine non-duplicate errors. */
  genuineInvalidRows?: number;
  previewRows: PreviewRow[];
  validationErrors: Array<{ rowNumber: number; rule: string; message: string }>;
  canExecute: boolean;
}

interface PreviewPageResponse {
  importId: number;
  page: number;
  pageSize: number;
  totalRows: number;
  filteredTotal: number;
  rows: PreviewRow[];
}

interface ImportJobSummary {
  jobId: string;
  dataImportId: number;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  filename: string;
  fileType: string;
  totalRows: number;
  processedRows: number;
  successfulRows: number;
  failedRows: number;
  chunkSize: number;
  progressPct: number;
  currentChunk: number;
  totalChunks: number;
  error: string | null;
}

interface Organization {
  id: number;
  code: string;
  name: string;
  status: string;
}

const TARGET_FIELDS: Array<{ key: string; label: string; required?: boolean }> = [
  { key: 'originalCode', label: 'material_code', required: true },
  { key: 'originalDescription', label: 'description', required: true },
  { key: 'category', label: 'category' },
  { key: 'subcategory', label: 'subcategory' },
  { key: 'manufacturer', label: 'manufacturer' },
  { key: 'model', label: 'model' },
  { key: 'partNumber', label: 'part_number' },
  { key: 'uom', label: 'uom' },
];

/** Page size for the SERVER-side preview requests (server caps at 100). */
const PREVIEW_PAGE_SIZE = 50;

export default function ImportWizard({ organizations, csvLimitMb = 50, xlsxLimitMb = 5 }: { organizations: Organization[]; csvLimitMb?: number; xlsxLimitMb?: number }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1 — Source
  const [orgCode, setOrgCode] = useState<string | null>(null);
  // Step 2 — Upload
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Step 3 — Mapping (bounded analysis only — never the full row set)
  const [analyze, setAnalyze] = useState<BoundedAnalyzeResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  // Step 4 — server-paginated validation preview
  const [severityFilter, setSeverityFilter] = useState<'ALL' | 'ERROR' | 'WARNING' | 'VALID'>('ALL');
  const [rowSearch, setRowSearch] = useState('');
  const [preview, setPreview] = useState<PreviewPageResponse | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [selectedProblem, setSelectedProblem] = useState<PreviewRow | null>(null);
  const [includeWarnings, setIncludeWarnings] = useState(true);
  // Step 6 — background job + live progress
  const [job, setJob] = useState<ImportJobSummary | null>(null);

  const summary = analyze;

  /* UI-9 fix — Step-5 eligibility (presentation layer only).
   *
   * The analyzer classifies `duplicate_in_database` rows as ERROR severity,
   * but the execution layer includes ERROR rows whose errors are ALL
   * duplicate rules: strategy `skip` skips them (zero new materials,
   * originals never overwritten); `update` refreshes optional fields only.
   * The server now reports duplicateOnlyRows / genuineInvalidRows from the
   * actual per-row rules. Fallback for stale responses: derive nothing and
   * treat all ERROR rows as genuine (conservative, old behavior).
   */
  const dupOnly = Math.max(0, summary?.duplicateOnlyRows ?? 0);
  const genuineInvalid = summary ? Math.max(0, (summary.genuineInvalidRows ?? summary.invalidRows) ) : 0;
  const genuineWarningRows = summary
    ? Math.max(0, summary.totalRows - summary.validRows - summary.invalidRows - summary.duplicateRows)
    : 0;

  const importableCount = useMemo(() => {
    if (!summary) return 0;
    // Rows execution will actually write or refresh: valid (+ warnings when
    // opted-in). Duplicate-only rows are NOT counted as imported — they are
    // skipped (or updated) and reported separately.
    return summary.validRows + (includeWarnings ? genuineWarningRows : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, includeWarnings]);

  const canImport = Boolean(summary && summary.mappingUsable && (importableCount > 0 || dupOnly > 0));

  const reset = useCallback(() => {
    setStep(0);
    setError(null);
    setOrgCode(null);
    setFile(null);
    setAnalyze(null);
    setMapping({});
    setJob(null);
    setSelectedProblem(null);
    setSeverityFilter('ALL');
    setRowSearch('');
    setPreview(null);
    setPreviewPage(1);
    setIncludeWarnings(true);
  }, []);

  /** Fetch one server-side preview page for the current filters. */
  const loadPreview = useCallback(
    async (importId: number, page: number, severity: string, q: string) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PREVIEW_PAGE_SIZE), severity });
      if (q.trim()) params.set('q', q.trim());
      const res = await fetch(`/api/imports/${importId}/preview?${params.toString()}`);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.data) setPreview(data.data as PreviewPageResponse);
    },
    [],
  );

  // Re-fetch the preview page whenever filters/page change (step 4 only).
  useEffect(() => {
    if (step !== 3 || !analyze) return;
    void loadPreview(analyze.importId, previewPage, severityFilter, rowSearch);
  }, [step, analyze, previewPage, severityFilter, rowSearch, loadPreview]);

  async function uploadAndAnalyze(): Promise<void> {
    if (!file || !orgCode) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('organizationCode', orgCode);
      const res = await fetch('/api/imports/analyze', { method: 'POST', body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? `Analysis failed (HTTP ${res.status}).`);
        return;
      }
      applyAnalysis(data.data as BoundedAnalyzeResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error during upload.');
    } finally {
      setBusy(false);
    }
  }

  function applyAnalysis(data: BoundedAnalyzeResponse, overrideMapping?: Record<string, string | null>) {
    setAnalyze(data);
    setMapping(overrideMapping ?? data.mapping);
    setPreview(null);
    setPreviewPage(1);
    setSelectedProblem(null);
    setStep(data.mappingUsable ? 3 : 2);
  }

  async function revalidateWithMapping(): Promise<void> {
    if (!file || !orgCode) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('organizationCode', orgCode);
      form.append('mapping', JSON.stringify(mapping));
      const res = await fetch('/api/imports/analyze', { method: 'POST', body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? `Validation failed (HTTP ${res.status}).`);
        return;
      }
      applyAnalysis(data.data as BoundedAnalyzeResponse, mapping);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error during validation.');
    } finally {
      setBusy(false);
    }
  }

  async function execute(): Promise<void> {
    if (!analyze) return;
    setBusy(true);
    setError(null);
    try {
      // Chunked background job — returns 202 with the job summary immediately.
      const res = await fetch('/api/import-jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importId: analyze.importId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? `Import failed to start (HTTP ${res.status}).`);
        return;
      }
      setJob(data.data as ImportJobSummary);
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error during import.');
    } finally {
      setBusy(false);
    }
  }

  // Live progress polling — server is the source of truth; a refresh of the
  // page would simply re-enter this state from the job listing/status API.
  useEffect(() => {
    if (step !== 5 || !job) return;
    if (job.status === 'COMPLETED' || job.status === 'FAILED') return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/import-jobs/${job.jobId}`);
        const data = await res.json().catch(() => null);
        if (res.ok && data?.data) setJob(data.data as ImportJobSummary);
      } catch {
        /* transient network error — next tick retries */
      }
    }, 1000);
    return () => clearInterval(t);
  }, [step, job]);

  function acceptFile(f: File | null): void {
    setError(null);
    if (!f) return;
    const lower = f.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
      setError('Unsupported file type — choose a .csv or .xlsx file.');
      return;
    }
    if (f.size === 0) {
      setError('The selected file is empty.');
      return;
    }
    // Client-side pre-check mirrors the server's per-format cap (the server
    // limit is authoritative; this only avoids a doomed upload).
    const isCsv = lower.endsWith('.csv');
    const limitMb = isCsv ? csvLimitMb : xlsxLimitMb;
    if (f.size > limitMb * 1024 * 1024) {
      setError(
        isCsv
          ? `CSV file exceeds the configured upload limit (${limitMb} MB). For larger enterprise ingestion, use the supported enterprise ingestion pipeline.`
          : `XLSX file exceeds the ${limitMb} MB safety limit. XLSX parsing is memory-sensitive — export the material master as CSV for large datasets.`
      );
      return;
    }
    setFile(f);
    setAnalyze(null); // new file invalidates any previous analysis
  }

  const rows = preview?.rows ?? [];
  const filteredTotal = preview?.filteredTotal ?? 0;
  const previewPages = Math.max(1, Math.ceil(filteredTotal / PREVIEW_PAGE_SIZE));
  const codeHeader = mapping.originalCode ?? '';
  const descHeader = mapping.originalDescription ?? '';
  const sampleRow = analyze?.previewRows.find((r) => Object.keys(r.values).length > 0);

  return (
    <div>
      {/* Step indicator */}
      <ol className="wizard-steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''}>
            <span className="step-num">{i + 1}</span> {label}
          </li>
        ))}
      </ol>

      {error ? <div className="error-box">{error}</div> : null}

      {/* STEP 1 — Source */}
      {step === 0 ? (
        <section>
          <h2>1 · Select source CPSE</h2>
          <p className="subtitle">Every imported row belongs to exactly one organization. An import cannot start without it.</p>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Organization</th>
                <th>Code</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {organizations.map((o) => (
                <tr key={o.id} className={orgCode === o.code ? 'selected-row' : ''}>
                  <td>
                    <input
                      type="radio"
                      name="org"
                      checked={orgCode === o.code}
                      onChange={() => setOrgCode(o.code)}
                      aria-label={`Select ${o.code}`}
                    />
                  </td>
                  <td>{o.name.replace(' (synthetic demo)', '')}</td>
                  <td className="mono">{o.code}</td>
                  <td><span className={`badge ${o.status === 'active' ? 'approved' : 'deferred'}`}>{o.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {organizations.length === 0 ? (
            <div className="empty-state">No CPSE organizations exist yet. Create one before importing.</div>
          ) : null}
          <div className="decision-row">
            <button className="primary" disabled={!orgCode || busy} onClick={() => setStep(1)}>
              Next: Upload file
            </button>
          </div>
        </section>
      ) : null}

      {/* STEP 2 — Upload */}
      {step === 1 ? (
        <section>
          <h2>2 · Upload file</h2>
          <p className="subtitle">
            Accepted: CSV and XLSX. <strong>CSV is recommended for large enterprise material masters</strong> and is
            processed through bounded, chunked import jobs. XLSX remains subject to a safety limit. Contents are
            treated as untrusted data — formulas and macros are never executed.
          </p>
          <div className="record-box" style={{ marginBottom: 12 }}>
            <dl>
              <dt>CSV</dt>
              <dd>Recommended for large datasets — chunked processing (limit {csvLimitMb} MB)</dd>
              <dt>XLSX</dt>
              <dd>Supported for spreadsheet uploads — safety-limited (limit {xlsxLimitMb} MB)</dd>
            </dl>
            <p className="subtitle" style={{ marginTop: 8 }}>
              Large enterprise datasets are processed through import jobs rather than loading the entire material
              master into the browser. Progress is tracked on the server and survives a page refresh.
            </p>
          </div>
          <div
            className={`dropzone${dragOver ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              acceptFile(e.dataTransfer.files?.[0] ?? null);
            }}
          >
            <p>Drag a spreadsheet here, or</p>
            <button type="button" onClick={() => fileInput.current?.click()}>
              Browse files
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.xlsx,.xls"
              hidden
              onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
            />
          </div>
          {file ? (
            <div className="record-box" style={{ marginTop: 12 }}>
              <dl>
                <dt>Filename</dt>
                <dd className="mono">{file.name}</dd>
                <dt>Type</dt>
                <dd>
                  {file.name.toLowerCase().endsWith('.csv')
                    ? 'CSV — recommended for large datasets; processed in bounded chunks'
                    : 'Excel — supported for spreadsheet uploads; safety-limited'}
                </dd>
                <dt>Size</dt>
                <dd>{(file.size / 1024).toFixed(1)} KB</dd>
              </dl>
              <div className="decision-row">
                <button className="primary" disabled={busy} onClick={uploadAndAnalyze}>
                  {busy ? 'Reading and validating…' : 'Next: Inspect columns'}
                </button>
                <button disabled={busy} onClick={() => { setFile(null); setAnalyze(null); }}>
                  Remove file
                </button>
              </div>
            </div>
          ) : null}
          <div className="decision-row">
            <button disabled={busy} onClick={() => setStep(0)}>← Back</button>
          </div>
        </section>
      ) : null}

      {/* STEP 3 — Map columns */}
      {step === 2 && analyze ? (
        <section>
          <h2>3 · Map columns</h2>
          <p className="subtitle">
            Detected columns in <span className="mono">{file?.name}</span>. Confirm the mapping — ambiguous headers are
            left unmapped on purpose. Required: material_code, description.
          </p>
          {analyze.parseWarnings.length > 0 ? (
            <div className="info-box">
              {analyze.parseWarnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          ) : null}
          <table>
            <thead>
              <tr>
                <th>Detected column</th>
                <th>Maps to</th>
                <th>Sample value (row 2)</th>
              </tr>
            </thead>
            <tbody>
              {analyze.headers.map((header) => {
                const currentTarget = Object.entries(mapping).find(([, h]) => h === header)?.[0] ?? '';
                const suggestion = analyze.suggestions.find((s) => s.header === header);
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
                          <option key={f.key} value={f.key}>
                            {f.label}
                            {f.required ? ' *' : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="evidence-detail">
                      {sampleRow?.values[header] ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="decision-row">
            <button disabled={busy} onClick={() => setStep(1)}>← Back</button>
            <button
              className="primary"
              disabled={busy || !mapping.originalCode || !mapping.originalDescription}
              onClick={revalidateWithMapping}
            >
              {busy ? 'Validating…' : 'Next: Validate rows'}
            </button>
          </div>
          {!mapping.originalCode || !mapping.originalDescription ? (
            <div className="info-box">material_code and description must be mapped before validation can run.</div>
          ) : null}
        </section>
      ) : null}

      {/* STEP 4 — Validate (server-paginated) */}
      {step === 3 && analyze ? (
        <section>
          <h2>4 · Validation results</h2>
          <p className="subtitle">
            Every row checked server-side. {summary?.totalRows} data rows: {summary?.validRows} valid ·{' '}
            {Math.max(0, summary!.totalRows - summary!.validRows - summary!.invalidRows)} with warnings ·{' '}
            {summary?.invalidRows} with errors · {summary?.duplicateRows} duplicates.
          </p>
          <div className="stat-grid">
            <div className="stat">
              <div className="value">{summary?.validRows ?? 0}</div>
              <div className="label">✓ Valid</div>
            </div>
            <div className="stat">
              <div className="value">{Math.max(0, (summary?.totalRows ?? 0) - (summary?.validRows ?? 0) - (summary?.invalidRows ?? 0))}</div>
              <div className="label">⚠ Warnings</div>
            </div>
            <div className="stat">
              <div className="value">{summary?.invalidRows ?? 0}</div>
              <div className="label">✕ Errors</div>
            </div>
            <div className="stat">
              <div className="value">{summary?.duplicateRows ?? 0}</div>
              <div className="label">Duplicates</div>
            </div>
          </div>

          <form className="filterbar" onSubmit={(e) => e.preventDefault()}>
            <label className="fld">
              Show
              <select value={severityFilter} onChange={(e) => { setSeverityFilter(e.target.value as never); setPreviewPage(1); }}>
                <option value="ALL">All rows</option>
                <option value="ERROR">Errors only</option>
                <option value="WARNING">Warnings only</option>
                <option value="VALID">Valid only</option>
              </select>
            </label>
            <label className="fld">
              Search
              <input type="text" value={rowSearch} onChange={(e) => { setRowSearch(e.target.value); setPreviewPage(1); }} placeholder="row number or value…" />
            </label>
          </form>

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
              {rows.map((r) => {
                const code = codeHeader ? r.values[codeHeader] : '';
                const desc = descHeader ? r.values[descHeader] : '';
                const first = r.problems[0];
                return (
                  <tr
                    key={r.rowNumber}
                    onClick={() => r.problems.length && setSelectedProblem(r)}
                    style={{ cursor: r.problems.length ? 'pointer' : 'default' }}
                  >
                    <td className="num">{r.rowNumber}</td>
                    <td className="mono">{code || '—'}</td>
                    <td>{desc || '—'}</td>
                    <td className="evidence-detail">
                      {first ? `${first.message}${r.problems.length > 1 ? ` (+${r.problems.length - 1} more)` : ''}` : '—'}
                    </td>
                    <td>
                      <span className={`badge ${r.severity === 'VALID' ? 'approved' : r.severity === 'WARNING' ? 'pending' : 'rejected'}`}>
                        {r.severity}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="pagination">
            Showing {filteredTotal === 0 ? 0 : (previewPage - 1) * PREVIEW_PAGE_SIZE + 1}–
            {Math.min(filteredTotal, previewPage * PREVIEW_PAGE_SIZE)} of {filteredTotal}
            <button disabled={previewPage <= 1} onClick={() => setPreviewPage((p) => Math.max(1, p - 1))}>← Prev</button>
            <button disabled={previewPage >= previewPages} onClick={() => setPreviewPage((p) => p + 1)}>Next →</button>
          </div>

          {selectedProblem ? (
            <div className="proposal-card">
              <div className="card-head">
                <strong>Row {selectedProblem.rowNumber} — details</strong>
                <button onClick={() => setSelectedProblem(null)}>Close</button>
              </div>
              <div className="card-body">
                <table>
                  <tbody>
                    {Object.entries(selectedProblem.values).map(([k, v]) => (
                      <tr key={k}>
                        <td className="mono">{k}</td>
                        <td>{v || '(empty)'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {selectedProblem.problems.map((p) => (
                  <div key={p.rule} className={`info-box`}>
                    <strong>{p.severity} · {p.rule}</strong>
                    <div>{p.message}</div>
                    {p.suggestion ? <div className="evidence-detail">Action: {p.suggestion}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="decision-row">
            <button disabled={busy} onClick={() => setStep(2)}>← Back to mapping</button>
            <a className="btn" href={`/api/imports/${analyze.importId}/errors`}>
              Download error report (CSV)
            </a>
            <button className="primary" disabled={busy} onClick={() => setStep(4)}>
              Next: Review import
            </button>
          </div>
        </section>
      ) : null}

      {/* STEP 5 — Review & confirm */}
      {step === 4 && analyze ? (
        <section>
          <h2>5 · Review before import</h2>
          <p className="subtitle">Exactly this will be written to the material master. Nothing else.</p>
          <div className="record-box">
            <dl>
              <dt>Source CPSE</dt>
              <dd className="mono">{orgCode}</dd>
              <dt>Filename</dt>
              <dd className="mono">{file?.name}</dd>
              <dt>Total data rows</dt>
              <dd>{summary?.totalRows}</dd>
              <dt>Valid rows (new)</dt>
              <dd>{summary?.validRows}</dd>
              <dt>Rows with warnings</dt>
              <dd>{genuineWarningRows}</dd>
              <dt>Invalid rows (excluded)</dt>
              <dd>{genuineInvalid}</dd>
              <dt>Duplicate rows</dt>
              <dd>{summary?.duplicateRows}</dd>
            </dl>
          </div>

          {/* UI-9 fix: genuine source errors keep the hard error treatment;
              duplicate-only rows are NOT source errors — they are handled by
              the duplicate strategy (skip / update), originals never changed. */}
          {genuineInvalid > 0 ? (
            <div className="error-box">
              {genuineInvalid} row(s) with errors will NOT be imported. Fix them in the source file and re-validate, or
              continue without them. Invalid rows never enter the material master.
            </div>
          ) : null}
          {dupOnly > 0 ? (
            <div className="info-box">
              {dupOnly} row(s) already exist for this CPSE and will be handled according to the selected duplicate
              strategy: skipped (importing {importableCount} new row{importableCount === 1 ? '' : 's'}), or updated
              (refreshing optional fields only). Existing material codes and descriptions are never overwritten.
            </div>
          ) : dupOnly === 0 && (summary?.duplicateRows ?? 0) > 0 ? (
            <div className="info-box">
              {summary?.duplicateRows} duplicate material code(s) detected. Existing codes are skipped — original
              codes and descriptions are never overwritten.
            </div>
          ) : null}

          <label className="fld" style={{ margin: '12px 0' }}>
            <input type="checkbox" checked={includeWarnings} onChange={(e) => setIncludeWarnings(e.target.checked)} />{' '}
            Also import the rows that carry warnings
          </label>

          <div className="section-label">Rows to be imported</div>
          <div className="record-box" style={{ fontSize: 18, fontWeight: 700, padding: '12px 14px' }}>
            {importableCount} row{importableCount === 1 ? '' : 's'}
          </div>
          {dupOnly > 0 ? (
            <div className="record-box" style={{ padding: '10px 14px' }}>
              <dl style={{ margin: 0 }}>
                <dt>Duplicates to skip (or update)</dt>
                <dd>{dupOnly}</dd>
              </dl>
            </div>
          ) : null}

          <div className="decision-row">
            <button disabled={busy} onClick={() => setStep(3)}>← Back</button>
            <button disabled={busy} onClick={reset}>Cancel import</button>
            <button
              className="primary"
              disabled={busy || !canImport}
              onClick={execute}
              title={canImport ? undefined : 'Nothing to import — all rows are duplicates handled by the strategy or invalid'}
            >
              {busy ? 'Starting…' : `Import ${importableCount} valid row${importableCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </section>
      ) : null}

      {/* STEP 6 — Done (chunked job progress) */}
      {step === 5 && job ? (
        <section>
          <h2>6 · Import {job.status === 'COMPLETED' ? 'complete' : 'in progress'}</h2>
          <div className="record-box">
            <dl>
              <dt>Status</dt>
              <dd><span className={`badge ${job.status === 'COMPLETED' ? 'approved' : job.status === 'FAILED' ? 'rejected' : 'pending'}`}>{job.status}</span></dd>
              <dt>Job</dt>
              <dd className="mono">{job.jobId}</dd>
            </dl>
          </div>

          {job.status === 'RUNNING' || job.status === 'QUEUED' ? (
            <div className="record-box" aria-live="polite">
              <div className="section-label">Progress (committed rows only)</div>
              <div style={{ background: 'var(--border, #e5e7eb)', borderRadius: 4, height: 10, overflow: 'hidden' }}>
                <div style={{ background: 'var(--accent, #1d4ed8)', width: `${job.progressPct}%`, height: '100%', transition: 'width .4s ease' }} />
              </div>
              <p style={{ margin: '8px 0 0' }}>
                <strong>{job.progressPct}%</strong> — {job.processedRows.toLocaleString()} / {job.totalRows.toLocaleString()} rows ·
                chunk {Math.min(job.totalChunks, job.currentChunk + 1)} / {job.totalChunks || 1} · {job.successfulRows.toLocaleString()} imported
              </p>
            </div>
          ) : null}

          {job.status === 'COMPLETED' ? (
            <>
              <div className="record-box">
                <dl>
                  <dt>Rows imported</dt>
                  <dd>{job.successfulRows}</dd>
                  <dt>Rows processed</dt>
                  <dd>{job.processedRows}</dd>
                  <dt>Chunk size</dt>
                  <dd>{job.chunkSize}</dd>
                  <dt>Chunks</dt>
                  <dd>{job.totalChunks}</dd>
                </dl>
              </div>
              <div className="info-box">
                Every imported material was normalized, classified and had technical attributes extracted. Review its
                processing status on the material pages.
              </div>
            </>
          ) : null}

          {job.status === 'FAILED' ? (
            <div className="error-box">
              Import failed at chunk {Math.min(job.totalChunks, job.currentChunk + 1)}: {job.error ?? 'unknown error'}. Already
              committed chunks are preserved; the job can be retried safely without creating duplicates.
            </div>
          ) : null}

          <div className="decision-row">
            <Link className="btn" href={`/imports/${analyze?.importId ?? job.dataImportId}`}>
              View import record #{analyze?.importId ?? job.dataImportId}
            </Link>
            <Link className="btn" href="/materials">Open material catalog</Link>
            <button onClick={reset}>Import another file</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
