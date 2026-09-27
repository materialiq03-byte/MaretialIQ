import { requirePermission } from '@/lib/auth/guard';
import { getSupplierIntelligenceBundle } from '@/lib/services/procurement-service';
import { errors } from '@/lib/errors';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Supplier Detail — MaterialIQ' };
export const dynamic = 'force-dynamic';

/**
 * Step 16 - supplier detail (section 14). Every metric is traceable to
 * procurement_records; UOM and currency boundaries preserved; NULL prices
 * counted, never priced. Descriptive only: no ranking, no preference, no
 * performance inference, no savings.
 */
export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('VIEW_MAPPINGS');
  const { id } = await params;
  const bundle = getSupplierIntelligenceBundle(Number(id));
  if (!bundle) throw errors.notFound('Supplier');
  const { detail, orgActivity, cmiActivity, matrix, recentRecords, orgColumns, comparable } = bundle;
  const qtyEntries = Object.entries(detail.quantityByUom);
  const spendEntries = Object.entries(detail.spendByCurrency);

  return (
    <main>
      <h1>
        {detail.supplier.supplier_name}
        <span className="mono" style={{ marginLeft: 12, fontSize: '0.8em' }}>{detail.supplier.supplier_code}</span>
      </h1>
      <p className="subtitle">
        Recorded procurement activity — descriptive metrics only. This page does not rank, score or
        recommend suppliers and infers no reliability, quality or performance from procurement history.
      </p>

      <div className="hq-kpis">
        <div className="hq-kpi">
          <div className="hq-kpi-value">{detail.orgCount}</div>
          <div className="hq-kpi-label">CPSEs</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{detail.cmiCount}</div>
          <div className="hq-kpi-label">CMIs</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{detail.materialCount}</div>
          <div className="hq-kpi-label">Materials</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{detail.recordCount}</div>
          <div className="hq-kpi-label">Records</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{detail.unpricedRecords}</div>
          <div className="hq-kpi-label">Unpriced records</div>
          <div className="hq-kpi-context">Excluded from spend, never zero-priced</div>
        </div>
      </div>

      <h2>Recorded procurement activity</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <th>Quantity (by UOM — never combined)</th>
              <td className="mono">{qtyEntries.map(([u, v]) => `${v} ${u}`).join(' + ') || '—'}</td>
            </tr>
            <tr>
              <th>Spend (by currency — never combined)</th>
              <td className="mono">{spendEntries.map(([c, v]) => `${v} ${c}`).join(' + ') || '—'}</td>
            </tr>
            <tr>
              <th>Period</th>
              <td className="mono">{detail.firstPurchaseDate ?? '—'} → {detail.lastPurchaseDate ?? '—'}</td>
            </tr>
            <tr>
              <th>Comparable quantity (by canonical UOM — Step 17 rules)</th>
              <td className="mono">
                {comparable && Object.keys(comparable.comparableQuantityByUom).length > 0
                  ? Object.entries(comparable.comparableQuantityByUom).map(([u, v]) => `${v} ${u}`).join(' + ')
                  : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>CPSE activity</h2>
      <p className="subtitle" style={{ marginTop: -14 }}>Recorded procurement activity by CPSE — not supplier preference.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>CPSE</th>
              <th className="num">Records</th>
              <th>Quantity (by UOM)</th>
              <th>Spend (by currency)</th>
            </tr>
          </thead>
          <tbody>
            {orgActivity.length === 0 && <tr><td colSpan={4}>No recorded procurement activity.</td></tr>}
            {orgActivity.map((o) => (
              <tr key={o.organizationId}>
                <td className="mono">{o.orgCode}</td>
                <td className="num">{o.recordCount}</td>
                <td className="mono">{Object.entries(o.quantityByUom).map(([u, v]) => `${v} ${u}`).join(' + ') || '—'}</td>
                <td className="mono">{Object.entries(o.spendByCurrency).map(([c, v]) => `${v} ${c}`).join(' + ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>CMI activity</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>CMI</th>
              <th className="num">Records</th>
              <th className="num">CPSEs</th>
              <th>Quantity (by UOM)</th>
              <th>Spend (by currency)</th>
              <th>Period</th>
            </tr>
          </thead>
          <tbody>
            {cmiActivity.length === 0 && <tr><td colSpan={6}>No harmonized (CMI-linked) activity.</td></tr>}
            {cmiActivity.map((c) => (
              <tr key={c.cmiId}>
                <td className="mono"><a href={`/materials/common/${c.cmiId}`}>{c.cmiCode}</a></td>
                <td className="num">{c.recordCount}</td>
                <td className="num">{c.orgCount}</td>
                <td className="mono">{Object.entries(c.quantityByUom).map(([u, v]) => `${v} ${u}`).join(' + ') || '—'}</td>
                <td className="mono">{Object.entries(c.spendByCurrency).map(([cu, v]) => `${v} ${cu}`).join(' + ') || '—'}</td>
                <td className="mono">{c.firstPurchaseDate ?? '—'} → {c.lastPurchaseDate ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Supplier → CMI → CPSE matrix</h2>
      <p className="subtitle" style={{ marginTop: -14 }}>Quantity by UOM per CPSE — UOM boundaries preserved; em-dash where a CPSE has no recorded activity for the CMI.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>CMI</th>
              {orgColumns.map((c) => <th key={c.id} className="num">{c.code}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.length === 0 && <tr><td colSpan={orgColumns.length + 1}>No harmonized (CMI-linked) activity.</td></tr>}
            {matrix.map((row) => (
              <tr key={row.cmiId}>
                <td className="mono">{row.cmiCode}</td>
                {orgColumns.map((c) => <td key={c.id} className="mono">{row.cells[c.id] ?? '—'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Recent procurement</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>CPSE</th>
              <th>Material</th>
              <th>CMI</th>
              <th className="num">Quantity</th>
              <th>UOM</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {recentRecords.length === 0 && <tr><td colSpan={7}>No procurement records.</td></tr>}
            {recentRecords.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.purchaseDate}</td>
                <td className="mono">{r.orgCode}</td>
                <td>
                  <span className="mono">{r.materialCode}</span> {r.materialDescription}
                </td>
                <td className="mono">{r.cmiCode ?? '—'}</td>
                <td className="num mono">{r.quantity} {r.uom}</td>
                <td className="mono">{r.uom}</td>
                <td className="mono">{r.unitPrice != null ? `${r.unitPrice} ${r.currency ?? ''}` : 'Unpriced'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="disclaimer">
        Demonstration environment — procurement records are representative synthetic data. Supplier
        metrics describe recorded procurement activity and are not supplier performance ratings.
      </p>
    </main>
  );
}
