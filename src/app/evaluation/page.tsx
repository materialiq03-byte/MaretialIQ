import { requirePermission } from '@/lib/auth/guard';
import {
  evaluateGroundTruth,
  EVAL_LABELS,
  MIN_PAIRS_FOR_CATEGORY_METRICS,
  type EvalLabel,
  type GroundTruthPairRecord,
} from '@/lib/matching/ground-truth';
import { loadRunHistory, validateRunRecord, currentBuildId } from '@/lib/matching/run-history';
import { DECISION_STATE_LABELS, type DecisionState } from '@/lib/matching/decision';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Evaluation — MaterialIQ' };
export const dynamic = 'force-dynamic';

const LABELS: EvalLabel[] = ['MATCH', 'NEEDS_REVIEW', 'NOT_A_MATCH'];

const CLASS_TONE: Record<EvalLabel, string> = {
  MATCH: 'approved',
  NEEDS_REVIEW: 'pending',
  NOT_A_MATCH: 'rejected',
};

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function DecisionLabel({ d }: { d: string }) {
  return <>{(DECISION_STATE_LABELS as Record<string, string>)[d as DecisionState] ?? d}</>;
}

/** One labelled pair with its engine evidence — used for the FP/FN lists. */
function PairRow({ r }: { r: GroundTruthPairRecord }) {
  return (
    <tr>
      <td className="mono">{r.a}</td>
      <td className="mono">{r.b}</td>
      <td>{r.category}</td>
      <td>
        <span className={`badge ${CLASS_TONE[r.groundTruth]}`}>{r.groundTruth}</span>
      </td>
      <td>
        <span className={`badge ${CLASS_TONE[r.modelClass]}`}>{r.modelClass}</span>
        <span className="evidence-detail"> · {r.modelScore}%</span>
      </td>
      <td className="evidence-detail">
        {r.criticalConflicts.length > 0 ? `conflict: ${r.criticalConflicts.join('; ')}` : null}
        {r.missingCritical.length > 0 ? `${r.criticalConflicts.length > 0 ? ' · ' : ''}missing: ${r.missingCritical.join(', ')}` : null}
        {r.criticalConflicts.length === 0 && r.missingCritical.length === 0 ? <DecisionLabel d={r.modelDecision} /> : null}
      </td>
    </tr>
  );
}

export default async function EvaluationPage() {
  await requirePermission('VIEW_ANALYTICS');
  // Computed live from the labelled dataset + the real pipeline — the exact
  // numbers a re-run of `npm run evaluate` produces.
  const ev = evaluateGroundTruth();
  // Permanent run history (current run first as "current", then prior runs).
  const history = loadRunHistory().slice().reverse();
  const historyProblems = history.flatMap((r) => validateRunRecord(r));

  return (
    <main>
      <h1>Model &amp; Matching Evaluation</h1>
      <p className="subtitle">
        Engineering validation console — dataset <strong>{ev.dataset.name} v{ev.dataset.version}</strong> ({ev.dataset.file}),{' '}
        {ev.dataset.pairs} hand-labelled cross-CPSE pairs, labelled from each record&apos;s technical attributes, never from
        engine output. Every pair is scored through the same pipeline the product runs.
      </p>

      <div className="error-box" role="note">
        <strong>How to read these numbers.</strong> This prototype is evaluated against a labelled synthetic ground-truth
        dataset. Metrics represent prototype evaluation results on this dataset and should not be interpreted as production
        accuracy. Synthetic evaluation does not prove real-world CPSE performance.
      </div>

      <div className="stat-grid">
        <div className="stat"><span className="value">{ev.evaluatedPairs}</span><span className="label">Labelled pairs evaluated</span></div>
        <div className="stat"><span className="value">{ev.labelCounts.MATCH}</span><span className="label">Ground truth: MATCH</span></div>
        <div className="stat"><span className="value">{ev.labelCounts.NEEDS_REVIEW}</span><span className="label">Ground truth: NEEDS_REVIEW</span></div>
        <div className="stat"><span className="value">{ev.labelCounts.NOT_A_MATCH}</span><span className="label">Ground truth: NOT_A_MATCH</span></div>
      </div>

      <h2>Confusion matrix</h2>
      <p className="subtitle">Rows are ground-truth labels, columns are the engine&apos;s 3-class prediction
        (HIGH_CONFIDENCE_MATCH → MATCH; NEEDS_TECHNICAL_REVIEW / LOW_CONFIDENCE → NEEDS_REVIEW; NOT_A_MATCH → NOT_A_MATCH).</p>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ground truth \ Predicted</th>
            {LABELS.map((l) => <th key={l} className="num">{l}</th>)}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {LABELS.map((gt) => (
            <tr key={gt}>
              <td><strong>{gt}</strong></td>
              {LABELS.map((pred) => (
                <td key={pred} className={`num ${gt === pred ? 'strong-cell' : ''}`}>
                  {ev.confusion[gt][pred]}
                </td>
              ))}
              <td className="num">{ev.labelCounts[gt]}</td>
            </tr>
          ))}
          <tr>
            <td><strong>Predicted total</strong></td>
            {LABELS.map((pred) => <td key={pred} className="num">{ev.predictionCounts[pred]}</td>)}
            <td className="num">{ev.evaluatedPairs}</td>
          </tr>
        </tbody>
      </table>
      </div>

      <h2>Precision / Recall / F1</h2>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Class</th>
            <th className="num">Support</th>
            <th className="num">Precision</th>
            <th className="num">Recall</th>
            <th className="num">F1</th>
            <th>Reading</th>
          </tr>
        </thead>
        <tbody>
          {LABELS.map((l) => {
            const c = ev.perClass[l];
            return (
              <tr key={l}>
                <td>{l}</td>
                <td className="num">{c.support}</td>
                <td className="num">{c.precision.toFixed(4)}</td>
                <td className="num">{c.recall.toFixed(4)}</td>
                <td className="num">{c.f1.toFixed(4)}</td>
                <td className="evidence-detail">
                  {l === 'MATCH' ? 'How many auto-approved pairs truly are the same item (precision) and how many true duplicates were auto-approved (recall).' : null}
                  {l === 'NEEDS_REVIEW' ? 'High recall here is the fail-safe behaviour: pairs needing human judgement are surfaced, not auto-decided.' : null}
                  {l === 'NOT_A_MATCH' ? 'High precision = the engine never auto-approves a labelled non-match; lower recall = dissimilar pairs land in review instead.' : null}
                </td>
              </tr>
            );
          })}
          <tr>
            <td><strong>Macro average</strong></td>
            <td className="num">{ev.evaluatedPairs}</td>
            <td className="num">{ev.macro.precision.toFixed(4)}</td>
            <td className="num">{ev.macro.recall.toFixed(4)}</td>
            <td className="num">{ev.macro.f1.toFixed(4)}</td>
            <td className="evidence-detail">Unweighted mean over the classes present in the dataset.</td>
          </tr>
          <tr>
            <td><strong>Weighted average</strong></td>
            <td className="num">{ev.evaluatedPairs}</td>
            <td className="num">{ev.weighted.precision.toFixed(4)}</td>
            <td className="num">{ev.weighted.recall.toFixed(4)}</td>
            <td className="num">{ev.weighted.f1.toFixed(4)}</td>
            <td className="evidence-detail">Support-weighted; dominated by the larger classes.</td>
          </tr>
          <tr>
            <td><strong>Accuracy</strong></td>
            <td className="num">{ev.evaluatedPairs}</td>
            <td className="num">{ev.accuracy.toFixed(4)}</td>
            <td className="num" />
            <td className="num" />
            <td className="evidence-detail">Diagonal / total.</td>
          </tr>
        </tbody>
      </table>
      </div>

      <div className="stat-grid">
        <div className="stat"><span className="value">{pct(ev.reviewRate)}</span><span className="label">Review rate (pairs routed to human review)</span></div>
        <div className="stat"><span className="value">{ev.conflictDetection.detected}/{ev.conflictDetection.expected}</span><span className="label">Critical conflicts detected ({pct(ev.conflictDetection.detectionRate)})</span></div>
        <div className="stat"><span className="value">{ev.falsePositives.length}</span><span className="label">False positives (wrongly auto-approved)</span></div>
        <div className="stat"><span className="value">{ev.falseNegatives.length}</span><span className="label">False negatives (missed auto-matches)</span></div>
      </div>

      <h2>Technical-conflict detection</h2>
      <p className="subtitle">
        {ev.conflictDetection.expected} pairs declare which attribute the evidence <em>must</em> name (2RS vs ZZ, Class 150 vs 300,
        415V vs 230V, nut vs stud, series 6205 vs 6310, …).
      </p>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th className="num">Detected</th>
            <th className="num">Detection rate</th>
          </tr>
        </thead>
        <tbody>
          {ev.conflictDetection.previousBaseline ? (
            <tr>
              <td>Previous ({ev.conflictDetection.previousBaseline.note})</td>
              <td className="num">{ev.conflictDetection.previousBaseline.detected}/{ev.conflictDetection.previousBaseline.expected}</td>
              <td className="num">{pct(ev.conflictDetection.previousBaseline.detected / ev.conflictDetection.previousBaseline.expected)}</td>
            </tr>
          ) : null}
          <tr>
            <td><strong>Current engine</strong></td>
            <td className="num"><strong>{ev.conflictDetection.detected}/{ev.conflictDetection.expected}</strong></td>
            <td className="num"><strong>{pct(ev.conflictDetection.detectionRate)}</strong></td>
          </tr>
        </tbody>
      </table>
      </div>
      <p className="subtitle">
        Attribute-aware technical comparison was introduced to prevent product-series identifiers from being treated as ordinary
        continuous measurements.
        {ev.conflictDetection.missed.length > 0
          ? ` Missed now: ${ev.conflictDetection.missed.map((m) => `${m.a} ↔ ${m.b} (${m.attribute}${m.kind === 'missing' ? ', missing-side' : ''})`).join('; ')}.`
          : ' No declared conflict was missed by the current engine.'}
      </p>

      <h2>Review-rate tradeoff</h2>
      <p className="subtitle">
        {pct(ev.reviewRate)} of evaluated pairs are routed to NEEDS_TECHNICAL_REVIEW. A higher review rate reduces the risk of
        automatic false matches but increases reviewer workload; a lower rate does the opposite. Neither extreme is
        automatically &quot;good&quot; — the split is a product decision, which is why conflicting or under-specified pairs are
        never auto-approved in this prototype.
      </p>

      <h2>Score distribution</h2>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Predicted class</th>
            <th className="num">Pairs</th>
            <th className="num">Score min</th>
            <th className="num">Score max</th>
          </tr>
        </thead>
        <tbody>
          {LABELS.map((l) => {
            const range = ev.scoreRanges[l];
            return (
              <tr key={l}>
                <td>{l}</td>
                <td className="num">{ev.predictionCounts[l]}</td>
                <td className="num">{range ? range.min : '—'}</td>
                <td className="num">{range ? range.max : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      <p className="subtitle">
        {ev.scoreOverlap.length > 0
          ? `Limitation: predicted-class score ranges overlap for ${ev.scoreOverlap.map(([a, b]) => `${a} ↔ ${b}`).join(' and ')} — the combined score alone does not separate those classes; the decision layer (conflicts, missing criticals, manufacturer rule) does the separation.`
          : 'Score ranges are disjoint across predicted classes on this dataset.'}
      </p>

      <h2>Category breakdown</h2>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th className="num">Pairs</th>
            {LABELS.map((l) => <th key={l} className="num">{l}</th>)}
            <th className="num">Label agreement</th>
          </tr>
        </thead>
        <tbody>
          {ev.categoryBreakdown.map((c) => (
            <tr key={c.category}>
              <td>
                {c.category}
                {!c.sufficientSample ? <span className="evidence-detail"> · small sample (&lt;{MIN_PAIRS_FOR_CATEGORY_METRICS})</span> : null}
              </td>
              <td className="num">{c.pairs}</td>
              {LABELS.map((l) => <td key={l} className="num">{c.predicted[l]}</td>)}
              <td className="num">{pct(c.agreement)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p className="subtitle">
        Category metrics are shown only where the sample supports them ({MIN_PAIRS_FOR_CATEGORY_METRICS}+ pairs). Categories below
        the threshold are listed for completeness but their agreement numbers are not meaningful on their own.
      </p>

      <h2>False positives ({ev.falsePositives.length})</h2>
      {ev.falsePositives.length === 0 ? (
        <p className="subtitle">
          None on this dataset — no labelled NEEDS_REVIEW / NOT_A_MATCH pair was auto-approved.
          {ev.conflictDetection.previousBaseline?.assemblyAware ? (
            <> The one former false positive (a bolt vs the same bolt offered <strong>WITH NUT</strong>) was an assembly/kit variant: the descriptions were similar, but one material represented an assembly configuration. Assembly/kit awareness now routes such pairs to technical review instead of automatically treating them as equivalent.</>
          ) : null}
        </p>
      ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Material A</th><th>Material B</th><th>Category</th><th>Ground truth</th><th>Prediction</th><th>Why</th></tr>
          </thead>
          <tbody>
            {ev.falsePositives.map((r, i) => <PairRow key={i} r={r} />)}
          </tbody>
        </table>
        </div>
      )}
      {ev.falsePositives.length > 0 ? (
        <p className="subtitle">
          {ev.falsePositives.map((r) => `${r.a} ↔ ${r.b}: ${r.rationale}`).join(' ')}
        </p>
      ) : null}

      <h2>False negatives ({ev.falseNegatives.length})</h2>
      {ev.falseNegatives.length === 0 ? (
        <p className="subtitle">None — every labelled MATCH pair was auto-approved.</p>
      ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Material A</th><th>Material B</th><th>Category</th><th>Ground truth</th><th>Prediction</th><th>Why</th></tr>
          </thead>
          <tbody>
            {ev.falseNegatives.map((r, i) => <PairRow key={i} r={r} />)}
          </tbody>
        </table>
        </div>
      )}
      {ev.falseNegatives.length > 0 ? (
        <p className="subtitle">
          {ev.falseNegatives.map((r) => `${r.a} ↔ ${r.b}: ${r.rationale}`).join(' ')}
        </p>
      ) : null}

      <h2>Run history</h2>
      {history.length === 0 ? (
        <p className="subtitle">No recorded runs yet — run <code>npm run evaluate</code> to append the first one.</p>
      ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Timestamp (UTC)</th>
              <th className="num">Pairs</th>
              <th className="num">Accuracy</th>
              <th className="num">Macro F1</th>
              <th className="num">Weighted F1</th>
              <th className="num">Conflicts</th>
              <th className="num">FP</th>
              <th className="num">FN</th>
              <th>Build / config</th>
            </tr>
          </thead>
          <tbody>
            {history.map((r, i) => (
              <tr key={r.runId} style={i === history.length - 1 ? { fontWeight: 600 } : undefined}>
                <td className="mono">{r.runId}</td>
                <td>{r.timestamp.slice(0, 16).replace('T', ' ')}</td>
                <td className="num">{r.pairs}</td>
                <td className="num">{r.accuracy.toFixed(2)}</td>
                <td className="num">{r.macroF1.toFixed(4)}</td>
                <td className="num">{r.weightedF1.toFixed(4)}</td>
                <td className="num">
                  {r.conflictDetection.detected}/{r.conflictDetection.expected}
                </td>
                <td className="num">{r.falsePositives}</td>
                <td className="num">{r.falseNegatives}</td>
                <td>{r.buildId}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <p className="subtitle">
        Every <code>npm run evaluate</code> appends an immutable record (run ID, timestamp, dataset, metrics, confusion matrix,
        matcher configuration, build identifier) to the <code>evaluation_runs</code> table with a JSON mirror at <code>data/evaluation/run-history.json</code> — previous runs are never
        overwritten, so metric changes can always be traced to the matcher configuration that produced them. Current engine
        build: <code>{currentBuildId()}</code>.
      </p>
      {historyProblems.length > 0 ? (
        <div className="error-box" role="alert">
          <strong>Run-history consistency warning.</strong> {historyProblems.join(' · ')}
        </div>
      ) : null}

      <h2>Label definitions</h2>
      <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Label</th><th>Meaning (ground truth is the human/technical reference; the model output is separate)</th></tr>
        </thead>
        <tbody>
          {LABELS.map((l) => (
            <tr key={l}>
              <td><strong>{l}</strong></td>
              <td>{ev.vocabulary[l]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <h2>Reproducibility</h2>
      <p className="subtitle">
        Dataset: <code>data/evaluation/ground-truth-pairs.json</code>; per-CPSE record fixtures:{' '}
        <code>data/evaluation/fixtures/*.csv</code>; runner: <code>npm run evaluate</code> (writes{' '}
        <code>.freebuff/evaluation-report.json</code>); tests: <code>tests/evaluation.test.ts</code> rebuild the dataset in a
        disposable database and assert identical metrics. Re-running the evaluation yields the same numbers unless the matching
        engine or the dataset changes.
      </p>
    </main>
  );
}

