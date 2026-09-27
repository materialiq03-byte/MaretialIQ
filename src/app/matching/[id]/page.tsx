import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { getMatchRequired } from '@/lib/db/repositories/matching-repository';
import { getMatchReview, type TechnicalComparisonRow } from '@/lib/services/match-review-service';
import { getJudgeBrief, judgeScopeOrganizationIds } from '@/lib/services/judge-mode-service';
import { listAudit } from '@/lib/db/repositories/audit-repository';
import { getCommonMaterialByMatchId } from '@/lib/db/repositories/registry-repository';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import DecisionPanel from '../decision-panel';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Candidate #${id} — Matching Workspace — MaterialIQ` };
}

/* ---------------------------------------------------------------------------
 * Phase UI-2 — Matching Workspace flagship.
 *
 * Presentation-only redesign over the FROZEN engineering layer: every value
 * below is rendered from the persisted candidate / Step 23 review contract /
 * Step 24 Judge Mode brief. No rescoring, no new workflow states, no backend
 * changes. Visual hierarchy: MATERIALS → TECHNICAL EVIDENCE → SYSTEM
 * ASSESSMENT → REVIEW ACTION.
 * ------------------------------------------------------------------------- */

/** Relation semantics — icon + text, never color alone (§3/§18). */
const RELATION_META: Record<TechnicalComparisonRow['relation'], { icon: string; label: string; cls: string }> = {
  EXACT: { icon: '✓', label: 'EXACT', cls: 'mw2-rel-exact' },
  NORMALIZED: { icon: '↔', label: 'NORMALIZED', cls: 'mw2-rel-norm' },
  CLOSE: { icon: '≈', label: 'CLOSE', cls: 'mw2-rel-close' },
  MISSING: { icon: '—', label: 'MISSING', cls: 'mw2-rel-missing' },
  CONFLICT: { icon: '!', label: 'CONFLICT', cls: 'mw2-rel-conflict' },
  NOT_APPLICABLE: { icon: '–', label: 'N/A', cls: 'mw2-rel-missing' },
};

/** Importance labels with distinct text (never color alone). */
const IMPORTANCE_META: Record<TechnicalComparisonRow['importance'], { label: string; cls: string }> = {
  CRITICAL: { label: 'CRITICAL', cls: 'mw2-imp-critical' },
  IMPORTANT: { label: 'IMPORTANT', cls: 'mw2-imp-important' },
  INFORMATIONAL: { label: 'INFO', cls: 'mw2-imp-info' },
};

const BAND_CLASS: Record<string, string> = {
  high: 'mw2-band-high',
  review: 'mw2-band-review',
  low: 'mw2-band-low',
  reject: 'mw2-band-reject',
  unknown: 'mw2-band-unknown',
};

function labelize(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Deterministic timestamp rendering (no locale drift between server renders). */
function fmtWhen(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

export default async function MatchWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission('VIEW_MATCHES');
  const { id } = await params;
  const matchId = Number(id);
  if (!Number.isInteger(matchId) || matchId <= 0) notFound();

  // IDOR protection — same scoping rule as Judge Mode and the decision API:
  // a scoped CPSE user may only open pairs touching their own organization.
  const scope = visibleOrganizationIds(user);
  if (scope !== null) {
    const pairOrgs = judgeScopeOrganizationIds(matchId);
    if (!pairOrgs.some((orgId) => scope.includes(orgId))) notFound();
  }

  let match: Awaited<ReturnType<typeof getMatchRequired>>;
  let review: ReturnType<typeof getMatchReview>;
  let brief: ReturnType<typeof getJudgeBrief>;
  let audit: ReturnType<typeof listAudit>['items'];
  try {
    match = getMatchRequired(matchId);
    review = getMatchReview(matchId);
    brief = getJudgeBrief(matchId);
    audit = listAudit({ entityType: 'match_candidate', entityId: matchId, page: 1, pageSize: 12 }).items;
  } catch (err) {
    return (
      <main className="mw-root">
        <p className="mw-back">
          <Link href="/proposals">← Back to Review Queue</Link>
        </p>
        <div className="mw2-state mw2-state-error" role="alert">
          <strong>CANDIDATE UNAVAILABLE</strong>
          <p>
            The requested match candidate could not be loaded
            {err instanceof Error && err.message ? `: ${err.message}` : '.'} Return to the review queue and choose a
            candidate from the list.
          </p>
        </div>
      </main>
    );
  }

  const cmi = getCommonMaterialByMatchId(matchId);
  const left = review.leftMaterial;
  const right = review.rightMaterial;
  const band = review.verdictBand;
  const verdictLabel =
    review.verdict === 'UNCLASSIFIED' ? 'NOT YET CLASSIFIED' : review.verdict.replace(/_/g, ' ');
  const rows = review.technicalComparison;
  const conflictRows = rows.filter((r) => r.relation === 'CONFLICT');
  const criticalCount = review.conflicts.filter((c) => c.criticality === 'CRITICAL').length;
  const isPending = match.candidate.status === 'pending';

  return (
    <main className="mw-root mw2-root">
      {/* ------------------------- §1 COMPACT PAGE HEADER ------------------------- */}
      <header className="mw2-header">
        <div className="mw2-header-main">
          <p className="mw-back">
            <Link href="/proposals">← Back to Review Queue</Link>
          </p>
          <p className="mw2-kicker">MATCHING WORKSPACE · MATERIAL EQUIVALENCE REVIEW</p>
          <h1 className="mw2-title">
            <span className="mw2-title-id">Candidate #{match.candidate.id}</span>
            <span className={`mw2-band ${BAND_CLASS[band] ?? 'mw2-band-unknown'}`}>{verdictLabel}</span>
          </h1>
          <p className="mw2-header-meta">
            <span className="mw2-meta-pair">
              <span className="mw-org">{left.cpse}</span>
              <span className="mono">{left.code}</span>
              <span className="mw2-vs">↔</span>
              <span className="mw-org">{right.cpse}</span>
              <span className="mono">{right.code}</span>
            </span>
            <span className="mw2-meta-sep" aria-hidden="true">·</span>
            <span>Category: {left.category}</span>
            {match.queue ? (
              <>
                <span className="mw2-meta-sep" aria-hidden="true">·</span>
                <span>
                  Queue: {match.queue.status} · priority {match.queue.priority}
                </span>
              </>
            ) : null}
            {match.decision ? (
              <>
                <span className="mw2-meta-sep" aria-hidden="true">·</span>
                <span>
                  Human decision: {match.decision.decision} by {match.decision.reviewer}
                </span>
              </>
            ) : null}
          </p>
        </div>
      </header>

      {/* ----------------- §7a CRITICAL CONFLICT ALERT (instant reason) ----------------- */}
      {review.conflicts.length > 0 ? (
        <div className="mw2-alert" role="alert">
          <span className="mw2-alert-tag" aria-hidden="true">!</span>
          <p>
            <strong>
              CRITICAL TECHNICAL CONFLICT{criticalCount === 1 ? '' : `S`} DETECTED
            </strong>{' '}
            — automatic harmonization blocked. {labelize(review.conflicts[0].attribute)}:{' '}
            <span className="mono">{review.conflicts[0].leftValue ?? '—'}</span> vs{' '}
            <span className="mono">{review.conflicts[0].rightValue ?? '—'}</span>.
            {review.conflicts.length > 1 ? ` +${review.conflicts.length - 1} more below.` : ''} Human technical review
            required.
          </p>
        </div>
      ) : null}

      {/* --------------------------- §2 MATERIAL PANELS --------------------------- */}
      <section aria-label="Material identity">
        <h2 className="mw2-sec-title">MATERIALS</h2>
        <div className="mw2-materials">
          {[
            { side: 'LEFT', role: 'SOURCE RECORD', m: left },
            { side: 'RIGHT', role: 'CANDIDATE RECORD', m: right },
          ].map(({ side, role, m }) => (
            <article className="mw2-material" key={side}>
              <div className="mw2-material-head">
                <span className="mw2-material-side">{side}</span>
                <span className="mw2-material-role">{role}</span>
              </div>
              <div className="mw2-material-org">
                <span className="mw-org">{m.cpse}</span>
                <Link className="mw2-material-open" href={`/materials/${m.id}`}>
                  open record →
                </Link>
              </div>
              <p className="mw2-material-code mono">{m.code}</p>
              <p className="mw2-material-desc">{m.description}</p>
              {m.normalizedDescription ? (
                <p className="mw2-material-norm">normalized: {m.normalizedDescription}</p>
              ) : null}
              <dl className="mw2-material-facts">
                <div>
                  <dt>Category</dt>
                  <dd>{m.category}</dd>
                </div>
                <div>
                  <dt>Manufacturer</dt>
                  <dd>{m.manufacturer ?? '—'}</dd>
                </div>
                <div>
                  <dt>Part number</dt>
                  <dd className="mono">{m.partNumber ?? '—'}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd className="mono">{m.model ?? '—'}</dd>
                </div>
                <div>
                  <dt>UOM</dt>
                  <dd className="mono">{m.uom}</dd>
                </div>
              </dl>
              {m.attributes.length > 0 ? (
                <div className="mw2-material-attrs">
                  <h3>Extracted technical attributes</h3>
                  <ul>
                    {m.attributes.map((a) => (
                      <li key={a.name}>
                        <span className="mw2-attr-name">{labelize(a.name)}</span>
                        <span className="mono mw2-attr-value">
                          {a.value}
                          {a.unit ? ` ${a.unit}` : ''}
                        </span>
                        {a.critical ? <span className="mw2-attr-crit">critical</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mw2-material-noattrs">No structured attributes extracted for this record.</p>
              )}
            </article>
          ))}
        </div>
      </section>

      {/* --------------------- §3 SIDE-BY-SIDE TECHNICAL COMPARISON --------------------- */}
      <section aria-label="Side-by-side technical comparison">
        <h2 className="mw2-sec-title">TECHNICAL COMPARISON</h2>
        {rows.length === 0 ? (
          <div className="mw2-state">
            <strong>NO STRUCTURED COMPARISON AVAILABLE</strong>
            <p>
              No attribute-level comparison is stored for this pair (legacy evidence). The score components below come
              from the persisted candidate record; reprocess both materials to build the technical matrix.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="mw2-compare">
              <thead>
                <tr>
                  <th scope="col">Attribute</th>
                  <th scope="col">
                    <span className="mw-org">{left.cpse}</span> <span className="mono">{left.code}</span>
                  </th>
                  <th scope="col">
                    <span className="mw-org">{right.cpse}</span> <span className="mono">{right.code}</span>
                  </th>
                  <th scope="col">Relation</th>
                  <th scope="col">Importance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const rel = RELATION_META[r.relation];
                  const imp = IMPORTANCE_META[r.importance];
                  const criticalRow = r.importance === 'CRITICAL' && r.relation === 'CONFLICT';
                  return (
                    <tr key={r.attribute} className={criticalRow ? 'mw2-row-critical' : undefined}>
                      <th scope="row" className="mw2-cell-attr">
                        {labelize(r.attribute)}
                        {r.basis ? <span className="mw2-basis">{r.basis}</span> : null}
                      </th>
                      <td className="mono">{r.leftValue ?? '—'}</td>
                      <td className="mono">{r.rightValue ?? '—'}</td>
                      <td>
                        <span className={`mw2-rel ${rel.cls}`}>
                          <span aria-hidden="true">{rel.icon}</span> {rel.label}
                        </span>
                      </td>
                      <td>
                        <span className={`mw2-imp ${imp.cls}`}>{imp.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------ §7 CONFLICTS AREA ------------------------------ */}
      <section aria-label="Technical conflicts">
        <h2 className="mw2-sec-title">TECHNICAL CONFLICTS</h2>
        {review.conflicts.length === 0 ? (
          <div className="mw2-clearconflict" role="status">
            <span aria-hidden="true">✓</span> NO CRITICAL CONFLICTS DETECTED
            {review.missingEvidence.length > 0
              ? ' — missing critical evidence is listed below; missing is never treated as equal.'
              : ' — technical attributes agree or are within tolerance.'}
          </div>
        ) : (
          <ol className="mw2-conflicts">
            {review.conflicts.map((c, i) => (
              <li key={`${c.attribute}-${i}`} className="mw2-conflict">
                <span className="mw2-conflict-n num">{String(i + 1).padStart(2, '0')}</span>
                <div className="mw2-conflict-body">
                  <span className="mw2-conflict-name">{labelize(c.attribute)}</span>
                  <span className="mw2-conflict-vs">
                    <span className="mw-org">{left.cpse}</span> <span className="mono">{c.leftValue ?? '—'}</span>
                    <span className="mw2-vs">≠</span>
                    <span className="mw-org">{right.cpse}</span> <span className="mono">{c.rightValue ?? '—'}</span>
                  </span>
                  <span className="mw2-conflict-effect">
                    Importance: <strong>{c.criticality}</strong> · Effect: {c.assessment}
                    {c.criticality === 'CRITICAL' ? ' Automatic harmonization blocked.' : ''}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
        {review.missingEvidence.length > 0 ? (
          <div className="mw2-missing">
            <h3>MISSING CRITICAL EVIDENCE</h3>
            <ul>
              {review.missingEvidence.map((m) => (
                <li key={m}>
                  <span aria-hidden="true">—</span> {labelize(m)} is absent on one record — equality cannot be
                  confirmed, and missing is never treated as equal or as conflict.
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {review.assemblyEvidence ? (
          <div className="mw2-missing mw2-assembly">
            <h3>ASSEMBLY / CONFIGURATION DIFFERENCE</h3>
            <p>
              <span className="mono">{review.assemblyEvidence.materialA}</span> vs{' '}
              <span className="mono">{review.assemblyEvidence.materialB}</span> — {review.assemblyEvidence.detail}.
              System handling: technical review required; no equivalence is declared.
            </p>
          </div>
        ) : null}
      </section>

      {/* --------------------------- §5 SYSTEM ASSESSMENT --------------------------- */}
      <section aria-label="System assessment">
        <h2 className="mw2-sec-title">SYSTEM ASSESSMENT</h2>
        <div className={`mw2-assessment ${BAND_CLASS[band] ?? 'mw2-band-unknown'}`}>
          <div className="mw2-assess-verdict">
            <span className="mw2-assess-label">SYSTEM ASSESSMENT</span>
            <span className="mw2-assess-state">{verdictLabel}</span>
            <span className="mw2-assess-score num">
              {clampPct(review.finalScore)}<span className="mw2-assess-denom"> / 100</span>
            </span>
          </div>
          <div className="mw2-assess-body">
            <p className="mw2-assess-reason">{review.reason}</p>
            <p className="mw2-assess-note">
              {brief.completeness === 'LIMITED'
                ? 'Persisted evidence is LIMITED for this legacy candidate — components below come from the persisted candidate columns; nothing is recomputed.'
                : 'Computed from the persisted evidence document at match-run time. Nothing is recomputed on this page.'}
            </p>
            <div className="mw2-svsh">
              <div className="mw2-svsh-cell mw2-svsh-system">
                <span className="mw2-svsh-label">SYSTEM ASSESSMENT</span>
                <span>{brief.systemVsHuman.assessment} — computed evidence, never a human approval</span>
              </div>
              <div className="mw2-svsh-cell mw2-svsh-human">
                <span className="mw2-svsh-label">HUMAN DECISION</span>
                <span>{brief.systemVsHuman.humanDecision}{isPending ? ' — authorized reviewer action required below' : ''}</span>
              </div>
            </div>
            <p className="mw2-svsh-separator">{brief.systemVsHuman.separator}</p>
            <div className="mw2-assess-cta">
              <Link className="mw2-cta" href={`/matching/${match.candidate.id}/judge`}>
                WHY THIS RESULT → OPEN JUDGE MODE
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------- §6 WHY THIS RESULT (summary) ------------------------- */}
      <section aria-label="Why this result — evidence summary">
        <h2 className="mw2-sec-title">WHY THIS RESULT</h2>
        <div className="mw2-why">
          <p className="mw2-why-q">
            {brief.question.replace(/_/g, ' ')} — deterministic summary; every line cites stored evidence.
          </p>
          <ul className="mw2-why-bullets">
            {brief.headline.bullets.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <p className="mw2-why-note">
            Judge Mode remains the authoritative, full explainability experience — it opens with this candidate, route
            context and theme preserved.
          </p>
        </div>
      </section>

      {/* ------------------------- §4 SCORE DECOMPOSITION ------------------------- */}
      <section aria-label="Score decomposition">
        <h2 className="mw2-sec-title">SCORE DECOMPOSITION</h2>
        <div className="mw2-scores">
          {brief.scoreDecomposition.components.map((c) => (
            <div className="mw2-scorecomp" key={c.component}>
              <div className="mw2-scorecomp-top">
                <span className="mw2-scorecomp-name">{c.component}</span>
                <span className="mw2-scorecomp-nums num">
                  {c.score} × {c.weightPct}% weight →{' '}
                  {c.contribution === null ? '—' : `+${c.contribution}`}
                </span>
              </div>
              <div
                className="mw2-scorebar"
                role="img"
                aria-label={`${c.component}: score ${c.score} of 100 at ${c.weightPct}% weight`}
              >
                <div className="mw2-scorebar-fill" style={{ width: `${clampPct(c.score)}%` }} />
              </div>
            </div>
          ))}
          <div className="mw2-scorefinal num">
            FINAL SCORE {brief.scoreDecomposition.finalScore} / 100 — persisted engine value
          </div>
          <p className="mw2-scorenote">
            {brief.scoreDecomposition.source === 'evidence_document'
              ? 'Components and weighted contributions are the persisted engine values from the evidence document.'
              : 'Persisted evidence document unavailable for this legacy candidate — component scores are the persisted candidate columns; contributions are omitted rather than fabricated.'}
          </p>
        </div>
      </section>

      {/* --------------------------- §8 REVIEW ACTION --------------------------- */}
      <section aria-label="Review action">
        <h2 className="mw2-sec-title">REVIEW ACTION</h2>
        <div className="mw2-actions">
          <DecisionPanel
            matchId={match.candidate.id}
            status={match.candidate.status}
            decision={match.decision}
          />
          {match.queue ? (
            <p className="mw2-queue-note">
              Review queue: {match.queue.status} · priority {match.queue.priority}
              {match.queue.reason ? ` — ${match.queue.reason}` : ''}
            </p>
          ) : null}
        </div>
      </section>

      {/* ------------------------ §9 REVIEW HISTORY (governance) ------------------------ */}
      <section aria-label="Review history">
        <h2 className="mw2-sec-title">REVIEW HISTORY</h2>
        {review.decisionHistory.length === 0 ? (
          <div className="mw2-history-empty" role="status">
            No human decision recorded yet — this candidate is awaiting authorized technical review.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="mw2-history">
              <thead>
                <tr>
                  <th scope="col">Decision</th>
                  <th scope="col">Reviewer</th>
                  <th scope="col">Reason</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {review.decisionHistory.map((d, i) => (
                  <tr key={i}>
                    <td>
                      <span className="mw2-hist-decision">{d.decision.replace(/_/g, ' ').toUpperCase()}</span>
                    </td>
                    <td>{d.reviewer}</td>
                    <td className="mw2-hist-reason">{d.comment ?? '—'}</td>
                    <td className="mono">{fmtWhen(d.decidedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {audit.length > 0 ? (
          <details className="mw2-audit">
            <summary>Audit trail ({audit.length} recent events)</summary>
            <div className="table-wrap">
              <table className="mw2-history">
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Actor</th>
                    <th scope="col">When</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{a.action}</td>
                      <td>{a.actor}</td>
                      <td className="mono">{fmtWhen(a.created_at)}</td>
                      <td className="mw2-hist-reason">
                        {a.details == null ? '—' : typeof a.details === 'string' ? a.details : JSON.stringify(a.details)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </section>

      {/* ------------------------------ §10 CMI STATE ------------------------------ */}
      <section aria-label="Harmonization state">
        <h2 className="mw2-sec-title">HARMONIZATION STATE</h2>
        {cmi ? (
          <div className="mw2-cmi mw2-cmi-created">
            <span className="mw2-cmi-badge">✓ CMI CREATED</span>
            <div>
              <p className="mw2-cmi-code">
                CMI: <Link href="/cross-reference" className="mono">{cmi.code}</Link>
              </p>
              <p className="mw2-cmi-orgs">
                Organizations: <span className="mw-org">{left.cpse}</span> <span className="mw-org">{right.cpse}</span> —
                original codes <span className="mono">{left.code}</span> / <span className="mono">{right.code}</span>{' '}
                remain preserved.
              </p>
              <p className="mw2-cmi-note">{brief.cmi.note}</p>
            </div>
          </div>
        ) : review.cmiState === 'cmi_pending' ? (
          <div className="mw2-cmi mw2-cmi-pending">
            <span className="mw2-cmi-badge mw2-cmi-badge-pending">AWAITING CMI</span>
            <div>
              <p className="mw2-cmi-note">{brief.cmi.note}</p>
            </div>
          </div>
        ) : (
          <div className="mw2-cmi mw2-cmi-none" role="status">
            <span className="mw2-cmi-badge mw2-cmi-badge-none">NO HARMONIZED IDENTITY CREATED</span>
            <p className="mw2-cmi-note">
              {brief.cmi.note} Common Material Identity is created only through the governed workflow after authorized
              human approval — never automatically.
            </p>
          </div>
        )}
      </section>

      {/* --------------------------- §11 QUEUE INTEGRATION --------------------------- */}
      <footer className="mw2-queuebar">
        <Link className="mw2-cta mw2-cta-ghost" href="/proposals">
          ← Back to Review Queue
        </Link>
        <Link className="mw2-cta mw2-cta-ghost" href={`/matching/${match.candidate.id}/judge`}>
          Open Judge Mode →
        </Link>
        <span className="mw2-queuebar-note">
          Decision on candidate #{match.candidate.id} is {isPending ? 'pending — actions above are live' : 'recorded and immutable'}; the trail is audited.
        </span>
      </footer>
    </main>
  );
}
