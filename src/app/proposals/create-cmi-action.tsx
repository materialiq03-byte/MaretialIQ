'use client';

import { useState } from 'react';

export interface CreateCmiSpec {
  matchId: number;
  suggestedCode: string;
  suggestedName: string;
  category: string;
  source: { org: string; code: string };
  candidate: { org: string; code: string };
}

export interface CmiCreatedResult {
  cmiId: number;
  mappingsCreated: number;
  code?: string;
  category?: string;
}

/**
 * Step 11 - explicit, human-triggered Common Material Identity creation.
 *
 * Rendered ONLY for approved relationships whose pair is not yet covered by an
 * active CMI (server-derived state - never mounted for pending/rejected/
 * deferred or already-created pairs). Nothing is created until the reviewer
 * explicitly confirms; the confirm dialog states exactly what will be created
 * (identity + 2 mappings + audit records). Business rules (approval guard,
 * one-CMI-per-material, atomicity) remain in the service layer; the UI merely
 * prompts and reports.
 */
export default function CreateCmiAction({ spec, canCreate }: { spec: CreateCmiSpec; canCreate: boolean }) {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'done'>('idle');
  const [code, setCode] = useState(spec.suggestedCode);
  const [name, setName] = useState(spec.suggestedName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CmiCreatedResult | null>(null);

  async function createCmi() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/common-materials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId: spec.matchId, code: code.trim(), name: name.trim(), category: spec.category }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error?.message ?? `Request failed with status ${res.status}`);
        return;
      }
      setResult(data.data as CmiCreatedResult);
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? `Network error: ${err.message}` : 'Network error - nothing was created.');
    } finally {
      setSubmitting(false);
    }
  }

  if (stage === 'done' && result) {
    return (
      <div className="decision-note cmi-result">
        <div className="section-label">CMI CREATED</div>
        <p className="evidence-detail">
          <strong className="mono">{result.code ?? spec.suggestedCode}</strong>
          {' '}- {result.mappingsCreated} material mapping{result.mappingsCreated === 1 ? '' : 's'} created -
          category {spec.category} - source: approved relationship #{spec.matchId}.
        </p>
        <p className="evidence-detail">
          Registry: <a href="/cross-reference">Common Materials</a> -
          audit: <a href="/audit">Audit Trail</a>. On the next matching run this pair is recognised as
          already harmonized (CMI short-circuit, currently off by default).
        </p>
      </div>
    );
  }

  if (stage !== 'confirm') {
    return (
      <div className="decision-row">
        <button className="primary" disabled={!canCreate || submitting} onClick={() => setStage('confirm')}>
          Create CMI
        </button>
        {!canCreate ? (
          <span className="evidence-detail">Requires the Create Common Identity permission.</span>
        ) : null}
        {error ? <div className="error-box">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className="decision-note cmi-confirm">
      <div className="section-label">CREATE COMMON MATERIAL IDENTITY</div>
      <p className="evidence-detail">
        This will group <strong>{spec.source.org} {spec.source.code}</strong> ↔{' '}
        <strong>{spec.candidate.org} {spec.candidate.code}</strong> into one prototype common material identity.
      </p>
      <p className="evidence-detail">The following will be created:</p>
      <ul className="evidence-list">
        <li>Common Material Identity (prototype identifier - not an official national material code)</li>
        <li>2 material mappings (one per CPSE record; legacy codes preserved)</li>
        <li>Audit records (identity creation + mappings, attributed to you)</li>
      </ul>
      <label className="fld">
        CMI code
        <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} maxLength={30} />
      </label>
      <label className="fld">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
      </label>
      <div className="decision-row">
        <button className="primary" disabled={submitting || !code.trim() || !name.trim()} onClick={createCmi}>
          {submitting ? 'Creating…' : 'Create CMI'}
        </button>
        <button disabled={submitting} onClick={() => setStage('idle')}>
          Cancel
        </button>
      </div>
      {error ? <div className="error-box">{error}</div> : null}
    </div>
  );
}
