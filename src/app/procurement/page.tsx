import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import {
  listProcurementRecords,
  listSuppliers,
  getProcurementCoverage,
  listCmiProcurementOverviews,
  getOrganizationProcurementSummaries,
  type ProcurementWithContext,
} from '@/lib/db/repositories/procurement-repository';
import { listOrganizations } from '@/lib/db/repositories/organization-repository';
import type { Metadata } from 'next';
import type { ProcurementStatus } from '@/lib/types/domain';
import { getUomDataQuality } from '@/lib/services/procurement-service';
import { listOpportunities } from '@/lib/services/procurement-opportunity-service';

export const metadata: Metadata = { title: 'Procurement — MaterialIQ' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/** Real persisted procurement states → existing badge classes (text + color). */
const PROC_STATUS_BADGE: Record<string, string> = {
  ORDERED: 'pending',
  PARTIALLY_DELIVERED: 'deferred',
  DELIVERED: 'approved',
  CANCELLED: 'rejected',
};

/**
 * Step 12 - procurement data foundation page.
 * Representative synthetic procurement data for demonstration - NOT actual
 * CPSE purchasing records. CMI linkage reflects the human-approved
 * harmonization state only (prototype common material identity - not an
 * official national material code).
 */
export default async function ProcurementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('VIEW_MAPPINGS');
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const orgParam = get('cpse');
  const supParam = get('supplier');
  const harmParam = get('harmonized');
  const statusParam = get('status') as ProcurementStatus | undefined;
  const dateFrom = get('dateFrom');
  const dateTo = get('dateTo');
  const uomParam = get('uom');
  const currencyParam = get('currency');
  const rawPage = Number.parseInt(get('page') ?? '1', 10);
  const requestedPage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const orgs = listOrganizations().map((o) => ({ ...o }));
  const suppliers = listSuppliers().map((s) => ({ ...s }));
  const scope = visibleOrganizationIds(user);
  const organizationId = scope !== null ? scope[0] : orgParam ? Number(orgParam) : undefined;
  const supplierId = supParam ? Number(supParam) : undefined;
  const harmonized = harmParam === 'true' ? true : harmParam === 'false' ? false : undefined;

  let items: ProcurementWithContext[] = [];
  let total = 0;
  let coverage: ReturnType<typeof getProcurementCoverage> | null = null;
  let uomQuality: ReturnType<typeof getUomDataQuality> | null = null;
  let cmiDemand: ReturnType<typeof listCmiProcurementOverviews> = [];
  let orgSummaries: ReturnType<typeof getOrganizationProcurementSummaries> = [];
  let openOpps: ReturnType<typeof listOpportunities>['items'] | null = null;
  let loadError: string | null = null;
  try {
    const r = listProcurementRecords(
      { organizationId, supplierId, harmonized, status: statusParam, dateFrom, dateTo, uom: uomParam, currency: currencyParam },
      requestedPage,
      PAGE_SIZE
    );
    items = r.items.map((i) => ({ ...i, record: { ...i.record } }));
    total = r.total;
    coverage = getProcurementCoverage();
    uomQuality = getUomDataQuality();
    cmiDemand = listCmiProcurementOverviews().filter((c) => c.recordCount > 0);
    orgSummaries = getOrganizationProcurementSummaries();
    openOpps = listOpportunities({ status: 'OPEN' }, 1, 500).items.map((o) => ({ ...o }));
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const pageHref = (p: number) => {
    const qs = new URLSearchParams();
    if (orgParam) qs.set('cpse', orgParam);
    if (supParam) qs.set('supplier', supParam);
    if (harmParam) qs.set('harmonized', harmParam);
    if (statusParam) qs.set('status', statusParam);
    if (dateFrom) qs.set('dateFrom', dateFrom);
    if (dateTo) qs.set('dateTo', dateTo);
    if (uomParam) qs.set('uom', uomParam);
    if (currencyParam) qs.set('currency', currencyParam);
    if (p > 1) qs.set('page', String(p));
    const s = qs.toString();
    return s ? `/procurement?${s}` : '/procurement';
  };

  if (loadError) {
    return (
      <main>
        <h1>Procurement</h1>
        <div className="error-box">Failed to load procurement records: {loadError}</div>
      </main>
    );
  }

  return (
    <main className="hq-root">
      <section className="hq3-pagehead" aria-label="Procurement intelligence">
        <div>
          <p className="hq3-kicker">PROCUREMENT INTELLIGENCE — DECISION SUPPORT</p>
          <h1>Procurement</h1>
          <p className="hq3-sub">
            Representative synthetic procurement data for demonstration — not actual CPSE purchasing records. Records
            link to materials and, where a human-approved mapping exists, to the prototype common material identity.
            Decision support only — no savings are claimed and no financial optimization is computed.
          </p>
        </div>
        <div className="hq3-pagehead-actions">
          <a className="btn primary" href="/procurement/import">Import Procurement Data</a>
        </div>
      </section>

      {/* Technical safety: harmonization never means blindly merging materials.
          Semantics reuse the UI-2 relation vocabulary (text + icon, not color). */}
      <div className="hq3-safety" role="note" aria-label="Technical safety semantics">
        <span className="hq3-safety-title">HARMONIZATION ≠ BLIND MERGING</span>
        <span className="hq3-sem hq3-sem-match"><span aria-hidden="true">✓</span> MATCH — agrees technically</span>
        <span className="hq3-sem hq3-sem-review"><span aria-hidden="true">≈</span> REVIEW — human validation required</span>
        <span className="hq3-sem hq3-sem-conflict"><span aria-hidden="true">!</span> CONFLICT — automatic harmonization blocked</span>
        <span className="hq3-sem hq3-sem-none"><span aria-hidden="true">—</span> NOT A MATCH — excluded from equivalence</span>
      </div>

      {(() => {
        if (openOpps === null) return null;
        const byType = (t: string) => openOpps.filter((o) => o.opportunity_type === t).length;
        return (
          <div className="filterbar" role="status" aria-label="Procurement opportunities summary">
            <span>
              OPPORTUNITIES <strong>{openOpps.length}</strong>
            </span>
            <span>
              CROSS-CPSE <strong>{byType('CROSS_CPSE_DEMAND')}</strong>
            </span>
            <span>
              REPEATED <strong>{byType('REPEATED_PROCUREMENT')}</strong>
            </span>
            <span>
              UNHARMONIZED <strong>{byType('UNHARMONIZED_RELATED_PROCUREMENT')}</strong>
            </span>
            <a href="/procurement/opportunities">View all opportunities →</a>
            <a href="/procurement/suppliers">Supplier intelligence →</a>
          </div>
        );
      })()}

      <div className="filterbar" role="status" aria-label="Procurement totals">
        <span>
          RECORDS <strong>{coverage?.totalRecords ?? 0}</strong>
        </span>
        <span>
          CPSES <strong>{coverage?.organizationsWithProcurement ?? 0}</strong>
        </span>
        <span>
          SUPPLIERS <strong>{coverage?.suppliersWithProcurement ?? 0}</strong>
        </span>
        <span>
          CMI-LINKED <strong>{coverage?.cmiLinkedRecords ?? 0}</strong>
        </span>
        <span>
          UNHARMONIZED <strong>{coverage?.unharmonizedRecords ?? 0}</strong>
        </span>
        <span>
          COVERAGE{' '}
          <strong>
            {coverage?.coverageRatio != null ? `${(coverage.coverageRatio * 100).toFixed(2)}%` : '—'}
          </strong>
        </span>
        <span>
          UNPRICED <strong>{coverage?.unpricedRecords ?? 0}</strong>
        </span>
      </div>

      <form className="filterbar" method="get">
        <label className="fld">
          CPSE
          <select name="cpse" defaultValue={orgParam ?? ''} disabled={scope !== null}>
            {scope !== null ? (
              <option value="">{user.organizationCode}</option>
            ) : (
              <>
                <option value="">All CPSEs</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
        <label className="fld">
          Supplier
          <select name="supplier" defaultValue={supParam ?? ''}>
            <option value="">All suppliers</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.supplier_name}
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          CMI state
          <select name="harmonized" defaultValue={harmParam ?? ''}>
            <option value="">All</option>
            <option value="true">CMI-linked</option>
            <option value="false">Unharmonized</option>
          </select>
        </label>
        <label className="fld">
          Status
          <select name="status" defaultValue={statusParam ?? ''}>
            <option value="">All statuses</option>
            <option value="ORDERED">Ordered</option>
            <option value="PARTIALLY_DELIVERED">Partially delivered</option>
            <option value="DELIVERED">Delivered</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </label>
        <label className="fld">
          UOM
          <input type="text" name="uom" defaultValue={uomParam ?? ''} placeholder="EA" />
        </label>
        <label className="fld">
          Currency
          <input type="text" name="currency" defaultValue={currencyParam ?? ''} placeholder="INR" />
        </label>
        <label className="fld">
          From
          <input type="text" name="dateFrom" defaultValue={dateFrom ?? ''} placeholder="YYYY-MM-DD" />
        </label>
        <label className="fld">
          To
          <input type="text" name="dateTo" defaultValue={dateTo ?? ''} placeholder="YYYY-MM-DD" />
        </label>
        <button type="submit">Apply</button>
        <a href="/procurement">Clear</a>
      </form>

      <h2 className="hq3-sec"><span className="hq6-secno">01</span> Common Material Demand</h2>
      <p className="subtitle" style={{ marginTop: -14 }}>
        Cross-CPSE procurement visibility per prototype common material identity. Quantities aggregate per UOM
        only — no unit conversions are applied; spend per currency — no exchange rates.
      </p>
      {uomQuality && (
        <div className="hq-kpis" style={{ marginTop: 8 }}>
          <div className="hq-kpi">
            <div className="hq-kpi-value">{uomQuality.counts.VALID_CANONICAL ?? 0}</div>
            <div className="hq-kpi-label">Valid canonical</div>
            <div className="hq-kpi-context">Original UOM already canonical</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-value">{(uomQuality.counts.VALID_ALIAS ?? 0) + (uomQuality.counts.VALID_CONVERTED ?? 0)}</div>
            <div className="hq-kpi-label">Normalized via rule</div>
            <div className="hq-kpi-context">Exact alias/scale rule applied</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-value">{uomQuality.counts.UNCONVERTED ?? 0}</div>
            <div className="hq-kpi-label">Unconverted</div>
            <div className="hq-kpi-context">No explicit rule — kept separate</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-value">{uomQuality.counts.UNKNOWN ?? 0}</div>
            <div className="hq-kpi-label">Unknown UOM</div>
            <div className="hq-kpi-context">Not in the controlled vocabulary</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-value"><a href="/procurement/uom-rules">UOM Rules →</a></div>
            <div className="hq-kpi-label">Conversion registry</div>
            <div className="hq-kpi-context">Explicit, directional, SYSTEM_DEFINED</div>
          </div>
        </div>
      )}
      {cmiDemand.length === 0 ? (
        <div className="empty-state">No common material identity has procurement records yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>CMI</th>
                <th>Category</th>
                <th className="num">CPSEs</th>
                <th className="num">Records</th>
                <th className="num">Suppliers</th>
                <th>Demand (by UOM)</th>
                <th>Spend (by currency)</th>
                <th>Period</th>
              </tr>
            </thead>
            <tbody>
              {cmiDemand.map((c) => (
                <tr key={c.cmiId}>
                  <td className="mono">{c.cmiCode}</td>
                  <td>{c.category}</td>
                  <td className="num">{c.orgCount}</td>
                  <td className="num">{c.recordCount}</td>
                  <td className="num">{c.supplierCount}</td>
                  <td className="mono">
                    {Object.entries(c.quantityByUom)
                      .map(([uom, qty]) => `${qty} ${uom}`)
                      .join(' + ') || '—'}
                  </td>
                  <td className="mono">
                    {Object.entries(c.spendByCurrency)
                      .map(([cur, amt]) => `${amt} ${cur}`)
                      .join(' + ') || '—'}
                  </td>
                  <td className="mono">
                    {c.firstPurchaseDate ?? '—'} → {c.lastPurchaseDate ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="hq3-sec"><span className="hq6-secno">02</span> Demand by CPSE</h2>
      <p className="subtitle" style={{ marginTop: -14 }}>
        Descriptive per-CPSE procurement statistics — not performance rankings.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>CPSE</th>
              <th className="num">Records</th>
              <th className="num">CMI-linked</th>
              <th className="num">Unharmonized</th>
              <th className="num">Suppliers</th>
              <th>Quantity (by UOM)</th>
              <th>Spend (by currency)</th>
            </tr>
          </thead>
          <tbody>
            {orgSummaries.map((o) => (
              <tr key={o.organizationId}>
                <td className="mono">{o.orgCode}</td>
                <td className="num">{o.recordCount}</td>
                <td className="num">{o.cmiLinkedRecords}</td>
                <td className="num">{o.unharmonizedRecords}</td>
                <td className="num">{o.supplierCount}</td>
                <td className="mono">
                  {Object.entries(o.quantityByUom)
                    .map(([uom, qty]) => `${qty} ${uom}`)
                    .join(' + ') || '—'}
                </td>
                <td className="mono">
                  {Object.entries(o.spendByCurrency)
                    .map(([cur, amt]) => `${amt} ${cur}`)
                    .join(' + ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="hq3-sec"><span className="hq6-secno">03</span> Procurement Records</h2>
      {total === 0 ? (
        <div className="empty-state">
          No procurement records for these filters. Seed the isolated demonstration dataset with
          DATA_DIR=&lt;isolated dir&gt; npx tsx scripts/seed-procurement.ts.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>CPSE</th>
                <th>Material</th>
                <th>CMI</th>
                <th>Supplier</th>
                <th className="num">Qty</th>
                <th>UOM</th>
                <th>Status</th>
                <th className="num">Unit price</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.record.id}>
                  <td className="mono">{r.record.purchase_date}</td>
                  <td className="mono">{r.org_code}</td>
                  <td className="mono">
                    <a href={`/materials/${r.record.material_id}`}>{r.material_code}</a>
                  </td>
                  <td className="mono">{r.cmi_code ? <span className="hq3-cmi-chip">{r.cmi_code}</span> : <span className="hq3-unlinked">unharmonized</span>}</td>
                  <td>{r.supplier_name}</td>
                  <td className="num">{r.record.quantity}</td>
                  <td className="mono">{r.record.uom}</td>
                  <td><span className={`badge ${PROC_STATUS_BADGE[r.record.procurement_status] ?? ''}`}>{r.record.procurement_status.replace(/_/g, ' ').toLowerCase()}</span></td>
                  <td className="num">{r.record.unit_price ? `${r.record.unit_price} ${r.record.currency ?? ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
