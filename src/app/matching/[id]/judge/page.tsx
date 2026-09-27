import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { parseOrThrow, idSchema } from '@/lib/validation/schemas';
import { getJudgeBrief, judgeScopeOrganizationIds } from '@/lib/services/judge-mode-service';
import { getMatchReview } from '@/lib/services/match-review-service';
import { getCommonMaterialByMatchId } from '@/lib/db/repositories/registry-repository';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Judge Mode — MaterialIQ' };

export const dynamic = 'force-dynamic';

/* ---------------------------------------------------------------------------
 * Phase UI-5 — Judge Mode as an ENGINEERING EVIDENCE CONSOLE.
 *
 * Presentation-only redesign over the frozen Step 24 JudgeBrief (plus the
 * Step 23 MatchReview for material identity fields and the existing read-only
 * CMI lookup). No rescoring, no writes, no audit rows, no fabricated values:
 * every number, label and timestamp comes from the frozen contracts; unknown
 * values render as "—" with honest notes.
 *
 * Visual hierarchy: DECISION → CRITICAL EVIDENCE → TECHNICAL COMPARISON →
 * SCORE REASONING → SOURCE TRACEABILITY → SYSTEM/HUMAN → HISTORY → ACTION.
 * ------------------------------------------------------------------------- */

const BAND_CLASS: Record<string, string> = {
  high: 'mw2-band-high',
  review: 'mw2-band-review',
  low: 'mw2-band-low',
  reject: 'mw2-band-reject',
  unknown: 'mw2-band-unknown',
};

function bandOf(verdict: string): string {
  if (verdict === 'HIGH_CONFIDENCE_MATCH') return 'high';
  if (verdict === 'NEEDS_TECHNICAL_REVIEW') return 'review';
  if (verdict === 'NOT_A_MATCH') return 'reject';
  return 'low';
}

/** Relation semantics — icon + text, never color alone (UI-2 vocabulary). */
const RELATION_META: Record<string, { icon: string; label: string; cls: string }> = {
  EXACT: { icon: '✓', label: 'EXACT', cls: 'mw2-rel-exact' },
  NORMALIZED: { icon: '↔', label: 'NORMALIZED', cls: 'mw2-rel-norm' },
  CLOSE: { icon: '≈', label: 'CLOSE', cls: 'mw2-rel-close' },
  MISSING: { icon: '—', label: 'MISSING', cls: 'mw2-rel-missing' },
  CONFLICT: { icon: '!', label: 'CONFLICT', cls: 'mw2-rel-conflict' },
  NOT_APPLICABLE: { icon: '–', label: 'N/A', cls: 'mw2-rel-missing' },
};

const IMPORTANCE_META: Record<string, { label: string; cls: string }> = {
  CRITICAL: { label: 'CRITICAL', cls: 'mw2-imp-critical' },
  IMPORTANT: { label: 'IMPORTANT', cls: 'mw2-imp-important' },
  INFORMATIONAL: { label: 'INFO', cls: 'mw2-imp-info' },
};

function labelize(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

export default async function JudgeModePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission('VIEW_MATCHES');
  const { id } = await params;
  const matchId = parseOrThrow(idSchema, id);
  // IDOR protection: scoped CPSE users may only open pairs touching their org.
  const scope = visibleOrganizationIds(user);
  if (scope !== null) {
    const pairOrgs = judgeScopeOrganizationIds(matchId);
    if (!pairOrgs.some((orgId) => scope.includes(orgId))) notFound();
  }

  let b: ReturnType<typeof getJudgeBrief>;
  try {
    b = getJudgeBrief(matchId);
  } catch {
    // UI-6 negative-test fix: an unknown candidate previously escaped to the
    // generic error boundary. Present the same honest unavailable state the
    // Matching Workspace already uses — no fabricated candidate, no crash.
    return (
      <main className="mw-root">
        <p className="mw-back">
          <Link href="/proposals">← Back to Review Queue</Link>
        </p>
        <div className="mw2-state mw2-state-error" role="alert">
          <strong>CANDIDATE UNAVAILABLE</strong>
          <p>The requested match candidate does not exist. Return to the review queue and choose a candidate from the list.</p>
        </div>
      </main>
    );
  }
  // Material identity detail + CMI state from the same frozen contracts the
  // workspace uses (read-only; nothing new is queried beyond these).
  const review = getMatchReview(matchId);
  const cmi = getCommonMaterialByMatchId(matchId);
  const left = review.leftMaterial;
  const right = review.rightMaterial;
  const band = bandOf(b.headline.verdict);
  const criticalConflicts = b.conflicts.filter((c) => c.criticality === 'CRITICAL');
  const pending = review.status === 'pending';

  return (
    <main className="mw-root mw5-root">
      {/* ------------------------------- top header ------------------------------- */}
      <header className={`mw5-head mw2-assessment ${BAND_CLASS[band]}`}>
        <div className="mw2-assess-verdict">
          <p className="mw5-kicker">
            <Link href={`/matching/${b.candidateId}`}>← Matching Workspace</Link>
            <span aria-hidden="true"> · </span>
            <Link href="/proposals">Review queue</Link>
          </p>
          <span className="mw2-assess-label">JUDGE MODE · DETERMINISTIC EVIDENCE CONSOLE</span>
          <span className="mw5-head-id">Candidate #{b.candidateId}</span>
          <span className="mw5-head-score num">
            {b.headline.finalScore}<span className="mw2-assess-denom"> / 100</span>
          </span>
        </div>
        <div className="mw2-assess-body">
          <div className="mw5-head-pair">
            <span className="mw-org">{b.headline.left.cpse}</span>
            <span className="mono mw5-head-code">{b.headline.left.code}</span>
            <span className="mw2-vs" aria-hidden="true">↔</span>
            <span className="mw-org">{b.headline.right.cpse}</span>
            <span className="mono mw5-head-code">{b.headline.right.code}</span>
            <span className={`mw2-band ${BAND_CLASS[band]}`}>{b.headline.verdictLabel}</span>
          </div>
          <p className="mw2-assess-reason">{b.headline.reason}</p>
          <p className="mw2-assess-note">
            Every statement below traces to persisted system evidence ({b.completeness} evidence). Nothing is
            generated, nothing is recomputed on this page. Print / export: use the browser&apos;s print function — this
            page is print-friendly by design.
          </p>
        </div>
      </header>

      {/* --------------------------- §1 decision headline --------------------------- */}
      <section className="mw5-decision" aria-label="Decision headline">
        <div className="mw5-decision-verdict">
          <span className="mw5-decision-label">SYSTEM ASSESSMENT</span>
          <span className="mw5-decision-state">{b.headline.verdictLabel}</span>
          <span className="mw5-decision-effect">
            {b.headline.verdict === 'NEEDS_TECHNICAL_REVIEW'
              ? 'Automatic harmonization blocked — critical technical evidence requires authorized human technical review.'
              : b.headline.verdict === 'HIGH_CONFIDENCE_MATCH'
                ? 'Technical attributes agree with no critical conflict — eligible for authorized human approval.'
                : b.headline.verdict === 'NOT_A_MATCH'
                  ? 'Excluded from equivalence by the configured rules and thresholds.'
                  : 'Persisted evidence is limited for this legacy candidate — displayed components come from the persisted candidate columns.'}
          </span>
        </div>
        <div className="mw5-decision-why">
          <span className="mw5-sec-label">{b.question.replace(/_/g, ' ')}</span>
          <ul className="mw2-why-bullets">
            {b.headline.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* --------------------- §2/§8 material identity + source trace --------------------- */}
      <section aria-label="Source material identity">
        <h2 className="mw2-sec-title">SOURCE MATERIAL IDENTITY — ORIGINAL CPSE CODES PRESERVED</h2>
        <div className="mw2-materials">
          {[
            { side: 'SOURCE A', t: b.sourceTrace.left, m: left },
            { side: 'SOURCE B', t: b.sourceTrace.right, m: right },
          ].map(({ side, t, m }) => (
            <article className="mw2-material" key={side}>
              <div className="mw2-material-head">
                <span className="mw2-material-side">{side}</span>
                <span className="mw2-material-role">{t.importUrl ? 'IMPORTED FEED' : 'LEGACY / IMPORT CENTER'}</span>
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
                  <dt>Manufacturer</dt>
                  <dd>{m.manufacturer ?? '—'}</dd>
                </div>
                <div>
                  <dt>Part number</dt>
                  <dd className="mono">{m.partNumber ?? '—'}</dd>
                </div>
                <div>
                  <dt>Category</dt>
                  <dd>{m.category}</dd>
                </div>
                <div>
                  <dt>UOM</dt>
                  <dd className="mono">{m.uom}</dd>
                </div>
                <div>
                  <dt>Source system</dt>
                  <dd className="mono">{t.adapterVersion ?? t.sourceSystem ?? '—'}</dd>
                </div>
                <div>
                  <dt>Source record</dt>
                  <dd className="mono">{t.sourceRecordId}</dd>
                </div>
                <div>
                  <dt>Source file / row</dt>
                  <dd className="mono">{t.sourceFileName ?? '—'}{t.sourceRow !== null ? ` · row ${t.sourceRow}` : ''}</dd>
                </div>
                <div>
                  <dt>Import</dt>
                  <dd>
                    {t.importUrl ? (
                      <Link href={t.importUrl}>import #{t.importId}</Link>
                    ) : (
                      <span className="evidence-detail">{t.note ?? '—'}</span>
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
        <p className="mw5-preserve">
          <span aria-hidden="true">✓</span> ORIGINAL SOURCE IDENTITIES PRESERVED — harmonization adds identity; the
          CPSE material codes above are never replaced or overwritten.
        </p>
      </section>

      {/* ------------------------ §4 critical conflicts ------------------------ */}
      {b.conflicts.length > 0 ? (
        <section aria-label="Critical technical conflicts">
          <h2 className="mw2-sec-title">CRITICAL TECHNICAL CONFLICT{criticalConflicts.length === 1 ? '' : 'S'}</h2>
          <ol className="mw2-conflicts">
            {b.conflicts.map((c, i) => (
              <li key={`${c.attribute}-${c.source}`} className="mw2-conflict">
                <span className="mw2-conflict-n num">{String(i + 1).padStart(2, '0')}</span>
                <div className="mw2-conflict-body">
                  <span className="mw2-conflict-name">{labelize(c.attribute)}</span>
                  <span className="mw2-conflict-vs">
                    <span className="mw-org">{left.cpse}</span> <span className="mono">{c.leftValue ?? '—'}</span>
                    <span className="mw2-vs">≠</span>
                    <span className="mw-org">{right.cpse}</span> <span className="mono">{c.rightValue ?? '—'}</span>
                  </span>
                  <span className="mw2-conflict-effect">
                    Importance: <strong>{c.criticality}</strong> · {c.assessment}
                    {c.criticality === 'CRITICAL' ? ' Automatic harmonization blocked; authorized human technical review required.' : ''}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <section className="mw2-clearconflict" role="status" aria-label="Conflicts">
          <span aria-hidden="true">✓</span> NO CRITICAL TECHNICAL CONFLICT DETECTED
          {b.missingEvidence.length > 0
            ? ' — missing critical evidence is listed below; missing is never treated as equal or as conflict.'
            : ' — technical attributes agree or are within tolerance.'}
        </section>
      )}

      {b.missingEvidence.length > 0 ? (
        <div className="mw2-missing" role="note">
          <h3>MISSING CRITICAL EVIDENCE</h3>
          <ul>
            {b.missingEvidence.map((m) => (
              <li key={m}>
                <span aria-hidden="true">—</span> {labelize(m)} is absent on one record — equality cannot be confirmed,
                and missing is never treated as equal or as conflict.
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {b.assemblyEvidence ? (
        <div className="mw2-missing mw2-assembly" role="note">
          <h3>ASSEMBLY / CONFIGURATION DIFFERENCE</h3>
          <p>
            <span className="mono">{b.assemblyEvidence.materialA}</span> vs{' '}
            <span className="mono">{b.assemblyEvidence.materialB}</span> — {b.assemblyEvidence.detail}. System
            handling: technical review required; no equivalence is declared.
          </p>
        </div>
      ) : null}

      {/* --------------------- §3 technical evidence matrix --------------------- */}
      <section aria-label="Technical evidence matrix">
        <h2 className="mw2-sec-title">TECHNICAL EVIDENCE MATRIX</h2>
        {b.technicalMatrix.length === 0 ? (
          <div className="mw2-state">
            <strong>NO STRUCTURED COMPARISON AVAILABLE</strong>
            <p>
              No attribute-level comparison is stored for this pair (legacy evidence). The score components below come
              from the persisted candidate record; nothing is fabricated to fill the matrix.
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
                  <th scope="col">Result</th>
                  <th scope="col">Importance</th>
                  <th scope="col">Basis</th>
                </tr>
              </thead>
              <tbody>
                {b.technicalMatrix.map((row) => {
                  const rel = RELATION_META[row.relation] ?? { icon: '•', label: row.relation, cls: 'mw2-rel-missing' };
                  const imp = IMPORTANCE_META[row.importance] ?? { label: row.importance, cls: 'mw2-imp-info' };
                  const criticalRow = row.importance === 'CRITICAL' && row.relation === 'CONFLICT';
                  return (
                    <tr key={row.attribute} className={criticalRow ? 'mw2-row-critical' : undefined}>
                      <th scope="row" className="mw2-cell-attr">{labelize(row.attribute)}</th>
                      <td className="mono">{row.leftValue ?? '—'}</td>
                      <td className="mono">{row.rightValue ?? '—'}</td>
                      <td>
                        <span className={`mw2-rel ${rel.cls}`}>
                          <span aria-hidden="true">{rel.icon}</span> {rel.label}
                        </span>
                      </td>
                      <td>
                        <span className={`mw2-imp ${imp.cls}`}>{imp.label}</span>
                      </td>
                      <td className="mw5-basis">{row.basis}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------- §5 score decomposition + system vs human ------------------- */}
      <section aria-label="System score decomposition">
        <h2 className="mw2-sec-title">SYSTEM SCORE — DECOMPOSITION OF THE PERSISTED VALUE</h2>
        <div className="mw5-scoresplit">
          <div className="mw2-scores">
            {b.scoreDecomposition.components.map((c) => (
              <div className="mw2-scorecomp" key={c.component}>
                <div className="mw2-scorecomp-top">
                  <span className="mw2-scorecomp-name">{c.component}</span>
                  <span className="mw2-scorecomp-nums num">
                    {c.score} × {c.weightPct}% weight → {c.contribution === null ? '—' : `+${c.contribution}`}
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
            <div className="mw5-scorefinal num">
              SYSTEM SCORE {b.scoreDecomposition.finalScore} / 100 — persisted engine value
            </div>
            <p className="mw2-scorenote">
              {b.scoreDecomposition.source === 'evidence_document'
                ? 'Components and weighted contributions are the persisted engine values from the evidence document. Nothing is recomputed here.'
                : 'Detailed persisted evidence is unavailable for this legacy candidate. Displayed score components are from persisted candidate columns (contributions omitted rather than fabricated).'}
            </p>
          </div>
          <div className="mw5-verdictbox">
            <span className="mw5-verdict-label">SYSTEM SCORE</span>
            <span className="mw5-verdict-value num">{b.headline.finalScore}<span className="mw2-assess-denom"> / 100</span></span>
            <span className={`mw2-band ${BAND_CLASS[band]}`}>{b.headline.verdictLabel}</span>
          </div>
        </div>
        <div className="mw2-svsh mw5-svsh">
          <div className="mw2-svsh-cell mw2-svsh-system">
            <span className="mw2-svsh-label">SYSTEM ASSESSMENT</span>
            <span>{b.systemVsHuman.assessment} — {b.systemVsHuman.separator}</span>
          </div>
          <div className="mw5-svsh-arrow" aria-hidden="true">↓</div>
          <div className="mw2-svsh-cell mw2-svsh-human">
            <span className="mw2-svsh-label">HUMAN TECHNICAL REVIEW</span>
            <span>
              {pending
                ? 'Authorized reviewer determines the final decision — record it on the Matching Workspace.'
                : `Decision recorded: ${b.systemVsHuman.humanDecision}. Recorded decisions are immutable and audited.`}
            </span>
          </div>
        </div>
      </section>

      {/* ---------------- §7 why this result / rule trace / verdict logic ---------------- */}
      <section aria-label="Why this result — rules and verdict logic">
        <h2 className="mw2-sec-title">WHY THIS RESULT — RULES THAT ACTUALLY APPLIED</h2>
        {criticalConflicts.length > 0 ? (
          <div className="mw5-blocker" role="note">
            <span className="mw5-blocker-tag">PRIMARY BLOCKER</span>
            <span className="mw5-blocker-body">
              <strong>{labelize(criticalConflicts[0].attribute)}</strong> —{' '}
              <span className="mono">{criticalConflicts[0].leftValue ?? '—'}</span> ≠{' '}
              <span className="mono">{criticalConflicts[0].rightValue ?? '—'}</span> · system outcome{' '}
              <strong>{b.headline.verdictLabel}</strong>
            </span>
          </div>
        ) : null}
        <div className="table-wrap">
          <table className="mw2-compare">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Outcome</th>
                <th scope="col">Effect</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {b.ruleTrace.map((r) => (
                <tr key={r.rule}>
                  <th scope="row" className="mw2-cell-attr">{labelize(r.rule)}</th>
                  <td>
                    <span className={`mw2-rel ${r.outcome === 'applied' ? 'mw2-rel-exact' : 'mw2-rel-conflict'}`}>
                      <span aria-hidden="true">{r.outcome === 'applied' ? '✓' : '⚠'}</span>{' '}
                      {r.outcome === 'applied' ? 'APPLIED' : 'EXCLUDED'}
                    </span>
                  </td>
                  <td className="mw5-basis">{r.effect}</td>
                  <td className="mw5-basis mono">{r.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mw2-why">
          <span className="mw5-sec-label">VERDICT LOGIC</span>
          <ul className="mw2-why-bullets">
            {b.verdictLogic.because.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <p className="mw2-why-note">
            Thresholds (prototype configuration): high-confidence ≥ {b.thresholds.highConfidence}, review{' '}
            {b.thresholds.highConfidence - 20}–{b.thresholds.highConfidence - 0.01}, not-a-match &lt;{' '}
            {b.thresholds.highConfidence - 50}. Scores between the not-a-match floor and the review floor are
            LOW_CONFIDENCE (kept for completeness, not queued). Manufacturer: {b.manufacturer.left ?? '—'} vs{' '}
            {b.manufacturer.right ?? '—'} ({b.manufacturer.relationship}) — {b.manufacturer.systemHandling} Category:{' '}
            {b.category.left} vs {b.category.right} — {b.category.result}.
          </p>
        </div>
      </section>

      {/* --------------------------- §9 decision history --------------------------- */}
      <section aria-label="Decision history">
        <h2 className="mw2-sec-title">DECISION HISTORY</h2>
        {b.decisionHistory.length === 0 ? (
          <div className="mw2-history-empty" role="status">
            {pending
              ? 'No human decision recorded yet — this candidate is awaiting authorized technical review. The system assessment above is not a decision.'
              : 'No human decision row recorded for this candidate in the review history.'}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="mw2-history">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Event</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Reason / state</th>
                </tr>
              </thead>
              <tbody>
                {b.decisionHistory.map((d, i) => (
                  <tr key={i}>
                    <td className="mono">{d.decidedAt.replace('T', ' ').slice(0, 16)}</td>
                    <td>
                      <span className="mw2-hist-decision">{d.decision.replace(/_/g, ' ').toUpperCase()}</span>
                    </td>
                    <td>{d.reviewer}</td>
                    <td className="mw2-hist-reason">{d.comment ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --------------------------- §10 harmonization state --------------------------- */}
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
              <p className="mw2-cmi-note">{b.cmi.note}</p>
            </div>
          </div>
        ) : review.cmiState === 'cmi_pending' ? (
          <div className="mw2-cmi mw2-cmi-pending">
            <span className="mw2-cmi-badge mw2-cmi-badge-pending">AWAITING CMI</span>
            <div>
              <p className="mw2-cmi-note">{b.cmi.note}</p>
            </div>
          </div>
        ) : (
          <div className="mw2-cmi mw2-cmi-none" role="status">
            <span className="mw2-cmi-badge mw2-cmi-badge-none">NO COMMON MATERIAL IDENTITY ASSIGNED</span>
            <p className="mw2-cmi-note">
              {b.cmi.note} Common Material Identity is created only through the governed workflow after authorized
              human approval — never automatically, and never from Judge Mode.
            </p>
          </div>
        )}
      </section>

      {/* --------------------------- §11 action bar --------------------------- */}
      <footer className="mw2-queuebar" aria-label="Actions">
        <Link className="mw2-cta mw2-cta-ghost" href={`/matching/${b.candidateId}`}>
          ← BACK TO TECHNICAL COMPARISON
        </Link>
        <Link className="mw2-cta" href="/proposals">
          RETURN TO REVIEW QUEUE
        </Link>
        <Link className="mw2-cta mw2-cta-ghost" href="/cross-reference">
          VIEW CMI REGISTER
        </Link>
        <span className="mw2-queuebar-note">
          {pending
            ? `Decision on candidate #${b.candidateId} is pending — record it on the Matching Workspace.`
            : `Decision on candidate #${b.candidateId} is recorded and immutable; the trail is audited.`}
        </span>
      </footer>

      {/* --------------------------- summary + provenance --------------------------- */}
      <section aria-label="Evidence provenance and conclusion">
        <h2 className="mw2-sec-title">EVIDENCE PROVENANCE</h2>
        <div className="mw5-prov">
          <ul className="mw5-prov-list">
            {b.provenance.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <dl className="mw5-prov-facts">
            <div><dt>Matching (exact) attributes</dt><dd className="num">{b.summary.exactAttributes}</dd></div>
            <div><dt>Normalized attributes</dt><dd className="num">{b.summary.normalizedAttributes}</dd></div>
            <div><dt>Close attributes</dt><dd className="num">{b.summary.closeAttributes}</dd></div>
            <div><dt>Missing attributes</dt><dd className="num">{b.summary.missingAttributes}</dd></div>
            <div><dt>Conflicted attributes</dt><dd className="num">{b.summary.conflictAttributes}</dd></div>
            <div><dt>Critical conflicts</dt><dd className="num">{b.summary.criticalConflicts}</dd></div>
            <div><dt>Final system assessment</dt><dd>{b.summary.finalAssessment.replace(/_/g, ' ')}</dd></div>
            <div><dt>Human review</dt><dd>{b.summary.humanReview.replace(/_/g, ' ')}</dd></div>
          </dl>
        </div>
        <p className="mw2-why-note">
          MaterialIQ assists human technical judgment with deterministic similarity and technical rule analysis. It does
          not replace engineering approval and never certifies equivalence autonomously.
        </p>
      </section>
    </main>
  );
}
