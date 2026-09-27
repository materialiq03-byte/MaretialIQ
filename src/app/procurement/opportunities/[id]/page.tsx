import { requirePermission } from '@/lib/auth/guard';
import { getOpportunityRequired } from '@/lib/services/procurement-opportunity-service';
import { listOpportunitySourceRecords } from '@/lib/db/repositories/procurement-repository';
import { roleHasPermission } from '@/lib/auth/permissions';
import { OpportunityReviewActions } from './review-actions';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Procurement Opportunity — MaterialIQ' };
export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<string, string> = {
  CROSS_CPSE_DEMAND: 'Cross-CPSE demand detected',
  REPEATED_PROCUREMENT: 'Repeated procurement activity detected',
  FRAGMENTED_DEMAND: 'Demand distributed across CPSEs',
  UNHARMONIZED_RELATED_PROCUREMENT: 'Unharmonized procurement review signal',
  MULTI_SUPPLIER_ACTIVITY: 'Multiple suppliers active',
  HIGH_PROCUREMENT_ACTIVITY: 'High procurement activity (dataset-relative)',
};

/**
 * Opportunity detail: WHY FLAGGED (explainable evidence), demand by CPSE,
 * supplier activity, bounded source-record traceability (section 23), and the
 * governed human-review actions. Evidence is a summary - the source records
 * below are the real procurement rows it reconciles to.
 */
export default async function OpportunityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission('VIEW_MAPPINGS');
  const { id } = await params;
  const opp = getOpportunityRequired(Number(id));
  const evidence = safeParse(opp.evidence) as Record<string, unknown>;
  const sourceRecords = listOpportunitySourceRecords(opp, 200);
  const canReview = roleHasPermission(user.role, 'EDIT_MATERIALS');
  const period = evidence['period'] as { start?: string; end?: string } | undefined;
  const demand = (evidence['demandByOrgAndUom'] as Array<{ org: string; uom: string; qty: string; records: number }> | undefined) ?? [];
  const supplierActivity = (evidence['supplierActivity'] as Array<{ supplier: string; supplierId?: number; records: number; first: string; last: string }> | undefined) ?? [];
  const materialIds = (evidence['materialIds'] as number[] | undefined) ?? [];
  const comparable = evidence['comparableDemand'] as
    | { comparableQuantityByUom?: Record<string, string>; qualityCounts?: Record<string, number>; note?: string }
    | undefined;

  return (
    <main>
      <h1>{TYPE_LABELS[opp.opportunity_type] ?? opp.opportunity_type}</h1>
      <p className="subtitle">
        {opp.title} · Detected {opp.created_at.slice(0, 10)}
        {opp.cmi_code ? ' · ' : ''}
        {opp.cmi_code && (
          <>
            CMI <a href={'/cross-reference?cmi=' + opp.cmi_id}>{opp.cmi_code}</a> (prototype common
            material identity — not an official national material code)
          </>
        )}
      </p>
      <p className="muted">
        Opportunity signals are derived from representative synthetic procurement history and require
        human review. This is an observation for investigation — never a purchasing instruction.
      </p>

      <section>
        <h2>Why this was flagged</h2>
        <p>{opp.description}</p>
        <ul>
          <li>Signal score: {opp.priority_signal} (transparent formula: 2 × CPSEs + 2 × suppliers + procurement events — no AI model involved)</li>
          {typeof evidence['orgs'] === 'number' && <li>CPSEs purchasing: {evidence['orgs'] as number}</li>}
          {typeof evidence['records'] === 'number' && <li>Procurement records: {evidence['records'] as number}</li>}
          {typeof evidence['distinctPurchaseDates'] === 'number' && <li>Distinct purchase dates: {evidence['distinctPurchaseDates'] as number}</li>}
          {typeof evidence['suppliers'] === 'number' && <li>Suppliers: {evidence['suppliers'] as number}</li>}
          {period && period.start && <li>Period: {period.start} → {period.end ?? 'current'}</li>}
          {typeof evidence['highThreshold'] === 'number' && (
            <li>Dataset-relative high-activity threshold: {evidence['highThreshold'] as number} events (this demonstration dataset only)</li>
          )}
        </ul>
      {comparable?.comparableQuantityByUom && Object.keys(comparable.comparableQuantityByUom).length > 0 && (
        <p className="evidence-detail">
          <strong>Comparable demand (Step 17 UOM normalization):</strong>{' '}
          {Object.entries(comparable.comparableQuantityByUom).map(([u, v]) => `${v} ${u}`).join(' + ')}
          {comparable.note ? <> — {comparable.note}</> : null}
        </p>
      )}

      </section>

      {demand.length > 0 && (
        <section>
          <h2>Demand by CPSE (per UOM)</h2>
          <table>
            <thead>
              <tr>
                <th>CPSE</th>
                <th>UOM</th>
                <th>Quantity</th>
                <th>Records</th>
              </tr>
            </thead>
            <tbody>
              {demand.map((d, i) => (
                <tr key={i}>
                  <td>{d.org}</td>
                  <td>{d.uom}</td>
                  <td>{d.qty}</td>
                  <td>{d.records}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {supplierActivity.length > 0 && (
        <section>
          <h2>Supplier activity (descriptive — never a ranking)</h2>
          <table>
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Records</th>
                <th>First purchase</th>
                <th>Last purchase</th>
              </tr>
            </thead>
            <tbody>
              {supplierActivity.map((s, i) => (
                <tr key={i}>
                  <td>
                    {typeof s.supplierId === 'number' ? (
                      <a href={`/procurement/suppliers/${s.supplierId}`}>{s.supplier}</a>
                    ) : (
                      s.supplier
                    )}
                  </td>
                  <td>{s.records}</td>
                  <td>{s.first}</td>
                  <td>{s.last}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {materialIds.length > 0 && (
        <section>
          <h2>Materials suggested for material-master review</h2>
          <p className="muted">
            These materials remain unharmonized. Review happens in the material master / matching
            workspace — procurement never assigns or creates common material identities.
          </p>
          <ul>
            {materialIds.map((m) => (
              <li key={m}>
                <a href={'/materials/' + m}>Material #{m}</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Source procurement records</h2>
        <p className="muted">The evidence above reconciles exactly to these records.</p>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>CPSE</th>
              <th>Material</th>
              <th>CMI</th>
              <th>Supplier</th>
              <th>Qty</th>
              <th>UOM</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sourceRecords.map((r) => (
              <tr key={r.record.id}>
                <td>{r.record.purchase_date}</td>
                <td>{r.org_code}</td>
                <td>{r.material_code}</td>
                <td>{r.cmi_code ?? '—'}</td>
                <td>{r.supplier_name}</td>
                <td>{r.record.quantity}</td>
                <td>{r.record.uom}</td>
                <td>{r.record.procurement_status.toLowerCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Status</h2>
        <p>
          <span className={'badge badge-' + opp.status.toLowerCase()}>{opp.status}</span>
          {opp.reviewed_by && (
            <span className="muted">
              {' '}· {opp.reviewed_by} · {opp.reviewed_at?.slice(0, 10)}
              {opp.review_note ? ' · "' + opp.review_note + '"' : ''}
            </span>
          )}
        </p>
        <OpportunityReviewActions
          opportunityId={opp.id}
          status={opp.status}
          canReview={canReview}
        />
      </section>
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
