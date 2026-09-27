import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { roleHasPermission } from '@/lib/auth/permissions';
import { listMatches, getApprovalCmiFunnel, parseReviewSort } from '@/lib/db/repositories/matching-repository';
import { getReviewSummary } from '@/lib/services/match-review-service';
import { listOrganizations, getOrganization } from '@/lib/db/repositories/organization-repository';
import ProposalCard from './proposal-card';
import CreateCmiAction from './create-cmi-action';

export const dynamic = 'force-dynamic';

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('VIEW_MATCHES');
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const status = get('status')?.trim() || undefined;
  const matchType = get('matchType')?.trim() || undefined;
  const cpse = get('cpse')?.trim() || undefined;
  const cmiStateRaw = get('cmiState')?.trim();
  const cmiState = cmiStateRaw === 'cmi_created' || cmiStateRaw === 'cmi_pending' ? cmiStateRaw : undefined;
  const band = get('band')?.trim() || undefined;
  const conflictOnly = get('conflict') === '1' ? true : undefined;
  const category = get('category')?.trim() || undefined;
  const sort = parseReviewSort(get('sort'));
  const run = get('run');
  const PAGE_SIZE = 100;
  const rawPage = Number.parseInt(get('page') ?? '1', 10);
  const requestedPage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  let matches: ReturnType<typeof listMatches>['items'];
  let total = 0;
  let page = 1;
  let pages = 1;
  let orgs: ReturnType<typeof listOrganizations>;
  let funnel: ReturnType<typeof getApprovalCmiFunnel> | null = null;
  let summary: ReturnType<typeof getReviewSummary> | null = null;
  let loadError: string | null = null;
  try {
    if (run === '1') {
      // Step-4 job model: the run executes in bounded chunks outside the
      // request lifecycle (single-active-run guarded). The page renders the
      // current state immediately; completed results appear on refresh.
      const { createAndStartMatchingJob } = await import('@/lib/services/matching-job-service');
      createAndStartMatchingJob('review-console');
    }
    const scope = visibleOrganizationIds(user);
    const result = listMatches({
      status: status as never,
      matchType: matchType as never,
      organizationCode: scope === null ? cpse : getOrganization(scope[0])?.code,
      cmiState,
      confidenceBand: band,
      hasCriticalConflicts: conflictOnly,
      category,
      sort,
      page: requestedPage,
      pageSize: PAGE_SIZE,
    });
    matches = result.items;
    total = result.total;
    pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    page = Math.min(requestedPage, pages);
    orgs = listOrganizations();
    funnel = getApprovalCmiFunnel();
    summary = getReviewSummary();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    matches = [];
    orgs = [];
  }

  /** Pagination link preserving the active filters (never carries run=1). */
  const pageHref = (p: number) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (matchType) qs.set('matchType', matchType);
    if (cpse) qs.set('cpse', cpse);
    if (cmiState) qs.set('cmiState', cmiState);
    if (band) qs.set('band', band);
    if (conflictOnly) qs.set('conflict', '1');
    if (category) qs.set('category', category);
    if (sort !== 'score_desc') qs.set('sort', sort);
    if (p > 1) qs.set('page', String(p));
    const s = qs.toString();
    return s ? `/proposals?${s}` : '/proposals';
  };
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  if (loadError) {
    return (
      <main>
        <h1>Review Queue</h1>
        <div className="error-box">Failed to load proposals: {loadError}</div>
      </main>
    );
  }

  return (
    <main>
      <h1>Technical Review Queue</h1>
      <p className="subtitle">
        Candidates requiring authorized technical validation — {total} candidate pair{total === 1 ? '' : 's'} match
        these filters{total > PAGE_SIZE ? ` — showing ${from}–${to} (page ${page} of ${pages})` : ''}. Open a row to
        see both records, the computed evidence and the reasoning. Decisions are final for pending items and fully
        audited.
      </p>

      {summary ? (
        <div className="hq-kpis" role="status" aria-label="Review summary">
          <div className="hq-kpi">
            <span className="hq-kpi-value num">{summary.openReviews}</span>
            <span className="hq-kpi-label">Open reviews</span>
          </div>
          <div className="hq-kpi">
            <span className="hq-kpi-value num">{summary.highConfidence}</span>
            <span className="hq-kpi-label">High-confidence (pending)</span>
          </div>
          <div className="hq-kpi">
            <span className="hq-kpi-value num">{summary.technicalConflicts}</span>
            <span className="hq-kpi-label">Critical conflicts</span>
          </div>
          <div className="hq-kpi">
            <span className="hq-kpi-value num">{summary.missingCriticalEvidence}</span>
            <span className="hq-kpi-label">Missing critical evidence</span>
          </div>
          <div className="hq-kpi">
            <span className="hq-kpi-value num">{summary.assemblyDifferences}</span>
            <span className="hq-kpi-label">Assembly differences</span>
          </div>
          <div className="hq-kpi">
            <span className="hq-kpi-value num">{summary.crossBrand}</span>
            <span className="hq-kpi-label">Cross-brand reviews</span>
          </div>
        </div>
      ) : null}

      {funnel ? (
        <div className="filterbar" role="status" aria-label="Approved CMI funnel">
          <span>
            APPROVED RELATIONSHIPS <strong>{funnel.approvedTotal}</strong>
          </span>
          <span>
            AWAITING CMI{' '}
            <a href="/proposals?status=approved&cmiState=cmi_pending">
              <strong>{funnel.awaitingCmi}</strong>
            </a>
          </span>
          <span>
            CMI CREATED{' '}
            <a href="/proposals?status=approved&cmiState=cmi_created">
              <strong>{funnel.cmiCreated}</strong>
            </a>
          </span>
        </div>
      ) : null}

      <form className="filterbar" method="get">
        <label className="fld">
          Status
          <select name="status" defaultValue={status ?? ''}>
            <option value="">All statuses</option>
            <option value="pending">Open — pending review</option>
            <option value="approved">Decision recorded — approved</option>
            <option value="rejected">Decision recorded — rejected</option>
            <option value="deferred">Decision recorded — deferred</option>
          </select>
        </label>
        <label className="fld">
          Classification
          <select name="matchType" defaultValue={matchType ?? ''}>
            <option value="">All types</option>
            <option value="identical">Identical</option>
            <option value="near_duplicate">Near duplicate</option>
            <option value="functional_equivalent">Functional equivalent</option>
            <option value="needs_review">Needs review</option>
            <option value="different">Different</option>
          </select>
        </label>
        <label className="fld">
          CMI state
          <select name="cmiState" defaultValue={cmiState ?? ''}>
            <option value="">All</option>
            <option value="cmi_pending">Approved — CMI pending</option>
            <option value="cmi_created">Approved — CMI created</option>
          </select>
        </label>
        <label className="fld">
          Verdict band
          <select name="band" defaultValue={band ?? ''}>
            <option value="">All verdicts</option>
            <option value="high">High-confidence match</option>
            <option value="review">Needs technical review</option>
            <option value="low">Low confidence</option>
            <option value="reject">Not a match</option>
          </select>
        </label>
        <label className="fld">
          Risk
          <select name="conflict" defaultValue={conflictOnly ? '1' : ''}>
            <option value="">All candidates</option>
            <option value="1">Critical conflict only</option>
          </select>
        </label>
        <label className="fld">
          Category
          <select name="category" defaultValue={category ?? ''}>
            <option value="">All categories</option>
            <option>Bearings</option>
            <option>Valves</option>
            <option>Motors</option>
            <option>Pumps</option>
            <option>Fasteners</option>
          </select>
        </label>
        <label className="fld">
          Sort
          <select name="sort" defaultValue={sort}>
            <option value="score_desc">Highest score</option>
            <option value="score_asc">Lowest score</option>
            <option value="priority">Priority (high first)</option>
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
          </select>
        </label>
        <label className="fld">
          CPSE
          <select
            name="cpse"
            defaultValue={cpse ?? ''}
            disabled={visibleOrganizationIds(user) !== null}
          >
            {visibleOrganizationIds(user) !== null ? (
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
        <button type="submit">Apply</button>
        <a href="/proposals">Clear</a>
        <a className="btn" href="/proposals?run=1">
          Run matcher
        </a>
      </form>

      {matches.length === 0 ? (
        <div className="empty-state">
          No match candidates for these filters. Use “Run matcher” to compare cross-CPSE records.
        </div>
      ) : (
        matches.map((m) => {
          const eligibleForCmi = m.cmiState === 'cmi_pending';
          const suggestedCode = `CMI-${(m.source.category || 'COMMON').toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 12)}-${(
            m.source.original_code || 'MAT'
          )
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '')
            .slice(0, 14)}`;
          return (
            <div key={m.candidate.id}>
              <ProposalCard match={m} />
              {eligibleForCmi ? (
                <div className="cmi-slot">
                  <CreateCmiAction
                    canCreate={roleHasPermission(user.role, 'CREATE_COMMON_IDENTITY')}
                    spec={{
                      matchId: m.candidate.id,
                      suggestedCode,
                      suggestedName: `Common identity: ${m.source.original_description}`,
                      category: m.source.category,
                      source: { org: m.source.org_code, code: m.source.original_code },
                      candidate: { org: m.candidateMat.org_code, code: m.candidateMat.original_code },
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })
      )}

      {pages > 1 ? (
        <div className="pagination">
          {page > 1 ? (
            <a className="btn" href={pageHref(page - 1)}>
              ← Previous
            </a>
          ) : (
            <span className="btn" style={{ opacity: 0.5, pointerEvents: 'none' }}>
              ← Previous
            </span>
          )}
          <span>
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <a className="btn" href={pageHref(page + 1)}>
              Next →
            </a>
          ) : (
            <span className="btn" style={{ opacity: 0.5, pointerEvents: 'none' }}>
              Next →
            </span>
          )}
        </div>
      ) : null}
    </main>
  );
}
