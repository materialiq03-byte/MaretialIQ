import { requirePermission } from '@/lib/auth/guard';
import { getAnalytics } from '@/lib/services/analytics-service';
import { evaluateAgainstGroundTruth } from '@/lib/matching/evaluation';
import { DECISION_STATE_LABELS, type DecisionState } from '@/lib/matching/decision';
import type { Metadata } from 'next';
import { DecisionPie, CategoryBar, CpseBar, ConflictBar } from './charts';

export const metadata: Metadata = { title: 'Analytics — MaterialIQ' };
export const dynamic = 'force-dynamic';

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export default async function AnalyticsPage() {
  await requirePermission('VIEW_ANALYTICS');
  const data = getAnalytics();
  // Matcher-quality metrics against the labelled synthetic ground truth
  // (PRD §15). Computed from the same engine the candidates came from.
  const ev = evaluateAgainstGroundTruth();

  const decisionLabel = (d: string): string =>
    (DECISION_STATE_LABELS as Record<string, string>)[d as DecisionState] ?? d;

  return (
    <main>
      <h1>Analytics</h1>
      <p className="subtitle">
        Cross-CPSE harmonization intelligence derived live from the database (FR-16). All figures
        are SQL aggregates over <code>data/materialiq.db</code> — synthetic demo data, not official
        CPSE data.
      </p>

      <div className="stat-grid">
        <div className="stat"><span className="value">{data.cmis}</span><span className="label">Common identities</span></div>
        <div className="stat"><span className="value">{data.mappings}</span><span className="label">Legacy mappings</span></div>
        <div className="stat"><span className="value">{data.importsTotal}</span><span className="label">Imports</span></div>
        <div className="stat"><span className="value">{data.importsRejectedRows}</span><span className="label">Rejected rows (validation)</span></div>
      </div>

      <div className="chart-grid">
        <DecisionPie data={data.decisions.map((d) => ({ ...d, decision: decisionLabel(d.decision) }))} />
        <CategoryBar data={data.materialsByCategory} />
        <CpseBar data={data.materialsByOrg} />
        <ConflictBar data={data.topConflicts} />
      </div>

      <h2>Matcher quality — labelled ground truth (PRD §15)</h2>
      <p className="subtitle">
        The synthetic dataset was authored with known same-item groups and known conflicting
        variants. The engine is scored on whether its decisions agree with those labels. A conflict
        pair routed to human review counts as correctly caught — the engine must not auto-approve it.
      </p>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th className="num">Value</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Evaluated labelled pairs</td>
            <td className="num">{ev.evaluatedPairs}</td>
            <td>{ev.positives} positive (same item &amp; brand) · {ev.negatives} negative (conflict / different item)</td>
          </tr>
          <tr>
            <td>Precision</td>
            <td className="num"><strong>{pct(ev.precision)}</strong></td>
            <td>Of pairs auto-matched HIGH_CONFIDENCE, share that truly are the same item</td>
          </tr>
          <tr>
            <td>Recall</td>
            <td className="num"><strong>{pct(ev.recall)}</strong></td>
            <td>Of true same-item pairs, share found as high-confidence candidates</td>
          </tr>
          <tr>
            <td>F1 score</td>
            <td className="num"><strong>{pct(ev.f1)}</strong></td>
            <td>Harmonic mean of precision and recall</td>
          </tr>
          <tr>
            <td>Human-review rate</td>
            <td className="num">{pct(ev.humanReviewRate)}</td>
            <td>Share of labelled pairs routed to NEEDS_TECHNICAL_REVIEW</td>
          </tr>
          <tr>
            <td>Conflicts caught (fail-safe)</td>
            <td className="num">{ev.conflictsCaught}/{ev.negatives}</td>
            <td>Labelled conflict pairs NOT auto-approved — the core safety metric</td>
          </tr>
          <tr>
            <td>Unsafe auto-matches</td>
            <td className="num"><strong>{ev.unsafeAutoMatches}</strong></td>
            <td>Labelled conflicts the engine wrongly auto-approved (target: 0)</td>
          </tr>
        </tbody>
      </table>
      </div>

      <h2>Per-CPSE harmonization snapshot</h2>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>CPSE</th>
            <th className="num">Materials</th>
            <th className="num">Candidate pairs</th>
            <th className="num">High-confidence</th>
            <th className="num">Open reviews</th>
          </tr>
        </thead>
        <tbody>
          {data.cpseTable.map((r) => (
            <tr key={r.code}>
              <td>{r.code}</td>
              <td className="num">{r.materials}</td>
              <td className="num">{r.candidates}</td>
              <td className="num">{r.highConfidence}</td>
              <td className="num">{r.pendingReviews}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <h2>Match-type classification distribution</h2>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Classification</th>
            <th className="num">Candidates</th>
          </tr>
        </thead>
        <tbody>
          {data.matchTypes.map((r) => (
            <tr key={r.match_type}>
              <td>{r.match_type}</td>
              <td className="num">{r.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <p className="subtitle" style={{ marginTop: 24 }}>
        Matcher-quality figures are computed against the synthetic ground truth in
        <code> data/synthetic-imports/</code> and reflect prototype thresholds — not an official
        standard. Common Material Identity is a prototype construct, not an official national code.
      </p>
    </main>
  );
}
