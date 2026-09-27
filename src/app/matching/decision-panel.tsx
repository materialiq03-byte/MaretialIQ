'use client';

import { useState } from 'react';
import { DECISIONS } from '@/lib/types/domain';

/**
 * Presentation labels only — the underlying decision values are the existing
 * frozen workflow states (approved / rejected / deferred / sent_for_review).
 * No new workflow state is invented.
 */
const DECISION_LABELS: Record<string, string> = {
  approved: 'APPROVE MATCH',
  rejected: 'REJECT MATCH',
  deferred: 'NEEDS REVIEW — DEFER',
  sent_for_review: 'SEND FOR SENIOR REVIEW',
};

const DECISION_TONE: Record<string, string> = {
  approved: 'mw2-act-approve',
  rejected: 'mw2-act-reject',
  deferred: 'mw2-act-hold',
  sent_for_review: 'mw2-act-hold',
};

/**
 * Human review actions for ONE candidate, embedded in the technical-comparison
 * workspace. Uses the existing POST /api/matches/:id contract; the acting
 * reviewer is always the authenticated session user (server-side). Decided
 * candidates render an immutable "Decision Recorded" state — governance, not
 * decoration.
 *
 * Phase UI-2: the request now carries `expectedStatus` (a supported field of
 * the same contract) so a stale page is rejected with a 409 instead of
 * deciding on outdated state. Confirmation step, duplicate-decision
 * protection, authorization and audit behavior are unchanged.
 */
export default function DecisionPanel({
  matchId,
  status,
  decision,
}: {
  matchId: number;
  status: string;
  decision: { decision: string; reviewer: string; comment: string | null; decided_at: string } | null;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const isPending = status === 'pending' && !done && !decision;

  async function submit() {
    if (!chosen) return;
    setSubmitting(true);
    setError(null);
    setStale(false);
    try {
      const res = await fetch(`/api/matches/${matchId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: chosen,
          comment: comment.trim() || undefined,
          // Optimistic concurrency (existing contract): reject stale decisions
          // server-side with a 409 before anything is written.
          expectedStatus: status,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          setStale(true);
          setError(
            data?.error?.message ??
              'Stale review: this candidate changed after the page was loaded. Refresh and decide on the current state.',
          );
        } else {
          setError(data?.error?.message ?? `Request failed with status ${res.status}`);
        }
        return;
      }
      setDone(data.data.status);
    } catch (err) {
      setError(err instanceof Error ? `Network error: ${err.message}` : 'Network error — decision not recorded.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!isPending) {
    return (
      <div className="mw2-recorded" role="status">
        <span className="mw2-recorded-icon" aria-hidden="true">
          ✓
        </span>
        <div>
          <strong>DECISION RECORDED</strong>
          <span className="mw2-recorded-meta">
            {done
              ? `Your decision (${done}) was recorded. Reload to see the updated queue.`
              : decision
                ? `${decision.decision.toUpperCase()} by ${decision.reviewer} at ${decision.decided_at}${
                    decision.comment ? ` — “${decision.comment}”` : ''
                  }`
                : 'No human decision recorded yet for this candidate.'}
          </span>
          <span className="mw2-recorded-immutable">
            Recorded decisions are immutable — the full trail is in the review history and audit trail below.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="mw2-actionbox">
      <div className="mw2-action-title">HUMAN TECHNICAL REVIEW REQUIRED</div>
      <p className="mw2-action-sub">
        The system assessment above is computed evidence — it is never an approval. Record your authorized decision;
        it is attributed and audited.
      </p>
      <div className="mw2-action-row" role="group" aria-label="Review decision">
        {DECISIONS.map((d) => (
          <button
            key={d}
            className={`mw2-act ${DECISION_TONE[d] ?? ''}`}
            disabled={submitting}
            onClick={() => setChosen(d)}
          >
            {DECISION_LABELS[d]}
          </button>
        ))}
      </div>
      {chosen ? (
        <div className="mw2-confirm">
          <p className="mw2-confirm-line">
            <strong>{DECISION_LABELS[chosen]}</strong> on candidate #{matchId}
            {chosen === 'rejected' ? ' — a cited technical reason is strongly recommended.' : '.'}
          </p>
          <label className="fld mw2-confirm-fld">
            Technical reason {chosen === 'rejected' ? '(strongly recommended)' : '(optional)'}
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Cite the technical evidence you relied on…"
              aria-label="Decision comment"
            />
          </label>
          <div className="mw2-action-row">
            <button className="mw2-act mw2-act-confirm" disabled={submitting} onClick={submit}>
              {submitting ? 'RECORDING…' : `CONFIRM: ${DECISION_LABELS[chosen]}`}
            </button>
            <button className="mw2-act mw2-act-cancel" disabled={submitting} onClick={() => setChosen(null)}>
              CANCEL
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="mw2-action-error" role="alert">
          {error}
          {stale ? (
            <>
              {' '}
              <button type="button" className="mw2-reload" onClick={() => window.location.reload()}>
                Reload current state
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
