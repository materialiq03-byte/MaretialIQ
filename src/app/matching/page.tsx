import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import {
  listMatches,
  listDistinctMatchManufacturers,
} from '@/lib/db/repositories/matching-repository';
import { listCategories } from '@/lib/db/repositories/material-repository';
import { listOrganizations } from '@/lib/db/repositories/organization-repository';
import { getDb } from '@/lib/db/client';
import { cachedRead, READ_CACHE_TAGS } from '@/lib/cache/read-cache';

/** Short backstop TTL; every mutation route revalidates the tag sooner. */
const DASHBOARD_TTL_SECONDS = 30;
import { getDecisionBands } from '@/lib/services/matching-service';
import { findMaterialIdBySearch } from '@/lib/db/repositories/matching-queries';
import { DECISION_STATES, DECISION_STATE_LABELS } from '@/lib/matching/decision';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/** Badge class + short label per decision state (text label, never color alone). */
function badgeFor(state: string | undefined, band: string | undefined, matchType: string) {
  if (state === 'HIGH_CONFIDENCE_MATCH') return { cls: 'mw-badge-high', label: 'HIGH CONFIDENCE' };
  if (state === 'NEEDS_TECHNICAL_REVIEW') return { cls: 'mw-badge-review', label: 'NEEDS TECHNICAL REVIEW' };
  if (state === 'LOW_CONFIDENCE') return { cls: 'mw-badge-low', label: 'LOW CONFIDENCE' };
  if (state === 'NOT_A_MATCH') return { cls: 'mw-badge-drop', label: 'NOT A MATCH' };
  if (state) return { cls: 'mw-badge-low', label: DECISION_STATE_LABELS[state as keyof typeof DECISION_STATE_LABELS] ?? state };
  if (band === 'high') return { cls: 'mw-badge-high', label: 'HIGH CONFIDENCE' };
  if (band === 'review') return { cls: 'mw-badge-review', label: 'NEEDS TECHNICAL REVIEW' };
  return { cls: 'mw-badge-low', label: matchType.replace(/_/g, ' ').toUpperCase() };
}

export default async function MatchingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('VIEW_MATCHES');
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string).trim() : undefined) || undefined;

  const cpse = get('cpse');
  const category = get('category');
  const decision = get('decision');
  const band = get('band');
  const manufacturer = get('manufacturer');
  const minScore = get('minScore');
  const maxScore = get('maxScore');
  const q = get('q');
  const conflictOnly = get('conflict') === '1';

  // Free-text search resolves to the existing materialId pair filter — the
  // only search primitive the repository supports; nothing new is invented.
  let searchNote: string | null = null;
  let searchMaterialId: number | undefined;
  if (q) {
    const id = findMaterialIdBySearch(q);
    if (id === null) {
      searchNote = `No material found for “${q}” — showing unfiltered results.`;
    } else {
      searchMaterialId = id;
      searchNote = `Filtered to candidate pairs involving “${q}”.`;
    }
  }

  const scope = visibleOrganizationIds(user);
  const orgs = listOrganizations();
  const categories = listCategories();
  const manufacturers = listDistinctMatchManufacturers();
  // PERF: this page renders only the pending decision-state overview from
  // the dashboard metrics bundle — fetch exactly that aggregation instead
  // of the full metrics bundle. Same SQL shape, same rows, same ordering.
  // Match/review metrics are inherently cross-CPSE; scoped users see those
  // involving their organization (same clause the metrics repository uses).
  const matchOrgFilter =
    scope === null
      ? ''
      : ' AND (source_material_id IN (SELECT id FROM material_records WHERE organization_id = ?) OR candidate_material_id IN (SELECT id FROM material_records WHERE organization_id = ?))';
  const matchOrgParams: Array<string | number> = scope === null ? [] : [scope[0] ?? -1, scope[0] ?? -1];
  const matchOverview = await cachedRead(
    ['match-overview', String(scope === null ? 'all' : scope[0] ?? -1)],
    DASHBOARD_TTL_SECONDS,
    [READ_CACHE_TAGS.dashboardMetrics],
    () =>
      (
        getDb()
          .prepare(
            `SELECT COALESCE(json_extract(evidence, '$.decision.state'), 'UNCLASSIFIED') AS decision,
                COUNT(*) AS n
           FROM match_candidates WHERE status = 'pending'${matchOrgFilter}
          GROUP BY decision ORDER BY n DESC, decision`
          )
          .all(...matchOrgParams) as Array<{ decision: string; n: number }>
      ).filter((r) => r.decision !== 'UNCLASSIFIED'),
  );
  const overviewN = new Map(matchOverview.map((m) => [m.decision, m.n]));
  const bands = getDecisionBands();

  const { items, total } = listMatches({
    organizationCode: scope === null ? cpse : orgs.find((o) => o.id === scope[0])?.code,
    category,
    decision,
    confidenceBand: band,
    manufacturer,
    minScore: minScore ? Number(minScore) : undefined,
    maxScore: maxScore ? Number(maxScore) : undefined,
    materialId: searchMaterialId,
    page: 1,
    // Conflicts only occur in the review band, well below the top-score cutoff,
    // so fetch enough rows to make the client-side conflict filter meaningful.
    pageSize: conflictOnly ? 400 : 50,
  });

  // Technical-conflict indicator per row (from stored critical_difference).
  const shown = conflictOnly ? items.filter((m) => m.candidate.critical_difference) : items;
  const overviewFor = (state: string) => overviewN.get(state) ?? 0;

  const fmtScore = (n: number) => `${Math.round(n)}%`;

  return (
    <main className="mw-root">
      {/* Workspace header */}
      <section className="mw-header">
        <div>
          <h1>Matching Workspace</h1>
          <p className="mw-header-sub">
            Discover potential material relationships across CPSE catalogs — similar wording is
            evidence, never proof. Prototype thresholds: high ≥ {bands.highConfidence}%, review ≥{' '}
            {bands.reviewFloor}%, reject &lt; {bands.notAMatch}%.
          </p>
        </div>
        <div className="mw-header-actions">
          <a className="btn mw-btn" href="/proposals?run=1">
            Run Matching
          </a>
          <a className="btn mw-btn mw-btn-ghost" href="/proposals">
            Review Queue →
          </a>
        </div>
      </section>
      <p className="mw-run-note">
        The matcher never auto-approves: every candidate lands in the review queue for a human
        technical decision.
      </p>

      {/* Decision overview tiles (real counts, clickable filters) */}
      <div className="mw-tiles">
        {DECISION_STATES.map((s) => (
          <Link
            key={s}
            href={`/matching?decision=${s}`}
            className={`mw-tile${decision === s ? ' mw-tile-active' : ''}`}
          >
            <span className="mw-tile-n">{overviewFor(s).toLocaleString('en-IN')}</span>
            <span className="mw-tile-label">{DECISION_STATE_LABELS[s]}</span>
          </Link>
        ))}
        <Link href="/matching" className={`mw-tile${!decision ? ' mw-tile-active' : ''}`}>
          <span className="mw-tile-n">{total.toLocaleString('en-IN')}</span>
          <span className="mw-tile-label">Pairs shown (filtered)</span>
        </Link>
      </div>

      {/* Filter / search bar */}
      <form className="mw-filters" method="get">
        <label className="fld mw-fld-search">
          Search
          <input
            type="search"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Material code, description, manufacturer…"
            aria-label="Search materials in candidate pairs"
          />
        </label>
        <label className="fld">
          CPSE
          <select name="cpse" defaultValue={cpse ?? ''} disabled={scope !== null}>
            {scope !== null ? (
              <option value="">{user.organizationCode}</option>
            ) : (
              <>
                <option value="">All CPSEs</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.code}>
                    {o.code}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
        <label className="fld">
          Category
          <select name="category" defaultValue={category ?? ''}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category} ({c.count})
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          Decision
          <select name="decision" defaultValue={decision ?? ''}>
            <option value="">All decisions</option>
            {DECISION_STATES.map((s) => (
              <option key={s} value={s}>
                {DECISION_STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          Confidence
          <select name="band" defaultValue={band ?? ''}>
            <option value="">All bands</option>
            <option value="high">High</option>
            <option value="review">Review</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label className="fld">
          Manufacturer
          <select name="manufacturer" defaultValue={manufacturer ?? ''}>
            <option value="">All manufacturers</option>
            {manufacturers.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="fld mw-fld-narrow">
          Min score
          <input type="number" name="minScore" min={0} max={100} defaultValue={minScore ?? ''} />
        </label>
        <label className="fld mw-fld-narrow">
          Max score
          <input type="number" name="maxScore" min={0} max={100} defaultValue={maxScore ?? ''} />
        </label>
        <label className="mw-check">
          <input type="checkbox" name="conflict" value="1" defaultChecked={conflictOnly} />
          Technical conflicts only
        </label>
        <div className="mw-filter-actions">
          <button type="submit" className="btn mw-btn">
            Apply
          </button>
          <a href="/matching" className="mw-clear">
            Clear
          </a>
        </div>
      </form>
      {searchNote ? <p className="mw-search-note">{searchNote}</p> : null}

      {/* Candidate cards */}
      {shown.length === 0 ? (
        <div className="empty-state">
          No candidate pairs match these filters. Run the matcher from the review queue if the
          catalogue changed.
        </div>
      ) : (
        <div className="mw-cards">
          {shown.map((m) => {
            const ev = safeParse(m.candidate.evidence);
            const state = ev?.decision?.state;
            const bandVal = ev?.decision?.band;
            const badge = badgeFor(state, bandVal, m.candidate.match_type);
            const hasConflict = Boolean(m.candidate.critical_difference);
            return (
              <Link key={m.candidate.id} href={`/matching/${m.candidate.id}`} className="mw-card">
                <div className="mw-card-pair">
                  <div className="mw-card-side">
                    <span className="mw-org">{m.source.org_code}</span>
                    <span className="mw-code">{m.source.original_code}</span>
                    <span className="mw-desc">{m.source.original_description}</span>
                  </div>
                  <span className="mw-card-link" aria-hidden="true">
                    ↔
                  </span>
                  <div className="mw-card-side">
                    <span className="mw-org">{m.candidateMat.org_code}</span>
                    <span className="mw-code">{m.candidateMat.original_code}</span>
                    <span className="mw-desc">{m.candidateMat.original_description}</span>
                  </div>
                </div>
                <div className="mw-card-meta">
                  <span className={`mw-badge ${badge.cls}`}>{badge.label}</span>
                  {hasConflict ? (
                    <span className="mw-conflict-flag" title={m.candidate.critical_difference ?? undefined}>
                      ⚠ Critical conflict
                    </span>
                  ) : null}
                  <span className="mw-scores">
                    <span className="num">S {fmtScore(m.candidate.semantic_score)}</span>
                    <span className="num">F {fmtScore(m.candidate.fuzzy_score)}</span>
                    <span className="num">T {fmtScore(m.candidate.technical_score)}</span>
                    <strong className="num">{fmtScore(m.candidate.final_score)}</strong>
                  </span>
                  <span className="mw-compare-cta">Compare →</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}

function safeParse(json: string | null): { decision?: { state?: string; band?: string } } | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed?.decision === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
