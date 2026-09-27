import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import {
  listOpportunities,
  detectProcurementOpportunities,
} from '@/lib/services/procurement-opportunity-service';
import { listOrganizations } from '@/lib/db/repositories/organization-repository';
import type { Metadata } from 'next';
import type { OpportunityStatus, OpportunityType } from '@/lib/types/domain';

export const metadata: Metadata = { title: 'Procurement Opportunities — MaterialIQ' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const TYPE_LABELS: Record<string, string> = {
  CROSS_CPSE_DEMAND: 'Cross-CPSE demand',
  REPEATED_PROCUREMENT: 'Repeated procurement',
  FRAGMENTED_DEMAND: 'Fragmented demand',
  UNHARMONIZED_RELATED_PROCUREMENT: 'Unharmonized procurement',
  MULTI_SUPPLIER_ACTIVITY: 'Multi-supplier activity',
  HIGH_PROCUREMENT_ACTIVITY: 'High activity',
};

const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  DISMISSED: 'Dismissed',
  RESOLVED: 'Resolved',
};

/**
 * Step 15 - procurement opportunities console. Descriptive, explainable
 * signals derived from representative synthetic procurement history; every
 * signal requires human review. Prototype common material identity - not an
 * official national material code.
 */
export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('VIEW_MAPPINGS');
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const typeParam = get('type') as OpportunityType | undefined;
  const statusParam = get('status') as OpportunityStatus | undefined;
  const orgParam = get('cpse');
  const cmiParam = get('cmi');
  const runParam = get('detect') === '1';

  const orgs = listOrganizations().map((o) => ({ ...o }));
  const scope = visibleOrganizationIds(user);
  const organizationId = scope !== null ? scope[0] : orgParam ? Number(orgParam) : undefined;

  let summary: ReturnType<typeof detectProcurementOpportunities> | null = null;
  let items: ReturnType<typeof listOpportunities>['items'] = [];
  let total = 0;
  let loadError: string | null = null;
  try {
    if (runParam) {
      summary = detectProcurementOpportunities();
    }
    const r = listOpportunities(
      {
        type: typeParam,
        status: statusParam,
        organizationId,
        cmiId: cmiParam ? Number(cmiParam) : undefined,
      },
      1,
      200
    );
    items = r.items;
    total = r.total;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const openCount = items.filter((i) => i.status === 'OPEN').length;
  const byType = (t: OpportunityType) => items.filter((i) => i.opportunity_type === t).length;

  const qs = new URLSearchParams();
  if (typeParam) qs.set('type', typeParam);
  if (statusParam) qs.set('status', statusParam);
  if (orgParam) qs.set('cpse', orgParam);
  if (cmiParam) qs.set('cmi', cmiParam);
  const baseQs = qs.toString();
  const href = (patch: Record<string, string>) => {
    const q = new URLSearchParams(baseQs);
    for (const [k, v] of Object.entries(patch)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    q.delete('detect');
    const st = q.toString();
    return st ? '/procurement/opportunities?' + st : '/procurement/opportunities';
  };

  if (loadError) {
    return (
      <main>
        <h1>Procurement Opportunities</h1>
        <div className="error-box">Failed to load opportunities: {loadError}</div>
      </main>
    );
  }

  return (
    <main>
      <h1>Procurement Opportunities</h1>
      <p className="subtitle">
        Opportunity signals are derived from representative synthetic procurement history and require
        human review. An opportunity is an observed pattern worth investigating — never a purchasing
        instruction. Quantities aggregate per UOM only; spend per currency.
      </p>

      <div className="decision-row">
        <a className="btn primary" href={'/procurement/opportunities?detect=1' + (baseQs ? '&' + baseQs : '')}>
          Run detection
        </a>
        {summary && (
          <span>
            Detection complete: {summary.created} new, {summary.refreshed} refreshed, {summary.totalOpen} open.
          </span>
        )}
      </div>

      <div className="hq-kpis">
        <div className="hq-kpi">
          <div className="hq-kpi-value">{openCount}</div>
          <div className="hq-kpi-label">Open signals</div>
          <div className="hq-kpi-context">{total} total in current filter</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{byType('CROSS_CPSE_DEMAND')}</div>
          <div className="hq-kpi-label">Cross-CPSE demand</div>
          <div className="hq-kpi-context">Same CMI purchased by 2+ CPSEs</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{byType('UNHARMONIZED_RELATED_PROCUREMENT')}</div>
          <div className="hq-kpi-label">Unharmonized signals</div>
          <div className="hq-kpi-context">Material-master review suggested</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{byType('REPEATED_PROCUREMENT')}</div>
          <div className="hq-kpi-label">Repeated procurement</div>
          <div className="hq-kpi-context">2+ records on 2+ distinct dates</div>
        </div>
      </div>

      <form className="filterbar" method="get">
        <label className="fld">
          Type
          <select name="type" defaultValue={typeParam ?? ''}>
            <option value="">All types</option>
            {Object.entries(TYPE_LABELS).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </label>
        <label className="fld">
          Status
          <select name="status" defaultValue={statusParam ?? ''}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </label>
        <label className="fld">
          CPSE
          <select name="cpse" defaultValue={orgParam ?? ''} disabled={scope !== null}>
            {scope !== null ? (
              <option value="">{user.organizationCode}</option>
            ) : (
              <>
                <option value="">All CPSEs</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.code}</option>
                ))}
              </>
            )}
          </select>
        </label>
        <label className="fld">
          CMI
          <input name="cmi" defaultValue={cmiParam ?? ''} placeholder="CMI id" />
        </label>
        <button className="btn" type="submit">Apply</button>
        <a className="btn" href={href({ type: '', status: '', cpse: '', cmi: '' })}>Clear</a>
      </form>

      <table>
        <thead>
          <tr>
            <th>Signal</th>
            <th>Subject</th>
            <th>CPSEs</th>
            <th>Events</th>
            <th>Suppliers</th>
            <th>Status</th>
            <th>Detected</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={7}>No opportunities match the current filter. Run detection to scan current procurement history.</td>
            </tr>
          )}
          {items.map((o) => {
            const ev = safeParse(o.evidence) as Record<string, unknown>;
            const subject = o.cmi_code ?? (ev['organization'] as string | undefined) ?? o.organization_name ?? '—';
            return (
              <tr key={o.id}>
                <td>
                  <a href={'/procurement/opportunities/' + o.id}>{TYPE_LABELS[o.opportunity_type] ?? o.opportunity_type}</a>
                  <div className="muted small">{o.title}</div>
                </td>
                <td>{subject}</td>
                <td>{num(ev['orgs']) ?? '—'}</td>
                <td>{num(ev['records']) ?? o.priority_signal}</td>
                <td>{num(ev['suppliers']) ?? '—'}</td>
                <td>
                  <span className={'badge badge-' + o.status.toLowerCase()}>{STATUS_LABELS[o.status] ?? o.status}</span>
                </td>
                <td>{o.created_at.slice(0, 10)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
