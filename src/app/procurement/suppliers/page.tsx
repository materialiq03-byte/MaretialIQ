import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import {
  listSuppliersWithIntelligence,
  getCrossCpseSuppliers,
} from '@/lib/services/procurement-service';
import { listOrganizations } from '@/lib/db/repositories/organization-repository';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Supplier Intelligence — MaterialIQ' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

/**
 * Step 16 - supplier intelligence list. Descriptive recorded-procurement
 * metrics only: no rank, score, best/preferred/recommended column, no
 * supplier performance inference, no savings claims. Supplier identity is
 * the existing suppliers master (supplier_id + supplier_code); nothing is
 * created or merged here.
 */
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('VIEW_MAPPINGS');
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const q = get('q');
  const orgParam = get('cpse');
  const dateFrom = get('dateFrom');
  const dateTo = get('dateTo');
  const uomParam = get('uom');
  const currencyParam = get('currency');
  const rawPage = Number.parseInt(get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const orgs = listOrganizations().map((o) => ({ ...o }));
  const scope = visibleOrganizationIds(user);
  const organizationId = scope !== null ? scope[0] : orgParam ? Number(orgParam) : undefined;

  let items: ReturnType<typeof listSuppliersWithIntelligence>['items'] = [];
  let total = 0;
  let crossCpse: number[] = [];
  let loadError: string | null = null;
  try {
    const r = listSuppliersWithIntelligence(
      { q, organizationId, dateFrom, dateTo, uom: uomParam, currency: currencyParam },
      page,
      PAGE_SIZE
    );
    items = r.items;
    total = r.total;
    crossCpse = getCrossCpseSuppliers(2).map((s) => s.supplierId);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (orgParam) qs.set('cpse', orgParam);
  if (dateFrom) qs.set('dateFrom', dateFrom);
  if (dateTo) qs.set('dateTo', dateTo);
  if (uomParam) qs.set('uom', uomParam);
  if (currencyParam) qs.set('currency', currencyParam);
  const baseQs = qs.toString();
  const href = (patch: Record<string, string>) => {
    const q2 = new URLSearchParams(baseQs);
    for (const [k, v] of Object.entries(patch)) {
      if (v) q2.set(k, v);
      else q2.delete(k);
    }
    const st = q2.toString();
    return st ? '/procurement/suppliers?' + st : '/procurement/suppliers';
  };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (loadError) {
    return (
      <main>
        <h1>Supplier Intelligence</h1>
        <div className="error-box">Failed to load suppliers: {loadError}</div>
      </main>
    );
  }

  return (
    <main>
      <h1>Supplier Intelligence</h1>
      <p className="subtitle">
        Recorded procurement activity by supplier — descriptive metrics only. Suppliers are never
        ranked, scored, recommended or compared for preference, and no savings are calculated.
        Supplier metrics describe recorded procurement activity and are not supplier performance ratings.
      </p>

      <div className="hq-kpis">
        <div className="hq-kpi">
          <div className="hq-kpi-value">{total}</div>
          <div className="hq-kpi-label">Suppliers in current filter</div>
          <div className="hq-kpi-context">From the existing supplier master</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{crossCpse.length}</div>
          <div className="hq-kpi-label">Cross-CPSE activity</div>
          <div className="hq-kpi-context">Recorded activity spans 2+ CPSEs (observed pattern)</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{items.reduce((a, s) => a + s.unpricedRecords, 0)}</div>
          <div className="hq-kpi-label">Unpriced records (page)</div>
          <div className="hq-kpi-context">NULL prices are never treated as zero spend</div>
        </div>
      </div>

      <form className="filterbar" method="get">
        <label className="fld">
          Search
          <input name="q" defaultValue={q ?? ''} placeholder="Supplier code or name" />
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
          From
          <input type="date" name="dateFrom" defaultValue={dateFrom ?? ''} />
        </label>
        <label className="fld">
          To
          <input type="date" name="dateTo" defaultValue={dateTo ?? ''} />
        </label>
        <label className="fld">
          UOM
          <input name="uom" defaultValue={uomParam ?? ''} placeholder="EA" />
        </label>
        <label className="fld">
          Currency
          <input name="currency" defaultValue={currencyParam ?? ''} placeholder="INR" />
        </label>
        <button className="btn" type="submit">Apply</button>
        <a className="btn" href={href({ q: '', cpse: '', dateFrom: '', dateTo: '', uom: '', currency: '' })}>Clear</a>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Supplier</th>
              <th>Code</th>
              <th className="num">CPSEs</th>
              <th className="num">CMIs</th>
              <th className="num">Materials</th>
              <th className="num">Records</th>
              <th>Latest activity</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={8}>No suppliers match the current filter. Suppliers are created through the governed supplier master, never from procurement imports.</td>
              </tr>
            )}
            {items.map((s) => (
              <tr key={s.supplierId}>
                <td>
                  <a href={'/procurement/suppliers/' + s.supplierId}>{s.supplierName}</a>
                  {crossCpse.includes(s.supplierId) && (
                    <span className="badge badge-open" style={{ marginLeft: 8 }}>Cross-CPSE</span>
                  )}
                </td>
                <td className="mono">{s.supplierCode}</td>
                <td className="num">{s.orgCount}</td>
                <td className="num">{s.cmiCount}</td>
                <td className="num">{s.materialCount}</td>
                <td className="num">{s.recordCount}</td>
                <td className="mono">{s.lastPurchaseDate ?? '—'}</td>
                <td>
                  <span className={'badge ' + (s.isActive ? 'badge-approved' : 'badge-dismissed')}>
                    {s.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="decision-row">
          {page > 1 && <a className="btn" href={href({ page: String(page - 1) })}>Previous</a>}
          <span>Page {page} of {totalPages}</span>
          {page < totalPages && <a className="btn" href={href({ page: String(page + 1) })}>Next</a>}
        </div>
      )}

      <p className="muted small">
        Demonstration environment — procurement records are representative synthetic data.
        Status is the existing supplier master-data field; no preferred/blacklisted/strategic
        classification is applied.
      </p>
    </main>
  );
}
