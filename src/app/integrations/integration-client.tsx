'use client';

/**
 * Step 22 — Integration import flow (client island).
 *
 * Select source profile → upload feed → analyze (read-only preview + quality
 * report from the adapter) → execute through the EXISTING import pipeline.
 * All authorization stays server-side; this component only renders what the
 * APIs return and never invents values.
 */
import { useRef, useState } from 'react';
import type { FeedAnalysis } from '@/lib/integrations/parse-and-validate';

interface SourceOption {
  id: string;
  cpse: string;
  label: string;
  version: string;
  description: string;
  fieldMapping: Array<{ sourceField: string; canonicalField: string }>;
}

interface ExecuteResult {
  importId: number;
  jobId: string;
  adapterVersion: string;
  cpse: string;
  canonicalRecordCount: number;
  job: { jobId: string; status: string; totalRows: number };
}

export default function IntegrationClient({ sources }: { sources: SourceOption[] }) {
  const [selected, setSelected] = useState<string>(sources[0]?.id ?? '');
  const [analysis, setAnalysis] = useState<FeedAnalysis | null>(null);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const source = sources.find((s) => s.id === selected) ?? null;

  async function handleAnalyze() {
    setError(null);
    setResult(null);
    setAnalysis(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a source feed file first (.csv).');
      return;
    }
    const form = new FormData();
    form.set('file', file);
    form.set('sourceSystem', selected);
    const res = await fetch('/api/integrations/analyze', { method: 'POST', body: form });
    const body = (await res.json()) as { data?: FeedAnalysis; error?: { message: string } };
    if (!res.ok || !body.data) {
      setError(body.error?.message ?? 'Analysis failed.');
      return;
    }
    setAnalysis(body.data);
  }

  async function handleExecute() {
    setError(null);
    setExecuting(true);
    try {
      const file = fileRef.current?.files?.[0];
      if (!file) {
        setError('Choose a source feed file first (.csv).');
        return;
      }
      const form = new FormData();
      form.set('file', file);
      form.set('sourceSystem', selected);
      const res = await fetch('/api/integrations/execute', { method: 'POST', body: form });
      const body = (await res.json()) as { data?: ExecuteResult; error?: { message: string } };
      if (!res.ok || !body.data) {
        setError(body.error?.message ?? 'Execution failed.');
        return;
      }
      setResult(body.data);
      setAnalysis(null);
      if (fileRef.current) fileRef.current.value = '';
    } finally {
      setExecuting(false);
    }
  }

  return (
    <div className="detail-card">
      <h2>Import from source system</h2>
      <p className="note">
        The adapter validates and translates the source feed into MaterialIQ&apos;s canonical contract, then the
        existing Import Center runs the import — chunked, audited, and reviewed by the existing matching pipeline.
      </p>

      {/* UI-7: single-column on narrow viewports so the file input never clips. */}
      <div className="hq7-sourceform hq-kpis" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div>
          <label className="hq-kpi-label" htmlFor="source-profile">
            Source profile
          </label>
          <select
            id="source-profile"
            className="mono"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setAnalysis(null);
              setResult(null);
              setError(null);
            }}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.cpse} — {s.version}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="hq-kpi-label" htmlFor="source-file">
            Source feed file (.csv)
          </label>
          <input id="source-file" type="file" accept=".csv,.xlsx,.xls" ref={fileRef} />
        </div>
      </div>

      {source && (
        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Source field</th>
                <th>Canonical field</th>
              </tr>
            </thead>
            <tbody>
              {source.fieldMapping.map((m) => (
                <tr key={m.sourceField}>
                  <td className="mono">{m.sourceField}</td>
                  <td className="mono">{m.canonicalField}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="btn" onClick={handleAnalyze} disabled={executing}>
          Analyze feed
        </button>
        <button type="button" className="btn" onClick={handleExecute} disabled={executing}>
          {executing ? 'Starting…' : 'Validate & import'}
        </button>
      </div>

      {error && (
        <div className="error-box" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}

      {analysis && (
        <div style={{ marginTop: 18 }}>
          <h3>
            Source quality — {analysis.cpse} ({analysis.adapterVersion})
          </h3>
          <div className="hq-kpis">
            <div className="hq-kpi">
              <span className="hq-kpi-value num">{analysis.rowsReceived}</span>
              <span className="hq-kpi-label">Rows received</span>
            </div>
            <div className="hq-kpi">
              <span className="hq-kpi-value num">{analysis.rowsValid}</span>
              <span className="hq-kpi-label">Valid</span>
            </div>
            <div className="hq-kpi">
              <span className="hq-kpi-value num">{analysis.rowsWithWarnings}</span>
              <span className="hq-kpi-label">Warnings</span>
            </div>
            <div className="hq-kpi">
              <span className="hq-kpi-value num">{analysis.rowsWithError}</span>
              <span className="hq-kpi-label">Errors</span>
            </div>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Canonical field</th>
                  <th className="num">Populated</th>
                  <th className="num">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {analysis.fieldCoverage.map((c) => (
                  <tr key={c.field}>
                    <td className="mono">{c.field}</td>
                    <td className="num">
                      {c.populated}/{c.total}
                    </td>
                    <td className="num">{c.coveragePct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {analysis.canonicalPreview.length > 0 && (
            <>
              <h3>Canonical preview (first {analysis.canonicalPreview.length})</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>CPSE</th>
                      <th>Source record</th>
                      <th>Description (verbatim)</th>
                      <th>Category</th>
                      <th>UOM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.canonicalPreview.slice(0, 10).map((r) => (
                      <tr key={r.sourceRowNumber}>
                        <td className="num">{r.sourceRowNumber}</td>
                        <td>{r.cpse}</td>
                        <td className="mono">{r.sourceRecordId}</td>
                        <td>{r.sourceDescription}</td>
                        <td>{r.category ?? '—'}</td>
                        <td className="mono">{r.uom ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {analysis.diagnostics.length > 0 && (
            <>
              <h3>Diagnostics ({analysis.diagnostics.length})</h3>
              <ul className="note">
                {analysis.diagnostics.slice(0, 10).map((d, i) => (
                  <li key={`${d.row}-${d.field}-${i}`}>
                    <span className={`badge ${d.severity === 'ERROR' ? 'rejected' : 'pending'}`}>{d.code}</span>{' '}
                    row {d.row}, {d.field}: {d.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {result && (
        <div className="detail-card" style={{ marginTop: 18 }}>
          <h3>Integration started</h3>
          <p className="note">
            {result.canonicalRecordCount} canonical rows handed to the existing import pipeline (job{' '}
            <span className="mono">{result.job.jobId}</span>, {result.job.status.toLowerCase()}).
          </p>
          <a className="btn" href={`/imports/${result.importId}`}>
            Open import #{result.importId}
          </a>{' '}
          <a className="btn" href="/imports">
            Open Import Center
          </a>
        </div>
      )}
    </div>
  );
}
