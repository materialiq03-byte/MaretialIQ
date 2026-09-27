'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Status = 'OPEN' | 'ACKNOWLEDGED' | 'DISMISSED' | 'RESOLVED';

/**
 * Governed human-review actions (Step 15 sections 6/27/29): every transition
 * posts to the authorized API; dismiss/resolve/reopen require a short reason,
 * acknowledge does not. Buttons are enabled by server-verified permission -
 * the API re-checks server-side regardless.
 */
export function OpportunityReviewActions({
  opportunityId,
  status,
  canReview,
}: {
  opportunityId: number;
  status: Status;
  canReview: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: string, reason?: string) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch('/api/procurement/opportunities/' + opportunityId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? 'Request failed');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function withReason(action: string) {
    const reason = window.prompt('Short reason (recorded in the audit trail):');
    if (reason === null) return;
    if (reason.trim().length === 0) {
      setError('A reason is required.');
      return;
    }
    void act(action, reason.trim());
  }

  if (!canReview) {
    return (
      <p className="muted">
        Review actions require procurement-management permission. Current view is read-only.
      </p>
    );
  }

  return (
    <div className="decision-row">
      {(status === 'OPEN') && (
        <button className="btn" type="button" disabled={busy !== null} onClick={() => void act('acknowledge')}>
          {busy === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
        </button>
      )}
      {(status === 'OPEN' || status === 'ACKNOWLEDGED') && (
        <>
          <button className="btn" type="button" disabled={busy !== null} onClick={() => withReason('dismiss')}>
            {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
          </button>
          <button className="btn primary" type="button" disabled={busy !== null} onClick={() => withReason('resolve')}>
            {busy === 'resolve' ? 'Resolving…' : 'Resolve'}
          </button>
        </>
      )}
      {(status === 'DISMISSED' || status === 'RESOLVED') && (
        <button className="btn" type="button" disabled={busy !== null} onClick={() => withReason('reopen')}>
          {busy === 'reopen' ? 'Reopening…' : 'Reopen'}
        </button>
      )}
      {status === 'ACKNOWLEDGED' && <span className="muted">Acknowledged — awaiting further human review.</span>}
      {error && <span className="error-box">{error}</span>}
    </div>
  );
}
