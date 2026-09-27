'use client';

import { useState } from 'react';
import type { MatchWithContext } from '@/lib/db/repositories/matching-repository';
import { DECISIONS } from '@/lib/types/domain';

const DECISION_LABELS: Record<string, string> = {
  approved: 'Approve mapping',
  rejected: 'Reject',
  deferred: 'Defer',
  sent_for_review: 'Send for senior review',
};

export default function ProposalCard({ match }: { match: MatchWithContext }) {
  const c = match.candidate;
  const [decision, setDecision] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ status: string } | null>(null);

  const isPending = c.status === 'pending' && !done;

  async function submit() {
    if (!decision) return;
    setSubmitting(true);
    setError(null);
    try {
      // The acting reviewer is the authenticated session user — the server
      // ignores any client-supplied identity.
      const res = await fetch(`/api/matches/${c.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, comment: comment.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error?.message ?? `Request failed with status ${res.status}`);
        return;
      }
      setDone({ status: data.data.status });
    } catch (err) {
      setError(err instanceof Error ? `Network error: ${err.message}` : 'Network error — decision not recorded.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="proposal-card">
      <div className="card-head">
        <div>
          <strong>
            {match.source.org_code} {match.source.original_code}
          </strong>{' '}
          ↔{' '}
          <strong>
            {match.candidateMat.org_code} {match.candidateMat.original_code}
          </strong>
        </div>
        <div>
          <span className={`badge ${c.status}`}>{c.status}</span>{' '}
          {c.status === 'approved' ? (
            <span className={`badge ${match.cmiState === 'cmi_created' ? 'approved' : 'medium'}`}>
              {match.cmiState === 'cmi_created' ? 'CMI created' : 'CMI pending'}
            </span>
          ) : null}{' '}
          <span className={`badge ${c.match_type}`}>{c.match_type}</span>
        </div>
      </div>

      <div className="card-body">
        <div className="compare-grid">
          <div className="record-box">
            <div className="cpse">{match.source.org_code} · source</div>
            <dl>
              <dt>Code</dt>
              <dd className="mono">{match.source.original_code}</dd>
              <dt>Description</dt>
              <dd>{match.source.original_description}</dd>
              <dt>Category</dt>
              <dd>{match.source.category}</dd>
              <dt>UOM</dt>
              <dd>{match.source.uom}</dd>
            </dl>
          </div>
          <div className="record-box">
            <div className="cpse">{match.candidateMat.org_code} · candidate</div>
            <dl>
              <dt>Code</dt>
              <dd className="mono">{match.candidateMat.original_code}</dd>
              <dt>Description</dt>
              <dd>{match.candidateMat.original_description}</dd>
              <dt>Category</dt>
              <dd>{match.candidateMat.category}</dd>
              <dt>UOM</dt>
              <dd>{match.candidateMat.uom}</dd>
            </dl>
          </div>
        </div>

        {c.critical_difference ? (
          <div className="critical-banner">
            <strong>Critical technical difference:</strong> {c.critical_difference}
          </div>
        ) : null}

        <div className="section-label">Scores (computed, not model opinions)</div>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Signal</th>
              <th className="num">Value</th>
              <th>Basis</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Semantic (embedding)</td>
              <td className="num">{Math.round(c.semantic_score)}%</td>
              <td className="evidence-detail">Provider-embedded descriptions compared via cosine similarity</td>
            </tr>
            <tr>
              <td>Lexical (fuzzy)</td>
              <td className="num">{Math.round(c.fuzzy_score)}%</td>
              <td className="evidence-detail">Dice coefficient over synonym-normalised description tokens</td>
            </tr>
            <tr>
              <td>Technical attributes</td>
              <td className="num">{Math.round(c.technical_score)}%</td>
              <td className="evidence-detail">Agreement across structured material attributes</td>
            </tr>
            <tr>
              <td>Category compatible</td>
              <td className="num">{c.category_compatible ? 'Yes' : 'No'}</td>
              <td className="evidence-detail">Exact category equality</td>
            </tr>
            <tr>
              <td>
                <strong>Final score</strong>
              </td>
              <td className="num">
                <strong>{Math.round(c.final_score)}%</strong>
              </td>
              <td className="evidence-detail">30% semantic + 20% lexical + 30% technical + 20% category — prototype weights, not official methodology</td>
            </tr>
          </tbody>
        </table>
        </div>

        <div className="section-label">Why this classification</div>
        <p className="evidence-detail">{c.explanation}</p>

        {isPending ? (
          <div className="decision-row">
            {DECISIONS.map((d) => (
              <button
                key={d}
                className={d === 'approved' ? 'approve' : d === 'rejected' ? 'reject' : ''}
                disabled={submitting}
                onClick={() => setDecision(d)}
              >
                {DECISION_LABELS[d]}
              </button>
            ))}
          </div>
        ) : (
          <div className="review-meta">
            {done
              ? `Decision recorded: ${done.status}. Reload to refresh the queue.`
              : match.decision
                ? `Last decision: ${match.decision.decision} by ${match.decision.reviewer} at ${match.decision.decided_at}${
                    match.decision.comment ? ` — “${match.decision.comment}”` : ''
                  }`
                : 'No decision recorded.'}
            {match.cmiState === 'cmi_created' ? ' · Common Material Identity active' : ''}
            {match.cmiState === 'cmi_pending' ? ' · Awaiting Common Material Identity creation' : ''}
          </div>
        )}

        {isPending && decision ? (
          <div className="decision-note">
            <label className="fld">
              Comment {decision === 'rejected' ? '(strongly recommended)' : '(optional)'}
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Cite the evidence you relied on…"
              />
            </label>
            <div className="decision-row">
              <button className="primary" disabled={submitting} onClick={submit}>
                {submitting ? 'Recording…' : `Confirm: ${DECISION_LABELS[decision]}`}
              </button>
              <button disabled={submitting} onClick={() => setDecision(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {error ? <div className="error-box">{error}</div> : null}
      </div>
    </div>
  );
}
