'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Step 18 - governance controls for MATERIAL-SPECIFIC (DOMAIN_SPECIFIC) UOM
 * rules. The server-rendered page stays read-only; this island performs the
 * two governed mutations (propose / transition) via the authorized API routes
 * and refreshes the server data afterwards. All actions require
 * MANAGE_UOM_RULES server-side; the UI only reflects state:
 * PENDING -> Approve/Reject, APPROVED -> Disable, DISABLED -> Re-enable.
 */

interface CmiOption {
  id: number;
  code: string;
  name: string;
}

const CANONICAL_UOMS = ['EA', 'G', 'ML', 'MM'];

export function UomGovernanceActions({
  cmiOptions,
  canManage,
}: {
  cmiOptions: CmiOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cmiId, setCmiId] = useState('');
  const [fromUom, setFromUom] = useState('');
  const [toUom, setToUom] = useState('EA');
  const [factor, setFactor] = useState('');
  const [reason, setReason] = useState('');

  if (!canManage) {
    return (
      <p className="note">
        Rule governance requires the MANAGE_UOM_RULES permission — the registry below is read-only for this role.
      </p>
    );
  }

  async function propose() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch('/api/procurement/uom-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmiId: Number(cmiId), fromUom, toUom, factor: Number(factor), reason }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Proposal failed');
      setNotice(`Rule proposed (PENDING): ${json.data.cmiCode} ${json.data.fromUom} → ${json.data.toUom} ×${json.data.factor}`);
      setFromUom('');
      setFactor('');
      setReason('');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function transition(id: number, action: 'approve' | 'reject' | 'disable' | 're-enable') {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/procurement/uom-rules/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Transition failed');
      setNotice(`Rule #${id}: ${json.data.previousStatus} → ${json.data.rule.status}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const invalidForm =
    cmiId === '' || fromUom.trim() === '' || !/^\d+$/.test(factor) || Number(factor) <= 0 || reason.trim() === '';

  return (
    <div className="detail-card">
      <h2>Propose material-specific rule</h2>
      <p className="note">
        Scoped to one CMI; starts PENDING and never affects comparable quantities until approved. No automatic
        conversion, no guessing — the reason must cite an authoritative source.
      </p>
      <div className="stack">
        <label>
          CMI scope
          <select value={cmiId} onChange={(e) => setCmiId(e.target.value)}>
            <option value="">Select CMI…</option>
            {cmiOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From UOM (original)
          <input value={fromUom} onChange={(e) => setFromUom(e.target.value)} placeholder="SET" maxLength={16} />
        </label>
        <label>
          To UOM (canonical)
          <select value={toUom} onChange={(e) => setToUom(e.target.value)}>
            {CANONICAL_UOMS.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </label>
        <label>
          Factor (integer)
          <input value={factor} onChange={(e) => setFactor(e.target.value)} placeholder="10" inputMode="numeric" />
        </label>
      </div>
      <label className="stack">
        Evidence / reason (required)
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Authoritative source for this conversion, e.g. supplier pack sheet or technical datasheet…"
          maxLength={500}
          rows={3}
        />
      </label>
      <div className="stack">
        <button type="button" disabled={busy || invalidForm} onClick={propose} className="btn">
          {busy ? 'Working…' : 'Propose rule (PENDING)'}
        </button>
      </div>
      {notice && <p className="note">{notice}</p>}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

export function UomRuleTransitionActions({
  id,
  status,
  canManage,
}: {
  id: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DISABLED';
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canManage || status === 'REJECTED') return null;

  async function run(action: 'approve' | 'reject' | 'disable' | 're-enable') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/procurement/uom-rules/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Transition failed');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="stack">
      {status === 'PENDING' && (
        <>
          <button type="button" disabled={busy} onClick={() => run('approve')}>Approve</button>
          <button type="button" disabled={busy} onClick={() => run('reject')}>Reject</button>
        </>
      )}
      {status === 'APPROVED' && (
        <button type="button" disabled={busy} onClick={() => run('disable')}>Disable</button>
      )}
      {status === 'DISABLED' && (
        <button type="button" disabled={busy} onClick={() => run('re-enable')}>Re-enable</button>
      )}
      {error && <span className="error-box">{error}</span>}
    </span>
  );
}

/**
 * Step 20 — approve/reject the PENDING amendment on a rule (version decision;
 * the rule's lifecycle status is unchanged). Requires MANAGE_UOM_RULES, which
 * the server enforces again on the API.
 */
export function AmendDecisionActions({ ruleId }: { ruleId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function decide(action: 'approve' | 'reject'): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/procurement/uom-rules/${ruleId}/amend`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `Request failed (${res.status})`);
      setNotice(action === 'approve' ? 'Amendment approved: the new version is now effective.' : 'Amendment rejected: the current version stays effective.');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="decision-row">
      <button className="btn" onClick={() => decide('approve')} disabled={busy}>
        Approve amendment
      </button>
      <button className="btn" onClick={() => decide('reject')} disabled={busy}>
        Reject amendment
      </button>
      {notice && <p className="note">{notice}</p>}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

/**
 * Step 20 — propose an amendment (new immutable version) for an APPROVED or
 * DISABLED rule. Creating it changes nothing until it is approved.
 */
export function UomRuleAmendForm({ ruleId, canManage }: { ruleId: number; canManage: boolean }) {
  const router = useRouter();
  const [factor, setFactor] = useState('');
  const [toUom, setToUom] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!canManage) return null;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = { reason };
      if (factor.trim() !== '') payload.factor = Number(factor);
      if (toUom.trim() !== '') payload.toUom = toUom;
      const res = await fetch(`/api/procurement/uom-rules/${ruleId}/amend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `Request failed (${res.status})`);
      setNotice('Amendment proposed as PENDING — conversion still uses the current version until approval.');
      setFactor('');
      setToUom('');
      setReason('');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h3>Propose amendment</h3>
      <p className="note">
        Leave a field empty to keep the current value. The amendment becomes a new immutable version (PENDING) and
        affects conversion only after approval by a different authorized user.
      </p>
      <div className="decision-row">
        <input placeholder="New factor (integer)" value={factor} onChange={(e) => setFactor(e.target.value)} />
        <select value={toUom} onChange={(e) => setToUom(e.target.value)}>
          <option value="">To UOM: keep current</option>
          <option value="EA">EA</option>
          <option value="G">G</option>
          <option value="ML">ML</option>
          <option value="MM">MM</option>
        </select>
        <input placeholder="Amendment reason / evidence (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn" onClick={submit} disabled={busy || reason.trim() === ''}>
          Propose amendment (PENDING)
        </button>
      </div>
      {notice && <p className="note">{notice}</p>}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
